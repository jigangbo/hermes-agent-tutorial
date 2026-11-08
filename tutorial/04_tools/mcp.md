# MCP 客户端组 —— 把外部服务器变成工具

## 文件概览

MCP（Model Context Protocol）是「给 AI 用的 USB 接口」：任何进程只要说这套协议，Hermes 就能把它的能力变成模型可调的工具。本组 27 个文件实现了一个完整的 MCP 客户端：`mcp_tool.py` 是门面（SDK 加载器 + `MCPServerTask` 长活任务 + 共享状态），`mcp_tool_transport.py` 管三种传输（stdio 子进程 / Streamable HTTP / SSE）的建立，`mcp_oauth*.py` 四件套管 OAuth 2.1 登录，其余兄弟模块按主题切分——配置、发现、注册、内容渲染、错误分类、健康刷新、生命周期、成本预算。核心心智模型：**每台配置在 `mcp_servers` 里的服务器 = 一个后台事件循环里的长活 Task**，工具动态注册进 registry 的 `mcp-<服务器名>` toolset。

## 关键代码走读

### 1. mcp_tool.py：一个事件循环，多个长活 Task

门面 docstring 定下了并发模型：一条后台事件循环（`_mcp_loop`）跑在守护线程里，每台服务器是一个 `MCPServerTask`——**传输层的 anyio cancel scope 必须在同一个 Task 里进出**，这是 MCP SDK 的要求。所有 `_servers`/loop 的改动都持 `_lock`：

```python
# 来源：tools/mcp_tool.py:1-10
#!/usr/bin/env python3
"""MCP (Model Context Protocol) client: connects to the ``mcp_servers`` configured in
~/.hermes/config.yaml (stdio, Streamable HTTP or SSE), discovers their tools and registers them
into the hermes tool registry. The ``mcp`` package is optional (no-op without it).

One background event loop (``_mcp_loop``) in a daemon thread runs each server as a long-lived
Task (``MCPServerTask``) so the transport's anyio cancel scopes enter and exit in one Task; every
``_servers``/loop mutation holds ``_lock``. This module keeps the SDK loader, ``MCPServerTask`` and
all shared state; the ``mcp_tool_*`` siblings read that state back through ``tools.mcp_tool`` at
call time (``_core``) and are imported directly by their callers."""
```

兄弟模块通过 `_core` 回读门面状态（ siblings late-import 模式），而不是反过来——门面在模块头就把它们 import 好。

### 2. 懒加载 SDK 与 PEP 562

import `mcp` 包要 ~260ms，而很多用户根本没配 MCP 服务器。所以 SDK 的符号走 **PEP 562 模块级 `__getattr__` 懒加载**：import 时只用 `find_spec` 探测「装没装」（快），真正的 import 推迟到第一次使用；可选的类型家族（sampling、elicitation、通知）缺了只损失那个特性，不损失 MCP：

```python
# 来源：tools/mcp_tool.py:86-93
# Importing ``mcp`` costs ~260ms, so it is deferred to first use (_ensure_mcp_sdk); availability
# is decided now via find_spec so every ``if not _MCP_AVAILABLE`` gate / patch / skipif holds.
try:
    _MCP_AVAILABLE = importlib.util.find_spec("mcp") is not None
except Exception:
    _MCP_AVAILABLE = False
if not _MCP_AVAILABLE:
    logger.debug("mcp package not installed -- MCP tool support disabled")
```

`_MCP_SDK_LAZY_SYMBOLS` 集合（`mcp_tool.py:114-116`）登记所有懒符号，`__getattr__` 命中才触发 `_ensure_mcp_sdk()`——这也让 `mock.patch("tools.mcp_tool.stdio_client")` 能见到真实的 original。

### 3. stdio 启动前的恶意软件预检

stdio 服务器是「下载并运行陌生人的代码」。启动前有一道 OSV（Open Source Vulnerabilities）恶意软件预检，带 12 秒墙上时钟上限、超时 fail-open（网络慢不该冻死工具系统）。关键注释：**预检必须看到真实命令**——任何把 argv 改写成包装器的逻辑都必须排在它之后，否则检查的是包装器，等于没查：

