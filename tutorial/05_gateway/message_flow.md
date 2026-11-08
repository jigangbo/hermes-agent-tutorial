# message_flow.md —— 一条消息的七步全链路

## 文件概览

本篇把「用户在 Telegram 发了一句『你好』到 agent 回帖」拆成 7 步，每步给真实代码。链路贯穿三组文件：**入站管线**（`run_inbound*.py` + 授权/忙碌）、**会话接纳**（`session_ingress.py` + SessionAuthority）、**投递与落盘**（`delivery*`、`response_filters.py`、SessionStore）。读完本篇，gateway/ 里一半以上的文件都有了坐标。

```
(1) 适配器收包        (2) 入站管线           (3) 会话接纳          (4) turn 执行
Telegram update  ─▶  MessageEvent 归一  ─▶  授权/忙碌/入站准备 ─▶ SessionAuthority  ─▶  _handle_message_with_agent
                     (platforms/event)      (authz/run_inbound)   admit_session_input     (run_turn.py:200)
                                                                          │
   (7) 落盘            (6) 最终回复            (5) 流式                   ▼
SessionStore 转录  ◀─  send_final_ledgered ◀─  GatewayStreamConsumer ◀─  agent 线程
+ 重试队列/关机排水     + delivery_ledger       逐步编辑一条消息
```

## 关键代码走读

### 第 1 步：适配器收包，归一为 MessageEvent

所有平台的消息先被各自适配器归一成同一个数据类 `MessageEvent`（`gateway/platforms/event.py`，叶子模块，谁都能 import）。字段在追加时保持「只增不改位置」的纪律，这是数据类在 60+ 处 `event.<attr>` 读法下的生存之道：

```python
# 来源：gateway/platforms/event.py:66-98（节选）
@dataclass
class MessageEvent:
    """Incoming message from a platform — the normalized shape all adapters produce."""
    text: str
    message_type: MessageType = MessageType.TEXT
    user_id: Optional[str] = None
    user_name: Optional[str] = None
    source: SessionSource = None          # 生产路径必填；Optional 只为单测
    raw_message: Any = None
    message_id: Optional[str] = None
    ledger_message_id: Optional[str] = None   # /queue 链的最终回复按链尾消息记账
    reply_anchor_override: Optional[str] = None  # 忙碌重定向后回复锚点改指重定向消息
    media_urls: list[str] = field(default_factory=list)
    ...
    internal: bool = False                # 合成事件（后台通知）绕过用户授权
    metadata: dict[str, Any] = field(default_factory=dict)
    allow_gateway_control: bool = True    # 主动插件事件置 False，防不可信文本执行命令
```

适配器把事件交给 `BasePlatformAdapter.handle_message`（`platforms/base.py:3924`）。这里是第一道忙碌守卫：`session_key` 已在 `_active_sessions` 里就转 `_handle_message_while_active`（排队或绕行），否则**先同步装好守卫再 spawn 后台任务**，杜绝第二条消息抢跑：

```python
# 来源：gateway/platforms/base.py:3941-3966（节选）
        if event.allow_gateway_control:
            coerce_plaintext_gateway_command(event)
        # Identity FIRST: every key below (routing check, guard lookup, batch lane) derives from it.
        if self._drop_unresolved(event):
            return
        ...
        session_key = self._event_session_key(event)
        ...
        from gateway.session_ingress_burst import burst_gate
        behind_burst = await burst_gate(self, event, session_key)  # a serial reader's command waits too
        if session_key in self._active_sessions or behind_burst:
            await self._handle_message_while_active(event, session_key)
            return
        # Guard installed synchronously BEFORE the task spawns so a second message can't race in.
        event._gateway_accepted = self._start_session_processing(event, session_key)
```

注意 `_drop_unresolved`：多路复用下身份解析不出来，事件在适配器缝上就被丢弃——绝不落到默认 profile（HX002）。

### 第 2 步：入站管线——授权、忙碌、文本/媒体准备

