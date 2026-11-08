# turn_pipeline.md — 33 个 turn_*.py 分阶段走读

## 文件概览

`conversation_loop.py` 只负责"把阶段串起来"，每个阶段的真正逻辑都住在 `agent/turn_*.py`
的独立文件里（agent/AGENTS.md：*Each phase of an iteration is its own sibling*——改一处
溢出处理只动一个 ~600 行的文件）。`agent/` 下共有 **33 个** `turn_*.py`，本文按 turn
生命周期分五幕走读：

```
① 上下文构建（一次/turn）      turn_context / turn_context_compaction / turn_preflight / turn_preflight_gate / turn_scripted_prelude
② 迭代准备与请求组装（一次/迭代） turn_iteration_prep / turn_request_assembly / turn_api_request
③ API 调用与错误（一次/尝试）    turn_api_call / turn_api_error / turn_response_check / turn_response_intake / turn_retry_state
④ 恢复分支（出错时）            turn_recovery / turn_overflow / turn_truncation / turn_empty_response / turn_recovery_autorecover / turn_recovery_codex
⑤ 工具轮与收尾（回答成型时）     turn_tool_round / turn_tool_validation / turn_final_response / turn_stop_gates / turn_finalizer / turn_usage / turn_summary / turn_liveness / turn_loop_errors / turn_explainers / turn_failure_copy / turn_author
（准入门面，另有专文）           turn_facade / turn_facade_lease → 见 turn_facade.md
```

所有阶段函数遵循同一协议：接收 `_LoopState` 的同名字段、返回带 `action` 的 verdict
（fallthrough / return / break / continue），由 `_run_phase` 按名传参回拷。

---

## 关键代码走读

### 第一幕：turn 上下文构建（每 turn 一次）

**build_turn_context —— 一次性的赛前准备（turn_context.py:1189）**

```python
# agent/turn_context.py:1189-1206（节选）
def build_turn_context(agent, user_message, system_message, conversation_history,
                       task_id, stream_callback, persist_user_message, ...) -> TurnContext:
    """Run the once-per-turn setup and return the loop's input context.

    Helpers are passed in to avoid an import cycle with ``agent.conversation_loop``.
    Order matters: the DB session row is created only AFTER the system prompt is built
    (else it persists system_prompt=NULL and costs a cache miss) and BEFORE preflight
    compression."""
```

docstring 末尾的 "Order matters" 是这一幕的灵魂：**会话行必须在系统提示词之后、preflight
压缩之前创建**——先建行会落一条 `system_prompt=NULL` 的记录，下次恢复触发警告外加一次
前缀缓存 miss（#45499）。内部按序做：安全 stdio → turn_author 解析 → 旋转会话恢复 →
绑定 task/turn id → 复制历史 → 追加用户消息并记 `current_turn_user_idx` → 恢复/构建系统
提示词 → 建会话行 → `run_turn_start_compaction` → 插件 `pre_llm_call` → 内存预取 → 盖
`api_content` sidecar 章 → `_persist_turn_start`（第一次 LLM 调用前就持久化用户消息）。
成品 `TurnContext`（:546-561）的字段即循环要读的输入：`messages`、`active_system_prompt`、
`current_turn_user_idx`、`plugin_block_message`（否决：turn 以此结束、不做推理）等。

**三遍 turn 起始压缩（turn_context_compaction.py:129）**：`run_turn_start_compaction`
（docstring："Idle compaction, then preflight compression (or the uncompressed guard)"）先跑
`_idle_compaction` 再跑 `_preflight_compression`，产出 `CompactionOutcome`（重建后的
messages/系统提示词/历史/user 下标 + `compressed`/`blocked` 旗标）。第一遍 **idle**（:144）：
opt-in——距上次活动超过 `idle_compact_after_seconds` 才估算 token，够闲且超 floor 才压。
第二遍 **preflight**（:230）：超阈值时最多跑 `max_compression_attempts`（默认 3）个 pass
（`_run_preflight_passes`，:352），"行数和 token 都没动"或"进度不足"就 `blocked=True` 收手
防抖动；引擎接管时只跑一次维护 pass（:436）。第三遍：压缩被禁用时
`_rearm_uncompressed_overflow_warn`（:479）重新武装溢出告警。细节（#98722）：压缩耗尽
主机感知的进度超时——这个 preflight 迭代根本没碰 provider，要**退还** `api_call_count`
和预算（`_refund_api_call`，:103）并终止 turn。

