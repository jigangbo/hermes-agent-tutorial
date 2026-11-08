# tool_execution.md — agent 侧工具执行：拦截表、段规划器、并发执行与护栏

## 文件概览

模型一次吐回 N 个 `tool_calls`，到结果逐条回填进 `messages` 之间，是 agent 侧最重的一段管线。
04_tools 讲**工具本体**（registry、各工具实现、`delegate_tool` 的子代理侧）；本篇讲 **agent 侧的
执行编排**：

```
assistant_message.tool_calls
   │ expand_local_tool_batches     tool_call 批次桥拆分成普通调用（先于持久化）
   ▼
AIAgent._execute_tool_calls       run_agent.py:1308
   │  _plan_tool_batch_segments   ──► [("parallel"|"sequential", calls), ...]  段规划
   ▼
execute_tool_calls_segmented      tool_executor.py:1929  按序跑段
   │  并行段 → execute_tool_calls_concurrent（线程池 ≤ _MAX_TOOL_WORKERS=8）
   │  顺序段 → execute_tool_calls_sequential（每 call 先拦截表 INLINE_TOOL_EXECUTORS）
   ▼
_dispatch_authorized_once / registry dispatch
   │  guardrails.before_call → 中间件 → 工具本体 → after_call
   ▼
_commit_tool_result：observe → commit → project（结果线格式只产出一次）
```

| 文件 | 行数 | 角色 |
|---|---|---|
| `agent/tool_executor.py` | 1,960 | 顺序/并发/分段执行器与结果提交管线 |
| `agent/inline_tool_executors.py` | 378 | `INLINE_TOOL_EXECUTORS` 拦截表（agent 状态型工具先行） |
| `agent/tool_call_batches.py` | 80 | `tool_call` 批次桥展开为普通调用 |
| `agent/tool_dispatch_helpers.py` | 627 | 段规划器、破坏性命令启发、多模态结果摘要 |
| `agent/tool_progress_relay.py` | 68 | 工具内进度（MCP notifications/progress）→ UI 事件 |
| `agent/tool_guardrails.py` | 672 | 纯函数式循环护栏控制器（停滞/循环/预算） |
| `agent/tool_result_classification.py` | 118 | 结果分类：失败标记、限速、写落地判定 |
| `agent/terminal_approval_batch.py` | 328 | 桌面终端批准批次（先批准、后按序执行） |
| `agent/terminal_env_provider.py` | 122 | 终端环境后端 ABC（分类契约属性化） |
| `agent/terminal_env_registry.py` | 85 | 插件终端后端注册表（内置名保留） |
| `agent/terminal_image.py` | 476 | kitty/iTerm2/sixel 图形能力探测与内联图渲染 |
| `agent/file_safety.py` | 526 | 文件安全守卫（纵深防御，非安全边界） |
| `agent/shell_hooks.py` | 858 | `hooks:` 配置 → 脚本钩子桥（stdin/stdout JSON 协议） |
| `run_agent.py` | 1,565 | `_execute_tool_calls`（:1308）/ `_dispatch_delegate_task`（:1344）门面侧 |
| `agent/agent_init.py` | 2,211+ | `ToolCallGuardrailController` 接线（:1145-1152） |

---

## 关键代码走读

### 1. `INLINE_TOOL_EXECUTORS`：需要活 agent 状态的工具先行拦截

一部分工具需要 `AIAgent` 的活状态（store、回调、session DB），不走 registry。两张历史上各自漂移的
if/elif 链（顺序路径与并发 `invoke_tool`）被收编成**一张表**：

```python
# agent/inline_tool_executors.py:291-354（节选）
_RAW_INLINE_TOOL_EXECUTORS: dict[str, InlineToolExecutor] = {
    "todo_list": _tool("tools.todo_tool", "todo_tool", ("todos", "todos"), ("merge", "merge", False),
                       store=lambda agent, ctx: agent._todo_store),
    "message_agent": _tool("tools.bot_mode_dm", "message_agent_tool", ...),
    "session_search": _session_search,
    "memory": _memory,
    "clarify": _tool("tools.clarify_tool", "clarify_tool", ("questions", "questions"),
                     callback=lambda agent, ctx: agent.clarify_callback),
    ...
    "browser_vault": _browser_vault,
    "drive_preview": _callback_tool("tools.drive_preview_tool", "drive_preview_tool", "drive_preview_callback", ...),
    ...
    "manage_connections": _manage_connections,
    ...
    "delegate_task": lambda agent, args, ctx: agent._dispatch_delegate_task(args),
}

INLINE_TOOL_EXECUTORS: dict[str, InlineToolExecutor] = {
    name: _coerced(name, executor) for name, executor in _RAW_INLINE_TOOL_EXECUTORS.items()
}
```

