# sessions_authority.md —— 会话索引、路由身份与 durable 接纳权威

## 文件概览

gateway 的会话层回答三个问题：**这条消息属于哪个会话**（路由索引 SessionStore + `session_identity.py` 的冻结身份）、**谁说了算**（`session_authority.py::SessionAuthority`，durable FIFO 的 owner）、**接纳之后谁执行**（`session_ingress*.py` + 各入口 turn）。本篇深讲承重文件，并用分组表覆盖 gateway 顶层全部 138 个 `session*.py`——它们大多是 SessionAuthority 或 SessionStore 的一个切面（mixin、控制面、本地会话、查看器、worker）。

两个核心对象的分工：

- **SessionStore**（`session.py:787`）：`session_key → SessionEntry` 的持久化路由索引 + 转录存储，SQLite（SessionDB）+ 旧 JSONL 兜底。它知道「这个聊天当前轮到哪个 session_id」。
- **SessionAuthority**（`session_authority.py:134`）：每个被服务 profile 一个实例，持有 runtime epoch，管理 durable FIFO 的接纳、认领（claim）、结算（settle）、转向（steer）与取消；它知道「这个会话现在哪个 generation 在跑、队列里排着谁」。

## 关键代码走读

### 1. SessionStore：路由索引 + 转录重试队列

```python
# 来源：gateway/session.py:787-828（节选）
class SessionStore(
    SessionPersistenceMixin, SessionRecoveryMixin, SessionLifecycleMixin, SessionTranscriptMixin,
    SessionPromptPinMixin,
):
    """Session routing index + transcripts: SQLite (SessionDB), legacy JSONL fallback."""

    def __init__(self, sessions_dir: Path, config: GatewayConfig, has_active_processes_fn=None):
        ...
        self._lock = threading.Lock()      # guards _entries / _loaded only
        self._save_lock = threading.Lock() # whole-index persistence, never held with _lock
        # Fast (single-entry) and full saves share one generation counter so they are totally
        # ordered; _fast_persisted_entries: key -> (revision, entry_json) since the last rewrite.
        self._routing_generation = 0
        self._inflight_sessions: dict[str, _SessionFlight] = {}
        ...
        self._transcript_retry_lock = threading.Lock()
        # One transcript drainer at a time: parent->child queue migration stays linearizable.
        self._transcript_drain_lock = threading.RLock()
        self._transcript_reroutes: dict[str, str] = {}
        self._dirty_transcripts: dict[str, list[dict[str, Any]]] = {}
        self._transcript_append_failures: dict[str, int] = {}
```

五件事值得注意：索引是**双写**的（SQLite 路由表 + 旧 JSONL 兜底，句柄恢复后对账）；`_lock` 与 `_save_lock` 永不嵌套持有；快存与全量存共享一个**单调代计数器**保证总序；`_inflight_sessions` 让同一路由的并发首消息只飞一次（`_SessionFlight` 的 event/result/error 三件套）；转录写入失败进 `_dirty_transcripts` 内存重试队列，排水器由 `_transcript_drain_lock` 串行化（父→子队列迁移必须线性化）。SQLite 句柄**按路径缓存、每次经 `_db` 解析**（`session.py:829-845` 注释：多路复用下一个进程服务所有 profile，句柄冻结在根 home 会把所有 profile 的行写进根 state.db，#88532）。

### 2. SessionEntry：一行路由记录都记了什么

```python
# 来源：gateway/session.py:484-541（节选）
@dataclass
class SessionEntry:
    """Routing-index entry: maps a session key to its current session ID and metadata."""
    session_key: str
    session_id: str
    ...
    # Durable marker of the executing turn; CAS-cleared on normal unwind, left behind by
    # SIGKILL/OOM so unclean startup recovers the exact session instead of guessing.
    active_turn_token: Optional[str] = None
    ...
    # Profile owning the bot that received this lane's traffic (``RoutingIdentity.transport_profile``,
    # "default" spelled out). The key namespace only says where the turn RUNS; after a restart this is
    # what says which bot may DELIVER to it. None = unknown (row predates the field, or standalone).
    transport_profile: Optional[str] = None
    # Exact session-context/channel inputs from the last human turn. Append-only dataclass field so
    # older positional construction of transport_profile keeps its meaning.
    prompt_pin: Optional[dict[str, Any]] = None
```

