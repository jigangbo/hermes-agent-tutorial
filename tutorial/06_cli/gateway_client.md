# CLI↔网关客户端 与 profiles/auth/models

## 文件概览

本篇是 CLI 层的收尾，覆盖四个相关簇：

- **网关客户端簇（35 文件）**：CLI 进程与共享网关会话之间的全部通信——`gateway_agent.py`（AIAgent 兼容表面）、`gateway_connection.py`（每进程一条连接）、`gateway_client.py`（纯传输）、`gateway_runtime*`（发现/附加/一次性票据）、`gateway_connections_*`（远程网关含 SSH ControlMaster）；
- **profiles 簇（15 文件）**：隔离 profile 的创建/克隆/改名/删除/分发；
- **auth 簇（27 文件）**：多 provider 凭据系统；
- **models 簇（20 文件）**：模型目录/切换/定价/setup 向导。

## 关键代码走读

### gateway_agent.py：CLI 从不构建 agent

```python
# hermes_cli/gateway_agent.py:1-8
"""The AIAgent surface main's HermesCLI uses, backed by the shared gateway session (CALLMAP §3.2-3.3).

``run_conversation`` submits ``prompt.submit`` and replays the gateway's event stream, on the
calling (agent) thread, into the SAME callbacks HermesCLI passed to ``AIAgent`` on main, then
returns a dict shaped like ``AIAgent.run_conversation``'s. The CLI process never builds an agent,
never runs a tool and never writes ``state.db``: the turn runs in the gateway.

Event contract: wave_a.md (frozen). Every frame is a gateway ``event`` with params
``{type, session_id, execution_generation, admission_id?, payload}``.
"""
```

哲学：`GatewayAgent` 是一个**AIAgent 兼容外壳**——`HermesCLI` 以为自己在和 `AIAgent` 说话，实际上 `run_conversation()`（gateway_agent.py:750）只是提交 `prompt.submit` RPC，然后在调用线程上回放网关事件流进原来的回调。CLI 进程**不构建 agent、不跑工具、不写 state.db**。状态栏读的 token 计数、压缩器视图都由网关的 `session.usage` 帧映射回来（`_COUNTER_FROM_USAGE` 表，gateway_agent.py:47-58）。

### gateway_connection.py：每进程一条连接

```python
# hermes_cli/gateway_connection.py:1-12
"""One gateway connection per classic-CLI process (CALLMAP §3.1, §4).

A daemon thread owns an asyncio loop and one ``GatewayClient``. It never calls a HermesCLI
method and never blocks: every event frame goes into a thread-safe ``queue.Queue`` that the
agent thread drains (``GatewayAgent.run_conversation``), and ``session.info``-class frames
also update the plain-attribute ``SessionState`` caches the status bar reads.

Callers on any other thread use ``call()``, which blocks on the loop's future; calling it on
the loop thread itself is a deadlock and raises.
"""
```

线程模型：daemon 线程拥有 asyncio loop + 一个 `GatewayClient`（gateway_connection.py:156 `class GatewayConnection`）；事件帧进 `queue.Queue` 由 agent 线程消费；其他线程用 `call()`（行 397）阻塞等 future——在 loop 线程上再调 `call()` 是死锁，直接抛。`gateway_client.py` 则是「Transport-only RPC client. Closing a viewer never stops its authority」——关掉查看者不停止权威（网关的会话）。

### runtime attach：一次性会话票据

```python
# hermes_cli/gateway_runtime_attach.py:1-6
"""One client attach: find (or start) the profile's owner, then mint its single-use session ticket.

Shared by ``hermes gateway attach`` (any local client) and Ink's ``ui-tui/scripts/gateway_bootstrap.py``.
The ticket is a credential for the one process that dials: never log it, never put it in a repr.
"""
```

attach 三步：发现（`gateway_runtime_discovery.py`，无诊断回退）→ 找不到就启动 owner（`gateway_runtime_start.py` 一个 detached 进程原语）→ 铸造单次会话票据。启动策略（模型、toolsets、kanban 板等）装在 `session.create` 里走 `CLIENT_LAUNCH_ENV`（gateway_runtime_attach.py:16-21），不进 daemon 全局默认——否则一个终端启动的 daemon 会把它的板解析强加给之后所有会话。

