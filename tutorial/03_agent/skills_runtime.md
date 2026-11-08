# skills_runtime.md — 技能运行时与策展人：slash 注册、预处理管线、索引增量与 Curator 生命周期机

## 文件概览

技能的**格式与安装**（SKILL.md frontmatter、hub 安装、`/skills` 命令）在 12_skills 与
04_tools/skills_memory.md 讲；本篇讲**运行时**：一个技能从磁盘走到模型面前要经过

```
SKILL.md 磁盘扫描 ──► /skill-name slash 命令表（多槽缓存）
                      │
/skill 或 /bundle ──► _build_skill_message（脚手架 + 预处理 + 缓存边界注册）
                      │                    └─ skill_preprocessing：${HERMES_*} 展开、!`cmd`
                      ▼
              user 消息（模型可见）
                      ▲
会话中途安装/删除 ──► skills_index_delta：索引差量骑 user 注记通道
turn 结束        ──► background_review：daemon 线程回放快照问"要不要存技能/记忆"
不活动           ──► curator：生命周期迁移 + 可选 LLM fork 整合（tar.gz 快照先行）
```

| 文件 | 行数 | 角色 |
|---|---|---|
| `agent/skill_commands.py` | 1,028 | `/skill-name` 自动注册、脚手架构造/解析、多槽缓存 |
| `agent/skill_bundles.py` | 213 | 技能束：一个 slash 别名加载多个技能 |
| `agent/skill_preprocessing.py` | 156 | 模板变量展开 + 内联 shell 片段 |
| `agent/skill_utils.py` | 902 | frontmatter/平台门/搜索根与优先级（共享底座） |
| `agent/skills_index_delta.py` | 138 | 系统提示词技能索引的中途差量投递 |
| `agent/background_review.py` | 1,392 | turn 后台记忆/技能评审 fork |
| `agent/curator.py` | 1,218 | 不活动触发的技能生命周期策展人 |
| `agent/curator_backup.py` | 492 | 策展人 tar.gz 快照与回滚 |

---

## 关键代码走读

### 1. 技能即 slash 命令：多槽缓存键 `(platform, home, project)`

每个技能自动注册一条 `/skill-name`。扫描结果按**完整解析身份**缓存——旧的单槽 memo 只持一个
`(platform, home, project)` 三元组，Desktop serve 进程身份来回摆动时每次 poll 都 miss、每 5 秒
重扫 3 次（#104849）：

```python
# agent/skill_commands.py:18-36（节选）
_skill_commands_by_key: dict[tuple, dict[str, dict[str, Any]]] = {}
_last_interactive_skill_commands_by_key: dict[tuple, dict[str, Any]] = {}
_skill_commands_sig_by_key: dict[tuple, tuple] = {}
_publish_lock = threading.Lock()
```

三个键分别来自：`HERMES_PLATFORM` / 会话平台环境（`skills.platform_disabled` 视图）、
`get_hermes_home()`（profile 各带 `skills.external_dirs`，#88023）、`find_project_root()`
（一个多会话主机服务多个 repo，#114359）。`scan_skill_commands()` 把扫描做成"本地构建 +
锁内一次性发布"——直接写全局会让并发扫描对着**自己的半成品**报"already claimed"假冲突（#74574）；
磁盘签名（`_skill_dirs_signature`）在扫描**前**取样，别的终端装/删技能能推动它触发重扫（CFG-8）。
注册时核心命令优先：与 core slash 撞名的技能跳过自动注册（`skill_command_collision_note` 同一谓词
喂给 `/skills` 列表与命令面板做用户提示），同 slug 去重 first-wins 保住 project > local > external
优先级。技能名走 `\w` 保留 Unicode——`name: 小说拆条` 注册 `/小说拆条`（#12351）。

### 2. `_build_skill_message`：中途注入骑 user 消息 + 缓存边界

技能内容**不进系统提示词**，而是展开成一条模型可见的 user 消息。有指令时，脚手架部分是稳定前缀、
调用方指令是易变尾部，边界被显式注册给缓存规划器：

