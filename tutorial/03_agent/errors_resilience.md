# 错误分类与韧性（agent/ 错误子系统）

## 文件概览

Hermes 的错误处理是一条「分类 → 路由 → 韧性原语」的流水线：

- **分类器** `error_classifier.py`（1,637 行）：把任意 API 异常压成带恢复提示的
  `ClassifiedError`（`FailoverReason` 枚举 + 4 个布尔提示）。这是错误域的单一
  真相源。
- **恢复路由** `turn_recovery.py`（1,999 行）+ `turn_recovery_autorecover.py`
  （耗尽后的等待-重试阶梯）+ `turn_recovery_codex.py`（陈旧 reasoning 阶）——
  在 `02_core/turn_pipeline.md` 已从循环视角讲过，本篇从分类器视角收束。
- **失败面** `error_surface.py`：把内部分类映射成 UI 稳定描述符
  `{"layer", "code", "retryable"}`。
- **中断族** `interrupt_compat.py` / `interrupt_control.py` / `interrupt_scope.py` /
  `estop.py`：用户取消、范围取消、全局急停。
- **边界原语** `deadline.py` / `iteration_budget.py` / `turn_liveness.py` /
  `retry_utils.py` / `fallback_cooldown.py`：超时、预算、看门狗、退避、冷却。

## 关键代码走读

### 1. 错误分类学：`FailoverReason` + `ClassifiedError`

分类的结果不是字符串而是结构化恢复建议。`FailoverReason` 有 30+ 个值，每个值
注释里直接写恢复策略：

```python
# agent/error_classifier.py:34（节选）
class FailoverReason(enum.Enum):
    """Why an API call failed — determines recovery strategy."""
    auth = "auth"                        # Transient auth (401/403) — refresh/rotate
    auth_permanent = "auth_permanent"    # Auth failed after refresh — abort
    billing = "billing"                  # 402 or confirmed credit exhaustion — rotate immediately
    rate_limit = "rate_limit"            # 429 or quota-based throttling — backoff then rotate
    upstream_rate_limit = "upstream_rate_limit"  # Aggregator's upstream model 429 — fallback model, key is healthy
    overloaded = "overloaded"            # 503/529 — provider overloaded, backoff
    timeout = "timeout"                  # Connection/read timeout — rebuild client + retry
    context_overflow = "context_overflow"  # Context too large — compress, not failover
    payload_too_large = "payload_too_large"  # 413 — compress payload
    model_not_found = "model_not_found"  # 404 or invalid model — fallback to different model
    content_policy_blocked = "content_policy_blocked"  # Provider safety filter rejected this prompt — deterministic per-request, don't retry unchanged
    reasoning_mandatory = "reasoning_mandatory"  # Route rejects reasoning: {enabled: false} — send the disable no more this session and retry
    unknown = "unknown"                  # Unclassifiable — retry with backoff
```

`ClassifiedError` 携带四个恢复提示，重试循环读提示而不是重新分类：

```python
# agent/error_classifier.py:70（节选）
@dataclass
class ClassifiedError:
    """Structured classification of an API error with recovery hints."""

    reason: FailoverReason
    status_code: Optional[int] = None
    provider: Optional[str] = None
    model: Optional[str] = None
    message: str = ""
    error_context: dict[str, Any] = field(default_factory=dict)

    # Recovery hints — the retry loop checks these instead of re-classifying.
    retryable: bool = True
    should_compress: bool = False
    should_rotate_credential: bool = False
    should_fallback: bool = False

    @property
    def billing_unverified(self) -> bool:
        """True when a ``billing`` verdict rests on an ambiguous body (#82154)."""
        return bool(self.error_context.get("billing_unverified"))
```

`billing_unverified` 是个好例子：Anthropic 对内容过滤拒绝也会返回「out of extra
usage」的 body（#82154），所以裁决保持 `billing` 但打上「未证实」标记，让面层
措辞谨慎、密钥池用短冷却。

### 2. 分类流水线：阶段表 + 首个裁决获胜

`classify_api_error` 按 `_STAGES` 顺序跑插件裁决 → provider 特例 → 错误码 →
消息模式 → 传输层 → HTTP 状态，首个非 None 胜出，否则 `unknown`：

