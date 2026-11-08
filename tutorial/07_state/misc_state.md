# 收尾：网关持久化、异常分类、Schema、用量与 Terminal 墓碑

## 文件概览

最后五个兄弟模块不属于前七篇的任何单一主题，却各自被多方依赖：

- `hermes_state_gateway.py`（1033 行）：gateway 需要的一切持久化——路由索引、peer 恢复、孤儿会话、后端心跳、跨平台 handoff。
- `hermes_state_errors.py`（326 行）：异常类型与**字符串级**错误分类谓词（让 wrapped RPC 字符串与活异常走同一套判定）。
- `hermes_state_schema.py`（1367 行）：声明式 DDL、列调和、FTS 重建编排——打开连接时跑的那段。
- `hermes_state_usage.py`（469 行）：合并式后台 token 写入器与每模型用量行。
- `hermes_state_terminal.py`（170 行）：terminal 专用的退休墓碑查询——精确重放，绝无历史重建。

本篇末尾附**64 文件全覆盖核对表**：前七篇清单与本篇清单的并集即全部 `hermes_state_*.py` 兄弟。

## 关键代码走读

### 1. 路由索引与 peer 恢复

```python
# hermes_state_gateway.py:60-76（节选）
_PEER_BY_KEY_SQL = f"""{_PEER_SELECT_HEAD}                WHERE s.session_key = ?
                  AND s.source = ?
                  AND (s.ended_at IS NULL OR s.end_reason IN ({_RECOVERABLE_END_REASONS_SQL})
                       OR {_HANDOFF_OWNED_ROW_SQL})
                  AND NOT EXISTS (
                      SELECT 1 FROM sessions b
                      WHERE b.session_key = s.session_key
                        AND b.source = s.source
                        AND b.ended_at IS NOT NULL
                        AND b.end_reason IN ({_RESET_END_REASONS_SQL})
                        AND b.ended_at
                            > COALESCE(s.last_activity_at, s.started_at)
                  )
                ORDER BY _has_messages DESC,
                         COALESCE(s.last_activity_at, s.started_at) DESC
                LIMIT 1
                """
```

`find_latest_gateway_session_for_peer`（:496）先按精确 key、再按 peer 五元组（source/user/chat/type/thread）恢复"这个对话上次是哪一行"；`_HANDOFF_OWNED_ROW_SQL = "(s.handoff_state = 'completed')"`（:59）让已完成交接的行无视 end_reason 保持可恢复——源侧 teardown 可能在目的地首条回复前打上 cli_close，否则交接腿会被孤儿化。`_COMPRESSION_LINEAGE_CTE`（:25）把压缩祖先绑在同一个 routing peer 上。

### 2. 孤儿、心跳与 handoff

`find_orphaned_gateway_sessions`（:540）找"有 key 无活跃 backend 且超时"的会话；`adopt_orphaned_gateway_session`（:598）把孤儿捐给接管者。心跳四件套 `register_backend_heartbeat`（:901）/`clear_backend_heartbeat`（:918）/`prune_stale_heartbeats`（:926）/`list_backend_heartbeats`（:939）。handoff 状态机 `request_handoff`（:946）→`claim_handoff`（:980）→`complete_handoff`（:991）→`fail_handoff`（:997），外加 `reclaim_stale_running_handoffs`（:1011）。`save/load_gateway_routing_entries`（:304/:337）维护 `gateway_routing` 表（scope 为空的行是本地路由）；`rekey_profile_state`（:673）/`purge_profile_state`（:782）服务 profile 改名与清除。

### 3. 异常分类：字符串也要能判

```python
# hermes_state_errors.py:49-56
def is_sqlite_lock_error(exc_or_str) -> bool:
    """SQLITE_BUSY / SQLITE_LOCKED: wait and retry, never treat as damage. A known result code
    decides; only without one (our own re-raised messages, RPC-wrapped strings) does the text."""
    code = _sqlite_primary_code(exc_or_str)
    if code is not None:
        return code in _SQLITE_LOCK_CODES
    text = str(exc_or_str).lower()
    return "locked" in text or "busy" in text
```

