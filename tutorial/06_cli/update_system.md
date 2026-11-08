# 更新系统（hermes update）

## 文件概览

`hermes update` 的实现散布在 44 个文件里（42 个 `update_*.py` + 2 个退役 shim）：

- **管线**：`update_cmd.py`（派发器 + git plumbing）；每个关注点一个 `update_cmd_<concern>.py`，re-import 回门面保持可补丁；import 单向：`main → update_cmd → update_cmd_*`；
- **承诺恢复**：`update_cmd_commit.py`（树替换的唯一提交点）、`_early_recovery*.py`（撕裂树恢复）、`update_finish/handoff`；
- **互斥与保管**：`update_lock.py`（跨进程互斥）、`update_custody.py`（子进程生成策略）；
- **舰队**：`update_cmd_fleet*.py`（网关重启 + 验证）、`update_inventory`（运行时清单）、`update_receipt`（结构化回执）；
- **Windows**：`update_cmd_zip.py`（ZIP 回退）、`update_cmd_windows.py`、`update_windows_acl.py`；
- **退役 shim**：`_old_updater.py`、`_update_takeover.py`（历史 updater 的逃生口）。

## 关键代码走读

### 管线（ASCII）

```text
hermes update
   │
   ▼
┌─ check（update_cmd_check：碎片清理/通道目标/范围 fetch/裁决）──否──▶ 结束
   │
   ▼ update_lock 跨进程互斥（update_lock.py）
┌─ 准备：autostash（update_cmd_stash）→ launch_files 重写 → 库存/计划
   │
   ▼
┌─ pause gateways：Windows 服务暂停（update_cmd_windows + pause_gate + pause_record）
   │                POSIX 侧 update_cmd_posix_pause —— 换树前暂停网关
   │
   ▼
┌─ COMMIT POINT（update_cmd_commit.py）：树移动前先把恢复义务落盘
   │    ├─ .git/hermes-update-pull 撕裂标记（每次树移动）
   │    ├─ venv_sync.arm_completion 源完成尾巴
   │    └─ 主机舰队重启义务（update_host_obligation）
   │
   ▼
┌─ 换树：git checkout/pull（update_cmd_git）或 ZIP 两段交换（update_cmd_zip，Windows 坏 git 回退）
   │
   ▼
┌─ 完成：venv 同步（update_finish）→ config 迁移（update_cmd_config）→ 维护（update_cmd_maint）
   │
   ▼
┌─ 舰队重启 + 验证（update_cmd_fleet + _checkout/_gatewayless/_unit_budget/_verify）
   │    └─ 矩阵证明仍陈旧的网关升级处置（update_cmd_stale_survivors）
   │
   ▼
┌─ resume 被暂停的网关 → 结构化回执（update_receipt）→ downgrade_guard 复核
```

### update_cmd.py 门面

```python
# hermes_cli/update_cmd.py:1-6
"""Hermes update pipeline: dispatchers (``_cmd_update_impl``/``_cmd_update_check``) + git plumbing.

Each concern lives in ``update_cmd_<concern>.py`` and is re-imported here so
``hermes_cli.update_cmd.<name>`` keeps resolving (and stays monkeypatchable). Imports are one-way:
main -> update_cmd -> update_cmd_*; ``_m()`` resolves ``hermes_cli.main`` at call time.
"""
```

`_m()`（行 158）在调用时解析 `hermes_cli.main`——兄弟模块晚 import 门面的标准做法。git 一律经 `_git_run`（行 263）执行，网络步骤显式标注 `network=True`。

### 深讲 update_cmd_commit.py：唯一提交点

```python
# hermes_cli/update_cmd_commit.py:1-12
"""The single commit point of a source ``hermes update``: everything the tree move needs armed first.

Before git (or the ZIP swap) writes the first file of the new code, three things are durable:

* the interrupted-pull marker (``.git/hermes-update-pull``) naming the commit git moves to, for EVERY
  tree move (branch switch, upstream fork pull, the pull itself) so a launch after any exit that left
  a torn tree puts the old one back (``_early_recovery.restore_interrupted_pull``);
* the source-completion tail (``venv_sync.arm_completion``) and the host fleet-restart obligation,
  so a kill after the move but before the completion child starts still leaves the tail owed to the
  next launch (``venv_sync.prepare_launch``) and the restart owed to the next ``hermes update``.

Failures before the move are no-ops: ``disarm_commit_obligations`` puts both obligations back the
way this run found them once the tree is verified at its pre-update commit again.
"""
```