```python
# agent/error_classifier.py:1068（节选）
def classify_api_error(
    error: Exception, *, provider: str = "", model: str = "",
    approx_tokens: int = 0, context_length: int = 200000, num_messages: int = 0,
    base_url: str = "",
    api_key: Any = None,
) -> ClassifiedError:
    """Classify an API error into a structured recovery recommendation (see ``_STAGES``)."""
    from hermes_cli.anon_auth import is_anonymous_request
    status_code = _extract_status_code(error)
    # Some SDK RateLimitErrors (OpenAI-compatible relays) may not set .status_code; force 429.
    if status_code is None and type(error).__name__ == "RateLimitError":
        status_code = 429
    body = _extract_error_body(error)
    c = _Ctx(error, status_code, body, _build_error_msg(error, body), provider, model,
             approx_tokens, context_length, num_messages, str(base_url or ""),
             anonymous=is_anonymous_request(provider, api_key))
    verdict = next((v for v in (stage(c) for stage in _STAGES) if v is not None), _V_UNKNOWN)
    ...
    base = {"status_code": status_code, "provider": provider, "model": model, "message": message}
    return ClassifiedError(**{**base, **verdict})
```

阶段顺序本身就是设计：**插件/profile 的针对性裁决先于通用模式**，结构化错误码
先于易碎的文本子串。`base_url` 让「请求发到了错误的 host」（陈旧的
`model.base_url`）能被识别为离线路由而非坏密钥（#113719）。

### 3. 恢复阶梯全景

分类之后控制权流经的阶梯（细节在 turn_pipeline.md，此处是分类器视角的地图）：

```
  API 调用抛异常
        │
        ▼
 classify_api_error ──► ClassifiedError(reason, hints)
        │
        ├─ context_overflow / payload_too_large ──► agent/turn_overflow.py
        │        压缩 + 重启调用（OverflowVerdict: return/break/continue/fallthrough）
        │
        ├─ retryable (timeout/overloaded/server_error/unknown)
        │        │
        │        ▼
        │   turn_recovery.py 恢复链 → retry_utils.jittered_backoff 重试
        │        │ 耗尽
        │        ▼
        │   turn_recovery_autorecover.py 等待-重试阶梯（分钟级退避）
        │
        ├─ should_rotate_credential (auth/billing/rate_limit)
        │        → fallback_cooldown 冷却主路由 → 密钥池轮换
        │
        ├─ should_fallback (upstream_rate_limit/model_not_found/...)
        │        → 走 fallback 链换模型/供应商
        │
        └─ 不可重试 (auth_permanent/content_policy_blocked/format_error)
                 → turn 以 failure_reason=FailoverReason 值结束
                        → error_surface.py 映射成 {"layer","code","retryable"}
                        → TUI/Desktop 展示
```

### 4. 退避与冷却

`retry_utils.py` 的核心是**去相关抖动退避** —— 多会话同时撞上同一个限流供应商
时，固定指数退避会形成重试尖峰：

```python
# agent/retry_utils.py:121
def jittered_backoff(attempt: int, *, base_delay: float = 5.0, max_delay: float = 120.0, jitter_ratio: float = 0.5) -> float:
```

配套的 `parse_retry_after_seconds`（行 30）解析 `Retry-After` 头与多种「quota
resets in/at」消息格式，`adaptive_rate_limit_backoff`（行 155）把两者结合。主
路由的限流冷却由 `fallback_cooldown.py` 统一武装，回退行走与
`restore_primary_runtime` 共享同一份状态：

```python
# agent/fallback_cooldown.py:1
"""Primary rate-limit cooldown arming and per-session model rejection markers, shared by the
fallback walk (chat_completion_helpers) and restore_primary_runtime (agent_runtime_helpers)."""
```

### 5. 中断族：三层取消

**compat → control → scope** 是从「怎么调」到「谁能取消谁」的三层：

- `interrupt_compat.py`（55 行）：探测可调用对象是否支持某关键字参数 —— 让硬
  中断请求兼容新旧生产者签名。
- `interrupt_control.py`：`InterruptControlMixin` 拥有软/硬中断请求、工具线程
  中断传播、pending steer/redirect 队列。
- `interrupt_scope.py` 解决一个真实痛点：host 在 worker 线程上跑阻塞命令时，
  看不见 CLI 子命令内部 fork 出的 `AIAgent`，没法调 `interrupt()`：

```python
# agent/interrupt_scope.py:1（模块 docstring，节选）
"""Host-owned cancellation for agents created deep inside synchronous work.

A host that runs a blocking command on a worker thread (Hermes Console) never sees
the ``AIAgent`` a CLI subcommand forks inside it, so it cannot call ``interrupt()``
when the user cancels. The host binds an :class:`InterruptScope` around the work;
every ``run_conversation()`` under that scope registers its agent, and
``scope.cancel()`` hard-interrupts them from any thread. Agents registering after
the cancel are interrupted immediately, so a cancel never loses the race with a
turn that has not started yet (#106179).
"""
```

「cancel 之后注册的 agent 立即被中断」堵住了取消与未开始 turn 的竞态。

### 6. 边界原语：deadline / iteration_budget / turn_liveness / estop