后台任务进入 runner 的 `_handle_message`（`GatewayInboundMixin`，`run_inbound.py`）。这条管线依次做：更新提示回复、紧急停止门、授权判定（`authz_mixin.py`：允许名单、DM 策略、未授权发送者的**配对码**回复、bot 回环守卫 `bot_loop_guard.py` 的回环预算）、slash 命令改写与未知命令应答、语音转写（`run_inbound_transcription.py`）、插件注入（`run_plugin_injection.py`）、回复上下文与媒体注记前缀、忙碌会话分流（`run_busy.py`）：

```python
# 来源：gateway/run_inbound.py:1-5
"""Inbound message pipeline (_handle_message, text/media preparation, durable-turn markers, plugin
injection) for GatewayRunner.

Split out of ``gateway/run.py``; bound onto ``GatewayRunner`` via the MRO.
``gateway.run`` internals are imported lazily inside method bodies (import cycle),
so ``patch("gateway.run.X")`` keeps intercepting them at call time."""
```

```python
# 来源：gateway/authz_mixin.py:1-5
"""User-authorization mixin for ``GatewayRunner``: may this user/chat talk to the agent,
the per-adapter DM policy, the unauthorized-DM behavior, and the bot loop guard.

``gateway.run`` is never imported at module import time (cycle). The unauthorized-DM method still
logs through ``gateway.run``'s logger so its records keep that name."""
```

忙碌分发的关键不变量（gateway/AGENTS.md § The gateway has TWO message guards）：agent 运行中，入站消息先过**适配器守卫**（`_pending_messages`），再过 **runner 守卫**（`run_busy.py` 拦 `/stop` `/new` `/queue` `/status` `/approve` `/deny`，绝不放它们去 `running_agent.interrupt()`）。任何新的「必须在 agent 阻塞时可达」的命令要同时绕过**两道**守卫并内联分发——`_process_message_background()` 与会话生命周期有竞态，禁用。

### 第 3 步：会话接纳——durable FIFO

通过忙碌分流的消息来到 `session_ingress.py::admit_message`，对着 `session_authority.py::SessionAuthority` 完成接纳。接纳不是内存排队，而是把输入**写进 SQLite 的 `session_admissions` 表**（durable FIFO，由状态层的 `hermes_state_runtime.py::admit_session_input` 承接）：

```python
# 来源：gateway/session_ingress.py:39-64（节选）
async def admit_message(authority, event):
    ...
    receipt = await authority.admit_native(event)
    ...
    except RuntimeStoreError as exc:
        if exc.reason == 'stale_generation' and exc.field == 'route':
            return None  # a later /stop or /new of the chat fenced it, as main cancels a queued row
        if exc.reason == 'invalid_params' and exc.field:
            # Refused before commit (_validate_native): a refusal notice instead of a generic turn error.
            named = f'{exc.reason}: {exc.field}' if exc.field in _CONTENT_CLAUSES else exc.reason
            return (f'⚠️ Hermes refused this message ({named}), so it was not saved '
                    'or answered. Ask the operator to check gateway.log.')
        if exc.reason != 'queue_full':
            raise
        return QUEUE_FULL_REPLY
```

```python
# 来源：hermes_state_runtime.py:130-168（节选）
def admit_session_input(db, *, epoch: int, principal_id: str, session_id: str,
                        request_id: str, payload: dict, intent: str = 'queue', ...) -> dict:
    """Admit input; the trusted private guard raises to refuse a NEW write."""
    ...
    def write(conn):
        _epoch(conn, epoch)
        _session(conn, session_id)
        old = conn.execute('''SELECT * FROM session_admissions
            WHERE principal_id=? AND target_session_id=? AND request_id=?''', ...).fetchone()
        if old is not None:
            if old['payload_digest'] != digest:
                raise RuntimeStoreError('admission_conflict', **ADMITTED_REQUEST_CONFLICT)
            ...
            return _row(old)
        queued = conn.execute('''SELECT COUNT(*) FROM session_admissions WHERE target_session_id=?
            AND status='queued' ''', (session_id,)).fetchone()[0]
        if queued >= ADMISSION_QUEUE_MAX:      # 32：与 main 的忙碌队列上限一致
            raise RuntimeStoreError('queue_full')
        ...
        conn.execute('''INSERT INTO session_admissions(...,status,owner_epoch) VALUES(...,'queued',?)''', ...)
        return _row(_admission(conn, admission_id))
    return db._execute_write(write)
```

