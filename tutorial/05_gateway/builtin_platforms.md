# builtin_platforms.md —— 三个内置 HTTP 平台：webhook、msgraph、api_server

## 文件概览

`gateway/platforms/` 里除了适配器框架，还直接住着 3 个**不依赖外部 SDK** 的内置平台适配器——它们都是 HTTP 服务器型适配器（aiohttp），所以天然属于框架目录而非插件目录：

1. **webhook**（`webhook.py` + 5 个兄弟文件）：通用的 HMAC 签名 webhook 入站（GitHub、GitLab、Svix、Linear、任意自定义），把载荷渲染成 agent prompt，回复路由回 github_comment 或任何网关平台。
2. **msgraph**（`msgraph_webhook.py`）：Microsoft Graph 变更通知（Teams/Outlook）入站。
3. **api_server**（`api_server.py` + 17 个兄弟文件）：OpenAI 兼容 API 服务器——`/v1/chat/completions`、`/v1/responses`、`/v1/runs` 等，任何 OpenAI 前端指到 `http://localhost:8642/v1` 配 `API_SERVER_KEY` 即可接入；多路复用下次要 profile 住 `/p/<profile>/...`。

三者共用 `tcp_site.py` 的端口绑定设施与 `shared_ingress.py` 的共享监听器，并都把 `serves_profile_prefix` 声明为 True。

## 关键代码走读

### 1. webhook：HMAC 校验、合并、过滤、投递

模块 docstring 就是配置面全景：

```python
# 来源：gateway/platforms/webhook.py:1-9（节选）
"""Generic webhook platform adapter: aiohttp server that validates HMAC-signed POSTs (GitHub, GitLab,
Svix, Linear, generic), renders payloads into agent prompts, and routes responses back (github_comment
or any gateway platform). Routes live under platforms.webhook.extra.routes: events (header filter),
secret (REQUIRED; "INSECURE_NO_AUTH" skips validation, loopback only), prompt template, skills,
deliver/deliver_extra, deliver_only (rendered prompt IS the message), cron_job (...), mirror_to_session
(opt-in: a delivered response is also written into the target chat's transcript so follow-ups there have
context). Per-route rate limiting, idempotency cache, body-size caps checked before reading. Generic
HMAC V2 binds a timestamp for replay protection; body-only V1 is deprecated but accepted with a warning."""
```

安全要点：每条 route **必须**配 secret（`INSECURE_NO_AUTH` 只允许 loopback 且显式点名）；V2 HMAC 绑定时间戳防重放，仅对 body 的 V1 已弃用但仍收（带警告）；body 大小上限在**读取之前**检查。事件去重靠幂等缓存，但「同一逻辑实体的快速连续事件」各有新 delivery id、幂等拦不住——于是有 opt-in 的合并器：

```python
# 来源：gateway/platforms/webhook_coalesce.py:1-11（节选）
"""Per-route event coalescing for the webhook adapter (opt-in ``coalesce`` route block).

Rapid distinct events on one logical entity (five pushes to a PR, a burst of ticket edits) each
carry a fresh delivery ID, so idempotency cannot suppress them and every event wakes an agent
run. Coalescing groups events by a payload-derived key and debounces them: only the LATEST event
of a group is dispatched once the quiet window passes, bounded by ``max_wait_seconds`` past the
group's first event so a steady stream cannot starve dispatch (one durable run per entity, stale
heads superseded). #92066"""

DEFAULT_WINDOW_SECONDS = 30.0
DEFAULT_MAX_WAIT_SECONDS = 300.0
```

兄弟文件分工：`webhook_filters.py` 做 route 级过滤与脚本变换（受 `DEFAULT_SCRIPT_TIMEOUT_SECONDS` 约束的子进程）；`webhook_ingress.py` 只发**收据**——执行权归 SessionAuthority 而非 HTTP 任务；`webhook_delivery.py` 的立场写在第一行：「validated webhook destinations live in the owner's admitted input, not a TTL cache」——投递目的地随 owner 的已接纳输入持久化，并对 route 配置做 sha256 digest，配置变了目的地就作废（防陈旧投递）；`webhook_mcp_events.py` 处理 MCP 事件控制。

### 2. msgraph：Graph 变更通知

```python
# 来源：gateway/platforms/msgraph_webhook.py:1-3、27-31（节选）
"""Microsoft Graph webhook adapter for change-notification ingress."""
...
# ``None`` → aiohttp binds one socket per address family (IPv4 + IPv6); the old "0.0.0.0" default was
# unreachable over IPv6-only private networks. Pin a host via extra.host. The all-interfaces default
# still requires extra.allowed_source_cidrs (see _source_allowlist_required_but_missing).
DEFAULT_HOST = None
DEFAULT_PORT = 8646
DEFAULT_WEBHOOK_PATH = "/msgraph/webhook"
DEFAULT_MAX_SEEN_RECEIPTS = 5000
DEFAULT_MAX_BODY_BYTES = 1_048_576
```

