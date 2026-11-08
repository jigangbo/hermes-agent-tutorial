# 文件与终端工具组 —— read_file、terminal 与影子 git

## 文件概览

这是 tools/ 里最大的一个组：文件操作 21 个文件、终端与进程管理 30 个文件、代码执行 5 个文件，共 56 个。四条主线分别是：`file_tools.py` 提供模型可见的 `read_file`/`write_file`/`patch`/`search_files` 四件套（底层由 `file_operations.py` 面向任意终端后端实现）；`terminal_tool.py` 是那个唯一的 `terminal` 工具，把命令送进可插拔的执行环境（本地/Docker/SSH/Modal，见 environments.md）；`process_registry*.py` 管后台进程的生命周期；`checkpoint_manager.py` 用一个共享的影子 git 仓库给文件改动做透明快照。`patch_parser.py` 则解析 V4A 补丁格式。本篇深讲这四个主角，其余文件入清单。

## 关键代码走读

### 1. file_tools.py：读预算与续读游标

模型一次读入超大文件会吃掉几十 K token。Hermes 的做法不是拒绝超限读取（那会逼模型猜一个更小的 limit，白烧一轮往返），而是**裁到预算内最后一个完整行**，并附上下一次的 `next_offset` 续读游标：

```python
# 来源：tools/file_tools.py:67-94
def _truncate_to_char_budget(content: str, max_chars: int) -> tuple[str, int, bool]:
    """Trim line-numbered ``read_file`` content to the last COMPLETE line within *max_chars*.

    Returns ``(kept_text, lines_kept, truncated)`` so the caller can offer a
    ``next_offset`` instead of rejecting the read. If not even the first line
    fits it is clamped mid-line so the read is never empty and the cursor advances.

    Ported in spirit from nearai/ironclaw#5029 (dual line/byte cap on ``read_file``). Where hermes
    previously hard-rejected an oversized read (forcing the model to guess a smaller ``limit`` and burn a
    round-trip returning nothing), this trims the content to the last *complete line* that fits within
    ``max_chars`` and reports how many lines were kept so the caller can offer a ``next_offset``
    continuation.
    """
    if len(content) <= max_chars:
        return content, (content.count("\n") + 1 if content else 0), False

    lines = content.split("\n")
    kept: list[str] = []
    running = 0
    for line in lines:
        addition = len(line) + (1 if kept else 0)  # +1 for the rejoining "\n"
        if running + addition > max_chars:
            break
        kept.append(line)
        running += addition
    if not kept:
        kept.append(lines[0][:max_chars])
    return "\n".join(kept), len(kept), True
```

默认预算 100,000 字符（`_DEFAULT_MAX_READ_CHARS`，约 25-35K token），可经 config.yaml 的 `file_read_max_chars` 覆盖。读取函数特意**不缓存**配置值——多路复用时进程级槽位会把启动 profile 的值钉死给所有 profile。

### 2. file_tools_write_guards / read_tracking：写保护与读账本

写文件前有一排守卫（`file_tools_write_guards.py`）：敏感路径检查、跨 profile 路径检查、受保护的指令文件（比如别人家的 AGENTS.md）、二进制文档写检查、以及**过期覆盖阻断**——你上次读之后文件被别人改过，就拒绝盲写。读侧的 `file_tools_read_tracking.py` 则按 task 记账：哪些文件读过、sha 是多少、连续读了多少次（检测读循环）。

### 3. terminal_tool.py：一个工具，八个生命周期文件

`terminal_tool()` 的参数表就是它的功能面：`background` 转后台（由 process_registry 跟踪）、`notify_on_complete`/`watch_patterns` 完成通知与输出模式触发、`heartbeat` 周期心跳、`persist_on_release` 跨 agent 生命周期存活：

```python
# 来源：tools/terminal_tool.py:1472-1487
def terminal_tool(
    command: str,
    background: bool = False,
    timeout: Optional[int] = None,
    task_id: Optional[str] = None,
    session_id: Optional[str] = None,
    force: bool = False,
    workdir: Optional[str] = None,
    pty: bool = False,
    notify_on_complete: bool = False,
    watch_patterns: Optional[list[str]] = None,
    _host_local: bool = False,
    _completion_output_chars: int = 0,
    heartbeat: int = 0,
    persist_on_release: bool = False,
) -> str:
```

docstring 里有一个关键的安全契约：`force` 是内部参数（不在模型 schema 里），仅在用户确认后由宿主传入，用来跳过危险命令检查；而**前置守卫链对它免疫**——守卫若超时未给结论则 fail closed，命令被拒绝并提示可重试，绝不裸奔（`terminal_tool.py:1537-1539` 的注释原文：these checks apply unconditionally (``force`` cannot bypass them)）。

注册本身非常朴素，`max_result_size_chars=100_000` 给结果封顶：

