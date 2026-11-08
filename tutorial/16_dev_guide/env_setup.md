# 环境搭建

> Hermes 支持多平台（Linux/macOS/Windows/WSL/Termux），环境由自带的包管理系统 **PM** 全权管理 —— 这是理解一切开发流程的前提。

## 两条铁律

1. **环境只用 PM 建**：永远不要用裸 `pip`/`uv` 修改 Hermes 环境。`source ./activate`（fish 用 `activate.fish`，PowerShell 用 `activate.ps1`）负责准备并激活 PM 环境。
2. **先选隔离的 HOME**：开发测试前先指定独立的 `HERMES_HOME` 与 `HERMES_RUNTIME_DIR`，避免污染真实用户数据。详见 `website/docs/reference/package-management.md` 的 Developer Workflow 一节。

```bash
# 典型开发者循环
source ./activate          # 准备 + 激活 PM 环境
python scripts/check       # 全量 lint 门禁（CI 同款）
scripts/run_tests.sh       # 测试（需要单独的 test 环境，见测试篇）
```

## activate 到底做了什么

`activate` 不是普通的 venv 激活脚本，读它的头注释就能学到设计（`activate:1-32`）：

- 它把 PM 组合好的环境（PATH + 工具变量）应用到**当前 shell**，带 save/restore —— `deactivate` 精确撤销激活改动的一切；
- `hermes` 变成**本 checkout 专属的 shell 函数**：只在 shell 位于这个 worktree 内时可用，兄弟 worktree 用自己的命令（提示符前缀显示 worktree 名）；
- 脚本与其他子进程**不 source 它**，改走 `scripts/run-in-hermes-env` —— 两者都构建自 `scripts/_activation.sh`；
- 激活前先经 setup 同步；PM 拥有"新鲜度"，激活不做二次依赖盖章，而是信任记录的工具 digest。

测试解释器用检出的 bootstrapped Python 现构建（非就地同步）：

```bash
python -m pm.build_env --source . --out .venv --group dev --group test
```

## HERMES_HOME：profile 感知的路径中枢

- 所有用户状态都在 `~/.hermes/`：`config.yaml`（设置）、`.env`（**只放密钥**）、`logs/`、`state.db`、`skills/`、`plugins/`……
- 代码里**永不硬编码** `~/.hermes`：路径用 `hermes_constants.get_hermes_home()`，给人看的文本用 `display_hermes_home()`（门禁规则 HX001）。
- `_get_profiles_root()` 故意以 HOME 锚定 —— profile 是彼此隔离的孤岛（这是设计，不是缺陷）。
- 测试绝不写 `~/.hermes/`：`tests/conftest.py` 的 autouse `_isolate_hermes_home` fixture 会把 `HERMES_HOME` 重定向到临时目录。

## 一个进程，多个 profile

- 每个 profile 一个独立的 `HERMES_HOME`（各自的 state.db、config）。
- 但**进程是共享的**：默认开启的 multiplex 模式让一个网关进程同时服务多个 profile。
- 推论（全仓库头号 bug 类别）：任何**非 turn 期**代码 —— 启动探测、驱逐、ticker、延迟回调、RPC 方法、线程跳转、子进程派生 —— 必须显式绑定所属 profile 的作用域。`os.environ`、模块全局、导入期常量只持有**启动 profile** 的值；未绑定的读取 = 静默跨 profile 泄漏（HX002/HX004/HX005/HX012）。
- 相关守卫：`scripts/check_profile_scope_patterns.py` 在 CI 里扫描这类模式。

## PM 命令速查（pm/cli.py 的子命令）

| 命令 | 作用 |
|------|------|
| `hermes pm lock` | 解析并重新钉版 lockfile（改了 `pyproject.toml` 后必跑，提交 `uv.lock`） |
| `hermes pm install` | 安装包（默认全部 required + 可选默认项） |
| `hermes pm doctor` | 对照 lockfile 检查已安装状态 |
| `hermes pm repair` | 重建记录的依赖环境（不改依赖图） |
| `hermes pm update` | 解析最新版本并重新钉版 |
| `hermes pm env` | 打印已安装包组合出的环境 |
| `hermes pm status` | 打印最近一次 pm sync 回执（机器可读） |
| `hermes pm gc` | 清理无引用的 store 条目 |
| `hermes pm bundle` | 把 payload（repo+store+facts+可重定位 venv）暂存到 `--out` |

