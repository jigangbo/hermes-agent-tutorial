# auxiliary_clients.md — 辅助 LLM 客户端：副任务宇宙

## 文件概览

主循环之外的一切 LLM 调用——压缩、标题、视觉、embedding、会话搜索、curator、MoA
顾问——都叫**辅助调用**（auxiliary）。它们没有自己的 turn，却要凭据、要路由、要重试、
要可观测。`agent/auxiliary_client.py`（8,281 行，全仓最大）是这片宇宙的中心路由器，
19 个 `auxiliary_*` 兄弟模块各管一摊。

| 文件 | 行数 | 角色 |
|---|---|---|
| `agent/auxiliary_client.py` | 8,281 | 中心路由器：`call_llm` 入口、`_resolve_auto_route` 三级阶梯、`resolve_provider_client` |
| `agent/auxiliary_task_config.py` | 117 | `auxiliary.<task>` 配置块的读时解析（每任务 pin、插件任务、inherit_from） |
| `agent/auxiliary_hooks.py` | 266 | `pre_auxiliary_call`/`post_auxiliary_call` 插件事件（每次物理尝试一对） |
| `agent/auxiliary_unavailable.py` | 275 | "为什么建不出客户端"： Nous 凭据失败的记忆与一次性告警 |
| `agent/auxiliary_error_shapes.py` | 54 | 错误形态读取：HTTP 状态在哪、无状态失败如何终结一条路由 |
| `agent/auxiliary_rate_limit_backoff.py` | 71 | 同凭据 429/限流退避（阶梯产出 wait，sync/async 共享一张表） |
| `agent/auxiliary_fallback_recovery.py` | 50 | 回退候选的参数拒绝恢复（剥掉被拒字段再试） |
| `agent/auxiliary_reasoning_floor.py` | 126 | 推理下限：路由拒绝关推理时改为升档 |
| `agent/auxiliary_structured_output.py` | 127 | 结构化输出能力记忆（某路由拒 `response_format` 就记下来） |
| `agent/auxiliary_stream_watchdog.py` | 182 | 流式无进展看门狗（只 shutdown 本尝试的 socket） |
| `agent/auxiliary_health.py` | 73 | 自定义 provider 健康检查的端点身份 |
| `agent/auxiliary_client_registry.py` | 134 | `auth_type` 分派表（auxiliary registry 分支） |
| `agent/auxiliary_plugin_oauth.py` | 45 | OAuth 型 model-provider 插件的 aux 客户端 |
| `agent/auxiliary_key_rotation.py` | 21 | 凭据刷新后轮转已发布的 main-runtime key |
| `agent/auxiliary_local_runtime.py` | 35 | 托管 llama.cpp 端点（aux/回退解析） |
| `agent/auxiliary_managed_local.py` | 44 | 判定"哪个端点是本 Hermes 管的 llama-server" |
| `agent/auxiliary_wire.py` | 33 | 解析出的客户端边界上的消息卫生 |
| `agent/auxiliary_async_rebuild.py` | 42 | sync → async 客户端重建时携带凭据与配置头 |
| `agent/auxiliary_codex_response.py` | 55 | Codex Responses → chat.completions 的 aux 侧归一化 |
| `agent/auxiliary_call_outcome.py` | 60 | 一次逻辑调用的结局（Relay `hermes.logical_llm_call` 作用域） |

模块头（auxiliary_client.py:1-7）把自动链背得滚瓜烂熟：

> Text auto chain: main provider+model → OpenRouter → Nous Portal → custom endpoint →
> native Anthropic → direct API-key providers → None. Vision auto chain: main
> provider (if a supported vision backend) → OpenRouter → Nous → Anthropic → custom.
> ``auxiliary.free_only`` restricts the OpenRouter lane to ``:free`` SKUs. **Codex OAuth is
> in neither chain** (undocumented, shifting allow-list): main provider or explicit
> ``auxiliary.<task>.provider`` only. HTTP 402 in call_llm() falls through the chain.

---

## 关键代码走读

### 1. `_resolve_auto_route` —— 三级自动路由阶梯（auxiliary_client.py:4568）

