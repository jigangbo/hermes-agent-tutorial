# conversation_loop.py — Agent 主循环心脏

## 文件概览

`agent/conversation_loop.py`（1,967 行）是 Hermes 整个 Agent 的**心脏**：一个用户消息进来之后，
"调模型 → 解析响应 → 执行工具 → 把工具结果喂回去 → 再调模型……"直到模型给出最终文字回答，
这整台发动机就装在这个文件里。它原本是 `run_agent.py` 里 `AIAgent` 的几千行内联 while 循环，
后来被抽成独立模块；函数签名都带一个 `agent` 参数——不是类方法，而是"把 AIAgent 实例当
上下文对象传进来"的普通函数（模块 docstring，`agent/conversation_loop.py:1-6`）。

文件顶部有一句关键设计说明（`:43-44`）：*Phase helpers of the turn loop, bound at import so a
source-tree swap cannot load a skewed phase mid-turn*——turn 循环的各阶段助手在 import 时就
绑定好，源码树热替换不可能让一轮 turn 中途换实现。

一个 turn（一轮用户对话）分两层：`run_conversation`（外层信封）套着 `_run_conversation_turn`
（真正的循环体）。整条链路**完全同步**（没有 async/await），只在真正发起 HTTP 请求时借一个
worker 线程，以便用户随时可以打断（interrupt）。

---

## 关键代码走读

### 1. 完整的 turn 阶段序列（ASCII 全景图）

编号对应真实代码行（`agent/conversation_loop.py:1646-1805`），方括号内是阶段实际所在文件：

```
用户消息 user_message
      │
      ▼
┌──────────────────────────────────────────────────────────────┐
│ run_conversation (:1808)  外层信封                            │
│  native_turn_images（本 turn 原生图片上下文）                   │
│  调 _run_conversation_turn → settle_held_final                │
│  → export_current_turn_boundary（盖章 {turn_id, user_idx}）    │
│  → _close_durable_failed_turn（失败 turn 收口）                │
├──────────────────────────────────────────────────────────────┤
│ _run_conversation_turn (:1646)                                │
│ ① MoA 解码 + 每 turn 状态复位 (:1673-1695)                     │
│ ② build_turn_context [turn_context.py:1189]                   │
│     ↳ run_turn_start_compaction：idle→preflight→溢出告警 re-arm│
│ ③ begin_voice_turn_route（语音 turn 换路由）                    │
│ ④ 构造 _LoopState (:1740)，从 TurnContext 按名播种              │
│ ⑤ _turn_without_loop (:1617)：pre_llm_call 否决 OR             │
│     codex_app_server 运行时 → 不进通用循环，直接出结果           │
│ ⑥ play_prelude [turn_scripted_prelude.py:57]                  │
│                                                               │
│ ╔═ WHILE (api_call_count < max_iterations AND budget>0) ═════╗ │
│ ║     OR grace_call                                          (:1751-1753)
│ ║  a. begin_iteration   [turn_iteration_prep.py:352]          │
│ ║      重定向入栈/中断检查/预算扣减/api_call_count += 1          │
│ ║  b. prepare_iteration  → c. assemble_api_request             │
│ ║      [turn_request_assembly.py:106 装饰副本+cache plan]      │
│ ║  d. run_preflight_gate [turn_preflight_gate.py:20] 压力门    │
│ ║  e. announce_api_call → f. _run_api_retry_loop (:1577)       │
│ ║      while retry_count < max_retries:                        │
│ ║        nous_rate_limit_guard [turn_api_call.py:232]          │
│ ║        build_api_request    [turn_api_request.py:177]        │
│ ║        perform_api_call     [turn_api_call.py:72] ★真调用     │
│ ║        check_api_response   [turn_response_check.py:92]      │
│ ║        except InterruptedError → handle_api_interrupt        │
│ ║        except Exception       → handle_api_error             │
│ ║            [turn_api_error.py:52]                            │
│ ║  g. apply_retry_restarts [turn_iteration_prep.py:437]        │
│ ║      消费重启信号（重定向/压缩重建/fallback）→ continue        │
│ ║  h. normalize_model_response [turn_response_intake.py:165]   │
│ ║  i. tool_calls?                                              │
│ ║      ├─ 是 → run_tool_round [turn_tool_round.py:49]          │
│ ║      │      验证→先持久化再执行→回填结果→continue              │
│ ║      └─ 否 → finish_text_response (:106) → return 结果       │
│ ║  except → handle_outer_loop_error [turn_loop_errors.py:35]   │
│ ╚══════════════════════════════════════════════════════════════╝
      │ 循环结束（回答完成/预算耗尽/中断/错误上限）
      ▼
 finalize_turn [turn_finalizer.py:619]
 预算兜底 → "静默停止"修复 → 轨迹保存 → 持久化 → 输出变换 → 结果 dict
```

