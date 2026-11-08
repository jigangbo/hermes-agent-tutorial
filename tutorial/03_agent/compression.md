# 上下文压缩引擎（agent/ 压缩子系统）

## 文件概览

Hermes 的上下文压缩是一个横跨约 40 个文件的子系统，但职责划分非常清晰：

- **引擎本体** `context_compressor.py`（5,725 行）：`ContextCompressor` —— 默认的
  `ContextEngine` 实现。五步算法：无 LLM 剪枝旧工具结果 → 选边界 → 保护头尾 →
  用辅助压缩模型迭代摘要中段 → 组装回写。文件本体只是一个 mixin 装配点，每个阶段
  拆在 `context_compressor_*.py` 兄弟模块里。
- **编排层** `conversation_compression.py`（4,410 行）：可行性探针、警告回放、
  commit-fence 发布（超过 host timeout 的工作被丢弃，绝不租约外提交）、在池化
  daemon 线程上对私有深快照运行。宿主侧包装在 `compression_facade.py::
  CompressionFacadeMixin._compress_context`；手动入口 `conversation_compression_manual.py::
  compress_now`（CLI / 网关 / TUI / ACP 所有表面的 `/compress` 共用）。
- **触发层** `turn_context_compaction.py` / `turn_preflight.py` / `turn_overflow.py`：
  把压缩挂进 turn 循环的五个时机。
- **特殊路径** `native_compaction.py`、`conversation_compression_codex.py`（provider
  原生 Responses/Codex 压缩）、`micro_compaction.py`（滚动逐轮摘要，默认关闭）、
  `prepared_compaction.py`（后台预备摘要）。

## 关键代码走读

### 1. 引擎 = 七个 mixin 的装配

`ContextCompressor` 本体不含算法细节，只做装配和会话状态管理。MRO 顺序即阶段顺序：

```python
# agent/context_compressor.py:2138
class ContextCompressor(
    SummaryDispatchMixin, PreLlmSkipMixin, CompressionTelemetryMixin, MicroCompactionMixin,
    ProactivePruneMixin, CompactionWindowMixin, ContextEngine,
):
    """Default context engine: prune tool results, protect head/tail, summarize the middle
    with an LLM, and iteratively update the previous summary on later compactions."""

    @property
    def name(self) -> str:
        return "compressor"
```

mixin 到文件的映射：

```
ContextCompressor (context_compressor.py, 装配 + compress 主流程)
├── SummaryDispatchMixin        ← context_compressor_summary.py   摘要 LLM 调度/重试/回退
├── PreLlmSkipMixin             ← context_compressor_prellm.py    摘要前的可行性跳过
├── CompressionTelemetryMixin   ← context_compressor_telemetry.py 遥测/结构化 no-op
├── MicroCompactionMixin        ← micro_compaction.py             滚动逐轮摘要（默认关）
├── ProactivePruneMixin         ← context_compressor_prune.py     无 LLM 剪枝旧工具结果
├── CompactionWindowMixin       ← context_compressor_window.py    边界选择 + 头尾保护
└── ContextEngine               ← context_engine.py               引擎基类/接口
```

`ContextEngine` 基类（`context_engine.py`）定义 `threshold_percent: float = 0.75`
这样的接口默认值，真正的默认来自配置 `compression.threshold`（见下文）。

### 2. 五步算法：`compress()`

主流程只有一个入口。注意它是「先剪枝、再选窗、后摘要」的流水线，任何一步失败都
返回**未裁剪**的 `canonical_messages` —— 历史永不因压缩失败而丢失：

