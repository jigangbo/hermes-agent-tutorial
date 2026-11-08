# 阅读指南 —— 三条学习路径

> 本套教程共 16 个模块、约 122 篇文档，从零基础领域知识一路讲到动手贡献。本篇是你的地图：先讲清教程结构，再给出三条学习路径（快速通道 / 完整路径 / 主题式），最后附全部文档的一句话索引。
>
> 如果你还没有读过[背景知识](00_background_knowledge.md)，请先读它——后面所有文档默认你已经掌握其中的术语。

---

## 1. 教程结构说明

教程按"模块"组织，编号即依赖顺序：数字越小越靠近地基，数字越大越靠近外围与动手实践。

```text
tutorial/
├── 00_background_knowledge.md   # 背景知识：领域概念地基（先读我）
├── 00_reading_guide.md          # 阅读指南：本篇
│
├── 01_architecture/             # 01 架构专题 —— 横向切分系统，7 篇
│   ├── index.md
│   ├── big_picture.md
│   ├── turn_lifecycle.md
│   ├── caching_invariants.md
│   ├── state_model.md
│   ├── tool_system.md
│   └── security_model.md
│
├── 02_core/                     # 02 核心门面层 —— 根目录门面文件，11 篇
├── 03_agent/                    # 03 agent 核心循环 —— 系统的心脏，22 篇
├── 04_tools/                    # 04 工具系统 —— agent 的手脚，13 篇
├── 05_gateway/                  # 05 消息网关 —— 约 20 个平台接入，10 篇
├── 06_cli/                      # 06 命令行层 —— REPL 与子命令，12 篇
├── 07_state/                    # 07 状态持久化层 —— SQLite 状态库，8 篇
├── 08_tui_gateway/              # 08 TUI 网关 —— 进程模型与 RPC，5 篇
├── 09_plugins/                  # 09 插件系统 —— 能力生态，5 篇
├── 10_cron/                     # 10 定时调度 —— cron 与看板，4 篇
├── 11_pm/                       # 11 包管理环境 —— PM 与依赖钉版，3 篇
├── 12_skills/                   # 12 技能系统 —— 程序性记忆，3 篇
├── 13_hermes_platform/          # 13 平台事实层 —— 跨主机兼容，2 篇
├── 14_acp_adapter/              # 14 ACP 适配器 —— 编辑器接入，2 篇
├── 15_typescript/               # 15 TypeScript 端 —— 桌面/TUI/Web，7 篇
└── 16_dev_guide/                # 16 开发实践 —— 环境与贡献，5 篇
```

各模块的主题一句话概括：

| 模块 | 主题 |
|---|---|
| 00 基础 | 领域背景知识 + 阅读指南（本篇） |
| 01 架构专题 | 不按目录、按主题横向切分：全局架构、turn 生命周期、缓存不变量、状态模型、工具全景、安全模型 |
| 02 核心门面 | 仓库根目录的门面文件（run_agent.py、model_tools.py、cli.py、hermes_state.py 等）及其兄弟文件布局 |
| 03 agent 核心 | turn 循环与一切运行时机制：提示词组装、模型接入、压缩、缓存、记忆、技能、流式、工具执行、子代理 |
| 04 工具系统 | 内置工具的实现：注册表、文件/终端、网页/浏览器、执行环境、桌面控制、MCP |
| 05 消息网关 | `hermes gateway`：多平台适配、消息守卫、会话路由、流式与通知 |
| 06 命令行层 | `hermes` CLI：REPL、斜杠命令注册表、配置与皮肤、各类子命令 |
| 07 状态持久化 | SessionDB：WAL 并发写、会话与消息、锁、后台 worker、FTS5 检索 |
| 08 TUI 网关 | TUI 的进程模型：Python 后端与界面渲染进程之间的 JSON-RPC |
| 09 插件系统 | 插件种类、公共 API、目录准入、内置插件盘点 |
| 10 定时调度 | cron 调度器、任务数据模型、看板分发器 |
| 11 包管理环境 | PM 自研包管理：环境模型、依赖钉版与供应链防护 |
| 12 技能系统 | SKILL.md 格式与 agent 自动策展技能的机制 |
| 13 平台事实层 | hermes_platform：主机事实与可执行文件解析的统一出口 |
| 14 ACP 适配器 | 编辑器/IDE 通过 ACP 协议驱动 agent |
| 15 TypeScript 端 | 桌面应用、终端 TUI、Web 仪表盘及共享基建与 TS 约定 |
| 16 开发实践 | 环境搭建、测试、代码健康棘轮、贡献流程 |