约 20 项：`todo_list`/`message_agent`/`session_search`/`memory`/`clarify`、GUI 回调工具
（`read_terminal`/`drive_preview`/`annotate_preview`/`gui_tour`/`set_theme`……回调属性只存在于
agent 上，registry dispatch 永远转发不到）、`manage_connections`/`manage_catalog`、以及
`delegate_task`。看 `_memory` 执行器如何连回记忆系统：

```python
# agent/inline_tool_executors.py:144-164（节选）
def _memory(agent, args: dict, ctx: InlineToolContext) -> Any:
    result = _call_tool("tools.memory_tool", "memory_tool", args, (...), store=agent._memory_store)
    # Mirror built-in memory writes to external providers; gating lives in
    # MemoryManager.notify_memory_tool_write.
    if agent._memory_manager:
        agent._memory_manager.notify_memory_tool_write(result, args,
            build_metadata=lambda: agent._build_memory_write_metadata(task_id=ctx.effective_task_id,
                                                                       tool_call_id=ctx.tool_call_id))
    return result
```

工具模块全部**惰性导入**（`_call_tool`），测试里 `patch("tools.x.y")` 因此持续有效；
`_coerced` 统一做参数类型矫正。并发路径的优先级由 `resolve_invoke_tool_executor` 定：
`{todo_list, session_search, memory}` → memory-manager 工具 → 其余内联工具
（`message_agent` 落回 registry）。

### 2. 段规划器：并行安全段 + 顺序屏障

`_plan_tool_batch_segments` 把批次切成**保序**的段——后面的调用绝不越过前面的屏障，
结果顺序与副作用边界与全顺序执行完全一致：

```python
# agent/tool_dispatch_helpers.py:212-258（节选）
def _plan_tool_batch_segments(tool_calls, *, execution_cwd=None) -> list[tuple]:
    """Split a tool-call batch into ordered ("parallel"|"sequential", calls) segments.

    Call order is preserved exactly (a later call never crosses an earlier barrier) ...
    Path-scoped tools join a run only if they don't conflict with its reservations:
    reader↔reader overlap stays parallel; any overlap involving a writer closes the run ...
    Runs shorter than two calls demote to sequential ..."""
    segments: list[tuple] = []
    current: list = []
    reserved_paths: list[tuple[Path, bool]] = []   # (canonical_path, is_writer) 当前 run 的预约
    ...
    for tool_call in tool_calls:
        admission = _batch_admission(tool_call, execution_cwd)
        if admission is None:
            _close_parallel()
            _extend_sequential([tool_call])        # 屏障
            continue
        _name, scoped_paths, is_writer = admission
        if any((is_writer or existing_is_writer) and _paths_overlap(scoped_path, existing)
               for scoped_path in scoped_paths
               for existing, existing_is_writer in reserved_paths):
            _close_parallel()                      # 写冲突：关闭 run，重新开段
        reserved_paths.extend((p, is_writer) for p in scoped_paths)
        current.append(tool_call)
    _close_parallel()
    return segments
```

准入分三类（`_batch_admission`，:182）：`_NEVER_PARALLEL_TOOLS`（`clarify`/`manage_connections`/
`manage_catalog`/`setup_beat`/`set_theme`——交互或用户可见）是屏障；`_PATH_SCOPED_TOOLS`
（`read_file`/`search_files` 读，`write_file`/`patch` 写）按**路径预约**入场——读者可与读者共享
子树，写者与任何重叠者互斥；白名单 `_PARALLEL_SAFE_TOOLS`（web_search、skill_view 等无共享可变
状态）、无状态桥查（`tool_search`/`tool_describe`）与** opting-in 的 MCP 服务器工具**自由入场。
`_peel_bridge_call`（:137）先把 `tool_call` 桥拆到底层工具再判——否则 tool search 激活后所有
延迟工具都顶着同一个名字，悄悄丢失并发。段由门面侧消费：

