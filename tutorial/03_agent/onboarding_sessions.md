# onboarding_sessions.md — 会话生命周期与新手引导:一次性提示、first-run 状态机、转录持久化与缓存安全注入

## 文件概览

本篇讲 agent 侧"会话"的一整圈外围:会话**从哪里来**(来源标签、客户端环境)、**活没活着**
(活动时钟、看门狗喂食)、**怎么落盘**(SQLite 转录持久化、持久化回执)、**怎么换皮**(表面切换、
编码姿态),以及两条新手引导路径——CLI/网关上的一次性 first-touch 提示,和桌面端 first-run 的
"一次聊天跑完所有节拍"状态机。主旋律是那条最老的不变量:**不要动已缓存的前缀**——范例是
`subdirectory_hints.py`:新发现的上下文文件"骑"在工具结果上注入,系统提示词一字不动。

first-run 引导是**纯数据状态机**:`onboarding_flow.py` 定义 7 个节拍(name → theme → layout →
connectors → plugins → tour → build),`apply(record, event, facts)` 返回"新记录 + 模型可见结果
+ 提醒键";`onboarding_record.py` 把记录存进会话行的 `sessions.model_config`(不加 schema);
`onboarding_session.py` 折入 `onboarding` 工具集,`onboarding_text.py` 出文案,
`onboarding_facts.py` 提供无需同意的机器事实,`onboarding_first_tasks.py` 是 build 节拍的任务
目录。

```text
桌面 first-run 引导(一次聊天,setup_beat 工具驱动):
  start(db, session_id, facts)  →  写 onboarding_run + set_run(True)
  聊天循环:
    脚本开场(问候+name 卡,onboarding_prelude)
    模型调 setup_beat(beat=...) → apply(record, Shown/Answered/Wrote/...)
        → Step(record, result, reminder)            onboarding_flow
    普通工具结果也结算节拍:set_theme/manage_connections/gui_tour → Applied
        (observe_tool_result, onboarding_record.py:161)
  build 卡的答案被结算 → phase=COMPLETE → 安装级 flag 关闭
```

| 文件 | 行数 | 角色 |
|---|---|---|
| `agent/onboarding.py` | 251 | 一次性 first-touch 提示(busy/tool-progress/OpenClaw 残留/首条消息 note)+ first-run 入口 |
| `agent/onboarding_facts.py` | 35 | 无需同意的"类 A"机器事实(OS/arch/机器类型/NVIDIA 平台/locale) |
| `agent/onboarding_first_tasks.py` | 328 | build 节拍的首任务目录(`FirstTask` + 资格门) |
| `agent/onboarding_flow.py` | 429 | 节拍与运行记录的纯状态机:`apply()` 是唯一事件归约器 |
| `agent/onboarding_record.py` | 178 | 运行记录存取:一次数据库事务里的 load→apply→save |
| `agent/onboarding_session.py` | 92 | 会话级拼装:工具集折入、脚本开场、per-turn note |
| `agent/onboarding_text.py` | 392 | 全部文案:多语言问候、隐藏首 turn 的开场提示词、提醒渲染 |
| `agent/session_source.py` | 72 | 来源词表:`tui/desktop/cli/oneshot/...` 与"有人在看"判定 |
| `agent/session_client_env.py` | 170 | shell 客户端冻结进会话的白名单环境(ContextVar 绑定) |
| `agent/session_activity.py` | 149 | 活动观察契约:时间戳 + 有界描述 + provenance 枚举 + 睡眠修正 |
| `agent/activity_tracking.py` | 149 | `ActivityTrackingMixin`:`_touch_activity` 单写路径 + 限频持久化 |
| `agent/session_persistence.py` | 607 | `SessionPersistenceMixin`:SQLite 转录落盘、去重标记、脚手架过滤 |
| `agent/persisted_turn_receipt.py` | 65 | `message.complete.persisted_turn` 回执:按 row_id 绑定流式回复 |
| `agent/history_commentary.py` | 181 | Codex commentary 显示投影(REST/网关历史共用,源数据不动) |
| `agent/coding_context.py` | 592 | "我们在写代码吗"的唯一裁决点:冻结的 RuntimeMode 姿态 |
| `agent/subdirectory_hints.py` | 326 | 渐进子目录提示:首访目录把 AGENTS.md 骑上工具结果 |
| `agent/surface_switch.py` | 140 | 表面切换不重建提示词:当前表面指导走 per-turn note |
| `agent/served_model.py` | 68 | 路由代理的"实际服务模型"捕获(httpx 响应钩子) |