### 远程网关：SSH ControlMaster

```python
# hermes_cli/gateway_connections_ssh.py:1-10
"""Gateway SSH connections: a ControlMaster tunnel to a remote ``hermes serve``.

Server-side port of Desktop's SSH attach path. ``ensure_tunnel`` opens (or reuses) a ControlMaster
to the registry entry's host, starts or attaches a provably-owned ``serve --isolated`` there and
forwards a 127.0.0.1-only local port to it. Linux/macOS on both ends.

Ownership is scoped to THIS gateway's connections store, not to a Desktop install: two clients
sharing one remote never reap each other's serve. The serve's session token lives in process
memory only; a fresh process cannot prove the old serve's token, so it reaps that (provably owned)
serve and spawns anew.
"""
```

隧道=OpenSSH ControlMaster（`gateway_connections_ssh_transport.py`）；远端 `serve --isolated` 的**可证明所有权**决定生死：token 只在本进程内存，新进程证明不了旧 serve 的 token，就 reap 旧 serve 再起新的——两个客户端共享一个远程也不会互相 reap。

### auth.py：凭据系统核心

```python
# hermes_cli/auth.py:1-11
"""Multi-provider authentication system for Hermes Agent.

- ``ProviderConfig`` / ``PROVIDER_REGISTRY`` describe every known inference provider.
- The auth store (``~/.hermes/auth.json``) holds per-provider state, the credential pool and
  suppression markers; ``_auth_store_lock`` / ``_load_auth_store`` / ``_save_auth_store`` are the
  only I/O primitives (cross-process flock, atomic 0o600 writes).
- ``resolve_provider()`` picks the active provider via the documented priority chain.
- ``OAUTH_PROVIDER_FLOWS`` maps each OAuth provider to its resolver/status builder; ...
"""
```

身份事实源是 `providers.py`（「Single source of truth for provider identity」）与 `provider_catalog.py`；OAuth 流程住在 `auth_nous/auth_codex/auth_xai/...` 并 re-import 回 `auth.py` 保持可补丁面。

## 核心类/函数

| 符号 | 文件:行号 | 职责 |
|---|---|---|
| `GatewayAgent` | gateway_agent.py | AIAgent 兼容表面（回放网关事件流） |
| `GatewayAgent.run_conversation()` | gateway_agent.py:750 | 提交 prompt.submit + 回放 |
| `GatewayConnection` | gateway_connection.py:156 | 每进程一条连接（daemon loop + 事件队列） |
| `GatewayConnection.call()` | gateway_connection.py:397 | 其他线程的阻塞 RPC |
| `GatewayClient` | gateway_client.py | 纯传输 RPC 客户端（无会话权威） |
| `CLIENT_LAUNCH_ENV` | gateway_runtime_attach.py:16 | 随 session.create 传递的启动策略 |
| `ensure_tunnel()` | gateway_connections_ssh.py | SSH ControlMaster 隧道 |
| `resolve_provider()` | auth.py | 文档化优先级链选活动 provider |
| `PROVIDER_REGISTRY` | auth.py | 已知 provider 描述表 |
| `Profile` / 列表函数 | profiles.py | profile 隔离管理 |

## 本组文件清单

### 网关客户端簇（35 文件）

