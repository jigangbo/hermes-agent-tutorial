# 状态层压缩：谱系、覆盖、显示与原位重写

## 文件概览

上下文压缩在存储层留下四类痕迹：**谱系**（`parent_session_id` 链 + `end_reason='compression'`）、**归档行**（`active=0, compacted=1` 或轮转到子会话）、**覆盖账目**（压缩器到底"持有"了哪些行）和**边车**（`api_content`——模型实际看到的字节）。本篇五个文件各管一类：

- `hermes_state_compression.py`（963 行）：谱系行走、冷却/连击计数器、压缩锁、turn 租约——压缩的"控制面"。
- `hermes_state_coverage.py`：原位压缩时判定哪些 durable 行确实被压缩器持有——提交正确性的"账面"。
- `hermes_state_compaction_display.py`：显示层把压缩过的工具结果画成**归档原貌**而非缩短 stub。
- `hermes_state_prune_rewrite.py`：proactive prune 的**原位行重写**（行 id 不变、内容变了）及其 CAS 陈旧探测。
- `hermes_state_api_content.py`：`api_content` 边车的两个回填写入。

## 关键代码走读

### 1. 谱系单步 SQL 与链行走

```python
# hermes_state_compression.py:30-50（节选）
_CHAIN_STEP_SQL = f"""
                    SELECT child.id
                    FROM sessions parent
                    JOIN sessions child ON child.parent_session_id = parent.id
                    WHERE parent.id = ?
                      AND parent.end_reason = 'compression'
                      AND {_sql_json_extract('child.model_config', '$._branched_from')} IS NULL
                      AND {_sql_json_extract('child.model_config', '$._delegate_from')} IS NULL
                      AND NOT ({_RESET_CHILD_SQL.format(a='child')})
                      AND COALESCE(child.source, '') != 'tool'
                    ORDER BY
                      CASE
                        WHEN child.end_reason = 'compression' THEN 0
                        WHEN child.ended_at IS NULL THEN 1
                        ELSE 2
                      END,
                      ...
                    LIMIT 1
                    """
```

"首选延续子"的四重排除（branch/delegate/reset/tool）与优先序（压缩边 > 未结束 > 已结束）定义了唯一推进方向——注释点名 #114271：reset fork 不是延续，跟着走会劫持 tip 投影。`_walk_compression_chain`（:92-108）据此 root-first 走链，`_CHAIN_CAP = 1000`（:82）防御截断谱系（#125041）。

```python
# hermes_state_compression.py:884-897（节选）
    def get_compression_chain(self, session_id: str) -> list[str]:
        ...
    def get_compression_tip(self, session_id: str) -> Optional[str]:
```

`get_compression_lineage`（:916）给出全链；这些读是 `sessions_messages` 组与 worker 回执读取的共享底座。

### 2. 租约：单事务声明

```python
# hermes_state_compression.py:62-76
def _claim_lease_row(conn, table: str, key_col: str, key: str, holder: str, now: float, expires_at: float,
                     stale) -> tuple[bool, Optional[str]]:
    """Single-transaction lease claim: DELETE a stale holder's row (``stale(holder,
    expires_at)``), INSERT OR IGNORE ours, then SELECT to confirm ownership (INSERT OR
    IGNORE gives no rowcount signal). Returns ``(acquired, reclaimed_holder)``."""
```

压缩锁（`compression_locks` 表）与 turn 租约（`session_turn_leases`）共用这个原语。上层的 `try_acquire_compression_lock`（:651）/`refresh_compression_lock`（:633）/`acquire_session_turn_lease`（:744）把"持有者进程已死"的判定（`hermes_state._compression_lock_holder_process_is_dead`，hermes_state.py:142）作为 `stale` 回调注入——PID 复用读作活着（保守），外来 PID 命名空间交给 TTL（见 pidns）。

### 3. 冷却与连击计数器

`record_compression_failure_cooldown`（:493）、`get/restore/clear_compression_failure_cooldown`（:508/:522/:551）管理失败冷却（`compression_failure_cooldown_until/error` 列）；`get/set_compression_fallback_streak`（:572/:576）、`ineffective_count`（:581/:587）、`overload_streak`（:612/:621）与 `recovery_deadline`（:592/:602）构成连击/恢复账本——worker 侧通过 `hermes_state_worker_compression.worker_cooldown_record` 等闭合 op 写同一批列。`_CONVERSATION_MODEL_CONFIG_KEYS`（:89）定义轮转时必须带到子行的全对话键（如 `prompt_refresh_epoch`）。

