# 15.1 Desktop —— Electron 桌面应用总览

## 概览

`apps/desktop/` 是 Hermes 的原生聊天表面——**不是**浏览器仪表盘，也**不**内嵌 TUI。

技术栈：Electron + React 19 + nanostores + `@assistant-ui/react`，Vite 构建，经 `@hermes/shared` 的 JSON-RPC 客户端连 canonical 网关。它是 TS 端最大的代码库：

- `src/` 约 3,700 个 ts/tsx（渲染器）
- `electron/` 约 720 个（main 进程，每个文件带同名 `.test.ts` 兄弟）

这个应用的全部架构可以用一句话说清：**三方共治，各管一摊，接缝干净**。

当一次改动模糊了接缝，那就是坏味道——修接缝，而不是把接缝撑宽。

## 权威三分：机器 / 体验 / 工作

```
┌─────────────────────────┐   ┌─────────────────────────┐   ┌─────────────────────────┐
│  Electron (electron/)   │   │  Renderer (src/)        │   │  Agent backend (网关)     │
│  拥有【机器】             │   │  拥有【体验】             │   │  拥有【工作】              │
│                         │   │                         │   │                         │
│  · 进程生命周期           │   │  · 导航 / 路由            │   │  · 会话、工具             │
│  · 原生 FS / git / 窗口  │◀─▶│  · 呈现 / 交互态          │◀─▶│  · 模型调用、流式          │
│  · 安装 / 自动更新        │窄 │  · 纯本窗口的短暂状态       │WS │  · slash 逻辑             │
│  · 窄类型能力桥           │类型│                         │   │                         │
│    backend-*.ts         │桥 │  从不直接碰 Node/Electron │   │  渲染器从不重实现          │
└─────────────────────────┘   └─────────────────────────┘   └─────────────────────────┘
```

三条权威规则派生出全部状态决策：

- **backend** 对"别的 Hermes 表面也能改"的一切状态拥有权威——渲染器里的副本只是缓存：
  - 合并而非覆盖；
  - 乐观上屏且可见回滚；
  - 陈旧的异步结果永不覆盖更新的意图（generation 计数、request token）；
  - 只有前台表面向共享视图发布；
  - 化妆品更新合并，终态转换立即冲刷；无操作时保持引用同一。
- **Electron** 对机器与运行时事实拥有权威——能力桥是窄类型接口，不是万能逃生舱。
- **renderer** 只拥有"纯粹关于这个窗口的呈现"的状态。

持久化状态必须在 key 里声明自己的作用域：全局、连接、profile、存储的会话、项目还是窗口？作用域错了就是一个 profile 的设置渗进另一个。

## src/ 目录结构

| 主要子目录 | 文件数（ts/tsx） | 角色 |
|-----------|------|------|
| `app/` | 1,370 | 应用主体：chat、session、settings、messaging、cron、profiles、shell、gateway/、overlays、`routes.ts` 路由根 |
| `components/` | 604 | 跨特性复用的展示组件 |
| `lib/` | 499 | 纯函数与协议辅助，含 `desktop-slash-commands.ts`（slash palette 的承重墙，997 行） |
| `store/` | 436 | nanostores 原子——feature 自有的共享状态 |
| `plugins/` | 297 | 界面级插件：`hermes-bots/`（Bot Mode）、kanban、radio、hello-runtime |
| `i18n/` | 312 | 多语言文案（DESIGN.md 要求改动同步全部 locale） |
| `api/` | 53 | REST 形状的类型化封装 |
| `sdk/` | 23 | 会话客户端 SDK 表面 |
| `themes/` | 31 | 皮肤与主题 |
| `contrib/` | 29 | 贡献点注册表（`registry`，`routes.ts` 经它发现贡献） |
| `hooks/` + `debug/` + `test/` | 38 | 窄 hooks、调试面、测试工具 |
| 根文件 | 16 | `entry.ts`、`main.tsx`、`hermes.ts`（能力入口）等 |

## Electron main（electron/）的职责

`electron/` 有独立的 `tsconfig.electron.json`，是机器能力唯一合法的入口。按主题拆成大量单文件模块：

| 文件族 | 职责 |
|--------|------|
| `backend-discovery.ts` / `backend-claim.ts` / `backend-dial-claim.ts` | 发现本机网关、认领拨号（一次性 dial 绑定请求窗口） |
| `backend-ownership.ts` / `backend-child.ts` | 后端归属探测与进程台账 |
| `backend-health.ts` / `backend-probes.ts` | 健康检查与探针——注意：是**探测归属**，不是拥有子进程（见下节） |
| `backend-connection-state.ts` / `backend-descriptor-cache.ts` | 连接状态机、描述符缓存 |
| `backend-env.ts` / `backend-ready.ts` / `backend-exit.ts` | 环境注入、就绪判定、退出路径 |
| `app-updater.ts` + `update-feed.cjs` | 自动更新（app 与 runtime 分开两个时钟更新） |
| `electron-builder.config.cjs` + `packaging/` | 打包（含 MSIX） |
| `active-runtime-state.ts`、`api-transport.ts`、`app-icon.ts`、`application-menu-startup.ts` 等 | 运行时切换、API 传输、图标、应用菜单 |

