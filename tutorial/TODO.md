# Hermes-Agent 代码教程 — 进度跟踪

> 计划文档总数：约 120 篇（架构精读版：承重文件逐一精讲 + 主题分组覆盖全部产品源文件）
> 产品源文件总数：约 2,629 个 Python + TS 端模块级覆盖（tests/、evals/、scripts/ 不在逐文件范围）
> 创建：2026-11-08
> 语言：中文
> 覆盖策略：每篇主题文档必须包含「本组完整文件清单表」（每个文件一行：文件名 / 角色 / 关键符号），
> 确保所有源文件在教程中有归属；核心承重文件另加逐段代码走读。

## 进度总览

| 模块 | 计划文档 | 已完成 | 状态 |
|------|---------|--------|------|
| 00 基础（背景知识 + 阅读指南） | 2 | 2 | ✅ |
| 01 系统架构专题 | 7 | 7 | ✅ |
| 02 核心门面层（根目录） | 11 | 11 | ✅ |
| 03 agent/ 核心循环 | 22 | 22 | ✅ |
| 04 tools/ 工具系统 | 13 | 13 | ✅ |
| 05 gateway/ 消息网关 | 10 | 10 | ✅ |
| 06 hermes_cli/ 命令行层 | 12 | 12 | ✅ |
| 07 状态持久化层（hermes_state_*） | 8 | 8 | ✅ |
| 08 tui_gateway/ | 5 | 5 | ✅ |
| 09 plugins/ 插件系统 | 5 | 5 | ✅ |
| 10 cron/ 调度 | 4 | 4 | ✅ |
| 11 pm/ 包管理环境 | 3 | 3 | ✅ |
| 12 skills/ 技能系统 | 3 | 3 | ✅ |
| 13 hermes_platform/ | 2 | 2 | ✅ |
| 14 acp_adapter/ | 2 | 2 | ✅ |
| 15 TypeScript 端（desktop/ui-tui/web） | 7 | 7 | ✅ |
| 16 开发实践指南 | 5 | 5 | ✅ |
| 首页 index.md | 1 | 1 | ✅ |

## 文档清单与完成状态

### 00_基础
- [x] `00_background_knowledge.md` — AI Agent 领域背景（零基础友好）
- [x] `00_reading_guide.md` — 三条阅读路径 + 全部文档索引

### 01_architecture/（横向架构专题）
- [x] `index.md`
- [x] `big_picture.md` — 全局架构总览（ASCII 图）
- [x] `turn_lifecycle.md` — 一次对话的完整生命周期
- [x] `caching_invariants.md` — 提示词缓存不变量
- [x] `state_model.md` — 状态与存储模型
- [x] `tool_system.md` — 工具系统全景
- [x] `security_model.md` — 安全边界模型

### 02_core/（根目录门面文件，逐文件）
- [x] `index.md`
- [x] `run_agent.md` — run_agent.py（AIAgent 门面）
- [x] `model_tools.md` — model_tools.py（工具编排）
- [x] `toolsets.md` — toolsets.py + toolset_distributions.py
- [x] `cli.md` — cli.py（REPL + slash 分发）
- [x] `hermes_state.md` — hermes_state.py（SessionDB 门面）
- [x] `hermes_constants.md` — hermes_constants.py + 3 个 scratch 兄弟文件
- [x] `bootstrap_logging.md` — hermes_bootstrap.py + hermes_logging.py
- [x] `platform_acl.md` — hermes_dir_acl.py + hermes_startup_watchdog.py
- [x] `utilities.md` — hermes_time.py + hermes_yaml.py + utils.py
- [x] `misc_root.md` — trajectory_compressor.py + batch_runner.py + registration_lifecycle.py

