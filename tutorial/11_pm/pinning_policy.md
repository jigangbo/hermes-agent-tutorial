# 钉版政策与 lock/update —— 上限、SHA 与 release-age 隔离

## 文件概览

PM 拥有依赖变更的同时，也拥有**钉版政策**：全部依赖带上限、git 依赖钉 40 位 SHA、release-age 检查只在 Hermes 锁定时生效。本篇走读 `lock.py`（lockfile 与安装态文件的 schema）、`update.py`（解析最新并重钉）、`uv_cache_health.py` / `uv_cache_prune.py`（缓存守护），并把政策里剩下的支持文件（recovery/receipt/launch/runtime/…/plugin_*）全部列册。

## 关键代码走读

### lock.json 与 facts.json：机器接口

```python
# pm/lock.py:1-16（docstring 节选）
"""The lockfile (versions + hashes, machine-written) and the installed-state
file (what is actually on this machine).

lock.json:  {"schema": 1, "packages": {name: {"version": ..., "artifacts": {target: {"url": ..., "sha256": ...}}}}}
facts.json: {"schema": 1, "packages": {name: {"entry": ..., "version": ..., "env": ..., "stamp": ...}}}

A target's value is one {"url", "sha256"} object, or a LIST of them when the
package is split across several archives that must land in one directory
(llama.cpp's engine zip and its cudart zip: Windows resolves a DLL from the
loading executable's own directory). Both shapes read back as a list.

lock.json artifacts carry the RESOLVED url beside the hash: the lockfile is
the complete machine interface (nix reads it as pure data), and the python
url templates are consulted only at `pm lock --bump` time.

facts.json env values hold {{store}} templates so a CI-built file adopts onto
any machine by substitution.
"""
```

两个文件、两种承诺：lock.json 是「**应该**装什么」（版本+每 target 的 URL+SHA，机器写人只读），facts.json 是「**实际**装了什么」——env 值带 `{{store}}` 模板，CI 机器构建的安装态可以按替换 adopt 到任何机器。这就是 `hermes pm doctor`（对 lockfile 校验安装态）与 `hermes pm repair`（按记录环境重建、不改图）的依据。

### 上限政策：Shai-Hulud 的教训

政策全文（`pm/AGENTS.md`）的数字都有出处：PyPI 依赖 `>=floor,<next_major`（`"httpx>=0.28.1,<1"`）；pre-1.0 用 `<0.(minor+2)`（`>=0.29,<0.32`）；git URL 钉 40 位 commit SHA；GitHub Actions 钉 SHA + `# vN` 注释；CI-only requirements 用 `==exact`。裸 `>=X.Y.Z` 会被 CI 和评审直接拒绝。背景是 litellm 事件（#2796/#2810）与 2026 年 5 月的 Mini Shai-Hulud 蠕虫——无上限的 `>=` 意味着上游任意一次发布都会自动进入你的供应链。

### release-age 隔离：只属于锁定者

```python
# pm/workspace.py:184-194
def _without_release_age(text: str) -> str:
    """Drop ``[tool.uv] exclude-newer`` from a generated root's pyproject text.

    The lock already holds checked versions; on the user's machine the cutoff only gates the
    build tools uv fetches for source builds (setuptools for Hermes itself), and a mirror that
    serves no upload times rejects all of them (#135589). Text-level so the pre-3.11 bootstrap
    python, which has no tomllib, can run it.
    """
    import re

    return re.sub(r"(?m)^exclude-newer\s*=.*\n", "", text)
```

