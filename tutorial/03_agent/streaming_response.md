# 流式与响应整流（agent/ 流式子系统）

## 文件概览

模型响应从 socket 到用户屏幕要过五道工序，每道工序一组文件：

1. **请求双路径**：`chat_completion_helpers.py`（4,001 行）—— 流式
   `_StreamingCall` 与非流式 `_NonStreamRequest`（worker 线程 + 轮询监控），
   外加 `build_api_kwargs` 请求装配。
2. **流纪律**：`stream_single_writer.py`（单写者围栏）、`stream_diag.py`
   （断流诊断）、`stream_max_lifetime.py`（总寿命帽）、`stream_delivery.py`
   （delta 风扇出）、`chat_completion_stream_monitor.py`（心跳/陈旧检测）。
3. **推理清洗**：`think_scrubber.py`（跨 delta 状态机剥 `<think>` 块）、
   `reasoning_carriers.py`（provider 原生思考载体）、`reasoning_effort/params/
   promotion/summaries/timeouts.py`。
4. **响应整流**：`message_sanitization.py`（消毒）、`bounded_response.py`
   （有界错误体读取）、`empty_response_guard.py`（空响应守卫）、
   `repetition_guard.py`（重复循环检测）、`markdown_tables.py`（CJK 表格对齐）。
5. **呈现**：`display.py`（spinner/工具预览）、`status_output.py`（状态/警告管线）。

双路径的统一入口是 `interruptible_api_call`（非流式）与
`interruptible_streaming_api_call`（流式），两者都跑在「可中断」语义下：调用者
不必等完整 HTTP 往返就能感知中断。

## 关键代码走读

### 1. 非流式路径：worker 线程 + 陈旧调用击杀

非流式请求在 worker 线程上跑，调用者轮询。陈旧连击（连续多次无响应）超过阈值
就直接抛错，不再碰网络：

```python
# agent/chat_completion_helpers.py:1260
def interruptible_api_call(agent, api_kwargs: dict):
    """Run the API call on a worker thread so the caller can detect interrupts
    without waiting for the full HTTP round-trip. Each worker gets its own
    per-request client (interrupts close only that one); a stale-call detector
    kills the connection and raises so the main retry loop can back off / rotate
    credentials / fall back."""
    # Nested-pool contexts (cron, delegated children) wedge on a worker thread
    # (#62151): run inline. See should_use_direct_api_call.
    if should_use_direct_api_call(agent):
        return direct_api_call(agent, api_kwargs)
    _check_stale_giveup(agent)  # cross-turn stale breaker (#58962), non-streaming sibling
    from agent.chat_completion_nonstream import _NonStreamRequest

    return _NonStreamRequest(agent, api_kwargs).run()
```

`_NonStreamRequest`（`chat_completion_nonstream.py:13`）把 worker（`_call`）与
轮询循环共享的状态放在实例上，`_abort_request` 可能从轮询的「陌生线程」调用 ——
所以共享状态全部按跨线程可变设计。

### 2. 流式路径：`_StreamingCall`

流式请求是一个「请求线程 + 轮询监控」双线程协作体。看 `__init__` 的字段就能
读懂它要处理的所有边界情况：

```python
# agent/chat_completion_helpers.py:2699（节选）
class _StreamingCall(StreamingWaitMonitor):
    """One streaming request on the chat_completions / anthropic_messages wire.
    State shared between the request worker and the poll-loop monitor (heartbeat,
    stale kill, interrupt abort) lives on the instance, mutated from both threads."""

    def __init__(self, agent, api_kwargs: dict, on_first_delta):
        self.agent = agent
        self.api_kwargs = api_kwargs
        self.on_first_delta = on_first_delta
        self.worker = None  # request thread; None in inline mode
        self.result = {"response": None, "error": None, "partial_tool_names": []}
        self.clients = _RequestClientRegistry(agent)
        # Request-local cancel flag: the worker recognizes its own interrupt
        # force-close (RemoteProtocolError) and exits instead of retrying (#6600).
        self._request_cancelled = {"value": False}
        self.first_delta_fired = {"done": False}
        self.deltas_were_sent = {"yes": False}  # for the partial-delivery fallback
        self.provider_tool_in_flight = {"yes": False}
        # Last REAL chunk; the monitor detects SSE-ping-only connections with it.
        self.last_chunk_time = {"t": time.time()}
        ...
        # Per-attempt: single-writer token, request-local client, raw HTTP response (chat wire).
        self._writer_token = self._attempt_request_client = self._attempt_stream_response = None
        # The route ``api_kwargs`` was assembled for; a retry must not replay it on another one.
        self._request_route = self._live_route()
```

