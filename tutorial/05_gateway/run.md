# gateway/run.py —— 网关进程的启动、门面与关闭

## 文件概览

`gateway/run.py`（5,204 行）是网关的门面：模块 docstring 自述 "Gateway runner — entry point for messaging platform integrations"，对外暴露 `start_gateway()`（进程生命周期，实现在 `gateway/run_bootstrap.py`）和 `GatewayRunner`（控制器类，实现在 19 个 mixin 里）。真正的 `main()` 做的是「进程级」的事：进程身份注册、启动看门狗、UTF-8 stdio、venv 同步——都是「让这个进程活得健康、死得干净」的工程，而消息怎么跑那是 mixin 的事。本篇同时覆盖 gateway 顶层的**进程生命周期组**（引导、多 profile 装配、关闭排水、状态可观测、控制面、托管房间、看板 watcher）约 80 个文件。

## 关键代码走读

### 1. main()：先保证「进程」健康，再谈「服务」

main() 的第一步不是加载配置，而是拒绝解析失败的 config（宁可退不出来也不能带着半猜的默认值启动），然后按固定顺序执行四个 best-effort 的进程级步骤：

```python
# 来源：gateway/run.py:5072-5101（节选）
def main():
    """CLI entry point for the gateway."""
    # Before any config-dependent startup (watchdog, DB opens, provider resolution).
    _guard_corrupt_user_config()
    from hermes_cli.resource_limits import apply_malloc_arena_max  # runs before any thread (glibc latches)
    os.environ.setdefault("AI_AGENT", "hermes-agent")
    os.environ.setdefault("HERMES_AGENT", "true")

    def _register_identity() -> None:
        # Ledger registration + Windows job-object attach so update-time reapers can identify this gateway.
        from hermes_cli.process_identity import attach_self_to_kill_on_close_job, register_self
        register_self("gateway")
        attach_self_to_kill_on_close_job()

    def _arm_watchdog() -> None:
        # Armed before config load / DB opens so a pre-loop deadlock is respawned by the supervisor instead
        # of wedging as a live-PID zombie. GatewayRunner disarms it.
        from hermes_startup_watchdog import arm_startup_watchdog
        arm_startup_watchdog()

    def _utf8_stdio() -> None:
        # Windows: gateway logs and banner would UnicodeEncodeError on cp1252 consoles. No-op on POSIX.
        from hermes_cli.stdio import configure_windows_stdio
        configure_windows_stdio()

    for _step in (apply_malloc_arena_max, _register_identity, _arm_watchdog, _utf8_stdio):
        _best_effort(_step)
```

顺序是有讲究的：`apply_malloc_arena_max` 必须在任何线程启动前跑（glibc 会在第一个线程上锁死 arena 设置）；看门狗必须在配置加载/DB 打开之前武装——「启动早期死锁」是最难排查的僵尸形态，让监督者直接重新拉起比挂着一个活 PID 强。进程身份注册（`hermes_cli/process_identity.py` + Windows job object）让 `hermes update` 的收割器能认出「这是网关」，而不是误杀别的 Python 进程。随后是 PM 的 venv 同步检查与 post-update bootstrap，再进 `asyncio.run(start_gateway(config))`。

### 2. 退出必须「防卡死」：os._exit 后门

`start_gateway()` 自己完成全部优雅拆除（适配器断连、会话保存、SQLite 关闭、cron/MCP 停止、PID 文件与运行时锁释放），但 main() 仍然在它返回或抛 `SystemExit` 之后强制硬退出：

```python
# 来源：gateway/run.py:5139-5155（节选）
    try:
        success = asyncio.run(start_gateway(config))
        exit_code = 0 if success else 1
    except SystemExit as e:
        exit_code = 0 if e.code is None else e.code if isinstance(e.code, int) else 1
    _exit_after_graceful_shutdown(exit_code)
```

