# acp_adapter/ —— 把 Hermes 暴露给编辑器的 ACP 适配器

## 文件概览

ACP（Agent Client Protocol）是 Zed 等编辑器与编码代理通话的协议；Hermes 经 `acp/agent-client-protocol` Python 包实现它，`acp_adapter/` 把 Hermes 暴露为一个 ACP agent——于是你可以在编辑器里直接跟 Hermes 对话。入口是 `entry.py`（`python -m acp_adapter.entry`、`hermes acp` 或 `hermes-acp` 命令），进程内服务在 `server.py`（`HermesACPAgent`，自建 AIAgent 的执行路径），网关投影在 `gateway_server.py`（`GatewayACPAgent`——**「profile 网关的 ACP 投影；永不构建执行 owner」**）。共 22 个文件：协议骨架（entry/server/gateway_server/modes/events/auth）+ 会话与目录（session/catalog/model_catalog/provenance）+ 桥接件（content/tools/commands/permissions/edit_approval/elicitation）+ 网关面（gateway_commands/gateway_media/gateway_reply/gateway_session_meta）。

## 关键代码走读

### entry.py：stdout 是协议，stderr 是日志

```python
# acp_adapter/entry.py:1-9
"""CLI entry point for the hermes-agent ACP adapter.

Loads ``~/.hermes/.env``, routes logging to stderr (stdout is reserved for ACP
JSON-RPC), and starts the ACP agent server.

Usage::

    python -m acp_adapter.entry   # or: hermes acp / hermes-acp
"""
```

stdio 传输下 stdout 是 JSON-RPC 专线——一条混进 stdout 的日志就会破坏协议帧，所以 `_setup_logging()`（行 65-78）把 root logger 全部改道 stderr（且经 `RedactingFormatter` 脱敏），`httpx/httpcore/openai` 降噪到 WARNING。启动顺序上有三道保险：

```python
# acp_adapter/entry.py:13-28
try:
    import hermes_bootstrap
except ModuleNotFoundError as exc:
    # Partial ``hermes update`` (git-reset landed, ``uv pip install -e .`` did not).
    if exc.name != "hermes_bootstrap" and not "hermes_bootstrap".startswith(f"{exc.name}."):
        raise  # the bootstrap exists but cannot load: skipping it would skip PM activation
else:
    # Stop a ``utils/``/``proxy/``/``ui/`` package in the launch cwd from shadowing Hermes modules.
    hermes_bootstrap.harden_import_path()

# `hermes-acp` runs without hermes_cli.main: repair a `hermes update` killed mid-pull here, before
# importing anything else from the checkout (a no-op under `hermes acp`, which already did).
from hermes_cli import _early_recovery

if _early_recovery.restore_interrupted_pull():
    _early_recovery.relaunch_after_restore()
```

`hermes_bootstrap` 必须是第一个 import（Windows 上的 UTF-8 stdio）；导入失败时只有「bootstrap 本身存在但装不上」才重抛——跳过它等于跳过 PM 激活。`hermes-acp` 不经过 `hermes_cli.main`，所以被半路杀死的 `hermes update` 的恢复（`restore_interrupted_pull` → 可能 re-launch）在这里补做。良性探针过滤（行 39-62）：`ping`/`health`/`healthcheck` 不在 ACP schema 里，路由器正确回 JSON-RPC -32601（客户端当「agent 活着」），但派发 supervisor 会为每次探针打一条「Background task failed」堆栈——过滤器只吞这个噪声，其余 method_not_found 依旧可见。进程主循环里还有两处值得注意：Windows 上先在主线程预热 memory provider + numpy 的 import（首次原生扩展 import 与另一线程的 import 链竞争曾在 `create_module` 死锁、`session/new` 永不响应，#58083）；MCP 发现与执行属于网关守护进程——「这个进程是一个查看者」。

### server.py vs gateway_server.py：两条执行路径

```python
# acp_adapter/server.py:273
class HermesACPAgent(SlashCommandsMixin, acp.Agent):
```

```python
# acp_adapter/gateway_server.py:1
"""ACP projection of the profile gateway; never constructs an execution owner."""
```

