# 调度器族 —— tick 循环、线程监督与多路复用派发

## 文件概览

`cron/scheduler.py`（4,416 行门面）负责「到点了去执行」：`tick()` 的准入与派发在兄弟文件 `scheduler_tick.py`，线程模型在 `scheduler_thread.py` + `scheduler_provider.py`，执行体（agent 会话、脚本、外部 worker）与清理留在门面内，投递在 `scheduler_delivery*.py`，执行前检查在 `scheduler_preflight.py` / `scheduler_prompt.py`。整族的纪律是：**门面保留调用点，行为按主题下沉；所有兄弟件用 `_sched` 晚绑定引用门面，让 monkeypatch 定义模块仍然生效**。本篇走读 tick 主干、线程监督、多路复用、headless 网关门、不活动看门狗与外部 worker 自举，并给出全族文件清单。

## 关键代码走读

### tick()：准入即持锁

```python
# cron/scheduler_tick.py:33-43
def tick(verbose=True, adapters=None, loop=None, sync=True, *, can_dispatch=None,
         headless: bool = False):
    from hermes_cli.backend_retirement import retirement

    # Hold admission through the entire scan/advance/submit handoff. A predicate alone races
    # prepare after the check but before a due job enters the running-job ledger.
    with retirement.work() as admitted:
        if not admitted:
            return 0
        return _tick_admitted(verbose, adapters, loop, sync, can_dispatch=can_dispatch,
                              headless=headless)
```

`tick()` 是 tick 的公共入口，但真正的流程在 `_tick_admitted()`（行 92-204）：先做「旧代码让位」检查（进程的 checkout 被 `hermes update` 换过、又有更新鲜的网关持有 runtime 锁时抛 `CronTickYielded`，让位而不是用混合的 `sys.modules` 跑任务），然后拿 `<home>/cron/.tick.lock`。随后的顺序非常关键：

```python
# cron/scheduler_tick.py:160-167
        # Advance next_run_at for recurring jobs FIRST, under the lock, before any execution
        # (at-most-once). Re-advancing running jobs keeps the grace window alive; mark_job_run
        # overwrites it on completion. Composes with the claim-time advance in claim_job_for_fire.
        due_jobs = _advance_or_drop_recurring(_sched, due_jobs)
        if not due_jobs:
            _sched._sweep_mcp_orphans()
            return 0
```

**先推进 `next_run_at`、再执行**——这是「至多一次 occurrence」不变量的实现位置：中途崩溃只会丢失一次执行，绝不会每次重启都重放。当存储拒绝写入（磁盘满/只读）时 `_advance_or_drop_recurring` 只放行 one-shot、跳过循环任务（行 62-72）——没有持久推进的循环任务一旦中途崩溃必然重燃，跳过就是「至多一次」这一侧。

`headless=True` 的 tick（系统 crontab 的 `hermes cron tick`）在派发前多一道门：

```python
# cron/scheduler_gateway_gate.py:66-83
def refuse_agent_jobs_without_gateway(due_jobs: list) -> list:
    """Return the due jobs a headless tick may dispatch; agent jobs are held back (skipped, not
    failed) when no ready gateway serves this home. Logs once per tick, not once per job."""
    from hermes_constants import get_hermes_home

    agent_jobs = [job for job in due_jobs if not job.get("no_agent")]
    if not agent_jobs:
        return due_jobs
    home = get_hermes_home().resolve()
    hint = _gateway_unavailable(home)
    if hint is None:
        return due_jobs
    ids = [str(job["id"]) for job in agent_jobs]
    _note_fire_refused(ids, f"Skipped: {hint}")
    logger.warning(
        "Cron tick for %s skipped %d agent job(s) (%s): %s",
        home, len(ids), ", ".join(ids), hint)
    return [job for job in due_jobs if job.get("no_agent")]
```

门的原则是「**拒绝，而不是孵化**」：`run_canonical_job → connect_gateway → ensure_gateway_runtime` 会孵化一个无人管理的网关守护进程，对交互调用者是对的，对 crontab 的每分钟 tick 是灾难。拒绝时 `_note_fire_refused`（行 48-63）盖 `last_fire_error`、*清掉* due 扫描刚写的 `pending_slot` 与派发标记——槽位从未移交，不能留下会被「恢复」的痕迹，due 时刻保持不动，网关回来后的下一拍照常触发。

