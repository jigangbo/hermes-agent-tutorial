# 15.5 apps/shared 与 bootstrap-installer —— 共享契约层与首启安装器

## 概览

本章覆盖 `apps/` 下两个"为别人服务"的成员。

- **`apps/shared/`** 是 npm 包 `@hermes/shared`：desktop、web、TUI 共用的 JSON-RPC 网关客户端、生成的 wire 契约与一批跨表面纯工具——它是"一协议"能够成立的物理载体。
- **`apps/bootstrap-installer/`** 是首启安装器：一个 Tauri 壳（`src-tauri/`，Rust）包着 Vite/React UI 的小型独立 app，负责用户第一次接触 Hermes 时的引导安装。

两者共同点：不拥有任何用户会话，不做 UI 主表面，却是 TS 端其他模块能保持薄的前提。

## apps/shared：@hermes/shared

包名 `@hermes/shared`（`apps/shared/package.json:2`），`src/` 约 70 个文件，几乎每个纯工具都带同名 `.test.ts`。

按职责分组：

| 分组 | 文件 | 消费者 |
|------|------|--------|
| JSON-RPC 通道 | `json-rpc-channel.ts`、`json-rpc-gateway.ts`（864 行）、`reconnect-backoff.ts`、`websocket-url.ts`、`gateway-types.ts`、`backend-scope.ts` | desktop 与 ui-tui 的连接层 |
| 生成 wire 契约 | `gateway-contract.generated.ts`、`gateway-contract.openrpc.json`、`gateway-canonical.ts` | 全部表面的类型基础 |
| 事件层 | `gateway-events.ts`（客户端本地合成事件 + `GatewayEvent` 信封，叠加在生成物之上） | desktop 事件汇入点、TUI `createGatewayEventHandler.ts` |
| slash 工具 | `slash.ts`、`slash-score.ts`、`slash-input.ts` | 三个表面共用的命令评分与输入解析 |
| catalog / billing | `catalog-browse.ts`、`catalog-curation.json`、`catalog-featured.ts`、`catalog-install.ts`、`billing-policy.ts`、`billing-types.ts`、`plan-usage.ts`、`charge-settlement.ts`、`usage-tick.ts` | desktop 与 web 的插件目录、计费视图 |
| i18n / 主题 | `i18n.ts`、`theme-presets.ts`、`skin.ts`、`color.ts`、`translucency.ts`、`ansi.ts` | 三表面统一的多语言与配色底座 |
| 文本与格式 | `format.ts`、`fuzzy.ts`、`interpolation.ts`、`gateway-text.ts`、`model-search-text.ts`、`provider-names.ts`、`reasoning-effort.ts`、`circular-buffer.ts` | 跨表面纯函数 |
| URL / 安全 | `external-url.ts`、`file-url.ts`、`data-url-read-max.ts`、`hermes-cloud.ts` | guest 内容与云连接的边界检查 |
| 杂项 | `skill-scaffold.ts`、`cron-trigger-controller.ts`、`session-http-mutations.ts`、`update-debt.ts`、`node/`（Node 侧辅助） | 按需引用 |

### JsonRpcGatewayClient：唯一的 WS 客户端

desktop 与 TUI 都不自研传输，都汇到同一个类：

```ts
// apps/shared/src/json-rpc-gateway.ts:140
export class JsonRpcGatewayClient { ... }
```

它封装了协议的三种帧形态：

| 帧形态 | 方向 | 例子 |
|--------|------|------|
| 方法调用 | client→server | `prompt.submit`、`session.list` |
| **请求**（必须应答） | server→client | `approval`、`clarify`、`sudo`、`secret` —— 走 `onRequest` 回调 |
| 事件通知 | server→client | `message.delta`、`tool.start` |

两个表面的接入姿势：

- TUI 的 `gatewayClient.ts` 把 `localGatewayBootstrap.ts` 的 bootstrap 结果作为 `connect` 注入；
- desktop 由 Electron 侧喂给它 ensure --json + ticket 的连接信息。

重连与重放也在这一层，因此三个表面天然行为一致：

- `reconnect-backoff.ts` —— 有界的重连退避；
- `json-rpc-gateway-replay.test.ts` —— 事件重放（重连后补发错过的 `message.delta` 等）；
- `json-rpc-gateway-legacy-replay.test.ts` —— legacy 客户端的重放兼容路径；
- `gateway-text.ts` / `circular-buffer.ts` —— 事件文本处理与环形缓冲。