Graph 的订阅模型用「变更通知 + 客户端拉取」：适配器收 subscription webhook（HMAC/sha1 校验订阅密钥）、去重 receipt（上限 5000），再以 Graph API 拉取内容、渲染成 prompt。网络安全上，绑全接口时**强制**要求 `allowed_source_cidrs` 源地址允许名单。Teams/Outlook 侧的会话管线运行时由 `run.py::_wire_teams_pipeline_runtime` 绑定（见 run.md）。

### 3. api_server：OpenAI 兼容门面

```python
# 来源：gateway/platforms/api_server.py:1-6
"""OpenAI-compatible API server platform adapter (aiohttp).

Serves /v1/chat/completions, /v1/responses, /v1/models, /v1/capabilities, /api/sessions,
/v1/runs, /api/jobs and /health* (full table: ``APIServerAdapter._http_route_table``); any
OpenAI-compatible frontend connects at http://localhost:8642/v1 with API_SERVER_KEY. Under
``gateway.multiplex_profiles`` secondary profiles live at ``/p/<profile>/...``."""
```

`/v1/capabilities` 是一张静态特性表（`_STATIC_FEATURE_FLAGS` + `_CAPABILITY_ENDPOINTS`，api_server.py:44-70）：run_status/run_steer/session_chat_streaming 等按 listener 能力有条件广告，客户端据此降级。路由面三块值得展开：

- **`/v1/runs`（durable run）**：`api_server_runs.py` 提供持久化的 run 准入/状态/事件/控制；run 有 idempotency（`api_server_run_idempotency.py`）、有审批与 steer 端点，执行也复用 `turn_executor._UnboundedThreadExecutor`（runs 文件 import 了它）。
- **`previous_response_id` 链**：`api_server_response_store.py` 是 SQLite 底座（「SQLite-backed store for Responses API state (`previous_response_id` chaining, named conversations)」，每 body 槽位存终态封套，`MAX_STORED_RESPONSES = 100`，损坏的 body 读作缺失而不抛）。链的关键在 `api_server_turn_boundary.py`：`AIAgent.run_conversation` 返回的是**全量转录**（客户端历史 + 本 turn），要用「逐条消息说了什么」的前缀比对（`_same_transcript_prefix`）找到本 turn 的起点，才能切出 Responses `output` items 与存储的历史。
- **bot_chat（Bot Chat 对等 turn）**：`api_server_bot_chat.py` 的 docstring 是 Profile scope 的又一课——`hermes peer dm` / `hermes peer run` 指向 profile 的 Bot Chat，它在会话权威下是 LOCAL 会话，唯一写者是权威 FIFO；API 边缘与 `bot_relay.deliver` 走**同一扇门**接纳 turn，从收据读回复；把会话绑成 API conversation 会造成第二写者，被 `permission_denied` 拒绝。

api_server 还有一个独特行为：**每请求重建 agent，但不重建 memory provider**。

```python
# 来源：gateway/platforms/api_server_memory_sessions.py:1-11（节选）
"""Memory-provider continuity across api_server requests (#120116).

The api_server adapter builds a fresh ``AIAgent`` per request (per-request callbacks, model
route, ephemeral prompt), unlike the messaging platforms, whose cached agent — and with it the
memory provider — lives for the whole session. External providers deliver recall as the
PREVIOUS turn's background prefetch held on the provider instance, so a provider that is
re-initialised per request never has anything to inject ... This registry keeps one initialised
``MemoryManager`` per (profile home, session id): a request checks the session's manager out
before building its agent ... and checks it back in when the turn ends. Check-out is exclusive,
so two concurrent requests on one session never share a manager; ... Idle entries and LRU
overflow are shut down under the owning profile's scope, like the gateway agent cache's eviction."""
```

这就是 gateway/AGENTS.md 里 `api_server` 一节的机制：MemoryManager 按 (profile home, session id) 停泊、独占借出、turn 结束归还，空闲/LRU 驱逐在 owning home 的作用域下关闭——否则上一 turn 排队的 recall 永远到不了下一请求（#120116）。

## 核心类/函数