```
(1) 主 provider + 主模型
    "auto" = 副任务也用我的主模型（每任务显式覆盖仍然赢）
        │ 失败/不可用
        ▼
(2) 配置的回退策略
    auxiliary.<task>.fallback_chain → 主 agent 顶层 fallback_chain
        │ 没配置或不可用
        ▼
(3) 发现链（仅当无策略且主客户端不工作）
    OpenRouter → Nous → custom → Codex → API-key providers
        │ 全灭
        ▼
    (None, None, "") —— 压缩/标题/记忆全部停摆，日志点名怎么配
```

```python
# agent/auxiliary_client.py:4568-4593
def _resolve_auto_route(
    main_runtime: Optional[dict[str, Any]] = None, task: Optional[str] = None
) -> tuple[Optional[OpenAI], Optional[str], str]:
    """Full auto-detection chain, including the selected provider identity. Priority: (1) main provider +
    main model, regardless of provider type ("auto" means "my main model for side tasks too"; explicit
    per-task overrides still win); (2) configured fallback policy — task chain, then the main agent's
    top-level chain; (3) OpenRouter → Nous → custom → Codex → API-key providers, only with no policy
    and no working main client."""
    runtime = _normalize_main_runtime(main_runtime)
    _warn_stale_openai_base_url(runtime.get("provider", ""))
    main_provider, main_model, base_url, api_key, api_mode = _main_route_target(runtime, task)
    routed = _try_main_provider_route(main_provider, main_model, base_url, api_key, api_mode)
    if routed is not None:
        return routed
    if task:
        fb_client, fb_model, fb_label = _try_configured_fallback_chain(
            task, main_provider or "auto", reason="main provider unavailable")
        if fb_client is not None:
            return fb_client, fb_model, _fallback_provider_from_label(fb_label)
    fb_client, fb_model, fb_label = _try_main_fallback_chain(
        task, main_provider or "auto", reason="main provider unavailable")
    if fb_client is not None:
        return fb_client, fb_model, fb_label
    if not _discovery_chain_allowed(main_provider, task):
        return None, None, ""
    return _try_discovery_chain()
```

第三级 `_try_discovery_chain`（:4544-4565）自带健康过滤：跳过被标记不健康的 provider，
并把试过的每个候选记进日志；全灭时给一句可操作的告警——"Set OPENROUTER_API_KEY or
configure a local model in config.yaml"，且明说后果（压缩/摘要/记忆刷新不会工作）。

### 2. `resolve_provider_client` —— 唯一入口（auxiliary_client.py:5311）

```python
# agent/auxiliary_client.py:5300-5305 + 5311-5317（节选）
# Centralized Provider Router: resolve_provider_client() is the single entry point for building a configured
# client (auth, base URL, headers, API format) from (provider, model). Never read auth env vars ad-hoc.


def resolve_provider_client(
    provider: str, model: str | None = None, async_mode: bool = False, raw_codex: bool = False,
    explicit_base_url: str | None = None, explicit_api_key: Optional[str | Callable[[], str]] = None,
    api_mode: str | None = None, main_runtime: Optional[dict[str, Any]] = None, is_vision: bool = False,
    task: Optional[str] = None,
) -> tuple[Optional[Any], Optional[str]]:
```

注释里那句大写是铁律：**Never read auth env vars ad-hoc**——auth、base URL、headers、
API 格式全部从这里出。provider 可以是内置名、`custom:<name>`、"custom"（OPENAI_BASE_URL
+ OPENAI_API_KEY）或 "auto"（完整自动链）。返回的客户端**永远暴露
`.chat.completions.create()`**——Codex/Responses/Anthropic/Bedrock/Gemini provider 得到
的是适配器客户端（`CodexAuxiliaryClient`、`AnthropicAuxiliaryClient`…），副任务世界
内部只有一种方言。

模型解析的优先级写在 :5335-5353 的长注释里：caller 的 `model` → provider 目录默认
（`ProviderProfile.default_aux_model`）→ config.yaml 的主模型。注释特别点出
**`auto` 故意不预填**——预填一个过期主模型 slug 会把 Claude 模型发到 Codex OAuth 上
（#31845 的教训）；OAuth provider 用户配置的主模型必须胜过 Step-2 回退，否则 xai-oauth
用户的标题生成会静默掉到随便什么便宜模型。