`[tool.uv] exclude-newer = "3 days"` 的 release-age 检查**只在 Hermes 锁定时跑**（`hermes pm lock`、CI 的 lock 检查），且覆盖 Hermes 自己的全部依赖（含精确钉）、只有一类豁免：CA 信任库（`certifi`）——吊销发布必须当天进锁（`exclude-newer-package`，别的包不许进这个表）。每个用户机器上生成的 workspace 都会摘除这个截止（`_generate_pyproject` 行 165-167 先 pop 掉两个键，行 179 再对文本兜底）：锁里已经是被检查过的版本，用户机器上的截止只会拦住 uv 为源码构建取的构建工具，而一个不提供上传时间的镜像会因此拒绝一切（#135589）。JS 侧对应物是 `pnpm-workspace.yaml` 的 `minimumReleaseAge`（14 天），豁免是一行精确的 `- name@1.2.3  # why`；`hermes pm update --pnpm` 会点名并随后丢弃豁免。插件依赖遵循插件自己的政策（Teknium 裁定：「plugins dont have to abide by our 14 day rule … Only hermes' dependencies themselves have to」）。

### update：两种版本风格

```python
# pm/update.py:1-22（docstring 节选）
"""hermes pm update: resolve the latest versions and re-pin the lockfile.

Each Package subclass declares how to find its own latest via
``latest_versions(target)`` (see pm/package.py); this module is the driver:
it intersects those candidate lists across the targets the package serves,
compares against the lockfile, and (in real mode) re-pins + reinstalls.

Two version styles (``Package.version_style``):

  semver — one shared version across targets (node 26.7.0, uv 0.12.3).
          The update is the highest version every relevant target serves.
  minor  — the lockfile ``version`` field is major.minor; each target's
          exact patch lives in ITS artifact urls. ...
```

`--check` 是纯干跑：打上游索引（小 HTTP GET）但不写锁、不进 store、不下载 artifact；真实 `pm update` 重钉变化的包（`pm lock` 式哈希）、安装、刷 venv，并在依赖腿启用时连 uv.lock 与 pnpm-lock.yaml 一起刷。`cli.py` 的 `cmd_update`（行 760）是入口；`pnpm_release_age.py` 专门负责「pnpm 的 minimumReleaseAge 拒掉了谁」——pnpm 12 的错误码不报包名，得在 workspace 决议输入的副本上用允许保存的方式重跑一次才能列出来。

### uv 缓存：健康检查与精确修剪

```python
# pm/uv_cache_health.py:1-9（docstring）
"""Find corrupt entries in PM's uv cache.

uv unpacks every wheel into ``<cache>/.tmpXXXX`` and renames the directory
into ``archive-v0/<id>``; it never flushes the file data first. When the
machine stops mid-install (a hosted restart, a power cut), the rename can
survive while the files read back as NUL bytes. uv then reuses that entry on
every later sync and fails at install time with "The wheel is invalid", and
retrying cannot help. These helpers recognise that failure and name the
packages to purge. Deletion goes through ``uv cache clean`` (the caller),
which takes uv's cache lock, so a concurrent sync never loses files mid-read."""
```

故障模式很具体：rename 存活、内容是 NUL——重试永远无效，必须按错误里的 wheel 名定位缓存条目清除。而「fetch/解析/磁盘满」类失败绝不打印这些标记，所以不会被误判为损坏。`uv_cache_prune.py` 是另一个方向：把滚动 CI 缓存修剪到**恰好** uv.lock 能解析的集合（比 `uv cache prune --ci` 更精确，不丢当前锁仍需要的 wheel）——这是 bundle payload 与 CI 快照的「exactness contract」。

## 核心类/函数

