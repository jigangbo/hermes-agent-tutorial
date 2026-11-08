# multimodal_media.md — 多模态与媒体 provider 注册表:六对 registry/provider、视觉消息准备与图片生命周期

## 文件概览

Hermes 的"多模态"不是模块而是**注册表模式**:每种能力(图片生成、视频生成、TTS、语音转写、
网页搜索、云浏览器)一对文件——`*_provider.py` 定义 ABC 与响应信封,`*_registry.py` 持有
`ProviderRegistry` 并实现"选谁"。插件经 `PluginContext.register_<kind>_provider()` 注册,core 只
认抽象基类——"窄腰内核 + 能力住边缘"的落法;六个 registry 共享引擎 `agent/provider_registry.py`。
其余文件围着**图片的生命周期**转(入站路由、消息准备、出站退休、成本学习、历史重放);
`voice_turn_route.py` 是语音聊天的 per-turn 换轨,`gemini_long_decode.py` 处理 Gemini 4 多跳
续传(细节见模型层文档)。

```text
模型要一张图:
  image_generate(prompt, aspect_ratio, image_url?)
    ▼ image_gen_registry.get_active_provider()      ← 选谁
      配置命中 → 直接返回(可用性检查关掉,错误信息精确)
      未配置 → 唯一可用者 / fal 遗留默认 / None(工具指向 hermes tools)
    ▼ ImageGenProvider.generate(...)                ← 干活:有图路由编辑端点;统一信封
    ▼ save_b64_image / save_url_image → $HERMES_HOME/cache/generated/images/
    ▼ 图片的后半生:vision_message_prep 出站准备 / image_eviction_policy 条件化退休 /
      image_token_cost 学每图价 / image_replay 重建历史时重放 [screenshot]
```

| 文件 | 行数 | 角色 |
|---|---|---|
| `agent/provider_registry.py` | 211 | 全部 `*_registry` 的共享引擎(全局 + scoped + 插件快照) |
| `agent/image_gen_provider.py` | 139 | `ImageGenProvider` ABC + 统一响应信封 + 图片落盘 |
| `agent/image_gen_registry.py` | 47 | 图片生成 registry + `get_active_provider` 选择规则 |
| `agent/video_gen_provider.py` | 289 | `VideoGenProvider` ABC(文生视频/图生视频;编辑/扩展刻意不暴露) |
| `agent/video_gen_registry.py` | 45 | 视频生成 registry(配置未注册时 fail-closed) |
| `agent/tts_provider.py` | 114 | `TTSProvider` ABC(整段 synthesize + 可选 PCM 流式) |
| `agent/tts_registry.py` | 45 | TTS registry(内建名保留、大小写不敏感) |
| `agent/transcription_provider.py` | 66 | `TranscriptionProvider` ABC + 可选流式 `TranscriptionStreamSession` |
| `agent/transcription_registry.py` | 45 | STT registry(`stt.provider`,内建优先) |
| `agent/web_search_provider.py` | 101 | `WebSearchProvider` ABC + 密钥作用域安全的 `get_provider_env` |
| `agent/web_search_registry.py` | 204 | 搜索/抽取 registry(5 级优先序,能力过滤) |
| `agent/browser_provider.py` | 57 | `BrowserProvider` ABC(云浏览器会话生命周期三件套) |
| `agent/browser_registry.py` | 61 | 云浏览器 registry(`browser.cloud_provider`) |
| `agent/browser_page_backend.py` | 37 | `BrowserPageBackend` ABC(自有页面传输的插件浏览器) |
| `agent/browser_page_registry.py` | 29 | 页面后端 registry(browser_vault 的求值路由) |
| `agent/image_routing.py` | 593 | 入站图片路由:文本挖图、native/text 裁决、MIME 嗅探 |
| `agent/vision_message_prep.py` | 359 | `VisionMessagePrepMixin`:视觉探针、非视觉回退、provider 怪癖 |
| `agent/image_eviction_policy.py` | 288 | 出站旧图片退休策略(两趟共享,stdlib-only) |
| `agent/image_token_cost.py` | 149 | 从 provider usage 残差学习的每图 token 成本 |
| `agent/image_replay.py` | 172 | DB 重建历史时的图片重放(批次推进,保缓存前缀) |
| `agent/voice_turn_route.py` | 218 | 语音聊天 per-turn 换轨(`auxiliary.voice_chat`) |
| `agent/gemini_long_decode.py` | 102 | Gemini 4 长解码:CONTINUATION 多跳续传 |

