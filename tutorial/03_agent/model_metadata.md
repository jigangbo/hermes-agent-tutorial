# model_metadata.md — 模型元数据与 token 粗估

## 文件概览

"这个模型的上下文窗口多大？这个消息列表大约多少 token？"——压缩触发、preflight 检查、
工具输出预算都靠这两个答案。回答它们的代码集中在 `agent/model_metadata.py`（2,627 行）
及其五个兄弟模块，加上 `models_dev.py` 这个外部目录源。

| 文件 | 行数 | 角色 |
|---|---|---|
| `agent/model_metadata.py` | 2,627 | 主模块：上下文长度九级解析、能力门控、token 粗估、错误信息反推窗口 |
| `agent/model_metadata_cache.py` | 72 | 持久上下文缓存文件（`@<host>` 键）的加锁写入 |
| `agent/model_metadata_http.py` | 72 | 所有元数据 HTTP 的统一出口：凭据作用域、TLS verify、流式下载 |
| `agent/model_metadata_llamacpp.py` | 64 | llama.cpp `/props` 的已分配 `n_ctx` 读取 |
| `agent/model_metadata_memo_bounds.py` | 36 | 端点 memo 的有界记忆（endpoint models、codex 缓存封顶） |
| `agent/model_metadata_token_memo.py` | 129 | 每消息 token 估算 memo：指纹键 + LRU + 双界（条数/字节） |
| `agent/models_dev.py` | 1,032 | models.dev 目录（models.dev/api.json）：内存/磁盘/网络三级缓存 + 覆盖层 |

模块头一句话定了性（model_metadata.py:1-3）："Pure utility functions with no AIAgent
dependency"——全模块不 import AIAgent，供 ContextCompressor 与 run_agent 在 preflight
时调用。

---

## 关键代码走读

### 1. `get_model_context_length` —— 九级解析阶梯（model_metadata.py:2211）

这是全模块的招牌函数，docstring 直接把阶梯写在第一段（:2215-2220）：

```python
# agent/model_metadata.py:2211-2220 + 2221-2230（节选）
def get_model_context_length(
    model: str, base_url: str = "", api_key: str = "", config_context_length: int | None = None,
    provider: str = "", custom_providers: list | None = None,
) -> int:
    """Context length for a model. Resolution order: 0 config override / MoA aggregator /
    model_overrides / custom_providers / endpoint-scoped; 1 persistent cache (Nous, LM
    Studio, Codex OAuth bypass it) and Bedrock; 2-3 custom endpoints (/models, local
    probe, Ollama); 4 Anthropic /v1/models (API keys only); 5 provider-aware (profile live
    catalog, Nous, Codex OAuth, GMI, Ollama, OpenRouter live, models.dev); 6 OpenRouter for
    unknown providers; 7 local server; 8 hardcoded defaults; 9 256K fallback."""
    # 0. Explicit config override — user knows best
    if isinstance(config_context_length, int) and config_context_length > 0:
        return config_context_length
```

阶梯中段有两处"排位即语义"的注释（:2252-2263）：

```python
# agent/model_metadata.py:2243-2256 + 2258-2263（节选）
    model = _strip_provider_prefix(model)  # "local:x" -> "x"; Ollama "model:tag" colons preserved
    # OpenRouter routing variants (":nitro", ":floor", ...) are request-time
    # modifiers, not catalog entries — resolve the window from the BASE id.
    # Deliberately placed AFTER the explicit config overrides above (0b/0c) so
    # a user who pinned the fully-suffixed id keeps winning, and BEFORE every
    # cache/catalog lookup below so the base's real window is found instead of
    # a generic family default. Mirrors the validation path's base/suffix split
    # in hermes_cli.models.validate_requested_model.
    model = _strip_openrouter_routing_variant(model, base_url=base_url, provider=provider)
    # Endpoint-scoped metadata goes AHEAD of the persistent cache so a value learned on a
    # multiplexed provider's other endpoint cannot override it.
    endpoint_context = _endpoint_scoped_context_length(model, base_url)
    if endpoint_context is not None:
        return endpoint_context
    # A profile that qualifies its own bound (external processes have no /models probe) wins
    # over the generic caches below; explicit user/endpoint overrides above still take precedence.
    from providers import get_provider_profile
    profile = get_provider_profile(provider)
    context = profile.get_model_context_length(model) if profile else None
```

