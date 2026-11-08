# model_providers.md — provider 体系：声明式 Profile、api_mode 路由与传输层

## 文件概览

Hermes 要跟几十家推理服务商对话，每家的"方言"都不一样：OpenAI 走 Chat Completions /
Responses，Anthropic 走 Messages，AWS 走 Bedrock Converse，还有插件自带 dialect。这套体系
分三层，各管一件事：

| 层 | 目录/文件 | 职责 | 绝不碰的事 |
|---|---|---|---|
| **声明层** | `providers/`（3 文件）+ `plugins/model-providers/`（38 个插件） | ProviderProfile 声明 auth、endpoint、quirks | 不建 client、不转凭据、不做流式 |
| **路由层** | `agent/agent_init.py`（`_resolve_api_mode`/`_finalize_routing`/`_build_client`） | 决定这次会话说哪种 api_mode、用哪个 client | 不做消息/工具格式转换 |
| **数据层** | `agent/transports/`（11 文件） | 一个 api_mode 的四步数据路径 | 不管 client 生命周期、流式、凭据、缓存 |

`transports/base.py:1-4` 的模块 docstring 把边界写得非常直白：

> A transport owns one api_mode's data path (convert_messages -> convert_tools -> build_kwargs
> -> normalize_response), NOT client construction, streaming, credentials, caching, interrupts
> or retries — those stay on AIAgent.

这层边界是本组文件共同的宪法。下文按"路由 → client → 数据转换 → profile 声明 →
插件接入"的顺序走读。

---

## 关键代码走读

### 1. `_resolve_api_mode` —— 有序阶梯，先到先得（agent_init.py:277）

初始化时第一个路由问题："这个 agent 说哪种 api_mode？"答案由一条**有序阶梯**给出，
第一个命中的分支获胜：

```python
# agent/agent_init.py:271-274 + 277-292 + 296-325（节选）
_EXPLICIT_API_MODES = {
    "chat_completions", "codex_responses", "anthropic_messages", "bedrock_converse",
    "codex_app_server",
}

def _resolve_api_mode(agent, api_mode, provider_name, base_url):
    """Set ``agent.api_mode`` (and provider rewrites) — ordered ladder, first match wins."""
    from hermes_cli.providers import is_actual_route
    from agent.transports import registered_api_modes
    host, url = agent._base_url_hostname, agent._base_url_lower
    if is_actual_route(agent.provider, base_url):
        agent.api_mode = "chat_completions"
    elif api_mode in _EXPLICIT_API_MODES or (api_mode and api_mode in registered_api_modes()):
        # A provider plugin's own dialect (``register_transport(api_mode, cls)``) is as explicit
        # as the in-tree modes; rewriting it to chat_completions silently dropped its transport.
        agent.api_mode = api_mode
    elif agent.provider in {"openai-codex", "xai", "xai-oauth"}:
        agent.api_mode = "codex_responses"
    elif agent.provider == "anthropic" or (provider_name is None and host == "api.anthropic.com"):
        agent.api_mode = "anthropic_messages"; agent.provider = "anthropic"
    elif url.rstrip("/").endswith("/anthropic"):
        # Third-party Anthropic-compatible endpoints (MiniMax, DashScope) end in /anthropic.
        agent.api_mode = "anthropic_messages"
    elif agent.provider == "bedrock" or (
        host.startswith("bedrock-runtime.") and base_url_host_matches(url, "amazonaws.com")):
        agent.api_mode = "bedrock_converse"
    elif agent.provider in {"nous", "nous-portal", "nousresearch"}:
        from hermes_cli.providers import nous_api_mode
        agent.api_mode = nous_api_mode(agent.model)   # Portal 双线：anthropic/* 或 chat_completions
    else:
        ...
        agent.api_mode = _mandated if _mandated is not None else "chat_completions"   # :325
```

四个要点：**显式配置第一**——用户/插件明确给出的 api_mode 永远赢，
`registered_api_modes()`（transports/\_\_init\_\_.py:44）判断前先发现，插件用
`register_transport(api_mode, cls)` 注册的自有 dialect 与内置模式同等显式（教训写在注释里：
早期把插件 mode 重写成 chat_completions，方言翻译被静默丢弃）。**provider slug 次之、
host 检测再次**——名字没给时退化到 URL 探测（`chatgpt.com/backend-api/codex`、
`api.anthropic.com`、`bedrock-runtime.*`、以 `/anthropic` 结尾的兼容端点、
`nous_api_mode` 双线判定）。**URL 驱动是设计**：最后的 else 调
`host_mandated_api_mode(base_url)`，注释明说 Meta 按名字强推会打爆指向别处的自定义端点
（#63425）。**默认值是 `chat_completions`**——一切不命中落回 OpenAI 兼容方言。

