# 08 tui_gateway/ —— TUI、桌面端与仪表盘共用的 JSON-RPC 后端总览

`tui_gateway/`（103 个顶层文件 + `contracts/` 25 个契约文件）是 Hermes 的**终端 UI 后端**：一个把 agent 能力暴露成 JSON-RPC 方法的 Python 进程。它同时是三个消费者的后端——`hermes --tui` 的 Ink 终端界面、Electron 桌面应用（`apps/desktop/`）、以及仪表盘内嵌的 `/chat`（`web/` + `ui-tui` 经 PTY 复用）。改这里的一行代码，三个界面同时受影响；这正是 `tui_gateway/AGENTS.md` 开篇的第一句话。

这个模块是「瘦腰架构」在 UI 侧的体现：**Python 拥有行为（会话、工具、模型调用、slash 逻辑），TypeScript 拥有屏幕（转写渲染、输入框、提示卡片）**。把任何 agent 行为搬进渲染器都是违反设计方向的——渲染器只是一个会画 JSON-RPC 事件的客户端。

## 进程模型：一个 ASCII 说清全部

```
hermes --tui
  └─ Node (Ink)  ──WebSocket /api/ws, 子协议 hermes-gateway-v1──▶  该 profile 的共享网关 owner
       │  (URL + 一次性票据：                                        ├─ 会话权威：sessions、AIAgent、工具
       │   ui-tui/scripts/gateway_bootstrap.py)                     └─ tui_gateway handlers（非会话方法）
       └─ 渲染转写、输入框、提示、活动流
```

三个关键事实：

- **Ink 从不 spawn 私有 agent**。`ui-tui/scripts/gateway_bootstrap.py` 是 `hermes_cli/gateway_runtime_attach.py::attach_gateway` 的薄包装——与任何本地客户端跑的 `hermes gateway attach --json` 完全同一条路。它按需拉起该 profile 的**共享**网关 owner（`hermes gateway run`，空闲自动退出），拿到 URL + 一次性票据后经 WebSocket 附加过去。唯一拨向别处 URL 的是仪表盘 `/chat`（`HERMES_TUI_GATEWAY_URL`），它从 listener 的 ready 帧协商 wire。
- **stdio 通道仍在**。`tui_gateway/entry.py` 是老的 stdio JSON-RPC 入口（换行分隔 JSON-RPC over stdin/stdout），如今只供开发 harness（如 `apps/desktop/e2e/real-session-builder.ts`）使用——产品面全部走 WS 附加；`entry.py::main` 甚至会因 `gateway.lock` 被占而拒绝启动。
- **desktop 不另起后端**。桌面应用经 `apps/shared` 的 `JsonRpcGatewayClient`（`onRequest`）连同一个服务器；仪表盘把真实 TUI 嵌进 PTY（`web/AGENTS.md`），再开一条 back-WS 把事件镜像到侧边栏（`event_publisher.py`）。

## 传输层一句话

Wire 是**换行分隔的 JSON-RPC 帧**，对等（peer-to-peer）双向：

| 方向 | 形态 | 例子 |
|------|------|------|
| client→server | 方法调用 | `prompt.submit`、`session.list`、`slash.exec` |
| server→client | **请求**（agent 问用户，要应答） | `approval`、`clarify`、`sudo`、`secret`、`vault.*`、`connection` |
| server→client | `event` 通知（单向广播） | `message.delta`、`tool.start`、`request.cancel` |

server→client 请求是这套协议最独特的部分：agent 线程在 `server_requests.py::send()` 上**阻塞等待**，直到应答帧带着同一个 `srq-<n>` id 回来。客户端在连接建立时声明 `client.capabilities {server_requests: true}`；从不声明的旧版客户端会被快速失败而不是让 agent 干等超时。

## 方法面与契约面

