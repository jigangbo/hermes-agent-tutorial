# 贡献准则

> 贡献 rubric 是项目的"意图层"：不只告诉贡献者怎么改，更告诉 triage 与评审**为什么这样判**。原文（含示例）在 `website/docs/developer-guide/contributing.md` § Contribution rubric。

## 想要什么（Wanted）

- **真 bug 修复**：在 `main` 上可复现、指到出问题的那一行、修掉**整类**问题（含兄弟路径）。
- **边缘触达**：适配器、提供方、模型、UI 特性 —— 接入现有 setup UX。
- **神文件 → 模块重构**（facade + siblings 模式，见 [02_core](../02_core/index.md)）。
- **先扩展后复制**：同一类别 3+ 个 PR 后，应收敛为 ABC + 编排器。
- **行为契约测试**、**真 import 的 E2E**（临时 `HERMES_HOME` 上验证解析/配置/安全/IO）。
- **抢救（salvage）用 cherry-pick**：让原作者署名存活。

## 拒收什么（Rejected —— 即使做得漂亮）

- 没有具体消费者的 hooks；
- 非密钥配置的新 `HERMES_*` 环境变量（`.env` 只放密钥，行为进 `config.yaml`）；
- 终端 + 文件或技能已能覆盖时的**新核心工具**；
- 教学型工具上的 `offset`/`limit` 分页；
- **摧毁其所保护的特性的"修复"**；
- 无 opt-in 门的对外遥测；
- 改核心文件的插件（发独立插件仓库）；
- 核心树里的第三方产品。

## 判定一个"bug"之前

先验证**声明**，再验证**意图**（`git log -p -S "<符号>"`）：

- 隔离往往是设计（profile 是故意的孤岛）；
- 缺席可能是承重的；
- 一个指不出"哪一行坏了"的修复，前提未经验证。

Triage 清扫器只允许按 `implemented_on_main` / `cannot_reproduce` / `incoherent` 关单；品味性关闭是维护者的判断；拿不准时 PR 保持开放。

| 关单理由 | 何时合法 | 何时非法 |
|----------|---------|---------|
| `implemented_on_main` | main 上已有等价修复，能给 commit/PR 链接 | 只凭"看起来类似"就关 |
| `cannot_reproduce` | 按报告步骤在 main 上复现失败，写明环境 | 不给复现环境与版本 |
| `incoherent` | 报告自相矛盾、无法构成可验证声明 | 把"我看不懂"当"不成立" |
| 品味性关闭（太复杂/不想要） | **只允许维护者** | 清扫器、贡献者均不可 |

## 抢救（salvage）：关闭 PR ≠ 抛弃工作

一个被拒收的 PR 里的好改动可以走 salvage 流程：**cherry-pick 原提交**（而不是重写），让原作者署名与提交历史存活；在新 PR 里注明来源 PR，并按 rubric 修掉当初拒收的原因。这是"拒收想法、善待作者"的制度化。

## Footprint 阶梯（取能解决问题的最高一阶）

```
扩展现有代码 → CLI 命令+技能 → 服务门控工具(check_fn) → 插件 → 目录内 MCP → 新核心工具
```

- `check_fn` 回答**可达性/opt-in**，永远不是每会话表面开关（`tools/AGENTS.md`）；
- 新核心工具的门槛：根本性、广泛有用、否则不可达 —— 因为每个模型工具都随每次 API 调用发送。

## 信任模型要点（SECURITY.md §2）

理解安全边界先记四条定义（§2.1）：**agent 进程**（跑 Hermes 的 Python 解释器及其加载的一切）、**terminal 后端**（`terminal` 工具的可插拔执行目标）、**输入表面**（一切让内容进入 agent 上下文的通道）、**信任信封**（操作者运行 Hermes 即默认授予的资源）。分层如下：

| 层 | 承重程度 | 要点 |
|----|---------|------|
| §2.2 OS 级隔离 | **唯一真边界** | 对抗对抗性 LLM 的唯一安全边界是操作系统；进程内的审批门、脱敏、模式扫描、工具白名单**都不是** containment。支持 terminal 后端隔离（容器/远程/沙箱）等姿势，操作者 deliberate 选择 |
| §2.3 凭据作用域 | 进程内纪律 | 凭据分层持有，插件/平台适配器不直读 `os.environ` |
| §2.4 进程内启发式 | 尽力而为 | 一切筛选 LLM 输出的组件都是"在攻击者影响的字符串上工作的启发式"，按此对待 |
| §2.5 插件信任 | SHA 锚定 | 目录准入 + SHA 锁定（详见 [安全边界模型](../01_architecture/security_model.md)） |
| §2.6 外部表面 | 按表面声明 | 每个外部表面（dashboard、webhook…）有明确 stance，如"仪表盘把 agent 输出渲染为惰性 HTML" |

## 安全边界（报告流程）

`SECURITY.md` 是范围权威：

- **§3.1 发现**（跨边界漏洞）走私密渠道 —— GitHub Security Advisory 或 security@nousresearch.com，**绝不**进公开 issue/PR/commit/评论；
- **§3.2 硬化**是普通公开工作；
- 提交安全相关内容时点名越过的 §2 边界，并给出 `main` 上的复现。

## 一次 PR 的生命周期

| 阶段 | 做什么 |
|------|--------|
| 动手前 | `git log -p -S "<符号>"` 验证意图；确认走 footprint 阶梯的哪一阶 |
| 写代码 | 行为进兄弟文件；不 re-export 内部路径；改符号同 PR 修文档引用 |
| 写测试 | 1-2 个不变量测试，证明在 base 上红过（见 [testing](testing.md)） |
| 提交前 | `python scripts/check` 全绿（可 `--install-hook pre-push`）；`scripts/run_tests.sh` |
| 开 PR | 描述里给 repro 与出问题的行；安全相关走 §3.1 私下渠道 |
| 合并前 | **rebase onto `main`** —— 从旧分支 squash 会静默回滚更新的修复 |

## 提交纪律

- 合并前 **rebase onto `main`**：从旧分支 squash 会静默回滚更新的修复；
- 每个修复带 1-2 个不变量测试，证明在 base 上是红的；
- TypeScript（desktop/TUI/website）：feature 自有 nanostores 优先于穿线状态、薄路由根、窄 hooks、`interface` 声明 props、表驱动派发优先于条件阶梯；`src/app` 路由、`src/store` atoms、`src/lib` 纯函数。

## 长文与流程

工作流细则（PR/issue/评审/salvage 流程）在 `hermes-agent-dev` 技能；各区域的深耕文档在 `website/docs/developer-guide/`。

## 一张表记住 rubric 的立场

| 你带来的 | 仓库的回应 | 背后的理由 |
|----------|-----------|-----------|
| 指到具体行的整类修复 | 收 | 修复的价值 = 消灭的问题类别 |
| 边缘新能力（适配器/技能/插件） | 收 | 能力在边缘，核心窄腰 |
| 第三种新的"同类"实现 | 要求收敛为 ABC + 编排器 | 3+ 复制 = 抽象信号 |
| 漂亮但破坏特性的"加固" | 拒 | 安全修复不能摧毁它保护的可用性 |
| 无消费者的钩子/无门的遥测 | 拒 | 没有具体需求的面板面是纯负债 |
| 改核心文件的插件 | 拒（发独立仓库） | 插件只用已发布 API，边界由 lint 守护 |
