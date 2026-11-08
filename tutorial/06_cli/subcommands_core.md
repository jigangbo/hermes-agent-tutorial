# 65 个 `hermes <topic>` 子命令

## 文件概览

`hermes_cli/subcommands/` 共 65 个文件，每个是 `hermes <topic>` 的 argparse 构建器。分发结构：

- `hermes_cli/_parser.py` 只放顶层 parser 和 `chat` 子 parser；
- 其余每个子 parser 由 `subcommands/<group>.py` 构建，在 `main._build_cli_parser` 中接线并注入 `cmd_*` handler；
- 大多数 handler 走惰性 import（`cmd_sessions_lazy` 模式）：只有子命令真正运行时才 import 对应实现模块；
- `_shared.py` 提供 `add_json_flag` / `add_yes_flag` 等共用旗标。

## 关键代码走读

### 分发接线

```python
# hermes_cli/_parser.py:1-6
"""Top-level argparse construction for the hermes CLI.

Only the top-level parser and the ``chat`` subparser live here. Every other subparser (model,
gateway, sessions, …) is built by ``hermes_cli/subcommands/<group>.py`` and wired in
``main._build_cli_parser`` with its ``cmd_*`` handler injected.
"""
```

`--profile` / `-p` 不在 parser 上——它在 argparse 之前被 `main._apply_profile_override` 消费（设置 `HERMES_HOME` 并把自己从 argv 剥掉），文件里用 `PRE_ARGPARSE_INHERITED_FLAGS` 保留这份元数据。

### 代表一：update.py（简述，详见 update_system.md）

```python
# hermes_cli/subcommands/update.py:9-30（节选）
def build_update_parser(subparsers, *, cmd_update: Callable) -> None:
    """Attach the ``update`` subcommand to ``subparsers``."""
    from hermes_cli.release_channels import validate_name
    update_parser = subparsers.add_parser(
        "update", help="Update Hermes Agent to the latest version",
        description="Pull the latest changes from git and reinstall dependencies")
    update_parser.add_argument(
        "--check", action="store_true", default=False,
        help="Check whether an update is available without installing anything")
    update_parser.add_argument(
        "--plan", action="store_true", default=False,
        help="Show the update plan and exit without changing anything: install "
            "kind (git/docker/nix), every running Hermes service across all "
            "profiles with its supervisor and running code version, and how "
            "each will be restarted. Read-only; safe on a live fleet.")
```

旗标族：`--gateway`（文件 IPC 提示模式）、`--check`、`--plan`（只读舰队计划）、`--list-venv-holders`（Windows venv 占用者 JSON 清单）。实现散布在 `update_cmd*.py` 44 个文件里，`update_cmd.py` 是管线派发器。

### 代表二：sessions.py

```python
# hermes_cli/subcommands/sessions.py:12-16
def cmd_sessions_lazy(args, **kwargs):
    """``hermes sessions`` handler; sessions_cmd imports only when the subcommand runs."""
    from hermes_cli.sessions_cmd import cmd_sessions

    return cmd_sessions(args, **kwargs)
```

`sessions_cmd.py` 把 `args.sessions_action` 路由进 `_PRE_DB_HANDLERS`（repair/recover/import——必须在不打开 `SessionDB()` 的情况下跑，坏 schema 会挡路）与 `_DB_HANDLERS`（其余动作共享一个 `SessionDB`）；交互式选择器在 `sessions_cmd_browse.py`。

## 核心类/函数