分类桶全集 `PERSISTENCE_ERROR_CAUSES`（:99-102）：`locked / compression / compression_closed / turn_lease / corrupt / fts_index / replaced / deleted_wal / disk / session_row_missing / unknown`。顺序敏感：`_DB_CORRUPTION_MARKERS` 的注释（:105-109）强调 "database disk image is malformed" 含 "disk"，**必须先于磁盘桶**判，否则 B-tree 损坏会被读成"清一下磁盘"。`StateDbCorruptError`/`StateDbReplacedError`/`DeletedWalGenerationError` 等类型与 `classify_persistence_error` 都定义于此。

### 4. Schema：声明式 DDL 与打开时编排

```python
# hermes_state_schema.py:1341-1354（签名）
def apply_declared_schema(cursor: sqlite3.Cursor) -> None:
...
def reconcile_state_schema(conn: sqlite3.Connection) -> None:
```

`SessionSchemaMixin`（:187）在 `_init_schema` 里执行：`apply_declared_schema`（幂等建表/列）→ `reconcile_state_schema`（补列、退移 legacy 对象）→ FTS ensure/重建编排（`retry_deferred_fts_recovery` :558，退避重试被持锁挡下的恢复，间隔翻倍到 3600s 上限）。message_uid 的 legacy 回填（:50-54）分块 2000 行、预算 1 秒，跨多次打开逐步完成。`schema_read_probe_statements`（:170）给"库能不能读"提供最小探针。

### 5. 用量：合并式后台 token 写入器

```python
# hermes_state_usage.py:107-114（节选）
    def queue_token_counts(self, session_id: str, **kwargs) -> None:
        """Enqueue a token/cost delta for the background writer (same kwargs as
        :meth:`update_token_counts`). After close() stopped the writer, falls back to the
        synchronous path and may raise."""
```

`SessionUsageMixin`（:83）维持单写线程：`queue_token_counts` 只是 deque append，**连续同路由的增量被合并**（合并键 `_TOKEN_DELTA_SUM_FIELDS`/`_TOKEN_DELTA_ROUTE_FIELDS`，hermes_state.py:1605-1613——合并后的 UPDATE 等价于顺序施加）；精确读走 `flush_token_counts`（:159）。SQL 生成器 `_token_update_sql`（:21）区分 delta（CLI 逐调用）与 absolute（gateway 累计）两种模式；`session_model_usage` 表的 UPSERT（:53-72）按 `(session_id, model, provider, base_url, mode, task)` 累加。`record_auxiliary_usage`（:392）与 `usage_totals`（:456）补齐辅助用量与汇总。线程空闲 `_TOKEN_WRITER_IDLE_SECONDS = 30s` 后退休（hermes_state.py:512-513），避免绑定方法把废弃 handle 钉在内存里。

### 6. Terminal 墓碑：精确重放，不重建历史

```python
# hermes_state_terminal.py:1-15（节选）
"""Private terminal-only tombstone queries; never reconstruct executable history.

The authenticated edge supplies the original principal/target/request and frozen
payload. A retired target permits only that exact digest, never fresh admission.
Worker receipt reads additionally require the original private adoption proof."""
...
RESULT_PREFIX = 'gateway.admission.result.v1.'
ADMISSION_PREFIX = 'gateway.terminal_admission.v1.'
IDENTITY_PREFIX = 'gateway.terminal_identity.v1.'
WORKER_PREFIX = 'gateway.terminal_worker.v1.'
```

会话被删除后，admission/worker 行已被 `retire_terminal_receipts` 压成墓碑（见 wal_mutations 组）；`terminal_admission`（:118）/`retry_terminal_admission`（:124）让**精确重放**（同 digest）仍能取到原结局，而任何新 admission 都被拒。`compact_result`（:18）在存储侧先做一轮瘦身：剥掉 tools 列表、把累计 messages 截成"本轮后缀"（`_messages_are_turn_suffix`），压缩结果是唯一例外（它的替换快照是改写前缀的唯一记录）。

## 核心类/函数

