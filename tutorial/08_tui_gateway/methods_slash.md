# 08.4 方法面导览 —— 34 个 methods_*.py 与 slash worker 机制

`server.py`（2041 行）是门面，真正的 RPC 方法按主题拆在 34 个 `methods_*.py` 兄弟模块里（合计约 15,000 行）。这些模块用 `method_ctx.HandlerRegistry` 声明方法，`server.py` import 完自己的全局后统一 `install` 重绑定——bodies 以 `types.FunctionType` 复制到 server 命名空间，裸引用 `_sessions`、`_ok`、`_err` 等 global。

## 文件概览

| 文件 | 行数 | 主题 |
|------|------|------|
| `method_ctx.py` | — | 拆分 seam：`bind_module` + `HandlerRegistry` |
| `methods_session.py` | 2339 | 会话 CRUD/列表/恢复/转写（+ branch/control/interrupt/foreign/model_guard 四兄弟） |
| `methods_prompt.py` | 1551 | `prompt.submit` 与 turn 门外的一切 |
| `methods_tools.py` | 1981 | 工具/MCP 面（+ `methods_tools_plugin_servers.py`） |
| `methods_config.py` / `methods_config_set.py` | 547/614 | 配置读写（`config.get`/`config.set`） |
| `methods_slash.py` | 549 | `slash.exec` 的会话侧与副作用镜像 |
| `methods_voice.py` | 900 | 语音录制/转写/提交 |
| `methods_profiles.py` | 791 | profile 管理 |
| `methods_groups.py` / `methods_groups_forward.py` | 669/228 | 多人会话与转发 |
| `methods_complete.py` / `methods_complete_helpers.py` | 413/150 | `complete.slash` / `complete.path` |
| `methods_connectors.py` / `methods_connectors_account.py` | 445/333 | 连接器操作（`connection.request` 流） |
| `methods_display.py` / `methods_display_watch.py` | 274/178 | 显示偏好 |
| `methods_onboarding.py` | 316 | onboarding 卡 |
| `methods_projects.py` | 405 | 项目 |
| `methods_session_control.py` | 421 | 会话控制（title 等） |
| `methods_subagents.py` | 214 | `subagent.list/tail/steer/interrupt` |
| `methods_vault.py` | 234 | vault 提示（预览 fill 走 pinned 应答） |
| `methods_browser.py` | 175 | 浏览器操作 |
| `methods_bot_relay.py` | 152 | Bot Mode 中继 |
| `methods_images.py` / `methods_free_tier.py` / `methods_i18n.py` / `methods_plugin_catalog.py` / `methods_machine.py` | 126/127/66/45/23 | 图像 / 免费层 / 语言包 / 插件目录 / 机器信息 |
| `methods_shared_metrics.py` | 203 | 共享指标 |

## 关键代码走读

### 1. 拆分 seam：`HandlerRegistry` 如何把兄弟模块接到门面

```python
# tui_gateway/method_ctx.py:44-50, 65-70 (节选)
class HandlerRegistry:
    """Deferred @method registrar used by the split modules."""

    def __init__(self) -> None:
        self._pending: list[tuple[str, types.FunctionType]] = []

    def method(self, name: str):
        """Drop-in for server.py's ``@method`` decorator (defers registration)."""
        def dec(fn):
            self._pending.append((name, fn))
            return fn
        return dec
    ...
    def install(self, server) -> None:
        """Rebind pending handlers onto ``server``'s globals and register them."""
        g = vars(server)
        for name, fn in self._pending:
            real = rebind(fn, g)
            if getattr(fn, "_hermes_profile_scoped", False):
                ...
```

`rebind`（19-41 行）复制函数并重绑闭包里同模块的函数，连 `contextlib.contextmanager` 包装的生成器也经 `__wrapped__` 重绑。没有 import 环：兄弟模块从不在模块级 import server，是 server 在自己 import 末尾把名字递进去。

### 2. slash 在 worker 里跑：`_SlashWorker`

slash 命令不跑在 gateway 进程内，而是跑在持久子进程 `tui_gateway.slash_worker`（每个会话一个 HermesCLI）。客户端协议只有两行注释：

```text
# tui_gateway/slash_worker.py:1-4
"""Persistent slash-command worker — one HermesCLI per TUI session.

Protocol: reads JSON lines from stdin {id, command}, writes {id, ok, output|error} to stdout.
"""
```

gateway 侧的 `_SlashWorker` 负责把子进程拉对：

