# 协议接入深读 —— entry/server/gateway_server/modes/events/auth

## 文件概览

本篇按「一个进程如何变成一个 ACP agent」的顺序走读协议接入的五个支点：`entry.py`（进程外壳与 stdio 纪律）、`server.py`（进程内 agent 的会话生命周期）、`gateway_server.py`（网关投影与回复分组）、`modes.py` + `permissions.py` + `edit_approval.py`（编辑审批的三层）、`events.py`（事件桥）。全部 22 个文件的清单在 `index.md`，此处不重复。

## 关键代码走读

### 进程外壳：三层启动保险 + 一个会话生命周期的所有权

```python
# acp_adapter/entry.py:197-226（节选）
    import acp
    from .server import HermesACPAgent

    # Windows: import the configured memory provider (and numpy) on the main thread before
    # the ACP stdin-reader thread starts. A first-time native-extension import racing another
    # thread's import chain deadlocked in create_module and session/new never answered (#58083).
    if sys.platform == "win32":
        _warm_memory_provider_import(logger)

    # MCP discovery and execution belong to the gateway daemon; this process is a viewer.
    agent = HermesACPAgent()

    async def serve():
        # MCP and execution belong to the daemon. Close only this viewer, while
        # its event loop is still alive, including on protocol/transport errors.
        try:
            await acp.run_agent(agent, use_unstable_protocol=True)
        finally:
            await agent.aclose()

    try:
        asyncio.run(serve())
    except KeyboardInterrupt:
        logger.info("Shutting down (KeyboardInterrupt)")
```

三个启动细节：Windows 主线程先预热 memory provider 的 import（#58083 的死锁修复）；`HermesACPAgent()` 构造旁的注释宣告了进程身份——「MCP 发现与执行属于网关守护进程；这个进程是一个查看者」；`serve()` 的 `finally` 只关*这个查看者*，且在事件循环还活着的时候关（协议/传输错误也一样）——**没有任何 ended_at 时间戳**：会话是 daemon 拥有的，可能还有别的查看者或排队的工作；owner 在最后一个查看者以空闲 FIFO 脱离时、或在网关停止时才结束 ACP 会话（`gateway/session_acp_lifecycle.py`，#118216）。这就是「查看者而非 owner」在进程生命周期上的具体形状。

### 进程内 server：历史恢复与压缩协作

`HermesACPAgent`（`server.py:273`）把 ACP 会话映射到 AIAgent：`session.py::SessionManager` 持有会话表，每个会话持久化进共享 `hermes_state.SessionDB`——重启后 `load_session`/`resume_session` 从 `state.db` 全量恢复历史，编辑器重连不丢上下文。压缩链是编辑器特有的难点：压缩轮换内部 head 时，编辑器握着的 session_id 必须保持稳定——`provenance.py` 从 `sessions` 表的 `parent_session_id`/`end_reason` 派生 `_meta.hermes` 出处（前/当前内部 id、谱系根），不新增任何持久状态。模型选择器（`model_catalog.py`）把 Hermes 库存 + 命名端点去重成 `provider:model` 行（每 provider 上限 `ACP_MAX_MODELS_PER_PROVIDER = 200`，客户端在一个下拉框里渲染全部 `availableModels`；当前模型经 fallback 插入永远保留）。

### 网关投影：回复分组与恰好一次终稿

```python
# acp_adapter/gateway_reply.py:1-4
"""How a gateway turn's reply reaches the editor: ``messageId`` grouping, exactly-once final text, tool and
permission bubbles closed as the in-process agent closed them. Mixed into ``GatewayACPAgent``, whose state
(``_conn``, ``_streamed``, ``_segments``, ``_tool_args``, ``_message_ids``, ``_cut``) it reads and updates."""
```

网关路径的难点不在请求（`prompt.submit` 直白），而在**流式回复的语义对齐**：网关的流式事件要折算成 ACP 的 `session_update`，`messageId` 把同一轮的片段分组，终稿文本恰好出现一次（流式增量 + 最终完整文本不能重复呈现），工具气泡与权限气泡的打开/关闭时机对齐进程内 agent 的行为——同一个编辑器客户端不应因后端是网关还是进程内 agent 而看到不同的 UI 生命周期。`gateway_media.py` 把编辑器发来的内容块转成 `prompt.submit` 文本 + 暂存图片附件（远程图片 URL 拉取失败不致命）；`gateway_session_meta.py` 的每个数字都来自 owner 的既有读数（`session.info` 快照、`session.stats`、`message.complete` 的 usage、或 `state.db`）——投影层自己不算账。

