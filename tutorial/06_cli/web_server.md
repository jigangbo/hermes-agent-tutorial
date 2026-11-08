# Web 服务器簇

## 文件概览

`web_server.py`（1,537 行）是 FastAPI app 的组装点；路由在 `web_routers/`（另见 web_routers.md），helper 在约 30 个 `web_server_<concern>.py` 兄弟里，**re-import 回门面**让 `web_server.<name>` 保持唯一的 late-binding seam（测试 monkeypatch 目标）。相关簇：`web_deps.py`（seam 实现）、`web_models.py`（Pydantic 模型）、`web_session_sockets.py`、`web_upload_limit.py`、`webapp*` 7 文件。

## 关键代码走读

### 组装：一个 app、多个 surface

```python
# hermes_cli/web_server.py:1-7
"""Hermes Agent — Web UI server: FastAPI app assembly, auth/host middleware, ``start_server``.

Route handlers live in ``web_routers/``; their helpers live in the sibling
``web_server_<concern>`` modules and are re-imported here so ``web_server.<name>``
stays the single late-binding seam tests monkeypatch (``web_deps.late``).
Usage: ``python -m hermes_cli.main web [--port 8080]``."""
# 行 210
app = FastAPI(title="Hermes Agent", version=get_version_info().base_version, lifespan=app_lifespan)
```

启动入口 `start_server()`（行 1415）。fastapi 缺失时惰性安装 dashboard extras——只有真正跑 `hermes dashboard` 的用户才需要 fastapi+uvicorn。

### surface 矩阵

```python
# hermes_cli/web_server_surface.py:1-9
"""What each launch surface of the one web-server stack may do.

The host serving the app records its surface once on ``app.state.ui_surface``; unset, it reads
as ``gateway`` on the gateway's own listener for native clients (the app has a ``gateway_runner``,
as the lifespan choice reads) and ``dashboard`` elsewhere (the standalone ``hermes dashboard``
and ``hermes serve``). Every surface-dependent decision reads this table instead of re-deriving
it, and :func:`route_on` keeps a route off the surfaces that do not use it.
"""
# 行 19-27
@dataclass(frozen=True)
class SurfacePolicy:
    #: Mounts a browser UI; ``serve`` is JSON-RPC/WS only.
    serves_spa: bool
    #: Public HTML may carry the session token. Where it may not, every HTML entry
    #: (``/index.html`` included) gets the token-free bootstrap instead of the raw file.
    ...
```

同一套 app 栈按 surface 服务三种启动方式：**gateway 自己的 listener**（原生客户端，JSON-RPC/WS）、**`hermes dashboard`**、**`hermes serve`**。每个依赖 surface 的决策都读这张表，不重新推导；`route_on` 把不适用 surface 的路由直接摘掉。auth 与否不在表里——由运行时 auth gate 决定（状态函数）。

### 生命周期

`web_server_lifecycle.py`：「Serve-process lifecycle: parent death watchdog, port-conflict preflight, READY announcement, browser open」。`hermes serve` 子进程带父进程死亡看门狗与端口冲突预检，就绪后宣告 READY。Desktop 拥有的 `--isolated` 后端另有三种退出路径：`web_server_idle_exit.py`（空闲退出）、`web_server_owner_exit.py`（被新属主取代而退）、`web_server_skew_exit.py`（代码版本偏斜而退）——三者的 docstring 都指向 SSH 远程场景（#101626）。

### PTY 桥与文件票据

```python
# hermes_cli/web_server_chat.py:1-2
"""Chat/terminal WebSocket plumbing: PTY bridge selection and registry, WS
"""
```

PTY 会话注册表（`hermes_cli/pty_session.py` 的 `RegistryFull`）+ `web_routers/chat_ws.py` 的 `/api/pty` 构成终端桥；浏览器文件下载走**路径绑定票据**：

```python
# hermes_cli/web_server_file_tickets.py:1-2
"""Path-bound tickets for browser file URLs (``/api/fs/download``, ``/api/files/stream``)."""
# hermes_cli/web_server_file_response.py:1-2
"""Range responses over a descriptor opened under the file ticket's profile lease."""
```

票据把「哪个 profile 的哪个路径」绑进 URL 凭据；Range 响应在票据租约下打开的描述符上服务，远程 profile 的媒体经 `web_server_remote_media.py` 从 SSH 工作区内联。

### webapp 簇

```python
# hermes_cli/webapp.py:1-2
"""Build and launch plumbing for the browser-hosted Desktop workspace."""
```

`webapp.py`（构建与启动）+ `webapp_launcher.py`（`hermes webapp` 打开网关服务的浏览器桌面）+ `webapp_page_policy.py`（CSP，独立于预览文档）+ `webapp_previews.py`（凭据-free 预览资产：私有 HTML 只跨 parent/frame 消息）+ `webapp_sign_in.py`（登录随浏览器凭据存活）+ `webapp_access.py`/`webapp_relay_target.py`（Desktop Web Access 开关与代理目标）。

上传侧有独立的先闸：`web_upload_limit.py` 在 FastAPI 解析、落盘或缓冲**之前**限制聊天上传请求体—— oversized body 永远不进内存。浏览器 socket 的会话绑定由 `web_session_sockets.py` 管：一个会话 token 开出的所有 socket，在该 token 被替换时统一收尾。

## 核心类/函数

