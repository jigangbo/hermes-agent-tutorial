# 05 gateway/ —— 消息网关层总览

gateway/ 是 Hermes 的**消息网关**：一个常驻 asyncio 进程，把 Telegram、Discord、Slack 等约 30 个聊天平台上的每一条人话，安全地送进 agent，再把 agent 的回复（含流式增量、媒体、审批提示）可靠地送回原聊天。它是整个产品里文件最多的一层（gateway/ 顶层 300+ 个 Python 模块，外加 `platforms/`、`relay/` 两个子包），但结构非常规整：`run.py` 是门面，各阶段拆进 `run_*.py` 兄弟模块，会话状态拆进 `session*.py`，适配器框架在 `platforms/`，实验性转发通道在 `relay/`。

## 进程模型

```
 多个聊天表面                        一个网关进程                            agent
┌──────────────┐   webhook/长轮询/   ┌───────────────────────────────┐   turn 线程
│ Telegram bot │   WebSocket 连接    │  gateway/run.py  GatewayRunner │  ┌─────────┐
│ Discord bot  │ ──────────────────▶ │  ├ 26 平台适配器（插件注册）    │ ─▶│ AIAgent │
│ Slack / SMS  │   MessageEvent 归一 │  ├ 入站管线 run_inbound_*       │   │(每会话  │
│ WhatsApp …   │ ◀────────────────── │  ├ 忙碌保护 run_busy            │   │ 缓存)   │
└──────────────┘   SendResult/流式帧  │  ├ turn 执行 run_turn_*         │   └─────────┘
                                      │  ├ 投递账本 delivery_ledger     │      ▲
 CLI / TUI / Desktop ──── 本地会话 ───▶│  └ SessionStore/Authority      └──────┘
 (LOCAL 平台)         复用同一 durable FIFO                  session_key → session_id
```

- 一个进程可以只服务一个 profile，也可以在 `gateway.multiplex_profiles` 下**同时服务多个 profile**——每个 profile 有自己的适配器、config、secret scope，共享同一个进程与事件循环。
- 每个会话同时只有**一个 turn 在跑**：适配器层排队 + runner 层忙碌分发 + turn 租约三层保护。
- agent 实例按 `session_key` 缓存（上限 128 个、1 小时闲置驱逐、内存压力软驱逐），turn 本体跑在 `_UnboundedThreadExecutor` 的独立线程上，不占用事件循环。

三类线程/任务并存，是读懂 run.py 的前提：

1. **asyncio 事件循环**（主循环）：适配器收发包、入站管线、忙碌分发、流式编辑、通知——所有 I/O 协程的家。
2. **家务线程池**（`_HOUSEKEEPING_MAX_WORKERS = 4`，`run.py:66`）：best-effort 的会话清理任务，与 turn 隔离，避免慢磁盘 I/O 拖住投递。
3. **turn executor**（`_UnboundedThreadExecutor`）：每个 turn 一个独立线程，跑同步的 AIAgent；线程用完**停车复用**（60 秒 LIFO），复用前清空 contextvars——细节见 `turn_machinery.md`。

另外两个容易踩坑的进程事实：

- **网关进程独立于 Desktop 应用**。`hermes serve`（控制面）随 App 退出而死，但 `gateway run` 是 detached 拉起的（`start_new_session` / `DETACHED_PROCESS`），SIGTERM 杀不到它——bot 在 App 关掉后继续活着，这是设计不是 bug。
- **一个 host 只允许一个网关 owner**。第二次 `gateway run` 会经 `host_attach.py::decide` 判定为 ATTACH（附着现役实例）或 REFUSE（拒绝），除非 `--force`。

## GatewayRunner：一个由 19 个 mixin 拼成的门面

`gateway/run.py:3322` 的 `GatewayRunner` 类体本身几乎没有逻辑——真正的行为按阶段分布在 19 个 mixin（各自住在 `gateway/` 下的独立文件）里，经 MRO 绑定：

