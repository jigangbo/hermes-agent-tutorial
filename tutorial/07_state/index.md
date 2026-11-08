# 07 状态持久层（State Persistence Layer）总览

## 文件概览

Hermes 的所有会话状态——会话行、消息转录、token 用量、FTS 全文索引、网关路由索引、cron 记录——都落在一个单文件 SQLite 库里：`HERMES_HOME/state.db`。入口是根目录的门面 `hermes_state.py`（`SessionDB` 类），它由一组 `hermes_state_<topic>.py` 兄弟模块按 mixin 组装而成。当前树上共有 **64 个 `hermes_state_*.py` 根级兄弟文件**（文件数量随版本演进，本篇以当前 `main` 树为准逐一清点）；加上门面本身，构成约 2.8 万行的持久层。

设计上这一层回答三个问题：

1. **一个文件，多个进程**——gateway 长驻、cron 定时进出、CLI 一次性打开，都要安全地共用 `state.db`。答案是 WAL 多读一写 + 耐心预算 + 文件身份探测 + 孤儿锁防护。
2. **谁有权改什么**——所有"改状态"的动作（/model、/branch、压缩、删除、重置）走 **mutation 回执事务**：一个闭合动作 = 一个 `BEGIN IMMEDIATE` = 一张可精确重放的回执。
3. **坏了怎么办**——每一类损伤（清零、损坏、被替换、WAL 世代丢失、FTS 索引损坏）都有专门的检疫/修复/降级路径，且"绝不原地修库"是底线。

## 存储模型：多读连接 / 写连接 / WAL / 回执事务

```
                          HERMES_HOME/state.db  （单 SQLite 库，WAL 模式）
                          ├── state.db-wal      （写前日志，journal_size_limit 64 MiB）
                          └── state.db-shm      （共享内存索引）
                                       ▲
   进程 A（gateway 长驻）               │               进程 B（cron 一次性）
 ┌──────────────────────────┐         │         ┌──────────────────────────┐
 │ SessionStore ──┐         │         │         │ run_agent：SessionDB()   │
 │ GatewayRunner ─┴→registry│         │         │ 直接 open + close        │
 │   acquire() 每路径 refcount=1      │         │ （或经 registry acquire） │
 │        │                 │         │         │        │                 │
 │  ┌─────▼──────┐  ┌──────┐│         │         │  ┌─────▼──────┐          │
 │  │ 1 写连接    │  │读连接池││  读不排队 │         │  │ 1 写连接    │          │
 │  │ BEGIN      │  │mode=ro││  写互斥   │         │  │ BEGIN      │          │
 │  │ IMMEDIATE  │  │上限 8/ ││         │         │  │ IMMEDIATE  │          │
 │  │ +抖动重试   │  │文件 24/││         │         │  │ +抖动重试   │          │
 │  └─────┬──────┘  │进程    ││         │         │  └─────┬──────┘          │
 │        │         └──────┘│         │         │        │                 │
 │  _execute_write(fn)      │         │         │  _execute_write(fn)      │
 │  ── 回执事务 ──────────────┘         │         └──────────┬───────────────┘
 │  admit → claim → settle              │                    │
 │  （runtime_epoch + admission 回执）   │                    │
 └──────────────────────────────────────┼────────────────────┘
                                        │
            每 50 次成功写 → PRAGMA wal_checkpoint(PASSIVE)
            每 1000 次写   → 有界 FTS 'merge'（每索引 ≤4 命令 × 500 页）
            NFS/SMB/ZFS/virtiofs → journal_mode 回退 DELETE（只读池随之关闭）
```

要点：

- **写互斥靠应用层耐心，不靠 SQLite busy handler**。`SessionDB` 把 busy timeout 压到 1 秒，锁冲突时释放 Python 锁、睡一个随机抖动、然后**整段回调重跑**（回调必须幂等）。
- **读路径在 WAL 下走独立 `mode=ro` 连接池**，读不排队在写锁后面；池满或非 WAL（DELETE 回退）时降级到写连接上的带锁读——"慢但活着"优于 EMFILE 崩溃。
- **回执事务是唯一的合法写通道**（运行时动作）：`admit_session_input` 入队 → `claim_session_input` 领取 → `settle_session_input` 结算，每一步都在一个 `BEGIN IMMEDIATE` 里完成校验+写+回执落盘，天然可精确重放。

