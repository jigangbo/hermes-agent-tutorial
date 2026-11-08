# toolsets.py —— 三层工具集与平台包的静态契约表

> 阅读前提：[model_tools.md](model_tools.md)。工具集是"名字 → 工具名集合"的**纯数据层**；组面管线在 model_tools。

## 文件概览

`toolsets.py`（507 行）+ `toolset_distributions.py`（106 行）。前者是全仓库共享的工具集定义与解析器，后者服务于批量数据生成（batch_runner）时的概率采样。两个文件都是"契约表"——改这里的名字会直接改变每个会话携带的工具面。

## 关键代码走读

### 1. 核心工具清单 `_HERMES_CORE_TOOLS`（行 11）

```python
# toolsets.py:11-36（节选）
_HERMES_CORE_TOOLS = [
    "web_search", "web_extract",
    "terminal", "process_manage",
    "read_file", "write_file", "patch", "search_files",
    "vision_analyze", "image_generate",
    "skills_list", "skill_view", "skill_manage",
    "browser_exec",  # THE browser: Python over CDP (browser-harness)
    "browser_cdp", "browser_dialog",
    "browser_vault",  # rides with the browser; deferred by default (tools.tool_search.defer)
    "text_to_speech",
    "todo_list", "memory",
    "session_search",
    "clarify",
    "execute_code", "delegate_task",
    "cronjob_manage",
    "kanban_show", "kanban_list",
    ...
    "computer_use",
    # Service-gated connector account status and authorization links.
    "manage_connections",
]
```

41 个核心工具。注释里点明两条设计：桌面 GUI 专属工具**不**在这里（它们住 `desktop_ui`/`project`，由 GUI 网关按会话来源启用）；`manage_connections` 是 service-gated 的连接器账户面。

配套的还有两个小集合：

```python
# toolsets.py:38-39
# Webhook payloads are untrusted third-party content: no file/system execution.
_HERMES_WEBHOOK_SAFE_TOOLS = ["web_search", "web_extract", "vision_analyze", "clarify"]
```

webhook 载荷是不可信第三方内容，`hermes-webhook` 工具集只带这 4 个不碰文件/系统的工具——这是"输入不可信 → 缩工具面"的安全样板。

### 2. 构建器 `_ts` / `_bundle` / `_core_without`（行 46-58）

```python
# toolsets.py:46-58
def _ts(description, tools=(), includes=(), **extra):
    """One TOOLSETS entry (fresh lists per entry; extra keys such as posture pass through)."""
    return {"description": description, "tools": list(tools), "includes": list(includes), **extra}


def _bundle(description, extras=()):
    """A `hermes-*` platform bundle: the shared core tools plus optional platform extras."""
    return _ts(description, _HERMES_CORE_TOOLS + list(extras))


def _core_without(*excluded, kanban=True):
    """_HERMES_CORE_TOOLS minus *excluded* (and, unless kanban=True, every kanban_* tool); order preserved."""
    return [t for t in _HERMES_CORE_TOOLS if t not in excluded and (kanban or not t.startswith("kanban_"))]
```

三个小构建器保证 22 个平台包**共享同一份核心清单**（"edit once, all platforms follow"），平台 extras 只做增量。`posture=True` 这类额外键从 `**extra` 透传——`coding` 工具集用它标记"每会话姿态，绝不自动回收进平台工具配置"。

### 3. TOOLSETS 字典与三层结构（行 70）

```python
# toolsets.py:70-181（节选）
TOOLSETS = {
    # Basic toolsets - individual tool categories
    "web": _ts("Web research and content extraction tools", ["web_search", "web_extract"]),
    "terminal": _ts("Terminal/command execution and process management tools", ["terminal", "process_manage"]),
    ...
    # Scenario-specific toolsets
    "debugging": _ts("Debugging and troubleshooting toolkit", ["terminal", "process_manage"], includes=["web", "file"]),
    "safe": _ts("Safe toolkit without terminal access", [], includes=["web", "vision", "image_gen"]),
    "coding": _ts(
        "Coding-focused toolset: files, terminal, search, web docs, skills, todo, delegate, vision, browser",
        _CODING_TOOLS,
        posture=True,
    ),
    # Full Hermes toolsets (CLI + messaging platforms). All share the core tools;
    # there is deliberately no agent-callable send_message tool. hermes-acp is the
    # coding posture minus the interactive clarify UI.
    "hermes-acp": _ts("Editor integration (VS Code, Zed, JetBrains) ...",
                      [t for t in _CODING_TOOLS if t != "clarify"]),
    "hermes-cli": _bundle("Full interactive CLI toolset - all default tools plus cronjob management"),
    "hermes-telegram": _bundle("Telegram bot toolset - full access for personal use (terminal has safety checks)"),
    "hermes-discord": _bundle("Discord bot toolset - full access ...", ["discord", "discord_admin"]),
    ...
    "hermes-webhook": _ts("Webhook toolset - receive and process external webhook events", _HERMES_WEBHOOK_SAFE_TOOLS),
    "hermes-gateway": _ts("Gateway toolset - union of all messaging platform tools", [],
                          includes=["hermes-telegram", "hermes-discord", ...]),
}
```