**deadline.py** 是统一的有限执行原语（#85125）：`resolve_timeout`（config >
legacy env > default）、`clamp_timeout`（超大超时在 macOS 上会溢出 `time_t`，
#83220）、`run_bounded_async/run_bounded_sync`（daemon Timer 驱动 —— 事件循环
卡死时超时依然触发）、`poll_until`（唯一合法的轮询循环写法）。

**iteration_budget.py** 是线程安全的迭代预算，父/子代理各自持有：

```python
# agent/iteration_budget.py:25（节选）
class IterationBudget:
    """Thread-safe iteration counter; ``execute_code`` (programmatic tool calling)
    iterations are refunded via :meth:`refund` so they don't eat into the budget."""

    def __init__(self, max_total: int):
        self.max_total = max_total
        self._used = 0
        self._lock = threading.Lock()

    def consume(self) -> bool:
        """Try to consume one iteration.  Returns True if allowed."""
        with self._lock:
            if self._used >= self.max_total:
                return False
            self._used += 1
            return True
```

父代默认 500（`max_iterations`），子代理默认 50（`delegation.max_iterations`），
所以父+子的总迭代可以超过父代上限 —— 这是刻意的设计而非漏洞。预检压缩没有真正
到达 provider 的调用会被 `refund()` 退回（见 turn_context_compaction.py:103）。

**turn_liveness.py** 处理「turn 卡死但租约还在续期」的最坏情况：无声停滞的 turn
会被看门狗强制中止。中止决定绑定观测到的 `(generation, timestamp)`，提交回调在
`_touch_activity` 加锁的同一把锁下复核 —— 恢复了的 turn 永不被误杀。

**estop.py** 是全局急停：`hermes pause` 写哨兵文件 `$HERMES_HOME/ESTOP`，cron
调度器、kanban 分发器、新网关 turn 看到它就跳过工作；**在飞的工作永不杀死**。
检查是一两次未缓存的 `os.stat`；损坏/空文件也算已启用（fail safe，
`touch ~/.hermes/ESTOP` 即可用）。

### 7. 错误面：给 UI 的稳定描述符

`error_surface.py` 把 `FailoverReason`（或原始异常）映射成小而稳定的线上描述符，
且**永不抛异常** —— 诊断机制不能弄坏它所描述的错误路径：

```python
# agent/error_surface.py:1（节选）
"""Structured error-surface descriptors for UI clients (Desktop/TUI).

Maps the internal failure taxonomy (``FailoverReason`` values carried in turn
results as ``failure_reason``, or raw exceptions from the turn dispatcher)
onto a small, stable wire descriptor ``{"layer", "code", "retryable"}``.
Layers: provider (model API rejected/failed), endpoint (user-configured
custom/local endpoint transport failure), streaming (SSE dropped mid-turn),
auth, billing (fallback signal; clients usually have a richer
``billing_block``), gateway (local runtime errored), disk (disk full).
Dependency-light and NEVER raises: surfacing diagnostics must not break the
error path it describes. Descriptors are advisory — clients fall back to
string sniffing when absent or partial.
"""
```

配套的 `timeout_error_summary.py` 把「Request timed out.」这种 SDK 裸文本升级成
带阶段（连接/读取/流中）和「该调哪个配置」的一句话；`api_error_summary.py`
负责 API 错误的脱敏摘要（密钥掩码、结构化细节收敛）。

## 核心类/函数

| 名称 | 文件:行号 | 职责 |
|---|---|---|
| `FailoverReason` | error_classifier.py:34 | 30+ 失败原因枚举，注释即恢复策略 |
| `ClassifiedError` | error_classifier.py:70 | 分类结果 + 4 恢复提示 + `billing_unverified` |
| `classify_api_error()` | error_classifier.py:1068 | 阶段表分类流水线，首个裁决获胜 |
| `recover_from_overflow()` | turn_overflow.py:44 | 溢出/413 恢复，产出 `OverflowVerdict` |
| `jittered_backoff()` | retry_utils.py:121 | 去相关抖动退避（防重试尖峰） |
| `parse_retry_after_seconds()` | retry_utils.py:30 | Retry-After 头 / quota 消息解析 |
| `arm_primary_rate_limit_cooldown` 等 | fallback_cooldown.py | 主路由限流冷却 + 模型拒绝标记 |
| `InterruptControlMixin` | interrupt_control.py:9 | 软/硬中断、工具线程传播、steer/redirect 队列 |
| `InterruptScope` | interrupt_scope.py | host 对深层同步工作中的 agent 的取消 |
| `engage()` / `is_engaged()` | estop.py | 全局急停哨兵（在飞工作不杀） |
| `resolve_timeout()` / `run_bounded_async()` | deadline.py | 统一超时解析 + daemon Timer 有限执行 |
| `IterationBudget` | iteration_budget.py:25 | 线程安全消费/退还预算（父 500 / 子 50） |
| `TurnLivenessWatchdog` | turn_liveness.py:90 | 无声停滞 turn 的看门狗强制中止 |
| `describe_error`（surface） | error_surface.py | `FailoverReason` → `{"layer","code","retryable"}` |
| `ApiRequestHooksMixin` | api_request_hooks.py | `api_request_error` 生命周期 hook 派发 |
| `ClientLifecycleMixin` | client_lifecycle.py:8 | 客户端生命周期：owner 线程 close vs 陌生线程 abort、凭据轮换 |

