# 本地模型运行时与转发代理

## 文件概览

本篇覆盖两个小子系统：

- **`hermes_cli/local_runtime/`（19 文件 + catalog.json）**：托管 llama.cpp 本地模型运行时——检测、硬件估算、进程监督、恢复；
- **`hermes_cli/proxy/`（5 文件 + adapters/ 4 文件）**：本地 OpenAI 兼容转发代理，给 OAuth 化的上游附加凭据。

## 关键代码走读

### detect.py：指纹级实例检测

```python
# hermes_cli/local_runtime/detect.py:1-9
"""Detection of running llama-server instances.

Probes well-known local roots and fingerprints genuine llama-server via /props (build_info + model
fields — Ollama and LM Studio answer /v1/models but not /props). Detection never needs a key, but
honors one if the probed server requires it (401 -> detected, auth_required=True).
"""

# 行 13-15
# Always 127.0.0.1 — resolving localhost costs ~2s/request on Windows.
DEFAULT_PROBE_PORTS = (8080,)  # llama-server default; managed port comes from config
```

指纹用 `/props` 而非 `/v1/models`：Ollama 和 LM Studio 都会应答后者，但只有真 llama-server 有 `/props` 的 build_info + model 字段。探测永远打 `127.0.0.1`——Windows 上解析 `localhost` 每请求多花约 2 秒（IPv6 回退），这条教训在 supervisor.py 里重复出现。

### estimator.py：逐层显存估算

```python
# hermes_cli/local_runtime/estimator.py:1-5
"""Per-layer context-memory estimator + physics check.

The estimator is ADVISORY: fit's allocation is authoritative at launch and the touch generation is
ground truth after it. Unknown shapes round UP (never underestimate memory).
"""
# 行 12-17
# q8_0: 34-byte blocks of 32 f16-equivalent elements (exact).
_Q8_BYTES_PER_ELEM = 34 / 32
_F16_BYTES_PER_ELEM = 2.0

# Architectures with a known SWA layer pattern: arch -> fraction of layers that are
# sliding-window. Unknown SWA archs treat every layer as full attention (overestimate; safe).
_SWA_LAYER_FRACTION = {"gemma3": 5 / 6, "gemma2": 1 / 2}
```

估算器只是**建议**：启动时以 fit 的分配为准，启动后以 touch generation（真跑一遍）为准。未知形状一律向上取整——永不低估显存。

### supervisor.py：路由模式的进程监督

```python
# hermes_cli/local_runtime/supervisor.py:1-6
"""Supervision of one llama-server in router mode.

The router process is ours (restart with backoff on crash); router children are its problem — child
failures surface via GET /models exit_code, never auto-retried here. Learned on real hardware:
health-200 is NOT readiness — every readiness claim requires a touch generation (temp-0, expected
token, generous budget, reasoning_content scanned); always dial 127.0.0.1 ...
```

监督边界清晰：**router 进程归我们**（崩溃退避重启），router 的子模型是它自己的事——子失败经 `GET /models` 的 exit_code 冒出，这里绝不自动重试。健康检查 200 ≠ 就绪：每次就绪声明都要一次 touch generation（temp-0、期望 token、宽预算、扫 reasoning_content）。

### proxy/server.py：凭据附加转发器

```python
# hermes_cli/proxy/server.py:1-5
"""HTTP server that forwards OpenAI-compatible requests to a configured upstream.

A credential-attaching forwarder: request/response bodies are never mediated, logged, or rewritten.
The one shim: after a *clean* upstream EOF, a ``text/event-stream`` response that carried a terminal
``finish_reason`` or ``lastOne: true`` but omitted ``data: [DONE]`` gets a single ``[DONE]`` frame.
"""
# 行 37-40
_HOP_BY_HOP_HEADERS = frozenset({
    "host", "content-length", "connection", "keep-alive", "proxy-authenticate",
    "proxy-authorization", "te", "trailers", "transfer-encoding", "upgrade", "authorization",
})
```

转发语义：请求/响应体**不中介、不记录、不重写**；剥离 hop-by-hop 头，`authorization` 换成上游 bearer。唯一的 shim 是 SSE `[DONE]` 帧补全——严格 OpenAI 客户端把没有 `data: [DONE]` 的流视为截断：

```python
# hermes_cli/proxy/sse_done.py:1-6
"""SSE ``[DONE]`` sentinel normalization for OpenAI-compatible proxies.

Strict OpenAI clients treat a stream without ``data: [DONE]`` as truncated. The tracker watches the
forwarded SSE bytes and says whether to append ONE ``[DONE]`` after a *clean* upstream EOF: only after
a terminal choice (``finish_reason`` non-null) or ``lastOne: true``; never after an error event, an
interrupted stream, or when the upstream already sent ``[DONE]``.
"""
```