**run_preflight_gate —— 发请求前的压力门（turn_preflight_gate.py:20）**：它比较**完全组装
后的请求**（含 api_content/插件注入/prefill/MoA 上下文），不是裸 `messages`（:72-79 注释）；
"上次压缩没取得足够进度"就置 `_preflight_compression_blocked=True` 封锁本轮主动压缩
（provider 报错后的被动通道保留）。同时处理 Ollama 运行时窗口过小的终局（:46-58，退还计数
并 break）。**turn_preflight.py** 提供两个压缩时机：`run_preflight_compression`（:57，上面
那道门的实现体）与 `compress_after_tool_results`（:245，工具结果回填后的第二次时机）。

**turn_scripted_prelude.py —— 剧本式工具前奏（play_prelude:57）**：桌面向导要在第一次模型
调用**之前**自己演几个工具步骤？`Prelude` 是调用方持有的生成器，每步 yield
`(assistant 文本, 工具名, 参数)`，走完全一样的 `run_tool_round`（先持久化再执行、照发事件），
工具结果 send 回生成器供后续步骤使用；`play_prelude` 返回 `("return", result)` /
`("break", None)` / `("run", None)` 三种裁决。角色序列保持
`user → assistant(tool_calls) → tool → ... → assistant(模型)`，不计 API 调用、不发
pre/post_api_request 钩子——缓存不变量完好。

### 第二幕：迭代准备与请求组装（每迭代一次）

**begin_iteration —— 迭代入口（turn_iteration_prep.py:352）**：docstring 概括顺序——
"apply a pending redirect, reset the checkpoint dedup, then the interrupt / review-budget /
iteration-budget exits；`api_call_count` 在这里自增（宽限调用消费 flag 而非预算）"。
`prepare_iteration`（:144）做提示词刷新 epoch 检查；`announce_api_call`（:307）负责转圈
动画与请求日志。宽限调用（`_budget_grace_call`，:408-416）：预算耗尽后允许模型多调一次
产出体面总结，flag 用完即清。

**assemble_api_request —— 装饰副本 + cache plan 最后构建（turn_request_assembly.py:106）**

```python
# agent/turn_request_assembly.py:106-113 + 189-231（节选）
def assemble_api_request(agent, *, messages, current_turn_user_idx, _ext_prefetch_cache, ...) -> AssembledRequest:
    """Assemble the request in the original order. ORDER IS LOAD-BEARING: cache breakpoints
    are injected only after whitespace normalization, the orphan sweep, thinking-only drop /
    user merge and surrogate stripping, so the same row's bytes never vary across turns."""
    ...
    api_messages, effective_system = build_api_messages(          # turn_context.py:1418
        agent, messages, current_turn_user_idx=current_turn_user_idx, ...)
    ...
    # Normalize whitespace and tool-call JSON for bit-perfect prefixes across turns
    # (KV-cache reuse on local servers, better cloud cache hits); API copy only.
    for am in api_messages:
        if isinstance(am.get("content"), str):
            am["content"] = am["content"].strip()
    _canonicalize_api_tool_calls(api_messages)
    ...
    # Build the request-local cache sections LAST, after every transcript mutation.
    if agent._use_prompt_caching and agent.provider != "moa":
        _initial_cache_plan = build_prompt_cache_plan(...)
        api_messages = _initial_cache_plan.messages
        tools_for_api = _initial_cache_plan.tools
```

三个核心概念：