| 符号 | 文件:行号 | 职责 |
|---|---|---|
| `app = FastAPI(...)` | web_server.py:210 | 应用组装点（lifespan 挂 app_lifespan） |
| `start_server()` | web_server.py:1415 | 监听启动入口 |
| `app_lifespan` | web_server_app.py | HTTP lifespan 组装；standalone 后端保持 opt-in |
| `SurfacePolicy` | web_server_surface.py:19 | 每个 surface 的能力表（frozen dataclass） |
| `route_on()` | web_server_surface.py | 把路由摘出不适用 surface |
| `resolve_session_token` | web_server_session_token.py | 会话 token 值从哪来 |
| `run_reaper` | pty_session.py（chat 簇引用） | PTY 会话收割 |
| `mint/consume` 文件票据 | web_server_file_tickets.py | 路径绑定下载凭据 |
| `CONFIG_SCHEMA` | web_server_config.py | dashboard 配置 schema 与模型分配逻辑 |

## 本组文件清单（38 文件）

| 文件 | 职责 |
|---|---|
| web_server.py | 门面：FastAPI 组装、auth/host 中间件、start_server；唯一补丁 seam |
| web_server_app.py | lifespan 组装；standalone 后端服务保持 opt-in |
| web_server_boundary.py | dashboard app 与网关 session listener 共享的监听边界原语 |
| web_server_surface.py | surface 能力矩阵（serves_spa/token 策略/route_on） |
| web_server_lifecycle.py | serve 进程生命周期：父死亡看门狗、端口预检、READY、开浏览器 |
| web_server_session_token.py | dashboard 会话 token 的取值来源 |
| web_server_static_assets.py | SPA catch-all 不得答 index.html 的静态资产查找 |
| web_server_dashboard.py | SPA 挂载、主题归一化/bootstrap CSS、dashboard 插件发现 |
| web_server_config.py | CONFIG_SCHEMA 构建、动态 provider 选项、模型分配逻辑 |
| web_server_chat.py | 聊天/终端 WS 管道：PTY 桥选择与注册表 |
| web_server_cron.py | cron 助手：每 profile 调度器 I/O、任务校验/归一化、点火 |
| web_server_files.py | 托管文件策略：根解析、路径包含、条目元数据 |
| web_server_file_tickets.py | 浏览器文件 URL 的路径绑定票据 |
| web_server_file_response.py | 票据租约下描述符上的 Range 响应 |
| web_server_remote_media.py | 从 profile 的 SSH 工作区内联音视频 |
| web_server_profiles.py | profile 域助手：发现回退、目录/MCP-server 写入 |
| web_server_plugin_profiles.py | 次级被服务 profile 的 dashboard 插件（PLG-3） |
| web_server_gateway.py | 网关/进程助手：拓扑(+缓存)、动作 |
| web_server_oauth.py | 登录状态助手：provider 目录、device poller |
| web_server_messaging.py | 平台目录与 onboarding：覆盖/env 发现、WhatsApp |
| web_server_memory.py | 记忆 provider 助手：manifest/schema、setup-env、依赖探测 |
| web_server_mcp.py | MCP 助手：payload 归一化、env 脱敏、dashboard 驱动的 OAuth |
| web_server_sessions.py | 只读会话浏览、最新后代查找、owner 维护 |
| web_deps.py | 抽出 router 的 late-binding seam |
| web_models.py | dashboard 的 Pydantic 请求/响应模型 |
| web_session_sockets.py | 会话 token 打开的浏览器 socket 及其被替换时的收尾 |
| web_upload_limit.py | 在 FastAPI 解析/落盘前限制聊天上传请求体 |
| web_server_idle_exit.py | Desktop 拥有的 --isolated 后端空闲退出（SSH 场景） |
| web_server_idle_proof.py | Desktop 池化 serve 子进程的诊断工作快照 |
| web_server_owner_exit.py | 被属主取代的退役（supersession） |
| web_server_skew_exit.py | 代码偏斜退役 |
| webapp.py | 浏览器桌面工作区的构建与启动 |
| webapp_launcher.py | `hermes webapp`：打开网关服务的浏览器桌面 |
| webapp_access.py | Desktop Web Access 面板对网关服务 webapp 的开关 |
| webapp_page_policy.py | 浏览器桌面的 CSP（独立于预览文档） |
| webapp_previews.py | 凭据-free 预览资产：私有 HTML 只跨 parent/frame 消息 |
| webapp_relay_target.py | webapp 代理的 gateway_connections_reach 异步视图 |
| webapp_sign_in.py | 登录随其绑定的浏览器凭据存活 |

## 与其他模块的关系

- **web_routers/**（37 文件）：本门面挂载的路由本体，经 `web_deps.late` 回调 helper。
- **dashboard_auth/**：auth gate 中间件插进本 app（见 web_routers.md）。
- **gateway/**：gateway surface 下 app 携带 `gateway_runner`，同一监听器服务原生客户端。
- **pty_session.py / active_sessions.py**：PTY 注册表与会话租约的共享原语。
- **apps/desktop/**：Desktop 通过 `serve --isolated` 拥有本服务器；三个 *_exit 模块是它的生命周期协议。

## 总结

记住一个 seam 与一张表：**`web_server.<name>` 是唯一的 monkeypatch seam**（helper 全部 re-import 回门面，路由用 `web_deps.late` 惰性回调）；**`SurfacePolicy` 是所有 surface 分支的唯一事实源**。文件下载不直接给路径——给票据；Desktop 后端不常驻——空闲/被取代/偏斜三条退出路径各归一个模块。
