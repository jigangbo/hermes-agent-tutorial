# cli.py —— 交互式 REPL 的门面

> 阅读前提：[run_agent.md](run_agent.md)。agent 在 `run_agent.py`，这一层是"人坐在终端前"的壳。

## 文件概览

`cli.py`（1,792 行）定义 `HermesCLI`——交互式终端 REPL 的门面类，外加模块级的清理、输出历史、斜杠分发设施。它是另一个"门面 + 兄弟"的样板：18 个 mixin 全部住在 `hermes_cli/cli_*.py`，门面本身保留 re-export、斜杠分发表、`run()` 的 prompt_toolkit 装配和模块级 `main()`。

## 关键代码走读

### 1. 第一个 import 与 HERMES_QUIET

```python
# cli.py:5-9,31
# Must be the very first import (UTF-8 stdio on Windows). Missing only mid-``hermes update``.
try:
    import hermes_bootstrap
except ModuleNotFoundError as exc:
    if exc.name != "hermes_bootstrap" and not "hermes_bootstrap".startswith(f"{exc.name}."):
        raise  # the bootstrap exists but cannot load: skipping it would skip PM activation
...
os.environ["HERMES_QUIET"] = "1"  # suppress our modules' startup chatter
```

`hermes_bootstrap` 第一（Windows UTF-8 stdio + PM 激活，见 [bootstrap_logging.md](bootstrap_logging.md)）；`HERMES_QUIET=1` 压掉自家模块的启动噪声（CLI 自己负责渲染横幅）。

### 2. 门面 re-export：机械拆分的产物

```python
# cli.py:34-50（节选）
from hermes_cli.cli_agent_setup_mixin import CLIAgentSetupMixin
from hermes_cli.cli_commands_mixin import CLICommandsMixin
from hermes_cli.cli_billing_mixin import CLIBillingMixin
...
from hermes_cli.cli_backtrack import CLIBacktrackMixin
# Extracted clusters (mechanical split, #116911); re-exported here so `cli.<name>` stays the seam.
from hermes_cli.cli_shutdown import (_CLEANUP_STEPS, _arm_exit_watchdog, _emit_interrupted_session_end, ...)
from hermes_cli.cli_render import (ChatConsole, _ACCENT, _BOLD, _render_final_assistant_content, ...)
from hermes_cli.cli_config_load import (CLI_CONFIG 来源、_merge_file_config、load_cli_config, ...)
from hermes_cli.cli_terminal_input import (_bind_prompt_submit_keys, _detect_file_drop, ...)
from hermes_cli.cli_single_query import (_run_single_query_mode, _run_quiet_single_query, ...)
```

数百个符号被 re-export 回门面（#116911 的机械拆分），注释直说目的：**"`cli.<name>` stays the seam"**——测试与兄弟模块仍然 patch `cli.X`，生产代码从门面读，二者永远一致。另一个提速手段是 `_lazy_shim`：

```python
# cli.py:246-254
def _lazy_shim(module: str, name: str, alias: str | None = None):
    """Import ``module.name`` on first call; keeps heavy imports off startup while ``cli.<name>`` stays patchable."""
    def shim(*args, **kwargs):
        return getattr(importlib.import_module(module), name)(*args, **kwargs)
    shim.__name__ = shim.__qualname__ = alias or name
    return shim
```

`get_tool_definitions` 是手工版：先等 MCP 发现完成，再转发 `model_tools.get_tool_definitions`（行 396-401）——CLI 启动只需要画提示符，工具面到第一次需要时才等齐。

### 3. HermesCLI：18 个 mixin（行 881）

```python
# cli.py:881-882
class HermesCLI(CLIBacktrackMixin, CLIInitMixin, CLITuiRuntimeMixin, CLIProcessNotificationsMixin, CLIAgentSetupMixin,
                CLICommandsMixin, CLIBillingMixin, CLITuiMixin, CLIStatusBarMixin, CLIVoiceMixin, CLIModelSwitchMixin,
                CLISessionMixin, CLIStreamMixin, CLIModalMixin, CLITerminalMixin, CLIInfoMixin, CLILoopsMixin, CLIChatTurnMixin):
    """Interactive REPL for the Hermes Agent."""
```

