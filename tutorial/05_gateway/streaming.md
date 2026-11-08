# streaming.md —— 流式契约、GatewayStreamConsumer 与通知唤醒

## 文件概览

本篇覆盖「agent 边跑边说」的整套机制与「跑完之后的主动告知」：

- **typed 事件契约**（`stream_events.py`）：agent 线程向网关广播「发生了什么」的冻结数据类——**事件描述传输，从不描述上下文**：网关「吃掉」的任何字节都不许偏离 agent 自己持有的消息历史。
- **GatewayStreamConsumer**（`stream_consumer.py`）：把同步的 agent 回调桥到异步平台投递——`on_delta()` 入队，异步任务缓冲、限速、**逐步编辑同一条平台消息**。
- **四个横切 mixin**（think 过滤、代码围栏、附件 hold-back、回退）与 **TTS 流式消费者**。
- **通知与唤醒**（`run_notifications*.py`、`wake.py`、`run_goals.py` 家族）：后台进程完成、目标续跑、心跳——它们以 `internal=True` 合成事件回到 `message_flow.md` 的同一条管线。

## 关键代码走读

### 1. stream_events.py：七个事件、一个显式 union

```python
# 来源：gateway/stream_events.py:1-7
"""Structured streaming events — the agent→gateway delivery contract.

Typed *what happened* events (frozen dataclasses, no I/O) emitted from the agent's
worker thread; ``GatewayStreamConsumer`` is the sink and the adapter decides rendering.
Events describe *transport*, never *context*: whatever the gateway "eats" must never
diverge from the agent-owned message history."""
```

七个事件各管一件事：`MessageChunk`（正文增量，think 内容已在源头滤掉）、`MessageStop`（`final=True` 仅用于 turn 的终点停——中间停表示 text→tool→text 的段切换）、`Commentary`（工具迭代之间的**完整**过渡消息，非增量）、`ToolCallChunk`（工具开跑，`index` 单调可关联起止）、`ToolCallFinished`（工具结束，带时长与 ok；**工具输出永远不走这里**——输出是历史）、`LongToolHint`（长工具的一次性引导提示，网关按平台能力与首用门控）、`GatewayNotice`（网关自产控制消息，`kind` 是稳定字符串：restart/online/long_run…）：

```python
# 来源：gateway/stream_events.py:70-72
# Explicit union (not a marker base class) so a missing ``case`` in an
# exhaustive match is a visible type error rather than a silent fall-through.
StreamEvent = MessageChunk | MessageStop | Commentary | ToolCallChunk | ToolCallFinished | LongToolHint | GatewayNotice
```

用显式 union 而不是公共基类：消费端 `match` 少写一个 case 就是**类型错误**，不是静默漏接。分发器 `stream_dispatch.py` 把事件分两路——消息事件进 consumer，工具事件经 adapter 的 `format_tool_event`（返回 None = 在没有工具「chrome」的平台吃掉）后进同一条工具进度队列，**同步、可在 agent 工作线程直接调**，两条路因此永不竞速。

### 2. GatewayStreamConsumer：同步→异步的桥

```python
# 来源：gateway/stream_consumer.py:1-7
"""Gateway streaming consumer — bridges sync agent callbacks to async platform delivery.

on_delta() queues deltas from the agent's worker thread; the async run() task buffers,
rate-limits and progressively edits one platform message (send, then editMessageText;
draft/native transports are optional per adapter)."""
```

桥的两侧都用最简单的原语。agent 侧是 `queue.Queue` 的 put（永不阻塞 worker 线程）；哨兵分裸对象与元组两类（stream_consumer.py:43-56）：`_DONE`（结束）、`_NEW_SEGMENT`（finalize 后开新消息）、`_COMMENTARY`/`_TOOL_PROGRESS`（过渡消息/原生气泡叠加）、`(_FINAL_TEXT, text)`（**权威** final_response，含流式之后才补齐的增强内容，排在 `_DONE` 前入队）、`(_FLUSH, event)`（屏障）、`(_APPROVAL_BOUNDARY, ...)`（审批等待边界）、`_REOPEN_SEED`（澄清回答后 EAGER 原生重播——WeCom 的 typing 由种子帧驱动，惰性重播实测 48 秒死寂）：

```python
# 来源：gateway/stream_consumer.py:538-553（节选）
    def on_delta(self, text: str) -> None:
        """Thread-safe callback from the agent's worker thread.  ``None`` signals a tool
        boundary: the current message is finalized and subsequent text goes out as a new
        message below any tool-progress messages."""
        if text:
            self._queue.put(text)
        elif text is None:
            self.on_segment_break()

    def finish(self, final_text: Optional[str] = None) -> None:
        """Signal stream completion.  ``final_text`` is the AUTHORITATIVE completed
        final_response (incl. post-stream augmentation the accumulator never saw); the drain
        loop adopts it as the finalize payload.  Interrupt/error paths call ``finish()`` bare."""
        if final_text is not None:
            self._queue.put((_FINAL_TEXT, final_text))
        self._queue.put(_DONE)
```

