# relay_moa.md — NeMo Relay 观测运行时与 Mixture-of-Agents:作用域栈、多模型备援循环与 bot 链防环

## 文件概览

本篇讲 agent 侧两套"多模型协作"机制,外加两个模型行为调节器。先澄清一个容易望文生义的点:
`relay_*.py` 的 **relay 指的是 NeMo Relay**——NVIDIA 的 LLM 观测/追踪管线,不是 CLI 与网关之间
的"消息中继面"。Hermes 把 Relay 嵌成**代理执行的观测骨架**:每个会话一根作用域栈(Agent
scope),每个 turn 一个 Function scope,每次 LLM 尝试/工具执行/压缩都作为 span 挂到正确的父
节点上;用户配置 Relay 导出器即可看到全链路,Hermes 自己不添任何出站路径。

MoA(Mixture-of-Agents)则是**备援的智力面**:`/moa` 把一个 user turn 标记为 MoA 开启,正常
agent 循环照旧持有工具调用与终止权,`moa_loop.py` 只在每次模型迭代前并行征询若干**参考模型**
(advisor),把它们的建议合成"引导块"附加给聚合器(aggregator,即当前 acting model)。引导块
作为**独立的尾部 user 消息**追加——这是全篇最重要的缓存决策。`bot_chain.py` 防 bot-to-bot
死循环,`fast_mode.py` 管有界快窗。

```text
Relay 作用域栈(每会话一栈,turn 之间 LIFO):
  push SESSION_SCOPE (ScopeType.Agent)             ensure_session
   ├── push TURN_SCOPE (ScopeType.Function)         begin_turn
   │    ├── LLMRequest span(chat_completions/codex_responses/anthropic_messages)
   │    │      relay_llm._ManagedAttempt — codec 往返、请求/响应捕获
   │    ├── ToolExecution span                      relay_tools.execute
   │    │      managed_callback_guard:工具内部的辅助 LLM 调用绕过托管
   │    └── hermes.compaction mark                  relay_compaction
   └── 并发 turn?同一物理栈,兄弟 scope 不能 LIFO 关闭
         → pop_relay_scope_if_top 拒绝,孤儿由会话关闭排水回收

MoA 一次 create():
  参考扇出(≤8 workers,并行) → 失败变模型专属占位(不炸循环)
  aggregate_moa_context:聚合器合成一次 → guidance(中央脱敏 + MoA PII 过滤)
  _attach_reference_guidance:guidance 作独立尾部 user 消息(前缀字节稳定)
  聚合器请求 → 400 role_alternation? → moa_alternation 反应式合并一次 + 记住目的地
```

| 文件 | 行数 | 角色 |
|---|---|---|
| `agent/relay_runtime.py` | 1,440 | `RelayRuntime`:作用域栈、会话/turn 生命周期、插件配置、关停排水 |
| `agent/relay_llm.py` | 964 | LLM 尝试适配器:`_ManagedAttempt` + 三协议 codec + 流式累加器 |
| `agent/relay_tools.py` | 106 | 工具执行适配器:`execute()` 把工具调用挂上 ToolExecution span |
| `agent/relay_compaction.py` | 93 | 压缩记录 → `hermes.compaction` mark(挂会话/turn 作用域) |
| `agent/relay_cwd.py` | 91 | 逻辑工作目录解析:session_cwd/turn_cwd 进 scope input |
| `agent/chat_completion_helpers_relay.py` | 82 | chat_completions 流式 wire 的 Relay 侧累加器 |
| `agent/moa_loop.py` | 1,564 | MoA 运行时:参考扇出、引导构建、`MoAChatCompletions` 门面 |
| `agent/moa_alternation.py` | 64 | 严格交替模板 400 的反应式合并(目的地记忆) |
| `agent/moa_trace.py` | 115 | 全 turn 追踪持久化(opt-in `moa.save_traces`,JSONL) |
| `agent/bot_chain.py` | 178 | Bot Mode 的 bot-to-bot 链:运行时持有的跳数、去重、回复规则 |
| `agent/fast_mode.py` | 120 | 有界快窗(`/fast auto` / `/fast cold`)与 static tier |

---

## 关键代码走读

### 1. `RelayRuntime`:一个进程、多个 profile、每会话一根栈

