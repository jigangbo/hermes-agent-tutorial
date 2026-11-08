# 技能格式与加载机器 —— SKILL.md、编写标准与渐进披露

## 文件概览

本篇讲技能的**格式契约**（frontmatter 字段、目录布局）与**加载机器**（`tools/skills_tool.py` 的发现缓存、`agent/skill_commands.py` 的 slash 注册、`agent/skill_preprocessing.py` 的预处理），以及 CI 强制的编写硬标准。一个技能 = 一个目录，里面必有 `SKILL.md`（YAML frontmatter + Markdown 指令），可选 `references/`（参考文档）、`templates/`（模板）、`assets/`（资源）、`scripts/`（helper 脚本）。

## 关键代码走读

### frontmatter 实例与字段表

```yaml
# skills/software-development/github/SKILL.md:1-11
---
name: github
description: "GitHub via gh CLI: PRs, issues, reviews, repos, auth."
version: 2.0.0
author: Ben Barclay (benbarclay), Hermes Agent
license: MIT
platforms: [linux, macos, windows]
metadata:
  hermes:
    tags: [github, gh, git, pull-requests, issues, code-review, repos, auth, ci]
    category: software-development
    related_skills: [codebase-inspection, requesting-code-review]
---
```

| 字段 | 必需 | 语义 |
|---|---|---|
| `name` | 是 | 加载名；`skill_view(name)` 接受 frontmatter 名（也接受目录名，递归兼容） |
| `description` | **强制** | ≤60 字符、一句话、以句号结尾；技能索引只显示到这里 |
| `version` / `author` / `license` | 否 | 人类作者优先（「Hermes Agent」排第二） |
| `platforms` | 否 | OS 门：`[macos]`、`[linux, macos]`…；编写标准要求它与脚本实际 import 对账 |
| `metadata.hermes.tags` / `category` / `related_skills` | 否 | 索引展示与关联；顶层 `tags:`/`category:` 被加载器镜像接受 |
| `metadata.hermes.config` | 否 | 技能需要的 config.yaml 设置：setup 时提示、加载时注入，存于 `skills.config.<key>` |
| `prerequisites.commands` | 否 | 前置命令检查（setup note） |

### 发现：签名 + TTL 的每会话缓存

```python
# tools/skills_tool.py:33-40
# Per-session discovery cache: {cache_key: (signature, timestamp, skills_list)}. Signature =
# every catalog directory's mtime and child-dir names, walked like the catalog itself (an install
# under an existing category such as ``mlops/training/`` moves only that dir's mtime) + the disabled
# set (config-only change, no mtime) + platform; the TTL bounds staleness from in-place SKILL.md
# edits, which no directory signature can see.
_SKILLS_CACHE: dict = {}
_SKILLS_CACHE_TTL_SECONDS = 30.0
# Deepest directory the signature descends to below a root (a skill sits at <cat>/<sub>/<skill>/).
_SIGNATURE_MAX_DEPTH = 6
```

扫描本身很便宜（`_dir_tree_signature` 约 1ms/170 目录），但「目录签名」有一个盲区：**原地编辑 SKILL.md 不动 mtime 目录**——TTL 就是给这个盲区兜底的。缓存键分 `filtered`/`with_disabled`（配置 UI 需要看禁用项）与 `include_hidden`；命中时返回**浅拷贝**——调用者会改写返回的 dict（web_server 注注 `enabled`/`usage`），把缓存对象递出去会毒化缓存。缓存的签名在扫描**前**计算：一个与扫描竞争的写入改变签名，下一次调用重新扫而不是端出撕裂结果。

### 渐进披露的两个工具

```python
# tools/skills_tool.py:753-755
registry.register(
    name="skills_list", toolset="skills", schema=SKILLS_LIST_SCHEMA,
    handler=lambda args, **kw: skills_list(category=args.get("category"), task_id=kw.get("task_id")),
)
```

`skills_list` 的 schema 描述就是教学文案：「List available skills (name + description). Use skill_view(name) to load full content.」——模型读完列表自然会调 `skill_view`。`skill_view` 的 handler 是 `_skill_view_with_bump`（行 758）：成功视图顺手把 `use_count`/`view_count` 遥测 +1（best-effort），重复视图经 `dedup_skill_view` 去重——一个 stub 防止同一文件被反复全量注入。**技能列表工具上禁用 `offset`/`limit` 分页**（skills/AGENTS.md）：agent 必须完整读一个技能。

