# WAL 与 Mutation 回执事务

## 文件概览

这一组回答两个问题：**文件用什么 journal 模式打开**（`hermes_state_wal.py`），以及**"改状态"这一动作如何被原子且可重放地记账**（`hermes_state_runtime.py` + `hermes_state_mutations.py` + 16 个 `mutation_*` / `worker_*` / `local*` 兄弟）。

核心模型：一个**闭合动作**（closed action）= 一个 `BEGIN IMMEDIATE` 事务 = 一张写进 `state_meta` 的回执（receipt，键形如 `gateway.mutation.v1.*`）。调用方先"乐观准备"（在事务外算好快照），事务内重校验快照（revision/generation 围栏），然后提交动作+回执。同一 `(principal, session, request_id)` 的精确重放直接返回旧回执，绝不重复施加。

## 关键代码走读

### 1. WAL 激活与文件系统回退

```python
# hermes_state_wal.py:25-31
# WAL needs mmap shared memory + fcntl byte-range locks. Network filesystems (NFS, SMB/CIFS, some FUSE, WSL1) raise
# ``locking protocol``; ZFS corrupts the -shm file under concurrent bursts (COW + mmap) -> ``disk I/O error``.
# Either would silently break everything on state.db/kanban.db, so fall back to DELETE (readers block on writes).
_WAL_INCOMPAT_MARKERS = ("locking protocol", "not authorized", "disk i/o error")
_WAL_SIZE_LIMIT_BYTES = 64 * 1024 * 1024  # 64 MiB
```

`apply_wal_with_fallback`（hermes_state_wal.py:254）是**唯一**允许发起 journal-mode 切换策略的地方，不变量是"绝不把在盘 WAL 降级成 DELETE"——probe 读不到模式（`None`）与读到 WAL 同样拒绝切换（:395-398），因为所有权不可证明时切换会毁掉兄弟连接未 checkpoint 的提交。`_set_journal_mode_no_wait`（:419）用 `busy_timeout=0` 把"有并发打开者"变成立即失败而不是抢在写者事务之间翻模式。macOS 额外强制 `synchronous=FULL` + `checkpoint_fullfsync`（:96-128），virtiofs/9p（Docker Desktop bind mount）在启用 WAL 之前就直接拒绝（:184-235）。

### 2. PRAGMA 应用层

```python
# hermes_state_wal.py:644-651
def apply_database_pragmas(conn: sqlite3.Connection, *, db_label: str = "state.db") -> None:
    """Apply optional performance and WAL-sizing PRAGMAs from ``config.yaml``.

    Journal mode is NOT handled here (owned by :func:`apply_wal_with_fallback`). ``database:`` keys: ``cache_size``
    (negative = KiB, positive = pages), ``mmap_size`` (bytes, 0 = off), ``temp_store`` (0-3), ``wal_autocheckpoint``
    (pages), ``journal_size_limit`` (bytes), ``synchronous`` (unset leaves the compile-time default...).
```

写者、只读 attach、WAL 读池三种连接统一走这里；`synchronous` 语义特殊（决定落盘与否），不认识的值警告后保持原样而非猜一个（`_apply_synchronous_pragma`，:624）。

### 3. runtime epoch：实例世代的栅栏

```python
# hermes_state_runtime.py:116-123
def begin_runtime_epoch(db, *, instance_id: str) -> int:
    """Caller MUST hold the profile ownership lock, not merely an endpoint ticket."""
    _text(instance_id)
    def write(conn):
        conn.execute('''INSERT INTO runtime_epoch(singleton,epoch,instance_id) VALUES(1,1,?)
            ON CONFLICT(singleton) DO UPDATE SET epoch=runtime_epoch.epoch+1, instance_id=excluded.instance_id''', (instance_id,))
        return conn.execute('SELECT epoch FROM runtime_epoch WHERE singleton=1').fetchone()[0]
    return db._execute_write(write)
```

每个回执写都带 `_epoch(conn, epoch)` 校验（:66-69）：epoch 不匹配 → `stale_epoch`。旧 owner 重启后带着旧 epoch 的任何写都被拒绝。

### 4. admit：入队与精确重放

