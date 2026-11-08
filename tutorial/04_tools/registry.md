# registry.py —— 工具注册表与发现机制

## 文件概览

本篇深讲 `tools/registry.py`——整个工具子系统的地基。它是一个**零依赖叶子模块**（不 import 任何工具文件、也不 import model_tools），因此每个工具文件都可以在模块级安全地 `from tools.registry import registry` 而不产生循环导入。注册表负责四件事：收集工具元数据（`ToolEntry`）、发现并 import 自注册模块（AST 预过滤 + 磁盘缓存）、回答可用性（`check_fn` TTL 缓存）、以及在多 profile/多插件环境下的冲突仲裁。工具文件只需要认识一个函数 `registry.register()`；`model_tools.py` 则把注册表当成唯一事实来源，不再维护平行的数据结构。本篇同时给出「注册基础设施组」22 个文件的清单——它们是注册表和调度器的公共设施。

## 关键代码走读

### 1. 循环安全的 import 链

文件开头的 docstring 一句话讲清了整条链的方向：注册表是被依赖方，永远不反向依赖。

```python
# 来源：tools/registry.py:1-6
"""Central registry for all hermes-agent tools: each tool file calls ``registry.register()``
at import to declare schema, handler, toolset membership and availability check;
``model_tools.py`` queries the registry instead of keeping parallel data structures.
Cycle-safe import chain: this module imports nothing from model_tools or tool files;
tools/*.py import it at module level; model_tools.py imports both; run_agent/cli import
model_tools."""
```

记忆方式：`registry.py ← tools/*.py ← model_tools.py ← run_agent.py / cli.py`，箭头永远单向。

### 2. ToolEntry：一张工具的「户口本」

每个工具注册后成为一条不可变元数据。`eq=False` 让比较退化为 `is`（身份比较），`slots=True` 省内存——快照/恢复路径靠「同一个对象」判断条目是否还是当初那条：

```python
# 来源：tools/registry.py:215-233
@dataclass(eq=False, slots=True)
class ToolEntry:
    """Metadata for one registered tool (identity semantics: restore/CAS paths compare ``is``)."""

    name: str
    toolset: str
    schema: dict
    handler: Callable
    check_fn: Optional[Callable]
    requires_env: list
    is_async: bool
    description: str
    emoji: str
    max_result_size_chars: int | float | None = None
    # Zero-arg callable whose dict is shallow-merged onto the schema at every get_definitions()
    # — for fields tracking runtime config (delegate_task's description reflects limits).
    dynamic_schema_overrides: Optional[Callable] = None
    execution_timeout: float | None = None
```

`dynamic_schema_overrides` 值得注意：它是一个**每次取 schema 时都会被调用**的零参函数，把运行时配置（比如委派并发上限）浅合并进 schema——这样模型看到的描述永远是活的。

### 3. AST 预过滤：谁才是工具模块

发现不是无脑 import 目录下所有文件，而是先问「这个文件的**模块体**有没有 `registry.register(...)` 调用」。判定分两层：文本预过滤（不含 `registry`/`register` 两个词的文件直接跳过，省掉 parse），再 AST 精确匹配。只有模块体顶层的语句才算数——在函数体里注册的辅助模块会被跳过：

```python
# 来源：tools/registry.py:94-109
def _module_registers_tools(module_path: Path) -> bool:
    """True when the module body (or a module-level ``for``) calls ``registry.register(...)``.
    Only module-body statements count, so helpers registering inside a function are skipped;
    a text prefilter avoids ``ast.parse`` for files lacking both words."""
    try:
        source = module_path.read_text(encoding="utf-8-sig")
        if "registry" not in source or "register" not in source:
            return False
        tree = ast.parse(source, filename=str(module_path))
    except (OSError, SyntaxError):
        return False
    # Table-driven modules register several tools from one loop, still at import time.
    return any(
        _is_registry_register_call(stmt)
        or (isinstance(stmt, ast.For) and any(_is_registry_register_call(s) for s in stmt.body))
        for stmt in tree.body)
```

注意第二个分支：`for` 循环里逐个注册的「表驱动模块」（kanban 工具就是 17 个工具一个循环注册）也认定为工具模块。

