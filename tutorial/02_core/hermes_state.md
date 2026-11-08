# hermes_state.py —— SQLite 状态库的门面（65 个文件的一家）

> 阅读前提：[../01_architecture/state_model.md](../01_architecture/state_model.md)；更细的主题文档在 [../07_state/](../07_state/index.md)。本章讲门面与兄弟的分工。

## 文件概览

```python
# hermes_state.py:1-6
"""SQLite state store for Hermes Agent: session metadata, message history, model
config, FTS5 search. WAL mode (concurrent readers + one writer); compression
splits sessions via parent_session_id chains; sessions are source-tagged
('cli', 'telegram', ...). Batch-runner / RL trajectories live elsewhere.
"""
```

`hermes_state.py`（1,738 行）是 `SessionDB` 的门面。四个关键事实浓缩在 docstring 里：**WAL 多读一写**；**压缩经 `parent_session_id` 拆谱系**（一次压缩生成新会话行，旧会话成为父节点）；**会话带来源标签**（cli / telegram / …）；批量/RL 轨迹另存。实现散布在 64 个 `hermes_state_*.py` 兄弟中——根目录 86 个 `.py` 文件里这一家占 65 个。

## 关键代码走读

### 1. SessionDB：18 个 mixin 的组装（行 464）

```python
# hermes_state.py:464-473
class SessionDB(
    SessionSessionsMixin, SessionFtsSetupMixin, SessionSearchMixin, SessionSchemaMixin,
    SessionPortabilityMixin, SessionTelegramTopicsMixin, SessionCompressionMixin,
    SessionGatewayMixin, SessionMaintenanceMixin, SessionUsageMixin, SessionTitlesMixin,
    SessionMessagesMixin, SessionPruneRewriteMixin, SessionApiContentMixin, SessionCoverageMixin,
    SessionRewindMixin, SessionProfileRepairMixin, SessionPromptRefreshMixin,
):
    """SQLite-backed session storage with FTS5 search; many reader threads, one writer (WAL)."""
```

与 `AIAgent`（14 个 mixin）、`HermesCLI`（18 个）同构：门面只负责把主题 mixin 钉进 MRO。门面**自己保留**的是写路径的心脏与安全网：`__init__`（行 584）、`_execute_write`（行 1014）、`close`（行 1527）、文件身份/代数/损坏隔离逻辑（行 1226-1400）。

### 2. 打开路径与守护

```python
# hermes_state.py:584-588（节选）
    def __init__(self, db_path: Path | None = None, read_only: bool = False):
        self.db_path = db_path or _default_db_path()
        _ensure_test_isolation(self.db_path)  # before any connection/pragma/mkdir
```

任何连接之前先做**live-system guard**：pytest 上下文（env 或祖先进程）解析到生产 state.db 直接抛错（#82770：子进程重建环境后丢了 `HERMES_HOME`，恰好是要写生产库的状态）。可写打开走 `_open_writer`（行 679）：预检可写性 → 零字节/坏头隔离（quarantine）→ 连接 + schema（坏 sqlite_master 一次性就地修复）→ 生成戳（`state_meta` + `PRAGMA application_id`，行 1184）。打开失败的原因记录在 `_set_last_init_error`（`hermes_state_guard.py`），供 `/resume` 等界面给出人话。

### 3. 写路径纪律：`_execute_write`（行 1014）

```python
# hermes_state.py:1014-1021（节选）
    def _execute_write(
        self, fn: Callable[[sqlite3.Connection], T], patience_s: Optional[float] = None,
    ) -> T:
        """Run *fn(conn)* inside BEGIN IMMEDIATE with jittered lock retry; commit
        is handled here (callers must not commit). Returns *fn*'s result.
        BEGIN IMMEDIATE takes the WAL write lock up front so contention surfaces
        immediately; on locked/busy the Python lock is released, a jitter slept,
        and the WHOLE callback retried — *fn* must stay idempotent under retry."""
```

要点：**BEGIN IMMEDIATE** 抢锁前移，冲突立刻可见；**抖动重试**整个回调（前 2 秒 20-150ms 快抖动，之后 250ms-1s 慢抖动）；耐心按用途分级——普通写 20s、转录写 60s、观测性活动写仅 0.5s（行 488）；压缩租约冲突单独给 5s 短等待（`_COMPRESSION_BUSY_WAIT_S`），超时**拒绝**而不是把陈旧 turn 落进正在压缩的会话。每 50 次成功写做一次 PASSIVE checkpoint（TRUNCATE 曾在大库上撕裂 B-tree，#45383）。锁耗尽时的报错说人话：指出"另一个 Hermes 进程持有写锁超过 N 秒"，持有者信息进日志而不是消息（避免 argv 里的词改变错误分类）。

### 4. 读路径分裂与 close

WAL 模式下读走**有界只读连接池**（`_read_ctx`，行 927）：池借不到（许可按数据库路径共享，`hermes_state_readpool.py`）就降级到写锁——"慢优于 EMFILE"。`close()`（行 1527）先排空 token 队列，再按状态收敛：registry 共享实例只放 refcount（`hermes_state_registry.release`）；WAL 代数丢失的句柄先**留证捕获**（`capture_retired_wal_generation`）再决定是否永不 close（Python < 3.12 无法关掉关闭时 checkpoint，只能把连接 pin 住）；干净关闭才做 PASSIVE checkpoint 并清空 sidecar 身份。

