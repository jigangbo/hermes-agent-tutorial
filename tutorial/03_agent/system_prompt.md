# system_prompt.md — 系统提示词的三层结构与字节稳定不变量

## 文件概览

系统提示词（system prompt）是每次 API 请求的第一条 `role:"system"` 消息。Hermes 对它有
一条近乎宗教的规则（根 AGENTS.md 不变量 #1 的核心）：

> **The system prompt is byte-stable for the life of a conversation; the ONLY context mutation
> is compression.**（系统提示词在整个会话生命周期内字节稳定；唯一的上下文变异是压缩。）

为什么？模型 API 的提示词缓存按**前缀字节**匹配。系统提示词在所有消息的最前面——它变
一个字节，从它开始的整条缓存链全部作废，成本立刻翻几倍。两份文件分工：

| 文件 | 行数 | 角色 |
|---|---|---|
| `agent/system_prompt.py` | 889 | 三层结构的**编排**：stable / context / volatile 各装什么、按什么顺序、何时重建 |
| `agent/prompt_builder.py` | 1,750 | 三层结构的**原料**：身份文本、技能索引渲染、上下文文件发现与截断、环境探测 |

```
                    ┌──────────────────────────────────────────────┐
                    │            一条完整的 system 消息              │
                    │                                            │
   stable 层        │  身份（SOUL.md 或默认身份）                    │  ◄── 最不可能变
   （字节稳定）      │  Hermes 帮助指引 / 通用与工具感知指引            │      整个会话不重建
                    │  钉住的 skills.auto_load 块                    │
                    │  编码姿态 operating brief                      │
                    ├──────────────────────────────────────────────┤
   context 层       │  调用方 system_message                          │  ◄── 项目/工作区相关
                    │  项目上下文文件（AGENTS.md 等，封顶截断）          │      换会话才可能换
                    │  工作区快照（git probe，按会话钉住）              │
                    │  环境探测 / Bot Mode 协议 / 平台提示             │
                    ├──────────────────────────────────────────────┤
   volatile 层      │  技能索引（skills index）                       │  ◄── 最可能变
   （重建时重写）    │  记忆块（memory + USER.md + 外部记忆提供者）      │      放最后，
                    │  插件段落 / 档案行                              │      保住最长公共前缀
                    │  Conversation started: 时间戳行                │
                    │  # Hermes runtime environment 运行时锚          │
                    └──────────────────────────────────────────────┘
```

三层之间用 `\n\n` 连接（模块 docstring，system_prompt.py:1-9：*Three tiers are joined with
``\n\n``*）。顺序 = 缓存经济学：**越稳定的越靠前**，最长的公共前缀（stable）在任何
重建中保持不变，隐式最长前缀缓存就能复用它。

---

## 关键代码走读

### 1. build_system_prompt —— 组装与缓存（system_prompt.py:810）

```python
# agent/system_prompt.py:810-819
def build_system_prompt(agent: Any, system_message: Optional[str] = None) -> str:
    """Assemble the full prompt; cached on ``agent._cached_system_prompt`` and
    only rebuilt after compression.  Tiers are ordered stable -> context ->
    volatile so implicit longest-prefix caches keep the unchanged scaffold."""
    parts = build_system_prompt_parts(agent, system_message=system_message)
    agent._cached_system_prompt_static = parts["stable"]
    # Surface context-file truncation warnings in chat, not only in logs.
    for warning in drain_truncation_warnings():
        agent._emit_diagnostic_status(warning)
    return "\n\n".join(p for p in (parts["stable"], parts["context"], parts["volatile"]) if p)
```

两条关键事实藏在 docstring 与这 10 行里：

1. **缓存位置**：成品存到 `agent._cached_system_prompt`，**只在压缩之后重建**。
   `build_turn_context`（turn_context.py:1302-1305）的调用方式印证了这一点：
   `if agent._cached_system_prompt is None: restore_or_build_system_prompt(...)`——
   已有缓存就直接用，连函数都不进。
2. **stable 层被单独保存**到 `_cached_system_prompt_static`。prompt_cache 的 cache plan
   会用这段字节作为静态前缀标记缓存断点（turn_request_assembly.py:210-222），而
   `reconstruct_static_prefix`（system_prompt.py:843）能在恢复进程/keep-prompt 压缩时从
   持久化的完整提示词中**重建**这一层——条件苛刻：重建出的字节必须恰好是存储提示词的
   前缀（`stored.startswith(static)`，:862），否则 static 置 None、存储字节原样发送。