`server.py`（1,155 行）是进程内 agent server：自己构造 AIAgent（线程池 `_executor = ThreadPoolExecutor(max_workers=4, thread_name_prefix="acp-agent")` 把同步 agent 挪出事件循环），自己管理 sessions/models/modes/usage 更新（经 `acp.schema` 类型）。`gateway_server.py`（1,238 行）是另一条路：**投影**——经 `hermes_cli.gateway_client.connect_gateway` 把每个 ACP 请求转成网关动词，本进程不建任何执行 owner。 slash 识别（`_slash_command`，行 17-33）只认注册命令或别名：`/etc/hosts is wrong` 是 prompt 文本不是命令；注册命令绝不降级为 prompt——要么被网关动词应答，要么按名拒绝。`--safe-mode`/`--ignore-user-config` 启动的会话必须在 session/new 时冻结显式路由（`_bypass_route`，行 36-51）：只给模型不给 provider 的话，第一轮 turn 就无法构建 agent——所以在会话创建时就拒绝。

### modes.py：一张 19 行的表

```python
# acp_adapter/modes.py:1-18
"""ACP's edit modes, one table for the in-process server and the gateway path.

mode id -> (edit approval policy, display name, description). On the gateway path the policy is the
session's own on the owner (``session.mutate edit_policy``), enforced where the edit runs
(``gateway/session_local_editor.py``); sensitive paths always ask."""

DEFAULT_MODE = "default"
DEFAULT_EDIT_APPROVAL_POLICY = "ask"
EDIT_APPROVAL_POLICY_CONFIG_ID = "edit_approval_policy"
MODES: dict[str, tuple[str, str, str]] = {
    "default": ("ask", "Default", "Ask before edits."),
    "accept_edits": ("workspace_session", "Accept Edits",
                     "Auto-allow workspace and temp-dir edits; still asks for sensitive paths."),
    "dont_ask": ("session", "Don't Ask", "Auto-allow file edits for this session except sensitive paths."),
}
MODE_TO_EDIT_APPROVAL_POLICY = {mode: spec[0] for mode, spec in MODES.items()}
EDIT_APPROVAL_POLICY_TO_MODE = {spec[0]: mode for mode, spec in MODES.items()}
```

三个编辑模式映射到 Hermes 的编辑审批政策：`default`→`ask`（每笔编辑都问）、`accept_edits`→`workspace_session`（工作区+临时目录自动放行，敏感路径仍问）、`dont_ask`→`session`（本会话文件编辑自动放行，敏感路径例外）。**敏感路径永远要问**——模式再宽松也不越过安全下限。表驱动：进程内路径直接查表构造审批回调（`permissions.py` 的 `make_approval_callback`），网关路径把它写进 owner 的 `session.mutate edit_policy`、在**编辑真正执行的地方**（`gateway/session_local_editor.py`）强制。`edit_approval.py` 是预执行审批助手：把审批请求者绑进 ContextVar，只在一次 ACP agent 运行期间有效；CLI/网关等会话不设它、天然绕过——「隔离于通用工具注册表」是刻意的。

### events.py：线程到事件循环的桥

```python
# acp_adapter/events.py:1-7
"""Callback factories for bridging AIAgent events to ACP notifications.

Each factory returns a callable with the signature AIAgent expects for its
callbacks. AIAgent runs in a worker thread while the event loop lives on the
main thread, so updates are pushed via ``conn.session_update()`` scheduled
thread-safely onto the loop."""
```

AIAgent 在 worker 线程跑、事件循环在主线程——每个回调工厂（`make_message_cb`、`make_step_cb`、`make_thinking_cb`、`make_tool_progress_cb`）都返回 AIAgent 期待的签名，内部用 `conn.session_update()` 线程安全地排进循环。`AssistantMessageIdAllocator` 分配消息 id；`flush_open_tool_calls` 保证流中断时未闭合的 tool-call 气泡被正确关闭；`_build_plan_update_from_todo_result` 把 Hermes 的 todo 结果折算成 ACP 的计划更新。`content.py` 做反向翻译：ACP prompt 内容块（文本/图片/资源/audio）⇄ OpenAI user content；`tools.py` 把 Hermes 工具映射到 ACP ToolKind 并用 `agent.display.build_tool_preview` 造预览。

