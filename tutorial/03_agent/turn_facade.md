# turn_facade.md — 准入门面：AIAgent、租约与 Mixin 拼装

## 文件概览

用户消息要进入 `conversation_loop.run_conversation` 那颗心脏之前，必须先过一道**安检门**。
这道门由三份文件共同把守：

| 文件 | 行数 | 角色 |
|---|---|---|
| `agent/turn_facade.py` | 224 | `TurnFacadeMixin`：`AIAgent.run_conversation` / `chat` 的正式入口 |
| `agent/turn_facade_lease.py` | 495 | 跨进程会话 turn 租约：准入、续租线程、停滞看门狗接线 |
| `run_agent.py` | 1,565 | 公共门面：`AIAgent` 类 = 14 个 Mixin 拼装；`__init__` 是纯转发器 |
| `agent/agent_init.py` | 2,211 | `init_agent`：构造的真正实现（相位顺序 load-bearing） |
| `agent/iteration_budget.py` | 60 | 线程安全的迭代预算（父子共享） |

根 AGENTS.md 对这个布局的概括：`run_agent.py` is the public facade: `AIAgent` is assembled
from mixins; Construction runs `agent/agent_init.py::init_agent`; a turn is
`agent/conversation_loop.py::run_conversation`, which `AIAgent.run_conversation` forwards to
**after taking the session turn lease** (`turn_facade_lease.py`).

```
用户消息
   ▼
AIAgent.run_conversation   (turn_facade.py:22，TurnFacadeMixin)
   │ ① cancel_background_review_for_live_turn  后台 review 让路
   │ ② admit_durable_turn_lease  ← 跨进程准入（另一进程在用就等/退）
   │ ③ relay/accounting/portal scopes  ④ bind_subagent_parent / interrupt scope
   │ ⑤ lease.start()（续租线程 + 看门狗上线）
   ▼
conversation_loop.run_conversation (:1808)   ← 心脏
   │ finally: lease.stop_refresher() → join_threads → clear_interrupt → release
   ▼
结果 dict 返回给调用方（CLI / 网关 / TUI / 桌面 / ACP / cron）
```

---

## 关键代码走读

### 1. TurnFacadeMixin.run_conversation —— 安检门的五步（turn_facade.py:22）

```python
# agent/turn_facade.py:19-41（节选）
class TurnFacadeMixin:
    """run_conversation()/chat() (see module docstring)."""

    def run_conversation(
        self, user_message: Any, system_message: str | None=None,
        conversation_history: list[dict[str, Any]] | None=None, task_id: str | None=None,
        ...
    ) -> dict[str, Any]:
        """Forwarder — see ``agent.conversation_loop.run_conversation``."""
        # A review shares this session_id for cache parity: fence review startup or interrupt
        # an admitted request and await its exit before opening live-turn instrumentation.
        from agent.background_review import cancel_background_review_for_live_turn

        cancel_background_review_for_live_turn(self)

        from agent.turn_facade_lease import admit_durable_turn_lease, carry_unadmitted_user_message
        ...
```

第一步先请走后台 review fork（它共享 session_id 以获得同源缓存前缀；前台 turn 开始前
要么挡住它启动、要么打断已准入的请求并等它退出）。接着生成 `effective_task_id` 与
`relay_turn_id`，然后进入 try/finally——**finally 里的对称复位比 try 里的开启还长**
（:190-218）：结束 relay turn → 释放 relay 会话 → 租约停止续租、join 线程、
清中断、释放行 → 复位活动标签 → 依次复位 portal/accounting/affinity 三个 ContextVar
→ `note_turn_finished` 平衡计数。每个 token 初始为 None，注释写明原因（:74-76）：
早退的路径可能根本没执行过 set 调用，finally 必须**无条件**逐个复位。

准入与转发（:80-158）：

