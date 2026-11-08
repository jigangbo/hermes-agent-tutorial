# 09.1 已发布的插件 API —— hooks、ctx、ABC 与清单

插件作者能碰到的一切，就是这一篇里的四样东西：钩子点、`PluginContext`（`ctx`）、可实现的核心 ABC、以及 `plugin.yaml` 清单。任何超出这个表面的工作方式（改核心文件、patch 核心对象、读别的插件的内部）都违反「插件永不触碰核心」（见 index.md）。

## 文件概览

| 文件 | 行数 | 角色 |
|------|------|------|
| `hermes_cli/plugins_context.py` | — | `PluginContext`：插件拿到的唯一把柄 |
| `hermes_cli/plugins_dispatch.py` | — | 钩子分发：超时分档、签名检查 |
| `hermes_cli/plugins_loader.py` / `plugins/plugin_loader.py` | 278（后者） | 按路径导入 + 有界等待锁 |
| `hermes_cli/plugins_manifest.py` | — | `plugin.yaml` 解析 |
| `hermes_cli/plugins_activation.py` | — | 中途加载的"现在活 vs 下个会话"摘要 |
| `hermes_cli/data/plugin_api.json` | — | 已发布核心名清单（boundary lint 的依据） |

## 关键代码走读

### 1. 钩子点

通用插件在 `register(ctx)` 里注册钩子。分发层的分档表就是钩子世界的地图：

```python
# hermes_cli/plugins_dispatch.py:42-49 (节选)
_HOOK_TIMEOUT_BOUNDED_HOOKS: set[str] = {
    "post_tool_call", "transform_terminal_output", "transform_tool_result", "transform_llm_output",
    "pre_llm_call", "post_llm_call", "pre_api_request", "post_api_request", "api_request_error",
    "pre_auxiliary_call", "post_auxiliary_call", "pre_verify", "on_session_start", "on_session_end",
    # Fail-open consumer on every inbound gateway message: a hung plugin must not stall the profile.
    "post_gateway_admission",
    ...
}
_HOOK_TIMEOUT_FAIL_CLOSED_HOOKS: set[str] = {"pre_tool_call"}
```

核心六钩是 `pre_tool_call` / `post_tool_call` / `pre_llm_call` / `post_llm_call` / `on_session_start` / `on_session_end`，另有辅助调用对的 `pre_auxiliary_call` / `post_auxiliary_call`（payload 是 `*_api_request` 形状 + `aux_task` 字段）。超时纪律：有界钩子跑在 `plugins.hook_callback_timeout` 下（worker 被弃置、绝不 join）；`pre_tool_call` 是唯一 fail-closed 的——超时或仍在跑就阻塞该工具，消息是 `"pre_tool_call plugin callback timed out or is still running"`（67 行）。回调按签名检查：旧窄签名只收到自己声明的字段，`**kwargs` 收完整 payload——这就是"payload 以关键字字段增量添加"的兼容契约的落实处。

`pre_llm_call` 可以返回 `{"context": "..."}`（或字符串）注入上下文；辅助钩子由 `agent/auxiliary_hooks.py` 从 titling/压缩/MoA/vision 等路径发出，绝不与 turn 范围钩子混淆（#79733）。

### 2. ctx 表面：插件拿到的把柄

```python
# hermes_cli/plugins_context.py:36, 270, 442, 723, 834 (grep 视角)
class PluginContext(PluginCapabilityCtxMixin):   # :36
    ...
    def register_tool(self, ...):                # :270
    def ask_choice(self, question, choices): ... # :425
    def register_cli_command(self, ...):         # :442
    def register_locale_dir(self, ...):          # :723
    def register_login_backend(self, provider):  # :834
```

关键方法与语义：