---

## 关键代码走读

### 1. 注册表引擎:`ProviderRegistry` 与 `export()`

所有 `*_registry.py` 共享一个泛型引擎:全局表是插件注册的默认落点,per-profile 的
`_scoped_providers` 服务多路网关;`merged()` 用作用域表覆盖全局表;快照/回滚对是插件卸载的
undo 机制:

```python
# agent/provider_registry.py:77-112(节选)
def register(self, provider: P, *, scope: Optional[str] = None) -> None:
    """Register a provider; same-name re-registration overwrites (hot reload)."""
    if not isinstance(provider, self.provider_cls):
        ...raise TypeError(...)
    if not isinstance(provider.name, str) or not provider.name.strip():
        raise ValueError(f"{self.label} provider .name must be a non-empty string")
    key = self.normalize(provider.name)
    if key in self.builtin_names:                 # 内建名保留:撞名只警告,注册被跳过
        if self._on_builtin_collision is not None:
            self._on_builtin_collision(key)
        return
    with self._lock:
        self._target(scope, create=True)[key] = provider
        self._bump(scope)

def merged(self, scope: Optional[str] = None) -> dict[str, P]:
    """Global map overlaid with the active profile's scoped map (a copy)."""
    with self._lock:
        merged = dict(self._providers)
        merged.update(self._scoped_providers.get(hermes_home_key(scope), {}))
    return merged
```

每个 `*_registry.py` 只需三行:建 `ProviderRegistry`、`_registry.export(globals())` 把历史模块级
名字(`register_provider`/`get_provider`/`_providers` 测试钩子……)绑进自己命名空间,旧补丁路径
`patch("agent.x_registry.get_provider")` 继续成立。`normalize` 可选 `str.strip`/`lower_key`/
`exact_key`——TTS registry 用 `lower_key` 且内建名单恒保留,插件名撞内建永远赢不了。

### 2. 选择规则:配置命中与可用性的微妙关系

六对 registry 的 `get_active_provider()` 形同实异,差异全在"配置了但不可用怎么办"。图片生成的
规则最有代表性——**显式配置者即使 `is_available()` 为 False 也照返**,让调度器给出精确的
"X_API_KEY is not set"错误,而不是悄悄换后端:

```python
# agent/image_gen_registry.py:27-47(节选)
def get_active_provider() -> Optional[ImageGenProvider]:
    """...an explicitly configured provider is returned even if ``is_available()`` is False, so the
    dispatcher surfaces a precise "X_API_KEY is not set" error instead of silently switching
    backends; only the unconfigured fallback path is filtered by availability."""
    configured = configured_provider_name("image_gen", logger)
    snapshot = _registry.merged()
    if configured:
        if snapshot.get(configured) is not None:
            return snapshot[configured]           # 配置命中:可用性检查关掉
        logger.debug("image_gen.provider='%s' configured but not registered; falling back", configured)
    available = [p for p in snapshot.values()
                 if is_available_safe(p, logger, "image_gen provider %s.is_available() raised %s")]
    if len(available) == 1:
        return available[0]                       # 未配置回落:唯一可用者,或 fal 遗留默认
    fal = snapshot.get("fal")
    return fal if fal is not None and is_available_safe(fal, logger, "...") else None
```

对照另外三种口味:视频生成**配置未注册时 fail-closed**(返回 None,不回落);浏览器沿
`_LEGACY_PREFERENCE` 走遗留偏好序;网页搜索 5 级优先序(配置键 → 唯一可用 → 遗留偏好 → keyless
免费 → None),`supports_search`/`supports_extract` 能力过滤每步生效。`is_available_safe` 把抛异常
的 provider 视为不可用——插件代码永远不该炸穿注册表。

### 3. Provider ABC 们与密钥作用域

`ImageGenProvider.generate` 的签名浓缩了这类设计的取舍:一个工具同时覆盖文生图和编辑
(`image_url`/`reference_image_urls` 存在即路由到编辑端点),未知 kwargs **必须忽略**(前向
兼容),`capabilities()` 动态进工具 schema:

```python
# agent/image_gen_provider.py:46-60(节选)
@abc.abstractmethod
def generate(
    self,
    prompt: str,
    aspect_ratio: str = DEFAULT_ASPECT_RATIO,
    *,
    image_url: Optional[str] = None,
    reference_image_urls: Optional[list[str]] = None,
    **kwargs: Any,
) -> dict[str, Any]:
    """Generate an image, or edit ``image_url`` ...; any source image routes to the edit endpoint.
    Unknown ``kwargs`` MUST be ignored (forward compat); ``upscale`` (bool) is a post-generation
    high-res pass, reported as ``upscaled: True`` in ``extra``."""
```

响应信封由 `success_response`/`error_response` 统一构造,`extra` 键只能**追加**不能覆盖标准键;
落盘共用 `agent/provider_media.py`(`save_b64_image`/`save_url_image`,25MB 上限)。视频 ABC 镜像
这套但刻意**不**暴露视频编辑/扩展——各家后端太不一致。TTS 的额外面是**流式**(`stream()` 产出
int16 mono PCM,每句可并发必须 thread-safe),整段 `synthesize` 仍保底;转写 ABC 的流式面是
`TranscriptionStreamSession.push_audio`(16kHz mono s16le)+ `finalize`(不得抛)。

密钥侧,`web_search_provider.get_provider_env` 是"配置层密钥"的读取口,其最后一段是最重要的多
profile 防线——作用域未绑定时**拒绝**回落 `os.environ`(那里躺的是**启动** profile 的密钥):

```python
# agent/web_search_provider.py:44-53
    scope_bound, multiplex_active = _secret_scope_state()
    if val is None and multiplex_active and not scope_bound:
        from agent.secret_scope import UnscopedSecretError

        raise UnscopedSecretError(name, f"get_provider_env({name!r}) called with no active profile scope")
    if val is None and not scope_bound:
        val = os.getenv(name, "")
    return (val or "").strip()
```

被路由的 profile 没有 Exa/Parallel 密钥时必须**拒绝**,而不是拿另一个 profile 的密钥去搜索。
`browser_page_backend.py` 是密钥安全的另一半:插件浏览器自带页面时,`evaluate(..., secret=True)` 的
契约——嵌入凭据的表达式只走 loopback/HTTPS、不进 argv、不跟随重定向、不进日志;core 负责包装
脚本让页面异常永远到不了后端的错误文本。

### 4. 入站路由:`decide_image_input_mode` 与魔法字节

用户发的图走两条路:`native`(OpenAI 风格 image_url part,模型原生看图)或 `text`(先跑
`vision_analyze` 把有损描述垫在前面,给非视觉模型)。`auto` 裁决:显式 `auxiliary.vision` 后端强制
text(即使主模型有视觉);否则 `supports_vision`(配置覆盖 > 模型目录)裁决:

```python
# agent/image_routing.py:375-391(节选)
def decide_image_input_mode(provider: str, model: str, cfg: Optional[dict[str, Any]], *,
                            requested_provider: str = "") -> str:
    """Return ``"native"`` or ``"text"`` for the given turn (``cfg`` None behaves as auto)."""
    mode_cfg = _coerce_mode(_dict_or_empty(_dict_or_empty(cfg).get("agent")).get("image_input_mode"))
    if mode_cfg != "auto":
        return mode_cfg
    if _explicit_aux_vision_override(cfg):  # auto: an explicit auxiliary.vision backend wins
        return "text"
    extra = {"requested_provider": requested_provider} if requested_provider else {}
    return "native" if _lookup_supports_vision(provider, model, cfg, **extra) is True else "text"
```

同一文件埋着两个鲁棒性细节。其一,**尺寸处理是反应式的**:全尺寸附上,等 provider 报 400 再缩小
重试——主动式尺寸表会过时并悄悄降质。其二,**MIME 用魔法字节嗅探**(`_sniff_mime_from_bytes`,
image_routing.py:419):平台会说谎(Discord 把 PNG 贴纸伺服成 `image/webp`),Anthropic 对
media_type 不匹配直接 400。自由文本挖图(`extract_image_refs`)也在这:局部路径必须真实存在、URL
不验证、**代码围栏里的匹配跳过**——贴的代码片段不该变成活附件。

### 5. 出站消息准备:`VisionMessagePrepMixin` 的非视觉回退