- 方法实现按主题拆进 34 个 `methods_*.py` 兄弟模块（`methods_session`、`methods_config`、`methods_browser`、`methods_bot_relay`……），经 `method_ctx.HandlerRegistry` 重绑定到 `server.py` 的命名空间——没有 `if method == ...` 链。
- **Wire 在 Python 里声明，为 TypeScript 生成**：`tui_gateway/contracts/`（25 个文件）给每个方法、每个 server→client 请求、每个事件各一个 Pydantic 模型；`scripts/gen_gateway_contracts.py` 渲染出 `apps/shared/src/gateway-contract.generated.ts` 与 OpenRPC JSON，陈旧性测试让 CI 失败。
- `hermes-gateway-v1` 规范传输另有独立的 `CANONICAL_METHODS` 目录（`contracts/canonical*.py`），由 `gateway/session_controls.py::AuthorityConnection` 服务。

## 关键界面速查（Ink 组件 ↔ 网关方法/事件）

| 界面 | Ink 组件 | 网关方法 / 事件 |
|------|---------|----------------|
| 聊天流式 | `app.tsx` + `messageLine.tsx` | `prompt.submit` → `message.delta` / `message.complete` |
| 工具活动 | `thinking.tsx` | `tool.start` / `tool.generating` / `tool.complete` |
| 审批 | `prompts.tsx` | server→client 请求 `approval` → 应答 `{choice}` |
| clarify / sudo / secret | `prompts.tsx`, `maskedPrompt.tsx` | server→client 请求 `clarify` / `sudo` / `secret` |
| 会话选择器 | `sessionPicker.tsx` | `session.list` / `session.resume` |
| slash 命令 | 本地处理 + 兜底 | `slash.exec` → `_SlashWorker`；`command.dispatch` |
| 补全 | `useCompletion` hook | `complete.slash` / `complete.path` |
| 主题 | `theme.ts` + `branding.tsx` | `gateway.ready` 携带 skin 数据 |
| 连接操作卡（desktop） | desktop `store/connection-request.ts` | `connection.request` → `connection.update`* → `connection.respond {op_id}` |

## 多 profile：一个进程服务多个家

一个 `serve` 进程可能同时承载多个 profile 家的会话（Desktop 池化后端、仪表盘）。第一个非启动 profile 家注册时，`launch_profile_policy.py` 冻结启动环境并把 `get_secret` 翻成 fail-closed；每个读写家/配置/.env 派生状态的方法都必须挂在 `server.py::@_profile_scoped` 装饰器下——只设 `get_hermes_home_override()` 是"半绑定"，凭据和 `TERMINAL_*` 策略仍会泄漏启动 profile 的值。详见本组 `process_model.md`。

## 三个消费者，一条后端

| 维度 | Ink 终端（`hermes --tui`） | Desktop 应用 | 仪表盘 `/chat` |
|------|---------------------------|--------------|----------------|
| 渲染器 | Node + Ink（`ui-tui/`） | Electron + React（`apps/desktop/`） | 嵌入真实 TUI 经 PTY |
| 连接方式 | `gateway_bootstrap.py` 附加（WS，协议 `hermes-gateway-v1`） | `apps/shared::JsonRpcGatewayClient`（WS） | `HERMES_TUI_GATEWAY_URL` 拨别处 URL |
| 附加通道 | `attach_gateway`（URL + 一次性票据） | 同一 `attach_gateway` | listener ready 帧协商 |
| 额外面 | stdio（开发 harness） | server→client 桥：`preview.read/act`、`terminal.read`、`window.read`、`tour` | back-WS 事件镜像（`event_publisher.py`） |
| 代码归属 | TypeScript 画屏幕 | TypeScript 画屏幕 | Python 画转写，TS 嵌壳 |

"TypeScript 拥有屏幕"的边界在 Desktop 上最容易被误判：desktop 插件的 `plugin.js` 有 App 全部权限，但目录准入（规则 8）把它锁死在 SDK 表面——同样的隔离哲学，UI 侧的投影。

## 一次 prompt.submit 的完整旅程

把前面的抽象串成时间线，是理解三个消费者共用后端的最快方式：