## 本组文件清单

| 文件 | 一句话 |
|---|---|
| error_classifier.py | 错误分类器：`FailoverReason`/`ClassifiedError`/阶段表流水线 |
| error_surface.py | UI 稳定错误描述符（永不抛异常） |
| errors.py | 两个领域异常：`EmptyStreamError`、`MoAPresetNotFoundError` |
| api_error_summary.py | API 错误摘要：权益检测、脱敏、结构化细节 |
| timeout_error_summary.py | 传输超时的分阶段一句话摘要 |
| api_request_hooks.py | `api_request_error` hook 载荷与派发 |
| turn_recovery.py | 分类后的恢复分支（1,999 行，见 turn_pipeline.md） |
| turn_recovery_autorecover.py | 重试耗尽后的等待-重试阶梯 |
| turn_recovery_codex.py | Codex 陈旧 reasoning 阶恢复 |
| turn_overflow.py | 溢出/413 → 压缩恢复（`OverflowVerdict`） |
| retry_utils.py | 抖动退避、Retry-After 解析、自适应限流退避 |
| fallback_cooldown.py | 主路由限流冷却 + 每会话模型拒绝标记 |
| interrupt_compat.py | 显式停止生产者的签名兼容探测 |
| interrupt_control.py | 软/硬中断 + steer/redirect 控制面（`InterruptControlMixin`） |
| interrupt_scope.py | host 拥有的范围取消（注册后即取消，#106179） |
| estop.py | 全局急停哨兵（`$HERMES_HOME/ESTOP`，在飞不杀） |
| deadline.py | 统一 deadline 层：解析/钳制/有限执行/进程树击杀 |
| iteration_budget.py | 线程安全迭代预算（消费/退还） |
| turn_liveness.py | turn 停滞看门狗（采样状态机 + watcher 线程） |
| async_utils.py | 异步辅助 |
| client_lifecycle.py | 工具资源回收 + wire 客户端生命周期 + 凭据轮换 |
| jiter_preload.py | jiter 预加载（加速 json 解析，可选） |
| ssl_verify.py | TLS 校验处理（确定性失败快速给出指引） |
| proxy_bypass.py | 代理绕过判定 |
| （关联）interrupt 相关 exit 处理 | 见 turn_pipeline.md 的 turn 退出路径 |

## 与其他模块的关系

- **agent/chat_completion_helpers**：`try_activate_fallback` 消费
  `should_fallback` 提示并与 `fallback_cooldown` 协作；陈旧连击熔断抛出的
  `RuntimeError` 也会回到 `classify_api_error` 走通用分类。
- **agent/turn_context_compaction / turn_preflight / turn_overflow**：
  `context_overflow`/`payload_too_large` 的消费者；`_refund_api_call` 退回
  `IterationBudget`。
- **agent/streaming**：流中段断（SSE 掉线）是 `error_surface` 的 `streaming`
  层；`errors.EmptyStreamError` 由流路径抛出。
- **gateway / cron / kanban**：`estop.is_engaged` 是新工作的统一闸门；
  `interrupt_scope` 服务 Hermes Console 这类 host。
- **TUI / desktop**：`error_surface.py` 描述符 + `billing_block` 富化是 UI
  显示错误的合同。

## 总结

错误子系统的架构是一台**编译器**：`classify_api_error` 把不可控的原始异常「词法
解析」成结构化 `ClassifiedError`，重试循环是它的「调度器」，只消费四个布尔提示
而不重复解析。三条韧性支柱各自补一个盲区：退避+冷却管**速率**（抖动防尖峰、
冷却防反复撞墙），deadline+预算+看门狗管**卡死**（事件循环阻塞也有 daemon Timer
兜底、无声停滞 turn 有强制中止），中断族管**人**（软/硬中断、范围取消、急停，
且急停永不杀在飞工作）。贯穿其中的是同一价值观：分类宁可打上「未证实」标记也
不硬下结论（`billing_unverified`）、诊断层永不抛异常（`error_surface`）、降级
路径宁可 fail-safe（ESTOP 空文件也算启用）。下一篇读 turn_recovery.py 时，
把每个分支对回 `FailoverReason` 的一个值，整张恢复网络就清晰了。
