# 一次对话的完整生命周期

> 本文把 [全局架构总览](big_picture.md) 的分层图"跑"一遍：从用户按下回车，到回复送达、状态落盘，每一步对应哪个文件。

## 第 0 步：会话从哪里来

无论哪个表面，会话的权威都在网关进程。经典 CLI 启动时：

1. `hermes_cli/main.py` 把普通 chat 路由到 `gateway_chat_startup.launch_gateway_chat`；
2. `hermes_cli/gateway_runtime_attach.py::attach_gateway` 找到（或按需启动）本 profile 的网关 owner，铸造**一次性会话票据**；
3. `hermes_cli/gateway_connection.py` 建立"每 CLI 进程一条网关连接"（daemon 线程拥有 asyncio loop，事件帧进线程安全队列）；
4. `hermes_cli/gateway_agent.py` 提供一个 AIAgent 兼容外壳 —— `run_conversation` 只是提交 `prompt.submit` RPC 然后回放事件流。

## 第 1 步：入站与接纳（网关侧）

```
平台/壳层事件
   │  适配器收包（plugins/platforms/<name>/adapter.py 或 gateway/platforms/ 内置）
   ▼
run_inbound.py::_handle_message            文本/媒体预处理、语音转写、插件注入
   ▼
authz_mixin.py + bot_loop_guard.py         授权、bot 回环预算
   ▼
session_ingress.py                         「可信消息接纳」边界
   ▼
session_authority.py::SessionAuthority     durable FIFO 排队（hermes_state_runtime.py 承接）
   ▼
run_turn.py::_handle_message_with_agent    装载/创建会话 agent（run_agent_cache.py）
   ▼
turn_lease.py                              每会话租约：串行化 load→run→flush（5s 等待后 fail-closed）
   ▼
turn_executor.py::_UnboundedThreadExecutor 每 turn 一个线程（复用线程先重置 contextvars）
```

## 第 2 步：agent 核心 —— turn 循环

线程内进入 [conversation_loop.py](../03_agent/conversation_loop.md)（1,967 行）。完整阶段序列：

```
AIAgent.run_conversation (agent/turn_facade.py)
  ├─ admit_durable_turn_lease        跨进程 turn 准入（turn_facade_lease.py）
  └─► conversation_loop.run_conversation
        └─ _run_conversation_turn:
        1. build_turn_context        (turn_context.py:1189)  恢复/构建系统提示词、
        │      │                                              持久化用户消息行、播种 _LoopState
        │      └─ run_turn_start_compaction  turn 起始压缩：空闲触发 → 预检阈值 → 溢出重整备
        2. begin_voice_turn_route    语音 turn 路由
        3. _turn_without_loop        pre_llm_call 钩子可否决；codex_app_server 运行时走支线
        4. play_prelude              预置工具调用（turn_scripted_prelude.py）
        5. WHILE 迭代预算未耗尽:
             a. begin_iteration / prepare_iteration      (turn_iteration_prep.py)
             b. assemble_api_request (turn_request_assembly.py:106)
             │      api_messages 装饰副本 + MoA 上下文 + 发送期净化
             │      → "为逐位一致的缓存前缀做规范化" → 缓存计划最后构建
             c. run_preflight_gate   (turn_preflight_gate.py) 压力门
             d. announce_api_call
             e. _run_api_retry_loop (conversation_loop.py:1577)  ← 内层重试
                  nous_rate_limit_guard → build_api_request (turn_api_request.py:177)
                  → perform_api_call (turn_api_call.py:72)   ←★ 真正的模型调用
                  → check_api_response (turn_response_check.py:92)
                  异常 → handle_api_error (turn_api_error.py:52) / handle_api_interrupt
             f. apply_retry_restarts → normalize_model_response (turn_response_intake.py:165)
             g. 有 tool_calls？
                  ├─ 是 → run_tool_round (turn_tool_round.py:49)
                  │        validate → 先持久化后执行（不变量）→ _execute_tool_calls
                  │        （段规划器：只读/不相交文件/MCP 可并行，_MAX_TOOL_WORKERS=8）
                  │        结果行回填 → 回到 5 继续迭代
                  └─ 否 → finish_text_response (turn_final_response.py:106) → 结束
             异常 → handle_outer_loop_error (turn_loop_errors.py:35)
        6. finalize_turn (turn_finalizer.py:619)  预算兜底、静默停止修复、结果字典
```

两个机制值得停留：
- **_LoopState + _run_phase**：每个阶段 helper 通过按参数名传递/回拷共享 `_LoopState` 数据类（`conversation_loop.py:1461`）。给阶段增加一个输入输出 = 加一个字段，没有别的接线。阶段裁决返回 `action ∈ {fallthrough, return, break, continue}`。
- **先持久化后执行**：工具轮先把 assistant 消息追加进规范转录，canonical append 失败则直接终止 turn —— 保证"模型说了要做 X"这件事在任何崩溃场景下都不会丢失。

## 第 3 步：流式回传

agent 的同步回调被 `gateway/stream_consumer.py::GatewayStreamConsumer` 桥接到异步平台投递：`on_delta()` 在 agent 工作线程上把增量入队，异步任务缓冲、限速、然后**逐步编辑同一条平台消息**（先发送，再反复 editMessageText）。typed 事件契约在 `gateway/stream_events.py`（`MessageChunk/MessageStop/Commentary/ToolCallChunk/...`）——"事件描述传输，从不描述上下文"。

## 第 4 步：投递与落盘

- 最终文本经 `_send_final_text` / `send_final_ledgered`（`gateway/platforms/base.py`）发出，投递义务记入 `delivery_ledger.py`，路由由 `delivery.py::DeliveryRouter` 决定（显式 `"telegram:123"` 目标、home channel、mirror 镜像）。
- 转录经 `SessionStore`（`gateway/session.py:787`，路由索引 + 转录重试队列）写入 SessionDB。
- 会话结束时记忆提取（`memory_manager.py::on_session_end`）在绑定所属 profile 作用域的前提下运行。

## 一次带工具的对话时间线（示例）

```
用户(Telegram): "帮我看下仓库最近的提交"
  t0  平台事件到达网关
  t1  FIFO 排队 → turn 租约获取
  t2  turn 1 迭代: 模型返回 tool_calls=[terminal("git log --oneline -5")]
  t3  run_tool_round: 校验 → 持久化 assistant 行 → 执行 terminal 工具
  t4  工具结果行回填 → turn 2 迭代: 模型返回纯文本总结
  t5  finish_text_response → finalize_turn
  t6  stream_consumer 已在 t2-t4 期间把增量"逐步编辑"进 Telegram 消息
  t7  最终文本投递 + 转录落盘 + 释放租约
```

## 下一步

- 想知道循环里最贵的资产（缓存前缀）是怎么保护的 → [提示词缓存不变量](caching_invariants.md)
- 想知道每一步的代码细节 → [03_agent/conversation_loop](../03_agent/conversation_loop.md) 与 [03_agent/turn_pipeline](../03_agent/turn_pipeline.md)