`RelayRuntime` 构造时做三件事:加载 nemo-relay 库、认领当前 profile、加入进程级插件配置。
会话表按 session_id 存 `RelaySession`(每会话一根**隔离的作用域栈** + 自己的 RLock + 关闭状态
+ 段轮转旗标):

```python
# agent/relay_runtime.py:402-424(节选)
def __init__(self, relay: Any = None, *, profile_key: str | None = None) -> None:
    self.relay = relay or _load_nemo_relay()
    self.profile_key = profile_key or current_profile_key()
    self.runtime_id = uuid.uuid4().hex
    self._sessions_lock, self._execution_consumers_lock = threading.RLock(), threading.RLock()
    self._sessions: dict[str, RelaySession] = {}
    ...
    self._plugin_configuration_state = _PLUGIN_CONFIGURATION.acquire(self, self.relay)
    if self._plugins_active():
        self.retain_managed_execution(RELAY_PLUGINS_EXECUTION_CONSUMER)
    atexit.register(self.shutdown)
```

会话 scope 的开栈是**有界异步**的:`_open_session_scope` 把 `scope.push` 提交到 8 工人的 daemon
池,`future.result(timeout=SCOPE_OP_TIMEOUT=10s)`——一根卡死的管线最多损失一个 span,永远不会
堵住 agent。子代理的 scope 挂在派生它的 turn/session handle 之下
(`metadata["nemo_relay_scope_role"]="subagent"`),父会话不存在时 `resolve_parent` 先建它。

### 2. turn 生命周期:`begin_turn` / `end_turn` 与并发守卫

同一会话的两个并发 Hermes turn 共享**物理**作用域栈——后开者的兄弟 scope 关闭时不满足 LIFO。
`begin_turn` 用 active-turn 表守卫:发现并发就关掉本 turn 的 Relay 插桩,只损失观测、不损失
正确性:

```python
# agent/relay_runtime.py:1046-1089(节选)
def begin_turn(self, lease, *, turn_id: str, task_id: str, metadata=None) -> RelayTurnContext:
    if lease.released:
        raise RuntimeError("Hermes Relay conversation lease is released")
    turn = RelayTurnContext(lease=lease, turn_id=turn_id, task_id=task_id)
    key = (lease.profile_key, lease.session_id)
    with self._active_turns_lock:
        if self._active_turns.get(key):
            # One physical scope stack per session; concurrent turns' sibling scopes would not close LIFO.
            turn.relay_enabled = False
            logger.warning("Skipping Relay instrumentation for concurrent Hermes turn %s in session %s", ...)
        else:
            self._active_turns[key] = {id(turn)}
            turn._active_registered = True
    host = lease.live_runtime() if turn.relay_enabled else None
    if host is not None:
        # Rotation happens HERE: no live turn scope on the stack, so the session scope can close/reopen LIFO.
        _warn_on_error("segment rotation", self._maybe_rotate_segment, host, lease.session)
        ...
        turn.handle = _warn_on_error("turn initialization", host.run_in_session, lease.session,
            host.relay.scope.push, TURN_SCOPE, host.relay.ScopeType.Function, handle=lease.session.handle,
            input=_scope_input(lease.turn_cwd), metadata=turn_metadata, timeout=SCOPE_OP_TIMEOUT)
    turn._previous_turn = _CURRENT_TURN.get()
    _CURRENT_TURN.set(turn)
    return turn
```

两个设计点:段轮转(压缩或 max_turns 触发的 session scope 关闭重开)**只发生在 turn 边界**——
这是唯一 LIFO 安全的时点,压缩打旗标、`begin_turn` 消费;`_CURRENT_TURN` ContextVar 把"当前
turn"带给深层代码(`relay_compaction._turn_target` 用它寻挂载点)。`end_turn`(relay_runtime.py:1100)
幂等;`pop_relay_scope_if_top`(relay_runtime.py:118)拒绝弹出兄弟之上的 scope,真实输出存进
`_deferred_scope_outputs`,由会话关闭排水收尾。

### 3. LLM 尝试与工具执行:托管判定 + 回调 guard