### 2. build_system_prompt_parts —— 三层的配料单（system_prompt.py:744）

这个 60 多行的函数就是配料单，我们分段看：

**stable 层（:755-777）：**

```python
# agent/system_prompt.py:755-777（节选）
    # ── Stable tier ────────────────────────────────────────────────
    stable_parts, _soul_loaded = _identity_parts(agent, _ctx_len)
    # The skill_view() pointer dangles without skill tools OR without the
    # hermes-agent skill installed, so the variant is chosen after the skills
    # index is built; this slot holds its position.
    _help_guidance_slot = len(stable_parts)
    stable_parts.append(HERMES_AGENT_HELP_GUIDANCE_NO_SKILLS)
    stable_parts.extend(_guidance_parts(agent))
    skills_prompt = _skills_prompt(agent)
    if "skill_view" in (agent.valid_tool_names or set()) and "- hermes-agent:" in skills_prompt:
        stable_parts[_help_guidance_slot] = HERMES_AGENT_HELP_GUIDANCE
    stable_parts.extend(_alibaba_identity_part(agent))
    # Pinned skills are per-agent constants (resolved once), so they live in the stable prefix.
    stable_parts.extend(_auto_load_parts(agent))
    ...
    stable_parts.extend(coding_prefix_parts)
```

细节品味：

- **帮助指引的变体**用"占位后替换"实现（:760-767）：先放 NO_SKILLS 版本占住位置，
  等技能索引渲染完，确认 `skill_view` 工具存在且索引里有 `hermes-agent` 这一条，
  才把占位符换成带 `skill_view` 指引的版本——避免在没有技能工具集的会话里留下一个
  悬空的 `skill_view()` 指引。槽位（slot）保证了两种变体的字节长度差异不影响其他块的位置。
- **钉住的技能**（`skills.auto_load`）解析结果缓存在 agent 上
  （`_auto_load_skills_resolved`，:334-345），配置、技能文件、HERMES_IGNORE_RULES 都
  **只在第一次构建时读**——注释写明这是为了让提示词跨模型切换、压缩、静态前缀恢复
  保持字节稳定。
- **工作区快照按会话钉住**（`_coding_parts`，:674-703）：git probe 的结果若每次重建都
  重新探测，任何仓库变动都会改变提示词字节、挫败 keep-prompt 快速路径。所以快照以
  `(cwd_key, block)` 形式冻结在 agent 上（`agent._frozen_workspace_snapshot`），
  `reset_session_state` 在会话边界丢弃它（run_agent.py:399-401）。恢复的 agent 还能
  `_seed_workspace_pin`（:655-671）从**持久化提示词**里认领已有快照，避免首次重建就
  改写字节。

**context 层（:778-789）：**

```python
# agent/system_prompt.py:778-789（节选）
    # ── Context tier (project/worktree-dependent, may change between sessions) ──
    context_parts: list[str] = []
    # ephemeral_system_prompt is injected at API-call time only, never cached.
    if system_message is not None:
        context_parts.append(system_message)
    context_parts.extend(_context_files_part(agent, _ctx_len, _soul_loaded))
    if coding_workspace_parts:
        context_parts.extend([*coding_workspace_parts, *coding_trailing_parts, *post_workspace_parts])
    else:
        # Preserve the stable placement for non-workspace sessions; ...
        stable_parts.extend([*coding_trailing_parts, *post_workspace_parts])
```

注释解释了为什么环境探测/平台提示在**有工作区快照时**要挪到 context 层：
`Worktree-dependent blocks follow project context so a shared context file can remain in
the longest common prefix across worktrees`（:749-750 docstring）——同一个仓库的不同
工作树共享 AGENTS.md，把"随工作树变化"的块放到项目上下文**之后**，AGENTS.md 就能留在
跨工作树的最长公共前缀里。

**volatile 层（:790-807）：**