---

## 2. 三条学习路径

### 路径 A：快速通道（约 2 小时）

| 顺序 | 文档 | 预计用时 |
|---|---|---|
| 1 | [背景知识](00_background_knowledge.md) | 20 分钟 |
| 2 | [全局架构总览 big_picture](01_architecture/big_picture.md) | 25 分钟 |
| 3 | [一次对话的完整生命周期 turn_lifecycle](01_architecture/turn_lifecycle.md) | 30 分钟 |
| 4 | [主循环精读 conversation_loop](03_agent/conversation_loop.md) | 30 分钟 |
| 5 | [工具系统总览](04_tools/index.md) | 15 分钟 |
| 6 | 合上文档，凭记忆重画两张图（全局架构分层 + turn 循环）；画不出来就回去重读对应章节 | 15 分钟 |

**适合谁**：时间紧张的工程师；想先判断"这个项目值不值得深入"的人；只需对系统有"够用"理解的贡献者。

**读完你应当能够**：画出全局架构分层图；说清一条消息从进入到落盘的每一步；知道工具从哪里注册、在哪里执行。

### 路径 B：完整学习路径（00 → 16，按模块顺序）

推荐顺序与理由如下。核心思想是：**先拿地图，再看零件，然后精读心脏，最后逛外围**。

| 阶段 | 顺序 | 模块 | 为什么排在这个位置 |
|---|---|---|---|
| 1 | 00 | 背景知识 + 本篇 | 术语地基；后面所有文档默认你已读过 |
| 2 | 01 | 架构专题（7 篇） | 先建立全局地图再钻细节，才不会迷路；最重要的"缓存不变量"在这里建立 |
| 3 | 02 | 核心门面层（11 篇） | 根目录门面文件是所有模块的"入口清单"，读完知道系统有哪些零件、各自住在哪 |
| 4 | 03 | agent 核心（22 篇） | 系统的心脏、文档最多的模块；有了 01/02 的铺垫，精读主循环事半功倍 |
| 5 | 04 | 工具系统（13 篇） | agent 的手脚；理解"注册-发现-执行"链路后，工具相关的一切都能自查 |
| 6 | 05 | 消息网关（10 篇） | 最复杂的壳：异步消息、会话路由、平台适配，顺带反哺对核心并发模型的理解 |
| 7 | 06 | 命令行层（12 篇） | 第二复杂的壳，也是用户接触最多的入口；顺带讲清配置系统与皮肤引擎 |
| 8 | 07 | 状态持久化（8 篇） | 数据怎么存、怎么并发安全；为理解 cron、记忆、全文检索打底 |
| 9 | 08-14 | 外围模块（TUI 网关、插件、cron、PM、技能、平台层、ACP） | 核心已通，外围按依赖逐个击破；其中插件（09）建议优先——它是 Hermes 的能力生态 |
| 10 | 15 | TypeScript 端（7 篇） | 三个界面（桌面/TUI/Web）与 Python 后端的 RPC 边界，补全"四种壳"的另一半 |
| 11 | 16 | 开发实践（5 篇） | 环境、测试、代码健康棘轮——把知识变成动手贡献 |

节奏建议：每天 1-2 篇，读必配源码（见第 4 节）；读完 03 后做一次全流程复盘——自己画出 turn 循环的每个阶段，再与文档对照。