```
用户在 Ink 输入框敲下回车
  → Node 渲染器本地处理内置命令（/help、/quit、/clear、/resume…）
  → 其余走 slash.exec 或直接 prompt.submit（JSON-RPC 方法调用帧）
  → WebSocket /api/ws → ws.py 读循环排队 → rpc_dispatch.dispatch
  → 契约校验（未知参数键 4000）→ handler（methods_prompt.py）
  → 延迟 agent 构建等待（session_registry._wait_agent_for_prompt）
  → prompt_turn._run_prompt_submit：admit → 绑作用域 → run_conversation（独立线程）
  → 流式期间：message.delta / tool.start … 事件帧（经 write_json 路由到会话 transport）
  → 需要用户决定时：server_requests.send("approval") 阻塞 agent 线程 → 客户端弹卡
  → 应答帧带 srq-<id> 回来 → resolve_response 结算 → turn 继续
  → message.complete → history 提交 → 目标/循环钩子 → 排队续跑
```

三个消费者差异只在两端：Ink 从 stdio/WS 读帧、画成终端组件；Desktop 经 `apps/shared` 的 `JsonRpcGatewayClient` 画成 React 卡片；仪表盘 `/chat` 干脆把真实 TUI 嵌进 PTY、再用 back-WS 镜像事件到侧边栏。**中间的 Python 后端完全同一条路。**

## server.py 的骨架：门面里住着什么

`server.py`（2041 行）作为门面，值得记住它顶部的几个全局（`server.py:102-122`）：

- `_sessions`（会话表）与 `_sessions_lock`（可重入——关闭路径可能在已持锁的调用者下运行）。
- `_methods`（方法表）：唯一的注册 seam 是 `register_method`/`@method` + 分身模块的 `HandlerRegistry.install`。
- `_idempotency_keys`：`session.create` 的幂等注册表——重试的 create（应答丢失在途）返回同一会话而不是拉起重复子进程，条目随会话过期（TTL 300s）。
- `_SLASH_WORKER_TIMEOUT_S`：slash worker 问答的默认 45s 上限。
- panic 钩子（`:86-93`）：把每个未捕获异常写进 `logs/tui_gateway_crash.log`——stdout 是 JSON-RPC 管道、stderr 在退出前可能不刷，崩溃不留 forensics 就无从排查。

门面之外的 34 个兄弟模块经 `method_ctx.bind_module` 重绑定（详见 methods_slash.md），所以 `tests/tui_gateway/` 里的 monkey-patch 目标始终是 `tui_gateway.server` 的名字。

## 新方法 / 新事件 / 新问题的落地清单

开发者的三个高频动作，各自的最小完整改动集：

| 动作 | Python 侧 | TS 侧 | 守卫 |
|------|-----------|-------|------|
| 新 RPC 方法 | 契约 `method(...)` + handler（新 `methods_<topic>.py` 或现有兄弟的条目，注册进表——绝不 if 链） | 生成契约后 `tsc` 显示消费者 | `test_generated.py` 陈旧即 CI 失败 |
| 新事件 | `contracts/events.py` 里 `event("<type>", Payload)`；发射器被 `check_payload` 盯住 | `gateway-events.ts` 只加客户端本地合成事件 | STRICT 下发射漂移抛 `ContractViolation` |
| 新 server→client 问题 | 发射器 `_ask("<method>", sid, params, timeout)`；契约 `server_request(...)` | `apps/desktop/.../server-requests.ts` + `ui-tui/src/app/createServerRequestHandler.ts` 两个 handler | `assert_complete` 拒孤儿契约 |

规范传输（`hermes-gateway-v1`）另有 `canonical_method(...)` / `canonical_namespace(...)` 一条平行轨道（contracts.md），由 `gateway/session_controls.py::AuthorityConnection` 服务。

## 本组文档导航