三个拒绝理由各有用途：`admission_conflict`（同 request_id 不同内容——重放冲突）、`queue_full`（每会话 32 条上限，回复 QUEUE_FULL_REPLY 提示稍后再发）、epoch 校验（进程换代后旧 epoch 的写入作废）。接纳返回 receipt 后，调用者挂在 `asyncio.shield(waiter)` 上等执行结果；进程崩溃后，未决行由启动恢复接手。

### 第 4 步：turn 执行

`run_turn.py:200` 的 `_handle_message_with_agent` 在 `_running_agents` 哨兵守卫下运行：解析会话（`_hmwa_resolve_session`）、准备 turn（`_hmwa_prepare_turn`：装历史、获取 **turn 租约**、绑定 profile 作用域、`agent:start` hook），然后调 `_run_agent`：

```python
# 来源：gateway/run_turn.py:200-268（节选）
    async def _handle_message_with_agent(self, event, source, _quick_key: str, run_generation: int):
        """Inner handler that runs under the _running_agents sentinel guard."""
        ...
        resolved = await self._hmwa_resolve_session(event, source)
        if resolved is None:
            return
        source, session_entry, session_key = resolved
        prepared, _session_env_tokens = await self._hmwa_prepare_turn(
            event, source, session_entry, session_key, _quick_key, run_generation,
        )
        ...
            agent_result = await self._run_agent(
                message=message_text, context_prompt=prepared.context_prompt, history=history,
                source=_turn_source, session_id=_run_start_session_id, session_key=session_key,
                run_generation=run_generation, ...)
```

这一步的机器细节——租约为什么按 session_id 而不是路由键、线程怎么停车复用、agent 缓存怎么驱逐——全部留给 `turn_machinery.md`。

### 第 5 步：流式事件

agent 线程产出的 delta 经 `GatewayStreamConsumer`（`stream_consumer.py`）桥到事件循环：同步回调 `on_delta()` 入队，异步任务缓冲、限速、**逐步编辑同一条平台消息**。流式只是「展示」——事件描述传输、从不描述上下文，被网关「吃掉」的任何字都不许偏离 agent 自己持有的消息历史。深讲见 `streaming.md`。

### 第 6 步：最终回复——先记账，再发送

turn 结束，最终文本走 `send_final_ledgered`（`platforms/base.py:4281`）：**先**把投递义务写进 `delivery_ledger`（state.db 里的表），**再**发送，**最后**按 SendResult 结账——崩溃在中间任何一点，重启清扫都能补投或明确放弃：

```python
# 来源：gateway/platforms/base.py:4281-4304（节选）
    async def send_final_ledgered(
        self, event: MessageEvent, session_key: str, text_content: str, metadata: dict[str, Any], *,
        reply_to: Optional[str], is_ephemeral_response: bool = False,
    ) -> "tuple[SendResult, BasePlatformAdapter]":
        """The delivery-ledger bracket every final text goes through, on the CURRENT transport
        (a reconnect may have replaced this adapter): record the obligation before the send,
        send with retry, finalize from the result — so a refused final (flood control, a dead
        transport) leaves a ledger row the boot sweep / runtime redelivery can act on."""
        delivery_adapter = self._final_delivery_adapter(event.source)
        obligation_id = await self._record_delivery_obligation(
            event, session_key, text_content, delivery_adapter, is_ephemeral_response)
        if obligation_id is not None:
            await self._release_turn_marker(event)  # the ledger now owns the crash recovery
        result = await delivery_adapter._send_with_retry(
            chat_id=event.source.chat_id, content=text_content, reply_to=reply_to, metadata=metadata)
        ...
        if obligation_id is not None:
            await self._finalize_delivery_obligation(obligation_id, result, event, delivery_adapter)
        return result, delivery_adapter
```

