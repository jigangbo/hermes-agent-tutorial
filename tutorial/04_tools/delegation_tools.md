# 子代理委派组 —— delegate_task 与它的 20 个帮手

## 文件概览

`delegate_task` 让主 agent 把一块工作扔给一个**全新对话**的子代理：子代理有独立的上下文、自己的 task_id（终端会话、文件缓存）、继承父辈的 toolset（减去被禁工具），干完只向父辈交一份摘要——父辈永远看不到子代理的中间工具调用。本组 21 个文件把这件事拆到极致：`delegate_tool.py` 是门面（构建子代理 + `_run_single_child` 跑完一个孩子），13 个 `delegate_tool_*.py` 兄弟各管一段（配置、分发、进度、注册表、结果、路由、会话、任务校验、toolset 裁剪、调优、预热门），`async_delegation*.py` 三件套管后台委派的完成队列，`delegation_live_log` 提供实时可尾随的子代理记录，`subagent_worktree.py` 支持可选的 git worktree 隔离。本篇深讲 delegate_tool.py 的核心三件：角色与深度、`_run_single_child`、以及 `_last_resolved_tool_names` 的保存/恢复。

## 关键代码走读

### 1. 门面的形状：leaf 与 orchestrator

子代理有两种角色。默认 `leaf`：没有 `delegate_task`、`clarify`、`memory`、`send_message`、`cronjob`（保留 `execute_code`）——叶子就该干活，不该再生孩子、问人、发消息。`orchestrator` 保留 `delegate_task`，受 `delegation.orchestrator_enabled` 门控、`delegation.max_spawn_depth`（默认 2）限深：

```python
# 来源：tools/delegate_tool.py:1-12
#!/usr/bin/env python3
"""
Delegate Tool -- Subagent Architecture

Spawns child AIAgent instances with a fresh conversation, their own task_id
(terminal session, file-ops cache), the parent's toolsets minus child-blocked
tools, and a focused system prompt built from goal + context. Single-task and
batch (parallel) modes; top-level model calls run in the background while
orchestrator children wait for their own workers. The parent only ever sees
the delegation call and the summary result, never the child's intermediate
tool calls or reasoning.
"""
```

blocked 工具集合定义在 `delegate_tool_toolsets.py`（`DELEGATE_BLOCKED_TOOLS`），孩子 toolset 的解析 `_resolve_child_toolsets` 在那里完成。门面把兄弟模块的名字全部 re-import 到 `tools.delegate_tool` 命名空间——调用者和测试都只需要认识门面（facade + siblings 布局的标准姿势）。

### 2. _run_single_child：一个孩子的一生

这是跑一个孩子的完整生命周期函数，注释明确写出结果契约（status ∈ completed/interrupted/failed，exit_reason ∈ completed/max_iterations/interrupted/error）。逐步看：租借凭据池 → 启动心跳（防止网关不活跃看门狗误杀）→ 注册进 TUI/RPC 子代理登记表（可 kill/pause/status）→ `run.seed_workspace()` → `await_child()` 等结果：

```python
# 来源：tools/delegate_tool.py:377-405（节选）
def _run_single_child(
    task_index: int, goal: str, child=None, parent_agent=None, *, owner_session_id: Optional[str] = None,
    owner_transport: Any = None, owner_session_record: Any = None, **_kwargs,
) -> dict[str, Any]:
    """Run a pre-built child agent (called from a worker thread) and return its result entry.
    ...
      status      ∈ {completed, interrupted, failed} — a structured failure
                    (failed=True / non-empty error) or an invalid terminal state
                    is "failed" even when a summary exists.
      exit_reason ∈ {completed, max_iterations, interrupted, error} —
                    "max_iterations" only for genuine budget exhaustion
                    (completed=False with no failure fields), never for errors.
      truncated   == (exit_reason == "max_iterations").
    """
    child_progress_cb = getattr(child, "tool_progress_callback", None)
    child_pool, leased_cred_id = _lease_child_credential(child)
    # Heartbeat keeps the parent's _last_activity_ts moving so the gateway inactivity timeout doesn't fire while the
    # child works; once the child looks stale (see _HEARTBEAT_STALE_CYCLES_*) it also ends await_child's wait.
    heartbeat = _start_heartbeat(child, parent_agent, task_index)
    # TUI/RPC registry entry (kill/pause/status by subagent_id); None for test
    # doubles without a stable id. Unregistered in the finally block.
    _subagent_id = _register_child(
        child, parent_agent, goal, owner_session_id=owner_session_id, owner_transport=owner_transport,
        owner_session_record=owner_session_record,
    )
    run = _ChildRun(child, parent_agent, task_index, goal, _subagent_id, child_progress_cb, heartbeat=heartbeat)
```

