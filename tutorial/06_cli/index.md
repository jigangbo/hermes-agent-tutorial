# 06 CLI 层总览 — cli.py 与 hermes_cli/

## 文件概览

CLI 层是 Hermes 四个表面（CLI、网关、TUI、桌面）中用户最常接触的一个。它由两部分组成：

- **`cli.py`（1,792 行）**——`HermesCLI` 门面：交互式 REPL 的入口与组装点；
- **`hermes_cli/`（843 个 py 文件）**——门面的兄弟模块群：16 个 mixin、中央命令注册表、65 个 argparse 子命令、Web 服务器、更新系统、网关客户端、看板等。

本层遵守仓库级「门面 + 兄弟」布局：`cli.py` 只保留公共入口和被其他包 import 的名字（机械拆分 #116911 之后 re-export 数百个符号），行为全部下沉到 `hermes_cli/cli_*_mixin.py` 与主题兄弟文件中。

## 关键代码走读

cli.py 的启动顺序是刻意安排的——`hermes_bootstrap` 必须是第一个 import（Windows 上装 UTF-8 stdio 并激活 PM 环境），随后立刻压掉子模块的启动噪音：

```python
# cli.py:6-31
# Must be the very first import (UTF-8 stdio on Windows). Missing only mid-``hermes update``.
try:
    import hermes_bootstrap
except ModuleNotFoundError as exc:
    if exc.name != "hermes_bootstrap" and not "hermes_bootstrap".startswith(f"{exc.name}."):
        raise  # the bootstrap exists but cannot load: skipping it would skip PM activation

...
os.environ["HERMES_QUIET"] = "1"  # suppress our modules' startup chatter
```

`HermesCLI` 类由 18 个 mixin 组装（行 881）。MRO 顺序即能力清单：

```text
cli.py:881
class HermesCLI(CLIBacktrackMixin, CLIInitMixin, CLITuiRuntimeMixin,
                CLIProcessNotificationsMixin, CLIAgentSetupMixin, CLICommandsMixin,
                CLIBillingMixin, CLITuiMixin, CLIStatusBarMixin, CLIVoiceMixin,
                CLIModelSwitchMixin, CLISessionMixin, CLIStreamMixin, CLIModalMixin,
                CLITerminalMixin, CLIInfoMixin, CLILoopsMixin, CLIChatTurnMixin):
    """Interactive REPL for the Hermes Agent."""
```

## hermes_cli/ 目录地图

```text
hermes_cli/  (843 py files)
├── cli_*_mixin.py ×16      HermesCLI 的 18 个 mixin（见 repl_mixins.md）
├── commands.py             slash 命令中央注册表 COMMAND_REGISTRY（见 slash_registry.md）
├── slash_exec.py           表面无关的命令执行器 EXECUTORS
├── commands_completion.py  自动补全派生   ┐ 平台/补全视图从同一
├── commands_platforms.py   Telegram/Discord/Slack 命令列表派生 ┘ 注册表派生
├── subcommands/  65 文件   hermes <topic> argparse 构建器（见 subcommands_core.md）
├── web_routers/  37 文件   dashboard 的 FastAPI APIRouter（见 web_routers.md）
├── dashboard_auth/ 18 文件 仪表盘认证中间件栈
├── observability/ 32 文件  shared_metrics 同意门控用量遥测 + schemas/ v1..v4（见 observability.md）
├── local_runtime/ 19 文件  托管 llama.cpp 本地模型运行时（见 local_runtime.md）
├── proxy/ 8 文件           本地凭据附加转发代理（见 local_runtime.md）
├── config*.py ~25 文件     配置系统 + skin_engine.py 主题 SDK（见 config_skins.md）
├── update_*.py ~44 文件    hermes update 更新管线（见 update_system.md）
├── web_server*.py ~30 文件 FastAPI app 组装、surface 矩阵、webapp（见 web_server.md）
├── kanban*.py 25 文件      跨 profile 看板 + swarm（见 kanban.md）
├── gateway_*.py ~35 文件   CLI↔网关客户端：gateway_agent/连接/runtime（见 gateway_client.md）
├── profiles*.py 15 文件    隔离 profile 管理
├── auth*.py ~25 文件       多 provider 凭据系统
├── models*.py ~20 文件     模型目录/切换/定价/本地模型
├── sessions_*.py ~14 文件  会话命令、HTML/MD 导出、找回
├── plugins*.py ~40 文件    插件装载/宿主/目录
├── mcp_*.py / tools_config*  MCP 配置与安全、工具集配置
├── setup*.py / doctor*.py  引导向导与体检
└── 其余顶层工具            banner、bang_shell、send_cmd、service_manager、worktree_*、
                            status*、timefmt/sizefmt、stream_json、turn_exit …
```

