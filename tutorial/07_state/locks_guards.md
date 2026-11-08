# 锁、守卫与持有者：谁在用这个文件

## 文件概览

`state.db` 会被多个进程同时打开，因此"谁持有写锁""这个进程是否测试进程""文件是否被换掉"是持久层每天要回答的问题。本组八个文件构成一张**进程与文件健康**的防护网：

- `hermes_state_guard.py`：活库测试隔离守卫——pytest 上下文的进程绝不打开生产库。
- `hermes_state_lockguard.py`：把 WAL 文件锁补成 OFD（open file description）锁，防本进程内游离的 `close()` 取消 SQLite 自己的 POSIX 锁。
- `hermes_state_lockowners.py`：读 `/proc/locks`，在写等待超时时点名持锁者。
- `hermes_state_holders.py`：结构维护前的进程/描述符权威（`read_only_db_uri` 也在这）。
- `hermes_state_pidns.py`：PID 命名空间身份——跨容器不误收别人的租约。
- `hermes_state_health.py`：每路径的 `STORAGE_CORRUPT` 健康闩（进程级，一次性）。
- `hermes_state_dbfile.py`：文件级健康——清零检疫、交叉锁、退休 WAL 代捕获、锁安全 header 探测。
- `hermes_state_readpool.py`：读连接预算（每文件 8 / 每进程 24 / fd 余量门）。

## 关键代码走读

### 1. 活库测试隔离守卫

```python
# hermes_state_guard.py:23-51（节选）
_STATE_DB_GUARD_BYPASS_ENV = "HERMES_STATE_DB_GUARD_BYPASS"
...
_TEST_ISOLATION_MARKER_ENV = "HERMES_TEST_ISOLATION"
```

守卫的判定面在 `hermes_state._ensure_test_isolation`（hermes_state.py:214-244）：pytest 上下文（环境变量**或**进程祖先）解析到生产 DB 就在**任何连接/mkdir/pragma/字节探测之前**抛错。为什么环境不够？docstring（:218-220）说得直白："a child spawned with a rebuilt environment loses `PYTEST_*` and `HERMES_HOME` together, which is precisely the state in which it writes to production"。所以自家的 `HERMES_TEST_ISOLATION` 标记默认继承进子进程，携带它还解析到生产库的进程**按定义是隔离逃逸**。祖先检测走 psutil cmdline 的 basename 匹配（`_process_looks_like_pytest` :76），绝不猜"读不到 cmdline"的方向。

### 2. OFD 锁守卫：防游离 close

```python
# hermes_state_lockguard.py:1-23（模块 docstring 节选）
"""Hold a state.db writer's WAL-mode file locks in a form a stray ``close()`` cannot cancel.

SQLite protects a live WAL generation with two POSIX advisory locks: a SHARED lock on the main
file's lock range and a shared lock on the DMS byte of ``state.db-shm``. A sibling process may
checkpoint and unlink ``-wal``/``-shm`` at its close only after taking both EXCLUSIVE. POSIX locks
are per process, so any ``open()``/``close()`` of those two files inside the holder — a raw probe,
a plugin, a tool reading ``~/.hermes`` — cancels both (sqlite.org/howtocorrupt.html §2.2)...
This module adds the same two ranges as *open file description* locks (``F_OFD_SETLK``) on the
descriptors SQLite itself holds."""
```

OFD 锁属于**描述**而非进程：本进程其他代码随手 close 那两个文件不会取消它，而外来 EXCLUSIVE 依旧冲突——兄弟的 close-time unlink 因此被拒绝。锁几何取自 SQLite unix VFS（`_PENDING_BYTE/_SHARED_FIRST/_SHM_DMS_BYTE`，:39-42）。持有计数按 **inode** 记（`_HANDLES: dict[Identity, int]`，:82），fd 号复用不会被误当成幸存的锁。`hold`（:146）/`release`（:167）是门面调用点（`_open_writer` 末尾 `self._wal_lock_guard = _lockguard.hold(...)`，hermes_state.py:729；close 前释放 :1580）。Windows 无 POSIX advisory 锁，模块承诺 no-op（:50-53 先按平台 gating，连第三方 `fcntl` 撞名模块都不信）。

