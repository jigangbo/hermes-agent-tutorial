# hermes_constants.py —— import-safe 常量与 profile 感知路径

> 阅读前提：根 AGENTS.md 的 HX001 规则（永不硬编码 `~/.hermes`）。本文档覆盖 `hermes_constants*.py` 全部 4 个文件。

## 文件概览

```python
# hermes_constants.py:1-4
"""Shared constants for Hermes Agent.

Import-safe, stdlib-only — importable from anywhere without circular-import risk.
"""
```

`hermes_constants.py`（1,490 行）是全仓库的"路径与宿主事实"单一来源。它的契约是 **import-safe**：只依赖标准库（少数函数内 lazy import `pm`、`hermes_platform`），任何模块在任何阶段都能 import 它而不成环。`get_hermes_home()` / `display_hermes_home()` 是两条铁律（HX001/HX002）的实现地。

## 关键代码走读

### 1. get_hermes_home()：三级解析（行 194）

```python
# hermes_constants.py:194-201
def get_hermes_home() -> Path:
    """Hermes home: context-local override → ``HERMES_HOME`` env var → platform default."""
    override = get_hermes_home_override()
    if override:
        return _expand_hermes_home(override)
    if not os.environ.get("HERMES_HOME", "").strip():
        _warn_profile_fallback_once()
    return get_process_hermes_home()
```

解析顺序：**contextvar 覆盖**（`set_hermes_home_override`，供单线程任务临时换家，绝不碰 `os.environ`——那是全线程共享的）→ **HERMES_HOME 环境变量** → **平台默认**。平台默认在 `_platform_default_hermes_home`（行 57）：Windows 走 `%LOCALAPPDATA%\hermes`，POSIX 走 `~/.hermes`，支持 `HERMES_DATA_DIR_SUFFIX`。env 缺失而 sticky 的 `active_profile` 又不是 default 时发一次性 stderr 警告——子进程 spawner 忘传 HERMES_HOME 是数据落错 profile 的经典事故（#18594）。

`get_process_hermes_home`（行 243）是"进程自己的家"（跟随 HERMES_HOME 现场解析）；`pin_process_hermes_home`（行 259）允许嵌入宿主把"本进程服务的 profile"钉住，路由决策用 `get_routing_process_hermes_home` 读钉值，避免把镜像进 env 的 turn-level profile 误当启动 profile。

### 2. display_hermes_home()：给人看的路径（行 648）

```python
# hermes_constants.py:648-659
def display_hermes_home(home: Path | None = None) -> str:
    """User-facing ``~/`` display string for HERMES_HOME (``~/.hermes/profiles/coder``)."""
    if home is None:
        home = get_hermes_home()
    try:  # as_posix(): str() on Windows yields chimeras like ~/AppData\Local\hermes/skills/
        return "~/" + home.relative_to(Path.home()).as_posix()
    except ValueError:
        return str(home)
```

打印到 UI/文档的路径必须走它：相对 `Path.home()` 化成 `~/...`，Windows 上用 `as_posix()` 防止 `~/AppData\Local\hermes` 这种混合斜杠"奇美拉"。

### 3. `_get_profiles_root()` 为什么故意 HOME 锚定

profile 体系的根判定（`_is_hermes_profiles_root`，行 323；`named_profile_home`，行 345）不跟随 `HERMES_HOME` 随意漂移：`<root>/profiles/<name>` 是否是合法 profile 树，看的是**native home 的形状 + 标记文件**（`config.yaml`/`.env`/`state.db`）+ `.deleted` 墓碑（`profile delete` 才会创建）。配套的身份判定把"目录存在"与"profile 可服务"分开：

```python
# hermes_constants.py:399-408（节选）
# A directory under profiles/ is a profile only when something identifies it as one.
# Runtime side-effects (cron heartbeats, log rotation, caches) create dirs that carry
# none of these; a pre-tombstone ghost shell or a stray infrastructure dir must never
# be listed, served, ticked, or seeded with the default install's credentials.
_PROFILE_IDENTITY_MARKERS = ("config.yaml", ".env", "SOUL.md", "profile.yaml", "auth.json", "state.db")
PROFILE_ID_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{0,63}$")

def named_profile_has_identity(profile_home: str | Path) -> bool:
    home = Path(profile_home)
    return any((home / marker).is_file() or (home / marker).is_symlink() for marker in _PROFILE_IDENTITY_MARKERS)
```

