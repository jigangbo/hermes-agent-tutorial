# 检索与维护：FTS、修剪、修复与 /undo

## 文件概览

状态库不仅要写得对，还要**找得到、瘦得下、坏得起**。本组十个文件覆盖三件事：

- **检索**：`hermes_state_fts.py`（FTS5 索引 ensure 与 tokenizer 能力回退）+ `hermes_state_search.py`（全文/trigram/CJK 检索与重建引擎）。
- **维护**：`hermes_state_maintenance.py`（保留修剪、陈旧归档、VACUUM）、`hermes_state_repair.py`（修复/备份/可写性预检）、`hermes_state_profile_repair.py`（跨 profile 修复）、`hermes_state_reconcile.py`（schema 漂移）、`hermes_state_media.py`（durable 媒体回收）、`hermes_state_prompt_refresh.py`（提示词刷新 epoch）。
- **回退**：`hermes_state_rewind.py`（/undo /retry 的 carrier-aware user-turn 回退）与 `hermes_state_legacy_refusal.py`（旧版安全拒绝行的一次性迁移修复）。

## 关键代码走读

### 1. FTS 布局注册表：版本化 DDL

```python
# hermes_state_fts.py:39-62（节选）
# Every stored definition a released version has created, oldest first; the LAST entry is the one this code
# creates. optimize-storage rebuilds only the older entries: an unrecognised definition (a newer release's, after
# a downgrade) is left alone. Literal on purpose: a change to FTS_SQL / FTS_TRIGRAM_SQL fails
# test_the_layout_registry_ends_with_the_shipping_ddl until its new form is appended here...
FTS_VTABLE_LAYOUTS: dict[str, tuple[str, ...]] = {
    "messages_fts": (
        "CREATE VIRTUAL TABLE messages_fts USING fts5(content,content=messages,content_rowid=id)",
        ...
        "CREATE VIRTUAL TABLE messages_fts USING fts5(content,tool_name,tool_calls,"
        "content='messages_fts_src',content_rowid='id')",
    ),
    "messages_fts_trigram": (... tokenize='trigram' ...),
}
```

注册表把"历史上发过哪些 FTS 定义"钉成字面量；`fts_layout_drift`（:93）报告旧布局（optimize-storage 的重建对象），`fts_layout_current`（:105）判定当前态（`fts_storage_version` 唯一可盖戳的状态）。tokenizer 能力回退：无 trigram 支持的 SQLite 上 `messages_fts_trigram` 直接不建（只读 attach 用 SELECT 探测，hermes_state.py:743-747）。

### 2. FTS 损坏的 fail-open

FTS 影子表损坏会让每次写都炸（同步触发器），而 canonical 行完好。写路径 `_execute_write` 里 `_enter_fts_fail_open`（hermes_state.py:1126）**原子卸下 FTS 触发器并重试**——绝不在写路径重建。判定谓词 `is_fts_scoped_corruption_error`（hermes_state_errors.py:122）让"SQLITE_CORRUPT_VTAB 结果码优先于散文"。

### 3. 检索引擎

```python
# hermes_state_search.py:1154-1160（签名节选）
    def search_messages(
        self, ...,
    ) -> ...:
# hermes_state_search.py:1348 / :1368
    def optimize_fts(self) -> int:
    def rebuild_fts(self) -> int:
```

`SessionSearchMixin`（:288）承载 `search_messages`（FTS5 MATCH + trigram 子串 + CJK 兜底三路）、`search_sessions_by_id`（:1311，前缀/模糊找会话 id）、`fts_rebuild_step`（:385，分窗后台重建，`_BackfillProgress` 按行数计进度——prune 后的 id 空洞不会让进度从 0% 跳 99%）、`optimize_fts_storage`（:772，影子表渐进排空，`_TeardownProgress` + `_HolderWatch` :84 边重建边盯外来持有者）。VACUUM 进度是"耗时对规模"而非百分比（`_VacuumProgress` :70）。

### 4. 保留修剪与 VACUUM 策略

```python
# hermes_state_maintenance.py:311-312 / :454-455 / :483（签名）
    def archive_stale_sessions(self, idle_days: float, *, exclude_pinned: bool = True) -> int:
    def vacuum(self) -> int:
    def maybe_auto_prune_and_vacuum(
```

`prune_empty_ghost_sessions`（:113）删空壳、`sweep_orphaned_sessions`（:160）收孤儿、`prune_sessions`（:369）按天数/来源删历史、`archive_stale_sessions`（:311）自动归档闲置（尊重 pin 与 `_AUTO_PRUNE_STALE_OPEN_SOURCES` 白名单，hermes_state.py:477-479——消息/UI 类来源有自己的生命周期 owner，未知来源 fail closed）。`maybe_auto_prune_and_vacuum`（:483）是后台钩子：修剪收益与 VACUUM 代价一起算账，`logical_size_bytes`（:428）用 page 统计给出"逻辑大小"。

