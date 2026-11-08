# 语音与媒体生成组 —— TTS、STT、唤醒词与图像/视频

## 文件概览

声音这条链路比想象中长：模型产出文字 → `tts_tool.py` 选 provider 合成（Edge/ElevenLabs/OpenAI/本地 NeuTTS/Piper……）→ 长文分句流式 → ffmpeg 编码成 Opus/MP3 交付；反过来，用户发一条语音消息 → `transcription_tools.py` 转写（本地 faster-whisper 默认，或十余种云 provider）→ 文本进回合。`wake_word.py` 再加一层「Hey Hermes」免提交互。媒体生成侧 `image_generation_tool.py`/`video_generation_tool.py` 走 FAL.ai 与插件 provider，`vision_tools.py` 则是看图/看视频的分析工具（含历史预算控制）。本组约 39 个文件分四小群：TTS 13、STT 9+1、voice 6、media 11。本篇深讲 tts_tool.py、transcription_tools.py、wake_word.py。

## 关键代码走读

### 1. tts_tool.py：门面 + 懒 SDK + provider 表

门面的分工宣言：本模块持有配置解析、内置 provider 派发、输出策略与注册；所有后端实现住在 `tts_tool_*` 兄弟里，通过 `_origin()` 在调用时回读门面的接缝：

```python
# 来源：tools/tts_tool.py:1-9
#!/usr/bin/env python3
"""Text-to-speech tool: config resolution, built-in provider dispatch, output policy, registration.

Built-ins: Edge (free default), ElevenLabs, OpenAI, DeepInfra, MiniMax, Mistral, Gemini, xAI,
local NeuTTS / KittenTTS / Piper; plus ``type: command`` providers under ``tts.providers.<name>``
and plugin-registered ones. Output is Opus (.ogg) on voice-bubble platforms, MP3 elsewhere.
Sibling ``tts_tool_*`` modules hold backends/delivery/lifecycle; they read the seams defined
here (config, provider resolution, lazy SDK importers) through ``_origin()`` at call time."""
```

十一个 provider 意味着十一个 SDK，但语音是可选特性——全靠**懒导入工厂**：`_sdk_importer(module, attr, feature)` 返回一个闭包，首次调用才 import，可选先尽力 `pm ensure_import` 装 extra（在 config 里启用过 provider 的用户没跑过 post-setup hook 的兜底）：

```python
# 来源：tools/tts_tool.py:57-82（节选）
# --- Lazy SDK importers -- providers import only when used (headless boxes lack PortAudio etc.) ---
def _sdk_importer(module: str, attr: Optional[str] = None, feature: Optional[str] = None) -> Callable[[], Any]:
    """Lazy SDK importer: returns ``module`` (or ``module.attr``), raising ImportError when absent.

    ``feature`` names a ``pm.ensure_import`` extra to best-effort install first (users who enabled
    a provider in config.yaml never ran the post-setup hook); any failure there falls through so
    the raw import still raises cleanly. sounddevice also raises OSError without PortAudio."""
    def _import():
        if feature:
            with contextlib.suppress(Exception):
                from pm import ensure_import as _pm_ensure
                _pm_ensure(_PM_FEATURE_ALIASES.get(feature, feature))
        mod = importlib.import_module(module)
        return getattr(mod, attr) if attr else mod
    _import.__name__ = f"_import_{module.split('.')[0]}"
    return _import


_import_edge_tts = _sdk_importer("edge_tts", feature="tts.edge")
_import_elevenlabs = _sdk_importer("elevenlabs.client", "ElevenLabs", feature="tts.elevenlabs")
_import_openai_client = _sdk_importer("openai", "OpenAI")
```

兄弟分工：`_delivery` 管长文分块/ffmpeg 编码/容器修复/交付打包，`_providers` 是云家（Edge/ElevenLabs/xAI/MiniMax/Mistral/Gemini），`_local` 是本地引擎（NeuTTS/Piper/KittenTTS），`_openai` 是 OpenAI/DeepInfra，`_plugins` 路由插件注册的 provider，`_speaker` 是扬声器侧流式管线，`_lifecycle` 是本地引擎的预热/释放租约。`tts_streaming.py` 则提供 provider 无关的「句子 → int16 单声道 PCM 块迭代器」。