- **`register_tool`**：把一个 Python 函数注册成模型工具；工具出现在下个会话（prompt-cache 不变量，见 activation）。
- **`register_cli_command`**：argparse 子树在启动时接进 `hermes` 主解析器——**不需要改 `main.py`**，这正是「加宽通用面而非硬编码」的样板。
- **`register_locale_dir`**：清单里 `provides_locales` 的语言包（`locales/<lang>[.tui|.desktop].yaml`）自动注册；纯清单语言包连 `__init__.py` 都不需要，`hermes_cli/plugin_validate_locales.py` 校验它们。
- **`agent.secret_scope.get_secret`**：凭据的唯一正确读法。多路复用下一个进程服务多个 profile，裸 `os.environ` 读可能拿到另一个 profile 的 key（`plugins/AGENTS.md`「Lifecycle hooks fire under the owning profile's scope」节）。
- **`credentialed_provider_request`**：订阅式登录（Codex/ChatGPT）的唯一用法——Hermes 附 token，插件永远不持有它。
- **`spawn_context_thread`**：一切后台工作的起点；裸 `threading.Thread` 起的 worker 没有作用域，fail-closed 或写进启动 profile 的租户。
- **`register_login_backend`**（browser_vault 登录后端）：加载时只接受**捆绑插件**或**verified/official 层目录插件**在受审 pin 上的安装（`plugin-catalog/README.md` 规则 18）。

### 3. 可实现的核心 ABC

| ABC | 文件 | 说明 |
|-----|------|------|
| `MemoryProvider` | `agent/memory_provider.py` | `sync_turn`/`prefetch`/`shutdown`，可选 `post_setup`；编排者 `agent/memory_manager.py`；profile 归属经 `on_profile_created`/`on_profile_renamed` |
| `ProviderProfile` | `providers/base.py` | **声明式** auth/endpoints/quirks；`__init__.py` 在加载时调 `providers.register_provider(ProviderProfile(...))` |
| Context engine / image-gen / video-gen / delegation provider | `agent/context_engine.py` 等 | 各自的 ABC + 目录（`plugins/context_engine/` 等）；`plugins/delegation/default` 就是今天的委派路由 |
| `PlatformEntry` seams | `gateway/platforms/base.py` | 平台插件设置 `trusted_inbound`、`display_tier`、`shared_env_prefixes` 等 seam——核心特例变成插件设置的 seam，**永不是名字检查** |

模型提供方的 last-writer-wins 在 `providers/__init__.py` 有明确设计意图（docstring，731-732 行）："documented override precedence via last-writer-wins in `register_provider()` — a pip package cannot hijack a first-party profile"——顺序靠发现步骤的先后实现：pip entry points 先跑（最低优先），然后捆绑目录、`$HERMES_HOME` 层，**后者覆盖前者**。

### 4. plugin.yaml 清单

```yaml
# 典型内置清单（plugins/memory/byterover/plugin.yaml 节选）
name: byterover
version: 1.0.0
description: "ByteRover — persistent knowledge tree with tiered retrieval via the brv CLI."
external_dependencies:
  - name: brv
    install: "curl -fsSL https://byterover.dev/install.sh | sh"
    check: "brv --version"
config_keys:
  - memory.byterover
```

通用字段面（`plugin-catalog/README.md` 条目 schema 与 AGENTS.md 归纳）：`name`、`version`、`description`、`kind`（general/memory-provider/model-provider…；**缺 `kind:` 的清单按源码启发式自动判型**——同时出现 `register_provider` + `ProviderProfile` 即判 model-provider，`PluginManager` 只记录其清单却**绝不 import**，否则会双实例化）、`requires_env`、`config_schema`、`oauth:`、`capabilities:`、`python_dependencies`、`provides_locales`。未知原生清单字段被忽略（兼容契约）。

### 5. 加载机制：`plugins/plugin_loader.py`

这是 memory/cron/context_engine 各专用系共用的按路径加载器：

```python
# plugins/plugin_loader.py:144-149 (docstring 节选)
def load_plugin_module(module_name: str, plugin_dir: Path, *, parents: tuple[str, ...],
                       logger: logging.Logger, synthetic_namespace: Optional[str] = None) -> Optional[Any]:
    """Import ``plugin_dir/__init__.py`` as *module_name* (reusing sys.modules when loaded).
    Order matters: parents first (relative imports need them), then siblings as ``module_name.<stem>``
    (so ``from ._x import Y`` resolves), then module. ..."""
```