| mixin | 兄弟文件 | 主题 |
|---|---|---|
| CLIBacktrackMixin | cli_backtrack.py | 回溯/撤销 |
| CLIInitMixin | cli_init_mixin.py | `__init__` 三段初始化（显示/路由/运行时状态） |
| CLITuiRuntimeMixin | cli_tui_runtime_mixin.py | TUI 运行时装配 |
| CLIProcessNotificationsMixin | cli_process_notifications.py | 后台进程通知 |
| CLIAgentSetupMixin | cli_agent_setup_mixin.py | 构造/重建 AIAgent |
| CLICommandsMixin | cli_commands_mixin.py | 内建命令实现 |
| CLIBillingMixin | cli_billing_mixin.py | 订阅/账单展示 |
| CLITuiMixin | cli_tui_mixin.py | TUI 布局与按键绑定 |
| CLIStatusBarMixin | cli_status_bar_mixin.py | 状态栏 |
| CLIVoiceMixin | cli_voice_mixin.py | 语音输入/TTS |
| CLIModelSwitchMixin | cli_model_switch_mixin.py | /model 切换 |
| CLISessionMixin | cli_session_mixin.py | /resume /new /handoff |
| CLIStreamMixin | cli_stream_mixin.py | 流式渲染 |
| CLIModalMixin | cli_modal_mixin.py | 模态对话框 |
| CLITerminalMixin | cli_terminal_mixin.py | 终端窗格 |
| CLIInfoMixin | cli_info_mixin.py | /tools /context 等 |
| CLILoopsMixin | cli_loops_mixin.py | 输入循环 |
| CLIChatTurnMixin | cli_chat_turn_mixin.py | 单轮对话管线 |

`__init__`（行 890）只有三行：`_init_display_options` → `_init_model_routing` → `_init_runtime_state(resume)`——"CLI 参数赢过 config；reasoning 仅本次运行；resume 从 SQLite 恢复历史"。

### 4. 斜杠分发：`_SLASH_DISPATCH` 表与 process_command

```python
# cli.py:1117-1136（节选）
    # canonical command -> (method name, pass cmd_original?). Absent commands resolve to
    # ``_handle_<name>_command(cmd)``. Looked up via getattr at dispatch time so
    # monkeypatching works. A handler returning False exits the REPL.
    _SLASH_DISPATCH: dict[str, tuple[str, bool]] = {
        "exit": ("_cmd_exit", True), "quit": ("_cmd_exit", True), "help": ("_cmd_help", True),
        "palette": ("_open_command_palette", False), "whoami": ("_handle_whoami_command", False),
        ...
        "moa": ("_cmd_moa", True),
    }
```

`process_command`（行 1152）的顺序：中心别名注册表（`hermes_cli/commands.py::resolve_command`）归一化 → 记录共享指标 → 取消 `/resume` 的一次性待选状态 → 网关设置命令优先 → 插件 pre_command 观察钩子 → 查表取 handler（getattr 保持可 patch）→ **handler 返回 False 即退出 REPL**。未注册命令走 `_process_unregistered_slash`：quick_commands → 插件 → skill bundle → skill → 唯一前缀扩展。

输入侧的入口在 `CLILoopsMixin`：**以 `/` 开头的输入路由进 `process_command`，返回 False 时 REPL 退出**；普通输入排进 `_pending_input` 队列交给 agent worker 线程。

### 5. run()：prompt_toolkit 应用五步（行 1407）

```python
# cli.py:1407-1489（节选）
    def run(self):
        """Run the interactive CLI loop with persistent input at bottom."""
        if not self._claim_active_session("cli"):     # ① 跨进程活动会话租约
            return
        self._tui_print_startup()
        self._tui_init_run_state()
        kb = self._tui_build_key_bindings()           # ② 构建按键/布局/应用
        layout, style = self._tui_build_layout(kb)
        app = self._tui_build_application(layout, kb, style)
        ...
        try:                                           # ③ patch prompt_toolkit 渲染差异函数
            import prompt_toolkit.renderer as _pt_renderer
            from prompt_toolkit.renderer import _output_screen_diff as _orig_osd
            if not getattr(_pt_renderer, "_hermes_osd_patched", False):
                _pt_renderer._output_screen_diff = functools.partial(_hermes_call_output_screen_diff, _orig_osd)
                _pt_renderer._hermes_osd_patched = True
        except Exception:
            pass
        ...
        atexit.register(_run_cleanup)                  # ④ atexit/信号清理
        self._tui_install_signal_handlers()
        ...
        try:
            with patch_stdout():                       # ⑤ app.run() 置于 patch_stdout 之下
                ...
                _mark_tui_input_modes_active()
                ...
                app.run()
```

第 ③ 步是修复一个真实的 prompt_toolkit 缺陷：渲染器每帧把光标移到底部"保证终端滚动"，非全屏模式下状态栏被推进 scrollback；列宽收缩时重排产生 ghost-line 副本（pt #29 自 2014 年悬而未决）。Hermes 用 `functools.partial` 包一层 `_output_screen_diff`，让它的"高度增加"分支直接 fall through。第 ④ 步的信号路径另有 `_arm_exit_watchdog_on_shutdown_signal`（行 446）：SIGTERM/SIGHUP 到达瞬间就武装 2 倍时长的退出看门狗——优雅卸载链在 `_run_cleanup` 之前有多个楔点，曾经的进程"死后"还活着 47 分钟（#65998）。

### 6. -q / -Q 一次性路径