### 路径 C：主题式路径（按兴趣直达）

| 你的目标 | 推荐路径 |
|---|---|
| 想做插件 | [背景知识](00_background_knowledge.md) → [big_picture](01_architecture/big_picture.md) → [09 总览](09_plugins/index.md) → [插件 API](09_plugins/plugin_api.md) → [目录准入](09_plugins/catalog.md) → [边界治理](09_plugins/boundary_lint.md) → [16 总览](16_dev_guide/index.md) → [环境搭建](16_dev_guide/env_setup.md) → [贡献流程](16_dev_guide/contribution.md) |
| 想懂消息平台 | [背景知识](00_background_knowledge.md) → [05 总览](05_gateway/index.md) → [网关主流程 run](05_gateway/run.md) → [消息流转](05_gateway/message_flow.md) → [适配器框架](05_gateway/platforms_framework.md) → [平台适配器解剖](05_gateway/platform_adapters.md) → [turn 机制](05_gateway/turn_machinery.md) → [流式与通知](05_gateway/streaming.md) |
| 想懂上下文工程与缓存 | [turn 生命周期](01_architecture/turn_lifecycle.md) → [缓存不变量](01_architecture/caching_invariants.md) → [提示词缓存](03_agent/prompt_caching.md) → [上下文压缩](03_agent/compression.md) → [系统提示词](03_agent/system_prompt.md) → [压缩的持久化](07_state/compression_state.md) |
| 想懂状态管理 | [状态模型](01_architecture/state_model.md) → [07 总览](07_state/index.md) → [SessionDB 门面](07_state/facade.md) → [WAL 与变更](07_state/wal_mutations.md) → [会话与消息](07_state/sessions_messages.md) → [检索与维护](07_state/search_maintenance.md) |
| 想贡献代码 | [01 总览](01_architecture/index.md)（7 篇全读）→ [02 总览](02_core/index.md) → [16 总览](16_dev_guide/index.md) → [环境搭建](16_dev_guide/env_setup.md) → [测试](16_dev_guide/testing.md) → [代码健康](16_dev_guide/code_health.md) → [贡献流程](16_dev_guide/contribution.md) |

---

## 3. 完整文档索引

全 16 个模块、119 篇文档，每篇一句话。链接均为相对路径，点击直达。

### 01 架构专题（01_architecture/）

| 文档 | 内容一句话 |
|---|---|
| [index](01_architecture/index.md) | 架构专题导读：七篇专题的地图与推荐阅读顺序 |
| [big_picture](01_architecture/big_picture.md) | 全局架构总览：四种壳、一个核心、模型层与状态层的完整图景 |
| [turn_lifecycle](01_architecture/turn_lifecycle.md) | 一次对话从消息进入、循环执行到状态落盘的完整生命周期 |
| [caching_invariants](01_architecture/caching_invariants.md) | 提示词缓存不变量：为什么"不改动过去"是铁律，哪些代码在守护它 |
| [state_model](01_architecture/state_model.md) | 状态与存储模型：SessionDB、config.yaml、记忆文件、技能库各自管什么 |
| [tool_system](01_architecture/tool_system.md) | 工具系统全景：注册、门控、工具集如何分发到四种壳 |
| [security_model](01_architecture/security_model.md) | 安全边界模型：OS 级隔离、审批门、凭证过滤与信任模型 |

### 02 核心门面层（02_core/）