```python
# agent/skill_commands.py:401-416（节选）
    stable_prefix = None
    if user_instruction:
        parts.append("")
        # Everything before the caller-supplied instruction is a stable scaffold; declare the exact boundary
        # so the Anthropic cache planner can put a breakpoint on it instead of caching the whole message as
        # one atomic block (#81867).
        stable_prefix = append_user_instruction(parts, user_instruction)
    if runtime_note:
        parts += ["", f"[Runtime note: {runtime_note}]"]
    message = "\n".join(parts)
    if stable_prefix is not None and message.startswith(stable_prefix) and len(message) > len(stable_prefix):
        register_stable_prefix(stable_prefix)
```

同一构造点的另一面是**解析**：`extract_user_instruction_from_skill_content` 依赖脚手架标记
（`_SKILL_INVOCATION_PREFIX`、`_SINGLE_SKILL_INSTRUCTION` 等）逐字节稳定，从展开后的消息里还原
"用户到底说了什么"——记忆 provider 存 turn 时要的就是这个（`MemoryManager._strip_skill_scaffolding`
直接引用它），会话标题/预览同理（`describe_skill_invocation` 渲染成 `/work — fix the title leak`）。
构造方与解析方的标记必须 byte-identical，这是全文件最硬的隐含契约。

### 3. `skill_preprocessing`：令牌展开与 `!`cmd`` 内联 shell

```python
# agent/skill_preprocessing.py:142-156
def preprocess_skill_content(content, skill_dir, session_id=None, skills_cfg=None) -> str:
    """Apply configured SKILL.md template and inline-shell preprocessing."""
    if not content:
        return content
    cfg = skills_cfg if isinstance(skills_cfg, dict) else load_skills_config()
    if cfg.get("template_vars", True):
        content = substitute_template_vars(content, skill_dir, session_id)
    if cfg.get("inline_shell", False) and not _is_community_hub_skill(skill_dir):
        content = expand_inline_shell(content, skill_dir, int(cfg.get("inline_shell_timeout", 10) or 10))
    return content
```

- `${HERMES_SKILL_DIR}` / `${HERMES_SESSION_ID}`：解析不了的**原样保留**，作者看得见。
- `` !`cmd` ``：单行 shell 片段在加载时执行、替换为 stdout，输出上限 **4000 字符**
  （`_INLINE_SHELL_MAX_OUTPUT`，防 runaway 命令撑爆上下文）；失败返回 `[inline-shell ...]` 标记
  而非抛异常。
- 安全门：`inline_shell` **默认关**；即便开了，hub 社区信任级的技能也不自动执行——hub 的
  INSTALL_POLICY 本会拦截高危社区安装，但 `--force` 能把它放上磁盘，内联 shell DSL 又扫描为高危，
  自动执行等于把被拒的东西重新武装（#63307）。锁不可读时对树内技能 **fail-closed**。
- Windows 上 bash 解析复用终端工具的 `_find_bash()`（CreateProcess 会先搜 System32、可能选中
  WSL 启动器），子进程环境经 `delegated_child_subprocess_env()`（delegation_context，见本组
  delegation_subagents.md）。

### 4. `skills_index_delta`：不重建提示词的索引更新

`<available_skills>` 索引住在系统提示词里，会话一生不动它（缓存前缀！）。会话中途安装/创建/删除
技能（hub install、`skill_manage`、curator、另一进程），索引就过期了。解法是每 turn 对比
"提示词携带的索引"与"现在会构建的索引"，把**完整差量**发到每 turn 的 user 消息注记通道
（骑在缓存前缀之后；移植自 cloudflare/cloudflare-os#267）：

```python
# agent/skills_index_delta.py:1-13（模块 docstring）
"""Skills that change mid-conversation reach the model without a prompt rebuild.
...
Each note states the FULL difference against the prompt, so the prompt plus the newest note is the
complete record of what the model was told. A fresh agent (the gateway builds one per turn) reads that
record back from the transcript once; a long-lived agent (CLI, TUI, Desktop) keeps it on itself. A note
is sent only when the difference changes."""
```

"完整差量"是关键：最新一条注记 + 提示词 = 模型被告知过的完整记录，所以网关每 turn 重建的
agent 只需从转录读回一次。

### 5. `curator.py` 深讲：生命周期状态机

