# 15 TypeScript 前端 —— 四表面一协议总览

## 概览

Hermes 的 agent 行为几乎全部活在 Python 里（`agent/`、`tui_gateway/`、`hermes_cli/`），而用户**看到**的一切界面几乎都是 TypeScript 写的。

TS 代码分布在四个位置，服务四个表面：

- `ui-tui/` —— 终端 TUI（React 19 渲染到终端）
- `apps/desktop/` —— Electron 桌面应用
- `web/` —— 浏览器仪表盘（`hermes dashboard`，端口 9119）
- `apps/bootstrap-installer/` —— 首启安装器（Tauri 壳）

外加一个被多个表面直接复用的共享包 `apps/shared/`。

它们形态各异——渲染到终端、渲染到原生窗口、渲染到浏览器——但**连的都是同一个后端**：canonical 网关的 JSON-RPC wire（`hermes-gateway-v1`）。

这就是本章的名字：**四表面，一协议**。理解了这一点，四个代码库的分工就不再是四份知识，而是同一份契约在四种渲染器上的投影。

## 四表面，一协议

```
                        ┌────────────────────────────────────────────┐
   hermes --tui         │            canonical 网关 owner             │
  ┌──────────────┐      │   （hermes gateway run，按需拉起、空闲退出）   │
  │ ui-tui/      │      │                                            │
  │ Node + Ink   │──────▶  会话权威：sessions、AIAgent、工具、流式      │
  │ 473 ts       │ WS   │                                            │
  └──────────────┘ hermes-gateway-v1                                │
                        │  tui_gateway/ 方法实现（methods_*.py）        │
  ┌──────────────┐      │  契约：contracts/*.py（Pydantic）            │
  │ apps/desktop │      └────────────────────────────────────────────┘
  │ Electron+React│──────▶ 同上（经 @hermes/shared 客户端）
  │ ~3,700 ts    │  WS + REST（每个 REST 调用带 ?profile=）
  └──────────────┘
  ┌──────────────┐
  │ web/         │──────▶ REST/WS（hermes_cli/web_server.py + web_routers/）
  │ Vite+React 19│           /chat 页面特殊：经 /api/pty 嵌入**真 TUI**
  │ 239 ts       │
  └──────────────┘
  ┌──────────────┐
  │ CLI (Python) │──────▶ 进程内直接调用（无 TS 渲染器，作参照系）
  └──────────────┘
```

四条连接方式的差异是本章各篇的重点，但有一个不变式贯穿全部：

**TypeScript 拥有屏幕，Python 拥有行为。**

会话、工具、模型调用、slash 逻辑从不搬进渲染器；渲染器只是一个会把 JSON-RPC 事件画出来的客户端。

| 表面 | 代码位置 | 渲染栈 | 连接后端的方式 | 规模（ts/tsx） |
|------|---------|--------|--------------|---------------|
| 终端 TUI | `ui-tui/` | React 19 → vendored Ink fork | `gateway_bootstrap.py` 附加共享 owner（WS + 一次性票据） | src 473 + packages 161 |
| Desktop | `apps/desktop/` | Electron + React 19 + nanostores | `hermes gateway ensure --json` + 私有 control tickets | src ~3,700 + electron ~720 |
| Web 仪表盘 | `web/` | Vite + React 19 + Tailwind v4 | REST/WS；`/chat` 经 PTY 嵌真 TUI | 239 |
| 安装器 | `apps/bootstrap-installer/` | Tauri 壳 + Vite/React | 独立首启流程 | 小型独立 app |
| 共享层 | `apps/shared/` | 纯 TS 库 `@hermes/shared` | 被引用，不自己连接 | ~70 文件 |

注意一个容易误判的点：

**Web 仪表盘的聊天页不是第四个聊天 UI。**

它挂 xterm.js，把真实 `hermes --tui` 进程的字节流搬进浏览器——Ink 里加的任何东西自动出现在仪表盘上。这是刻意的：禁止第二个聊天面（详见 `web_dashboard.md`）。

## 生成契约流：Python 声明 wire，TypeScript 消费

四个表面连同一个后端却不靠"口头约定"对齐——wire 是**在 Python 里声明、为 TypeScript 生成**的：

```
tui_gateway/contracts/*.py          scripts/gen_gateway_contracts.py
（每个方法/请求/事件一个               ──────────────────────────▶   apps/shared/src/
 Pydantic 模型，extra="forbid"）                                    gateway-contract.generated.ts
                                                                              │
   改模型 → 重新生成 → tsc 立刻向                 生成物被三处 import           ▼
   每一个 TS 消费者展示字段挪动了                  ◀──────────────  ui-tui/  apps/desktop/  web/
   （tests/tui_gateway/contracts/
    test_generated.py 在生成物陈旧时让 CI 失败）
```

要点逐条：

