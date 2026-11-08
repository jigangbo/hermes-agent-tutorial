# delegation_subagents.md — 委派与子代理：DelegationProvider 路由、子会话运行时与辅助侧问

## 文件概览

`delegate_task` 把一个目标拆成若干 task，交给**子 `AIAgent`** 并发执行。core 保留整个生命周期
（spawn、隔离、roles、depth、并发、后台单元、stop 扇出、结果、`output_schema`、progress）——
都在 `tools/delegate_tool.py`（04_tools/delegation_tools.md，含 `_run_single_child` 的
`_last_resolved_tool_names` 保存/恢复）；本篇讲 **agent/ 侧**的配套机器：

```
父 turn（AIAgent）
   │ delegate_task（INLINE_TOOL_EXECUTORS 拦截 → run_agent.py:1344 _dispatch_delegate_task）
   ▼
DelegationProvider.route_task(task, config)     —— "这个 task 走哪条路"
   │  默认 backend = 内置插件 plugins/delegation/default；route: model/provider/base_url/
   │  reasoning_effort/service_tier/profile/label
   ▼
每个 task 一个子 AIAgent（platform="subagent"）
   │  路由随本会话 schema 钉死（delegation_backends）；子上下文标记 delegated_child_context
   │  / DELEGATED_CHILD_ENV_MARKER；托管 worker：owner 预留子会话行（runtime_session_child），
   │  私有 exec 入口 managed_worker + safe_worker_policy 冻结配置
   ▼
结果 JSON 回填父 turn（on_delegation 钩子 → 父的记忆 provider 观察）
```

| 文件 | 行数 | 角色 |
|---|---|---|
| `agent/delegation_provider.py` | 117 | `DelegationProvider` ABC：路由词汇表 |
| `agent/delegation_registry.py` | 134 | backend 注册表；默认 backend 即内置插件 |
| `agent/delegation_backends.py` | 157 | `/delegation` 命令；backend 按会话钉死 |
| `agent/delegation_context.py` | 187 | 子上下文标记与 kanban 环境作用域 |
| `agent/subagent_lifecycle.py` | 472 | 插件安全的公共生命周期 API（不可变契约） |
| `agent/runtime_session_store.py` | 497 | 托管 worker 的显式持久化门面 |
| `agent/runtime_session_child.py` | 57 | 子会话 store：owner 预留，绝不自注册 |
| `agent/runtime_session_lifecycle.py` | 93 | worker store 的显式生命周期方法（含压缩 API：`runtime_session_compression.py` 162 行） |
| `agent/managed_worker.py` | 477 | 私有 exec 入口（有界 stdin 控制管道） |
| `agent/safe_worker_policy.py` | 80 | 一次性绑定的冻结会话配置 |
| `agent/oneshot.py` | 122 | 一次性 LLM 请求（commit 信息、改名建议…）；有限会话削减见 `oneshot_footprint.py`（78 行） |
| `agent/side_question.py` | 175 | `/btw` 侧问：缓存对齐 fork |
| `agent/side_question_lease.py` | 151 | 插件侧问的 turn 租约 |
| `agent/side_question_request.py` | 288 | 单次纯文本请求（分离缓存对齐 fork） |
| `agent/review_engine.py` | 195 | `/review` 共享引擎（后台全权子代理） |
| `agent/review_idle_queue.py` | 218 | 本地托管 runtime 的评审空闲排队 |
| `agent/process_bootstrap.py` | 358 | 进程级引导（共享 httpx 传输池、Happy Eyeballs） |
| `agent/primary_runtime_snapshot.py` | 84 | 回退后下 turn 恢复的主路由快照 |

---

## 关键代码走读

### 1. `DelegationProvider` ABC：core 只问"这条路怎么走"

provider 决定一个 task 如何变成一次子运行：用什么 model/provider/endpoint/reasoning effort，
或者以哪个 Hermes profile 身份跑。跨接口全是纯 JSON 数据（无活 agent 对象），所以同一 provider
在进程内与 `plugins.isolation: host` 下都能跑：

```python
# agent/delegation_provider.py:110-117
    @abc.abstractmethod
    def route_task(self, task: Mapping[str, Any], config: Mapping[str, Any]) -> dict[str, Any]:
        """Return the route for one task (vocabulary in the module docstring).

        ``task`` carries ``goal``, ``context``, ``index`` and the values the model supplied for
        this provider's :meth:`task_parameters` (absent when omitted). Raise
        :class:`DelegationRouteError` to refuse the task."""
```