---

## 关键代码走读

### 1. 一次性提示:`onboarding.seen.<flag>` 与"任务优先"条款

CLI/网关上的引导极轻:每个提示只在**每个安装**出现一次,旗标存 `config.yaml` 的 `onboarding.seen` 下;
文件刻意小而无依赖。首条消息的 note 有个关键条款——绝不让引导语吃掉真实任务:

```python
# agent/onboarding.py:131-136 + 138-143(节选)
TASK_FIRST_CLAUSE = (
    "If this message is itself a real request or task, DO THE TASK FIRST -- call "
    "whatever tools it needs -- and only then, in the closing sentences of that same "
    "reply, do what this note asks. Never let this note replace or skip work the user "
    "actually asked for. "
)
# PLAIN_INTRO_NOTE = "[System note: ... " + TASK_FIRST_CLAUSE + "briefly introduce yourself ...]"
```

`first_contact_turn_note()`(onboarding.py:146)决定首条消息挂哪份 note:`profile_build: ask` 且
旗标未落 → profile-build 指令(先问后查、绝不静默读已连接账号),否则普通自我介绍;会话历史非空、
安装里已有旧会话、first-run 进行中三者任一即返回 `None`。`mark_seen()`(onboarding.py:210)用
`atomic_config_write` 原子落旗标,失败静默(引导失败不该毁掉真实回复)。

### 2. first-run 状态机:`BEATS` 与 `apply()`

整个引导是数据:节拍表 + 事件归约。`Beat` 自带 `when` 门(这台机器要不要跳过)、`values`(可接受
的答案 id)、`after`(结算后的提醒键);`_settle_unfit` 建记录时就把不适用节拍标成 `skipped`:

```python
# agent/onboarding_flow.py:174-187(节选)
BEATS: tuple[Beat, ...] = (
    Beat("name", lambda facts, picks: {}, picks=("name",), value="name"),
    Beat("theme", lambda facts, picks: {"picker": "accent"}, picks=("accent", "mode"), value="accent"),
    Beat("layout", lambda facts, picks: {"options": list(LAYOUT_OPTIONS)}, picks=("layout",), value="layout",
         values=lambda facts, picks: _option_ids(LAYOUT_OPTIONS)),
    Beat("connectors", lambda facts, picks: {}, picks=("connected", "newly_connected")),
    Beat("plugins", ..., when=lambda facts, picks: bool(facts.plugins)),   # 这台机器没装就不显示
    Beat("tour", ..., when=lambda facts, picks: facts.tours),
    Beat("build", ..., value="build", values=build_values),                # 首个任务卡,结算即完成
)
```

`apply()`(onboarding_flow.py:412)是唯一入口:深拷贝记录、按事件类型分派给 `_HANDLERS` 表、build
结算即完成。事件 9 种——`Shown`(出卡片)、`Answered`(卡上作答)、`Wrote`(改发消息)、`TimedOut`
(卡片超时 300s)、`Recorded`(值用文字给出)、`Skipped`、`End`(Skip setup)、`Done`、`Applied`
(普通工具结果结算节拍);文件**纯**,无 I/O 无时钟。`valid_answer()`(onboarding_flow.py:271)防
越权:答案只能携带本节拍的 pick 键、id 必须来自卡片自己的选项,`label` 只是显示文本、绝不入库。

### 3. 运行记录存取与工具集折入

记录存在 `sessions.model_config` 的 `onboarding_run` 键下——不加 schema,压缩轮转顺带携带。
`advance` 是 `start` 之后的唯一写者,用回调式事务把读和写放进同一临界区(Skip setup 与卡片作答
并发时,旧副本不会覆盖新状态):

```python
# agent/onboarding_record.py:47-70(节选)
def _transition(db, session_id: str, event: Event) -> Step | None:
    """Apply *event* and write the result in one database transaction at the compression tip ..."""
    holder: dict[str, Any] = {}
    def update(current: Any) -> Any:      # 事务内回调:load → apply → save
        holder["was_active"] = is_active(current)
        holder["step"] = apply(current, event, Facts.from_stored(current["facts"]), now=time.time())
        return holder["step"].record
    db.update_conversation_model_config_value(session_id, KEY, update)
    step = holder.get("step")
    # Told before the flag write, which can fail: the record already says the run ended.
    if step is not None and holder["was_active"] and not is_active(step.record):
        _announce(step.record.get("run_id"), session_id, step.record["ended_by"])
    if step is not None and not is_active(step.record) and active_session_id(db) is None:
        _close_install_flag()
```