slash 命令在网关路径上各有归宿（`gateway_commands.py` docstring）：报告类是 owner 的 `slash.exec` 读数；`/model`、`/compress`、`/reset` 是保留的 `session.mutate` 控制；`/steer` 是 owner 的 `session.steer`；`/queue` 与空闲的 `/steer` 变成下一个 prompt（会话 FIFO 在在途 turn 之后执行）；`/title` 是 rename、`/undo`/`/retry` 是 rewind；其余注册命令原样送 `slash.exec`——**拒绝也要以「点名命令的回复」到达编辑器，绝不能变成一次失败的 prompt**。

### 编辑审批的三层

```python
# acp_adapter/permissions.py:9-12
"""ACP permission bridging for Hermes dangerous-command approvals."""
# ACP permission option id -> Hermes approval result. Ids are stable across the
# ``allow_permanent=True`` and ``False`` paths even though the option list differs.
```

第一层是 `permissions.py`：Hermes 的危险命令审批被翻译成 ACP 权限请求（`PermissionOption`/`AllowedOutcome`），选项 id 在「允许记住」与「只允许一次」两条路径上保持稳定（选项列表不同、id 语义不变）；`FutureTimeout` 与递增计数器处理「编辑器没人应答」的路径。第二层是 `edit_approval.py`：把编辑审批请求者绑进 ContextVar、只覆盖一次 ACP agent 运行——CLI/网关等会话不设它、自然绕过；**刻意不进通用工具注册表**，因为这不是工具行为而是会话行为。第三层是 `modes.py` 的模式表（见 `index.md`）：ACP 的三档编辑模式映射到 Hermes 审批政策，网关路径把政策写进 owner 的 `session.mutate edit_policy`、在编辑真正执行处强制——适配器只声明意图，不执行放行。

### 事件桥的细节

```python
# acp_adapter/events.py:9-11
Each factory returns a callable with the signature AIAgent expects for its
callbacks. AIAgent runs in a worker thread while the event loop lives on the
main thread, so updates are pushed via ``conn.session_update()`` scheduled
thread-safely onto the loop.
```

四个工厂（message/step/thinking/tool_progress）+ 两个助手：`AssistantMessageIdAllocator`（消息 id 分配——流式增量要挂同一个 id 下）、`flush_open_tool_calls`（流被截断时，把还开着的 tool-call 气泡按 ACP 语义闭合——否则编辑器留下永远转圈的气泡）。`_build_plan_update_from_todo_result` 是语义折算的样例：Hermes 的 todo 工具结果 → ACP 的 `AgentPlanUpdate`（`PlanEntry` 列表），让编辑器原生渲染任务清单。

## 核心类/函数

| 符号 | 位置 | 职责 |
|---|---|---|
| `main()` | `entry.py:163` | 启动顺序：bootstrap→恢复→日志→env→truststore→serve |
| `_warm_memory_provider_import()` | `entry.py:155` | Windows 死锁修复（#58083） |
| `aclose()`（agent 生命周期） | `entry.py:210-215` | 只关查看者，不碰 owner 会话 |
| `_session_response_fields` 等（进程内读数） | `server.py` | 会话元数据的进程内来源 |
| `SessionManager` | `session.py` | 会话表 + SessionDB 持久化 |
| `_expand_acp_enabled_toolsets()` | `session.py` | ACP 工具集展开 |
| `_translate_acp_cwd()` / `_normalize_cwd_for_compare()` | `session.py` | WSL 路径翻译 + cwd 归一比较 |
| `GatewayReplyMixin` | `gateway_reply.py` | messageId 分组 + 恰好一次终稿 |
| `GatewayACPAgent` RPC 面 | `gateway_server.py` | initialize/new/load/resume/prompt |
| `ROUTES` | `gateway_commands.py` | slash → 网关动词路由表 |
| `make_approval_callback()` | `permissions.py` | 审批桥（选项 id 稳定） |
| 审批请求者 ContextVar | `edit_approval.py` | 一次运行期的编辑审批 |
| `make_message_cb` / `make_step_cb` / `make_thinking_cb` / `make_tool_progress_cb` | `events.py` | 四类事件桥 |
| `AssistantMessageIdAllocator` / `flush_open_tool_calls` | `events.py` | id 分配 / 气泡闭合 |
| `_estimate_tokens()` | `commands.py` | /compress 的 token 估计 |
| `build_auth_methods()` | `auth.py` | 认证方法列表（含 `hermes-setup`） |
| `build_session_provenance` | `provenance.py` | 压缩链出处派生 |
| `clarify` 表单/权限卡 | `elicitation.py` | 能力分级的提问交互 |