### 3. `_relay_*` —— 每次物理尝试的漏斗（auxiliary_client.py:2612）

每个 aux 物理尝试（重试、恢复档、回退在内）都要过三个 relay 之一：

```python
# agent/auxiliary_client.py:2612-2648（节选）
def _relay_sync_completion(
    client: Any, kwargs: dict[str, Any], *, provider: str | None = None,
    api_mode: str | None = None, create: Callable[[dict[str, Any]], Any] | None = None,
) -> Any:
    from agent.auxiliary_wire import prepare_chat_messages, relay_chat_metadata

    kwargs = prepare_chat_messages(client, kwargs)
    # The progress hook is installed per TASK, so every attempt (retries, recovery rungs, fallbacks)
    # must stream through _create_with_progress or the compression watchdog sees silence (#98466).
    relay_context = _RELAY_AUX_CALL_CONTEXT.get() or {}
    task = relay_context.get("task")
    relay_context["stream_provider"] = provider or relay_context.get("provider")
    callback = create or (lambda request: _create_with_progress(client, request, task))
    route = _relay_auxiliary_metadata(provider=provider, api_mode=api_mode)
    ...
    try:
        return run_with_aux_hooks(
            lambda: relay_llm.execute_current(
                kwargs, lambda request: _run_protected_sync_provider_call(callback, request),
                name=provider_name, model_name=model_name, metadata=relay_chat_metadata(metadata),
                defer_logical_completion=True,
            ),
            aux_task=..., metadata=..., client=client, kwargs=kwargs,
            provider=provider_name, model=model_name, api_mode=...,
        )
    except Exception as exc:
        _note_relay_auxiliary_error(exc)
        raise
```

三件套 `_relay_sync_completion`（:2612）/`_relay_async_completion`（:2651）/
`_relay_sync_stream`（:2681）是同一漏斗的同步/异步/流式变体：先 `prepare_chat_messages`
（auxiliary_wire 的边界卫生），再包进 `run_with_aux_hooks`（插件事件对）与
`relay_llm.execute_current`（Relay 逻辑调用作用域）。两条注释值得记：progress hook
按 **task** 安装，所以任何重试/回退路径都必须从 `_create_with_progress` 走，否则压缩
看门狗把正常工作误判为静默（#98466）；`_run_protected_sync_provider_call` 只隔离
provider 回调——硬取消时拥有线程能正常解卷租约/DB 事务，共享客户端不受影响。

### 4. hooks 对 —— 为什么主循环钩子不得对 aux 触发（auxiliary_hooks.py:1-12）

```python
# agent/auxiliary_hooks.py:1-12（模块 docstring）
"""Plugin events for auxiliary LLM calls (#79733).

``pre_auxiliary_call`` / ``post_auxiliary_call`` fire once per physical provider attempt at the
relay boundary of ``agent.auxiliary_client`` — the funnel every auxiliary task (titling,
compression, MoA advisors/aggregator, vision, approval, ...) shares, retries and fallbacks
included — carrying the ``pre_api_request`` / ``post_api_request`` payload shape plus
``aux_task``. They are deliberately DISTINCT events: the main-loop ``*_api_request`` events stay
turn-scoped, so observability plugins keyed on turn identity never see auxiliary traffic unless
they subscribe to these. Observer-only (returns ignored) and fail-open: a raising or hung
callback is logged and the auxiliary call proceeds untouched.
"""
```

这是刻意的**双事件体系**：主循环的 `pre_api_request`/`post_api_request` 事件是
turn-scoped 的——按 turn 身份键控的可观测插件绝不该看到副任务流量，除非它明确订阅
`*_auxiliary_call`。aux 对携带与主事件相同的载荷形状外加 `aux_task`，每次**物理**尝试
发一对（重试和回退各有各的对）。两条安全阀：observer-only（返回值被忽略，调用结果
不许依赖观察者），fail-open（抛异常/挂起的回调只记日志，aux 调用照常进行）。