成功的尾部依次做：校验 output_schema（`delegate_tool_output_schema` 追加的输出契约）、合并迟到的 steer 指令、构建结果条目、**给后台进程记账**、发出完成事件、附上 worktree 信息：

```python
# 来源：tools/delegate_tool.py:424-440
        duration = run.elapsed()
        entry = _build_result_entry(child, result, task_index, duration, schema)
        run.append_sibling_write_reminder(entry)
        run.account_background_processes(entry)
        run.emit_complete(result, entry, duration)
        return run.attach_worktree(entry)
    except Exception as exc:
        # Close steer acceptance before any completion callback (see _merge_late_steer).
        _late_pending_steer = run.close_steering()
        logging.exception(f"[subagent-{task_index}] failed")
        # Entry status "error" (contract), progress event status "failed" (UI vocabulary).
        return run.finish_failed(
            _fabricated_entry(task_index, "error", str(exc), child, run.elapsed()), _late_pending_steer,
            preview=str(exc), summary=str(exc), status="failed",
        )
    finally:
        run.cleanup(heartbeat=heartbeat, child_pool=child_pool, leased_cred_id=leased_cred_id, close_deferred=_child_close_deferred)
```

`account_background_processes` 值得单独记住：孩子留下没人管的后台进程会在 teardown 被杀，通知在父辈侧被抑制；孩子显式 `process_manage(action="handoff")`（仅限孩子调用）可以把所有权过户给父辈，完成事件按新主人路由。没过户的会以 `orphaned_processes` 落在结果上。

### 3. _last_resolved_tool_names 的保存/恢复

`model_tools._last_resolved_tool_names` 是一个**进程全局**——上一次 `get_tool_definitions()` 解析出的工具名列表（execute_code 沙箱默认拿它当工具来源）。构建孩子会触发一次孩子自己的解析，把这个全局污染成孩子的视角。所以构建被包在一个「保存→构建→恢复」的三明治里，孩子的构建还被全局锁串行化（构建不是线程安全的）：

```python
# 来源：tools/delegate_tool_results.py:315-326
def _build_child_preserving_parent_tools(**kwargs):
    """Build a child without leaking its resolved toolset into the parent."""
    from tools.delegate_tool import _build_child_agent
    import model_tools
    with _CHILD_CONSTRUCTION_LOCK:
        parent_tool_names = list(model_tools._last_resolved_tool_names)
        try:
            child = _build_child_agent(**kwargs)
        finally:
            model_tools._last_resolved_tool_names = parent_tool_names
    child._delegate_saved_tool_names = parent_tool_names
    return child
```

AGENTS.md 顺带警告了一个已知边界：读者在委派进行中可能看到**陈旧**的全局值——这是接受的权衡，不是 bug。孩子的 `execute_code` 内核也有对应的记账：键为 `<父owner>::child::<子session-id>`，孩子活着时钉在 LRU 上限之外、结束由 cleanup 释放（`code_kernel.shutdown_kernels_for_delegated_child`）。

### 4. 批量、后台与完成单元