```python
# agent/context_compressor.py:5422（节选）
def compress(
    self, messages: list[dict[str, Any]], current_tokens: Optional[int] = None, focus_topic: Optional[str] = None,
    force: bool = False, memory_context: str = "", bypass_cooldown: bool = False,
) -> list[dict[str, Any]]:
    """Summarize the middle turns: prune tool-result bodies (tool-call args untouched), protect head and a
    token-budget tail from the pruned copy, summarize, then clean orphaned tool pairs."""
    from agent.conversation_compression import _raise_if_stale_attempt

    _raise_if_stale_attempt(self)                       # 过期尝试连状态都不许重置
    telemetry = self._begin_compress_attempt(current_tokens, force)
    n_messages = len(messages)
    _min_for_compress = self._protect_head_size(messages) + 3 + 1
    if n_messages <= _min_for_compress:                 # 消息太少 → 结构性 no-op
        self._structural_no_op_result(telemetry, "insufficient_messages", ...)
        return messages
    ...
    canonical_messages = self._drop_blank_echoes(messages)      # 无损副本：no-op/中止时返回它
    # 阶段 1-2：剪枝（无 LLM）+ 选边界
    messages, pruned_count, compress_start, compress_end = self._plan_compaction_window(messages)
    ...
    # 阶段 3：结构化摘要（可行才调 LLM）
    feasibility_skip = not (force or prepared) and (...)
    summary = self._summarize_window(messages, turns_to_summarize, scan, focus_topic, memory_context, bypass_cooldown)
    if not summary:
        summary = self._fallback_summary_for_window(...)        # 确定性回退摘要
    # 阶段 4：组装；之后 _finalize_compressed 清理孤儿工具对
    compressed = self._assemble_compressed(messages, compress_start, compress_end, scan, summary)
    return self._finalize_compressed(compressed, canonical_messages, n_messages, spare_pending_images, pruned_count)
```

三处「失败即无损」的设计值得注意：`canonical_messages` 是未剪枝副本；
`_structural_no_op_result` 把「没有可压缩窗口」「消息太少」这类**结构性跳过**记入
遥测而非报错；摘要失败时走 `_fallback_summary_for_window` 生成确定性骨架摘要，
而不是把对话砍掉。

### 3. 阈值：50% 解析窗口 + 小窗口只升不降地板

默认阈值是配置 `compression.threshold: 0.50`（相对解析后的上下文窗口；
`hermes_cli/config_defaults.py:575`）。每个模型可用 `model_thresholds` 子串覆盖，
最长匹配（provider 作用域优先）获胜：

```python
# agent/context_compressor.py:2039
def resolve_model_threshold(
    model: str, model_thresholds: dict[str, float] | None, default: float, provider: str = "",
) -> float:
    """Per-model threshold: longest matching ``model_thresholds`` key wins, else ``default``."""
    if not model_thresholds or not model:
        return default
    provider = (provider or "").strip().lower()
    ranked = ((_model_threshold_key_rank(key, model, provider), key) for key in model_thresholds)
    best = max(((rank, key) for rank, key in ranked if rank is not None), default=None)
    return float(model_thresholds[best[1]]) if best else default
```

小窗口模型（< 512K）有一个**只升不降**的地板 —— 50% 对小窗口意味着几乎从不触发
（provider 会先拒绝请求），所以地板抬到 75%：

```python
# agent/context_compressor.py:2752
@staticmethod
def _effective_threshold_percent(context_length: int, threshold_percent: float) -> float:
    """Raise-only small-context threshold floor: models under 512K trigger at >= 75%."""
    if context_length and context_length < _SMALL_CTX_WINDOW_LIMIT:      # 512_000 (行 1151)
        return max(threshold_percent, _SMALL_CTX_THRESHOLD_PERCENT)      # 0.75   (行 1152)
    return threshold_percent
```

### 4. 触发点全图（5 处 + 1 处网关兜底）

