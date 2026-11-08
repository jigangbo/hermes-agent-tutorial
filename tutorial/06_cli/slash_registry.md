# Slash 命令注册表与两层派发

## 文件概览

slash 命令有两个事实源，分两层：

- **层 1**：`cli.py:1117` 的类级表 `_SLASH_DISPATCH`——canonical 名 → `(方法名, 是否传原始输入)`，缺席命令按命名约定 `_handle_<name>_command` 经 `getattr` 命中；
- **层 2**：`hermes_cli/commands.py` 的中央注册表 `COMMAND_REGISTRY`——「CLI help、gateway dispatch、Telegram BotCommands、Slack subcommand mapping、autocomplete 都从 COMMAND_REGISTRY 派生」。加命令 = 追加一个 `CommandDef`。

兄弟文件：`commands_completion.py`（补全）、`commands_platforms.py`（Telegram BotCommands/Discord/Slack 列表派生）、`slash_exec.py`（表面无关执行器）。

## 关键代码走读

### CommandDef：注册表的一行

```python
# hermes_cli/commands.py:45-93
class CommandDef:
    """Definition of a single slash command."""
    name: str                          # canonical name without slash: "background"
    description: str                   # human-readable description
    category: str                      # "Session", "Configuration", etc.
    aliases: tuple[str, ...] = ()      # alternative names: ("bg",)
    args_hint: str = ""                # argument placeholder: "<prompt>", "[name]"
    subcommands: tuple[str, ...] = ()  # tab-completable subcommands
    cli_only: bool = False             # only available in CLI
    gateway_only: bool = False         # only available in gateway/messaging
    gateway_config_gate: str | None = None  # config dotpath; truthy overrides cli_only for gateway
    # Mid-run (agent busy) gateway behavior ...
    busy_policy: str = "reject"
    busy_handler: str | None = None  # key of a special mid-run handler in Guard-2 table
    # Key in ``hermes_cli.slash_exec.EXECUTORS`` (a string, not a callable: keeps this module
    # import-light for the gateway).
    execute: str | None = None
    argument_mode: str | None = None  # desktop composer: options|text|mixed; None inferred
    desktop: str | None = None
    desktop_subcommands: tuple[str, ...] | None = None
```

`execute` 存**字符串键**而非可调用对象，是有意的：commands.py 被 gateway 在早期 import，执行器（`slash_exec.EXECUTORS`）惰性解析，保持模块 import 轻。

### 两层派发（ASCII）

```text
用户输入 "/bg 5"
      │
      ▼
process_command()  cli.py:1152
      │ 小写化(仅匹配用，args 保大小写)
      ▼
resolve_command("bg") ──── hermes_cli/commands.py:402   别名→canonical "background"
      │                                      （层 2：注册表）
      ▼
_slash_handler("background")  cli.py:1139                （层 1：类级表）
      │ _SLASH_DISPATCH 命中 → ("_handle_background_command", True)
      │ 缺席时试 getattr(cls, "_handle_<name>_command")
      ▼
gateway_setting_commands.run → 插件 pre_command 钩子 → gateway_cli_commands.run → mixin handler
```

### process_command 六步

```python
# cli.py:1152-1200（节选）
    def process_command(self, command: str, *, redispatch: bool = False) -> bool:
        cmd_lower = command.lower().strip()  # lowercase only for matching; args keep their case
        cmd_original = command.strip()

        # Aliases resolve via the central registry (hermes_cli/commands.py).
        from hermes_cli.commands import resolve_command as _resolve_cmd
        _base_word = cmd_lower.split()[0].lstrip("/")
        _cmd_def = _resolve_cmd(_base_word)
        canonical = _cmd_def.name if _cmd_def else _base_word
        if not redispatch and self._slash_metrics_surface:
            from hermes_cli.observability.shared_metrics_events import record_slash_command
            record_slash_command(command=canonical, surface=self._slash_metrics_surface)
```

六步依次是：(1) 小写化匹配用副本；(2) `resolve_command` 别名→canonical；(3) 记 `shared_metrics_events.record_slash_command`（`redispatch` 标记内部重入，用户命令只计一次）；(4) `_slash_handler` 查层 1；(5) 网关设置命令 `gateway_setting_commands.run` + 插件 `pre_command` 钩子（`plugins.fire_pre_command_hook`）+ `gateway_cli_commands.run`（checkpoints/.env/handoff 等网关拥有的状态）；(6) mixin handler，返回 `False` 即退出 REPL。

### 未注册命令的优先级链

```python
# cli.py:1202-1233
    def _process_unregistered_slash(self, cmd_original: str, cmd_lower: str) -> bool:
        """Slash input with no built-in handler; precedence: quick_commands -> plugins -> bundles -> skills -> prefix expansion."""
        base_cmd = cmd_lower.split()[0]
        bare = base_cmd.lstrip("/")
        skill_bundles = get_skill_bundles()
        quick_commands = self.config.get("quick_commands", {})
        user_args = cmd_original[len(base_cmd):].strip()
        if bare in quick_commands:
            return self._run_quick_command(base_cmd, quick_commands[bare], user_args)
        ...
        if plugin or (plugin is None and bare in _get_plugin_cmd_handler_names()):
            gone = self._run_plugin_slash_command(base_cmd, user_args) is gateway_plugin_commands.GONE
            if not gone:
                return True
            skill_commands = _session_skill_commands(self)  # the reload may have changed the skills
        if base_cmd in skill_bundles:  # also a name a gateway plugin reload just dropped (GONE)
            self._run_skill_bundle_command(base_cmd, skill_bundles[base_cmd], user_args)
        elif base_cmd in skill_commands:
            self._run_skill_slash_command(base_cmd, skill_commands[base_cmd], user_args)
        elif not (gone and gateway_plugin_commands.report_gone(bare, skill_commands, skill_bundles)):
            return self._expand_slash_prefix(cmd_original, cmd_lower, skill_commands, skill_bundles)
```