路由词汇表（模块 docstring，:15-31）：`model/provider/base_url/api_key/api_mode/request_overrides/
reasoning_effort/fallback_providers`（空 route = 子代理继承父路由）；`service_tier`（`normal/fast/
ultrafast`，按 `/fast` 规则核对）；`profile`（子代理以该 profile 的 config/凭据/技能/`SOUL.md`/
终端策略运行，scope helper 与多路网关同一套）；`label`（进度/结果旁显示的短文本）。
`task_parameters`（:93）允许 provider 给 `delegate_task` 的 `tasks.items.properties` 追加
per-task JSON-schema 字段（profile 名枚举、标题化模型选项……），但它**只在会话构建工具时**调用、
且必须对同一 config 产出逐字节相同的结果——schema 是缓存前缀的一部分。保留名
`RESERVED_TASK_PARAMETERS`（:45，goal/context/index/output_schema/provider/model/...）在
schema 构建期拒收：插件加参数，永不重定义 core 的。`DelegationRouteError` 的消息会原样变成
`delegate_task` 的工具错误给模型读，所以措辞是"指令式"的。

### 2. 注册表：默认 backend 本身就是一个插件

``delegation.backend`` 未配置即 `default`——而"今天的行为"（每个子代理跟随 `delegation` 段，
否则继承父路由）由内置插件 `plugins/delegation/default` 通过**同一接缝**提供：

```python
# agent/delegation_registry.py:128-134
def get_active_provider(config: Mapping[str, Any]) -> DelegationProvider:
    """The provider ``config`` (the ``delegation`` section) selects; ``default`` when unset. Raises
    :class:`DelegationRouteError` naming the backend and the fix when it is not registered or unavailable."""
    provider, reason = backend_status(configured_backend(config))
    if reason or provider is None:
        raise DelegationRouteError(f"{reason} No subagent was started.")
    return provider
```

`_usable`（:88）的解析顺序：已注册且 available → bundled 首用加载（`plugins/delegation/<name>/`，
不经插件 sweep——delegation 是 core 工具，不能依赖 sweep 跑过；`plugins.disabled` 每次调用都
生效）→ 补一次 discovery。**fail-closed**：backend 未安装/不可用不是悄悄换路由，而是工具错误
指名 backend 与修法；该会话的 schema 里也不会出现它的参数（schema 由同一解析构建）。

### 3. `delegation_backends`：路由按会话钉死保护缓存

```python
# agent/delegation_backends.py:1-8（模块 docstring 节选）
"""Which delegation backend Hermes uses: the public API behind a ``/delegation`` command.

``delegation.backend`` in config.yaml is the saved choice. A session routes on the backend its
``delegate_task`` schema was built from (``agent._delegation_backend``, captured with its tools and
pinned with them to the session row), because that schema (a backend's per-task parameters) is cached
prompt: a save, or a config.yaml edit, changes nothing in a running chat and applies from its next
session (``/new``). ``apply_now`` opts into rebuilding the calling session's tools at its next turn
instead ... one prompt-cache break, the rule every slash command that changes prompt state follows."""
```

这正是根 AGENTS.md"slash 命令改系统提示词状态推迟到下一会话、opt-in `--now`"规则的一个实例。
附带防御：带着本会话 backend 未声明参数的 task 仍会被拒（`tools/delegate_tool_routes.py`）。

### 4. `bind_subagent_parent`：TurnFacadeMixin 每回合绑定属主

`subagent_lifecycle.py` 是插件可拿到的**不可变契约层**（`SubagentHandle/Status/TerminalState/
CancelResult/Result`，frozen dataclass + HMAC capability 字段），唯一暴露活 agent 的地方是
contextvar 绑定：

```python
# agent/subagent_lifecycle.py:165-189（节选）
_ACTIVE_PARENT_AGENT: contextvars.ContextVar[Any] = contextvars.ContextVar("hermes_subagent_lifecycle_parent", default=None)

@contextmanager
def bind_subagent_parent(parent_agent: Any):
    """Bind the host-owned parent for the current agent turn.

    Stored as a weakref: every asyncio Handle/Future scheduled from the turn
    (LSP reader loops, kernel pipes, ...) snapshots the Context, and those
    snapshots outlive the turn. A strong ref there pinned finished delegate
    children — each of which binds itself here for its own turn — in the
    parent process heap for the life of the background loop."""
    try:
        ref = weakref.ref(parent_agent)
    except TypeError:
        ref = lambda: parent_agent
    token = _ACTIVE_PARENT_AGENT.set(ref)
    try:
        yield
    finally:
        _ACTIVE_PARENT_AGENT.reset(token)
```