| # | Mixin | 所在文件 | 职责 |
|---|-------|---------|------|
| 1 | GatewayAuthorizationMixin | `authz_mixin.py` | 发送者授权、DM 策略、未授权配对、bot 回环守卫 |
| 2 | GatewayKanbanWatchersMixin | `kanban_watchers.py` | 看板任务到会话的 watcher |
| 3 | GatewaySlashCommandsMixin | `slash_commands.py` | slash 命令注册表与分发 |
| 4 | GatewayVoiceMixin | `run_voice.py` | 语音频道/音频转写投递 |
| 5 | GatewayAdapterLifecycleMixin | `run_adapters.py` | 适配器创建、连接、重连、profile 分配 |
| 6 | GatewayTopicThreadsMixin | `run_topics.py` | 话题/thread 恢复与路由 |
| 7 | GatewayTurnMixin | `run_turn.py` | turn 执行主链（再由 4 个子 mixin 组成） |
| 8 | GatewayShutdownMixin | `run_shutdown.py` | 优雅关闭、逐会话 finalize |
| 9 | GatewayBusySessionMixin | `run_busy.py` | 忙碌排队/打断/绕行命令表 |
| 10 | GatewayConfigLoadersMixin | `run_config_loaders.py` | 多 profile 网关配置装载 |
| 11 | GatewayStartupMixin | `run_startup.py` | 启动横幅、会话恢复、预热 |
| 12 | GatewaySessionWatchersMixin | `run_watchers.py` | 会话侧 watcher（心跳、待投递队列） |
| 13 | GatewayNotificationsMixin | `run_notifications.py` | 后台进程/更新/完成通知 |
| 14 | GatewayInboundMixin | `run_inbound.py` | 入站管线（文本/媒体准备、插件注入） |
| 15 | GatewayGoalsMixin | `run_goals.py` | 目标续跑与心跳验收 |
| 16 | GatewayAgentCacheMixin | `run_agent_cache.py` | 每会话 agent 缓存、模型覆盖、租约 |
| 17 | GatewayRuntimeInitMixin | `run_runtime_init.py` | 运行时初始化（executor、租约注册表等） |
| 18 | GatewayProfileReconcileMixin | `run_profile_reconcile.py` | 多 profile 增删后的一致性对账 |
| 19 | GatewayPluginRewireMixin | `run_plugin_rewire.py` | 插件 handler 热重接 |

注意 `GatewayTurnMixin`（`run_turn.py:170`）自己又是 `GatewayBackgroundMixin + GatewayTurnPrepareMixin + GatewayTurnHygieneMixin + GatewayTurnPersistenceMixin` 的组合——「 mixin 也分层」。

## 目录导览

| 区块 | 文件形态 | 本组教程 |
|------|---------|---------|
| 进程生命周期 | `run.py` + `run_bootstrap/startup/shutdown/idle_*`、`restart*`、`status*`、`config*`、`hosted_rooms*` | `run.md` |
| 消息入站与投递 | `run_inbound_*`、`run_busy.py`、`authz_mixin.py`、`delivery*`、`response_filters.py`、`mirror.py` | `message_flow.md` |
| turn 机器 | `run_turn*`、`turn_lease.py`、`turn_executor.py`、`run_agent_cache.py`、`agent_cache_pressure.py` | `turn_machinery.md` |
| 会话索引与权威 | `session.py` + 全部 `session_*.py`（约 130 个） | `sessions_authority.md` |
| 适配器框架 | `platforms/base.py`、`event.py`、`platform_registry.py`、`_shared.py`、`media_cache.py` 等 | `platforms_framework.md` |
| 平台适配器（插件） | `plugins/platforms/<name>/adapter.py`，26 个平台 | `platform_adapters.md` |
| 内置 HTTP 平台 | `platforms/webhook*`、`msgraph_webhook.py`、`api_server*` | `builtin_platforms.md` |
| relay 转发通道 | `relay/` 13 个文件（RelayAdapter、握手、egress） | `relay.md` |
| 流式与通知唤醒 | `stream_events.py`、`stream_consumer*`、`streaming_tts_consumer.py`、`run_notifications*`、`wake.py` | `streaming.md` |