原因写在 `run.py:5142-5150` 的注释里：解释器正常退出会 `Py_FinalizeEx` join 所有非 daemon 线程——一个卡死在无超时 LLM 调用上的 worker 线程能把已经拆除一半的网关永远吊住，监督者没法重启它（#53107）。所以 `_exit_after_graceful_shutdown`（`run.py:5158`）显式做了本该由 atexit 做的事：flush stdio → 释放 PID/锁 → 盖「clean exit」戳（`lifecycle_ledger.py`，下次启动的不洁死亡检测只认 SIGKILL/OOM）→ flush 指标 → CPU profile → 有界日志排水，最后 `os._exit(exit_code)`。

### 3. start_gateway()：门面把生命周期委托给 bootstrap

```python
# 来源：gateway/run.py:5052-5056
async def start_gateway(config: Optional[GatewayConfig] = None, replace: bool = False,
                        verbosity: Optional[int] = 0, force: bool = False, idle_exit: bool = False) -> bool:
    """Run the process lifecycle; the runner facade remains the public entrypoint."""
    from gateway.run_bootstrap import start_gateway as bootstrap
    return await bootstrap(config, replace, verbosity, force, idle_exit)
```

bootstrap 阶段（`run_bootstrap.py`）串联：host 附着判定（`_host_attach_or_none`：ATTACH 附着现役实例 / REFUSE 拒绝第二实例 / REPLACE 走替换握手）→ 替换旧实例 → 构造 runner、连接适配器 → 启动 cron 与家务 watcher → 装信号 handler → 关闭尾巴。测试把各阶段当 `gateway.run` 属性 patch，所以这几个阶段函数以 `_start_gateway_*` 名字从 bootstrap 模块导入回门面（`run.py:5010-5013`）。

### 4. GatewayRunner 构造：多路复用从第一行就生效

```python
# 来源：gateway/run.py:3411-3449（节选）
    def __init__(self, config: Optional[GatewayConfig] = None):
        global _gateway_runner_ref
        self.config = config if config is not None else load_gateway_config_for_runner()
        ...
        # Multiplexer flag flips agent.secret_scope.get_secret() to fail-closed on unscoped credential
        # reads, so a missed migration crashes loudly instead of leaking a cross-profile value.
        try:
            from agent.secret_scope import set_multiplex_active
            set_multiplex_active(bool(getattr(self.config, "multiplex_profiles", False)))
        except Exception:
            logger.debug("could not set multiplex-active flag", exc_info=True)
        self.adapters: dict[Platform, BasePlatformAdapter] = {}
        self._profile_adapters: dict[str, dict[Platform, BasePlatformAdapter]] = {}
        self._profile_configs: dict[str, Any] = {}
        self._warn_if_docker_media_delivery_is_risky()
        _gateway_runner_ref = _weakref.ref(self)

        self._init_runtime_settings()
        self._init_session_store()
        self._init_lifecycle_state()
        self._init_runtime_caches()
        self._init_session_db()
        self._init_registries_and_clocks()
```

三个要点：`self.adapters` 永远只是**默认 profile** 的适配器表，次要 profile 的在 `_profile_adapters`（谁直接读 `self.adapters[p]` 做投递就会把回复发给默认 bot）；多路复用开关会把 `agent.secret_scope` 切成 fail-closed——任何未经作用域绑定的凭据读取直接崩，而不是静默泄漏跨 profile 的值（#64674/#72348）；`_session_db` 是一个 property（`run.py:3510-3516`），**每次访问**都按当前活动作用域解析 SQLite 句柄并按路径缓存，因为 `SessionDB()` 在构造时读 context 局部的 `HERMES_HOME`，冻结在 `__init__` 里会把所有 profile 的行写进根 home（#88532/#98573）。

### 5. SessionState：19 个 dict 变一个容器