```python
# agent/turn_facade.py:83-98（节选）
            admission = admit_durable_turn_lease(
                self, session_id=session_id, relay_turn_id=relay_turn_id, task_context=task_context,
                conversation_history=conversation_history,
            )
            if admission.early_result is not None:
                carry_unadmitted_user_message(
                    admission.early_result, user_message, persist_user_message, ...)
                relay_outcome = ("cancelled" if admission.early_result.get("interrupted")
                                 else "timed_out")
                return admission.early_result
            lease = admission.lease
            conversation_history = admission.conversation_history
```

准入失败就**原样返回 early_result**（被中断 / 等待超时），用户的输入由
`carry_unadmitted_user_message` 转移到结果历史里，让下一个 turn 能接手并持久化它——
排队等了 20 分钟才被用户按停的消息，绝不能凭空消失。

随后挂载四层作用域并真正进入循环：

```python
# agent/turn_facade.py:133-163（节选）
            token = set_conversation_context(self._conversation_root_id())   # Portal 标签
            affinity_token = set_affinity_scope(declared_conversation_scope_safe(self))
            acct_token = set_accounting_context(                             # 辅助调用记账
                getattr(self, "_session_db", None), getattr(self, "session_id", None))
            with bind_subagent_parent(self), scoped_runtime_main({}), track_in_interrupt_scope(self):
                try:
                    if lease is not None:
                        lease.start()
                    result = run_conversation(          # ← conversation_loop.run_conversation
                        self, user_message, system_message, conversation_history, ...)
                finally:
                    if lease is not None:
                        lease.stop_refresher()          # 先停续租，再走 join/release
```

`bind_subagent_parent` 让子代理把自己的父会话记录在案；`scoped_runtime_main` 与
`track_in_interrupt_scope` 分别限定运行时与中断的作用域。`chat`（:220-222）是极简封装：

```python
# agent/turn_facade.py:220-222
    def chat(self, message: str, stream_callback: Optional[callable] = None) -> str:
        """Final response string of one turn; ``stream_callback`` receives each text delta."""
        return self.run_conversation(message, stream_callback=stream_callback)["final_response"]
```

### 2. admit_durable_turn_lease —— 跨进程会话租约（turn_facade_lease.py:299）

为什么需要租约？`state.db` 里的会话被多个进程共享（Desktop、CLI resume、网关、后台投递），
**同一时刻只允许一个进程对一个会话执行 load → run → flush**，否则两个进程交错写入
同一份转录就是数据损坏。模块 docstring（:1-8）给出分工：`admit_durable_turn_lease`
负责拿行级租约（或返回门面必须转交的 early result）；`DurableTurnLease` 负责周期续租、
看门狗接线、丢租/停滞中断。

```python
# agent/turn_facade_lease.py:26-31
LEASE_TTL_SECONDS = 300.0      # 行租约的 TTL
LEASE_WAIT_SECONDS = 1800.0    # 最多等另一个进程 30 分钟
_REFRESH_WRITE_PATIENCE_S = 20.0   # 续租等待写锁的耐心
_REFRESH_EXPIRY_MARGIN_S = 2.0     # 距过期的安全余量

# agent/turn_facade_lease.py:299-311（节选）
def admit_durable_turn_lease(
    agent, *, session_id: str, relay_turn_id: str, task_context: dict[str, Any],
    conversation_history: Optional[list[dict[str, Any]]],
) -> TurnLeaseAdmission:
    """Acquire the session turn lease (the row need not exist yet); build (not start) its threads.

    Mutates ``task_context["session_id"]`` and ``agent.session_id`` when the wait forced a resume-id
    reload. Returns an ``early_result`` (interrupted / timed out) instead of a lease when admission
    fails; the caller returns it verbatim."""
```

三个值得注意的细节：

1. **没有行也照样拿租约**（:318-326 注释）：客户端自造的 session id 不保证进程唯一，
   第一次 turn 可能在中途才建行——若"没有行就不拿租约"，第二个写进程就会拿一个无人
   持有的租约、把自己的 turn 插进来。holder 串是
   `pid=<pid>:turn=<relay_turn_id>:platform=<platform>`。
