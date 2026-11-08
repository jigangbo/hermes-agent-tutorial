# pm/ 模块总览 —— 依赖管理器与 Hermes 环境

## 文件概览

`pm/` 是 Hermes 的「PackageManager」：**它拥有全部 Hermes Python 依赖变更**——用裸 `pip`/`uv` 改 Hermes 环境是被禁止的（根 AGENTS.md 铁律）。对使用者它暴露为 `hermes pm` CLI（`pm/cli.py`）：`lock`（从 pyproject.toml 重锁 uv.lock；`--bump` 把工具钉进 pm/lock.json）、`install`、`env`（打印已装包组合的环境）、`doctor`（对 lockfile 校验安装态）、`repair`（按记录环境重建、不改图）、`environment`、`gc`（清无引用 store 条目）、`bundle`（暂存 repo+store+facts+可迁移 venv payload）、`status`（机器可读同步回执）、`update`（解析最新、重钉）。内部三层结构清晰：**内容寻址 store**（pm/store.py）管下载与发布；**每项目 venv「代」**（pm/environments.py）管选代与激活；**uv 引擎**（pm/environment.py）管工具路由、隔离与命令执行。本篇是第 11 章总览；`environments.md` 深讲 store/代/registry/引擎，`pinning_policy.md` 讲钉版政策与 lock/update。

## 数据流全景（ASCII）

```
  pyproject.toml（>=floor,<next_major 上限）
        │  hermes pm lock  （Hermes 锁定时才带 exclude-newer="3 days"）
        ▼
  uv.lock（版本+哈希，机器写）◄──── CI lock 检查
        │  hermes pm install / activate 同步
        ▼
┌───────────────────────────────────────────────────────────┐
│ PM store（内容寻址，机器级）：下载→校验 sha256→解包→原子发布  │
│  store.py: ALL_TARGETS / current_target() / hash_url()      │
│  downloader.py: 可续传、多连接、哈希验证                     │
│  artifact_mirror.py + artifact-mirror.json: 复核过的二进制   │
└───────────────────────┬───────────────────────────────────┘
                        ▼
┌───────────────────────────────────────────────────────────┐
│ <root>/installs/<install_key>/environments/<gen>            │
│  「代」= 一次完整解析出的 venv；facts.json 记录 committed 选择 │
│  environments.py: install_key / committed_venv /            │
│                   activate_dependencies（租用该代）          │
└───────────────┬───────────────────────────┬───────────────┘
                ▼                           ▼
      ./activate（开发者 shell）     cron 外部 worker 自举
      PM activate_dependencies      cron/worker_bootstrap.py
      重放 .pth、改 sys.path/PATH    → 同一个 activate_dependencies

  消费者：activate 脚本、hermes 启动器（launch.py）、cron worker、
          build_env/build_operations（CI 构建）、testenv（测试环境）
```

## 「调用者拿到解释器或工具路径，不是 uv」

`pm/operations.py` 的 docstring 是整包的钥匙：

> Callers describe a dependency graph and its lifetime, never a uv command. Only the private environment engine knows how to obtain or invoke uv.

也就是说 `pm.build_environment` / `pm.ensure_environment` / `pm.sync_venv([...])` 这类公共 API 描述*要什么*，`pm.environment.py` 才知道*怎么跑 uv*（含 uv 本身也是 store 里的一个被钉版工具，`pm/_uv.py`）。这个边界让 Nix 的声明式 uv2nix 构建与用户自己的项目保持独立所有权——PM 从不碰别人的环境。

## 机器事实的三条纪律（与 hermes_platform 呼应）

PM 在应用可导入*之前*就要跑，所以它对宿主的判断自带一小组只读事实，且遵守同样纪律：`pm/store.py::_native_machine()`（行 38-83）优先问 `hermes_platform.host.facts.native_arch()`；PM 独立引导运行时里没有 `hermes_platform` 时，才直接问 OS——**macOS 用 `sysctl.proc_translated`、Windows 用 `IsWow64Process2`**，因为 Rosetta 与 WOW64 下 Python 进程会报错架构，选错 target triple 就装错 artifact。libc 风味（glibc/musl/bionic）也是 target triple 的一部分：`_is_bionic_libs`（行 86-102）是全仓库唯一探测 bionic 的地方。

## 谁在什么时候调 PM

| 调用方 | 入口 | 语义 |
|---|---|---|
| 开发者 shell | `./activate`（fish/PowerShell 变体） | 同步开发环境到 lock；`--test-extras` 换测试集 |
| `scripts/run-in-hermes-env` | `ACTIVATION_INPUTS` mtime 戳 | 戳变了才重新同步（省启动时间） |
| cron 外部 worker | `cron/worker_bootstrap.py` → `activate_dependencies` | 租用 committed 代、重放 `.pth`，之后才能 import 第三方 |
| `hermes update` | PM 的依赖腿 | 重钉 + 安装 + 刷 venv + plugin eviction |
| CI 构建 | `pm.build_env --source . --check-lock` | 与 `pm lock` 同一套操作（隔离设置不漂移） |
| 插件安装 | `pm.publication`/`plugin_eviction` | 安装锁内快照与发布；更新期插件不适配则驱逐 |

这些调用面的共同点是：**调用者描述目标状态，PM 决定路径**。没有人直接跑 `uv sync`；因此隔离设置（exclude-newer、workspace、缓存策略）只存在一份实现。

## 十个 CLI 动词

```python
# pm/cli.py:1
"""hermes pm: lock / install / repair / env / doctor / gc / bundle."""
```

