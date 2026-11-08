# 09.3 plugin-catalog/ —— 约 1,150 条 YAML 的信任模型

`plugin-catalog/` 是**树外插件的唯一发现系统**：一个 YAML 一个条目（`0bull.yaml`、`3ds-platform.yaml`…共约 1,150 个，外加 `README.md` 与黑名单 `removed.yaml`），可经 `hermes plugins catalog` / `hermes plugins search` 浏览，`hermes plugins install <name>` 安装。README 第一句立住信任模型："Presence in this directory **is** the trust signal."——目录里的存在本身就是人工准入的信号。

## 文件概览

| 文件 | 行数 | 角色 |
|------|------|------|
| `plugin-catalog/README.md` | 260 | 准入政策 18 条 + 条目 schema + 黑名单语义 |
| `plugin-catalog/<name>.yaml` ×~1150 | — | 每个插件一个条目，40-hex SHA 钉 |
| `plugin-catalog/removed.yaml` | — | kill list |
| `hermes_cli/plugin_catalog.py` | 534 | loader、活刷新、回退 |
| `hermes_cli/plugins_cmd_catalog.py` | 1011 | 解析、provenance sidecar、search/info/validate、re-pin |
| `.github/workflows/plugin-catalog-ci.yml` | — | 每个**变更**条目在其 pin 上 clone 并跑 `hermes plugins validate` |

## 关键代码走读

### 1. 准入规则（18 条，README 逐字镜像进开发者指南）

```text
# plugin-catalog/README.md:14-29 (规则 1-4)
1. **Human-merged gate.** Entries are added *only* via a PR to the
   `hermes-agent` repository, reviewed and merged by a maintainer. There is
   no self-serve registry, no automated ingestion.
2. **Exact SHA pins are mandatory.** Every entry pins a full 40-character
   commit SHA. Branches, tags, and short SHAs are rejected by the loader.
   Installs clone the repository and check out exactly that commit.
3. **No self-updating code.** A listed plugin must not fetch and replace
   its own files ... The exact SHA pin *is* the trust model; a
   self-updater lets an installed copy move to a commit nobody reviewed.
   Updates reach users only through a SHA-bump PR here plus
   `hermes plugins update <name>`.
4. **SHA bumps are new PRs.** Updating an entry's pin is a new PR whose diff
   (old SHA → new SHA) is re-reviewed like any other change — reviewers are
   expected to look at the upstream commit range being adopted.
```

完整 18 条的主干（每条都在 README 带编号小节）：人工合并 PR 门（1）；40-hex SHA 钉强制（2）；禁自更新代码（3）；SHA 升级 = 新 PR 重审（4）；owner-or-major-contributor 提交或维护者梳理批入（5）；`capabilities:` 必须与 pin 上的实际注册相符，未声明的能力蔓延按安全问题处理（6）；准入时跑安装扫描，`dangerous` 拒绝、`caution` 由审阅者读过再合（7）；desktop 插件限 SDK 表面——禁 prototype 补丁、禁 eval/new Function、禁非 SDK 的 import()、禁伸进应用内部 store 或标记（8）；禁运行时覆盖 Hermes 核心（禁 `AIAgent.<method> = ...`、`sys.modules[...]` 写入等，hook 不存在就开 issue 加 seam，9）；依赖安全政策归插件但受核心约束、裸地板版本会被要求加天花板（10）；凭据只走 Hermes 路由——`get_secret` / `credentialed_provider_request` / `oauth:` 声明，绝不读 .env/auth.json/别的工具的 token 文件（11）；尊重审批系统、无人值守下干净失败（12）；风险行为须披露、遥测 opt-in（13）；`requires_hermes` 是 SemVer 地板且被执行、`version` 与 pin 相符（14）；禁皮肤/禁捆绑插件的 fork 竞品（15）；一个插件谱系只列一次（16）；禁不可扫的二进制 payload——源码可读是准入前提，真需要原生组件就由插件仓库自己的公开 Actions 构建并带 GitHub build attestation（17）；密码管理器登录后端只收 vendor 仓库的 verified/official 条目（18）。

### 2. 条目 schema 与一个真实条目