`main()`（行 1670）按参数分流：`-q/--query` 在真实 TTY 上"种子"进交互会话（`_SeededQueryMessage`，逐字提交），`--oneshot`/`-Q`/非 TTY 走 `_run_single_query_mode`（`hermes_cli/cli_single_query.py`）——安静模式回答即退出，带一次性会话的信号处理与退出码归一。`stream-json` 输出格式强制 quiet。`--gateway` 则走 `_run_legacy_gateway`（行 1601）：先 `arm_startup_watchdog()` 再导入 gateway 图。

## 核心类/函数

| 名称 | 位置 | 职责 |
|---|---|---|
| `HermesCLI` | cli.py:881 | 18 个 mixin 组成的 REPL 门面类 |
| `HermesCLI.__init__` | cli.py:890 | 三段式初始化；CLI 参数优先于 config |
| `run` | cli.py:1407 | prompt_toolkit 五步装配与主循环 |
| `process_command` | cli.py:1152 | 斜杠分发；返回 False 退出 REPL |
| `_SLASH_DISPATCH` | cli.py:1117 | 命令 → (方法名, 传原始命令?) 表 |
| `_process_unregistered_slash` | cli.py:1202 | 未注册命令的四级回退 |
| `_run_cleanup` | cli.py:472 | 恰好一次的资源清理（`_CLEANUP_STEPS` 表驱动） |
| `_arm_exit_watchdog_on_shutdown_signal` | cli.py:446 | 信号到达即武装退出看门狗 |
| `_claim_active_session` | cli.py:914 | 跨进程"活动会话"租约（拒绝第二个交互进程） |
| `_detect_light_mode` | cli.py:602 | 亮/暗主题检测（OSC 11 等，缓存一次） |
| `main` | cli.py:1670 | fire CLI 入口；分流 gateway / one-shot / REPL |
| `_build_cli_from_args` | cli.py:1517 | 解析 toolset、构造 HermesCLI、后台预载 skills |
| `_lazy_shim` | cli.py:246 | 首次调用才 import 的门面垫片 |

## 本组文件清单

| 文件 | 行数 | 角色 |
|---|---|---|
| cli.py | 1,792 | REPL 门面：re-export、斜杠分发、run()、main() |
| hermes_cli/cli_init_mixin.py | ~300 | 三段初始化 |
| hermes_cli/cli_agent_setup_mixin.py | ~600 | AIAgent 构造/重建 |
| hermes_cli/cli_commands_mixin.py | ~700 | 内建命令实现 |
| hermes_cli/cli_tui_mixin.py / cli_tui_runtime_mixin.py | ~800/~500 | prompt_toolkit 布局与运行时 |
| hermes_cli/cli_stream_mixin.py | ~500 | 流式渲染 |
| hermes_cli/cli_chat_turn_mixin.py | ~600 | 单轮对话管线 |
| hermes_cli/cli_session_mixin.py | ~400 | 会话命令（/new /resume /branch） |
| hermes_cli/cli_single_query.py | ~700 | -q/-Q 一次性路径 |
| hermes_cli/cli_shutdown.py | ~400 | `_CLEANUP_STEPS` 与退出看门狗 |
| hermes_cli/cli_render.py | ~900 | 渲染原语（ANSI/皮肤/面板） |
| hermes_cli/cli_config_load.py | ~500 | CLI 配置装载与 env 镜像 |
| hermes_cli/cli_terminal_input.py | ~900 | 终端输入模式/文件拖放/粘贴 |
| 其余 8 个 mixin（backtrack/billing/info/loops/modal/model_switch/process_notifications/status_bar/voice/terminal） | 各 ~200-600 | 按主题的 REPL 能力 |

## 与其他模块的关系

- **run_agent.py**：`CLIAgentSetupMixin` 构造 AIAgent；turn 回调全部接到 CLI 的渲染线程。
- **hermes_state.py**：`/resume`、会话标题、FTS 检索都经 SessionDB。
- **model_tools.py**：`get_tool_definitions` 的 MCP 等待包装在门面（行 396）。
- **hermes_bootstrap.py / hermes_logging.py**：第一个 import 与日志初始化（`_init_logging_and_display_from_config`）。
- **tui_gateway/**：桌面端把斜杠命令转发到 gateway 进程；本门面的 `_slash_metrics_surface` 决定命令计数归属。

## 总结

- cli.py 是第二个"门面 + N 个 mixin"样板：门面保留 re-export 接缝（#116911）、分发表和装配序，行为全部在 `hermes_cli/cli_*.py`。
- `run()` 的五步顺序是踩坑史：租约（防双进程）、ghost-line patch（上游十年未修）、信号武装的退出看门狗（#65998）。
- 斜杠命令的"表驱动 + getattr 查找 + 返回 False 退出"是一切命令（含插件与 skill 命令）汇流的单点。
