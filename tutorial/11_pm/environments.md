# store、venv「代」与 uv 引擎 —— PM 的环境机器

## 文件概览

本篇深讲 PM 的三个机械层：**内容寻址 store**（`pm/store.py`——下载、校验、解包、原子发布）、**每项目 venv「代」**（`pm/environments.py`——install_key、committed 选择、`activate_dependencies` 租用）、**uv 私有引擎**（`pm/environment.py`——工具路由、隔离、命令执行、解析器错误分类），以及把它们串起来的 `registry.py`（包注册表与依赖行走）。文末清单覆盖 install/worker/build/download/artifact_mirror 五个组。

## 关键代码走读

### store：九个 target、一个哈希契约

```python
# pm/store.py:24-35
ALL_TARGETS = (
    "win32-x64",
    "win32-arm64",
    "linux-x64",
    "linux-arm64",
    "linux-x64-musl",
    "linux-arm64-musl",
    "linux-arm64-bionic",
    "darwin-x64",
    "darwin-arm64",
)
MUSL_TARGETS = frozenset({"linux-x64-musl", "linux-arm64-musl"})
```

每个包为它服务的 target 各留一行 lock 表项（`pm/lock.py` 顶部 schema：`packages.name.artifacts[target] = {"url", "sha256"}`）；target 无关的 artifact（如 npm tarball）折叠为 `"any"`。`current_target()`（行 152）由 OS/架构/libc 三要素决定；`hash_url()`（行 171）给 `pm lock --bump` 现场哈希归档。发布是原子的：`publish()`（行 450）从暂存目录改名进 store，`published()`（行 391）判存在。

### 「代」：install_key 与 committed 选择

```python
# pm/environments.py:20-22
def install_key(project_root: Path) -> str:
    canonical = str(Path(project_root).resolve())
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()[:16]
```

依赖状态按数据根分域：`<root>/installs/<install_key>/`（`installs_root()`，行 33；`dependency_home_root()` 行 25 尊重 `HERMES_HOME` 覆盖）。一个 checkout 的 launch 可能被别的根「借用」（测试的临时 HERMES_HOME、每任务 home）——`owning_home_root()`（行 41-72）用 checkout 自己的 `hermes` launcher 反查真正拥有状态的根：只有 owner 发布 launcher，且它 exec 的解释器指向 owner 的 store。

选择记录在 `facts.json`：

```python
# pm/environments.py:297-305
def committed_venv(project_root: Path) -> Path | None:
    """The environment PM committed for this install (or a sealed payload's own), else ``None``.

    Unlike ``selected_venv`` this never answers with the in-tree ``venv``/``.venv``: that tree
    predates PM and is built for whichever interpreter created it, so loading it from PM's store
    Python mixes ABIs (compiled modules vanish). PM never deletes it: ``legacy_selection`` reads its
    site-packages again whenever this install has no dependency facts."""
```

`selected_venv`（行 285）= committed 或首次同步前的原始安装；committed 记录损坏是**错误**而不是「悄悄回退旧依赖集」的许可。`flush_before_selecting()`（行 263-282）在写选择记录前做一次文件系统级 sync：记录是「代」的完成标记，必须先保证它担保的每个文件已落盘——否则断电可能选中半成品 venv（Windows 无 `os.sync`，记录的原子写是唯一保证，NTFS 只 journal 元数据）。

### activate_dependencies：启动时的代租用

```python
# pm/environments.py:464-513（节选）
def activate_dependencies(project_root: Path) -> None:
    """Select the committed tree at process boot, before third-party imports.

    A process with no extension selection keeps its original launch contract.
    Already-running processes are never switched after a dependency install.
    """
    ...
        with runtime_lock(project_root) as held:
            if held:
                recover_publication(project_root)
            environment = committed_venv(project_root)
            if environment is None:
                return _require_own_dependencies(project_root)
            release = lease_generation(environment)
            # Without the lock, an installer may commit a new generation between the
            # read and the lease, leaving the leased one unselected and collectable.
            while not held and (current := committed_venv(project_root)) not in (None, environment):
                release()
                environment, release = current, lease_generation(current)
```