### 2. transcription_tools.py：STT 派发与本地模型卸载

转写门面覆盖三类 provider：本地（faster-whisper，默认免费）、用户声明的 command provider、云（groq/openai/mistral/xai/elevenlabs/deepinfra）。统一入口 `transcribe_audio(path)` 返回 `{"success", "transcript", "error"?, "provider"?}` 信封：

```python
# 来源：tools/transcription_tools.py:1-8
#!/usr/bin/env python3
"""Speech-to-text transcription used by the gateway for voice messages.

Built-in providers: local (faster-whisper, default/free), local_command, groq, openai
(also serves the managed ``nous`` selection), mistral, xai, elevenlabs, deepinfra; plus
user-declared command providers and plugin providers. ``transcribe_audio(path)`` returns
``{"success", "transcript", "error"?, "provider"?}``. This module owns provider resolution,
the dispatcher and the cached local model + idle-unload state; backends live in
``transcription_{common,audio,local,cloud,command}``."""
```

兄弟各管一段：`_audio` 是预处理（CAF 转 WAV、静音修剪、文件校验），`_chunking` 按各 provider 的上传上限切长音频，`_cloud` 是云家 handler 表（`_dispatch_stt_provider` 按本模块 globals 查 `_transcribe_<provider>`），`_local` 是本地 backend + 空闲卸载，`_streaming` 是边说边转的实时流，`_whisper_cpp` 管受管 whisper.cpp 的首次下载与校验，`stt_lease.py` 给桌面语音输入的本地 STT 做预热租约。Magic-byte 容器嗅探在 `audio_container.py`——全代码库唯一的嗅探器。

### 3. wake_word.py：一个监听者，多界面共享

唤醒词是「Hey Hermes」的免提触发器。架构上最讲究的是**单例所有权**：CLI、TUI、桌面 GUI 共享一个常驻热词监听（`wake_surface_enabled` 门控谁开），因为麦克风的打开是排他的——两个输入流抢一个设备在跨平台上不可靠。语音回合持有麦克风时调 `pause()`，空闲时 `resume()`：

```python
# 来源：tools/wake_word.py:1-9
"""Wake-word ("Hey Hermes") detection — hands-free session trigger.

One always-on hotword listener shared by CLI, TUI and desktop GUI (a single owner,
gated by ``wake_surface_enabled``). Engines live in :mod:`tools.wake_word_engines`;
this module owns config, the capture loop and the process-wide listener singleton.
Capture reuses voice mode's 16 kHz mono int16 ``sounddevice`` path on a daemon
thread; callers ``pause()`` while a voice turn holds the mic and ``resume()`` once
idle (two input streams on one device is unreliable cross-platform)."""
```

引擎可插拔：`wake_word_engines.py` 提供三实现——`_OpenWakeWordEngine`（pyopen-wakeword）、`_SherpaKwsEngine`（sherpa-onnx 关键词 spotting）、`_PorcupineEngine`（Picovoice）；引擎类**故意**在 wake_word 模块 re-export，让 `_build_engine` 在本模块上解析 `_PROVIDERS` 名字，测试/插件可以整体换引擎。模型资产在 `tools/wakewords/` 目录。配套的语音模式家族：`voice_mode.py` 是 CLI 的按住说话（PTT）录音回放，`voice_mode_transcript.py` 是纯文本助手（Whisper 幻觉过滤、语音聊天语清洗），`voice_live.py` 是 GPT-Live 全双工语音前端，`voice_client_config.py` 为客户端直连语音解析当前 profile 的 STT/TTS 配置。

### 4. media：图像/视频生成与看图