优先级：**用户 quick_commands**（`alias` 重派发 / `exec` shell 片段）→ **网关插件命令** → **插件 slash handlers** → **skill bundles** → **skill commands** → `_expand_slash_prefix`。都没命中则打印 `cli_unknown_command.py` 的文案。

### busy_policy 语义（网关 Guard-2 派发器）

| 值 | 语义 |
|---|---|
| `dispatch` | agent 忙碌时照常执行（或走 `busy_handler` 变体） |
| `reject` | 忙碌期拒绝（通用「Agent is running」，或 `busy_handler` 指定的拒绝文案） |
| `interrupt_then_dispatch` | 先打断当前 turn 再执行（`/stop`、`/new`、`/reset`；Guard 1） |

### 表面无关执行器

```python
# hermes_cli/slash_exec.py:1-6
"""Registry-owned slash command execution (thin slice).

Invariant: an executor's output depends only on ``ctx.args`` / ``ctx.options`` — never on
``ctx.surface`` — so the core text is identical across surfaces for a fixed context (enforced by
tests/hermes_cli/test_commands_execute.py).
"""
```

`CommandContext(surface, args, options, config_get)` 进、`CommandReply(text, data, format)` 出；执行器是纯格式化器，不动 agent/session。

## 核心类/函数

| 符号 | 文件:行号 | 职责 |
|---|---|---|
| `CommandDef` | commands.py:45 | 一条命令的冻结定义（dataclass） |
| `_CATEGORY_SLUGS` | commands.py:31 | 8 个类别 → 本地化 slug（Session/Configuration/Info/Tools & Skills/Plugins/Exit/Context/Background & Automation） |
| `COMMAND_REGISTRY` | commands.py:86 | 全表面命令列表 |
| `_COMMAND_LOOKUP` | commands.py:396 | 名字+别名 → CommandDef 的字典 |
| `resolve_command()` | commands.py:402 | 「名字或别名（斜杠可选）→ CommandDef」 |
| `build_commands_by_category()` | commands.py:416 | 本地化 `{category: {"/cmd": 描述}}`，每次调用重建 |
| `_SLASH_DISPATCH` | cli.py:1117 | 层 1 快表 |
| `_slash_handler()` | cli.py:1139 | 层 1 查找 + 命名约定回退 |
| `process_command()` | cli.py:1152 | 六步派发 |
| `_process_unregistered_slash()` | cli.py:1202 | 未注册命令优先级链 |
| `_run_quick_command()` | cli.py:1241 | `alias` 重派发 / `exec` shell 片段（30s 超时、环境洗白、输出脱敏） |
| `EXECUTORS` / `execute_command()` | slash_exec.py | 字符串键 → 纯执行器 |

## 本组文件清单

| 文件 | 职责 |
|---|---|
| hermes_cli/commands.py | 中央注册表：CommandDef、COMMAND_REGISTRY、resolve_command、类别/本地化 |
| hermes_cli/commands_completion.py | 从注册表派生 prompt_toolkit 补全 |
| hermes_cli/commands_platforms.py | 从注册表派生 Telegram BotCommands、Discord、Slack 子命令映射 |
| hermes_cli/slash_exec.py | EXECUTORS 执行器注册表 + CommandContext/CommandReply |
| hermes_cli/cli_unknown_command.py | 未知命令文案 |
| hermes_cli/gateway_setting_commands.py | 网关拥有的每会话设置命令（process_command 第 5 步前半） |
| hermes_cli/gateway_cli_commands.py | 网关拥有状态的 CLI 命令（checkpoints/.env/handoff；REFUSED 表） |
| hermes_cli/gateway_plugin_commands.py | 网关插件命令 lookup/run/observe/GONE 报告 |
| hermes_cli/cli_commands_mixin.py | 大量 handler 本体（16 mixin 之一） |
| hermes_cli/cli_commands_session_tools.py | 会话工具命令拆分文件 |
| hermes_cli/cli_commands_worktree.py | /worktree 命令拆分文件 |

## 与其他模块的关系

- **observability/**：每次用户键入的命令经 `record_slash_command` 进 shared_metrics。
- **plugins/**：`fire_pre_command_hook` 观察者钩子；插件命令经 `plugin_command_dispatch` 执行。
- **skills/**：skill bundles（`/<bundle>` 一次装多技能）与 skill slash 命令是优先级链末端。
- **gateway/**：`busy_policy` 的消费方在 `gateway/run.py` Guard-2 派发器与 `platforms/base.py` Guard-1。
- **apps/desktop/**：`desktop`/`argument_mode`/`desktop_subcommands` 字段喂桌面命令面板。

## 总结

记住三件事：(1) 加命令 = 在 `COMMAND_REGISTRY` 追加一个 `CommandDef` +（可选）一个 mixin handler 或 EXECUTOR；(2) 层 1 快表只是 CLI 的方法路由，层 2 注册表才是跨表面契约；(3) 未注册输入走一条明确优先级链，quick_commands 永远最先。