三个细节值得停顿。**租用**：拿到 committed 路径后 `lease_generation` 租用它——PM 收集器不删有租约的代（cron 外部 worker 活下来的关键）。**无锁重读循环**：没有持锁时，安装者可能在「读选择」与「租用」之间提交新代，循环保证租的永远是最新 committed。**sys.path 重写**（行 506-513）：先剔掉旧 site-packages 与项目根，`site.addsitedir` 让 uv editable 成员的 `.pth` 生效，再把项目根与 selected 置顶，并同步改 `PYTHONPATH`/`PATH`——venv 里的 `hermes` console script 是构建时快照的 editable 安装（#124627），子进程解析 `hermes` 必须先命中 checkout 自己的 launcher。`_require_own_dependencies`（行 450-461）：PM 的裸 store Python 若没有 committed 代，宁可抛 `NoCommittedEnvironment`（只有 `hermes pm repair` 能修）也不跑在继承来的 PYTHONPATH 上。

### registry：注册即发现，懒加载内置表

```python
# pm/registry.py:19-39
_BUILTIN_MODULES = ("pm.packages", "pm.security_packages")


def _builtins_loaded() -> dict[str, Package]:
    """Register the built-in definitions on first read, not on ``import pm``.

    Process boot imports ``pm.environments`` before any dependency is importable;
    pulling the whole package catalogue (downloader, network) in with it would
    cost every launch ~40ms and break the stripped payloads that ship only the
    pre-import files.
    """
    for module in _BUILTIN_MODULES:
        if module not in sys.modules:
            importlib.import_module(module)
    return _packages


def register(cls):
    instance = cls()
    if not instance.name:
        raise ValueError("package has no name")
    _packages[instance.name] = instance
    return cls
```

`pm.packages`（1,424 行）与 `pm.security_packages` 以 `@register` 类注册每个被管理工具；版本与哈希住在 lock.json，定义文件里一个版本数字都没有（`pm/package.py` docstring）。`get_package`/`source_install_packages`/`tool_roots`（`pm/registry.py`）是查询面。懒加载的原因写在注释里：进程引导时 `pm.environments` 先于一切依赖被 import，把整个目录（downloader、network）拖进来会让每次启动多付 ~40ms、并压垮只带 pre-import 文件的精简 payload。

### uv 引擎：隔离与错误分类

```python
# pm/environment.py:35-46
# Deliberately narrow: a fetch timeout or index outage must not be misread as a
# conflict — and regardless of classification, nothing here ever disables a
# plugin; the caller decides. Lives here (stdlib-only imports) because the
# bootstrap runner streams uv output from a pre-3.11 system python where
# pm.workspace's tomllib import cannot load.
_RESOLVER_MARKERS = (
    "no solution found",
    "conflicting requirements",
    "conflicting urls",
    "because only the following versions",
    "and your pyproject depends on",
)
```

引擎只认这几行 uv 输出为「解析冲突」（`ResolutionConflict`）——fetch 超时/索引故障不得误读为冲突；且无论分类结果如何，**这里永不禁用插件**，调用者决定（配合 `pm/plugin_eviction.py`）。流式输出只留末尾 2000 字符，标记会被缝回（`_STREAM_TAIL_MARKERS` 行 72）——字节码编译失败与原生构建失败的标记也得走同一条缝，否则修复路径看不到重试信号。损坏缓存的恢复有界：`_CACHE_RECOVERY_ROUNDS = 3`，每轮必须点名一个之前没清过的包——这是「缓存里多处损坏」的上界，不是对一个坏 wheel 的死循环。环境隔离上，PM 剥掉环境中所有 `UV_*`（防止调用者的 uv 设置劫持操作），只有索引/传输旋钮被 `index_config.py` 显式转发（镜像/气隙网络需要）。

## 核心类/函数

| 符号 | 位置 | 职责 |
|---|---|---|
| `ALL_TARGETS` / `current_target()` | `store.py:24/152` | 9 target 三元组 / 当前 target |
| `hash_url()` | `store.py:171` | `pm lock --bump` 现场哈希 |
| `publish()` / `published()` | `store.py:450/391` | 原子发布 / 存在判定 |
| `_native_machine()` | `store.py:38` | 仿真下也报原生架构（WOW64/Rosetta） |
| `install_key()` | `environments.py:20` | checkout 路径哈希 → installs 子目录 |
| `owning_home_root()` | `environments.py:41` | 借用 launch 反查状态 owner |
| `committed_venv()` / `selected_venv()` | `environments.py:297/285` | committed 选择 / 选择或原始安装 |
| `flush_before_selecting()` | `environments.py:263` | 选择记录前的全盘 sync |
| `activate_dependencies()` | `environments.py:464` | 启动时选代 + 租用 + sys.path 重写 |
| `lease_generation()`（runtime_state 提供） | 经 `environments.py:484` | 租约防收集器删除 |
| `NoCommittedEnvironment` | `environments.py:446` | 裸 store Python 无代时的硬错误 |
| `venv_command()` / `venv_python()` | `environments.py:363/341` | 另一解释器跑代码（payload 场景） |
| `install_state_dir()` / `runtime_facts_path()` | `environments.py:37/105` | 状态目录 / facts.json |
| `ACTIVATION_INPUTS` | `environments.py:111` | 决定依赖集的四个文件（mtime 戳同步） |
| `_builtins_loaded()` / `register()` / `get_package()` | `registry.py:25/36/41` | 注册表三原语 |
| `_RESOLVER_MARKERS` / `classify_uv_failure` | `environment.py:40` | 解析冲突的窄分类 |
| `_without_release_age()` | `workspace.py:184` | 用户机器生成的 workspace 摘除 release-age 截止 |
| `_generate_pyproject()` | `workspace.py:141` | core + 插件成员快照进新一代 |