条目形状是 `name → {description, tools, includes, posture?, platforms?}`。三层结构：

1. **基础分类组**：`web`、`terminal`、`file`、`vision`、`skills`、`todo`、`memory`、`cronjob`、`browser` 等——单一类别。
2. **场景复合组**：`debugging` / `safe` / `coding`，靠 `includes` 组合基础组；`coding` 用 `_CODING_TOOLS`（`_core_without("image_generate", "text_to_speech", "cronjob_manage", "computer_use", kanban=False)`）并带 `posture=True`。
3. **平台包（22 个）**：`hermes-cli`、`hermes-cron`、`hermes-telegram`、`hermes-discord`、`hermes-whatsapp`、`hermes-slack`、`hermes-signal`、`hermes-bluebubbles`、`hermes-email`、`hermes-mattermost`、`hermes-matrix`、`hermes-dingtalk`、`hermes-feishu`、`hermes-weixin`、`hermes-qqbot`、`hermes-wecom`、`hermes-wecom-callback`、`hermes-sms`、`hermes-webhook`、`hermes-gateway`、`hermes-acp`、`hermes-api-server`。除 `hermes-acp`（coding 姿态去掉 clarify）与 `hermes-api-server`（`_core_without`）外都用 `_bundle`。注释里有一条刻意设计：**没有 agent 可调用的 send_message 工具**——回信是各适配器的职责，不是模型的。

### 4. 客户端自加工具集 `CLIENT_SURFACE_TOOLSETS`（行 67）

```python
# toolsets.py:65-67
# Toolsets a CLIENT adds to its own sessions (tui_gateway/server.py::_gui_surface_toolsets), never
# config: another surface lacking them made no configuration choice.
CLIENT_SURFACE_TOOLSETS = frozenset({"project", "desktop_ui", "catalog"})
```

这三个（`project`、`desktop_ui`、`catalog`）由桌面客户端给**自己来源的会话**加，从不走 config.yaml——另一个界面没有它们，不代表用户选择了关掉它们。`platforms=frozenset({"desktop"})` 键（`onboarding`、`catalog`）进一步把这些工具集绑定到 desktop 平台；`TOOLSET_SESSION_PLATFORMS`（行 236）把带 `platforms` 的条目汇成索引，`session_platform_tool_drops` / `session_disabled_toolsets`（行 441/447）据此算出"本平台会话拿不到哪些工具"。

### 5. 递归解析与 memo：resolve_toolset（行 355）

```python
# toolsets.py:355-399（节选）
def resolve_toolset(name: str, visited: set[str] | None = None, *, include_registry: bool = True) -> list[str]:
    """Recursively resolve a toolset (and its includes) to a sorted tool-name list."""
    external_call = visited is None
    if external_call:
        memo_key = (name, include_registry, *_registry_generation(), _registry_call("current_scope_key", ""))
        cached = _resolve_toolset_memo.get(memo_key)
        if cached is not None:
            return list(cached)
        visited = set()

    # "all"/"*" span every toolset so new toolsets are included automatically, ...
    if name in {"all", "*"}:
        ...
    # Diamond include or cycle: [] silently — the tools are collected via another path.
    if name in visited:
        return []
    visited.add(name)

    toolset = get_toolset(name, include_registry=include_registry)
    if not toolset:
        return _plugin_platform_bundle(name) if include_registry else []

    tools = set(toolset.get("tools", []))
    for included_name in toolset.get("includes", []):
        tools.update(resolve_toolset(included_name, visited, include_registry=include_registry))
    result = sorted(tools)
    if external_call:
        if len(_resolve_toolset_memo) >= 256:  # stale-generation entries are never hit again
            _resolve_toolset_memo.clear()
        _resolve_toolset_memo[memo_key] = list(result)
    return result
```

四件事：递归展开 `includes`（菱形/环靠 `visited` 静默去重）；`all`/`*` 跨所有工具集（平台门控的除外）；memo 键含 `(registry id, 代数, profile scope)`——多路复用进程按 profile 解析 `mcp-<server>`，没有 scope 键时 profile B 会拿到 profile A 的工具名（#106005）；memo 满 256 条整体清空（旧代数条目永不再命中）。