记住这张图，后面每一节都是在放大其中某一块。

### 2. run_conversation：turn 的外层信封（:1808）

```python
# agent/conversation_loop.py:1825-1831（docstring）
    """Run one turn (see ``_run_conversation_turn``) and export the current-turn boundary.

    Every envelope that leaves the loop — success, partial/error, interrupt, retry-exhausted,
    tool-limit, preflight timeout, codex runtime — passes through here, so the
    ``{turn_id, current_turn_user_idx}`` pair is stamped beside the exact ``messages`` it
    addresses, after every history rewrite including post-turn micro-compaction."""
```

docstring 说得直白：**所有离开循环的信封**（成功、部分失败、中断、重试耗尽、工具上限、
preflight 超时、codex 运行时）都要路过这里——因为要在"最后一刻"（所有历史改写都完成后）
给结果盖 `{turn_id, current_turn_user_idx}` 印章。主体三步（:1838-1866）：

```python
# agent/conversation_loop.py:1838-1866（节选）
    agent._turn_user_intervened = False          # steer/重定向/中断会置位，结果里上报
    with native_turn_images(user_message):
        try:
            result = _run_conversation_turn(...)  # ← 真正的循环
        finally:
            end_voice_turn_route(agent)           # 语音路由必回退，即使抛异常
    settle_held_final(agent, result)              # hold_stream 持扣的最终回答落地
    result = export_current_turn_boundary(agent, result, user_message)
    if isinstance(result, dict):
        result["user_intervened"] = bool(getattr(agent, "_turn_user_intervened", False))
    _close_durable_failed_turn(agent, result)     # 失败 turn 的持久化收口
    return result
```

`_close_durable_failed_turn`（:1914）值得单独一提：失败的 turn 若什么都没留下，
持久化尾巴会停在裸 `user` 行或裸 `tool` 行上，下一个 prompt 追加第二条 user 行就违反
角色交替。它在 SessionDB 尾部补一条 Hermes 署名的 assistant 边界行，并刻意**排除**
上下文压力类失败（`compression_exhausted` 等）——往已经超限的会话里继续追加，正是
历史 issue #1630 那个"越压越大"的死循环。

### 3. _run_conversation_turn 的前半段：赛前准备（:1646-1748）

```python
# agent/conversation_loop.py:1673-1682（节选）
    if moa_config is None:
        user_message, moa_config, persist_user_message = _decode_inline_moa_turn(
            user_message, persist_user_message)
    # The gateway caches agents across turns; compression state is per-turn, or a stale
    # in-place boundary would make a later uncompressed result look compacted.
    agent._last_compaction_in_place = agent._last_compression_attempt_recorded = False
```

第一，用户消息里若编码了 MoA（多模型混合）预设先解码；第二，**压缩状态是 per-turn 的**——
网关会缓存 AIAgent 跨 turn 复用，不重置的话上一轮的"原地压缩边界"会污染下一轮的判断。
这正是根 AGENTS.md"一个进程服务多个 turn，任何跨 turn 状态泄漏都是 bug"的具体体现。

接着是重头戏 `build_turn_context`（:1699-1717）：一次性赛前准备（系统提示词恢复或重建、
用户消息入列、三遍 turn 起始压缩、插件 `pre_llm_call` 钩子、内存预取……），返回
`TurnContext` 数据类。它传入了一堆函数引用（`restore_or_build_system_prompt=...`、
`ra=_ra` 等，:1706-1712）——为了**避免循环 import**：turn_context 不能模块级 import
conversation_loop，回调从调用方传进去。`PreflightCompressionTimedOut`（:1718-1719）是
唯一专门异常出口：turn 起始 preflight 压缩超时就直接返回类型化失败结果，循环都不进。