2. **等到了才重载转录**（:378-401）：等待期间上一个持有者可能压缩/轮转了会话；
   只有 `reload_needed` 且行确实存在（或不确定）时才重载——立即拿到租约的快路径跳过
   这一步，省一次提示词缓存 miss。
3. **异常时释放已拿到的租约**（:403-406）：`except BaseException: lease.release(); raise`——
   门面还没见过这个 lease，不能让它泄漏（行永远锁死）。

等待期间的用户体验在 `_on_wait`（:336-344）：先提示"另一个 Hermes 进程正在使用此会话，
等待中"，超过 1 秒开始播报已等待秒数。

### 3. DurableTurnLease —— 续租与看门狗（turn_facade_lease.py:34）

```python
# agent/turn_facade_lease.py:83-101（节选）
    def start(self) -> None:
        with self._lock:
            self.turn_active = True
        # Stamp the activity clock at turn entry: `_last_activity_ts` persists across turns, so
        # without this the watchdog would measure idle from the PREVIOUS turn and abort a fresh one.
        self.agent._touch_activity("starting new turn")
        ...
        self.timer_handles.append(schedule(self.refresh_tick, self.refresh_interval))  # 默认 60s
        if self.watchdog is not None:
            self.timer_handles.append(self.watchdog.schedule())
```

注意：定时器走**共享调度器**（`agent/periodic_scheduler.py`），不是每 turn 两个线程。
turn 进入时要摸一次活动时钟——`_last_activity_ts` 是跨 turn 持久的，不摸的话看门狗
会拿上一个 turn 的尾巴来量这个新 turn，直接误杀。

续租核心 `refresh_tick`（:201-258）的语义：续租成功 → `_authority_deadline` 前移，这是
**唯一**能移动 deadline 的事情；真正的丢租（rowcount 0）→ `_interrupt_turn` 无条件打断本
turn——"丢租意味着这个进程已不再拥有该会话"（:130-132 注释），打断不需要 generation 认领；
SQLite 锁是"错过一拍"，只有下一次尝试也来不及在过期前落笔时才停
（`_stop_on_exhausted_authority`，:195-199）；续租 UPDATE 带 holder 限定（fence），防止迟到
的续租者续到后继租约上。

看门狗接线 `build_threads`（:62-81）：**续租成功 ≠ 有进展**——一个静默卡死的 turn
会永远续租。所以可选配置 `agent.turn_liveness` 会构造 `TurnLivenessWatchdog`
（实现在 turn_liveness.py），停滞即硬中断。`commit_liveness_abort`（:144-175）是看门狗的
提交点：在 `_touch_activity` 同一把锁下复核观察到的 `(generation, timestamp)`，
turn 若已复活则拒绝中止（fail-closed 语义是"拒绝中止"而非"强行中止"）。

### 4. run_agent.py —— AIAgent：14 个 Mixin 的拼装（:214）

```python
# run_agent.py:214-219
class AIAgent(
    ClientLifecycleMixin, StreamDeliveryMixin, StatusOutputMixin, ApiRequestHooksMixin, ApiErrorSummaryMixin,
    InterruptControlMixin, TurnExplainersMixin, ActivityTrackingMixin, RateLimitCreditsMixin,
    SessionPersistenceMixin, CompressionFacadeMixin, TurnFacadeMixin, VisionMessagePrepMixin, ReasoningParamsMixin,
):
    """AI Agent with tool calling capabilities."""
```

14 个 Mixin，各管一摊：客户端生命周期、流式投递、状态输出、API 请求钩子、错误摘要、
中断控制、turn 解释器、活动跟踪、限流额度、会话持久化、压缩门面（**TurnFacadeMixin
在这里**）、视觉消息预处理、推理参数。`AIAgent` 本体几乎不写业务——它要么是 Mixin
方法，要么是 `_forward` 转发：

