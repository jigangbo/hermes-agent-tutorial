# model_tools.py —— 工具注册表之上的薄编排层

> 阅读前提：[../01_architecture/tool_system.md](../01_architecture/tool_system.md)、[toolsets.md](toolsets.md)。注册表本体在 `tools/registry.py`，本章讲编排。

## 文件概览

`model_tools.py`（1,018 行）的模块 docstring 自我定位很清楚：

```python
# model_tools.py:1-7
"""Thin orchestration layer over the tool registry.

Importing runs tool discovery (each tools/*.py self-registers via
tools.registry.register()); exposes get_tool_definitions() (toolset-filtered
schemas sent to the model) and handle_function_call() (dispatch with
hooks/middleware) plus registry pass-throughs.
"""
```

它只做三件事：**导入即发现工具**、**组面**（决定每次 API 请求带哪些工具 schema）、**派发**（把模型的一次 tool call 安全送达处理函数）。注册表（`tools.registry.registry`）保存真正的 schema 与 handler。

## 关键代码走读

### 1. 导入即发现（行 151）与"故意不发现的 MCP"

```python
# model_tools.py:150-166（节选）
# --- Tool discovery (importing each tools/*.py triggers registry.register) ---
discover_builtin_tools()

# MCP discovery is deliberately NOT run here: it blocks up to 120 s and the
# gateway lazy-imports this module inside its event loop; each entry point
# (gateway/run.py, cli.py, tui_gateway, acp_adapter) runs it at startup.
try:  # plugin tool discovery (user/project/pip plugins)
    from hermes_cli.plugins import discover_plugins
    discover_plugins()
except Exception as e:
    logger.debug("Plugin discovery failed: %s", e)
```

- `discover_builtin_tools()` 定义在 `tools/registry.py:121`：对 `tools/*.py` 逐文件做 **AST 预过滤**（只有确实出现 `registry.register(...)` 的文件才值得 import），判定结果带 `(mtime_ns, size)` 键落盘缓存，整体约 145 ms。
- **safe-worker 模式**下导入图被刻意收紧：只 import `tools.file_tools`、`tools.terminal_tool`、`tools.process_registry` 三个已审计核心模块，不碰插件包装器与 profile 可写的发现缓存。
- **MCP 发现被故意排除**：`discover_mcp_tools()` 内部有一个 `future.result(timeout=120)` 的阻塞等待，而网关会在事件循环里 lazy-import 本模块——曾经导致任何一台配置了慢 MCP 服务器的机器在第一条用户消息处冻结 Discord/Telegram 心跳最长 120 秒（issue #16856）。现在 MCP 发现由各入口点（gateway、cli、tui_gateway、acp）自己负责。

### 2. 组面管线：get_tool_definitions（行 227）

```python
# model_tools.py:227-235（节选）
def get_tool_definitions(enabled_toolsets=None, disabled_toolsets=None,
                         quiet_mode: bool = False, skip_tool_search_assembly: bool = False) -> list[dict[str, Any]]:
    """Tool definitions for model API calls, filtered by toolset.

    enabled_toolsets None = all; disabled_toolsets are subtracted after enabling.
    quiet_mode suppresses status prints and enables memoization.
    """
```

未缓存的实现在 `_compute_tool_definitions`（行 522），管线依次是：

1. **选名**：`_select_tool_names`（行 333）。enabled 是**并集**；disabled 最后才减：

```python
# model_tools.py:349-355（节选）
    # Disabled toolsets are always subtracted LAST, so a tool in a disabled
    # toolset is stripped even when a composite (hermes-cli) re-enables it.
    # See issue #17309.
    if disabled_toolsets:
        _apply_toolset_selection(tools, disabled_toolsets, quiet_mode, disable=True)
    return tools
```

   关键在顺序：`disabled_toolsets: [browser]` 必须能从 `hermes-cli` 这类复合包里把 web_search 也剥掉（#17309、#64503），所以"最后减"是语义的一部分。平台包名出现在 disabled 里只会剥非核心增量并告警（`bundle_non_core_tools`）。