`active_turn_token` 是崩溃恢复的锚：正常卸场 CAS 清除，SIGKILL 留下它，下次不洁启动据此找回确切会话。`transport_profile` 与 key 命名空间的分工是 Profile scope 的核心设计：**namespace 说这条 lane 在哪跑（runtime），这一列说哪个 bot 能向它投递（transport）**。`session_key` 本身由 `build_session_key`（session.py:686）按 `agent:<profile>:` 命名空间拼出；`_session_key_namespace`（session.py:665）保证与 `RoutingIdentity.namespace` 字节一致。

### 3. RoutingIdentity：一个事件一个身份，最先解析

```python
# 来源：gateway/session_identity.py:43-66（节选）
@dataclass(frozen=True)
class RoutingIdentity:
    """Everything a turn needs to know about who it is, resolved once at ingress.

    ``transport_profile`` owns the receiving adapter (its credential and allowlist);
    ``runtime_profile`` is the profile that executes the turn — the same name unless a
    ``profile_routes`` entry re-homed the event. Both are explicit (``"default"`` is spelled out);
    ``None`` never means default here. ``multiplexed`` is False for a standalone gateway, whose
    keys stay in the legacy ``agent:main`` namespace whatever profile it was launched with."""

    transport_profile: str
    runtime_profile: str
    authorization_home: Path
    runtime_home: Path
    multiplexed: bool = True
    # Receiving adapter; None for restored/synthetic sources (no live provenance → fail closed).
    transport: Optional[weakref.ref] = field(default=None, compare=False, hash=False)
    # True when nothing named the receiving bot ... ``transport_profile`` is the primary by default.
    transport_inferred: bool = field(default=False, compare=False, hash=False)
```

`resolve_identity` 把它钉在 source 的 `_identity` 属性上（wire 不可见，和 `_transport_adapter_ref` 一样不进 to_dict）；`transport_profile ≠ runtime_profile` 是**正常**形态（共享 bot → 路由卫星 profile）。两个配套缝：`replace_source`（session_identity.py:124）让 `dataclasses.replace` 复制 source 时把身份等 provenance 一起带走（`_apply_topic_recovery` 靠它）；`IdentityUnresolved`（:37）规定多路复用下解析失败必须丢弃事件——绝不静默落回默认 profile。`session_route_identity.py` / `session_route_recovery.py` 负责路由身份的持久侧与恢复侧。

### 4. SessionAuthority：一个权威对象管住全部执行权

```python
# 来源：gateway/session_authority.py:134-160（节选）
class SessionAuthority:
    def __init__(self, runner, *, profile_id, instance_id, db, epoch):
        self.runner = runner
        self.profile_id = profile_id
        self.instance_id = instance_id
        self.db = db
        self.epoch = epoch
        self.sessions = {}
        self.waiters = {}
        self.native_waiters = set()
        self.pending_results = {}
        self.pending_stops = {}       # 尚未 adopt agent 的 Stop，按 session→generation 存
        self.pending_steers = {}      # adopt 前收到的转向文本，只交给那一代
        self.adopted = {}             # session -> (generation, agent)：Stop 只去这个 agent
        self.executing = {}           # session id -> 执行中的 generation（发布围栏）
        self._route_epochs = {}       # route 被多少次 /stop、/new 围栏过
```