### auth.py 与 catalog.py

```python
# acp_adapter/auth.py:1-8
"""ACP auth helpers — detect and advertise Hermes authentication methods."""

TERMINAL_SETUP_AUTH_METHOD_ID = "hermes-setup"


def detect_provider() -> Optional[str]:
    """Resolve the active Hermes runtime provider, or None if unavailable.

    A callable ``api_key`` (Azure Foundry Entra ID bearer-token provider, see
    :mod:`agent.azure_identity_adapter`) counts as a valid credential; otherwise
    Entra-configured Foundry deployments would default to ``"openrouter"`` and ...
```

`hermes-setup` 认证方法把「在终端里跑 `hermes acp --setup`」通告给编辑器——编辑器发起认证时，适配器指引它走 Hermes 自己的 provider/model 设置流。`detect_provider` 的细节：可调用的 `api_key`（Entra bearer token 提供者）也算有效凭据，否则 Entra 配置的 Foundry 部署会被误判为默认 `openrouter`。`catalog.py` 是历史会话目录：从 `hermes_state.SessionDB` 只读投影（不做存储初始化、不建执行 owner）；`provenance.py` 从既有压缩链（`sessions` 表的 `parent_session_id`/`end_reason`）派生 `_meta.hermes` 出处元数据——压缩轮换内部 head 时，编辑器侧的 session_id 仍是稳定公共句柄，出处元数据暴露前/当前内部 id 与谱系根。`elicitation.py`：声明了 `elicitation.form` 能力的客户端拿到 `elicitation/create` 表单；其他客户端拿到「选项 + Skip」的权限卡——所有 ACP 客户端都会渲染的那种交互。

## 核心类/函数

| 符号 | 位置 | 职责 |
|---|---|---|
| `main()` | `entry.py:163` | 入口：bootstrap→恢复→日志→env→TLS→ACP serve |
| `_setup_logging()` / `_BenignProbeMethodFilter` | `entry.py:65/45` | 日志改道 stderr + 探针降噪 |
| `_load_env()` | `entry.py:81` | `~/.hermes/.env` 加载 |
| `_run_setup()` / `_run_setup_browser()` | `entry.py:120/143` | 终端认证 setup + PM 钉版 Chromium |
| `HermesACPAgent` | `server.py:273` | 进程内 agent server |
| `GatewayACPAgent` / `GatewayReplyMixin` | `gateway_server.py:67` / `gateway_reply.py` | 网关投影 + 回复混入 |
| `_slash_command()` | `gateway_server.py:17` | 只认注册命令/别名 |
| `_bypass_route()` | `gateway_server.py:36` | safe-mode 会话冻结显式路由 |
| `SessionManager` / `SessionState` | `session.py` | ACP 会话 ⇄ AIAgent 映射（持久进共享 SessionDB） |
| `MODES` / `MODE_TO_EDIT_APPROVAL_POLICY` | `modes.py:11/17` | 编辑模式表 |
| `make_approval_callback()` | `permissions.py` | 危险命令审批桥（ACP 选项 ⇄ Hermes 结果） |
| 预执行审批 ContextVar | `edit_approval.py` | 一次 agent 运行期的编辑审批请求者 |
| `make_*_cb` 工厂 | `events.py` | AIAgent 事件 → ACP 通知 |
| `_content_blocks_to_openai_user_content()` / `_extract_text()` | `content.py` | 内容块双向翻译 |
| `build_tool_start/complete` / `coerce_tool_args` | `tools.py` | 工具调用映射 + ToolKind |
| `SlashCommandsMixin` | `commands.py` | 无头 slash（/help /model /compress…） |
| `build_model_state()` / `encode_model_choice()` | `model_catalog.py` | 去重 `provider:model` 行的模型选择器 |
| `TERMINAL_SETUP_AUTH_METHOD_ID` / `detect_provider()` | `auth.py:6/8` | 认证方法通告 |
| `read_catalog_rows()` | `catalog.py` | SessionDB 只读历史目录 |
| `build_session_provenance`（语义） | `provenance.py` | 压缩链出处 |
| `ELICITATION_METHOD` / `SKIP_OPTION` | `elicitation.py` | clarify 表单/权限卡 |
| gateway_media/_reply/_session_meta | `gateway_*.py` | 提交内容/回复分组/元数据投影 |