1. **装饰副本**：`build_api_messages`（turn_context.py:1418-1531）对 messages 逐条结构化
   克隆（嵌套容器绝不共享）；历史行重放"当初发送的精确字节"（`api_content` sidecar）。
   `messages` 本体除了 sidecar 章绝不被触碰。
2. **bit-perfect 缓存前缀**：空白归一化、孤儿工具结果清扫、thinking-only 丢弃、相邻 user
   合并、代理剥离——全在**打缓存断点之前**。顺序错了，同一行的字节在不同 turn 间漂移，
   缓存永远 miss。
3. **cache plan 最后构建**：`build_prompt_cache_plan` 在所有转录变异完成后才执行，
   只装饰请求副本，canonical 工具注册表原样。

`AssembledRequest`（:24-37）action 恒为 `"fallthrough"`，字段是迭代要用的
`api_messages`/`tools_for_api`/`approx_tokens`/`request_pressure_tokens` 等。压力估算三级：
锚定值（provider 真实 usage+delta）> 原生 Responses 剪枝估算 > 粗估 + 实际值托底
（`_pressure_with_real_floor`）。

**build_api_request —— 每次尝试的请求（turn_api_request.py:177）**：docstring 点题——
"every mutation happens BEFORE middleware/hooks/debug dumps observe the payload"。与每迭代
一次的 `assemble_api_request` 不同，它在**内层重试循环里每次尝试都跑**：重新施加 reasoning
echo pad、为**当前 provider**（fallback 后可能不同）重打缓存装饰、调 `build_api_kwargs`
（chat_completion_helpers.py:1503）按 api_mode 分支构造 kwargs、代理/ASCII 检查点、
OpenRouter 缓存绕过、provider 请求头、中间件与 `pre_api_request` 钩子。

### 第三幕：API 调用与错误（每尝试一次）

**perform_api_call —— 真正的模型调用（turn_api_call.py:72）**

```python
# agent/turn_api_call.py:91-115（节选）
        if _use_streaming:
            return agent._interruptible_streaming_api_call(next_api_kwargs, on_first_delta=_stop_spinner)
        from agent import relay_llm
        return relay_llm.execute(next_api_kwargs, agent._interruptible_api_call, ...)
```

两个落地实现在 `agent/chat_completion_helpers.py`（4,001 行）：
`interruptible_streaming_api_call`（:3977，流式逐 delta 回调）和 `interruptible_api_call`
（:1260，**worker 线程**上跑，让主循环随时检测中断；每个 worker 独立 per-request client，
中断只关那一条连接）。wire 适配在 `agent/transports/`：`chat_completions.py`（默认）、
`anthropic.py`、`bedrock.py`、`codex.py`（Responses）、`codex_app_server.py`（子进程运行时）。
调用被 `run_llm_execution_middleware` 包裹并在重定向锁保护的 `_model_request_active` 括号下
执行；响应返回后检查"重定向是否跨过了响应"（线程竞争 → 丢弃过时响应从纠正重建）。

**nous_rate_limit_guard**（turn_api_call.py:232）：provider 是 nous 时先看剩余限额——另一
会话已撞限（含 SDK 重试，每次都计 RPH）就跳过本次调用；有 fallback 就武装重启（break），
没有就把缓冲的限流文案作为失败结果返回。整个守卫包在 try/except 里——**守卫自己永远不许
弄断 agent 循环**。**handle_api_error**（turn_api_error.py:52）：内层 `except Exception`
的落点——解释器关闭检测（立即放弃）→ `classify_api_error` 分类（429/401/413/overflow/
content policy/billing…）→ 按类路由到恢复分支（第四幕）→ 不可重试的客户端错误终局 →
重试耗尽时 `settle_unrecovered_error`（:266）走"主传输恢复 → fallback 链 → 终局结果"。