安全红线（GHSA-9f4c-93c8-jc8g）：**访客内容永不自行打开任何东西**。

- artifact iframe 和 preview `<webview>` 永不自己驱动 OS 浏览器；
- `setWindowOpenHandler` 全拒；webview 无 `allowpopups`；
- 访客 `target="_blank"` 链接只能经 `persist:hermes-preview` guest preload 的 trusted-click 桥到达 `hermes:openExternal`，仅 `http:`/`https:`；
- 放宽分区键、trusted-click 门或 scheme 集都会重开这个 advisory；
- OAuth 分区名避开 Electron 会百分号转义的字符（`electron/oauth-partition.ts`）。

端到端测试：`e2e/`（Playwright，`playwright.config.ts` + `tsconfig.e2e.json`）。

## 网关连接：ensure --json，从不拥有 PID

桌面本地执行属于 **canonical 网关**。这是 `src/AGENTS.md` 用整节钉死的契约：

```
Desktop app
   │  1. hermes gateway ensure --json        （无凭据 endpoint）
   │  2. 领取一次性私有 control ticket
   │  3. 票据经私有 preload IPC 瞬时传递，
   │     在构造 WebSocket 前从 URL 移除，
   │     并作为 subprotocol 提供
   ▼
┌────────────────────────────────┐
│  canonical 网关 owner           │   每个 home 一个多路复用 owner；
│  （可能是远端/云，也可能服务多个  │   HERMES_DESKTOP=1 不是找它的方式；
│   profile 的同一进程）           │   绝不为单 profile spawn
└────────────────────────────────┘   hermes serve --port 0 子进程
   ▲
   │ 关闭/切换/驱逐 Desktop 连接 = 断开 viewer；
   │ 只有显式的 gateway 生命周期命令才停掉 owner
```

逐条展开：

- **app 从不把网关 PID 收为 owned 子进程。** Electron 的 backend-* 探测只回答"这个 owner 归谁、活着吗"，生命周期归网关自己。这保证了 TUI、仪表盘、桌面三表面看到同一个会话世界。
- **多路复用下的 profile 纪律**：
  - 每个生命周期/状态/设置 REST 调用都带 `?profile=`（或 `profile` 参数）；
  - 每个新会话 tile 记录 owner 路由；
  - 后端侧的作用域修复必须用两种姿势各探测一次——profile 作为网关自己的启动 home，以及作为被同一进程服务的 secondary。
- **远端失败不得拉起本地 owner**；SSH/URL intent 保留既有的远端解析与暴露生命周期。
- **OAuth 网关连接每次拨号铸新票据**，只有确认的 401/403 才意味着要重新认证；连接测试必须演练真正要用的那条腿。
- 还有一类 agent-callable 能力（开面板、读应用内浏览器、对消息做出反应）：它是**会话客户端的属性**，靠 `session.create` 发的 `source: 'desktop'` 判定，而不是后端进程的 env var——那个进程可能只是这台 app 连上的远端或云网关（见 `tools/AGENTS.md`"Surface capability is a property of the SESSION"）。

## 切换上下文是 re-home，不是重启

| 变更 | 语义 |
|------|------|
| 连接/模式 apply | 软 re-home：壳不动，网关绑定的 store 显式清空后重连 |
| 运行时 `HERMES_HOME` 变更 | 硬 re-home：整体 reload |
| 存活 profile 切换 | 列表合并，后台 profile 继续流式 |

任何切换之后，活跃 socket、profile 与 connection 原子三者必须一致。

身份也不是附带品：会话有持久、运行时与谱系根三种身份，表面按需挑选并在边界翻译——用户消息在发送即持久（`prompt.submit` 先写会话与用户行，回合认领该行）；可验证消失的会话（`goneSessionVerdict` → `'draft'`）静默落回新草稿并一次性收养未发送文本，不弹 toast、不抢导航、不抢焦点。

## 与其他模块的关系

- **`tui_gateway/`**：真正的后端；desktop 的 server→client 桥（`gateway-event/server-requests.ts`）对应它的 `server_requests.py`。
- **`hermes_cli/commands.py`**：slash 命令的 desktop 处置（`desktop=` 字段）在这里一次性编写，经 `commands.catalog` 流到桌面（详见 `desktop_features.md`）。
- **`apps/shared`**：`JsonRpcGatewayClient` 是唯一 WS 客户端；不另造传输。
- **`web/`**：同一份 `@hermes/shared`，但 `hermes serve`（desktop 拉起的 headless 后端）禁用 SPA——两个表面互不依赖构建产物。

## 总结

Desktop 的架构判断题只有一道：**这块状态/能力的权威是谁？**

Electron 管机器，renderer 管体验，backend 管工作；接缝用窄类型桥连接。

把两条 invariant 记住，剩下的目录结构都只是这个三分法的展开：

1. 从不拥有网关 PID——连接的是多路复用的 canonical owner；
2. 渲染器不碰 Node/Electron——原生能力只走窄类型桥。