模型不支持视觉但历史里有图怎么办?`_describe_image_for_anthropic_fallback`(vision_message_prep.py:92)
把图交给 `vision_analyze` 换成详尽文字描述,替换图片 part:描述按图片内容的 sha256 缓存,data: URL
先落临时文件再喂,20MB base64 上限防共享网关被打爆内存。兜底形状值得注意——分析失败不是抛异常,
而是 `[Image analysis failed: ...]`:turn 继续,错误对模型可见;材料化失败的临时文件必须删
(delete=False 否则每次失败漏一个 0 字节文件)。

### 6. 出站退休:`image_eviction_policy` 的"条件化阈值"

老图片要从每请求拷贝里退休——但**为什么**触发阈值是 provider 限值而不是"保留最近 N 张"?退休
图片等于编辑一条 provider 已缓存的消息,Anthropic 的提示缓存按精确字节前缀匹配;"keep-newest-N"
每来一张新图就多退休一条消息,每 turn 都是全前缀 miss。**按住不动直到请求真会越过 API 限值,
然后成批退休**,每批只花一个慢 turn:

```python
# agent/image_eviction_policy.py:42-55(节选)
OUTBOUND_IMAGE_LIMIT = 20            # Anthropic 更严 2000px 帽的文档阈值
OUTBOUND_IMAGE_HARD_LIMIT = 100
OUTBOUND_IMAGE_BUDGET_BYTES = 24_000_000
IMAGE_EVICTION_BATCH = 8
MANY_IMAGE_DIMENSION_LIMIT = 2000
```

