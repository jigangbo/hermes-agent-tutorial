# 任务存储族 —— jobs.json、时间数学与执行台账

## 文件概览

`cron/jobs.py`（3,453 行门面）回答「任务是什么、什么时候跑」：任务 CRUD、计划解析、due 扫描、`next_run_at` 推进。存储在每 profile 一份的 `~/.hermes/cron/jobs.json`，输出在 `~/.hermes/cron/output/{job_id}/{timestamp}.md`。行为按主题下沉到兄弟文件：时间旋钮（`jobs_time.py`）、执行模式不变量（`jobs_invariants.py`）、模型钉（`jobs_model_pin.py`）、occurrence 身份（`occurrences.py`）、执行台账（`executions.py`）等。本篇先走读存储与锁、due 扫描与宽限窗，再把加固不变量逐条对到代码位置，最后给出全族清单。

## 关键代码走读

### 每 profile 的存储与双层锁

```python
# cron/jobs.py:83-95
# Cron is per-profile by design: anchor at get_hermes_home() (active profile home), NOT
# get_default_hermes_root() — the shared root would funnel every profile's jobs into one jobs.json
# and run them under the ticker's HERMES_HOME, leaking config/credentials/skills across profiles.
# Each profile owns its own cron store under its own HERMES_HOME, and a profile-scoped gateway runs that
# profile's jobs under that same HERMES_HOME — so a job authored in profile `coder` lives in
# `~/.hermes/profiles/coder/cron/jobs.json` and executes with `coder`'s `.env`, `config.yaml`, and skills.
# Do NOT change this to the default root: that re-breaks per-profile isolation. See also the dynamic
# `_get_hermes_home()` / `_get_lock_paths()` resolution in cron/scheduler.py. See #4707.
HERMES_DIR = get_hermes_home().resolve()
# Default-profile fallback and compatibility surface for callers/tests. Cross-profile callers must
# scope paths with use_cron_store() instead of mutating these process-wide.
CRON_DIR = HERMES_DIR / "cron"
JOBS_FILE = CRON_DIR / "jobs.json"
```

跨 profile 调用者用 `use_cron_store(home)`（行 192）这个 ContextVar 把存储路由到任意 home，绝不改进程级常量。锁是两层的：

```python
# cron/jobs.py:293-300
@contextlib.contextmanager
def _jobs_lock():
    """Serialize a load_jobs→modify→save_jobs critical section: in-process RLock (parallel tick
    threads) plus a cross-process flock on ``<cron dir>/.jobs.lock`` (gateway vs. CLI writes —
    otherwise a `cron pause` could be clobbered and keep firing). Nested calls in one thread
    reuse the held lock. Without a flock backend, or on flock timeout (logged loudly), it
    degrades to in-process-only locking: a briefly torn cross-process write beats a dead
    scheduler."""
```

进程内 `threading.RLock` 管 tick 并行池线程之间；`fcntl`（Unix）/`msvcrt`（Windows）跨进程 flock 管「网关 vs `hermes cron pause`」。flock 是**有界**轮询（30s 超时，行 115-118）：每个 cron 函数都汇入 `_jobs_lock()`，被一个卡死的兄弟进程无限阻塞会冻结整个调度器；超时则大声降级为仅进程内锁——短暂的撕裂写好过死掉的调度器（#60703）。任务级还有第三层 `_fire_job_lock`（行 348）：可跨网络投递持有、按 `profile+job` 分片，拿不到时**失败关闭**。

### 四类计划与宽限窗

```python
# cron/jobs.py:947-960
def _compute_grace_seconds(schedule: dict, grace_minutes: Any = None) -> int:
    """How late a job can be and still catch up rather than fast-forward: half the period, clamped
    to [120s, 2h], so daily jobs catch up but frequent jobs fast-forward quickly.

    A per-job ``grace_minutes`` overrides that window (0 = never catch up), floored at the
    120s tick tolerance: the ticker always fires a few seconds after the slot, so a 0s window
    would classify every on-time run as missed."""
    override = jobs_time.grace_seconds_override(grace_minutes)
    if override is not None:
        return max(override, _MIN_GRACE_SECONDS)
    period_seconds = _schedule_cadence_seconds(schedule)
    if not period_seconds:
        return _MIN_GRACE_SECONDS
    return max(_MIN_GRACE_SECONDS, min(int(period_seconds) // 2, _MAX_GRACE_SECONDS))
```