cron 心跳、日志轮转这类运行时副作用创建的目录没有这些标记，永远不该被列出、服务或用默认凭据播种。`named_profile_has_servable_identity` 更严：空 `.env` 是崩溃的 `profile create` 留下的壳，可列出但不算第二个租户。

### 4. 子进程 HOME 契约与 scratch 目录

```python
# hermes_constants.py:765-800（节选）
def get_subprocess_home(env=None) -> str | None:
    """Subprocess ``HOME`` override, or ``None``.

    ``auto``: hosts keep real HOME (repairing a profile-home parent), containers use
    ``{HERMES_HOME}/home``; ``real``: always real HOME; ``profile``: always the profile home.
    """
```

`get_real_home`（行 738）从候选序列（`HERMES_REAL_HOME`、`HOME`、pwd 数据库、`USERPROFILE`、`HOMEDRIVE+HOMEPATH`、`expanduser`）里挑第一个不是 profile-home 的——外部 CLI 的凭据在真 HOME 下，父进程带 `HOME={HERMES_HOME}/home` 时要修复回去。scratch 目录（行 803-1070）是 Hermes 自己的临时空间：每个进程与子进程的 `TMPDIR/TMP/TEMP` 被指向 `<HERMES_HOME>/cache/scratch`（系统 /tmp 是 tmpfs，浏览器配置和下载会吃内存）；保留策略是 **idle 24h**（子树内最后一次写入起算），而不是固定年龄——目录自身 mtime 只在直接子项增删时移动。

### 5. 其余高频出口

- `mkdir_under_hermes_home`（行 461）：建目录前断言目标不是已删除/缺失的命名 profile（防墓碑复活），再经 `hermes_dir_acl.make_user_dir` 创建。
- `apply_secure_dir_policy`（行 926）：Hermes home 目录权限策略的唯一实现（managed 安装不动、容器里只有显式 `HERMES_HOME_MODE` 才动、其余 0700），与 CLI 的 `_secure_dir` 共享一份逻辑。
- `parse_reasoning_effort` / `resolve_reasoning_config`（行 1076/1188）：reasoning effort 解析的单一汇合点（CLI、网关、TUI、cron、/model 全走这里）。
- `openrouter_variant_base`（行 1331）：`:nitro/:floor/:exacto/:online` 是请求期路由后缀，目录查找必须折回基础 id；`:free/:batch` 是真 SKU，绝不能剥。
- `emit_partial_update_hint`（行 1462）：import 报错是"半更新树"时给出恢复指引。
- `normalize_scope`（行 1472）：写侧注册 scope 键归一——`None` 在写路径意味着"进程全局层"，在读路径却是"活动 home"，两种契约绝不统一。

### 6. 两个容易误用的辅助函数

```python
# hermes_constants.py:113-141（节选）
def hermes_root_for_environment(environ: Mapping[str, str]) -> Path | None:
    """The Hermes root that a process started with *environ* resolves, or None.

    Applies the root rules of ``get_default_hermes_root`` to another process's
    environment. ``%NAME%``, ``${NAME}`` and ``$NAME`` references and a leading
    ``~`` expand from *environ* alone, never from this process. Returns None
    when the answer depends on anything outside *environ*: ...
    """
```

`hermes_root_for_environment` 回答"**另一个**进程会解析到哪个家"——只看传入的 env 字典，绝不碰本进程环境；答案依赖字典之外的信息（相对 HERMES_HOME、未定义变量、缺用户 profile 目录）时返回 None 而不是猜。`sudo_invoker_default_home`（行 144）是它的姊妹：sudo 会剥掉 HERMES_HOME 并把 HOME 设成 /root，此时要操作的 profile 存储和系统服务属于 `SUDO_USER`。