### 6. 插件扩展与 distribution 文件

- 插件/MCP 经 `_registry()`（行 244）把工具注册进某个工具集；`get_toolset(include_registry=True)` 合并这部分，MCP 服务器与内建工具集重名（如 "browser"）时靠 alias union 补齐（行 288-294）。`validate_toolset`（行 486）与 `create_custom_toolset`（行 491）供运行时注册新名字。
- `toolset_distributions.py` 是批量数据生成的概率表：

```python
# toolset_distributions.py:18-19,67-93（节选）
DISTRIBUTIONS = {
    "default": _dist("All available tools, all the time", web=100, vision=100, image_gen=100, terminal=100, file=100, browser=100),
    ...
    "browser_tasks": _dist(
        "Browser-focused distribution with web_search for finding URLs ...",
        **{"browser+search": 97}, vision=12, terminal=15,
    ),
}

def sample_toolsets_from_distribution(distribution_name: str) -> list[str]:
    """Sample toolset names, each entry included independently with its % probability.

    An entry may be a single toolset or a "+"-grouped compound like
    "browser+search": one roll selects (or skips) every member together, ...
    """
```

条目 = `工具集名 → 启用概率%`，独立采样；`"browser+search"` 复合键**一次掷骰**决定整组（两个独立 97% 的同现概率只有 ~94%）。全没掷中时回退到概率最高的条目。消费者是 `batch_runner.py`（`--distribution` 参数）。

## 核心类/函数

| 名称 | 位置 | 职责 |
|---|---|---|
| `_HERMES_CORE_TOOLS` | toolsets.py:11 | 41 个核心工具（CLI 与全部平台共享） |
| `_HERMES_WEBHOOK_SAFE_TOOLS` | toolsets.py:39 | webhook 不可信输入的 4 工具白名单 |
| `_ts` / `_bundle` / `_core_without` | toolsets.py:46/51/56 | 条目构建器 |
| `TOOLSETS` | toolsets.py:70 | 静态工具集字典（三层） |
| `TOOLSET_SESSION_PLATFORMS` | toolsets.py:236 | 平台门控索引 |
| `BUILTIN_TOOL_NAMES` / `BUILTIN_TOOLSET_NAMES` | toolsets.py:240-241 | 用户自定义之前捕获的内置名字（共享指标只能导出这些） |
| `CLIENT_SURFACE_TOOLSETS` | toolsets.py:67 | 客户端自加、不走 config 的 3 个工具集 |
| `get_toolset` | toolsets.py:266 | 定义查询；include_registry 合并插件注册与 alias |
| `resolve_toolset` | toolsets.py:355 | 递归解析 + memo（含 profile scope） |
| `bundle_non_core_tools` | toolsets.py:310 | 平台包禁用时的"非核心增量" |
| `session_platform_tool_drops` / `session_disabled_toolsets` | toolsets.py:441/447 | 平台/oneshot 会话的工具削减 |
| `agent_tool_surface` / `agent_tool_drops` | toolsets.py:474/467 | agent 实际携带的工具面 |
| `validate_toolset` / `create_custom_toolset` | toolsets.py:486/491 | 校验与运行时注册 |
| `get_toolset_info` | toolsets.py:496 | `hermes --list-toolsets` 的展示数据 |
| `DISTRIBUTIONS` / `sample_toolsets_from_distribution` | toolset_distributions.py:18/67 | 批量跑的概率分布与采样 |

## 本组文件清单

| 文件 | 行数 | 角色 |
|---|---|---|
| toolsets.py | 507 | 工具集契约表 + 解析器（本文主体） |
| toolset_distributions.py | 106 | 批量数据生成的工具集概率分布 |

## 与其他模块的关系

- **model_tools.py**：`_select_tool_names` 是 `resolve_toolset` 最大的消费者；disabled"最后减"语义在两侧配合实现。
- **agent/agent_init.py**：init 时经 `agent_tool_surface` / `session_disabled_toolsets` 得到本会话最终工具面。
- **tui_gateway/server.py**：GUI 网关按会话来源折叠 `desktop_ui`/`project` 等客户端面。
- **agent/coding_context.py**：代码工作区自动选 `coding` 姿态。
- **batch_runner.py**：`toolset_distributions` 的唯一运行时消费者。

## 总结

- 三层工具集（分类组 / 场景复合组 / 平台包）+ 一份共享核心清单，让"每个平台缺什么"变成一行 `_bundle` 增量。
- 安全语义藏在数据里：webhook 白名单、`platforms` 门控、`posture` 标记、没有 send_message 工具。
- 解析器带 memo 与代数/ profile 键，是静态表之外唯一的"活"部分；插件通过 registry 注入而非改这张表。
