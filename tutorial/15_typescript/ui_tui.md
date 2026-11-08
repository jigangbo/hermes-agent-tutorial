# 15.3 ui-tui —— 终端 TUI：React 渲染到终端

## 概览

`ui-tui/` 用 React 19 把 Hermes 的界面画进终端：

- 规模：634 个 ts/tsx（`src/` 473 + `packages/` 161）
- 渲染：vendored Ink fork（`packages/hermes-ink`，`@hermes/ink`，esbuild 打包）把 React 组件渲染成 ANSI 字节
- 运行：Node 下（开发 `tsx src/entry.tsx`，构建走 `scripts/build/tui.mjs`）
- 状态：nanostores + `@nanostores/react`（与桌面端同款）

它是三个 TS 表面里最小、最"纯"的一个：没有 Electron 的机器层、没有浏览器的宿主。

**TypeScript 拥有屏幕，一切行为来自 `tui_gateway` 的 `hermes-gateway-v1` JSON-RPC。**

想理解 TS 端的分层，从这里读起最便宜。

## vendored Ink fork：packages/hermes-ink

TUI 没有直接依赖上游 Ink，而是把 fork 收进 monorepo：

- 位置：`packages/hermes-ink`，以 `@hermes/ink` 名义被 `src/` 引用；
- 打包：esbuild；
- 收益：终端渲染是**可掌控的内部依赖**——流式 markdown（`streamingMarkdown.tsx`）、块布局、宽字符处理这类对 Hermes 至关重要的渲染行为可以随主仓演进，不必等上游。

## 进程与连接：bootstrap 附加

```
hermes --tui
  └─ Node (Ink)                          该 profile 的共享网关 owner
     │  src/localGatewayBootstrap.ts       （hermes gateway run，
     │    └─ 运行 ui-tui/scripts/            按需拉起、空闲退出）
     │       gateway_bootstrap.py
     │       （= hermes_cli/gateway_runtime_attach.py
     │         ::attach_gateway 的薄包装）
     │  ← URL + 一次性票据（或命名的失败判决）
     ▼
  src/gatewayClient.ts ──WS /api/ws──▶ 网关（子协议 hermes-gateway-v1）
     （@hermes/shared 的 GatewayClient，
      bootstrap 结果作为 connect 注入）
```

几个值得记住的细节：

- **附加而非 spawn**：Ink 从不启动私有 agent 子进程；`gateway_bootstrap.py` 与任何本地客户端跑的 `hermes gateway attach --json` 完全同路。
- **解释器只信 `HERMES_PYTHON`**。`localGatewayBootstrap.ts` 开头注释写明了原因：
  - launcher 链（`hermes_cli/main.py` 校验并兜底、Nix 包装器设置）保证了它存在；
  - 在这里扫 `VIRTUAL_ENV`/`.venv` 只会找到一个**与父进程不同的** python——在 pm store 的世界里，陈旧的 venv 路径是危险的（网关子进程拿到的解释器必须与拉起它的一致）；
  - 唯一无 launcher 覆盖的情形是直接在 `ui-tui/` 下 `pnpm dev/start`，此时退回 PATH（win32 用 `python`，其余 `python3`）。
- **失败也有名字**：`isTerminalBootstrapFailure` 识别 `gateway unavailable: ...` 形态的判决，让上层能给出明确的失败文案而不是裸堆栈。
- 唯一拨向别处 URL 的是仪表盘 `/chat`（`HERMES_TUI_GATEWAY_URL`），从 listener 的 ready 帧协商 wire。
- 协议细节另有 `CANONICAL_GATEWAY.md` 在仓内可读。

## src/app/ —— 应用大脑（54 个文件）

`src/app/` 是 TUI 的神经中枢，几个承重文件：

| 文件 | 角色 |
|------|------|
| `gatewayContext.tsx` | 网关连接的 React 上下文（连接生命周期从这里铺开） |
| `createGatewayEventHandler.ts` | 服务端事件 → store 的唯一汇入点 |
| `createServerRequestHandler.ts` | 应答 server→client 请求（`approval`/`clarify`/`sudo`/`secret`…）——与桌面的 `gateway-event/server-requests.ts` 一一对应 |
| `createSlashHandler.ts` + `slash/`（目录+队列） | 本地 slash 处理与队列；内建本地处理，其余 `slash.exec` |
| `turnController.ts`（`ui-tui/src/app/turnController.ts`）/ `turnStore.ts` | 回合状态机与存储（提交、排队、审批流） |
| `delegationStore.ts` / `liveSessions.ts` / `agentRoster.ts` | 子代理快照、存活会话、agent 名册（对应 `subagent.list`） |
| `useMainApp.ts` / `useSubmission.ts` / `useInputHandlers.ts` | 主循环装配与输入面 |
| `gatewayRecovery.ts` / `gatewayStartTimeout.ts` | 连接恢复与启动超时 |
| `slashCatalog.ts` / `queueSlash.ts` / `steerOrQueue.ts` | slash 目录、队列化、转向或排队决策 |

`src/` 其余部分：