| 文档 | 内容一句话 |
|---|---|
| [index](02_core/index.md) | 根目录门面层总览：每个门面文件的角色与"门面 + 兄弟文件"布局 |
| [run_agent](02_core/run_agent.md) | run_agent.py——AIAgent 门面：对外入口与它如何把工作分发给 agent/ 内部模块 |
| [model_tools](02_core/model_tools.md) | model_tools.py——工具编排：发现内置工具、组装请求工具清单、分发函数调用 |
| [toolsets](02_core/toolsets.md) | toolsets.py——工具集定义：TOOLSETS 字典与 CLI、Telegram 等各平台预设 |
| [cli](02_core/cli.md) | cli.py——HermesCLI 门面：REPL 主循环与斜杠命令分发 |
| [hermes_state](02_core/hermes_state.md) | hermes_state.py——SessionDB 门面：会话数据库的公共入口 |
| [hermes_constants](02_core/hermes_constants.md) | hermes_constants.py——get_hermes_home() 等路径常量：profile 感知的家目录 |
| [bootstrap_logging](02_core/bootstrap_logging.md) | hermes_bootstrap.py + hermes_logging.py——启动引导与日志初始化 |
| [platform_acl](02_core/platform_acl.md) | hermes_dir_acl.py + hermes_startup_watchdog.py——家目录 ACL 与启动看门狗 |
| [utilities](02_core/utilities.md) | hermes_time.py / hermes_yaml.py / utils.py——时间、YAML 与通用工具 |
| [misc_root](02_core/misc_root.md) | trajectory_compressor / batch_runner / registration_lifecycle——轨迹压缩、批量运行与注册生命周期 |

### 03 agent 核心（03_agent/）

| 文档 | 内容一句话 |
|---|---|
| [index](03_agent/index.md) | agent/ 模块总览：分层图与各主题文档导航 |
| [conversation_loop](03_agent/conversation_loop.md) | conversation_loop.py——主循环心脏 run_conversation() 的逐段精读 |
| [turn_pipeline](03_agent/turn_pipeline.md) | turn_*.py 系列——一轮 turn 的分阶段流水线（约 35 个文件） |
| [turn_facade](03_agent/turn_facade.md) | turn_facade.py 系列——turn 门面、租约与存活检测机制 |
| [system_prompt](03_agent/system_prompt.md) | system_prompt.py + prompt_builder.py——系统提示词如何组装（身份、技能、记忆、上下文文件） |
| [model_providers](03_agent/model_providers.md) | provider_* 等——多 provider 接入层（Nous Portal、OpenRouter、Anthropic、Bedrock、Gemini 等） |
| [codex_runtime](03_agent/codex_runtime.md) | codex_* 系列——Codex 运行时的接入与适配 |
| [model_metadata](03_agent/model_metadata.md) | model_metadata* 系列——模型上下文长度、token 估算等元数据 |
| [auxiliary_clients](03_agent/auxiliary_clients.md) | auxiliary_* 系列——辅助模型客户端（摘要、视觉等独立小模型调用） |
| [credentials_rate](03_agent/credentials_rate.md) | credential_* + rate_limit_* + billing_*——凭证管理、限速与计费追踪 |
| [compression](03_agent/compression.md) | context_* + compression_* 系列——上下文压缩的完整实现 |
| [prompt_caching](03_agent/prompt_caching.md) | prompt_cache_* 系列——提示词缓存的守护、刷新与边界 |
| [memory_learning](03_agent/memory_learning.md) | memory_* + learning_* 系列——记忆沉淀与学习闭环 |
| [skills_runtime](03_agent/skills_runtime.md) | skill_* 系列——技能的运行时加载、注入与门控 |
| [streaming_response](03_agent/streaming_response.md) | stream_* + reasoning_* 系列——流式响应与推理输出的处理 |
| [tool_execution](03_agent/tool_execution.md) | tool_* 系列——工具执行、危险命令审批与 shell 钩子 |
| [delegation_subagents](03_agent/delegation_subagents.md) | delegation_* + subagent_* 系列——子代理委派的完整机制 |
| [onboarding_sessions](03_agent/onboarding_sessions.md) | onboarding_* + session_* 系列——引导流程与会话生命周期管理 |
| [errors_resilience](03_agent/errors_resilience.md) | error_* + retry_* + interrupt_* 系列——错误处理、重试与中断恢复 |
| [multimodal_media](03_agent/multimodal_media.md) | image_* / vision / tts / browser_* 系列——多模态与媒体处理 |
| [relay_moa](03_agent/relay_moa.md) | relay_* + moa_* 系列——消息中继与多模型聚合机制 |
| [platform_misc](03_agent/platform_misc.md) | i18n_* / vault_* 等——国际化、凭证保险库与平台杂项 |