### 一个 ticker 顺序遍历所有 profile

```python
# cron/scheduler_provider.py:539-547
    def _start_multiplex(
        self, stop_event, *, profile_homes, adapters=None, loop=None, interval=60,
        can_dispatch=None, profile_adapters=None, default_profile=None, profile_gate=None,
        profile_bot_platforms=None,
    ):
        """Tick every profile's store, each scoped via ``_profile_cron_scope``. ``profile_gate(name,
        home)``, when given, is consulted every cycle; a rejected profile is neither ticked nor
        heartbeated."""
        from cron.scheduler import tick as cron_tick
```

`_start_multiplex` 是「Axis B — 触发器」提供者：**一个** ticker 线程每周期在 `_profile_cron_scope(home)`（home + secret 作用域 + 终端作用域）内顺序 tick 每个 served home。绝不 N 线程——模块全局量（inflight 表、锁表）会跨线程竞争。每个 home 的 store 打开、锁路径、失败计数、任务 env 构造、`on_session_end` 冲刷全部活在这个守卫里：曾经有一个在进入作用域*之前*打开的 store，把次要 profile 的运行记录写进了启动 profile 的 `jobs.json`。

每个 home 的恢复 + 心跳彼此隔离（行 575-584 附近）：一个坏 store 不许拖垮其他 profile 的启动；profile 可能已被删除，心跳绝不为已删的 home 重建 cron 工作区（#47368）。

### 线程监督：死掉的 ticker 会被复活

门面里的每个守卫都能在单次 tick 失败时保活循环，但没有任何东西能注意到「线程已经整个结束」——网关继续服务、`ticker_heartbeat` 冻结、任务再也不触发，直到重启（#111010）。监督者是最外层：

```python
# cron/scheduler_thread.py:52-64
    def restart_if_dead(self) -> bool:
        """Respawn the ticker when it crashed without ``stop_event``; True when a restart happened."""
        if self._stop_event.is_set() or self._thread.is_alive() or not self._crashed:
            return False
        self.restarts += 1
        logger.error(
            "Cron ticker thread %r died without a stop request; restarting (restart #%d). Scheduled jobs "
            "did not fire while it was down — check errors.log for the escaping exception.",
            self._name, self.restarts,
        )
        self._thread = self._spawn()
        self._thread.start()
        return True
```

只有「带着异常逃出 target」才算死（`_crashed` 标记）：外部提供者的 `start()`（Chronos）武装远程一次性触发后*按设计返回*，那是活着的 ticker，不是尸体。监督按 served home 一份，不是按进程一份。

### 不活动看门狗：按空闲时间，不按墙钟

```python
# cron/scheduler.py:1186-1199
def _cron_inactivity_seconds() -> float:
    """..."""
```

`_run_agent_with_watchdog`（行 1937）用 `agent/session_activity.AwakeIdleMeter` 测 agent 的*空闲*时间：默认 600s 空闲即硬中断（`HERMES_CRON_TIMEOUT` 覆盖，`0` = 无限）。空闲时间而不是墙钟意味着：卡死的会话被掐掉、不能独占调度器；长但活跃的任务（一直在产 token）永不被误杀。随行脚本（预跑脚本或 `no_agent=True` 的任务）由脚本超时（`_DEFAULT_SCRIPT_TIMEOUT`，3600s）单独封顶。看门狗与 `scheduler_liveness.py` 读同一个信号、作用于两条边：看门狗在空闲越限时中断；进度戳在空闲保持短时刷新 `progress_at`——所以「健康拥有者 vs 僵尸」的判定是「自上次戳以来的沉默」，而不是「运行时长」（#115692）。

### 外部 worker 自己完成依赖自举

重启安全的 worker 是 `sys.executable -m cron.scheduler --external-worker-file …`——一个完整 Hermes 入口，但 `hermes_bootstrap` 只在其 `__main__` 里跑，而 `-m` 先执行的是包本身：

```python
# cron/__init__.py:7-9
# The restart-safe external worker runs as ``-m cron.scheduler``, which executes this package
# first: boot PM dependencies before ``cron.jobs`` reaches a third-party import. A no-op
# unless ``_launch_external_cron_worker`` marked this process. See cron/worker_bootstrap.py.
from cron.worker_bootstrap import worker_bootstrap as _boot_external_worker

_boot_external_worker()
```