字段名就是它的职责清单：`epoch`（`hermes_state_runtime.begin_runtime_epoch` 递增的运行时代——进程换代后旧 epoch 的写全部作废）、`adopted`/`executing`（Stop 与结果只投给**当前代**）、`_route_epochs`（对聊天维度的围栏计数，旧值永远提交不了）。durable FIFO 的实际落盘在状态层：`admit_session_input`（已在 `message_flow.md` 第 3 步走读）写 `session_admissions` 表；权威对象再提供 `claim_session_input` / `settle_session_input` / `steer_session_input` 的编排。接纳入口按来源分流：`session_api_turn.py`（API 服务器）、`session_cli_turn.py`（本地 CLI）、`session_cron.py` / `session_automation.py`（定时与自动化）——全部汇聚到同一个 store 调用，这是「canonical local CLI/TUI/Desktop sessions 也走同一 durable FIFO」的机制保证。

### 5. session_ingress 族：接纳的五道切面

`session_ingress.py::admit_message`（`message_flow.md` 已走读）是主干；四个切面各管一件事：`session_ingress_burst.py` 的 `burst_gate` 在适配器缝上合并照片/文本连发（串行读者的命令也要等）；`session_ingress_context.py` 处理历史回填的渠道上下文；`session_ingress_live_turn.py` 管「活动 turn 期」的接纳语义；`session_ingress_media.py` 管媒体就绪等待。配套的 `session_admission.py` / `session_retry_admission.py` 处理重试语义，`session_producer_lifecycle.py` 定义 producer turn 的生命周期（`close_producer_turn` 等）。

## 核心类/函数

| 符号 | 位置 | 职责 |
|------|------|------|
| `SessionSource` | session.py:69 | 消息来源（platform/chat/user/thread/scope/profile…），wire 序列化字节稳定 |
| `SessionEntry` | session.py:484 | 路由索引行：session_key→session_id、活跃 turn 令牌、transport_profile、prompt_pin |
| `SessionStore` | session.py:787 | 路由索引 + 转录（SQLite+JSONL 兜底），双锁+代计数，转录重试队列 |
| `AsyncSessionStore` | session.py:770 | 同步 store 的 async 边界（`asyncio.to_thread` 逐方法卸载） |
| `build_session_key()` | session.py:686 | 按 `agent:<profile>:` 命名空间拼会话键 |
| `RoutingIdentity` | session_identity.py:43 | 冻结的传输/运行时身份；`resolve_identity` 每事件解析一次 |
| `SessionAuthority` | session_authority.py:134 | 每 profile 的执行权威：接纳/认领/结算/转向/围栏，按 generation 记账 |
| `admit_session_input()` | hermes_state_runtime.py:130 | durable FIFO 落盘（重放冲突、队列上限 32、epoch 校验） |
| `begin_runtime_epoch()` | hermes_state_runtime.py:116 | 递增 runtime epoch（调用者必须持有 profile 所有权锁） |
| `admit_message()` | session_ingress.py:39 | 消息接纳主干：receipt→waiter，错误翻译成人话 |

## 本组文件清单

### A. 索引、身份与持久化

| 文件 | 角色 |
|------|------|
| `session.py` | SessionSource/SessionEntry/SessionStore/AsyncSessionStore + key 命名空间 |
| `session_identity.py` | RoutingIdentity：每事件冻结路由身份；replace_source 携带 provenance |
| `session_route_identity.py` | 路由身份的持久侧（source↔索引行） |
| `session_route_recovery.py` | 路由恢复（重启后重钉） |
| `session_state.py` | SessionState 三格容器（turn/conversation/persistent；见 run.md） |
| `session_contract.py` | 会话层契约常量 |
| `session_envelope.py` | native 事件封套（restore_native 等） |
| `session_persistence.py` | SessionPersistenceMixin：索引落盘（快存/全量、句柄缓存） |
| `session_lifecycle.py` | SessionLifecycleMixin：创建/重置/过期 |
| `session_recovery.py` | SessionRecoveryMixin：不洁启动恢复 |
| `session_prompt_pin.py` | 渠道 prompt/parent 钉住（sanitize_prompt_pin） |
| `session_transcript.py` | SessionTranscriptMixin：转录追加/重试队列 |
| `session_transcript_rows.py` / `session_transcript_subagent.py` | 转录行模型 / 子代理行 |
| `session_db_recovery.py` | SQLite 句柄恢复（RecoverableHandleCache 配合） |
| `session_detached.py` | 「聊天已移开」的 detached route（wire 不可见） |
| `session_policy.py` / `session_policy_credentials.py` / `session_policy_refresh.py` | 会话策略、凭据、hooks 刷新 |

