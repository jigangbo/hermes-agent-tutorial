# run_agent.py —— AIAgent 门面与 turn 生命周期的"地址簿"

> 阅读前提：[../01_architecture/turn_lifecycle.md](../01_architecture/turn_lifecycle.md)。本文讲门面本身；循环心脏在 `agent/conversation_loop.py`。

## 文件概览

`run_agent.py`（1,565 行）是 `AIAgent` 类的**门面**：模块 docstring 开头就是使用契约——

```python
# run_agent.py:1-7
"""AIAgent: the tool-calling agent runner (conversation loop, tool execution, session lifecycle).

    from run_agent import AIAgent
    agent = AIAgent(base_url="http://localhost:30000/v1", model="claude-opus-4-20250514")
    response = agent.run_conversation("Tell me about the latest Python updates")
"""
```

两行使用契约说清了整个仓库对外最重要的 API 面：**构造 → `run_conversation`**。所有重量级实现都在 `agent/` 兄弟包里；门面保留 14 个 mixin 的组装、纯转发的 `__init__`、少量"架构重量"的内部方法（工具执行与委派派发），以及 `main()` 直跑入口。

文件头还有两条值得注意的启动纪律：

```python
# run_agent.py:9-14
# hermes_bootstrap must be the very first import (UTF-8 stdio on Windows; no-op on POSIX).
try:
    import hermes_bootstrap
except ModuleNotFoundError as exc:  # partial `hermes update` left the bootstrap unregistered
    if exc.name != "hermes_bootstrap" and not "hermes_bootstrap".startswith(f"{exc.name}."):
        raise  # the bootstrap exists but cannot load: skipping it would skip PM activation
```

`hermes_bootstrap` 必须第一个 import；半途失败的 `hermes update` 只允许跳过 bootstrap 本身缺失的情形，绝不能吞掉"bootstrap 存在但加载失败"。

## 关键代码走读

### 1. AIAgent：14 个 mixin 的组装（行 214）

```python
# run_agent.py:214-219
class AIAgent(
    ClientLifecycleMixin, StreamDeliveryMixin, StatusOutputMixin, ApiRequestHooksMixin, ApiErrorSummaryMixin,
    InterruptControlMixin, TurnExplainersMixin, ActivityTrackingMixin, RateLimitCreditsMixin,
    SessionPersistenceMixin, CompressionFacadeMixin, TurnFacadeMixin, VisionMessagePrepMixin, ReasoningParamsMixin,
):
    """AI Agent with tool calling capabilities."""
```

每个 mixin 都是 `agent/` 下的一个兄弟文件（`agent/turn_facade.py`、`agent/stream_delivery.py`…）。门面在这里**只做一件事：把名字钉到 `AIAgent` 的 MRO 上**。这意味着 `monkeypatch.setattr(AIAgent, "run_conversation", ...)` 或者 patch `agent.turn_facade.TurnFacadeMixin.run_conversation` 都能命中同一条 MRO 链。

### 2. `__init__`：约 60 个参数的纯转发器（行 236）

```python
# run_agent.py:236-288（节选）
    def __init__(
        self,
        base_url: str | None = None, api_key: str | None = None, provider: str | None = None, api_mode: str | None = None,
        ...
        max_iterations: int = sys.maxsize,  # unlimited tool-calling iterations by default (shared with subagents)
        tool_delay: float | None = None,  # deprecated: accepted for compatibility, ignored
        ...
    ):
        """Forwarder — see ``agent.agent_init.init_agent`` (same keyword parameters, minus ``tool_delay``)."""
        init_kwargs = {k: v for k, v in locals().items() if k not in ("self", "tool_delay")}
        if tool_delay is not None:
            warnings.warn("tool_delay is deprecated and ignored; ...", DeprecationWarning, stacklevel=2)
        from agent.agent_init import init_agent
        init_agent(self, **init_kwargs)
```

三个要点：

- **打包 `locals()` 转发**：`__init__` 不逐参数赋值，而是把整个局部字典（除 `self` 与已废弃的 `tool_delay`）原样交给 `agent/agent_init.py::init_agent`（行 2056）。签名在两处必须逐字一致——新增参数要同时改两个文件。
- **`init_agent` 内部相位顺序是 load-bearing 的**：解析 provider/api_mode → 建客户端 → 加载工具（`_load_tools`，工具快照在 `agent/agent_init.py:1019` 处一次定死 `agent.tools`）→ 会话状态 → 记忆 → 压缩配置。任何一个相位提前都可能读到未初始化的字段。
- **`max_iterations` 的字面默认值是 `sys.maxsize`**——"无限次"；host/config 层会传 500。真正的预算执行者是 `agent/iteration_budget.py::IterationBudget`：