两个次序细节:结束公告在**写安装旗标之前**发(旗标写可能失败,而记录已宣布结束);旗标只在
**没有别的 run 还开着**时关闭——旗标属于活着的 run,旧聊天不能替它收尾。`delete_chat()`
(onboarding_record.py:125)则先关旗标再删、删除失败把旗标设回,并把每份压缩副本逐行写上
`End("deleted")`。

`setup_beat` 什么时候进工具数组?答案是 **agent 构建时定死**——工具数组是缓存前缀的一部分,
run 结束绝不撤掉(已结束的 run 会对 `setup_beat` 回绝,直到会话重建):

```python
# agent/onboarding_session.py:39-48(节选)
def onboarding_chat_toolsets(enabled, db, session_id: str):
    """...Keyed on the record existing, never on the run being open: the tool array is part of
    the cached prefix; a run that ends must not change it mid-conversation."""
    from agent.onboarding_record import load
    if keeps_toolsets(enabled) or db is None:
        return enabled
    tip = db.get_compression_tip(session_id) or session_id
    return with_onboarding(enabled) if load(db, tip) is not None else enabled
```

判据是"**记录存在**"而非"run 还开着"——每 turn 都解析工具集的会话权威,若按 run 开关切换,
run 结束那一 turn 会原地丢弃缓存前缀。脚本开场 `onboarding_prelude()`(onboarding_session.py:58)
只在 name 节拍从未展示时产出问候 + 第一次 `setup_beat` 调用,重启时问候已在历史里就不再说。

### 4. 转录持久化:去重标记与临时脚手架过滤

`SessionPersistenceMixin` 把对话落 SQLite,两个契约值得背下来。"已落盘"标记必须挂在 **dict 的键**
上而非 `id(msg)` 集合——`id()` 会把被释放 dict 的地址别名叫到新消息上;恢复用的临时脚手架**绝不**
进持久转录,否则续会话会重放合成 turn 或破坏前缀缓存复用:

```python
# agent/session_persistence.py:34-44 + 52-60(节选)
_EPHEMERAL_SCAFFOLDING_FLAGS = (
    "_empty_recovery_synthetic",
    "_empty_terminal_sentinel",
    "_thinking_prefill",
    "_verification_stop_synthetic",  # verify-on-stop nudge; the assistant candidate itself is NOT synthetic
    "_pre_verify_synthetic",
    "_kanban_stop_synthetic",  # kanban worker stop-guard
    "_dropped_toolcall_nudge",  # internal retry instruction; must not replay as user context
)

# `_DB_PERSISTED_MARKER` ... is the intrinsic "already written to SQLite" marker: an
# id(msg) set can alias a freed dict's address onto a new message, a key on the dict cannot. ...
# CONTRACT: the marker asserts the dict's CONTENT is durable as written — any in-place mutation
# that must persist MUST pop it (turn_finalizer, context_compressor).
```

落盘是**文本投影**:`_durable_content()`(session_persistence.py:122)把多模态信封压成摘要、
图片 part 变成位置保真的 `[screenshot]`(带 `detail=` 的标记供 `image_replay` 重建原始 part)。
图片字节本体没丢——会话权威把它们提交到 profile 的内容寻址 `native-inputs/<sha256>/`,行内写
`[Image attached at: <path>]`,这是 image_replay 的前提。会话 id 是可能不可信的
`X-Hermes-Session-Id`,`_safe_session_filename_component()`(session_persistence.py:63)清洗非法
字符并加内容哈希防碰撞——导出/轨迹文件的路径安全层。

### 5. 活动时钟:单写路径、代数计数与限频心跳

`ActivityTrackingMixin._touch_activity` 是活动戳的**唯一**写路径。在一个锁里同时推进 monotonic 代数
和时间戳,让看门狗把"停滞观察"绑定到确切的 `(generation, timestamp)`,避免中断一个恰好在观察
间隙恢复了的 turn:

```python
# agent/activity_tracking.py:63-89(节选)
resolved_provenance = normalize_activity_provenance(provenance)
with _activity_lock(self):
    self._turn_liveness_activity_generation = (getattr(self, "_turn_liveness_activity_generation", 0) + 1)
    self._last_activity_ts = time.time()
    self._last_activity_desc = bound_activity_description(desc)
    self._last_activity_provenance = resolved_provenance
    self._turn_liveness_abort_claim = None   # real progress invalidates a reserved abort claim
if os.environ.get("HERMES_KANBAN_TASK"):     # kanban 心跳桥(限频、best-effort、永不抛进循环)
    with suppress(Exception):
        heartbeat_current_worker_from_env(); inject_new_comments_from_env(self)  # OUT-OF-BAND steer
if force_persist or is_terminal_compression_provenance(resolved_provenance):
    # ... deferring this write leaves the durable row advertising a compression that has already
    # ended — the permanently "stuck" chat (#72039).
    reset_session_activity_persist_window(self)
self._persist_session_activity_if_due()
```

