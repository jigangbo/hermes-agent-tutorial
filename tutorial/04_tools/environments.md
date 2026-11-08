# 执行环境抽象组 —— base.py 与它的六种后端

## 文件概览

`terminal` 工具的命令最终在哪里跑？Hermes 用一个抽象基类回答：`tools/environments/base.py` 定义 `BaseEnvironment`，六个后端（local、docker、ssh、modal、daytona、vercel_sandbox）各自实现——模型调用 `terminal` 时完全不知道脚下是本机 shell 还是一台云沙箱。基类的核心模型是 **spawn-per-call**：每条命令都 spawn 一个全新的 `bash -c` 进程，会话状态（环境变量、函数、别名）在 init 时拍一次快照、每条命令前重新 source，cwd 靠带内标记或临时文件持久。本组 21 个文件（20 个模块 + `__init__.py`）还包括每个后端的安全层（docker 的 cap-drop 全降、无 egress 泄漏；local 的环境清洗策略）与远程文件同步。本篇深讲 base.py、local.py、docker.py。

## 关键代码走读

### 1. base.py：统一的会话假象

基类 docstring 一段话讲完整个模型，后半句还预告了兄弟模块的切分（`base_output`、`base_session_env`、`base_wait`、`path_utils`）：

```python
# 来源：tools/environments/base.py:1-8
"""Base class for all Hermes execution environment backends.

Unified spawn-per-call model: every command spawns a fresh ``bash -c`` process.
A session snapshot (env vars, functions, aliases) is captured once at init and
re-sourced before each command. CWD persists via in-band stdout markers (remote)
or a temp file (local). Cohesive pieces live in sibling modules (``base_output``,
``base_session_env``, ``base_wait``, ``path_utils``).
"""
```

为什么用 spawn-per-call 而不是常驻 shell？常驻 PTY 状态复杂且难清理；一次性进程天然隔离，代价是要靠「快照 + 重新 source + cwd 标记」假装出一个连续会话——这套假象的代码全在 `base_session_env.py`（`_snapshot_bootstrap_script`、`_cwd_marker`、`_wrap_command_script`）。

### 2. 前台进程的生死簿：退出栅栏

进程退出时（用户 Ctrl+C、宿主被 SIGTERM），可能还有前台命令在别的线程里跑。base.py 维护一份**进程内所有环境的前台命令**登记表 `_live_foreground`（每条命令在自己的会话/进程组里），并提供两级收割。`now=True` 的硬退出路径最有趣：先立一堵**单向退出栅栏**（之后不再有新 spawn），再等已过栅栏的 spawn 落地，最后在 0.5 秒预算内先 TERM 后 KILL——远程后端的 SDK 取消跑在守护线程上，绝不能拖住 `os._exit`：

```python
# 来源：tools/environments/base.py:95-118（节选）
def kill_live_foreground_processes(*, now: bool = False) -> int:
    """Kill every in-flight foreground command's process tree; returns how many were signalled.

    ``now=True`` is for a caller about to ``os._exit``: the graceful kill TERMs, waits and only then
    KILLs, so a SIGTERM-ignoring command outlives a hard exit that lands inside that window. It also
    raises the exit fence and waits for spawns already past it to register, so no command started
    around the snapshot survives, and it never blocks past ``_HARD_KILL_BUDGET_S``: SDK cancels
    (Modal, Daytona, Vercel) run on daemon threads under that one deadline."""
    global _exit_fenced
    if not now:
        with _live_foreground_cond:
            live = list(_live_foreground.values())
        for env, proc in live:
            _quiet_kill(env._kill_process, proc)
        return len(live)
    deadline = time.monotonic() + _HARD_KILL_BUDGET_S
    _exit_fenced = True
    if _live_foreground_cond.acquire(timeout=_HARD_KILL_BUDGET_S):
        try:
            _live_foreground_cond.wait_for(lambda: _spawns_in_flight == 0, max(0.0, deadline - time.monotonic()))
            live = list(_live_foreground.values())
        finally:
            _live_foreground_cond.release()
    else:  # the holder is stuck under our signal: a lock-free copy beats hanging the exit
        live = list(_live_foreground.values())
```

连「锁被卡死怎么办」都想到了：拿不到锁就退化为无锁拷贝再逐个杀——硬退出宁可漏杀一个也不挂住进程。

### 3. local.py：一个 env builder 统治所有子进程

本地后端最重要的导出不是某个方法，而是**唯一的子进程环境构建器**。AGENTS.md 的裁决：终端、execute_code、后台进程、委派孩子、ACP、MCP stdio 子进程……所有 spawn 都必须经 `environments/local.py::build_subprocess_env`（+ `hermes_constants.apply_subprocess_home_env`、`env_passthrough.py::resolve_passthrough_value`）；为一个 **目标 profile** 干活的孩子（`hermes -p X` worker、浏览器驱动、Bot Chat relay）则用 `served_profile_child_env(target_home=, inherit_credentials=)`——剥掉启动 profile 的 `.env`/`TERMINAL_*` 残留、钉住目标 home、只叠加目标自己的密钥：

