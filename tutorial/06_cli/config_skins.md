# 配置系统与皮肤引擎

## 文件概览

配置簇约 27 个文件，围绕 `config.py`（3,945 行门面）组织：

- **读写**：`config.py`（load/save/validate/save_env_value）；写回原语 `config_backend` seam；
- **叠加**：`config_effective.py` = config.yaml + managed overlay + `${VAR}` 展开（无默认值层）；
- **路由**：`config_env_routing.py` 决定一个键落 `.env` 还是 `config.yaml`；
- **迁移**：`config_migrations.py` 表驱动注册表（+ `config_migrations_browser.py`）；
- **IT 下发**：`managed_scope.py` 用户不可变的托管层；
- **守护**：backups/issues/show/section_guard/value_checks/key_notices/read_errors/runtime_keys/worker_save/version_stamp/language/check_diagnostics；
- 皮肤：`skin_engine.py`（主题 SDK）+ `skin_cmd.py`（`hermes skin`）。

## 关键代码走读

### config.py 门面

```python
# hermes_cli/config.py:1-3
"""Configuration management for Hermes Agent: config.yaml / .env loading, saving,
validation, migration, and the ``hermes config`` command."""
```

核心入口：`load_config()`（行 1978，先合并 `DEFAULT_CONFIG`）、`load_config_readonly()`（行 1985）、`_load_config_impl()`（行 2215）、`save_config()`（行 2366）、`save_env_value()`（行 2688）、`get_config_value()`（行 3450）、`validate_config_structure()`（行 1052）。

### config_effective 三层

```python
# hermes_cli/config_effective.py:1-14
"""The effective USER config: config.yaml + managed overlay + ``${VAR}`` expansion, no defaults.

``load_config()`` merges ``DEFAULT_CONFIG`` first, which is wrong for readers that treat a
missing key as "unset" (the gateway's presence-sensitive env bridge, ``cfg == {}`` sentinels,
cron model pinning) — so nine surfaces used to hand-roll raw-read → overlay → expand in
differing orders and none of them replayed the model-key canonicalization or the last-known-good
recovery ``load_config()`` gained. This module is that one primitive.
```

叠加顺序与 `_load_config_impl` 一致：**用户层先展开 `${VAR}`，再叠 managed overlay**——托管层里的 `${VAR}` 只对进程环境解析，永远不会被某个 profile 的 secret 作用域再解析（docs/design/managed-scope.md §4.1）。该模块还带「最后一次成功解析的 raw 用户映射」缓存：文件中途被改坏时按上个好版本继续服务。

### config_env_routing：按形状路由

```python
# hermes_cli/config_env_routing.py:1-14（节选）
"""Which ``hermes config`` keys live in ``.env`` instead of ``config.yaml``, and their lifecycle.
...
The routing rule is the key's SHAPE, not a registry: a bare ``UPPER_SNAKE`` name is an environment
setting and goes to ``.env`` — the file every runtime reader (``os.getenv``, the gateway's
``platform_gate_env``) resolves against — whether or not Hermes enumerates it anywhere.
"""
# 行 26-28
_ENV_SHAPE_RE = re.compile(r"^[A-Z][A-Z0-9_]*$")
```

路由规则是键的**形状**而非注册表：裸 `UPPER_SNAKE` 名进 `.env`；小写裸名留在 config.yaml 顶层。约 700 个文档变量中的 290 个只从环境读（`TELEGRAM_GROUP_ALLOWED_USERS`、`HERMES_TIMEZONE`……），注册表检查总会漏——所以用形状。这与 AGENTS.md 的铁律一致：**`.env` 只放密钥，行为进 config.yaml**。

### managed_scope：IT 下发层

`managed_scope.py` 是「Managed scope — IT-pushed, user-immutable config & env layer」：组织下发的覆盖层，用户不可变；`config_effective` 把它叠在用户层之上。

### 迁移

`config_migrations.py` 是表驱动注册表；`config_migrations_browser.py` 注册 51→52 步（agent-browser 配置迁移）。`config_version_stamp.py` 负责从 config.yaml 裸读 `_config_version` 戳。

### skin_engine：每个表面的主题 SDK

```python
# hermes_cli/skin_engine.py:1-37（节选）
"""Hermes skin/theme engine — the theme SDK for every surface."""

@dataclass
class SkinConfig:
    """Complete skin configuration."""
    name: str
    description: str = ""
    colors: dict[str, str] = field(default_factory=dict)
    # Paired palettes for the opposite background polarity (mirrors the desktop app's
    # colors/darkColors pairing): a light terminal prefers `light_colors` (falling back to
    # `colors`), and vice versa for `dark_colors`.
    light_colors: dict[str, str] = field(default_factory=dict)
    dark_colors: dict[str, str] = field(default_factory=dict)
    spinner: dict[str, Any] = field(default_factory=dict)
    branding: dict[str, str] = field(default_factory=dict)
    tool_prefix: str = "┊"
    tool_emojis: dict[str, str] = field(default_factory=dict)  # per-tool emoji overrides
    banner_logo: str = ""    # Rich-markup ASCII art logo (replaces HERMES_AGENT_LOGO)
    banner_hero: str = ""    # Rich-markup hero art (replaces HERMES_CADUCEUS)
    custom_css: str = ""     # Raw CSS injected as a <style> tag on the desktop GUI (32 KiB cap)
```