## 依赖策略速记

- 所有依赖带上限：`>=floor,<next_major`（1.0 之前 `<(0.(minor+2))`）；git 依赖钉 40 位 SHA；Actions 钉 SHA。
- 改了 `pyproject.toml` 必须跑 `hermes pm lock` 并提交 `uv.lock`。
- 锁定时有 3 天 release-age 隔离（`[tool.uv] exclude-newer`）；JS 侧 `pnpm-workspace.yaml` 的 `minimumReleaseAge`（14 天）。
- 全文见 `pm/AGENTS.md` 与 [11_pm](../11_pm/index.md)。

一条容易忽略的推论：**依赖图被 PM 独占记账**，所以手工改动 `.venv`、往 `site-packages` 里塞包、或直接编辑 `uv.lock`，都会让 `hermes pm doctor` 的对照检查报错 —— PM 的修复命令能重建记录的环境，但重建不了你对环境做过什么的手工改动。

需要临时的独立试验环境时，同样走 PM（新 `--out` 目录 + 独立 `HERMES_HOME`），不要复用任何已有环境。

## 仓库根目录的开发者视角地图

搭好环境后，这些根目录条目是日常开发最常碰的（完整结构见 [big_picture](../01_architecture/big_picture.md)）：

| 条目 | 开发者视角 |
|------|-----------|
| `activate` / `activate.fish` / `activate.ps1` | 三种 shell 的激活入口，同一套 `scripts/_activation.sh` 底座 |
| `scripts/check` | 本地全量门禁；`--install-hook pre-push` 装成推送钩子 |
| `scripts/run_tests.sh` | 测试 runner（强制 CI 对等） |
| `pyproject.toml` + `uv.lock` | 依赖声明与钉版；改前者必提交后者 |
| `justfile` | JS 侧常用任务 |
| `pnpm-workspace.yaml` | Node 工作区（desktop/ui-tui/web/shared） |
| `docker/` + `docker-compose*.yml` | 容器化部署（s6-rc 服务定义） |
| `nix/` | Nix derivation、NixOS module 与 dev shell |
| `website/` | Docusaurus 文档（长文出处，改符号要同步） |

## 其他平台入口

- Docker：`Dockerfile` + `docker-compose.yml`（Windows 变体 `docker-compose.windows.yml`），容器内 s6-rc 服务定义在 `docker/`。
- Nix：`nix/` 提供 agent/TUI/web/desktop 的 derivation、NixOS module 与 dev shell。
- 桌面/Node 侧：`pnpm` workspace（`pnpm-workspace.yaml`），`justfile` 常用任务。

## 常见坑

| 症状 | 原因 | 解法 |
|------|------|------|
| `pip install` 后环境异常 | 裸 pip 绕过了 PM 的 store/hash 记账 | `hermes pm repair` 重建；今后只用 PM |
| 测试找不到 pytest | runner 清空 `PYTHONPATH`，PM shell 激活不等于测试环境 | 先 `python -m pm.build_env --group dev --group test` |
| 改动在兄弟 worktree 不生效 | `hermes` 函数绑定当前 worktree | 每个 worktree 各自 `source ./activate` |
| 测试写穿了真实配置 | 没设 `HERMES_HOME` | 开发/测试前始终设隔离的 `HERMES_HOME` |
| 拉取了新依赖但行为没变 | 忘了重新同步 | `source ./activate` 会经 setup 校验工具 digest；必要时 `hermes pm install` |
| Windows 终端跑不了 bash 钩子 | 钩子依赖 Git Bash 的 POSIX 环境 | 用 Git for Windows 自带的 bash 跑 `scripts/check` |
