# 会话与消息：sessions / messages 及其卫星模块

## 文件概览

如果说回执事务是"写协议"，这一组就是**数据本身**：`hermes_state_sessions.py`（1992 行）管会话行的生老病死，`hermes_state_messages.py`（1992 行）管转录的追加、替换、回退与显示投影。围绕它们的是九个卫星模块——标题、时间线、Todo 恢复、间隙结果、存储读投影、Telegram 话题、白话文案——各自从大文件里按 FILE_LINES 棘轮拆出，经 MRO 绑回 `SessionDB`。

所有 mixin 共享同一批原语：`_read_ctx`（读）、`_execute_write`（写）、`_read_one/_read_all`（便捷读）。

## 关键代码走读

### 1. 会话行的谱系 CTE

```python
# hermes_state_sessions.py:48-74（节选）
_LINEAGE_CTE_SQL = f"""
            WITH RECURSIVE
              ancestors(id) AS (
                SELECT ?
                UNION
                SELECT parent.id
                FROM ancestors a
                JOIN sessions child ON child.id = a.id
                JOIN sessions parent ON parent.id = child.parent_session_id
                WHERE parent.end_reason = 'compression'
{_non_continuation_child_sql('child.', 'parent.id')}
              ),
              descendants(id) AS (...)
```

压缩谱系只沿 `parent_session_id` 的 **compression 边**扩展；`_non_continuation_child_sql` 把 branch/delegate 子行排除在边之外（branch 是另一段对话，不是延续）。`_expand_compression_lineage_ids`（:159）是它的 Python 对偶，`_collect_delegate_child_ids`（:195）单独收集 delegate 子树。

### 2. 会话生命周期

```python
# hermes_state_sessions.py:418-423
    def create_session(self, session_id: str, source: str, **kwargs) -> str:
        ...
    def ensure_session(self, session_id: str, source: str = "unknown", model: str | None = None, **kwargs) -> str:
```

`create_session`/`ensure_session` 幂等建行；`end_session`（:479）与 `_end_and_bump`（:487）结束行并推 `conversation_generations`；`reopen_session`（:521）重开（同时停用未被排空队列的 accept 行，`retire_undrained_queue_rows` :505）；`promote_to_session_reset`（:546）把可恢复结束升格为 reset 边界；`delete_session`（:1713）/`delete_sessions`（:1846）执行级联删除。列表侧的 `list_sessions_rich`（:1309）按页投影会话行（含 prompt join、preview、last_active）。

### 3. 会话级 model_config 的读改写

```python
# hermes_state_sessions_model_config.py:12-33
def update_conversation_model_config_value(db, session_id: str, key: str,
                                           update: Callable[[Any], Any]) -> Optional[str]:
    """Read a conversation-wide ``key`` at *session_id*'s compression tip and write ``update(value)``
    back, in one write transaction: a concurrent writer of the key cannot be overwritten with a stale
    copy, and a rotation cannot publish between finding the tip and writing it (the child would keep
    the old copy). ``update`` may run more than once (lock retry) and must be pure; returning None
    removes the key. Returns the id written, None when the row does not exist."""
    def _do(conn) -> Optional[str]:
        tip = db._compression_tip_on(conn, session_id)
        row = conn.execute("SELECT model_config FROM sessions WHERE id = ?", (tip,)).fetchone()
        ...
        conn.execute("UPDATE sessions SET model_config = ? WHERE id = ?", (json.dumps(config), tip))
        return tip
    return db._execute_write(_do)
```

关键在"**先在事务内找 tip、再写 tip**"：轮转不能插在两步之间，否则子行带走旧副本。`session_ids_with_model_config_key`（:36）是反向索引扫描。

### 4. 会话列表页投影

```python
# hermes_state_session_list.py:5-9
def project_compression_tips(db, sessions: list[dict[str, Any]], compact_rows: bool) -> list[dict[str, Any]]:
    """Replace each compression root's surfaced fields with its live tip's (root ``started_at`` kept
    for stable ordering), one batched query. ``_lineage_ids`` carries every chain id (a tile may
    hold a MIDDLE segment's id)."""
```

