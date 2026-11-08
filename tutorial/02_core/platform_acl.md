# hermes_dir_acl.py 与 hermes_startup_watchdog.py —— 主机边界的两件兵器

> 阅读前提：无。一个是 Windows 提权后的目录 ACL，一个是"事件循环之前"的启动看门狗。

## 文件概览

这两个文件处理的是**进程边界外**的事实：

- `hermes_dir_acl.py`（462 行）：Windows 上 CPython 3.13 起 `os.mkdir(path, 0o700)` 会给目录挂一张"受保护 DACL"，提权进程创建的目录在降权后连创建者自己都打不开（`WinError 5`）。`make_user_dir` 是 Hermes 全部状态/锁/日志目录的**唯一建目录入口**。
- `hermes_startup_watchdog.py`（513 行）：其他一切活性兜底（loop-liveness watchdog、shutdown watchdog、心跳文件）都假设启动成功了；若进程在事件循环活起来**之前**就死锁，没有任何东西能开枪（OOF-298：~30h 全线程停在 `futex_wait_queue`、零日志、s6 看到的 PID 还活着）。这个看门狗在进程入口武装、确认循环存活后解除。

## 关键代码走读（hermes_dir_acl.py）

### 1. 唯一建目录入口 make_user_dir（行 407）

```python
# hermes_dir_acl.py:407-437（节选）
def make_user_dir(path: str | Path, mode: int = 0o777, *, parents: bool = False, exist_ok: bool = False,
                  elevated: bool | None = None) -> Path:
    """``Path.mkdir`` (same arguments and defaults) that keeps an elevated Windows creation usable
    by the same user unelevated.

    Off Windows or unelevated this is ``Path.mkdir`` and nothing else. Elevated, every directory
    this call created (missing parents included) is granted the user's inheriting full-control ACE,
    and an existing leaf (the repair case) once per directory object per process, ...
    """
    target = Path(path)
    if not _elevated(elevated):
        target.mkdir(mode=mode, parents=parents, exist_ok=exist_ok)
        return target
    created = []
    probe = target
    while not probe.exists() and probe.parent != probe:
        created.append(probe)
        probe = probe.parent
    try:
        target.mkdir(mode=mode, parents=parents, exist_ok=exist_ok)
    except FileExistsError:
        # ``Path.mkdir`` contract: an existing leaf still raises without exist_ok. The directory an
        # earlier elevated run left is repaired first, ...
        if target.is_dir() and not is_reparse_point(target):
            _grant_dirs(target, [target])
        raise
    _grant_dirs(target, list(reversed(created or [target])), fresh=set(created))
    return target
```

非 Windows / 非提权时**就是** `Path.mkdir`，零额外开销。提权时：为本次创建的每个目录（含缺失的父级）授予"当前用户可继承的完全控制 ACE"；对已存在叶子（此前提权运行留下的）按目录对象身份**每进程一次**修复；`FileExistsError` 的契约保持——但先修复目录再抛，保证调用方的报错不是"非提权 Hermes 被锁在外面"的原因。

### 2. 授权永不穿越 reparse point

提权 ACE 若跟随 junction/symlink/硬链接，等于把 UAC 边界外的目标（如 `C:\Program Files\X`）交给同用户中等完整性代码——这是明确的攻击面。所以：

```python
# hermes_dir_acl.py:59-69
def is_reparse_point(path: str | Path) -> bool:
    """True when *path* itself is a symlink, junction or other reparse point (never followed), or
    cannot be lstat-ed at all; the safe answer for "may an elevated grant act on this path"."""
    try:
        st = os.lstat(path)
    except OSError:
        return True
    if stat.S_ISLNK(st.st_mode) or getattr(st, "st_file_attributes", 0) & FILE_ATTRIBUTE_REPARSE_POINT:
        return True
    isjunction = getattr(os.path, "isjunction", None)  # 3.12+; st_file_attributes covers 3.11
    return bool(isjunction and isjunction(path))
```

lstat 判定 + pywin32 授予时以 `FILE_FLAG_OPEN_REPARSE_POINT` 打开句柄并**复查句柄**（check 之后被换掉也不跟随），icacls 回退传 `/L`；硬链接文件（`st_nlink > 1`）同样拒绝，因为继承 ACE 会落到链接的其他名字上。`grant_user_access`（行 275）只授 home 内路径，并要求"home 之下的每个组件都不是链接"（`_components_below_home` + `_expected_final` 的句柄终路径比对）；`grant_tree_user_access`（行 341）是递归形式（update 后修复），`iter_tree_without_reparse_points` 保证遍历本身也剪掉每个 reparse point。

### 3. 无法修复时给一句人话

```python
# hermes_dir_acl.py:457-463
def unusable_dir_remedy(path: str | Path, *, windows: bool | None = None) -> str:
    """The one-line repair for a directory this process may not use (owner from an elevated run)."""
    if (os.name == "nt") if windows is None else windows:
        return f'from an elevated prompt run: icacls "{path}" /reset /t'
    return f'run: sudo chown -R "$(id -un)" "{path}"'
```

## 关键代码走读（hermes_startup_watchdog.py）

### 1. 轻量性本身是正确性属性

```python
# hermes_startup_watchdog.py:20-26
IMPORT-LIGHTNESS IS A CORRECTNESS PROPERTY: top-level module, stdlib only. Arming must
precede importing ``gateway`` (hundreds of modules; an import-time deadlock is in scope),
and at fire time the wedged main thread may hold the import lock — so the fire path does
no imports on its own thread; the ledger write runs on a helper thread joined with a
timeout. Config is env-only (``HERMES_STARTUP_WATCHDOG=0``,
``HERMES_STARTUP_WATCHDOG_TIMEOUT_S``) because config.yaml parsing is itself in scope.
```