值得注意的三个字段：`last_chunk_time` 用来识别「只发 SSE ping 不发真实块」的
僵尸连接；`_request_route` 捕获请求装配时的路由，`/model` 中途切换时重试会把
错误交回 turn 循环重建请求（`_route_switched_under_request`，行 2738）而不是把
旧模型的 payload 发到新 base_url；每个 attempt 拿独立的单写者 token 和请求级
client。

流式入口在最终分派前处理特殊 api_mode 并做同样的陈旧连击检查：

```python
# agent/chat_completion_helpers.py:3977
def interruptible_streaming_api_call(agent, api_kwargs: dict, *, on_first_delta=None):
    """Streaming variant of _interruptible_api_call: fires the delta callbacks per
    text token (tool-call turns suppress them) and returns a SimpleNamespace in
    the non-streaming response shape. codex_responses delegates to the already-
    streaming codex runner; cron turns and delegated children run inline."""
    if agent._interrupt_requested:
        raise InterruptedError("Agent interrupted before streaming API call")
    if agent.api_mode == "codex_responses":
        return _stream_codex_passthrough(agent, api_kwargs, on_first_delta)
    if agent.api_mode == "bedrock_converse":
        return _BedrockStream(agent, api_kwargs, on_first_delta).run()
    # Cross-turn stale-stream circuit breaker (see ``_stale_streak()``).
    _check_stale_giveup(agent)
    return _StreamingCall(agent, api_kwargs, on_first_delta).run()
```

陈旧熔断器本身只有十行，但它区分「显式 env 设定 = 用户死线，永不封顶」：

```python
# agent/chat_completion_helpers.py:608
def _check_stale_giveup(agent) -> None:
    """Raise immediately when the consecutive-stale streak is past the
    give-up threshold — no network attempt, no stale-timeout wait."""
    _giveup = stale_giveup()
    _streak = _stale_streak(agent)
    if _giveup > 0 and _streak >= _giveup:
        raise RuntimeError(
            "Provider has been unresponsive (no response received) for "
            f"{_streak} consecutive stale attempts — aborting this call to "
            "avoid an indefinite stall. Switch models or start a new session, then retry."
        )
```

### 3. 单写者纪律：`stream_single_writer.py`

同一会话可能出现两个并发 delta 源（比如重试叠加）。围栏只丢弃**可证明被取代**
的流，绝不丢弃唯一写者；agent 没有围栏时降级为「无围栏」而不是崩溃：

```python
# agent/stream_single_writer.py:1（模块 docstring，节选）
"""Best-effort accessors for the single-writer stream fence.

The fence lives on ``AIAgent`` (``_claim_stream_writer`` / ``_stream_writer_is_current``) but is
used from other streaming modules. Calling it directly would turn an *additive* safety net into a
fatal AttributeError on a partially-updated checkout, hot-reloaded gateway, duck-typed agent, or
test double (a cron job died this way). The fence may only drop a *provably* superseded stream,
never the sole writer, so when it is unavailable or raises the degradation is "no fence".
"""

def claim_stream_writer(agent: Any) -> int:
    """Claim the delta sink for this stream attempt; ``0`` (never fenced) when the agent lacks the fence or the claim raised."""
    return _fence_call(agent, "_claim_stream_writer", int, 0, "claim failed; proceeding unfenced")
```

### 4. 推理清洗：跨 delta 的 `<think>` 状态机

逐 delta 跑正则会把「单独到达的 `<think>` 开头」抹掉，导致下游状态机泄漏推理
文本。`StreamingThinkScrubber` 在 delta 边界持有半个标签，直到它被证实或证伪：

```python
# agent/think_scrubber.py:23（节选）
# The one list of model reasoning tag names. Every surface that hides reasoning (this scrubber,
# the CLI stream filter, the gateway stream filter, the final-response regex stripper) binds to
# these; a tag added here is covered everywhere. Consumers match case-insensitively, so the
# literal tags are lowercase. The CJK names cover models (MiniMax-M3) that emit Chinese reasoning
# tags: 思考 (think), 反思 (reflect), 推理 (reason), 推敲 (deliberate).
THINK_TAG_NAMES: tuple[str, ...] = (
    "think", "thinking", "reasoning", "thought", "REASONING_SCRATCHPAD",
    "思考", "反思", "推理", "推敲",
)
```

```python
# agent/think_scrubber.py:31
class StreamingThinkScrubber:
    """Stateful scrubber for streaming reasoning/thinking blocks.

    State: ``_in_block`` (inside an open block; text discarded), ``_buf`` (held-back partial-tag
    tail), ``_last_emitted_ended_newline`` (True iff the last emission ended with ``\\n`` or nothing
    was emitted yet — decides whether an open tag at buffer position 0 sits at a block boundary).
    """
```