## 本组文件清单（22 文件全清单）

| 文件 | 角色 | 关键符号 |
|---|---|---|
| `acp_adapter/entry.py` | 进程外壳（stdout 纪律） | `main`, `_load_env` |
| `acp_adapter/server.py` | 进程内 agent server | `HermesACPAgent` |
| `acp_adapter/gateway_server.py` | 网关投影 | `GatewayACPAgent` |
| `acp_adapter/gateway_commands.py` | slash → 网关动词 | `ROUTES` |
| `acp_adapter/gateway_reply.py` | 回复分组混入 | `GatewayReplyMixin` |
| `acp_adapter/gateway_media.py` | 内容 → submit + 附件 | `_fetch_remote_image` |
| `acp_adapter/gateway_session_meta.py` | 元数据投影 | `session.info` |
| `acp_adapter/session.py` | 会话管理 | `SessionManager` |
| `acp_adapter/modes.py` | 编辑模式表 | `MODES` |
| `acp_adapter/permissions.py` | 危险命令审批桥 | `make_approval_callback` |
| `acp_adapter/edit_approval.py` | 编辑审批 ContextVar | 预执行请求者 |
| `acp_adapter/events.py` | 事件桥 | `make_*_cb` |
| `acp_adapter/content.py` | 内容块翻译 | `_extract_text` |
| `acp_adapter/tools.py` | 工具调用映射 | `coerce_tool_args` |
| `acp_adapter/commands.py` | 无头 slash | `SlashCommandsMixin` |
| `acp_adapter/model_catalog.py` | 模型选择器 | `build_model_state` |
| `acp_adapter/auth.py` | 认证通告 | `detect_provider` |
| `acp_adapter/catalog.py` | 只读历史目录 | `read_catalog_rows` |
| `acp_adapter/provenance.py` | 压缩链出处 | `_meta.hermes` |
| `acp_adapter/elicitation.py` | clarify 交互 | `ELICITATION_METHOD` |
| `acp_adapter/__main__.py` | `python -m acp_adapter` | `entry.main` |
| `acp_adapter/__init__.py` | 包标记 | — |

## 与其他模块的关系

- **01_architecture（执行所有权）**：「查看者而非 owner」是 `big_picture.md` 所有权模型在编辑器表面上的投影——网关投影永不构建执行 owner，MCP/执行/会话生命周期全归 daemon。
- **hermes_cli/gateway_client.py**：`GatewayACPAgent` 的全部 RPC 面；`GatewayClientError`/`GatewayRPCError` 是拒绝语义的载体。
- **gateway/session_local_editor.py**：`edit_policy` 的真正执行点——适配器声明、编辑器放行、owner 强制。
- **agent/（AIAgent + 压缩链）**：进程内路径的执行体与 provenance 的数据源。
- **hermes_state.SessionDB**：会话持久化与历史目录的存储层。

## 总结

协议接入的深读可以收拢成三个「恰好」：**恰好一个 owner**（进程内或网关二选一，投影层永不越位）；**恰好一次终稿**（流式增量与最终文本的分组、去重、气泡闭合全部对齐进程内 agent 的行为）；**恰好一次询问**（编辑审批的 ContextVar 只覆盖一次运行、选项 id 稳定、敏感路径的下限不可协商）。ACP 的 schema 类型（`acp.schema`）保证了协议面的形状稳定，而 Hermes 的语义（审批、压缩、会话所有权）通过这三条「恰好」无损地穿过协议边界。
