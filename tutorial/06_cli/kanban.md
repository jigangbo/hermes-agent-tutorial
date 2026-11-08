# 看板（Kanban）子系统

## 文件概览

`hermes_cli/` 下 25 个 `kanban*.py` 文件构成跨 profile 的任务看板：

- **板**：`kanban_db.py`（SQLite 板，跨 profile 协调原语）+ `_boards/_connect/_graph/_notify/_context/_workspace` 兄弟；
- **派发**：`kanban_db_dispatch.py`（崩溃检测/断路器/并发上限/worker 生成/守护循环）+ `kanban_worker_client.py`（worker 侧）；
- **命令面**：`kanban.py`（`hermes kanban …` 派发 + `/kanban`）+ `kanban_parser/_output/_boards/_ops`；
- **工作流**：`kanban_workflow.py`（列定义）、`kanban_swarm/decompose/specify/transfer/pr_acceptance/resume_guard/diagnostics/owner_recovery`。

## 关键代码走读

### kanban_db.py：SQLite 板

```python
# hermes_cli/kanban_db.py:1-13
"""SQLite-backed Kanban board shared across profiles (the cross-profile coordination primitive).

Lives under the shared Hermes root: ``default`` board DB at ``<root>/kanban.db`` (pre-boards
back-compat), other boards at ``<root>/kanban/boards/<slug>/``; a worker on one board never sees
another. Board resolution: ``board=`` arg > ``HERMES_KANBAN_BOARD`` > ``HERMES_KANBAN_DB`` (pins
the file path) > ``<root>/kanban/current`` > ``default`` — but only for unfenced callers; the
dispatcher injects these into workers, and dispatched workers (``HERMES_KANBAN_TASK``), delegated
children and board-enumerating machine flows ... always resolve through the pin, so workers
physically cannot see other boards.
Concurrency: WAL + ``BEGIN IMMEDIATE`` + compare-and-swap on ``tasks.status``/``claim_lock`` —
SQLite serializes writers so one claimer wins, losers see zero rows (no retries, no distributed
locks). Schema: tasks, task_links, task_comments, task_events, task_runs, attachments, notify subs.
"""
```

两个设计支点：

1. **板隔离是物理的**：worker 经环境 pin（`HERMES_KANBAN_TASK` 等）解析板，永远看不到别的板——不是靠约定，是靠注入；
2. **并发靠 SQLite 写者串行化**：WAL + `BEGIN IMMEDIATE` + 对 `tasks.status`/`claim_lock` 的 CAS——一个认领者赢，输家看到零行更新，无需重试、无需分布式锁。

### 派发器：崩溃检测 + 断路器

```python
# hermes_cli/kanban_db_dispatch.py:1-7
"""Dispatcher: crash/stale/orphan detection, failure accounting and the respawn circuit breaker,
memory-aware concurrency caps, the one-shot ``dispatch_once`` pass, worker spawning
(``_default_spawn``), worker-log rotation and the long-lived ``run_daemon`` loop.
...
"""
# 行 33-44
# After this many consecutive non-success attempts on a task/profile the
# dispatcher parks the task in ``blocked`` with a reason — prevents retry storms.
DEFAULT_FAILURE_LIMIT = 2

# Keep a little wall-clock budget for the worker to observe a terminal timeout
# and make a terminal board call (kanban_block/kanban_complete/kanban_request_review)
# before max_runtime_seconds kills it.
KANBAN_TERMINAL_TIMEOUT_GRACE_SECONDS = 30
```

断路器：同一 task/profile 连续 2 次非成功就把任务停进 `blocked` 并附原因——掐灭重试风暴。终止超时前留 30 秒宽限，让 worker 有机会做一次终态板调用（`kanban_block`/`kanban_complete`/`kanban_request_review`）再被杀。

### 任务图 → 派发 → worker（ASCII）

```text
 kanban_decompose            kanban_db_graph              kanban_db_dispatch            worker
 ┌──────────────┐   分解     ┌──────────────┐   认领     ┌───────────────────┐  spawn  ┌─────────────┐
 │ /kanban 三行 │ ────────▶ │ tasks +      │ ────────▶ │ dispatch_once /   │ ──────▶ │ kanban_     │
 │ triage 任务  │           │ task_links   │  BEGIN    │ run_daemon 循环   │ CAS 认领│ worker_client│
 │ (specify)    │           │ (原子持久化) │ IMMEDIATE │ 崩溃/孤儿/断路器  │         │ → profile   │
 └──────────────┘           └──────────────┘           │ 内存感知并发上限  │         │   owner 网关│
                                                        └───────────────────┘         └──────┬──────┘
  worker 上下文（kanban_db_context 构建的截断 markdown 节）◀────────────────────────────────────┘
  工作区：kanban_db_workspace 解析 scratch/dir/worktree（含 git worktree 创建）
  终态：kanban_pr_acceptance 以精确 head 校验 PR 任务；owner_recovery 只读准入栅栏
```

worker 本身从不跑 agent（`kanban_worker_client.py`：「Dispatcher subprocess: submit one claim to its profile owner; never run an agent」）——认领提交给该 profile 的 owner（网关），turn 在那里跑。

### worker 上下文与工作区