核心不变量：**新代码写下第一个文件之前，恢复所需的一切必须已经持久**。三样东西：撕裂 pull 标记（命名 git 要去到的 commit，任何退出留下的撕裂树都会在下一次启动时被放回旧树）、源完成尾巴、主机重启义务。移动前失败是无操作——`disarm_commit_obligations` 在树被验证回到 pre-update commit 后把义务原样归还（模块级快照 `_armed_snapshot` 记录「本 run 武装前各路径的原始字节」，disarm 只归还仍精确匹配的记录）。

武装入口：

```python
# hermes_cli/update_cmd_commit.py:121（签名）
def arm_commit_obligations(root: Path, expected_sha: str) -> None:
# 行 226 / 250
def arm_commit_point(git_cmd, root: Path, expected_sha: str, **move) -> str | None:
def arm_tree_move(git_cmd, root: Path, *, pre: str | None, target: str, stash: str | None, ...):
```

配套的还有 `publish_recovery_closure()`（行 277，把旧树的恢复闭包发布到磁盘）与 `settle_failed_tree_move()`（行 400）。

### Windows ZIP 回退

`update_cmd_zip.py`：「ZIP-download fallback for ``hermes update`` (Windows with broken git): two-phase stage/commit swap」。git 不可用时下载 ZIP，两段式 stage/commit 交换整棵树——同样是提交点武装的消费者。`_should_zip_fallback_on_update_error()`（update_cmd.py:469）决定何时触发。

### 跨进程互斥

`update_lock.py`：「Cross-process mutual exclusion for in-flight Hermes updates」——两个 `hermes update` 不能并发；`update_owning_install.py` 把更新送回它正运行的解释器所属的安装。

## 核心类/函数

| 符号 | 文件:行号 | 职责 |
|---|---|---|
| `_cmd_update_impl` / `_cmd_update_check` | update_cmd.py | 管线派发器 |
| `_m()` | update_cmd.py:158 | 调用时解析 main（晚绑定） |
| `_git_run()` | update_cmd.py:263 | git 执行原语（network 显式标注） |
| `arm_commit_obligations()` | update_cmd_commit.py:121 | 武装恢复义务 |
| `disarm_commit_obligations()` | update_cmd_commit.py:152 | 移动前失败时归还义务 |
| `arm_tree_move()` | update_cmd_commit.py:250 | 树移动提交点 |
| `publish_recovery_closure()` | update_cmd_commit.py:277 | 发布旧树恢复闭包 |
| `restore_interrupted_pull` | _early_recovery.py | 启动时放回撕裂树 |
| `run_git` | update_custody.py | 子进程 git 的唯一生成策略 |
| `acquire/release` | update_lock.py | 跨进程更新互斥 |
| `_should_zip_fallback_on_update_error()` | update_cmd.py:469 | ZIP 回退判定 |

## 本组文件清单（44 文件）