单任务是 `goal`（+ 可选 `context`/`toolsets`）；批量是 `tasks: [...]`，并发上限 `delegation.max_concurrent_children`（默认 3）。`background=true` 立即返回一个委派 id，结果经异步完成队列回流。批量的「完成单元」由 `delegate_tool_dispatch._units_of` 决定：默认整个批量作为**一个**完成；`delegation.independent_completions` 打开后按 `group` 拆分——同组任务一起汇报，无组任务完成即报。同一调用的所有单元共享**一个**池槽（`slot_key`），绝不按单元数占容量。

### 5. 路由与后端

`delegation.backend` 选择委派提供方（`agent/delegation_provider.py`），它为每个任务回答一条路由（`delegate_tool_routes.py`）：解析 model/provider 字段、检查 `service_tier`（`delegate_tool_tuning.py` 像 `/fast` 那样对待它）、或指定 `profile`——孩子整个构建、租借、对话都在那个 profile 的作用域里。**失败一律 fail closed**：不可用的后端是一个点名后端的工具错误（绝不静默回退 `default`），不可路由的任务单独被拒（`TaskRoute.error`），给任务传了后端不支持的参数也拒。默认策略就是捆绑的 `plugins/delegation/default` 插件——核心对它没有特殊照顾，只是选中它。

### 6. 停止传播与心跳

一个回合的硬中断只到达 `_active_children`；后台单元在派发时就被故意「detach」，在中断中幸存（背景子代理独立于派生它的聊天——包括 `/review`）。只有显式 `/stop` 命令和会话关闭/重置会终止后台委派。深度 > 0 的委派永远是同步的（`_model_background_value`），这样停止会沿孩子自己的 `_active_children` 递归下去。心跳有双阈值判陈旧：15 个周期（450s）回合间无进展，或 40 个周期（1200s）卡在同一工具——`delegate_tool.py:107-117` 的常量连同「孩子其实已写完最终答案，再多等 2 秒收真结果」的宽限（`_STALE_RESULT_GRACE_SECONDS = 2.0`）都在门面里。

## 核心类/函数

| 符号 | 职责 | 位置 |
|---|---|---|
| `delegate_task`（注册名） | 委派工具本体：单任务/批量/后台三形态 | `tools/delegate_tool.py` |
| `_run_single_child` | 跑一个孩子的完整生命周期（心跳、登记、清理） | `tools/delegate_tool.py:377` |
| `_normalize_role` | leaf/orchestrator 角色规整（未知值警告并回退 leaf） | `tools/delegate_tool.py:98` |
| `_open_child_session_db` | 孩子的专用 SessionDB 句柄（同文件、独立连接，防父句柄早关） | `tools/delegate_tool.py:124` |
| `_build_children` | 主线程串行构建全部孩子（构建非线程安全） | `tools/delegate_tool.py:464` |
| `_ChildRun` | 一个孩子运行的载体：seed、await、account、cleanup | `tools/delegate_tool_child_run.py` |
| `_build_child_preserving_parent_tools` | 构建 + `_last_resolved_tool_names` 保存/恢复三明治 | `tools/delegate_tool_results.py:315` |
| `_units_of`（delegate_tool_dispatch） | 批量任务 → 完成单元（group 聚合 / 独立汇报） | `tools/delegate_tool_dispatch.py` |
| `_resolve_child_toolsets` | 孩子 toolset 解析：继承父辈、剥离 blocked | `tools/delegate_tool_toolsets.py` |
| `TaskRoute`（delegate_tool_routes） | 每任务路由（model/profile/error），fail closed | `tools/delegate_tool_routes.py` |
| `pin_child_service_tier` | 按 `/fast` 同款规则钉住孩子的服务档位 | `tools/delegate_tool_tuning.py` |
| `dispatch`（async_delegation） | 后台委派的完成队列注册与 `slot_key` 容量 | `tools/async_delegation.py` |
| `wrap_progress_callback`（delegation_live_log） | 给进度回调叠加可尾随的实时记录 | `tools/delegation_live_log.py` |

## 本组文件清单

委派组共 21 个文件：