### 4. 发现的候选与缓存

候选 = 平铺的 `tools/*.py` + 子包唯一的入口 `tools/<pkg>/tool.py`（`connectors/`、`computer_use/` 都靠这条规则注册）。排序必须稳定：`register()` 允许同名同 toolset 静默覆盖，导入顺序不能依赖文件深度。每个文件的判定结果按 `(mtime_ns, st_size)` 缓存进 `~/.hermes/cache/tool_discovery_cache.json`，并发进程竞写也无害（best-effort 原子写）：

```python
# 来源：tools/registry.py:112-118
def _tool_module_candidates(tools_path: Path) -> list[Path]:
    """Flat ``tools/*.py`` modules plus the package entry point ``tools/<pkg>/tool.py``, in one
    sorted list. Only ``tool.py`` is scanned in a package, so every other file in it is a library
    by construction. Sorted after merging: ``register()`` lets a same-name, same-toolset duplicate
    overwrite silently, so the import order must not depend on file depth."""
    candidates = list(tools_path.glob("*.py")) + list(tools_path.glob("*/tool.py"))
    return sorted(candidates)
```

发现主循环里还有三条豁免/守卫：`__init__.py`、`registry.py`、`mcp_tool.py` 跳过（MCP 自带懒发现）；子包没有 `__init__.py` 就告警跳过（setuptools 打 wheel 时会丢掉这种目录，工具会「在源码里能用、装好就消失」）。

### 5. check_fn 的 TTL 缓存与宽限期

`check_fn` 探测的是外部世界（Docker 在不在、密钥配没配），变化频率是人的秒级，所以结果缓存 30 秒。真正精妙的是**宽限期**：一个探测在成功后 60 秒内失败，视为抖动——继续暴露工具且**不缓存**这个 False（下次直查再探）。否则 Docker 一次超时就会让整个 toolset 从模型眼前消失，子代理会报出诡异的「Tool read_file does not exist」：

```python
# 来源：tools/registry.py:377-391（节选）
def _check_fn_cached(fn: Callable) -> bool:
    """Return bool(fn()), TTL-cached across calls."""
    now = time.monotonic()
    if fn in _NO_CACHE_CHECK_FNS:
        return _run_check_fn_uncached(fn)
    scope = check_fn_cache_scope()
    if scope == CHECK_FN_CACHE_BYPASS:
        return _run_check_fn_uncached(fn)
    cache_key = (fn, scope)
    with _check_fn_cache_lock:
        _prune_check_fn_caches(now)  # leaves only entries within TTL
        cached = _check_fn_cache.get(cache_key)
        if cached is not None:
            _note_verdict_expiry(cached[0] + _CHECK_FN_TTL_SECONDS)
            return cached[1]
```

缓存键是 `(fn, scope)`：`scope` 来自 `check_fn_cache_scope()`——多路复用时是当前 profile 的 home 路径，单 profile 时是 None（进程级缓存）。身份解析不出来就 fail closed（`CHECK_FN_CACHE_BYPASS`），宁可每次直查也不能把 A profile 的可用性判定张冠李戴给 B。

另一个防御是 `UnscopedSecretError` 的分类处理（`registry.py:346-374`）：启动期探测没有 profile 密钥作用域，读密钥按设计抛错，这是 DEBUG 日志；而调用方明明有作用域却还是失败，说明探测代码丢了作用域（spawn-site bug），保持 WARNING 大声报错。

### 6. 注册与冲突仲裁

`register()` 的冲突规则浓缩在一段：schema 先做形状校验（坏 schema 会在注册时就报错并点名，而不是请求时把整轮 API 打 400）；跨 toolset 遮蔽一律拒绝除非 `override=True`；插件遮蔽内置工具还要第二把钥匙 `allow_tool_override`：