### 5. 为什么 `hermes_state_common.py` 住在门面外

```python
# hermes_state.py:31-36
from hermes_state_common import (
    TITLE_SOURCE_DERIVED as _TITLE_SOURCE_DERIVED, ...
)
```

64 个兄弟里有一个特例：`hermes_state_common.py`（75k 字节，全家族最大的纯助手集）**不 import 门面**，只被门面和兄弟 import。原因是破环：门面要从它取常量/助手，兄弟也要从它取；若它反过来函数内 late-import 门面没问题，但它被门面在**模块级** import，任何门面级回引都会成环。其余兄弟全部遵循"函数内 late-import 门面"模式——例如压缩、搜索 mixin 需要访问 `SessionDB` 的写路径时，都是从 `hermes_state` 取名字，这让**门面保持 patch seam** 地位。

### 6. 主题如何找到实现

门面里没有"压缩怎么写库"。按主题 grep：

```bash
grep -rn "def compress" hermes_state_*.py       # → hermes_state_compression.py / _mutation_compress.py
grep -rn "def add_message" hermes_state_*.py    # → hermes_state_messages.py
grep -rn "def search_messages" hermes_state_*.py  # → hermes_state_search.py
```

完整主题分组（谱系/写路径/mutation 收据/repair）见 [../07_state/](../07_state/index.md) 目录文档。

## 核心类/函数

| 名称 | 位置 | 职责 |
|---|---|---|
| `SessionDB` | hermes_state.py:464 | 18 个 mixin 的门面类 |
| `SessionDB.__init__` | hermes_state.py:584 | 守护 → 打开 → 身份快照；失败记 `_set_last_init_error` |
| `_open_writer` | hermes_state.py:679 | 预检/隔离/连接/schema/生成戳 |
| `_execute_write` | hermes_state.py:1014 | BEGIN IMMEDIATE + 抖动重试 + 分级耐心 |
| `_read_ctx` | hermes_state.py:927 | WAL 池化只读连接，降级到写锁 |
| `close` | hermes_state.py:1527 | 排空/代数留证/检查点/释放 refcount |
| `_halt_db_corrupt` / `_raise_if_db_replaced` | hermes_state.py:1351/1328 | 结构损坏隔离与文件被换的粘性拒绝 |
| `_ensure_db_file_generation` | hermes_state.py:1184 | 每文件一次的生成戳（state_meta + application_id） |
| `AsyncSessionDB` | hermes_state.py:1725 | `asyncio.to_thread` 包装，异步门 |
| `hermes_state_registry.acquire/release_or_close` | hermes_state_registry.py:195/474 | 进程级共享连接注册表（#90837） |
| `format_session_db_unavailable` | hermes_state.py:381 | "存储不可用"的人话提示（网络盘提示等） |

## 本组文件清单（门面 + 64 兄弟，一个不漏）

