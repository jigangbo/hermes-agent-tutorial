# Hermes-Agent 源码教程 — 从入门到精通

**Hermes** 是一个个人 AI 代理：同一套 agent 核心跑在 **CLI、消息网关（Telegram/Discord/Slack/飞书/微信等 26+ 平台）、TUI、Electron 桌面应用** 四种壳上。它跨会话学习（记忆 + 技能）、委派子代理、运行定时任务、驱动真实终端与浏览器。它主要通过**插件与技能**扩展，而不是把核心做大。

本教程覆盖约 2,600 个产品源文件：核心承重文件逐一精讲（含真实代码走读），其余文件全部纳入各模块的清单表 —— 每个文件都有归属。

## 快速开始

- 零基础 → 先读 [背景知识](00_background_knowledge.md)（什么是 agent 循环、术语词典）
- 急于建立全局 → [全局架构总览](01_architecture/big_picture.md) → [一次对话的完整生命周期](01_architecture/turn_lifecycle.md)
- 想按路径学 → [阅读指南](00_reading_guide.md)（快速通道 ~2 小时 / 完整路径 / 主题式）

---

## 全局架构图

```
┌──────────────────── 用户触达层（4 种壳） ────────────────────────┐
│  CLI (prompt_toolkit)   TUI (Ink/Node)   Desktop (Electron)      │
│         └────────────── JSON-RPC "hermes-gateway-v1" ──────┐     │
│  26 个消息平台插件 (plugins/platforms/)                     │     │
│  + 3 个内置 (webhook/msgraph/api_server)                    ▼     │
├────────────────── 网关进程（唯一执行 owner） ────────────────────┤
│  GatewayRunner：适配器生命周期 → 入站管线 → SessionAuthority      │
│  durable FIFO → 每会话 turn_lease → 每 turn 一线程执行            │
├──────────────────── agent 核心（窄腰） ──────────────────────────┤
│  AIAgent 门面 → conversation_loop → turn 管线（33 个阶段文件）    │
│  系统提示词（字节稳定）│ 工具执行 │ 压缩引擎 │ 辅助 LLM │ 记忆    │
├───────── 工具层 ─────────┬─── 模型层 ─────────┬─── 插件/技能 ────┤
│ tools/registry 自注册    │ providers/ 声明式   │ plugins/ 5 类    │
│ toolsets 过滤+门控       │ transports/ 4 协议  │ skills/ 43 内置  │
│ model_tools 编排+审批    │ auxiliary_client    │ plugin-catalog   │
├──────────────────────── 状态层 ───────────────────────────────────┤
│  state.db (SQLite WAL) ← SessionDB 门面 + 66 个主题兄弟文件       │
│  会话谱系 / mutation 回执 / FTS5 / 锁与健康                       │
└───────────────────────────────────────────────────────────────────┘
```

## 主工作流：一条消息的生命周期

```
(1) 用户在任意表面发送消息
(2) 壳层/平台适配器收包 → MessageEvent          gateway/platforms/event.py
(3) 入站管线：预处理+授权+bot 回环守卫          gateway/run_inbound.py
(4) 接纳与排队：durable FIFO                    gateway/session_ingress.py, session_authority.py
(5) turn 准入：每会话租约 + 每turn一线程         gateway/turn_lease.py, turn_executor.py
(6) turn 上下文：系统提示词+起始压缩             agent/turn_context.py
(7) 迭代循环：组装请求（缓存最后定版）           agent/turn_request_assembly.py
(8) 模型调用（流式/非流式，重试+恢复）           agent/turn_api_call.py, chat_completion_helpers.py
(9) 有工具调用？→ 校验→先持久化→执行→结果回填   agent/turn_tool_round.py, tool_executor.py
(10) 纯文本回复 → 终止门 → finalize             agent/turn_final_response.py, turn_finalizer.py
(11) 流式回传：增量逐步编辑平台消息              gateway/stream_consumer.py
(12) 投递路由 + 落盘 + 记忆同步                  gateway/delivery.py, gateway/session.py
```

## 代码到流程映射表