### 04 工具系统（04_tools/）

| 文档 | 内容一句话 |
|---|---|
| [index](04_tools/index.md) | tools/ 总览：自注册机制与工具分类地图 |
| [registry](04_tools/registry.md) | registry.py——中央注册表：schema、handler、check_fn 与自动发现 |
| [file_terminal](04_tools/file_terminal.md) | 文件与终端类工具：read_file / write_file / patch / terminal 及其安全护栏 |
| [web_browser](04_tools/web_browser.md) | 网页与浏览器类工具：web_search / web_extract / browser_exec |
| [connectors](04_tools/connectors.md) | connectors/ 目录——外部服务连接器的统一接入 |
| [environments](04_tools/environments.md) | environments/ 目录——终端执行后端（local / docker / ssh / modal / daytona 等） |
| [computer_use](04_tools/computer_use.md) | computer_use/ + bot_desktop/——桌面自动化控制 |
| [mcp](04_tools/mcp.md) | mcp_tool.py——MCP 客户端：配置发现、传输与工具桥接 |
| [delegation_tools](04_tools/delegation_tools.md) | delegate_task 等子代理委派工具：生成、路由与并行 |
| [approval_safety](04_tools/approval_safety.md) | 审批与安全组：危险命令的门、模式库与 SSRF 防线 |
| [messaging_cron](04_tools/messaging_cron.md) | 消息发送与定时任务工具组：send_message、cronjob 与 kanban |
| [skills_memory](04_tools/skills_memory.md) | 技能/记忆/澄清/Todo 工具组：渐进披露与持久记忆 |
| [voice_media](04_tools/voice_media.md) | 语音与媒体生成组：TTS、STT、唤醒词与图像/视频 |

### 05 消息网关（05_gateway/）

| 文档 | 内容一句话 |
|---|---|
| [index](05_gateway/index.md) | gateway/ 总览：网关进程模型与启动架构 |
| [run](05_gateway/run.md) | run.py——GatewayRunner 门面深度走读：启动、收信、turn、忙碌各阶段 |
| [message_flow](05_gateway/message_flow.md) | 消息流转全链路：守卫（guards）、会话路由到最终回复 |
| [platforms_framework](05_gateway/platforms_framework.md) | 适配器框架：BasePlatformAdapter、MessageEvent 与平台注册表 |
| [platform_adapters](05_gateway/platform_adapters.md) | 26 个平台插件与 Telegram 适配器解剖 |
| [builtin_platforms](05_gateway/builtin_platforms.md) | 三个内置 HTTP 平台：webhook、msgraph、api_server |
| [sessions_authority](05_gateway/sessions_authority.md) | 会话索引、路由身份与 durable 接纳权威 |
| [relay](05_gateway/relay.md) | relay 机制：网关↔connector 转发通道 |
| [streaming](05_gateway/streaming.md) | 流式契约、GatewayStreamConsumer 与通知唤醒 |
| [turn_machinery](05_gateway/turn_machinery.md) | turn 租约、无界线程执行器与 agent 缓存 |

### 06 命令行层（06_cli/）

