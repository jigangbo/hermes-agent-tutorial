# 09.2 边界治理 —— boundary_lint 与"特性离开核心"的迁移表

「插件永不触碰核心」不是口号，而是**CI 里跑得动的两向 lint + baseline 棘轮**。这一篇读 `scripts/boundary_lint.py`（181 行）的判定逻辑，以及配套的 `hermes_cli/data/plugin_api.json` 与 `hermes_cli/left_core_migration.py`。

## 文件概览

| 文件 | 行数 | 角色 |
|------|------|------|
| `scripts/boundary_lint.py` | 181 | 两向 import lint：模块→核心、核心→模块 |
| `scripts/boundary_lint_baseline.json` | — | 每个跨越的计数棘轮 |
| `hermes_cli/data/plugin_api.json` | — | 已发布插件 API（`module` 与 `module:Name` 条目） |
| `hermes_cli/plugin_validate_private_imports.py` | — | lint 复用的核心判定（与 `hermes plugins validate` 同源） |
| `hermes_cli/left_core_migration.py` | 1338 | LEFT_CORE 迁移表：离开核心的特性自动装回 |
| `scripts/gen_plugin_api_docs.py` | — | 从 plugin_api.json 渲染 `public-api.md` |

## 关键代码走读

### 1. 两向规则

```text
# scripts/boundary_lint.py:2-21 (docstring 节选)
"""Report-only import lint for the core/module boundary, in both directions.

* **module -> core internals**: a bundled module imports a Hermes module or name that is not on the
  published plugin API (``hermes_cli/data/plugin_api.json``), e.g. ``gateway.run``. The rule is the one
  ``hermes plugins validate`` warns with (``plugin_validate_private_imports.private_import_findings``),
  so the lint and the plugin-author warning cannot drift.
* **core -> module**: core code imports a specific module (``plugins.platforms.discord.adapter``)
  instead of reaching it through discovery and the plugin contracts.

A *module* is a directory under ``plugins/`` with a ``plugin.yaml`` manifest, or a ``plugins/<name>/``
with a ``dashboard/manifest.json``. Everything else under ``plugins/`` (``plugin_loader``,
``plugin_utils``, ``plugins/memory/__init__.py`` discovery, ...) is core plugin plumbing. *Core* is
every other file of the shipped packages (pyproject ``packages.find``) and the root ``*.py`` modules;
tests, scripts, docs and skills are neither.
```

两个方向的措辞值得逐字体会：**模块 → 核心**禁的是"import 一个不在已发布 API 上的名字"；**核心 → 模块**禁的是"import 一个**具体的**模块"——核心应该经发现与插件契约到达模块，而不是点名。判定范围也有精确定义：有 `plugin.yaml` 的目录才算"模块"，`plugin_loader`/`plugin_utils`/`plugins/memory/__init__.py` 这些是核心插件管线。

### 2. 模块判定与发现函数

```python
# scripts/boundary_lint.py:51-65 (节选)
def module_dirs(root: Path = ROOT) -> list[Path]:
    """Every bundled module directory under ``plugins/``."""
    plugins = root / "plugins"
    dirs = {p.parent for p in plugins.rglob("plugin.yaml") if not _SKIP_PARTS.intersection(p.relative_to(plugins).parts)}
    dirs |= {p.parent.parent for p in plugins.glob("*/dashboard/manifest.json")}
    return sorted(dirs)


def module_to_core(root: Path = ROOT) -> list[str]:
    """``["plugins/<module>/<rel>:<line> <target>", ...]`` for every module import of a core internal.
    An in-tree module's full-path import of itself (``plugins.web.exa.provider``) or of another module
    is not a core import, so it is left out."""
    modules = module_dirs(root)
    return [f"{d.relative_to(root).as_posix()}/{hit}" for d in modules for hit in private_import_findings(d)
            if not _in_module(hit.split(" ", 1)[1], root, modules)]
```

模块自己的全路径导入或对另一模块的导入不算核心导入。反向扫描用 AST：

```python
# scripts/boundary_lint.py:110-127 (节选)
def core_to_module(root: Path = ROOT) -> list[str]:
    """``["<rel>:<line> <module path>", ...]`` for every core import that names a specific module."""
    modules = module_dirs(root)
    found: set[tuple[str, int, str]] = set()
    for path, rel in _core_files(root, modules):
        try:
            tree = ast.parse(path.read_text(encoding="utf-8-sig"))
        except (OSError, SyntaxError, ValueError):
            continue
        skipped = _type_checking_nodes(tree)
        for node in ast.walk(tree):
            if id(node) in skipped:
                continue
            for spellings in _targets(rel, node):
                # Collapse the spellings of one alias to one target; distinct aliases count separately.
                if hits := [t for t in spellings if _in_module(t, root, modules)]:
                    found.add((rel.as_posix(), getattr(node, "lineno", 0), min(hits, key=len)))
    return [f"{rel}:{line} {target}" for rel, line, target in sorted(found)]
```