### 4. 覆盖：压缩器持有了哪些行

```python
# hermes_state_coverage.py:62-79（docstring 节选）
    def _carried_tail_ids(
        self, conn, tail_ids: list[int], compacted_messages: list[dict[str, Any]],
    ) -> tuple[dict[int, int], set[int]]:
        """Rows of *tail_ids* that *compacted_messages* already carry -> ``({row id: carrying dict index}, weak)``.

        A row above the watermark is normally a concurrent append the summary never saw, so the commit
        clones it after the compacted set. A row the compressor ALSO held ... is already in the compacted
        set as a carried copy; cloning it too stores the message twice... A claim must prove the occurrence
        AND the version, so the next request sees exactly what it would have seen with the clone minus the
        second copy: only a dict that names the row (``_row_id``, else ``message_uid``) may claim it, never
        matching text, which another surface can append independently."""
```

两遍声明：第一遍认领"点名且内容逐字节重放"（`_replays_as` :157）；第二遍允许"压缩器自己的重写能解释差异"（`_rewrite_explains` :192）且全库唯一携带该 uid 的 dict 认领。其余一律克隆——宁可重复，不可陈旧或缺模型输入。`_proved_coverage`（:398）汇总证据，`archive_and_compact`（messages，:908）据此决定归档集或回退水位。

### 5. 显示：归档原貌

```python
# hermes_state_compaction_display.py:26-32
def not_a_later_tool_copy_sql(alias: str) -> str:
    """Filter that drops *alias* rows that are a later copy of an archived tool result."""
    return (f" AND NOT ({alias}.role = 'tool' AND {alias}.message_uid IS NOT NULL AND EXISTS ("
            f"SELECT 1 FROM messages AS original WHERE original.session_id = {alias}.session_id "
            f"AND original.timestamp = {alias}.timestamp AND original.message_uid = {alias}.message_uid "
            "AND original.role = 'tool' AND original.active = 0 AND original.compacted = 1 "
            f"AND +original.display_order < {alias}.display_order AND {_ORIGINAL_VISIBLE_SQL}))")
```

规则只用身份（session、uid、timestamp、display slot），从不看内容、不改存储行：同一 slot 上活跃行胜出（in-place prune 的 stub 继续显示），更晚 slot 的拷贝让位于更早 slot 的归档原文。`later_tool_copy_ids`（:35）是 Python 对偶，供已加载行集合使用。文件头（:1-13）解释了为什么工具结果**故意**把 payload 留在显示键里——归档输出绝不能折叠进它的 stub。

### 6. 原位重写与 CAS 陈旧探测

```python
# hermes_state_prune_rewrite.py:29-48（docstring 节选）
    def rewritten_held_row_ids(self, session_id: str, held: list[dict[str, Any]]) -> list[int]:
        """Ids among *held* message dicts whose ACTIVE row no longer holds the payload the dict holds.

        An in-place commit (the proactive prune's ``rewrite_pruned_rows``) changes what a row says and
        keeps its id and its ``active`` flag, so an id/activity staleness check cannot see it. A lease-less
        writer holding the pre-rewrite bodies must not publish them: that archives rows it never compared
        and republishes the stale text over the newer generation (#124102)."""
```

比较是**表示安全**的：活字典内容先过加载器镜头（`_loaded_view_content`），或直接用字典携带的存储行 CAS 摘要（`DB_ROW_SNAPSHOT`）；`held_row_mismatches`（:52）是调用者已持事务连接时的版本——**预检必须在 `BEGIN IMMEDIATE` 窗口内**，否则 check 与 commit 之间落下的重写会被归档。`rewrite_pruned_rows`（:133）本身是原语：固定列（session_id/role/timestamp/active/display_identity）永不移动，只有"行说什么"变。

### 7. api_content 边车回填

```python
# hermes_state_api_content.py:17-39（节选）
    def set_latest_user_api_content(self, session_id: str, content: Any, api_content: str) -> int:
        """Backfill the ``api_content`` sidecar onto the newest ACTIVE user row (0/1 rows). Preflight compaction
        inserts that row BEFORE the sidecar exists and the later persist identity-skips compacted dicts;
        without this a reload reopens the prompt-cache divergence. ``content`` match guards a racing rewrite.
        POSITIONAL, and only safe when the caller already knows the newest active user row IS the message
        it stamped. ..."""
        return self._write_rowcount(
            "UPDATE messages SET api_content = ? WHERE id = (SELECT id FROM messages "
            "WHERE session_id = ? AND role = 'user' AND active = 1 ORDER BY id DESC LIMIT 1"
            ") AND content IS ?",
            (_scrub_surrogates(api_content), session_id, self._encode_content(content)))
```