| 文件 | 职责 |
|---|---|
| gateway_agent.py | AIAgent 兼容表面；CLI 从不构建 agent/跑工具/写 state.db |
| gateway_connection.py | 每 CLI 进程一条连接：daemon asyncio loop + 事件队列 |
| gateway_client.py | 传输-only RPC 客户端；关查看者不停权威 |
| gateway_chat.py | 经典/一次性启动走 canonical 网关，绝不 AIAgent |
| gateway_chat_commands.py | 共享网关上的经典 CLI slash 命令（视图控件之外） |
| gateway_chat_listing.py | 网关路径上的 --list-tools/--list-toolsets（无需会话） |
| gateway_chat_startup.py | 经典 chat 与一次性共用的前端启动检查 |
| gateway_chat_view.py | 权威事件与受控操作的终端呈现 |
| gateway_runtime.py | 验证过的、无凭据的网关端点发现 |
| gateway_runtime_attach.py | 一次 attach：找/启 owner + 铸单次会话票据 |
| gateway_runtime_cli.py | 机器可读 ensure/attach 边界；只有 attach 打印凭据 |
| gateway_runtime_discovery.py | 有界本地控制发现（无诊断回退） |
| gateway_runtime_multiplex.py | 空 home 时 named-profile 客户端该启动哪个 daemon |
| gateway_runtime_replace.py | 换掉旧 Hermes 遗留在本安装 home 上的网关 |
| gateway_runtime_service.py | 显式 canonical profile 的非安装服务管理操作 |
| gateway_runtime_service_identity.py | 只读绑定检查；未知 supervisor 语法 ≠ profile 缺失 |
| gateway_runtime_start.py | 一个 detached 进程原语；调用方须先证明 owner/service 缺席 |
| gateway_multiplex_mode.py | gateway.multiplex_profiles 的启动裁决（默认开，无 opt-out） |
| gateway_multiplex_s6.py | 一主机一网关收敛的 s6 支路 |
| gateway_multiplex_served.py | 活着的多路器服务哪些 profile（唯一答案） |
| gateway_migrate.py | `gateway migrate --multiplex`：per-profile 网关安装收敛为一 |
| gateway_migrate_guards.py | 自动迁移不可越界 + opt-out |
| gateway_connections.py | 本机保存的网关连接：Desktop 与所有浏览器共用的一个列表 |
| gateway_connections_normalize.py | 保存网关注册表的纯归一化器 |
| gateway_connections_oauth.py | RFC 8252 登录 oauth 模式网关 + token 维护 |
| gateway_connections_probe.py | Webapp 的 Test 按钮：可达性探测 |
| gateway_connections_reach.py | relay 代理拨向哪里、用什么凭据 |
| gateway_connections_ssh.py | SSH ControlMaster 隧道到远程 serve |
| gateway_connections_ssh_transport.py | OpenSSH ControlMaster 传输 |
| gateway_connections_ssh_remote.py | 经 ControlMaster 的远程 serve 生命周期 |
| gateway_connections_ssh_programs.py | 在 SSH 远端运行的更新标记 gate 程序 |
| gateway_connections_watch.py | Webapp listener 跟随另一写者的网关编辑 |
| gateway_service_owner.py | 谁可写网关服务定义（systemd/launchd） |
| gateway_setup_service.py | 网关服务安装编排（运行时启动另计） |
| gateway_setup_wizard.py | 网关设置向导 |

### profiles 簇（15 文件）

| 文件 | 职责 |
|---|---|
| profiles.py | profile 隔离管理核心（创建/克隆/列表） |
| profiles_cache.py | list_profiles 背后的派生值缓存 |
| profiles_config.py | 新 profile 拷贝配置文档的迁移 |
| profiles_initialization.py | 发布前写在暂存树上的初始 profile 文件 |
| profiles_remove.py | 目录删除：等走活 owner 再带短重试 rmtree |
| profiles_service_cleanup.py | 删除/改名后清理旧名的 supervisor 注册 |
| profiles_export_scrub.py | 导出暂存副本要擦掉的密钥与网关存储 |
| profiles_honcho.py | profile rename 的 Honcho host-block 迁移 |
| profile_cmd.py | `hermes profile` 子命令 handler |
| profile_describer.py | 自动生成 profile description |
| profile_distribution.py | 可分享打包 profile（经 git） |
| profile_identity.py | 改名 rekey / 删除 purge 持久身份（#111926/#112727） |
| profile_channels.py | 克隆不得继承的消息渠道设置 |
| profile_memory_config.py | 把活动记忆 provider 的配置带进 --clone |
| profile_model_seed.py | 把模型与自定义端点播种进新 profile |

### auth 簇（27 文件）