```python
# 来源：tools/registry.py:777-799（节选）
            if existing and existing.toolset != toolset:
                if override:
                    if plugin_override_denied:
                        logger.error(
                            "Tool registration REJECTED: plugin %r attempted to override built-in "
                            "tool %r (existing toolset %r) without operator opt-in. Set "
                            "plugins.entries.<plugin_id>.allow_tool_override: true in config.yaml "
                            "to allow it.",
                            owner, name, existing.toolset)
                        raise PermissionError(_OVERRIDE_DENIED_MSG.format(owner=owner, name=name))
                    # Explicit opt-in (or non-plugin caller): INFO so the override is auditable.
                    logger.info(
                        "Tool '%s': toolset '%s' overriding existing toolset '%s' "
                        "(override=True opt-in)", name, toolset, existing.toolset)
                else:
                    # Reject every cross-toolset shadow (incl. MCP-to-MCP); same-toolset
                    # re-registration (MCP reconnect/refresh) stays allowed.
                    logger.error(
                        "Tool registration REJECTED: '%s' (toolset '%s') would shadow existing "
                        "tool from toolset '%s'. Pass override=True to register() if the "
                        "replacement is intentional, or deregister the existing tool first.",
                        name, toolset, existing.toolset)
                    return
```

三层记忆：**同 toolset 重注册放行**（MCP 重连刷新就是这么工作的）；**跨 toolset 需 `override=True`**；**插件再加 `allow_tool_override`**。

### 7. 三层注册表的合并顺序

`_merged_tools()` 揭示了查一个工具名时的优先级：**会话叠加层 > profile 覆盖层 > 进程全局**。全局是内置工具，profile 层是插件按 home 分桶的注册，会话层是 `session_tool_scope()` 临时挂上的工具：

```python
# 来源：tools/registry.py:532-537
    def _merged_tools(self, scope: Optional[str] = None) -> dict[str, ToolEntry]:
        """Return global tools overlaid with one profile's plugin tools."""
        entries = {**self._tools, **self._scoped_tools.get(hermes_home_key(scope), {})}
        if scope is None:
            entries.update(self._scoped_tools.get(_session_slot_key(), {}))
        return entries
```

字典合并的顺序即优先级：后面的键覆盖前面的。MCP 刷新会边写边被别的线程读，所以所有读都走 `_snapshot_state()`——先在 `RLock` 里拷一份快照再慢慢算。

## 核心类/函数

| 符号 | 职责 | 位置 |
|---|---|---|
| `registry`（`ToolRegistry` 单例） | 全局注册表；`register/deregister/get_definitions` 等全部入口 | `tools/registry.py:488` 起 |
| `ToolEntry` | 一条工具注册元数据（schema、handler、check_fn…），身份比较语义 | `tools/registry.py:215` |
| `register()` | 注册工具；schema 校验 + 三层冲突仲裁 + `_generation` 自增 | `tools/registry.py:735` |
| `discover_builtin_tools()` | 扫描候选模块、查缓存、import 自注册模块 | `tools/registry.py:121` |
| `_module_registers_tools()` | 文本预过滤 + AST 判定模块体是否有顶层 register 调用 | `tools/registry.py:94` |
| `_tool_module_candidates()` | 候选清单：`tools/*.py` + `tools/<pkg>/tool.py`，排序稳定 | `tools/registry.py:112` |
| `_load/_save_discovery_cache()` | 判定结果的磁盘缓存（`~/.hermes/cache/tool_discovery_cache.json`） | `tools/registry.py:188,201` |
| `session_tool_scope()` | 会话级工具叠加层的上下文管理器 | `tools/registry.py:30` |
| `_check_fn_cached()` | check_fn 的 30s TTL 缓存 + 60s 失败宽限 + profile 作用域键 | `tools/registry.py:377` |
| `invalidate_check_fn_cache()` | 配置变更后清空缓存并推进 epoch | `tools/registry.py:464` |
| `check_fn_verdict_window()` | 记录本次过滤所依赖判定的最早过期时间，防止过期结果被复用 | `tools/registry.py:292` |
| `no_cache_check_fn()` | 标记「本地配置型探测」不进缓存 | `tools/registry.py:281` |
| `deregister()` | 注销工具；插件注销他人工具需 opt-in；`mcp-*` toolset 豁免 | `tools/registry.py:814` |
| `restore_registration()` | 插件卸载时按 `is` 身份恢复宿主注册，不踩更新的条目 | `tools/registry.py:882` |
| `_merged_tools()` | 会话层 > profile 层 > 全局的三层合并 | `tools/registry.py:532` |

## 本组文件清单

