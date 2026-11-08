# REPL 与 16 个 Mixin

## 文件概览

`cli.py` 的 `HermesCLI` 类由 18 个 mixin 组装（行 881）。每个 mixin 拆出 `cli.py` 的一个主题：

- 每个 mixin 文件都遵循同一约定：**cli.py 内部符号在方法内惰性 import**（`from cli import _cprint`），绝不模块级 import——避免循环且让 `cli.py` 保持补丁 seam；
- 行为写在兄弟文件里，`cli.py` 门面只保留公共入口和 re-export（机械拆分 #116911）。

## 关键代码走读

### run() 五步

`HermesCLI.run()`（`cli.py:1407`）是 REPL 的装配点，可读作五步：

```python
# cli.py:1407-1426
def run(self):
    """Run the interactive CLI loop with persistent input at bottom."""
    if not self._claim_active_session("cli"):
        return                                  # 步骤 1：跨进程活动会话租约（active_sessions.py）

    self._tui_print_startup()
    self._tui_init_run_state()
    kb = self._tui_build_key_bindings()         # 步骤 2：构建 key bindings / layout / Application
    layout, style = self._tui_build_layout(kb)
    app = self._tui_build_application(layout, kb, style)
```

```python
# cli.py:1436-1452（步骤 3：patch prompt_toolkit 渲染器修 ghost-line）
        try:
            import prompt_toolkit.renderer as _pt_renderer
            from prompt_toolkit.renderer import _output_screen_diff as _orig_osd

            if not getattr(_pt_renderer, "_hermes_osd_patched", False):
                _pt_renderer._output_screen_diff = functools.partial(
                    _hermes_call_output_screen_diff, _orig_osd
                )
                _pt_renderer._hermes_osd_patched = True
        except Exception:
            pass
```

ghost-line 补丁的 WHY（源码注释，`cli.py:1437-1440`）：prompt_toolkit 渲染器每次绘制后把光标移到画布底部以滚动终端；终端列宽收缩时旧的全宽行被重排成多行推入回滚区，留下重复的「幽灵」状态栏。包装 `_output_screen_diff`，在其 `current_height > previous_screen.height` 分支前膨胀 `previous_screen.height`，让分支不触发。

步骤 4：后台线程与清理——spinner 线程、TUI 处理线程、唤醒词线程；`atexit.register(_run_cleanup)`（`hermes_cli/cli_shutdown.py`）+ 信号处理器。步骤 5：`with patch_stdout(): app.run()`，`EOFError/KeyboardInterrupt` 直接吞掉作为正常退出。

### 输入入口：`/` 开头走 slash 派发

```python
# hermes_cli/cli_tui_runtime_mixin.py:173-183
def _tui_run_slash_input(self, user_input: str):
    """Dispatch a slash command. Returns the pending agent seed to run as a chat turn, else None."""
    from cli import _cprint
    _cprint(f"\n⚙️  {user_input}")
    try:
        if not self.process_command(user_input):
            self._should_exit = True
            if self._app.is_running:
                self._app.exit()
    except KeyboardInterrupt:
        # Ctrl+C during a slow slash command returns to the prompt instead of exiting.
        _cprint(f"\n[dim]{t('cli.tui.command_interrupted')}[/dim]")
```

`process_command` 返回 `False` 即退出 REPL；慢命令中的 Ctrl+C 只回到提示符。

### 每 turn 相位（cli_chat_turn_mixin）

`chat()` 把一个用户输入跑成相位链：**图片路由 → 暂存（staging）→ agent 线程 → 中断监视 → 渲染**。turn 之后的簿记在 `_tui_after_turn`：

```python
# hermes_cli/cli_tui_runtime_mixin.py:184-206
def _tui_after_turn(self):
    """Post-turn bookkeeping after chat() returns (normal, error, or interrupt)."""
    from cli import _DIM, _RST, _cprint
    self._agent_running = self._pet_reasoning = False
    self._spinner_text = self._last_scrollback_tool = ""
    ...
    # After an interrupt the renderer may have drifted (leaked CPR text, VT100 parser
    # stalled mid-escape): drain stray bytes and force a clean redraw.
    if self._last_turn_interrupted:
        self._recover_terminal_after_interrupt()
```

### 模态覆盖（cli_modal_mixin）

clarify（`ctx.ask_choice`）、工具批准、sudo/secret 捕获、命令面板、外部编辑器都做成 prompt_toolkit 覆盖层。工具回调在 run 时挂接：

```python
# cli.py:962-966
    def _install_tool_callbacks(self) -> None:
        """Install tool callbacks that need the live prompt UI."""
        if self._tool_callbacks_installed:
            return
        set_sudo_password_callback(self._sudo_password_callback)
        set_approval_callback(self._approval_callback)
        set_secret_capture_callback(self._secret_capture_callback)
```

### 流式渲染（cli_stream_mixin）

agent 的流式输出、reasoning 预览、工具进度回调都在这里落到屏幕；agent 忙碌时由状态栏 mixin 的 spinner 循环驱动，slash 命令在忙碌期由 `busy_policy` 决定拒绝/打断/照常派发（见 slash_registry.md）。

