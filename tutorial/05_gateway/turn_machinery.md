# turn_machinery.md —— turn 租约、无界线程执行器与 agent 缓存

## 文件概览

本篇讲 turn 执行的并发机器，回答三个「为什么」：

1. **为什么忙碌保护按路由键不够，还要 turn 租约按 session_id 串行化？**——因为路由键到 session_id 是**多对一**的（`/resume` 从第二个聊天恢复、CLI 续聊、委派固定、话题游走都会让两个键映射到同一份转录），两个键可以在一份转录上交错 flush，即 turn_lease.py 注释里的 `user;user` 楔死事故（#64934）。
2. **为什么 `_UnboundedThreadExecutor` 不是 ThreadPoolExecutor？**——因为「无界」的 ThreadPoolExecutor 其实是 `min(32, cpu_count + 4)` 的有界池加静默队列；而 turn 的 submit 全部发生在事件循环上，`Thread.start()` 要在循环里等新线程拿到 GIL，turn 一多每次 submit 都冻结整个循环（#142061）。
3. **agent 缓存为什么要有内存压力信号？**——LRU 上限数的是条目数不是字节，一个缓存 agent 钉着整份活动转录（工具重的会话几十 MB），空闲 TTL 又对忙碌会话视而不见。

## 关键代码走读

### 1. turn_lease.py：按「解析后的 session_id」串行化

模块 docstring 一句话讲清全部前提：

```python
# 来源：gateway/turn_lease.py:1-10
"""Per-session turn lease — serializes the [load history -> run -> flush] region.

Busy guards are keyed by ROUTING KEY but the transcript is owned by SESSION_ID, and
``switch_session()`` makes key->id many-to-one (/resume from a second chat, CLI-continuity,
delegation pinning, topic tip-walks), so two keys could interleave flushes on one transcript
(``user;user`` wedge). The lease serializes per RESOLVED session_id: acquired right before the
transcript load, released in the dispatch layer's ``finally``; identity-checked release; a
timed-out waiter fails CLOSED (:class:`TurnLeaseTimeoutError`); only idle entries evict. Limits:
CLI-continuity processes are outside this lock; mid-turn rotation alias is closed by ``rebind``."""
```

获取端是最讲究的一段。等待者统计 `pending_acquires` 覆盖了「锁已释放但唤醒还没跑」的交接窗口——否则驱逐逻辑可能把旧锁孤立、给同一会话造出第二把锁：

```python
# 来源：gateway/turn_lease.py:98-137（节选）
    async def acquire(
        self, session_id: str, *, owner_key: str, generation: int, timeout: Optional[float] = None
    ) -> Optional[TurnLeaseToken]:
        if not session_id:
            return None
        wait = float(timeout) if timeout and timeout > 0 else DEFAULT_LEASE_WAIT  # 5.0s
        lease = self._get_or_create(session_id)
        token = TurnLeaseToken(session_id, owner_key, int(generation), lease=lease)
        if lease.lock.locked():
            logger.warning(
                "turn lease contention on session %s: routing key %s (gen %s) waiting behind "
                "in-flight turn held by routing key %s (gen %s, held %.0fs) — two routing keys "
                "are mapped to one session_id (#64934); serializing this turn behind the previous "
                "turn's flush", ...)
        lease.pending_acquires += 1
        try:
            await asyncio.wait_for(lease.lock.acquire(), timeout=wait)
        except TimeoutError:
            logger.error("turn lease wait timed out after %.0fs on session %s ... — failing closed: "
                         "refusing to run this turn UNSERIALIZED against the still-held lease", ...)
            raise TurnLeaseTimeoutError(...) from None
        finally:
            lease.pending_acquires -= 1
        lease.holder = token
        lease.acquired_at = lease.last_used = time.time()
        return token
```

三个设计决定值得背下来：

- **fail-closed**：等待超时抛 `TurnLeaseTimeoutError`，宁可拒绝这一 turn 也不无串行化地闯进转录区；外层 dispatch 把它翻成一条「请稍后重发」的提示。
- **按代释放**：租约令牌记在 `SessionState.turn.lease_tokens[run_generation]`（`session_state.py:33`），被驱逐的旧 turn 卸场时只释放自己那一代的，绝不放掉继任者的。
- **`rebind()` 关掉轮换别名**：turn 中途压缩会让 session_id 轮换，`rebind` 把**同一把** `_SessionLease` 登记到新 id 下，让 flush 目标仍被串行化；若新 id 上已有活锁，大声记日志并保留旧 id（fail-open，#64934 轮换别名边缘）。

