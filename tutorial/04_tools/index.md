# tools/ 模块总览 —— 模型工具子系统

## 文件概览

`tools/` 是 Hermes 的「工具箱」：模型（LLM）能调用的每一个能力——读写文件、跑终端命令、开浏览器、发消息、设闹钟——都以一个 Python 函数的形式住在这里。本目录有 300 多个文件，但组织方式极其规律：**每个工具一个文件（或一个子包），每个文件在 import 时把自己注册进一张全局登记表**，剩下的交给 `model_tools.py`（调度入口）和 `toolsets.py`（分组清单）两个门外汉。理解了「注册 → 发现 → 过滤 → 调度」这条主线，几百个文件就不再是散沙，而是一条流水线上、按功能分组的零件。本篇是第 04 章的总览，后续 12 篇分主题拆解每个工具组。

## 工具注册三步曲

Hermes 的工具注册**不使用装饰器**，而是「import 时自注册」（self-registration at import）。整个流程分三步：

**第一步：import 时自注册。** `tools/registry.py` 是一个零依赖的叶子模块，里面有一个全局单例 `registry`。每个工具文件在模块末尾直接调用 `registry.register(...)` 声明自己的名字、schema（JSON 参数说明书）、处理函数、所属 toolset 和可用性检查函数。以终端工具为例：

```python
# 来源：tools/terminal_tool.py:1750-1758
registry.register(
    name="terminal",
    toolset="terminal",
    schema=TERMINAL_SCHEMA,
    handler=_handle_terminal,
    check_fn=check_terminal_requirements,
    emoji="💻",
    max_result_size_chars=100_000,
)
```

也就是说：**只要一个 `tools/*.py` 顶层有 `registry.register(...)` 调用，它就会被自动发现并 import——没有任何手工维护的 import 清单**。

**第二步：`discover_builtin_tools()` AST 扫描 + 磁盘缓存。** `model_tools.py` 在被 import 时（模块级一行 `discover_builtin_tools()`）触发发现。逐个文件跑 AST 解析太慢（约 100 个文件要 ~145ms），所以先用一个廉价的文本预过滤，再用 AST 精确判断「模块体是否有顶层 `registry.register` 调用」，并把判定结果按 `(mtime_ns, size)` 缓存到 `~/.hermes/cache/tool_discovery_cache.json`，文件没变就直接用缓存：

```python
# 来源：tools/registry.py:121-125
def discover_builtin_tools(tools_dir: Optional[Path] = None) -> list[str]:
    """Import built-in self-registering tool modules and return their module names. The
    per-file AST scan costs ~145 ms over ~100 files, so verdicts are memoized on disk keyed
    by ``(mtime_ns, size)``; a mismatch or corrupt cache re-scans that file. The write is
    best-effort and atomic, so concurrent processes race harmlessly."""
```

**第三步：toolsets 过滤。** 注册 ≠ 暴露。`toolsets.py` 里有一份手写的 `_HERMES_CORE_TOOLS` 清单（41 个核心工具），工具只有在某个 toolset 点名时才会真正出现在模型的工具列表里。每个平台（CLI、Telegram、桌面……）启用哪些 toolset，可以再按 config.yaml 的 `tools.<platform>.enabled/disabled` 增删。

值得注意的一个「反例」：**MCP 发现故意不在 `model_tools.py` import 时运行**。因为它内部有一个最长 120 秒的阻塞等待，而网关是在事件循环里懒加载这个模块的，会冻住 Telegram/Discord 的心跳（issue #16856）。所以每个入口（gateway、cli、tui_gateway）都在自己的启动路径上另行触发 MCP 发现：

```python
# 来源：model_tools.py:167-171
# --- Tool discovery (importing each tools/*.py triggers registry.register) ---
discover_builtin_tools()

# MCP discovery is deliberately NOT run here: it blocks up to 120 s and the
# gateway lazy-imports this module inside its event loop; each entry point
# (gateway/run.py, cli.py, tui_gateway, acp_adapter) runs it at startup.
```