### 写耐心预算（hermes_state.py:488-513，已核实）

| 预算 | 值 | 用途 |
|---|---|---|
| `_WRITE_PATIENCE_S` | 20s | 常规写默认预算（兄弟进程合法持锁：VACUUM、checkpoint、修复） |
| `_TRANSCRIPT_WRITE_PATIENCE_S` | 60s | 转录写（失败会中止整轮对话，给最长耐心） |
| `_ACTIVITY_WRITE_PATIENCE_S` | 0.5s | 心跳/活动观察写（在响应关键路径上，跳过即下次重试） |
| `_COMPRESSION_BUSY_WAIT_S` | 5s | 压缩锁忙等（租约是正确性边界，超时必须拒绝而非硬闯） |
| `_WRITE_RETRY_MIN/MAX_S` | 0.020–0.150s | 前 2 秒的快抖动 |
| `_WRITE_RETRY_SLOW_MIN/MAX_S` | 0.250–1.000s | 2 秒后的慢抖动 |
| `_CHECKPOINT_EVERY_N_WRITES` | 50 | 每 50 写一次 PASSIVE checkpoint |
| `_FTS_MERGE_EVERY_N_WRITES` | 1000 | 每 1000 写做有界 FTS merge（代替 9–18 秒的 'optimize'） |

## 66 → 64：兄弟文件主题地图

任务书按 66 个兄弟计数，当前树实测为 **64 个**（数量随提交漂移，以文件系统为准）。按八篇文档分组如下；每篇文末的「本组文件清单」表会再逐行展开：

| 篇 | 主题 | 兄弟文件数 |
|---|---|---|
| `facade.md` | 门面、共享常量、id 铸造、身份键、注册表、可移植性 | 6 |
| `wal_mutations.md` | WAL 策略、runtime 回执事务、mutation 处理器、worker/local 三族 | 19 |
| `sessions_messages.md` | 会话行、转录、标题、时间线、resume 组装 | 11 |
| `compression_state.md` | 压缩谱系、覆盖、显示、原位重写、api_content 边车 | 5 |
| `locks_guards.md` | 测试隔离守卫、OFD 锁、锁主、PID 命名空间、健康闩、读池 | 8 |
| `search_maintenance.md` | FTS 索引、检索、保留修剪、修复、schema 漂移、/undo | 10 |
| `misc_state.md` | 网关持久化、异常分类、schema DDL、用量、terminal 墓碑 | 5 |
| **合计** | | **64** |

### 全部 64 文件总表