### B. 权威、接纳与执行权

| 文件 | 角色 |
|------|------|
| `session_authority.py` | SessionAuthority：接纳/claim/settle/steer/cancel，按代记账 |
| `session_authorities.py` | 每 profile 权威对象的注册表（创建/退役） |
| `session_admission.py` | admission 辅助语义 |
| `session_ingress.py` | admit_message 主干（receipt→waiter） |
| `session_ingress_burst.py` | burst_gate：连发合并、busy burst 分发 |
| `session_ingress_context.py` | 历史回填渠道上下文 |
| `session_ingress_live_turn.py` | 活动 turn 期的接纳语义 |
| `session_ingress_media.py` | 媒体就绪等待 |
| `session_retry_admission.py` | 重试接纳 |
| `session_api_turn.py` / `session_cli_turn.py` | API / 本地 CLI 入口的 turn 接纳 |
| `session_cron.py` / `session_cron_commands.py` / `session_automation.py` | cron 与自动化入口 |
| `session_producer_lifecycle.py` | producer turn 生命周期 |
| `session_settlement_recovery.py` / `session_unattended_unknown.py` | 结算恢复 / 未知执行的处理 |
| `session_finite.py` / `session_stall.py` | 会话有限状态与停滞检测 |
| `session_execution.py` | GatewaySessionAgentMixin：权威侧 agent 执行 |
| `session_managed_worker.py` / `session_managed_worker_log.py` / `session_runtime_workers.py` | 托管 worker（demand 驱动）与日志 |

### C. 面向 API/查看器的读取与显示

| 文件 | 角色 |
|------|------|
| `session_api.py` / `session_api_media.py` | 会话 API 面（媒体子集） |
| `session_a2a.py` | A2A agent-to-agent 会话 |
| `session_acp_lifecycle.py` | ACP 适配器会话生命周期 |
| `session_active_list.py` / `session_listing.py` / `session_live_listing.py` | 活动/静态/实时会话清单 |
| `session_display.py` / `session_surface.py` / `session_skin.py` | 显示与表面样式 |
| `session_discovery.py` / `session_info_reads.py` / `session_stored_reads.py` | 发现与只读查询 |
| `session_usage.py` | 用量统计 |
| `session_images.py` / `session_context.py` / `session_context_refs.py` / `session_history_mount.py` | 图像/上下文/历史挂载 |
| `session_results.py` / `session_completion_notes.py` / `session_complete_path.py` | 结果与完成注记 |
| `session_events.py` / `session_tool_events.py` / `session_readiness.py` | 事件流与就绪 |
| `session_kanban.py` | 看板会话绑定 |

### D. 本地会话（CLI/TUI/Desktop/查看器）