| 符号 | 文件 | 职责 |
|---|---|---|
| `_build_cli_parser` | hermes_cli/main.py | 把 65 个构建器接进顶层 parser |
| `build_*_parser(subparsers, *, cmd_*)` | subcommands/*.py | 每个子命令的 argparse 构建（统一签名） |
| `add_json_flag` / `add_yes_flag` | subcommands/_shared.py | 共用旗标 |
| `cmd_sessions_lazy` | subcommands/sessions.py:12 | 惰性 handler 模板 |
| `build_update_parser` | subcommands/update.py:9 | update 旗标族 |

## 本组文件清单

65 个文件按域分组（`__init__.py`/`_shared.py` 为基础设施，不属任何域）：

**基础设施**

| 文件 | 职责 |
|---|---|
| __init__.py | 子命令 parser 构建器包入口 |
| _shared.py | 共用 argparse 助手（JSON/yes 旗标等） |

**会话与状态**

| 文件 | 职责 |
|---|---|
| sessions.py | `hermes sessions`：list/browse/rename/discard/adopt/refresh-prompts 等 |
| checkpoints.py | 文件系统检查点子命令 |
| dump.py | 会话/状态转储 |
| memory.py | 记忆子命令 |
| insights.py | 使用洞察 |
| journey.py | journey 追踪 |
| import_cmd.py | `hermes import`（外部会话导入） |
| migrate.py | 数据迁移 |
| worktree.py | git worktree 管理 |

**配置与凭据**

| 文件 | 职责 |
|---|---|
| config.py | `hermes config`：get/set/show/check |
| auth.py | `hermes auth` 子命令 |
| login.py / logout.py | provider 登录/登出 |
| secrets.py | 密钥管理 |
| vault.py | 凭据保险库 |
| pairing.py | 平台配对 |
| connectors.py | 连接器 |
| egress.py | Docker 出站代理状态 |

**网关与平台**

| 文件 | 职责 |
|---|---|
| gateway.py | `hermes gateway`（及 `hermes proxy`） |
| acp.py | ACP 适配器 |
| whatsapp.py | WhatsApp 集成 |
| slack.py | Slack 集成 |
| webhook.py | webhook 管理 |
| peer.py | 跨机器 bot-to-bot DM |
| pause.py | `hermes pause`/`resume` 全局紧急停止 |

**工具与技能**

| 文件 | 职责 |
|---|---|
| tools.py | 工具集子命令 |
| skills.py | 技能子命令 |
| mcp.py | MCP 服务器管理 |
| browser.py | 浏览器控制 |
| computer_use.py | 计算机使用 |
| computer_use_screen.py | Bot Desktop 屏幕（`computer_use` 驱动） |
| moa.py | MoA 配置 |
| bundles.py | 技能包 |

**模型与运行时**

| 文件 | 职责 |
|---|---|
| model.py | 模型列表/搜索 |
| codex_runtime.py | `/codex-runtime` 的非交互对应 |
| fallback.py | 模型回退链 |
| usage.py | 账户限额块（不开会话） |
| prompt_size.py | 提示尺寸 |

**界面与体验**

| 文件 | 职责 |
|---|---|
| skin.py | 皮肤切换 |
| gui.py | 桌面 GUI |
| dashboard.py | `hermes dashboard` / `hermes serve` |
| webapp.py | 浏览器版桌面工作区 |
| console.py | 控制台 |
| pets.py | 宠物面板 |
| clipboard.py | 剪贴板 |
| completion.py | shell 补全 |
| welcome_trial 等 | （体验类实现散布顶层） |

**运维与诊断**

| 文件 | 职责 |
|---|---|
| update.py | 更新（详见 update_system.md） |
| setup.py | 引导向导 |
| doctor.py | 体检 |
| debug.py | 调试 |
| logs.py | `hermes logs` |
| status.py | 状态汇总 |
| monitoring.py | 网关健康/诊断导出控制 |
| backup.py | 备份/恢复 |
| verify.py | 安装验证 |
| uninstall.py | 卸载 |
| profile.py | profile 管理 |
| curator.py | 记忆策展 |
| cron.py | 定时任务 |
| hooks.py | 钩子 |
| plugins.py | 插件管理 |
| approvals.py | 审批管理 |
| security.py | 安全审计 |

> 注：以上 8 组共 65 行，与 `hermes_cli/subcommands/` 的 65 个文件一一对应。

## 与其他模块的关系

- **实现模块**：每个 `subcommands/<x>.py` 的 handler 指向 `hermes_cli/<x>_cmd.py` 或 `<x>.py` 的同名函数。
- **cli.py**：`hermes chat`（顶层 parser 的 `chat` 子命令）直接进 `HermesCLI`；`-q`/`-Q` 走 `cli_single_query.py`。
- **hermes_state.py**：sessions/checkpoints/journal 的存储层。

## 总结

子命令层是一条薄薄的水平线：65 个构建器 + 惰性 handler，行为全部在实现模块。找 `hermes <x>` 的行为，直接看 `hermes_cli/<x>_cmd.py`；找旗标，看 `subcommands/<x>.py`。