### 2. `_finalize_routing` —— 定案后的四件收尾（agent_init.py:328）

```python
# agent/agent_init.py:328-346（节选）
def _finalize_routing(agent, api_mode, credential_pool):
    from hermes_cli.providers import is_actual_route
    # Credential-pool validation runs AFTER provider auto-detection so a pool scoped to
    # "anthropic" isn't rejected for provider=None + anthropic.com URL.
    # Regression from #63048 which placed this check before the URL-based auto-detection block above (fixed
    # #63425).
    if credential_pool is not None:
        try:
            from agent.credential_pool import credential_pool_matches_provider
            if not credential_pool_matches_provider(
                credential_pool, agent.provider, base_url=agent.base_url,
            ):
                agent._credential_pool = None
        except Exception:
            agent._credential_pool = None

    # Warm the transport cache so import errors surface at init (non-fatal: some modes lack one).
    with suppress(Exception):
        agent._get_transport()
```

- **凭据池校验必须在 provider 自动检测之后**（:334-342）：#63048 曾把校验放前面，
  `provider=None` + anthropic.com URL 的池被误拒（#63425 修复）。不匹配就静默清空
  池——宁可不用池也不能用错池。
- **transport 预热**（:344-346）：init 摸一次 `_get_transport()`，import 错误在构造期
  暴露，而不是第一个 turn 半路上炸。
- **模型名归一**（:359-370）：非聚合器 provider 做 `normalize_model_for_provider`；Nous
  再按路由 `pin_model_for_route`（凭据池换路由时 `_swap_credential` 重新套用）。
- **GPT-5.x 自动升级 Responses**（:379-401）：api_mode 未显式指定且模型要求 Responses
  （或直连 OpenAI URL）时升到 `codex_responses`，并**清空已预热的 transport 缓存**；
  ACP 客户端（`acp://`）与 Azure OpenAI 显式豁免——Azure 的 gpt-5.x 只有
  /chat/completions。

### 3. `_build_client` —— 按 wire mode 建客户端（agent_init.py:929）

```python
# agent/agent_init.py:929-942
def _build_client(agent, api_key, base_url, fallback_model):
    # LLM client per wire mode (raw_codex=True: the main agent needs direct
    # responses.stream()). One provider/model timeout up front so every path applies it.
    agent._anthropic_client = None
    agent._is_anthropic_oauth = False
    _provider_timeout = get_provider_request_timeout(agent.provider, agent.model)
    if agent.api_mode == "anthropic_messages":
        _init_anthropic_client(agent, api_key, base_url, _provider_timeout)
    elif agent.provider == "moa":
        _init_moa_client(agent, api_key)
    elif agent.api_mode == "bedrock_converse":
        _init_bedrock_client(agent, base_url)
    else:
        _init_openai_client(agent, api_key, base_url, fallback_model, _provider_timeout)
```

四个分支对应四种 client：Anthropic SDK（OAuth/API key 双认证）、MoA 聚合门面、boto3
Bedrock（走 AWS 凭据链，无 API key 也能跑）、默认 OpenAI 兼容 client。
`_init_openai_client`（:890-926）里两步值得注意：custom provider 的 TLS/extra_headers
最后套用（"most specific config level wins"，且注释强调 header 值可能带凭据**绝不打
日志**）；`agent._client_kwargs` 存下来供中断后重建 client 复用。

### 4. `ProviderTransport` ABC —— 四步数据路径（transports/base.py:12）

```
        OpenAI 形态（agent 主循环的唯一内部方言）
     messages[] + tools[] + params（reasoning/temperature…）
                        │
                        ▼
   ProviderTransport.build_kwargs(model, messages, tools, **params)
        ├─① convert_messages()   OpenAI 消息 → provider 原生结构
        ├─② convert_tools()      OpenAI 工具 schema → provider 原生格式
        └─③ 组装 SDK kwargs      reasoning 钳制、extra_body、max_tokens 策略
                        │
                        ▼
        provider SDK / HTTP  ← AIAgent 持有 client、流式、凭据、重试、缓存
                        │
                        ▼
   ④ normalize_response(raw) ──► NormalizedResponse（回到 OpenAI 词汇表）
```