```python
# tui_gateway/slash_worker_client.py:56-58, 74-76, 91-94 (节选)
        argv = [sys.executable, "-P", "-m", "tui_gateway.slash_worker", "--session-key", session_key] \
            + (["--model", model] if model else []) \
            + (["--provider", provider] if provider else [])
        ...
        env = _prepend_tool_paths(served_profile_child_env(
            target_home=profile_home or (_hermes_home if is_multiplex_active() else None),
            inherit_credentials=True))
        ...
        self.proc = spawn_owned(
            argv, purpose="slash-worker", stdin=subprocess.PIPE, stdout=subprocess.PIPE,
            stderr=subprocess.PIPE, text=True, encoding="utf-8", errors="replace", bufsize=1,
            cwd=os.getcwd(), env=env, creationflags=windows_hide_flags())
```

四个细节都有 issue 背书：`--provider` 钉住父 agent 的虚拟 provider（MoA 会话否则把 preset 名字发给真实 provider 然后 402/503，#57283）；`served_profile_child_env` 让多路复用下的 worker 拿到**该 profile** 的 home + secrets（#40677/#115427）；`spawn_owned` 让 worker 领自己的进程组——gateway 被 SIGKILL/OOM 时 worker 组跟着死，否则一个快速命令的 shell 会永远挂着；`-P` 让 worker 的 cwd 不进 `sys.path`（用户目录里的 `utils/` 包不许遮蔽 Hermes 顶层模块）。`run()`（109-127 行）写一行 JSON、在 `_SLASH_WORKER_TIMEOUT_S`（默认 45s）内等匹配 id 的应答。

`methods_slash.py` 里还有一层"活会话短路"：`/context`、`/tools`、`/help` 在 compute-host 会话上直接答，本地 `/context` 在进程内渲染（worker 的 CLI 是懒建 agent 的，slash 命令永远答"(._.) No active agent"，#81251/#93280）；`/review`、`/refine` 直接派发到活 agent 而不是 fork worker（`_format_live_review_output`，`methods_slash.py:29`）。

### 3. 事件发布与重放：`event_publisher.py` / `event_replay.py`

`event_publisher.py` 是 PTY 侧的尽力而为 WS 镜像：

```text
# tui_gateway/event_publisher.py:1-5 (docstring)
"""Best-effort WebSocket publisher transport for the PTY-side gateway.

The dashboard's `/api/pty` spawns `hermes --tui`, which spawns ``tui_gateway.entry`` — three
processes from the dashboard server. To surface events in the sidebar (`/api/events`), that gateway
opens a back-WS to the dashboard at startup and mirrors every emit through this transport as
newline-framed JSON (no JSON-RPC envelope; ``/api/pub`` rebroadcasts bytes verbatim). Failure mode:
silent — the agent loop must never block on the sidecar."""
```

`WsPublisherTransport`（31 行）用 256 深度的队列 + 守护线程排空，满了就丢——侧边栏不许拖住 agent 循环。`entry.py::_install_sidecar_publisher`（87-93 行）把它 tee 在 stdio transport 后面。

`event_replay.py` 是 WS 重连的记忆：

```python
# tui_gateway/event_replay.py:1-8 (docstring 节选)
"""Per-session event sequencing + bounded replay for WS reconnects.

Every event frame through :func:`server.write_json` (hence ``_emit``) gets a per-session monotonic
``seq`` and lands in a small ring per session; a reconnecting client calls ``session.events.since``
with its last seen seq and gets everything newer. ...
"""
```

内存上限三重：每会话 512 条**或** 4 MB 冻结 UTF-8 字节；全进程 64 MB、64 个会话；FIFO 逐出（`_REPLAY_BUFFER_MAX = 512`、`_REPLAY_BUFFER_BYTES_MAX = 4 * 1024 * 1024` 等，27-34 行）。逐出留下水位线，重连客户端发现有洞就整段重取。`_REPLAY_EPOCH`（22 行）解决"服务器重启 seq 归 1、客户端还举着 97"的错位——epoch 让客户端识别重启并重置水位线。

### 4. 会话注册与生命周期

`session_registry.py` 管会话槽里 agent 的就绪等待。`_wait_agent_for_prompt`（33 行）是防"第一条消息被吃"的关键：

```python
# tui_gateway/session_registry.py:18-19, 33-40 (节选)
_AGENT_BUILD_WAIT_SLICE = 5.0
_AGENT_BUILD_SLOW_NOTICE_AFTER = 30.0
...
def _wait_agent_for_prompt(session: dict, rid: str, sid: str) -> dict | None:
    """Patient ``_wait_agent`` for deferred prompt.submit: the client already got ``streaming`` and the
    first message IS the turn, while a cold build routinely outlives the flat 30s ceiling (timing out
    silently discarded it). Waits in short slices (cancel honored promptly), notifies once (keyed) past
    ``_AGENT_BUILD_SLOW_NOTICE_AFTER``, fails only on a dead build thread or the bounded cap.
    ...
```