| 符号 | 位置 | 职责 |
|---|---|---|
| `Lockfile` / `read` / `set_pin` | `lock.py` | lock.json 读写 + `--bump` 写钉 |
| `InstalledState`（facts.json 读取） | `lock.py` | 安装态 schema + `{{store}}` adopt |
| `cmd_lock()` / `_relock_project()` | `cli.py:24/31` | 重锁 + 新 extra 提示 |
| `_pin_tool()` | `cli.py:99` | 解析各 target 归档、哈希、写 lock.json |
| `resolve_package()` / `Resolved` | `update.py` | 跨 target 求交的最新版解析 |
| `reuse_index_responses()` | `update.py` | 一次 update 内复用索引响应 |
| `cmd_update()` | `cli.py:760` | update 入口（含 `--pnpm`/`--termux` 腿） |
| `_without_release_age()` | `workspace.py:184` | 用户机器摘除 exclude-newer |
| `classify_corruption()`（语义） | `uv_cache_health.py` | NUL 内容识别 + 点名待清包 |
| `lock_package_names()` | `uv_cache_prune.py` | 锁可解析集 = 缓存修剪契约 |
| `STARTUP_IMPORTS` | `recovery.py` | 无导入受损环境的代恢复探针 |
| `record_*` / `begin` / `finalize` | `receipt.py` | ContextVar 回执（copy-on-write + token 恢复） |
| `main()` | `launch.py` | PM CLI 入口：truststore → 租用 runtime → cli.main |
| `runtime_environment()` / `lease_current_runtime()` | `runtime.py` | PM 运行时与图隔离 |
| `stage_runtime()` | `runtime_stage.py` | PM worker/打包运行时的唯一锁定构建器 |
| `ensure_project_environment()` | `testenv.py` | 测试 side environment（dev+test 组） |
| `read_extras_file()`（语义） | `features.py` | 已装 extras 清单（冻结/基线两态） |
| `anchor_for_extra`（表） | `extras.py` | feature 名 = extra 名，锚 import 一个 find_spec 判定 |
| `_toolchain()` | `_uv.py` | 钉版 uv+Python 获取（非 worker API） |
| `main`（脚本语义） | `_venv_entry.py` | `python -S _venv_entry.py SITE ARGS` 跨解释器执行 |
| `main`（脚本语义） | `_marker_eval.py` | 无 packaging 解释器委托评估 PEP 508 marker |
| `pin` 表 + `termux_runtime_libs.json` | `termux_libs.py` | Termux 池钉（rolling pool，pin 会烂，repin=repair） |
| `install_security_executable`（语义） | `security_packages.py` | 可选安全可执行文件的获取与发布 |
| `name_immature_picks`（语义） | `pnpm_release_age.py` | pnpm minimumReleaseAge 拒绝名单 |
| `native_manifest_file()` / `python_dependencies` | `plugin_declarations.py` | 读插件构建声明（不 import 插件代码） |
| `Members` | `plugin_inputs.py` | venv 同步/探针的插件成员输入（一请求一来源） |
| `read_enabled_plugins`（语义） | `plugins_state.py` | 按 config 顺序读全 profile 启用集 |
| `evict_incompatible()`（语义） | `plugin_eviction.py` | 更新时禁用不适配插件、适配后撤销 |

## 本组文件清单

