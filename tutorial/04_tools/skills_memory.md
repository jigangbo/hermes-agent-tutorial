# 技能/记忆/澄清/Todo 工具组 —— 渐进披露与持久记忆

## 文件概览

这组工具回答「agent 怎么带着经验工作」。技能侧（约 30 个文件）：`skills_tool.py` 提供 `skills_list`/`skill_view`/`skill_manage`——**渐进披露**是关键设计，列表只给名字和描述，全文按需再取；`skills_hub*.py` 十个文件是从 ClawHub、GitHub、skills.sh 等来源发现/安装技能的商城层，`skills_guard.py`/`skills_ast_audit.py`/`skillevaluator_scan.py` 是安装前的三道安检。记忆侧：`memory_tool.py` 的 `memory` 工具维护 MEMORY.md（agent 笔记）与 USER.md（用户档案），**会话开始时冻结进系统提示，会话中写盘但不改提示**（保住前缀缓存）。`session_search_tool.py` 提供 `session_search`，`clarify_tool.py` 提供 `clarify`（向用户提结构化问题），`todo_tool.py` 提供 `todo_list`。注意：这四个工具（加 delegate_task）都在 `_AGENT_LOOP_TOOLS` 拦截名单里。

## 关键代码走读

### 1. skills_tool.py：渐进披露与发现缓存

一个技能是含 SKILL.md（YAML frontmatter + 指令）的目录加可选的 references/、templates/、assets/、scripts/。`skills_list` 刻意只返回 name/description——模型先看目录，需要哪份再 `skill_view` 全文，避免把几十个技能全文塞进上下文：

```python
# 来源：tools/skills_tool.py:1-5
#!/usr/bin/env python3
"""Skills Tool — list and view skill documents (progressive disclosure). A skill is a directory
holding SKILL.md (YAML frontmatter + instructions) plus optional references/, templates/, assets/,
scripts/. `skills_list` returns name/description only; `skill_view` returns full content and
linked files. Sibling modules (skills_tool_setup / _plugin / _dedup) re-export here."""
```

列表有 30 秒 TTL 的发现缓存，失效判定靠一棵**目录树签名**：每个目录记 `(路径, mtime_ns, 子目录名列表)`，深度封顶 6。记子目录名而不只是 mtime 是有原因的——某些文件系统 mtime 粒度 1-2 秒，一次安装紧跟一次卸载可能让所有 mtime 相同，子目录名一变就能看出端倪：

```python
# 来源：tools/skills_tool.py:49-74（节选）
def _dir_tree_signature(root, sig, depth=_SIGNATURE_MAX_DEPTH) -> None:
    """Append ``(dir, mtime_ns, child dir names)`` for *root* and the dirs below it the catalog walks
    (``iter_skill_index_files``: no excluded dirs, no support dirs of a skill), depth-bounded. The child
    names, not only mtimes: an install and an uninstall inside one coarse mtime tick (1-2 s on some
    filesystems) leave every mtime equal, and the change must still show. ~1 ms for 170 dirs."""
    from agent.skill_utils import EXCLUDED_SKILL_DIRS, SKILL_SUPPORT_DIRS
    try:
        mtime = os.stat(root).st_mtime_ns
        with os.scandir(root) as it:
            entries = list(it)
    except OSError:
        return
    names, is_skill = [], False
    for entry in entries:
        with suppress(OSError):
            if entry.is_dir():
                names.append(entry.name)
            elif entry.name == "SKILL.md":
                is_skill = True
```

技能目录在**调用时**按 profile 解析（`_skills_dir()`，`skills_tool.py:93`）：import 时的 `SKILLS_DIR` 只是初始值，长活网关可能先 import 后切 profile——这是根 AGENTS.md「状态文件用 `get_hermes_home()` 在调用时取」规则的标准实现。

### 2. 安全三闸：guard、AST 审计、SkillEvaluator