```python
# 来源：tools/environments/local.py:1-2, 22-35（import 节选）
"""Local execution environment — spawn-per-call with session snapshot."""
...
from tools.environments.local_env_policy import (
    _ALWAYS_STRIP_FOLDED, _ALWAYS_STRIP_KEYS, _HERMES_PROVIDER_ENV_BLOCKLIST, _HERMES_PROVIDER_ENV_FORCE_PREFIX,
    _is_hermes_internal_secret, _is_provider_env_blocklisted, _is_terminal_first_party_env,
    _home_adapter_secret_env, _matches_terminal_first_party_prefix, _plugin_terminal_env_strip_keys,
    _registered_adapter_secret_env, _registry_adapter_secret_env,
    strip_profile_gate_env, strip_supervised_process_identity)
```

`local_env_policy.py` 就是这份策略的细节：哪些键永远剥掉、Hermes 内部密钥怎么识别、provider 环境块名单。配套注释强调了一条硬规则：**contextvars 不跨进程边界，所以在 `Popen` 之前就要解析好环境**——`os.environ.copy()` 钉住的是启动 profile；孩子的 `UnscopedSecretError` 是 spawn 点的 bug，绝不能靠加环境变量兜底来解决。

### 4. 临时目录的修剪：按组判断年龄

本地后端的终端临时产物（后台进程的 `hermes_bg_<id>.log/.pid/.exit` 三件套）存在 `HERMES_HOME/cache/terminal`，24 小时空闲即修剪。但年龄判定有个坑：活着的后台进程其 `.pid` 文件 mtime 永不变、而 `.log` 一直在写——按单个文件判龄会把活会话的 pid/exit 文件误删。所以按**共享词干的组**取最新 mtime：

```python
# 来源：tools/environments/local.py:44-49
# Background artifacts come in triplets (hermes_bg_<id>.log/.pid/.exit). A live
# server's .pid never changes mtime while its .log does, so age is judged per
# GROUP (newest mtime sharing a stem) to keep pid/exit files of live sessions.
_BG_GROUP_RE = re.compile(r"^(hermes_bg_[A-Za-z0-9_-]+)\.(log|pid|exit)$")
```

### 5. docker.py：默认硬化的沙箱

Docker 后端的安全姿态写在 docstring 第一行：**cap-drop ALL、no-new-privileges、PID 上限**，可配置 CPU/内存/磁盘限额，可选 bind mount 持久化：

```python
# 来源：tools/environments/docker.py:1-8
"""Docker execution environment for sandboxed command execution.

Security hardened (cap-drop ALL, no-new-privileges, PID limits), configurable
resource limits (CPU, memory, disk), and optional filesystem persistence via
bind mounts.
"""
```

它的 import 面也透露了两个独有子系统。`docker_egress.py` 管**出网策略**：检查 `forward_env`/`extra_args` 与 egress 配置的键冲突、按指纹复用 egress 容器、给代理环境变量合成参数——沙箱里能连哪儿是被显式设计的，不是意外。`docker_ownership.py` 管**文件属主**：容器里创建的文件属主是 root，宿主拿回来要 `hand_back_sandbox_files`（chown 交还用户），反向有 `reclaim_sandbox_files` 和 `strip_sandbox_privileges`。远程后端的公共语汇在 `remote_common.py`（bash_argv、client_env_with、prepend_unset、run_capture），ssh/modal/managed_modal/daytona/vercel_sandbox 五个后端都站在它肩上。

### 6. base_wait.py 与 streams.py：等待的礼貌

远程命令的等待循环会通过一个**线程本地的活动回调**向网关报「我还活着」（`base.py:52-54` 的 `_activity_callback_local`）——网关的不活跃看门狗因此不会误杀长命令。`base_wait.py` 携带 `_WaitTrace`（等待轨迹，出问题可诊断），`streams.py` 抽象输出流读取，`fd_wait.py` 处理文件描述符就绪等待，`file_sync.py` 给远程后端做文件同步，`path_utils.py` 有 task_id 的路径净化等公共助手。

## 核心类/函数