```
turn 循环内的 5 个压缩时机                          宿主/网关侧
────────────────────────────────────────────      ──────────────────────────────
① turn 开始    run_turn_start_compaction          ⑥ 宿主侧包装
   (turn_context_compaction.py:129)                CompressionFacadeMixin
   空闲触发 → 预检 token 阈值 →                       ._compress_context
   未压缩会话溢出警告重整备                           (compression_facade.py)
        │
② 预 API 门    turn_preflight.py +                ⑦ 手动入口（所有表面）
   turn_preflight_gate.py                          /compress → compress_now
   请求发出前量压，超阈值则压缩；                      (conversation_compression_
   工具轮后的压缩也在这里                               manual.py:69)
        │
③ 响应式恢复   turn_overflow.py::recover_from_overflow
   provider 溢出/413 分类命中后压缩重试
        │
④ 手动 /compress（同⑦）
⑤ 网关会话卫生兜底  gateway/run_turn_hygiene.py —— 85% 阈值
```

预 API 门的尝试预算来自 `max_compression_attempts`（默认 3）：

```python
# agent/turn_context_compaction.py:382
_max_preflight_passes = max(1, int(getattr(agent, "max_compression_attempts", 3) or 3))
```

网关卫生兜底刻意**高于** agent 压缩阈值（85% vs 50%），注释写明它是安全网：

```python
# gateway/run_turn_hygiene.py:97（节选）
# The 0.85 threshold is deliberately HIGHER than the agent's compressor (0.50): a safety net
```

### 5. 编排契约：快照 + commit fence

`conversation_compression.py` 的模块 docstring 就是整个并发模型的契约：

```python
# agent/conversation_compression.py:1
"""Context compression: feasibility probe, warning replay, compress, image fix.

Thread-safety contract for extension points: with ``compression.context_timeout_seconds > 0`` (default) the
whole pass, context engines and memory providers included, runs on a pooled daemon thread. Calls may arrive
on any pooled thread (never rely on thread-affinity/locals); the message list is a private deep snapshot
(in-place mutation is invisible to the live conversation unless the pass commits); state is published ONLY
on an admitted :class:`CompressionCommitFence` commit (work still running after a host timeout is discarded);
one pass per session at a time (durable lock) but sessions run concurrently, so shared engines must be thread-safe.
"""
```

commit fence 让「超时的 worker 线程无法被杀死」这一事实变得确定性可控：

```python
# agent/conversation_compression.py:458
class CompressionCommitFence:
    """Fence timeout cancellation against post-summary session mutation.
    The sync worker thread cannot be killed; the fence makes the commit boundary deterministic: cancellation
    wins before mutation starts, or waits for an already-started commit to finish completely."""
```

也就是说：host 放弃等待后，工作线程若还没开始提交 → 取消生效，结果**丢弃**；
若提交已开始 → host 等它完整落盘。绝不存在「半个压缩结果写进会话」的中间态。
这是把「压缩是对历史的唯一合法变更」这条不变量在并发下兜住的关键。

### 6. 为什么 micro_compaction 默认关闭

滚动逐轮摘要每走一轮都会改写 prompt 前缀 —— 这直接违反「每会话 prompt 缓存神圣」
不变量，所以默认关、只在用户显式开启时工作：

```python
# agent/micro_compaction.py:1
"""Micro-compaction mixin for ContextCompressor.

Rolling per-exchange summarization that folds old user/assistant exchanges into a single
summary marker between turns. OFF by default: every pass rewrites the prompt prefix and
breaks the provider prompt cache.
"""
```

对比之下，主压缩路径（批量摘要）一次性替换历史，前缀只破坏一次，且立即用
`register_stable_prefix` / 重建系统提示把缓存重新热起来。

### 7. 手动入口是唯一被认可的历史变更

四个表面（CLI/网关/TUI/ACP）共用同一个核心，避免各写一份 flag 解析和措辞：

```python
# agent/conversation_compression_manual.py:1（节选）
"""Manual ``/compress`` core shared by the CLI, gateway, TUI and ACP surfaces.

Manual compression is the ONE sanctioned history mutation (prompt-cache invariant): each surface parses
its own flags and renders its own text, but the sequence — split for ``here [N]``, estimate, run
``agent._compress_context(force=True)``, detect a lock-skip, rejoin the verbatim tail, summarize — lives
here so ``--preview`` / ``--aggressive`` and the lock-skip wording cannot drift per surface again.
"""
```

