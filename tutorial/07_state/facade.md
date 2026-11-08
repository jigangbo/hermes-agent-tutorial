# 门面与基础设施：hermes_state.py 与它的六块基石

## 文件概览

`hermes_state.py` 是状态持久层的门面：约 1738 行里，它只做四件事——组装 `SessionDB` 的 mixin MRO、管理写连接与写耐心、守护文件身份（替换/世代丢失/损坏检疫）、提供 token 队列与 meta 键值等门面级工具。**行为都住在兄弟模块里，门面不实现具体业务**，这是 AGENTS.md "facade + siblings" 布局的标准形态。

本篇同时讲门面脚下的六块基石：`hermes_state_common.py`（破导入环的共享层）、`hermes_state_ids.py`（id 铸造）、`hermes_state_keys.py` / `hermes_state_identity.py`（身份与键）、`hermes_state_registry.py`（进程内共享）、`hermes_state_portability.py`（导出/导入）。

## 关键代码走读

### 1. SessionDB 的 mixin 组装（MRO 即架构图）

```python
# hermes_state.py:464-471
class SessionDB(
    SessionSessionsMixin, SessionFtsSetupMixin, SessionSearchMixin, SessionSchemaMixin,
    SessionPortabilityMixin, SessionTelegramTopicsMixin, SessionCompressionMixin,
    SessionGatewayMixin, SessionMaintenanceMixin, SessionUsageMixin, SessionTitlesMixin,
    SessionMessagesMixin, SessionPruneRewriteMixin, SessionApiContentMixin, SessionCoverageMixin, SessionRewindMixin, SessionProfileRepairMixin,
    SessionPromptRefreshMixin,
):
    """SQLite-backed session storage with FTS5 search; many reader threads, one writer (WAL)."""
```

直接基类共 **18 个 mixin**；`SessionMessagesMixin` 自身又继承 `SessionDetachedResultsMixin`、`SessionTodoResultMixin`、`SessionStoredReadsMixin`（`hermes_state_messages.py:124`），所以 MRO 里实际有 21 个 mixin 模块。任何一个模块都"必须绝不 import hermes_state"（否则成环）。

### 2. 默认库路径与导入时快照

```python
# hermes_state.py:179-204
DEFAULT_DB_PATH = _IMPORT_DEFAULT_DB_PATH = get_hermes_home() / "state.db"
...
def _default_db_path() -> Path:
    """Default state DB path at CALL time: a re-pointed ``DEFAULT_DB_PATH`` wins, else
    ``get_hermes_home()`` is resolved fresh (a runtime HERMES_HOME redirect works regardless of import)."""
    return DEFAULT_DB_PATH if DEFAULT_DB_PATH != _IMPORT_DEFAULT_DB_PATH else get_hermes_home() / "state.db"
```

canonical store 就是 `HERMES_HOME/state.db`。导入时快照 `_IMPORT_DEFAULT_DB_PATH` 让测试 monkeypatch `DEFAULT_DB_PATH` 常量也能被 `_default_db_path()` 感知；运行时重定向 `HERMES_HOME` 则无需补丁即可生效。

### 3. 写连接与耐心预算常量

```python
# hermes_state.py:488-508
_WRITE_PATIENCE_S, _TRANSCRIPT_WRITE_PATIENCE_S, _ACTIVITY_WRITE_PATIENCE_S = 20.0, 60.0, 0.5
...
_COMPRESSION_BUSY_WAIT_S = 5.0
_WRITE_RETRY_MIN_S, _WRITE_RETRY_MAX_S = 0.020, 0.150  # fast jitter for the first _SLOW_AFTER_S
_WRITE_RETRY_SLOW_AFTER_S = 2.0
_WRITE_RETRY_SLOW_MIN_S, _WRITE_RETRY_SLOW_MAX_S = 0.250, 1.000
# PASSIVE WAL checkpoint every N successful writes.
_CHECKPOINT_EVERY_N_WRITES = 50
# Bounded FTS ``'merge'`` (ms of lock each) instead of ``'optimize'`` (9-18s per index on a 10GB
# DB, longer than a writer's patience); up to _COMMANDS_PER_PASS per index, stopping on no-progress.
_FTS_MERGE_EVERY_N_WRITES, _FTS_MERGE_MAX_PAGES_PER_INDEX, _FTS_MERGE_COMMANDS_PER_PASS = 1000, 500, 4
```

### 4. `_execute_write`：抖动重试 + 回调整体重跑

```python
# hermes_state.py:1014-1021（节选 docstring）
def _execute_write(
    self, fn: Callable[[sqlite3.Connection], T], patience_s: Optional[float] = None,
) -> T:
    """Run *fn(conn)* inside BEGIN IMMEDIATE with jittered lock retry; commit
    is handled here (callers must not commit). Returns *fn*'s result.
    BEGIN IMMEDIATE takes the WAL write lock up front so contention surfaces
    immediately; on locked/busy the Python lock is released, a jitter slept,
    and the WHOLE callback retried — *fn* must stay idempotent under retry."""
```