```python
# 来源：tools/terminal_tool.py:1750-1758
registry.register(
    name="terminal",
    toolset="terminal",
    schema=TERMINAL_SCHEMA,
    handler=_handle_terminal,
    check_fn=check_terminal_requirements,
    emoji="💻",
    max_result_size_chars=100_000,
)
```

### 4. process_registry：后台进程的户口系统

`terminal(background=true)` 或任何后台 spawn 的进程都登记进 `process_registry.py`。它的兄弟文件各管一段：`_termination` 管「先父后子」的进程树收割（先 SIGTERM 记录在案的父进程、等它自己 reap 子进程，再清理幸存者——先杀浏览器的 zygote 会把退出码 0 变成 SIGTRAP core dump）；`_notifications` 把完成/心跳/输出事件渲染成人类可读文本；`_checkpoint` 支持进程随会话快照持久化并做 PID 安全恢复（防止 PID 复用误杀）。`process_manage` 工具是模型操作这些登记的唯一入口。

### 5. patch_parser.py：V4A 补丁格式

模型返回的补丁用 codex/cline 风格的 V4A 格式：`*** Begin Patch` / `*** End Patch` 包住若干操作块。解析器把文本变成 `PatchOperation` 列表（ADD/UPDATE/DELETE/MOVE），每个操作带若干 hunk，hunk 行用前缀区分上下文/删除/新增：

```python
# 来源：tools/patch_parser.py:41-58
@dataclass
class PatchOperation:
    operation: OperationType
    file_path: str
    new_path: Optional[str] = None  # MOVE only
    hunks: list[Hunk] = field(default_factory=list)


# Markers must occupy the whole line at column 0 so content lines that merely
# mention the format ("+*** End Patch") can't truncate or reset the patch.
_BEGIN_MARKER = re.compile(r'^\*\*\*\s*Begin\s+Patch\s*$')
_END_MARKER = re.compile(r'^\*\*\*\s*End\s+Patch\s*$')
_OP_MARKERS: list[tuple[OperationType, re.Pattern]] = [
    (OperationType.UPDATE, re.compile(r'\*\*\*\s*Update\s+File:\s*(.+)')),
    (OperationType.ADD, re.compile(r'\*\*\*\s*Add\s+File:\s*(.+)')),
    (OperationType.DELETE, re.compile(r'\*\*\*\s*Delete\s+File:\s*(.+)')),
    (OperationType.MOVE, re.compile(r'\*\*\*\s*Move\s+File:\s*(.+?)\s*->\s*(.+)'))]
_HINT_RE = re.compile(r'@@\s*(.+?)\s*@@')
```

注释解释了一个容易被忽视的防御：标记必须**独占整行**，否则正文里恰好出现 `+*** End Patch` 字样的代码行会把补丁截断。应用侧的 `fuzzy_match.py` 做模糊查找替换——模型凭记忆写的上下文行常有一字之差，严格匹配会失败，模糊匹配用一个保守的相似度阶梯兜住。

### 6. checkpoint_manager.py：影子 git 快照

`write_file`/`patch`/破坏性终端命令执行前，checkpoint 管理器自动给工作目录拍快照，支持回滚到任意历史点。它**不是模型可见的工具**（docstring 原话：the LLM never sees it），是纯透明基础设施，由 `checkpoints` 配置项或 `--checkpoints` 开关控制。存储上最有趣的决定是**全项目共享一个 git 存储仓**：

```text
# 来源：tools/checkpoint_manager.py:18-33（docstring 节选）
    ~/.hermes/checkpoints/
        store/                          — single bare-ish git repo
            HEAD, config, objects/      — standard git internals (shared)
            refs/hermes/<hash16>        — per-project branch tip
            indexes/<hash16>            — per-project git index
            projects/<hash16>.json      — {workdir, created_at, last_touch}
            info/exclude                — default excludes (shared)
        .last_prune                     — auto-prune idempotency marker
        legacy-<timestamp>/             — archived pre-v2 per-project shadow
                                          repos (auto-migrated on first init)
```

为什么共享？v2 之前每个工作目录一个影子仓，同一仓库的十几个 worktree 各存一份几乎相同的对象，单用户能烧掉 500 MB；共享后 git 的内容寻址对象库跨项目跨回合去重，新加一个 worktree 几乎零成本。影子仓用 `GIT_DIR` + `GIT_WORK_TREE` + `GIT_INDEX_FILE` 环境变量操作，git 状态绝不漏进用户项目目录。配套的 `checkpoint_maintenance.py` 负责孤儿 ref 清理、按保留天数与总大小上限的修剪加 `git gc`。

## 核心类/函数