`image_generation_tool.py` 走 FAL.ai（模型在 `hermes tools` 里挑，持久化到 `image_gen.model`），目录与放大常量在 `image_generation_catalog.py`；Nous 订阅的托管选型单列在 `image_generation_managed.py`（一行选择器 + 一份模型目录）；`fal_common.py` 是 FAL SDK 的懒导入与托管网关同步客户端公共件。`video_generation_tool.py` 是**一个** `video_generate` 工具派发到插件注册的 `VideoGenProvider`（文生视频/图生视频/参考视频），xAI 专属的 Imagine 编辑/延长是独立工具（`xai_video_tools.py`）。看图侧 `vision_tools.py` 提供 `vision_analyze`/`video_analyze`，`vision_tools_image_prep.py` 管格式检测/归一化/区域裁剪，`vision_tools_history_budget.py` 管**原生视觉嵌入的历史预算**——图像烘进工具结果会随每轮 API 重发，尺寸与重复次数策略（`vision.embed_target_bytes`、`vision.max_calls_per_image`）集中在这一个文件，绝不许在工具里私开第二个计数器。`image_source.py` 是所有媒体来源（data:/http(s)/file/本地/容器）到 bytes+mime 的唯一解析器。

## 核心类/函数

| 符号 | 职责 | 位置 |
|---|---|---|
| `text_to_speech`（注册名） | TTS 工具：provider 派发、输出策略（语音气泡 Opus/其余 MP3） | `tools/tts_tool.py` |
| `_sdk_importer` | 懒 SDK 导入工厂（可选先 pm ensure_import） | `tools/tts_tool.py:58` |
| `stream_tts_to_speaker`（tts_tool_speaker） | 扬声器侧流式管线 | `tools/tts_tool_speaker.py` |
| `_split_text_for_tts` / `_convert_to_opus`（tts_tool_delivery） | 长文分块与 ffmpeg 编码/容器修复 | `tools/tts_tool_delivery.py` |
| `streaming_pcm_chunks`（tts_streaming） | 句子 → int16 单声道 PCM 迭代器（provider 无关） | `tools/tts_streaming.py` |
| `transcribe_audio` | STT 统一入口：`{success, transcript, error?, provider?}` | `tools/transcription_tools.py` |
| `_dispatch_stt_provider` | provider handler 派发（查本模块 `_transcribe_*` globals） | `tools/transcription_tools.py` |
| `transcribe_oversized`（transcription_chunking） | 超上传上限的长音频切分转写 | `tools/transcription_chunking.py` |
| `WakeWordListener`（wake_word） | 进程级单例监听：capture 循环 + pause/resume | `tools/wake_word.py` |
| `_OpenWakeWordEngine` / `_SherpaKwsEngine` / `_PorcupineEngine` | 三个可插拔热词引擎 | `tools/wake_word_engines.py` |
| `image_generate`（注册名） | FAL.ai 图像生成（模型目录选择） | `tools/image_generation_tool.py` |
| `video_generate`（注册名） | 单工具派发到插件 VideoGenProvider | `tools/video_generation_tool.py` |
| `vision_analyze`（注册名） | 图像/视频分析（原生嵌入 + 历史预算） | `tools/vision_tools.py` |
| `resolve_media_source`（image_source） | data:/http(s)/file/容器 → bytes+mime 的唯一解析 | `tools/image_source.py` |

## 本组文件清单

TTS 群（13 个文件）：

| 文件 | 一句话角色 |
|---|---|
| `tools/tts_tool.py` | TTS 门面：配置、provider 派发、输出策略、注册。 |
| `tools/tts_tool_delivery.py` | 长文分块、ffmpeg 编码、容器修复、交付打包。 |
| `tools/tts_tool_lifecycle.py` | 本地引擎的预热/释放租约。 |
| `tools/tts_tool_local.py` | 本地引擎：NeuTTS、Piper、KittenTTS。 |
| `tools/tts_tool_openai.py` | OpenAI 与 DeepInfra 后端。 |
| `tools/tts_tool_plugins.py` | 插件注册的 TTS provider 路由。 |
| `tools/tts_tool_providers.py` | 云后端：Edge、ElevenLabs、xAI、MiniMax、Mistral、Gemini。 |
| `tools/tts_tool_speaker.py` | 扬声器侧流式管线。 |
| `tools/tts_command_provider.py` | 用户配置的 shell command TTS/STT 公共运行器。 |
| `tools/tts_elevenlabs_voices.py` | ElevenLabs 声音搜索（`find_voices` 参数）。 |
| `tools/tts_streaming.py` | provider 无关的句子→PCM 流式迭代。 |
| `tools/tts_text_normalize.py` | Markdown → 口播脚本的确定性清洗。 |
| `tools/neutts_synth.py` | 独立 NeuTTS 合成助手（samples/ 随包）。 |