消费侧 `run()` 的循环每轮先查 `_run_still_current()`——`/new`、`/stop` 之后**放弃**而非投递陈旧 delta；意向沉默标记（NO_REPLY/[SILENT]）在流式预览里就要撤回，因为网关的整响应过滤器对流式来说太晚了：

```python
# 来源：gateway/stream_consumer.py:555-595（节选）
    async def run(self) -> None:
        """Async task that drains the queue and edits the platform message."""
        self._len_fn, self._safe_limit = self._resolve_length_budget()
        await self._start_transports()
        try:
            while True:
                # Session reset (/new, /stop): abandon rather than deliver stale deltas.
                if not self._run_still_current():
                    await self._abandon_native_stream()
                    return
                tick = self._drain_queue()
                if tick.approval_boundary is not None:
                    await self._handle_approval_boundary(*tick.approval_boundary)
                    continue
                ...
                if tick.got_done:
                    self._flush_think_buffer()
                    # A bare intentional-silence marker (NO_REPLY / [SILENT]): the
                    # gateway's whole-response filter runs too late for a streamed
                    # preview, so retract it here instead of finalizing.
                    if _is_intentional_silence_response(self._clean_for_display(self._accumulated)):
                        await self._suppress_silence_marker()
                        return
                if self._should_edit(tick) and (...):
                    # Seal first: it clears the message id, so a remainder still over the limit
                    # is split again below. A plain first send would let the adapter split it and
                    # adopt only the LAST chunk as the preview; the next seal then overwrites that
                    # chunk with the head of the whole remainder (duplicated + lost text, #25349).
                    await self._seal_overflow_heads()
```

结构由四个 mixin 组成（`stream_consumer.py:102`）：`StreamTransportMixin`（draft/native/edit 三种传输的解析与失败降级）、`StreamFallbackMixin`（编辑失效后的回退发送）、`StreamThinkFilterMixin`（`<think>` 块过滤状态机）、加上主类。`StreamConsumerConfig` 携带运行参数：`edit_interval`（限速）、`buffer_threshold`、`cursor`、`fresh_final_after_seconds`（预览可见过久后 final 改为新消息，让平台时间戳反映完成时刻——移植自 openclaw#72038）。

**turn 终态的对账**在 `_clear_turn_final_flags`（stream_consumer.py:224-243）：`_final_response_sent` / `_final_content_delivered` / `_delivered_final_text` 三个旗标在每次工具/段边界清零（#29346——边界前交付的只是过渡前奏，冒充不了 final），唯一保留 legacy 信任的是 `_delivery_ambiguous`（全量 final 发送超时但**可能**已到达——重发反而制造重复，#95382）。gateway 侧据此比对 `delivered_final_matches` 决定是否补发——这条对账链与 gateway/AGENTS.md § Streaming delivery contract 的四条不变量（draft 前缀稳定、消费者宣布 final、临时发送带 `_interim_send`、对账靠 edit 不靠 send）一一对应，每条不变量背后都是一次线上重复事故（NS-658 账本，#85796/gateway-gateway#210）。

### 3. 横切细节：think、围栏、指令 hold-back、回退