阶梯尾部的两条防线（:2319-2325）：

```python
# agent/model_metadata.py:2319-2325
    # 7. Local server before hardcoded defaults — ``Hermes-3-Llama-3.1-70B`` matches ``llama``
    # (131072) even when vLLM runs at a lower ``--max-model-len``.
    local_ctx = _probe_local_context_length(model, base_url, api_key, provider) if base_url and is_local_endpoint(base_url) else None
    if local_ctx:
        return local_ctx
    # 8. Hardcoded defaults: `key in model` only — the reverse would let "claude-sonnet-4" match "claude-sonnet-4-6" and return 1M.
    hit = _longest_key_match(DEFAULT_CONTEXT_LENGTHS, model.lower())
    if hit:
        return hit[1]
    # 9. Default fallback — warn (deduped) so small-context models don't silently get 256K.
    _warn_context_length_fallback(model, base_url)
    return DEFAULT_FALLBACK_CONTEXT
```

值得咀嚼的细节：

- **OpenRouter 路由变体**（`:nitro`/`:floor`）是请求期修饰符，不是目录条目——窗口要查
  base id。剥除位置刻意夹在中间：显式覆盖（0 级）之后、一切缓存/目录查找之前。
  用户钉死全后缀 id 依然赢。
- **端点级元数据排在持久缓存之前**：多路复用网关下，一个端点上学到的值不能压过另一
  端点的真实窗口。
- **空白模型 id 直接落 256K**（:2239-2242）：空串对目录是万能模糊匹配（`"" in key`
  恒真），还会以垃圾键 `@<base_url>` 持久化——宁可默认也不查。
- **第 8 级只许 `key in model` 单向匹配**：反过来 `claude-sonnet-4` 会命中
  `claude-sonnet-4-6` 的 1M——方向错了就是 256K 报错。
- **第 9 级落 256K 前先去重告警**：小窗口模型静默拿到 256K 是最阴险的故障形态。

还有 Codex 路由的特殊性（:2265-2268 注释）：Codex Responses 路由按**传输**而不是 host
判定——代理（`HERMES_CODEX_BASE_URL`、custom api_mode）后面 URL 看着普通，窗口仍是
Codex OAuth 那套（#116191），所以持久缓存对它直接跳过。

### 2. token 粗估 —— CJK 密度与字节计数（model_metadata.py:2340）

```python
# agent/model_metadata.py:2336-2366
# CJK/Hangul/Kana codepoints (~1 token each), counted in one C-level regex pass: Hangul
# Jamo (+Ext-A), CJK radicals/ideographs (+compat), Hangul syllables, fullwidth/halfwidth.
# Rough chars-per-token ratio for ASCII text; the single source for every "N tokens ≈ N*4 chars"
# budget conversion (context files, tool-output budgets, whisper prompt cap, compressor metadata).
CHARS_PER_TOKEN = 4

_CJK_DENSE_RE = re.compile("[\u1100-\u11ff\u2e80-\u9fff\ua960-\ua97f\uac00-\ud7af\uf900-\ufaff\uff00-\uffef]")

def _is_cjk_token_dense_char(ch: str) -> bool:
    return _CJK_DENSE_RE.fullmatch(ch) is not None


def estimate_tokens_rough(text: str) -> int:
    """Rough token estimate: CJK/Hangul/Kana codepoints ~1 token each; everything else ceil(UTF-8 bytes/4).
    Ceiling keeps short texts from estimating 0. Runs on every preflight walk, so all-ASCII stays O(1).

    Byte-counting (not chars) is the corrective for non-CJK, non-ASCII text: Cyrillic/Greek/Arabic are 2
    bytes/char so count ~chars/2, matching real BPE cost (~2-3 chars/token) where chars/4 under-counted
    ~2x and let sessions ride the provider ceiling below the compaction threshold. Calibrated vs
    cl100k/o200k/Qwen2.5 (estimate/real): Russian 0.67->1.24, Arabic 0.53->0.96, Hindi 0.34->0.90,
    Greek 0.37->0.68; accented Latin barely moves (French 1.02->1.03). errors="replace": lone surrogates
    (routine in tool output; see message_sanitization) must not turn an estimate into a raise."""
    if not text:
        return 0
    text = str(text)
    if text.isascii():  # flag check on CPython; ASCII cannot contain token-dense CJK
        return (len(text) + 3) // CHARS_PER_TOKEN
    stripped = _CJK_DENSE_RE.sub("", text)
    dense = len(text) - len(stripped)
    return dense + ((len(stripped.encode("utf-8", "replace")) + 3) // CHARS_PER_TOKEN)
```