20 是**条件化**的:Anthropic 的更严 2000px 帽文档阈值就是 20,而 Hermes 入历史前已把工具图缩到
1568px——第 21 张截图不触发 provider 约束,在那里退休只会白付一次全前缀重写、还作废后续所有
thinking 块。仅当某张图实测超过 2000px 才适用 20,否则天花板是硬限 100。分类只读图片**头**(前
32KB base64 前缀解出 PNG IHDR / JPEG SOF),读不出尺寸一律按不安全处理(fail-closed)。两趟退休
(OpenAI 形列表与 Anthropic wire 列表)共享这 stdlib-only 的一册策略——必须在同一前沿退休,否则
第二趟会以不同前沿再退休一次(#113517)。

### 7. 学出来的每图成本与历史重放

固定每图 token 常数两头都错:同一张 1080p 截图在一个 provider 花 ~1,100 tokens,本地 mmproj 模型
4,000+。但 provider 在**携带它的那个请求**里把图定价得明明白白——用新鲜的 usage 锚,残差
(`prompt_tokens - anchor - 纯文本增量`)就是本次引入的 N 张图的价格:

```python
# agent/image_token_cost.py:1-12(docstring 节选)
"""Per-image token cost learned from the provider's own usage, never from a vendor formula. ...
The learned value is kept per ``model@host`` in ``~/.hermes/cache/image_token_costs.json`` so a
new session starts calibrated, and bound per turn through a ContextVar so every estimator
(preflight trigger, tail-budget walk, gateway hygiene) prices images the same way."""
```

学习值按 `model@host` 存 `image_token_costs.json`(合理带 64..32768 之外的观测是文本估计噪声,
不入表),经 ContextVar 每 turn 绑定——预检触发器、尾部预算游走、网关卫生检查全部同价;
`_table()` 有 profile 分叉,路由 profile 用**自己的**缓存文件,否则会把 A profile 学到的价写进每个
home。

DB 只存文本行(`[screenshot]`),`--resume`/API 服务器/网关重启后的重建历史会让模型看到占位符而非
一消息前的照片。字节没丢(在 profile 的 `native-inputs/<sha256>/`),`image_replay` 把最近的图变回
image_url part:

```python
# agent/image_replay.py:12-21(docstring 节选)
"""On the WIRE COPY only, when this turn sends images natively, the ``vision.replay_recent_images``
newest images (default 3, 0 = off) go back as ``image_url`` parts; older ones drop in whole
batches of that size (``replay_frontier``), so the cached prefix is rewritten at most once per
batch rather than on every new photo. ... byte-identical ... the prompt-cache prefix holds."""
```

三个"只"字是安全边界:只改 **wire 拷贝**(存储行不动)、只重放**留存**且摘要仍匹配的字节(远程
URL 会过期然后每 turn 400;网关的 settled-media 清扫会收走旧文件;两者都保持 `[screenshot]` 文本)、
data URL 来自与实况 turn **相同**的 `_file_to_data_url`——重建行与首次发送它的请求字节一致,前缀
才保得住。`_split_rebuilt_row` 按行序拆出 text/image 部件,marker 与 `[Image attached…]` 提示 1:1
配对,数量不符则放弃重放。

### 8. 语音换轨:`voice_turn_route` 的快照/回装

语音 turn(CLI 语音输入、桌面/TUI 语音对话、消息语音便签)可以跑更快的小模型。关键约束:路由绑定
在 turn setup **末尾**(系统提示词和会话行已按主模型建好、预检压缩已按主模型窗口判过),turn 后
工作(记忆同步、后台审查)前**解除**——turn 之外没人看见它:

```python
# agent/voice_turn_route.py:134-163(节选)
def begin_voice_turn_route(agent: Any, messages, system_prompt: Any) -> Any:
    """Bind the voice route for a marked turn; returns the system prompt the turn should send."""
    if not getattr(agent, "_voice_turn_pending", False):
        return system_prompt
    agent._voice_turn_pending = False
    ...
    state: dict[str, Any] = {"reasoning_config": copy.deepcopy(getattr(agent, "reasoning_config", None))}
    agent._voice_route_state = state
    if target is not None:
        state.update(_capture(agent))          # 快照 + 外部字段整包抓走
        if reason:                             # bind 失败或装不下(超语音模型窗口)
            _reinstall(agent, state)           # 原样放回 + 警告一次
            _warn_once(agent, target, reason)
            agent._voice_route_state = {"reasoning_config": state["reasoning_config"]}
            return agent._cached_system_prompt or system_prompt
```

换轨前 `_capture` 把 `_primary_runtime` 快照 + 一串外部字段(fallback 状态、凭据池、reasoning 拒绝
旗标)整包抓走;失败或"装不下"(会话 token 超过语音模型的压缩阈值——**切语音绝不为小模型压缩
对话**)就 `_reinstall` 原样放回并警告一次。`session_runtime_view` 再补一刀:turn 进行中 surfaces
应当报告的是**会话**的模型而非语音路由——否则桌面把临时路由采纳进 composer、新聊天继承
reasoning off。

---

## 核心类/函数

| 名称 | 位置 | 职责 |
|---|---|---|
| `ProviderRegistry` / `export` / `configured_provider_name` / `is_available_safe` | agent/provider_registry.py:31/167/190/179 | 注册表引擎与配置读取;抛异常 provider = 不可用 |
| `ImageGenProvider.generate` / `success_response` / `save_b64_image` | agent/image_gen_provider.py:47/106/83 | 文生图/编辑合一;统一信封;生成物落盘 |
| `get_active_provider`(image_gen) | agent/image_gen_registry.py:27 | 配置命中即返(可用性只过滤回落路径) |
| `TTSProvider.stream` / `TranscriptionStreamSession` | agent/tts_provider.py:43, transcription_provider.py:51 | PCM 流式;16kHz 流式转写会话 |
| `get_provider_env` | agent/web_search_provider.py:24 | 作用域安全的密钥读取(未绑 scope 拒绝回落) |
| `BrowserProvider.create_session` / `BrowserPageBackend.evaluate` | agent/browser_provider.py:44, browser_page_backend.py:32 | 云浏览器会话;secret 求值契约 |
| `decide_image_input_mode` / `extract_image_refs` / `_sniff_mime_from_bytes` | agent/image_routing.py:375/69/419 | native/text 裁决;自由文本挖图;魔法字节 MIME 嗅探 |
| `_describe_image_for_anthropic_fallback` / `image_dimensions_from_bytes` | agent/vision_message_prep.py:92, image_eviction_policy.py:63 | 非视觉回退;仅读头的尺寸探针 |
| `learned_image_token_cost` / `current_image_token_cost` / `_split_rebuilt_row` | agent/image_token_cost.py:72/77, image_replay.py:53 | 学到的每图价;turn 绑定价;重建行拆回原始部件 |
| `begin_voice_turn_route` / `end_voice_turn_route` / `session_runtime_view` | agent/voice_turn_route.py:134/200/192 | 语音路由绑定/幂等解除/会话运行时视图 |
| `long_decode_max_output_tokens` / `long_decode_hops` | agent/gemini_long_decode.py:29/37 | Gemini 4 长解码预算与跳数上界 |

## 本组文件清单

| 文件 | 主题 | 一句话 |
|---|---|---|
| `agent/image_gen_provider.py` | 图片生成 | ABC + 统一信封 + 生成物落盘 |
| `agent/image_gen_registry.py` | 图片生成 | registry 与选择规则(配置命中即返) |
| `agent/video_gen_provider.py` | 视频生成 | ABC(编辑/扩展刻意不暴露) |
| `agent/video_gen_registry.py` | 视频生成 | registry(配置未注册 fail-closed) |
| `agent/tts_provider.py` | 语音 | TTS ABC(整段 + 可选 PCM 流) |
| `agent/tts_registry.py` | 语音 | registry(内建名保留) |
| `agent/transcription_provider.py` | 语音 | STT ABC + 流式会话 |
| `agent/transcription_registry.py` | 语音 | registry(内建优先) |
| `agent/web_search_provider.py` | 搜索 | Web ABC + 作用域安全 env 读取 |
| `agent/web_search_registry.py` | 搜索 | registry(5 级优先序) |
| `agent/browser_provider.py` | 浏览器 | 云浏览器 ABC(会话三件套) |
| `agent/browser_registry.py` | 浏览器 | registry(遗留偏好序) |
| `agent/browser_page_backend.py` | 浏览器 | 自有页面传输的求值 ABC |
| `agent/browser_page_registry.py` | 浏览器 | 页面后端 registry |
| `agent/image_routing.py` | 图片生命周期 | 入站路由/挖图/MIME 嗅探/data URL |
| `agent/vision_message_prep.py` | 图片生命周期 | `VisionMessagePrepMixin` 出站准备 |
| `agent/image_eviction_policy.py` | 图片生命周期 | 出站旧图条件化成批退休 |
| `agent/image_token_cost.py` | 图片生命周期 | 从 usage 残差学的每图价 |
| `agent/image_replay.py` | 图片生命周期 | DB 重建历史的图片重放 |
| `agent/voice_turn_route.py` | 语音 turn | per-turn 模型换轨(快照/回装) |
| `agent/gemini_long_decode.py` | 模型层 | Gemini 4 多跳续传(细节见模型层文档) |

(`agent/provider_registry.py` 是共享引擎,已在走读 1 讲。)

## 与其他模块的关系

- **tools/**:`image_generate`、`video_generate`、`text_to_speech`、`transcribe_audio`、
  `web_search`/`web_extract`、`browser_exec` 的包装器消费这些 registry;`vision_analyze_tool` 是非
  视觉回退的分析器;`tools/browser_vault` 与 `browser_page_backend` 的 secret 求值协作(见
  platform_misc.md 的 vault 族)。
- **plugins/**:六个 registry 全部由 `PluginContext.register_*_provider()` 从
  `plugins/<kind>/<name>/` 或 `~/.hermes/plugins/<kind>/<name>/` 填充;卸载走快照/回滚对。
- **agent/其余**:`provider_media.save_b64/save_url` 是生成物落盘底座;`secret_scope` 支撑
  `get_provider_env` 的 fail-closed;`model_metadata` 与 `turn_preflight` 消费 `image_token_cost` 的
  ContextVar 价;`anthropic_message_convert._evict_old_screenshots` 与
  `context_compressor.evict_stale_outbound_tool_images` 是退休策略的两个消费者。
- **gateway/**:桌面语音便签、消息附件与 voice turn 标记(`_voice_turn_pending`)来自网关;
  `runtime_footer.py` 的 opt-in `served_model` 字段消费 served_model 捕获。
- **models.dev / 目录**:`supports_vision` 目录查询 + 配置覆盖决定 native 路由;`_coerce_capability_bool`
  防 YAML 引号陷阱(`"false"` 静默启用 native)。

## 总结

这一组的骨架是**一对模式**:provider ABC 定义"能做什么",registry 定义"用哪一个",插件注册,
core 零知识。学会读 `get_active_provider()` 的变体(配置命中即返 / fail-closed / 遗留偏好 /
keyless 兜底)就学会了 Hermes 对"可插拔后端"的全部态度——**显式配置的错误要精确,静默换后端
是 bug**。图片生命周期则展示了第二课:**缓存是设计约束,不是优化项**。退休按 provider 限值
条件化成批触发、重放按批次推进且字节一致、成本价经 ContextVar 让每个估计器同价——所有这些
都在回答同一道题:"改动历史里的一张图,要让 provider 重写多少字节的前缀?"答案永远是:
尽量一次都不写。