历史上 GatewayRunner 有约 19 个按 session_key 键控的 dict（运行中 agent、排队事件、待审批……），字段该在什么时候清、由谁清全靠口口相传，边界漂移和「整体清空竞态」不断。现在收敛为一个容器，**按清理时机分三个生命周期格**：

```python
# 来源：gateway/session_state.py:1-4、93-99
"""Per-session gateway state in one container (replaces ~19 session_key-keyed dicts on
GatewayRunner that bred boundary drift and wholesale-reset races).  Scopes follow where each dict
was CLEARED: ``turn`` at the end of every turn; ``conversation`` at conversation boundaries (/new,
/resume, auto-reset, expiry); ``persistent`` fields have their own lifecycles."""
...
@dataclass
class SessionState:
    """All per-session gateway state, grouped by lifecycle scope."""

    turn: TurnState = field(default_factory=TurnState)
    conversation: ConversationState = field(default_factory=ConversationState)
    persistent: PersistentState = field(default_factory=PersistentState)
```

`TurnState.lease_tokens` 特意不在 `clear()` 里清——turn 租约由 `_release_turn_lease` 精确释放一次（见 `turn_machinery.md`）；`PersistentState.run_generation` 单调递增**永不重置**，陈旧 turn 靠它自认过时。

### 6. 关闭排水：三种文件、一条流水线

关闭侧的分工：`run_shutdown.py`（GatewayShutdownMixin）逐会话 `_finalize_session`（在**该会话所属 profile 的作用域里** flush——AGENTS.md 明确把 shutdown 列为必须绑定 `_profile_runtime_scope` 的非 turn 路径）；`shutdown_flush.py` 排空脏转录与投递队列；`shutdown_forensics.py` 在排水失败时留下取证现场；`shutdown_watchdog.py` 是关闭本身的看门狗（拆到一半卡死时至少放监督者进来）。最后回到上文 `os._exit` 后门。

## 核心类/函数

| 符号 | 位置 | 职责 |
|------|------|------|
| `main()` | run.py:5072 | CLI 入口：config 守卫、进程身份、看门狗、UTF-8、argparse、硬退出后门 |
| `_exit_after_graceful_shutdown()` | run.py:5158 | 显式执行 atexit 义务后 `os._exit`，防非 daemon 线程卡死解释器退出 |
| `start_gateway()` | run.py:5052 | 门面入口；委托 `run_bootstrap.py` 走 host 附着/替换/连接/信号全流程 |
| `_host_attach_or_none()` | run.py:5016 | 单实例仲裁：附着现役 host 网关或拒绝第二实例（`--force` 豁免） |
| `GatewayRunner` | run.py:3322 | 19-mixin 门面控制器；`adapters`/`_profile_adapters`/`_profile_configs` 三张表 |
| `_session_state()` | run.py:3377 | get-or-create 每会话 `SessionState` 容器 |
| `_session_db`（property） | run.py:3510 | 按活动 profile 作用域解析 AsyncSessionDB，按路径缓存句柄 |
| `SessionState/TurnState/...` | session_state.py:17-99 | turn/conversation/persistent 三格生命周期容器 |
| `legacy_dict_property()` | session_state.py:214 | 旧 dict 属性的活视图（测试兼容层） |

## 本组文件清单

### A. 门面与引导

| 文件 | 角色 |
|------|------|
| `run.py` | 门面：main()、GatewayRunner 装配、退出后门 |
| `run_bootstrap.py` | start_gateway 全流程阶段函数（host 附着、替换、信号） |
| `run_common.py` | runner 各 mixin 共享的小工具（CSV→set 等） |
| `run_startup.py` | GatewayStartupMixin：横幅、会话恢复、预热 |
| `run_watchers.py` | GatewaySessionWatchersMixin：待投递队列/心跳 watcher |
| `run_active_work_verb.py` | 「正在做什么」动词短语（状态行/通知文案） |
| `readiness.py` | 就绪判定（readiness 门） |
| `lifecycle_ledger.py` | 进程生命周期台账（干净退出戳、不洁死亡检测） |
| `__init__.py` | 包标记 |
| `AGENTS.md` | 本层开发规约（§Profile scope 等） |