```python
# hermes_state_runtime.py:130-177（节选）
def admit_session_input(db, *, epoch: int, principal_id: str, session_id: str,
                        request_id: str, payload: dict, intent: str = 'queue',
                        _authorize_write=None, _replay_guard=None) -> dict:
    """Admit input; the trusted private guard raises to refuse a NEW write. ...
    Exact existing and terminal replays bypass it: they cannot create or change accepted work."""
    ...
    def write(conn):
        _epoch(conn, epoch)
        _session(conn, session_id)
        old = conn.execute('''SELECT * FROM session_admissions
            WHERE principal_id=? AND target_session_id=? AND request_id=?''', (principal_id, session_id, request_id)).fetchone()
        if old is not None:
            if old['payload_digest'] != digest:
                raise RuntimeStoreError('admission_conflict', **ADMITTED_REQUEST_CONFLICT)
            if _replay_guard is not None:
                _replay_guard(conn)
            return _row(old)
        queued = conn.execute('''SELECT COUNT(*) FROM session_admissions WHERE target_session_id=?
            AND status='queued' ''', (session_id,)).fetchone()[0]
        if queued >= ADMISSION_QUEUE_MAX:
            raise RuntimeStoreError('queue_full')
        if _authorize_write is not None:
            _authorize_write(conn)
        ...INSERT INTO session_admissions(...status='queued'...)
```

同一 request id + 同一 digest = 精确重放（返回旧回执）；digest 不同 = `admission_conflict`，且 `ADMITTED_REQUEST_CONFLICT`（:38）是唯一能**证明**"请求已被受理过"的冲突形态。守卫 `_authorize_write(conn)` 收到的是事务连接：不许 commit、不许有外部副作用、SQLite 重试时可能再跑一次。队列上限 `ADMISSION_QUEUE_MAX = 32`（:127）。

### 5. claim / settle / cancel / recover

- `claim_session_input`（hermes_state_runtime.py:206）：领取 FIFO 头；有 `started/unknown` 的 admission 或活 worker 就返回 None；`head` 参数实现预检后二次确认；同时记录转录高水位 `transcript_mark`（:240），结算时据此区分本轮失败边界与更早轮次（#134889 GW-21）。
- `settle_session_input`（:245）：`stale_generation` 三重校验（status/owner_epoch/generation），`_terminal_write(conn, row)` 是 owner 的同事务效果，抛错即整体回滚。
- `cancel_session_input`（:280）、`recover_session_inputs`（:453）、`resolve_unknown_session_input`（:657）分别处理取消、owner 重启后的悬空恢复与"结局未知"裁决。
- `mutation_receipt_key` / `replay_mutation_receipt`（:467 / :478）：回执键与重放读取的公共底座。

### 6. 闭合动作分派

```python
# hermes_state_mutations.py:89-102
def apply_action(db, conn, session_id, operation, payload, *, prepared=None):
    if operation == 'compress':
        from hermes_state_mutation_compress import compress_in_transaction
        return compress_in_transaction(db, conn, session_id, payload, prepared)
    if operation in {'model', 'reasoning', 'workspace', 'editor_mcp', 'edit_policy'}:
        from hermes_state_mutation_prepared import POLICY_HANDLERS
        return POLICY_HANDLERS[operation](db, conn, session_id, payload, prepared)
    if operation == 'branch':
        from hermes_state_mutation_branch import branch_in_transaction
        ...
    handlers = {'delete': _delete, 'import': _import, 'rewind': _rewind, 'reset': reset_in_transaction}
```

`validate_action`（:8-55）是所有操作载荷的白名单校验（每个键、每个类型都点名）。处理器统一返回 `(affected_session_ids, result_dict)`。

### 7. 乐观准备快照的事务内重校验

```python
# hermes_state_mutation_prepared.py:23-29
def validate_prepared(db, conn, session_id, prepared):
    if not isinstance(prepared, dict) or 'snapshot' not in prepared:
        raise RuntimeStoreError('runtime_coordination_required')
    current = local_snapshot(db, conn, session_id)
    if current != prepared['snapshot']:
        raise RuntimeStoreError('revision_conflict')
    return current
```

`local_snapshot`（:12-20）读取 `POLICY_PREFIX` 回执、`validate_local_lineage` 解析物理目标、`require_target_advanceable` 守卫，并抓下 `runtime_revision`。事务内快照不等 ⇒ `revision_conflict`。`POLICY_HANDLERS`（:113-115）把 model/reasoning/workspace/editor_mcp/edit_policy 五个处理器挂在同一快照协议上。

### 8. 守卫在写连接上跑