| 文件 | 角色 | 关键符号 |
|---|---|---|
| `pm/lock.py` | lockfile/facts schema 与读写 | `SCHEMA`, `STORE_TOKEN` |
| `pm/lock.json` | 被管理工具的版本+SHA 表（数据） | 机器写 |
| `pm/update.py` | 解析最新 + 重钉驱动 | `resolve_package`, `version_style` |
| `pm/uv_cache_health.py` | uv 缓存损坏识别 | `_FAILED_INSTALL` 正则 |
| `pm/uv_cache_prune.py` | 按 lock 精确修剪缓存 | `lock_package_names` |
| `pm/recovery.py` | 不导入受损环境的代恢复 | `STARTUP_IMPORTS` |
| `pm/receipt.py` | 同步回执（机器可读面） | ContextVar + copy-on-write |
| `pm/launch.py` | PM CLI 入口 | truststore → `lease_current_runtime` |
| `pm/runtime.py` | PM 自有运行时（与图隔离） | `runtime_environment` |
| `pm/runtime_stage.py` | 唯一锁定依赖构建器 | `stage_runtime` |
| `pm/testenv.py` | 测试 side environment | dev+test 组 |
| `pm/features.py` | 已装 extras 清单（冻结/基线） | lazy installs 两态 |
| `pm/extras.py` | extra ↔ 锚 import 表 | `find_spec` 判定 |
| `pm/carried_extras.py` | 迁移遗留 extra 不再构建时的处理 | 保活记录 |
| `pm/_uv.py` | 钉版工具获取 | `_toolchain` |
| `pm/_venv_entry.py` | 跨解释器 venv 执行 | `python -S` 协议 |
| `pm/_marker_eval.py` | marker 委托评估 | `Marker(...).evaluate` |
| `pm/termux_libs.py` | Termux 运行库池钉 | repin=repair 工作流 |
| `pm/termux_runtime_libs.json` | 库钉表数据 | 数据文件 |
| `pm/security_packages.py` | 可选安全可执行文件 | 获取/发布归 PM |
| `pm/pnpm_release_age.py` | pnpm 拒绝名单 | scratch 副本探针 |
| `pm/plugin_declarations.py` | 插件构建声明读取 | `native_manifest_file` |
| `pm/plugin_inputs.py` | 插件成员输入（一请求一来源） | `Members` |
| `pm/plugins_state.py` | 全 profile 启用集读取 | 共享 union |
| `pm/plugin_eviction.py` | 更新期的插件驱逐/撤销 | 指纹重试 |
| `pm/paths.py` | store/lockfile/安装态路径 | 三路径权威 |
| `pm/filesystem.py` | stdlib-only 文件系统原语 | boot 期可导入 |
| `pm/network.py` | PM 幂等网络操作的有界重试 | 指数退避 |
| `pm/progress.py` | 子进程输出策略（CI 全流/其余收敛） | `CI`/`HERMES_VERBOSE` |
| `pm/publication.py` | worker 本地插件选择与代码发布 | 安装锁内快照 |
| `pm/user_facing.py` | 终端 PATH：用户工具优先 | Hermes 工具为回退 |
| `pm/shell.py` | `pm.shell()`：唯一的 shell 解析点 | Windows Git Bash 经 store |
| `pm/client.py` | 隔离解释器里的同步 PM 变更 | 不碰应用 imports |
| `pm/defaults.py` | 默认安装的可选包与用户退出 | `--skip-browser` |
| `pm/index_config.py` | 转发索引/传输配置进 uv | 镜像/气隙需要 |
| `pm/libatomic.py` | libatomic 处理 | 平台特例 |
| `pm/pip_check.py` | pip check 一致性校验 | 同步后验证 |
| `pm/pyproject.toml` | PM 自身的包元数据 | 数据文件 |
| `pm/uv.lock` | PM 运行时自身的锁 | 数据文件 |
| `pm/__init__.py` | 包入口（`pm.check_project_lock`/`lock_project`/`ensure` 门面） | 重导出 |
| `pm/AGENTS.md` | 区域指南（钉版政策全文） | 文档 |

## 与其他模块的关系

- **CI**：lock 检查跑同一套 exclude-newer；`scripts/ci/` 的归档链把 termux 库镜像进 R2。
- **hermes update**（`hermes_cli/update*`）：大消费者；回执 schema 与 `pm.receipt` 相同（同一目录、`kind` 区分）。
- **plugin 体系**：admission 拥有写、discovery 只读；eviction 的指纹在「任一侧变了」时重试。
- **activate**：`./activate` 与 `scripts/run-in-hermes-env` 消费 `ACTIVATION_INPUTS` 戳与 features 文件。
- **cron/worker_bootstrap**：租用 committed 代 = 本篇政策的最终受益者（收集器不敢删有租约的代）。

## 总结

钉版政策的每一数字都对着一次真实事故：上限对着供应链蠕虫，SHA 钉对着 tag 移动，release-age 对着刚发布的投毒版本，certifi 豁免对着 CA 吊销的时效性。实现上政策被切成两个不变式：**锁定者检查年龄，消费者信任锁**（用户机器摘除截止）；**lock.json 是完整机器接口**（Nix 直接当数据读）。缓存健康/修剪、回执、恢复、插件驱逐都是这两个不变式的配套件。
