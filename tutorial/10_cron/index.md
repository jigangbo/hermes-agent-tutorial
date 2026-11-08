# cron/ 模块总览 —— 定时任务调度器

## 文件概览

`cron/` 是 Hermes 的「闹钟 + 定时工头」：它让 agent 和用户能把一件事安排到未来某个时刻自动执行——每天早上的简报、每周的回顾、`in 30m` 的一次性提醒。任务定义/存储在 `cron/jobs.py`（持久化为 `~/.hermes/cron/jobs.json`），派发循环在 `cron/scheduler.py::tick()`（网关后台线程每 60 秒调一次）。本目录共 50+ 个 Python 文件，但结构极其规律：**门面文件（`jobs.py`、`scheduler.py`）保留调用点与公共入口，一切新行为都放进 `<stem>_<topic>.py` 兄弟文件**——这正是仓库「门面 + 兄弟」布局的教科书案例。本篇是第 10 章总览，后续 3 篇分别精读调度器族、任务存储族与「看板/蓝图/建议」族。

## 一条任务的完整旅程（ASCII 全景）

```
 用户 / Agent
   │  hermes cron add "0 9 * * *"  /  cronjob 工具(tools/cronjob_tools.py)
   │  lifespan_guard 拒绝自杀式任务 → create_job 写入
   ▼
┌────────────────────────────────────────────────────────────────┐
│ ~/.hermes/cron/jobs.json        （每 profile 一份，跨进程 flock）│
│  schedule / timezone / grace_minutes / pending_slot / fire_claim│
└───────────────┬────────────────────────────────────────────────┘
                │ 每 60s：scheduler_thread.SupervisedTickerThread
                │   └─ scheduler_provider._start_multiplex（一个线程顺序遍历 served homes，
                │        每个 home 在 _profile_cron_scope(home) 下 tick）
                ▼
┌────────────────────────────────────────────────────────────────┐
│ cron/scheduler_tick.py::tick()                                  │
│  1. 旧代码让位 gate（CronTickYielded）                           │
│  2. 拿 <home>/cron/.tick.lock（进程间去重）                      │
│  3. get_due_jobs()（jobs.py：宽限窗 / 时区钉 / pending_slot 恢复）│
│  4. advance_next_runs()：先推进 next_run_at（至多一次）          │
│  5. 并行池逐个 _process_due_job                                  │
└───────┬──────────────────────────────┬─────────────────────────┘
        │ no_agent/script 任务          │ agent 任务
        ▼                              ▼
 cron/scheduler_script.py      内起 AIAgent 会话（skip_memory=True）
 （预跑脚本，输出注入 prompt）   不活动看门狗 / preflight / prompt 组装
        │                              │ 外部 worker：scheduler.py::_launch_external_cron_worker
        │                              │  → -m cron.scheduler --external-worker-file …
        │                              │  → cron/__init__ → worker_bootstrap → PM activate_dependencies
        ▼                              ▼
┌────────────────────────────────────────────────────────────────┐
│ ~/.hermes/cron/output/{job_id}/{timestamp}.md + executions 台账  │
│ 投递：scheduler_delivery.py → origin/家回退/显式目标/群聊房间     │
│       delivery_queue.py（跨 cgroup 的持久投递交接，至多一次）     │
└────────────────────────────────────────────────────────────────┘
```

## 四类计划表达式

`cron/jobs.py::parse_schedule()`（行 787）把一个字符串解析为 `{"kind": ...}`，四类输入共用一个入口：

| 输入 | kind | 语义 |
|---|---|---|
| `"30m"` / `"every 2h"` | `interval` | 循环间隔（裸时长按文档约定=循环，不是一次性） |
| `"every monday 9am"` / `"weekdays at 9am"` | `cron` | 自然语言短语转 5 字段 cron（需 `croniter` 包） |
| `"0 9 * * *"` | `cron` | 标准 5 字段 cron 表达式 |
| `"2026-06-01T09:00:00Z"` / `"in 30m"` | `once` | 一次性（naive 时间戳按配置好的 Hermes 时区解释，非服务器本地时区） |

## 两条创建路径

- **Agent**：`tools/cronjob_tools.py` 注册的 `cronjob_manage` 工具（行 1263），agent 可以替用户建/改/暂停任务。
- **用户**：`hermes cron list|status|doctor|tick|runs|incidents|notepad|create|edit|pause|resume|run|cancel|remove`（`hermes_cli/cron.py` 行 1019-1032 的动词表），REPL 里对应 `/cron`。

## 每条不变量守护一个真实故障

cron 的「加固不变量」清单是仓库里最长的（见 `cron/AGENTS.md`），每一条都对应一个修过的 bug：