外部来源的技能是不可信代码。安装走三层：`skills_guard.py` 的正则静态扫描 + 信任感知安装策略（每个发现都带上下文降级判定，见 `plugin_guard_context.py` 的姊妹版）；`skills_ast_audit.py` 的 AST 级深审（opt-in，`hermes skills audit --deep`）；`skillevaluator_scan.py` 的 NVIDIA SkillEvaluator Tier 1 咨询性扫描——docstring 强调 alongside, never instead of（叠加而非替代）。写侧还有 `skill_manager_guards.py` 的写/删守卫（每个守卫 None=放行）与 `skill_lock.py` 的用户锁（每次 agent 写路径都强制执行）、`skill_ledger.py` 的变更台账（支持单编辑回滚）、`skill_provenance.py` 的写来源 ContextVar（区分后台评审写与前台风写）。

### 3. skills_hub：商城层

`skills_hub.py` 是门面（hub 状态 + 来源适配器公共入口），八个来源兄弟各接一个渠道：`_official`（仓库自带可选技能 + 官方索引）、`_github`（API 认证 + tap providers + Contents/Trees）、`_clawhub`（clawhub.ai HTTP API）、`_skillssh`（skills.sh 目录发现，内容走 GitHub）、`_sources`（知名端点、直链 URL、LobeHub、browse.sh）、`_search`（中心索引抓取，缓存 + 过期兜底）、`_models`（数据模型与路径校验，叶子模块）、`_install`（安装/卸载/更新：**隔离区 staging**、安装后检查）。`skills_sync.py` 管捆绑技能的种子与更新（repo skills/ → 用户目录），`_bundled_ops`/`_optional` 处理重置/diff/退出与官方可选技能的溯源。

### 4. memory_tool.py：冻结快照原则

`memory` 工具的操作是 add/patch/remove 或批量 `operations`。它的 docstring 最大的价值是那个**大写 FROZEN** 的承诺：

```python
# 来源：tools/memory_tool.py:1-4
#!/usr/bin/env python3
"""Memory Tool - persistent curated memory (MEMORY.md = agent notes, USER.md = user
profile). Both enter the system prompt as a FROZEN snapshot at session start;
mid-session writes hit disk but never change the prompt (prefix cache intact).
Single `memory` tool: add/patch/remove or a batch `operations` list."""
```

这是根 AGENTS.md「每会话提示缓存神圣」不变量在工具侧的直接体现：会话中途写记忆只落盘，下一场会话才出现在提示里——绝不为「让模型马上看到自己刚写的记忆」而重建系统提示。存储在 `memory_tool_store.py` 的 `MemoryStore`：有界（`memory_char_limit` 默认 2200 / `user_char_limit` 默认 1375）、文件备份、文件锁（Unix fcntl / Windows msvcrt）。工具的可用性 check_fn 标了 `no_cache_check_fn`（本地配置型探测不进 TTL 缓存），而且**一次 schema 构建只用一个配置决定**——check_fn 的结果通过 ContextVar 传递给紧随其后的 `dynamic_schema_overrides`，并发构建各拿各的：

```python
# 来源：tools/memory_tool.py:30-32
# One tool-definition pass must use ONE config decision for availability and the
# dynamic target schema: the check_fn result flows to the immediately following
# dynamic_schema_overrides call; ContextVar isolates concurrent profile builds.
_memory_surface_flags: ContextVar[Optional[tuple[bool, bool]]] = ContextVar("memory_surface_flags", default=None)
```

### 5. session_search_tool.py：召回盲治

长期对话检索有四种形态，参数自动推断：DISCOVERY（`query`，FTS5 去重 + 自适应细节）、SCROLL（`session_id` + `around_message_id`，锚点前后窗口）、READ（`session_id`，整场或头尾）、BROWSE（无参）。它从不调 LLM，全部返回真实 DB 消息。两个有意思的策展决定：kanban/subagent/tool 来源的会话**隐藏**（不是用户的对话史）；cron 来源的会话**降级不排除**——cron 词汇量大会在裸 BM25 里淹没用户自己的会话（"recall blindness"），降级让交互会话总是优先：

