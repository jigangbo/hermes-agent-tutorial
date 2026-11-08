# skills/ 模块总览 —— 技能系统的两个表面

## 文件概览

技能是 Hermes 的「可加载操作手册」：一个目录、一份 `SKILL.md`（YAML frontmatter + Markdown 指令），可选再带 `references/ templates/ assets/ scripts/`。仓库里有**两个表面**：`skills/` 是内置技能（44 个 SKILL.md，12 个类别目录，默认可加载）；`optional-skills/` 是更重、更小众的技能（141 个 SKILL.md，23 个类别目录，未激活，经 `hermes skills install official/<category>/<skill>` 安装，适配器是 `tools/skills_hub_official.py` 的 `OptionalSkillSource`）。运行时机器在 `tools/skills_tool.py`（渐进披露的两个模型工具）、`agent/skill_commands.py`（每个技能自动注册 `/skill-name` slash）与 `agent/skill_preprocessing.py`（模板令牌 + 内联 shell 展开）；生命周期维护者是策展人（`agent/curator.py`）。本篇是第 12 章总览与全部内置技能名单。

## 两表面 + 四级搜索目录

模型可见的技能目录按 `agent/skill_utils.get_skill_search_roots()`（行 413-423）给出的四级优先序解析——这是技能列表、prompt 索引、slash 命令、`skill_view`、preload 与 cron 共享的**唯一**顺序：

```
TIER_PROJECT   项目 .hermes/skills/（opt-in）
TIER_LOCAL     ~/.hermes/skills/（用户技能 + 从内置播种 + hub 安装落点）
TIER_CREATE_DIR 技能创建目录（存在才加入）
TIER_EXTERNAL  skills.external_dirs 配置的外部目录
（内置 skills/ 与 optional-skills/ 经 bundled 播种/官方源进入 TIER_LOCAL 世界）
```

同名时高 tier 遮蔽低 tier；`resolve_skill_catalog` 负责去重与遮蔽判定，重复者用「精确相对路径」作为 `skill_view` 的名字。

## 渐进披露：两次工具调用

```python
# tools/skills_tool.py:3-4
"""Skills Tool — list and view skill documents (progressive disclosure). A skill is a directory
holding SKILL.md (YAML frontmatter + instructions) plus optional references/, templates/, assets/,
scripts/. `skills_list` returns name/description only; `skill_view` returns full content and
linked files. Sibling modules (skills_tool_setup / _plugin / _dedup) re-export here."""
```

`skills_list`（行 290）只暴露名称 + 描述 + 类别（描述截断到索引宽度），`skill_view`（行 613）才给全文与链接文件。技能**经描述进入模型技能索引**——所以描述质量就是触发质量，这也是编写标准把 description 卡在 ≤60 字符一句的原因。发现结果有每会话缓存（目录签名 + 30s TTL，行 33-40）：签名 = 每个目录的 mtime + 子目录名（装/卸发生在同一个粗粒度 mtime 刻度内也能被名字差异捕捉）+ 禁用集 + platform；TTL 管不住的只有原地改 SKILL.md（无目录变化）。

## 一条技能被触发后的完整链路

```
1. 模型读到 skills_list 的行（name + description + category）
2. 模型调 skill_view(name) → 全文 + 链接文件清单
   ├── frontmatter 平台门/环境门/app 门（不可见技能按需可查，skip_disabled 场景）
   ├── setup 检查：prerequisites.commands / metadata.hermes.config 的 env 提示
   └── 预处理：${HERMES_SKILL_DIR}/${HERMES_SESSION_ID} 展开（默认开）
              ！`cmd` 内联 shell（默认关；community 信任级永不自动执行）
3. /skill-name slash（agent/skill_commands.py）：用户直接点名 → 技能全文嵌入消息
   └── 脚手架标记让记忆提供者只存「用户的指令」而不存技能正文
4. usage 遥测 +1（tools/skill_usage.py，best-effort、跨进程锁、原子写）
5. 策展人日后读这份遥测决定 active/stale/archived（见 curator.md）
```

## 一份技能目录长什么样

```
skills/software-development/github/
├── SKILL.md            ← frontmatter（name/description/platforms/metadata.hermes.*）+ 指令正文
├── references/         ← 按工作流拆分的参考文档（PR 生命周期、issue 管理……）
├── scripts/            ← helper 脚本（技能相对路径引用；不让模型现写解析器）
├── templates/          ← 可填模板
└── assets/             ← 资源文件
```

编写标准（CI 强制）要求正文遵循现代章节顺序、prose 用反引号点名原生工具、`platforms` 门与脚本实际 import 对账——完整字段表与标准清单见 `skill_format.md`。

## 44 个内置技能全名单