TurnFacadeMixin 在 turn 外围 `with bind_subagent_parent(self)`；`_record`（:399）校验 handle 的
HMAC capability 与属主会话后才放行 status/result/cancel/steer。终态记录保留 1 小时
（`_TERMINAL_RETENTION_SECONDS`）供重连查询，live 记录永不外露；取消走 `request_hard_interrupt`
（`CANCEL_REQUESTED → CANCELLED`）。fork 的实际执行体 `_run`（:421）回调
`tools/delegate_tool._run_child_lifecycle`。

### 5. `delegation_context`：身份门 fail-closed 而不改进程环境

一个 Hermes 进程可能本身就是 Kanban dispatcher worker（`HERMES_KANBAN_*` 在 os.environ）。
**进程内的** delegate 子代理与 cron 作业不是 dispatcher 所有——身份门必须对它们关闭，但不能
去改进程全局环境（claim 心跳与并发读者都在用）：

```python
# agent/delegation_context.py:28-40（节选）
@contextmanager
def delegated_child_context(session_id=None) -> Iterator[None]:
    """Mark child execution and isolate its task-local session identity..."""
    token = _DELEGATED_CHILD_CONTEXT.set(True)
    try:
        from gateway.session_context import scoped_current_session_id
        with scoped_current_session_id(session_id):
            yield
    finally:
        _DELEGATED_CHILD_CONTEXT.reset(token)
```

跨真实进程 spawn 时，`delegated_child_subprocess_env()`（:176）→ `scrub_kanban_env()`（:122）：
剥掉 worker 身份（`HERMES_KANBAN_TASK` 等），保留 board/位置，并写入/继承
`DELEGATED_CHILD_ENV_MARKER`——标记的值是**围栏板根**，后代对板外 Kanban DB 的写被
`kanban_path_is_fenced`（:144）拒绝；"TASK 缺席"单独不足以提升为 orchestrator。内联 shell
（skill_preprocessing）与终端工具都经它清洗子进程环境。

### 6. 子会话运行时（runtime_session_*）：托管 worker 持久化

gateway 托管模式下，持久化走"worker 发 RPC、owner 持 SQLite"的显式通道：

```python
# agent/runtime_session_child.py:19-57（节选）
class ChildSessionStore(RuntimeSessionStore):
    binds_delegation_ledger = False

    def create_session(self, session_id, source, **fields):
        # The owner created this row at reservation with its source, lineage and profile; only
        # the constructor facts are the child's to add.
        ...
        return super().create_session(session_id, 'subagent', model=..., ...)


def reserve_child_store(parent):
    """A ``ChildSessionStore`` the owner reserved under ``parent``'s verified execution."""
    ...
    result = call_off_event_loop(parent._apply, 'child.reserve', {'secret': secret})
    if 'refused' in result:
        raise ValueError(_REFUSALS.get(result['refused'], ...))   # 容量/深度超限 → 工具错误
    ...
```

子会话行由 **owner 在预留时**创建（source='subagent'、lineage、profile 都定好），子代理只补
构造事实；拒绝（`delegation_capacity`、`delegation_depth_exceeded`）以 ValueError 上浮成
`delegate_task` 工具错误。`runtime_session_store.py` 定义显式持久化门面（**永不**打开规范 SQLite
库；`is_worker_process()` 一旦自注册即进程级、不可逆）；`runtime_session_lifecycle.py` 补显式
生命周期方法；`runtime_session_compression.py` 把微压缩 handoff 行投影到 owner 的封闭字段集
（worker 本地簿记键发给 owner 会打不进收据、卡死 journal）。

### 7. 私有 exec：`managed_worker` + `safe_worker_policy`