`CHARS_PER_TOKEN = 4` 是**唯一事实源**——上下文文件、工具输出预算、whisper 上限、
压缩器元数据里所有 "N tokens ≈ N*4 chars" 换算都 import 它。估算公式的演进史写在
docstring 里：字符/4 对西里尔/阿拉伯语低估约 2 倍，会让会话贴着 provider 上限运行而
压缩永不触发；改按 **UTF-8 字节/4** 后按 cl100k/o200k/Qwen2.5 校准，俄语 0.67→1.24、
阿拉伯语 0.53→0.96。CJK 密集码点（约一字一 token）用一条 C 级正则一次剥出。

`estimate_messages_tokens_rough`（:2369-2381）再上一层：图片按**从 provider 用量学到的
每图价格**计（`agent.image_token_cost`），而非 base64 长度；`charge_stale_thinking=False`
时剥掉旧 turn 的 reasoning 键（只保留最新 assistant）——非 echo 路由上过期推理只有最新
一轮真正上线，不剥离的话推理重的会话会让 preflight 永远开火，与压缩器的尾预算游走
（`context_compressor._estimate_msg_budget_tokens`）必须同尺寸类。

### 3. 每消息 memo —— 指纹键与双界缓存（model_metadata.py:2425 + token_memo.py:29）

估算函数每次循环迭代都对全历史跑一遍（conversation_loop preflight）、压缩遥测反复调、
MoA 的 O(n²) 收缩循环里更要命。于是有了一个**按值指纹**的 memo（:2425-2438 的长注释
给出完整健全性论证）：

```python
# agent/model_metadata.py:2425-2438（节选）
# Per-message token-estimate memo keyed by an exact value fingerprint: strings by ``id()`` AND
# pinned (strong ref in the entry, so the id can't be reused and immutability makes id-equality
# value-equality); numbers/bools/None by value; dicts/lists structurally in key order (``str(shadow)``
# depends on it); any other type aborts the memo. api_messages shallow-copies dicts but shares the strings.
# ...
# Fingerprint design (soundness argument): While the entry lives, that id cannot be reused by another
# object, so id-equality implies object-equality — strings are immutable, so value-equality too ...
```

字符串按 `id()` 键入，但 entry 里**强引用钉住**（`MemoPins`，token_memo.py:43）——id
不可被复用，不可变对象相等即值相等。历史 dict 每 turn 浅拷贝但共享同一批字符串，所以
未变的历史消息照样命中。缓存本体在 token_memo.py：