旧的 30s 平顶是"消息被永久丢弃的悬崖"（#63078）：`prompt.submit` 已回 `{"status": "streaming"}`，冷启动构建（MCP 逐服务器重试退避、同步模型元数据 HTTP、技能扫描）却常常超过 30 秒。现在按 5 秒片等待（取消能及时响应），过 30 秒发一次 keyed 慢构建通知，上限可经 `agent.build_wait_timeout` 调（默认 600s）。

`session_lifecycle.py` 管终结与拆除。两个小而重要的片段：

```python
# tui_gateway/session_lifecycle.py:21-27, 39-45
def _start_session_work(target, *, name: str, session: dict | None = None):
    """Reserve before spawning; release only after the worker (including cleanup) has unwound."""
    from agent.memory_provider import spawn_context_thread
    from hermes_cli.backend_retirement import retirement

    if not retirement.acquire():
        return None
    ...
def _notify_session_boundary(event_type: str, session_id: str | None, platform: str | None = None) -> list[str]:
    """Fire session lifecycle hooks with CLI parity; returns plugin ``on_session_finalize`` user messages."""
    ...
        invoke_hook(event_type, session_id=session_id, platform=_resolve_agent_platform(platform))
```

后台线程经 `agent.memory_provider.spawn_context_thread` 起步（绝不裸 `threading.Thread`——作用域跟线程走）；`_finalize_session` / `_teardown_session` 进入 `_session_profile_runtime_scope(session)` 再跑 `on_session_end`、记忆提交与 `agent.close()`，因为它们的调用者是**无作用域**的 reaper、Timer、atexit 和池线程。自动结束原因（`ws_orphan_reap`、`idle_timeout`、`lru_evict`…）集合在 `_AUTOMATIC_SESSION_END_REASONS`（47 行附近）。

### 5. agent 工厂与 turn 主体

`agent_factory.py` 决定新会话 agent 的种子：`_resolve_model`（10 行）按 env seed → config → cost-safe 静默默认（`get_preferred_silent_default_model`）解析，"从不落到未选定的旗舰"；`_resolve_session_platform`（26 行）区分 desktop/tui。`agent_callbacks.py` 提供构造 `AIAgent` 时的回调桥。

`prompt_turn.py` 的 docstring 就是一张 turn 流程图：

```text
# tui_gateway/prompt_turn.py:4-7 (docstring)
"""The prompt turn: ``_run_prompt_submit`` and the per-phase helpers it drives.

... Turn shape (one fresh daemon thread):
admit -> crash marker -> bind scopes -> resolve message -> run_conversation ->
commit history / message.complete -> goal & loop hooks -> release scopes ->
post-turn follow-ups (queued prompt, goal continuation, notifications).
"""
```

`checkpoints.py` 解决 Desktop 会话检查点被环境变量单闸门误关的问题（#79625）：

```python
# tui_gateway/checkpoints.py:1-11 (docstring 节选)
"""Checkpoint-enablement resolution for TUI-created agents (issue #79625).

Desktop sessions (``hermes serve`` → TUI gateway) never set ``HERMES_TUI_CHECKPOINTS``
(that env var is only set by the ``hermes --tui --checkpoints`` CLI path), so agent
creation previously gated filesystem checkpointing on the env var alone and silently
ignored ``checkpoints.enabled`` in config.yaml. These helpers resolve enablement the
way the messaging gateway does ...: the env var (explicit CLI opt-in) wins when set, otherwise the ``checkpoints`` config section applies with ``DEFAULT_CONFIG`` defaults.
"""
```

### 6. 多人房间、账单视图与主题桥

`hosted_room_*.py` 七个文件（driver/member_activity/peer_deadline/peer_http/peer_transport/prepare_stall/router_call/service）把 `gateway/hosted_room*` 的多人讨论房间接到 RPC 面；`hosted_room_service.py` 开头一句自述："Production coordinator for same-gateway hosted Discussion rooms."。`billing_view.py` 用**结构化信封**（`result.ok`/`result.error`）而不是 JSON-RPC 错误，客户端永远能解析并在类型化 billing code 上分支。`theme_bridge.py` 把 `theme.apply`（值请求，渲染器毫秒级应答）和 `theme.pick`（卡片等用户）分到两个超时（15s/300s）：

```python
# tui_gateway/theme_bridge.py:8-10, 18-22 (节选)
# Applying a theme is a store write the renderer answers in ms; a picker waits for a person.
THEME_TIMEOUT_S = 15
THEME_PICK_TIMEOUT_S = 300

def theme_request(sid: str, payload: dict) -> dict:
    """The renderer's answer; a dismissed picker and an expired one are told apart."""
    from tui_gateway import server_requests
    from tui_gateway.server import _ask
```