| 符号 | 职责 | 位置 |
|---|---|---|
| `BaseEnvironment` | 抽象基类：spawn-per-call、会话快照、cwd 持久 | `tools/environments/base.py` |
| `kill_live_foreground_processes` | 收割全部在飞前台命令（优雅/硬退出两级） | `tools/environments/base.py:95` |
| `_enter/_leave_foreground_spawn` | 退出栅栏内的 spawn 登记（防快照缝隙漏进程） | `tools/environments/base.py:68,77` |
| `build_subprocess_env` | **唯一**的子进程 env builder（所有 spawn 的必经之路） | `tools/environments/local.py` |
| `served_profile_child_env` | 为目标 profile 干活的孩子环境（剥残留、钉 home） | `tools/environments/local.py` |
| `LocalEnvironment` | 本地后端（含临时目录修剪、Windows 适配） | `tools/environments/local.py` |
| `DockerEnvironment` | Docker 后端：默认硬化 + 资源限额 + bind mount | `tools/environments/docker.py` |
| `SshEnvironment` / `ModalEnvironment` / `DaytonaEnvironment` / `VercelSandboxEnvironment` | 远程后端家族（共享 remote_common 语汇） | `tools/environments/ssh.py` 等 |
| `strip_profile_gate_env`（local_env_policy） | 剥离 profile 门控与启动残留环境键 | `tools/environments/local_env_policy.py` |
| `check_forward_env_collisions`（docker_egress） | egress 策略与用户 env 的冲突检查 | `tools/environments/docker_egress.py` |
| `hand_back_sandbox_files`（docker_ownership） | 沙箱产出的 root 文件交还宿主用户 | `tools/environments/docker_ownership.py` |
| `ProcessHandle`（base_output） | 一条前台命令的句柄（本地 Popen 或远程引用） | `tools/environments/base_output.py` |

## 本组文件清单

environments/ 组共 21 个文件：

| 文件 | 一句话角色 |
|---|---|
| `tools/environments/__init__.py` | 子包标识。 |
| `tools/environments/base.py` | 抽象基类：spawn-per-call 会话模型与前台生死簿。 |
| `tools/environments/base_output.py` | 输出收集、drain 线程与 ProcessHandle。 |
| `tools/environments/base_session_env.py` | 会话快照引导脚本、cwd 标记、命令包装。 |
| `tools/environments/base_wait.py` | 等待循环与 `_WaitTrace` 等待轨迹。 |
| `tools/environments/fd_wait.py` | 文件描述符就绪等待。 |
| `tools/environments/streams.py` | 输出流抽象（本地/远程统一读取）。 |
| `tools/environments/local.py` | 本地后端 + 全局唯一的子进程 env builder。 |
| `tools/environments/local_env_policy.py` | 本地环境清洗策略（剥键、密钥识别、provider 黑名单）。 |
| `tools/environments/local_pythonpath.py` | PYTHONPATH 与 Hermes 仓库根别名的清理。 |
| `tools/environments/docker.py` | Docker 后端：默认硬化的沙箱。 |
| `tools/environments/docker_egress.py` | Docker 出网策略：代理参数、指纹复用、冲突检查。 |
| `tools/environments/docker_ownership.py` | 沙箱文件属主：交还/回收/降权。 |
| `tools/environments/ssh.py` | SSH 远程后端。 |
| `tools/environments/modal.py` | Modal 云沙箱后端。 |
| `tools/environments/managed_modal.py` | Nous 托管的 Modal 后端（托管配置注入）。 |
| `tools/environments/daytona.py` | Daytona 云沙箱后端。 |
| `tools/environments/vercel_sandbox.py` | Vercel 沙箱后端。 |
| `tools/environments/remote_common.py` | 远程后端公共语汇（bash 参数、env 处理、run_capture）。 |
| `tools/environments/file_sync.py` | 远程后端的文件同步。 |
| `tools/environments/path_utils.py` | 路径助手（task_id 净化等）。 |

## 与其他模块的关系

- `tools/terminal_tool.py`：经 `terminal_tool_backends.py` 的构建器表选择并创建后端实例。
- `tools/credential_files.py`：远程后端的文件透传登记（本地文件如何出现在 Docker/Modal/SSH 里）。
- `tools/env_passthrough.py`：`resolve_passthrough_value` 参与 env builder 的透传白名单。
- `tools/mcp_tool_transport.py` 与 `tools/code_kernel_remote.py`：MCP stdio 子进程和远程内核都复用同一 env builder / 后端抽象。
- `hermes_constants.apply_subprocess_home_env`：env builder 的另一半——把正确的 `HERMES_HOME` 写进孩子环境。

## 总结

environments/ 证明了「抽象收口」的价值：模型只见一个 `terminal` 工具，背后六种后端共享同一套 spawn-per-call 会话假象、同一份等待礼貌、同一本前台生死簿。三条最值得带走的规则：**所有子进程环境出自一个 builder**（profile 隔离在 spawn 点就完成，不靠事后补救）；**退出必须设栅栏**（先立栅栏再等落地再收割，0.5 秒预算封顶）；**远程安全是配置出来的**（Docker 默认 cap-drop ALL + egress 显式设计，属主交还而非共享 root）。AGENTS.md 还有一句收束本组的话：远程后端的文件可见性问题在挂载点上修，而不是加新工具。