| 文档 | 内容一句话 |
|---|---|
| [index](06_cli/index.md) | CLI 层总览：cli.py + hermes_cli/ 的 mixin 架构 |
| [repl_mixins](06_cli/repl_mixins.md) | cli_*_mixin.py 系列——REPL 的各职责切片（显示、会话、斜杠） |
| [slash_registry](06_cli/slash_registry.md) | commands.py——斜杠命令中央注册表与自动补全 |
| [config_skins](06_cli/config_skins.md) | config.py + skin_engine.py——配置系统与皮肤引擎 |
| [subcommands_core](06_cli/subcommands_core.md) | main.py 等——命令行子命令入口与分发 |
| [web_routers](06_cli/web_routers.md) | web_routers/——仪表盘的 FastAPI 路由 |
| [observability](06_cli/observability.md) | doctor.py 与日志体系——诊断与可观测性 |
| [local_runtime](06_cli/local_runtime.md) | 本地模型运行时与转发代理 |
| [gateway_client](06_cli/gateway_client.md) | CLI↔网关客户端 与 profiles/auth/models |
| [kanban](06_cli/kanban.md) | kanban 看板的 CLI 命令与交互 |
| [web_server](06_cli/web_server.md) | web_server.py——仪表盘服务器门面 |
| [update_system](06_cli/update_system.md) | 更新系统（hermes update） |

### 07 状态持久化层（07_state/）

| 文档 | 内容一句话 |
|---|---|
| [index](07_state/index.md) | 状态持久化层总览：hermes_state_*.py 兄弟文件地图 |
| [facade](07_state/facade.md) | hermes_state.py——SessionDB 门面与公共 API |
| [wal_mutations](07_state/wal_mutations.md) | WAL 写入与状态变更：并发安全的写路径 |
| [sessions_messages](07_state/sessions_messages.md) | 会话与消息的存储：schema、生命周期与标题生成 |
| [compression_state](07_state/compression_state.md) | 压缩状态：摘要如何持久化与恢复 |
| [locks_guards](07_state/locks_guards.md) | 锁与守卫：忙碌锁、令牌锁与并发保护 |
| [search_maintenance](07_state/search_maintenance.md) | FTS5 全文检索与数据库维护 |
| [misc_state](07_state/misc_state.md) | 其余状态模块清单：导出、归档等杂项 |

### 08 TUI 网关（08_tui_gateway/）

| 文档 | 内容一句话 |
|---|---|
| [index](08_tui_gateway/index.md) | tui_gateway/ 总览：TUI 的进程模型 |
| [process_model](08_tui_gateway/process_model.md) | 进程模型：Python 后端与界面渲染进程如何分工 |
| [rpc_transport](08_tui_gateway/rpc_transport.md) | JSON-RPC 传输层：事件流与请求响应协议 |
| [contracts](08_tui_gateway/contracts.md) | 契约即文档：tui_gateway/contracts/ 的 25 个文件 |
| [methods_slash](08_tui_gateway/methods_slash.md) | 方法面导览：34 个 methods_*.py 与 slash worker 机制 |

### 09 插件系统（09_plugins/）

| 文档 | 内容一句话 |
|---|---|
| [index](09_plugins/index.md) | plugins/ 总览：五套发现系统与一条铁律 |
| [plugin_api](09_plugins/plugin_api.md) | 插件公共 API：ctx 与 plugin_api.json 的能力边界 |
| [boundary_lint](09_plugins/boundary_lint.md) | 边界治理：boundary_lint 与"特性离开核心"的迁移表 |
| [catalog](09_plugins/catalog.md) | plugin-catalog/：目录准入规则与提交流程 |
| [bundled_plugins](09_plugins/bundled_plugins.md) | 内置插件盘点：平台适配器、memory、dashboard 等 |

### 10 定时调度（10_cron/）

| 文档 | 内容一句话 |
|---|---|
| [index](10_cron/index.md) | cron/ 总览：调度器的不变量 |
| [scheduler](10_cron/scheduler.md) | 调度器：任务扫描、触发与错过补偿 |
| [jobs](10_cron/jobs.md) | 任务数据模型：job 字段、脚本与注入扫描 |
| [kanban_dispatcher](10_cron/kanban_dispatcher.md) | 看板分发器：kanban 任务如何变成 agent 工作 |

### 11 包管理环境（11_pm/）

| 文档 | 内容一句话 |
|---|---|
| [index](11_pm/index.md) | pm/ 总览：自研包管理的设计理念 |
| [environments](11_pm/environments.md) | PM 环境模型：应用环境、工具仓与开发者工作流 |
| [pinning_policy](11_pm/pinning_policy.md) | 依赖钉版策略：精确钉版、上界与供应链防护 |