`_ask`（`server.py:969`）是"向用户提新问题"的标准入口。`render.py` 供出 `make_stream_renderer` / `render_diff` / `render_message`，Python 侧的文本投影与 Ink 的屏幕保持职责分离。

## 核心类/函数

| 名称 | 位置 | 职责 |
|------|------|------|
| `HandlerRegistry` | `tui_gateway/method_ctx.py:44` | 兄弟模块的延迟 `@method` 注册器，`install` 重绑定 |
| `_SlashWorker` | `tui_gateway/slash_worker_client.py:44` | 持久 slash 子进程：`run()` 问答、stderr 尾巴、组销毁 |
| `WsPublisherTransport` | `tui_gateway/event_publisher.py:31` | PTY 侧 back-WS 事件镜像（尽力而为） |
| `_stamp_event` / `replay_epoch` / `events_since` | `tui_gateway/event_replay.py` | per-session `seq` + 有界重放环 |
| `_wait_agent_for_prompt` | `tui_gateway/session_registry.py:33` | 冷构建下的耐心等待（防首条消息被吃） |
| `_start_session_work` | `tui_gateway/session_lifecycle.py:21` | retirement 预留 + `spawn_context_thread` 起线程 |
| `_notify_session_boundary` | 同上 :39 | 会话边界插件钩子（与 CLI 对齐） |
| `_resolve_model` | `tui_gateway/agent_factory.py:10` | env → config → cost-safe 默认 |
| `_run_prompt_submit` | `tui_gateway/prompt_turn.py` | turn 主链（见 docstring 流程图） |
| `resolve_checkpoints_enabled` | `tui_gateway/checkpoints.py:36` | env 覆盖优先、config 兜底 |
| `theme_request` | `tui_gateway/theme_bridge.py:18` | 主题应答（dismissed vs expired 可分辨） |
| `_ask` | `tui_gateway/server.py:969` | server→client 请求的统一入口（默认 300s 超时） |

## 本组文件清单

| 文件 | 一句话 |
|------|--------|
| `method_ctx.py` | `rebind` + `HandlerRegistry`：拆分模块接入门面的 seam |
| `methods_*.py`（34 个） | 按主题的 RPC handler（见文件概览表） |
| `slash_worker.py` | worker 子进程本体：stdin JSON 行协议 + 父进程看门狗 |
| `slash_worker_client.py` | gateway 侧 worker 客户端：spawn/env/超时/组管理 |
| `event_publisher.py` / `event_replay.py` | 侧边栏镜像 / 重连重放 |
| `session_registry.py` / `session_lifecycle.py` / `session_transports.py` / `session_reaper.py` / `session_history.py` / `session_compression.py` / `session_auto_continue.py` / `session_notifications.py` / `session_workdir.py` | 会话槽与生命周期家族 |
| `agent_factory.py` / `agent_callbacks.py` | agent 构造种子与回调桥 |
| `prompt_turn.py` / `prompt_attachments.py` / `synthetic_turn.py` / `turn_marker.py` | turn 主体与辅助 |
| `checkpoints.py` | 检查点使能解析 |
| `hosted_room_*.py`（7 个） | 多人房间的 RPC 面 |
| `billing_view.py` / `theme_bridge.py` / `render.py` / `command_discovery.py` / `slash_fuzzy.py` / `project_tree.py` / `pet_sheet.py` / `git_probe.py` / `stream_segments.py` / `tool_progress.py` / `loop_noise.py` / `user_messages.py` | 数据构建器与渲染辅助 |

## 与其他模块的关系

- `hermes_cli/commands.py`：slash 注册表的定义源；`command_discovery.py` 构建目录数据但**不 import 旧 server**。
- `agent/memory_provider.py::spawn_context_thread`：一切后台线程的正确起点（作用域随线程）。
- `gateway/session_commands.py`：canonical 传输上的 slash 执行适配（不加载 worker）；本组的 `slash.exec` 是 sidecar 面。
- `apps/desktop`/`ui-tui`：`methods_connectors.py` 的连接操作卡、`methods_vault.py` 的预览 fill 都以 TS 侧 handler 为对端（见 contracts.md）。

## 总结

方法面的组织哲学是「门面 + 主题兄弟 + 表驱动」：`server.py` 只留方法表和全局，34 个模块经 `HandlerRegistry` 延迟注册、`install` 时重绑定——没有 if 链，没有 import 环。slash 命令跑在自己的持久 worker 子进程里，环境经 `served_profile_child_env` 精确注入；事件面靠 per-session `seq` + 有界重放环撑起重连；会话生命周期把"无作用域的清理者"全部包进 `_session_profile_runtime_scope`。读到这一层，`tui_gateway` 的行为就不再是黑盒，而是一张可 grep 的方法目录。