| 文件 | 职责 |
|---|---|
| auth.py | 多 provider 认证核心：auth.json 存储/优先级链/OAUTH_PROVIDER_FLOWS |
| providers.py | provider 身份唯一事实源 |
| provider_catalog.py | 统一 provider 目录（宇宙的单一事实源） |
| credential_lifecycle.py | Hermes 读的每个存储间的统一凭据生命周期 |
| auth_commands.py | 凭据池 auth 子命令 |
| auth_constants.py | 认证常量 |
| auth_codex.py | Codex OAuth：token 存储/刷新/配额探测/device-code |
| auth_codex_browser.py | Codex 浏览器登录 |
| auth_nous.py | Nous OAuth 流程 |
| auth_minimax.py / auth_qwen.py / auth_xai.py | MiniMax / Qwen / xAI OAuth 流程 |
| auth_openrouter.py / auth_zai_kimi.py | OpenRouter / Z.ai Kimi 流程 |
| auth_device_flow.py | 共享 device-code/loopback-PKCE/浏览器/TLS 助手 |
| auth_oauth_grants.py | OAuth 授权记录 |
| auth_oauth_pkce_plugin.py | 插件 provider 的 PKCE OAuth |
| auth_plugin_providers.py | 插件注册的 provider 适配 |
| auth_model_picker.py | 认证中的模型选择 |
| auth_error_copy.py | 认证错误文案 |
| auth_external_process.py | 外部进程（如桌面）代持的认证 |
| anon_auth.py | Nous 免费档 anonymous 认证方式 |
| anon_challenge.py / anon_sign_in.py / anon_sign_in_cli.py | 匿名质询与登录 |
| dingtalk_auth.py | 钉钉凭据 |
| nous_auth_keepalive.py | Nous 凭据保活 |
| status_auth.py / vercel_auth.py / web_server_oauth.py | 状态/部署/服务器侧 OAuth 助手 |

### models 簇（20 文件）

| 文件 | 职责 |
|---|---|
| models.py | 门面：发现/缓存/身份 helper，re-import 兄弟 |
| model_catalog.py | 远程模型目录抓取 |
| models_catalog_static.py | 静态 provider/模型目录表（纯数据，无网络） |
| models_reasoning_caps.py | 推理能力档位 |
| models_local.py | 本地/自托管模型服务器（Ollama/LM Studio） |
| models_pricing.py | 定价表 |
| models_validate.py | 模型/凭据校验 |
| models_detect.py | 从环境探测模型 |
| models_cache_lock.py | 目录缓存跨进程锁 |
| models_profile_cache.py | profile 级目录缓存 |
| model_switch.py | CLI 与网关 /model 共享的切换逻辑 |
| model_switch_providers.py | 切换时的 provider 分支 |
| model_selection_guards.py | 切换面统一的选型时守卫注册表 |
| model_setup.py | `hermes model` 公共助手 |
| model_setup_flows.py | `hermes setup`/`hermes model` 的每 provider 选型向导 |
| model_setup_flows_common.py | 向导共用步骤 |
| model_setup_flows_azure.py / _bedrock.py / _custom.py / _local.py | Azure / Bedrock / 自定义端点 / 本地向导 |

## 与其他模块的关系

- **agent/**：`GatewayAgent` 实现与 `AIAgent` 相同的 `run_conversation` 契约——mixin 感知不到差异。
- **gateway/（服务端）**：wave_a.md 事件契约冻结；`gateway/run.py` 的 Guard-1/Guard-2 消费 `busy_policy`。
- **cli.py**：`process_command` 里 `gateway_setting_commands`/`gateway_cli_commands`/`gateway_plugin_commands` 是本簇伸进 slash 派发的桥（见 slash_registry.md）。
- **web_routers/gateway_connections*.py**：Webapp 的保存网关/SSH reach 路由调本簇。
- **update_system**：舰队重启的对象就是本簇负责发现/附加的网关。
- **config_skins**：profile 隔离以 `get_hermes_home()` 为锚；profiles 簇是其管理面。

## 总结

这四簇共享一个主题：**所有权与事实源的唯一性**。网关拥有 turn（CLI 只回放）；owner 网关拥有 profile 的服务定义；providers.py 拥有 provider 身份；auth.json 的三个 I/O 原语拥有凭据字节。CLI 侧的全部复杂度——单连接、事件队列、一次性票据、ControlMaster 所有权——都是「不构建 agent 的进程如何安全参与」这个问题的答案。