```yaml
# plugin-catalog/README.md:180-208 (schema 节选)
name: example-plugin        # [a-z0-9_-]{1,64}, the catalog key
repo: https://github.com/owner/repo   # https:// only
sha: <40-hex commit sha>    # mandatory exact pin
description: One-line description.
maintainer: OwnerName
tier: community             # official | verified | community (default community);
                            # official and verified are set by Nous maintainers only
category: memory            # desktop | memory | platform | web | tools | voice | automation | models | general
requires_hermes: ">=0.19"   # optional; enforced at install and update (also declare it in plugin.yaml)
version: "1.4.0"            # optional human label for the sha (quote it); shown as "1.4.0 @ abcd1234"
platforms: []               # optional, e.g. [linux, macos]; empty = all
capabilities:
  provides_tools: []
  provides_hooks: []
  provides_middleware: []
  requires_env: []
```

`tier` 说的是"谁站在条目背后"：`official`（NousResearch 维护）、`verified`（Nous 核实来自被集成公司的官方仓库）、`community`（其余）。`version`/`image`/`screenshots`/`readme` 是装饰性的——**SHA 才是 release**；`bump version` 要与 `bump sha` 同 PR。图片只许 GitHub 主机（raw.githubusercontent.com 等），URL 钉到条目的 commit——图与代码一样不可变。真实条目（`0bull.yaml`）展示了披露字段的样子：description 里明写"hosted-only connector; screenshots… go to 0bull.net; posts publish publicly…"。

### 3. removed.yaml：kill list

```yaml
# plugin-catalog/removed.yaml:1-9
# Blocklist for plugins pulled from the catalog for security or policy
# reasons. The installer refuses to install anything whose name or repo URL
# matches an entry here (unless the caller explicitly bypasses the check).
# Each entry: {name, repo, reason, date}. Removals land via reviewed PRs,
# same as additions.
#
# Name only. Do not set repo: the replacement entry is the same repository,
# and a repo match would refuse that install too.
removed:
- name: or-picker
  reason: "Folded into openrouter-picker. ..."
  date: "2026-09-28"
```

每条安装路径（CLI、dashboard、TUI）都拒绝与移除条目匹配的名字或 repo URL——repo URL 按 canonical 的 `host/owner/repo` 比较，`git@`/`ssh://`/`www.` 拼写照样命中。移除后：已装插件停止更新、无法 enable、加载时被 `gate_manifest` 拒。**只有 CLI 有响亮的 `--allow-removed`**，它记录在安装记录上，也是 `update`/`enable`/load 时唯一能豁免同项检查的东西。注意黑名单与下架（delisting）的区别：不再维护/换名抢位/违反新规则是**普通文件删除**，已装用户不受影响，修好后欢迎回来；进 `removed.yaml` 是安全/政策处置。

### 4. loader：活刷新与三层回退

```python
# hermes_cli/plugin_catalog.py:1-9 (docstring)
"""Plugin catalog — curated, Nous-approved Hermes plugins shipped with the repo.

Mirrors the ``optional-mcps/`` MCP-catalog pattern: one YAML file per entry under the in-tree
``plugin-catalog/`` directory, pinned to an exact 40-character commit SHA. Presence in the directory IS
the human-merged approval gate; SHA bumps are new, re-reviewed PRs; ``removed.yaml`` is the kill list
(installs of a removed name/repo are refused with the recorded reason). Full policy:
``plugin-catalog/README.md``.

Live refresh: the docs build publishes the same data as ONE JSON document
(``website/scripts/extract-plugins.py`` → ``/docs/api/plugin-catalog.json``, like the skills index), so
an installed Hermes sees new entries and removals without updating. A fetch failure reuses the last valid
cached copy regardless of age, then falls back to the in-tree copy when no valid cache exists."""
```

关键常量（37-45 行附近）：`LIVE_CATALOG_URL = "https://hermes-agent.nousresearch.com/docs/api/plugin-catalog.json"`、TTL 6 小时、离线 pin 24 小时过期但**缓存的移除条目是永久 kill list**、请求超时 5s、上限 2 MB、`_SHA_RE = re.compile(r"^[0-9a-f]{40}$")`（分支/tag/短 SHA 一律拒绝）。安装来源三选：活 JSON（最新）→ 有效缓存（无论多旧）→ 树内目录（兜底）。

### 5. CLI 面：解析、provenance、re-pin