## 本组文档导航

> 阅读顺序建议：`run.md` → `message_flow.md` 先建立骨架；`turn_machinery.md`、`sessions_authority.md` 是并发与持久化两大纵深；其余按兴趣任选。每篇 150–350 行，含真实源码走读（标注 文件:行号）与完整文件清单表。

1. `run.md` —— run.py 深讲：`main()` 启动序列、`start_gateway()`、GatewayRunner 构造、SessionState 容器、关闭排水。
2. `message_flow.md` —— 一条消息的 7 步全链路：适配器收包 → 入站管线 → 会话接纳 → turn 执行 → 流式 → 最终投递 → 落盘。
3. `turn_machinery.md` —— turn 租约（为什么按路由键的忙碌保护不够）、`_UnboundedThreadExecutor`、agent 缓存与内存压力。
4. `sessions_authority.md` —— SessionStore 路由索引、SessionAuthority durable FIFO、路由身份、入站接纳族。
5. `platforms_framework.md` —— BasePlatformAdapter 接口、MessageEvent、平台注册表、加平台指南。
6. `platform_adapters.md` —— 26 个平台插件分组清单 + Telegram 适配器解剖。
7. `builtin_platforms.md` —— webhook（HMAC）、msgraph（Teams/Outlook）、api_server（OpenAI 兼容）。
8. `relay.md` —— 网关↔connector 转发通道：CapabilityDescriptor 握手、egress 授权、账号 linking。
9. `streaming.md` —— 流式事件契约、GatewayStreamConsumer、think 过滤与围栏、TTS、通知与唤醒。

## Profile scope：贯穿全层的硬约束

`gateway/AGENTS.md § Profile scope` 是这一层最重要的横切规则，摘要如下（完整编号 HX002/HX004/HX005/HX012、PS-P05/P06 见各文件内注释）：

- **一个事件一个身份，且最先解析。** `session_identity.py::resolve_identity` 在每个入站事件上回答一次「哪个 bot 收的 / 谁能接纳 / 在哪跑」，把冻结的 `RoutingIdentity` 钉在 source 上；任何 key 派生都必须发生在它之后。多路复用下解析不出身份的事件**直接丢弃并告警**，绝不落进默认 profile。
- **非 turn 期代码必须显式绑定 profile 作用域。** turn 期由 `run_turn.py::_profile_scope_for_source` 包住；turn 之外的所有路径——agent 驱逐（`run_agent_cache.py::_run_release_in_profile_scope`）、关机 finalize、媒体投递、延迟回调、通知——都必须用会话记录里解析出的 owning home 重新进入 `_profile_runtime_scope`。教训：曾经有驱逐路径在启动 profile 的作用域下 flush，把次要 profile 的记忆悄悄写进了默认 profile 的存储。
- **凭据与环境读取必须走 scoped reader。** `platforms/_shared.py::get_scoped_secret` 是唯一实现；多路复用时 scoped miss 返回默认值而**不是** `os.environ`（后者持有启动 profile 的值）。
- **摄取适配器与投递适配器是两个缝。** `_intake_adapter_for`（收事件的 bot）管准入策略，`_delivery_adapter_for`（回话的 bot）管投递；禁止直接读 `self.adapters[platform]` 猜投递端。
- **身份要活过进程重启。** `SessionEntry.transport_profile` 把「哪个 bot 可以投递」持久化在路由索引里；从盘上恢复的会话经 `authz_mixin.py::_restored_source` 重新钉回身份，宁可投不出去也不猜默认 bot。

## 一段定场代码：门面是怎么被拼起来的

