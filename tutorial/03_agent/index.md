# 03_agent — Agent 核心模块总览

`agent/` 是 Hermes 的心脏：一条用户消息从进入 `AIAgent.run_conversation` 到变成最终回答，
经历租约准入 → turn 前奏 → 组装请求 → 调用模型 → 执行工具 → 收尾持久化的完整管线，
全部住在这个目录的约 200 个文件里。本篇是导航地图。

## 全景图

```
用户消息（CLI / Telegram / TUI / Desktop / cron / ACP …）
     │
     ▼
┌────────────────────────────────────────────────────────────────────┐
│ AIAgent.run_conversation —— 准入门面（agent/turn_facade.py:22）      │
│  ① 后台 review 让路  ② admit_durable_turn_lease 跨进程租约           │
│     （turn_facade_lease.py：TTL 300s、续租 60s、停滞看门狗）          │
│  ③ relay / portal / accounting 作用域  ④ lease.start()              │
└────────────────────────────────────────────────────────────────────┘
     │
     ▼
┌────────────────────────────────────────────────────────────────────┐
│ conversation_loop.run_conversation（agent/conversation_loop.py:1808）│
│  外层信封：结果盖章 {turn_id, current_turn_user_idx}、失败收口        │
│  ┌──────────────────────────────────────────────────────────────┐  │
│  │ _run_conversation_turn (:1646)                                │  │
│  │  ▸ build_turn_context  turn 前奏（系统提示词/用户行/三遍压缩）    │  │
│  │  ▸ play_prelude        剧本式工具前奏（可选）                    │  │
│  │  ╔═ WHILE api_call_count<max_iterations AND 预算>0 ══════════╗  │  │
│  │  ║  begin_iteration → prepare_iteration                      ║  │  │
│  │  ║  → assemble_api_request（装饰副本 + cache plan 最后）       ║  │  │
│  │  ║  → run_preflight_gate（压力门，必要时就地压缩）              ║  │  │
│  │  ║  → _run_api_retry_loop (:1577)                            ║  │  │
│  │  ║       nous_rate_limit_guard → build_api_request            ║  │  │
│  │  ║       → perform_api_call ←★ 真正的模型调用                 ║  │  │
│  │  ║            （流式 / worker 线程，经 agent/transports/）     ║  │  │
│  │  ║       → check_api_response                                ║  │  │
│  │  ║       except → handle_api_interrupt / handle_api_error    ║  │  │
│  │  ║  → apply_retry_restarts → normalize_model_response        ║  │  │
│  │  ║  → tool_calls? ──┬─ 是：run_tool_round（先持久化再执行）     ║  │  │
│  │  ║                  │        AIAgent._execute_tool_calls      ║  │  │
│  │  ║                  │        （分段规划，_MAX_TOOL_WORKERS=8）  ║  │  │
│  │  ║                  └─ 否：finish_text_response → return       ║  │  │
│  │  ╚═════════════════════════════════════════════════════════════╝  │  │
│  │  ▸ finalize_turn（turn_finalizer.py:619）收尾总管                  │  │
│  └──────────────────────────────────────────────────────────────────┘  │
└────────────────────────────────────────────────────────────────────┘
     │
     ▼
结果 dict {final_response, messages, completed, failure_reason, …}
     └──► 调用方交付（网关投递 / CLI 打印 / TUI 渲染 / Desktop 卡片）
```

## 文档导航

| 文档 | 主题 | 内容 |
|---|---|---|
| [conversation_loop.md](conversation_loop.md) | 主循环心脏 | `run_conversation`/`_run_conversation_turn`、`_LoopState` 数据类、`_run_phase` 按名传参/回拷、verdict 四 action、`_run_api_retry_loop` 内层重试循环 |
| [turn_pipeline.md](turn_pipeline.md) | 33 个 turn_\*.py 分阶段走读 | 五幕：上下文构建 → 请求组装 → API 调用与错误 → 恢复分支 → 工具轮与收尾；每文件一行清单 |
| [turn_facade.md](turn_facade.md) | 准入门面 | `TurnFacadeMixin`、跨进程 turn 租约与看门狗、`AIAgent` 的 14 个 Mixin、`init_agent` 相位、`IterationBudget` |
| [system_prompt.md](system_prompt.md) | 系统提示词 | 三层结构 stable/context/volatile、字节稳定不变量、技能索引与上下文文件、时间戳的缓存经济学 |
| 本篇 index.md | 总览 | 全景图、导航、大文件排行、facade+siblings 模式 |

其余主题文档（已随本模块成文）：

| 文档 | 主题 |
|---|---|
| [compression.md](compression.md) | 上下文压缩：`context_compressor.py`（5,725 行）、`conversation_compression.py`（4,410 行）、三遍压缩、溢出恢复 |
| [model_providers.md](model_providers.md) | 模型与 provider 解析：`auxiliary_client.py`（8,281 行）、`model_metadata.py`（2,627 行）、fallback 链与凭据池；wire 适配层 `agent/transports/`（chat_completions / anthropic / bedrock）也在这篇讲 |
| [../02_core/model_tools.md](../02_core/model_tools.md) 与 [tool_execution.md](tool_execution.md) | 工具体系：`model_tools.py`、toolsets、`tool_executor.py` 深读；MCP 见 [../04_tools/mcp.md](../04_tools/mcp.md) |
| [codex_runtime.md](codex_runtime.md) | codex wire 适配：`agent/transports/codex*.py` 系列 |
| [memory_learning.md](memory_learning.md) 与 [skills_runtime.md](skills_runtime.md) | 记忆与技能：`memory_manager.py`、curator、skills frontmatter |