| 步骤 | 源文件 | 教程文档 |
|------|--------|---------|
| 壳层接入 | `cli.py`、`ui-tui/`、`apps/desktop/` | [cli](06_cli/index.md) · [tui_gateway](08_tui_gateway/index.md) · [desktop](15_typescript/desktop_overview.md) |
| 平台适配器 | `plugins/platforms/*/adapter.py` | [platform_adapters](05_gateway/platform_adapters.md) |
| 入站管线 | `gateway/run_inbound.py` | [message_flow](05_gateway/message_flow.md) |
| 接纳排队 | `gateway/session_authority.py` | [sessions_authority](05_gateway/sessions_authority.md) |
| turn 准入 | `gateway/turn_lease.py`、`turn_executor.py` | [turn_machinery](05_gateway/turn_machinery.md) |
| turn 上下文 | `agent/turn_context.py` | [turn_pipeline](03_agent/turn_pipeline.md) |
| 请求组装 | `agent/turn_request_assembly.py` | [turn_pipeline](03_agent/turn_pipeline.md) · [caching](01_architecture/caching_invariants.md) |
| 模型调用 | `agent/turn_api_call.py`、`agent/transports/` | [model_providers](03_agent/model_providers.md) |
| 工具执行 | `model_tools.py`、`agent/tool_executor.py`、`tools/` | [tool_system](01_architecture/tool_system.md) · [04_tools](04_tools/index.md) |
| 压缩 | `agent/context_compressor.py` | [compression](03_agent/compression.md) |
| 流式回传 | `gateway/stream_consumer.py` | [streaming](05_gateway/streaming.md) |
| 状态落盘 | `hermes_state*.py` | [state_model](01_architecture/state_model.md) · [07_state](07_state/index.md) |

## 模块索引

| 目录 | 内容 | 文档数 |
|------|------|--------|
| [00 背景与导读](00_reading_guide.md) | 领域背景、术语词典、三条阅读路径 | 2 |
| [01 系统架构专题](01_architecture/index.md) | 全局架构/turn 生命周期/缓存不变量/状态模型/工具系统/安全模型 | 7 |
| [02 核心门面层](02_core/index.md) | run_agent、model_tools、toolsets、cli、hermes_state 等根目录门面 | 11 |
| [03 agent 核心循环](03_agent/index.md) | 主循环、turn 管线、系统提示词、模型层、压缩、记忆、委派… | 21 |
| [04 工具系统](04_tools/index.md) | 注册表、审批安全、文件终端、浏览器、MCP、委派、语音媒体… | 14 |
| [05 消息网关](05_gateway/index.md) | GatewayRunner、消息流、平台适配器、流式、turn 机制 | 10 |
| [06 命令行层](06_cli/index.md) | REPL mixin、slash 注册表、配置、子命令、web_routers、更新 | 12 |
| [07 状态持久化](07_state/index.md) | WAL、mutation 回执、会话消息、锁、检索维护 | 8 |
| [08 TUI 网关](08_tui_gateway/index.md) | 进程模型、JSON-RPC 契约、slash 流 | 5 |
| [09 插件系统](09_plugins/index.md) | 5 类插件、插件 API、目录准入、内置插件 | 5 |
| [10 定时任务](10_cron/index.md) | 调度器、任务定义、看板派发 | 4 |
| [11 包管理环境](11_pm/index.md) | PM 环境、钉版策略 | 3 |
| [12 技能系统](12_skills/index.md) | 技能格式、策展人 | 3 |
| [13 平台事实层](13_hermes_platform/index.md) | 主机事实、无副作用解析器 | 2 |
| [14 ACP 适配器](14_acp_adapter/index.md) | 编辑器协议接入 | 2 |
| [15 TypeScript 端](15_typescript/index.md) | Desktop、ui-tui、web 仪表盘、共享契约 | 7 |
| [16 开发实践](16_dev_guide/index.md) | 环境搭建、测试、代码健康门禁、贡献准则 | 5 |

## 这套教程能带你练到什么

- **架构能力**：门面+兄弟拆分、进程模型与多租户作用域、生成式跨语言契约 —— 都是大仓库演进的实战模式；
- **上下文工程**：prompt caching 不变量、压缩引擎、层级化系统提示词 —— LLM 应用最贵的资源怎么管；
- **可靠性工程**：mutation 回执事务、fail-closed 租约、恢复阶梯、崩溃后取证 —— agent 长跑不散架的秘密；
- **安全工程**：审批管线、SSRF/路径守卫、SHA 锁定的插件供应链 —— 见 [安全边界模型](01_architecture/security_model.md)。

> 本教程由 AI 从源码生成；每篇文档都注明了出处文件与行号，读时请打开源码对照。