```python
# agent/system_prompt.py:790-807（节选）
    # ── Volatile tier (most likely to differ on a rebuild; kept last so the stable prefix stays reusable) ──
    # Skills are runtime-mutable, so the index leads the volatile band: on a longest-prefix
    # backend an unchanged index stays inside the reused prefix; a changed one re-prefills from here.
    volatile_parts: list[str] = [skills_prompt, *_memory_parts(agent)]
    # Plugin sections are confined to one coarse anchor in the volatile tail so
    # a resumed process can reconstruct the stable prefix without re-running plugins.
    volatile_parts.extend(_plugin_section_blocks(_frozen_plugin_prompt_sections(agent), "after_memory"))
    # The profile line names this home's path, so it rides in the volatile tier: the stable
    # prefix then stays byte-identical across every profile (and home) on the host.
    volatile_parts.append(_active_profile_line(agent))
    volatile_parts.append(_timestamp_line(agent))
    ...
    return {"stable": _join_tier(stable_parts), "context": _join_tier(context_parts), "volatile": _join_tier(volatile_parts)}
```

volatile 层装什么、为什么：

| 块 | 内容 | 放 volatile 的理由 |
|---|---|---|
| `skills_prompt` | 技能索引（名称+描述，按类目分节） | 技能是运行时可变的（装/卸/改）；放最前意味着索引没变时它还在被复用的前缀内，变了也只从它开始重预填 |
| `_memory_parts` | 内建 memory 块、USER.md 块、外部记忆提供者块 | 记忆随会话被写入磁盘，重建时要带上新内容 |
| 插件段落 | 插件渲染的提示词段（按会话冻结） | 被限制在 volatile 尾部的一个粗锚点——恢复进程不必重跑插件代码就能重建 stable 前缀 |
| `_active_profile_line` | "Active Hermes profile: X，本会话读写 <home>/" | 行里含 home 的**路径**；放进 volatile 后 stable 前缀在同一台主机的所有 profile/家目录间字节一致（:796-799 注释） |
| `_timestamp_line` | `Conversation started: ...` + 尾行 | 见下节 |
| 运行时环境锚 | `# Hermes runtime environment` 块 | 渲染器所有，放在全部用户/插件散文之后，持久化提示词验证用它定位 |

### 3. _timestamp_line —— 时间戳为什么必须"日期粒度"（system_prompt.py:501）

```python
# agent/system_prompt.py:501-510（节选）
def _timestamp_line(agent: Any) -> str:
    """Date-only so the prompt is byte-stable for the day; zone + offset so
    tools needn't guess EST vs EDT. Long-lived sessions get an "as of" line on
    rebuild days (the cache prefix is already invalidated at that boundary)."""
    ...
    timestamp_line = f"Conversation started: {safe_strftime(_start, '%A, %B %d, %Y')}{_zone_suffix}"
```

时间是天生易变的东西，Hermes 的处理是三层妥协：

1. **只写日期、不写时刻**——同一天内字节稳定（缓存友好），时区缩写 + UTC 偏移保留
   （工具不用猜 EST 还是 EDT，`_zone_bits`，:486-498）；
2. **"Conversation started" 用会话的出生日期**，从 session id 里内嵌的
   `YYYYMMDD_HHMMSS` 戳解析（`_session_start_like`，:182-228）。压缩会轮转 session id，
   每个新 id 有自己的出生时间——所以先沿会话谱系走到**根 id**（`get_conversation_root`），
   拿最初的出生戳。注释（:190-198）写明：Bot Mode 的永续聊天跨过无数次压缩之后，
   仍然知道自己诞生于哪一天。
3. **跨天重建时才加第二行**（:518-520）：`Today's date (as of the last context rebuild)`。
   提示词本来就要在压缩边界重建（缓存已经失效），这时把"今天"钉进来**零额外缓存
   代价**；同天会话完全跳过——单行形状保持字节一致。

### 4. prompt_builder.py —— 原料车间

#### DEFAULT_AGENT_IDENTITY（prompt_builder.py:160）

stable 层的默认身份是一段行为规格而非特质清单：

```python
# agent/prompt_builder.py:160-169（节选）
DEFAULT_AGENT_IDENTITY = (
    # A behavior spec (sizing rule, named prohibitions, earned-depth escape hatch), not a trait list — trait
    # lists change nothing. Maintainer rule: models UNDER-explore by default; never re-add an exploration-thrift line.
    "You are Hermes Agent, built by Nous Research. Be direct: match the length of your reply to the weight of the ask "
    "— a one-line question gets a one-line answer, ... Plain claims over adjectives; when unsure, say so plainly."
)
```