获取点在 `run_turn_prepare.py:522`：

```python
# 来源：gateway/run_turn_prepare.py:522-541（节选）
    async def _hmwa_acquire_turn_lease(self, _quick_key, run_generation, session_entry, _session_env_tokens):
        """Serialize [load history → run → flush] per resolved SESSION_ID so another routing key on
        the same session waits for the prior flush. Fail-closed on timeout (outer dispatch returns
        a resend notice). Released in _handle_message's finally, granted per (routing key, run
        generation) so a stale unwind can't release a newer turn's."""
        ...
            _lease_token = await _lease_registry.acquire(
                session_entry.session_id, owner_key=_quick_key, generation=run_generation,
                timeout=_float_env("HERMES_TURN_LEASE_TIMEOUT", DEFAULT_LEASE_WAIT),
            )
```

注册表本体在 `run_runtime_init.py:85`（`self._turn_leases = SessionTurnLeaseRegistry()`），进程内、单事件循环——与它所扩展的路由键守卫同一可见范围。

### 2. turn_executor.py：每 turn 一个线程，线程停车复用

```python
# 来源：gateway/turn_executor.py:25-42（节选）
class _UnboundedThreadExecutor(concurrent.futures.Executor):
    """Every submitted item starts at once on its own thread; no queue, no cap.

    ``ThreadPoolExecutor(max_workers=None)`` is NOT unbounded (it is ``min(32, cpu_count + 4)``),
    which is the same silent queue at a larger number. An item goes to a parked (idle) worker when
    one exists, otherwise to a new thread. Reuse matters because ``submit`` runs on the event loop
    and ``Thread.start()`` waits there until the new thread gets the GIL: with many turns running,
    every submit (the handoff watcher's 2 s idle gates included) froze the loop (#142061). Handing an
    item to a parked worker is a queue put. A worker parked for ``idle_timeout`` exits."""
```

submit 是一个临界区完成「检查 + 交接/启动 + 登记」：有空闲 worker 就 `self._idle.pop()`（**LIFO：最暖的线程先用**，最冷的让它超时退出）然后 `inbox.put(item)`——一次队列 put，不等 GIL；没有才新建线程。线程退出边界还有一句反直觉的注释：先 `t.start()` 再登记进 `_threads`，因为到达 OS 线程上限时 `start()` 抛异常，一个没启动的线程留在集合里会让 shutdown 的 join 炸掉、跳过静默判定。

复用的线程必须对下一个 item 伪装成新线程：

```python
# 来源：gateway/turn_executor.py:77-98（节选）
    def _work(self, worker: _Worker, item) -> None:
        while item is not None:
            fut, fn, args, kwargs = item
            del item
            if fut.set_running_or_notify_cancel():
                try:
                    fut.set_result(contextvars.Context().run(fn, *args, **kwargs))
                except BaseException as exc:
                    fut.set_exception(exc)
            del fut, fn, args, kwargs  # a parked worker must not pin the last item's arguments
            item = self._park(worker)

    def _park(self, worker: _Worker):
        """Reset this thread, then wait for its next item; None means exit."""
        from gateway.turn_thread_reset import reset_reused_thread_state
        try:
            reset_reused_thread_state()
            reusable = True
        except Exception:
            logger.warning("turn worker state reset failed; retiring the thread", exc_info=True)
            reusable = False
```

两重清洁：每个 item 在**空 `contextvars.Context`** 里跑（等价于新线程的起点；注意这里有一条 `# health: allow HX012` 豁免，理由正是「worker 服务多个 item，每个都在全新 Context 里跑」）；停车前 `reset_reused_thread_state()` 清掉上一 turn 落下的线程键状态（如线程局部会话绑定），**重置失败的线程退役，绝不复用**。空闲 60 秒（`_IDLE_TIMEOUT_S`）后 worker 退出；超时与 submit 抢车的竞态也有处理——`_park` 拿锁检查后发现自己在 `_idle` 里已被摘除，说明 item 已经在路上，继续 `inbox.get()`。

### 3. run_turn.py：_handle_message_with_agent 与 _run_agent 家族