列表显示的是 root 行，但内容画成 tip：批量取 tip 行（:15-19）后逐字段替换（id/ended_at/title/preview/model/cwd 等），root 的 `started_at` 保留用于稳定排序；投影行带上 `_lineage_root_id` / `_lineage_ids` / `continuation_kind="compression"`（:39-45），让客户端能标示"这是自动延续，不是新对话"。

### 5. 转录写入：一条 INSERT 形状

```python
# hermes_state_messages.py:34-41
# One INSERT shape for every message writer (append, batch, replace, compact, import).
_INSERT_MESSAGE_SQL = """INSERT INTO messages (session_id, role, content, tool_call_id,
                   tool_calls, tool_name, effect_disposition, timestamp, token_count, finish_reason,
                   reasoning, reasoning_content, reasoning_details, codex_reasoning_items,
                   codex_message_items, platform_message_id, observed, _compressed_summary, active, api_content, display_kind,
                   display_metadata, display_identity, message_uid, absorbed_message_uids, tool_call_uids,
                   tool_call_uid)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"""
```

append/batch/replace/compact/import 五条路共用一个 INSERT 形状；`_MESSAGE_WRITE_COLUMNS`（:45）由此派生。Mixin 头（:124-126）表明它叠在三个子 mixin 之上：

```python
# hermes_state_messages.py:124-126
class SessionMessagesMixin(SessionDetachedResultsMixin, SessionTodoResultMixin, SessionStoredReadsMixin):
```

主要入口：`append_message`（:397）、`append_messages_batch`（:431，`_execute_transcript_write` :474 提供 restore 语义）、`replace_messages`（:721，可选保留活跃前缀 `_stamp_kept_live_prefix` :788）、`get_messages`（:1385，可含 inactive/compacted）、`resolve_resume_session_id`（:1468，把 id 解析到压缩 tip 的 resume 目标）、`get_messages_as_conversation`（:1522，含祖先的完整组装）。

### 6. 转录写守卫

```python
# hermes_state_messages.py:214-216（签名）
    def _check_transcript_write_guards(self, conn, session_id: str, compression_lock_holder: Optional[str],
                                       *, reject_active_turn_lease: bool, ...) -> None:
```

每次转录写（含 mutation 里的 rewind）都过这道闸：活跃 turn 租约、活跃压缩锁、世代变更都会拒绝；这是"守卫在写连接上跑"原则在存储层的镜像。

### 7. reactions 与显示去重

reactions 存在 `display_metadata` 的 `reactions` 键里（`REACTIONS_METADATA_KEY`，hermes_state.py:1635），合并写用 `json_patch`（`hermes_state_common.py:86` 的 `_MERGE_DISPLAY_META`）——行级重写不能抹掉并发写入者加的键。`set_message_reaction`（hermes_state_messages.py:524）/`take_unseen_reactions`（:565）是其读写。显示投影 `_dedupe_display_generations`（:1143）按稳定身份折叠跨代副本，`_display_dedupe_key`（:1107）对工具行用 call-id 而非会被 prune 重写的参数（配合 `hermes_state_identity._stable_tool_key`）。

### 8. 标题：净化 + 出处排序

```python
# hermes_state_titles.py:62-74
    @staticmethod
    def sanitize_title(title: Optional[str]) -> Optional[str]:
        """Strip control/zero-width/bidi chars (and lone surrogates sqlite3 cannot bind),
        collapse whitespace, normalize empty to None. ValueError past MAX_TITLE_LENGTH."""
        from hermes_state import SessionDB
        if not title:
            return None
        cleaned = _TITLE_INVISIBLE_RE.sub('', _TITLE_CONTROL_RE.sub('', _sanitize_surrogates(title)))
        cleaned = re.sub(r'\s+', ' ', cleaned).strip()
        if not cleaned:
            return None
        if len(cleaned) > SessionDB.MAX_TITLE_LENGTH:
            raise ValueError(f"Title too long ({len(cleaned)} chars, max {SessionDB.MAX_TITLE_LENGTH})")
        return cleaned
```

出处按 `TITLE_SOURCE_DERIVED(0) < TITLE_SOURCE_LLM(1) < TITLE_SOURCE_USER(2)` 排序（`_title_rank` :54-59；NULL 视为 user，兼容前溯源时代的手打标题）。`bot_chat_title_released`（:17-24）是"归档的 Bot Chat 不再占用其名"的唯一判定；`next_title_in_lineage`（:36）产 "my session #2" 式命名。