一个标签名单覆盖所有表面：流式 scrubber、CLI 流过滤器、网关流过滤器、最终响应
正则剥离器 —— 在这里加一个标签，到处生效。开标签只在块边界（流首/换行后）开启
块，所以**提到** `<think>` 的正文不会被误伤；闭合对则总是抑制。

provider 原生的思考载体由 `reasoning_carriers.py` 处理：Gemini 的
`thought_signature` 等被捕获为一条私有 `reasoning_details` 记录持久化，发送时只
由声明它的路由重新抬回线上（`shape_wire_carriers`），其他路由全部剥离。

### 5. 响应整流四守卫

**消毒**（`message_sanitization.py`）：修复或剥离会让 OpenAI SDK 的 `json.dumps`
崩溃或被上游拒绝的字符 —— 纯函数、原地变更语义有文档标注。

**有界错误体读取**（`bounded_response.py`）：非 OK 的流式响应要读 body 出诊断，
但裸 `response.read()` 既可能内存爆炸也可能永远卡住：

```python
# agent/bounded_response.py:1（节选）
"""Bounded reads of HTTP error response bodies.

On a non-OK *streaming* response Hermes reads the body for a diagnostic (only ever shown truncated to
a few hundred chars). A bare ``response.read()`` is unbounded two ways: arbitrarily large body
(memory) or a body that stalls forever (hang). ``read_streaming_error_body`` caps bytes and enforces a
hard wall-clock deadline; ... ``httpx.iter_bytes()`` blocks *inside* the socket read, so the
read runs on a daemon thread; on timeout we close the response (unblocking the read) and return the
partial bytes.
"""
```

**空响应守卫**（`empty_response_guard.py`）：无信号空完成（success、零输出
token）与被信号拒绝（content_filter）不同，前者重试最多 3 次后走 fallback 链，
每次重试都全额计费输入。两个独立守卫都 fail-open：连续两次
`output_tokens == 0` 的确定性空 → 直接跳 fallback；单次空响应估算输入成本超阈值
→ 提前止损。

**重复循环守卫**（`repetition_guard.py`）：退化重复循环能烧光全部输出预算
（真实事故：一条 60k 字符的 turn 被拆成 31 条 Discord 消息）。检测在
`finish_reason=length` 的「继续」助推之前做，只对 60+ 字符的长逐字重复且占片段
多数的情况触发 —— 刻意保守。

### 6. 呈现层

`display.py` 是无 `AIAgent` 依赖的纯展示函数（spinner、工具预览、diff）；
`markdown_tables.py` 用 `wcwidth` 重排模型输出的 CJK 表格（模型按「一格一字符」
补空格，中日韩字形占两格，行会漂移）；`status_output.py` 是 `AIAgent` 的状态/
警告管线：安全打印、quiet-mode 门控、去重的上下文溢出警告，以及只在所有重试/
回退耗尽后才展示的缓冲重试碎语。

## 核心类/函数

| 名称 | 文件:行号 | 职责 |
|---|---|---|
| `build_api_kwargs()` | chat_completion_helpers.py:1503 | 请求装配：消息/工具/reasoning/缓存标记 |
| `interruptible_api_call()` | chat_completion_helpers.py:1260 | 非流式入口：worker 线程 + 陈旧熔断 |
| `interruptible_streaming_api_call()` | chat_completion_helpers.py:3977 | 流式入口：codex/bedrock 分派 + `_StreamingCall` |
| `_StreamingCall` | chat_completion_helpers.py:2699 | 单个流式请求：worker+监控双线程共享状态 |
| `_NonStreamRequest` | chat_completion_nonstream.py:13 | 单个非流式请求：worker 生命周期 + 看门狗轮询 |
| `_check_stale_giveup()` | chat_completion_helpers.py:608 | 跨 turn 陈旧连击熔断（不碰网络直接抛） |
| `claim_stream_writer()` | stream_single_writer.py:18 | 单写者围栏的降级安全访问 |
| `StreamingThinkScrubber` | think_scrubber.py:31 | 跨 delta 的 `<think>` 块状态机剥离 |
| `THINK_TAG_NAMES` | think_scrubber.py:23 | 全表面共享的推理标签名单（含中文标签） |
| `shape_wire_carriers()` | reasoning_carriers.py | 原生思考载体按路由抬回/剥离 |
| `read_streaming_error_body()` | bounded_response.py | 有界 + 死线错误体读取（daemon 线程） |
| 两个空响应守卫 | empty_response_guard.py | 确定性空检测 + 成本感知预算，均 fail-open |
| 重复守卫 | repetition_guard.py | 长逐字重复检测，阻断「继续」助推 |
| `realignment` | markdown_tables.py | wcwidth 感知的 CJK markdown 表格重排 |
| `StatusOutputMixin` | status_output.py | 状态/警告/去重溢出警告管线 |