**check_api_response —— 响应校验（turn_response_check.py:92）**：顺序是——形状验证
（`validate_response_shape`，turn_recovery.py:1585；无效→重试/急切 fallback/终局）→ 推导
finish_reason → `content_filter`（HTTP-200 的内容政策拒绝是确定性的：试一次 fallback，否则
返回拒绝文案）→ `length`（进截断恢复）→ usage 折算（`record_response_usage`）。
**normalize_model_response —— 响应整流（turn_response_intake.py:165）**：把原始响应整流成
`assistant_message`（content 恒为 str）、拼接 agent-as-provider 投影、发 `post_api_request`
钩子、思考内容转发进度回调；两个续写守卫：未闭合的 `<REASONING_SCRATCHPAD>`（重试 2 次）
与 Codex `incomplete`（必要时激活 fallback 并同步系统提示词上的身份）。

**TurnRetryState —— 单次尝试的守卫账本（turn_retry_state.py:9-15）**：dataclass docstring
点题——"One-shot recovery guards + restart signals for a single API-call attempt. A fresh
instance is created per ``api_call_count`` iteration; each guard fires at most once, and
``restart_with_*`` signals tell the loop to rebuild and retry."。三十多个一次性布尔守卫
（OAuth 刷新 × 各 provider、thinking 签名、图片收缩、429、402 下调、auth failover……）
加四个重启信号（compressed / length_continuation / rebuilt / redirected）。每次迭代在主循环
新建一个（conversation_loop.py:1768）——每守卫最多触发一次，天然防死循环。

### 第四幕：恢复分支（出错时才进）

| 文件 | 场景 | 手段 |
|---|---|---|
| `turn_recovery.py`（1,999 行） | 模型调用抛异常后、通用重试/退避之前 | 一串"就地修复"处理器：OAuth/凭据刷新、thinking 签名、加密内容剥离、图片收缩、语法重试……返回 True 表示修好，`retry_count` 不涨直接重试 |
| `turn_overflow.py`（506 行） | 413 payload-too-large / context-length | 压缩并武装重启 / 软推迟（压缩锁被占）/ 类型化终局；provider 证实过的溢出压过粗估校准 |
| `turn_truncation.py`（801 行） | `finish_reason == "length"` | 续写 nudge 最多 4 次（`_join_truncated_parts` 用 KMP 重叠检测去重拼接片段）；截断工具调用→max_tokens 提升重试；最终回滚 |
| `turn_empty_response.py`（315 行） | 无可见文本（think-only/空） | **阶梯序即一切**：partial-stream 恢复 → 复用上轮内容（仅家务工具）→ 一次 post-tool nudge → thinking-only prefill 续写 ×2 → 预算内空响应重试（确定性空短路）→ fallback → 终局 `(empty)` 哨兵 |
| `turn_recovery_autorecover.py`（116 行） | 重试耗尽 + fallback 无路，但 provider 只是暂时不在（5xx/529/超时） | 有界等待-重试阶梯（#85426）：默认 5 轮、抖动 15/30/60/60/60s、provider 的 Retry-After 最多 120s；不可重试类（auth/格式/内容政策/计费）绝不进入 |
| `turn_recovery_codex.py`（76 行） | Codex Responses 专属 | 陈旧加密推理剥离、replay 判决重置 |

`apply_retry_restarts`（turn_iteration_prep.py:437）在内层循环结束后按优先级消费重启信号：
重定向/压缩重建/fallback 重建/length 续写；产生"无效迭代"的路径**退还**预算
（退款重启由 `restart_count` 兜底）。

### 第五幕：工具轮与收尾

**run_tool_round —— persist-before-execute 持久化不变量（turn_tool_round.py:49）**