### 03_agent/（核心循环，主题分组 + 承重文件单独精讲）
- [x] `index.md` — 模块总览 + 架构图
- [x] `conversation_loop.md` — conversation_loop.py（主循环心脏，单独精讲）
- [x] `turn_pipeline.md` — turn_*.py 系列（~35 文件，分阶段走读）
- [x] `turn_facade.md` — turn_facade.py + turn_facade_lease.py + turn_liveness.py
- [x] `system_prompt.md` — system_prompt.py + prompt_builder.py（单独精讲）
- [x] `model_providers.md` — provider_* + anthropic_* + bedrock + gemini + vertex + azure（~20 文件）
- [x] `codex_runtime.md` — codex_* 系列（5 文件）
- [x] `model_metadata.md` — model_metadata* + models_dev（7 文件）
- [x] `auxiliary_clients.md` — auxiliary_* 系列（~22 文件）
- [x] `credentials_rate.md` — credential_* + rate_limit_* + billing_* + account_usage*（~18 文件）
- [x] `compression.md` — context_* + compression_* + conversation_compression*（~28 文件）
- [x] `prompt_caching.md` — prompt_cache_* + prompt_caching + prompt_refresh + cache_bounds（6 文件）
- [x] `memory_learning.md` — memory_* + learning_* + insights + curator*（~12 文件）
- [x] `skills_runtime.md` — skill_* + skills_index_delta（6 文件）
- [x] `streaming_response.md` — stream_* + reasoning_* + message_* + display（~20 文件）
- [x] `tool_execution.md` — tool_* + inline_tool_executors + terminal_* + file_safety + shell_hooks（~14 文件）
- [x] `delegation_subagents.md` — delegation_* + subagent_* + managed_worker + runtime_session_* + side_question*（~18 文件）
- [x] `onboarding_sessions.md` — onboarding_* + session_*（~12 文件）
- [x] `errors_resilience.md` — error_* + retry_* + interrupt_* + estop + deadline 等（~15 文件）
- [x] `multimodal_media.md` — image_* + vision + tts/transcription + browser_* + web_search_*（~18 文件）
- [x] `relay_moa.md` — relay_* + moa_* + bot_chain（~10 文件）
- [x] `platform_misc.md` — i18n_* + vault_* + 其余杂项（~25 文件）

### 04_tools/（工具系统）
- [x] `index.md` — 注册机制 + 架构图
- [x] `registry.md` — 工具注册/发现/门控
- [x] `file_terminal.md` — 文件与终端类工具
- [x] `web_browser.md` — 网页与浏览器类工具
- [x] `connectors.md` — connectors/（34 文件）
- [x] `environments.md` — environments/（21 文件）
- [x] `computer_use.md` — computer_use/（13 文件）+ bot_desktop/（11 文件）
- [x] `mcp.md` — MCP 工具
- [x] `delegation_tools.md` — 子代理委派工具
- [x] `approval_safety.md` — 审批与安全组（原 misc_tools 拆分）
- [x] `messaging_cron.md` — 消息发送与定时任务工具组（原 misc_tools 拆分）
- [x] `skills_memory.md` — 技能/记忆/澄清/Todo 工具组（原 misc_tools 拆分）
- [x] `voice_media.md` — 语音与媒体生成工具组（原 misc_tools 拆分）

### 05_gateway/（消息网关）
- [x] `index.md` — 网关进程模型 + 架构图
- [x] `run.md` — run.py 深度走读
- [x] `message_flow.md` — 消息流转全链路（guards、streaming）
- [x] `platforms_framework.md` — 适配器接口 + ADDING_A_PLATFORM（原 platforms_intro）
- [x] `platform_adapters.md` — 26 个平台插件清单 + Telegram 解剖（原 platforms_chat）
- [x] `builtin_platforms.md` — 内置 HTTP 平台 webhook/msgraph/api_server（原 platforms_work）
- [x] `sessions_authority.md` — 会话索引、路由身份与 durable 接纳权威
- [x] `relay.md` — relay/（13 文件）
- [x] `streaming.md` — 流式契约 + 通知唤醒（原 streaming_tts + notifications）
- [x] `turn_machinery.md` — 网关侧 turn 执行（turn_executor、lease）（原 turn_execution）