- **不活动看门狗**（默认 600s 空闲，`HERMES_CRON_TIMEOUT` 可调，`0` = 无限）：按*空闲时间*而非墙钟掐会话——卡死的会话被硬中断，不能霸占调度器；长时间但活跃的任务永不被误杀。
- **catch-up 窗口** = 周期一半 clamp 到 120s–2h，或 `grace_minutes` 覆盖（`0` = 永不补跑——`0 == False` 是 Python 的坑，校验代码里明确拒绝 bool）。
- **钉死 timezone 拥有全路径**：`compute_next_run` 解析「任务钉 → profile 时区」，且每个 `next_run_at` 写点（`quota_hold.plan_hold`、`unreachable_retry.will_retry`、`extra_fire.settle`……）都必须传钉；漏一处就是突发重跑或静默跳过一拍。
- **至多一次 occurrence**：`tick()` 在派发*前*推进 `next_run_at`，同一保存内盖 `pending_slot` 戳；owner 死掉的 pending 槽位由 `cron/occurrences.py` 恰好恢复一次；executions 台账的 `scheduled_instant` 挡住第二次点燃。
- **headless tick 拒绝而不孵化**：`hermes cron tick`（系统 crontab）走 `tick(headless=True)`，`scheduler_gateway_gate.py` 在发现没有网关时跳过 agent 任务并盖 `last_fire_error`，绝不 spawn 一个无人管理的网关守护进程。
- **一个 ticker，绝不 N 线程**：`scheduler_provider._start_multiplex` 在 `_profile_cron_scope(home)` 下*顺序*迭代每个 served profile——模块全局量会在线程间打架。
- **inflight 状态键 = `(home key, job id)`**：一个进程 tick N 个 profile，两个 profile 合法地各有一个 `daily-brief`；claims 必须在注册时的 home 下释放（ContextVar 的坑）。
- **宿主网关为「跑自己网关的 profile」让位**：`gateway/run.py::_cron_profile_gate` 把 liveness PID 与 `os.getpid()` 比较，避免把自己吓退。
- **cron 会话默认 `skip_memory=True`**：记忆提供者在 cron 里故意不跑。

## 磁盘上的文件布局

```
~/.hermes/                        ← 每个 profile 自己的 home（get_hermes_home()）
├── cron/
│   ├── jobs.json                 ← 任务存储（原子写 + 0600 + 跨进程 flock）
│   ├── .jobs.lock                ← jobs.json 临界区的跨进程锁文件
│   ├── .tick.lock                ← tick 互斥（网关 vs crontab vs 手动 tick）
│   ├── ticker_heartbeat          ← 每次循环触碰：区分「线程活着」与「进程活着」
│   ├── ticker_last_success       ← 最近一次无异常完成的 tick
│   ├── dispatch_held.json        ← 网关排水期间 one-shot 宽限重锚的持久记录
│   ├── catch_up_occurrences      ← profile 本地补跑计数标记
│   ├── executions.db             ← 执行台账 + 失败事件（SQLite，两模块共用）
│   ├── suggestions.json          ← 统一建议面（0600）
│   ├── admissions/<hash>.json    ← 传输层执行的 admission journal（0600）
│   └── output/{job_id}/{ts}.md   ← 每次运行的输出文档（id 是路径组件，逃逸被拒）
└── scripts/                      ← script 字段引用的文件必须住这里（绝不接受命令行）
```

任务 id 是 `output/` 下的路径组件，所以 `_job_output_dir()`（`jobs.py:431`）拒绝 `..`、绝对路径、分隔符——只接受单个安全组件；`id` 也在 `_IMMUTABLE_JOB_FIELDS` 里，创建后不可改。

## 三个时钟词汇

读 cron 源码前先分清三个时间概念，几乎所有不变量都围绕它们的边界展开：

- **instant（时刻）**：绝对时间点（UTC 规范化后比较）。台账的 `scheduled_instant`、fire claim 的 skew/TTL 都在 instants 上运算。
- **wall clock（挂钟）**：某个时区的本地墙钟读数。cron 表达式表达的是挂钟意图——「每周一 9 点」的意思随 zone 而变；`_stored_wall_clock_is_future`（`jobs.py:920`）专治「时区改了之后旧 offset 让未来 run 看起来 due」的错觉。
- **idle time（空闲时间）**：agent 最后产出的距今时长。看门狗与 stale-claim 扫描都用它而不是墙钟时长——活跃的长任务与僵死的短任务由此分野。

## 本组文档导航

| 文档 | 内容 |
|---|---|
| `scheduler.md` | `scheduler.py` + 全部 `scheduler_*.py` 兄弟：tick 准入、线程监督、多路复用、投递、看门狗、网关门 |
| `jobs.md` | `jobs.py` 存储族 + 全部不变量逐条深讲：锁、时区、pending_slot、executions 台账、quota_hold、missed_runs…… |
| `kanban_dispatcher.md` | `blueprint_catalog.py` / `suggestions.py` / `notepad.py` 等面向用户的自动化入口 + 与 `hermes_cli/kanban*` 看板派发的关系 |

## 与其他模块的关系

- **gateway/**：网关是 ticker 的宿主（`gateway/run.py::_cron_tick_profile_homes` 决定 tick 哪些 profile home；`_cron_profile_gate` 让位给跑自己网关的 profile）。
- **pm/**：外部 cron worker 经 `cron/worker_bootstrap.py` → `pm.environments.activate_dependencies` 自举租用 committed 依赖代。
- **tools/**：`cronjob_manage` 工具是 agent 侧创建入口；kanban 工具集由看板派发器spawn 的 worker 使用。
- **agent/**：cron 任务每次运行得到独立 AIAgent 会话（`skip_memory=True`、不活动看门狗、`execution_identity.py` 的 ContextVar 出处）。
- **hermes_cli/**：`hermes cron <verb>` CLI 与 `hermes_cli/kanban*` 看板命令共享这里的存储原语。

## 总结

cron/ 的读法是「先抓两条主干」：`jobs.py` 管*是什么、什么时候*（存储 + 时间数学 + 不变量），`scheduler.py` 管*去执行、去投递*（tick 准入 + 执行 + 投递）。其余几十个文件全部是这两条主干按主题切出的兄弟件，每个文件头 docstring 都写明它守护哪个故障。下一篇从调度器族开始。