### 3. /proc/locks：点名叫锁者

```python
# hermes_state_lockowners.py:49-56
def parse_proc_locks(text: str, inodes: dict[tuple[int, int], str]) -> list[tuple[int, str, str]]:
    """``(pid, lock kind, sidecar)`` for every WRITE lock on one of ``inodes``.

    ``inodes`` maps ``(st_dev, st_ino)`` to ``""`` (main file), ``"-wal"`` or ``"-shm"``. Read locks
    are dropped: they never block a writer in WAL mode. An OFD lock is reported with pid ``-1``
    (the kernel does not export its owner)."""
```

SQLite unix VFS 的字节偏移编码锁种类（`_SHM_LOCK_NAMES` :21-26：120=WAL write、128=shm dead-man switch 等），内核带着 pid 导出。`log_write_lock_holders`（:115-124）在写耐心耗尽的那一刻打一条 WARNING，把"等了 20 秒"升级成"是谁在等了 20 秒"；连续三轮读 `/proc/locks` 取并集防中途翻页漏读（:96-105）。

### 4. holders：结构维护的权威

```python
# hermes_state_holders.py:27-30
def read_only_db_uri(db_path) -> str:
    """``file:`` URI for a ``mode=ro`` open. ``as_uri()`` percent-encodes ``?``/``#`` in the home
    path; a raw ``f"file:{path}?mode=ro"`` truncates there and opens the wrong (empty) database."""
    return Path(db_path).resolve().as_uri() + "?mode=ro"
```

除只读 URI 外，本模块证明"没有外来进程仍持有活动的或已 unlink 的 SQLite DB/WAL/SHM 世代"——`foreign_state_db_holders` 扫描打开描述符，`describe_holder_pid`（:60）产出 `PID 123 (hermes gateway run)` 形式的操作者可读行。它还按 argv 语义分类"谁算 Hermes 进程"（`_HERMES_PYTHON_SCRIPTS` 等 :36-42），遵循"不从 argv 子串推断"的项目红线——脚本/模块名是白名单匹配。

### 5. PID 命名空间：租约归属

```python
# hermes_state_pidns.py:96-117（节选）
def _qualify(recorded: Optional[str], *, unstamped_checkable: bool) -> bool:
    """The shared matrix; *unstamped_checkable* is the policy for a record that
    carries no namespace (see the module docstring for why there are two)."""
    local = _local_pid_namespace()
    if not local.supported:
        return True  # single-namespace platform: a pid is evidence on its own
    if recorded is None:
        return unstamped_checkable
    if local.id is None:
        return False  # our own lookup failed: unknown authority is not authority
    return recorded == local.id


def holder_pid_checkable(holder: str) -> bool:
    """STRICT: may a structured holder string's ``pid=`` be probed here? ..."""
    return _qualify(_recorded_namespace(holder), unstamped_checkable=False)
```

持有者字符串被盖 `pidns=<inode of /proc/self/ns/pid>` 章（`holder_namespace_token` :81）；另一个命名空间里的读者把"活的持有者"看成"不存在"，会错误回收未过期租约——所以外来章永不探测。两档策略：TTL 行（压缩锁/turn 租约）严格，无章 defer 到过期（错放自愈）；无过期的 flock 记录宽容（错放会永久禁用孤儿锁清理）。

### 6. 健康闩：进程级一次性

```python
# hermes_state_health.py:60-72（节选）
def mark_storage_corrupt(db_path, reason: object) -> None:
    """Latch *db_path* as corrupt for the life of this process (idempotent)."""
    key = _key(db_path)
    with _lock:
        if key in _corrupt:
            return
        _corrupt[key] = str(reason)
    logger.error(...)
```