`force=True` 会清掉摘要失败冷却并绕过可行性跳过 —— 用户显式请求总是走完整路径；
自动压缩调用方永远传 `False`。

## 核心类/函数

| 名称 | 文件:行号 | 职责 |
|---|---|---|
| `ContextCompressor` | context_compressor.py:2138 | 默认引擎，mixin 装配 + `compress()` 主流程 |
| `compress()` | context_compressor.py:5422 | 五步算法入口；失败路径全部返回无损副本 |
| `resolve_model_threshold()` | context_compressor.py:2039 | 按模型子串覆盖阈值，最长匹配获胜（模块级，插件引擎可复用） |
| `_effective_threshold_percent()` | context_compressor.py:2752 | 小窗口（<512K）只升不降地板 75% |
| `_compute_threshold_tokens()` | context_compressor.py:2766 | 阈值 token 数 = 有效输入预算 × 百分比，含 85% 触发帽 |
| `MicroCompactionMixin` | micro_compaction.py:39 | 滚动逐轮摘要；默认关闭（破坏缓存前缀） |
| `CompressionCommitFence` | conversation_compression.py:458 | 提交围栏：取消要么在提交前生效，要么等提交完整结束 |
| `CompressionFacadeMixin._compress_context` | compression_facade.py | 宿主侧包装：发布 fence、快照运行、回填标记、重绑会话 |
| `run_turn_start_compaction()` | turn_context_compaction.py:129 | turn 开始三趟：空闲触发 → 预检阈值 → 溢出警告重整备 |
| `CompactionOutcome` | turn_context_compaction.py:26 | turn 开始压缩的结果（compressed/blocked 标志） |
| `PreflightGateVerdict` | turn_preflight.py:39 | 预 API 门裁决：fallthrough/continue/break/return |
| `recover_from_overflow()` | turn_overflow.py | 413/上下文溢出的响应式恢复，返回 `OverflowVerdict` |
| `compress_now()` | conversation_compression_manual.py:69 | 所有表面 `/compress` 的共享核心 |
| `salvage_grown_transcript()` | conversation_compression.py:567 | 膨胀转录的抢救降级路径 |

## 本组文件清单