### 12 技能系统（12_skills/）

| 文档 | 内容一句话 |
|---|---|
| [index](12_skills/index.md) | skills/ 总览：技能即程序性记忆 |
| [skill_format](12_skills/skill_format.md) | SKILL.md 格式：frontmatter、目录结构与平台门控 |
| [curator](12_skills/curator.md) | 策展器：agent 自动创建与改进技能的机制 |

### 13 平台事实层（13_hermes_platform/）

| 文档 | 内容一句话 |
|---|---|
| [index](13_hermes_platform/index.md) | hermes_platform/ 总览：机器事实层的设计 |
| [facts_resolvers](13_hermes_platform/facts_resolvers.md) | 主机事实与可执行文件解析：跨平台兼容的统一出口 |

### 14 ACP 适配器（14_acp_adapter/）

| 文档 | 内容一句话 |
|---|---|
| [index](14_acp_adapter/index.md) | acp_adapter/ 总览：编辑器接入层 |
| [protocol](14_acp_adapter/protocol.md) | ACP 协议实现：编辑器 / IDE 如何驱动 agent |

### 15 TypeScript 端（15_typescript/）

| 文档 | 内容一句话 |
|---|---|
| [index](15_typescript/index.md) | TypeScript 端总览：桌面 / TUI / Web 三端地图 |
| [desktop_overview](15_typescript/desktop_overview.md) | 桌面应用总览：Electron 架构与 serve 后端 |
| [desktop_features](15_typescript/desktop_features.md) | 桌面特性：斜杠面板、Bot Mode、子代理设置 |
| [ui_tui](15_typescript/ui_tui.md) | ui-tui：Ink 终端界面的实现 |
| [web_dashboard](15_typescript/web_dashboard.md) | Web 仪表盘：嵌入真实 TUI 的 Web 端 |
| [shared_infra](15_typescript/shared_infra.md) | 共享基础设施：跨端共享代码与打包构建 |
| [ts_conventions](15_typescript/ts_conventions.md) | TS 约定：nanostores 状态、路由与目录布局 |

### 16 开发实践（16_dev_guide/）

| 文档 | 内容一句话 |
|---|---|
| [index](16_dev_guide/index.md) | 开发实践总览：从读者到贡献者 |
| [env_setup](16_dev_guide/env_setup.md) | 环境搭建：PM 激活、测试环境与 JS 工作区 |
| [testing](16_dev_guide/testing.md) | 测试体系：run_tests.sh、行为契约与平台标记 |
| [code_health](16_dev_guide/code_health.md) | 代码健康棘轮：复杂度上限与 scripts/check |
| [contribution](16_dev_guide/contribution.md) | 贡献流程：PR 规范、提交规范与评审标准 |

---

## 4. 学习建议

1. **边读边开源码。** 每篇文档都对应具体文件——双屏（或分屏）一边文档一边源码；遇到文档讲的函数，就在源码里找到它读一遍。建议先把 Hermes 跑起来（`hermes` 进 REPL、`hermes gateway` 起网关），有了体感再读，效率翻倍。
2. **养成画图习惯。** 每读完一篇，合上文档、凭记忆重画文中的架构图或流程图，并加上你自己的标注；画不出来的地方就是没读懂的地方，回去重读。
3. **术语回查。** 遇到任何不懂的词（token、WAL、JSON-RPC、MCP……），回[背景知识](00_background_knowledge.md)第 2 节的词典，3 分钟补齐。
4. **以代码为准。** 教程描述的是某一时点的实现；Hermes 迭代很快，若文档与代码不一致，先信代码，再检查是否是文档滞后。
5. **按路径走，别乱跳。** 03（agent 核心）是全教程最重的模块，跳过 01/02 直接读它会反复碰壁；按路径 A → B → C 的顺序投入，回报最高。