- **think 过滤**（`stream_consumer_think.py`）：`<think>` 块的开关状态机镜像 CLI 的 `_stream_delta`——增量切片随时可能把标签切成两半，必须按缓冲重放判定。
- **围栏闭合**（`stream_consumer_fences.py::ensure_closed_code_fences`）：预览里的未闭合 ``` 围栏在每次编辑时临时闭合，防止平台渲染把后续正文吞进代码块；**只在 edit 路径**——draft 前缀稳定不变量禁止在帧上做这件事。
- **指令 hold-back**（`stream_consumer_directives.py`）：附件指令（`MEDIA:<path>`、`[[…]]` 旗标、markdown/HTML 图片标签）还在「正在打的最后一行」时被扣住不显示；`_PENDING_MEDIA_RE` 只匹配「还能长成路径」的 `MEDIA:` 前缀，散文里的 "social media: Twitter" 永远不会扣住一行。hold 的附件最终被持回，交给 turn 后的媒体投递。
- **回退**（`stream_consumer_fallback.py`）：progressive edit 不可用（flood 三连、edit 不支持）时降级为分段发送/尾部补发；Telegram 的编辑重试上限 5 秒约束了回退的等待预算。

### 4. streaming_tts_consumer：增量到声音

```python
# 来源：gateway/streaming_tts_consumer.py:1-8（节选）
"""Gateway streaming-TTS consumer — LLM deltas to adapter PCM audio sink.

``on_delta`` (agent worker thread) never blocks: SentenceChunker -> thread-safe queue. The
``_run`` task on the gateway loop drains, synthesises via a ``StreamingTTSProvider`` and writes
PCM so playback starts mid-generation. Outcome: success -> ``completed``; failure before audible
output -> ``suppress_whole_file=False`` (gateway falls back to whole-file TTS); failure after
partial audio -> ``partial`` + suppress (never replay the response from the beginning)."""
```

同一「队列 + 循环」模式换了介质：SentenceChunker 按句切块，`StreamingTTSProvider` 合成 PCM，播放随生成开始。结果分三档：成功 `completed`；**尚未出声就失败** → 回退整文件 TTS；**已出部分声音再失败** → `partial` 且抑制整文件重放（绝不能从头把整段回复再说一遍）。适配器侧的基类协议在 `platforms/base_streaming_tts.py`；已完成流式 TTS 的 turn 记进 `BasePlatformAdapter._streaming_tts_completed_turns`（base.py:1917-1921），整文件自动 TTS 路径据此跳过，避免双份语音（#60671）。语音频道的装配在 `run_voice.py`（GatewayVoiceMixin）。

### 5. 通知与唤醒：跑完之后主动开口

后台事件回到网关的入口都遵循同一模式——**合成的 `MessageEvent(internal=True)`** 走 `handle_message`，与人类输入共用授权豁免与 durable FIFO：

```python
# 来源：gateway/wake.py:1-8（节选）
"""Wake an existing agent session from a background completion event. Push-capable adapters
(``supports_async_delivery``) get a synthetic ``MessageEvent(internal=True)`` via handle_message;
stateless adapters (API server) would run that under a ``build_session_key()`` key that never
matches the raw ``X-Hermes-Session-Id`` real turns use (invisible parallel session), so we self-POST
``/v1/chat/completions`` with the raw id header to resume the REAL session. Exception:
async-delegation completions: the CLIENT owns the next turn, so they are never self-POSTed as a
new ``role=user`` prompt (could cross a pending human-confirmation gate); instead
``persist_delegation_delivery`` writes a durable DELIVERY row ... Failures RAISE (after bounded
retries on transient errors) so callers can rewind cursors / retry instead of silently losing the event."""
```

`terminal(background=true, notify_on_complete=true)` 在网关循环上布 watcher（`run_notifications.py::arm_process_watcher`），完成时启动新 turn；注入必须拿到 `admit_internal_event` 的**收据**（handler 返回 None 不算接受），被拒的注入会退还同批兄弟条目、不消耗重试次数（gateway/AGENTS.md § Background process notifications）。`wake.py` 补足推送不可用的平台：api_server 无状态、合成事件的 key 对不上真实会话，改为**自 POST** `/v1/chat/completions` 带原始 `X-Hermes-Session-Id` 恢复真身；异步委派的完成则**永不**自 POST（下一 turn 归客户端所有，盲发可能撞上等人确认的门），只写 durable DELIVERY 行。失败必须 raise（有界退避后）——调用方要回卷游标重试，不允许静默丢事件。

家族成员的分工：`run_goals.py`（GatewayGoalsMixin）管目标/心跳的续跑、`run_heartbeat_acceptance.py` / `run_heartbeat_restore.py` 管心跳 turn 的验收（`heartbeat_owner_is_current` 守卫执行前身份）与恢复；`run_notifications_update.py` 管更新通知、`run_notifications_ownership.py` 管通知的投递所有权；`warning_notifications.py` 统一告警文案（warning_text 按平台与 display 档位降噪）；`channel_directory.py` 维护「哪个 profile 的哪个平台是 home channel」目录，通知去重键在多路复用下带 `<profile>:<platform>` 前缀；`run_delivery_queue_watch.py` 监视投递队列（配合 `delivery_ledger` 的运行时重投）；`rich_sent_store.py` 记录富文本已发送（edit 目标查找）。观察者只看不动手：canonical 本地会话把完成与观察事件**接纳**进同一 durable FIFO，但观察者从不拥有或消费那些 turn。

## 核心类/函数

| 符号 | 位置 | 职责 |
|------|------|------|
| `StreamEvent`（7 数据类 union） | stream_events.py:72 | agent→网关传输契约；显式 union 防漏 case |
| `GatewayStreamConsumer` | stream_consumer.py:102 | 同步入队→异步编辑的主消费者（三传输 × think/围栏/指令/回退） |
| `on_delta()` / `finish()` | stream_consumer.py:538/547 | 线程安全入口；`finish(final_text)` 携带权威 final |
| `run()` | stream_consumer.py:555 | 排队循环：current 检查、沉默撤回、溢出先封缄 |
| `dispatch_stream_event()` | stream_dispatch.py | 消息/工具双路分发（worker 线程可调） |
| `StreamThinkFilterMixin` | stream_consumer_think.py | `<think>` 块过滤状态机 |
| `ensure_closed_code_fences()` | stream_consumer_fences.py | 预览的围栏临时闭合（仅 edit 路径） |
| `has_pending_media_directive()` | stream_consumer_directives.py | 附件指令 hold-back |
| `StreamingTTSConsumer` | streaming_tts_consumer.py | LLM 增量→PCM；三档结果与回退 |
| `arm_process_watcher()` | run_notifications.py | 后台进程完成 watcher（收据门） |
| `WakeNotAccepted` / wake 自 POST | wake.py:54/… | 推送不可用平台的会话恢复；失败必 raise |
| `GatewayGoalsMixin` | run_goals.py | 目标/心跳续跑 |

## 本组文件清单

### A. 流式契约与消费

| 文件 | 角色 |
|------|------|
| `stream_events.py` | 7 个冻结事件 + 显式 union（传输契约） |
| `stream_dispatch.py` | adapter 驱动的事件分发（消息→consumer，工具→进度队列） |
| `stream_consumer.py` | GatewayStreamConsumer 主体（队列、哨兵、final 对账） |
| `stream_consumer_transport.py` | StreamTransportMixin：draft/native/edit 三传输 |
| `stream_consumer_think.py` | `<think>` 过滤状态机 |
| `stream_consumer_fences.py` | 代码围栏临时闭合 |
| `stream_consumer_directives.py` | 附件指令 hold-back（MEDIA: 等） |
| `stream_consumer_fallback.py` | 编辑失效的回退发送 |
| `streaming_tts_consumer.py` | 流式 TTS：增量→PCM（三档结果） |

### B. 通知与唤醒

| 文件 | 角色 |
|------|------|
| `run_notifications.py` | GatewayNotificationsMixin：进程/完成/媒体/委派通知 |
| `run_notifications_update.py` | GatewayUpdateNotificationsMixin：更新流程通知 |
| `run_notifications_ownership.py` | GatewayNotificationOwnershipMixin：通知投递所有权 |
| `warning_notifications.py` | 告警文案与降噪（warning_text） |
| `wake.py` | 后台完成唤醒（合成事件或自 POST；失败必 raise） |
| `channel_directory.py` | home channel 目录与通知去重键 |
| `run_delivery_queue_watch.py` | 投递队列监视（账本运行时重投） |
| `delivery_ledger.py` | durable 投递义务账本（见 message_flow.md） |
| `run_goals.py` | GatewayGoalsMixin：目标/心跳续跑、post-turn hooks |
| `run_heartbeat_acceptance.py` | 心跳 turn 验收（owner 身份守卫） |
| `run_heartbeat_restore.py` | 心跳恢复 |
| `message_timestamps.py` / `sticker_cache.py` | 时间戳去重 / 贴纸缓存（投递辅助，已列 message_flow.md） |

## 与其他模块的关系

- 事件的生产端在 `agent/`：worker 线程经 stream 回调发出 `StreamEvent`；`turn_machinery.md` 的 turn executor 线程正是生产现场。
- 流式只管「展示」：`SessionStore` 的转录以 agent 的历史为准（第 1 节的格言），`message_flow.md` 第 6 步的 `send_final_ledgered` 是最终投递的唯一出口——消费者交付过的内容通过 `_run_agent_mark_streamed_delivery` 报告给 turn 侧，避免重复发送。
- relay 平台的 Slack 原生流式（`draft_stream_is_message=True`）是四条不变量的最严格执行者：`relay.md` 的 draft 墓碑表就是不变量 1 与 4 的落地。
- 通知唤醒依赖 `session_authority` 的 `admit_internal_event` 收据门（`sessions_authority.md`）与 `delivery.py` 的目标解析。

## 总结

流式层的两个关键词是「**桥**」与「**对账**」。桥：同步的 agent 线程永不阻塞，一切经 `queue.Queue` 的哨兵语法交给事件循环侧的一个消费者任务；传输可以换（edit/draft/native），队列不变。对账：消费者知道自己交付过什么（三个终态旗标 + 交付文本快照），gateway 拿它与权威 final 比对，宁可少说不谎报；意向沉默、溢出封缄、审批边界这些「非正文」状态都成了队列里的一等公民。通知唤醒则是同一可靠性哲学的主动面：后台事件要么拿到收据、要么大声失败，绝不静默消失——推送不行就自 POST，委派完成就写 durable 行，让每个「跑完了」都有下文。