`GatewayTurnMixin`（`run_turn.py:170`）= Background + Prepare + Hygiene + Persistence 四个子 mixin。turn 主链在 `message_flow.md` 第 4 步已经走过；这里补执行侧的两个细节：

- **陈旧结果丢弃**：turn 结束先查 `self._is_session_run_current(_quick_key, run_generation)`（`run_turn.py:286`），不是当前代就 `_hmwa_discard_stale_result` 丢弃——`/stop`、`/new`、驱逐都会推进代数，慢 turn 的结果绝不能覆盖新状态。
- **流式已交付则正文不再发**：`agent_result.get("already_sent")` 时 footer 单独补发（`run_turn.py:298-299`），避免流式消费者与最终发送双份。

`_run_agent` 自身是一组小函数的组合（`_run_agent_build_turn_context`、`_run_agent_start_turn_worker`、`_run_agent_await_turn_worker`、`_run_agent_cleanup_turn_taskasks`…）：worker 在 `_UnboundedThreadExecutor` 上跑同步 agent，事件循环侧同时跑打字指示、不活跃告警、中断监测（`_run_agent_monitor_for_interrupt`、备份检查 `_run_agent_backup_interrupt_check`）；`finally` 半场 `_run_agent_cleanup_turn_tasks` 取消后台任务、flush 流、按代释放会话槽。

### 4. agent 缓存与内存压力

```python
# 来源：gateway/run.py:51-53
# Per-session AIAgent cache bounds (agents are heavy); see _enforce_agent_cache_cap/_session_housekeeping_watcher.
_AGENT_CACHE_MAX_SIZE = 128
_AGENT_CACHE_IDLE_TTL_SECS = 3600.0  # evict agents idle for >1h
```

缓存的实现与驱逐策略在 `run_agent_cache.py`（GatewayAgentCacheMixin，还兼管会话模型覆盖 `/model`、run 代数、会话级重置）。关键规则：**驱逐必须在 owning profile 的作用域里做**——`_run_release_in_profile_scope` 让 TTL/LRU/内存压力三条驱逐路径都过 `_profile_runtime_scope`，这样 `on_session_end` 与 memory flush 才会命中会话所属 profile 的 provider（HX005：曾经有驱逐在启动作用域下 flush，把次要 profile 的记忆写进了默认库）。

```python
# 来源：gateway/agent_cache_pressure.py:1-11（节选）
"""Memory-pressure bounds for the gateway's per-session AIAgent cache.

Each cached ``AIAgent`` pins its full live transcript (tens of MB on a tool-heavy
session); the LRU cap counts entries, not bytes, and the idle TTL defers eviction
for busy sessions, so neither sees actual memory use.  This module supplies that
signal — own anonymous RSS against a budget derived from the cgroup limit — and
``GatewayRunner`` sheds LRU transcripts via soft eviction (rebuilt from the
persisted session next turn).  Pure/read-only; config under ``agent.agent_cache``."""
```

参数同样克制：自动预算取 cgroup 限额的 65%（`_AUTO_BUDGET_FRACTION`）——留给 SIGTERM flush 完成的时间；512 MB 下限（小容器每个回合都驱逐等于没有暖前缀）；每轮最多驱逐 16 个；**最热的 8 个会话永不驱逐**（`_DEFAULT_PROTECT_RECENT`，它们的提示缓存最值钱，驱逐只是把成本挪到下一 turn）。

## 核心类/函数

| 符号 | 位置 | 职责 |
|------|------|------|
| `SessionTurnLeaseRegistry` | turn_lease.py:74 | 每 session_id 一把 asyncio 锁；容量 512，只驱逐空闲条目 |
| `acquire()` | turn_lease.py:98 | 取租约；等待 5s（`DEFAULT_LEASE_WAIT`），超时 fail-closed 抛 `TurnLeaseTimeoutError` |
| `rebind()` | turn_lease.py:139 | 压缩轮换后把持有中的租约别名到新 session_id；仅持有者可 rebind |
| `release()` | turn_lease.py:165 | 幂等；仅当 token 就是当前持有者才生效（陈旧 token 安全空操作） |
| `TurnLeaseTimeoutError` | turn_lease.py:32 | 等待预算耗尽——调用方不得进入 turn 区域 |
| `_UnboundedThreadExecutor` | turn_executor.py:25 | 每 item 一线程；无队列无上限；parked worker 60s LIFO 复用 |
| `reset_reused_thread_state()` | turn_thread_reset.py | 清线程键状态；失败则线程退役 |
| `_handle_message_with_agent()` | run_turn.py:200 | turn 主链（哨兵守卫下） |
| `_hmwa_acquire_turn_lease()` | run_turn_prepare.py:522 | 转录装载前取租约；token 按 run_generation 归档 |
| `GatewayAgentCacheMixin` | run_agent_cache.py:46 | agent 缓存、`/model` 覆盖、run 代数；驱逐走 profile 作用域 |
| `AgentCacheBounds` / `pressure` | agent_cache_pressure.py:29/43 | cgroup 推导的内存预算与软驱逐参数 |