成功路径上每 50 写做一次 PASSIVE checkpoint、每 1000 写做一次有界 FTS merge（`hermes_state.py:1063-1067`）；压缩锁冲突单独走 `_COMPRESSION_BUSY_WAIT_S` 的短预算，耗尽仍被锁则**拒绝写**（租约是正确性边界，不是普通忙碌信号）。

### 5. 读路径分裂：只读池 + 降级

```python
# hermes_state.py:927-936（节选）
@contextmanager
def _read_ctx(self, *, reopen: bool = True, pooled_only: bool = False) -> Iterator[sqlite3.Connection]:
    """Yield a connection for read-only statements: a pooled read-only
    connection with NO lock under WAL; otherwise (non-WAL, open failure,
    ceiling reached) the writer connection under self._lock — deliberate
    degradation: slower beats EMFILE, which the supervisor cannot see."""
```

WAL 已确认时读走 `mode=ro` 池（上限由 `hermes_state_readpool` 的每文件/每进程预算决定）；否则借用写连接并在 DELETE 模式下临时抬高 `busy_timeout`（`hermes_state.py:971-978`）。

### 6. registry 共享：close() 变成释放引用

```python
# hermes_state.py:1536-1543（节选）
def close(self):
    ...
    if self._shared_registry_owned:
        from hermes_state_registry import release
        release(self)
        return
```

经 `hermes_state_registry.acquire()` 打开的实例，`close()` 只减引用计数，物理连接的生死归注册表管——一个调用者的 close 不能拆掉同进程其他调用者还在用的写连接。

### 7. common：破导入环的共享层

```python
# hermes_state_common.py:1-2
"""Shared constants and helpers for the SessionDB family of modules.  Lives outside hermes_state so
the mixin modules can import it without a cycle."""
```

标题出处常量（`TITLE_SOURCE_DERIVED/LLM/USER`，:22-24）、预览 SQL、`escape_like`、`stat_db_file_identity`、schema SQL 等都在这里。它也反向 late-import（如 `:44-52` 的 `routed_sessions_setting` 在函数内 import config），把"哪个 profile 的配置"在多路复用下读对。

### 8. 兄弟的 late-import seam

兄弟模块不 import 门面，但在**函数体内** late-import 门面拿常量/类型：

```python
# hermes_state_titles.py:62-73（节选）
@staticmethod
def sanitize_title(title: Optional[str]) -> Optional[str]:
    """Strip control/zero-width/bidi chars (and lone surrogates sqlite3 cannot bind),
    collapse whitespace, normalize empty to None. ValueError past MAX_TITLE_LENGTH."""
    from hermes_state import SessionDB          # ← 函数内 late import，破环
    ...
    if len(cleaned) > SessionDB.MAX_TITLE_LENGTH:
```

这形成一条工程约定：**给生产代码打补丁时要打在定义处，而测试可通过门面 patch**——门面是 seam。

### 9. ids：会话 id 的唯一铸造点

```python
# hermes_state_ids.py:53-60
DEFAULT_HEX_LEN = 6


def new_session_id(now: Optional[datetime] = None, *, hex_len: int = DEFAULT_HEX_LEN) -> str:
    """``<timestamp>_<random hex>`` for a fresh session; ``now`` pins the timestamp to a clock the
    caller already captured (``agent.session_start``) so the id and the row agree to the second."""
    stamp = (now or datetime.now()).strftime("%Y%m%d_%H%M%S")
    return f"{stamp}_{uuid.uuid4().hex[:hex_len]}"
```

形状是 `YYYYMMDD_HHMMSS_<hex>`；交互面用 6 位 hex，gateway 8 位、portability 导入 12 位（同一秒铸多行）。`SESSION_ID_RECOGNIZERS`（:21-39）枚举所有表面派生的 id 形状（`cron_*`、`bg_*`、`room_*`、`api_*`、uuid4 等），salvage 靠它区分"像会话 id 的单元格"。

### 10. keys / identity：身份派生与 durable 消息身份

```python
# hermes_state_keys.py:62-74
def admission_fingerprint(*, canonical_target: str, payload: dict) -> str:
    """Canonical payload identity after authorization and immutable media capture."""
    encoded = json.dumps(
        {'target': canonical_target, 'payload': payload}, ensure_ascii=False,
        sort_keys=True, separators=(',', ':'), allow_nan=False,
    ).encode('utf-8', errors='surrogatepass')
    return hashlib.sha256(encoded).hexdigest()


def local_identity(profile_id, principal_id, request_id):
    """The deterministic session id of a LOCAL creation receipt."""
    identity = json.dumps([profile_id, principal_id, request_id], separators=(',', ':'))
    return 'local-' + hashlib.sha256(identity.encode()).hexdigest()
```