```python
# run_agent.py:465 + 1376-1378（节选）
    switch_model = _forward("agent.agent_runtime_helpers", "switch_model")
    _execute_tool_calls_concurrent = _forward("agent.tool_executor", "execute_tool_calls_concurrent")
    _execute_tool_calls_sequential = _forward("agent.tool_executor", "execute_tool_calls_sequential")
    _handle_max_iterations = _forward("agent.chat_completion_helpers", "handle_max_iterations")
```

`_forward` 在首次调用时才 import 目标模块并转发（`agent/lazy_forward.py`）——
MRO 不变、日志名不变，实现却搬进了兄弟模块。这就是根 AGENTS.md 说的
**facade + siblings 布局**：门面保留公共入口和"别人 import 的名字"，实现住在兄弟文件。

### 5. __init__ 是纯转发器（run_agent.py:236-288）

```python
# run_agent.py:236-241 + 282-288（节选）
    def __init__(
        self,
        base_url: str | None = None, api_key: str | None = None, provider: str | None = None,
        api_mode: str | None = None, ..., model: str = "",
        max_iterations: int = sys.maxsize,  # unlimited tool-calling iterations by default (shared with subagents)
        ...
    ):
        """Forwarder — see ``agent.agent_init.init_agent`` (same keyword parameters, minus ``tool_delay``)."""
        init_kwargs = {k: v for k, v in locals().items() if k not in ("self", "tool_delay")}
        if tool_delay is not None:
            warnings.warn("tool_delay is deprecated and ignored; sequential tool calls "
                          "no longer sleep between executions.", DeprecationWarning, stacklevel=2)
        from agent.agent_init import init_agent
        init_agent(self, **init_kwargs)
```

约 60 个参数原封不动打包进 `init_agent`（唯一排除的 `tool_delay` 已弃用，仅发警告）。
注意 `max_iterations` 的默认值是 `sys.maxsize`——**默认不限工具轮数**，真正的闸门是
IterationBudget（下节）。

`agent/agent_init.py::init_agent`（:2056-2208）的**相位顺序是 load-bearing 的**，
对零基础读者最有用的几步：

```python
# agent/agent_init.py:2111-2120（节选）
    # Shared iteration budget: parent creates, children inherit.
    agent.iteration_budget = iteration_budget or IterationBudget(max_iterations)
    ...
    _resolve_api_mode(agent, api_mode, provider_name, base_url)      # 相位：路由定型
    _finalize_routing(agent, api_mode, credential_pool)
    _init_prompt_cache_config(agent)      # 相位：缓存配置
    _init_turn_state(agent, run_budget_seconds)
    _build_client(agent, api_key, base_url, fallback_model)          # 相位：建 client
    _init_fallback_chain(agent, fallback_model)
    _load_tools(agent, enabled_toolsets, disabled_toolsets)          # 相位：装工具
    _init_session_state(agent, session_id, session_db, ...)
    _init_memory(agent, _agent_cfg, skip_memory, platform, ...)      # 相位：记忆
    _parse_compression_config(agent, _agent_cfg); _resolve_context_length(...)
    _build_context_engine(...)
    _snapshot_primary_runtime(agent)      # 最后：快照主运行时（fallback 后能回切）
```

顺序为什么要紧？举例：DB 会话行的创建（`_ensure_db_session`，run_agent.py:315）发生在
**每个 turn 的系统提示词构建之后**——同一思想贯穿构造期：先有提示词缓存配置，再有
client；先有工具，再有会话状态；配置快照（`_snapshot_primary_runtime`）必须最后做，
否则 fallback 之后无从"恢复主运行时"。

### 6. IterationBudget —— 线程安全的迭代预算（iteration_budget.py:25）