用户若有 `SOUL.md`（HERMES_HOME 下的人格文件），它**顶替**默认身份占住 stable 层的
第一个槽位（`_identity_parts`，system_prompt.py:556-562）。

#### 技能索引：build_skills_system_prompt（prompt_builder.py:1233）

```python
# agent/prompt_builder.py:1233-1244 + 1295-1310（节选）
def build_skills_system_prompt(available_tools=None, available_toolsets=None,
                               compact_categories=None, skills_dir_override=None) -> str:
    """Compact skill index for the system prompt.

    Same-named skills resolve like skill_view: project > local > create_dir > external_dirs, and a
    same-tier duplicate is listed under its exact relative path. ..."""
    ...
def _render_skills_index(skills_by_category, compact_categories, available_tools, unloadable=()) -> str:
    """Render the ## Skills block; "" when there is nothing to list. ..."""
    # Demoted categories collapse to one names-only line. NEVER drop entries — agent-created skills are the
    # model's project memory and it won't rediscover them via skills_list. ...
```

索引有**两级缓存**（进程内 LRU + 磁盘快照，:1072-1082）：快照按 SKILL.md 文件签名
清单（manifest）失效，版本不匹配就重建。渲染规则：同名技能按
project > local > create_dir > external 优先级解析；coding 紧凑模式下非编码类目降级为
"仅名称"行——**绝不删除条目**（agent 创建的技能是它的项目记忆，删了它无法用
skills_list 重新发现）。

#### 上下文文件：build_context_files_prompt（prompt_builder.py:1720）

```python
# agent/prompt_builder.py:1720-1749（节选）
def build_context_files_prompt(cwd=None, skip_soul=False, context_length=None,
                               allow_install_tree_fallback=False, home_override=None) -> str:
    """Discover and load context files for the system prompt (each capped, see ``_get_context_file_max_chars``).

    Only ONE project context type loads, first found wins: .hermes.md/HERMES.md (walk to git root) →
    AGENTS.md chain (git root → cwd) → CLAUDE.md (cwd) → .cursorrules + .cursor/rules/*.mdc (cwd). SOUL.md
    from HERMES_HOME is independent and always included unless *skip_soul* (already the identity slot)."""
    sections = [_load_hermes_md(cwd_path, context_length) or _load_agents_md(cwd_path, context_length)
                or _load_claude_md(cwd_path, context_length) or _load_cursorrules(cwd_path, context_length)]
    if not skip_soul:
        sections.append(load_soul_md(context_length, home_override=home_override))
    return ("# Project Context\n\n..." + "\n".join(sections))
```

要点：**只加载一种**项目上下文类型（先到先得）；AGENTS.md 沿 git 根 → cwd 的目录链
逐级拼接、去重后再整体封顶（`_load_agents_md`，:1676-1697，防止深 monorepo 把预算
乘起来）；每个文件封顶由 `_get_context_file_max_chars`（:1051）决定——显式配置
`context_file_max_chars` 优先，否则按模型窗口的 6% 动态计算，夹在 [20K 下限, 500K 上限]
之间。截断保留头 70% 尾 20%，中间省略的标题列表附在后面让模型知道丢了什么。

安全闸门 `_scan_context_content`（:84-110）：项目目录里的 AGENTS.md/.cursorrules 要过
注入模式扫描，命中即**整体拦截**（渲染成 `[BLOCKED: ...]` 占位，内容不进提示词）；
而用户自己 HERMES_HOME 里的 SOUL.md 属于"用户创作"信任级，命中只警告、照常加载。
读取本身有超时保护 `_read_text_with_timeout`（:53-81）：daemon 线程上 5 秒读不完就放弃
——网络盘（iCloud Drive/OneDrive/NFS）可能把被逐出的文件"按需调入"并无限期阻塞，
没有这道闸，冷启动的系统提示词组装会直接卡死。

#### build_environment_hints —— volatile 层的运行时锚（prompt_builder.py:1014）

