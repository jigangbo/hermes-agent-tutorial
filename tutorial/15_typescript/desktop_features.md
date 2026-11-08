# 15.2 Desktop —— 特性深讲：Slash Palette 全链路与 Bot Mode

## 概览

本篇拆开桌面应用两个最有辨识度的特性：

- **slash palette** —— 命令面板的全链路：从 Python 命令定义到补全、派发与离线回退；
- **Bot Mode**（`src/plugins/hermes-bots/`）—— 一个"名字即身份"的设计，因为反复回归而经历五波硬化，其不变式不再接受日常 PR 重新讨论。

两者共同展示同一原则的两个侧面：

1. 客户端策展只藏噪音，永不藏用户的东西；
2. 身份由权威数据派生，永不靠存储的指针。

## Slash palette 全链路

后端其实已经提供了一切：`commands.catalog` 与 `complete.slash` 包含内建命令、用户 `quick_commands` **以及**技能派生命令——看见技能不需要任何新 RPC。

桌面做的事只有**策展**：

```
hermes_cli/commands.py            apps/desktop/src/
CommandDef.desktop=  ──(live catalog)──▶ use-slash-completions.ts
  │ 每个命令的桌面处置只写一次          （两条补全路径都过
  │                                    isDesktopSlashSuggestion）
  │                                          ▲
  ├── scripts/dump_desktop_slash_registry.py │ filterDesktopCommandsCatalog
  │        生成 ──▶ src/lib/desktop-slash-registry.json（离线回退，漂移测试守卫）
  │
  └── DESKTOP_COMMAND_SPECS + block-list ──▶ desktop-slash-commands.ts（承重墙，997 行）
                                               │
                                               ▼
                                app/session/hooks/use-prompt-actions/slash.ts
                                runSlash：本桌面内建 → 本地/commands.catalog；
                                其余 → slash.exec → command.dispatch 兜底；
                                技能命令 = {type:"skill", message} → 按普通 prompt 提交
```

**承重文件**是 `apps/desktop/src/lib/desktop-slash-commands.ts`。关键锚点（文件:行号）：

| 符号 | 位置 | 作用 |
|------|------|------|
| `DESKTOP_COMMAND_SPECS` | `desktop-slash-commands.ts:202` | 内建命令及其桌面表面（含别名）；一个命令的桌面处置（terminal-only / messaging-only / settings-owned / advanced / hidden）在 Python `CommandDef.desktop=` 上**只写一次**，live catalog 携带它 |
| `TS_ONLY_NO_DESKTOP_SURFACE` | `desktop-slash-commands.ts:412` | 只有 Python 注册表从未听过、无桌面表面的名字：`/density`、`/details`、`/logs`、`/mouse`（Ink 本地）、`/pets` |
| `isDesktopSlashExtensionCommand` | `desktop-slash-commands.ts:738` | 对一切非已知内建返回 true——**扩展放行** |
| `isDesktopSlashCommand` | `desktop-slash-commands.ts:771` | 门**执行**（内建与所有非内建都为 true，所以敲出来的技能/quick 命令都能跑） |
| `isDesktopSlashSuggestion` | `desktop-slash-commands.ts:789` | 门**发现**——两条补全路径与 catalog 过滤共用 |

三个判定函数的消费点：

- 发现/补全：`app/chat/composer/hooks/use-slash-completions.ts` 的两条补全路径；
- catalog 过滤：`filterDesktopCommandsCatalog`；
- 执行派发：`app/session/hooks/use-prompt-actions/slash.ts` 的 `runSlash`。

**离线回退注册表**：

- `src/lib/desktop-slash-registry.json` 由 `scripts/dump_desktop_slash_registry.py` 生成；
- 两份漂移测试（`tests/hermes_cli/test_desktop_slash_registry.py` + vitest 同名文件）在 Python 注册表与 JSON 不同步时让 CI 失败；
- 这是 TS 端"生成物 + 漂移测试"模式的又一实例（见 `ts_conventions.md`）。

**历史教训**（写进了 AGENTS.md 的规则）：

早期 allow-list 曾把每个技能/quick 命令从补全里静默丢掉——敲了能执行，面板却不显示。

所以现在的铁律是：**palette 策展只藏噪音（terminal-only / messaging-only 内建），永不藏用户激活的扩展**。

收紧 `desktop-slash-commands.ts` 时必须让 `isDesktopSlashExtensionCommand` 继续流进发现与 catalog 两条路。

回归测试：`pnpm exec vitest run src/lib/desktop-slash-commands.test.ts`（workspace 依赖装在仓库根）。

## Bot Mode：NAME 即身份