`scheduler_worker_env.py` 只是把 committed 代的 `site-packages` 钉回子进程 `PYTHONPATH`——钉住路径不等于租用：没有租约，PM 收集器可以在网关退出后删掉那一代（#122290）。`worker_bootstrap()`（`cron/worker_bootstrap.py:49-55`）调 `pm.environments.activate_dependencies`——正是 `hermes_bootstrap` 为其他入口做的同一个调用——租用该代、执行 `.pth` 文件、在任何第三方 import 之前激活。激活失败是致命的：worker 在所有权 ack 之前退出（这会被上报为一次派发失败），而不是跑在无租约的一代上等收集器删除。网关自己绝不重跑这个自举（#122222）。依赖自举只覆盖依赖；`finish_worker_boot()`（行 58-67）在 `__main__` 里跑 `hermes_bootstrap`（可能因源码更新 re-launch 整个 worker），之后才读 payload、摘标记——恢复/重执行必须重放整个 worker，绝不能「ack 之后 payload 没了、依赖没启动」。

## 核心类/函数

| 符号 | 位置 | 职责 |
|---|---|---|
| `tick()` | `scheduler_tick.py:33` | tick 公共入口；`retirement.work()` 内持准入 |
| `_tick_admitted()` | `scheduler_tick.py:92` | 让位 gate → tick 锁 → 预派发清扫 → due 扫描 → 先推进后派发 |
| `_advance_or_drop_recurring()` | `scheduler_tick.py:62` | 存储拒绝时只放行 one-shot（至多一次侧） |
| `refuse_agent_jobs_without_gateway()` | `scheduler_gateway_gate.py:66` | headless tick 拒绝 agent 任务而非孵化网关 |
| `_note_fire_refused()` | `scheduler_gateway_gate.py:48` | 盖 `last_fire_error`、清 `pending_slot`/`run_claim` |
| `_start_multiplex()` | `scheduler_provider.py:539` | 单 ticker 顺序遍历 served homes，`_profile_cron_scope` 逐个绑定 |
| `SupervisedTickerThread` | `scheduler_thread.py:19` | `restart_if_dead` 复活带异常逃出的 ticker |
| `_profile_cron_scope()` | `scheduler_provider.py:119` | per-tick home/secret/terminal 作用域 ContextVar |
| `_inflight_key()` | `scheduler.py:581` | `(home key, job id)`——一个进程 tick N 个 home，任务 id 不唯一 |
| `try_register_running_job()` / `release_running_job()` | `scheduler.py:796/826` | inflight 认领/释放（释放须传注册 home） |
| `sweep_stale_inflight()` | `scheduler.py:1035` | 按沉默时间强制释放泄漏的 claim |
| `_cron_inactivity_seconds()` | `scheduler.py:1186` | 看门狗上限（默认 600s，`HERMES_CRON_TIMEOUT`） |
| `_run_agent_with_watchdog()` | `scheduler.py:1937` | 空闲超限 → 硬中断 cron 会话 |
| `_launch_external_cron_worker()` | `scheduler.py:3602` | spawn 重启安全外部 worker，钉 PYTHONPATH + 置 `_HERMES_CRON_WORKER_BOOT` |
| `owns_cron_tick_for()` / `live_gateway_ticking()` | `scheduler_ownership.py` | 「谁拥有某 home 的 tick」两个谓词（探测失败一律答「否」） |
| `register_ticked_homes()` | `scheduler_ownership.py` | 每 cycle 重发布 tick 集合并回收离开 home 的线程池 |

## 本组文件清单