只有**结构性损坏**闩上（`is_structural_corruption_error` :49：非 FTS 范围的 SQLITE_CORRUPT/NOTADB，且非可修复的 malformed-schema）。闩永不自愈——损坏的镜像不会自己长好，闪烁的 "ok/corrupt" 正是它要替换的静默失败。读取方：`storage_state`（:83）被 `_raise_if_db_corrupt(storage=True)`（hermes_state.py:1445-1454）与 gateway readiness 消费，让同进程的所有 handle 在碰 SQLite 前先拒绝。

### 7. dbfile：锁安全的 header 探测与检疫

```python
# hermes_state_dbfile.py:63-73（注释节选）
# _read_sqlite_application_id runs on EVERY write (_raise_if_db_replaced) against the LIVE
# state.db.  A bare open()/read()/close() there is the howtocorrupt §2.2 bug: close() cancels
# every POSIX advisory lock this process holds on the file... So the probe preads through a per-path fd
# cached for the life of the process (opening never cancels locks).  When the path is re-pointed
# at a new inode (the very replacement this probe detects) the stale fd is RETIRED, never closed.
_HEADER_PROBE_LOCK = threading.Lock()
_HEADER_PROBE_FDS: dict[str, tuple[int, int, int]] = {}  # key -> (fd, dev, ino)
_RETIRED_HEADER_PROBE_FDS: list[int] = []  # intentionally never closed
```

`_pread_db_range`（:77）实现该探测；`_prepare_connection_retirement`（:36）在 <3.12 的 Python 上用 `Py_IncRef` 把被检疫连接钉活过解释器关停（close 会在错误页号上 checkpoint）。清零库检疫（`quarantine_invalid_state_db`）、交叉进程锁检疫（`quarantine_cross_process_lock`）、退休 WAL 代捕获（`capture_retired_wal_generation`，产 manifest.json 供取证）都在这里；门面侧的调用点见 `_handle_quarantine_if_invalid`（hermes_state.py:775）与 `_capture_retired_generation`（:1307）。

### 8. 读连接预算

```python
# hermes_state_readpool.py:140-151（节选）
class _PathReadBudget:
    """Read-connection permits for ONE database file, shared process-wide
    (per-instance semaphores let N SessionDBs peak at N x (1 + MAX)). An idle
    pooled connection keeps its permit, so a permit miss first reclaims an IDLE
    connection from a peer on the same path.

    ``_READ_POOL_MAX`` used to be enforced by a ``BoundedSemaphore`` owned by each SessionDB, which bounded
    the wrong noun: the descriptors are spent on a *file*, so N SessionDB objects on one state.db each got
    their own allowance and peak scaled as ``N x (1 + _READ_POOL_MAX)`` ... which is how a healthy process
    walked into EMFILE — #98573."""
```

三级门，由宽到窄（`acquire` :198-212）：fd 余量（`_FD_HEADROOM_RESERVE = 64`，:56——SQLite 的描述符只是 fd 表的一部分，EMFILE 往往先炸在 httpx/终端管道上）→ 每进程 24（`_READ_POOL_PROCESS_MAX`，多路复用网关 N 个 profile 各一个 state.db）→ 每文件 8（`_READ_POOL_MAX`，:35）。许可不足时先回收同路径同伴的**空闲**连接（`reclaim_idle` :230），仍不得才降级到写连接上的带锁读。同一文件 >4 个活 handle 触发一次性 WARNING 并列出各 handle 的创建点（`register` :160-191）。

## 核心类/函数