`session_activity.py` 定义共享契约:描述钳 120 字符;provenance 是封闭名词枚举(默认 `unknown`,
压缩写手带 `agent.compression*`);心跳下限 60s 是**代码常量**(不许任何配置把它变成高频写手)。
`AwakeIdleMeter`(session_activity.py:121)修一个真实 bug:挂起的笔记本按 wall clock 算 idle,
唤醒后第一拍会误杀健康 turn——`time.monotonic()` 睡眠时暂停,两钟之差就是睡掉的秒数。

### 6. 来源标签、客户端环境与持久化回执

`session_source.py` 是词表叶子(唯一依赖 stdlib-only):`tui/desktop` 是 UI 传输来源、`oneshot`
让 `hermes chat -q` 在人工选择器里隐藏、`ATTENDED_SOURCES` 判定"turn 运行时有人在看":

```python
# agent/session_source.py:17-30
UI_TRANSPORT_SOURCES = frozenset({"tui", "desktop"})
ONESHOT_SOURCE = "oneshot"
CLI_FAMILY_SOURCES = frozenset({"cli", ONESHOT_SOURCE})
DAYBREAK_SOURCES = UI_TRANSPORT_SOURCES | {"cli"}
ATTENDED_SOURCES = UI_TRANSPORT_SOURCES | {"cli", "acp"}
```

`session_client_env.py` 解决"一个网关进程服务所有会话"后的环境归属:客户端在 `session.create`
时把**白名单**值(行为名 + 工具链名 + profile 配置的额外名)随会话冻结,绑到 ContextVar
(`client_env_scope`),绝不写进网关的 `os.environ`。`session_env()` 读行为值、`toolchain_environ()`
为工具子进程装配环境——本客户端没导出的工具链变量被**显式 unset**(一个客户端的 venv 不能经
daemon 渗进另一客户端的会话),`_travels()` 还拦下命中密钥策略的 `NODE_` 前缀名;非 `local`
客户端(Desktop)只保留不指名本主机的值。

`persisted_turn_receipt()` 为 `message.complete.persisted_turn` 事件产出本 turn 已提交行的地址;
docstring 里的设计意图一句话:**报告已提交的 row 地址,绝不做文本/时间戳搜索**。回执分级:
`row_ids`(部分)、`user_row_ids`(turn 里每条可见 user 行,支持 steer/redirect 多 prompt)、
`final_assistant_row_id`,以及 `complete` 标志——要求前缀逐行匹配、无压缩、无重定向边界。
`committed_row_id()`(persisted_turn_receipt.py:15)要求消息同时带 `_DB_PERSISTED_MARKER` 和正
整数 `_row_id`——回执只认真正落盘的行;TUI/桌面据此把乐观气泡绑定到存储行,重启后也不错位。

### 7. 子目录提示:缓存安全注入的教科书范例

最后深讲本篇样板戏。启动时 `prompt_builder.py` 只加载 CWD 的 AGENTS.md/CLAUDE.md;agent 通过
工具调用走进子目录时,`SubdirectoryHintTracker` 在**首次**触及每个目录时把该目录的提示文件追加
到工具结果上——上下文到达了,系统提示词一字未动:

```python
# agent/subdirectory_hints.py:187-196
def check_tool_call(self, tool_name: str, tool_args: dict[str, Any]) -> Optional[str]:
    """Return formatted hint text for newly visited directories, or None."""
    from agent.safe_worker_policy import safe_worker_enabled

    if not self.enabled or safe_worker_enabled():
        return None
    if self._home_is_working_dir:
        return None
    all_hints = [h for d in self._extract_directories(tool_name, tool_args) if (h := self._load_hints_for_directory(d))]
    return "\n\n" + "\n\n".join(all_hints) if all_hints else None
```