**共享的准入标准**很严：设计一个共享契约，只在多于一个真实消费者证明其形状之后。

`@hermes/shared` 里没有为单一消费者发明的抽象——这也是它只有 ~70 个文件而能服务三个表面的原因。

## bootstrap-installer：Tauri 首启安装器

```
apps/bootstrap-installer/
├── src-tauri/                 # Tauri 壳（Rust）
│   ├── Cargo.toml             # Rust 依赖
│   ├── tauri.conf.json        # Tauri 配置（窗口、能力、打包）
│   ├── capabilities/          # Tauri 能力声明（最小授权）
│   ├── hermes-setup.manifest  # Windows 安装清单
│   ├── entitlements.plist / Info.plist  # macOS 沙盒与属性
│   └── icons/
└── src/                       # Vite/React UI（与主 TS 约定同构）
    ├── app.tsx + main.tsx     # 入口（薄路由根）
    ├── routes/                # 安装步骤路由
    ├── components/            # 步骤组件
    ├── lib/                   # 纯辅助
    ├── store.ts               # nanostores 安装状态
    └── theme.ts / styles.css  # 主题
```

设计要点：

- **独立 app**：自己的 `package.json`、`vite.config.ts`、`tsconfig.json`（还有 `tsconfig.node.json`）——安装器只在首启存活，不该背主应用运行时的任何依赖。
- **UI 复用主仓约定**：nanostores 状态（`store.ts`）、薄路由根（`routes/`）、`interface` 形状——维护者零学习成本。
- **原生交互全在 Rust 侧**：与系统交互的部分下沉到 Tauri，JS 面不碰原生能力；`capabilities/` 声明最小授权。
- **跨平台打包线索**：Windows 用 MSIX 清单（`hermes-setup.manifest`），macOS 有 entitlements/plist。

它存在的理由：desktop 主 app 假设 Hermes 已经装好；而"第一次把 Hermes 装进机器"这一步没有 Node/Electron 可依赖——Tauri 的小体积二进制正是为这个鸡生蛋时刻准备的。

## 生成契约流在 shared 的落点

把契约闭环放到本包视角再看一遍：

```
tui_gateway/contracts/*.py（Pydantic，单一事实源）
        │  scripts/gen_gateway_contracts.py
        ▼
apps/shared/src/gateway-contract.generated.ts   ← 汇点：全部 RPC 类型
        │
        ├─ ui-tui/src/…        tsc 报字段移动
        ├─ apps/desktop/src/…  tsc 报字段移动
        └─ web/src/…           tsc 报字段移动
```

教训是单向的：**不要手改 `.generated.ts`**——改 Python 模型再重新生成；陈旧的生成物会被 `tests/tui_gateway/contracts/test_generated.py` 抓住。

## 目录结构

| 主要子目录 | 文件数 | 角色 |
|-----------|------|------|
| `apps/shared/src/` | ~70 | `@hermes/shared`：契约、客户端、跨表面工具（几乎全带测试） |
| `apps/shared/src/node/` | 少量 | 仅 Node 侧可用的辅助（TUI/desktop main 用） |
| `apps/bootstrap-installer/src/` | 少量 | 安装器 React UI（routes/components/lib/store） |
| `apps/bootstrap-installer/src-tauri/` | Rust 工程 | Tauri 壳：窗口、能力声明、跨平台打包 |

## 与其他模块的关系

- **`tui_gateway/contracts/`**：`gateway-contract.generated.ts` 的源头。改 Pydantic 模型 → 重新生成 → 三个消费者的 `tsc` 同时报字段移动。本包是契约流的**汇**（见 `index.md`）。
- **`apps/desktop` / `ui-tui` / `web`**：三个直接依赖者；任何被两个以上表面需要的东西才配进 shared。
- **`pm/`（11 章）**：pnpm workspace 管理；workspace 依赖在仓库根安装（desktop 的测试说明里明确提示这一点）。
- **`scripts/gen_gateway_contracts.py` / `dump_desktop_slash_registry.py`**：TS 端两大生成物的生成器。

## 总结

apps/shared 证明了"共享层薄"与"复用面广"可以兼得：靠 Python 生成物兜住类型一致性，靠"两个真实消费者才准入"挡住投机抽象。

bootstrap-installer 则示范了边缘工具的形态：独立 app、最小授权、复用主仓约定。

一句话记住它们：

**shared 是契约的物理载体，installer 是用户的第一屏，两者都不拥有会话。**