```python
# agent/model_metadata_token_memo.py:29-38 + 68-75（节选）
# fingerprint -> (pins, text tokens, image count). Order is recency: a hit moves its entry to the end, and an
# OrderedDict evicts from the front in O(1) where a plain dict rescans its deleted slots on every eviction.
_MSG_TOKENS_CACHE: OrderedDict[Any, tuple[list, int, int]] = OrderedDict()
_MSG_TOKENS_CACHE_MAX = 4096
_MSG_TOKENS_CACHE_MAX_BYTES = 16 * 1024 * 1024
# Measured on real histories: the fingerprint tuple, its id int and the pin slot cost ~120 B per string leaf.
_LEAF_OVERHEAD_BYTES = 120
# An entry looked up this recently is never evicted (see module docstring).
_ACTIVE_WINDOW_S = 60.0

def remember_message_tokens(key: Any, entry: tuple[MemoPins, int, int]) -> None:
    """Insert ``entry`` as most recent, then evict least-recently-used entries past either bound, stopping at
    the first one looked up inside the active window (everything after it is more recent)."""
    ...
    if size > _MSG_TOKENS_CACHE_MAX_BYTES:
        return  # one message larger than the whole budget is recomputed, never allowed to flush the memo
```

三条驱逐规则：LRU 4096 条上限、16 MB 字节预算（按每字符串叶子 ~120 B 估）、以及
**60 秒活动窗**——刚被查过的条目永不被逐（驱逐停在第一个活动窗内的条目）。单条消息
超过整个预算则直接重算，绝不许它冲刷整个 memo。`forget_message_token_memo`（:112）在
消息内容被压缩修改时按字符串 id 定点遗忘。

### 4. `fetch_model_metadata` —— OpenRouter 元数据与三级降级（model_metadata.py:898）

```python
# agent/model_metadata.py:898-910 + 932-943（节选）
def fetch_model_metadata(force_refresh: bool = False) -> dict[str, dict[str, Any]]:
    """Fetch model metadata from OpenRouter (cached for 1 hour)."""
    global _model_metadata_cache, _model_metadata_cache_time
    if not force_refresh:
        if _model_metadata_cache and (time.time() - _model_metadata_cache_time) < _MODEL_CACHE_TTL:
            return _model_metadata_cache
        disk_age = _model_metadata_disk_cache_age_seconds()
        if disk_age is not None and disk_age < _MODEL_CACHE_TTL:
            disk_cache = _load_model_metadata_disk_cache()
            if disk_cache:
                _model_metadata_cache = disk_cache
                _model_metadata_cache_time = time.time() - disk_age
                return _model_metadata_cache
    ...
    except Exception as e:
        logger.warning("Failed to fetch model metadata from OpenRouter: %s", e)
        if _model_metadata_cache:
            return _model_metadata_cache
        disk_cache = _load_model_metadata_disk_cache()
        if disk_cache:
            _model_metadata_cache = disk_cache
            disk_age = _model_metadata_disk_cache_age_seconds()
            stale_by = min(disk_age, _MODEL_CACHE_TTL) if disk_age is not None else _MODEL_CACHE_TTL - 1
            _model_metadata_cache_time = time.time() - stale_by
            return _model_metadata_cache
        return {}
```

内存（1h TTL）→ 磁盘（`_model_metadata_disk_cache_age_seconds` 只认新鲜度）→ 网络，
网络失败再回退内存/陈旧磁盘。agent_init 的 `_finalize_routing`（agent_init.py:403-410）
在 OpenRouter 路由上开后台线程预热这份缓存——进程级 Event 防每消息漏一个线程。
`agent_init.py` 里那句话就是这里的契约："the first pricing estimate doesn't block"。

### 5. models_dev —— 目录权威与 `_default` 填缝（models_dev.py:1-7 + 750）

```python
# agent/models_dev.py:1-7 + 24-30（节选）
"""Models.dev registry integration — primary database for providers and models.

Resolution: in-memory cache (fresh, or stale served while one background daemon
thread refreshes) → disk cache (~/.hermes/models_dev_cache.json, any age) →
network only when no cache exists. Failed refreshes back off 5 min process-wide.
Refreshes use ETag conditional GET when a servable registry is held. Hot paths
pass ``allow_network=False`` and never do I/O. A corrupt/empty disk cache is
quarantined, never served as ``{}``. ``models_dev.url`` in config.yaml = mirror."""

MODELS_DEV_URL = "https://models.dev/api.json"
_MODELS_DEV_CACHE_TTL = 4 * 3600  # 4 hours — ETag conditional GET makes refresh cheap
_MODELS_DEV_RETRY_DELAY = 300  # 5 minutes after a failed refresh
```