```python
# 来源：tools/session_search_tool.py:19-29
# Hidden from browsing/searching — integrations (HERMES_SESSION_SOURCE=tool), delegate
# subagent runs, kanban workers are not the user's history.
_HIDDEN_SESSION_SOURCES = ("kanban", "subagent", "tool")
# Searchable but DEMOTED below interactive sessions: cron vocabulary dominates bare
# BM25 and starves out the user's own sessions ("recall blindness").
...
_DEMOTED_SESSION_SOURCES = ("cron",)
```

读形态还有每条消息 2000 字符的内容上限（`_READ_MAX_CONTENT`）——历史教训是一条 74K 字符的归档工具结果原样回流，把一个请求从 ~50K 打到 ~89K token。

### 6. clarify 与 todo

`clarify_tool.py` 的 `clarify` 是结构化提问：多选题/开放题、选项带标签和描述，在终端直接呈现，在网关走 `clarify_gateway.py` 的阻塞事件队列（agent 跑在 worker 上），批量场景的终局在 `clarify_batch.py`。`todo_tool.py` 的 `todo_list` 是内存中的**修订版**任务列表（状态带 revision，防并发写覆盖），状态挂在 agent 会话上而非磁盘。

## 核心类/函数

| 符号 | 职责 | 位置 |
|---|---|---|
| `skills_list` / `skill_view` / `skill_manage` | 渐进披露三工具（列表/全文/增删改） | `tools/skills_tool.py` |
| `_dir_tree_signature` | 目录树签名：mtime + 子目录名，防粗粒度 mtime 漏检 | `tools/skills_tool.py:49` |
| `_skills_dir` | 调用时的 profile 技能目录解析 | `tools/skills_tool.py:93` |
| `dedup_skill_view`（skills_tool_dedup） | 同一技能文件的重复查看去重（按 task） | `tools/skills_tool_dedup.py` |
| `scan_skill`（skills_guard） | 外源技能的正则静态扫描 + 信任策略 | `tools/skills_guard.py` |
| `MemoryStore` | 有界、文件备份的 MEMORY.md/USER.md 存储（带文件锁） | `tools/memory_tool_store.py` |
| `memory`（注册名） | 记忆工具：add/patch/remove/batch，写盘不改当前提示 | `tools/memory_tool.py` |
| `_memory_surface_flags`（ContextVar） | 一次 schema 构建共用一个配置决定 | `tools/memory_tool.py:32` |
| `session_search`（注册名） | 四形态会话检索（DISCOVERY/SCROLL/READ/BROWSE） | `tools/session_search_tool.py` |
| `clarify`（注册名） | 结构化多选/开放提问 | `tools/clarify_tool.py` |
| `todo_list`（注册名） | 修订版内存任务列表 | `tools/todo_tool.py` |
| `Memory`（skills_hub_install） | 安装管线：隔离区 staging + 安装后检查 | `tools/skills_hub_install.py` |

## 本组文件清单

技能/记忆/澄清/Todo 组共 34 个文件：