每次物理 provider 尝试若落在托管执行里,`_ManagedAttempt.resolve` 组装请求状态:请求体经 Relay
codec 做**往返基线**(`_codec_round_trip_request_body`),让拦截器改写后的请求与原请求可比。
协议名按 api_mode 归一化:

```python
# agent/relay_llm.py:31-35 + 58-71(节选)
_RELAY_PROTOCOL_BY_API_MODE = {
    "chat_completions": ("openai.chat_completions", "OpenAIChatCodec"),
    "codex_responses": ("openai.responses", "OpenAIResponsesCodec"),
    "anthropic_messages": ("anthropic.messages", "AnthropicMessagesCodec"),
}

class _ManagedAttempt:
    @classmethod
    def resolve(cls, session_id, request, metadata, *, name: str, model_name: str):
        """Return the managed attempt for ``session_id`` ..., or None to run unmanaged."""
        if session_id is None:
            session_id = _current_session_id()
        if not session_id:
            return None
        runtime, session, parent = relay_runtime.resolve_execution_context(session_id)
        if runtime is None or session is None or not runtime.managed_execution_enabled():
            return None
        return cls(runtime, session, parent, request, metadata, name=name, model_name=model_name)
```

回调跑在**捕获上下文的副本**里(`self.context = contextvars.copy_context()`),且套
`managed_callback_guard()`——Relay 管线驱动流时,回调内部发起的嵌套 relay 调用必须绕过托管
(#77244:管线的 Future 绑定在正在被阻塞的循环上)。工具侧 `relay_tools.execute`(relay_tools.py:16)
同一套路:先判托管,让 Relay 拦截器有机会改写工具参数(`invoke` 收 `next_args`),回调全程
guard。流式侧的对称件是 `chat_completion_helpers_relay.py` 的 `RelayChatAccumulator`:Relay 的
finalizer 在 provider 流结束时立刻跑,与 Hermes 消费线程**并发**——它只能用自己 collector 观测
到的状态重建响应,绝不能碰消费者闭包里的东西。

### 4. 压缩标记与 cwd:挂对父节点

`relay_compaction.py` 处理一个只有观测层才有的问题:压缩发生在 turn 外(网关卫生)时没有活
turn scope,mark 该挂哪?寻挂顺序是"同会话的活 turn → 该会话的 session scope → 压缩 agent 启动
时所在的活 turn",而**Relay 只对持有压缩标记的 agent scope 重置 LLM 历史新鲜度**——挂错父
节点,下一条 LLM span 就不会重新记录完整历史。mark 是纯观测:一次停滞发布就让本进程对 Relay
停止等待(有界超时),导出器由用户配置、mark 不添出站路径。`relay_cwd.py` 为 scope input 提供
逻辑 cwd:任务可用与所属会话不同的 worktree,远程路径按声明保留、未知路径**省略**而不是拿
Hermes 主机的 cwd 顶替。

### 5. MoA 主循环:`MoAChatCompletions.create`

`MoAChatCompletions` 是 **OpenAI-chat 兼容门面**:`client.chat.completions.create()` 长着 SDK 的
脸,内部做参考扇出 + 引导注入 + 聚合器请求:

```python
# agent/moa_loop.py:1434-1483(节选)
def create(self, **api_kwargs: Any) -> Any:
    ...
    preset, moa_raw = _resolve_preset_cached(self.preset_name)
    self._privacy_mode = _moa_privacy_mode(moa_raw)
    messages = list(api_kwargs.get("messages") or [])
    # A disabled preset = "use the aggregator directly".
    reference_models = [slot for slot in (preset.get("reference_models") or []) if slot.get("enabled", True)] ...
    aggregator = preset.get("aggregator") or {}
    # The MoA path's virtual model/provider have no pricing entry; expose the real slot.
    self.last_aggregator_slot = dict(aggregator) if aggregator else None
    ...
    ref_messages = _reference_messages(messages)
    cache_key = self._fanout_cache_key(preset, ref_messages, reference_models)
    cache_hit = bool(cache_key == self._ref_cache_key and self._ref_cache_outputs)
    if cache_hit:
        # HIT: already ran and accounted. Do NOT zero pending totals ...
        reference_outputs = list(self._ref_cache_outputs)
        self._pending_trace = None
    else:
        reference_outputs = self._run_fanout(preset, ref_messages, reference_models, aggregator, aggregator_temperature, cache_key)
    agg_messages = [dict(m) for m in messages]
    guidance = self._build_guidance(reference_outputs, aggregator, ...)
    if guidance:
        _attach_reference_guidance(agg_messages, guidance)
    ...
    return self._call_prepared_aggregator(prepared_request, api_kwargs)
```

扇出有**节奏**(`_fanout_cache_key`,moa_loop.py:1272):默认 `user_turn` 只哈希到最后一条真实
user 消息为止的前缀——工具迭代 2+ 全是缓存 HIT,advisor 每 user turn 只跑一次(合成在开头,
acting model 随后独力干活,原始 MoA 形态);`per_iteration` 每次工具迭代重跑;`every_n:<N>` 折中,
迭代 1 与每第 N 次上节奏,中间复用上一次的引导。参考调用走 `_run_references_parallel`(≤8
workers),失败变**模型专属占位**而非炸循环;advisor 输出先过中央脱敏器再过 MoA 自己的 email/
电话模式(电话模式刻意要求分隔符,免得误伤行号/日期/SHA/IP)。usage/成本按 **advisor 自己的
费率**计价再美元求和(`_RefAccounting`),中断后迟到的 future 回调经 `_fold_pending_accounting`
补账(只加不覆,流式重试不重复计)。

### 6. 引导块的缓存经济学:`_attach_reference_guidance`

这是 moa_loop 全文最贵的一课。引导块每 turn 都不同,追加它有两种位置选择,而其中一种曾经把
缓存打回原点(#112358):

```python
# agent/moa_loop.py:1021-1036
def _attach_reference_guidance(agg_messages: list[dict[str, Any]], guidance: str) -> None:
    """Attach the per-turn reference block as its OWN trailing user message.

    The block varies per turn; appending keeps ``[system][task][tool-history]``
    cache-stable. It is never merged into a trailing user turn: iteration 1 of a
    tool loop ends on ``user(task)``, and a merged ``user(task + guidance)`` byte-differs
    from the ``user(task)`` every later iteration replays, so the provider prefix cache
    collapsed to the system prompt on iteration 2 of every turn (#112358). Converters
    that require strict alternation (Anthropic Messages, Converse, native Gemini) merge
    the two user turns as SEPARATE content blocks, so the task block stays byte-stable
    there too; on the OpenAI-compatible wire the request ends ``user(task), user(guidance)``,
    which a chat template that enforces strict user/assistant alternation rejects."""
    agg_messages.append({"role": "user", "content": guidance})
```

读三遍:合并进尾部 user turn,迭代 1 的 `user(task + guidance)` 与迭代 2 起重放的 `user(task)`
字节不同——**每次 turn 的第二次 API 调用,缓存就从系统提示词重新开始**。"独立的尾部 user 消息"
则让 `[system][task][tool-history]` 全程字节稳定。代价是 OpenAI wire 上出现相邻 user 对,严格
交替的聊天模板(llama.cpp/vLLM Jinja、Mistral、部分 OpenRouter)会 400——这正是
`moa_alternation.py` 的活:被 400 判定为 `FailoverReason.role_alternation` 后**只对这一个目的
地**合并重试一次,并在门面上记住 `(route, model)`,后续迭代预合并、永不付第二次 400;接受分离
形状的目的地永不被触碰。`peel_reference_guidance` 是精确逆操作,让缓存断点绝不落在每 turn 变化
的引导上。

### 7. 参考系统的"自白书"、one-shot 路径与追踪

advisor 看到的是一份**咨询视图**(`_reference_messages`):工具结果被头尾预览到 4000 字符(工具
调用保留全文),外加一条把它们钉在"顾问"位置上的系统提示词——没有它,advisor 会以为自己是
acting agent,拒绝执行或假装执行:

```python
# agent/moa_loop.py:183-197(节选)
_REFERENCE_SYSTEM_PROMPT = (
    "You are a reference advisor in a Mixture of Agents (MoA) process. You are "
    "NOT the acting agent and you do NOT execute anything: you cannot call "
    "tools, run commands, browse, or access files, repositories, or URLs, and "
    "you should not try to or apologize for being unable to. A separate "
    "aggregator/orchestrator model holds those capabilities and will take the "
    "actual actions.\n\n"
    "CRITICAL: You must NEVER claim or imply that you have executed a command, "
    "downloaded a file, accessed a URL, or performed any action. ..."
    "Advise in prose: never emit a tool call or a JSON "
    "tool-call object, because the aggregator replays what looks like one. "
    "Your response is private guidance handed to the aggregator, not an answer shown to the user. ..."
)
```

最后一句是硬需求:聚合器会**重放**看似工具调用的文本,所以 advisor 必须只出散文。
`aggregate_moa_context`(moa_loop.py:914)是 one-shot `/moa` 路径:扇出 → 全失败则跳过聚合器
(合成空转只会白等满 provider 超时)→ 合成失败回落拼接的建议原文 → 统一包上 "[Mixture of
Agents context — 私密引导]"信封。追踪(`moa_trace.py`)把每个跑了扇出的 turn 追加一行 JSONL 到
`<hermes_home>/moa-traces/<session_id>.jsonl`:advisor 看到什么、说了什么、花了多少,加聚合器
输入输出——**侧通道是刻意的**:参考调用是咨询性质的副调用,把它们的行写进 `messages` 表会腐蚀
角色交替、污染重放。opt-in(`moa.save_traces`),关闭时唯一开销是一次配置读;`full` 隐私模式下
追踪里的消息副本也过脱敏。surface 层经 `reference_callback` 收 `moa.reference`/`moa.progress`/
`moa.phase`/`moa.aggregating` 事件——显示回调失败只 debug,永不影响 turn。

### 8. `bot_chain.py`:跳数属于运行时,不属于模型

Bot Mode 允许 bot 互发消息,死循环防护的全部状态**由运行时持有**:跳数骑在投递的 author
envelope(`hops`)里,只有运行时写它,模型无法重置;超过 `gateway.bot_loop_guard.max_hops` 拒发。
同链内"同文同收件人"按 body 摘要去重;"回复不需要回复"的消息置 notify-only,且该 turn 不得再
回消息给对方:

```python
# agent/bot_chain.py:139-157(节选)
def admit_send(agent: Any, recipients: list[str], body: str) -> Admission:
    """Check one ``message_agent`` call to ``recipients`` ... Admitted recipients reserve their
    ask and the call's hop until ``Admission.release``."""
    settings = _settings()
    if not settings.enabled:
        return Admission()
    author = getattr(agent, "_turn_author", None) or {}
    author_id = str(author.get("id") or "") if author.get("is_bot") else ""
    digest = hashlib.sha256(" ".join(str(body).split()).encode()).hexdigest()
    with _LOCK:
        key = _bound_key(agent)
        state = _CHAINS.setdefault(key, _new_state(time.monotonic()))
        bot_turn = state["hops"] > 0
        hop = state["sent"] + 1 if bot_turn else 1
        if hop > settings.max_hops:
            return Admission(refusal=(
                f"This bot-to-bot exchange already reached its limit of {settings.max_hops} messages "
                "(gateway.bot_loop_guard.max_hops), so nothing was sent. Do not retry; finish your turn "
                "and tell your user where it stands."))
```

链状态按 **session_id** 键存进程级 `_CHAINS`,而非挂在 agent 上——网关可能在 turn 间重建
agent,丢了计数等于送新预算;压缩轮转让 session_id 变更时 `carry_chain` 把条目跟着搬。人发言即
断链(旧条目删除);拒绝文案直接给模型行为指令("Do not retry")。`Admission.release` 处理
"确定没发出去"的回收:撤销 ask 预订,整 call 无一送达时连 hop 也退回,重试既不算重复也不算
新跳。

### 9. `fast_mode.py`:有界快窗与字节不变性

`/fast auto` 让每个 user turn 开一个 `agent.fast_auto_seconds`(默认 60s)的窗口,`/fast cold`
只在无历史的会话首 turn 开。窗口只影响**每请求参数**(`service_tier`/`speed`),请求体其余部分
字节不变——这是它对提示缓存无副作用的全部理由。Anthropic 为每个 speed 单独留一份提示缓存,
所以 Anthropic 的窗口边界注定重写一次前缀(文档里明说,当作已知代价):

```python
# agent/fast_mode.py:59-74(节选)
def begin_turn(agent: Any, conversation_history: Any) -> None:
    """Open (or refuse) the fast window at a user-turn boundary."""
    mode = getattr(agent, "service_tier", None)
    agent._fast_until = 0.0
    if mode not in BOUNDED_MODES:
        return
    if mode == "cold" and any(
        isinstance(m, dict) and m.get("role") in ("user", "assistant", "tool")
        for m in (conversation_history or ())
    ):
        return
    ...
    agent._fast_until = time.monotonic() + max(window, 0.0)
```

`effective_request_overrides`(fast_mode.py:77)只在窗口开着时把 provider 的 fast override 叠加
到请求 kwargs 上,且对已标记"无 fast 容量"的模型摘除 `speed`。最后一对函数处理"组织根本没有
fast 容量":429 且 fast 限额头为 0 → `fast_mode_unprovisioned` 判定为无解(等待/换 key 都没用),
`mark_fast_mode_unavailable` 把模型标记进会话级黑名单,caller 每模型最多重试一次。
`SERVICE_TIER_WORDS` 是所有表面(config、CLI/网关/TUI 的 /fast)共用的唯一解析表——新 tier 加
一行即可。

---

## 核心类/函数

| 名称 | 位置 | 职责 |
|---|---|---|
| `RelayRuntime` / `RelaySession` | agent/relay_runtime.py:399/225 | 作用域栈 owner + 段轮转旗标;atexit 关停 |
| `ensure_session` / `begin_turn` / `end_turn` | agent/relay_runtime.py:492/1046/1100 | 会话 scope 取或建;turn 推弹 + 并发守卫 |
| `pop_relay_scope_if_top` | agent/relay_runtime.py:118 | 只弹栈顶;兄弟之上的 scope 延迟排水 |
| `resolve_execution_context` | agent/relay_runtime.py:1273 | (runtime, session, parent) 解析统一入口 |
| `_ManagedAttempt.resolve` | agent/relay_llm.py:58 | 物理尝试的托管判定与状态组装 |
| `RelayChatAccumulator` | agent/chat_completion_helpers_relay.py:26 | 并发安全:只用 collector 观测态重建响应 |
| `relay_tools.execute` | agent/relay_tools.py:16 | 工具调用的托管执行 + guard |
| `emit_compaction_mark` 族 / `resolve_relay_scope_cwds` | agent/relay_compaction.py, relay_cwd.py:27 | mark 挂载点寻址;(session_cwd, turn_cwd) 解析 |
| `MoAChatCompletions.create` | agent/moa_loop.py:1434 | 扇出缓存判定 + 引导注入 + 聚合器调用 |
| `_attach_reference_guidance` / `_fanout_cache_key` | agent/moa_loop.py:1021/1272 | 引导独立尾部消息;user_turn/every_n 节奏 |
| `_REFERENCE_SYSTEM_PROMPT` / `_run_references_parallel` | agent/moa_loop.py:183/619 | advisor 自白书;≤8 workers 扇出 + liveness 桥 |
| `aggregate_moa_context` | agent/moa_loop.py:914 | one-shot /moa 的扇出+合成 |
| `merge_same_role_messages` / `is_role_alternation_rejection` | agent/moa_alternation.py:32/53 | 反应式合并 + 400 分类 |
| `save_moa_turn` | agent/moa_trace.py | 全 turn 追踪 JSONL 追加(脱敏副本) |
| `on_turn_start` / `admit_send` / `carry_chain` | agent/bot_chain.py:71/139/61 | 链跳数推进 / 发送准入 / session_id 迁移 |
| `begin_turn`(fast_mode) / `effective_request_overrides` | agent/fast_mode.py:59/77 | 快窗开闭 / 窗口内的 tier 叠加 |
| `fast_mode_unprovisioned` / `mark_fast_mode_unavailable` | agent/fast_mode.py:97/110 | 429+限额头 0 的无解判定 / 会话级黑名单 |

## 本组文件清单

| 文件 | 主题 | 一句话 |
|---|---|---|
| `agent/relay_runtime.py` | Relay | 作用域栈/turn 生命周期/插件配置/关停排水 |
| `agent/relay_llm.py` | Relay | LLM 尝试适配器 + 三协议 codec + 流式累加 |
| `agent/relay_tools.py` | Relay | 工具执行的托管入口 + managed_callback_guard |
| `agent/relay_compaction.py` | Relay | 压缩记录 → hermes.compaction mark |
| `agent/relay_cwd.py` | Relay | scope input 的逻辑 cwd 解析 |
| `agent/chat_completion_helpers_relay.py` | Relay | chat_completions 流式的 Relay 侧累加器 |
| `agent/moa_loop.py` | MoA | 参考扇出、引导构建、OpenAI 兼容门面 |
| `agent/moa_alternation.py` | MoA | 严格交替 400 的反应式合并(目的地记忆) |
| `agent/moa_trace.py` | MoA | opt-in 全 turn 追踪 JSONL |
| `agent/bot_chain.py` | 备援面 | bot-to-bot 链的跳数/去重/回复规则 |
| `agent/fast_mode.py` | 调节器 | 有界快窗与 static service tier |

## 与其他模块的关系

- **transports / 模型层**:`relay_llm` 的托管执行挂在传输层之下——`chat_completion_helpers` 逐
  attempt 调 `_ManagedAttempt.resolve`;`RelayChatAccumulator` 复用
  `chat_completion_helpers_tool_calls._ToolCallAccumulator` 与 `reasoning_summaries`。
- **auxiliary**:`moa_loop` 的参考/聚合调用全部经 `agent.auxiliary_client.call_llm`
  (`task="moa_aggregator"` 等),记账进 aux 面(见 auxiliary_clients.md);MoA 扇出的活跃度经
  `_reference_liveness_hook` 桥回 `_touch_activity`(否则看门狗会在 advisor 流式期间误杀 turn)。
- **gateway/**:`bot_chain` 与 `gateway.bot_loop_guard` 共享 `load_settings` 与 max_hops 上限;
  `gateway.response_filters.is_machinery_display_kind` 参与链判定;Relay 的
  `gateway.telemetry.session_segments` 配置读取刻意避开 `gateway.run` 的 import 副作用
  (#87183/#95577)。
- **cli/**:`/moa` 斜杠命令只标记 turn;`hermes_cli/moa_config.resolve_moa_preset` 是预设解析;
  `hermes_cli/runtime_provider` 为 slot 解析真实 base_url/api_key/api_mode(按 profile 缓存,
  TTL 5 分钟)。
- **agent/其余**:`_touch_activity` 被 MoA liveness 桥与 `voice_turn_route` 双向使用;
  `error_classifier.classify_api_error` 供 role_alternation 判定;`redact.redact_sensitive_text`
  是 MoA 隐私过滤的中央底座;surface_switch 明确跳过 MoA turn(`api_content` sidecar 不盖章)。
- **tools/**:`tools.daemon_pool.DaemonThreadPoolExecutor` 是 Relay scope 操作的执行器;终端会话
  cwd(`tools.terminal_tool.get_session_cwd`)供 `relay_cwd` 读取。
- **NeMo Relay 库**:由 PM 环境提供;Relay 插件配置(plugins.toml)激活时托管执行对整个进程保留
  (`_ProcessRelayPluginConfiguration`,外方配置已存在则 FOREIGN 状态礼让)。

## 总结

这两套机制是"多模型"的两种正交形态:Relay 是**看**——一次 LLM 调用在观测骨架里留下完整的
父子 span 链,而它对执行的唯一介入是"被拦截器改写",所以整套集成最重的工程都在边界条件上
(并发 turn 不 LIFO、回调重入、codec 往返基线、10s 有界 scope 操作);MoA 是**想**——acting
model 的权力一寸不让,advisor 只提供私有引导,而引导块的每一点形状(独立尾部消息、扇出节奏、
peel 逆操作)都由提示缓存经济学决定。bot_chain 和 fast_mode 则示范了两个纪律:防环状态必须放
在运行时手里(envelope 由 runtime 写、session_id 键控),请求调优必须收敛到单表单字段
(`SERVICE_TIER_WORDS`)以保请求体字节稳定。一句话:**观测可以失败(有界、警告、跳过),引导
可以缺失(占位、降级),缓存前缀不能变。**