### 9. 时间线：只读 prompt 索引 + 有界跳转

```python
# hermes_state_timeline.py:102-107
def get_session_messages_around(db, session_id, row_id, *, limit=120):
    """Read at most *limit* display rows starting at an exact human prompt.

    Existence probes/counts contain ids only. Full payloads are fetched only for
    the selected bounded page, even when the anchor is deep in a transcript."""
```

`_snapshot`（:42-51）把计数与页锁在同一读事务；`_display_rows_sql`（:54）优先用持久 display index（无 payload 只取 id），legacy 库退化为 SQL 窗口分组；`timeline_identity_content` / `timeline_preview` 两个确定性 SQL 函数（:88-99）在库内归一化 carrier 与生成预览。`get_session_timeline`（:142）输出分页 prompt 列表（cursor 是逻辑 turn 的首个物理行 id）。

### 10. Todo 恢复：索引化有界搜索

```python
# hermes_state_todo.py:30-44（节选）
        session_ids = self._resume_lineage_ids(session_id)
        with self._read_ctx() as conn:
            removed = self._removed_todo_copies(conn, session_ids)
            for sid in reversed(session_ids):
                before_id = 2**63 - 1
                while True:
                    rows = conn.execute(
                        "SELECT id, role, content, ... FROM messages INDEXED BY idx_messages_session_id "
                        f"WHERE session_id = ? AND id < ? AND role = 'tool' AND {_TODO_TOOLS} AND (active = 1 OR compacted = 1) "
                        "AND length(content) <= ? ORDER BY id DESC LIMIT 100",
                        (sid, before_id, max_chars),
                    ).fetchall()
```

沿 resume 谱系从新到旧分页搜 `todo_list`/`todo` 工具结果，要求与 assistant 调用配对、`todos` 是 list、revision 可解析；被 undo 移除的副本（`_removed_todo_copies` :98）不复活。

### 11. 间隙结果：恰好一次落成 user 行

```python
# hermes_state_detached_results.py:40-59（节选）
    def _append_detached_result(self, session_id: str, content: str, display_kind: str, metadata: dict[str, Any],
                                match_sql: str, params: tuple) -> int:
        """Record a result that arrived between turns as a user row once, including replay after rotation: a row
        ``match_sql`` (a condition on ``m``) finds in the compression lineage is returned instead. Check and insert
        share the writer transaction, so independent gateway processes cannot duplicate it; a live turn refuses it."""
```

去重键是**事件单元 id**（`delegation_id` / `completion_admission`），不是文本；`_LINEAGE_MATCH_SQL`（:13）把查重范围扩到压缩祖先——轮转后的重放也不会落第二行。

### 12. stored_reads / telegram / user_copy

- `hermes_state_stored_reads.py`：`session.transcript`、`session.list` picker 字段与 delegate 子行查找背后的存储读（:1-8 的 docstring 逐一列举）；全部是**固定次数索引探测**（`_HANDOFF_COPIES_SQL` :35 用三条索引分别覆盖 live/归档/NULL 世代），从不逐行回表。
- `hermes_state_telegram.py`：Telegram DM 话题模式的表 DDL（`_TOPIC_TABLES` :28-64，PK 以 `profile_name` 打头——同一 chat_id 跨 bot 共库会撞）与绑定/未链会话查询；mixin 在 :92。
- `hermes_state_user_copy.py`：`classify_persistence_error` 的 cause 桶 → 白话文案的**唯一**总表（`_STORAGE_FAILURES` :26），CLI 横幅、gateway 频道警告、TUI/Desktop RPC 错误共用，附带机器可读 `code`（GUI 可挂"Run doctor"按钮）；`describe_storage_failure`（:97）与 `storage_failure_details`（:110）是入口。

## 核心类/函数