托管 worker 是 `python -m` 裸进程：**先** `import hermes_bootstrap` 选定已提交的环境，再谈别的。
stdin 是 owner 的**有界** bootstrap/控制管道（`MAX_FRAME = 4MB`），stdout 的复制品被预留给
帧化事件——运行时导入重定向普通输出前就位；指派机密与启动凭据不出现在 argv 或日志里。
`safe_worker_policy.py` 在新鲜 exec 里**一次性绑定**冻结的会话配置（frozen dataclass、无重置、
无环境开关），此后每个 config 读取者返回同一快照；排障 worker 额外允许 safe/ignore-user-config
旁路（stdlib-only，hermes_cli 的 config 层要导入它）。`process_bootstrap.py` 管进程级传输经济性：
**共享 httpx 传输池**（`_SHARED_TRANSPORTS`，同 (verify, proxy, happy-eyeballs) 身份复用，上限
32）——否则 N 个委托子代理各持一套 TLS 池指向同一 provider；外加 Happy Eyeballs 后端与防崩 stdio。

### 8. 辅助路径：side_question、oneshot、review

```python
# agent/side_question.py:1-6（模块 docstring 节选）
"""Context-aware side questions (``/btw``): answer a question ABOUT the conversation without
touching it (no synthetic turns, no role-alternation risk, no prompt-cache invalidation).

Preferred path: a detached cache-parity fork of the live parent ``AIAgent`` replays its
snapshot verbatim against the warm prefix cache (tools denied at dispatch, persistence
detached, usage attributed to the parent)."""
```

- `side_question.py`：首选**缓存对齐 fork**（回放父快照，工具在 dispatch 侧拒绝、持久化分离、
  用量记给父）；无活 agent（网关已逐出）则回退到渲染转录走 `oneshot.run_oneshot`（每消息 2000
  字符、总量 24000 字符预算）。`trim_snapshot_for_fork` 截到"完整 assistant 文本"结尾，
  半截 turn 会破前缀缓存。
- `side_question_lease.py`：插件侧问（`ctx.side_question`，能力 `llm.side_question`）在 turn
  收尾时把请求输入拍成 `SideQuestionCapture`（弱引用父）并发 `post_llm_call` 一个不透明 token；
  一个 token 只买**一次**请求（共享给所有收到该钩子的插件），TTL 60s 或父开下一 turn 即失效；
  未托管 turn（cron、委托子代理）不发 token——"没人在场读一个用主模型 token 买的答案"。
- `side_question_request.py`：执行层——fork 走 turn 循环自己的请求相位（组装、带 LLM 中间件的
  payload 构建、`perform_api_call`）**恰好一次**：无工具派发、无重试、无回退模型、无压缩、无
  持久化；用量以 `plugin_side_question:<plugin_id>` 记账。
- `oneshot.py`：非会话型单发调用（commit 信息、改名建议、摘要），显式 instructions 或注册
  template；`oneshot_footprint.py` 用数据说明为什么 `-q` 会话砍掉自改进循环（21 条轨迹里 skill
  文本占工具结果字节的 34%）：`ONESHOT_DISABLED_TOOLSETS = ("clarify",)`、
  `delegation.oneshot_max_children` 封顶子代理。
- `review_engine.py`：`/review` 各表面共享——快照近 10 条消息（每条 12k 字符帽）拼
  `_REVIEW_GOAL`，走 `delegate_task(background=true)` 同一异步轨；模型路由
  `auxiliary.review` 优先，否则父凭据以 `credentials_cfg` 下传。`review_idle_queue.py`：
  本地托管 llama-server 上评审 fork 会霸占 GPU、被下一 turn 取消（解码成本照付、学习成果丢失），
  于是改排队、等 supervisor `/slots` 安静 15s 才发；每会话一槽、最新快照胜出、超 30 分钟照发。
- `primary_runtime_snapshot.py`：`_snapshot_primary_runtime` 在 agent 构建与主动切换模型时
  记录**拥有该凭据的 custom entry**；回退后的下 turn 恢复按这份快照圈定凭据池，而绝不按
  活的 config.yaml 重新查——被编辑/删除的条目不能把别的账号的 key 塞给这个会话。

### 9. 回到 delegate_tool：几个承重常量（供交叉阅读）

```python
# tools/delegate_tool.py:106 / :302 / :608-609
DEFAULT_MAX_ITERATIONS = 250
        ephemeral_system_prompt=child_prompt, log_prefix=f"[subagent-{task_index}]", platform="subagent",
    default_max_iter = cfg.get("max_iterations", DEFAULT_MAX_ITERATIONS)  # 调用方传入被忽略：配置为权威
```