```python
# 来源：tools/mcp_tool.py:33-53（节选）
# Wall-clock bound on the fail-open OSV malware preflight before a stdio spawn; just ABOVE
# osv_check._TIMEOUT (10s) so it only bites when a stalled SSL handshake defeats that.
_OSV_MALWARE_CHECK_TIMEOUT_S = 12.0


async def _preflight_stdio_command(server_name: str, command: str, args: list) -> tuple[str, list]:
    """OSV malware preflight (off-loop, wall-clock bound, fail-open on timeout), THEN the
    cached-npx swap. The preflight must see the REAL command/args: anything that rewrites argv to a
    wrapper or resolved binary has to happen after it, or the check silently inspects the wrapper
    and becomes a no-op (``_infer_ecosystem`` keys off the command basename being npx/uvx/pipx)."""
    from tools.osv_check import check_package_for_malware
    try:
        malware_error = await asyncio.wait_for(
            asyncio.to_thread(check_package_for_malware, command, args), timeout=_OSV_MALWARE_CHECK_TIMEOUT_S)
    except TimeoutError:
        logger.warning("MCP server '%s': OSV malware preflight timed out after %.0fs "
                       "(network slow/unreachable) — proceeding without the check.",
                       server_name, _OSV_MALWARE_CHECK_TIMEOUT_S)
        malware_error = None
    if malware_error:
        raise ValueError(f"MCP server '{server_name}': {malware_error}")
```

预检之后是**缓存的 npx 直换**：npx 解析完包后会分叉并作为常驻父进程空耗 ~48MB/台，Hermes 已自建死亡监督，所以命中缓存就直接 spawn 真正的服务器二进制，跳过 npx 这个中间人。

### 4. mcp_tool_transport.py：三种传输的建立

传输兄弟模块处理 stdio spawn（预检、npx 直换、子进程 PID 台账 + 死亡监督注册）与 HTTP/SSE 连接（内容类型预检、身份头、客户端证书、OAuth、协议协商）。一个细节能看出防御的密度——HTTP 预检直接手搓一个 JSON-RPC `initialize` 探测体去试端点：

```python
# 来源：tools/mcp_tool_transport.py:29-32
_PROBE_INITIALIZE_BODY = (  # JSON-RPC ``initialize`` body for the content-type preflight POST
    '{"jsonrpc":"2.0","id":"_probe","method":"initialize","params":{"protocolVersion":"2025-03-26",'
    '"capabilities":{},"clientInfo":{"name":"hermes-probe","version":"0.1"}}}')
```

先用它确认端点真是 MCP、拿到拒绝原因，再投入完整会话。错误分类（`mcp_tool_errors.py`）把这层可能遇到的一切——URL 校验失败、TLS 客户端证书、身份头、重定向、body 上限——翻译成模型可读的解释。

### 5. mcp_oauth.py：OAuth 2.1 + PKCE

需要登录的 MCP 服务器走 OAuth 2.1 授权码流程。Hermes 复用 SDK 的 `OAuthClientProvider`（它做发现、客户端识别、PKCE、换 token、刷新），自己提供三样：磁盘 token 存储（`HermesTokenStorage`）、localhost 回调监听器、以及构造入口 `build_oauth_auth()`。client_id 优先用 CIMD（Client ID Metadata Document URL），服务器不支持才退回 RFC 7591 动态注册：

```python
# 来源：tools/mcp_oauth.py:1-12
#!/usr/bin/env python3
"""MCP OAuth 2.1 client support: browser authorization-code flow with PKCE.

The SDK's ``OAuthClientProvider`` does discovery, client identification, PKCE, exchange and
refresh; this module supplies ``HermesTokenStorage`` (on-disk persistence), the localhost callback
listener and ``build_oauth_auth()`` (legacy entry point). client_id is Hermes' Client ID Metadata
Document URL (CIMD) when the server supports it, else RFC 7591 DCR. ``mcp_servers.<name>.oauth`` keys
(all optional): client_id, client_secret, scope, redirect_port, redirect_uri (proxy callback),
redirect_host, client_name, client_metadata_url, cimd, user_agent, timeout."""
```