短函数下叠了四层防御,每层都有真实事故背书:**路径仲裁**(`_resolved_hint_target`,subdirectory_hints.py:40)
——`read_text` 会跟随符号链接,仓库里一个 `sub/AGENTS.md -> ~/.aws/credentials` 就能把树外
文件注入工具结果,所以 resolve 后的目标必须留在工作目录内、通过规范读黑名单,黑名单查询失败
**fail-closed** 拒载;**家目录不是项目**(subdirectory_hints.py:123)——无默认项目的桌面应用把
cwd 解析到 `$HOME`,包含检查对整个 home 子树**空洞地**为真,所以 home/容器 home 直接禁用提示
发现,会话领养真实项目后 `rebind_working_dir()` 再开;**内容去重**(subdirectory_hints.py:299-303)
——同一文件经符号链接/硬链接/拷贝到达也只发一次,以 sha256 摘要去重;**上限+警告**
(`_MAX_HINT_CHARS = 32_000`)——超限保留头尾、带路径标记让 agent 可 `read_file` 续读,并打
WARNING(旧的 8k 静默截尾把 `apps/desktop/AGENTS.md` 切掉了几个月无人察觉)。

目录提取同样讲究:`_nav_targets()` 用 shlex 分词只认 shell 段**开头**的 `cd`/`pushd` 操作数
(`echo cd backend` 是散文不是导航);`_is_excluded` 与搜索探针共享 `SEARCH_PRUNE_DIR_NAMES`
排除依赖/构建树;`enabled=False` 镜像 `skip_context_files`——启动时拒绝 AGENTS.md 注入的会话,
后面也不许从工具结果偷渡回来(cron 转述精确 stdout 曾把它漏进聊天,#9441)。

### 8. 表面切换、编码姿态与 served model

`surface_switch.py` 处理 desktop↔TUI 换皮:重建系统提示词会让 220K 会话的缓存命中掉到 1%。
方案是保留已存字节,把**当前**表面的指导装进一次性 turn note(骑 user 消息 sidecar `api_content`,
字节稳定、后续 turn 原样重放),提示词本体等到下次重建边界(压缩)再收敛;`note_inert_pinned_tools()`
还要点名本表面没构建的"惰性钉住工具"——移除它们才会真的 re-prefill,所以只能告诉模型"调了会
失败"。`coding_context.py` 在会话初把"编码姿态"冻结为不可变 `RuntimeMode`:workspace 快照每会话
探针一次,之后 `system_prompt_parts(workspace_block=...)` 重放同一份字节——同为缓存安全。
`served_model.py` 补最后一块:LiteLLM 式代理把真实路由的部署放进响应头(`x-litellm-model-id`),
OpenAI SDK 解析对象会丢头,所以捕获挂 httpx 响应钩子,值落 `agent.last_served_model`——None 表示
本次响应没带头,值永不比产生它的请求活得久。`history_commentary.py` 同属"显示与存储分离"族:
存储的 reasoning 原样保留供模型重放,公开转录文本只准用投影字段。

---

## 核心类/函数

| 名称 | 位置 | 职责 |
|---|---|---|
| `first_contact_turn_note` / `mark_seen` | agent/onboarding.py:146/210 | 首条消息一次性 note;旗标原子写 |
| `Facts` / `new_record` / `apply` / `valid_answer` | agent/onboarding_flow.py:27/191/412/271 | 类 A 事实;建记录;9 种事件归约;卡答案防越权 |
| `start` / `advance` / `delete_chat` / `observe_tool_result` | agent/onboarding_record.py:87/99/125/161 | run 记录写/事务推进/删除聊天/工具结果结算节拍 |
| `onboarding_chat_toolsets` / `onboarding_prelude` / `reminder` | agent/onboarding_session.py:39/58, onboarding_text.py | 缓存安全的工具集折入;脚本开场;提醒渲染 |
| `ActivityProvenance` / `AwakeIdleMeter` / `_touch_activity` | agent/session_activity.py:24/121, activity_tracking.py:41 | 来源枚举;睡眠修正;活动单写路径 |
| `_is_ephemeral_scaffolding` / `durable_user_row_content` / `persisted_turn_receipt` | agent/session_persistence.py:52/94, persisted_turn_receipt.py:20 | 脚手架过滤;持久行分野;行地址回执 |
| `SubdirectoryHintTracker` / `check_tool_call` | agent/subdirectory_hints.py:136/187 | 首访目录提示,骑工具结果注入 |
| `stage_surface_switch_note` / `install_served_model_capture` | agent/surface_switch.py:103, served_model.py:35 | 表面切换 note;代理真实路由模型捕获 |
| `is_attended` / `session_source_for` | agent/session_source.py:61/39 | 有人在看判定;来源标签解析 |
| `client_env_scope` / `toolchain_environ` | agent/session_client_env.py:112/147 | 会话冻结环境绑定;工具子进程环境 |
| `RuntimeMode`(coding_context) | agent/coding_context.py | 冻结的编码姿态(auto/focus/on/off) |

## 本组文件清单

| 文件 | 主题 | 一句话 |
|---|---|---|
| `agent/onboarding.py` | 引导 | 一次性提示 + 首条消息 note + first-run 入口 |
| `agent/onboarding_facts.py` | 引导 | 类 A 机器事实,无需同意 |
| `agent/onboarding_first_tasks.py` | 引导 | build 节拍首任务目录与资格门 |
| `agent/onboarding_flow.py` | 引导 | 节拍状态机(纯数据,9 种事件归约) |
| `agent/onboarding_record.py` | 引导 | run 记录存取(model_config 键 + 事务推进) |
| `agent/onboarding_session.py` | 引导 | 工具集折入、脚本开场、per-turn note |
| `agent/onboarding_text.py` | 引导 | 多语言文案、开场提示词、提醒渲染 |
| `agent/session_source.py` | 会话 | 来源词表 + attended 判定 + Daybreak 表面 |
| `agent/session_client_env.py` | 会话 | 客户端环境冻结进会话(ContextVar) |
| `agent/session_activity.py` | 会话 | 活动观察契约 + 睡眠修正计时器 |
| `agent/activity_tracking.py` | 会话 | `ActivityTrackingMixin`:活动单写路径 |
| `agent/session_persistence.py` | 持久化 | `SessionPersistenceMixin`:SQLite 转录落盘 |
| `agent/persisted_turn_receipt.py` | 持久化 | turn 完成回执(row 地址绑定) |
| `agent/history_commentary.py` | 持久化 | Codex commentary 显示投影(源数据不动) |
| `agent/coding_context.py` | 姿态 | "我们在写代码吗"唯一裁决点 |
| `agent/subdirectory_hints.py` | 注入 | 首访子目录提示(缓存安全范例) |
| `agent/surface_switch.py` | 姿态 | 表面切换不重建提示词 |
| `agent/served_model.py` | 模型 | 路由代理真实服务模型捕获 |

## 与其他模块的关系

- **tools/**:first-run 引导由 `tools/setup_beat_tool.py` 驱动;`set_theme_tool`、`gui_tour`、
  `manage_connections` 的结果经 `observe_tool_result` 结算节拍;kanban 心跳桥在 `_touch_activity` 里。
- **hermes_state/**:`sessions.model_config` 是 run 记录的家,`hermes_state_compression` 保证压缩轮转
  携带它;`touch_session_activity`/`clear_session_activity_labels` 是活动投影落点。
- **gateway/**:来源标签由 `gateway/session_context.get_session_env` 供给;run 结束公告发给每个窗口;
  `gateway/session_finite` 参与 attended 判定;表面切换 note 由网关换皮触发。
- **hermes_cli/**:`onboarding_run.set_run` 是安装级 flag 的唯一写者;`atomic_config_write` 支撑 `mark_seen`。
- **agent/其余**:`_DB_PERSISTED_MARKER` 定义在 `context_compressor.py`;`_touch_activity` 由 turn 循环
  与 MoA 扇出桥(`moa_loop._reference_liveness_hook`)喂食;`subdirectory_hints` 复用 `prompt_builder`
  的读取/扫描/截断三件套与 `search_policy` 的排除目录。
- **hermes_platform**:`onboarding_facts.read_facts` 全部取自 `hermes_platform.host.summary`;
  **apps/desktop** 的多语言问候与桌面 first-run 文案必须逐字一致(注释互相钉住)。

## 总结

这一组文件是"会话"这个名词的全部周边:出生(来源、客户端环境)、活着(活动时钟与回执)、落盘
(去重标记 + 脚手架过滤的转录)、变脸(表面切换、编码姿态、代理后真实模型)和新生(两条引导
路径)。三个手法值得带走:**一次性状态用 install 级旗标 + 原子写**,永不重复打扰;**会话级可变
物冻结进会话行**(model_config、client_env),一进程多 profile 不串台;而最核心的——任何"中途
想给模型加点上下文"的冲动都必须过缓存这道闸,subdirectory_hints 的四层防御、surface_switch 的
turn note 通道、onboarding 工具集的"记录存在"判据,都是同一句话的不同拼法:**新信息骑在
user/tool 消息上,已缓存的前缀不动。**
