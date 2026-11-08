# 状态与存储模型

> 一切会话状态最终落在一个 SQLite 文件里。本文讲清楚：数据长什么样、并发怎么控制、"改历史"为什么是一次事务仪式。

## 数据在哪里

```
~/.hermes/                      ← get_hermes_home()，profile 感知
├── config.yaml                 设置（行为都在这；.env 只放密钥）
├── state.db                    ★ 唯一权威状态库（每 profile 一个）
├── cron/jobs.json              定时任务存储
├── kanban.db                   看板（跨 profile 协调原语，SQLite WAL）
├── logs/
└── skills/  plugins/  ...
```

`hermes_state.py:181` 的 `DEFAULT_DB_PATH` 指向 `state.db`。压缩会把长会话经 `parent_session_id` 链拆分成谱系；会话带来源标签（`cli` / `telegram` / ...）。

## SessionDB：17 个 mixin 组成的门面

`hermes_state.py::SessionDB`（行 464，1,738 行文件）由 17 个 mixin 组成，另有 66 个 `hermes_state_*.py` 兄弟文件按主题拆分（sessions、WAL、mutation、压缩、锁、运行时 worker、FTS、维护……）。主题式索引见 [07_state](../07_state/index.md)。

长命进程通过 `hermes_state_registry.py` 共享**每个 resolved 路径一个** refcount 的 SessionDB（文件被替换时按代数退休）；一次性脚本自己开。

## 兄弟文件的主题分组（66 个文件怎么找）

`hermes_state_*.py` 按主题前缀分组，找代码先按主题 grep（每组都有专文，见 [07_state](../07_state/index.md) 的清单表）：

| 主题前缀 | 管什么 |
|----------|--------|
| `hermes_state_wal` / `mutation_*` / `runtime` | journal 模式 + 变更回执事务（写路径的心脏） |
| `hermes_state_session*` / `message*` / `timeline` / `title*` | 会话、消息、时间线与标题 |
| `hermes_state_compression*` / `coverage` / `compaction_display` | 压缩谱系与显示 |
| `hermes_state_lock*` / `guard*` / `holder*` / `pidns` | 锁、守卫与持有者身份 |
| `hermes_state_runtime_*` / `worker_*` | runtime 回执与后台 worker 协议 |
| `hermes_state_fts*` / `search*` / `prune` / `repair*` / `reconcile` | 检索、修剪、修复与对账 |

## 并发模型：WAL + 写入耐心预算

```
        多读 ──────────────┐
                           ▼
   state.db  (SQLite, WAL 模式)      多个读取连接（hermes_state_readpool.py 预算）
        ▲
        │ 一写
   写连接（写耐心预算 + 抖动重试 + 每 50 写被动 checkpoint）
```

- `hermes_state_wal.py` 拥有 journal 模式/PRAGMA 策略；WAL 不兼容的文件系统（NFS/SMB/ZFS 标记）回退 DELETE journal。
- 写竞争按**操作类型**给耐心预算：常规 20s、转录 60s、活动 0.5s、压缩忙等 5s，随机抖动重试。
- `hermes_state_lockguard.py` 持有 WAL 文件锁防止游离 `close()` 取消它们；`hermes_state_lockowners.py` 能查到"谁持有写锁"（读 `/proc/locks`）；`hermes_state_pidns.py` 处理 PID 命名空间下的持有者身份。

## mutation 回执系统：改历史是一场事务仪式

任何转录/策略变更 —— 切模型、分支、重置、压缩发布、回退、聊天选择、worker 生命周期 —— 都必须作为一个**闭合动作**在**单一回执事务**里提交（`hermes_state_runtime.py` + `hermes_state_mutation_*.py`）：

```
乐观准备快照（hermes_state_mutation_prepared.py）
        │  （准备阶段可在事务外计算）
        ▼
写连接上开事务 → 守卫重校验快照（hermes_state_mutation_guards.py）
        → 应用动作 → 落回执 → 提交
```

意义：**崩溃时要么动作完整发生，要么完全没发生**，不存在"改了一半的转录"。例如压缩发布（`hermes_state_mutation_compress.py`）在一个提交里原子写入摘要 + 物理目标 + 代数 + 回执。

## 压缩谱系：会话不是一条线，是一棵树

```
session A (原始, 变满)
   │ 压缩 #1
   ▼
session A' (摘要头 + 保留尾)  ← parent_session_id → A
   │ 压缩 #2
   ▼
session A''                    ← parent_session_id → A'
```

- `hermes_state_compression.py` 管谱系、冷却/连击计数、锁与 turn 租约；
- `hermes_state_coverage.py` 记录压缩器"持有"了哪些持久行；显示层（`hermes_state_compaction_display.py`）把已压缩的工具结果画成其归档原貌；
- 缓存键作用域取**谱系根**（见 [提示词缓存不变量](caching_invariants.md) 支柱 4）—— 物理会话 id 轮换，缓存身份不换。

## 网关侧的路由索引与权威

SessionDB 之上还有一层网关自有状态（`gateway/session.py::SessionStore`，行 787）：内存路由索引 `_entries`（代数计数持久化 + sessions.json 兼容写）、每 profile 缓存的 SessionDB 句柄、每会话转录重试队列。再往上是 `SessionAuthority`（`gateway/session_authority.py`）—— 网关拥有的活会话层，用 `hermes_state_runtime` 的原语调度 durable FIFO。**SessionDB 是事实（facts），SessionAuthority 是意图（intents）。**

## 跨进程协作的三条纪律

1. **owner 应用，查看者不写**："bulk prune while the gateway is up: the owner applies it, this process never writes"（`hermes_cli/sessions_owner.py` 的注释就是这个模式的命名）。
2. **离线交接**：需要独占维护时，`hermes_cli/cli_snapshot.py` 先把 profile 离线交接、维护完再重新加入权威。
3. **崩溃即回执**：任何"看起来没做完"的状态由回执事务 + `occurrences.py` 式的恢复逻辑补齐，而不是靠各进程自觉。

三条纪律的共同前提是：SQLite 文件本身是唯一事实源，进程内的任何缓存（路由索引、句柄 refcount）都只是它的视图。

## 文件级健康与修复

`hermes_state_dbfile.py`（清零/交叉锁定的隔离检疫）、`hermes_state_repair.py`（修复/备份/可写性预检）、`hermes_state_profile_repair.py`（跨 profile 污染的查找与修复）、`hermes_state_reconcile.py`（schema 漂移检测）—— 一个被多进程高频写入的 SQLite 需要整条"医院"生产线，这也是 `07_state` 目录篇幅最大的原因。

## 下一步

- 逐文件走读 → [07_state/index](../07_state/index.md)
- 网关怎么用这套存储 → [05_gateway/index](../05_gateway/index.md)