```python
# hermes_cli/plugins_cmd_catalog.py:1-4, 24, 51-63 (节选)
"""``hermes plugins`` catalog surface: resolution, provenance sidecar, search/browse/info/validate,
catalog-aware update, plus the dashboard/TUI-facing catalog payload helpers."""

CATALOG_SIDECAR = ".hermes-catalog.json"
...
def looks_like_catalog_name(identifier: str) -> bool:
    """Bare ``[a-z0-9_-]`` token — not a URL, ``owner/repo`` or path."""
    from hermes_cli.plugins_cmd import _URL_SCHEMES
    return bool(identifier) and "/" not in identifier and "\\" not in identifier \
        and not identifier.startswith(_URL_SCHEMES) and bool(_NAME_RE.match(identifier))


def raise_if_removed(*candidates: str) -> None:
    """``PluginOperationError`` when any candidate (name or repo URL) is on the kill list."""
```

**裸名解析只经 catalog 或报错**——绝不加第二套名字索引（AGENTS.md 原话）。provenance 的存放位置有一条铁律：目录来源（catalog 块、sha = 实际 checkout 的 commit）住在**安装者拥有的** `.install-metadata.json` 记录里，**绝不进插件树**——树内的 `.hermes-catalog.json` 是 Desktop "Install here" 读的便利副本，Python 永不信任它（仓库可以伪造一份）。`update` 时按 catalog re-pin 到新的已审 commit；`search`/`info`/`validate`（含 `--install-deps`，CI 跑的那个）都在这个模块。

## 核心类/函数

| 名称 | 位置 | 职责 |
|------|------|------|
| `PluginCatalogEntry` / `RemovedEntry` | `hermes_cli/plugin_catalog.py` | 条目/移除条目 dataclass |
| `load_catalog_live` / `cached_removed_entries` | 同上 | 活刷新：URL → 缓存 → 树内三层回退 |
| `_SHA_RE` / `_NAME_RE` | 同上 :45/:49 | 40-hex SHA 与名字格式执法 |
| `is_allowed_image_url` | 同上 :46 附近 | 图片只许 GitHub 主机 |
| `find_removed` / `match_removed` | 同上 | canonical repo URL 匹配 kill list |
| `looks_like_catalog_name` | `plugins_cmd_catalog.py:49` | 裸名 vs URL/owner-repo/路径 |
| `raise_if_removed` | 同上 :58 | 安装路径的统一拒绝点 |
| `CATALOG_SIDECAR` | 同上 :24 | `.hermes-catalog.json` 便利副本（Python 不信任） |
| catalog CLI（search/info/validate/update） | `plugins_cmd_catalog.py` | 用户的目录操作面 |

## 本组文件清单

| 文件 | 一句话 |
|------|--------|
| `plugin-catalog/README.md` | 18 条准入 + schema + removed 语义（与开发者指南逐字镜像） |
| `plugin-catalog/<name>.yaml` ×~1150 | 条目本体（40-hex pin 强制） |
| `plugin-catalog/removed.yaml` | kill list（canonical URL 匹配） |
| `hermes_cli/plugin_catalog.py` | loader + 活刷新 + 回退 |
| `hermes_cli/plugins_cmd_catalog.py` | 解析/provenance/search/info/validate/re-pin |
| `website/scripts/extract-plugins.py` | 文档构建期产出单一 JSON |
| `.github/workflows/plugin-catalog-ci.yml` | 变更条目在 pin 上 clone + validate |
| `tests/website/test_catalog_rules_mirror.py` | README 与文档站的镜像一致性测试 |

## 与其他模块的关系

- **`hermes_cli/plugins_cmd*.py`**：catalog 是安装来源之一；裸名安装经 catalog 解析。
- **`hermes_cli/left_core_migration.py`**（上一篇）：离核特性的自动安装走的就是这条 catalog 安装路径（受审 pin、kill list、依赖约束）。
- **文档站**：每个条目在 `/docs/plugins/<name>` 有生成页；`/docs/api/plugin-catalog.json` 就是活刷新源。
- **Desktop/TUI**：`methods_plugin_catalog.py`（08 篇）把目录 payload 接进 RPC 面；Desktop 读 sidecar 提供"Install here"。

## 总结

目录的信任模型一句话说完：**目录里的存在 = 人工准入，SHA = 被审的 release，`removed.yaml` = 永久否决**。机器执法分布在三处——loader 拒绝非 40-hex 钉与坏 URL、CI 在 pin 上 clone 并 validate、安装路径 canonical 匹配 kill list；人的判断集中在 PR 门与 18 条规则。provenance 只住在安装记录里、便利副本永不信任，是"插件可以对用户做什么"这条主线的最后一次落实：连目录自己都不许被插件伪造。