| 文件 | 角色 | 关键符号 |
|---|---|---|
| `cron/scheduler.py` | 门面：执行体、inflight 簿记、清理 | `tick 调用点`, `_inflight_key`, `_run_agent_with_watchdog`, `_launch_external_cron_worker` |
| `cron/scheduler_tick.py` | tick 准入 + 派发顺序 | `tick`, `_tick_admitted`, `_advance_or_drop_recurring` |
| `cron/scheduler_thread.py` | 监督线程 | `SupervisedTickerThread.restart_if_dead` |
| `cron/scheduler_provider.py` | 触发器提供者 + 多路复用 | `_start_multiplex`, `_profile_cron_scope` |
| `cron/scheduler_ownership.py` | tick 所有权谓词 + ticked home 集合回收 | `owns_cron_tick_for`, `register_ticked_homes` |
| `cron/scheduler_gateway_gate.py` | headless tick 的网关门 | `refuse_agent_jobs_without_gateway` |
| `cron/scheduler_authority.py` | 传输层执行；output/投递仍在派发方 | `reconcile_pending`, `pause_for_unknown` |
| `cron/scheduler_bookkeeping.py` | 终局簿记 | `fail_empty_response`, `finish_interrupted_run` |
| `cron/scheduler_delivery.py` | 投递目标解析 + 各发送通道 | `_deliver_result`, transcript mirroring |
| `cron/scheduler_delivery_origin.py` | origin 的 relay 出站判别器 | `stamp_origin_discriminators` |
| `cron/scheduler_delivery_room.py` | `deliver: room:<id>[@<profile>]` 群聊房间投递 | 房间日志追加 |
| `cron/scheduler_detached_worker.py` | 超时后仍存活的 worker 的回收 | `_close_late_session_db_result` |
| `cron/scheduler_diagnostics.py` | 私有运行文档诊断（脱敏） | `format_run_error`, `external_worker_stderr_tail` |
| `cron/scheduler_failure_copy.py` | 一行失败通知的话术 | `cron_output_dir_display` |
| `cron/scheduler_liveness.py` | 看门狗循环 + 进度戳 | 空闲信号双边缘 |
| `cron/scheduler_preflight.py` | 派发前检查 + 共享路由适配器视图 | `_is_transient_provider_resolve_error`, `SharedRouteAdapters` |
| `cron/scheduler_prompt.py` | prompt 组装 + 注入/渗出守卫 | `context_from` 注入, 扫描守卫 |
| `cron/scheduler_script.py` | 预跑脚本执行 + claim 心跳 | 超时/进程树终止 |
| `cron/scheduler_worker_env.py` | 外部 worker 的 import 路径 | committed site-packages 钉回 |
| `cron/scheduler_worker_failure.py` | worker 死亡后的不确定结果投影 | `record_unknown_worker_outcome` |
| `cron/scheduler_worktree_maintenance.py` | worktree 清扫的进程级串行化 | 一扫一时间、一 repo 一区间 |
| `cron/worker_bootstrap.py` | 外部 worker 的 PM 依赖自举 | `worker_bootstrap`, `finish_worker_boot`, `WORKER_MARKER` |

（`cron/constants.py`、`env_settings.py` 与任务存储族在 `jobs.md` 清单；面向用户的蓝图/建议族在 `kanban_dispatcher.md` 清单。）

## 与其他模块的关系

- **gateway/run.py**：`_cron_tick_profile_homes`（行 1654）决定宿主进程 tick 哪些 home（served 集 + 活动 profile，与 `gateway.multiplex_profiles` 无关——该旗标管适配器，不管 tick 集合）；`_cron_profile_gate`（行 1672）让位给跑自己网关的 profile，liveness PID 与 `os.getpid()` 比较。
- **pm/**：外部 worker 经 `activate_dependencies` 租用 committed 代。
- **agent/**：cron 会话是独立 AIAgent；`agent/estop.check_paused` 在 tick 里被查询；`agent/session_activity.AwakeIdleMeter` 是看门狗信号源。
- **tools/**：任务崩溃遗留的 MCP stdio 孤儿由 tick 里的 `_sweep_mcp_orphans` 回收。
- **hermes_cli/cron.py**：`hermes cron tick` 调 `tick(headless=True)`（默认 headless 拒绝；`hermes cron run` 与进程内 ticker 不 headless）。

## 总结

调度器族的核心顺序是三句话：**准入先让位、派发先推进、执行先自举**。让位 gate 保证旧代码不混合执行；「先推进 `next_run_at` 再执行」把崩溃的代价从重放降为丢失一次；外部 worker 在任何第三方 import 前租用依赖代。单 ticker 多路复用 + inflight 双元组键，则是「一个进程服务多个 profile」这条仓库级不变量在 cron 里的全部投影。