适配器：`adapters/base.py` 定义 `UpstreamAdapter` 抽象；`nous_portal.py`、`xai.py` 是两个 OAuth 上游实现。代理默认绑 `127.0.0.1:8645`，请求体上限 10 MB。

## 核心类/函数

| 符号 | 文件 | 职责 |
|---|---|---|
| `DetectedServer` | local_runtime/detect.py:17 | 探测结果 dataclass（含 auth_required） |
| `fit` / 估算常量 | local_runtime/estimator.py | 逐层上下文显存估算 + 物理检查 |
| `supervise` / restart 循环 | local_runtime/supervisor.py | router 崩溃退避重启 |
| `bootstrap` | local_runtime/bootstrap.py | config → 已装 binary → 运行中受监督 server |
| `probe` | local_runtime/devices.py | 可弃进程里问 llama.cpp 看到了哪些加速器 |
| `resolve_endpoint` | local_runtime/endpoint.py | llamacpp-alias 请求的端点解析 |
| `contain` | local_runtime/processes.py | 包住每个托管 router 树，不收养属主进程 |
| `recover` | local_runtime/recovery.py | 本托管 runtime 记录的唯一 router 的保守恢复 |
| `SseDoneTracker` | proxy/sse_done.py:18 | 转发字节的增量扫描器 |
| `UpstreamAdapter` | proxy/adapters/base.py | 上游适配器抽象 |
| `HOP_BY_HOP_HEADERS` | proxy/server.py:37 | 剥头清单（authorization 替换为上游 bearer） |

## 本组文件清单

### local_runtime/（19 文件 + catalog.json）

| 文件 | 职责 |
|---|---|
| __init__.py | 托管 llama.cpp runtime 包入口 |
| binaries.py | PM 拥有的 llama.cpp 二进制的硬件选择；可变运行态分离 |
| bootstrap.py | 托管 runtime 的 bootstrap：config → 已装 binary → 运行中受监督 server |
| capabilities.py | 托管 runtime 所服务模型的能力应答 |
| catalog.py | 托管本地 runtime 的精选起始目录 |
| catalog.json | 目录数据文件 |
| context_policy.py | 上下文策略——托管本地模型的窗口阶梯 |
| detect.py | 运行中 llama-server 实例的探测与指纹 |
| devices.py | 用已装 llama.cpp 构建在可弃进程里问加速器 |
| endpoint.py | llamacpp-alias 请求的端点解析（provider 集成） |
| estimator.py | 逐层上下文显存估算 + 物理检查 |
| gguf.py | GGUF 元数据 + 张量表读取（仅 stdlib） |
| growth.py | 托管 llama.cpp runtime 的会话内上下文增长 |
| hardware.py | 活体硬件预算探测 |
| hf_browse.py | 浏览 Hugging Face 找用户跑得动的 GGUF |
| load_progress.py | 托管 llama-server router 的实时模型加载进度 |
| presets.py | 每模型 preset 生成（--models-preset INI）——context-policy 的 router 侧载体 |
| processes.py | 包住每个托管 router 树而不收养属主进程 |
| recovery.py | 本托管 runtime 记录的唯一 router 的保守恢复 |
| supervisor.py | router 模式 llama-server 的监督（崩溃退避 + touch-generation 就绪） |

### proxy/（8 文件）

| 文件 | 职责 |
|---|---|
| __init__.py | 转发到 OAuth 上游的本地 OpenAI 兼容代理 |
| cli.py | `hermes proxy` 子命令的 CLI handler |
| server.py | HTTP 服务器：转发 OpenAI 兼容请求到上游；体不中介不记录；补 [DONE] 帧 |
| sse_done.py | SSE [DONE] 哨兵归一化（干净 EOF + 终止选择才补一帧） |
| adapters/__init__.py | 上游适配器注册表 |
| adapters/base.py | UpstreamAdapter 抽象；服务器其余部分 provider 无关 |
| adapters/nous_portal.py | Nous Portal 上游适配器 |
| adapters/xai.py | xAI Grok OAuth 上游适配器 |

## 与其他模块的关系

- **models.py / models_local.py**：本地模型目录与 Ollama/LM Studio 发现共享命名。
- **web_routers/local_models.py**：dashboard 的本地模型窗口调本簇。
- **pm/**：llama.cpp 二进制由 PM 环境拥有（binaries.py 注明「PM-owned」）。
- **auth.py**：proxy 的 OAuth 凭据与 provider 凭据系统同源。

## 总结

本地运行时的三条硬教训写在源码注释里：**(1) 指纹用 /props 不用 /v1/models；(2) 永远打 127.0.0.1；(3) health-200 不是就绪——就绪必须 touch generation**。代理则是一个诚实的转发器：只附加凭据与补 `[DONE]`，其余字节不碰。