另一个易错点是 scope 键的两套契约（行 1472 `normalize_scope` 的 docstring 写得最全）：**写/槽位路径**（`register_*`、快照恢复、工具注册表槽位查找）里 `None` 意为"进程全局层"，必须保持 `None`；**读路径**（`list_providers`、`get_provider`）里 `None` 意为"活动 home"，必须经 `hermes_home_key()` 归一——在读路径误用 `normalize_scope` 会把所有带 scope 的注册全部隐藏（某次修复正是踩了这个坑）。`hermes_home_key`（行 212）本身带按输入路径的记忆缓存：它坐在工具注册表 `current_scope_key()` 的每次查找下方，没有缓存就要每次付一次 `Path.resolve()` 系统调用。

## 核心类/函数

| 名称 | 位置 | 职责 |
|---|---|---|
| `get_hermes_home` | hermes_constants.py:194 | override → env → 平台默认（HX001 的实现） |
| `display_hermes_home` | hermes_constants.py:648 | 用户可见的 `~/...` 字符串 |
| `get_process_hermes_home` / `pin_process_hermes_home` | :243/:259 | 进程家解析与宿主钉住 |
| `set_hermes_home_override` | :32 | contextvar 级换家（不动 os.environ） |
| `account_default_hermes_home` | :83 | OS 账户的家（不信进程 HOME） |
| `hermes_root_for_environment` | :113 | 按任意进程 env 推其 Hermes root |
| `named_profile_home` / `profile_name_for_home` | :345/:361 | profile 树判定与归属 id |
| `named_profile_has_identity` / `_servable` | :404/:411 | 身份标记与可服务身份 |
| `mark/clear_named_profile_deleted` | :441/:447 | profile 墓碑 |
| `mkdir_under_hermes_home` | :461 | 防 profile 复活的建目录 |
| `get_scratch_dir` / `apply_scratch_tmp_env` | :962/:1035 | scratch 空间与子进程 TMP 重定向 |
| `apply_secure_dir_policy` | :926 | home 目录权限策略唯一实现 |
| `get_subprocess_home` / `get_real_home` | :765/:738 | 子进程 HOME 契约 |
| `resolve_reasoning_config` | :1188 | reasoning effort 单一汇合点 |
| `hermes_home_key` / `normalize_scope` | :212/:1472 | 注册表 scope 键（读/写两种契约） |
| `emit_partial_update_hint` | :1462 | 半更新树恢复提示 |

## 本组文件清单

| 文件 | 行数 | 一行角色 |
|---|---|---|
| hermes_constants.py | 1,490 | 路径/profile/权限/reasoning 解析的 import-safe 门面 |
| hermes_constants_scratch.py | ~600 | scratch 保留规则：idle 判定 + 收割（杀浏览器、`git worktree prune`），注册进程不算孤儿（#132401） |
| hermes_constants_scratch_detach.py | ~100 | 每小时清理跑在分离子进程里（不拖短命命令、不随守护线程死亡） |
| hermes_constants_scratch_stuck.py | ~230 | POSIX：本用户删不掉的 scratch 条目记一次、跳过直到修复 |

## 与其他模块的关系

- **所有模块**：`get_hermes_home()` 的消费者横跨 agent/tools/gateway/cli——这正是它必须 import-safe 的原因。
- **hermes_dir_acl.py**：`mkdir_under_hermes_home` 落到 `make_user_dir`；ACL 模块也 import 本模块取家路径。
- **hermes_state.py**：`_default_db_path()` 每次现场调 `get_hermes_home()`。
- **hermes_logging.py**：日志目录经 `mkdir_under_hermes_home(home / "logs")`。
- **hermes_platform/**：`is_wsl/is_container/is_termux` 探测委托给平台权威模块。

## 总结

- 本文件是"没有依赖的底座"：正因为零依赖，它才能被 86 个根文件与全部包共享而不成环。
- 三条值得记住的纪律：路径永远经 `get_hermes_home()`（HX001）、目录创建永远经 `mkdir_under_hermes_home`（防墓碑复活 + Windows ACL）、权限策略只有 `apply_secure_dir_policy` 一份实现。
- profile 判定故意锚定 HOME/标记文件而非 env 漂移——这是"一个进程服务多个 profile"世界的安全底线。