`_fire`（:197-206）与 `run_with_aux_hooks`（:236-249）落实这两条；`_parent_turn_identity`
（:13-30）把主 turn 的 session/task/turn/platform 带上（无 turn 的调用者——cron、网关
空闲工作——得到空串）。流式响应**未消费**就交还（MoA 门面负责重组），post 载荷里没有
usage/finish_reason，由 `streaming=True` 解释（:159-163）。

### 5. 每任务 pin —— config.yaml 的 auxiliary: 段（auxiliary_task_config.py:45）

```yaml
# config.yaml（示意）
auxiliary:
  titles:
    provider: openrouter
    model: openai/gpt-4.1-mini
  compression:
    provider: auto            # 跟主模型
  vision:
    provider: nous            # Portal 的 tier 感知视觉推荐
  embedding:
    provider: custom:local-embed
  session_search:
    model: gpt-4.1-mini
  curator:
    fallback_chain: [nous, openrouter]
```

```python
# agent/auxiliary_task_config.py:45-56 + 94-95（节选）
def _get_auxiliary_task_config(task: str, _seen: frozenset = frozenset()) -> dict[str, Any]:
    """Config dict for auxiliary.<task>, or {} when unavailable. Plugin-registered tasks get their
    declared defaults layered under user config (user wins); built-in defaults live in DEFAULT_CONFIG.
    A task registered with ``inherit_from`` is resolved here, at read time, over the base task's
    effective config, so it follows the base's current settings (and the active profile's config)
    until the user pins a route on the task itself. ``_seen`` guards re-registration cycles."""
    if not task:
        return {}
    config = _task_config(str(task), _seen)
    if getattr(task, "route_authoritative", False):
        return {key: value for key, value in config.items() if key not in _AUX_ROUTE_KEYS}
    return config

# The fields that together pick WHERE a call goes. They travel as one unit: a provider pinned on an
# inheriting task must never pick up the base's base_url/api_key (that would send one vendor's key
# to another's endpoint).
_AUX_ROUTE_KEYS = frozenset({"provider", "model", "base_url", "api_key", "api_mode", "key_env",
                             "api_key_env", "reasoning_effort"})
```

三个设计点：

1. **读时解析**：`inherit_from` 在读取时解析到基础任务的**当前**生效配置——基础任务
   改了路由，继承任务跟着走，直到用户给自己 pin 了路由。`_seen` 防注册环。
2. **路由键是原子单位**（:91-95）：provider/model/base_url/api_key/api_mode/key_env/
   api_key_env/reasoning_effort 一起旅行——继承任务 pin 了 provider 却继承 base 的
   base_url/api_key，等于把一家的 key 发到另一家的端点。
3. **`route_authoritative`**（:32-42）：一次性回退若点名了完整路由，则剥离路由键——
   绝不继承刚失败那条路由的未清空 endpoint/key（#113322、#130895）。

`_layer_over_inherited`（:98-110）再补一层语义：picker/重置/面板持久化的
`provider: auto` + 空串是"跟随基础"而不是"覆盖为无"；一旦 pin 了路由（非 auto
provider、非空 model 或 base_url），**整条路由**都来自任务自己的块。

### 6. 恢复体系 —— 限流退避、流看门狗、参数恢复

aux 调用每 provider 只试一次（OpenAI SDK `max_retries=0`、botocore
`total_max_attempts: 1`），恢复阶梯自己掌握等待：

```python
# agent/auxiliary_rate_limit_backoff.py:1-8 + 16-24（节选）
"""Same-credential backoff for an auxiliary call refused by a rate limit (429, Bedrock throttle).

Auxiliary clients make one attempt per call (OpenAI SDK ``max_retries=0``, botocore
``total_max_attempts: 1``), so the recovery ladder owns the wait. An immediate re-send lands in the
same throttle window and spends the retry, then credential rotation and the provider fallback chain
see a provider that would have answered a moment later. The ladder yields a ``wait`` step; the sync
and async ladder drivers sleep it, so both caller kinds share one schedule."""

RATE_LIMIT_RETRIES = 1
RATE_LIMIT_BACKOFF_BASE = 1.0
RATE_LIMIT_BACKOFF_CAP = 4.0
# A provider-declared cooldown longer than this is not worth sitting through inside an auxiliary
# call (compression, titles, summaries): rotate or fall back instead.
RATE_LIMIT_RETRY_AFTER_CAP = 5.0
```