### 4. _LoopState：把循环局部变量装进一个数据类（:1460）

```python
# agent/conversation_loop.py:1460-1468
@dataclass
class _LoopState:
    """Every local the turn loop threads through the phase helpers in ``agent/turn_*.py``.

    Helpers take the loop locals they need as keyword arguments named like these fields and
    return a verdict whose non-``action``/``result`` fields carry the same names;
    :func:`_run_phase` passes and copies them back by name, so a new helper input/output
    needs a field here and nothing else. Per-iteration slots are rebound by the phases
    before any later phase reads them, exactly as the former inline locals were."""
```

docstring 就是设计文档，翻译成三句话：

1. turn 循环里每一个要穿过阶段助手的局部变量，都是 `_LoopState` 的一个字段（:1470-1540）；
2. 阶段助手用**与字段同名**的关键字参数接收它们，返回 verdict，verdict 上除
   `action`/`result` 外的字段也叫同样的名字；
3. `_run_phase` 按名字传参、按名字回拷——**给某个阶段加输入/输出 = 只加一个字段，
   别的什么都不用改**。

字段按生命周期分三组：

| 组 | 代表字段 | 含义 |
|---|---|---|
| 整个 turn 固定 | `user_message`、`system_message`、`conversation_history`、`turn_id` | 进 turn 时确定，之后只读 |
| turn 级可变 | `messages`、`active_system_prompt`、`api_call_count`、`final_response`、`compression_attempts`、`restart_count` | 循环过程中被各阶段改写 |
| 单次迭代槽位 | `api_messages`、`tools_for_api`、`response`、`api_kwargs`、`retry_count`、`finish_reason`、`assistant_message` | 每次迭代开始前重新赋值 |

`restart_count`（:1496-1502）的注释解释了一个坑：`retry_count` 每次迭代清零，但
"重定向重启"和"fallback 重建"这类**会退还迭代预算**的重启不能无限刷——需要一个跨迭代
存活的计数器兜底，防止失控的重启循环一直白嫖预算、一直占着 turn 租约。

### 5. _run_phase：按参数名传参、回拷的魔法胶水（:1556）

```python
# agent/conversation_loop.py:1549-1574
# Keyword names each phase helper takes (minus ``agent``), cached per function object.
_PHASE_PARAMS: dict[Any, tuple] = {}
# Verdict fields the loop latches (only ever sets True) instead of copying back:
# ``handle_api_error`` reports overflow recovery per call and must not clear an earlier arm.
_LATCHED_VERDICT_FIELDS = {"handle_api_error": frozenset({"_provider_overflow_recovery_pending"})}


def _run_phase(fn, agent, state: _LoopState, **extra):
    """Call phase helper ``fn`` with the loop locals it names, copy its verdict fields back.

    ``extra`` supplies non-state arguments (the caught exception). Returns the verdict so
    the caller can act on ``.action`` / ``.result``."""
    params = _PHASE_PARAMS.get(fn)
    if params is None:
        params = _PHASE_PARAMS[fn] = tuple(p for p in inspect.signature(fn).parameters if p != "agent")
    verdict = fn(agent, **{n: extra[n] if n in extra else getattr(state, n) for n in params})
    latched = _LATCHED_VERDICT_FIELDS.get(getattr(fn, "__name__", ""), ())
    for f in fields(verdict):
        if f.name in ("action", "result"):
            continue
        value = getattr(verdict, f.name)
        if f.name not in latched:
            setattr(state, f.name, value)
        elif value:
            setattr(state, f.name, True)
    return verdict
```

逐行拆解：

- **第一次调用时用 `inspect.signature` 缓存形参名**（`_PHASE_PARAMS`）；
- **调用时从 state 按名取值**：`extra` 传 state 之外的东西——最典型是 `except` 捕到的
  异常（`_run_phase(handle_api_error, agent, s, api_error=api_error)`）；