账本的状态机（`delivery_ledger.py:1-11` docstring）：`pending`（未开始，重投 plainly）→ `attempting`（发送中崩溃，平台**可能**已收到，重投必须带「可能重复」标记）→ `delivered`（剪除）/ `failed`（明确拒绝，重启即重试边界）；尝试封顶、过期转 `abandoned`。账本失败绝不阻塞发送——所有调用包在 try/except 里。投递路线的选择在 `delivery.py::DeliveryRouter`（home channel 解析、cron `deliver=<name>` 目标）；`mirror.py` 把回复镜像到绑定会话；`response_filters.py` 在发送前净化（意向沉默不投递、内部指令剥离、README 尾巴过滤）。

### 第 7 步：落盘

回复发完，转录由 SessionStore（`session.py:787`）追加到 SQLite（`session_transcript.py` mixin）。转录写入失败不丢数据——进**内存重试队列**（`_dirty_transcripts` + `_transcript_append_failures`，`session.py:817-822`）由排水器重放；父→子会话的队列迁移靠 `_transcript_drain_lock` 保持线性化。进程关闭时 `run_shutdown.py`/`shutdown_flush.py` 排空所有脏队列，`shutdown_forensics.py` 留证。崩溃恢复则靠 `SessionEntry.active_turn_token`：kill 在「终态提交」与「账本写入」之间时，下次不洁启动能找回确切的会话并补投持久化回复。

## 核心类/函数

| 符号 | 位置 | 职责 |
|------|------|------|
| `MessageEvent` | platforms/event.py:66 | 全平台归一入站事件；`internal`/`allow_gateway_control`/`ledger_message_id` 是安全与记账关键字段 |
| `MessageType` / `ProcessingOutcome` | platforms/event.py:46/59 | 消息类型枚举；处理钩子结果分类 |
| `BasePlatformAdapter.handle_message()` | platforms/base.py:3924 | 第一道忙碌守卫；身份优先；同步装守卫防竞态 |
| `GatewayInboundMixin._handle_message` | run_inbound.py | 入站管线：授权→slash→转写→插件→媒体→忙碌 |
| `admit_message()` | session_ingress.py:39 | 对 SessionAuthority 接纳；把 RuntimeStoreError 翻译成人话 |
| `admit_session_input()` | hermes_state_runtime.py:130 | durable FIFO 写入（SQLite session_admissions），重放/上限/epoch 守卫 |
| `_handle_message_with_agent()` | run_turn.py:200 | turn 执行入口（哨兵守卫下） |
| `send_final_ledgered()` | platforms/base.py:4281 | 投递账本括号：记账→发送→结账 |
| `DeliveryRouter` | delivery.py | 投递目标路由（home channel / cron deliver 目标） |
| `classify_send_error()` | platforms/base.py:1662 | 发送失败分类（too_long/forbidden/not_found/rate_limited/transient…） |

## 本组文件清单

### A. 入站管线

| 文件 | 角色 |
|------|------|
| `run_inbound.py` | GatewayInboundMixin 主管线：授权、文本/媒体准备、durable-turn 标记 |
| `run_inbound_consumer.py` | 入站消费循环（事件到 turn 的派发层） |
| `run_inbound_hooks.py` | GatewayInboundHooksMixin：处理生命周期钩子 |
| `run_inbound_media.py` | 入站媒体搬运（rehome_inbound_media） |
| `run_inbound_transcription.py` | GatewayInboundTranscriptionMixin：语音转文字 |
| `run_inbound_unauthorized.py` | 未授权发送者处理：配对码、owner 提示、限流 |
| `run_plugin_injection.py` | GatewayPluginInjectionMixin：插件注入内容进 turn |
| `run_topics.py` | GatewayTopicThreadsMixin：话题/thread 恢复路由 |