```python
# agent/prompt_builder.py:1014-1031（节选）
def build_environment_hints() -> str:
    """Execution-environment block: local backends get host OS/home/cwd; remote/sandbox
    backends get ONLY the backend's own state (the agent's tools cannot touch the host)."""
    backend = (_tenv_read("TERMINAL_ENV") or "local").strip().lower()
    is_remote_backend = backend in _REMOTE_TERMINAL_BACKENDS or _plugin_backend_is_remote(backend)
    hints = [_remote_backend_hint(backend)] if is_remote_backend else _local_host_hints()
    ...
    return "\n\n".join(h for h in (*hints, _embedder_environment_hint()) if h)

RUNTIME_ENVIRONMENT_HEADING = "# Hermes runtime environment"
RUNTIME_ENVIRONMENT_END = "<!-- End Hermes runtime environment -->"
```

本地后端拿到主机 OS/home/cwd；docker/modal/ssh 等远程沙箱后端**只**拿沙箱自己的状态
（agent 的工具摸不到宿主机，告诉它宿主机路径只会诱导幻觉）。这个块由专门的
heading + HTML 注释 end 标记包住——`reconstruct_static_prefix` 验证持久化提示词、
`_persisted_workspace_block` 定位快照时都靠这两个锚点。

### 5. invalidate_system_prompt —— 唯一的合法缓存破坏（system_prompt.py:822）

```python
# agent/system_prompt.py:822-840（节选）
def invalidate_system_prompt(agent: Any) -> None:
    """Force a rebuild on the next turn (after compression): reload memory from
    disk and clear the frozen plugin snapshot (previous bytes stashed as the
    fail-open fallback) so plugins re-render at the same boundary.

    Called after context compression events. ... The previous bytes are stashed so a plugin
    whose render RAISES falls back to its last good section instead of vanishing (fail-open
    guard, not a freeze)."""
    agent._cached_system_prompt = None
    agent._cached_system_prompt_static = None
    ...
    if agent._memory_store:
        agent._memory_store.load_from_disk()
```

**只有上下文压缩事件会调用它**。它是缓存不变量中那句"唯一的变异是压缩"的执行者：
清缓存 → 记忆从磁盘重载（重建的提示词要包含本会话写入的记忆）→ 插件快照清空
（上一份字节留作兜底——插件渲染若抛异常，回退到上次的段落而不是凭空消失）。
下一轮 `build_turn_context` 发现 `_cached_system_prompt is None`，重建一次，
然后再次冻结到下一次压缩边界。

```
   会话生命周期内的系统提示词：

   build ──► 字节冻结 ──► 每轮 API 重放同一份字节 ──► [压缩边界 invalidate]
                ▲                                          │
                └──────────── 重建一次，再次冻结 ◄──────────┘

   中途想注入新内容？走用户消息或工具结果（api_content sidecar），
   绝不碰系统提示词 —— agent/AGENTS.md 不变量 #1。
```

---

## 核心类/函数

| 符号 | 职责 | 位置 |
|---|---|---|
| `build_system_prompt` | 组装三层并缓存到 `_cached_system_prompt`（仅压缩后重建） | `agent/system_prompt.py:810` |
| `build_system_prompt_parts` | 三层配料单：stable/context/volatile 各装什么、顺序 | `agent/system_prompt.py:744` |
| `invalidate_system_prompt` | 压缩边界唯一合法的缓存破坏 + 记忆重载 + 插件快照兜底 | `agent/system_prompt.py:822` |
| `reconstruct_static_prefix` | 从持久化提示词重建 stable 层（必须逐字节为前缀才采纳） | `agent/system_prompt.py:843` |
| `_timestamp_line` | 日期粒度时间戳行（跨天重建加 "as of" 行） | `agent/system_prompt.py:501` |
| `_session_start_like` | 沿谱系根取会话出生日期（跨压缩轮转保持字节稳定） | `agent/system_prompt.py:182` |
| `_coding_parts` | 工作区快照的按会话冻结（`_frozen_workspace_snapshot`） | `agent/system_prompt.py:674` |
| `_memory_parts` | memory / USER.md / 外部记忆提供者块 | `agent/system_prompt.py:528` |
| `_join_tier` | 层内用 `\n\n` 连接非空块 | `agent/system_prompt.py:739` |
| `build_skills_system_prompt` | 技能索引渲染（两级缓存；同名技能按层优先级解析） | `agent/prompt_builder.py:1233` |
| `build_context_files_prompt` | 项目上下文发现与加载（四类文件先到先得，封顶截断） | `agent/prompt_builder.py:1720` |
| `build_environment_hints` | 运行时环境锚（本地/沙箱分支 + WSL + 嵌入器提示） | `agent/prompt_builder.py:1014` |
| `_scan_context_content` | 项目上下文文件的注入扫描（命中拦截；用户 SOUL.md 只警告） | `agent/prompt_builder.py:84` |
| `_read_text_with_timeout` | 上下文文件 5 秒超时读取（防网络盘卡死） | `agent/prompt_builder.py:53` |
| `_get_context_file_max_chars` | 截断上限（配置优先，否则窗口 6%，[20K, 500K] 夹取） | `agent/prompt_builder.py:1051` |
| `_truncate_content` | 头 70% + 尾 20% 截断，省略标题列表 | `agent/prompt_builder.py:1462` |

