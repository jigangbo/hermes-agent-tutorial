# 15.4 web —— 浏览器仪表盘：嵌入真 TUI

## 概览

`web/`（239 个 ts/tsx）是 `hermes dashboard` 打开的浏览器仪表盘（默认端口 9119）：

- 前端：Vite + React 19 + Tailwind v4 的 SPA；
- 构建：产物输出到 `hermes_cli/web_dist/`；
- 伺服：FastAPI 后端（`hermes_cli/web_server.py` + `web_routers/`，一表面一文件）当静态资产。

它有 19 个页面覆盖管理面（Sessions、Config、Cron、Models、Skills、Profiles…）。

但它的聊天页走了一条非常克制、也非常聪明的路：

**`/chat` 不是又一个聊天 UI，而是把真实的 `hermes --tui` 嵌进浏览器。**

这是 `web/AGENTS.md` 的第一句话，也是本篇要解释的核心设计。

## xterm.js 嵌真 TUI：PTY 桥架构

```
 浏览器（web/src/pages/ChatPage.tsx）           服务端（hermes_cli/web_server.py）
┌──────────────────────────────┐              ┌────────────────────────────────┐
│ xterm.js Terminal            │   /api/pty   │  @app.websocket("/api/pty")    │
│  · WebGL renderer  (:881)    │◀──WS 双向───▶│  hermes_cli/pty_bridge.py      │
│  · @xterm/addon-fit (:764)   │  裸 PTY 字节   │   · ptyprocess 精确 spawn       │
│  · @xterm/addon-unicode11    │              │     hermes --tui 会 spawn 的东西 │
│    (:785 宽字符宽度)          │  resize 帧：   │     （POSIX PTY：WSL 可用，     │
│                              │  \x1b[RESIZE: │      原生 Windows 不可用）      │
│  Terminal 装配在 :518         │  <cols>;<rows>]│   · 截获 resize → TIOCSWINSZ   │
└──────────────────────────────┘              └────────────────────────────────┘
        结构化 React UI 环绕四周：                        ▲
        ChatSidebar / ModelPickerDialog /                └── 真实 Ink TUI 进程
        ToolCall / ReasoningPicker（它们不是聊天面）
```

工作方式逐条拆开：

- **鉴权**：`/api/pty?token=…` 升级为 WebSocket；token 复用与 REST 相同的 ephemeral `_SESSION_TOKEN`——放在 query param 里，因为浏览器无法在 WS upgrade 上设 `Authorization` 头。
- **spawn 一致性**：服务端用 `ptyprocess` spawn 的进程与 `hermes --tui` 自己 spawn 的**完全一致**。
- **帧语义**：两个方向流动的都是裸 PTY 字节，没有任何"聊天消息"形状的协议。
- **resize 约定**：窗口尺寸变化走终端转义 `\x1b[RESIZE:<cols>;<rows>]`，服务端截获后用 `TIOCSWINSZ` 落到 PTY 上。
- **平台边界**：PTY 是 POSIX 概念——WSL 可用，原生 Windows 不可用。

`ChatPage.tsx`（2,073 行）是装配点：

- `new Terminal(...)` 在 `web/src/pages/ChatPage.tsx:518`；
- `FitAddon`（容器驱动的 resize）在 `:764`；
- `Unicode11Addon`（宽字符宽度）在 `:785`；
- `WebglAddon`（GPU 渲染）在 `:881`。

## 为什么禁止第二个聊天面

`web/AGENTS.md` 的禁令写得很直白：**不要在 React 里重实现主聊天体验**。

转写、输入流（含 slash 命令行为）、PTY 终端属于内嵌 TUI；如果你发现自己在为仪表盘重写转写或输入框——停下，去扩展 Ink（`tui_gateway/AGENTS.md`）。

理由有三层：

1. **行为分叉是负资产**。聊天行为（FIFO 排队、审批、补全、slash 语义）全部活在 `tui_gateway` + Ink 里；第二个 React 聊天面意味着每改一次后端要同步改多个消费者，漂移只是时间问题。
2. **结构化 UI 只做环绕，不做平行**。侧栏 widget、inspector、摘要、状态面板（`ChatSidebar`、`ModelPickerDialog`、`ToolCall`）**补充**内嵌 TUI 是受欢迎的——条件是：
   - 状态独立于 PTY 子进程的会话；
   - 失败以非破坏性方式呈现，保证终端 pane 继续可用；
   - 它们不构成第二条聊天通道。