```python
# agent/iteration_budget.py:25-40（节选）
class IterationBudget:
    """Thread-safe iteration counter; ``execute_code`` ... iterations are refunded via :meth:`refund` ..."""
    def __init__(self, max_total: int):
        self.max_total = max_total
        self._used = 0
        self._lock = threading.Lock()

    def consume(self) -> bool:
        with self._lock:
            if self._used >= self.max_total:
                return False
            self._used += 1
            return True
```

线程安全、父子共享（父 agent 与子 agent 各持一个 `IterationBudget`，父 cap 500、子 `delegation.max_iterations` 默认 50），`execute_code` 消耗的额度可 `refund`。

### 3. 公共 API 的家：run_conversation / chat / close / release_clients / reset_session_state

- `run_conversation` 定义在 `agent/turn_facade.py:22`（`TurnFacadeMixin`）。它的开头是一圈"入场仪式"：

```python
# agent/turn_facade.py:22-40（节选）
    def run_conversation(self, user_message, ...):
        """Forwarder — see ``agent.conversation_loop.run_conversation``."""
        from agent.background_review import cancel_background_review_for_live_turn
        cancel_background_review_for_live_turn(self)
        ...
        admission = admit_durable_turn_lease(self, session_id=..., relay_turn_id=..., ...)
```

要点：**跨进程 turn lease**（`agent.turn_facade_lease.admit_durable_turn_lease`，同一会话同时只允许一个 turn），随后建立 relay / accounting / portal 各类 contextvar 作用域，才转发 `agent.conversation_loop.run_conversation`。

- `chat`（`agent/turn_facade.py:220`）是"一条消息进、一个字符串出"的简化包装。
- `close` / `release_clients` 在门面（`run_agent.py:921-965`），两者刻意不同：`release_clients` 是网关缓存驱逐用——只放掉 LLM 客户端与子 agent，**保留**进程、沙箱、浏览器等会话工具状态（同 task_id 的会话可能复活）；`close` 是彻底关闭，每个阶段用 `_quietly` 包裹，一步失败不挡后续步骤。
- `reset_session_state`（`run_agent.py:379`）把 session 级 token/成本计数器清零，并驱动上下文引擎走完整的会话过渡生命周期（`_transition_context_engine_session`）。

### 4. 架构重量的两个内部方法

**`_execute_tool_calls`（行 1308）——段规划器**：

```python
# run_agent.py:1308-1333（节选）
    def _execute_tool_calls(self, assistant_message, messages: list, effective_task_id: str, api_call_count: int = 0) -> None:
        """Execute the assistant's tool calls and append results to ``messages``.

        The segment planner splits the batch into runs of parallel-safe calls ... separated by
        sequential barriers, run in emission order.
        """
        tool_calls = assistant_message.tool_calls
        ...
        with scoped_connection_surface(agent_connection_surface(self)):
            if len(tool_calls) <= 1:
                self._execute_tool_calls_sequential(*args)
            else:
                from agent.tool_dispatch_helpers import _plan_tool_batch_segments
                ...
                segments = _plan_tool_batch_segments(tool_calls, execution_cwd=exec_cwd)
                if len(segments) == 1:
                    run = self._execute_tool_calls_concurrent if segments[0][0] == "parallel" else self._execute_tool_calls_sequential
                    run(*args)
                else:
                    from agent.tool_executor import execute_tool_calls_segmented
                    execute_tool_calls_segmented(self, *args, segments=segments)
```

单个调用走顺序路径；多个调用先由 `_plan_tool_batch_segments` 把"并行安全"（只读、文件目标不重叠、opt-in 的 MCP）与"必须串行"的分段，再按发射顺序执行。真正的并发执行体在 `agent/tool_executor.py`（门面只是 `_forward` 转发，行 1376-1377）。

**`_dispatch_delegate_task`（行 1344）——唯一的委派派发点**：

```python
# run_agent.py:1344-1358（节选）
    def _dispatch_delegate_task(self, function_args: dict) -> str:
        """Single call site for delegate_task dispatch; new DELEGATE_TASK_SCHEMA fields are added only here."""
        from tools.delegate_tool import _strip_model_hidden_task_fields, delegate_task as _delegate_task
        return _delegate_task(
            goal=function_args.get("goal"), context=function_args.get("context"),
            tasks=_strip_model_hidden_task_fields(function_args.get("tasks")),
            ...
            background=not (getattr(self, "_delegate_depth", 0) > 0), ...
        )
```

"Single call site" 是刻意约束：`DELEGATE_TASK_SCHEMA` 新增字段只在这里接线。顶层委派默认后台跑（`background=True`），但**深度 > 0 的编排器子代理保持同步**——它需要在本 turn 内拿到结果。

### 5. main() 直跑入口与 `__main__` 路径

```python
# run_agent.py:1485-1551（节选）
def main(query=None, model="", api_key=None, base_url="", max_turns=10, enabled_toolsets=None,
         disabled_toolsets=None, list_tools=False, ...):
    ...
    if list_tools:
        return _print_tool_listing()
    ...
    result = agent.run_conversation(user_query)
```