2. **check_fn 过滤**：`registry.get_definitions(tools_to_include, ...)` 用每个工具的可达性检查函数（service-gated：没配 API key 的工具不出现）。
3. **动态 schema 重写**：`_DYNAMIC_SCHEMA_REWRITERS`（行 487）是 `工具名 → 重写函数` 的表——`execute_code` 只列出本会话真正可用的沙箱工具、discord 按 intents 出 schema、`delegate_task` 描述里的"子代理禁用工具"列表裁剪到本会话确实存在的名字，重写函数返回 `None` 表示整个工具从面上消失。
4. **schema 消毒 + Tool Search 折叠**：`sanitize_tool_schemas` 归一化 llama.cpp 语法转换器拒绝的形状；然后 Tool Search（渐进式披露）把超预算的 MCP/插件工具折叠成 `tool_search/tool_describe/tool_call` 桥。

**缓存纪律**是这一节的另一半：

```python
# model_tools.py:268-270
    # Always a shallow copy: run_agent appends memory/LCM schemas to its list; a
    # shared list would accumulate duplicate names (HTTP 400 from DeepSeek/Kimi/MiMo).
    return list(cached)
```

缓存键（`_tool_defs_cache_key`，行 273）覆盖：registry 代数 `_generation`、check_fn cache epoch、config.yaml 的版本指纹、kanban 上下文、委派上下文、profile scope。容量上限 8 条 FIFO（长命网关的热工作集）。**必须返回浅拷贝**：网关长进程里各 agent init 共享同一列表、又各自往里 append 记忆工具 schema，曾经累积出重复工具名，强制唯一工具名的 provider（DeepSeek、小米 MiMo、Moonshot Kimi）直接 HTTP 400（issue #17335）。另外每条缓存条目带 check_fn 判决窗过期时间——MCP 服务器掉线重连不重注册的场景不能被缓存永久藏住。

### 3. 派发管线：handle_function_call（行 897）

```python
# model_tools.py:897-921（节选）
def handle_function_call(
    function_name: str, function_args: dict[str, Any], task_id=None, tool_call_id=None, session_id=None,
    turn_id=None, api_request_id=None, user_task=None, enabled_tools=None,
    skip_pre_tool_call_hook: bool = False, skip_tool_request_middleware: bool = False,
    skip_tool_execution_middleware: bool = False, tool_request_middleware_trace=None,
    enabled_toolsets=None, disabled_toolsets=None, conversation_id=None,
) -> str:
    """Route a tool call through hooks/middleware to the registry; returns a JSON string."""
    function_args = coerce_tool_args(function_name, function_args)
    if not isinstance(function_args, dict):
        function_args = {}
    trace = list(tool_request_middleware_trace or [])
    function_name = _LEGACY_TOOL_ALIASES.get(function_name, function_name)
    ids = _CallIds(task_id, session_id, tool_call_id, turn_id, api_request_id, conversation_id)
```

完整管线（自上而下）：

| 步 | 做什么 | 代码 |
|---|---|---|
| 1 | 参数类型矫正 `coerce_tool_args`（模型把数组发成字符串等） | 行 914 |
| 2 | 旧名别名 `_LEGACY_TOOL_ALIASES`（行 633：todo 旧名→todo_list、`cronjob`→`cronjob_manage`…），旧会话/存档提示词继续可用 | 行 918 |
| 3 | Tool Search 桥 `_dispatch_bridge_tool`（行 724）：`tool_search`/`tool_describe` 是目录读；`tool_call` 解包成真工具名**递归重入**本函数，让下游钩子永远看到真名 | 行 931-948 |
| 4 | connectors 门控：`connectors__<c>__<t>` 命名与 `manage_connections` 必须在本会话工具面上 | 行 950-956 |
| 5 | tool_request 中间件（可改参、fail-open） | 行 958-960 |
| 6 | `_AGENT_LOOP_TOOLS` 拦截（见下） | 行 963 |
| 7 | pre_tool_call 插件钩子（可拦截/改参，单发契约）+ ACP 编辑审批 | `_pre_dispatch_guards` 行 789 |
| 8 | `_execute_tool`：绑定审批可观测上下文，经 tool-execution 中间件进 `registry.dispatch`；异步 handler 经 `_run_async` 跑在**每线程持久事件循环**上（缓存 httpx/AsyncOpenAI 客户端绑定活循环，避免 "Event loop is closed"） | 行 846-870 |
| 9 | post_tool_call 观察钩子（状态/错误字段从结果推导，受 `suppress_post_tool_call_hook` 抑制） | `_emit` 行 922 |
| 10 | transform_tool_result：插件可替换最终结果字符串；第一个字符串返回值生效 | 行 985 |