| 文件 | 职责 |
|---|---|
| update_cmd.py | 管线派发器 + git plumbing 门面 |
| update_cmd_check.py | --check 步骤：碎片清理/通道目标/范围 fetch/裁决 |
| update_cmd_commit.py | 唯一提交点：树移动前武装全部恢复义务 |
| update_cmd_common.py | 叶子助手（无 Hermes import，无环） |
| update_cmd_config.py | 更新后 config schema 迁移（活动 profile + 全部兄弟） |
| update_cmd_drain_report.py | 命名 drain 中的网关在等什么 |
| update_cmd_fleet.py | 舰队重启 + 更新后验证 |
| update_cmd_fleet_checkout.py | 重启义务的 checkout 谱系 |
| update_cmd_fleet_gatewayless.py | 无网关主机的证据 |
| update_cmd_fleet_unit_budget.py | systemd unit 的重启计时预算 |
| update_cmd_fleet_verify.py | 重启后舰队验证 |
| update_cmd_git.py | fork/upstream 同步、trampoline-git 检测、lockfile/EOL churn |
| update_cmd_maint.py | 更新后维护：备份快照、state-db 验证/恢复 |
| update_cmd_pause_gate.py | 被暂停网关的树 gate（Windows 暂停，#132338） |
| update_cmd_posix_pause.py | Linux/macOS 的换树前网关暂停 |
| update_cmd_stale_survivors.py | 舰队矩阵证明陈旧的网关升级处置 |
| update_cmd_stash.py | autostash：pull 前 stash，之后恢复/停放/丢弃 |
| update_cmd_validation.py | 更新与 stash 恢复的源 import 完整性检查 |
| update_cmd_windows.py | Windows 网关生命周期：暂停/恢复/冷启动、venv 占用者 |
| update_cmd_zip.py | ZIP 回退（Windows 坏 git）：两段 stage/commit 交换 |
| update_abort_recovery.py | 进程内重启阶段中止后的新进程恢复 |
| update_channel.py | 每安装更新通道记录 |
| update_completion.py | 新 checkout 的源更新完成 + 仅 stdlib 父传输 |
| update_contract.py | 镜像托管安装的拒绝契约 |
| update_custody.py | 更新子进程的 checkout 保管（R2）：唯一 spawn 策略 |
| update_downgrade_guard.py | 拒绝 state.db 已依赖更新网关 runtime 的降级 |
| update_finish.py | 现行与历史调用方共用的 post-checkout 完成 |
| update_fleet_scope.py | 舰队重启的 home scoping（#93349） |
| update_handoff.py | 冻结兼容面：经 post-swap hand-off 完成更新的发行版 |
| update_host_obligation.py | 主机范围 update→restart 义务 |
| update_inventory.py | 运行时清单 + 舰队更新计划 |
| update_launch_files.py | 启动任何网关前重写 Hermes 拥有的 launch 文件 |
| update_lock.py | 进行中更新的跨进程互斥 |
| update_owning_install.py | 把更新送回其解释器所属安装 |
| update_pause_record.py | Windows 上被暂停网关/服务的持久记录 |
| update_proxy_env.py | 撤销 Desktop 交给更新子进程的系统代理 |
| update_receipt.py | 结构化更新回执 + 舰队版本验证 |
| update_restart_recovery.py | 从干净 Python 代重启受监督网关 profile |
| update_serve_obligations.py | 手动 serve/dashboard 的持久重启提醒 |
| update_serve_resume.py | 历史更新器暂停的手动后端的新进程适配器 |
| update_stage.py | 若桌面 hand-off UI 在看，暂存更新 |
| update_windows_acl.py | 提权更新后归还 windows_home_acl 步骤 |
| _old_updater.py | 已运行历史 updater 的新导入逃生口 |
| _update_takeover.py | 历史 updater 接管的绝对路径 bootstrap |

## 与其他模块的关系

- **hermes_bootstrap / _early_recovery**：撕裂树在下一次启动时恢复——更新系统的最后防线在启动路径上。
- **gateway/**：暂停/重启的都是网关服务；`gateway_multiplex_s6.py` 与 fleet restart 协作。
- **pm/**：venv 同步尾巴由 PM 环境消费；shim 检疫与 PM 策略衔接。
- **cli.py**：`/update` slash 命令最终落到 `_cmd_update_impl`（gateway 模式用文件 IPC 提示）。
- **observability/**：更新事实经 `shared_metrics_update` 上报。

## 总结

更新系统的一切复杂度都源于一个事实：**正在更新的代码就是正在运行的代码**。于是它把每一步危险操作变成「先武装义务、再动手、失败即无操作」——提交点、互斥、暂停 gate、舰队验证、结构化回执都是围绕这条不变量的防御工事。Windows 的 ZIP 回退不是简化版，而是同一提交点契约的第二个实现。