### 每个技能一个 slash 命令

```python
# agent/skill_commands.py:15-23
# Multi-slot skill-command cache keyed by the full resolved identity
# (_resolve_skill_commands_platform(), _resolve_skill_commands_home(),
# _resolve_skill_commands_project()). The previous single-slot memo held ONE
# (platform, home, project) triple; a Desktop serve process whose identity
# flaps across requests (profile-home overrides, per-session project roots)
# missed on every poll and rescanned the whole skills dir ~3x/5s, re-logging
# the collision warnings each time (#104849). Each distinct identity is
# scanned once and memoized; reload_skills() clears every slot.
_skill_commands_by_key: dict[tuple, dict[str, dict[str, Any]]] = {}
```

旧的单槽 memo 只记一个 `(platform, home, project)` 三元组，Desktop serve 进程的身份在请求间抖动时每次轮询都 miss、每 5 秒重扫三遍技能目录。多槽缓存按完整身份分键。技能名转命令名的清洗也值得注意：`\w` 保留 Unicode 字母（CJK、西里尔），`name: 小说拆条` 的技能注册成 `/小说拆条` 而不是被 slug 成空串丢弃（#12351）；Telegram 的 `[a-z0-9_]` 菜单限制由平台层另管。`/skill` turn 会被展开成嵌入技能全文的模型消息，所以有成对的脚手架标记（`_SKILL_INVOCATION_PREFIX` 等）让 `extract_user_instruction_from_skill_message` 能把「用户到底问了什么」从消息里还原出来——否则记忆提供者会把技能正文当成用户发言存档。

### 预处理：模板令牌与内联 shell

