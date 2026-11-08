# hermes_bootstrap.py 与 hermes_logging.py —— 第一个 import 与日志子系统

> 阅读前提：无。这两个文件在每次进程启动的第 0 秒与第 1 秒运行。

## 文件概览

`hermes_bootstrap.py`（622 行）是**每个入口点的第一个 import**——`hermes`、`hermes-agent`、`hermes-acp`、`gateway.run`、`batch_runner`、`cron/scheduler`、`run_agent.py`、`cli.py` 都遵守"bootstrap 第一"的约定。它 stdlib-only，完成 Windows UTF-8 stdio、ANSI 控制台、导入路径加固、PM 依赖激活、Happy Eyeballs 连接与 scratch tmp 重定向。`hermes_logging.py`（1,053 行）是日志子系统：轮转文件、脱敏、跨进程锁、队列化输出。

## 关键代码走读（hermes_bootstrap.py）

### 1. 导入即生效的引导

```python
# hermes_bootstrap.py:471-478
# Apply on import — entry points just need ``import hermes_bootstrap`` ...
apply_windows_utf8_bootstrap()
enable_windows_vt()
suppress_platform_ver_console()
install_never_free_environ()
```

`import hermes_bootstrap` 这一行本身就是全部动作：

- **`apply_windows_utf8_bootstrap`（行 227）**：Windows 的 stdio 绑定在控制台代码页（cp1252），`print("café")` 会 `UnicodeEncodeError`。这里 `setdefault` 两个子进程可见的 env（`PYTHONUTF8`、`PYTHONIOENCODING`），再对当前进程三个流 `reconfigure(encoding="utf-8", errors="replace")`。POSIX 被故意放过——尊重用户的 `LANG/LC_*`。**不做 `-X utf8` re-exec**：当前进程的 `open()` 仍需显式 `encoding="utf-8"`（ruff PLW1514 强制）。
- **`enable_windows_vt`（行 259）**：conhost 打印 SGR 转义会显示成 `←[35m`；给 stdout/stderr 的控制台句柄开 `ENABLE_VIRTUAL_TERMINAL_PROCESSING`。拒绝 VT 的老控制台改为设置 `NO_COLOR=1`，让渲染层优雅降级而不是输出乱码。
- **`suppress_platform_ver_console`（行 297）**：OpenAI SDK 调 `platform.platform()`，Windows 上会 shell 出 `cmd /c ver`——无窗口父进程闪控制台，Python 3.11.0/3.11.1 还会 strict-utf-8 解码 OEM 输出崩溃（#69413）。把 `platform._syscmd_ver` 打成返回输入的桩。
- **`install_never_free_environ`（行 336）**：glibc < 2.41 对**新名字**的 `setenv` 会 realloc 并释放 `environ` 数组，而丢 GIL 的线程（`getaddrinfo`、OpenSSL 读 `SSL_CERT_FILE`）可能还在走老数组——tcache 指针让整个进程 SIGSEGV。Hermes 运行时大量写新 env 名，TUI 网关因此死过。这里仿照 glibc 2.41 的修法接管 `os.putenv/unsetenv`：条目按 `NAME=value` 永久缓存、新名字原地追加、整个数组替换时老数组永不释放；fork 时用 `register_at_fork` 抱锁。

### 2. 导入路径加固与 PM 激活

```python
# hermes_bootstrap.py:434-453（节选）
def harden_import_path(src_root: str | None = None) -> None:
    """Stop a package in the current directory from shadowing Hermes modules.

    Hermes ships top-level modules with common names (``utils``, ``proxy``, ``ui``); a
    project with its own ``utils/`` launched from its directory would win the import.
    """
    root = src_root or os.environ.get("HERMES_PYTHON_SRC_ROOT") or os.path.dirname(os.path.abspath(__file__))
    sys.path[:] = [p for p in sys.path if p not in ("", ".")]
    root_abs = os.path.abspath(root)
    sys.path[:] = [p for p in sys.path if os.path.abspath(p) != root_abs]
    sys.path.insert(0, root)
```

cwd 会以 `""`/`"."`（脚本启动）**和**绝对路径（venv 激活、PYTHONPATH）两种形式进 `sys.path`，两种都要处理；Hermes 根被"搬"到最前而不是仅补插。