## 本组文件清单（22 文件全清单）

| 文件 | 角色 | 关键符号 |
|---|---|---|
| `acp_adapter/entry.py` | CLI 入口（stdio 纪律） | `main`, `_BenignProbeMethodFilter` |
| `acp_adapter/server.py` | 进程内 ACP agent server | `HermesACPAgent` |
| `acp_adapter/gateway_server.py` | 网关投影（永不建 owner） | `GatewayACPAgent`, `_slash_command` |
| `acp_adapter/session.py` | 会话 ⇄ AIAgent 映射 | `SessionManager` |
| `acp_adapter/modes.py` | 编辑模式表 | `MODES` |
| `acp_adapter/events.py` | 事件桥（线程→循环） | `make_message_cb` 等 |
| `acp_adapter/auth.py` | 认证方法通告 | `hermes-setup` |
| `acp_adapter/catalog.py` | 历史会话只读目录 | `read_catalog_rows` |
| `acp_adapter/commands.py` | 无头 slash | `SlashCommandsMixin` |
| `acp_adapter/content.py` | 内容块翻译 | `_content_blocks_to_openai_user_content` |
| `acp_adapter/tools.py` | 工具调用映射 | `ToolKind`, `build_tool_start` |
| `acp_adapter/permissions.py` | 危险命令审批桥 | `make_approval_callback` |
| `acp_adapter/edit_approval.py` | 预执行编辑审批 | ContextVar 请求者 |
| `acp_adapter/model_catalog.py` | 模型选择器 | `build_model_state` |
| `acp_adapter/provenance.py` | 压缩链出处 | `_meta.hermes` |
| `acp_adapter/elicitation.py` | clarify 表单/权限卡 | `elicitation/create` |
| `acp_adapter/gateway_commands.py` | 网关路径 slash（每个=既有网关动词） | `ROUTES` |
| `acp_adapter/gateway_media.py` | 编辑器内容 → prompt.submit + 附件 | `_fetch_remote_image` |
| `acp_adapter/gateway_reply.py` | 回复分组与恰好一次终稿 | `GatewayReplyMixin` |
| `acp_adapter/gateway_session_meta.py` | 元数据投影（快照/usage/state.db） | `session.info` |
| `acp_adapter/__main__.py` | `python -m acp_adapter` | `entry.main` |
| `acp_adapter/__init__.py` | 包标记 | — |

## 与其他模块的关系

- **gateway/**：`GatewayACPAgent` 全靠 `hermes_cli.gateway_client` 的 RPC；「查看者而非 owner」原则呼应 `tutorial/01_architecture` 的执行所有权模型。
- **hermes_state.SessionDB**：会话持久化进共享 `state.db`（`session.py`），重启后 `load_session`/`resume_session` 全量恢复历史，也出现在 `session_search` 里。
- **agent/**：`HermesACPAgent` 构造 AIAgent；事件桥消费 AIAgent 的回调签名；`agent/context_compressor` 的压缩链是 provenance 的数据源。
- **pm/**：`hermes acp --setup-browser` 经 `pm.ensure("chromium")` 装 browser_exec 的本地浏览器。
- **tools/approval_context**：`set_hermes_interactive_context` 让 ACP 会话获得交互式审批语义。

## 总结

acp_adapter 的全部复杂度都服务于一条原则：**「查看者而非 owner」**。进程内路径（`server.py`）为没有网关的轻量场景自建 agent；网关路径（`gateway_server.py`）把每个 ACP 概念投影成既有网关动词，永不构建第二个执行 owner——执行、MCP、会话生命周期都归 daemon，编辑器只是一个渲染器。协议适配的技术底座是三条纪律：stdout 只走协议帧（日志全改道 stderr）、跨线程事件线程安全地排进循环、编辑审批的安全下限（敏感路径必问）写在模式表之外、不可协商。