宽限窗决定一次迟到派发是 `late`（补跑）还是 `catch_up`（跳过积压、只执行现在这一次，`_classify_dispatch_lateness` 行 969）。`grace_minutes` 是每任务覆盖，`0` 是真实值（永不补跑）——所以 `normalize_grace_minutes`（`jobs_time.py:80-111`）**显式拒绝 bool**：`0 == False` 的 Python 恒等式正是 `workdir` 更新 lambda `v in {None, "", False}` 会踩的坑。时区旋钮同理：`normalize_timezone`（`jobs_time.py:56-77`）把非法 IANA 名在**写入前**抛 `ValueError`，错别字永远到不了 60s 扫描循环。

### pending_slot：至多一次的持久证据

`tick()` 在派发前推进 `next_run_at`（防崩溃重放），但这留下一个窗口——推进已落盘、fire claim 未拿到（解释器终态化、执行器拒绝、进程被杀）——此时重启后的扫描看到未来的 `next_run_at`，什么都没跑过（#107485）。`pending_slot` 是这个窗口的持久记录：

```python
# cron/occurrences.py:62-69
# The tick advances a recurring job's ``next_run_at`` BEFORE dispatch (at-most-once: a crash
# mid-run must not re-fire on every restart). That leaves a window — advance done, fire claim
# not yet taken (interpreter finalizing, executor refusing work, process killed) — in which the
# process exiting loses the occurrence silently: the restarted scan sees a future ``next_run_at``
# and nothing ever ran (#107485). ``pending_slot`` is the durable record of that window: the due
# scan stamps it with the exact stored instant plus the stamping owner, ``claim_job_for_fire``
# (the point after which side effects may exist) clears it, and any explicit rewrite of the
# schedule drops it. A slot still pending once its owner is provably gone (or its lease has
# expired) was never claimed, so it is restored ONCE as the due instant and then flows through
# the ordinary late / fast-forward / ``cron.catch_up_missed`` policy — never N replays.
```

恢复谓词 `unclaimed_pending_slot`（行 78-103）的判定链：非循环任务/坏戳记→None（永不触发）；本进程仍在跑该任务→None（排队中的 worker 会自己认领并清戳）；别的进程盖的戳且 fire-claim 租约（`FIRE_CLAIM_TTL_SECONDS`，300s）还活着→None（第二个活网关正在派发，不是死了）。**同一保存内盖戳**是关键：`advance_next_runs` 与 `pending_slot` 写进同一次 `save_jobs`，不存在「推进了、没盖戳」的中间态。

### executions 台账：身份与防双发

`cron/executions.py` 是 profile 本地的 SQLite 台账（与 `incidents.py` 共用 `cron/executions.db`）。它记录*已知*的每次尝试，不是重试队列；「unknown」只在拥有者进程被证明死亡（启动时间指纹不匹配 = 死亡证据）之后才落账；终态不可变。每次执行携带 `scheduled_instant`——由 `occurrences.scheduled_instant`（行 9-19）规范化的 aware UTC 时刻，是独立于 jobs.json 可变派发戳的「确切计划身份」。台账里同一 `(job_id, scheduled_instant)` 已有 `completed` 行时，due 扫描和 fire claim 双闸门都吃掉这个槽位而不跑（`completed_occurrence` 行 22-55）——唯一的痕迹是一行 WARNING（#111414）。

### 失败面：hold、补跑与不可达重试