`skin_cmd.py` 提供 `hermes skin` 的 list/switch/tweak。皮肤同时喂 CLI、TUI、Web、桌面（custom_css 直接注入桌面 GUI 的 `<style>` 标签）。

## 核心类/函数

| 符号 | 文件:行号 | 职责 |
|---|---|---|
| `load_config()` | config.py:1978 | DEFAULT_CONFIG 合并后的读入口 |
| `load_config_readonly()` | config.py:1985 | 只读变体（不写恢复） |
| `_load_config_impl()` | config.py:2215 | 真正的加载管线（规范化 + last-known-good 恢复） |
| `save_config()` | config.py:2366 | 保存（含 worker_save 冻结会话分支） |
| `save_env_value()` | config.py:2688 | `.env` 键写入 |
| `validate_config_structure()` | config.py:1052 | 结构校验，产出 ConfigIssue |
| `read_user_config_raw` | config_effective.py | 写回原语；raw 读用户层 |
| `_ENV_SHAPE_RE` | config_env_routing.py:26 | `.env` 键形状判定 |
| `SkinConfig` | skin_engine.py:17 | 完整皮肤配置 dataclass |
| `apply_managed_overlay` | managed_scope.py | 托管层叠加（内含 `${VAR}` 展开） |

## 本组文件清单

| 文件 | 职责 |
|---|---|
| config.py | 门面：加载/保存/校验/迁移/`hermes config` 命令 |
| config_backend.py | 用户配置层所在地的 `ConfigBackend` seam（design §4.1, D10/D11） |
| config_defaults.py | DEFAULT_CONFIG 与 OPTIONAL_ENV_VARS |
| config_defaults_auxiliary.py | 辅助模型配置默认值的纯数据工厂 |
| config_defaults_env.py | OPTIONAL_ENV_VARS 的条目工厂（纯数据叶，仅 stdlib） |
| config_effective.py | 生效用户配置：yaml + managed overlay + ${VAR} 展开，无默认 |
| config_env_routing.py | 键落 .env 还是 config.yaml 的路由与生命周期 |
| config_migrations.py | 表驱动迁移注册表 |
| config_migrations_browser.py | 51→52 步：agent-browser 配置迁移 |
| config_providers.py | 自定义 provider 条目规范化与每路由查询（TLS/headers/上下文长度） |
| config_provider_env.py | OPTIONAL_ENV_VARS 的 provider-profile 条目 |
| config_backups.py | config.yaml 时间点副本：一个目录、一套命名、有界数量 |
| config_home.py | 活动 Hermes home 的目录初始化与存储诊断 |
| config_issues.py | 校验问题记录（config check、doctor、启动警告共用） |
| config_show.py | `hermes config` / `hermes config show` 只读摘要 |
| config_section_guard.py | 防 `config set` 单段键覆盖整个节 |
| config_value_checks.py | 单节值检查（voice/timezone/web backends） |
| config_version_stamp.py | config.yaml 中 `_config_version` 戳的裸读 |
| config_key_notices.py | `config set` 对未知键路径的提示 |
| config_read_errors.py | config.yaml 读不了/解析失败时的行为 |
| config_runtime_keys.py | 运行时读但 DEFAULT_CONFIG 遍历看不见的键 |
| config_worker_save.py | 冻结会话配置时 `save_config` 持久化什么 |
| config_language.py | `display.language` 校验，可插拔语言 |
| config_check_diagnostics.py | 已存 toolsets 与捆绑平台选择的只读诊断 |
| cli_config_load.py | 经典 CLI 配置装载：prefill 消息、reasoning/service-tier 解析、终端 env 镜像 |
| env_loader.py | 各入口一致的 .env 装载助手 |
| managed_scope.py | 托管作用域：IT 下发、用户不可变的 config 与 env 层 |
| skin_engine.py | 主题 SDK：SkinConfig 与每个表面的着色 |
| skin_cmd.py | `hermes skin` 命令 |

## 与其他模块的关系

- **gateway/**：网关的 presence-sensitive env bridge 读 `config_effective`（缺键=未设置语义）。
- **doctor/setup**：`config_issues`/`config_check_diagnostics` 喂体检输出。
- **dashboard/web_routers/config_env.py**：config/env 的 HTTP 视图经同一套保存原语。
- **pm/**：`.env` 是密钥唯一容身处的政策由本簇执行（ UPPER_SNAKE 形状路由）。

## 总结

配置系统的分层一句话：**默认（DEFAULT_CONFIG）→ 用户（config.yaml，${VAR} 先展开）→ 托管（managed overlay）**。想读「用户到底设没设」就用 `config_effective`；想写就回 `config.py` 门面；键去哪由形状决定。皮肤是横切所有表面的纯数据 SDK。