| 符号 | 职责 | 位置 |
|---|---|---|
| `read_file` / `write_file` / `patch` / `search_files` | 模型可见的文件四件套（registry 注册） | `tools/file_tools.py` |
| `_truncate_to_char_budget` | 读预算裁剪到完整行并产出续读游标 | `tools/file_tools.py:67` |
| `ShellFileOperations` | 面向任意终端后端的文件操作实现层 | `tools/file_operations.py` |
| `apply_v4a_operations` | 把解析出的补丁操作应用到后端文件 | `tools/patch_parser.py:344` |
| `parse_v4a_patch` | V4A 文本 → `PatchOperation` 列表 | `tools/patch_parser.py:61` |
| `fuzzy_find_and_replace`（fuzzy_match） | 模型生成编辑的模糊查找替换 | `tools/fuzzy_match.py` |
| `terminal_tool` | 终端工具主函数（前台/后台/心跳/看门模式） | `tools/terminal_tool.py:1472` |
| `ProcessRegistry` | 后台进程登记表：跟踪、stdin、等待策略、完成队列 | `tools/process_registry.py` |
| `ProcessTerminationMixin._terminate_host_pid` | 先父后子的进程树收割 | `tools/process_registry_termination.py` |
| `CheckpointManager` | 影子 git 快照与回滚 | `tools/checkpoint_manager.py` |
| `create_snapshot` / `rollback` | 每回合一次的透明快照与任意点回滚 | `tools/checkpoint_manager.py` |
| `execute_code`（code_execution_tool） | 程序化工具调用（PTC）：在沙箱里写 Python 直接编排其他工具 | `tools/code_execution_tool.py` |
| `shutdown_kernels_for_delegated_child` | 子代理结束时回收其内核，防止占用内核 LRU 上限 | `tools/code_kernel.py` |

## 本组文件清单

文件操作组（21 个文件）：

| 文件 | 一句话角色 |
|---|---|
| `tools/file_tools.py` | 模型可见的 read/write/patch/search 四工具与读预算。 |
| `tools/file_tools_paths.py` | 文件工具的路径解析：按 task 的基目录、`~` 展开、工作区分歧告警。 |
| `tools/file_tools_read_tracking.py` | 按 task 的读取/搜索记账：去重、读循环检测、过期状态。 |
| `tools/file_tools_write_guards.py` | 写侧安全守卫：敏感路径、跨 profile、保护文件、过期覆盖阻断。 |
| `tools/file_operations.py` | 面向任意终端后端的文件操作门面（read/write/patch/search）。 |
| `tools/file_operations_common.py` | 结果 dataclass 与纯文本助手（分页常量、冲突块计数）。 |
| `tools/file_operations_lint.py` | 语法 lint 与 LSP 诊断层，写完文件后给模型反馈。 |
| `tools/file_operations_native.py` | 本地 POSIX 后端的进程内写原语（快路径）。 |
| `tools/file_operations_search.py` | 内容/文件搜索层（grep 类实现）。 |
| `tools/file_state.py` | 跨 agent 的文件状态协调。 |
| `tools/read_extract.py` | read_file 的文档转文本：Jupyter/DOCX/XLSX 标准库提取 + 可选扩展。 |
| `tools/patch_parser.py` | V4A 补丁解析与应用。 |
| `tools/fuzzy_match.py` | 模糊查找替换，容模型生成编辑的一字之差。 |
| `tools/binary_extensions.py` | 二进制扩展名清单：文本操作跳过这些文件。 |
| `tools/working_diff.py` | 工作树 git diff 收集（CLI 与网关 `/diff` 共用）。 |
| `tools/checkpoint_manager.py` | 影子 git 快照/回滚管理器。 |
| `tools/checkpoint_maintenance.py` | 快照仓保留策略、孤儿修剪、状态与清理。 |
| `tools/checkpoint_manager_profile_rename.py` | profile 目录改名后重键本地快照项目。 |
| `tools/checkpoint_pruning.py` | 快照上限与仓库维护共享的历史改写。 |
| `tools/checkpoint_refs.py` | `/rollback` 参数的统一读取（序号或快照哈希）。 |
| `tools/checkpoint_undo_hint.py` | `/undo` 时列出被撤销回合改过的文件，提示可用 `/rollback` 找回。 |

终端与进程组（30 个文件）：