```python
# agent/iteration_budget.py:25-56（节选）
class IterationBudget:
    """Thread-safe iteration counter; ``execute_code`` (programmatic tool calling)
    iterations are refunded via :meth:`refund` so they don't eat into the budget."""

    def __init__(self, max_total: int):
        self.max_total = max_total
        self._used = 0
        self._lock = threading.Lock()

    def consume(self) -> bool:
        """Try to consume one iteration.  Returns True if allowed."""
        with self._lock:
            if self._used >= self.max_total:
                return False
            self._used += 1
            return True

    def refund(self) -> None:
        with self._lock:
            if self._used > 0:
                self._used -= 1

    @property
    def remaining(self) -> int:
        with self._lock:
            return max(0, self.max_total - self._used)
```

模块 docstring（:1-5）说明预算模型：**每个 AIAgent（父或子）各持有一个
IterationBudget**；父的上限来自 `max_iterations`，每个子代理用
`delegation.max_iterations`（config_migrations.py:779-787 记录了它从 50 提到 250——50 会
截断扎实的委派工作），所以父子总迭代数可以超过父的上限。`consume`/`refund` 在主循环与
工具轮里被调用：只有 `execute_code`（程序化工具调用）的轮次直接退款
（turn_tool_round.py:207-208）——廉价 RPC 式调用不该吃掉预算。

### 7. 公共 API 与 reset_session_state

对使用者而言 `AIAgent` 的门面只有几个名字（agent/AGENTS.md）：`run_conversation(...) -> dict`
（完整 turn，返回 `final_response` + `messages` 等键的结果 dict）、`chat(message) -> str`
（只要最终回答字符串）、`close()` / `reset_session_state(...)`（资源与状态复位）。

```python
# run_agent.py:379-397（节选）
    def reset_session_state(self, previous_messages=None, old_session_id=None, carry_over_context=False):
        """Reset session-scoped token/cost counters and compressor state for a fresh session."""
        for counter in ("session_total_tokens", "session_input_tokens", ..., "session_api_calls"):
            setattr(self, counter, 0)
        ...
        self._usage_anchor = None            # 会话边界：usage 锚描述的是旧转录
        self._frozen_workspace_snapshot = None  # 工作区快照按会话钉住（system_prompt.py）
```

`/new`、`/resume`、`/branch` 都会走到它：清计数器、清 usage 锚与工作区快照、
驱动上下文引擎的完整会话过渡（on_session_end → on_session_reset → on_session_start）。
系统提示词缓存不在它手里清——提示词是"每会话一次"，随轮转/压缩边界由
`invalidate_system_prompt`（system_prompt.py:822）处理。

---

## 核心类/函数

| 符号 | 职责 | 位置 |
|---|---|---|
| `AIAgent` | 公共门面类：14 个 Mixin 拼装 + `_forward` 转发 | `run_agent.py:214` |
| `AIAgent.__init__` | 纯转发器：打包 locals() 调 `init_agent`（排除 `tool_delay`） | `run_agent.py:236` |
| `AIAgent.run_conversation` / `.chat` | turn 安检门（review 让路→租约准入→作用域→转发）/ 简单字符串接口 | `agent/turn_facade.py:22` / `:220` |
| `AIAgent.reset_session_state` | 会话计数器/锚点/引擎状态复位 | `run_agent.py:379` |
| `AIAgent._execute_tool_calls` | 工具批执行入口（分段规划） | `run_agent.py:1308` |
| `admit_durable_turn_lease` | 跨进程会话 turn 租约准入（行可以尚不存在） | `agent/turn_facade_lease.py:299` |
| `DurableTurnLease` / `.refresh_tick` | 租约持有者（续租/看门狗/释放）/ 周期续租（成功是唯一移动 deadline 的事件） | `agent/turn_facade_lease.py:34` / `:201` |
| `DurableTurnLease.commit_liveness_abort` | 看门狗中止提交点（同锁复核 generation） | `agent/turn_facade_lease.py:144` |
| `TurnLeaseAdmission` | 准入结果：lease / early_result 二选一 | `agent/turn_facade_lease.py:261` |
| `carry_unadmitted_user_message` | 等租约被打断的用户输入转存到 early result | `agent/turn_facade_lease.py:411` |
| `init_agent` | 构造真身（相位顺序 load-bearing） | `agent/agent_init.py:2056` |
| `IterationBudget` | 线程安全 consume/refund 计数器（父子共享） | `agent/iteration_budget.py:25` |
| `lease_not_acquired_result` | 准入失败的类型化 early result（中断/超时） | `agent/turn_facade_lease.py:445` |