- **`quota_hold.py`**：provider 明说「retry after Ns」且整条 fallback 链都不可用时，`mark_job_run` 把 `next_run_at` 停到恢复边界（或窗内第一个合法 occurrence）并盖 `quota_hold_until`——否则每次按节奏重燃都是一次用量探测 + 一条失败告警。任何真正到达模型的运行清除标记。
- **`unreachable_retry.py`**：借鉴 Claude Cowork 的 5/15/30 分钟阶梯，但类别刻意窄——必须是瞬时网络/DNS 错误**且** agent 一次 API 调用都没完成（零开销、零副作用，所以重跑不可能翻倍任何副作用）；循环任务专属，one-shot 由 `claim_dispatch` 预认领不可再生。
- **`missed_runs.py`**：机器关机/网关停机期间的 occurrence 有 `catch_up` 三态——任务自己的 `true/false` 优先；缺席时循环任务跟 `cron.catch_up_missed`（默认 true）、one-shot 保持 120s 宽限规则（#93526：陈年提醒默认跳过）。跳过/合并的槽位记为一行 `missed ×N` 台账——**绝不静默丢槽**。
- **`dispatch_hold.py`**：网关排水（重启等待在途 turn）期间 tick 跳过派发；one-shot 的 120s 宽限从「hold 的最后一次 tick」起算而不是原 due 时刻——否则一次等了三分钟的更新会把用户定在那一分钟的提醒当 missed 退休。hold 跨重启持久在 `<cron store>/dispatch_held.json`。
- **`extra_fire.py`**：手动「立即运行」是**额外的** fire——离开 pending 的计划 occurrence 与 `repeat` 预算原封不动。否则一个测试点燃会吃掉 `in 30m` 提醒本身。

## 核心类/函数

| 符号 | 位置 | 职责 |
|---|---|---|
| `load_jobs()` / `save_jobs()` | `jobs.py:1377/1623` | 读写 jobs.json（原子替换 + 0600） |
| `_jobs_lock()` | `jobs.py:294` | 进程内 RLock + 跨进程 flock（有界，降级而非死亡） |
| `_fire_job_lock()` / `fire_claim_fence()` | `jobs.py:348/410` | 任务级 fire 栅栏（失败关闭） |
| `use_cron_store()` | `jobs.py:192` | ContextVar 路由存储到任意 home |
| `parse_schedule()` | `jobs.py:787` | 四类计划字符串 → `{"kind": ...}` |
| `compute_next_run` / `_ensure_aware()` | `jobs.py:863` | 时区归一（due 扫描传任务钉住的 zone） |
| `_compute_grace_seconds()` | `jobs.py:947` | 宽限窗 = 周期一半 clamp 120s–2h 或 `grace_minutes` |
| `create_job()` / `update_job()` | `jobs.py:1809/2119` | 创建/更新（都过 `jobs_invariants` 校验） |
| `advance_next_runs()` | `jobs.py:2672` | 派发前推进（同保存盖 `pending_slot`） |
| `claim_job_for_fire()` | `jobs.py:2723` | fire 认领：清 pending_slot、判重、盖 `fire_claim` |
| `get_due_jobs()` | `jobs.py:2868` | due 扫描（宽限窗、时区修复、槽位恢复） |
| `mark_job_run()` | `jobs.py:2484` | 终局簿记 + quota_hold 停泊 |
| `normalize_timezone()` / `normalize_grace_minutes()` | `jobs_time.py:56/80` | 写入前校验；拒绝 bool 的 `0` |
| `zone_for_job()` | `jobs_time.py:114` | 永不抛：坏值降级到 profile 时区（每值警告一次） |
| `JOB_DEFINITION_FIELDS` | `job_definition.py:13` | 「作者字段」枚举——profile 分发导入者据此合并 |
| `merge_job_definition()` | `job_definition.py:22` | 刷新作者字段、保留调度器状态；时区/表达式变更重锚 |
| `_validate_job_mode_invariants()` | `jobs_invariants.py` | `no_agent=True` 必须有 script；script 必须是文件不是命令行 |
| `scheduled_instant()` / `completed_occurrence()` | `occurrences.py:9/22` | 计划身份规范化 / 台账防双发 |
| `pending_slot_stamp()` / `unclaimed_pending_slot()` | `occurrences.py:71/78` | 槽位戳 / 死亡 owner 的槽位恰好恢复一次 |
| `hold_seconds_from_failure()` / `plan_hold()` | `quota_hold.py` | 解析「retry after Ns」/ 把 `next_run_at` 停出闭窗 |
| `job_catches_up()` | `missed_runs.py` | catch_up 三态判定 |
| `note_held()` / `grace_start_for()` | `dispatch_hold.py` | 排水 hold 的持久记录 / one-shot 宽限起点 |
| `queued()` / `pending_slot()` | `extra_fire.py` | 手动 fire 不吃计划槽位 |
| `RETRY_DELAYS_SECONDS` / `will_retry()` | `unreachable_retry.py` | 300/900/1800s 阶梯 / 规划下次重试（传时区钉） |
| `record_execution()` / `finish_execution()` | `executions.py` | 台账写入（终态不可变） |
| `current_execution()` | `execution_identity.py` | ContextVar 出处（插件 `ctx.current_cron_execution()`） |
| `upsert_incident()` | `incidents.py` | 失败按 `(job_id, 错误签名)` 去重的持久事件 |
| `apply_monitor_gate()` | `monitor.py` | 监视模式：源输出哈希未变 → 抑制 agent 运行 |
| `note_unwritable()` / `dispatch_blocked()` | `store_health.py` | 不可写 store 的单条降级记录 + 每分钟一次重探 |
| `validate_create_spec()` | `lifecycle_guard.py` | 拒绝「从网关内重启网关」的任务（防 SIGTERM 复活循环） |
| `request_cancel()` / `_cancel_marker_path()` | `cancellation.py` | 按 execution id 的标记文件跨进程取消 |
| `settle_queued_delivery()` | `delivery_outcome.py` | 队列投递的终局回写（按执行 id 栅栏幂等） |
| `_write()` | `jobs_oneshot_diagnostics.py` | one-shot 被移除时的操作者可见痕迹 |