比 OpenRouter 那份更讲究：陈旧注册表在手时由后台守护线程刷新（热路径先吃陈值），
失败全进程退避 5 分钟，ETag 条件 GET 让刷新便宜，损坏缓存**隔离**而不是当 `{}` 服务，
`models_dev.url` 配置可指镜像。数据模型三件套：`ModelInfo`（:42，能力/模态/限额/成本/
状态全字段）、`ProviderInfo`、`ModelCapabilities`。

用户覆盖层（:750-769）解决了"目录就是错"的问题：

```python
# agent/models_dev.py:750-761 + 764-769（节选）
def _default_model_override(provider: str, *, config: Optional[dict[str, Any]] = None) -> Optional[dict[str, Any]]:
    """Fill-gap ``_default`` override: per-provider first, then global; or None."""
    section = _provider_override_section(provider, config=config)
    if section is not None and isinstance(section.get("_default"), dict):
        return section["_default"]
    ...
    global_default = overrides.get("_default")
    return global_default if isinstance(global_default, dict) else None


def _override_for(
    provider: str, model: str, *, catalog_hit: bool, config: Optional[dict[str, Any]] = None,
) -> Optional[dict[str, Any]]:
    """Explicit override if any; else the ``_default`` only on a catalog miss."""
    explicit = _explicit_model_override(provider, model, config=config)
    return explicit if explicit is not None or catalog_hit else _default_model_override(provider, config=config)
```

三级语义：显式覆盖（exact 模型 id）永远赢 → 目录命中时 `_default` **不**插手 → 目录
miss 时 `_default`（per-provider 优先，再全局）填缝（#84482）。而
`_override_context_window`（:788-793）只用显式覆盖——它跑在解析链早期，`_default`
若在此抢先会压过更具体的来源。

### 6. 错误反推窗口 —— 从 400 学上下文（model_metadata.py:1218）

解析阶梯之外还有一条"事后学习"通道：provider 的 400 错误正文往往写着真实窗口。
`parse_context_limit_from_error`（:1218）从报错文本反推；`get_context_length_from_provider_error`
（:1245）配合 `get_next_probe_tier`（:1213， tiers: 256K→128K→64K→32K→16K→8K，:260）
逐级试探；`parse_available_output_tokens_from_error`（:1273）拆出"上下文减输入"的剩余
输出配额；`is_output_cap_error`（:1384）区分输出上限错误（s/glang 等各有专属短语组）。
学到的值经 `save_context_length`（:1134）写进 `@<host>` 键的持久缓存，下次直接命中。

### 7. HTTP 出口与本地探测兄弟模块

- `model_metadata_http.py`（72 行）：所有元数据 HTTP 的唯一出口——`scope_credentials`
  把当前 profile 的凭据作用域绑进请求（多路复用下绝不串号），`resolve_verify` 统一 TLS
  策略，`stream` 支持大目录的流式下载。
- `model_metadata_llamacpp.py`：llama.cpp 的 `/props`（旧版 `/v1/props`）读**已分配**
  的 `n_ctx`——服务器实际跑的窗口，不是模型标称；router 模式下按 `?model=` 逐个已加载
  子进程读，未加载的跳过（探测可能触发自动加载）。
- `model_metadata_cache.py`：持久缓存文件的全部写入都过 `locked_context_cache`（:31）
  文件锁；`drop_context_cache_rows`（:55）按键定点清除过期行。
- `model_metadata_memo_bounds.py`：`remember_endpoint_models` / `bound_codex_caches`
  给端点级 memo 封顶——一个恶意/病态端点返回 10 万个模型也不能把进程内存吃穿。