`_targets` 把相对 `from . import x` 折算成绝对点名再判归属；TYPE_CHECKING 块里的导入跳过（类型引用不是运行时耦合）。

### 3. baseline 棘轮：只拦"增量"，不追"存量"

```python
# scripts/boundary_lint.py:134-155 (节选)
def _key(site: str) -> str:
    """What a site couples: ``<importing file> <target>`` (repo-relative path, line dropped). Two
    branches that add the same target from different files add two different keys; a file that imports
    one target twice counts 2 under one key."""
    loc, target = site.split(" ", 1)
    return f"{loc.rsplit(':', 1)[0]} {target}"


def regressions(current: dict[str, dict[str, int]], baseline: dict[str, dict[str, int]]) -> list[str]:
    """One line per key whose count rose above the baseline: a swap still fails, and the line names
    the new import."""
    return [f"{d}: {key} ({n}, baseline {baseline.get(d, {}).get(key, 0)})" for d in DIRECTIONS
            for key, n in current[d].items() if n > baseline.get(d, {}).get(key, 0)]
```

baseline 按导入文件 × 目标计数。所以：已存的跨越不失败（存量豁免）；**同一文件的跨越搬家仍会失败**（计数按导入文件走，搬家使新文件超出 baseline）——这正是 AGENTS.md 说"import 搬到另一个文件也要跑 `--update`"的原因；消除跨越后跑 `--update` 让更低的计数钉住。`main()`（158-177 行）提供 `--list` / `--check` / `--update`；CI 跑的是 `--check`，`tests/scripts/test_boundary_lint.py` 同步把守。

### 4. plugin_api.json：发布面的机器形态

```python
# hermes_cli/data/plugin_api.json 的 _comment（节选）
# The modules and names a plugin may import from Hermes core. `hermes plugins validate` warns on any other
# Hermes import (hermes_cli/plugin_validate_private_imports.py), and scripts/gen_plugin_api_docs.py renders
# website/docs/developer-guide/plugins/public-api.md from this file.
# A `module` entry allows the module and its non-underscore names; `module:Name` allows that one name.
```

结构是 `{_comment, groups: [...]}`，groups 按"来源"分组（developer-guide / plugins docs / ctx 交出的对象 / 文档教作者调的名字），共 8 组、每条目形如 `agent.memory_provider`、`gateway.platforms.base` 或窄到单名的 `hermes_cli.auth_model_picker:prompt_model_selection`。**这份清单就是 API**：加名字 = 发布能力给每一个插件作者，所以 AGENTS.md 警告"never list one just to pass the lint"。修复一个 lint 失败的正当顺序（AGENTS.md §Boundary lint）：先用清单上已有的名字 / ctx 方法 / 发现路径；都不行就**单独一个 PR 先加 seam**，指名哪个插件需要它——优先 ctx 方法或 hook，其次 `plugin_api.json`（`module:Name`），再 `scripts/gen_plugin_api_docs.py` 重新生成 `public-api.md`、写文档、加行为测试。

### 5. 特性离开核心：LEFT_CORE 迁移表

边界治理的另一半是"已被移出核心的特性，怎么把还在用的家自动接上"。`hermes_cli/left_core_migration.py` 的 docstring 就是合同：

```text
# hermes_cli/left_core_migration.py:1-13 (docstring 节选)
"""Move a home onto the catalog plugin of a feature that left core.

A feature (gateway platform, toolset, bundled plugin) that moves from core into a standalone catalog
plugin keeps its names, config keys and env vars, so migrating is only "install the plugin". Each row of
:data:`LEFT_CORE` names the catalog plugin and a read-only predicate "does this home use it". The
contract is the one memory providers established (``memory_provider_migration``, whose helpers this
reuses; memory is not a row because its plugin name comes from ``memory.provider``, not a table):

* ``hermes update`` installs the plugin for every profile home sharing the venv that uses the feature.
* Agent start and gateway start retry once per process for the active home ...
* After a failed attempt ... starts skip the row for an hour, doubling with each further failure up to a week ...
* A home gets the plugin automatically at most once (``_left_core_installed`` in its config.yaml):
  ``hermes plugins remove`` afterwards is the user's choice and sticks."""
```

表本体（572 行起）每行是一个特性，字段即语义：

```python
# hermes_cli/left_core_migration.py:572-580 (节选)
LEFT_CORE: tuple[LeftCoreFeature, ...] = (
    LeftCoreFeature(
        plugin="homeassistant", label="Home Assistant", in_use=homeassistant_in_use,
        unchanged="HASS_TOKEN/HASS_URL, platforms.homeassistant and the ha_* tool names are unchanged",
        secret_env=("HASS_TOKEN",), private_env=("HASS_URL",),
        toolsets=("homeassistant",), off_platforms=("acp", "webhook"), platform="homeassistant",
        enable_env=("HASS_TOKEN",), channel_env_prefixes=("HASS_",),
    ),
    LeftCoreFeature(
        plugin="spotify", label="Spotify", in_use=spotify_in_use,
        unchanged="your Spotify login, the spotify toolset and the spotify_* tools are unchanged; "
                  "`hermes auth spotify` is now `hermes spotify login`",
        cli="spotify",
    ),
```

