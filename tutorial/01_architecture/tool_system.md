# 工具系统全景

> 每个模型工具都会随**每一次** API 调用发送给模型 —— 这就是为什么核心工具的准入门槛极高，也是整个工具系统的设计原点。

## 一行代码到一次调用的五道关

```
① 注册   tools/xxx.py 模块级自注册
          registry.register(name, toolset, schema, handler, check_fn=...)
              │  （import 时发生；无装饰器、无配置文件）
              ▼
② 发现   model_tools.py 导入时 discover_builtin_tools()
          AST 预过滤 _module_registers_tools() → 只 import 真正注册工具的模块
          （磁盘缓存按 (mtime_ns, size) 记忆；MCP 发现故意不在此运行，issue #16856）
              │
              ▼
③ 组面   get_tool_definitions(enabled_toolsets, disabled_toolsets, ...)
          toolsets.py 的 TOOLSETS dict 过滤 → 每工具 check_fn 可达性门控
          → _DYNAMIC_SCHEMA_REWRITERS 动态改写（execute_code/browser_*/delegate_task）
          → 有界 LRU 记忆（键 = registry 代数 + 配置指纹）→ 返回浅拷贝
          （agent.tools 在 init 时定死一次 —— 缓存不变量）
              │
              ▼
④ 拦截   模型返回 tool_calls → agent/tool_executor.py
          agent 循环内工具（todo_list/memory/session_search/delegate_task/clarify…）
          走 INLINE_TOOL_EXECUTORS 表（agent/inline_tool_executors.py:291）先行拦截；
          其余进 handle_function_call
              │
              ▼
⑤ 派发   model_tools.py::handle_function_call (行 897)
          coerce_tool_args → legacy 别名 → Tool Search 桥 → connectors 门控
          → 中间件 → pre_tool_call 钩子 → 审批（approval 管线）
          → _execute_tool（registry 派发，持久事件循环 _run_async）
          → post_tool_call 钩子 → transform_tool_result 钩子
          错误净化截断到 2048 字符
```

## 三层职责切分

| 层 | 文件 | 职责 |
|----|------|------|
| 注册表 | `tools/registry.py` | 进程全局 ToolRegistry + **profile 作用域覆盖槽**（`session_tool_scope()`）、冲突策略、check_fn 缓存 |
| 工具集 | `toolsets.py` | `TOOLSETS` dict（基础组/场景组/平台包）、`_HERMES_CORE_TOOLS` 41 个核心工具、递归解析 |
| 编排 | `model_tools.py` | 发现、组面解析、派发管线、钩子/审批接入 |

**41 个核心工具**（`_HERMES_CORE_TOOLS`，CLI 与所有消息平台共享）：
`web_search, web_extract, terminal, process_manage, read_file, write_file, patch, search_files, vision_analyze, image_generate, skills_list, skill_view, skill_manage, browser_exec, browser_cdp, browser_dialog, browser_vault, text_to_speech, todo_list, memory, session_search, clarify, execute_code, delegate_task, cronjob_manage, kanban_show/list/complete/block/request_review/request_changes/heartbeat/comment/create/link/unblock/attach/attach_url/attachments, computer_use, manage_connections`。

平台包在核心之上加料（`_bundle()`）：`hermes-telegram`、`hermes-discord`、`hermes-feishu`、`hermes-weixin`…… webhook 环境是**不可信**的，只给 4 个安全工具（`_HERMES_WEBHOOK_SAFE_TOOLS`）。

## TOOLSETS 字典的三类条目

`toolsets.py` 的 `TOOLSETS` dict 里住着三类东西，读时先分清：

| 类别 | 例子 | 说明 |
|------|------|------|
| 基础组 | `web`、`terminal`、`file`、`memory`、`todo`、`skills`、`browser`、`cronjob`、`session_search`、`clarify`、`code_execution`、`delegation`、`kanban` | 一组名字 → 描述 + 工具名清单 |
| 场景/合成组 | `debugging`、`safe`、`coding` | 用 `includes=[...]` 组合其他组（如 `safe` = web+vision+image_gen，无 terminal） |
| 平台包 | `hermes-cli`、`hermes-telegram`、`hermes-discord`、`hermes-feishu`、`hermes-acp`、`hermes-api-server`、`hermes-cron` | `_bundle()` 在核心之上加料；webhook 是例外 —— 不可信环境只给 `_HERMES_WEBHOOK_SAFE_TOOLS` 4 个工具 |

## 关键函数速查

| 函数 | 位置 | 作用 |
|------|------|------|
| `registry.register(name, toolset, schema, handler, check_fn=...)` | `tools/registry.py` | 模块级自注册的入口 |
| `discover_builtin_tools()` | `model_tools.py` | AST 预过滤 + 磁盘缓存的工具发现 |
| `get_tool_definitions(enabled_toolsets, disabled_toolsets, ...)` | `model_tools.py` | 组面：过滤 → 门控 → 动态改写 → LRU 缓存 |
| `handle_function_call` | `model_tools.py:897` | 派发管线总入口（中间件/钩子/审批/执行） |
| `INLINE_TOOL_EXECUTORS` | `agent/inline_tool_executors.py:291` | 循环内工具的先行拦截表 |
| `_plan_tool_batch_segments` | `agent/tool_dispatch_helpers.py` | 多工具批的"并行安全段"规划 |

## 并行与确定性

- `AIAgent._execute_tool_calls` 用段规划器（`tool_dispatch_helpers._plan_tool_batch_segments`）把多工具批拆成"并行安全段"（只读、不相交文件、opted-in 的 MCP）+ 顺序屏障；`_MAX_TOOL_WORKERS = 8`（`tools/daemon_pool.py` 的守护线程池）。
- 工具输出超限走 head/tail 截断（`tool_output_truncate.py`），大结果可外置存储（`tool_result_storage.py`）。

## 新工具该走哪条路（footprint 阶梯）

从低到高，取能解决问题的最高一阶：

1. **扩展现有代码** —— 能加参数就不加工具；
2. **CLI 命令 + 技能** —— 面向人的能力；
3. **服务门控工具** —— 带 `check_fn`（回答"可达/已 opt-in"，**不是**每会话表面开关）；
4. **插件** —— `ctx.register_tool`，命名空间隔离；
5. **MCP 服务器** —— 目录里已有的优先；
6. **新核心工具** —— 最后手段：它将随每次 API 调用发送给所有用户。

每一阶的落地细节分布在模块目录：技能见 [12_skills](../12_skills/index.md)，服务门控与注册见 [04_tools/registry](../04_tools/registry.md)，插件见 [09_plugins/plugin_api](../09_plugins/plugin_api.md)，MCP 见 [04_tools/mcp](../04_tools/mcp.md)。

## 冲突与覆盖

- 跨工具集遮蔽默认拒绝，`override=True` 才放行；
- 插件替换内建工具需要操作员显式 `plugins.entries.<id>.allow_tool_override: true`；
- `mcp-*` 工具集豁免（MCP 发现会重铺自己的工具）。

判断"同名冲突归谁"时记住默认立场：**显式 beats 隐式，操作员 beats 插件，内建 beats 偶然同名**。

## 逐文件走读

- 注册表与管线细节 → [04_tools/registry](../04_tools/registry.md)
- 审批/安全层 → [04_tools/approval_safety](../04_tools/approval_safety.md) 与 [安全边界模型](security_model.md)
- 终端/文件/浏览器等每类工具 → [04_tools/index](../04_tools/index.md)