| 文件 | 分组 | 角色一句话 |
|---|---|---|
| `hermes_state_common.py` | facade | 家族共享常量与 SQL 片段，住在 hermes_state 之外以破导入环 |
| `hermes_state_ids.py` | facade | `YYYYMMDD_HHMMSS_<hex>` 会话 id 的唯一铸造点与形状识别器 |
| `hermes_state_keys.py` | facade | cron 请求 id、admission 指纹、`local-` 身份等纯派生（stdlib-only） |
| `hermes_state_identity.py` | facade | schema v31 durable message identity 列的编解码器 |
| `hermes_state_registry.py` | facade | 进程级每路径 refcount 共享 SessionDB 的注册表 |
| `hermes_state_portability.py` | facade | 会话导出/导入（portability）mixin 与导入上限 |
| `hermes_state_wal.py` | wal_mutations | journal-mode/PRAGMA 策略：WAL 优先、NFS/SMB/ZFS/virtiofs 回退 DELETE |
| `hermes_state_runtime.py` | wal_mutations | runtime 回执事务：epoch、admit/claim/settle/cancel/recover |
| `hermes_state_mutations.py` | wal_mutations | 闭合动作的载荷校验与处理器分派表 |
| `hermes_state_mutation_binding.py` | wal_mutations | 未绑定 legacy 历史的 control-only 所有权 |
| `hermes_state_mutation_branch.py` | wal_mutations | /branch：独立路由+转录+冻结策略一提交 |
| `hermes_state_mutation_chat_pick.py` | wal_mutations | 消息端聊天的 /model /reasoning 拾取的 exact-retry 回执 |
| `hermes_state_mutation_compress.py` | wal_mutations | 压缩：摘要+物理目标+代数+回执原子提交 |
| `hermes_state_mutation_guards.py` | wal_mutations | 在写连接上执行的空闲/推进守卫与删除目标闭包 |
| `hermes_state_mutation_prepared.py` | wal_mutations | 乐观准备快照在事务内重校验 + model/reasoning/workspace 等处理器 |
| `hermes_state_mutation_reset.py` | wal_mutations | /reset：发布 reset 子行并推进物理目标 |
| `hermes_state_mutation_retirement.py` | wal_mutations | durable 删除围栏（RETIRED_PREFIX）与终端回执退休 |
| `hermes_state_mutation_transcript.py` | wal_mutations | 事务内回退（rewind）原语，供 /undo /retry 与 mutation 共用 |
| `hermes_state_runtime_workers.py` | wal_mutations | worker 排除跟随会话+谱系；子执行退休与回执压缩 |
| `hermes_state_worker_compression.py` | wal_mutations | worker 回执连接上的闭合压缩 op（锁/冷却/水位/发布） |
| `hermes_state_worker_context.py` | wal_mutations | worker 构造上下文读取（session/prompt/sidecars/tool_names） |
| `hermes_state_worker_lifecycle.py` | wal_mutations | worker 生命周期闭合处理器（create/end/title/activity） |
| `hermes_state_local.py` | wal_mutations | 私有本地创建回执（POLICY_PREFIX 路由+策略一提交） |
| `hermes_state_local_lineage.py` | wal_mutations | 发布事务内物理目标交接（validate/advance） |
| `hermes_state_local_migration.py` | wal_mutations | 事务性 legacy 绑定（老 CLI/TUI/GUI 行收编） |
| `hermes_state_sessions.py` | sessions_messages | 会话行生命周期 mixin：创建/结束/重开/列表/删除 |
| `hermes_state_sessions_model_config.py` | sessions_messages | 会话级 model_config 的读改写（在压缩 tip 上） |
| `hermes_state_session_list.py` | sessions_messages | `list_sessions_rich` 的页投影（root→tip 替换） |
| `hermes_state_messages.py` | sessions_messages | 转录 append/replace/rewind、reactions、resume 组装 |
| `hermes_state_titles.py` | sessions_messages | 标题净化、user/llm/derived 出处排序 |
| `hermes_state_timeline.py` | sessions_messages | 只读 prompt 索引与有界跳转（不水合全转录） |
| `hermes_state_todo.py` | sessions_messages | resume 恢复最新有效 Todo 结果（索引化有界搜索） |
| `hermes_state_detached_results.py` | sessions_messages | turn 间隙到达的结果记为 user 行（恰好一次） |
| `hermes_state_stored_reads.py` | sessions_messages | `session.transcript`/picker 背后的存储读投影 |
| `hermes_state_telegram.py` | sessions_messages | Telegram DM 话题模式 mixin（表+绑定） |
| `hermes_state_user_copy.py` | sessions_messages | 存储不可用时的白话文案总表（各端共用） |
| `hermes_state_compression.py` | compression_state | 谱系、冷却/连击、压缩锁、turn 租约 |
| `hermes_state_coverage.py` | compression_state | 原位压缩的持有行覆盖判定 |
| `hermes_state_compaction_display.py` | compression_state | 显示层把压缩工具结果画成归档原貌 |
| `hermes_state_prune_rewrite.py` | compression_state | proactive prune 的原位行重写与 CAS 陈旧探测 |
| `hermes_state_api_content.py` | compression_state | `api_content` 边车回填写入 |
| `hermes_state_guard.py` | locks_guards | 活库测试隔离守卫（pytest 进程绝不碰生产库） |
| `hermes_state_lockguard.py` | locks_guards | 持 WAL 文件 OFD 锁，防游离 close 取消 SQLite 锁 |
| `hermes_state_lockowners.py` | locks_guards | /proc/locks 查谁正持写锁（排障日志） |
| `hermes_state_holders.py` | locks_guards | 结构维护的进程/描述符权威 + `read_only_db_uri` |
| `hermes_state_pidns.py` | locks_guards | PID 命名空间身份（跨容器不误收租约） |
| `hermes_state_health.py` | locks_guards | 每路径 STORAGE_CORRUPT 健康闩（进程级） |
| `hermes_state_dbfile.py` | locks_guards | 文件级健康：清零检疫、交叉锁、退休 WAL 代捕获 |
| `hermes_state_readpool.py` | locks_guards | 读连接预算（每文件 8 / 每进程 24 / fd 余量门） |
| `hermes_state_fts.py` | search_maintenance | FTS5 索引 ensure、tokenizer 能力回退、fail-open 卸触发器 |
| `hermes_state_search.py` | search_maintenance | 全文/trigram/CJK 检索与 FTS 重建/优化引擎 |
| `hermes_state_maintenance.py` | search_maintenance | 保留修剪、陈旧会话归档、VACUUM 策略 |
| `hermes_state_repair.py` | search_maintenance | 修复/备份/可写性预检/耐久屏障 |
| `hermes_state_profile_repair.py` | search_maintenance | 跨 profile 行的发现与搬家修复 |
| `hermes_state_reconcile.py` | search_maintenance | schema 漂移原因与浏览时自愈 |
| `hermes_state_rewind.py` | search_maintenance | carrier-aware user-turn 回退支撑 /undo /retry |
| `hermes_state_legacy_refusal.py` | search_maintenance | 旧版安全拒绝行的一次性数据迁移修复 |
| `hermes_state_media.py` | search_maintenance | durable 媒体退休候选（删除后仍可回收） |
| `hermes_state_prompt_refresh.py` | search_maintenance | 系统提示词刷新 epoch（state_meta 计数器） |
| `hermes_state_gateway.py` | misc_state | 路由索引、peers、orphans、heartbeats、handoffs |
| `hermes_state_errors.py` | misc_state | StateDbCorruptError 等异常与字符串分类谓词 |
| `hermes_state_schema.py` | misc_state | 声明式 DDL、列调和、FTS 重建编排 |
| `hermes_state_usage.py` | misc_state | 合并式后台 token 写入器与每模型用量行 |
| `hermes_state_terminal.py` | misc_state | 私有 terminal 墓碑查询（精确重放拒绝重放件） |