父包与兄弟模块**预注册**成合成包（`register_synthetic_package`，72-78 行），相对导入才能解析，monkeypatch 才有正常的模块形状。并发纪律靠一套锁与有界等待：

```python
# plugins/plugin_loader.py:22-31 (节选)
_MODULE_LOAD_LOCKS: dict[str, threading.RLock] = {}
_MODULE_LOAD_LOCKS_GUARD = threading.Lock()
# Inside bounded_load_wait(), how long a second caller waits for another thread's in-flight load of
# the same module. Past it the module is marked stalled (a hung import) and later bounded callers
# refuse at once until it finishes.
_CONCURRENT_LOAD_WAIT_SECS = 10.0
_BOUNDED_WAIT: ContextVar[bool] = ContextVar("plugin_load_bounded_wait", default=False)
_STALLED_LOADS: set[str] = set()
_LOAD_OWNERS: dict[str, int] = {}  # module -> thread id running its load
_LOAD_WAITERS: dict[int, str] = {}  # thread id -> module whose load it waits for
```

`bounded_load_wait()`（56-64 行）让每 turn 的调用方最多等 10 秒，超时标记 stalled 并立即拒绝；死锁检测 `_load_would_deadlock`（42-53 行）沿着加载锁 + importlib 模块锁的等待图走回自己就放弃——**`PluginManager` 每次重扫的差异**在 `hermes_cli/plugins.py:391-436`：安全 worker 跳过、`force=True` 先 `unload()` 再重扫、`HERMES_SAFE_MODE=1` 直接跳过发现、失败时回滚 `_discovered` 标志免得"空注册表"被缓存，扫完 `_evict_stale_persistent_registrations` 处理没回来的注册者、`_refresh_secret_sources_after_discovery` 补拉插件密钥源。

### 6. 作用域纪律与宿主边界

**钩子在所属 profile 作用域下触发，调用者负责绑定**：`on_session_start`/`on_session_end`/`sync_turn`/`shutdown` 既从 turn（已绑定）也从 eviction、shutdown、`tui_gateway` teardown、cron completion 发出（由调用者经 `_run_release_in_profile_scope`、`_session_profile_runtime_scope`、`_profile_cron_scope` 绑定）。提供方**绝不把 `initialize()` 拿到的 `hermes_home` 缓存成"那个"家**——状态按每次调用交给它的 home 键控（`hermes_home_key()`），凭据只从 `agent.secret_scope.get_secret` 读。

`plugins.isolation: host` 时，每个非捆绑插件跑在 per-profile 宿主进程里（`plugin_host.py` 父侧 / `plugin_host_child.py` 子侧 / `plugin_host_wire.py` 帧协议）：一切用户代码导入路径要么路由进宿主要么拒绝；过不去的东西集中在 `plugin_isolation.HOST_UNSUPPORTED_CTX_METHODS` 一张表（活网关/适配器对象）；宿主永不 spawn 宿主（`HERMES_PLUGIN_HOST_PROCESS=1` 强制 in-process）。隔离方不能在操作员钉死时退出：`isolation_mode()`/`host_launcher()` 经托管 overlay（`load_config_readonly`）读取，`/etc/hermes/config.yaml` 压过 profile 自己的配置。

### 7. 中途激活摘要

```text
# hermes_cli/plugins_activation.py:1-9 (docstring 节选)
"""Mid-run plugin activation: what a just-loaded plugin does NOW vs next session (#87770).

One seam for every surface: ``PluginManager.on_plugin_loaded`` fires with one
:func:`plugin_activation_summary` per loaded plugin. Gateway handlers (slash commands, transform hooks,
platform callbacks) are live as soon as the plugin loads; portable MCP servers and skills go live in
the open chats of the plugin's profile (:func:`load_and_go_live`; MCP tools are deferred behind
tool_search, so the cached prompt prefix is unchanged); Python tools and system-prompt sections stay
deferred to the next session (prompt-cache invariant, same as ``/skills install``)."""
```