动词表（`pm/cli.py:966-1059` 的 argparse 注册）：`lock`（无参 = 从 pyproject 重锁；`--bump <name> <version>` = 解析每个 target 的归档、哈希、写 pm/lock.json）、`install`（默认装全部必需 + 可选默认）、`env`、`doctor`、`repair`（重建记录环境、**不改图**）、`environment`、`gc`、`bundle`、`status`（打印最近一次同步回执）、`update`。改完 pyproject.toml 的工作流固定为：`hermes pm lock` → 重新 source `./activate` → **pyproject.toml 与 uv.lock 一起提交**（`_relock_project`，行 31-71，还会提示新引入的 opt-in extra 需要 `--test-extras`）。

## 磁盘上的文件布局

```
<数据根>/                          ← dependency_home_root()（尊重 HERMES_HOME 覆盖）
├── installs/
│   └── <install_key>/            ← checkout 路径哈希（sha256 前 16 位）
│       ├── facts.json            ← 安装态：committed venv 选择 + {{store}} 模板 env
│       ├── inputs/               ← ACTIVATION_INPUTS 的 mtime 戳 + .project-root 记录
│       ├── environments/<gen>/   ← 一代代完整解析出的 venv
│       └── testenv/              ← 测试 side environment（dev+test 组）
├── tools/                        ← store 的工具目录（hermes launcher exec 的解释器住这里）
└── logs/update_receipts/         ← pm.receipt 与 update 回执共用目录（kind 区分）

仓库内：
pm/lock.json                      ← 被管理工具（node/uv/ffmpeg/…）的版本 + 每 target SHA
pm/uv.lock                        ← PM 运行时自身的锁
pyproject.toml / uv.lock          ← 应用依赖（PM 的 lock 动词管辖）
```

## 两个 lock 文件、两种承诺

| 文件 | 回答 | 谁写 | 谁读 |
|---|---|---|---|
| `pyproject.toml` + `uv.lock` | Python 依赖图（版本 + 哈希） | 人编辑 pyproject；`hermes pm lock` 机器重锁 | `hermes pm install`、CI lock 检查、workspace 构建 |
| `pm/lock.json` | 被管理工具的每 target 归档 URL + sha256 | `hermes pm lock --bump` | `pm/install.py` 的 `ensure()`、nix（纯数据读取） |
| `facts.json` | 这台机器**实际**装了什么 | 每次 PM 安装 | `doctor`/`repair`/`selected_venv`/`activate_dependencies` |

三层里最容易被忽略的是 facts.json：它是「选择记录」也是「完成标记」——只有在 `flush_before_selecting()` 的全盘 sync 之后才写，所以读它 = 信任一个已完整落盘的代（详见 `environments.md`）。

## 本组文档导航

| 文档 | 内容 |
|---|---|
| `environments.md` | store（内容寻址/9 个 target/哈希 URL）、venv「代」（install_key/committed 选择/租用）、registry、uv 引擎；install/worker/build/download/artifact_mirror 组清单 |
| `pinning_policy.md` | 上限政策（`>=floor,<next_major`；pre-1.0 `<0.(minor+2)`）、git SHA 钉、release-age 隔离只在锁定时生效、lock.py/update.py/uv_cache_health/prune + 其余全部文件清单 |

## 阅读顺序建议

第一次读 pm/ 推荐按依赖方向走：`index.md`（本篇，建全景）→ `environments.md`（store/代/引擎的机械层）→ `pinning_policy.md`（政策层）。三个反复出现的概念贯穿始终，先在此定义：

- **target triple**：`win32-x64`、`linux-arm64-musl`、`darwin-arm64`……九个取值（`pm/store.ALL_TARGETS`）。OS + 架构 + libc 的组合，一个包为它服务的每个 target 各留一行 lock 表项。
- **「代」（generation）**：一次完整解析出的 venv 快照，住在 `<root>/installs/<install_key>/environments/<gen>/`。`facts.json` 指向 committed 的那一棵；进程启动时**租用**它（收集器不删有租约的代）。
- **receipt（回执）**：每次 venv 同步写一条机器可读记录（与 `hermes update` 的回执同 schema 同目录），`hermes pm status` 与桌面 IPC 是它的读者。

## 与其他模块的关系

- **activate 脚本**（`./activate`）调 PM 同步开发环境；`scripts/run-in-hermes-env` 按 `ACTIVATION_INPUTS`（uv.lock/pyproject.toml/setup.py/pm/lock.json）的 mtime 戳决定是否重新同步。
- **cron/**：外部 worker 经 `cron/worker_bootstrap.py` → `pm.environments.activate_dependencies` 在任何第三方 import 前租用 committed 代。
- **hermes_platform/**：`native_arch()` 是 target triple 的权威来源（PM 独立运行时缺该包时才自行降级探测）。
- **acp_adapter/**：`hermes acp --setup-browser` 经 `pm.ensure("chromium", explicit=True)` 装 PM 钉版的 Chromium。
- **hermes_cli/**：`hermes update` 是 PM 的大消费者（依赖腿、plugin_eviction）；`hermes_cli/runtime_state.py` 提供 runtime 锁与代租用。

## 总结

pm/ 的核心契约有三条：**一切依赖变更走 PM**（可审计、可重放、可回收）；**调用者描述图、不描述命令**（uv 是私有引擎细节）；**选择即承诺**（facts.json 的 committed 记录在 `flush_before_selecting` 的全盘 sync 之后写入，选中的「代」必然已完整落盘）。这三条撑起了「升级不碎环境、worker 不死于收集器」的一系列下游不变量。