- **调完把 verdict 上除 `action`/`result` 外的所有字段按名拷回 state**——阶段函数改了
  `retry_count`，主循环的 `s.retry_count` 立刻同步；
- **`_LATCHED_VERDICT_FIELDS` 是特例**：`handle_api_error` 每次都报告"是否进入 overflow
  恢复"，直接回拷的话一次 False 会熄掉之前点亮灯。所以这类字段**只许置 True（闩锁），
  不许被 False 回拷清零**。

```
        _LoopState (s)
             │ 按名取值
             ▼
  _run_phase(fn, agent, s) ──► fn(agent, retry_count=s.retry_count, messages=s.messages, ...)
             ▲                          │
             │ verdict 字段按名回拷       ▼
        _LoopState (s) 已更新 ◄────── verdict（含 action/result）
```

### 6. verdict 的四种 action

每个阶段函数返回带 `action` 字段的 verdict，语义全项目统一：

| action | 含义 | 主循环的对应动作 |
|---|---|---|
| `fallthrough` | 正常走完，继续下一阶段 | 顺序往下 |
| `return` | turn 结束，`result` 是最终结果 dict | `return _xx.result` |
| `break` | 跳出当前循环（内层 break 交给外层；主循环 break 去 finalize） | `break` |
| `continue` | 本迭代结束，重开下一迭代 | `continue` |

主循环里这种模式反复出现：

```python
# agent/conversation_loop.py:1754-1764
        if _run_phase(begin_iteration, agent, s).action == "break":
            break
        _run_phase(prepare_iteration, agent, s)
        _run_phase(assemble_api_request, agent, s)
        _pg = _run_phase(run_preflight_gate, agent, s)
        if _pg.action == "return":
            return _pg.result
        if _pg.action == "break":
            break
        if _pg.action == "continue":
            continue
```

`prepare_iteration` 和 `assemble_api_request` 连 verdict 都不接——`AssembledRequest`
的 action 恒为 `"fallthrough"`（`agent/turn_request_assembly.py:24-28` docstring）。

### 7. 主 WHILE 循环本体（:1748-1798）

```python
# agent/conversation_loop.py:1751-1753
    while _prelude_action != "break" and (
        (s.api_call_count < agent.max_iterations and agent.iteration_budget.remaining > 0) or agent._budget_grace_call
    ):
```

循环条件两半：`api_call_count < max_iterations`（上限默认 `sys.maxsize` 即不限，
`run_agent.py:241`）+ `iteration_budget.remaining > 0`（线程安全预算，父子 Agent 共享
同一实例，`agent/iteration_budget.py:25`）；`or agent._budget_grace_call` 是**宽限调用**——
预算耗尽后允许模型多调一次产出体面总结，flag 在 `begin_iteration` 里被消费
（`agent/turn_iteration_prep.py:408-416`），用完即清，循环随即退出。

循环体最后是"分流到工具轮还是文本收尾"：

```python
# agent/conversation_loop.py:1781-1798
        try:
            _ri = _run_phase(normalize_model_response, agent, s)
            if _ri.action == "return":
                return _ri.result
            if _ri.action == "continue":
                continue
            _v = _run_phase(
                run_tool_round if s.assistant_message.tool_calls else finish_text_response, agent, s
            )
            if _v.action == "return":
                return _v.result
            if _v.action == "break":
                break
            if _v.action == "continue":
                continue
        except Exception as e:
            if _run_phase(handle_outer_loop_error, agent, s, e=e).action == "break":
                break
```

`_run_phase` 的第一个参数是**条件选出的函数**：有 `tool_calls` 进工具轮，否则文本收尾；
两个阶段的 verdict 接口一致，主循环不关心里面是哪种。最外层 `except` 兜住漏出的异常交给
`handle_outer_loop_error`（`agent/turn_loop_errors.py:35`）：区分"解释器关闭"（立即放弃）、
"确定性本地 bug"（traceback 只有本地模块、无 API 模块，不值得重试，
`agent/conversation_loop.py:229-235`），以及**每 turn 最多 8 次外层异常**
（`_MAX_OUTER_LOOP_ERRORS = 8`，:239——只有逃出内层重试机制的异常才计数，8 次够用）。