周边还有三个帮手：`mcp_oauth_device.py` 实现显式的 RFC 8628 设备码登录；`mcp_oauth_manager.py` 是进程级唯一管理器（每服务器 provider、跨进程刷新围栏——fcntl/msvcrt 文件锁）；`mcp_dashboard_oauth.py` 在桌面仪表盘场景用回调桥接代替本地监听。**信任是 per-profile 记录**：`mcp_tool_registration.py::_record_scope_trust` 把信任键在 home 上，多路复用时次要 profile 绝不继承启动 profile 对同名服务器的信任；`mcp_tool_handlers.py::_trust_gate_check` 查询的是发起调用的会话所属 profile。

### 6. 注册与 schema 缓存

连接成功后 `mcp_tool_registration.py` 把服务器的工具注册进 registry（toolset 名 `mcp-<服务器>`），schema 经 `mcp_tool_schema.py` 归一化（不同 provider 对 JSON schema 的容忍度不同）。`mcp_schema_cache.py` 支持**懒启动**：服务器工具清单持久化在磁盘上，重启后不必等服务器连上就有完整 schema，连接在后台补上。`mcp_liveness.py` 把应用侧的健康数据解析成给用户看的状态文案。

## 核心类/函数

| 符号 | 职责 | 位置 |
|---|---|---|
| `MCPServerTask` | 一台服务器的长活任务（传输 + 会话 + 健康 + 运行状态机） | `tools/mcp_tool.py` |
| `_mcp_loop` | 守护线程里的后台事件循环，所有 Task 的家 | `tools/mcp_tool.py` |
| `_ensure_mcp_sdk` / `__getattr__` | SDK 懒加载（find_spec 探测 + PEP 562 首次取用导入） | `tools/mcp_tool.py:86,119` |
| `_preflight_stdio_command` | stdio 启动前 OSV 预检（12s fail-open）+ 缓存 npx 直换 | `tools/mcp_tool.py:38` |
| `MCPServerTransportMixin` | stdio/HTTP/SSE 传输建立与协议协商 | `tools/mcp_tool_transport.py` |
| `MCPServerRunMixin` | `run` 状态机：连接、冷却、刷新、退出 | `tools/mcp_tool_server_run.py` |
| `MCPServerHealthMixin` | list_changed 触发的动态工具刷新与会话健康 | `tools/mcp_tool_health.py` |
| `register_server_tools`（mcp_tool_registration） | 把连接上/缓存里的工具注册进 registry；记录 per-profile 信任 | `tools/mcp_tool_registration.py` |
| `_trust_gate_check`（mcp_tool_handlers） | 按调用会话的 profile 查信任门 | `tools/mcp_tool_handlers.py` |
| `HermesTokenStorage` | OAuth token 的磁盘持久化 | `tools/mcp_oauth.py` |
| `build_oauth_auth` | 组装 SDK OAuthClientProvider（CIMD 优先，DCR 兜底） | `tools/mcp_oauth.py` |
| `load_mcp_servers`（mcp_tool_config） | `mcp_servers` 配置加载与 `${VAR}` 展开、stdio 启动环境 | `tools/mcp_tool_config.py` |
| `render_content_blocks`（mcp_tool_content） | MCP 工具结果内容块 → 模型可读文本（带尺寸策略） | `tools/mcp_tool_content.py` |

## 本组文件清单

MCP 组共 27 个文件：