```python
# agent/turn_tool_round.py:49-59 + 130-153（节选）
def run_tool_round(agent, *, assistant_message, finish_reason, messages, ...) -> ToolRoundVerdict:
    """Execute one tool round in the exact original order. Persist-before-execute is a
    durability invariant: resume must see the executed block if a destructive tool restarts
    Hermes; a failed canonical append ends the turn rather than running tools from
    process-only state."""
    _tvv = validate_tool_calls(agent, assistant_message, finish_reason, ...)   # ① 验证
    ...
    assistant_message.tool_calls = expand_local_tool_batches(...)              # ② 批展开+去重封顶
    ...
    append_message(messages, stage_tool_call_message(agent, ...)[0])           # ③ 暂存 assistant 行
    # Persist the tool-call turn before any tool side effects so resume sees the executed
    # block if a destructive tool restarts Hermes.                              # ④ 先持久化！
    try:
        _tool_turn_persisted = agent._flush_messages_to_session_db(messages, conversation_history)
    except Exception as exc:
        _tool_turn_persisted = False
    if _tool_turn_persisted is False:
        _turn_exit_reason = "session_persistence_failed"                       # ⑤ 失败 = 终止 turn
        failed = True
        return _verdict("break")
    ...
    agent._execute_tool_calls(assistant_message, messages, effective_task_id, api_call_count)  # ⑥ 执行
    if getattr(agent, "_incremental_persistence_failed", False):               # ⑦ 结果持久化失败同终止
        return _verdict("break")
    _ptc = compress_after_tool_results(...)                                    # ⑧ 工具后再压缩
    return _verdict("continue")                                                # ⑨ 循环继续
```

完整流程：**验证 → 展开/去重/封顶 → 暂存 assistant 行 → 先持久化再执行 → 执行 → 结果行
回填 → 工具后压缩 → 循环继续**。"先持久化再执行"是不容谈判的不变量：破坏性工具若把进程
干掉，恢复进程必须能在 SessionDB 里看到"已被执行"的工具块；canonical append 失败就终止
turn，绝不从纯内存状态执行工具。

执行入口 `AIAgent._execute_tool_calls`（run_agent.py:1308-1342）用**分段规划器**
`_plan_tool_batch_segments`（tool_dispatch_helpers.py:212）把一批调用切成有序的
`("parallel"|"sequential", calls)` 段——只读、路径不冲突、显式并行安全的调用并行跑
（worker 上限 `_MAX_TOOL_WORKERS = 8`），任何 barrier 强制开新段，顺序与副作用边界不变：

```python
# run_agent.py:1318-1331（节选）
            if len(tool_calls) <= 1:
                self._execute_tool_calls_sequential(*args)
            else:
                segments = _plan_tool_batch_segments(tool_calls, execution_cwd=exec_cwd)
                if len(segments) == 1:
                    run = self._execute_tool_calls_concurrent if segments[0][0] == "parallel" \
                          else self._execute_tool_calls_sequential
                    run(*args)
                else:
                    execute_tool_calls_segmented(self, *args, segments=segments)
```

agent 级工具（`todo`/`memory`…）经 `agent/inline_tool_executors.py` 的注册表拦截
（tool_executor.py:1681-1685），最后才落 `model_tools.handle_function_call`。

**finish_text_response —— 文本收尾（turn_final_response.py:106）**：docstring 点题——"每条
续写路径把 `final_response` 置 None，确认语永不压制迭代上限总结；最终消息只在停止门接受
后才追加并落盘"。守卫顺序：① reasoning-only 提升前置——可信路由上"干净的 stop 但 content
为空"且推理字段有货，把答案**提升为最终回答**（正文行保持空、文本走 api_content sidecar，
链式思考混进 content 会在历史界面上伪装成真回答，#111761）；② 空/think-only → 空响应
阶梯；③ 哑标记替换；④ 意图确认续写/停滞守卫（回复以"让我接着…"结尾却停了，最多 nudge
2 次）；⑤ length 续写拼接、掉工具调用重催、脚手架行弹出；⑥ **四道停止门**
（apply_stop_gates，turn_stop_gates.py:134：迟到 LSP 判决 / verify-on-stop / pre_verify 插件
钩子 / kanban 终端工具守卫——任何一道都可"暂存答案为兜底
（`_pending_verification_response`）+ 追加 user nudge + 继续 turn"）；⑦ 全过才追加最终
assistant 行并落盘。