### B. 适配器生命周期、配置与多 profile

| 文件 | 角色 |
|------|------|
| `run_adapters.py` | GatewayAdapterLifecycleMixin：创建/连接/断开适配器、intake/delivery 两个缝 |
| `run_adapters_recovery.py` | GatewaySecondaryReconnectMixin：次要平台断线重连 watcher |
| `run_config_loaders.py` | GatewayConfigLoadersMixin：加载每个被服务 profile 的网关配置 |
| `run_profile_reconcile.py` | GatewayProfileReconcileMixin：profile 增删后对账 hooks/观察者/适配器 |
| `run_runtime.py` / `run_runtime_init.py` | 运行时初始化（executor、租约注册表、时钟、缓存） |
| `config.py` | GatewayConfig/Platform/PlatformConfig 数据模型 |
| `config_env.py` | relay 激活时关闭直连适配器（`_relay`）；环境派生配置 |
| `config_loader.py` | 网关配置文件装载 |
| `profile_routing.py` | `profile_routes` 路由表解析 |
| `owner_identity.py` | owner 身份（home channel 判定） |
| `platform_activation.py` | 平台启用/连通判定（配合 platform_registry） |
| `hooks.py` | shell hooks / 生命周期观察者按 profile 注册 |

### C. 关闭、重启与排水

| 文件 | 角色 |
|------|------|
| `run_shutdown.py` | GatewayShutdownMixin：优雅关闭、`_finalize_session`（profile 作用域内 flush） |
| `run_shutdown_session_end.py` | GatewaySessionEndMixin：会话结束钩子（memory flush 等） |
| `shutdown_flush.py` | 排空脏转录/队列 |
| `shutdown_forensics.py` | 排水失败的取证记录 |
| `shutdown_watchdog.py` | 关闭过程看门狗 |
| `drain_control.py` | 排水状态机（drain/after-turn 等待） |
| `restart.py` | `/restart` 重启编排（含 detached 重启助手） |
| `restart_loop_guard.py` | 重启循环熔断 |
| `restart_notice.py` | 重启前后通知 |
| `code_skew.py` | `code_sha`/`code_version` 戳（更新器验证舰队一致性） |

### D. 状态、可观测与空闲

| 文件 | 角色 |
|------|------|
| `status.py` | 网关状态/PID 文件/作用域 token 锁（`acquire_scoped_lock`） |
| `status_inline_source.py` / `status_phrases.py` | 状态行来源与文案 |
| `status_lock_dir.py` / `status_pid_records.py` / `status_scoped_locks.py` / `status_served.py` | 锁目录、PID 记录、凭据作用域锁、被服务 profile 集合 |
| `disk_status.py` / `memory_status.py` | 磁盘/内存水位报告 |
| `cgroup_cleanup.py` | cgroup 清理（容器环境） |
| `display_config.py` | display.* 显示档位（high/medium/low/minimal） |
| `systemd_notify.py` / `systemd_stop_mark.py` | sd_notify 就绪/停止标记 |
| `scale_to_zero.py` | 空闲缩容到零 |
| `run_idle_exit.py` / `run_idle_gates.py` | 空闲退出与空闲门（2s gate 等） |
| `run_housekeeping_disk.py` | 磁盘家务（缓存清理） |
| `run_api.py` | runner 的 API 面（供 run_api 层查询） |

### E. 控制面、宿主与桌面集成