## 本组文件清单

| 文件 | 一句话角色 |
|---|---|
| `run_agent.py` | 公共门面：`AIAgent`（14 Mixin）+ `main()` CLI 入口；`__init__` 纯转发 |
| `agent/turn_facade.py` | `TurnFacadeMixin.run_conversation`/`chat`：租约准入与作用域挂载后转发循环 |
| `agent/turn_facade_lease.py` | 跨进程会话 turn 租约（admit + DurableTurnLease 续租/看门狗/释放） |
| `agent/agent_init.py` | `init_agent`：构造的真正实现（参数打包、路由、client、工具、记忆、压缩） |
| `agent/iteration_budget.py` | 线程安全迭代预算（父子共享、execute_code 可退款） |
| `agent/lazy_forward.py` | `_forward`：门面到兄弟模块的惰性转发（MRO 不变） |

## 与其他模块的关系

```
run_agent.AIAgent（门面，14 个 Mixin）
   ├── turn_facade.py ──► turn_facade_lease.py ──► hermes_state（SessionDB 行租约）
   │        │                                  └─► turn_liveness.py（看门狗实现）
   │        └─► conversation_loop.run_conversation（心脏，见 conversation_loop.md）
   ├── client_lifecycle / stream_delivery / session_persistence / compression_facade ...
   └── agent_init.py ──► hermes_cli.config（配置读取）+ providers 注册表（api_mode 解析）
```

- 网关/Desktop/CLI/TUI/ACP/cron 全部通过 `AIAgent.run_conversation` 进入，
  没有任何宿主绕过租约直呼 `conversation_loop.run_conversation`。
- 租约的持久层是 `hermes_state.py`（SessionDB）的
  `acquire/refresh/release_session_turn_lease`；TTL 300s、续租默认 60s。
- 构造期的每个相位又有自己的兄弟文件（`agent_init_fallback.py`、
  `agent_init_memory_provider.py`、`agent_init_ollama.py`……），门面照旧只转发。

## 总结

- **门面三层**：`AIAgent`（Mixin 拼装 + `_forward`）→ `TurnFacadeMixin.run_conversation`
  （安检门）→ `conversation_loop.run_conversation`（心脏）。每层只做自己的事。
- **安检门五步**：后台 review 让路 → 跨进程租约准入 → relay/accounting/portal 作用域 →
  中断/父子绑定 → `lease.start()` 后转发；finally 对称释放每一个，无条件复位。
- **租约 = 会话的进程级互斥锁**：TTL 300s、最多等 1800s；续租成功是唯一移动 deadline 的
  事件；丢租无条件硬中断；看门狗防"静默卡死但租约健康"；wait 被打断时用户输入由
  `carry_unadmitted_user_message` 转存，不丢消息。
- **构造即打包**：`__init__` 把 ~60 个参数打包转给 `init_agent`，相位顺序
  （路由→缓存→client→工具→会话→记忆→压缩→快照）load-bearing。
- **预算模型**：`max_iterations` 默认 `sys.maxsize`（不限），实际闸门是线程安全的
  `IterationBudget`（父上限、子代理独立、`execute_code` 退款）；主循环还有
  `_budget_grace_call` 一次宽限，让预算耗尽时能产出体面的总结。