| 名称 | 位置 | 职责 |
|---|---|---|
| `_ensure_test_isolation` | hermes_state.py:214（守卫判定面在 guard.py） | pytest 进程拒绝打开生产库 |
| `_running_under_pytest` | hermes_state_guard.py:54 | 环境变量/标记检测 |
| `hold` / `release` | hermes_state_lockguard.py:146 / :167 | WAL 文件锁的 OFD 加固/释放 |
| `supported` | hermes_state_lockguard.py:85 | 平台能力探测（Windows/无 OFD → no-op） |
| `parse_proc_locks` | hermes_state_lockowners.py:49 | /proc/locks 解析为 (pid, kind, sidecar) |
| `log_write_lock_holders` | hermes_state_lockowners.py:115 | 写等待超时时的点名 WARNING |
| `read_only_db_uri` | hermes_state_holders.py:27 | 正确百分号编码的 mode=ro URI |
| `describe_holder_pid` | hermes_state_holders.py:60 | 持有者 pid → 操作者可读行 |
| `holder_pid_checkable` | hermes_state_pidns.py:109 | 严格档：TTL 行的 pid 可否探测 |
| `persistent_record_pidns_checkable` | hermes_state_pidns.py:120 | 宽容档：无过期记录的 pid 可否探测 |
| `mark_storage_corrupt` / `storage_state` | hermes_state_health.py:60 / :83 | 健康闩写/读 |
| `_pread_db_range` | hermes_state_dbfile.py:77 | 锁安全的 header 预读（缓存 fd，永不关闭） |
| `_prepare_connection_retirement` | hermes_state_dbfile.py:36 | <3.12 钉活被检疫连接 |
| `_PathReadBudget` | hermes_state_readpool.py:140 | 每文件读许可（weak 成员集） |
| `_fd_headroom_ok` | hermes_state_readpool.py:111 | 进程 fd 余量门（fail-open on 不可测） |

## 本组文件清单（8 个）

| 文件 | 行数 | 角色 |
|---|---|---|
| `hermes_state_guard.py` | 179 | 活库测试隔离守卫 + 每进程 last-init-error 记录 |
| `hermes_state_lockguard.py` | 197 | WAL 文件锁的 OFD 加固（防游离 close 取消） |
| `hermes_state_lockowners.py` | 124 | /proc/locks 查谁持写锁（排障点名） |
| `hermes_state_holders.py` | 658 | 结构维护的进程/描述符权威 + read_only_db_uri |
| `hermes_state_pidns.py` | 128 | PID 命名空间身份（跨容器租约归属） |
| `hermes_state_health.py` | 114 | 每路径 STORAGE_CORRUPT 健康闩（进程级一次性） |
| `hermes_state_dbfile.py` | 858 | 文件级健康：清零/交叉锁检疫、退休 WAL 代捕获 |
| `hermes_state_readpool.py` | 259 | 读连接预算（8/文件、24/进程、fd 余量门） |

## 与其他模块的关系

- **门面**：`SessionDB.__init__`/`_open_writer`/`close` 是本组所有机制的最大消费方（隔离检查、OFD hold/release、身份记录、检疫）；`_execute_write` 超时后调 `log_write_lock_holders`。
- **mutation/压缩**：租约回收的 `stale` 回调依赖 `holder_pid_checkable`；`_halt_db_corrupt` 调 `mark_storage_corrupt` 广播给全进程。
- **`hermes doctor`**：holders/lockowners/dbfile 的扫描是 doctor 与 `hermes sessions recover` 的取证后端。
- **gateway**：readiness 探针读 `storage_state`，把 `/api/status` 的 `components.storage` 与桌面侧栏对齐到同一事实源。

## 总结

这一组把"多进程 SQLite"里最容易悄悄烂掉的部分变成可命名的事实：锁有名字（lockowners）、锁丢不了（lockguard）、pid 有命名空间（pidns）、损坏有闩（health）、替换有探测（dbfile）、读有预算（readpool）、测试进不了生产（guard）。它们大多只有几百行，却各自堵住一类真实事故——每一处 docstring 里的 issue 号就是曾经的停机记录。