| 文件 | 一句话 |
|---|---|
| context_compressor.py | 引擎装配 + `compress()` 主流程 + 阈值解析（5,725 行） |
| context_engine.py | `ContextEngine` 基类/接口，压缩状态消息 |
| context_breakdown.py | 头/中/尾区域拆分展示（`/context` 等用途） |
| context_file_sources.py | 追踪上下文中文件内容的来源 |
| context_pin.py | 引擎/上下文标签（pin）机制 |
| context_references.py | 跨消息引用处理 |
| context_default_record.py | 默认压缩记录结构 |
| context_compressor_prellm.py | `PreLlmSkipMixin`：摘要前可行性跳过 |
| context_compressor_prune.py | `ProactivePruneMixin`：无 LLM 剪枝旧工具结果 |
| context_compressor_summary.py | `SummaryDispatchMixin`：摘要 LLM 调度与回退 |
| context_compressor_retry.py | 摘要失败重试/冷却辅助 |
| context_compressor_tail.py | 尾部预算与 stale 工具降级 |
| context_compressor_telemetry.py | `CompressionTelemetryMixin`：遥测与结构化 no-op |
| context_compressor_window.py | `CompactionWindowMixin`：边界选择 + 头尾保护 |
| context_compressor_prompt_rules.py | 摘要 prompt 的分节指令规则 |
| conversation_compression.py | 编排层：可行性探针、commit fence、池化线程快照运行 |
| conversation_compression_archive.py | 压缩后的归档/水位 |
| conversation_compression_checkpoint.py | 压缩前 checkpoint（内存 provider 协作） |
| conversation_compression_codex.py | Codex app-server 原生压缩路径 |
| conversation_compression_deadline.py | 压缩超时解析（host/摘要两级预算） |
| conversation_compression_feasibility.py | 可行性探针（值得不值得调摘要 LLM） |
| conversation_compression_manual.py | `compress_now()`：/compress 共享核心 |
| conversation_compression_reply_anchor.py | 最新用户轮锚定（verbatim 快照插入） |
| conversation_compression_scaffolding.py | 合成 user 轮/脚手架消息识别 |
| conversation_compression_telemetry.py | 压缩尝试遥测发射（blocked/aborted/bypassed） |
| conversation_compression_watermark.py | 持久化水印（归档边界） |
| compression_facade.py | 宿主侧 `_compress_context` 包装（fence 发布/快照/回填） |
| compression_automation.py | 自动压缩策略开关 |
| compression_marker.py | 压缩摘要标记消息的构造/识别 |
| compaction_display.py | 压缩过程的用户可见展示 |
| compaction_events.py | micro/batch 压缩事件发布 |
| micro_compaction.py | 滚动逐轮摘要（默认关闭：重写前缀破坏缓存） |
| native_compaction.py | provider 原生 Responses 压缩路径 |
| prepared_compaction.py | 后台预备摘要（预先生成、用时采纳） |
| relay_compaction.py | relay 侧压缩适配 |
| agent_init_compression_notice.py | 启动时压缩配置提示 |
| turn_context_compaction.py | turn 开始压缩三趟 + 各触发点共享辅助 |
| turn_preflight.py | 预 API 压缩门 + 工具轮后压缩 |
| turn_preflight_gate.py | 预 API 压力门：runtime 地板/溢出复检/进度不足阻断 → 调 `run_preflight_compression` |
| turn_overflow.py | provider 溢出/413 响应式恢复 |
| （根）trajectory_compressor.py | 离线转录压缩工具，**不在** turn 循环内 |

## 与其他模块的关系

- **agent/turn_pipeline / conversation_loop**：五处触发点全部挂在 turn 循环上，
  细节见 `02_core/turn_pipeline.md`；错误恢复分支（`turn_recovery.py`）在
  `FailoverReason.context_overflow` 命中后把控制权交给 `turn_overflow.py`。
- **agent/prompt_caching**：压缩改写历史 = 缓存前缀失效，所以压缩谱系根
  （`prompt_cache_scope.py::conversation_id`）与 `prompt_refresh.py` 的 epoch 机制
  都围绕压缩设计；见本组 `prompt_caching.md`。
- **gateway/run_turn_hygiene.py**：85% 会话卫生兜底，复用同一压缩编排但独立于
  agent 阈值（安全网定位）。
- **hermes_state（SessionDB）**：压缩谱系、归档水位、checkpoint 都落在状态库；
  `session_db.get_compression_lineage` 同时是缓存作用域的数据源。
- **配置**：`compression.threshold / threshold_tokens / target_ratio /
  context_timeout_seconds / model_thresholds / max_compression_attempts`，
  默认值在 `hermes_cli/config_defaults.py` 的 `compression` 段。

## 总结

压缩子系统的设计可以压缩成三句话：**算法上**先做无 LLM 的便宜事（剪枝、选窗、
保护头尾），最后才花钱调辅助模型摘要中段，且摘要失败时历史保持无损；
**并发上**一切在私有深快照上运行，只有通过 commit fence 的提交才对活会话可见，
超时的工作被整体丢弃；**生态上**默认阈值 50%（小窗口抬到 75%），网关 85% 兜底，
每 turn 最多尝试 `max_compression_attempts`（3）次，micro-compaction 因破坏缓存
前缀而默认关闭。阅读顺序建议：先 `compress()` 主流程，再按 mixin 进入各阶段，
最后读 `conversation_compression.py` 顶部的并发契约 —— 它是理解其余 30 个文件的钥匙。