Curator **不靠 cron 守护**：由会话启动钩子在 agent 空闲时调用 `maybe_run_curator()`。
调度门槛（`should_run_now`）与状态机如下：

```
                      .usage.json 遥测（use/view/patch 计数、last_activity_at、pinned）
                                      │
        ┌─────────────────────────────▼──────────────────────────────┐
        │ maybe_run_curator(idle_for_seconds)                        │
        │  should_run_now: enabled ∧ ¬paused ∧ last_run_at 距今      │
        │                  ≥ interval_hours（默认 7d，首观播种推迟）  │
        │  idle_for_seconds ≥ min_idle_hours（默认 2h）              │
        │  _claim_run():  .locks/curator-run O_EXCL 跨进程认领       │
        └──────────────┬─────────────────────────────────────────────┘
                       ▼
        run_curator_review（trigger="scheduled"）
         ① consolidate ⇒ curator_backup.snapshot_skills("pre-curator-run")
         ② apply_automatic_transitions（纯函数，无 LLM）
         ③ 落盘 .curator_state（last_run_at/run_count，先于 LLM pass，崩溃可查）
         ④ consolidate ⇒ fork AIAgent 跑 CURATOR_REVIEW_PROMPT（opt-in）

  生命周期状态机（对每条 curated 记录）：
     active ──anchor ≤ stale_after_days(14d)──► stale
     stale  ──anchor > stale_cutoff───────────► active     （又用了）
     active/stale ──anchor ≤ archive_after_days(30d)──► archived（目录移入 .archive/，可恢复）
     ✗ pinned / cron 引用 / locked：全部豁免
     ✗ use_count==0 且未到 stale 期：缺席证据≠陈旧，只 reactivate
```

```python
# agent/curator.py:209-268（节选）
def apply_automatic_transitions(now=None) -> dict[str, int]:
    """Move every curator-managed skill between active/stale/archived based on its latest real
    activity; pinned skills are never touched."""
    ...
    protected = _cron_referenced_skills()          # cron 引用 = 在用，视同 pinned
    ...
    for row in _u.curated_report():
        name = row["name"]
        if row.get("pinned") or name in protected or (locked_names and is_locked_skill(name, locked_names)):
            continue
        if not row.get("_persisted", True):
            _u.seed_record_if_missing(name)        # 首见：时钟锚到现在，推迟一期
            continue
        ...
        if anchor <= archive_cutoff and current != _u.STATE_ARCHIVED:
            if _archive_as_curator(_u, name):      # ledger actor 打成 'curator'
                counts["archived"] += 1
        elif anchor <= stale_cutoff and current == _u.STATE_ACTIVE:
            _set(name, _u.STATE_STALE, "marked_stale")
        elif anchor > stale_cutoff and current == _u.STATE_STALE:
            _set(name, _u.STATE_ACTIVE, "reactivated")
```

三条**不变量**贯穿全文件：只碰 `created_by: "agent"` 的本地策展技能（bundled/hub/external
在候选列表前就被滤掉）；**永不删除**——archive 是上限、进 `.archive/` 可 `hermes curator restore`；
pinned（以及 cron 引用、锁定的）技能豁免一切迁移。LLM 整合 fork（`_run_llm_review`，curator.py:1086）
是**辅助客户端**、opt-in（`curator.consolidate`，默认 False）：`enabled_toolsets=["skills"]`
——没有 terminal，"shell mv/cp/rm 不留 ledger，回滚只会恢复空心技能，砍掉 toolset 从构造上封洞"；
`max_iterations=9999`（伞形整合数百技能要 50-100 次调用）；`memory_agent_context="subagent"`
只为压缩检查点持有 provider；`_memory_write_origin="background_review"` 让 skill_manage 的
后台写守卫生效。LLM pass 跑在 daemon 线程上，且必须 `copy_context()` 携带调用方的 profile
作用域——裸线程会掉回进程 home，把另一个 profile 的技能库读改写（curator.py:1018-1026 注释）。

### 6. `curator_backup.py`：回滚是"可回滚的"

任何会重写内容的 pass（只有 LLM 整合会原地改写；纯 prune 只是目录改名）之前，整个 `skills/` 树
tar.gz 进 `.curator_backups/<utc-iso>/`，带 `manifest.json`，并顺手拷贝 `cron/jobs.json` 的两个
字段（整合会原地改写 cron 的 `skills`/`skill` 引用）。排除名单本身就是一份事故史：