```python
# run_agent.py:1308-1331（节选）
    def _execute_tool_calls(self, assistant_message, messages, effective_task_id, api_call_count=0):
        tool_calls = assistant_message.tool_calls
        ...
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

`execute_tool_calls_segmented`（tool_executor.py:1929）逐段派发：并行段给
`execute_tool_calls_concurrent`（`ThreadPoolExecutor`，`_MAX_TOOL_WORKERS=8`，
`_DEFAULT_CONCURRENT_TOOL_TIMEOUT_S=420s`）、顺序段给 `execute_tool_calls_sequential`，
均以 `finalize=False` 跑；预算执行与 /steer 注入在**全批结束**只做一次
（`_finalize_tool_batch`）。

### 3. 顺序路径：批准批次与"persist-before-execute"的执行侧

顺序执行器外面还套一层**终端批准批次**——桌面场景要先把一批终端命令全部报批，再按原序放行执行：

```python
# agent/tool_executor.py:1859-1868
def execute_tool_calls_sequential(agent, assistant_message, messages, effective_task_id, api_call_count=0, *, finalize=True):
    from types import SimpleNamespace
    from agent.terminal_approval_batch import terminal_approval_batch, terminal_approval_runs
    for calls in terminal_approval_runs(agent, assistant_message.tool_calls):
        with terminal_approval_batch(agent, calls, messages, effective_task_id):
            _execute_tool_calls_sequential(agent, SimpleNamespace(tool_calls=calls), messages,
                                           effective_task_id, api_call_count, finalize=False)
        ...
```

`terminal_approval_batch.py` 的模块注释点明分工："Workers keep execution middleware on its original
stack. **Only command approval runs ahead**; the existing sequential executor releases each worker and
**persists its result before releasing the next**. No terminal environment/cwd is acquired while
preparing"——即批准可以预取，但每个结果**先持久化再放行下一个**（会话崩溃/中断时转录不缺行，
这就是 persist-before-execute 不变量在执行侧的形态），且准备阶段绝不预建终端环境。
顺序主体 `_execute_tool_calls_sequential`（:1871）在每个 call 前后检查 `_interrupt_requested`，
被打断时给未执行调用逐个补合成结果（`_skip_remaining_sequential`），保证
tool_call/tool_result 配对不破。

### 4. 拦截表之外：registry 分发的三段守卫

一次 registry 工具调用前后的护栏链是（`_pre_tool_block` → `_dispatch_authorized_once` →
`_run_agent_tool_execution_middleware`）：`ToolCallGuardrailController.before_call` 先判——

```python
# agent/tool_guardrails.py:312-319（类定义节选）
class ToolCallGuardrailController:
    """Pure tool-call loop guardrail primitives.

    The controller is side-effect free: it tracks per-turn tool-call observations
    and returns decisions. Runtime code decides whether a decision becomes warning
    guidance, a synthetic tool result, or a controlled turn halt."""