```
skills/
├── apple/               apple-notes  apple-reminders  findmy  imessage
├── autonomous-ai-agents/ claude-code  codex  computer-use  hermes-agent
├── creative/            architecture-diagram  ascii-video  baoyu-infographic
│                        claude-design  humanizer  manim-video  p5js
│                        popular-web-designs  songwriting-and-ai-music
├── devops/              sdlc-review
├── email/               email-inbox-triage  himalaya
├── media/               youtube-content
├── note-taking/         obsidian
├── productivity/        document-to-action-items  google-workspace  maps
│                        meeting-action-items  microsoft-office  pdf
│                        product-price-monitor  teams-meeting-pipeline
│                        weekly-review-planning
├── research/            arxiv  competitor-news-monitor  grounded-citations
├── social-media/        xurl
├── software-development/ codebase-inspection  dogfood  github
│                        requesting-code-review  simplify-code  spike
│                        systematic-debugging  test-driven-development
└── web/                 blocked-page-recovery
```

（`skills/index-cache/` 是索引缓存工作区，不是技能。）共 **44 个 SKILL.md、12 个类别目录**。`optional-skills/` 的 23 类：autonomous-ai-agents, blockchain, communication, creative, data-science, devops, dogfood, email, finance, gaming, health, mcp, media, mlops, payments, productivity, research, security, smart-home, social-media, software-development, web-development（+DESCRIPTION.md 说明文件）。

## 两条表面的准入差异

| 维度 | `skills/`（内置） | `optional-skills/`（可选） |
|---|---|---|
| 默认状态 | 可加载（播种进 `~/.hermes/skills/` 世界） | 未激活 |
| 安装方式 | 随仓库分发 | `hermes skills install official/<category>/<skill>` |
| 适配器 | bundled 播种 | `tools/skills_hub_official.py` 的 `OptionalSkillSource` |
| 准入标准 | 同一套编写硬标准（CI 强制） | 同上；重依赖/小众倾向送这里 |
| 评审提示 | 检查目标目录：重依赖或小众技能去 `optional-skills/` | — |

评审一个技能 PR 的第一问就是「该去哪个表面」：需要重依赖（manim、office 套件）或极小众（区块链、游戏）的技能进 `optional-skills/`，让默认安装保持轻。

## 本组文档导航

| 文档 | 内容 |
|---|---|
| `skill_format.md` | SKILL.md frontmatter 字段表、目录布局、编写硬标准（CI 强制）、渐进披露与 30s 缓存、预处理令牌 |
| `curator.md` | 策展人：不活动触发、usage 遥测、生命周期迁移、LLM 整合 opt-in、备份 |

## 常见问题速查

- **技能没被触发？** 先看 description：是否 ≤60 字符、是否描述能力而非实现、是否撞了名字/类别重复。触发质量 = 描述质量。
- **技能装了但 `skill_view` 拒绝？** 它在 `skills.disabled` 名单里（`skill_view` 按名单拒绝），或平台门/环境门/app 门判定不可见。
- **同名技能谁赢？** 四级搜索根的优先序（project > local > create > external）；同级重复用精确相对路径点名。
- **内联 `!`cmd`` 没执行？** 默认关闭（`skills.inline_shell`）；且 community 信任级的 hub 技能永不自动执行（#63307）。
- **技能被归档了？** 策展人的不活动迁移；`~/.hermes/skills/.archive/` 里可恢复，pinned 可豁免（见 `curator.md`）。

## 与其他模块的关系

- **tools/**：`skills_tool.py` 注册进 `tools/registry.py` 的 `skills` 工具集；官方源适配器 `skills_hub_official.py` 属于 skills hub 家族。
- **agent/**：`agent/skill_commands.py`（slash 注册）、`agent/skill_preprocessing.py`（预处理）、`agent/skill_utils.py`（搜索根与解析）、`agent/skills_index_delta.py`（索引增量）；运行时视角另见 `tutorial/03_agent/skills_runtime.md`。
- **cron/**：cron 任务可以带 `skills` 字段（`JOB_DEFINITION_FIELDS`），运行时按技能根加载。
- **hermes_cli/**：`hermes skills install ...` 与 `/skill-name` slash 命令分发。
- **tests/skills/**：编写标准由 `tests/skills/test_authoring_standards.py` CI 强制。

## 总结

技能系统的读法是「**一个格式、两个表面、两级披露**」：格式是「目录 + frontmatter + 指令」，表面是内置/可选，披露是「索引里只有名字和描述、`skill_view` 才有全文」。所有机器行为都挂在描述文本上——这解释了编写标准为何如此苛刻，也解释了策展人为何把「不活动」作为唯一的生命周期信号。