```python
# agent/skill_preprocessing.py:15-21
# ${HERMES_SKILL_DIR} / ${HERMES_SESSION_ID} tokens. Unresolvable ones (e.g. no
# session) are left as-is so the author can spot them.
_SKILL_TEMPLATE_RE = re.compile(r"\$\{(HERMES_SKILL_DIR|HERMES_SESSION_ID)\}")
# Inline shell snippets like !`date +%Y-%m-%d` — single-line only.
_INLINE_SHELL_RE = re.compile(r"!`([^`\n]+)`")
# Cap inline-shell output so a runaway command can't blow out the context.
_INLINE_SHELL_MAX_OUTPUT = 4000
```

两个令牌族：`${HERMES_SKILL_DIR}`/`${HERMES_SESSION_ID}`（解析不了的原样保留，作者看得见）；`!`cmd``（单行、输出封顶 4000 字符、失败返回 `[inline-shell ...]` 标记而不抛异常——一个坏片段不许毁掉整条技能消息）。内联 shell 默认**关闭**（`cfg.get("inline_shell", False)`），开启时还有一道信任闸：

```python
# agent/skill_preprocessing.py:154-155
    if cfg.get("inline_shell", False) and not _is_community_hub_skill(skill_dir):
        content = expand_inline_shell(content, skill_dir, int(cfg.get("inline_shell_timeout", 10) or 10))
```

`_is_community_hub_skill`（行 99-139）查 hub 的 `.hub/lock.json`：`--force` 装进来的 community 信任级技能不许在「查看」时自动执行 shell——那正是安装门当初拒绝的东西（#63307）；锁读不出来时对它树下的技能**失败关闭**。

### 编写硬标准（CI 强制）

`tests/skills/test_authoring_standards.py` 强制全部新/现代化技能（内置、可选、贡献）满足：description ≤60 字符一句（禁营销词、不复述名字/类别）；prose 引用原生 Hermes 工具或 MCP 时用反引号，且**不许点名 agent 已包装的 shell 工具**（`grep`→`search_files`、`cat`→`read_file`、`sed/awk`→`patch`）；`platforms:` 门与脚本实际 import 对账（POSIX-only 原语必须先试着跨平台化）；author 人类在前；现代章节顺序（When to Use / Prerequisites / How to Run / Quick Reference / Procedure / Pitfalls / Verification，复杂技能 ~200 行）；helper 逻辑进 `scripts/` 而不是让模型每次现写解析器；测试在 `tests/skills/test_<skill>_skill.py`（stdlib + pytest + mock，无真实网络）。

## 核心类/函数

| 符号 | 位置 | 职责 |
|---|---|---|
| `skills_list()` | `tools/skills_tool.py:290` | 渐进披露第一级（名字+描述） |
| `skill_view()` | `tools/skills_tool.py:613` | 全文 + 链接文件（第二级） |
| `_skill_view_with_bump()` | `tools/skills_tool.py:758` | 视图遥测 + 去重 stub |
| `_skill_catalog()` | `tools/skills_tool.py:230` 附近 | 扫描 + 缓存（签名前置） |
| `_dir_tree_signature()` | `tools/skills_tool.py:53` | 深度有界的目录签名 |
| `clear_skills_cache()` | `tools/skills_tool.py:44` | 显式 reload 不等 TTL |
| `skill_search_dirs()` | `tools/skills_tool.py:219` | `(tier, dir)` 优先序 + 活动 skills 目录 |
| `find_all_skills()` | `tools/skills_tool.py:287` | 可加载技能（含遮蔽判定） |
| `skill_matches_platform/environment/apps` | skills_tool 家族 | frontmatter 三个可见性门 |
| `register_stable_prefix()` / 清洗正则 | `agent/skill_commands.py` | slash 注册 + Unicode 名保留 |
| `extract_user_instruction_from_skill_message()` | `agent/skill_commands.py` | 从脚手架消息还原用户指令 |
| `substitute_template_vars()` | `agent/skill_preprocessing.py:36` | `${HERMES_*}` 展开 |
| `run_inline_shell()` / `expand_inline_shell()` | `agent/skill_preprocessing.py:47/89` | 内联 shell（4000 字符上限） |
| `_is_community_hub_skill()` | `agent/skill_preprocessing.py:99` | community 信任级禁自动执行 |
| `preprocess_skill_content()` | `agent/skill_preprocessing.py:142` | 预处理总入口（配置驱动） |
| `get_skill_search_roots()` | `agent/skill_utils.py:413` | 四级优先序的唯一权威 |

## 本组文件清单

| 文件 | 角色 | 关键符号 |
|---|---|---|
| `skills/<category>/<skill>/SKILL.md` ×44 | 内置技能（12 类） | 见 `index.md` 名单 |
| `optional-skills/<category>/<skill>/SKILL.md` ×141 | 可选技能（23 类，未激活） | 官方源安装 |
| `skills/index-cache/` | 索引缓存工作区 | 非技能 |
| `optional-skills/DESCRIPTION.md` | 可选表面说明 | 文档 |
| `tools/skills_tool.py` | 渐进披露两工具 + 发现缓存 | `skills_list`, `skill_view` |
| `tools/skills_tool_setup.py` | setup note / 环境变量捕获 | `SkillReadinessStatus` |
| `tools/skills_tool_plugin.py` | 插件技能服务 + 解析/截断助手 | `MAX_DESCRIPTION_LENGTH` |
| `tools/skills_tool_dedup.py` | 视图去重 | `dedup_skill_view` |
| `tools/skills_hub_official.py` | 官方源（repo 可选技能 + 集中索引） | `OptionalSkillSource` |
| `tools/skill_usage.py` | 用量遥测 sidecar | `.usage.json`（见 `curator.md`） |
| `agent/skill_commands.py` | slash 注册 + 消息脚手架 | `_skill_commands_by_key` |
| `agent/skill_preprocessing.py` | 模板/内联 shell 预处理 | `_INLINE_SHELL_MAX_OUTPUT` |
| `agent/skill_utils.py` | 搜索根/解析/禁用名 | `get_skill_search_roots` |
| `agent/skills_index_delta.py` | 技能索引增量 | 索引差分 |
| `tests/skills/test_authoring_standards.py` | 编写硬标准 CI | 强制门 |

## 与其他模块的关系

- **tools/registry.py**：两工具注册进 `skills` 工具集（可按平台启停）。
- **cron/**：任务的 `skills` 字段在运行时按同一套根解析。
- **curator（下一篇）**：消费 `skill_usage` 遥测；`skills.disabled` 名单由 `skill_view` 拒绝。
- **hermes_cli/**：`hermes skills install/list/remove` 走 hub 家族；slash 分发见 `tutorial/06_cli/`。
- **plugins/**：插件可提供技能（`plugin:skill` 限定名）。

## 总结

格式契约的每一个细节都指向同一个目标——**让「描述」成为机器可依赖的触发面**：60 字符上限让索引不膨胀、编写标准让 prose 不说谎、平台门与 import 对账让 OS 门不装样子。加载机器则用「签名 + TTL + 浅拷贝」三件套把廉价扫描做成正确缓存，用渐进披露把 185 份技能文档的上下文成本压到「列表一次、全文按需」。