```

控制器是**纯函数式**的：连续相同 (tool, args, result) 第 3 次给 notice（`STALL_GUARD_IDENTICAL_
CALL_THRESHOLD=3`）、识别最长 4 期的 A,B,A,B 循环（每个整批算一"圈"）、`no_progress` 熔断；
幂等工具（读文件/搜索）不计数，terminal 等"失败即工作产出"的工具只对**逐字重放**熔断。
运行时决定一个 decision 落成警告、合成结果还是受控停转（`toolguard_synthetic_result` /
`append_toolguard_guidance`）。结果侧由 `tool_result_classification` 供分类事实：`has_failure_marker`
（`"error": null` 不算失败）、`is_rate_limited`（只在已判失败的结果上找 429/retry_after）、
`file_mutation_result_landed`（write_file 必须见 `bytes_written`）。
`shell_hooks.py` 是另一条入口：用户在 config 里配 `hooks:`，首个使用需逐 `(event, command)` 同意，
stdin/stdout 走 JSON 协议、退出码 2 即拦截 `pre_tool_call`（Claude-Code 兼容）；默认 fail-open、
可配 `fail_closed`。`file_safety.py` 则是文件工具与 ACP shim 共用的纵深防御（HERMES_HOME/凭据
库保护等），注释明言"不是安全边界"。

### 5. 结果回填与溢出

结果统一走 `observe → commit → project` 管线（`_commit_tool_result`，:1064）：护栏
`after_call` 观察、`maybe_persist_tool_result` 按预算落盘并留持久化路径
（`agent._tool_guardrails.record_persisted_path_for_stub` 防引用桩悬空）、多模态文本部件持久化、
终态 `post_tool_call` 钩子（`emit_terminal_post_tool_call`）与 `transform_tool_result`
（`apply_transform_tool_result`，内联工具也要吃到同一"every tool"契约）。≥1MB 的原始结果引用
直到全批解栈才裁（`_LARGE_TOOL_RESULT_TRIM_CHARS`，#70684）。工具内进度由
`tool_progress_relay` 的 contextvar 承载：工具在自己的线程上调 `current_tool_progress()`，
按 call 节流（首帧与到达 total 的帧恒通过）。

### 6. 支撑件：终端环境与图形

- `terminal_env_provider.py`：插件终端后端 ABC。历史上每个核心策略决策都是一张内置名 frozenset，
  新后端会静默漏掉；现在改成一组成 **声明式属性**（`is_remote`、是否支持 cwd 持久等），ABC 直接
  带分类契约。
- `terminal_env_registry.py`：注册表无"active provider"解析——活跃后端就是 `TERMINAL_ENV`/
  `terminal.backend` 点名的那个；内置名（docker/modal/managed_modal…）保留，插件注册即报错。
- `terminal_image.py`： kitty → iterm → sixel → unicode 半块保真序探测（DA1 应答解析），
  pet 吉祥物与 CLI 内联图共享。
- `agent_init.py:1145-1152` 把 `ToolCallGuardrailController(ToolCallGuardrailConfig.from_mapping(
  _agent_cfg.get("tool_loop_guardrails", {})))` 绑到 `agent._tool_guardrails`（配置坏只降级不炸）。

---

## 核心类/函数

| 符号 | 位置 | 职责 |
|---|---|---|
| `INLINE_TOOL_EXECUTORS` | inline_tool_executors.py:352 | ~20 项 agent 状态型工具拦截表 |
| `resolve_invoke_tool_executor` | inline_tool_executors.py:362 | 并发路径的拦截优先级 |
| `notify_memory_tool_write`（经 `_memory`） | inline_tool_executors.py:144 | 内建 memory 写镜像给外部 provider |
| `_plan_tool_batch_segments` | tool_dispatch_helpers.py:212 | 批次 → 保序 parallel/sequential 段 |
| `_batch_admission` / `_peel_bridge_call` | tool_dispatch_helpers.py:182/137 | 逐调用准入分类 / 桥拆底 |
| `_is_destructive_command` | tool_dispatch_helpers.py:102 | 终端命令破坏性启发（rm/mv/`>` 重定向…） |
| `expand_local_tool_batches` | tool_call_batches.py:14 | `tool_call` 批次 → 普通 tool_calls（持久化前） |
| `execute_tool_calls_segmented` | tool_executor.py:1929 | 逐段派发 + 批末一次性 finalize |
| `execute_tool_calls_concurrent` | tool_executor.py:1578 | 并行段（≤8 workers、420s 默认超时） |
| `execute_tool_calls_sequential` | tool_executor.py:1859 | 顺序段（终端批准批次外壳） |
| `_execute_tool_calls_sequential` | tool_executor.py:1871 | 逐 call：拦截表 → registry → 结果发布 |
| `_commit_tool_result` | tool_executor.py:1064 | observe → commit → project 统一提交 |
| `_ConcurrentBatch` / `_StartOrderGate` | tool_executor.py:1320/1265 | 并行批状态机 / 启动顺序闸（批准往返 120s） |
| `ToolCallGuardrailController` | tool_guardrails.py:312 | 停滞/循环/预算护栏（纯函数决策） |
| `classify_tool_failure` / `is_rate_limited` | tool_result_classification.py:219/67 | 结果失败分类事实 |
| `terminal_approval_batch` / `terminal_approval_runs` | terminal_approval_batch.py | 桌面终端批准的批量预取与按序放行 |
| `TerminalEnvironmentProvider` / `TerminalEnvironmentRegistry` | terminal_env_provider.py:33 / terminal_env_registry.py | 插件终端后端 ABC / 注册表 |
| `render_inline_image` 等 | terminal_image.py | 终端图形协议探测与渲染 |
| `is_nt_namespace_path` 等 | file_safety.py | 文件安全守卫（NT 命名空间、HERMES_HOME/凭据库） |
| `invoke_hook`（shell hooks 桥） | shell_hooks.py | hooks: 配置 → 脚本回调（JSON 协议、exit 2 拦截） |

---

## 本组文件清单

| 文件 | 角色 | 关键符号 |
|---|---|---|
| `agent/tool_executor.py` | 执行编排主体（顺序/并发/分段/提交） | `execute_tool_calls_*`, `_commit_tool_result`, `_ConcurrentBatch` |
| `agent/inline_tool_executors.py` | agent 状态型工具拦截表 | `INLINE_TOOL_EXECUTORS`, `InlineToolContext`, `apply_transform_tool_result` |
| `agent/tool_call_batches.py` | tool_call 批次桥展开 | `expand_local_tool_batches` |
| `agent/tool_dispatch_helpers.py` | 段规划器与准入分类 | `_plan_tool_batch_segments`, `_NEVER_PARALLEL_TOOLS`, `_is_destructive_command` |
| `agent/tool_progress_relay.py` | 工具内进度事件中继 | `bound_tool_progress`, `current_tool_progress` |
| `agent/tool_guardrails.py` | 循环护栏控制器与配置 | `ToolCallGuardrailController`, `ToolCallGuardrailConfig`, `toolguard_synthetic_result` |
| `agent/tool_result_classification.py` | 结果分类原语 | `has_failure_marker`, `is_rate_limited`, `file_mutation_result_landed` |
| `agent/terminal_approval_batch.py` | 终端批准批次（先批后行） | `terminal_approval_batch`, `terminal_approval_runs` |
| `agent/terminal_env_provider.py` | 终端环境后端 ABC | `TerminalEnvironmentProvider` |
| `agent/terminal_env_registry.py` | 终端后端注册表 | `ProviderRegistry`, `BUILTIN_*` 保留名 |
| `agent/terminal_image.py` | 终端图形能力/内联图 | `render_inline_image`, DA1 探测 |
| `agent/file_safety.py` | 文件安全守卫（纵深防御） | `_hermes_dirs`, NT 命名空间守卫 |
| `agent/shell_hooks.py` | 用户 shell 钩子桥 | `invoke_hook`, ALLOWLIST, exit-2 拦截 |
| `run_agent.py` | 门面侧：段规划消费 + delegate 派发 | `_execute_tool_calls`(:1308), `_dispatch_delegate_task`(:1344) |
| `agent/agent_init.py` | 护栏控制器接线（:1145） | `ToolCallGuardrailController` 绑定 |

---

## 与其他模块的关系

- **tools/**：`tools/registry.py`（`handle_function_call`/`tool_error`）、`tools/terminal_tool_lifecycle`
  （`get_active_env`）、`tools/tool_result_storage`（预算落盘）、`tools/arg_coercion`（参数矫正）、
  `tools/threat_patterns`（参数威胁扫描）——工具本体见 04_tools/。
- **04_tools/delegation_tools.md**：`_dispatch_delegate_task` 只是单点转发到
  `tools/delegate_tool.delegate_task`；子代理生命周期见本组 delegation_subagents.md。
- **agent/ 内**：guardrails 控制器由 `agent_init` 接线；结果落盘对接会话持久化
  （`session_persistence.sync_rewritten_tool_rows`）；`prompt_cache_scope.conversation_id`
  为每个钩子调用提供会话身份；`message_sanitization.coalesce_tool_call_id` 统一 call id。
- **gateway/desktop**：`terminal_approval_batch` 服务桌面 Bot Mode 的交互式批准；
  `manage_connections`/`manage_catalog`/`setup_beat` 的回调与卡片只在桌面 chat 表面有意义。
- **plugins/**：`PluginContext.register_terminal_environment_provider` 向
  `terminal_env_registry` 注册沙箱后端；shell hooks 与 `transform_tool_result`/
  `post_tool_call` 是插件挂钩工具执行的两大公共缝。

## 总结

这一层的工程主轴有两个。其一，**保序的并行**：段规划器把"哪些调用可以同时跑"规约为三类可判定的
准入（交互屏障、路径预约、白名单/显式 opt-in），并用"读读可并行、写与任何重叠互斥"的预约表把
并发安全从"信任模型"变成"结构保证"——顺序语义一个字节没变。其二，**一次产出结果线格式**：
无论走哪条执行路径，最终都汇入同一个 observe → commit → project 提交管线，护栏、预算落盘、
钩子、结果变换各就各位。护栏控制器坚持"纯决策 + 运行时裁决"的分离，让同一套停滞/循环检测可以
落成警告、合成结果或受控停转三种处置——这是把复杂策略写成可测代码的范本。