### 06_cli/（hermes_cli/）
- [x] `index.md` — mixin 架构 + 全景图
- [x] `repl_mixins.md` — cli_*_mixin.py 系列
- [x] `slash_registry.md` — slash 命令注册表
- [x] `config_skins.md` — 配置系统 + 皮肤
- [x] `subcommands_core.md` — subcommands/ 核心（65 文件分组清单）
- [x] `web_routers.md` — web_routers/（37 文件）+ dashboard_auth/（18 文件）
- [x] `observability.md` — observability/（31 文件）
- [x] `local_runtime.md` — local_runtime/（19 文件）+ proxy/（8 文件）
- [x] `gateway_client.md` — CLI↔网关客户端 与 profiles/auth/models
- [x] `kanban.md` — kanban 相关
- [x] `web_server.md` — web_server 相关
- [x] `update_system.md` — hermes update + profiles/multiplex（原 update_profiles）

### 07_state/（状态持久化，68 个根目录文件分组）
- [x] `index.md` — 存储模型总览（SQLite/WAL）
- [x] `facade.md` — hermes_state.py 门面与兄弟文件模式
- [x] `wal_mutations.md` — WAL + mutation_*/runtime/worker 系列（~18 文件，含原计划的 runtime_workers）
- [x] `sessions_messages.md` — sessions/messages/timeline/titles（~14 文件）
- [x] `compression_state.md` — compression 相关（~6 文件）
- [x] `locks_guards.md` — lock*/guard/holders/pidns（~8 文件）
- [x] `search_maintenance.md` — search/fts/repair/maintenance/prune（~12 文件）
- [x] `misc_state.md` — 其余（portability/usage/media/telegram 等，全部清单）

### 08_tui_gateway/
- [x] `index.md` — 进程模型 + 架构图
- [x] `process_model.md`
- [x] `rpc_transport.md`
- [x] `contracts.md` — 契约即文档（contracts/ 25 文件）（原 slash_flow/streaming_ui 合并重组）
- [x] `methods_slash.md` — 34 个 methods_*.py 与 slash worker 机制（原 slash_flow）

### 09_plugins/
- [x] `index.md`
- [x] `plugin_api.md`（published API）
- [x] `boundary_lint.md`（边界治理 + 迁移表；plugin_kinds 内容并入 index/plugin_api）
- [x] `catalog.md`
- [x] `bundled_plugins.md`（内置插件清单）

### 10_cron/
- [x] `index.md`
- [x] `scheduler.md`
- [x] `jobs.md`
- [x] `kanban_dispatcher.md`

### 11_pm/
- [x] `index.md`
- [x] `environments.md`
- [x] `pinning_policy.md`

### 12_skills/
- [x] `index.md`
- [x] `skill_format.md`
- [x] `curator.md`

### 13_hermes_platform/
- [x] `index.md`
- [x] `facts_resolvers.md`

### 14_acp_adapter/
- [x] `index.md`
- [x] `protocol.md`

### 15_typescript/（模块级）
- [x] `index.md`
- [x] `desktop_overview.md` — Electron 结构 + serve 后端
- [x] `desktop_features.md` — slash palette、Bot Mode、src 分区
- [x] `ui_tui.md` — TUI 架构（packages/ + src/）
- [x] `web_dashboard.md` — 仪表盘 + TUI 嵌入
- [x] `shared_infra.md` — apps/shared + bootstrap-installer
- [x] `ts_conventions.md` — TS 端约定（nanostores、路由约定）

### 16_dev_guide/（开发实践 —— 提升 IT 能力）
- [x] `index.md`
- [x] `env_setup.md` — 环境搭建（activate、HERMES_HOME、profiles）
- [x] `testing.md` — 测试体系（run_tests.sh、行为契约、OS 标记）
- [x] `code_health.md` — 代码健康门禁（scripts/check、ratchet）
- [x] `contribution.md` — 贡献准则（rubric、footprint 阶梯、安全边界）

### 首页
- [x] `index.md` — 项目介绍 + 架构图 + 主流程图 + 代码映射表 + 模块索引

## 覆盖率核对（自审用）
原始清单保存在 /tmp/inv_root.txt、inv_agent.txt、inv_tools.txt、inv_gateway.txt、
inv_cli.txt、inv_periph.txt（共 2,629 个产品源文件）。自审阶段逐模块比对：
每个文件必须出现在某篇文档的「本组文件清单」表中。