| 名称 | 位置 | 职责 |
|---|---|---|
| `SessionGatewayMixin` | hermes_state_gateway.py:177 | 网关持久化 mixin |
| `record_gateway_session_peer` | hermes_state_gateway.py:234 | 记录会话 peer（key + 五元组） |
| `find_latest_gateway_session_for_peer` | hermes_state_gateway.py:496 | 两级 peer 恢复查询 |
| `find_orphaned_gateway_sessions` / `adopt_orphaned_gateway_session` | hermes_state_gateway.py:540 / :598 | 孤儿发现与收养 |
| `request_handoff` … `complete_handoff` | hermes_state_gateway.py:946-1009 | 跨平台 handoff 状态机 |
| `classify_persistence_error` | hermes_state_errors.py（PERSISTENCE_ERROR_CAUSES :99） | 统一错误桶（11 类） |
| `is_sqlite_lock_error` / `is_transient_sqlite_error` | hermes_state_errors.py:49 / :65 | 重试判定（503 vs 500） |
| `SessionSchemaMixin` | hermes_state_schema.py:187 | 打开时的 schema 编排 |
| `apply_declared_schema` / `reconcile_state_schema` | hermes_state_schema.py:1341 / :1354 | 幂等 DDL / 列调和 |
| `retry_deferred_fts_recovery` | hermes_state_schema.py:558 | FTS 恢复的退避重试 |
| `queue_token_counts` | hermes_state_usage.py:107 | 入队 token 增量（O(1)） |
| `flush_token_counts` | hermes_state_usage.py:159 | 精确读前排空 |
| `terminal_admission` / `retry_terminal_admission` | hermes_state_terminal.py:118 / :124 | 墓碑查询与精确重放 |

## 本组文件清单（5 个）

| 文件 | 行数 | 角色 |
|---|---|---|
| `hermes_state_gateway.py` | 1033 | 路由索引、peers、orphans、heartbeats、handoffs |
| `hermes_state_errors.py` | 326 | StateDbCorruptError 等异常 + 字符串级分类谓词 |
| `hermes_state_schema.py` | 1367 | 声明式 DDL、列调和、FTS 重建编排（打开时） |
| `hermes_state_usage.py` | 469 | 合并式后台 token 写入器 + 每模型用量行 |
| `hermes_state_terminal.py` | 170 | 私有 terminal 墓碑查询（精确重放专用） |

## 64 文件全覆盖核对

前七篇清单 ∪ 本篇清单 = 全部 64 个 `hermes_state_*.py` 根级兄弟（截至当前树；任务书按 66 计，实际以文件系统为准）：

| 篇 | 文件数 | 明细 |
|---|---|---|
| `facade.md` | 6 | common, ids, keys, identity, registry, portability |
| `wal_mutations.md` | 19 | wal, runtime, mutations, mutation_binding/branch/chat_pick/compress/guards/prepared/reset/retirement/transcript, runtime_workers, worker_compression/context/lifecycle, local, local_lineage, local_migration |
| `sessions_messages.md` | 11 | sessions, sessions_model_config, session_list, messages, titles, timeline, todo, detached_results, stored_reads, telegram, user_copy |
| `compression_state.md` | 5 | compression, coverage, compaction_display, prune_rewrite, api_content |
| `locks_guards.md` | 8 | guard, lockguard, lockowners, holders, pidns, health, dbfile, readpool |
| `search_maintenance.md` | 10 | fts, search, maintenance, repair, profile_repair, reconcile, rewind, legacy_refusal, media, prompt_refresh |
| `misc_state.md`（本篇） | 5 | gateway, errors, schema, usage, terminal |
| **合计** | **64** | 与 `ls hermes_state_*.py` 逐一对应，无遗漏、无重复 |

## 与其他模块的关系

- **gateway**：本组 `SessionGatewayMixin` 是 `gateway/session.py` 路由索引的直接后端；`session_admissions`/`worker_executions`/`gateway_routing` 表的读写分散在 runtime（回执）与本模块（索引/心跳）。
- **`hermes doctor` / `hermes status`**：`classify_persistence_error` 的桶 + `hermes_state_user_copy` 的文案 = 每个故障一张"发生了什么、怎么办"的卡片。
- **agent / turn loop**：`queue_token_counts` 由轮次记账调用；`api_call_count`、per-model 行喂 dashboard 用量页。
- **run_agent / TUI**：schema 编排决定首次打开的耗时特征；`retry_deferred_fts_recovery` 保证被挡的恢复不丢。

## 总结

这五个文件没有共同主题，但有一个共同气质：**做某张表/某类错误的唯一权威**。gateway 持久化独占路由与 peer 语义，errors 独占"什么算什么"，schema 独占打开时的编排，usage 独占记账节奏，terminal 独占墓碑协议。至此，64 个兄弟各归其位——门面组装它们，回执事务约束它们，谱系与守卫保护它们，这一层就完整了。