| 文件 | 一句话角色 |
|---|---|
| `tools/terminal_tool.py` | `terminal` 工具主函数与注册。 |
| `tools/terminal_tool_backends.py` | 各执行环境的构建器与配置→参数映射表。 |
| `tools/terminal_tool_background.py` | `background=true` 的后台启动路径（登记进 process_registry）。 |
| `tools/terminal_tool_config.py` | 作用域感知的 TERMINAL_* 配置读取与环境变量解析。 |
| `tools/terminal_tool_guards.py` | 执行前守卫：危险命令审批、self_repo_guard、workdir 检查。 |
| `tools/terminal_tool_lifecycle.py` | 沙箱生命周期：空闲回收、拆卸、atexit 兜底。 |
| `tools/terminal_tool_macos_open.py` | macOS `open` 命令的前台提升阶梯。 |
| `tools/terminal_tool_result.py` | 前台结果后处理（cwd 双写、提示与截断）。 |
| `tools/terminal_tool_sudo.py` | sudo 密码管道与命令改写（按作用域的凭据）。 |
| `tools/terminal_hints.py` | 按输出模式匹配的失败提示（比如常见报错的修复建议）。 |
| `tools/terminal_scope.py` | 每回合的终端作用域：profile 级 TERMINAL_* 策略。 |
| `tools/shell_heredoc.py` | shell 扫描器的 heredoc 掩码（`&` 守卫、封禁命令检查）。 |
| `tools/escape_drift_autocorrect.py` | 模糊匹配前对转义漂移的保守纠正。 |
| `tools/close_terminal_tool.py` | 关桌面 GUI 的只读终端标签页而不杀底层会话。 |
| `tools/read_terminal_tool.py` | 读桌面 GUI 终端窗格内容的工具。 |
| `tools/process_registry.py` | 后台进程登记表本体（含全会话心跳定时线程）。 |
| `tools/process_registry_awaiting.py` | 判断后台进程是否还会向其 spawner 回报。 |
| `tools/process_registry_checkpoint.py` | 运行中进程的快照持久化与 PID 安全恢复。 |
| `tools/process_registry_env_log.py` | 非本地轮询器的沙箱日志增量读取。 |
| `tools/process_registry_notifications.py` | 完成队列事件的人类可读渲染（completion/heartbeat/watch）。 |
| `tools/process_registry_output_log.py` | 后台进程的文件化输出（注册的 worker 启动的进程）。 |
| `tools/process_registry_ownership.py` | 哪些本地后台任务随其所有者一起消亡。 |
| `tools/process_registry_results.py` | 已完成终端进程的有界、profile 本地回执。 |
| `tools/process_registry_stdin.py` | 解释后台进程为何没有可写 stdin，并给出可行动的替代。 |
| `tools/process_registry_termination.py` | 进程树终结与杀后幸存者验证。 |
| `tools/process_registry_wait_policy.py` | 阻止对静默运行进程反复 `process_manage` 等待/轮询。 |
| `tools/process_registry_wsl.py` | 侦测经 `wsl[.exe]` 启动链路由的后台 spawn。 |
| `tools/pty_query_responder.py` | 回答 PTY 子进程抛出的一组有界阻塞查询。 |
| `tools/env_probe.py` | 系统提示的本地工具链探测：后端能跑什么就承诺什么。 |
| `tools/env_passthrough.py` | 环境变量透传登记表：会话作用域的白名单。 |

代码执行组（5 个文件）：

| 文件 | 一句话角色 |
|---|---|
| `tools/code_execution_tool.py` | `execute_code` 工具：程序化工具调用（PTC）。 |
| `tools/code_execution_env.py` | execute_code 子进程环境：清洗、解释器与 cwd 解析。 |
| `tools/code_execution_rpc.py` | execute_code 沙箱的宿主侧 RPC 服务器。 |
| `tools/code_kernel.py` | 会话持久 Python 内核：每 (owner, mode) 一个子进程，LRU 上限管理。 |
| `tools/code_kernel_remote.py` | 远程后端（docker/ssh/modal）上的会话持久内核。 |

## 与其他模块的关系

- `tools/environments/`：terminal 的执行后端抽象层，单独成篇（environments.md）。
- `tools/approval.py`：terminal 的执行前守卫调用审批门；`force=True` 只来自用户确认。
- `tools/self_repo_guard.py`：终端命令里若想改写本检出会被拦。
- `agent/`：`agent/tool_executor.py` 的并行段规划依赖文件/终端工具的 task_id 隔离；`agent/inline_tool_executors.py` 不涉及本组（四件套走正常派发）。
- 桌面 GUI：`read_terminal_tool`/`close_terminal_tool` 是 `desktop_ui` toolset 的成员，只读镜像、不碰底层进程。

## 总结

文件与终端组的设计反复出现三个母题。**其一，预算而非拒绝**：读超限裁到完整行给游标，输出超限头尾截断再落盘，模型永远拿到可继续的句柄。**其二，账本与守卫成对**：读侧记账（读过什么、版本多少）喂给写侧守卫（过期覆盖直接拒）。**其三，透明基础设施不占模型注意力**：checkpoint 的影子 git 对模型完全不可见，出了错 `/rollback` 一键找回；后台进程的收割、心跳、通知全部藏在 `process_manage` 一个工具背后。终端工具本身则把「能插拔的环境」与「不可绕过的守卫」焊在一起——后端随便换，安全检查永远在本端先跑。