3. **测试成本低**。Ink 的行为测试写一次，仪表盘免费继承。

## pages/ 一览（19 个路由页）

| 页面 | 覆盖 | 页面 | 覆盖 |
|------|------|------|------|
| `ChatPage.tsx` | xterm.js 嵌真 TUI（本篇主角） | `ModelsPage.tsx` | 模型目录与选择 |
| `SessionsPage.tsx` | 会话列表与管理 | `McpPage.tsx` | MCP 服务器 |
| `ConfigPage.tsx` | 配置 | `PluginsPage.tsx` | 插件 |
| `CronPage.tsx` | 定时任务 | `SkillsPage.tsx` | 技能 |
| `ProfilesPage.tsx` | profile 管理 | `ProfileBuilderPage.tsx` | profile 构建器 |
| `ChannelsPage.tsx` | 消息渠道 | `PairingPage.tsx` | 消息平台配对 |
| `FilesPage.tsx` | 文件 | `LogsPage.tsx` | 日志 |
| `EnvPage.tsx` | 环境变量 | `AnalyticsPage.tsx` | 用量分析 |
| `WebhooksPage.tsx` | Webhooks | `SystemPage.tsx` | 系统 |
| `DocsPage.tsx` | 文档 | | |

`src/` 其余部分：

| 子目录 | 角色 |
|--------|------|
| `components/` | 30+ 复用组件：`ChatSidebar`、`ChatSessionList`、`ModelPickerDialog`、`ReasoningPicker`、`OAuthLoginModal`、`ProfileSwitcher`、`MemoryPressureBanner` 等 |
| `contexts/` | React context（认证、profile 范围等） |
| `hooks/` | 窄 hooks |
| `lib/` | `api.ts` 类型化 fetch 封装等纯辅助 |
| `plugins/` `themes/` `i18n/` | 仪表盘级插件、主题、多语言 |

## dashboard 与 serve：同壳不同表

`dashboard` 与 `serve` 共享 `cmd_dashboard`/`start_server` 但**互不拉起**，是两个独立表面：

| 表面 | SPA | 用途 |
|------|-----|------|
| `dashboard`（9119） | 完整 SPA 伺服 | 人用的浏览器仪表盘 |
| `serve` | **禁用**：`headless_backend=True` 跳过 `_build_web_ui`；导出 `HERMES_SERVE_HEADLESS=1` 使 `mount_spa()` 即使发现残留 `web_dist/` 也不挂载；只暴露 JSON-RPC/WS/API | Desktop 拉起的 headless 后端 |

桌面**没有**对这个前端的任何构建/运行时依赖。

每个表面（`serve`/`dashboard`/`webapp`）允许做什么，唯一权威是一张表：`hermes_cli/web_server_surface.py`——读表，别去比对 `ui_surface` 字符串。

## 测试

- Python 侧：`tests/hermes_cli/`（routers、pty bridge）；
- JS 侧：`web/` 的 vitest 套件；
- 老规矩：Python 测试不断言 `.tsx` 源码，JS 断言放 vitest。

## 与其他模块的关系

- **`ui-tui/`**：`/chat` 的内容提供者；仪表盘是 Ink 的"免费投影屏"。
- **`hermes_cli/web_server.py` + `web_routers/`**：后端宿主，路由页与 REST 路由一一对应；`pty_bridge.py` 是 PTY 桥的服务端。
- **`apps/shared`**：JSON-RPC/WS 共享客户端（与 desktop 共用）。
- **`apps/desktop`**：`serve` 是它拉起的后端；两表面无构建依赖。
- **TUI 网关协议（08 章）**：TUI 进程内部再经 WS 连网关 owner——仪表盘看到的一切行为仍然源于同一个后端。

## 总结

web/ 是一个刻意"小"的代码库：239 个文件，管理面用常规 React 表单页，聊天面则整个外包给真 TUI。

两个架构决定值得记住：

1. **嵌入而非重写**——xterm.js + PTY 桥让 Ink 成为唯一的聊天行为源；
2. **表面矩阵化**——`web_server_surface.py` 一张表裁定每个表面能做什么。

当你想给仪表盘加聊天功能时，正确的问题不是"React 组件怎么写"，而是"该往 Ink 还是往 `tui_gateway` 加"。