| 文件 | 一行角色 |
|---|---|
| hermes_state.py | 门面：SessionDB 组装、写路径心脏、文件身份/损坏隔离、close |
| hermes_state_api_content.py | `api_content` sidecar 回填写入（#124102 行拆分） |
| hermes_state_common.py | 家族共享常量/助手；**住在门面外以破导入环** |
| hermes_state_compaction_display.py | 压缩归档行按原始内容一次性展示（#132939） |
| hermes_state_compression.py | 压缩谱系、冷却/连击计数、锁与 turn 租约 |
| hermes_state_coverage.py | 就地压缩的"持有行"覆盖判定 |
| hermes_state_dbfile.py | state.db 文件级健康（预开检查/隔离/退役捕获） |
| hermes_state_detached_results.py | turn 之间到达的分离式结果落成 user 行 |
| hermes_state_errors.py | 异常类型与错误分类谓词 |
| hermes_state_fts.py | FTS5 索引建立与 tokenizer 能力回退 |
| hermes_state_gateway.py | 网关侧持久化：路由索引、peers、孤儿、心跳、handoff |
| hermes_state_guard.py | live-DB 测试隔离守卫 + 进程级 init 错误记录 |
| hermes_state_health.py | profile 级存储健康闩锁（每路径一个） |
| hermes_state_holders.py | state.db 结构维护的进程/描述符权威 |
| hermes_state_identity.py | 消息身份列的编解码（schema v31） |
| hermes_state_ids.py | 会话 id 铸造：`YYYYMMDD_HHMMSS_<hex>` 唯一定义点 |
| hermes_state_keys.py | 规范存储与网关共用的纯身份推导 |
| hermes_state_legacy_refusal.py | 旧安全拒绝对话的一次性修复（#149708） |
| hermes_state_local.py | 私有本地创建回执（规范运行时事务 owner） |
| hermes_state_local_lineage.py | 发布事务内的本地物理目标移交 |
| hermes_state_local_migration.py | 事务性 legacy 绑定；绝不做第二个转录写入者 |
| hermes_state_lockguard.py | 把 WAL 文件锁钉成 stray close() 取消不掉的形态 |
| hermes_state_lockowners.py | 此刻谁持有写锁（Linux /proc/locks） |
| hermes_state_maintenance.py | 保留修剪、陈旧会话归档、VACUUM 策略 |
| hermes_state_media.py | 媒体退役候选跨转录删除存活 |
| hermes_state_messages.py | 转录持久化：追加/替换/rewind/反应/resume 组装 |
| hermes_state_mutation_binding.py | 未绑定 legacy 历史的 control-only 归属 |
| hermes_state_mutation_branch.py | 独立本地路由+转录+冻结策略的一次回执提交 |
| hermes_state_mutation_chat_pick.py | 消息聊天 viewer 选择的精确重试回执 |
| hermes_state_mutation_compress.py | 原子提交 prepared summary/目标/代数/回执 |
| hermes_state_mutation_guards.py | 回执写连接上评估的转录变更守卫 |
| hermes_state_mutation_prepared.py | 乐观准备快照在回执事务内重验证 |
| hermes_state_mutation_reset.py | 本地 reset 的准备与发布 |
| hermes_state_mutation_retirement.py | 可修剪转录行之外的持久删除栅栏 |
| hermes_state_mutation_transcript.py | storage 与 canonical mutation 共用的事务域 rewind |
| hermes_state_mutations.py | 运行时回执事务内的封闭动作处理器 |
| hermes_state_pidns.py | 锁/租约持有者的 PID 命名空间身份 |
| hermes_state_portability.py | 会话列表/富行/导出/导入 |
| hermes_state_profile_repair.py | 一个 state.db 里串档 profile 的查找与修复 |
| hermes_state_prompt_refresh.py | 运维请求的系统提示词刷新纪元 |
| hermes_state_prune_rewrite.py | 主动修剪的就地行重写持久化（#124102） |
| hermes_state_readpool.py | WAL 读路径的每文件连接预算 |
| hermes_state_reconcile.py | 附加式 schema 漂移检测与一次性 reconcile |
| hermes_state_registry.py | 进程级共享 SessionDB 注册表（acquire/release） |
| hermes_state_repair.py | state.db 修复、备份、可写性预检 |
| hermes_state_rewind.py | /undo /retry 的载体感知 rewind（唯一实现） |
| hermes_state_runtime.py | 规范运行时事务（调用方授权并解析会话身份） |
| hermes_state_runtime_workers.py | worker 排他跟随逻辑会话与物理谱系 |
| hermes_state_schema.py | schema 创建、列 reconcile、FTS DDL |
| hermes_state_search.py | FTS/trigram/CJK 消息搜索与索引维护 |
| hermes_state_session_list.py | `list_sessions_rich` 的会话列表页投影 |
| hermes_state_sessions.py | 会话生命周期：行 upsert/继承/收尾 |
| hermes_state_sessions_model_config.py | 会话级 model_config 键的读改写 |
| hermes_state_stored_reads.py | `session.transcript` 等背后的存储读 |
| hermes_state_telegram.py | Telegram DM 话题模式 mixin |
| hermes_state_terminal.py | 仅终端用的墓碑查询；不重建可执行历史 |
| hermes_state_timeline.py | 只读提示索引与有界转录跳转 |
| hermes_state_titles.py | 标题清洗与 derived/llm/user 权威排序 |
| hermes_state_todo.py | resume 恢复的最新 Todo 结果的有界检索 |
| hermes_state_usage.py | token/用量会计：合并式后台 token writer |
| hermes_state_user_copy.py | "存储不可用"提示的各语言文案 |
| hermes_state_wal.py | journal 模式与 PRAGMA 策略 |
| hermes_state_worker_compression.py | worker 回执连接上的封闭压缩操作 |
| hermes_state_worker_context.py | worker 回执事务内的封闭构造上下文操作 |
| hermes_state_worker_lifecycle.py | 仅在回执事务内调用的 worker 生命周期处理器 |

## 与其他模块的关系

- **run_agent.py**：`_ensure_db_session`（run_agent.py:315）惰性建会话行；`_finalize_owned_session_row`（:1018）在 close 时收尾并按 `hermes_state_registry.release_or_close` 归还共享连接。
- **gateway/**：每条入站消息的会话行、路由索引、心跳都写在这里（`hermes_state_gateway.py`）。
- **hermes_constants.py**：`_default_db_path()` 用 `get_hermes_home()` 现场解析，运行时重定向 HERMES_HOME 依然生效。
- **hermes_dir_acl.py**：`hermes_state.py:26` 直接 import `make_user_dir` 建目录。

## 总结

- 门面保留写路径心脏与安全网（身份/代数/损坏隔离），18 个 mixin 按主题分家；65 个文件是一家，主题查找靠 grep，细节在 07_state。
- 三条贯穿纪律：测试永不碰生产库（guard）、写必须走 `_execute_write` 的重试与分级耐心、结构损坏永远隔离而非就地修复。
- `hermes_state_common.py` 是唯一的例外邻居——住在门面外是为破导入环，也是理解整个家族 import 拓扑的钥匙。