流式这边，消费者阻塞在 SDK 的 chunk 迭代器里，静默流要等 httpx 读超时（压缩的完整
预算 ≥300s）才被发觉——宿主的压缩等待先放弃，这次尝试死于无回退。看门狗的窗口由一个
Timer 执行，且**只 shutdown 本次尝试的 socket**（FD 安全， stranger 线程可执行，
:1-8 docstring）：唤醒拥有者的阻塞读，拥有者仍在自己的 finally 里关流，让连接池丢弃
而不是回收死连接（#100501、#70773）。`ChatStreamWatchdog`（:45）只被**实质性 chunk**
重置；首个 token 前的静默由 first_token_window 界定（推理模型会静默思考数分钟），窗口
跑在 awake 时钟上——电脑睡眠的时间不计。

其余恢复件各就各位：`auxiliary_fallback_recovery.py` 把回退候选请求里被拒绝的参数
剥掉再试；`auxiliary_reasoning_floor.py` 处理"路由拒绝关推理"——改为**升档**而不是
硬来；`auxiliary_structured_output.py` 记住哪个路由拒 `response_format`，下次按
`_route_key` 直接省略；`auxiliary_error_shapes.py` 是这些机制共用的错误形态读取器
（SDK 错误的 HTTP 状态在哪、HTTP-200 畸形响应/SSE error 事件这类无状态失败如何终结
一条路由）；`auxiliary_unavailable.py` 记住最近一次 Nous 凭据失败的细节（`_quarantined_nous_error`
优先用池里持久化的终态隔离标记——池清理死 token 后，resolver 只能说"No access token
found"，真正死因 `invalid_grant` 只在标记里，#42177），并对每条不同消息只告警一次。

### 7. 客户端家族与异步重建

`resolve_provider_client` 返回的客户端是多态家族：`_to_async_client`（:4608-4652）展示
了完整清单——`CodexAuxiliaryClient`→Async 版、`AnthropicAuxiliaryClient`、
`BedrockAuxiliaryClient`、`GeminiNativeClient`、ACP shim（子进程，天然 async 安全，
`HERMES_SKIP_ASYNC_WRAP` 跳过包装）、其余重建为 AsyncOpenAI。重建时最容易踩的坑在
`auxiliary_async_rebuild.py`：key_cmd/Entra 客户端的凭据在 SDK 的 per-request provider
槽里而非 `.api_key`（保持空串），只从快照重建会**一个 Authorization 头都不带**
（#109595）；配置的 `default_headers` 也要按 SDK 的合并顺序带过去。

`call_llm`（:7905-7946）是最外层入口：先拿任务的并发信号量（排队时间记进
latency_info），包上 `scoped_runtime_main`（一次不可变运行时快照——并发 `/model` 切换
不可能把不同 runtime 的 key 和 client 混进一次调用），流式时信号量**延迟到流被消费或
关闭**才释放（`_release_sync_semaphore_after_stream`，:7949-7961）。

---

## 核心类/函数