| 文件 | 一句话角色 |
|---|---|
| `tools/skills_tool.py` | skills 三工具门面：渐进披露与发现缓存。 |
| `tools/skills_tool_dedup.py` | skill_view 的按 task 重复查看去重。 |
| `tools/skills_tool_plugin.py` | 插件技能服务（`plugin:skill` 名字）+ JSON/截断助手。 |
| `tools/skills_tool_setup.py` | 技能就绪：必需环境变量、密钥补采、安装说明。 |
| `tools/skill_manager_tool.py` | `skill_manage` 工具：agent 自管的技能创建/编辑。 |
| `tools/skill_manager_batch.py` | skill_manage 的原子多操作批量路径。 |
| `tools/skill_manager_guards.py` | 写/删守卫（None=放行）。 |
| `tools/skill_ledger.py` | 每次变更的审计台账 + 单编辑回滚。 |
| `tools/skill_linter.py` | SKILL.md 的结构/惯例 linter。 |
| `tools/skill_lock.py` | 用户技能锁：每次 agent 写路径强制执行。 |
| `tools/skill_provenance.py` | 技能写来源 ContextVar（后台评审 vs 前台）。 |
| `tools/skill_usage.py` | 技能使用遥测：`.usage.json` 侧车，喂给 Curator。 |
| `tools/skills_guard.py` | 外源技能正则静态扫描 + 信任感知安装策略。 |
| `tools/skills_ast_audit.py` | 技能 Python 文件的 AST 深审（opt-in 诊断）。 |
| `tools/skillevaluator_scan.py` | NVIDIA SkillEvaluator Tier 1 咨询性扫描。 |
| `tools/skills_hub.py` | Hub 门面：状态管理与来源适配器公共入口。 |
| `tools/skills_hub_clawhub.py` | ClawHub 适配器。 |
| `tools/skills_hub_github.py` | GitHub 适配器：认证、tap、Contents/Trees。 |
| `tools/skills_hub_install.py` | 安装/卸载/更新：隔离区 staging 与安装后检查。 |
| `tools/skills_hub_models.py` | Hub 数据模型、路径校验、SKILL.md 助手（叶子模块）。 |
| `tools/skills_hub_official.py` | 官方来源：仓库可选技能 + 中心索引。 |
| `tools/skills_hub_search.py` | 中心 Hermes 索引抓取（缓存、过期兜底）。 |
| `tools/skills_hub_skillssh.py` | skills.sh 适配器：目录走 skills.sh，内容走 GitHub。 |
| `tools/skills_hub_sources.py` | 知名端点/直链/LobeHub/browse.sh 适配器。 |
| `tools/skills_sync.py` | 捆绑技能种子与更新（repo → 用户目录）。 |
| `tools/skills_sync_bundled_ops.py` | 捆绑技能维护：重置、diff、退出、删原件。 |
| `tools/skills_sync_optional.py` | 官方可选技能溯源：hub-lock 回填与恢复（profile 作用域）。 |
| `tools/memory_tool.py` | `memory` 工具：冻结快照原则下的持久记忆。 |
| `tools/memory_tool_store.py` | MemoryStore：有界文件存储（fcntl/msvcrt 锁）。 |
| `tools/session_search_tool.py` | 会话检索：四形态、来源隐藏/降级策展。 |
| `tools/clarify_tool.py` | `clarify`：结构化提问工具。 |
| `tools/clarify_batch.py` | 批量 clarify 的终局（各登记表共用）。 |
| `tools/clarify_gateway.py` | 网关侧 clarify 原语（阻塞事件队列）。 |
| `tools/todo_tool.py` | `todo_list`：修订版内存任务列表。 |

## 与其他模块的关系

- `agent/`：四个工具在 `_AGENT_LOOP_TOOLS` 拦截名单里（`agent/inline_tool_executors.py` 直接执行）；`agent/curator*.py` 的策展人消费 `skill_usage` 的遥测；`agent/skill_utils.py` 提供目录遍历与排除规则。
- `tools/approval.py` / `write_approval.py`：记忆与技能写受写审批门（`memory_tool` 的 `load_on_disk_store` 保证网关侧审批用与 agent 相同的上限）。
- `tools/threat_patterns.py`：memory/skills 内容扫描用 strict 作用域。
- `gateway/`：clarify 在网关上走阻塞事件队列；voice/桌面各 surface 复用同一 `clarify` 工具。
- `cron/`：技能相关定时任务（如 Curator 跑批）复用 ledger/provenance 保证可回滚。

## 总结

这一组的核心思想是**注意力经济学**。技能侧：列表只给目录，全文按需加载，重复查看去重，外源技能过三道安检才落地——模型永远只背负它此刻需要的知识。记忆侧：MEMORY.md/USER.md 有字符上限、会话头冻结快照，写出即持久但绝不炸缓存前缀——「下一场会话再见」比「现在马上看到」更值钱。检索侧：四形态复用一个工具，cron 降级治召回盲、子代理会话藏起来不搅浑历史。三个 ContextVar/签名级的小机关（memory_surface_flags、目录树签名、读内容上限）则示范了并发正确性与成本防线怎么藏在看似普通的工具里。
