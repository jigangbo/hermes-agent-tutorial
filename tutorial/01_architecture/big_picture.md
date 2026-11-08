# 全局架构总览

> 阅读前提：你已经读过 [背景知识](../00_background_knowledge.md)，知道什么是 agent 循环。

## 一张图看懂 Hermes

```
┌────────────────────────── 用户触达层（4 种壳） ──────────────────────────┐
│                                                                          │
│   CLI (prompt_toolkit)    TUI (ui-tui, Ink/Node)    Desktop (Electron)   │
│   cli.py + 16 个 mixin    JSON-RPC 客户端            src/app 路由 + Bot  │
│        │                        │                        │               │
│        └────────────┬───────────┴────────────┬───────────┘               │
│                     │  WebSocket /api/ws     │                            │
│                     │  协议 "hermes-gateway-v1" (JSON-RPC)                │
│           ┌─────────▼────────────────────────▼─────────┐                 │
│           │  26 个消息平台插件 (plugins/platforms/)      │                │
│           │  Telegram / Discord / Slack / 飞书 / 微信…   │                │
│           │  + 3 个内置: webhook / msgraph / api_server │                 │
│           └─────────────────┬───────────────────────────┘                 │
└─────────────────────────────┼─────────────────────────────────────────────┘
                              ▼
┌────────────────────── 网关进程（唯一 owner） ─────────────────────────────┐
│  gateway/run.py::GatewayRunner（19 个 mixin 组成）                        │
│    ├─ 适配器生命周期 + 重连（run_adapters.py）                            │
│    ├─ 入站管线：run_inbound.py → session_ingress.py 接纳                  │
│    ├─ SessionAuthority：每会话 durable FIFO 排队（session_authority.py）  │
│    ├─ 每会话 turn 串行化：turn_lease.py（租约，fail-closed）              │
│    ├─ turn 执行：turn_executor.py::_UnboundedThreadExecutor              │
│    │   （每 turn 一个线程，无上限；复用线程重置 contextvars）             │
│    └─ 流式回传：stream_consumer.py（增量 → 平台消息逐步编辑）             │
└─────────────────────────────┬─────────────────────────────────────────────┘
                              ▼
┌────────────────────── agent 核心（窄腰） ─────────────────────────────────┐
│  run_agent.py::AIAgent —— 14 个 mixin 的门面，真正的循环在 agent/：        │
│    conversation_loop.py（turn 循环心脏）                                  │
│      ├─ turn_*.py × 33：一个 turn 的每个阶段一个文件                      │
│      ├─ system_prompt.py：三层系统提示词（会话期内字节稳定）              │
│      ├─ tool_executor.py：工具执行（段规划器 + 8 worker 并行）            │
│      ├─ context_compressor.py：上下文压缩（默认 50% 阈值）                │
│      ├─ auxiliary_client.py（8,281 行）：一切"副 LLM 任务"的解析与调用    │
│      └─ memory_manager.py：记忆提供方编排                                 │
└───────────┬──────────────────────────┬─────────────────┬─────────────────┘
            ▼                          ▼                 ▼
┌──── 工具层 ────┐          ┌──── 模型提供方 ────┐   ┌──── 插件 ────┐
│ tools/registry │          │ providers/ (声明式) │   │ plugins/     │
│ toolsets.py    │          │ agent/transports/   │   │ 5 类发现机制 │
│ model_tools.py │          │ (chat_completions/  │   │ + 插件目录   │
│ (编排/审批)    │          │  anthropic/codex/   │   │ plugin-catalog│
└────────────────┘          │  bedrock)           │   │ (SHA 锁定)   │
                            └─────────────────────┘   └──────────────┘
                              ▼
┌────────────────────── 状态层（每 profile 一个家） ────────────────────────┐
│  ~/.hermes/<profile>/state.db —— SQLite WAL（多读一写）                   │
│  hermes_state.py::SessionDB（17 mixin 门面）+ 66 个 hermes_state_* 兄弟   │
│    ├─ 会话/消息/标题/时间线        ├─ mutation 回执（一次事务一个动作）   │
│    ├─ 压缩谱系 parent_session_id   ├─ FTS5 全文检索                       │
│    └─ WAL/锁/持有者/修复                                                  │
└───────────────────────────────────────────────────────────────────────────┘
```

## 关键架构事实（逐条展开）

### 1. 网关是唯一的执行 owner，其他一切都是"查看者"

这是全项目最重要的运行时事实：**CLI 进程从不构建 agent、从不执行工具、从不写 state.db**。

- 经典 CLI 走 `hermes_cli/main.py → gateway_chat_startup.launch_gateway_chat`，把自己的输入通过 `prompt.submit` RPC 提交给网关，然后回放网关的事件流（`hermes_cli/gateway_agent.py` 提供一个 AIAgent 兼容外壳）。
- TUI（Ink）从不 spawn 私有 agent，它通过 `ui-tui/scripts/gateway_bootstrap.py` 附加到本 profile 的共享网关 owner（必要时按需拉起，空闲自动退出）。
- Desktop 与 dashboard `/chat` 谈的是同一个 `hermes-gateway-v1` JSON-RPC 协议。
- ACP（编辑器协议）会话同样只是查看者（`gateway/session_acp_lifecycle.py`）。