**finalize_turn —— 循环后的收尾总管（turn_finalizer.py:619）**

```python
# agent/turn_finalizer.py:619-638 + 717-736（节选）
def finalize_turn(agent, *, final_response, api_call_count, interrupted, failed, messages,
                  conversation_history, effective_task_id, turn_id, user_message,
                  original_user_message, _should_review_memory, _turn_exit_reason,
                  _pending_verification_response=None, ...):
    """Run the post-loop finalization and return the turn ``result`` dict."""
    final_response, _turn_exit_reason, preserved_verification_fallback, interrupted = \
        _resolve_budget_fallback(...)
    ...
    def _persist_step():
        nonlocal final_response
        _drop_transcript_scaffolding(agent, messages)              # 弹掉重试脚手架
        final_response, _recovered_from_stream = _recover_final_from_stream(...)  # 流式恢复
        if final_response and not interrupted:
            final_response, _, _ = apply_llm_output_transform(...) # 输出变换
        _close_transcript_tail(agent, messages, final_response, interrupted, _recovered_from_stream)
        if not interrupted and not failed and not vetoed:
            _micro_compact_after_turn(agent, messages, final_response, logger, effective_task_id)
        agent._persist_session(messages, conversation_history)     # 终持久化
    _guarded_cleanup("persist_session", _persist_step, _cleanup_errors, logger)
```

收尾清单（按序）：预算兜底回答 → "静默停止"修复（#55316/#54756：turn 结束在裸 tool 行、
无文字——铸造退出原因并合成可见收尾，UI 不再无休止转圈）→ 退出原因→失败判定映射
（`exit_reason_failure`）→ 一系列 `_guarded_cleanup`（轨迹保存、资源清理、终持久化——
每步独立守护，任何一步失败都丢不掉用户的回答，#8049）→ 文件变更 footer/异常退出解释 →
输出钩子 → 上下文引擎 `on_turn_complete` → 代理总检查点 → 结果组装 → steer 排空 →
后台 memory/skill review fork（在投递**之后**跑）。`settle_held_final`（:567）落地
`hold_stream` 变换插件扣住的最终回答。

**周边支撑**：**turn_usage.py**（`record_response_usage:73`）每成功响应后把 usage 折算进
压缩机、usage 锚点、会话 token/成本计数器、state.db token-delta 队列、观测日志；
**turn_summary.py** 的 `TurnSummaryCollector` 骑 `tool_progress_callback` 事件流统计本 turn
做了什么，渲染 `⋯ 12.4s · edited 2 files +18 -3 · ran 3 commands` 汇总行（纯展示）；
**turn_liveness.py** 是 turn 停滞看门狗——中止决策绑定观察到的 `(generation, timestamp)`，
提交回调在 `_touch_activity` 同一把锁下复核，复活过的 turn 绝不被误杀；
**turn_loop_errors.py**（`handle_outer_loop_error:35`）做外层异常分类（解释器关闭/确定性
本地 bug vs API 路径失败）、未回答的 tool_call 补错误结果、每 turn 8 次上限；
**turn_explainers.py** 提供文件变更验证 footer + turn 完成解释；**turn_failure_copy.py** 是
终局失败的用户文案表（每个终局必须带 `failure_reason`/`failure_retryable`，UI 靠它出具体
错误卡）；**turn_author.py** 记录本 turn 的用户侧作者——调度器只在一次性子进程设
`HERMES_TURN_AUTHOR`，网关的缓存 agent 一生服务多个作者，**按 turn 读、绝不按 agent 缓存**。

---

## 核心类/函数