## ASCII 架构图

```
                ┌──────────────────────────────────────────────────────┐
                │                    agent loop (agent/turn_*.py)      │
                │   模型返回 tool_call ──► handle_function_call()        │
                └───────────────────────────────┬──────────────────────┘
                                                │
                     ┌──────────────────────────▼─────────────────────────┐
                     │                model_tools.py（调度门面）            │
                     │  get_tool_definitions()      每轮把 schema 发给模型   │
                     │  handle_function_call()      参数纠偏 → 守卫 → 派发  │
                     │  _AGENT_LOOP_TOOLS 拦截 todo/memory/session_search/  │
                     │                     delegate_task（代理循环自答）     │
                     └───────────────┬───────────────────────┬────────────┘
                                     │                       │
             注册（import 时自注册）    │                       │ 调用 handler(args)
        ┌────────────────────────────▼───────┐               │
        │        tools/registry.py           │               │
        │  registry.register()  ToolEntry    │               │
        │  check_fn 可用性探测（30s TTL 缓存）  │               │
        │  profile 覆盖层 / 冲突仲裁           │               │
        └────────────────────────────▲───────┘               │
                                     │                       │
      ┌──────────────────────────────┴───────────────────────▼───────────┐
      │                        tools/*.py（300+ 文件，按组分层）            │
      │  file_tools / terminal_tool(+environments/) / browser_use_cli    │
      │  web_tools / mcp_tool_* / delegate_tool_* / tts_tool / cronjob…  │
      └──────────────────────────────────────────────────────────────────┘
```

数据流一句话：**启动时** `model_tools.py` import → 发现所有自注册工具 → 按 toolset 过滤出 schema 列表；**每一轮对话** schema 随请求发给模型 → 模型回一个 tool_call → `handle_function_call()` 找到对应 `ToolEntry` → 调 handler → 返回 JSON 字符串作为工具结果。

## 四个贯穿全模块的机制

**1. profile 作用域覆盖层（scoped overlay）。** 一个进程可能同时服务多个 profile（多路复用网关）。`registry` 里除了进程全局的 `_tools`，还有按 `HERMES_HOME` 分桶的 `_scoped_tools`；此外 `session_tool_scope()` 提供「执行期」叠加层——某个会话临时多出的工具（如 tool search 桥接出来的延迟工具）只在本会话可见：

```python
# 来源：tools/registry.py:30-37
@contextmanager
def session_tool_scope(scope):
    """Execution-owned overlay, additive to the existing profile registry."""
    token = _session_tool_scope.set(scope)
    try:
        yield
    finally:
        _session_tool_scope.reset(token)
```

**2. check_fn 门控。** 每个工具可带一个 `check_fn`，回答「这个工具在我的环境里可达吗/用户 opt-in 了吗」（比如 Docker 没装、API key 没配）。结果按 `(函数, profile 键)` 做 30 秒 TTL 缓存，探测必须通过 `agent.secret_scope.get_secret` 读密钥而不是裸 `os.getenv`——一个进程服务多个 profile 时，裸读环境变量会把启动 profile 的密钥泄露给所有人。探测在 60 秒宽限期内的一次失败视为抖动，继续暴露工具而不是瞬间抽走整个 toolset。

**3. 冲突策略。** 同名注册默认被拒绝：跨 toolset 遮蔽需要显式 `override=True`；插件要覆盖内置工具，除了 `override=True` 还需要操作者在 config.yaml 里写 `plugins.entries.<插件id>.allow_tool_override: true`，否则抛 `PermissionError`。这是注册表内置的授权记录，防止第三方插件悄悄替换你的 `terminal`。

**4. agent 循环拦截。** 有四个工具根本不经过注册表派发——`todo_list`、`memory`、`session_search`、`delegate_task`。它们需要读写 agent 自身的状态，所以由 `agent/inline_tool_executors.py` 在循环里直接执行；`handle_function_call()` 见到它们只会返回一句「必须由 agent loop 处理」的错误：