```python
# hermes_state_mutation_guards.py:52-61
def require_idle(db, conn, session_ids):
    for sid in session_ids:
        admissions = conn.execute("SELECT status FROM session_admissions WHERE target_session_id=? AND status IN ('queued','started','unknown')", (sid,)).fetchall()
        workers = conn.execute("SELECT status FROM worker_executions WHERE session_id=? AND status IN ('registered','running','unknown')", (sid,)).fetchall()
        states = {row[0] for row in [*admissions, *workers]}
        if 'unknown' in states:
            raise RuntimeStoreError('unknown_execution')
        if states:
            raise RuntimeStoreError('session_busy')
        _require_transcript_unleased(db, conn, sid)
```

守卫直接在回执事务的写连接上查询，杜绝"检查-提交窗口"竞态。`require_not_executing`（:19）是宽松版（允许 queued 跟随者）；`delete_targets`（:81）计算删除闭包：本地谱系 + 压缩链双向走查 + delegate 子树，固定点收敛，`_CHAIN_CAP` 兜底。

### 9. 压缩的原子提交

```python
# hermes_state_mutation_compress.py:6-27（节选）
def compress_in_transaction(db, conn, session_id, payload, prepared):
    snapshot = validate_prepared(db, conn, session_id, prepared)
    ...
    if prepared['in_place']:
        child = target
        archive_on_connection(db, conn, target, prepared['messages'])
        affected = {session_id, target}
    else:
        child = uuid.uuid4().hex
        publish_on_connection(db, conn, parent_session_id=target, child_session_id=child,
            source=policy['source'], model=policy['model'], messages=prepared['messages'],
            model_config={'_compressed_from': target}, cwd=policy['cwd'], require_compression_lease=False)
        affected = set()  # Rotation publication already advances the logical revision.
    conn.execute('UPDATE sessions SET runtime_generation=runtime_generation+1 WHERE id=?', (session_id,))
```

摘要、物理目标（原位或轮转子行）、代数递增、回执，一个事务全部落地；`validate_prepared` 已确认无 worker/turn/compactor 活跃，因此无需再走 legacy 事务。

### 10. branch / chat_pick / reset / transcript

- `branch_in_transaction`（hermes_state_mutation_branch.py:52）：铸 `local_identity` 子 id、复制父冻结策略（编辑器 MCP 例外，必须子自带 :34-49）、`_branch_boundary` 定复制边界（assistant 行自动带上紧跟的 tool 结果 :12-31）、克隆转录行、写子回执+路由条目。
- `prepare_chat_pick` / `commit_chat_pick`（hermes_state_mutation_chat_pick.py:41 / :52）：消息端聊天没有冻结策略，拾取（/model、/reasoning）以 `gateway.mutation.v1.*` 回执 + revision/generation 围栏落地，精确重放先于覆盖检查。
- `reset_in_transaction`（hermes_state_mutation_reset.py:12）：发布 `model_config={'_reset_from': target}` 子行、旧目标 `end_reason='session_reset'`、`advance_local_target` 推进物理目标并抬 revision。
- `rewind_in_transaction`（hermes_state_mutation_transcript.py:5）：转录写守卫 → 可选 CAS（`expected_active_ids`）→ 把 `>= target` 的活跃行置 `active=0` → 可选保留 compaction handoff 的替换行 → 回填计数。它同时服务存储层 `/undo /retry` 与 mutation 回执两条路。

### 11. local 三族：创建回执 / 谱系交接 / legacy 绑定

```python
# hermes_state_local.py:14-31（节选）
def commit_local_session(db, *, epoch, receipt):
    """Reserve the row, route and immutable policy together, before publication. ..."""
    ...
    def write(conn):
        _epoch(conn, epoch)
        old = conn.execute('SELECT value FROM state_meta WHERE key=?', (key,)).fetchone()
        if old is not None:
            ...  # 精确重放：同一 (profile, principal, request) + 同一冻结请求
            return saved
        from hermes_state_mutation_retirement import RETIRED_PREFIX
        if conn.execute('SELECT 1 FROM state_meta WHERE key=?', (RETIRED_PREFIX + sid,)).fetchone():
            # Deleted: its receipt was retired with the transcript; a create/cron retry must not
            # resurrect the row (and re-fire its prompt) under the same deterministic id.
            raise RuntimeStoreError('not_found')
```