| 子目录 | 角色 |
|--------|------|
| `components/`（46 文件） | 屏幕零件，详见下表 |
| `domain/` | 纯模型：`messages`、`roles`、`viewport`、`usage`、`attachments`、`blockLayout`——不碰 React 也不碰网络 |
| `protocol/` | 粘贴协议（`paste.ts`） |
| `hooks/` `lib/` `config/` `content/` | 组合逻辑、纯函数、配置、静态内容 |
| `i18n/` `sdk/` `types/` | 与桌面同构的横切层 |
| 入口 | `entry.tsx` + `app.tsx`；连接面 `gatewayClient.ts` + `localGatewayBootstrap.ts` |

`components/` 选列：

| 组件 | 画什么 |
|------|--------|
| `appChrome.tsx` / `appLayout.tsx` | 应用壳与布局 |
| `streamingMarkdown.tsx` / `streamingAssistant.tsx` / `messageLine.tsx` | 流式转写 |
| `thinking.tsx` | 工具活动流 |
| `prompts.tsx` / `maskedPrompt.tsx` | approval/clarify/sudo/secret 提问卡 |
| `modelPicker.tsx` | 模型选择 |
| overlays 系 | `agentsOverlay`、`billingOverlay`、`connectorsOverlay`、`skillsHub`、`pluginsHub`、`rewindBrowse`、pets |
| `fpsOverlay.tsx` 等调试面 | FPS/HUD |

## 渲染分工：TS 拥有屏幕

```
┌────────────────────── 屏幕四区（全部 TS） ──────────────────────┐
│  transcript        │  composer（输入、补全、粘贴）                │
│  （messageLine/    │                                            │
│   streaming*）     │  prompts（approval/clarify/sudo/secret 卡片）│
│  activity          │                                            │
│ （thinking.tsx 等） │  overlays（agents/billing/skills/pets…）    │
└─────────────────────────────────────────────────────────────────┘
         ▲ 事件（message.delta/tool.start/…）      │ prompt.submit / slash.exec / 应答
         └──────────── tui_gateway（Python 拥有行为）◀┘
```

典型映射（与 `08_tui_gateway/index.md` 的速查表一致）：

| 界面 | TS 组件 | 网关方法 / 事件 |
|------|---------|----------------|
| 聊天流式 | `app.tsx` + `messageLine.tsx` | `prompt.submit` → `message.delta` / `message.complete` |
| 工具活动 | `thinking.tsx` | `tool.start` / `tool.generating` / `tool.complete` |
| 审批 | `prompts.tsx` | server→client 请求 `approval` → 应答 `{choice}` |
| clarify / sudo / secret | `prompts.tsx`、`maskedPrompt.tsx` | 对应的 server→client 请求 |
| 会话选择器 | `sessionPicker.tsx` | `session.list` / `session.resume` |
| 补全 | `useCompletion` hook | `complete.slash` / `complete.path` |
| 主题 | `theme.ts` + `branding.tsx` | `gateway.ready` 携带 skin 数据 |

**反方向是禁区**：会话、工具、模型调用、slash 逻辑永远不进渲染器。

桌面与 TUI 需要同一个新提问方式时，正确动作是在 `tui_gateway/contracts/server_requests.py` 加一个 `server_request(...)`，然后两侧各写一个应答 handler——而不是在任一渲染器里发明本地逻辑。

## 开发与测试

```bash
cd ui-tui
pnpm install       # 首次
pnpm run dev       # watch：重建 hermes-ink + tsx --watch
pnpm start         # 生产运行
pnpm run build     # hermes-ink + tsc 全量
pnpm run typecheck # tsc --noEmit
pnpm test          # vitest
```

Python 侧测试在 `tests/tui_gateway/`。

注意根测试规则——Python 测试不得断言 `package.json`/`.ts` 源码，JS 侧断言放 vitest。

## 与其他模块的关系

- **`tui_gateway/`（08 章）**：宿主后端。所有事件、方法、server→client 请求的 Python 侧都在那里；`08_tui_gateway/index.md` 的速查表就是本目录的镜像。
- **`apps/shared`**：`GatewayClient`/传输/契约类型来自 `@hermes/shared`，TUI 不自研 wire。
- **`web/`**：仪表盘 `/chat` 用 PTY 把**这个 TUI** 整个搬进浏览器；Ink 里新增的东西在仪表盘自动出现。
- **`apps/desktop`**：同一套 server→client 请求在两个渲染器各有一个 handler；同一个 `@hermes/shared` 客户端。
- **`pm/`**：`HERMES_PYTHON` 是解释器解析的唯一信任源（上文 bootstrap 细节）。

## 总结

ui-tui 是"窄腰"哲学最干净的展示：渲染器只有一个职责——把 JSON-RPC 流画成终端，把人类输入变成 RPC 调用。

它没有自己的行为层，没有私有 agent，甚至没有自己的 Python 解释器判断。

三个值得带走的记忆点：

1. vendored Ink fork 让终端渲染成为可控资产；
2. `src/app/` 的 54 个文件按"事件汇入 / 请求应答 / 回合控制"分工而不是按屏幕分工；
3. bootstrap 附加共享 owner 的模式与桌面、仪表盘一致——三个表面，同一个后端。