```python
# 来源：model_tools.py:628-629, 962-964
# Intercepted by the agent loop (need agent-level state); dispatch returns a stub error.
_AGENT_LOOP_TOOLS = {"todo_list", "memory", "session_search", "delegate_task"}
...
        if function_name in _AGENT_LOOP_TOOLS:
            return tool_error(f"{function_name} must be handled by the agent loop")
```

## 目录导览

| 主题 | 代表文件 | 深入篇目 |
|---|---|---|
| 注册与基础设施 | `registry.py`、`tool_search.py`、`tool_output_truncate.py` | [registry.md](registry.md) |
| 审批与安全 | `approval.py`、`threat_patterns.py`、`url_safety.py` | [approval_safety.md](approval_safety.md) |
| 文件与终端 | `file_tools.py`、`terminal_tool.py`、`environments/` | [file_terminal.md](file_terminal.md)、[environments.md](environments.md) |
| 浏览器与网页 | `browser_use_cli.py`、`browser_session.py`、`web_tools.py` | [web_browser.md](web_browser.md) |
| GUI 自动化 | `computer_use/`、`bot_desktop/`、桌面桥接工具 | [computer_use.md](computer_use.md) |
| MCP 客户端 | `mcp_tool.py` + 26 个兄弟模块 | [mcp.md](mcp.md) |
| 子代理委派 | `delegate_tool.py` + 兄弟模块 | [delegation_tools.md](delegation_tools.md) |
| 服务连接器 | `connectors/` 子包 | [connectors.md](connectors.md) |
| 技能/记忆/澄清 | `skills_tool.py`、`memory_tool.py`、`todo_tool.py` | [skills_memory.md](skills_memory.md) |
| 语音与媒体 | `tts_tool.py`、`transcription_tools.py`、`wake_word.py` | [voice_media.md](voice_media.md) |
| 消息与定时 | `send_message_tool.py`、`cronjob_tools.py`、`kanban_tools.py` | [messaging_cron.md](messaging_cron.md) |

## 阅读顺序建议

- **第一遍（打地基）**：index → registry → approval_safety。这三篇读懂，「工具从哪来、怎么被拦、怎么被批」就有了全貌。
- **第二遍（主干道）**：file_terminal → environments → delegation_tools。文件/终端是 agent 最高频的动作，委派是它「分身」的方式。
- **第三遍（外围能力）**：其余各篇按兴趣跳读。每篇独立成文，清单表可以当目录索引用。

每篇的结构是固定的：文件概览 → 关键代码走读（真实源码 + 文件:行号）→ 核心类/函数表 → 本组文件清单（每个文件一行）→ 与其他模块的关系 → 总结。代码片段全部摘自当前工作树的真实源文件，行号在重构后可能漂移，但函数名与逻辑是可靠的锚点。

## 与其他模块的关系

- `agent/`（回合循环）：拦截 `_AGENT_LOOP_TOOLS` 四兄弟；`agent/tool_executor.py` 里 `_MAX_TOOL_WORKERS = 8` 决定并行段的规模。
- `toolsets.py`：toolset 字典的唯一事实来源，`_HERMES_CORE_TOOLS` 是每个平台基础包的公共底座。
- `plugins/`：插件通过 `ctx.register_tool(...)` 注册工具，走的是同一张 registry 的 profile 覆盖层。
- `hermes_cli/` 与 `gateway/`：作为宿主，在各自启动时触发发现、按平台装载 toolset、把审批提示呈现给用户。

## 总结

tools/ 的精髓不在三百个文件的细节里，而在四个约定里：**import 即注册**（无需名单）、**AST 预过滤 + 磁盘缓存**让发现几乎免费、**toolset 点名才暴露**（注册和暴露是两回事）、**`_AGENT_LOOP_TOOLS` 永不进派发器**。加上 check_fn 的 30 秒缓存、跨 toolset/插件覆盖的双重确认，这套系统在「零维护成本加新工具」和「多 profile 多会话下的隔离与安全」之间取得平衡。下一篇我们从注册表本体 `tools/registry.py` 开始逐层拆解。