```python
# agent/curator_backup.py:37-43
_EXCLUDE_TOP_LEVEL = {".curator_backups", ".hub", ".locks", ".git", ".archive", ".curator_ledger.jsonl"}
```

注释里记着教训：`.git` 回滚会破坏 git 追踪且快照嵌套膨胀（38MB 涨到 24GB）；`.archive/` 与
append-only 的 `.curator_ledger.jsonl` 回滚到旧副本会**丢失条目/技能**——而"永不删除"的承诺
正押在它们身上（650MB ledger 曾让每次快照 820MB、每次 archive 解压全程卡 CLI 6 分钟）。
嵌套的 venv/node_modules 等**可再生目录**也跳过（单个 torch venv 1.3GB，#107539）。
回滚（`rollback_snapshot`）先给**当前**树拍快照再解压目标——回滚自身可撤销。

### 7. `background_review.py`：turn 后的记忆/技能评审

`run_conversation` 结束后可派 daemon 线程，回放对话**快照**进一个 fork 的 `AIAgent`，问
"该保存/更新什么技能或记忆？"。三个决定性事实：fork **继承父运行时**（provider/model/凭据/缓存
系统提示词）因此命中同一前缀缓存；写直接进 memory + skill 存储，主会话与主缓存零接触；
fork 运行在 dispatch 侧工具白名单下。`_BackgroundReviewRun` 提供每评审的取消/完成握手
（`cancel_background_review_for_live_turn` 让新 turn 到来时在途评审让路）； managed local
runtime（本地 llama-server）上评审 fork 会霸占 GPU，`review_idle_queue.py` 因此把评审排队到
机器空闲（`/slots` 安静 15s 才算 idle；每会话一槽、最新快照胜出、超龄 30 分钟照发）。

---

## 核心类/函数

| 符号 | 位置 | 职责 |
|---|---|---|
| `scan_skill_commands` | skill_commands.py:555 | 扫描技能目录 → {"/name": 元数据}，本地构建+原子发布 |
| `_resolve_skill_commands_{platform,home,project}` | skill_commands.py:214/230/244 | 多槽缓存键三元组 |
| `slugify_skill_name` | skill_commands.py:85 | `Foo Bar` → `foo-bar`；保留 Unicode |
| `_build_skill_message` | skill_commands.py:366 | 脚手架消息构造 + `register_stable_prefix` |
| `append_user_instruction` | skill_commands.py:92 | 稳定前缀止于指令标记（单一构造点保证字节前缀性） |
| `extract_user_instruction_from_skill_message` | skill_commands.py:108 | 从展开消息还原用户指令（bundle 用首标记、单体用末标记） |
| `describe_skill_invocation` | skill_commands.py:154 | 渲染回用户输入形态（预览/标题） |
| `_load_bundle_file` / `_bundles_sig` | skill_bundles.py:60/44 | bundle YAML 解析；内容摘要签名（mtime 偏斜免疫） |
| `substitute_template_vars` / `expand_inline_shell` | skill_preprocessing.py:36/89 | `${HERMES_*}` 展开；`!`cmd`` 执行（≤4000 字符） |
| `preprocess_skill_content` | skill_preprocessing.py:142 | 预处理总入口（模板默认开、shell 默认关） |
| `get_skill_search_roots` / `pick_skill_candidate` | skill_utils.py:413/452 | 搜索根与 project>local>create>external 优先级 |
| `skill_matches_platform/environment/apps` | skill_utils.py:109/167/177 | frontmatter 平台/环境/应用门 |
| `index_entries` / `diff_skill_indexes` | skills_index_delta.py:40/… | 索引解析与差量；user 注记通道投递 |
| `should_run_now` | curator.py:160 | 调度门槛（enabled/paused/interval/首见播种） |
| `apply_automatic_transitions` | curator.py:209 | active/stale/archived 状态机（pinned/cron/locked 豁免） |
| `run_curator_review` | curator.py:917 | 单次 pass：备份→迁移→（可选）LLM fork→报告/状态 |
| `maybe_run_curator` | curator.py:1204 | 空闲触发的公共入口（O_EXCL 跨进程认领） |
| `_run_llm_review` | curator.py:1086 | fork AIAgent（skills-only toolset、ledgered 写） |
| `snapshot_skills` / `rollback_snapshot` | curator_backup.py | tar.gz 快照 / 先拍当前再回滚 |
| `load_background_review_settings` / `spawn_background_review_thread` | background_review.py:228/… | 评审开关/任务配置与 fork 派生 |
| `_BackgroundReviewRun` | background_review.py:28 | 评审取消/完成握手 |