### 一次性模式：-q / -Q

非交互不走 `run()`：`-q` 一次性问答由 `hermes_cli/cli_single_query.py` 编排（goal 循环、退出码映射、图片路由、信号处理）；`-Q` 静默模式由 `hermes_cli/quiet_single_query.py` 处理——它还要绑定本会话 key、恢复嵌套 notify，供 Bot Mode 的 `hermes -p <bot> chat -Q --query-file` 使用。

## 核心类/函数

| 类/函数 | 文件:行号 | 职责 |
|---|---|---|
| `HermesCLI.run()` | cli.py:1407 | 装配 prompt_toolkit 应用并进入事件循环 |
| `_claim_active_session()` | cli.py:932 | 跨进程活动会话租约（失败即拒绝第二个写者） |
| `_install_tool_callbacks()` | cli.py:962 | sudo/批准/secret 回调接prompt UI |
| `_tui_run_slash_input()` | cli_tui_runtime_mixin.py:173 | slash 输入入口；False→退出 |
| `chat()` | cli_chat_turn_mixin.py | 每 turn 相位：图片/staging/线程/中断/渲染 |
| `_tui_after_turn()` | cli_tui_runtime_mixin.py:184 | turn 后簿记 + 中断后终端恢复 |
| `_run_cleanup()` | cli_shutdown.py | atexit：恢复输入模式/焦点报告/租约释放 |

## 本组文件清单

| 文件 | 行数 | 职责 |
|---|---|---|
| cli_agent_setup_mixin.py | 925 | agent 构建 + resume 显示、凭据解析、每 turn agent 配置 |
| cli_billing_mixin.py | 1159 | `/topup`、`/subscription` 计费与订阅视图 |
| cli_chat_turn_mixin.py | 809 | `chat()` 每 turn 相位：图片路由/staging/agent 线程/中断监视/渲染 |
| cli_commands_mixin.py | 2164 | 大量 slash 处理器（命令本体） |
| cli_commands_session_tools.py | — | 从 commands mixin 拆出的会话工具命令 |
| cli_commands_worktree.py | — | 从 commands mixin 拆出的 `/worktree` |
| cli_info_mixin.py | 1081 | banner/help/tools/usage/insights/reload、bang shell |
| cli_init_mixin.py | 604 | 构造相位：显示选项/模型路由/turn 上限/toolsets/checkpoints/session store/UI 状态 |
| cli_loops_mixin.py | 894 | goal/heartbeat/loop 管理器钩子 + 简单命令包装 |
| cli_modal_mixin.py | 1303 | 模态：clarify/approval/sudo/secret/命令面板/外部编辑器 |
| cli_model_switch_mixin.py | 1133 | 模型选择器、`/model` 运行时快照恢复、codex runtime |
| cli_session_mixin.py | 1226 | new/resume/save、undo/retry 回退、yolo 持久化、手动压缩、退出摘要 |
| cli_status_bar_mixin.py | 1254 | 状态栏/spinner/turn 摘要/pet 面板/prompt 暂存 |
| cli_stream_mixin.py | 890 | 流式输出、reasoning 预览、工具进度回调、忙碌 spinner |
| cli_terminal_mixin.py | 674 | 重绘/resize 恢复/输入模式治疗/剪贴板 |
| cli_tui_mixin.py | 2311 | prompt_toolkit 构建：key bindings/layout/overlay |
| cli_tui_runtime_mixin.py | 576 | run loop 相位：输入处理/启动横幅/预热/维护/信号/关停 |
| cli_voice_mixin.py | 843 | STT/TTS/barge-in 全双工/wake word |
| cli_shutdown.py | — | atexit 清理：终端模式复位、会话租约释放 |
| cli_single_query.py | — | `-q` 一次性模式编排（goal 循环/退出码/图片路由/信号） |
| quiet_single_query.py | — | `-Q` 静默模式：会话 key 绑定、嵌套 notify 恢复 |
| active_sessions.py | — | 跨进程活动会话租约注册表 |

## 与其他模块的关系

- **agent/**：`cli_agent_setup_mixin` 构建 `AIAgent`；流式回调契约由 `cli_stream_mixin` 实现。
- **gateway/**：`gateway_setting_commands`/`gateway_cli_commands`/`gateway_plugin_commands` 在 `process_command` 中被调用，把网关拥有的设置/命令接进来。
- **observability/**：`run()` 挂 `cli_prompt_ready_handler`；每条 slash 命令经 `record_slash_command` 计数。
- **tools/**：quick command 的 `exec` 用 `tools.environments.local.build_subprocess_env` 洗环境变量。

## 总结

REPL 的可读入口只有两个：`run()`（装配）与 `process_command()`（派发）。其余一切——渲染、模态、语音、模型切换、会话生命周期——都是 18 个 mixin 中一个主题文件的责任。改动时先找 mixin，再回到 `cli.py` 只为确认 seam。