| 符号 | 位置 | 职责 |
|------|------|------|
| `WebhookAdapter` | platforms/webhook.py | HMAC 路由表、幂等缓存、限流、回复投递 |
| `WebhookCoalescer` | platforms/webhook_coalesce.py | 按载荷 key 分组去抖；30s 窗口、300s 最长等待 |
| `route_digest()` | platforms/webhook_delivery.py | 投递目的地的 route 配置摘要（防陈旧投递） |
| `producer_scope()` | platforms/webhook_ingress.py | 收据式接入：执行权归权威 |
| `MsGraphWebhookAdapter` | platforms/msgraph_webhook.py | Graph 订阅通知、receipt 去重、源 CIDR 门 |
| `APIServerAdapter` | platforms/api_server.py | OpenAI 兼容路由表、`/p/<profile>/` 前缀中间件、capabilities 表 |
| `ResponseStore` | platforms/api_server_response_store.py | `previous_response_id` 链与命名会话的 SQLite 存储 |
| `_same_transcript_prefix()` | platforms/api_server_turn_boundary.py | 按消息内容比对切出当前 turn 边界 |
| `admit_*`（runs） | platforms/api_server_runs.py | /v1/runs 持久准入、事件、审批、steer |
| `MemoryManagerRegistry` | platforms/api_server_memory_sessions.py | 每 (profile home, session id) 独占借出 MemoryManager |

## 本组文件清单

### A. webhook 平台（6 文件）

| 文件 | 角色 |
|------|------|
| `webhook.py` | 通用 HMAC webhook 适配器（routes 配置、幂等、限流） |
| `webhook_coalesce.py` | opt-in 事件合并去抖（#92066） |
| `webhook_delivery.py` | 投递目的地校验（admitted input，非 TTL cache） |
| `webhook_filters.py` | route 级过滤与脚本变换 |
| `webhook_ingress.py` | 收据式接入（权威拥有执行） |
| `webhook_mcp_events.py` | MCP 事件控制与 prompt 渲染 |

### B. msgraph 平台（1 文件）

| 文件 | 角色 |
|------|------|
| `msgraph_webhook.py` | Graph 变更通知入站（sha1 订阅校验、CIDR 门、receipt 去重） |

### C. api_server 平台（18 文件）

| 文件 | 角色 |
|------|------|
| `api_server.py` | 适配器主体：路由表、中间件、capabilities、profile 前缀 |
| `api_server_openai_routes.py` | /v1/chat/completions、/v1/responses 等路由实现 |
| `api_server_runs.py` | /v1/runs 持久准入、状态、事件、控制 |
| `api_server_run_idempotency.py` | run 幂等键 |
| `api_server_authority_runs.py` | 权威侧 run 编排 |
| `api_server_response_store.py` | previous_response_id 链的 SQLite 存储 |
| `api_server_response_admissions.py` | response 准入 |
| `api_server_response_identity.py` | response 身份（Idempotency-Key 保留等） |
| `api_server_turn_boundary.py` | 全量转录中当前 turn 的边界切分 |
| `api_server_request_options.py` | 请求级选项 |
| `api_server_profile_prefix.py` | `/p/<profile>/` 前缀解析（fail-closed） |
| `api_server_bot_chat.py` | Bot Chat 对等 turn（走权威 FIFO 同一扇门） |
| `api_server_room_dispatch.py` | RoomLink 分发校验与隐藏成员会话所有权 |
| `api_server_room_grants.py` | room 授权（JSON 错误约定） |
| `api_server_memory_sessions.py` | MemoryManager 停泊/独占借出（#120116） |
| `api_server_config_guard.py` | 配置守卫（admin 面） |
| `api_server_fire_startup.py` | 启动触发 |
| `api_server_store.py` | API 服务器存储底座 |

### D. 共享设施（框架篇已列，此处按使用关系复列）

| 文件 | 角色 |
|------|------|
| `tcp_site.py` | 三个 HTTP 平台共用的端口绑定辅助 |
| `shared_ingress.py` | 多路复用次 profile 共享默认监听器 |
| `_http_client_limits.py` | 出站 HTTP 上限 |

## 与其他模块的关系

- webhook/msgraph 的入站在**收据层**就交给 SessionAuthority（`webhook_ingress.py`），与 `message_flow.md` 第 3 步的 durable FIFO 同源；投递经 `delivery.py` 路由到任何网关平台。
- api_server 的 runs 复用 `turn_executor._UnboundedThreadExecutor`（`turn_machinery.md`）与权威 turn 门（`sessions_authority.md`）；`wake.py` 对无状态 api_server 的会话恢复走自 POST `/v1/chat/completions`（见 `streaming.md` 唤醒小节）。
- `serves_profile_prefix = True` 让三者都受 `shared_ingress.py` 的多路复用前缀规则约束；profile 前缀解析 fail-closed（`_prefix_names_served_profile`）。

## 总结

三个内置平台展示了适配器框架的另一面：不是「聊天 bot」，而是「HTTP 进、HTTP 出」的机器集成面。webhook 把任意签名事件变成一次 agent 运行，用合并器解决幂等拦不住的连发；msgraph 适配 Graph 的订阅拉取模型；api_server 则把整个 agent 变成一个 OpenAI 兼容服务——包括 run 生命周期、审批、steer 和 `previous_response_id` 会话链。它们共同演示了两个教训：**执行权永远归会话权威**（HTTP 任务只拿收据），以及**每请求重建 agent 时，跨请求的状态（MemoryManager、response 链）必须显式停泊与续接**。