| 名称 | 位置 | 职责 |
|---|---|---|
| `SessionSessionsMixin` | hermes_state_sessions.py:339 | 会话行生命周期/列表/删除 mixin |
| `create_session` / `ensure_session` | hermes_state_sessions.py:418 / :423 | 幂等建行 |
| `reopen_session` | hermes_state_sessions.py:521 | 重开 + 清理未排空 accept 行 |
| `list_sessions_rich` | hermes_state_sessions.py:1309 | 富列表查询（页投影的 SQL 来源） |
| `delete_session` | hermes_state_sessions.py:1713 | 会话级联删除 |
| `update_conversation_model_config_value` | hermes_state_sessions_model_config.py:12 | tip 上读改写 model_config 键 |
| `project_compression_tips` | hermes_state_session_list.py:5 | root→tip 的页投影 |
| `SessionMessagesMixin` | hermes_state_messages.py:124 | 转录持久化 mixin（叠 3 个子 mixin） |
| `append_message` / `append_messages_batch` | hermes_state_messages.py:397 / :431 | 追加（单/批） |
| `replace_messages` | hermes_state_messages.py:721 | 整体替换（可选保前缀） |
| `get_messages` | hermes_state_messages.py:1385 | 转录读取（含归档开关） |
| `resolve_resume_session_id` | hermes_state_messages.py:1468 | resume 目标解析到压缩 tip |
| `sanitize_title` | hermes_state_titles.py:62 | 标题净化（控制/零宽/bidi 字符） |
| `get_session_timeline` / `get_session_messages_around` | hermes_state_timeline.py:142 / :102 | prompt 索引与有界跳转 |
| `get_latest_todo_result` | hermes_state_todo.py:16 | resume 的最新有效 Todo |
| `append_delegation_delivery` / `append_completion_note` | hermes_state_detached_results.py:24 / :33 | 间隙结果恰好一次落行 |
| `describe_storage_failure` | hermes_state_user_copy.py:97 | cause 桶 → 白话文案 |

## 本组文件清单（11 个）

| 文件 | 行数 | 角色 |
|---|---|---|
| `hermes_state_sessions.py` | 1992 | 会话行生命周期 mixin：建/结束/重开/列表/删除/自动归档 |
| `hermes_state_sessions_model_config.py` | 42 | 会话级 model_config 读改写（压缩 tip 上，防轮转窗口） |
| `hermes_state_session_list.py` | 47 | `list_sessions_rich` 页投影（root 行画 tip 内容） |
| `hermes_state_messages.py` | 1992 | 转录 append/replace/rewind、reactions、resume 组装 |
| `hermes_state_titles.py` | 295 | 标题净化 + derived/llm/user 出处排序 + 谱系命名 |
| `hermes_state_timeline.py` | 168 | 只读 prompt 索引、有界跳转（不水合全转录） |
| `hermes_state_todo.py` | 112 | resume 恢复最新有效 Todo（索引化分页搜索） |
| `hermes_state_detached_results.py` | 59 | turn 间隙结果按事件单元 id 恰好一次记为 user 行 |
| `hermes_state_stored_reads.py` | 462 | `session.transcript`/picker 背后的存储读投影 |
| `hermes_state_telegram.py` | 370 | Telegram DM 话题模式 mixin（表 DDL + 绑定） |
| `hermes_state_user_copy.py` | 113 | 存储不可用白话文案总表（机器可读 code） |

（全文检索 `hermes_state_search.py` 不在本组，见 `search_maintenance.md`。）

## 与其他模块的关系

- **agent**：转录行的列契约对齐 `agent.transcript_repair._OWNED_COLUMNS`（hermes_state.py:1638-1646 的 `_CONVERSATION_ROW_COLUMNS` 注释明言）；`split_user_originated_turn`（agent.context_compressor）被 timeline/detached_results/rewind 共用。
- **gateway**：`SessionGatewayMixin`（misc 组）消费这里的会话行；Telegram 话题表由 gateway 平台适配器读写；`stored_reads` 是 RPC `session.transcript` 的存储端口。
- **压缩组**：`_resume_lineage_ids`、`_compression_tip_on` 定义在压缩/会话 mixin，messages/todo/detached_results 都依赖它们——组间是"谱系优先"。
- **errors**：`StateDbReplacedError` 等被 telegram/user_copy 捕获后转成用户可懂的降级提示。

## 总结

会话与消息是存储层的"表"，其余是"视图"。两张大文件守住不变量：谱系边只认 compression、一条 INSERT 形状、转录写必过守卫、显示投影身份稳定。卫星模块则把"大而全"拆成一题一文件，每个都只依赖门面原语与谱系原语——这让它能安全地被单独 patch 与测试。