## 与其他模块的关系

- **gateway（`gateway/session.py`）**：`SessionStore` 是路由索引+转录的门面，落库全部经 `SessionDB`；长驻进程按 `hermes_state_registry.acquire()` 共享每路径唯一写连接（注释见 `gateway/session.py:791`："Session routing index + transcripts: SQLite (SessionDB)"）。
- **cron（`cron/scheduler.py`）**：每次 fire 用 `hermes_state_registry.acquire/release_or_close` 借还句柄（`cron/scheduler.py:1869`），并用 `_BoundedCronSessionDB` 代理清理调用防止卡死。
- **run_agent / TUI / Desktop**：经 `AsyncSessionDB`（`hermes_state.py:1725`，每个调用 `asyncio.to_thread`）或直接 `SessionDB`；runtime 回执事务（`hermes_state_runtime.py`）是 gateway RPC `session.*` 的存储后端。
- **`hermes doctor` / `hermes sessions recover`**：消费 `hermes_state_repair.py`、`hermes_state_holders.py`、`hermes_state_lockowners.py`、`hermes_state_health.py` 暴露的诊断与修复面。
- **插件**：只能通过已发布的 plugin API 间接触碰状态层；`hermes_state_*` 不是插件面。

## 本系列文档导航

1. `facade.md` — 门面与基础设施组
2. `wal_mutations.md` — WAL 与 mutation 回执事务
3. `sessions_messages.md` — 会话与消息
4. `compression_state.md` — 状态层压缩
5. `locks_guards.md` — 锁、守卫与持有者
6. `search_maintenance.md` — 检索与维护
7. `misc_state.md` — 网关持久化与收尾

## 总结

状态层是一个"窄腰"：所有进程共写一个 SQLite 文件，靠 WAL 换并发、靠耐心预算换公平、靠回执事务换幂等、靠检疫而非原地修复换安全。64 个兄弟文件各守一个主题，门面只做组装；下一篇从门面本身读起。