随后（行 505-622）按序执行：`_settle_interrupted_update`（把被杀的 `hermes update` 搬一半的树放回去，甚至要在 `hermes_cli` 本身被移走时用 moved-aside 目录临时充当包）→ `_pin_launcher_home`（铸造的启动器把 HERMES_HOME 钉到安装默认根）→ `prepare_launch`（PM 依赖激活；Windows 用 `subprocess.call`、POSIX 用 `os.execv` 换到准备好的解释器，失败则降级为"旧依赖代继续跑 + 提示 `hermes update`"）→ `recover_if_needed` + `activate_dependencies`（真正的门禁：依赖装不上就退出并指路 `hermes pm repair`）→ `install_happy_eyeballs_socket_connect` → `export_scratch_tmp_env`。

### 3. Happy Eyeballs（RFC 8305）

```python
# hermes_bootstrap.py:193-218（节选）
def install_happy_eyeballs_socket_connect() -> None:
    """Race IPv6/IPv4 for every sync TCP connect in the process (RFC 8305, #114265).

    The stock implementations walk the ``getaddrinfo`` results serially — on a network
    whose advertised IPv6 route is blackholed, each AAAA record burns the full connect
    timeout before IPv4 answers. Idempotent, best-effort.
    """
```

进程内所有同步 TCP 连接（requests/urllib3、httpcore、urllib/http.client）最终都汇入 `socket.create_connection` 或 urllib3 自己的串行副本。这里换成 `_happy_eyeballs_create_connection`：地址族轮转交错、250ms 交错发射、selector 竞速，先到先用；urllib3 的模块用一次性 meta_path import 钩子在它加载的瞬间打补丁（避免为打补丁而 eager import ~50ms）。

## 关键代码走读（hermes_logging.py）

### 1. Windows 轮转处理器的选择

```python
# hermes_logging.py:96-115（节选）
# Windows-ONLY swap (#44873): stdlib ``RotatingFileHandler.doRollover()`` calls
# ``os.rename()``, which fails with ``PermissionError [WinError 32]`` whenever
# another process holds an append handle on ``agent.log`` — essentially always
# in Hermes (TUI, gateway, hy_memory, MCP servers, CLI commands all log) ...
if sys.platform == "win32":
    if _portalocker_probe():
        from concurrent_log_handler import ConcurrentRotatingFileHandler as RotatingFileHandler
    else:
        from logging.handlers import RotatingFileHandler
        _WINDOWS_CLH_FALLBACK = True
else:
    from logging.handlers import RotatingFileHandler
```

stdlib 轮转在 Windows 上几乎必然撞上"别的进程正持有 agent.log"——所以 Windows 换 `concurrent-log-handler`（跨进程锁轮转），且**import 时先探测** portalocker 是否真能上锁（打包payload 曾有 pywintypes 坏掉导致每条日志静默丢弃的案例），不行则回退 stdlib 并禁用 rollover。POSIX 保持 stdlib：open-file rename 可行，且 managed（NixOS）模式依赖 stdlib 的 `_open()`/`doRollover()` 生命周期做 0660 chmod。

### 2. setup_logging（行 357）

```python
# hermes_logging.py:357-375（节选）
def setup_logging(
    *,
    hermes_home: Optional[Path] = None,
    log_level: Optional[str] = None,
    max_size_mb: Optional[int] = None,
    backup_count: Optional[int] = None,
    mode: Optional[str] = None,
    force: bool = False,
) -> Path:
    """Configure the Hermes logging subsystem; returns the ``logs/`` directory.

    Safe to call multiple times; the second call is a no-op unless *force*. Level and
    rotation defaults come from config.yaml ``logging.*``. ``mode="gateway"`` adds
    ``gateway.log`` and ``mode="gui"`` adds ``gui.log``.
    """
```