### 5. 修复与可写性预检

```python
# hermes_state_repair.py:551-556（签名+docstring 节选）
def preflight_db_writability(db_path: Path, *, db_label: str = "state.db", directory_only: bool = False) -> None:
# hermes_state_repair.py:936
def repair_state_db_schema(db_path: Path, *, backup: bool = True) -> dict[str, Any]:
```

preflight 把"只读文件/目录"变成**可操作的报错**而非 sqlite 内部的 "attempt to write a readonly database"（`_open_writer` 两处调用，hermes_state.py:691/:707）。`repair_state_db_schema` 处理 malformed sqlite_master（先备份再原地修，`_claim_repair_attempt` 每进程每路径至多一次，hermes_state.py:420-424；跨进程手术锁 `_REPAIR_LOCK_TIMEOUT_SECONDS = 120`，为最慢合法持有者 VACUUM 留量）。`apply_durability_barriers`（:630）把 fsync 类屏障补到修复后的文件上；`state_db_has_structural_damage`（:747）是只读判定。

### 6. schema 漂移与浏览时自愈

```python
# hermes_state_reconcile.py:394 / :500（签名）
def reconcile_drift_for_browse(path: Path) -> bool:
def repair_declarative_schema(path: Path, *, backup: bool = True):
```

`schema_drift_reason`（:17）判定库与声明式 schema（`hermes_state_schema.reconcile_state_schema`，:1354）的差异类别；`reconcile_drift_for_browse` 让**读路径**也能在预算内（`_Budget` :190，含 busy_timeout 与超时 progress handler）自愈浅漂移，`BrowseBudgetExceeded`（:186）/`CorruptStoreError`（:263）把"太慢/真坏"分类抛出，`_SiblingStillBusy`（:320）区分兄弟进程占锁。

### 7. profile 修复与媒体回收

- `hermes_state_profile_repair.py`：`find_crossed_profile_sessions`（:77）找出"路由到 A profile 但行落在 B"的会话；`export_session_for_move`（:210）→ `import_moved_session`（:237）→ `delete_moved_session`（:278）构成搬家三步；`relabel_sessions_to_key_profile`（:162）与 `sever_crossed_parents`（:185）是原位小手术。
- `hermes_state_media.py`：`retire_media`（:11）在删除事务内把 admission 载荷里的媒体引用记成 durable 候选（`gateway.media.retired.v1.`）；`retire_spillover`（:21）同理记 spillover 归档名（指针将随行消失）；`collect_retired_media`（:55）在候选再无持有者时真正释放文件并删键——"退休候选"让删除事务不必同步删盘。

### 8. carrier-aware 回退（/undo /retry）

```python
# hermes_state_rewind.py:1-3（模块 docstring）
"""Carrier-aware user-turn rewind (``/undo``, ``/retry``) — the ONE implementation behind the CLI, the
gateway and the TUI. Rewind is a persisted-history operation: the durable transcript is the authority,
the warm (in-memory) history only has to agree with it. A composite compaction carrier (retained
summary + live human ask in one row) keeps its hidden handoff scaffold as the new head."""
```

`plan_user_turn_rewind`（:236）产出 `RewindPlan`（目标、将停用的 ids、预览），`rewind_user_turn`（:182）落库（底层即 `hermes_state_mutation_transcript.rewind_in_transaction`）；`retain_refused_turn_for_display`（:95）把刚被安全过滤拒绝的整轮移出模型上下文、同时在显示面保留灰色 `content_refused` 通知——注意它**住在 owner 侧**（持直接 SessionDB 的 CLI/ACP），不是 worker 对 RuntimeSessionStore 的调用。

### 9. legacy 拒绝修复与提示词刷新

- `hermes_state_legacy_refusal.py`：#149708 之前的构建把拒绝轮留在上下文里，整条聊天被锁死。本模块以 `failed_turn` 边界上的 `content_policy_blocked` 元数据为标记做**一次性数据迁移**（`repair_legacy_refused_turns` :252，`advance_legacy_refusal_repair` :304）：只动"最新稳定轮全是拒绝"的交互聊天；拒绝后有真实回答、已折进压缩摘要、非聊天来源（cron/subagent/kanban…）一律不动。发现阶段无写锁（每会话一次索引探测），写锁只按修复的会话取。
- `hermes_state_prompt_refresh.py`：`request_prompt_refresh`（:22）在 `state_meta` 写 `prompt_refresh.epoch`（profile 级）或 `prompt_refresh.epoch:<sid>`（会话级），`prompt_refresh_epoch`（:41）读"适用于该会话的最新 epoch"。agent 侧的 `agent/prompt_refresh.py` 据此决定下一轮是否重建提示词——epoch 也随压缩轮转带到子行（见 compression 组 `_CONVERSATION_MODEL_CONFIG_KEYS`）。