| 文件 | 角色 |
|------|------|
| `control_socket.py` / `control_dispatch.py` / `control_resolve.py` | 控制 Unix socket：动词表与解析（relay-link、pause-for-update 等） |
| `host_attach.py` | host 网关附着/替换/拒绝判定 |
| `host_rendezvous.py` | host 角色会合点（gateway/serve 记录发布） |
| `host_topology.py` | host 拓扑（谁在跑什么） |
| `local_desktop_ui.py` | 桌面 UI 本地集成 |
| `local_viewer_events.py` | 本地观察者事件 |
| `webapp_listener.py` | web 应用监听 |
| `runtime_bootstrap.py` / `runtime_bootstrap_windows.py` | 运行时引导（Windows 特化） |
| `runtime_contract.py` / `runtime_downgrade_exit.py` / `runtime_ownership.py` | 运行时契约/降级退出/所有权 |
| `runtime_footer.py` | turn 结果 footer 行 |
| `cwd_placeholder.py` | cwd 占位工具 |
| `cron_store_notices.py` | cron 任务库变更通知 |

### F. 托管房间（hosted rooms）

| 文件 | 角色 |
|------|------|
| `hosted_rooms.py` / `hosted_rooms_common.py` | 网关原生多 agent 房间：入口与公共工具 |
| `hosted_rooms_gateway_import.py` / `hosted_rooms_legacy_import.py` | 与门面/旧路径的导入桥 |
| `hosted_room_router.py` / `hosted_room_driver.py` | 房间路由与驱动（讨论编排） |
| `hosted_room_lead.py` / `hosted_room_peer.py` / `hosted_room_replicas.py` | 主持者/成员/副本角色 |
| `hosted_room_discussion.py` / `hosted_room_context.py` / `hosted_room_task_input.py` | 讨论流、上下文、任务输入 |
| `hosted_room_execution_policy.py` / `hosted_room_policy_checkpoint.py` | 执行策略与策略检查点 |
| `hosted_room_attachments.py` / `hosted_room_links.py` | 附件与链接 |
| `hosted_room_work_lineage.py` / `hosted_room_work_records.py` / `hosted_room_work_storage.py` | 工作项谱系/记录/存储 |
| `hosted_room_authority_history.py` | 权威变更历史 |

### G. 看板 watcher

| 文件 | 角色 |
|------|------|
| `kanban_watchers.py` | GatewayKanbanWatchersMixin：看板→会话 watcher 装配 |
| `kanban_watchers_common.py` / `kanban_watchers_dispatcher.py` / `kanban_watchers_notifier.py` | 公共状态、分发器、通知 |

## 与其他模块的关系

- `run.py` 依赖 `agent/`（压缩状态常量、中断兼容、活动计量）与 `hermes_cli/`（config 读取、multiplex 决策、进程身份）——注意 gateway 读用户 YAML 走的是**自己的 loader**（`run.py` + `config.py`），不经过 `DEFAULT_CONFIG`；CLI 看得见而网关看不见的 key，说明你用错了 loader。
- `run_bootstrap.py` 与 `run.py` 互相回导（bootstrap 阶段函数以 `_start_gateway_*` 名字在门面可见），这是本项目「兄弟模块函数内晚导入门面」的标准形态。
- Desktop 的 serve 后端经 `/api/gateway/*` detached 拉起本进程；`status.py` 写的 `gateway_state.json` 供更新器验证。
- 托管房间、看板 watcher、cron 都最终把工作转成普通入站事件（`internal=True`）走同一条消息流（见 `message_flow.md`）。

## 总结

run.py 的骨架是三段：**main() 管「进程能不能活」**（身份、看门狗、编码、硬退出），**start_gateway 管「服务怎么起」**（单实例仲裁、替换、适配器连接、信号），**GatewayRunner 管「消息怎么流」**（但那部分代码几乎全在 mixin 里）。多路复用不是事后补丁而是构造期开关：secret scope fail-closed、per-profile 适配器表、按访问解析的 SessionDB 句柄，都在 `__init__` 里就位。关闭侧的哲学是「优雅拆除一次做完，然后绝不相信解释器退出」——`os._exit` 后门加生命周期台账，让监督者永远能重启一个半死不活的网关。