---

## 本组文件清单

| 文件 | 角色 | 关键符号 |
|---|---|---|
| `agent/skill_commands.py` | slash 注册、脚手架、多槽缓存 | `scan_skill_commands`, `_build_skill_message`, `extract_user_instruction_from_skill_message` |
| `agent/skill_bundles.py` | YAML 技能束（束优先于技能） | `_load_bundle_file`, `_bundles_sig`, `resolve_slash_key` |
| `agent/skill_preprocessing.py` | 模板令牌 + 内联 shell | `preprocess_skill_content`, `run_inline_shell` |
| `agent/skill_utils.py` | frontmatter/门/搜索根共享底座 | `parse_frontmatter`, `get_skill_search_roots`, `pick_skill_candidate` |
| `agent/skills_index_delta.py` | 系统提示词索引中途差量 | `index_entries`, `_NOTE_PREFIX`, `_Delta` |
| `agent/background_review.py` | turn 后记忆/技能评审 fork | `_BackgroundReviewRun`, `load_background_review_settings`, `summarize_background_review_actions` |
| `agent/curator.py` | 生命周期策展人 | `should_run_now`, `apply_automatic_transitions`, `run_curator_review`, `maybe_run_curator` |
| `agent/curator_backup.py` | skills 树快照/回滚 | `snapshot_skills`, `rollback_snapshot`, `_EXCLUDE_TOP_LEVEL` |

---

## 与其他模块的关系

- **12_skills/**：SKILL.md frontmatter 规范、`/skills`、hub 安装与信任级——本篇的扫描/门控
  （`skill_matches_*`、`_is_community_hub_skill`）都是那份规范的执行侧。
- **04_tools/**：`tools/skills_tool.py`（`_skill_catalog`/`skill_view`/`_skills_scan_signature`）是
  扫描的数据源；`tools/skill_usage.py`（`.usage.json`：use/view/patch 计数、`last_activity_at`、
  active/stale/archived、pinned）是 curator 状态机的遥测底座；`tools/skill_ledger.py` 是审计账本
  （curator 归档时把 actor 打成 'curator'）；`tools/skill_manager_guards` 的 read-before-write
  标记由两个 fork（curator 与 background_review）显式播种。
- **agent/ 内**：`prompt_cache_boundary.register_stable_prefix` 是 #81867 缓存断点的注册处；
  `delegation_context.delegated_child_subprocess_env` 在内联 shell 子进程里携带/清洗委托标记；
  memory 侧 `MemoryManager._strip_skill_scaffolding` 复用脚手架解析（见 memory_learning.md）。
- **cron/**：`_cron_referenced_skills()` 把 cron 作业引用的技能视同 pinned；整合重写 cron 引用后
  备份负责恢复那两个字段。
- **CLI/网关**：`hermes curator run/--dry-run`、`/reload-skills`、Desktop/TUI 的命令面板都消费
  `published_scopes_signature()` 的作用域签名。

## 总结

技能运行时的主线是"**缓存友好地中途变化**"：技能体骑 user 消息（稳定前缀 + 注册断点），
索引差量骑注记通道，curator 与 background_review 两个后台机都走 fork、不碰主会话。
Curator 的克制值得细读——它把"自动"限定在确定性状态机（无 LLM 也能跑），把 LLM 交互限成
opt-in 的辅助 fork，用"永不删除 + 先快照 + ledger"兜底，再用排除名单把过往事故（820MB 快照、
24GB 膨胀）固化成常量。多槽缓存则是"进程服务多身份"这一现实在技能域的直接投影：
platform、home、project 任一漂移都不能复用别人的扫描结果。