```python
# agent/transports/base.py:12-17 + 32-41 + 51-53（节选）
class ProviderTransport(ABC):
    """Base class for provider-specific format conversion and normalization."""

    # Provider stop_reason -> OpenAI finish_reason. ``None`` means the provider
    # already speaks OpenAI vocabulary and map_finish_reason passes through.
    _STOP_REASON_MAP: Optional[dict[str, str]] = None

    @abstractmethod
    def build_kwargs(
        self, model: str, messages: list[dict[str, Any]],
        tools: Optional[list[dict[str, Any]]] = None, **params,
    ) -> dict[str, Any]:
        """Primary entry point: convert messages/tools and return kwargs ready for the provider SDK."""

    @abstractmethod
    def normalize_response(self, response: Any, **kwargs) -> NormalizedResponse:
        """Normalize a raw provider response to NormalizedResponse (the only transport-layer return type)."""

    def map_finish_reason(self, raw_reason: str) -> str:
        return raw_reason if self._STOP_REASON_MAP is None else self._STOP_REASON_MAP.get(raw_reason, "stop")
```

四个 `@abstractmethod`（`api_mode`/`convert_messages`/`convert_tools`/`build_kwargs`/
`normalize_response`）是硬合同；`validate_response` / `extract_cache_stats` /
`map_finish_reason` 是可选挂件。返回类型收敛到 `types.py` 的 `NormalizedResponse`——
协议专属状态（Codex 的 reasoning items、Anthropic 的有序签名块）塞进 `provider_data`
字段，不拓宽共享类型。

### 5. 四个内置 transport 的分工

- **chat_completions.py（804 行，默认）**：消息/工具本来就是 OpenAI 形态，convert 是
  近恒等；真功夫在 build_kwargs 的每 provider 钳制——Moonshot 工具 schema 消毒、
  reasoning effort 钳制、xAI 保留名 `tool_search` 改名 `hermes_tool_search` 再映射回来
  （:35，HTTP 400 "reserved for the tool_search tool"，#95003）、把持久化专用键从消息
  里剥掉防 400（:39-47）。还有个防御：某些路由器把上游超时伪装成 HTTP 200 + 哨兵文案
  （`is_router_timeout_shim`，:136，#68396）——只有"精确哨兵 + 无 tool_calls + 无正
  completion_tokens"才判假成功，真说了这些话的模型凭 usage 证据保住自己。
- **anthropic.py（137 行，薄壳）**：转换全部委托 `anthropic_adapter.py` /
  `anthropic_message_convert.py`，自己只做 normalize——解析 content blocks、映射
  stop_reason、收集 reasoning_details。微妙处（:70-100）：Anthropic 对每个 thinking 块
  按**前序块**签名，thinking 与 tool_use 交错时平行列表丢序、重放 HTTP 400——此时额外
  携带 `anthropic_content_blocks`（有序块通道）。
- **bedrock.py（89 行，薄壳）**：委托 `bedrock_adapter.py`，boto3 client 归 AIAgent。
  build_kwargs 塞两个哨兵键（`__bedrock_converse__`/`__bedrock_region__`，:50-51）给
  分发器识别，boto3 调用前由 agent pop 掉。
- **codex.py（977 行）**：OpenAI Responses API，负责 prompt_cache_key 内容寻址、
  effort 钳制、保留名别名——详见 codex_runtime.md。

### 6. codex_app_server —— 整个 turn 搬进子进程（transports/codex_app_server.py:83）

第五种 api_mode `codex_app_server` 不走 HTTP：把 OpenAI 的 `codex app-server` CLI 当
模型运行时，stdio 上的 newline-delimited JSON-RPC 2.0 驱动——`initialize` 握手 →
`thread/start` + `turn/start` → 流式 `item/*` 通知直到 `turn/completed`（docstring :1-6）。
Hermes 只当"线级说话者"，投影/审批/转录在兄弟模块。

```python
# agent/transports/codex_app_server.py:83-89
class CodexAppServerClient:
    """Minimal synchronous JSON-RPC 2.0 client for ``codex app-server`` over stdio.

    One reader thread routes replies to pending queues and notifications / server
    requests to queues; another captures stderr. Deliberately NOT async:
    AIAgent.run_conversation() is synchronous and cancels via ``turn/interrupt``.
    """
```