武装必须先于 gateway 导入（导入期死锁也在射程内），所以模块必须 stdlib-only；配置只认环境变量，因为连 config.yaml 解析都可能卡住；开火路径不许 import（主线程可能握着 import 锁），生命周期台账的写入放到辅助线程限时 join。

### 2. 武装与解除：模块级单例

```python
# hermes_startup_watchdog.py:424-453（节选）
def arm_startup_watchdog(timeout_s=None, *, exit_code: int = SERVICE_RESTART_EXIT_CODE) -> Optional[StartupWatchdogHandle]:
    """Arm the process-wide startup watchdog. Idempotent; never raises."""
    global _handle
    try:
        if startup_watchdog_disabled():
            return None
        with _handle_lock:
            if _handle is not None and _handle.is_alive():
                return _handle
            resolved = (float(timeout_s) if timeout_s is not None and float(timeout_s) > 0
                        else resolve_startup_watchdog_timeout())
            handle = StartupWatchdogHandle(resolved, exit_code)
            if not handle._start():
                return None
            _handle = handle
            return handle
```

武装点是 `hermes_cli.main`、`hermes_cli.gateway`、`gateway.run.main`、`cli.py --gateway` 四处，解除点是 `GatewayRunner`——它们互不认识对象，所以用模块单例 + 锁。默认 300s（下限 30s），退出码 75 = 服务管理器重启码（与 `gateway.restart` 的一致性由 parity 测试锁定，因为本模块不许 import gateway）。

### 3. 进展的三级权威与开火路径

看门狗线程 `_run`（行 355）在 deadline 过期时按权威顺序判断：

1. **阶段租约**（`report_startup_progress(expected_s, phase)`，行 494）：启动路径自己声明"我还要干 X 秒"（schema 迁移、损坏修复），每次调用钳制在 `_MAX_LEASE_S=900s`，长阶段靠续约——这是权威信号，I/O 密集阶段也有效；
2. **进程级 CPU 进展**：一个窗口内 CPU 增量 ≥1s 视为活着，但最多延 `_MAX_CPU_EXTENSIONS=3` 次——无关线程烧 CPU 不能永远藏住一个停摆的启动线程；
3. **都没有 → 开火**：`_fire`（行 264）先启动一个"护送线程"（10 秒后无条件 `os._exit`，防止取证路径被日志锁/满盘卡死），然后写 JSON 元数据 + faulthandler 全线程栈到 `<HERMES_HOME>/logs/gateway-startup-watchdog.log`、辅助线程写台账，最后 `os._exit(75)` 让 s6/systemd 重启。

刻意慢但活着的启动不会被杀：空闲等待处调 `kick_startup_watchdog`（行 485，如重启风暴退避最长 300s）；MCP 发现的 120s 等待落在 300s 默认值之内。

## 核心类/函数

| 名称 | 位置 | 职责 |
|---|---|---|
| `make_user_dir` | hermes_dir_acl.py:407 | 唯一建目录入口；提权时授予用户 ACE |
| `grant_user_access` | hermes_dir_acl.py:275 | 单路径授予（+可选修复子项） |
| `grant_tree_user_access` | hermes_dir_acl.py:341 | 递归授予（update 后修复），返回 (granted, skipped, failed) |
| `is_reparse_point` / `_hard_linked_file` | :59/:215 | 拒绝穿越链接/硬链接 |
| `process_is_elevated` / `process_elevation` | :114/:75 | 提权探测（唯一探针） |
| `unusable_dir_remedy` | :457 | 一行修复指引 |
| `arm_startup_watchdog` | hermes_startup_watchdog.py:424 | 武装（幂等、env 可关） |
| `disarm_startup_watchdog` | :456 | 解除（循环确认存活后） |
| `kick_startup_watchdog` | :485 | 空闲等待前推 deadline |
| `report_startup_progress` | :494 | 阶段租约（权威进展信号） |
| `StartupWatchdogHandle` | :177 | 状态机 armed/disarmed/firing + deadline/租约 |
| `_fire` / `_exit_escort` | :264/:326 | 取证 + 有界退出（75） |

## 本组文件清单

| 文件 | 行数 | 角色 |
|---|---|---|
| hermes_dir_acl.py | 462 | Windows 提权建目录的用户 ACL 修复（make_user_dir） |
| hermes_startup_watchdog.py | 513 | 启动活性看门狗：租约/CPU 两级权威 + 有界开火 |

## 与其他模块的关系

- **hermes_constants.py**：`mkdir_under_hermes_home` 调 `make_user_dir`——全仓库建 home 内目录都经此链；ACL 反向 lazy import `get_hermes_home` 判定 home 内组件。
- **hermes_state.py**：行 26 直接 import `make_user_dir`（状态库目录也走 ACL）。
- **gateway/**：watchdog 的武装在 gateway 启动序列，解除在 `GatewayRunner`；`SERVICE_RESTART_EXIT_CODE` 与 `gateway.restart` 保持 parity 测试同步；`gateway.runtime_bootstrap_windows` 用 `process_elevation` 命名拒绝者。
- **cli.py**：`--gateway` 路径 `_run_legacy_gateway` 在导入 gateway 图之前 `arm_startup_watchdog()`。

## 总结

- 两个文件都在处理"进程边界之外的事实"：Windows DACL 与服务管理器的重启语义。
- 共同的设计姿态：**宿主事实（提权、超时）是参数可注入的**（`elevated=` / `timeout_s=`），生产传 nothing、测试注入真值。
- 安全与活性都靠"最小权限/最小依赖"：授予永不穿越链接；看门狗 stdlib-only 且开火路径零 import。