## 本组文件清单

| 文件 | 角色 | 关键符号 |
|---|---|---|
| `cron/jobs.py` | 门面：存储/CRUD/时间/due 扫描 | `_jobs_lock`, `parse_schedule`, `claim_job_for_fire` |
| `cron/jobs_time.py` | `timezone`/`grace_minutes` 旋钮 | `zone_for_job`, `grace_seconds_override` |
| `cron/jobs_invariants.py` | 执行模式不变量 | `NO_AGENT_WITHOUT_SCRIPT_ERROR` |
| `cron/jobs_model_pin.py` | `pinned=True` 锁当前主模型 | `_main_model_pin` |
| `cron/jobs_oneshot_diagnostics.py` | one-shot 移除的可见痕迹 | `_write` |
| `cron/job_definition.py` | 作者字段枚举 + 外部 store 合并 | `JOB_DEFINITION_FIELDS` |
| `cron/occurrences.py` | 计划身份 + pending_slot 恢复 | `completed_occurrence`, `unclaimed_pending_slot` |
| `cron/quota_hold.py` | provider 配额窗停泊 | `plan_hold`, `STATE_KEY` |
| `cron/missed_runs.py` | 错过槽位的补跑/跳过 + 台账 | `job_catches_up` |
| `cron/delivery_queue.py` | 跨 cgroup 持久投递交接 | 至多一次 claim；死亡后 unknown 不重试 |
| `cron/dispatch_hold.py` | 排水期 one-shot 宽限重锚 | `note_held`, `TICK_SLACK_SECONDS` |
| `cron/extra_fire.py` | 手动运行 = 额外 fire | `queued`, `restore_target` |
| `cron/unreachable_retry.py` | 零副作用不可达重试阶梯 | `RETRY_DELAYS_SECONDS`, `STATE_KEY` |
| `cron/executions.py` | SQLite 执行台账 | `_transaction`, 终态不可变 |
| `cron/execution_identity.py` | 当前执行出处 ContextVar | `CronExecution` |
| `cron/incidents.py` | 失败事件（签名去重 + ack） | `upsert_incident`, `alerted` |
| `cron/monitor.py` | 监视模式哈希抑制 | `apply_monitor_gate` |
| `cron/store_health.py` | 不可写 store 的降级状态 | `note_unwritable`, `probe_store` |
| `cron/lifecycle_guard.py` | 创建期网关自杀守卫 | 命令形状模式（拒绝 prose） |
| `cron/cancellation.py` | 按 execution id 的跨进程取消 | 标记文件 + 心跳轮询 seam |
| `cron/delivery_outcome.py` | 队列投递终局回写 | `settle_queued_delivery` |
| `cron/delivery_queue.py` | （同上，见 `delivery_queue` 行） | claim 至多一次 |
| `cron/constants.py` | fire-claim 时间界（import-free） | `FIRE_CLAIM_TTL_SECONDS=300` |
| `cron/env_settings.py` | profile 作用域读 `HERMES_*` 调优 | `cron_env_setting` |