## 核心类/函数

| 符号 | 位置 | 职责 |
|---|---|---|
| `HermesCLI` | `cli.py:881` | REPL 门面类，18 个 mixin 组装 |
| `HermesCLI.run()` | `cli.py:1407` | prompt_toolkit 应用装配 + 事件循环 |
| `HermesCLI.process_command()` | `cli.py:1152` | slash 命令六步派发 |
| `_SLASH_DISPATCH` | `cli.py:1117` | 类级 canonical→method 快表（派发层 1） |
| `COMMAND_REGISTRY` | `hermes_cli/commands.py:86` | 全表面命令事实源（派发层 2） |
| `build_cli_parser` 系 | `hermes_cli/subcommands/` | `hermes <topic>` argparse 构建器 |
| `start_server()` | `hermes_cli/web_server.py:1415` | Web 服务器启动 |

## 12 篇文档导航

| # | 文档 | 内容 | 深讲对象 |
|---|---|---|---|
| 1 | `index.md`（本篇） | 目录地图与导航 | — |
| 2 | `repl_mixins.md` | REPL 主循环与 16 个 mixin | `run()`、`chat()` 相位 |
| 3 | `slash_registry.md` | slash 命令注册表与两层派发 | `CommandDef`、`process_command` |
| 4 | `config_skins.md` | 配置系统三层叠加 + 皮肤 SDK | `config_effective`、`SkinConfig` |
| 5 | `subcommands_core.md` | 65 个 `hermes <topic>` 子命令 | `update.py`、`sessions.py` |
| 6 | `web_routers.md` | dashboard 路由 + 认证栈 | `chat_ws.py`、`ws_tickets.py` |
| 7 | `observability.md` | shared_metrics 同意门控遥测 | `record_slash_command` |
| 8 | `local_runtime.md` | 本地 llama.cpp 运行时 + 转发代理 | `supervisor.py`、`proxy/server.py` |
| 9 | `kanban.md` | 跨 profile SQLite 看板与 swarm | `kanban_db.py`、派发器 |
| 10 | `web_server.md` | Web 服务器组装、surface 矩阵、webapp | `SurfacePolicy` |
| 11 | `update_system.md` | `hermes update` 更新管线 | `update_cmd_commit.py` |
| 12 | `gateway_client.md` | CLI↔网关客户端 + profiles/auth/models | `gateway_agent.py` |

建议阅读顺序：先 1→2→3 建立骨架（REPL 与派发），再按需跳入 4-12 的子系统。每篇的「本组文件清单」表格都是该簇的完整文件地图，可当索引用。

## 与其他模块的关系

- **agent/**：`HermesCLI` 在交互模式下构建 `AIAgent`；但在网关模式下 CLI 从不构建 agent——它持有 `gateway_agent.GatewayAgent` 这个「AIAgent 兼容表面」（见 gateway_client.md）。
- **gateway/**：CLI 是网关会话的查看者。网关拥有 turn、工具与 state.db；CLI 提交 `prompt.submit` 并回放事件流。
- **tools/ toolsets.py**：`/tools`、toolset 开关、会话级 surface 工具都从这里读取。
- **hermes_state.py**：会话存储、`/resume`、`/history` 经 SessionDB。
- **plugins/**：`process_command` 触发 `fire_pre_command_hook`，插件命令通过 `plugin_command_dispatch` 执行。

## 总结

CLI 层的三个要点：

1. **门面窄、能力在边**：`cli.py` 是装配点与 re-export 表；任何一个能力都住在 `hermes_cli/` 的某个主题兄弟文件里。
2. **一张注册表喂所有表面**：slash 命令的 CLI help、网关派发、Telegram BotCommands、补全都从 `COMMAND_REGISTRY` 派生——加命令只改一处。
3. **CLI 是网关的查看者**：连接共享网关时，CLI 进程从不构建 agent、从不跑工具、从不写 state.db；turn 在网关跑，CLI 只回放事件流。