| 符号 | 职责 | 位置 |
|---|---|---|
| `call_llm` | aux 调用最外层：任务信号量、runtime 快照、延迟计时 | `agent/auxiliary_client.py:7905` |
| `acall_llm` | 异步孪生入口 | `agent/auxiliary_client.py` |
| `_resolve_auto_route` | 三级自动路由阶梯（主模型 → 配置回退 → 发现链） | `agent/auxiliary_client.py:4568` |
| `_try_main_provider_route` | 第 1 级：主 provider+model | `agent/auxiliary_client.py:4481` |
| `_try_configured_fallback_chain` | 第 2 级：任务链 → 主链 | `agent/auxiliary_client.py:4292` |
| `_try_main_fallback_chain` | 主 agent 顶层回退链 | `agent/auxiliary_client.py:4378` |
| `_try_discovery_chain` | 第 3 级：健康过滤的发现链（OR→Nous→custom→Codex→API-key） | `agent/auxiliary_client.py:4544` |
| `resolve_provider_client` | 构建配置客户端的**唯一入口**（auth/base_url/headers/api format） | `agent/auxiliary_client.py:5311` |
| `_relay_sync_completion` / `_relay_async_completion` / `_relay_sync_stream` | 每次物理尝试的漏斗（wire 卫生 + hooks + Relay） | `agent/auxiliary_client.py:2612,2651,2681` |
| `CodexAuxiliaryClient` / `AnthropicAuxiliaryClient` / `BedrockAuxiliaryClient` | 多态客户端家族（对外统一 chat.completions） | `agent/auxiliary_client.py` |
| `_to_async_client` | sync→async 重建（凭据槽、头合并、家族分派） | `agent/auxiliary_client.py:4608` |
| `PRE_AUXILIARY_CALL` / `POST_AUXILIARY_CALL` | aux 插件事件名（每次物理尝试一对） | `agent/auxiliary_hooks.py:17,18` |
| `run_with_aux_hooks` / `arun_with_aux_hooks` | 一次尝试包进事件对（fail-open、observer-only） | `agent/auxiliary_hooks.py:236,253` |
| `start_aux_call_hooks` / `finish_aux_call_hooks` | 自己驱动 provider 调用的 caller 用的一对 | `agent/auxiliary_hooks.py:209,223` |
| `_get_auxiliary_task_config` | `auxiliary.<task>` 读时解析（插件默认层叠、inherit_from） | `agent/auxiliary_task_config.py:45` |
| `AuthoritativeAuxiliaryTask` | 剥路由键的任务名（一次性回退不继承失败路由） | `agent/auxiliary_task_config.py:32` |
| `AuxiliaryClientUnavailable` | "建不出客户端"的类型化错误（带 Nous 死因记忆） | `agent/auxiliary_unavailable.py:24` |
| `rate_limit_wait` / `rate_limit_retry_after` | 同凭据退避表与 Retry-After 读取 | `agent/auxiliary_rate_limit_backoff.py` |
| `ChatStreamWatchdog` | 流式无进展看门狗（只关本尝试 socket、awake 时钟） | `agent/auxiliary_stream_watchdog.py:45` |
| `remember_structured_output_rejection` / `_without_structured_output_format` | 结构化输出能力记忆 | `agent/auxiliary_structured_output.py` |
| `remember_reasoning_floor` / `with_reasoning_floor` | 推理下限记忆与执行 | `agent/auxiliary_reasoning_floor.py` |

## 本组文件清单

| 文件 | 一句话角色 |
|---|---|
| `agent/auxiliary_client.py` | 中心路由器：call_llm、三级 auto 阶梯、resolve_provider_client 唯一入口、relay 漏斗 |
| `agent/auxiliary_async_rebuild.py` | sync→async 重建携带凭据槽与配置头（#109595） |
| `agent/auxiliary_call_outcome.py` | 一次逻辑调用的结局（Relay logical_llm_call 作用域） |
| `agent/auxiliary_client_registry.py` | auxiliary registry 分支的 `auth_type` 分派表 |
| `agent/auxiliary_codex_response.py` | Codex Responses → chat.completions 的 aux 归一化 |
| `agent/auxiliary_error_shapes.py` | 错误形态读取（HTTP 状态位、无状态失败终结路由） |
| `agent/auxiliary_fallback_recovery.py` | 回退候选的参数拒绝恢复 |
| `agent/auxiliary_health.py` | 自定义 provider 健康检查端点身份 |
| `agent/auxiliary_hooks.py` | pre/post_auxiliary_call 事件对（distinct、observer-only、fail-open） |
| `agent/auxiliary_key_rotation.py` | 凭据刷新后轮转已发布的 main-runtime key |
| `agent/auxiliary_local_runtime.py` | 托管 llama.cpp 端点解析 |
| `agent/auxiliary_managed_local.py` | 判定本 Hermes 管的 llama-server |
| `agent/auxiliary_plugin_oauth.py` | OAuth 型 model-provider 插件的 aux 客户端 |
| `agent/auxiliary_rate_limit_backoff.py` | 429/节流的同凭据退避（一次重试 + 抖动指数表） |
| `agent/auxiliary_reasoning_floor.py` | 路由拒关推理时升档而非硬来 |
| `agent/auxiliary_stream_watchdog.py` | 流式无进展看门狗（Timer 只关本 socket） |
| `agent/auxiliary_structured_output.py` | response_format 拒绝的按路由记忆 |
| `agent/auxiliary_task_config.py` | `auxiliary.<task>` 读时解析（pin、继承、路由键原子性） |
| `agent/auxiliary_unavailable.py` | 建不出客户端的原因记忆与一次性告警（Nous 死因） |
| `agent/auxiliary_wire.py` | 解析出的客户端边界上的消息卫生 |