错误路径做**净化与截断**：

```python
# model_tools.py:652-661
def _sanitize_tool_error(error_msg: str) -> str:
    """Strip structural framing tokens from a tool error before the model sees it."""
    if not error_msg:
        return "[TOOL_ERROR] "
    sanitized = error_msg
    for pattern in _TOOL_ERROR_STRIP_RES:
        sanitized = pattern.sub("", sanitized)
    if len(sanitized) > _TOOL_ERROR_MAX_LEN:
        sanitized = sanitized[:_TOOL_ERROR_MAX_LEN - 3] + "..."
    return f"[TOOL_ERROR] {sanitized}"
```

`_TOOL_ERROR_STRIP_RE` 剥掉 `</tool_call>`、CDATA、代码围栏等结构性记号（防止异常文本诱导模型注入），长度上限 `_MAX_TOOL_ERROR_CHARS = 2048` 与 `tools/registry.py` 共享同一常量，保证文本不会"两次截断两个标记"。

### 4. `_AGENT_LOOP_TOOLS` 与 inline 拦截

```python
# model_tools.py:629
_AGENT_LOOP_TOOLS = {"todo_list", "memory", "session_search", "delegate_task"}
```

这 4 个工具需要 agent 级状态（todo 存储、记忆管理器、会话检索、子代理），若落到 `handle_function_call` 会返回 stub 错误。真正的执行者在 `agent/inline_tool_executors.py`：

```python
# agent/inline_tool_executors.py:291,352
_RAW_INLINE_TOOL_EXECUTORS: dict[str, InlineToolExecutor] = {
    "todo_list": _tool("tools.todo_tool", "todo_tool", ...),
    ...
}
INLINE_TOOL_EXECUTORS: dict[str, InlineToolExecutor] = {
    name: _coerced(name, executor) for name, executor in _RAW_INLINE_TOOL_EXECUTORS.items()
}
```

这张约 20 项的表在 agent 循环内**先行拦截**工具调用（顺序即历史 if/elif 顺序），根本不会进入 `handle_function_call`；`_AGENT_LOOP_TOOLS` 是派发侧的防御网。

### 5. `agent.tools` 一次定死与 `_last_resolved_tool_names`

- agent init 时组面一次（`agent/agent_init.py:1019`）：`agent.tools = agent_tool_surface(agent, model_tools.get_tool_definitions(...))`。此后每个 API 请求发送的是它的（按传输格式装饰的）副本——`agent/chat_completion_helpers.py` 里的 `tools_for_api`。这正是"会话期不换工具集"缓存不变量的实现点。
- `_last_resolved_tool_names`（行 175）是**进程全局快照**：`execute_code` 沙箱用它决定可编程调用哪些工具。子代理运行前后由 delegate 管线保存/恢复——`tools/delegate_tool.py::_run_single_child` 的执行链在 `tools/delegate_tool_results.py:320` 保存 `list(model_tools._last_resolved_tool_names)`、在 `tools/delegate_tool_child_run.py:1145` 恢复——否则子代理会把父会话的工具面覆盖成自己的，父进程后续的 `execute_code` 视野被污染。

## 核心类/函数