子代理 turn 以 `platform="subagent"` 起，经 relay 元数据携带；迭代帽默认 **250**——config
migration 36 从 50 升上来的（`hermes_cli/config_migrations.py:779`："50 truncated substantial
delegated work"）。记忆侧的父观察钩子在 `MemoryManager.on_delegation`（memory_learning.md）。

---

## 核心类/函数

| 符号 | 位置 | 职责 |
|---|---|---|
| `DelegationProvider` | delegation_provider.py:62 | 路由 ABC（route_task/task_parameters/description/settings） |
| `DelegationRouteError` / `RESERVED_TASK_PARAMETERS` / `ROUTE_KEYS` | delegation_provider.py:57/45/51 | 拒绝任务 / 保留参数 / 路由键词汇 |
| `get_active_provider` / `backend_status` / `_load_bundled` | delegation_registry.py:128/107/60 | 解析 active backend（fail-closed 带修法）；内置 default 插件首用加载 |
| `list_backends` / `apply_backend` 等 | delegation_backends.py | `/delegation` 的列表/保存/`apply_now` 重建请求 |
| `bind_subagent_parent` / `get_active_subagent_parent` | subagent_lifecycle.py:166/186 | turn 上下文绑定弱引用属主 |
| `SubagentLifecycleService` / `SubagentHandle` / `SubagentState` | subagent_lifecycle.py:269/65/36 | status/result/cancel/steer（HMAC）/ 不可变句柄与状态机 |
| `delegated_child_context` / `scrub_kanban_env` / `kanban_path_is_fenced` | delegation_context.py:28/122/144 | 子上下文标记 / 环境清洗 / 板围栏判定 |
| `RuntimeSessionStore` / `ChildSessionStore` | runtime_session_store.py / runtime_session_child.py:19 | worker 持久化门面 / owner 预留的子会话 store |
| `RuntimeSessionLifecycleMixin` / `RuntimeSessionCompressionMixin` | runtime_session_lifecycle.py / runtime_session_compression.py | 显式生命周期 / worker 压缩 API |
| `main`（exec 入口）/ `_bind_safe_worker_policy` | managed_worker.py / safe_worker_policy.py:37 | 有界 stdin 控制管道 / 一次性冻结会话配置 |
| `run_oneshot` / `is_single_query_session` / `answer_side_question` | oneshot.py / oneshot_footprint.py:27 / side_question.py | 单发调用 / 有限会话削减 / `/btw` 双路径 |
| `SideQuestionLease` / `SideQuestionCapture` | side_question_lease.py / side_question_request.py:36 | 插件侧问一次性 token / 快照捕获与单次纯文本请求 |
| `start_review` / `enqueue` | review_engine.py / review_idle_queue.py | `/review` 快照 → 后台子代理 / 空闲排队（settle 15s） |
| `_snapshot_primary_runtime` | primary_runtime_snapshot.py:13 | 主路由 + 凭据属主快照 |

---

## 本组文件清单