## 本组文件清单

| 文件 | 角色 |
|------|------|
| `turn_lease.py` | 每会话 turn 租约：串行化 load→run→flush，fail-closed，rebind |
| `turn_executor.py` | `_UnboundedThreadExecutor`：无界线程、parked worker 复用 |
| `turn_thread_reset.py` | 复用线程的状态重置 |
| `turn_context.py` | TurnContext：单 turn 的执行上下文对象 |
| `active_lease_io.py` | 活跃租约的 I/O 读写（跨进程可见的活跃槽） |
| `run_turn.py` | GatewayTurnMixin：`_handle_message_with_agent`、`_run_agent` 主链 |
| `run_turn_prepare.py` | GatewayTurnPrepareMixin：会话解析、历史装载、租约获取 |
| `run_turn_runner.py` | TurnRunner：agent 实例化与同步执行的封装 |
| `run_turn_runner_approval_settle.py` | 审批结算（approve/deny 后的 turn 续行） |
| `run_turn_runner_clarify_delivery.py` | 澄清提问的投递 |
| `run_turn_followup_ack.py` | 队列跟进消息的确认 |
| `run_turn_hygiene.py` | GatewayTurnHygieneMixin：上下文卫生（压缩失败冷却阶梯） |
| `run_turn_persistence.py` | GatewayTurnPersistenceMixin：转录/账本落盘半场 |
| `run_turn_progress.py` | GatewayTurnProgressMixin：迭代进度广播 |
| `run_background.py` | GatewayBackgroundMixin：后台进程 watcher 装配 |
| `run_agent_cache.py` | GatewayAgentCacheMixin：缓存/覆盖/代数/会话重置 |
| `agent_cache_pressure.py` | 内存压力信号与软驱逐参数 |
| `stuck_loop_counts.py` | 卡死循环计数（恢复失败升级 suspended） |
| `run_voice.py` | GatewayVoiceMixin：语音频道 |
| `streaming_tts_consumer.py` | LLM 增量→PCM 的 TTS 消费者（详见 streaming.md） |

## 与其他模块的关系

- 上游是 `message_flow.md` 第 3 步的接纳层：durable FIFO 保证输入不丢，本篇的租约保证**执行**不交错——两者合起来才是完整的「一个会话一个 turn」。
- `agent/` 是真正的 turn 本体：TurnRunner 调 AIAgent；租约区域串行化的正是 agent 的转录读写。
- 驱逐与 shutdown 都必须进入 `_profile_runtime_scope`（`run_agent_cache.py` / `run_shutdown.py`），是 Profile scope（HX005/PS-P05）在执行层的落点。
- `SessionState.turn`（`session_state.py`）是租约令牌与 run 代数的家；`hermes_state_runtime.py` 的 admission 表是另一维度的「执行权」记录（durable），两者互补：租约管进程内，admission 管跨重启。

## 总结

这一层的三个组件各堵一个真实事故的洞：**租约**堵「两个路由键交错写一份转录」（#64934），手段是把串行化点从「谁收到了消息」换到「这份转录属于谁」，等待超时宁可 fail-closed；**无界执行器**堵「submit 冻结事件循环」（#142061），手段是彻底放弃队列——每 turn 一线程 + 停车复用 + 双重上下文清洁；**内存压力驱逐**堵「LRU 数不出字节」，手段是拿 cgroup 推导预算、软驱逐（下 turn 从持久化重建）、保护最热的会话。读这类代码的方法论：每个看起来过度的防御，注释里都躺着一个带编号的事故。