| 文件 | 一句话角色 |
|---|---|
| `tools/delegate_tool.py` | 门面：构建孩子、跑孩子、角色/深度、心跳常量。 |
| `tools/delegate_tool_child_run.py` | `_ChildRun`：跑一个孩子的心跳、登记、工作区播种、收尾。 |
| `tools/delegate_tool_config.py` | `delegation.*` 配置旋钮与孩子凭据/provider 解析。 |
| `tools/delegate_tool_dispatch.py` | 批量执行 + 后台分发：`_Batch`、完成单元、槽位。 |
| `tools/delegate_tool_prefix_gate.py` | 批量子代理的提示缓存预热门（错峰启动）。 |
| `tools/delegate_tool_progress.py` | 孩子进度中继、控制台格式化、孩子系统提示构建。 |
| `tools/delegate_tool_registry.py` | 活动子代理登记表 + 模型面控制平面（list/steer/stop）。 |
| `tools/delegate_tool_results.py` | 结果后处理：摘要预算/溢写、工具轨迹摘要、生命周期钩子、成本汇总。 |
| `tools/delegate_tool_routes.py` | 来自活动委派后端的每任务路由。 |
| `tools/delegate_tool_sessions.py` | 被委派孩子的已存会话（按 subagent_id 寻址）。 |
| `tools/delegate_tool_tasks.py` | 输入校验：tasks/goal 规整、每任务 output schema 与图片。 |
| `tools/delegate_tool_toolsets.py` | 孩子 toolset 解析：能用什么、永不能用什么。 |
| `tools/delegate_tool_tuning.py` | 孩子的速度档位（service_tier 钉扎）。 |
| `tools/async_delegation.py` | 后台委派登记表：完成队列、slot_key、心跳事件类型。 |
| `tools/async_delegation_recovery_hints.py` | 遗弃委派恢复事件的取证提示。 |
| `tools/async_delegation_worker.py` | 进程绑定的 worker 台账，走既有持久 outbox。 |
| `tools/delegation_live_log.py` | 子代理的实时、可尾随记录。 |
| `tools/delegation_output_schema.py` | 结构化输出的 schema 助手（向孩子追加输出契约）。 |
| `tools/delegation_redaction.py` | 委派专属的输出投影，用既有文本脱敏器。 |
| `tools/subagent_worktree.py` | 可选的 git worktree 隔离（`delegation.worktree_isolation`）。 |
| `tools/human_input_hooks.py` | agent 阻塞等人类的每个点位上的插件观察者。 |

## 与其他模块的关系

- `agent/`：`_AGENT_LOOP_TOOLS` 把 `delegate_task` 拦在派发器外由 agent 循环执行；`agent/delegation_provider.py` 与 `agent/delegation_backends.py` 是后端选择的另一半。
- `tools/process_registry.py`：孩子的后台进程 handoff 改 `ProcessSession.owner_task_id`（registry 锁下），完成按新主人路由与收割；心跳走它的 `_heartbeat_loop` 守护线程。
- `tools/code_kernel.py`：孩子内核的键、钉扎与释放（见上文）。
- 持久性边界：后台委派是**进程本地的**，必须活过重启的工作用 `cronjob` 或 `terminal(background=True, notify_on_complete=True)`。
- API 文档：`website/docs/developer-guide/subagent-lifecycle-api.md`（生命周期 API 绕过常规路由）。

## 总结

委派组把「把活外包给一个干净的脑子」拆成了几乎正交的零件：门面管生命周期与契约，兄弟各管一段（谁配、谁发、谁记账、谁收尾），fail closed 的路由保证「错的后端喊得出名字」而不是静默降级。三个最值得带走的细节：`_last_resolved_tool_names` 的构建三明治（进程全局在并发下的自保姿势）、孩子的后台进程要么 handoff 要么记作 orphan（绝不留悬案）、后台委派是进程本地的（要活过重启就别用委派）。至于摘要预算、redaction、live log，都是「父辈只见摘要」这一承诺的工程化补全。