| 符号 | 职责 | 位置 |
|---|---|---|
| `build_turn_context` / `build_api_messages` | 一次/turn 赛前准备 / wire 副本与 api_content 重放 | `agent/turn_context.py:1189` / `:1418` |
| `run_turn_start_compaction` | turn 起始三遍压缩 | `agent/turn_context_compaction.py:129` |
| `play_prelude` | 剧本式工具前奏 | `agent/turn_scripted_prelude.py:57` |
| `begin_iteration` | 迭代入口（重定向/中断/预算，`api_call_count += 1`） | `agent/turn_iteration_prep.py:352` |
| `assemble_api_request` | 每迭代请求组装（装饰副本 + cache plan 最后） | `agent/turn_request_assembly.py:106` |
| `build_api_request` | 每尝试请求构建（变异先于中间件/钩子） | `agent/turn_api_request.py:177` |
| `nous_rate_limit_guard` / `perform_api_call` | Nous 限流守卫 / 真正的模型调用 | `agent/turn_api_call.py:232` / `:72` |
| `handle_api_error` | 异常分类 → 恢复分支 → 终局 | `agent/turn_api_error.py:52` |
| `check_api_response` | 形状/content_filter/length/usage 校验 | `agent/turn_response_check.py:92` |
| `normalize_model_response` | 响应整流 + post 钩子 + 续写守卫 | `agent/turn_response_intake.py:165` |
| `TurnRetryState` | 单次尝试的一次性守卫账本 + 重启信号 | `agent/turn_retry_state.py:9` |
| `run_tool_round` | 一轮工具调用（persist-before-execute 所在） | `agent/turn_tool_round.py:49` |
| `_execute_tool_calls` / `_plan_tool_batch_segments` | 分段执行入口 / 工具批切有序段 | `run_agent.py:1308` / `agent/tool_dispatch_helpers.py:212` |
| `finish_text_response` / `apply_stop_gates` | 文本收尾守卫链 / 四道停止门 | `agent/turn_final_response.py:106` / `agent/turn_stop_gates.py:134` |
| `finalize_turn` | 循环后收尾总管 | `agent/turn_finalizer.py:619` |
| `record_response_usage` / `handle_outer_loop_error` | usage 折算 / 外层异常分类+上限 | `agent/turn_usage.py:73` / `agent/turn_loop_errors.py:35` |

## 本组文件清单（33 个 turn_*.py 全列）

| 文件 | 一句话角色 |
|---|---|
| `agent/turn_context.py` | turn 前奏：`TurnContext`/`build_turn_context`/`build_api_messages` 与 api_content sidecar |
| `agent/turn_context_compaction.py` | turn 起始三遍压缩（idle/preflight/溢出告警 re-arm），`CompactionOutcome` |
| `agent/turn_preflight.py` | preflight 压缩门实现 + 工具结果后的第二次压缩时机 |
| `agent/turn_preflight_gate.py` | 发请求前的压力门：不足进度封锁、Ollama 窗口终局 |
| `agent/turn_scripted_prelude.py` | 剧本式工具前奏（首调前演工具步骤） |
| `agent/turn_iteration_prep.py` | 迭代入口/准备/播报 + 重启信号消费 |
| `agent/turn_request_assembly.py` | 每迭代请求组装：装饰副本、字节归一、cache plan 最后构建 |
| `agent/turn_api_request.py` | 每尝试请求构建：重打缓存装饰、中间件、pre_api_request 钩子 |
| `agent/turn_api_call.py` | 真正的模型调用 + Nous 限流守卫 + 中断处理 |
| `agent/turn_api_error.py` | 异常分类与恢复总入口（`handle_api_error`/`settle_unrecovered_error`） |
| `agent/turn_response_check.py` | 响应校验：形状/content_filter/length/usage 折算 |
| `agent/turn_response_intake.py` | 响应整流：`normalize_model_response` + 续写守卫 |
| `agent/turn_retry_state.py` | 单次尝试的一次性守卫账本 `TurnRetryState` |
| `agent/turn_recovery.py` | 1,999 行的就地修复链（OAuth/签名/图片/语法……） |
| `agent/turn_overflow.py` | 413/上下文溢出恢复（压缩重启/软推迟/终局） |
| `agent/turn_truncation.py` | `finish_reason=="length"` 续写与截断工具调用重试 |
| `agent/turn_empty_response.py` | 空/思考-only 响应的有序恢复阶梯 |
| `agent/turn_recovery_autorecover.py` | 重试耗尽后的有界等待-重试阶梯（#85426） |
| `agent/turn_recovery_codex.py` | Codex Responses 专属恢复档（加密推理剥离） |
| `agent/turn_tool_round.py` | 一轮工具调用：验证→先持久化再执行→回填→工具后压缩 |
| `agent/turn_tool_validation.py` | 工具名/JSON 参数验证与三振出局 |
| `agent/turn_final_response.py` | 纯文本收尾守卫链（`finish_text_response`） |
| `agent/turn_stop_gates.py` | 四道停止门：LSP/verify-on-stop/pre_verify/kanban |
| `agent/turn_finalizer.py` | 循环后收尾总管（`finalize_turn`/`settle_held_final`） |
| `agent/turn_usage.py` | 每响应 usage 折算（`record_response_usage`） |
| `agent/turn_summary.py` | CLI turn 汇总行（纯展示、无循环状态） |
| `agent/turn_liveness.py` | turn 停滞看门狗（采样状态机 + 复核提交） |
| `agent/turn_loop_errors.py` | 外层异常分类 + 每 turn 异常上限 |
| `agent/turn_explainers.py` | 文件变更验证 footer + turn 完成解释 |
| `agent/turn_failure_copy.py` | 终局失败的用户文案与 failure_reason 盖章 |
| `agent/turn_author.py` | 本 turn 的用户侧作者（按 turn 读、不缓存） |
| `agent/turn_facade.py` | `AIAgent.run_conversation` 准入门面 → 详见 turn_facade.md |
| `agent/turn_facade_lease.py` | 跨进程会话 turn 租约 → 详见 turn_facade.md |