## 本组文件清单

| 文件 | 角色 | 关键符号 |
|---|---|---|
| `pm/store.py` | 内容寻址 store（下载/校验/发布） | `ALL_TARGETS`, `current_target`, `hash_url` |
| `pm/environments.py` | venv 代布局/选择/激活 | `install_key`, `committed_venv`, `activate_dependencies` |
| `pm/environments_adopt.py` | 采纳既有环境为 PM 代 | 采纳纪律 |
| `pm/environment.py` | uv 私有引擎（路由/隔离/执行） | `_RESOLVER_MARKERS`, `classify_uv_failure` |
| `pm/workspace.py` | workspace 构建（用户机器去 release-age） | `_without_release_age`, `_generate_pyproject` |
| `pm/registry.py` | 包注册表与依赖行走 | `register`, `get_package`, `tool_roots` |
| `pm/install.py` | `ensure()`：安装态对齐 lockfile | `_facts`, `_lockfile`, `_store`, `ensure`, `stage_only` |
| `pm/install_states.py` | 回收 checkout 已消失的孤儿状态 | `inputs/.project-root`, 租约失败关闭 |
| `pm/worker.py` | 隔离进程里的 JSON-line PM 请求 | stdlib-only |
| `pm/worker_operations.py` | worker 的轻路由与前置策略 | `Operation` |
| `pm/build_env.py` | 显式 Python 依赖环境的构建/检查 | `--source . --check-lock` |
| `pm/build_operations.py` | 调用者自有输入的构建/CI 操作 | 与 live 选择无关 |
| `pm/build_compilers.py` | 钉版解释器下的原生编译工具指路 | sysconfig 的 clang→gcc 覆盖 |
| `pm/native_build.py` | 源码构建的原生编译环境（Win-ARM64 等） | MSVC/Clang/Rust/OpenSSL |
| `pm/download_state.py` | 可续传分片的跨进程所有权 + GC 边界 | `partial_lock` |
| `pm/downloader.py` | 可续传、哈希验证、多连接下载 | 全部大文件的唯一通道 |
| `pm/artifact_mirror.py` | 复核过的二进制输入的公共副本 | `artifact-mirror.json`, `KEY_PREFIX` |
| `pm/artifact-mirror.json` | 镜像布局数据（前缀/origin） | 数据文件 |

## 与其他模块的关系

- **cron/worker_bootstrap.py**：`activate_dependencies` 是外部 worker 自举的全部内容——租约让 PM 收集器绕开活着的 worker。
- **hermes_cli/runtime_state.py**：runtime 锁、发布恢复、`lease_generation` 的实现方；`environments.py` 只消费。
- **hermes_platform.host.facts**：`native_arch()` 权威；store 自带降级探测仅用于 PM 独立引导。
- **plugin 体系**：`plugins_state.py` 读全 profile 启用集 → workspace 成员；`plugin_eviction.py` 决定「插件不再适配时更新继续」。
- **testenv.py**：测试环境是 side environment（`ensure_project_environment`），绝不进入 selected 应用代——test-only 依赖不得进 PM facts 或任何出货物。

## 总结

这一层的读法是「三个不动点」：store 的每个 artifact 都有 sha256 且按 target 定位；「代」的选择记录是完成标记、租约是生命周期凭证；uv 引擎的错误分类刻意窄、插件决策永远外移。`activate_dependencies` 把三者接成一个原子动作——**选中即租用，租用即可活**——cron worker、activate shell、sealed payload 三条入口共享同一个实现。