| 名称 | 位置 | 职责 |
|---|---|---|
| `discover_builtin_tools()`（模块级执行） | model_tools.py:151（定义 tools/registry.py:121） | 导入即注册；AST 预过滤 + 磁盘缓存 ~145ms |
| `get_tool_definitions` | model_tools.py:227 | 组面入口；quiet 模式带 8 条上限的 memo |
| `_select_tool_names` | model_tools.py:333 | enabled 并集 → disabled 最后减（#17309） |
| `_apply_toolset_selection` | model_tools.py:300 | 单个 toolset 名解析进/出集合；平台包告警 |
| `_DYNAMIC_SCHEMA_REWRITERS` | model_tools.py:487 | 按会话可用面重写 8 个工具的 schema |
| `_compute_tool_definitions` | model_tools.py:522 | 未缓存管线：选名→check_fn→重写→消毒→Tool Search |
| `handle_function_call` | model_tools.py:897 | 10 步派发管线，返回 JSON 字符串 |
| `_dispatch_bridge_tool` | model_tools.py:724 | Tool Search 桥（目录读 / tool_call 解包重入） |
| `_execute_tool` | model_tools.py:846 | 经中间件进 registry.dispatch；connectors 分流 |
| `_run_async` | model_tools.py:95 | 同步代码跑协程；主线程持久循环 / worker 线程本地循环 |
| `_sanitize_tool_error` | model_tools.py:652 | 剥结构记号 + 截断 2048 |
| `_AGENT_LOOP_TOOLS` | model_tools.py:629 | 4 个必须由 agent 循环执行的工具 |
| `_LEGACY_TOOL_ALIASES` | model_tools.py:633 | 旧工具名 → 新名 |
| `_last_resolved_tool_names` | model_tools.py:175 | execute_code 沙箱用的进程级工具面快照 |
| `get_all_tool_names` 等直通函数 | model_tools.py:998-1018 | registry 兼容 pass-through |

## 本组文件清单

| 文件 | 行数 | 角色 |
|---|---|---|
| model_tools.py | 1,018 | 编排门面：发现/组面/派发 + registry 直通 |
| tools/registry.py | ~1,100 | `registry` 注册表本体、`discover_builtin_tools`（:121）、`register`（:735） |
| tools/arg_coercion.py | ~200 | `coerce_tool_args` 参数矫正 |
| tools/schema_sanitizer.py | ~100 | llama.cpp 兼容的 schema 归一化 |
| tools/tool_search.py | 大 | 渐进式披露：`assemble_tool_defs` 与桥派发 |
| tools/connectors/__init__.py | ~100 | `is_connector_name` / `dispatch_connector_call` / 批量派发 |
| tools/todo_tool.py | 大 | `TODO_LEGACY_ALIASES`、`TODO_SCHEMA`（别名表来源） |
| agent/inline_tool_executors.py | ~380 | INLINE_TOOL_EXECUTORS（:291/:352）：agent 循环内联执行 |
| tools/delegate_tool.py | ~1,500 | delegate_task 实现；`_run_single_child`（:377） |
| tools/delegate_tool_results.py | ~400 | 子代理结果装配；保存 `_last_resolved_tool_names`（:320） |
| tools/delegate_tool_child_run.py | ~1,200 | 子代理运行体；恢复快照（:1145） |

## 与其他模块的关系

- **toolsets.py**：`_select_tool_names` 通过 `resolve_toolset`/`bundle_non_core_tools` 把工具集名字变成工具名字集合（见 [toolsets.md](toolsets.md)）。
- **agent/agent_init.py**：init 时调用组面一次；`agent.tools` 从此冻结。
- **agent/tool_executor.py / inline_tool_executors.py**：派发的两个消费者（一个走 `handle_function_call`，一个绕过它）。
- **hermes_cli/plugins.py**：pre/post_tool_call、transform_tool_result 钩子的宿主。

## 总结

- 本文件是"注册表之上的薄层"：薄，但三条管线各自承载了硬教训——MCP 发现不能在导入期跑（#16856）、disabled 必须最后减（#17309）、缓存必须吐浅拷贝（#17335）。
- 派发管线是安全边界汇聚处：别名、桥解包、门控、中间件、审批钩子、错误净化，全部在模型看到结果之前完成。
- `agent.tools` init 定死 + `_last_resolved_tool_names` 子代理前后保存恢复，是"会话工具面稳定"不变量的两块基石。
