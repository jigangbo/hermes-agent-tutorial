# Web 路由与仪表盘认证

## 文件概览

- **`web_routers/`（37 文件）**：从 `web_server.py` 抽出的 FastAPI `APIRouter` 模块，由 `web_server.py` 挂载；helper 经 `web_deps.py` 的 late-binding seam 回到属主模块（cycle-safe，且测试对 `web_server.<name>` 的 monkeypatch 在调用时依然生效）；
- **`dashboard_auth/`（18 文件）**：仪表盘认证中间件栈——auth gate 只在受控模式下启用，provider 框架 + middleware + WS 票据。

## 关键代码走读

### chat_ws.py：聊天页 WebSocket 路由

```python
# hermes_cli/web_routers/chat_ws.py:1-9
"""Chat-tab WebSocket routes: /api/console, /api/pty, the /api/ws gateway
sidecar and /api/pub + /api/events broadcast.

Helpers/state that tests monkeypatch on ``web_server`` stay there and are
reached through the late-binding seam (cycle-safe).
"""

from fastapi import APIRouter, FastAPI, HTTPException, WebSocket, WebSocketDisconnect
```

路由族一览（chat_ws.py 顶部即可读到）：`/api/console`（浏览器内终端执行）、`/api/pty`（PTY 桥）、`/api/ws`（网关 sidecar socket）、`/api/pub` + `/api/events`（广播通道）。late-binding 的样子：

```python
# hermes_cli/web_routers/chat_ws.py:30-37
# Late-bound so a test's monkeypatch on the owning module wins at call time.
_active_session_file_for_channel = late("_active_session_file_for_channel", "hermes_cli.web_server_chat")
_profile_scope = late("_profile_scope", "hermes_cli.web_server_profiles")
_resolve_chat_argv_async = late("_resolve_chat_argv_async", "hermes_cli.web_server_chat")
_resolve_profile_dir = late("_resolve_profile_dir", "hermes_cli.web_server_profiles")
_DASHBOARD_EMBEDDED_CHAT_ENABLED = LateState("_DASHBOARD_EMBEDDED_CHAT_ENABLED")
```

事件通道状态从 `app.state` 惰性取（TestClient 没跑 lifespan 时兜底），且 Lock 必须在正确的事件循环上创建——注释明确写了这一点（chat_ws.py:39-44）。

### ws_tickets.py：WS 升级凭据

```python
# hermes_cli/dashboard_auth/ws_tickets.py:1-10
"""WS-upgrade auth credentials for gated mode.

Browsers cannot set ``Authorization`` on a WebSocket upgrade, and gated mode has no token
injected into the SPA, so two credential shapes exist: (1) single-use browser tickets
(``mint_ticket`` / ``consume_ticket``) fetched via authenticated ``POST /api/auth/ws-ticket``
and passed as ``?ticket=`` on the upgrade — 30 s TTL, a leak is uninteresting; (2) a
process-lifetime internal credential (...) for *server-spawned* WS clients ...
"""
```

两种凭据形状解决同一个物理限制——浏览器不能在 WS upgrade 上带 `Authorization` 头：

1. **浏览器票据**：`mint_ticket()` 签发 32 字节 base64url 一次性票据，30 秒 TTL（`TTL_SECONDS = 30`），`consume_ticket()` 消费即焚；
2. **进程内凭据**：`internal_ws_credential` 给服务器自己拉起的 WS 子进程（内嵌 TUI 的 PTY child），进程寿命、多次使用、永不进 HTML/SPA——只通过子进程环境变量离开本进程，XSS 读不到，权限也不比票据多。

```python
# hermes_cli/dashboard_auth/ws_tickets.py:23-26
#: Long enough for ``getWsTicket()`` -> open WS, short enough that a leaked ticket is uninteresting.
TTL_SECONDS = 30

_lock = threading.Lock()
_tickets: dict[str, tuple[int, dict[str, Any]]] = {}  # ticket -> (expires_at, info)
```

纯内存、`time.time` 可打补丁——这是测试友好的刻意设计。

### 认证中间件栈

`middleware.py` 是 auth gate 中间件；`public_paths.py` 是**两个 gate 共用**的 `/api/*` 白名单（import 注释强调 BOTH gates——改白名单要同时想两处）；`token_auth.py` 提供路线无关的 bearer-token seam；`body_limit.py` 在 FastAPI 组装 JSON 之前掐掉公共认证端点的超大请求体。

## 核心类/函数

| 符号 | 文件:行号 | 职责 |
|---|---|---|
| `router`（APIRouter） | web_routers/chat_ws.py:28 | 聊天页 WS 路由挂载点 |
| `late(name, module)` / `LateState` | web_deps.py | late-binding seam（测试补丁优先） |
| `_get_event_state(app)` | web_routers/chat_ws.py:39 | 事件通道 + 锁的惰性获取 |
| `mint_ticket()` | dashboard_auth/ws_tickets.py:34 | 一次性浏览器票据（30s TTL） |
| `consume_ticket()` | dashboard_auth/ws_tickets.py | 消费票据，返回绑定 info |
| `internal_ws_credential()` | dashboard_auth/ws_tickets.py | 服务器自用进程寿命凭据 |
| `register_provider()` | dashboard_auth/registry.py | 插件注册 DashboardAuthProvider |
| `SurfacePolicy` | web_server_surface.py:20 | 各启动面能做什么（另见 web_server.md） |

## 本组文件清单

### web_routers/（37 文件）