注册基础设施组共 22 个文件，每一个的角色如下：

| 文件 | 一句话角色 |
|---|---|
| `tools/__init__.py` | 包命名空间；刻意保持无副作用——import `tools` 本身不得触发任何注册。 |
| `tools/registry.py` | 本篇主角：全局注册表、AST 发现、check_fn 缓存、冲突仲裁。 |
| `tools/arg_coercion.py` | 参数类型纠偏：模型按 JSON Schema 把数字/布尔发成字符串时，派发前自动修复。 |
| `tools/schema_sanitizer.py` | 给严格后端（如 llama.cpp 文法转换器）清洗 JSON schema 中它会噎住的写法。 |
| `tools/tool_labels.py` | 工具显示标签：给 UI/日志用的友好名称映射。 |
| `tools/tool_output_limits.py` | 可配置的工具输出截断上限（config.yaml 的 `tool_output` 段）。 |
| `tools/tool_output_truncate.py` | 超长输出的头/尾截断（终端、execute_code、MCP 结果共用）。 |
| `tools/tool_result_storage.py` | 大结果落盘持久化：与其截断丢信息，不如存文件给出路径，与截断分层配合。 |
| `tools/tool_search.py` | 渐进式工具披露：MCP/插件工具与策展集延迟到 `tool_call` 桥接按需取用。 |
| `tools/tool_search_catalog.py` | 延迟工具目录：对可延迟工具的 schema 做 BM25 检索。 |
| `tools/tool_search_validation.py` | `tool_call` 调用延迟工具前，在本地按其 schema 先行参数校验。 |
| `tools/tool_backend_helpers.py` | 后端选择的共享助手（含托管网关 provider 常量、密钥解析）。 |
| `tools/daemon_pool.py` | 共享的守护线程 ThreadPoolExecutor，给各工具的并发段复用。 |
| `tools/thread_context.py` | 把 agent 回合的上下文（profile、审批态）传播进派发工具的工作线程。 |
| `tools/interrupt.py` | 线程作用域的中断信号：打断一个工具不殃及别的线程。 |
| `tools/lazy_deps.py` | 压制旧版 updater 工作的垫片；新代码禁止使用。 |
| `tools/debug_helpers.py` | 每工具调试会话：置调试开关时把工具调用记录成 JSON 日志。 |
| `tools/interpreter_shutdown.py` | 判断解释器是否正在退出的共享谓词，给可能活得比进程久的后台线程用。 |
| `tools/budget_config.py` | 工具结果持久化的可配置预算常量。 |
| `tools/hook_output_spill.py` | 钩子注入的超大上下文溢写到磁盘，留一个带预览的占位符。 |
| `tools/spill_safety.py` | `~/.hermes` 下溢写/缓存文件的符号链接安全创建助手。 |
| `tools/ansi_strip.py` | 剥离子进程输出里的 ANSI 转义序列，别让它们进入模型上下文。 |

## 与其他模块的关系

- `model_tools.py`：注册表的**唯一门面**。`handle_function_call()` 是所有派发的入口；`get_tool_definitions()` 按注册表 `_generation` 和 check_fn epoch 记忆化。
- `toolsets.py`：`register()` 只管登记；「暴露给哪个平台」由 toolset 字典和 `_HERMES_CORE_TOOLS` 决定，`_core_tools_gated_by()` 反查核心工具用于告警。
- `agent/`：`agent/inline_tool_executors.py` 在派发器之前拦截四个 agent 级工具；`agent/secret_scope.py` 给 check_fn 提供 profile 密钥作用域。
- `plugins/`：插件注册/覆盖/注销走 `register(override=True)`、`restore_registration` 与 `allow_tool_override` 授权记录。

## 总结

registry.py 的设计可以压缩成三句：**它是零依赖叶子，所以人人可 import**；**发现靠「顶层 register 调用」这一个事实，AST 判定 + 磁盘缓存让成本趋近于零**；**check_fn 的缓存带宽限期、冲突仲裁带双钥匙，宁可保守也不让工具静默消失或被静默替换**。理解了这一篇，后面任何一篇里的 `registry.register(...)` 对你都不再是咒语，而是一张带可用性探测和作用域的户口登记表。