两个安全细节：spawn 环境走 `hermes_subprocess_env(inherit_credentials=True)`（:105）——
codex 需要 LLM provider 凭据认证模型端点，但旧实现 `os.environ.copy()` 把 Tier-1
Hermes 秘密（网关 bot token、GitHub auth、基础设施 token）也交出去了，现在集中剥离；
崩溃清理用 psutil 快照后代进程再 TERM→KILL（:62-80），防 PID 复用误杀。配套的
`hermes_tools_mcp_server.py` 把**策展过的** Hermes 工具子集经 MCP 暴露给 codex
（codex 在那边拥有 loop 和工具列表；`EXPOSED_TOOLS` :57-67 明确排除 terminal/file/
search——codex 自带，也排除 delegate_task/memory——需要活的 AIAgent 上下文）。

### 7. providers/ —— 声明式 ProviderProfile 与懒发现（providers/base.py:141）

"20+ 布尔旗标在函数签名里飞"是 god-object 时代的遗产。声明层把它压成一个 dataclass：

```python
# providers/base.py:1-9 + 141-149 + 161-171（节选）
"""Provider profile base class.

A ProviderProfile declares everything about an inference provider in one place:
auth, endpoints, client quirks, request-time quirks. The transport reads this
instead of receiving 20+ boolean flags.

Provider profiles are DECLARATIVE — they describe the provider's behavior.
They do NOT own client construction, credential rotation, or streaming.
Those stay on AIAgent.
"""

@dataclass
class ProviderProfile:
    """Base provider profile — subclass or instantiate with overrides."""

    # ── Identity ─────────────────────────────────────────────
    name: str
    api_mode: str = "chat_completions"
    aliases: tuple = ()
    ...
    # ── Auth & endpoints ─────────────────────────────────────
    env_vars: tuple = ()
    base_url: str = ""
    auth_type: str = "api_key"   # api_key|oauth_device_code|oauth_external|external_process|aws_sdk|plugin-defined
    supports_streaming: bool | None = field(default=None, kw_only=True)
```

字段按 Identity / Auth & endpoints / Vision / External-process / Model catalog / quirks
分节；auth_type 枚举里 `external_process` 描述"驱动一个 agent CLI over stdio（ACP）"
的形态。行为钩子可选覆写：`build_api_kwargs_extras`（:351，返回 `(extra_body_additions,
top_level_kwargs)` 二元组——OpenRouter 把 reasoning 放 extra_body，Kimi 放顶层
api_kwargs，所以拆两半）、`prepare_messages`、`resolve_aux_model`（:295，活的便宜模型
id——硬编码的 `default_aux_model` 会烂，docstring 明说这个字段 "rots"）。

一个精致的小类是 `LazyHeaders`（:45）：插件 `default_headers` 里常有一个带版本号的
User-Agent，源码 checkout 下要从 git 解析版本——若 import 时就构造，**每条 CLI 命令
都得白付几次 git 子进程**（CLI 启动会 import 所有 provider 插件）。LazyHeaders 把
callable 存起来首次读取才解析，且仍是真 dict（插件会 copy/merge/serialize 它）；解析
用 `_RESOLVE_LOCK` 防并发首读各自走一遍 git。

```python
# providers/__init__.py:3-16（模块 docstring 节选）
Provider profiles can live in three places:

1. Bundled plugins: ``plugins/model-providers/<name>/`` (shipped with hermes-agent)
2. User plugins: ``$HERMES_HOME/plugins/model-providers/<name>/``
3. Pip-installed plugins: distributions exposing a ``hermes_agent.plugins``
   entry point (``module:func`` callable or a self-registering ``module``)

Discovery is lazy: the first call to ``get_provider_profile()`` or
``list_providers()`` imports the bundled and pip-installed plugins once per
process; the ``$HERMES_HOME`` plugins of the profile home bound at lookup time
load into that home's own layer, so one process serving several profiles
(multiplex gateway, Desktop ``serve``) resolves each profile's installs.
```

发现是懒的（第一次 `get_provider_profile()` 才触发），且**每个 profile home 一层**：
`_HomeLayer`（:72-93）按查找时绑定的 `$HERMES_HOME` 分层存用户插件，目录 mtime 戳
（1 秒 TTL + FAT/HFS+ 的 2 秒粒度余量，:66-69）让 `hermes plugins install` 装完的插件
不重启进程就能被发现。同名字冲突时**last-writer-wins**：用户插件覆盖 bundled 插件。
注册目标用 ContextVar（`_REGISTRATION_TARGET`，:102）而不是模块全局——两个 turn 线程
同时扫两个 profile home 时不能交叉注册。新增 provider 的完整成本：建
`plugins/model-providers/<name>/__init__.py`（构造 ProviderProfile + `register_provider`）
+ `plugin.yaml`，README 原话 "Nothing else needs to change"——auth/config/models
自动接上。