---

## 核心类/函数

| 符号 | 职责 | 位置 |
|---|---|---|
| `get_model_context_length` | 九级阶梯解析上下文窗口（config→缓存→探测→目录→兜底） | `agent/model_metadata.py:2211` |
| `get_model_context_length_async` | 同上但跑 worker 线程（阻塞 HTTP 不 stall 事件循环） | `agent/model_metadata.py:2328` |
| `estimate_tokens_rough` | CJK 一字一 token + 其余 UTF-8 字节/4 的粗估 | `agent/model_metadata.py:2349` |
| `estimate_messages_tokens_rough` | 消息列表粗估（图片按学习价、可选剥过期 thinking） | `agent/model_metadata.py:2369` |
| `estimate_request_tokens_rough` | 请求级粗估（system + tools） | `agent/model_metadata.py` |
| `_msg_fingerprint` / `_estimate_message_tokens_cached` | 每消息 memo 的指纹键与查取 | `agent/model_metadata.py:2441` |
| `CHARS_PER_TOKEN` | "N tokens ≈ N*4 chars" 的唯一换算源 | `agent/model_metadata.py:2340` |
| `fetch_model_metadata` | OpenRouter 元数据（1h TTL，内存→磁盘→网络→降级） | `agent/model_metadata.py:898` |
| `fetch_endpoint_model_metadata` | 自定义端点 /models 元数据（端点 memo + TTL） | `agent/model_metadata.py:1026` |
| `save_context_length` / `get_cached_context_length` | `@<host>` 键持久缓存的写/读 | `agent/model_metadata.py:1134,1170` |
| `parse_context_limit_from_error` | 从 400 错误正文反推窗口 | `agent/model_metadata.py:1218` |
| `get_next_probe_tier` | 256K→8K 的逐级试探阶梯 | `agent/model_metadata.py:1213` |
| `parse_available_output_tokens_from_error` | 拆"上下文减输入"的剩余输出配额 | `agent/model_metadata.py:1273` |
| `is_output_cap_error` | 判定输出上限错误（含 s/glang 短语组） | `agent/model_metadata.py:1384` |
| `query_ollama_num_ctx` / `_ollama_show_context` | Ollama 的 `num_ctx` 探测（API + show 双路） | `agent/model_metadata.py:1431,573` |
| `_query_anthropic_context_length` | Anthropic /v1/models 查询（仅 API key） | `agent/model_metadata.py:1633` |
| `_resolve_codex_oauth_context_length_with_source` | Codex OAuth 目录的窗口解析 | `agent/model_metadata.py:1896` |
| `lookup_message_tokens` / `remember_message_tokens` | 每消息 memo 的读/写（LRU+双界+活动窗） | `agent/model_metadata_token_memo.py:49,68` |
| `forget_message_token_memo` | 消息被改时按字符串 id 定点遗忘 | `agent/model_metadata_token_memo.py:112` |
| `locked_context_cache` / `drop_context_cache_rows` | 持久缓存文件锁与定点清除 | `agent/model_metadata_cache.py:31,55` |
| `resolve_verify` / `get` / `stream` | 元数据 HTTP 统一出口（凭据作用域、TLS、流式） | `agent/model_metadata_http.py:10,70,29` |
| `llamacpp_context` / `router_launch_ctx` | llama.cpp /props 的已分配 n_ctx | `agent/model_metadata_llamacpp.py:19,42` |
| `remember_endpoint_models` / `bound_codex_caches` | 端点 memo 封顶 | `agent/model_metadata_memo_bounds.py:21,32` |
| `ModelInfo` / `ProviderInfo` | models.dev 目录的元数据 dataclass | `agent/models_dev.py:42,90` |
| `get_model_info` / `lookup_models_dev_context` | 目录查询（能力/窗口/价格） | `agent/models_dev.py:1015` |
| `_override_for` / `_default_model_override` | 用户覆盖层：显式赢、`_default` 只填缝 | `agent/models_dev.py:764,750` |