| 文件 | 职责 |
|---|---|
| __init__.py | 路由模块包入口 |
| _common.py | 抽出的 dashboard 路由共用管道（web_server 薄包装） |
| actions.py | 网关 restart/drain、hermes update、后台动作状态路由 |
| analytics.py | raw YAML 配置与 token/成本分析路由 |
| audio.py | 音频路由：转写上传、实时 transcribe-stream、语音配置、TTS 声音 |
| chat_workspaces.py | 聊天工作区选择：新 dashboard chat 可用的宿主目录 |
| chat_ws.py | 聊天页 WS：/api/console、/api/pty、/api/ws sidecar、/api/pub + /api/events |
| chat_ws_errors.py | dashboard chat（/api/pty）启动失败的用户文案 |
| config_env.py | 配置、环境变量、provider 自定义端点路由 |
| cron.py | cron 路由 |
| dashboard_ui.py | 主题/字体与 dashboard 插件（发现/hub/安装/启用/资产）路由 |
| delegation.py | 委派路由：delegation.backend 与各插件后端 |
| desktop_plugins.py | Webapp 访问宿主 desktop-plugins 的门 |
| display.py | /api/display/ws——Bot Desktop 查看器的裸 RFB over WebSocket |
| files.py | 托管文件、聊天图片上传、/api/media 与 /api/fs 路由 |
| gateway_connections.py | /api/gateway-connections：本机保存网关列表的门 |
| gateway_connections_reach.py | 保存网关的 OAuth 登录与 SSH reach |
| git.py | git 路由——桌面编码轨道 + review 面板的远端半边 |
| local_models.py | 本地模型路由——托管 llama.cpp runtime 的窗口 |
| mcp.py | MCP 路由 |
| memory_providers.py | 记忆 provider 安装路由（schema/现有值/外部依赖安装） |
| messaging.py | 消息平台路由：WhatsApp/Telegram onboarding、启用/配置/测试 |
| messaging_relay.py | Team Gateway 账号链接（Channels 面） |
| models.py | 模型分配路由：模型信息/推荐默认/辅助 + MoA 槽位 |
| oauth.py | OAuth provider 路由：目录/断开/浏览器内 device-code 登录 |
| ops.py | 配对、webhook、网关生命周期、凭据池、记忆 provider |
| profiles.py | profile 路由 |
| sessions.py | 会话路由 |
| shared_metrics.py | /api/shared-metrics/consent：dashboard 的首跑遥测征求 |
| skills.py | 技能路由 |
| status.py | 状态路由：健康、/api/status、系统统计、curator、学习图谱 |
| tools.py | 工具集 / 终端后端路由 |
| ui_preferences.py | /api/ui-preferences：本机 UI 偏好存储的门 |
| uploads.py | 认证后的浏览器→宿主附件暂存 |
| webapp.py | webapp 专属：宿主终端、预览等 |
| webapp_access.py | Web Access：开关网关服务的 webapp |
| webapp_relay_proxy.py | /api/relay/<id>/<path>：已登录浏览器的转发代理 |

### dashboard_auth/（18 文件）

| 文件 | 职责 |
|---|---|
| __init__.py | 认证 provider 框架入口；gate 只在受控模式启用 |
| audit.py | dashboard-auth 事件审计日志（logs/dashboard-auth.log，一行一 JSON） |
| base.py | provider 抽象基类 + dataclass + 异常 |
| body_limit.py | 在 FastAPI 组装 JSON 前限制公共认证请求体 |
| cookies.py | 认证 cookie 助手 |
| listener_client.py | 本进程 listener 以 Nous Portal client 登录（替代所配 provider） |
| login_page.py | 服务端渲染的 /login（无 React、无 SPA bundle、无注入 token） |
| middleware.py | dashboard 的 auth gate 中间件 |
| native_flow.py | 网关中转的 RFC 8252 原生应用授权存储 |
| native_http.py | 既有 HTTP 认证边界上的同用户私有 bootstrap |
| prefix.py | X-Forwarded-Prefix 与反向代理部署的公网 URL 解析 |
| public_paths.py | 两个 gate 共用的 /api/* 免认证白名单 |
| refresh_singleflight.py | 刷新令牌的 single-flight + 短重放缓存 |
| registry.py | DashboardAuthProvider 的模块级注册表（插件入口） |
| request_utils.py | 认证路由与两个中间件共享的请求级助手 |
| routes.py | dashboard-auth OAuth 往返的 HTTP 路由 |
| token_auth.py | 路线无关的非交互（bearer）认证 seam |
| ws_tickets.py | 受控模式的 WS 升级凭据（票据 + 内部凭据） |

## 与其他模块的关系

- **web_server.py**：挂载所有 router；`web_deps.late` 保证补丁 seam 不破（另见 web_server.md）。
- **web_server_chat.py / web_server_profiles.py**：chat_ws 的 helper 属主，是 seam 的另一端。
- **gateway/**：`/api/ws` sidecar 把浏览器 socket 接到网关事件流；`active_sessions` 供 WS 复用。
- **observability/**：shared_metrics 路由暴露同意端点。
- **plugins/**：`registry.register_provider` 是插件进入认证框架的唯一口。

## 总结

两件事值得记住：(1) dashboard 的每个业务面一个 router 文件，helper 留在 `web_server_<concern>` 并经 `web_deps` late-binding 回调——**补丁永远打在属主模块上**；(2) WS 认证的本质约束是「升级请求带不了 Authorization 头」，于是有了 30 秒一次性票据与进程内部凭据两种形状。
