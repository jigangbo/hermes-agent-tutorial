# 开发实践指南 — 导览

本目录的目标是把"读懂"升级为"能改"：环境怎么搭、测试怎么跑、门禁怎么过、PR 怎么被接收。这四件事是任何大型仓库贡献者的基本功，Hermes 的做法尤其值得学习 —— 它把很多"团队默契"固化成了机器可执行的检查。

| 文档 | 内容 |
|------|------|
| [环境搭建](env_setup.md) | activate 脚本、PM 环境、HERMES_HOME 与 profile 隔离 |
| [测试体系](testing.md) | scripts/run_tests.sh、行为契约、平台标记、禁用形状 |
| [代码健康门禁](code_health.md) | scripts/check、棘轮（ratchet）、HX 规则族 |
| [贡献准则](contribution.md) | rubric、footprint 阶梯、安全边界、提交纪律 |

## 一分钟速览：改一行代码要过几关

```
改代码 → python scripts/check        本地全量 lint 门禁（CI 同款钉版工具）
      → scripts/run_tests.sh         测试（强制 CI 对等环境；绝不裸跑 pytest）
      → git commit                   1-2 个不变量测试，证明在 base 上红过
      → rebase onto main 再合并      旧分支 squash 会静默回滚更新的修复
```

## 权威文档地图

本模块是"速成版"；每个主题在仓库里都有更权威的出处，遇到分歧以它们为准：

| 主题 | 仓库内的权威出处 | 本模块对应 |
|------|----------------|-----------|
| 各目录的规矩 | 每个 area 的 `AGENTS.md`（根文件是路由表） | 全部四篇 |
| 测试怎么写 | `tests/AGENTS.md`（runner、放置、禁用形状的完整清单） | [testing](testing.md) |
| 门禁与棘轮 | `scripts/code_health/config.py`（规则表 = 唯一事实源） | [code_health](code_health.md) |
| 贡献 rubric 长文 | `website/docs/developer-guide/contributing.md` § Contribution rubric | [contribution](contribution.md) |
| 安全范围 | `SECURITY.md`（§2 信任模型、§3 范围） | [contribution](contribution.md) |
| 包管理 | `pm/AGENTS.md` + `website/docs/reference/package-management.md` | [env_setup](env_setup.md) |
| 工作流细则（PR/issue/salvage） | `hermes-agent-dev` 技能 | [contribution](contribution.md) |

## 常见任务 → 入口速查

| 我想… | 入口 | 注意 |
|-------|------|------|
| 跑测试 | `scripts/run_tests.sh tests/<目录>/` | 绝不裸跑 pytest；测试环境单独建（见 [testing](testing.md)） |
| 跑 CI 同款 lint | `python scripts/check` | `--install-hook pre-push` 可装成推送钩子 |
| 加一个 Python 依赖 | 改 `pyproject.toml` → `hermes pm lock` → 提交 `uv.lock` | 必须带上限 `>=floor,<next_major`（见 [env_setup](env_setup.md)） |
| 加一个新工具 | 先走 footprint 阶梯（见 [contribution](contribution.md)） | 核心工具门槛极高，多半该是技能/插件/门控工具 |
| 豁免一条棘轮规则 | `# health: allow <RULE> -- <理由>` | `# noqa` 不豁免棘轮（见 [code_health](code_health.md)） |
| 找某个函数在哪实现 | `grep -rn "def <名字>" <目录>/<stem>_*.py` | 别通读门面文件（facade + siblings 模式） |
| 查一个"bug"是不是设计 | `git log -p -S "<符号>"` 验证意图 | 见 [contribution](contribution.md) § 判定一个"bug"之前 |
| 报安全问题 | GitHub Security Advisory / security@nousresearch.com | §3.1 发现绝不进公开 issue/PR |
| 改了协议/schema | 只改 Python 一侧，跑生成器，提交生成物 | 跨语言契约靠生成保持同步（见 [code_health](code_health.md)） |
| 提交 PR | rebase onto `main`；带 1-2 个 base 上红过的不变量测试 | 细则见 [contribution](contribution.md) |

## 门禁全景：一次提交会触发什么

```
git push
  └─ pre-push 钩子（如已安装）→ python scripts/check（本分支候选提交逐个判）
  └─ CI
      ├─ scripts/ci/classify_changes.py   按改动文件挑任务（Python 套件 / vitest / …）
      ├─ scripts/check（钉版工具，读 main 的 ENFORCEMENT 开关 —— PR 无法放松对自己的检查）
      ├─ 棘轮：新函数 CC≤20/≤300 行/嵌套≤6，文件≤2,000 行；存量只降不升
      ├─ boundary_lint.py：核心-插件边界（baseline 之外的新跨越 = 红）
      └─ run_tests.sh 等价环境：TZ=UTC、凭据清空、HERMES_HOME 指向临时目录
```

两条常被忽视的推论：

- **CI 读 main 的开关**意味着把 `ENFORCEMENT` 调成 `advisory` 是对 main 的一行提交，对开放 PR 生效于下一次 CI 运行；
- **分道由改动文件决定**意味着"Python 测试断言 TS 文件"永远不会在 JS-only PR 上运行 —— 那类断言属于 vitest（见 [testing](testing.md) § CI 分道速览）。

## 本模块与教程其他部分的关系

- 想先看懂代码再看制度：本模块可以放在最后读 —— 它不依赖任何前置模块；
- 想边读代码边动手：在读完 [02_core](../02_core/index.md)（知道零件在哪）后读本模块的 [env_setup](env_setup.md) 与 [testing](testing.md)，就能跑起来验证教程里的每个断言；
- [contribution](contribution.md) 是全教程的"出口"：读完它，你与这个仓库的关系从"读者"变成"潜在贡献者"。

本模块四篇的推荐顺序：**env_setup → testing → code_health → contribution**。前三篇是"每天要用的手艺"，contribution 是"每次提 PR 要过的关"。

## 为什么值得学这套制度

Hermes 的工程制度有三条主线，每一条都值得搬到自己的项目里：

1. **棘轮化**：尺寸与复杂度指标"只降不升"，超标的存量永远不会再变糟 —— 对抗腐化最便宜也最有效的机制。
2. **CI 对等的本地检查**：`python scripts/check` 与 CI 用同一套钉版工具，"本地过 CI 挂"这类事故在流程上就被消灭了。
3. **制度即代码**：rubric、安全边界、平台测试策略都写成机器可执行的检查（棘轮、boundary lint、`platforms` 标记解析），不依赖评审者的记忆。