字段面（AGENTS.md「Other features that leave core」节的完整规则）：`in_use` 是只读谓词（无家内信号的特性如 MCP 客户端恒 False——只提示不自动装）；`toolsets`/`providers`/`hosts`/`terminal_backend` 让各类"未知名"错误报出安装命令；`cli` + `command`/`old_command` 让旧拼写打印新去向（`hermes mcp serve` → `hermes mcp-serve`）；`secret_env`/`private_env`/`profile_env`/`launch_env` 分类核心保留的 env 写权限；`notice` 给每个结果附加一句 per-home 提示。安装与状态转换是**两步**：toolset 范围转换按家×行记在 `_left_core_scoped`，自动安装记在 `_left_core_installed`（目录存在后才写）——所以 `hermes plugins remove` 之后不再自动装回来，失败安装会重试。

Home Assistant（Oct 2026）、Spotify toolset、Singularity 终端后端、GitHub Copilot 提供方、Langfuse 都在这张表上——它们离开核心时名字、config、env 全保留，迁移只是"装插件"。

### 6. 内部导入路径不是 API

PR #102117 把内部搬进 `<stem>_<topic>` 兄弟模块时留过的临时兼容层已在 2026-09-14 窗口后移除：旧路径现在抛 `ImportError`，以插件加载错误的形态出现在 `hermes plugins list` 里。**永远不为内部搬迁加 re-export shim**。`hermes_cli/plugin_compat.py` 只剩三个惰性 stub，供已在运行的旧 updater 导入。

## 核心类/函数

| 名称 | 位置 | 职责 |
|------|------|------|
| `module_dirs` | `scripts/boundary_lint.py:51` | 判定哪些 plugins/ 子目录是"模块" |
| `module_to_core` | 同上 :59 | 方向一：模块 import 核心内部名 |
| `core_to_module` | 同上 :110 | 方向二：核心 import 具体模块（AST 扫描） |
| `_key` / `tally` | 同上 :134/:142 | 跨越键（文件×目标）与计数 |
| `regressions` | 同上 :151 | 只报超过 baseline 的增量 |
| `main` | 同上 :158 | `--list` / `--check` / `--update` |
| `private_import_findings` | `hermes_cli/plugin_validate_private_imports.py` | 与 `hermes plugins validate` 共用的判定源 |
| `LeftCoreFeature` / `LEFT_CORE` | `hermes_cli/left_core_migration.py:486/:572` | 离核特性行定义与全表 |
| `install_for_homes` 等 | 同上（复用 memory_provider_migration 助手） | 自动安装与一次性标记 |

## 本组文件清单

| 文件 | 一句话 |
|------|--------|
| `scripts/boundary_lint.py` | 两向 lint（本篇主角） |
| `scripts/boundary_lint_baseline.json` | 棘轮 baseline（`--update` 重写全量） |
| `hermes_cli/data/plugin_api.json` | 已发布 API 清单（`module` / `module:Name`） |
| `hermes_cli/plugin_validate_private_imports.py` | 判定内核（validate 与 lint 共用） |
| `hermes_cli/left_core_migration.py` | LEFT_CORE 表 + 自动安装引擎 |
| `hermes_cli/memory_provider_migration.py` | 被复用的迁移助手（首例） |
| `scripts/gen_plugin_api_docs.py` | plugin_api.json → public-api.md |
| `hermes_cli/plugin_compat.py` | 三个惰性 stub（兼容层遗骸） |
| `tests/scripts/test_boundary_lint.py` | CI 侧的同步把守 |

## 与其他模块的关系

- **CI**：boundary lint 是阻塞检查；`plugin-catalog-ci.yml` 在目录侧做准入扫描（见 catalog.md）。
- **`hermes plugins validate`**：对单个插件给出同样的 private-import 警告（判定源同上），作者本地就能跑。
- **`ctx`/`plugin_api.json`**：见 plugin_api.md——lint 是那张清单的执法者。
- **catalog 安装路径**：`left_core` 的自动安装走普通目录安装（kill list、依赖约束、enable 全适用）。

## 总结

边界治理是三件互相咬合的机器：**lint 用 baseline 棘轮只拦增量**（搬文件也算新跨越，删跨越要主动钉住更低的计数）；**plugin_api.json 是发布面**（加名字就是向每个作者发布能力，不许为过 lint 加名字）；**LEFT_CORE 是离核特性的接生表**（保留名字与环境、自动安装一次、失败退避、remove 后不再自动装）。加上"内部导入路径不是 API"的 shim 禁令，这套机器保证边界只会朝"更薄的核心、更多的边缘"单向移动。