`set_message_api_content`（:41-67）是**按行寻址**的孪生：调用者传 `_row_id`，不会落到"恰好同样文本"的邻居行——重复的 "ok"/"continue" 会让 positional 版本写错行（docstring 点名为"更糟的缓存破坏"）。两者都保留 `active=1` + content 匹配作为防御栏。

## 核心类/函数

| 名称 | 位置 | 职责 |
|---|---|---|
| `SessionCompressionMixin` | hermes_state_compression.py:181 | 谱系/锁/租约/冷却 mixin |
| `_CHAIN_STEP_SQL` / `_walk_compression_chain` | hermes_state_compression.py:30 / :92 | 压缩链的单步与全程行走 |
| `_claim_lease_row` | hermes_state_compression.py:62 | 压缩锁与 turn 租约共用的单事务声明 |
| `try_acquire_compression_lock` | hermes_state_compression.py:651 | 取压缩锁（可回收死进程持有） |
| `acquire_session_turn_lease` | hermes_state_compression.py:744 | 取会话 turn 租约 |
| `record_compression_failure_cooldown` | hermes_state_compression.py:493 | 失败冷却记账 |
| `SessionCoverageMixin` | hermes_state_coverage.py:59 | 覆盖判定 mixin |
| `_carried_tail_ids` / `_proved_coverage` | hermes_state_coverage.py:62 / :398 | 尾行认领与覆盖证明 |
| `not_a_later_tool_copy_sql` | hermes_state_compaction_display.py:26 | 显示层"归档原貌"过滤（SQL） |
| `later_tool_copy_ids` | hermes_state_compaction_display.py:35 | 同上的 Python 对偶 |
| `rewritten_held_row_ids` | hermes_state_prune_rewrite.py:29 | 原位重写后的 CAS 陈旧探测 |
| `rewrite_pruned_rows` | hermes_state_prune_rewrite.py:133 | prune 的原位行重写提交 |
| `set_latest_user_api_content` | hermes_state_api_content.py:17 | 边车回填（positional，需调用者确证） |
| `set_message_api_content` | hermes_state_api_content.py:41 | 边车回填（按行寻址，默认选择） |

## 本组文件清单（5 个）

| 文件 | 行数 | 角色 |
|---|---|---|
| `hermes_state_compression.py` | 963 | 谱系、冷却/连击、压缩锁、turn 租约（控制面） |
| `hermes_state_coverage.py` | 483 | 原位压缩的持有行覆盖判定（两遍认领 + 证明） |
| `hermes_state_compaction_display.py` | 54 | 显示层把压缩工具结果画成归档原貌（身份规则） |
| `hermes_state_prune_rewrite.py` | 274 | proactive prune 原位行重写 + 事务内 CAS 探测 |
| `hermes_state_api_content.py` | 67 | `api_content` 边车的两个回填写入 |

## 与其他模块的关系

- **mutation 压缩**：`hermes_state_mutation_compress.compress_in_transaction` 调 `archive_on_connection`/`publish_on_connection`（worker_compression）完成归档与发布；本组的锁/租约是它的守卫面。
- **messages**：`archive_and_compact`（hermes_state_messages.py:908）是压缩的物理写入口，消费 coverage 的结论与 `_ARCHIVE_ACTIVE_SQL`（hermes_state_messages.py:74）。
- **runtime**：守卫 `_require_transcript_unleased`（mutation_guards:34）用 `_ENDED_ROW_SQL`/`_ended_by_compression` 判定"逻辑 owner 已被压缩关闭"。
- **timeline / display**：compaction_display 的 SQL 被 `_display_rows_sql`（timeline）与 stored_reads 复用，保证压缩后各端显示一致。
- **worker**：`CompressionSnapshot`（worker_compression:103）直接借用本组 `get_compression_chain` 等读算法。

## 总结

压缩在存储层被拆成"控制面"（锁、租约、冷却）与"数据面"（归档、覆盖、显示、重写）。控制面的原则是租约即正确性边界——宁可拒绝写也不硬闯；数据面的原则是**证明优于猜测**——覆盖要证明确实持有，重写要 CAS 比对，显示要按身份而不是内容。`api_content` 边车则守护最后一段一致性：用户行落库了，但模型看到的字节还没落时，由回填补齐，且必须按行寻址。