---

## 核心类/函数

| 符号 | 职责 | 位置 |
|---|---|---|
| `_resolve_api_mode` | 有序阶梯定 api_mode（显式 → slug → host → 默认） | `agent/agent_init.py:277` |
| `_finalize_routing` | 凭据池校验、transport 预热、模型归一、GPT-5.x 升级 | `agent/agent_init.py:328` |
| `_build_client` | 按 wire mode 分派四种 client 构造 | `agent/agent_init.py:929` |
| `_init_openai_client` | OpenAI 兼容 client：kwargs + header/TLS 政策 + 构造 | `agent/agent_init.py:890` |
| `_init_anthropic_client` / `_init_bedrock_client` / `_init_moa_client` | 其余三种 client 构造 | `agent/agent_init.py:641,707,690` |
| `AIAgent._get_transport` | 按 api_mode 取（并缓存）transport 实例 | `agent/vision_message_prep.py:177` |
| `ProviderTransport` | 传输层 ABC：四步数据路径硬合同 | `agent/transports/base.py:12` |
| `register_transport` / `get_transport` / `registered_api_modes` | 传输注册表：注册、惰性发现、全模式集合 | `agent/transports/__init__.py:21,26,44` |
| `NormalizedResponse` / `ToolCall` / `Usage` | 传输层唯一返回类型的三个 dataclass | `agent/transports/types.py:61,16,46` |
| `ChatCompletionsTransport` | 默认传输：近恒等转换 + 每 provider 钳制 | `agent/transports/chat_completions.py` |
| `AnthropicTransport` / `BedrockTransport` / `CodexTransport` | 其余内置传输（薄壳委托 adapter） | `agent/transports/anthropic.py:33` 等 |
| `CodexAppServerClient` | stdio JSON-RPC 客户端（子进程 codex app-server） | `agent/transports/codex_app_server.py:83` |
| `ProviderProfile` | 声明式 provider 元数据 dataclass | `providers/base.py:141` |
| `LazyHeaders` | 首读才解析的 default_headers（省 git 子进程） | `providers/base.py:45` |
| `get_provider_profile` / `register_provider` | 懒发现入口与注册（三来源、last-writer-wins） | `providers/__init__.py` |

## 本组文件清单