### 8. _run_api_retry_loop：内层重试循环（:1577）

```python
# agent/conversation_loop.py:1577-1606
def _run_api_retry_loop(agent, s: _LoopState) -> Optional[dict[str, Any]]:
    """One API call with its retry/recovery loop (guard → build → call → check, error handlers).

    Returns a turn result dict when a phase ends the turn, else None once the loop is left
    (success, a restart armed on ``s._retry``, interrupt, or retries exhausted)."""
    while s.retry_count < s.max_retries:
        _ng = _run_phase(nous_rate_limit_guard, agent, s)
        if _ng.action == "return":
            return _ng.result
        if _ng.action == "break":
            return None
        try:
            _run_phase(build_api_request, agent, s)
            if _run_phase(perform_api_call, agent, s).action == "break":
                return None
            _rc = _run_phase(check_api_response, agent, s)
            if _rc.action == "return":
                return _rc.result
            if _rc.action == "break":
                return None
        except InterruptedError:
            if _run_phase(handle_api_interrupt, agent, s).action == "break":
                return None
        except Exception as api_error:
            _ae = _run_phase(handle_api_error, agent, s, api_error=api_error)
            if _ae.action == "return":
                return _ae.result
            if _ae.action == "break":
                return None
    return None
```

这是"一次成功的模型调用"的完整生命周期：**限流守卫 → 请求构建 → 真调用 → 响应校验**
加两个异常分支。内层怎么"重试"？关键在 `handle_api_error` 的**就地修复**语义：它跑一轮
一次性恢复链（OAuth 刷新、thinking 签名重试、429 退避、凭据轮换、激活 fallback 链……），
守卫记录在 `TurnRetryState`（`agent/turn_retry_state.py:9`，每守卫只触发一次），
`restart_with_*` 信号让外层重建再试；修复成功则 `retry_count` 不涨重跑
`build → call → check`，手段用尽时 `settle_unrecovered_error`
（`agent/turn_api_error.py:266`）给终局。

`perform_api_call`（`agent/turn_api_call.py:154-163`）处理一个精妙的并发场景：

```python
# agent/turn_api_call.py:154-162（节选）
    if _redirect_crossed_response:
        # Response and redirect can cross threads: discard the now-stale
        # response and rebuild from the correction rather than lose it.
        thinking_spinner = stop_thinking_spinner(agent, thinking_spinner)
        if agent.clear_interrupt(preserve_redirect=True):
            _retry.restart_with_redirected_messages = True
        else:
            interrupted = True
        return _verdict("break")
```

用户在模型响应返回的**同一瞬间**发起重定向：响应与重定向跨线程竞争。代码选择丢弃过时
响应、从用户纠正出发重建——宁可重算，不丢用户输入。

### 9. 循环之后：finalize 与压缩超时特判（:1800-1805）

```python
# agent/conversation_loop.py:1800-1805
    result = _finalize_from_state(agent, s)
    if s._compression_timeout_exhausted:
        # Reuse the gateway's context-recovery contract: transcript stays intact while
        # future input can move to a clean session (#98722).
        result.update(error=_COMPRESSION_TIMEOUT_FINAL_RESPONSE, partial=True, compression_exhausted=True)
    return result
```

`_finalize_from_state`（:1609-1614）把 state 字段按 `finalize_turn` 形参名一把喂进去
（又是按名传参模式）。若压缩耗尽主机超时（#98722），复用网关的上下文恢复契约：
transcript 原样保留、结果标 `compression_exhausted`，让用户知道该开新会话或修
auxiliary.compression 配置，而不是对着永远发不出去的请求干瞪眼。

---

## 核心类/函数