## 模块内大文件排行

理解 agent/ 的第一课：**行数 = 主题的复杂度**。下面是 top 12（行数为当前源码实测）：

| 排名 | 文件 | 行数 | 一句话 |
|---|---|---|---|
| 1 | `agent/auxiliary_client.py` | 8,281 | 辅助（side-LLM）调用总管：压缩/视觉/标题/嵌入等非主循环模型调用的路由与降级 |
| 2 | `agent/context_compressor.py` | 5,725 | 内建压缩器：阈值、剪枝、摘要生成、失败冷却 |
| 3 | `agent/conversation_compression.py` | 4,410 | 压缩事务：边界选择、原地/轮转、feasibility、checkpoint |
| 4 | `agent/chat_completion_helpers.py` | 4,001 | 每次模型调用的落地：`build_api_kwargs`(:1503)、`interruptible_api_call`(:1260)、`interruptible_streaming_api_call`(:3977) |
| 5 | `agent/agent_runtime_helpers.py` | 3,765 | 运行时杂项助手：switch_model、invoke_tool、活动时钟、缓存同步 |
| 6 | `agent/model_metadata.py` | 2,627 | 模型元数据：上下文长度、能力、token 估算 |
| 7 | `agent/agent_init.py` | 2,211 | `init_agent`：构造的真正实现（相位顺序 load-bearing） |
| 8 | `agent/turn_recovery.py` | 1,999 | 内层重试的就地修复链（OAuth/签名/图片/语法……） |
| 9 | `agent/conversation_loop.py` | 1,967 | 主循环心脏：`run_conversation` + `_run_conversation_turn` + `_LoopState` |
| 10 | `agent/tool_executor.py` | 1,960 | 工具执行器：顺序/并发/分段三执行器，`_MAX_TOOL_WORKERS = 8` |
| 11 | `agent/prompt_builder.py` | 1,750 | 提示词原料：技能索引、上下文文件、环境锚 |
| 12 | `agent/system_prompt.py` | 889 | 系统提示词三层结构与缓存不变量 |

规则提醒（根 AGENTS.md）：文件 ≤ 2,000 行、新函数 CC ≤ 20——已超限的单元"只许变小"。
所以 top 8 里的大文件都是**历史上已定型的候选拆分对象**，阅读时优先找它的
facade（公开入口）和 siblings（同前缀兄弟文件）。

## facade + siblings 设计模式

agent/ 是这个模式的范本（根 AGENTS.md § Project Structure）：

```
run_agent.py（facade，1,565 行）            agent/conversation_loop.py（实现，1,967 行）
  class AIAgent(14 个 Mixin)                 def run_conversation(agent, ...)
      __init__ ──打包 locals()──►  agent/agent_init.py::init_agent
      run_conversation ──转发──►   ── lease 准入后 ──►
      _execute_tool_calls ──►      agent/tool_executor.py（siblings 之一）
      switch_model ──_forward──►   agent/agent_runtime_helpers.py
```

四条规则（读代码时随时用得上）：

1. **门面保留**：公共入口 + 其他包 import 的名字；**行为住在兄弟文件**
   `<stem>_<topic>.py`，每个文件管一个主题（`turn_tool_round.py` 只管一轮工具调用）。
2. **按主题找代码**：`grep -rn "def run_tool_round" agent/turn_*.py`，
   不要通读门面。
3. **兄弟文件在函数体内 late-import 门面**（`from agent.conversation_loop import X`），
   绝不模块级循环。这同时定义了测试缝：patch 生产代码真正读取的位置
   （`patch("agent.conversation_loop.X")`）。
4. **super god-file 的拆分方式**：turn 循环拆成了 33 个 `turn_*.py`，每个阶段一个文件；
   主循环只剩"串阶段"的 `_run_phase` 机制。

## 一条不变量贯穿所有文档

**Per-conversation prompt caching is sacred（会话级提示词缓存神圣不可侵犯）。**

- 系统提示词每会话构建一次、字节冻结，唯一合法的变异是压缩
  （[system_prompt.md](system_prompt.md)）；
- 请求历史通过 `api_content` sidecar 重放"当初发送的精确字节"，请求组装时
  cache plan 永远最后构建（[turn_pipeline.md](turn_pipeline.md)）；
- 中途注入的一切（steer、内存预取、预算警告）都骑在**最新的工具结果行**上，
  已持久化的行绝不改写（conversation_loop.py:139-158 的注释是范本）；
- 主循环是同步的：任何"换个上下文就想重建提示词"的冲动，都请回到这条不变量上自问。

## 阅读路径建议

零基础读者推荐顺序：

1. 本篇（全景图）→ 2. [turn_facade.md](turn_facade.md)（消息如何进门）
   → 3. [conversation_loop.md](conversation_loop.md)（循环如何转）
   → 4. [turn_pipeline.md](turn_pipeline.md)（每个阶段做什么）
   → 5. [system_prompt.md](system_prompt.md)（为什么提示词动不得）
   → 6. compression / model_providers 等后续文档（边缘系统）。

动手改代码前的三件套：读 `agent/AGENTS.md`（模块规则）、跑
`grep -rn "def <符号>" agent/turn_*.py` 定位实现、用 `scripts/run_tests.sh` 的
`tests/agent/` 套件验证消息形状不变量（角色交替、字节稳定系统提示词）。