- `hermes_state_local.py`：私有本地创建回执（`POLICY_PREFIX = 'gateway.local_policy.v1:'`，:9）；`local_identity` 决定性 id 保证重试天然幂等；`on_create` 快照只在获胜事务里 publish、失败即 withdraw（:78-86）。
- `hermes_state_local_lineage.py`：`validate_local_lineage`（:14-40）逐跳验证谱系（reset 边看 `_reset_from`、压缩边看 `_CHAIN_STEP_SQL`）；`advance_local_target`（:70）在**发布事务内**完成物理目标交接（回执+路由条目+revision 一起写）；`adopt_untracked_compression`（:145）收编超过一次 `_CHAIN_CAP` 的未跟踪压缩步。
- `hermes_state_local_migration.py`：`bind_legacy_target`（:103）把老 CLI/TUI/GUI/手机 app 的无路由行**事务性**绑定为本地会话（验证 legacy 行形状、无链、空闲、无 turn 租约，然后补路由列 + 写 `LEGACY_PREFIX` 绑定记录）；`client_label`/`legacy_history_row`（:41/:57）决定谁能被收编，第三方 WebUI 的行刻意排除（不合法化第二个写者）。

### 12. worker 三兄弟

- `hermes_state_runtime_workers.py`：`runtime_lineage`（:5-23）让 worker 排除跟随**逻辑会话+物理谱系**；`worker_states`（:26）一条 `json_each` 索引探测整条链；`compact_terminal_receipts`（:88）把终态执行的读回执缩成 `{'retired': True}` 墓碑（否则每次托管轮留一份全史拷贝，state.db 平方增长），并级联退休子执行（`descendant_range` :62 用前缀区间一次索引探测全部后代）。
- `hermes_state_worker_compression.py`：worker 回执连接上的闭合压缩操作——压缩锁 acquire/renew/release/holder（:26）、失败冷却记录/恢复/清除（:51/:64/:86，恢复带逐列验证 :79-82）、`CompressionSnapshot`（:103）只借生产读算法不给写能力、`worker_publish`（:311）发布轮转子、`worker_receipt_assignment`（:360）落分配回执。
- `hermes_state_worker_context.py`：构造上下文闭合读——`worker_context`（:16）、`worker_prompt`（:29）、`worker_sidecars`（:39，只许白名单键 `_usage_anchor` 等）、`worker_tool_names`（:47，4 MiB 上限）、`worker_tail_role`/`worker_row_role`（:74/:83）。模块头一句话定调："这不是任意 SessionDB RPC"。
- `hermes_state_worker_lifecycle.py`：`worker_create`（:17，worker 不能铸行或改路由/谱系/cwd，身份字段不一致即 `permission_denied`）、`worker_end`（:43）、标题三件套（:63/:77/:85，标题去重要求"已授标题或已回执的标题尝试"）等；`insert_session_row_in_transaction`（:209）是行插入原语。

### 13. retirement 与 terminal 墓碑

`hermes_state_mutation_retirement.py` 定义 durable 删除围栏：`RETIRED_PREFIX = 'gateway.retired_session.v1.'`（:9）。删除后该 id 永久拒绝重建（`create_conflict` :28）；派生 id（Bot Chat、hosted-room 成员等）被删后自动升到下一**代**（`first_generation` :38）；沿途路过的围栏被 `keep_passed_fences`（:57）转为永久。`retire_terminal_receipts`（:100）把 admission/worker 行缩成保留 digest 的墓碑——精确重放仍能解析，用户输入副本不再保留。

## 核心类/函数

| 名称 | 位置 | 职责 |
|---|---|---|
| `apply_wal_with_fallback` | hermes_state_wal.py:254 | journal-mode 决策树；绝不活降级 WAL |
| `apply_database_pragmas` | hermes_state_wal.py:644 | config 驱动的性能 PRAGMA（全连接类型） |
| `begin_runtime_epoch` | hermes_state_runtime.py:116 | 铸/递增 owner epoch |
| `admit_session_input` | hermes_state_runtime.py:130 | 入队 + 精确重放 + 队列上限 |
| `claim_session_input` | hermes_state_runtime.py:206 | 领取 FIFO 头 + transcript_mark |
| `settle_session_input` | hermes_state_runtime.py:245 | 三重围栏结算 + 同事务终端效果 |
| `apply_action` | hermes_state_mutations.py:89 | 闭合动作处理器分派 |
| `validate_prepared` | hermes_state_mutation_prepared.py:23 | 乐观快照事务内重校验 |
| `require_idle` / `require_target_advanceable` | hermes_state_mutation_guards.py:52 / :43 | 写连接上的空闲/推进守卫 |
| `compress_in_transaction` | hermes_state_mutation_compress.py:6 | 摘要+目标+代数+回执原子提交 |
| `branch_in_transaction` | hermes_state_mutation_branch.py:52 | 独立路由+转录+冻结策略一提交 |
| `rewind_in_transaction` | hermes_state_mutation_transcript.py:5 | 事务内回退原语 |
| `commit_local_session` | hermes_state_local.py:14 | 本地创建回执（幂等 id + 围栏） |
| `advance_local_target` | hermes_state_local_lineage.py:70 | 发布事务内物理目标交接 |
| `bind_legacy_target` | hermes_state_local_migration.py:103 | 事务性 legacy 绑定 |
| `compact_terminal_receipts` | hermes_state_runtime_workers.py:88 | 终态回执缩墓碑 + 子执行级联退休 |