| 文件 | 一句话角色 |
|---|---|
| `tools/mcp_tool.py` | 门面：SDK 加载器、MCPServerTask、共享状态与锁。 |
| `tools/mcp_tool_agent.py` | (重)发现后对活动 agent 的工具列表维护/刷新。 |
| `tools/mcp_tool_common.py` | 跨模块小助手：SDK 1.x/2.x 字段访问、默认超时。 |
| `tools/mcp_tool_config.py` | 服务器配置加载与 stdio 启动环境（`${VAR}` 展开、打包 npx 条目）。 |
| `tools/mcp_tool_content.py` | 工具结果内容块渲染成模型文本（尺寸限制策略）。 |
| `tools/mcp_tool_costs.py` | 声明式每工具成本与每会话花费台账（预算门）。 |
| `tools/mcp_tool_discovery.py` | 连接与发现：每服务器连接冷却、发现调度。 |
| `tools/mcp_tool_errors.py` | 连接/传输错误分类与人类可读解释（URL、TLS、身份头、重定向）。 |
| `tools/mcp_tool_events.py` | MCP Events 客户端与 webhook 交付（实验性 triggers/events 扩展）。 |
| `tools/mcp_tool_handlers.py` | 注册表面向的同步 handler + 工具资源/提示 utility + 每调恢复逻辑 + 信任门。 |
| `tools/mcp_tool_health.py` | 会话健康：list_changed 动态刷新、服务器活动监控。 |
| `tools/mcp_tool_lifecycle.py` | stdio 子进程 PID 台账、孤儿清理、优雅退出。 |
| `tools/mcp_tool_loop.py` | 后台循环设施：跨进程发现文件锁、调度。 |
| `tools/mcp_tool_node_abi.py` | Node 原生插件 ABI 不匹配的 stdio 服务器诊断。 |
| `tools/mcp_tool_registration.py` | 把已连接/缓存服务器的工具注册进 registry + per-profile 信任记录。 |
| `tools/mcp_tool_sampling.py` | 服务器发起请求的客户端 handler：sampling、elicitation。 |
| `tools/mcp_tool_schema.py` | 工具 schema 转换与命名（按 provider 归一化 JSON schema）。 |
| `tools/mcp_tool_scope.py` | 多路复用下连接台账的作用域键。 |
| `tools/mcp_tool_server_run.py` | MCPServerTask 的 run 状态机。 |
| `tools/mcp_tool_transport.py` | 传输建立：stdio spawn（OSV 预检、npx 直换、PID 台账）、HTTP/SSE、协商。 |
| `tools/mcp_oauth.py` | OAuth 2.1 授权码 + PKCE：token 存储、localhost 回调。 |
| `tools/mcp_oauth_device.py` | RFC 8628 设备码登录。 |
| `tools/mcp_oauth_manager.py` | 进程级 OAuth 状态管理器（每服务器 provider、跨进程刷新围栏）。 |
| `tools/mcp_oauth_provider.py` | Hermes 对 SDK OAuthClientProvider 的定制。 |
| `tools/mcp_dashboard_oauth.py` | 仪表盘中介的 OAuth 回调桥。 |
| `tools/mcp_schema_cache.py` | 懒启动的持久工具清单缓存。 |
| `tools/mcp_liveness.py` | 应用侧健康解析与用户可读状态文案。 |

## 与其他模块的关系

- `tools/registry.py`：MCP 工具注册进 `mcp-<服务器>` toolset；MCP 重连的同 toolset 重注册被放行，跨 toolset 遮蔽一律拒绝；deregister 对 `mcp-*` 豁免插件归属检查。
- `tools/osv_check.py`：stdio 预检的执行者（本组之外的安全文件）。
- `tools/environments/local.py::build_subprocess_env`：stdio 子进程的环境由这个统一 env builder 提供（绝不裸 `os.environ.copy()`）。
- `model_tools.py`：**MCP 发现故意不在 import 时跑**（120 秒阻塞 + 网关事件循环冻结，issue #16856），每个入口自行触发。
- `hermes_cli/` 与 `gateway/`：`hermes mcp` 管理命令、网关的每会话 MCP 授权与 `manage_connections` 打通。

## 总结

MCP 组的关键词是「长活 + 防御」。长活：一个后台循环，每服务器一个 Task，cancel scope 同 Task 进出，断线有冷却、清单有缓存、健康有刷新。防御层层叠叠：SDK 懒加载省 260ms 启动；stdio 先 OSV 预检再看 npx 直换（顺序不能反，注释写得斩钉截铁）；HTTP 先拿 initialize 探测体验明正身；OAuth 优先 CIMD、刷新有跨进程围栏；连「这台服务器被信任过」都是 per-profile 的记录，多路复用下谁的孩子谁抱。读完这组再看 `hermes mcp` 列出的那些服务器，你看到的就是二十几个文件在背后替模型守门的完整链条。