| 文件 | 角色 |
|------|------|
| `session_local.py` | 本地（LOCAL 平台）会话主干 |
| `session_local_adoption.py` / `session_local_close.py` / `session_local_recovery.py` | 收养/关闭/恢复 |
| `session_local_editor.py` / `session_local_inventory.py` / `session_local_mcp.py` | 编辑器/清单/MCP |
| `session_local_migration.py` / `session_local_route.py` / `session_local_title.py` | 迁移/路由/标题 |
| `session_tui_config.py` / `session_tui_ops.py` / `session_tui_reads.py` / `session_tui_side.py` | TUI 四切面（配置/操作/读/侧车） |
| `session_viewer_automation.py` / `session_viewer_close.py` | 查看器自动化/关闭（idle FIFO 等待） |
| `session_shell.py` / `session_client.py` | shell 集成/客户端 |
| `session_onboarding.py` / `session_operator.py` | 首次接触引导/操作者 |
| `session_messaging_picks.py` / `session_picker_fields.py` / `session_deferred_pick.py` | 选择器（/model 等延迟回调） |
| `session_connections.py` / `session_plugin_rpc.py` / `session_server_requests.py` | 连接/插件 RPC/服务端请求 |
| `session_ancillary.py` / `session_config.py` / `session_llm_oneshot.py` | 辅助面/配置/一次性 LLM |

### E. 控制、变更与 worker

| 文件 | 角色 |
|------|------|
| `session_commands.py` / `session_command_sink.py` / `session_setting_commands.py` | 会话命令与设置命令 |
| `session_controls.py` / `session_control_actions.py` / `session_busy_controls.py` / `session_queued_controls.py` / `session_pending_controls.py` / `session_group_controls.py` / `session_hosted_controls.py` | 控制 prompt 各形态（普通/忙碌/排队/待决/群组/托管） |
| `session_group_peers.py` / `session_hosted_members.py` / `session_hosted_member_homes.py` / `session_hosted_attachments.py` / `session_hosted_rpc.py` / `session_hosted_service.py` / `session_hosted_transport.py` | 群组成员与托管房间会话面 |
| `session_bot.py` / `session_bot_cancel.py` / `session_bot_mailbox.py` / `session_bot_outcome.py` / `session_bot_state.py` | bot 会话状态机（邮箱/结果/取消） |
| `session_mutations.py` / `session_mutation_compress.py` / `session_mutation_model.py` / `session_mutation_policy.py` | 会话变更（压缩/模型/策略） |
| `session_refine.py` / `session_prune.py` / `session_retirement.py` / `session_reactions.py` / `session_clarify_batch.py` / `session_clarify_lock.py` / `session_cold_review.py` | 精修/修剪/退役/回应/澄清 |
| `session_secret_prompt.py` / `session_vault_prompt.py` / `session_sudo_prompt.py` | 秘密/保险库/sudo 输入会话 |
| `session_worker.py` / `session_worker_child.py` / `session_worker_construct.py` / `session_worker_delegation.py` / `session_worker_reservation.py` / `session_worker_spawn.py` | 委派 worker 全家（构造/预留/子会话/孵化） |

## 与其他模块的关系

- **状态层**：durable FIFO、epoch、admission 表都在 `hermes_state_runtime.py`（gateway 之外的共享状态库）；SessionAuthority 是它们的 gateway 侧编排者。
- **run.py**：`_session_state()`（进程内三格容器）与本篇的 SessionStore（持久索引）+ SessionAuthority（执行权威）是三个不同层次——进程内易变状态、持久路由、执行权，各归各家。
- **message_flow.md** 第 3 步、**turn_machinery.md** 的租约都在本篇对象的掌控之下：admission 管跨重启的执行权，租约管进程内的串行化。
- **streaming.md** 的通知唤醒：后台完成事件经 `admit_internal_event` 收据进入同一 durable FIFO——观察者从不拥有这些 turn。

## 总结

会话层的铁律有三条。**一、身份先于一切**：`RoutingIdentity` 在入口一次性解析并冻结，多路复用下解析不出就丢弃，任何 helper 都只是读它而不是再猜一遍。**二、路由归索引，执行归权威**：SessionStore 只回答「这个聊天是哪个 session_id」，SessionAuthority 按 generation 记账执行权（adopted/executing/route fences），Stop 和结果永远只给当前代。**三、一切可恢复**：active_turn_token 找回被 kill 的 turn，transcript 重试队列接住写盘失败，runtime epoch 让旧进程的残余写全部作废。138 个 session_*.py 都只是这三条铁律在某个切面上的展开。