| 文件 | 一句话角色 |
|---|---|
| `providers/__init__.py` | profile 注册表：懒发现三来源、per-home 层、last-writer-wins |
| `providers/base.py` | `ProviderProfile` 声明式 dataclass + `LazyHeaders` + 行为钩子 |
| `providers/README.md` | 声明层使用说明（新增 provider 三步走） |
| `agent/agent_init.py` | `_resolve_api_mode`/`_finalize_routing`/`_build_client` 路由与 client 构造 |
| `agent/transports/__init__.py` | 传输注册表：register/get/发现四模块 + 插件模式 |
| `agent/transports/base.py` | `ProviderTransport` ABC：四步数据路径合同 |
| `agent/transports/types.py` | `NormalizedResponse`/`ToolCall`/`Usage`/`map_finish_reason` |
| `agent/transports/chat_completions.py` | 默认传输：近恒等转换 + 每 provider kwargs/钳制 |
| `agent/transports/anthropic.py` | Messages 传输薄壳：委托 adapter + normalize |
| `agent/transports/bedrock.py` | Converse 传输薄壳：委托 adapter + 哨兵键 |
| `agent/transports/codex.py` | Responses API 传输（详见 codex_runtime.md） |
| `agent/transports/codex_app_server.py` | codex app-server 的 stdio JSON-RPC 客户端 |
| `agent/transports/codex_app_server_session.py` | app-server 会话边界：init/turn 生命周期、崩溃退役 |
| `agent/transports/codex_event_projector.py` | `item/*` 事件 → OpenAI 形态消息的投影 |
| `agent/transports/hermes_tools_mcp_server.py` | 把策展的 Hermes 工具经 MCP 暴露给 codex 子进程 |
| `agent/provider_base.py` | 工具型 provider（browser/search/图像…）ABC 的公共基类 |
| `agent/provider_registry.py` | `agent.*_registry` 注册表的公共引擎（含快照/恢复） |
| `agent/provider_route_hooks.py` | 按 endpoint 询问 profile 钩子（具名 provider 优先，host 兜底） |
| `agent/provider_projection.py` | agent-as-provider 的自身活动折回 Hermes turn 状态 |
| `agent/provider_media.py` | 图像/视频生成 provider 的 `$HERMES_HOME/cache/` 物化助手 |
| `hermes_cli/providers.py` | 路由判定原语：`is_actual_route`/`nous_api_mode`/`host_mandated_api_mode` |
| `agent/anthropic_adapter.py` | Messages 适配器：client 构造 + 调用（OAuth/API key 双认证） |
| `agent/anthropic_credentials.py` | Anthropic 凭据源与 OAuth 流（详见 credentials_rate.md） |
| `agent/anthropic_endpoints.py` | 12 家 Anthropic 兼容端点的纯函数判定（无 I/O） |
| `agent/anthropic_message_convert.py` | OpenAI → Messages 请求转换（块/签名/cache_control） |
| `agent/anthropic_thinking_policy.py` | 各端点的 prior-turn thinking 保留政策（单一事实源） |
| `agent/anthropic_thinking_replay.py` | 被拒签名块的持久请求级抑制（不动正史） |
| `agent/bedrock_adapter.py` | Converse 转换 + normalize + guardrail 判定（boto3） |
| `agent/gemini_native_adapter.py` | Gemini 原生 API 的 OpenAI 兼容门面（generateContent） |
| `agent/gemini_long_decode.py` | Gemini 长解码：CONTINUATION 多跳续写与 usage 合并 |
| `agent/gemini_schema.py` | Gemini 工具 schema 两种线形（JSON Schema vs OpenAPI 子集） |
| `agent/vertex_adapter.py` | Vertex AI 认证 + base URL 解析（google-auth 懒装） |
| `agent/azure_identity_adapter.py` | Microsoft Entra ID 无密钥认证（DefaultAzureCredential 链） |
| `agent/moonshot_schema.py` | Kimi 严格 JSON Schema 子集的翻译器 |
| `agent/lmstudio_reasoning.py` | LM Studio reasoning effort 词表映射与钳制 |
| `agent/nous_wire.py` | Nous Portal `anthropic/*` 双线选择（auto 时按缓存损失定） |
| `agent/chat_completion_headers.py` | 非流式 chat completions 仍把响应头喂给额度捕获 |
| `agent/backend_identity.py` | 后端同一性判定（回退/去重/隔离决策的单一所有者） |

## 与其他模块的关系

```
配置 hermes_cli/config.yaml（model/provider/providers.* 段）
        ▼
agent_init::_resolve_api_mode ──► hermes_cli/providers.py（路由判定原语）
        │                      └──► transports/registered_api_modes
_finalize_routing ──► credential_pool.py（池校验，见 credentials_rate.md）
        ▼
_build_client ──► providers/ get_provider_profile（读 profile 的 auth/quirks）
        ▼
turn 循环（turn_api_call.py）──► _get_transport() ──► build_kwargs → normalize_response
        ▼
NormalizedResponse ──► 回到主循环的 OpenAI 形态世界
```

- transport 不碰的都住在别处：client 生命周期在 `client_lifecycle.py`，流式在
  `turn_api_call.py`/`stream_*` 家族，凭据在 `credential_pool.py`，缓存键在
  `prompt_cache_scope.py`。
- anthropic 族是"薄壳 transport + 厚 adapter"的范本：转换与端点判定在
  `anthropic_message_convert.py`/`anthropic_endpoints.py`（纯函数、无循环 import）。
- codex 族另成一篇：`codex_runtime.md`；凭据解析归 `credentials_rate.md`。

## 总结

- **三层各管一件事**：声明层（Profile 描述行为）→ 路由层（agent_init 阶梯定 api_mode
  与 client）→ 数据层（transports 只做格式转换与 normalize）。
- **路由是一条有序阶梯**：显式（含插件 dialect）→ provider slug → host 检测 → 默认
  `chat_completions`；URL 驱动判定是刻意设计（#63425）。
- **五个内置 api_mode**：chat_completions、codex_responses、anthropic_messages、
  bedrock_converse、codex_app_server（子进程 JSON-RPC）。
- **声明式压倒旗标**：ProviderProfile 一个 dataclass 说清 auth/endpoints/quirks；
  `LazyHeaders` 把版本探活成本推迟到首读。
- **插件一等公民**：`register_transport` 注册 dialect、`register_provider` 注册 profile；
  懒发现三来源 + 同名 last-writer-wins，第三方无需改仓库即可替换内置。
- **NormalizedResponse 是唯一的边界类型**：协议专属状态进 `provider_data`，共享类型
  不随 provider 膨胀。