## 本组文件清单

| 文件 | 一句话 |
|---|---|
| chat_completion_helpers.py | 双路径入口 + 请求装配 + `_StreamingCall`（4,001 行） |
| chat_completion_helpers_relay.py | relay 路由的 chat completion 辅助 |
| chat_completion_helpers_tool_calls.py | 工具调用轮的辅助（抑制 delta 等） |
| chat_completion_local.py | 本地 runtime（llama.cpp 等）的 completion 辅助 |
| chat_completion_nonstream.py | `_NonStreamRequest`：worker 生命周期 + 看门狗轮询 |
| chat_completion_stream_monitor.py | 流监控的展示/心跳阶段 + 陈旧击杀善后 |
| chat_completion_wait_notice.py | 等待提示（首 token 前的 UI 反馈） |
| chat_completion_headers.py | 路由派生请求头 |
| stream_delivery.py | `StreamDeliveryMixin`：delta/推理 hook 风扇出 + 临时文本去重 |
| stream_diag.py | 断流诊断：per-attempt 计数、异常链、重试日志 |
| stream_max_lifetime.py | 可选的总寿命帽（stale 检测管间隙，它管总时长） |
| stream_single_writer.py | 单写者围栏的降级安全访问器 |
| lazy_forward.py | `lazy_attr`/`forward`：facade 的惰性转发原语 |
| think_scrubber.py | 流式 `<think>` 块状态机剥离器 |
| reasoning_carriers.py | Gemini `thought_signature` 等原生思考载体捕获/重放 |
| reasoning_effort.py | reasoning effort 等级的解析与路由协商 |
| reasoning_params.py | reasoning 配置到线上参数的映射 |
| reasoning_promotion.py | reasoning-only 停止是否可提升为可见回答（限可信路由） |
| reasoning_summaries.py | 推理摘要的处理 |
| reasoning_timeouts.py | 推理阶段超时处理 |
| thinking_timeout_guidance.py | 思考超时的用户指引文案 |
| message_sanitization.py | 消息/载荷消毒（防 `json.dumps` 崩溃/上游拒绝） |
| message_content.py | 消息内容扁平化辅助 |
| message_metadata.py | 消息元数据（absorbed 标记等） |
| bounded_response.py | 有界错误体读取（字节帽 + 墙钟死线） |
| empty_response_guard.py | 无信号空响应的两守卫（确定性空 + 成本预算） |
| repetition_guard.py | 退化重复循环检测（流中/完成后皆可查） |
| markdown_tables.py | CJK/宽字符感知的 markdown 表格重对齐 |
| display.py | CLI 呈现：spinner、工具预览、diff（纯函数） |
| status_output.py | 状态/警告/notice 管线 + 缓冲重试碎语 |

## 与其他模块的关系

- **agent/turn_pipeline**：双路径入口由 turn 循环调用；错误向上交给
  `error_classifier.classify_api_error`（见本组 `errors_resilience.md`），
  溢出类错误路由到 `turn_overflow.py`。
- **agent/prompt_caching**：`build_api_kwargs` 在装配末尾消费
  `PromptCachePlan`；流式重试重建请求时标记随 `_strip_prior_decoration` 幂等重贴。
- **agent/errors / interrupt 族**：`_request_cancelled` 与 `InterruptControlMixin`
  的硬中断协作 —— worker 识别自己的强制关闭异常后退出而非重试（#6600）。
- **gateway**：网关流式适配器消费同一套标签名单与 `stream_diag` 诊断；
  TUI/desktop 靠 `error_surface.py` 的描述符理解失败层。
- **hermes_cli**：`display.py` 同时服务 CLI REPL 的本地呈现。

## 总结

流式子系统的两条主线是**可中断**与**可信**。可中断靠双路径的 worker+轮询结构
（调用者永远不必等完整 HTTP 往返）、请求级 client（中断只关一个连接）和跨 turn
的陈旧连击熔断；可信靠层层守卫：单写者围栏防并发 delta 串台、状态机 scrubber 防
推理文本泄漏（一份标签名单覆盖所有表面）、有界读取防诊断本身挂死、空响应/重复
守卫防预算被无声烧光。所有守卫共享一个哲学：**fail-open 或降级，绝不因安全网
本身不可用而崩溃** —— `stream_single_writer` 的「无围栏即无操作」是最好的例子。
读代码时建议按「入口 → 双路径类 → 守卫」的顺序，配合 `#6600`、`#81867`、
`#112121` 这类 issue 注释理解每个字段的来历。