`main()` 是 `hermes-agent` console script 与 `python run_agent.py` 的直跑入口：装 TLS 信任库 → 解析 toolset 参数 → 构造 AIAgent → `run_conversation` → 打印摘要；`--list_tools` 打印工具与工具集清单。而 `__main__` 分支经 `agent/legacy_cli.py` 走（行 1562-1565）：

```python
# run_agent.py:1562-1565
if __name__ == "__main__":
    from agent.legacy_cli import main as _legacy_cli_main
    raise SystemExit(_legacy_cli_main(run=main))
```

`agent/legacy_cli.py` 是参数层：console script 裸调用时 argv 会被忽略，这个兄弟补齐 argparse（`--query`、`--max-turns`、`--list-tools`…），并把 `--help`/`--version` 从"真跑一轮模型"里救回来（issue #54648）。

## 核心类/函数

| 名称 | 位置 | 职责 |
|---|---|---|
| `AIAgent` | run_agent.py:214 | 14 个 mixin 的门面类，全仓库对外唯一的 agent 类 |
| `AIAgent.__init__` | run_agent.py:236 | ~60 参数纯转发器；打包 `locals()` 交给 `init_agent` |
| `init_agent` | agent/agent_init.py:2056 | 真正的初始化；相位顺序 load-bearing |
| `_load_tools` | agent/agent_init.py:994 | 一次定死 `agent.tools`（行 1019）与 `valid_tool_names` |
| `run_conversation` | agent/turn_facade.py:22 | turn lease + relay/accounting 作用域 → conversation_loop |
| `chat` | agent/turn_facade.py:220 | 单消息 → 单字符串的简化入口 |
| `close` / `release_clients` | run_agent.py:938 / 921 | 彻底关闭 / 缓存驱逐式软释放（幂等） |
| `reset_session_state` | run_agent.py:379 | 清零会话计数器 + 上下文引擎会话过渡 |
| `_execute_tool_calls` | run_agent.py:1308 | 段规划器：顺序/并行分段执行一批工具调用 |
| `_dispatch_delegate_task` | run_agent.py:1344 | delegate_task 唯一派发点 |
| `IterationBudget` | agent/iteration_budget.py:25 | 线程安全的迭代预算；父 500/子 50；execute_code 可退款 |
| `main` / `_print_tool_listing` | run_agent.py:1485 / 1421 | 直跑入口与 `--list_tools` |
| `_StreamErrorEvent` | run_agent.py:200 | 把 Responses SSE `type=error` 帧合成为 SDK 形状的异常 |

## 本组文件清单

| 文件 | 行数 | 角色 |
|---|---|---|
| run_agent.py | 1,565 | AIAgent 门面：mixin 组装、转发器 `__init__`、工具执行/委派派发、main() |
| agent/agent_init.py | ~2,400 | `init_agent`：按相位完成全部初始化（工具快照在 :1019） |
| agent/turn_facade.py | ~300 | `TurnFacadeMixin`：run_conversation/chat 的入场仪式 |
| agent/turn_facade_lease.py | ~400 | 跨进程 durable turn lease 与守望线程 |
| agent/conversation_loop.py | 大 | turn 循环心脏（门面转发的最终去向） |
| agent/tool_executor.py | ~700 | 顺序/并发/分段工具执行体 |
| agent/tool_dispatch_helpers.py | ~200 | `_plan_tool_batch_segments` 段规划器 |
| agent/iteration_budget.py | 45 | 线程安全迭代预算 |
| agent/legacy_cli.py | ~120 | `hermes-agent`/`python run_agent.py` 的 argparse 参数层 |
| agent/lazy_forward.py | ~60 | `_forward`：把兄弟实现钉到门面名字上 |

## 与其他模块的关系

- **向下**：`agent/` 兄弟包承担全部行为；`tools/` 提供工具注册表；`hermes_state` 提供 SessionDB。
- **向上**：`cli.py`（经 `hermes_cli/cli_agent_setup_mixin.py`）与网关每消息构造 AIAgent；`batch_runner.py` 也直接 `from run_agent import AIAgent`。
- **横向**：`model_tools.get_tool_definitions` 在 init 时被调用一次（见 [model_tools.md](model_tools.md)）；`toolsets.agent_tool_surface` 决定本会话实际携带的工具面。

## 总结

- 门面只保留"使用契约 + mixin 组装 + 两个架构重量方法"，行为全部在 `agent/` 兄弟里。
- `__init__` 的 `locals()` 打包转发让签名一致成为硬约束；`init_agent` 的相位顺序不能调换。
- 工具集在 init 时一次定死、`max_iterations` 默认无限（预算由 IterationBudget 真正执行）、委派只有一个派发点——这三条都是**提示词缓存与可预测性**这两个不变量的落点。