## 本组文件清单

| 文件 | 一句话角色 |
|---|---|
| `agent/model_metadata.py` | 主模块：九级窗口解析、能力门控、token 粗估、错误反推、Ollama/Anthropic/Codex 探测 |
| `agent/model_metadata_cache.py` | 持久 `@<host>` 上下文缓存文件的锁写与定点清除 |
| `agent/model_metadata_http.py` | 元数据 HTTP 统一出口：凭据作用域、TLS verify、流式下载 |
| `agent/model_metadata_llamacpp.py` | llama.cpp /props 已分配 n_ctx（router 模式逐子进程读） |
| `agent/model_metadata_memo_bounds.py` | 端点 memo 有界记忆（endpoint models / codex 缓存封顶） |
| `agent/model_metadata_token_memo.py` | 每消息估算 memo：指纹键 LRU、4096 条/16 MB 双界、60s 活动窗 |
| `agent/models_dev.py` | models.dev 目录：三级缓存 + ETag 刷新 + 用户覆盖层（`_default` 填缝） |

## 与其他模块的关系

```
ContextCompressor / conversation_loop preflight
        │  （压缩触发窗口 = f(get_model_context_length, estimate_messages_tokens_rough)）
        ▼
model_metadata.get_model_context_length ──► providers.get_provider_profile（profile 自报窗口）
        │                                ──► models_dev（目录权威 + _default 填缝）
        │                                ──► fetch_model_metadata（OpenRouter 元数据）
        │                                ──► model_metadata_http（唯一 HTTP 出口）
        ▼
turn_preflight / turn_overflow ──► 窗口不够时触发压缩（conversation_compression）
```

- **消费方**：`context_compressor*.py` 用窗口定压缩阈值、用粗估定预算；`turn_preflight.py`
  在请求前量尺寸；`turn_overflow.py` 处理窗口超限错误（调
  `parse_context_limit_from_error` 学真实窗口）；`usage_pricing.py` 的计价读 OpenRouter
  的 `pricing` 字段；auxiliary 侧的响应校验也依赖 `fetch_model_metadata` 预热缓存。
- **profile 联动**：`provider_route_hooks`/`ProviderProfile.get_model_context_length` 让
  插件自报窗口；`_finalize_routing` 的 OpenRouter 预热线程喂的正是本模块的缓存。
- **写作面**：`hermes_cli/models.py` 的模型校验与本模块共享 base/suffix 拆分约定。

## 总结

- **九级阶梯排位即语义**：显式覆盖 → 端点级 → profile 自报 → 持久缓存 → Bedrock →
  自定义端点/本地探测 → Anthropic → provider 感知目录 → OpenRouter → 硬编码 → 256K
  兜底（兜底必告警）。方向性匹配只许 `key in model` 单向。
- **粗估是工程化的"够用"**：CJK 密集码点一字一 token，其余按 UTF-8 字节/4（不是
  字符/4——俄语/阿拉伯语曾因此低估 2 倍，压缩永不触发）；`CHARS_PER_TOKEN=4` 全仓
  唯一换算源。
- **memo 靠指纹和钉子**：字符串 id + 强引用 pin + 结构化 dict 指纹，健全性论证写在
  注释里；4096 条/16 MB/60 秒活动窗三重边界，超大消息重算不冲刷。
- **外部元数据三级降级**：OpenRouter（内存→磁盘→网络，失败回退陈值）与 models.dev
  （内存陈值可服务 + 后台刷新、ETag 条件 GET、失败退避、坏缓存隔离、可配镜像）。
- **覆盖层三级语义**：显式 id 覆盖永远赢；目录命中 `_default` 不插手；目录 miss
  `_default` 填缝——"用户钉对的"和"目录烂掉的"走不同的路。
- **错误也是数据源**：provider 的 400 正文能反推窗口与剩余输出配额，学到的值持久化，
  下次请求前就生效。