| 符号 | 职责 | 位置 |
|---|---|---|
| `run_conversation` | turn 外层信封：导出边界、关闭失败 turn | `agent/conversation_loop.py:1808` |
| `_run_conversation_turn` | 真正的循环体：赛前准备 → 主 WHILE → finalize | `agent/conversation_loop.py:1646` |
| `_LoopState` | 循环全部贯穿局部变量（新增阶段 IO = 加一个字段） | `agent/conversation_loop.py:1460` |
| `_run_phase` | 按参数名取值调用阶段函数、verdict 字段按名回拷 | `agent/conversation_loop.py:1556` |
| `_run_api_retry_loop` | 内层重试循环：guard→build→call→check+异常处理 | `agent/conversation_loop.py:1577` |
| `_finalize_from_state` | 把 state 喂给 finalize_turn（按形参名） | `agent/conversation_loop.py:1609` |
| `_turn_without_loop` | pre_llm_call 否决 / codex_app_server 的旁路出口 | `agent/conversation_loop.py:1617` |
| `_apply_active_turn_redirect` | 重定向：追加 role 安全的检查点+用户纠正行 | `agent/conversation_loop.py:324` |
| `_close_durable_failed_turn` | 失败 turn 收口（补 assistant 边界行） | `agent/conversation_loop.py:1914` |
| `_maybe_inject_run_budget_wrapup` | 运行预算过 80% 注入一次性收尾通知（缓存安全） | `agent/conversation_loop.py:126` |
| `_join_truncated_parts` / `_continuation_overlap_length` | length 续写片段去重拼接（KMP 重叠） | `agent/conversation_loop.py:296/268` |
| `_LATCHED_VERDICT_FIELDS` | 闩锁字段表：只置 True 不被清零 | `agent/conversation_loop.py:1553` |
| `_MAX_OUTER_LOOP_ERRORS` | 每 turn 外层异常上限（=8） | `agent/conversation_loop.py:239` |

## 本组文件清单

| 文件 | 一句话角色 |
|---|---|
| `agent/conversation_loop.py` | turn 主循环心脏：外层信封 + 主 WHILE + 内层重试循环 + `_LoopState`/`_run_phase` 机制 |

## 与其他模块的关系

```
AIAgent.run_conversation（turn_facade.py:22，先取租约）
        │ 转发
        ▼
conversation_loop.run_conversation ──import 时绑定──► 33 个 turn_*.py 阶段助手
        │                                              ├─ turn_context.py        赛前准备
        │                                              ├─ turn_request_assembly  请求组装
        │                                              ├─ turn_api_call          真正的调用
        │                                              ├─ turn_api_error         错误恢复
        │                                              ├─ turn_tool_round        工具轮
        │                                              ├─ turn_final_response    文本收尾
        │                                              └─ turn_finalizer         收尾
        └─ 工具轮内部 → AIAgent._execute_tool_calls（run_agent.py:1308）
                        → tool_dispatch_helpers 分段 → tool_executor 执行
```

`turn_*.py` 不在模块级 import conversation_loop（防循环），需要的循环常量在函数体内
延迟 import——同时让 `patch("agent.conversation_loop.X")` 的测试桩继续生效
（根 AGENTS.md："Patch where production reads"）。上层入口见 turn_facade.md；
工具执行细节见 turn_pipeline.md。

## 总结

- **一个 turn = 一次 `run_conversation`**：外层信封（边界导出、失败收口）套着
  `_run_conversation_turn` 的主 WHILE 循环。
- **每个阶段都是 `agent/turn_*.py` 的独立文件**，由 `_run_phase` 按参数名从 `_LoopState`
  取值调用、verdict 字段按名回拷——新增阶段输入输出只需加一个字段。
- **verdict action 全项目统一**：`fallthrough`/`return`/`break`/`continue`；
  闩锁字段只置 True 不清零。
- **内层 `_run_api_retry_loop`** = 一次模型调用 + 重试恢复的完整生命周期；错误处理走
  就地修复链（`TurnRetryState` 一次性守卫），重定向与响应的线程竞争以
  "宁可重算不丢用户输入"裁决。
- **预算三保险**：`api_call_count` 上限（默认 `sys.maxsize`）、线程安全的
  `IterationBudget`、`_budget_grace_call` 一次宽限；再加每 turn 8 次外层异常上限和
  `restart_count` 防退款失控兜底。
- **同步、可打断**：整条链路没有 async；HTTP 在 worker 线程上进行，用户随时可 interrupt。