## 与其他模块的关系

`conversation_loop._run_phase` 按名调用 33 个 `turn_*.py`；各阶段向外触达：
`prompt_caching.py`（cache plan 缓存断点标记）→ `chat_completion_helpers.py`（真正的 HTTP
调用）→ `agent/transports/`（wire 适配）→ `tool_executor` + `tool_dispatch_helpers`（工具
执行，`_MAX_TOOL_WORKERS=8`）→ `turn_finalizer`（落到 session_persistence /
context_compressor / background_review）。压缩算法层（`context_compressor.py` /
`conversation_compression.py`）在 compression 专文详述，本目录只调门面（`agent._compress_context`、
`should_compress`、`threshold_tokens`）。结果 dict 契约（`final_response`/`messages`/
`completed`/`failed`/`interrupted`/`failure_reason`）被 gateway/CLI/TUI/Desktop/ACP 全部
消费；UI 错误卡依赖 `turn_failure_copy` + `agent/error_surface.py`。系统提示词在
`build_turn_context` 里恢复/构建，之后整个循环视其为只读（见 system_prompt.md）。

## 总结

- **33 个 `turn_*.py` 就是 turn 生命周期的分解**：上下文构建（5）→ 迭代准备与请求组装（3）
  → API 调用与错误（5）→ 恢复分支（6）→ 工具轮与收尾（12）→ 准入门面（2）。
- **顺序即正确性**：提示词先建、会话行后建；先归一化再打缓存断点；cache plan 永远最后
  构建——顺序错一个，前缀缓存就碎一个。
- **三层请求概念**：`messages`（canonical，绝不改）→ `api_messages`（结构化克隆的装饰副本）
  → `api_kwargs`（每次尝试重建，中间件后的最终 payload）。
- **持久化不变量**：用户消息在第一次 LLM 调用前落库；工具调用在第一个副作用前落库；
  canonical append 失败 = 终止 turn。
- **恢复有界**：每守卫一次（`TurnRetryState`）、每 turn 8 次外层异常、自动恢复 5 轮抖动
  阶梯、重启退款由 `restart_count` 兜底——所有自动行为都有一条明示的天花板。