| 文件 | 角色 | 关键符号 |
|---|---|---|
| `agent/delegation_provider.py` | 路由 ABC 与词汇表 | `DelegationProvider`, `route_task`, `DelegationRouteError` |
| `agent/delegation_registry.py` | backend 注册表 + bundled 加载 | `get_active_provider`, `backend_status`, `_load_bundled` |
| `agent/delegation_backends.py` | `/delegation` 命令、会话钉死 | `BackendInfo`, `list_backends`, `apply_backend` |
| `agent/delegation_context.py` | 子上下文/kanban 身份作用域 | `delegated_child_context`, `scrub_kanban_env`, `DELEGATED_CHILD_ENV_MARKER` |
| `agent/subagent_lifecycle.py` | 插件安全生命周期契约 | `SubagentLifecycleService`, `bind_subagent_parent`, `SubagentHandle` |
| `agent/runtime_session_store.py` | worker 持久化门面 | `RuntimeSessionStore`, `is_worker_process`, `apply_row_annotations` |
| `agent/runtime_session_child.py` | 子会话 store（owner 预留） | `ChildSessionStore`, `reserve_child_store` |
| `agent/runtime_session_lifecycle.py` | 显式生命周期方法 | `RuntimeSessionLifecycleMixin` |
| `agent/runtime_session_compression.py` | worker 压缩 API | `RuntimeSessionCompressionMixin`, `_handoff_rows` |
| `agent/managed_worker.py` | 私有 exec 入口 | `main`, `MAX_FRAME`, `RESULT_FIELDS` |
| `agent/safe_worker_policy.py` | 冻结会话配置绑定 | `_bind_safe_worker_policy`, `safe_worker_enabled` |
| `agent/oneshot.py` | 非会话单发 LLM 调用 | `run_oneshot`, `PromptTemplate`, `_COMMIT_INSTRUCTIONS` |
| `agent/oneshot_footprint.py` | 有限会话削减面 | `is_single_query_session`, `ONESHOT_DISABLED_TOOLSETS` |
| `agent/side_question.py` | `/btw` 侧问（fork/oneshot） | `answer_side_question`, `trim_snapshot_for_fork`, `SIDE_QUESTION_TASK` |
| `agent/side_question_lease.py` | 插件侧问租约 | `SideQuestionLease`, `SIDE_QUESTION_CAPABILITY`, `LEASE_TTL_SECONDS` |
| `agent/side_question_request.py` | 分离缓存对齐 fork 执行 | `SideQuestionCapture`, `ask_text_only`, `PLUGIN_SIDE_QUESTION_TASK` |
| `agent/review_engine.py` | `/review` 共享引擎 | `start_review`, `_REVIEW_GOAL`, `DEFAULT_CONTEXT_MESSAGES` |
| `agent/review_idle_queue.py` | 空闲评审排队（本地 runtime） | `defer_mode`, `_IDLE_SETTLE_S`, `_MAX_AGE_DEFAULT_S` |
| `agent/process_bootstrap.py` | 进程级引导/传输池 | `_SHARED_TRANSPORTS`, `_HappyEyeballsSyncBackend`, `_SafeWriter` |
| `agent/primary_runtime_snapshot.py` | 主路由回退快照 | `_snapshot_primary_runtime` |

---

## 与其他模块的关系

- **tools/delegate_tool.py**（04_tools/delegation_tools.md）：生命周期本体——task 拆分、子代理
  spawn/join、`_run_single_child` 的工具面保存/恢复、后台单元结果回流；本组的 provider/registry/
  context 是它的决策与作用域供给方。
- **plugins/**：`PluginContext.register_delegation_provider` 注册 backend；默认 backend 就是
  `plugins/delegation/default`（核心工具不依赖插件 sweep，注册表可首用自加载）；
  `subagent_lifecycle` 经 `PluginContext.subagent_lifecycle` 发布。
- **agent/ 内**：`inline_tool_executors.py` 的 `delegate_task` 拦截 → `run_agent._dispatch_delegate_task`
  （tool_execution.md）；`bind_subagent_parent` 由 TurnFacadeMixin 调用；子代理的
  `platform="subagent"` 使 `agent_context="subagent"`（fork 写/召回被 manager 抑制，
  见 memory_learning.md）；`delegation_context` 被 `skill_preprocessing` 的内联 shell 复用。
- **gateway/**：多 profile 作用域 helper（`set_hermes_home_override`、secret scope）同时服务
  profile 路由的子代理与 `profile_scoped_chore`；托管模式下的 worker RPC/收据协议由
  `hermes_state_worker_*` 与 `gateway/session_worker_child.py` 配合。
- **cron/**：`side_question_lease` 不给 cron 发 token；`delegation_context.non_dispatcher_owned_context`
  防止 worker 里的 cron 运行被误读为 dispatcher 所有。
- **config**：`delegation.max_iterations` 默认 250（migration 36）、`max_concurrent_children`（migration
  37 提到 10）、`oneshot_max_children`；`auxiliary.{curator,side_question,review,background_review}.*`
  是各辅助 fork 的模型槽位。

## 总结

委派子系统把"拆分策略"与"执行机制"切得很干净：core 拥有全部机制（隔离、深度、并发、后台、
停止扇出、结果回填），插件只回答"这个 task 走哪条路"，且答案是纯数据。三个安全母题反复出现：
**fail-closed**（backend 不可用是工具错误而非静默换路；子上下文的身份门默认拒绝）、**作用域显式**
（contextvar 标记 + 子进程环境清洗 + 板围栏，绝不改进程全局）、**缓存钉死**（backend/schema 按
会话冻结，`/delegation` 默认等下一会话、`apply_now` 才破一次缓存）。辅助路径（/btw、/review、
curator fork）共享同一形态——缓存对齐 fork、dispatch 侧工具削减、用量记账回父会话——学会一个
就读懂了全部。