## 本组文件清单

| 文件 | 一句话角色 |
|---|---|
| `agent/system_prompt.py` | 系统提示词编排：三层结构、按会话缓存、仅压缩边界重建、静态前缀重建 |
| `agent/prompt_builder.py` | 提示词原料：默认身份、技能索引、上下文文件发现/截断/安全扫描、环境锚 |

## 与其他模块的关系

```
build_turn_context (turn_context.py)
    └─ restore_or_build_system_prompt (conversation_loop.py:802)
          ├─ agent._cached_system_prompt 有缓存 → 直接复用（预热 agent 的 /sessions refresh-prompts 走 prompt_refresh.py）
          └─ 无缓存 → build_system_prompt (system_prompt.py:810)
                ├─ stable: _identity_parts / _guidance_parts / _coding_parts
                │          └─ prompt_builder.load_soul_md / 常量 / coding_context
                ├─ context: _context_files_part ──► prompt_builder.build_context_files_prompt
                └─ volatile: _skills_prompt ──► prompt_builder.build_skills_system_prompt
                             _memory_parts / _timestamp_line / build_environment_hints

成品字节 ──► agent._cached_system_prompt（会话内冻结）
         └─► build_api_messages (turn_context.py:1523-1530)：作为 role:"system" 行
             放进每次请求的 api_messages 头部 + ephemeral_system_prompt 只在 API 时附加
```

- **缓存的消费端**是 `prompt_caching.py` 的 `build_prompt_cache_plan`：`_cached_system_prompt_static`
  作为静态前缀参与缓存断点标记（turn_request_assembly.py:210-222）。
- **压缩的触发端**是 `context_compressor.py` / `conversation_compression.py`（compression
  专文）：压缩完成后调 `invalidate_system_prompt`，下一轮重建——这是全项目唯一会
  改变系统提示词的事件。
- **安全**：SOUL.md 的写入受 `tools/file_tools_write_guards.py` 的受保护指令审批门约束
  （prompt_builder.py:84-98 注释）；上下文文件的注入扫描只挡"仓库带来的文件"，
  用户自己的人格文件只警告。

## 总结

- **三层结构 stable → context → volatile**，用 `\n\n` 连接：越稳定的越靠前，
  隐式最长前缀缓存吃掉整个 stable 段。
- **stable 层为什么必须字节稳定**：它在所有消息的最前面，变一个字节 = 全链缓存作废；
  所以身份、指引、钉住的技能、编码姿态 brief 全部"每 agent 解析一次、永久冻结"，
  就连工作区 git 快照、帮助指引的变体、profile 行的摆放位置都是围绕这一点的精心设计。
- **volatile 层装"注定要变的"**：技能索引（运行时可变）、记忆/USER.md、插件段落
  （冻结在粗锚点）、profile 行（含路径）、日期粒度的时间戳。它们排在末尾，
  变化只作废自己之后的部分。
- **时间戳的缓存经济学**：只写日期（当天字节稳定）、出生日期取自谱系根 session id
  （跨压缩轮转不漂移）、跨天只在重建边界加 "as of" 行（那时缓存本来就已经失效）。
- **唯一的合法变异是压缩**：`invalidate_system_prompt` 是全项目唯一清空提示词缓存的
  函数，压缩边界处记忆重载、插件重渲染（带失败兜底）；其余一切中途注入走用户消息或
  工具结果，永不碰系统提示词。