为什么这样设计？因为 **同一个会话可能同时被多个表面打开**（比如手机 Telegram 上继续电脑上聊到一半的会话），如果每个表面各自持有 agent 副本，会话状态会立刻分叉。单一 owner + 事件流广播让"谁在看"和"谁在跑"彻底解耦。

### 2. 一个 turn 在网关侧的串行化

消息从平台到达后并不是立刻执行：

```
平台事件 → 适配器收包 → run_inbound 预处理 → session_ingress 接纳
        → SessionAuthority durable FIFO（跨进程可恢复的队列）
        → turn_lease（按 resolved session_id 串行化 load→run→flush）
        → _UnboundedThreadExecutor 每 turn 一个线程
        → agent 循环（见 turn_lifecycle.md）
        → 流式/最终回复 → delivery.py 路由发送 → 落盘
```

两个容易被误读的点：
- `_UnboundedThreadExecutor` 故意**不是** `ThreadPoolExecutor`（后者默认上限 `min(32, cpu+4)`）——每个提交的 turn 立刻在自己的线程上启动；复用的 parked worker 会先经 `turn_thread_reset.reset_reused_thread_state()` 清理线程级状态。
- busy 保护按**路由键**（platform:chat_id），而转录由 **session_id** 拥有，两者是多对一关系 —— 所以需要 turn_lease 在 session_id 粒度上再串行化一次。

### 3. facade + siblings：每个前神文件都是"门面 + 主题兄弟"

仓库经历过大规模拆分，形成统一模式：`<stem>.py` 是门面（公共入口 + 兼容导出），`<stem>_<topic>.py` 每个文件拥有一个主题。四个代表：

| 门面 | 兄弟文件数 | 循环规则 |
|------|-----------|---------|
| `run_agent.py`（1,565 行） | `agent/` 423 文件 | 兄弟在函数内 late-import 门面 |
| `cli.py`（1,792 行） | `hermes_cli/` 843 文件 | 16 个 `cli_*_mixin.py` 组成 HermesCLI |
| `gateway/run.py`（5,204 行） | `gateway/` ~200 顶层文件 | 19 个 mixin 组成 GatewayRunner |
| `hermes_state.py`（1,738 行） | 66 个 `hermes_state_*.py` | 17 个 mixin 组成 SessionDB |

给读者的实用推论：**找代码按主题 grep**（`grep -rn "def 名字" <dir>/<stem>_*.py`），而不是通读门面；**打补丁打在生产读取处**（兄弟函数内 `from <门面> import 名字` 使门面成为 seam，patch 在定义模块上会静默失效）。

### 4. 一切状态按 profile 隔离，而进程按宿主共享

每个 profile 一个 `HERMES_HOME`（各自的 state.db、config.yaml、日志）。但进程是共享的：**一个网关进程可以同时服务多个 profile**（multiplex 模式，默认开启）。于是产生了全仓库的头号 bug 类别 —— 非 turn 期代码（ticker、RPC 方法、线程跳转、子进程）读到的是**启动 profile** 的环境。防御手段是显式绑定：`hermes_state_registry.py` 按 resolved 路径 refcount 共享 SessionDB；cron 的 ticker 在 `_profile_cron_scope(home)` 下逐个 profile 迭代；tui_gateway 的每个状态方法都跑在 `@_profile_scoped` 下。

### 5. 生成式契约：Python 是唯一权威，TS 端是投影

跨语言接口不靠人肉同步：`tui_gateway/contracts/` 里每个 RPC 方法都有 Pydantic 声明，`scripts/gen_gateway_contracts.py` 生成 `apps/shared/src/gateway-contract.generated.ts`，陈旧性测试在 CI 失败。同样的模式还有桌面 slash 注册表（`scripts/dump_desktop_slash_registry.py`）。改协议只改 Python 一侧。

## 分层与文档映射

| 层 | 核心源码 | 教程目录 |
|----|---------|---------|
| 用户触达 | `cli.py`、`ui-tui/`、`apps/desktop/`、`web/` | 06、08、15 |
| 网关 | `gateway/` | 05 |
| agent 核心 | `run_agent.py`、`agent/` | 02、03 |
| 工具 | `tools/`、`model_tools.py`、`toolsets.py` | 02、04 |
| 模型提供方 | `providers/`、`agent/transports/`、`agent/auxiliary_client.py` | 03 |
| 状态 | `hermes_state*.py` | 07 |
| 扩展机制 | `plugins/`、`skills/`、`plugin-catalog/` | 09、12 |
| 调度 | `cron/`、`hermes_cli/kanban*.py` | 10 |
| 环境 | `pm/`、`hermes_platform/` | 11、13 |