- `gateway-contract.generated.ts` 导出 `RpcMethods`、`ServerRequestMap`、`BackendGatewayEventMap` 和每个值形状。
- 同一次生成还产出 `gateway-contract.openrpc.json`（OpenRPC 描述文档）。
- `gateway-events.ts` 只在生成物之上叠加客户端本地合成事件与 `GatewayEvent` 信封——手写层刻意保持很薄。
- server→client 请求（agent 问用户：`approval`、`clarify`、`sudo`、`secret`…）在 TS 侧各有两个消费者：
  - `apps/desktop/.../gateway-event/server-requests.ts`
  - `ui-tui/src/app/createServerRequestHandler.ts`

这套流程把"前后端字段对不上"从运行时事故降级为编译错误，是 TS 端最重要的基础设施投资。

## 本组文档导航

| 文档 | 内容 |
|------|------|
| `desktop_overview.md` | Electron 桌面：权威三分（机器/体验/工作）、src/ 结构、网关连接方式 |
| `desktop_features.md` | 桌面特性深讲：slash palette 全链路、Bot Mode 的 NAME 即身份设计 |
| `ui_tui.md` | 终端 TUI：vendored Ink fork、app/ 大脑文件、渲染分工、gateway bootstrap |
| `web_dashboard.md` | Web 仪表盘：xterm.js 嵌真 TUI 的 PTY 桥架构、pages 全景 |
| `shared_infra.md` | `apps/shared`（契约与 JSON-RPC 客户端）+ `bootstrap-installer`（Tauri 安装器） |
| `ts_conventions.md` | TS 工程约定：nanostores 模式、路由根、interface、表驱动派发、生成物与漂移测试 |

阅读顺序建议：先本篇，再按兴趣选 `ui_tui.md`（最小最纯粹）或 `desktop_overview.md`（最庞大），`shared_infra.md` 与 `ts_conventions.md` 随时补课。

Python 侧的协议细节在 `08_tui_gateway/`，本章不重复。

## 目录结构

| 主要子目录 | 文件数（ts/tsx） | 角色 |
|-----------|------|------|
| `apps/desktop/src/` | ~3,700 | Electron 桌面渲染器（app 1,370 / components 604 / lib 499 / store 436 / plugins 297 / i18n 312 …） |
| `apps/desktop/electron/` | ~720 | Electron main 进程：机器能力的唯一入口（每个文件带同名 `.test.ts`） |
| `ui-tui/src/` | 473 | 终端 TUI 渲染器（app 54 个"大脑文件"、components 46、domain/） |
| `ui-tui/packages/hermes-ink/` | 161 | vendored Ink fork（`@hermes/ink`），esbuild 打包 |
| `web/src/` | 239 | 仪表盘 SPA（pages 19 个路由页、components、lib/api.ts） |
| `apps/shared/src/` | ~70 | `@hermes/shared`：JSON-RPC 客户端、生成契约、slash 评分、i18n/主题工具 |
| `apps/bootstrap-installer/` | 少量 | Tauri 壳（src-tauri/）+ Vite/React 首启安装 UI |

## TS 约定摘要

根 `AGENTS.md` 给 TS 端的一行式约定（展开见 `ts_conventions.md`）：

- feature 自有 nanostores 优于穿线状态；
- 薄路由根；
- 窄 hooks 与同址（colocated）action 模块；
- props 与共享形状用 `interface`；
- 表驱动派发优于条件阶梯；
- `src/app` 路由、`src/store` 原子、`src/lib` 纯函数。

## 与其他模块的关系

- **`tui_gateway/`（08 章）**：TS 端全部表面共同的后端。契约从这里生成，事件从这里流出；改 `tui_gateway/` 的一行代码，四个界面同时受影响。
- **`hermes_cli/`（06 章）**：`commands.py` 的 `CommandDef.desktop=` 字段决定桌面 slash palette 的策展；`web_server.py`/`web_routers/` 伺服 `web/` 的构建产物并承载 PTY 桥。
- **`plugins/`（09 章）**：桌面 `src/plugins/` 是**界面级插件**（hermes-bots、kanban、radio），与 agent 插件体系是两回事——"plugin" 在 Hermes 里一词多义，不要假设一个表面的扩展模型能跑在另一个上。
- **`pm/`（11 章）**：TS 包经 pnpm workspace 安装依赖（workspace 依赖在仓库根安装）；`HERMES_PYTHON` 是 TUI 反查解释器的唯一信任来源。

## 总结

TS 端的设计哲学可以压缩成三句话：

1. **一协议，四投影**——所有界面连同一个 canonical 网关，契约由 Python 生成给 TypeScript，编译器替你守卫前后端一致性。
2. **渲染器永远薄**——屏幕归 TS，行为归 Python；想给聊天加能力时，正确的动作是加一个 RPC 方法，不是在 React 里重写它。
3. **共享层只在被两个真实消费者证明时才生长**——`@hermes/shared` 里每一样东西都有多个表面在用，没有为单一消费者发明的"框架"。