这张"现在 vs 下个会话"表是 prompt-cache 神圣不变量在插件面的投影：**绝不从 RPC 里发 `on_plugin_loaded`**（AGENTS.md 原话）。

## 核心类/函数

| 名称 | 位置 | 职责 |
|------|------|------|
| `PluginContext` | `hermes_cli/plugins_context.py:36` | 插件唯一把柄：register_* / ask_choice / secret 路由 |
| `register_tool` / `register_cli_command` / `register_locale_dir` / `register_login_backend` | 同上 :270/:442/:723/:834 | 工具 / argparse 子树 / 语言包 / 登录后端注册 |
| `credentialed_provider_request` | ctx 面 | 订阅式登录请求（token 由 Hermes 附） |
| `_HOOK_TIMEOUT_BOUNDED_HOOKS` / `_FAIL_CLOSED_HOOKS` | `plugins_dispatch.py:42/:60` | 钩子超时分档；`pre_tool_call` 唯一 fail-closed |
| `discover_plugins(force)` | `hermes_cli/plugins.py:871` | 幂等发现入口；join 后台扫描 |
| `discover_and_load` | 同上 :390 附近 | 重扫主体：SAFE_MODE、unload、脏标志回滚 |
| `load_plugin_module` | `plugins/plugin_loader.py:144` | 按路径导入 + 父/兄弟预注册 |
| `bounded_load_wait` / `_module_load_lock` | 同上 :56/:67 | 10s 有界等待 + stalled 标记 |
| `register_synthetic_package` | 同上 :72 | 合成父包壳，相对导入的根基 |
| `MemoryProvider` / `ProviderProfile` | `agent/memory_provider.py` / `providers/base.py` | 记忆与模型提供方 ABC |
| `plugin_activation_summary` | `hermes_cli/plugins_activation.py` | 现在活 vs 下个会话的激活摘要 |

## 本组文件清单

| 文件 | 一句话 |
|------|--------|
| `hermes_cli/plugins_context.py` | ctx 面（73 个方法级定义） |
| `hermes_cli/plugins_dispatch.py` | 钩子分发、超时分档、签名检查 |
| `hermes_cli/plugins_loader.py` | 通用插件的导入与注册（isolation 路由点） |
| `plugins/plugin_loader.py` | 专用系共享的按路径加载器 |
| `hermes_cli/plugins_manifest.py` | `plugin.yaml` 解析与 kind 判定 |
| `hermes_cli/plugins_activation.py` / `plugins_activation_live.py` | 中途激活摘要与 go-live |
| `hermes_cli/plugins_ledger.py` / `plugins_state.py` / `plugins_transaction.py` | 注册账本与安装事务 |
| `hermes_cli/plugins_cmd*.py` | CLI 面（install/remove/toggle/update/catalog/…） |
| `hermes_cli/plugin_isolation_audit.py` / `plugin_host*.py` | host 隔离审计与宿主进程 |
| `hermes_cli/data/plugin_api.json` | 已发布核心名清单（boundary lint 依据） |

## 与其他模块的关系

- `model_tools.py`：钩子的主调用点（pre/post tool）与发现的触发副作用；`run_agent.py` 发生命周期钩子。
- `agent/secret_scope.py`：凭据路由与 fail-closed 语义（multiplex 翻转见 08 篇 process_model.md）。
- `gateway/platform_registry.py`：平台插件注册表；`_shared.apply_yaml_bridge` / `platform_gate_env` 是平台 YAML 的合法通道（**平台插件永不改 `os.environ`**）。
- `scripts/boundary_lint.py`：本篇的清单文件就是它的判定依据（下一篇细讲）。

## 总结

已发布 API 的全部逻辑可以压成四句话：**钩子有超时分档且按签名演进**；**ctx 是唯一把柄，CLI 子树和工具都经它注册而不碰 main.py**；**ABC 是类型边界，ProviderProfile 的 last-writer-wins 让用户覆盖而不劫持**；**加载有锁、有界等待与死锁检测，中途激活尊重 prompt-cache**。作者守住这四条，插件就与核心解耦；核心守住 `plugin_api.json` 这张清单，边界就有机器执法——这正是下一篇的内容。