`hermes_state_identity.py` 是 schema v31 引入的 durable message identity 列（`message_uid` / `absorbed_message_uids` / `tool_call_uids` / `tool_call_uid`）在"活字典 ↔ 存储行"两个表示之间的编解码器（`hermes_state_identity.py:1-3`），转录写入、恢复与修复共用一套，不漂移。

### 11. portability：导出/导入

```python
# hermes_state_portability.py:347-366（节选签名与契约）
    def export_session(self, session_id: str, include_compacted: bool = False,
                       ...
# hermes_state_portability.py:789
    def import_sessions(self, sessions: list[dict[str, Any]]) -> dict[str, Any]:
```

导出产出自包含 payload（含 `_export_timings` 计时与行数），导入走 `_IMPORT_SESSION_INSERT_SQL`（:43-64）并受门面常量约束：`_IMPORT_MAX_SESSIONS=500`、单会话 10k 条、总量 50k 条消息 / 25 MiB（`hermes_state.py:510-511`）——导入持有一个 `BEGIN IMMEDIATE`，上限刻意低于导出。

## 核心类/函数

| 名称 | 位置 | 职责 |
|---|---|---|
| `SessionDB` | hermes_state.py:464 | 门面类；18 直接 mixin + 3 嵌套 mixin 组成 MRO |
| `AsyncSessionDB` | hermes_state.py:1725 | 异步门：所有调用经 `asyncio.to_thread` 卸载 |
| `SessionDB.__init__` | hermes_state.py:584 | 测试隔离检查→建连→schema→记录文件身份 |
| `_open_writer` | hermes_state.py:679 | 预检、清零检疫、连接+schema、世代戳、OFD 锁守卫 |
| `_open_read_only` | hermes_state.py:731 | 跨 profile 只读 attach（无 schema 初始化、无写锁） |
| `_execute_write` | hermes_state.py:1014 | BEGIN IMMEDIATE + 抖动重试 + checkpoint/FTS 节拍 |
| `_read_ctx` | hermes_state.py:927 | 读连接借出（池→写连接降级） |
| `close` | hermes_state.py:1527 | 排空 token 队列→PASSIVE checkpoint→锁守卫释放 |
| `_halt_db_corrupt` | hermes_state.py:1351 | 结构性损坏检疫（sticky，进程内广播） |
| `new_session_id` | hermes_state_ids.py:56 | 铸造 `YYYYMMDD_HHMMSS_<hex>` |
| `is_known_session_id` | hermes_state_ids.py:42 | 形状识别（salvage 用） |
| `local_identity` / `admission_fingerprint` | hermes_state_keys.py:71 / 62 | 本地回执确定性 id / 载荷指纹 |
| `_restore_identity_columns` | hermes_state_identity.py:92 | 恢复时把身份列放回活字典 |
| `acquire` / `release` | hermes_state_registry.py:195 / 216 附近 | 每路径共享代际的引用计数 |
| `export_session` / `import_sessions` | hermes_state_portability.py:347 / 789 | 会话导出与导入 |

## 本组文件清单

| 文件 | 行数 | 角色 |
|---|---|---|
| `hermes_state.py` | 1738 | 门面：SessionDB 组装、写路径、文件身份、token 队列 |
| `hermes_state_common.py` | 1504 | 家族共享常量/SQL 片段，位于 hermes_state 之外破导入环 |
| `hermes_state_ids.py` | 60 | 会话 id 铸造 + 全表面 id 形状识别器（stdlib-only） |
| `hermes_state_keys.py` | 92 | cron 请求 id、指纹、`local-` 身份等纯派生函数 |
| `hermes_state_identity.py` | 111 | schema v31 durable message identity 编解码器 |
| `hermes_state_registry.py` | 478 | 进程级每路径 refcount 共享 SessionDB + 代际退休 |

## 与其他模块的关系

- **gateway**：`gateway/session.py` 的 `SessionStore` 经 registry `acquire()` 拿共享句柄；`local_identity`/`profile_from_session_key`（keys.py:77-92）是 gateway 会话键的存储侧副本。
- **agent / tui_gateway**：`AsyncSessionDB` 供异步服务器；`SessionResumeTooLargeError`（hermes_state.py:117）是 resume 上限的面向用户拒绝。
- **cron**：scheduler 借还句柄、meta 键值（`state_meta`）承载调度簿记（`get_meta/set_meta`，hermes_state.py:1650-1667）。
- **tests**：`_ensure_test_isolation`（hermes_state.py:214）配合 `hermes_state_guard.py` 在 pytest 上下文里拒绝打开生产库。

## 总结

门面把"多进程共写一个 SQLite 文件"的全部难点集中在 `__init__`/`_execute_write`/`close` 三个方法里：打开时检疫与守卫、写入时耐心与节拍、关闭时干净收代。六个基石模块则各管一件纯事：共享常量、id、键、身份、共享注册表、可移植性。下一章进入 WAL 与 mutation 回执事务——这一层真正的"写协议"。