```python
# hermes_cli/kanban_db_context.py:1-3
"""Worker-context rendering for ``build_worker_context``: the capped markdown sections a spawned
"""
# hermes_cli/kanban_db_workspace.py:1-3
"""Task workspace lifecycle: scratch/dir/worktree resolution (incl. git worktree creation), post-comple
```

派发时给 worker 注入有上限的 markdown 节（任务规格、评论、依赖），并解析工作区：scratch 目录、普通目录或 git worktree（`worktree_*` 簇为看板提供隔离 checkout）。

## 核心类/函数

| 符号 | 文件 | 职责 |
|---|---|---|
| `Task` | kanban_db.py | 任务行 dataclass（status/claim_lock CAS 字段） |
| `build_worker_context` | kanban_db_context.py | 给 spawned worker 的截断 markdown 节 |
| `dispatch_once()` | kanban_db_dispatch.py:1980 | 一次性派发扫描 |
| `run_daemon()` | kanban_db_dispatch.py:2905 | 长驻守护循环 |
| `_default_spawn()` | kanban_db_dispatch.py:2754 | worker 子进程生成 |
| `DEFAULT_FAILURE_LIMIT` | kanban_db_dispatch.py:34 | 断路器阈值（连续 2 次失败 → blocked） |
| `build_parser()` | kanban_parser.py | `hermes kanban …` argparse 树 |
| `run_slash` / `kanban_command` | kanban.py | `/kanban` 与 CLI 派发 |
| `DEFAULT_STATUSES` | kanban_workflow.py | 板列的唯一定义 |

## 本组文件清单（25 文件）

| 文件 | 职责 |
|---|---|
| kanban.py | `hermes kanban …` 派发 + 任务动词 handler + `/kanban` 的 run_slash |
| kanban_parser.py | argparse 树（build_parser，re-export） |
| kanban_output.py | 文本 / `--json` 输出助手 |
| kanban_boards.py | `boards …`：板目录、current 指针、board.json |
| kanban_db.py | SQLite 板核心：板解析、WAL+CAS 并发、schema |
| kanban_db_boards.py | 板元数据（board.json）与板生命周期 |
| kanban_db_connect.py | 连接生命周期：打开/配置、跨进程 init、派发 tick |
| kanban_db_context.py | worker 上下文渲染（封顶 markdown 节） |
| kanban_db_dispatch.py | 派发器：崩溃/陈旧/孤儿检测、断路器、并发上限、spawn、daemon |
| kanban_db_graph.py | 任务图初始化与原子分解持久化 |
| kanban_db_notify.py | 通知订阅（gateway kanban-notifier 消费） |
| kanban_db_workspace.py | 任务工作区生命周期：scratch/dir/worktree、完成后清理 |
| kanban_workflow.py | 板列与手动移动的唯一定义 |
| kanban_decompose.py | 分解器：把 triage 任务扇出成子任务图 |
| kanban_specify.py | 三行说明 → 完整规格 |
| kanban_swarm.py | Kanban Swarm v1：薄 swarm 拓扑助手 |
| kanban_ops.py | dispatch/daemon/tail/watch/gc/repair 动词 |
| kanban_transfer.py | 板导出/导入：跨机器搬整块板 |
| kanban_pr_acceptance.py | 显式声明 PR 任务的精确 head GitHub 验收 |
| kanban_pr_acceptance_store.py | 与终态写入同一所有权快照地持久化验收 |
| kanban_resume_guard.py | 看板拥有会话的恢复期守卫（#68779，唯一入口） |
| kanban_owner_recovery.py | 派发器 reclaim 路径的只读准入栅栏 |
| kanban_diagnostics.py | 结构化、可行动的任务困境信号 |
| kanban_worker_client.py | 派发子进程：提交一次认领给 profile owner；从不跑 agent |
| kanban_worker_log.py | 每任务 worker 日志轮转 |

## 常用入口

```bash
hermes kanban add "修复登录页" --board default   # 建任务
hermes kanban dispatch                          # 一次性派发扫描
hermes kanban daemon                            # 长驻派发守护
hermes kanban boards list                       # 板目录与 current 指针
/kanban <一句话>                                 # REPL 内直达（经 kanban.run_slash）
```

诊断入口在 `kanban_diagnostics.py`：对困境任务输出结构化、可行动的信号；`kanban_transfer.py` 的 export/import 负责跨机器搬板。

## 与其他模块的关系

- **worktree_* 簇**：看板任务的 worktree 工作区落到同一套 worktree 注册表/回收（见 repl_mixins.md 的 /worktree）。
- **gateway/**：通知订阅由 gateway kanban-notifier 消费；worker 的 turn 经 profile owner（网关）执行。
- **cron/**：`kanban cron` 行；daemon 由调度器拉起。
- **gateway_runtime_attach.py**：`CLIENT_LAUNCH_ENV` 里有 `HERMES_KANBAN_BOARD`——启动策略随会话传递，daemon 不会把本终端的板泄漏给后续所有会话。
- **kanban_resume_guard.py**：恢复看板拥有会话的唯一守卫（#68779）——防止被派发的会话被用户误接手。

## 总结

看板是「用 SQLite 做分布式协调」的教科书案例：**写者串行化代替分布式锁，环境 pin 代替命名约定，断路器代替无限重试**。worker 永远只是提交认领的薄壳，真正的 turn 由 profile owner 跑——与「CLI 是网关的查看者」一脉相承。