## 本组文件清单（19 个）

| 文件 | 行数 | 角色 |
|---|---|---|
| `hermes_state_wal.py` | 669 | journal-mode/PRAGMA 策略；NFS/SMB/ZFS/virtiofs 回退 DELETE |
| `hermes_state_runtime.py` | 1005 | runtime 回执事务：epoch、admit/claim/settle/cancel/recover、回执键 |
| `hermes_state_mutations.py` | 236 | 闭合动作载荷校验 `validate_action` 与分派 `apply_action` |
| `hermes_state_mutation_binding.py` | 132 | 未绑定 legacy 历史的 control-only 所有权（BINDING_PREFIX） |
| `hermes_state_mutation_branch.py` | 104 | /branch：独立本地路由+转录+冻结策略一提交 |
| `hermes_state_mutation_chat_pick.py` | 67 | 消息端拾取的 exact-retry 回执（围栏 revision/generation） |
| `hermes_state_mutation_compress.py` | 27 | 压缩闭合提交（原位归档或轮转发布） |
| `hermes_state_mutation_guards.py` | 128 | 写连接上的守卫 + `delete_targets` 删除闭包 |
| `hermes_state_mutation_prepared.py` | 166 | 乐观快照重校验 + model/reasoning/workspace/editor_mcp/edit_policy |
| `hermes_state_mutation_reset.py` | 43 | /reset 的发布与目标推进 |
| `hermes_state_mutation_retirement.py` | 433 | durable 删除围栏（RETIRED_PREFIX）与派生 id 世代 |
| `hermes_state_mutation_transcript.py` | 38 | 事务内 rewind 原语（CAS + handoff 保留） |
| `hermes_state_runtime_workers.py` | 112 | worker 排除跟随谱系；子执行退休与回执压缩 |
| `hermes_state_worker_compression.py` | 479 | worker 回执连接上的闭合压缩 op（锁/冷却/水位/发布） |
| `hermes_state_worker_context.py` | 89 | worker 构造上下文闭合读（session/prompt/sidecars/tools） |
| `hermes_state_worker_lifecycle.py` | 289 | worker 生命周期闭合处理器 + 行插入原语 |
| `hermes_state_local.py` | 419 | 私有本地创建回执（POLICY_PREFIX；幂等确定性 id） |
| `hermes_state_local_lineage.py` | 199 | 发布事务内物理目标交接（validate/advance/adopt/reset） |
| `hermes_state_local_migration.py` | 149 | 事务性 legacy 绑定与 legacy 行分类谓词 |

（`hermes_state_terminal.py` 属收尾组，但其 `retry_terminal_admission` 是 admit 的退休侧对偶，见 `misc_state.md`。）

## 与其他模块的关系

- **gateway**：`session.mutate`、`session.input` 等 RPC 全部落在 `hermes_state_runtime` + mutation 处理器上；`_authorize_write` 守卫由 gateway 的授权层注入。
- **agent**：`agent.conversation_compression_archive.ABSORBED_ROW_IDS`、`agent.message_metadata` 的 uid 键被 runtime 直接引用；压缩发布经 `worker_compression.publish_on_connection`。
- **锁层**：`hermes_state_compression._claim_lease_row` 是 worker 压缩锁与 `hermes_state_compression` 压缩锁共用的租约原语；守卫里的 `SessionTurnLeaseLostError`/`SessionCompressionInProgressError` 来自 `hermes_state_errors`。
- **owner_identity**：`gateway.owner_identity.same_owner` 决定绑定/收编语义，存储层只存 `[profile_id, subject]`。

## 总结

WAL 是"性能决策"，回执事务是"正确性协议"。前者只在文件系统允许时开 WAL、绝不停用已开的 WAL；后者把每个用户可见的状态变更变成"校验+写+回执"的单一事务，靠 digest 和围栏把重放、冲突、世代漂移全部变成可判定的错误码。这两层合起来，就是一个能被多进程安全共写的状态机。