`GatewayRunner` 的构造函数只有十几行，但每行都对应一个 mixin 阶段；类体里那组 `legacy_dict_property` 则是旧 19 个 session_key 键控 dict 向 `SessionState` 容器迁移留下的「活视图」：

```python
# 来源：gateway/run.py:3360-3384（节选）
    # Legacy per-session dict attrs as LIVE views over ``self._sessions``; new code: _session_state(key)
    _running_agents = legacy_dict_property("_running_agents")
    _queued_events = legacy_dict_property("_queued_events")
    _pending_approvals = legacy_dict_property("_pending_approvals")

    def _sessions_map(self) -> dict[str, SessionState]:
        """Per-session state map; lazily created so bare ``object.__new__`` test runners work."""
        sessions = self.__dict__.get("_sessions")
        if sessions is None:
            sessions = {}
            self.__dict__["_sessions"] = sessions
        return sessions

    def _session_state(self, session_key: str) -> SessionState:
        """Get-or-create the :class:`SessionState` for ``session_key``."""
        sessions = self._sessions_map()
        state = sessions.get(session_key)
        if state is None:
            state = SessionState()
            sessions[session_key] = state
        return state
```

新代码一律走 `_session_state(key)`：每会话状态装进 `gateway/session_state.py::SessionState` 的三个生命周期格（turn / conversation / persistent），旧 dict 形态只是测试兼容视图。

## 三个常见误区

1. **「gateway/platforms/ 里是各平台的适配器」**——错。那是适配器**框架** + 3 个内置 HTTP 平台；26 个真正的平台适配器全是插件，住在 `plugins/platforms/<name>/adapter.py`。详见 `platforms_framework.md` 开头的更正。
2. **「忙碌保护按 session_key 就够了」**——不够。路由键到 session_id 是多对一（/resume、CLI 续聊、委派固定、话题游走），所以还要按解析后 session_id 的 turn 租约串行化。详见 `turn_machinery.md`。
3. **「投递失败重发就好」**——不行。一个 `attempting` 状态的投递可能已经到达平台；重发必须带「可能重复」的诚实标记。详见 `message_flow.md` 第 6 步与 `streaming.md` 的对账旗标。

## 与其他模块的关系

- **上游** `plugins/platforms/`：26 个平台适配器经 `platform_registry` 自注册，是 gateway 能力的主要来源；`gateway/platforms/` 只提供框架与 3 个内置 HTTP 平台。
- **下游** `agent/`：`GatewayRunner` 通过 `run_turn_runner.py`（TurnRunner）驱动 AIAgent；流式事件契约 `stream_events.py` 是 agent→gateway 的边界。
- **状态层** `hermes_state*`：SessionStore 之下是 SessionDB（SQLite `state.db`）；durable FIFO 由 `hermes_state_runtime.py::admit_session_input` 承接，gateway 不自建队列表。
- **CLI/TUI/Desktop**：本地表面（LOCAL 平台）与网关共用同一套会话权威与投递账本，见 `sessions_authority.md`。
- **cron/**：定时任务产出经同一入站管线以 `internal` 事件进会话；投递目标解析复用 `delivery.py`。

## 总结

gateway 层的读法：先建立「**一个常驻进程 + 19 个 mixin 门面 + 7 步消息流**」的骨架（本页与 `run.md`、`message_flow.md`），再按兴趣下钻——关心并发正确性读 `turn_machinery.md`，关心持久化与多路复用读 `sessions_authority.md`，关心接新平台读 `platforms_framework.md` + `platform_adapters.md`，关心 OpenAI 兼容接口与 webhook 读 `builtin_platforms.md`，关心云托管转发读 `relay.md`，关心逐字上屏与通知读 `streaming.md`。所有篇目都围绕两条项目不变量：**每会话提示缓存神圣不可侵犯**，以及**核心是窄腰、能力住在边缘**。