## 核心类/函数

| 名称 | 位置 | 职责 |
|---|---|---|
| `FTS_VTABLE_LAYOUTS` | hermes_state_fts.py:44 | FTS 定义的历史注册表（末项=当前） |
| `fts_layout_drift` / `fts_layout_current` | hermes_state_fts.py:93 / :105 | 旧布局报告 / 当前态判定 |
| `search_messages` | hermes_state_search.py:1154 | 全文/trigram/CJK 检索 |
| `fts_rebuild_step` | hermes_state_search.py:385 | 分窗后台重建（行数进度） |
| `optimize_fts_storage` | hermes_state_search.py:772 | 影子表渐进排空（含 holder watch） |
| `archive_stale_sessions` | hermes_state_maintenance.py:311 | 闲置自动归档（来源白名单） |
| `prune_sessions` | hermes_state_maintenance.py:369 | 保留修剪 |
| `maybe_auto_prune_and_vacuum` | hermes_state_maintenance.py:483 | 后台修剪+VACUUM 决策 |
| `preflight_db_writability` | hermes_state_repair.py:551 | 打开前的可写性预检（可操作报错） |
| `repair_state_db_schema` | hermes_state_repair.py:936 | malformed sqlite_master 的备份+原地修复 |
| `find_crossed_profile_sessions` | hermes_state_profile_repair.py:77 | 跨 profile 行发现 |
| `export_session_for_move` / `import_moved_session` | hermes_state_profile_repair.py:210 / :237 | 会话搬家 |
| `reconcile_drift_for_browse` | hermes_state_reconcile.py:394 | 读路径预算内自愈 schema 漂移 |
| `rewind_user_turn` / `plan_user_turn_rewind` | hermes_state_rewind.py:182 / :236 | /undo /retry 的落库与计划 |
| `retain_refused_turn_for_display` | hermes_state_rewind.py:95 | 拒绝轮的 owner 侧保留 |
| `repair_legacy_refused_turns` | hermes_state_legacy_refusal.py:252 | 旧拒绝行的一次性迁移 |
| `retire_media` / `collect_retired_media` | hermes_state_media.py:11 / :55 | 媒体退休候选记账与回收 |
| `request_prompt_refresh` | hermes_state_prompt_refresh.py:22 | 刷新 epoch 计数器 |

## 本组文件清单（10 个）

| 文件 | 行数 | 角色 |
|---|---|---|
| `hermes_state_fts.py` | 437 | FTS5 索引 ensure、tokenizer 回退、布局注册表、fail-open 卸触发器 |
| `hermes_state_search.py` | 1441 | 全文/trigram/CJK 检索 + FTS 重建/优化/VACUUM 引擎 |
| `hermes_state_maintenance.py` | 591 | 保留修剪、陈旧会话归档、VACUUM 策略 |
| `hermes_state_repair.py` | 1242 | 修复/备份/可写性预检/耐久屏障 |
| `hermes_state_profile_repair.py` | 388 | 跨 profile 行发现与搬家修复 |
| `hermes_state_reconcile.py` | 514 | schema 漂移原因、预算化浏览时自愈 |
| `hermes_state_rewind.py` | 292 | carrier-aware user-turn 回退（/undo /retry 唯一实现） |
| `hermes_state_legacy_refusal.py` | 314 | 旧版安全拒绝行的一次性数据迁移 |
| `hermes_state_media.py` | 69 | durable 媒体退休候选（删除后仍可回收） |
| `hermes_state_prompt_refresh.py` | 54 | 系统提示词刷新 epoch（state_meta 计数器） |

## 与其他模块的关系

- **schema 组**（misc）：`hermes_state_schema` 在打开时编排 FTS ensure/重建，消费本组 `fts_layout_*` 与 `legacy_refusal` 迁移。
- **messages**：rewind 落到 `hermes_state_mutation_transcript.rewind_in_transaction`；prune 重写（compression 组）与 `rewritten_held_row_ids` CAS 协作。
- **`hermes doctor` / `optimize-storage`**：repair/reconcile/search 的导出面是这两条 CLI 的后端；`fts_layout_drift` 同时喂更新提示。
- **gateway/TUI**：`search_messages` 与 `get_session_timeline`（sessions 组）共同支撑面板搜索与跳转；`RewindOutcome` 是各端统一的回退结果。

## 总结

维护代码的第一性原则在文档串里反复出现：**绝不原地修库**（先备份、先检疫）、**预算内自愈**（读路径也修，但有 busy/时间预算）、**迁移一次性且可续**（state_meta 游标 + 一秒预算）、**回收走候选**（删除事务只记账，物理释放后置）。检索层则把"索引可以烂"当成常态设计：FTS 坏了就 fail-open 卸掉，canonical 行完好即可继续服务。