## 与其他模块的关系

```
副任务调用方（压缩 / 标题 / 视觉 / embedding / 会话搜索 / curator / MoA / 审批）
        │  call_llm(task=..., messages=...)
        ▼
auxiliary_client.call_llm ──► auxiliary_task_config（auxiliary.<task> pin / 回退链 / 超时）
        │
        ▼
_resolve_auto_route ──► resolve_provider_client（唯一入口）
        │                    ├──► providers/ get_provider_profile（default_aux_model）
        │                    └──► credential_pool / anthropic_credentials（凭据）
        ▼
_relay_sync/_async/_stream ──► auxiliary_wire（边界卫生）+ relay_llm（逻辑调用作用域）
        │                  └──► auxiliary_hooks（pre/post_auxiliary_call 插件事件）
        ▼
恢复阶梯：rate_limit_backoff → fallback_recovery → fallback_chain → aux_unavailable 上抛
```

- **消费方**：`context_compressor*.py`（压缩摘要）、`title_generator.py`、
  `vision_message_prep.py`、`side_question.py`、curator/`skills_index_delta.py`、
  MoA（`agent_init.py::_init_moa_client`）、审批与 goal judge。
- **凭据层**：池轮转/冷却在 `credential_pool.py`、Nous 密钥在 `anthropic_credentials.py`
  ——见 credentials_rate.md；`auxiliary_key_rotation.py` 在刷新后把新 key 发布回
  main-runtime。
- **观测**：`api_request_hooks.py` 的主循环事件与这里的事件对**互不越界**——turn-scoped
  插件看不到 aux 流量，除非订阅 `*_auxiliary_call`。
- **传输层复用**：Codex 头部/端点判定 import 自 `codex_headers.py`（叶子模块，见
  codex_runtime.md）；`auxiliary_codex_response.py` 与主传输共享 `_cache_scope_from_session_id`。

## 总结

- **副任务宇宙只有一个漏斗**：`call_llm` → 任务配置 → `_resolve_auto_route` 三级阶梯 →
  `resolve_provider_client`（唯一入口，"Never read auth env vars ad-hoc"）→ relay 漏斗。
  返回的客户端对外统一 `chat.completions.create()`，协议差异被家族适配器吃掉。
- **路由三级语义分明**：主模型优先（"auto = 副任务也用主模型"）、配置回退其次、发现链
  兜底（健康过滤 + 可操作告警）；Codex OAuth 因允许列表漂移**永远不进自动链**。
- **每任务 pin 是原子的**：路由键（provider/model/base_url/api_key/api_mode/key_env/
  reasoning_effort）作为一个单位旅行，继承任务的 provider 绝不配别家的 endpoint；
  `route_authoritative` 让一次性回退不继承失败路由的残骸。
- **事件双体系是刻意的**：`pre/post_auxiliary_call` 与主循环 `*_api_request` 形状相同
  但 distinct——turn-scoped 可观测插件看不到副任务流量；observer-only + fail-open，
  aux 结果不依赖任何观察者。
- **恢复阶梯替 SDK 重试**：每 provider 一次尝试（SDK max_retries=0），限流退避一次
  重试后转凭据轮转/回退链；流看门狗只关本次 socket、awake 时钟、实质性 chunk 才重置。
- **错误也是要记住的**：Nous 凭据死因、结构化输出拒绝、推理下限、回退参数拒绝——
  按路由/消息记忆，宁可升档与绕行，不硬撞墙。