## 不变量逐条对码

| 不变量 | 守护的故障 | 代码位置 |
|---|---|---|
| 不活动看门狗（空闲 600s） | 卡死会话独占调度器 | `scheduler.py::_cron_inactivity_seconds` + `scheduler_liveness.py` |
| 宽限窗 clamp 120s–2h | 日任务不补跑 / 分钟任务无限积压 | `jobs.py:947` |
| `timezone` 钉拥有全路径 | 一个写点漏传钉 = 突发重跑或静默跳拍 | `jobs_time.py` + `quota_hold.plan_hold` + `unreachable_retry.will_retry` + `extra_fire.settle` |
| 钉住任务跳过 `_repair_timezone_shifted_cron` | 东侧任务在 profile 时区下被判「未来」、重锚越过 due（永不触发） | `jobs.py:3009` + `_evaluate_due_job`（`jobs.py:3177`） |
| 派发前推进 + 同保存盖 pending_slot | 崩溃重放 / 推进后死亡丢拍 | `scheduler_tick.py:160` + `occurrences.py` |
| 台账 `scheduled_instant` 防双发 | 双闸门之间的重复点燃 | `executions.py` + `occurrences.completed_occurrence` |
| 每 home tick 锁 | 双进程同时 tick 一个 store | `scheduler.py::_get_lock_paths` |
| headless 拒绝而非孵化 | crontab 每 tick 留一个野网关 | `scheduler_gateway_gate.py` |
| `skip_memory=True` | 记忆提供者污染无上下文的 cron 会话 | 会话构造（`scheduler.py`） |
| 创建期拒绝网关重启任务 | SIGTERM→复活→重跑 的循环 | `lifecycle_guard.py` |
| `cron.max_parallel_jobs` 按 profile | 一个 home 吃光全局并行额度 | `scheduler.py::_resolve_max_parallel_workers` + `_get_parallel_pool` |

## 与其他模块的关系

- **scheduler 族**（见 `scheduler.md`）：due 扫描的产出被 `scheduler_tick` 消费；`claim_job_for_fire` 是「副作用可能存在」的分界点。
- **hermes_constants**：`get_hermes_home()`/`display_hermes_home()`——绝不硬编码 `~/.hermes`。
- **utils**：`atomic_write_text`/`atomic_json_write`/`fsync_directory`——jobs.json 与标记文件的原子性。
- **agent/**：`agent.deadline.poll_until`（有界锁轮询）、`agent/estop`（`hermes pause` 让 tick 拒绝派发）。
- **tools/cronjob_tools.py**：创建路径的模型侧入口，同样经 `create_job` 的不变量校验。

## 总结

存储族的读法是「两个证据系统 + 一组旋钮」：jobs.json 是*意图与派发状态*（含 pending_slot 戳），executions 台账是*事实记录*（确切的 `scheduled_instant` 身份）；`timezone`/`grace_minutes`/`catch_up` 是叠在时间数学上的三个旋钮，每个旋钮的 `0`/空值语义都被显式校验保护。所有不变量共享一个方向：**把「崩溃/竞争/坏输入」的后果收敛到至多一次、可恢复、可观测**。