| 文档 | 内容 | 核心文件 |
|------|------|---------|
| `index.md`（本篇） | 三消费者、进程模型、导航 | — |
| `process_model.md` | 附加而非私有 spawn、空闲退出、compute-host 隔离、多 profile 作用域 | `server.py`、`host_supervisor.py`、`compute_host.py`、`launch_profile_policy.py` |
| `rpc_transport.md` | 帧格式、三类帧、server→client 请求、Transport 家族、worker 池分发 | `ws.py`、`entry.py`、`transport.py`、`server_requests.py`、`rpc_dispatch.py` |
| `contracts.md` | 契约即文档：Pydantic 三表、代码生成、canonical 方法目录 | `contracts/registry.py`、`contracts/base.py`、`contracts/canonical.py`、`scripts/gen_gateway_contracts.py` |
| `methods_slash.md` | 34 个方法模块导览 + slash worker、事件发布/重放、会话生命周期深读 | `methods_*.py`、`slash_worker*.py`、`event_*.py`、`session_*.py` |

> 阅读顺序建议：先 `process_model.md` 弄清"谁是谁的进程"，再 `rpc_transport.md` 建立 wire 直觉；`contracts.md` 是改协议前必读；`methods_slash.md` 是日常开发的目录册。

## 与其他模块的关系

- **上游**：`agent/`（AIAgent、turn 循环）、`hermes_state.py`（SessionDB）、`tools/`（工具编排）——网关方法在 handler 里调用它们。
- **同层**：`gateway/` 的 `session_controls.py` / `session_discovery.py` / `session_commands.py` 提供 canonical 会话权威面；`tui_gateway` 的 sidecar 方法在票务 socket 上作为受限 fallback 与之共存（`ws_legacy_fallback.py`：会话动词归权威，其余 sidecar 方法需要完整交互授权）。
- **下游（TypeScript）**：`ui-tui/`（Ink 渲染器）、`apps/desktop/`（Electron）、`apps/shared/`（共享 TS 客户端与生成契约）、`web/`（仪表盘 `/chat`）。
- **宿主**：`hermes_cli/gateway_runtime*.py` 负责 owner 的发现/拉起/票据；`gateway/runtime_ownership.py` 的 `gateway.lock` 是唯一的 owner 仲裁。

## 常见踩坑速查

先给一张小术语表，后面每篇都会用到：

| 术语 | 含义 |
|------|------|
| owner | 某个 profile 的共享网关进程（`hermes gateway run`），会话权威与 sidecar 方法都在其中 |
| 票据（ticket） | 附加时铸造的一次性凭据；可附加上去，不可转发，绝不出现在日志或 repr 里 |
| sidecar 方法 | `server._methods` 注册的 RPC 面（本组的 34 个 methods_*.py），区别于权威的 canonical 方法 |
| canonical 方法 | `hermes-gateway-v1` 的权威动词目录（`contracts/canonical*.py`），仅 `AuthorityConnection` 服务 |
| `srq-<n>` | server→client 请求的 id 前缀；应答帧带同一 id 才算结算 |
| 重放环 | per-session 的有界事件缓冲，`session.events.since` 从中续传 |
| fanout | 多订阅者的有界信箱 transport；慢订阅者被摘除而非拖累全队 |
| compute-host | `dashboard.turn_isolation` 下承载 agent turn 的持久子进程 |
| multiplex | 一个进程承载多个 profile 家；激活后凭据读取 fail-closed |


| 症状 | 根因 | 指向 |
|------|------|------|
| 客户端调用成功但字段丢失 | 客户端拼错/旧字段名被静默忽略 | 契约 `extra="forbid"` 会让它变 `4000`（contracts.md） |
| `config.set` 写进了错误的 profile 配置 | handler 只设了 home override，没挂 `@_profile_scoped` | process_model.md §3；`rg` 排查命令 |
| agent 干等 300 秒没人应答 | 客户端从未声明 `client.capabilities {server_requests: true}` | rpc_transport.md §3（快速失败护栏） |
| 浏览器刷新泄漏一个 python 进程 | 孤儿 WS 会话的 slash worker（#38591 修复后有 20s 宽限收割） | server.py `_resolve_ws_orphan_reap_grace` |
| 重连后弹卡消失但问题还在 | 未应答的 server→client 请求经 `open_requests` 重放 | rpc_transport.md §3 重连段 |
| 流式文本卡顿成"手风琴" | token 帧未经 `message.delta` 合并车道 | ws.py `_STREAMING_EVENT_TYPES` + 33ms 缓冲 |