STT 群（10 个文件）：

| 文件 | 一句话角色 |
|---|---|
| `tools/transcription_tools.py` | STT 门面：provider 解析、派发、本地模型缓存/卸载。 |
| `tools/transcription_audio.py` | 音频预处理：CAF 转 WAV、静音修剪、校验。 |
| `tools/transcription_chunking.py` | 各 provider 上传上限与长音频切分。 |
| `tools/transcription_cloud.py` | 云 STT provider handlers。 |
| `tools/transcription_command.py` | 用户声明与插件 STT provider。 |
| `tools/transcription_common.py` | 常量、结果信封、小配置读取器。 |
| `tools/transcription_local.py` | 本地 STT backend（faster-whisper 等）。 |
| `tools/transcription_streaming.py` | 实时流式转写（边说边出部分/最终文本）。 |
| `tools/transcription_whisper_cpp.py` | 受管 whisper.cpp 命令与首次下载校验。 |
| `tools/stt_lease.py` | 桌面语音输入的本地 STT 预热租约。 |

voice 群（6 个文件）：

| 文件 | 一句话角色 |
|---|---|
| `tools/voice_mode.py` | CLI 按住说话：录音与回放。 |
| `tools/voice_mode_transcript.py` | 语音模式纯文本助手（幻觉过滤、语清洗）。 |
| `tools/voice_client_config.py` | 客户端直连语音的 profile STT/TTS 配置解析。 |
| `tools/voice_live.py` | GPT-Live 全双工语音前端。 |
| `tools/wake_word.py` | 唤醒词门面：配置、capture 循环、进程级单例。 |
| `tools/wake_word_engines.py` | 三个热词引擎（openwakeword/sherpa/porcupine）。 |

media 群（11 个文件）：

| 文件 | 一句话角色 |
|---|---|
| `tools/image_generation_tool.py` | FAL.ai 图像生成工具。 |
| `tools/image_generation_catalog.py` | FAL 图像模型目录与放大常量。 |
| `tools/image_generation_managed.py` | Nous 订阅的托管图像生成选型。 |
| `tools/image_source.py` | 所有媒体来源 → bytes+mime 的唯一解析器。 |
| `tools/video_generation_tool.py` | `video_generate`：派发到插件 VideoGenProvider。 |
| `tools/xai_video_tools.py` | xAI Imagine 视频编辑/延长工具。 |
| `tools/fal_common.py` | FAL SDK 懒导入与托管网关同步客户端。 |
| `tools/vision_tools.py` | `vision_analyze`/`video_analyze` 工具。 |
| `tools/vision_tools_history_budget.py` | 原生视觉嵌入的历史预算（尺寸/重复策略唯一归属）。 |
| `tools/vision_tools_image_prep.py` | 图像格式检测、归一化、区域裁剪。 |
| `tools/audio_container.py` | 共享 magic-byte 音频容器嗅探（全库唯一）。 |

## 与其他模块的关系

- `gateway/`：语音消息 → `transcribe_audio`；回复 → `text_to_speech`；语音气泡平台拿 Opus。
- `tools/tool_backend_helpers.py`：`resolve_provider_secret` 是所有语音 key 的统一解析（config > env/.env > 池）。
- `pm`（包管理）：懒导入失败时 `pm ensure_import` 尽力补装 extra。
- `plugins/`：TTS/STT/VideoGen 都接受插件注册的 provider（`ctx` 注册）。
- `tools/mcp.md` 之外的媒体边界：`vision_tools_history_budget.py` 是嵌入成本策略的唯一归属，AGENTS.md 明令不得私开第二计数器。

## 总结

语音组的工程母题是**懒与让渡**。懒：11 个 TTS provider 的 SDK 全部懒导入、本地模型空闲即卸载、whisper.cpp 首次使用才下载——语音是可选能力，不能拖累每个进程的启动。让渡：引擎可插拔（热词三个实现整体可换）、provider 全部可插件注册、媒体来源统一一个解析器、嵌入成本策略收口一个文件。设计上还有两处跨模块的自觉：唤醒词的单例所有权（麦克风排他）与 TTS 输出随平台变形（语音气泡 Opus、其他 MP3）——都是「同一个能力，不同 surface 不同交付」的具体化。