`src/plugins/hermes-bots/` 的设计宣言一句话：

**一个 bot = 一条 canonical forever-chat，身份就是 NAME。**

每个 bot 是一个 Hermes profile；聊天会话的唯一身份是 **(profile, 标题恰为 "Bot Chat" 的会话)**。

`state.db` 的 `UNIQUE(title)` 约束使这一对成为一张至多一行的注册表。

点击 bot 行的完整流程：

```
点击 bot 行
   │
   ▼
① 解析注册表——每次都重新解析：
     session.list {title: "Bot Chat", include_hidden: true}
     （走索引、窗口无关；隐藏行能解析，因为 canonical chat 恒为 hidden；
      压缩谱系解析到 live tip）
   │
   ├─ 行存在 ──▶ 打开它。这就是全部 happy path。
   │
   └─ 无行 ──▶ ②创建：标题 "Bot Chat"、born hidden、以 bot 的 intro 开场
              采用先于铸造（adopt-before-minting）：再查一遍，
              并发/既有行被打开而不是分叉
              （set_session_title 静默丢弃冲突标题——返回 0 行——
               这正是 2026-08 无限分叉循环的起点）
```

### 为什么是五波硬化

旧设计在 `ui_meta['hermes-bots'].chat` 里存一个 **session-id 指针**。

指针会悬空、会被偷走，每一波修复都发现一种新的坏法：

| 波次 | 问题 |
|------|------|
| #88690 | 首次守卫指针悬空 |
| #90732 | rows[0] 偷取；顺带删掉了 per-bot 会话浏览器 |
| #90751 | `last_session` 收养污染指针 |
| #91791（revert） | 瞬时清空 |
| #92042 | 指针重新锚到 cron 会话上——最终根除指针 |

根因总结：**名字不会悬空，指针会。**

旧 `ui_meta` 里的 `chat` 键现在被忽略并丢弃；任何把"存储的 session-id 指针"当作 canonical 身份的提案——包括"作为兜底层"或"仅用于校验"——都按评审规则拒绝。

### Recency 永不获胜（#91791 → #92042）

- canonical Bot Chat **无条件**从 Sessions 侧边栏隐藏，bot 行是唯一入口；
- "最近可见会话获胜"会把整段关系困在一个行后面——行预览的是一个会话，打开的却是另一个；
- 侧边聊天（"New chat with this agent"）不用管道标题命名、在侧边栏可见、永远不是 bot 行的目标；
- 关于它们的报告属于侧边栏 hide-sweep，不属于 Bot Mode。

**构造上的一致性**：

网关在 `profiles.list` 里把注册表行报成 `canonical_session`（服务端按标题解析）。

roster 预览、活动信号、`/new`→`/compact` 守卫都读它——预览身份与点击身份因此**天然是同一行**。

契约测试（`src/plugins/hermes-bots/`）：

- `canonical-chat-registry.test.ts` —— tripwire：打开路径从不读写存储指针；
- `canonical-chat-creation.test.ts`
- `canonical-chat-adopt-on-conflict.test.ts`
- `bot-row-opens-canonical-chat.test.ts`
- `hide-bot-chats.test.ts`

Python 侧：`tests/tui_gateway/test_profiles_list_canonical_session.py`。

Bot Mode 还有群聊合约（`apps/desktop/docs/canonical-groups.md`）：

- 网关列出方法才提供控件；
- 只发送生成契约声明的内容；
- 绝不回退经典执行；
- 只在网关给出 `admitted: false` 证明时才把 Send 的字还给你。

## 与其他模块的关系

- **`hermes_cli/commands.py`**：桌面处置的单一事实源；改这里要重新生成 `desktop-slash-registry.json`。
- **`tui_gateway/`**：`slash.exec` / `command.dispatch` / `complete.slash` / `profiles.list` 的实现方（`gateway/session_commands.py`、`gateway/session_discovery.py`）。
- **`hermes_state`（07 章）**：`UNIQUE(title)` 约束是 Bot Mode 身份设计的物理基础。
- **技能体系（12 章）**：技能命令在桌面上以普通 prompt 提交——palette 只负责被发现，不负责特殊执行。

## 总结

两个特性，一条原理：**权威在数据里，不在客户端的记忆里**。

- slash palette 的策展是 Python `desktop=` 字段的一次性投影（外加生成物兜底）；
- bot 的身份是数据库约束保证的一行注册表，每次点击现场解析。

凡是想在 TS 里"记住"一个指针、一个白名单、一个会话 id 的冲动，在这两个特性里都已经被同一种事故教育过——客户端的缓存永远可能陈旧，权威数据的派生永远便宜。