### B. 授权、忙碌与 slash 分发

| 文件 | 角色 |
|------|------|
| `authz_mixin.py` | GatewayAuthorizationMixin：允许名单、DM 策略、intake/delivery 适配器缝 |
| `bot_loop_guard.py` | bot 回环守卫：回环预算，防 bot 互聊打爆 |
| `bot_peer_notices.py` | 对端 bot 的提示通知 |
| `pairing.py` | 未授权发送者配对流程 |
| `run_busy.py` | GatewayBusySessionMixin：忙碌排队/打断、绕行命令表、确认流 |
| `slash_access.py` | slash 命令访问控制 |
| `slash_commands.py` | GatewaySlashCommandsMixin：命令注册表与 `_command_handler_table` |
| `slash_commands_branch_thread.py` | `/branch`、thread 类命令 |
| `slash_commands_goals.py` | 目标命令（GatewayGoalCommandsMixin） |
| `slash_commands_login.py` | `/login`（仅配对 DM，绑定整安装的 provider 凭据） |
| `slash_commands_model.py` | `/model` `/fast` 选择器（延迟回调捕获身份） |
| `slash_commands_session.py` | `/new` `/resume` `/sessions` 等会话命令 |
| `slash_commands_status.py` | `/status` `/verbose` 等 |
| `plugin_command_choice.py` | 插件命令与内置命令同名时的选择 |
| `parked_route_refusal.py` | 路由到未服务 profile 的拒收（一次性 WARNING + 渠道内提示） |

### C. 投递、净化与媒体

| 文件 | 角色 |
|------|------|
| `delivery.py` | DeliveryRouter：投递目标解析与发送通道选择 |
| `delivery_ledger.py` | durable 投递义务账本（pending/attempting/delivered/failed/abandoned） |
| `dead_targets.py` | 死目标分类与停投 |
| `response_filters.py` | 回复净化：意向沉默、部分沉默标记、尾巴剥离 |
| `mirror.py` | 回复镜像到绑定会话转录 |
| `rich_sent_store.py` | 富文本已发送记录（edit 目标查找） |
| `message_timestamps.py` | 消息时间戳去重/节流 |
| `media_fetch.py` | 入站媒体抓取 |
| `media_policy.py` | 媒体策略（大小/类型门） |
| `media_repair.py` | 媒体修复（损坏图片重取等） |
| `sticker_cache.py` | 贴纸缓存 |
| `whatsapp_identity.py` | WhatsApp 号码归一化/别名展开 |

## 与其他模块的关系

- 第 3 步的 durable FIFO 属于**状态层**：`hermes_state_runtime.py` 是 gateway 之下、`hermes_state.py` 家族的 runtime 表操作；gateway 自己不写队列表。
- 第 4/5 步的执行与流式分别在 `turn_machinery.md`、`streaming.md` 展开；本篇只给链路坐标。
- 适配器从哪来（`platform_registry` + 26 个插件）见 `platforms_framework.md`；3 个内置 HTTP 平台见 `builtin_platforms.md`。
- cron 与后台进程通知复用同一管线：它们是 `internal=True` 的合成事件（`wake.py`、`run_notifications.py`，见 `streaming.md` 末节）。

## 总结

七步链路里每一步都在回答一个可靠性问题：第 1 步「消息是谁的、允不允许进来」（身份优先 + 授权 + 回环守卫）；第 2/3 步「agent 忙时消息去哪」（两层守卫 + durable FIFO，重启不丢）；第 4/5 步「怎么跑、怎么边跑边说」（租约串行化 + 流式只管展示）；第 6 步「回复怎么保证送达」（先记账后发送，at-least-once + 诚实标记）；第 7 步「写盘失败怎么办」（内存重试队列 + 关机排水 + 活跃 turn 令牌）。把这条链背下来，gateway/ 顶层 300 个文件就不再是一团散沙。