幂等（第二次调用是 no-op 除非 `force=True`——每个 AIAgent 构造都会调它）；日志文件：`agent.log`（INFO+ 全量）、`errors.log`（WARNING+）、`gateway.log` / `gui.log`（按 mode）；全部经**一个异步队列**（QueueHandler/QueueListener）写出，格式化走 `RedactingFormatter`，**密钥永不上盘**。配套：`_line_buffer_piped_stdout`（行 116，管道 stdout 行缓冲，supervisor 的日志流跟得上 agent 循环）、`_quietly` 压噪、`set_session_context`（行 253，thread-local 会话标签进每条记录）。

### 3. 多 profile 的日志归属

`_ProfileRoutingFileHandler`（行 646）按记录的 profile home 路由到对应 profile 的 handler，profile 目录被删除时释放句柄（`_release_if_deleted`）；`_ManagedRotatingFileHandler`（行 467）在 managed 安装上维持 0660 并检测外部轮转。这些是"一个进程服务多个 profile"不变量在日志侧的落地。

## 核心类/函数

| 名称 | 位置 | 职责 |
|---|---|---|
| `apply_windows_utf8_bootstrap` | hermes_bootstrap.py:227 | Windows UTF-8 stdio（一次性） |
| `enable_windows_vt` | hermes_bootstrap.py:259 | ANSI/VT 控制台模式；失败设 NO_COLOR |
| `suppress_platform_ver_console` | hermes_bootstrap.py:297 | 桩掉 `platform._syscmd_ver`（#69413） |
| `install_never_free_environ` | hermes_bootstrap.py:336 | glibc<2.41 environ 释放防护 |
| `harden_import_path` | hermes_bootstrap.py:434 | 防本地包遮蔽 Hermes 顶层模块 |
| `_settle_interrupted_update` | hermes_bootstrap.py:511 | 恢复被杀的 update |
| `install_happy_eyeballs_socket_connect` | hermes_bootstrap.py:193 | RFC 8305 竞速连接（含 urllib3 钩子） |
| `RelaunchExit` | hermes_bootstrap.py:571 | 携带 relaunch 子进程状态的 SystemExit |
| `setup_logging` | hermes_logging.py:357 | 幂等日志初始化；返回 logs/ 目录 |
| `_portalocker_probe` | hermes_logging.py:38 | Windows CLH 可用性探测 |
| `_ManagedRotatingFileHandler` | hermes_logging.py:467 | managed 0660 + 外部轮转感知 |
| `_ProfileRoutingFileHandler` | hermes_logging.py:646 | 按 profile home 路由日志 |
| `set_session_context` | hermes_logging.py:253 | thread-local 会话标签 |
| `_start_queue_listener_locked` | hermes_logging.py:831 | 单一异步输出队列 |

## 本组文件清单

| 文件 | 行数 | 角色 |
|---|---|---|
| hermes_bootstrap.py | 622 | 进程第 0 秒：UTF-8/VT/environ 加固、路径加固、update 恢复、PM 激活、Happy Eyeballs、scratch tmp |
| hermes_logging.py | 1,053 | 日志子系统：轮转（Windows CLH）、脱敏、队列化、多 profile 路由 |

## 与其他模块的关系

- **cli.py / run_agent.py / batch_runner.py / gateway**：都以 `import hermes_bootstrap` 开头（try/except 容忍半更新的树）；cli 的 `main()` 里还二次调用 `configure_windows_stdio` 兜底。
- **hermes_constants.py**：bootstrap 结尾 `export_scratch_tmp_env` 委托给它的 scratch 逻辑；日志目录建在家路径下。
- **pm/**：`activate_dependencies` / `prepare_launch` 是 PM 环境的门禁（见 [../11_pm/](../11_pm/index.md)）。
- **每个 AIAgent 构造**：`agent/agent_init.py::_setup_logging` 调 `setup_logging()`（幂等）。

## 总结

- bootstrap 的所有动作都发生在"任何 Hermes 包 import 之前"，且 import 本身即完成——入口点只需要记住一行约定。
- 三类历史事故沉淀在这里：Windows 编码/控制台（UnicodeEncodeError、VT、platform.ver 崩溃）、并发进程（日志轮转 WinError 32、environ SIGSEGV）、网络（IPv6 黑洞超时）。
- 日志子系统的两个关键词：**脱敏**（密钥永不上盘）与**幂等**（每 agent 构造都调，第二次是 no-op）。
