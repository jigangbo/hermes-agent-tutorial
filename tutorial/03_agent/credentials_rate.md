# credentials_rate.md — 凭据池与限速记账

## 文件概览

一个长寿命 Hermes 进程（网关同时跑几十个会话）要回答四类问题：**这个 provider 现在用哪把
凭据**（池与轮转）、**凭据坏了怎么办**（冷却、隔离、刷新、恢复）、**我离限流还有多远**
（头部捕获、跨会话熔断、credits）、**这些 token 花了多少钱**（锚点记账、计价、用量/账单
视图）。27 个文件分担这些职责，没有一个是"顺手的散装代码"——凭据边界和钱都是审计对象。

| 组 | 文件 | 职责 |
|---|---|---|
| 池核心 | `credential_pool.py` + 4 兄弟 | 多凭据池：选择、轮转、冷却、刷新、管理端 |
| 多源凭据 | `credential_sources.py` / `credential_source.py` / `anthropic_credentials.py` / `command_token_source.py` / `credential_persistence.py` / `credential_auth_recovery.py` / `custom_entry_pool.py` | 来源读取、借用、key_cmd、磁盘边界 |
| 限速 | `rate_limit_tracker.py` / `rate_limit_credits.py` / `nous_rate_guard.py` / `credits_tracker.py` | 头部捕获、低额度通知、跨会话熔断 |
| 记账 | `usage_anchor.py` / `usage_pricing.py` / `usage_gauges.py` / `aux_accounting.py` | 锚点计数、美元计价、窗口余量、aux 归账 |
| 视图 | `account_usage.py` / `account_usage_cache.py` / `subscription_view.py` / `plan_limits.py` / `billing_usage.py` / `billing_view.py` / `billing_links.py` | /usage 与 /subscription 的数据与渲染 |

---

## 关键代码走读

### 1. `PooledCredential` —— 池行的全部状态（credential_pool.py:209）

```python
# agent/credential_pool.py:209-239（节选）
class PooledCredential:
    provider: str
    id: str
    label: str
    auth_type: str
    priority: int
    source: str
    access_token: str
    refresh_token: Optional[str] = None
    last_status: Optional[str] = None          # OK / EXHAUSTED / DEAD / ...
    last_status_at: Optional[float] = None
    last_error_code: Optional[int] = None
    last_error_reason: Optional[str] = None
    last_error_message: Optional[str] = None
    last_error_reset_at: Optional[float] = None
    # Epoch of the last deliberate ``hermes auth reset`` of this entry. Sticky: a later exhaustion
    # stamps a newer ``last_status_at``, so "reset postdates status" stays decidable across processes.
    status_cleared_at: Optional[float] = None
    base_url: Optional[str] = None
    expires_at: Optional[str] = None
    expires_at_ms: Optional[int] = None
    ...
    request_count: int = 0
    # A provider may rate-limit one model while the same credential remains
    # usable for its sibling models.  Keep that observation separate from the
    # credential-wide status used for auth and billing failures.
    model_cooldowns: Optional[dict[str, float]] = None
    extra: dict[str, Any] = None  # type: ignore[assignment]
```

三处设计值得记住：

- **status_cleared_at 是粘性的**（:224-226）：后续的 exhaustion 会盖新的时间戳，
  所以"reset 晚于 status"这条判定**跨进程永远可决**。
- **模型冷却与凭据级状态分离**（:235-238）：provider 可以只限流一个模型，同一凭据的
  兄弟模型照常可用——这个观察放在 `model_cooldowns`，不污染 auth/billing 失败用的
  `last_status`。
- **`extra` 是插件的载荷**（`from_dict`，:252-272）：非字段键全部进 `extra` 往返，
  插件存在自己行上的元数据在 load→save→load 之后幸存；`provider` 永远是行的所有者，
  不许被扫进元数据。

`runtime_api_key` / `runtime_base_url`（:287-316）是**运行时读取面**：Nous 的推理凭据
是 `agent_key`（必须是可用的 NAS invoke JWT）；openai-codex 的行保存规范 ChatGPT URL，
但 profile 级代理覆盖必须赢——否则一次 401/429 轮转会静默离开代理。

### 2. `_available_entries` 与 `mark_exhausted_and_rotate` —— 选择的纪律（credential_pool.py:2030, 2255）

```python
# agent/credential_pool.py:2030-2056 + 2090-2105（节选）
    def _available_entries(
        self, *, clear_expired: bool = False, refresh: bool = False, model: Optional[str] = None,
    ) -> tuple[list[PooledCredential], list[PooledCredential]]:
        """Return (available, pending_refresh) for entries not in cooldown.

        *clear_expired* resets elapsed cooldowns to STATUS_OK and persists.
        *refresh* refreshes entries needing a token refresh (skipped on
        failure) — except single-use-token providers (openai-codex,
        xai-oauth), which are returned as *pending_refresh* so the caller
        refreshes them outside the lock instead of stalling every pool
        consumer during cross-process flock acquisition + OAuth network I/O.
        """
        ...
            if entry.last_status == STATUS_DEAD:
                # Manual DEAD credentials are pruned after a 24h quiet window;
                # singleton-seeded ones stay (audit trail, and the seeder would
                # re-create them anyway). DEAD never re-enters via TTL — only a
                # write-side re-auth sync clears it.
```

可选用途过滤的完整链条：借用凭据未水合的不租（防发空 key）、DEAD 行手动来源 24h 后
修剪（singleton 播种的留着——审计线索，反正播种器会重建）、DEAD **永不**经 TTL 复活
（只有写侧的 re-auth 同步能清）、单 use token provider 的刷新推迟到锁外（不在跨进程
flock + OAuth 网络往返中卡死所有池消费者）。

```python
# agent/credential_pool.py:2255-2275 + 2281-2300（节选）
    def mark_exhausted_and_rotate(self, *, status_code, error_context=None, api_key_hint=None,
                                  credential_id=None, failure_reason=None, model=None):
        with self._lock:
            identity_supplied = bool(credential_id or api_key_hint)
            entry = self._identify_failed_entry(credential_id, api_key_hint)
            ...
            if self._is_model_scoped_failure(status_code, model, failure_reason):
                # A generic Anthropic 429 (per-model rate limit) or a Codex account model
                # entitlement rejection: bench this model only, the credential stays
                # available for its siblings.
                self._cool_down_model(entry, model, error_context, failure_reason=failure_reason)
                ...
            self._mark_exhausted(entry, status_code, error_context, failure_reason=failure_reason)
            # A 402/429/401 is a key-level failure, and the same key can back
            # several entries (an explicit entry plus a ``model_config`` row
            # auto-seeded from ``model.api_key``). Marking only the first
            # leaves siblings OK, ``_select_unlocked()`` keeps handing back
            # the depleted key, and rotation never converges (~2.5 min hang).
            # Mark every entry sharing the failed key.
            failed_runtime_key = entry.runtime_api_key
            if identity_supplied and failed_runtime_key:
                siblings = [
                    s for s in self._entries if s.id != entry.id and s.runtime_api_key == failed_runtime_key
                ]
                for sibling in siblings:
                    self._mark_exhausted(sibling, ..., persist=False, ...)
```

轮转的两条硬规则：**模型级失败只冷却模型**（Anthropic 泛 429、Codex 模型权益拒绝——
凭据留给兄弟模型）；**key 级失败连坐所有同 key 条目**（同一个 key 可以支撑多条
pool 行，只标记第一条的话 `_select_unlocked` 会一直把耗尽的 key 发回来，轮转永不
收敛，症状是 ~2.5 分钟挂起）。

### 3. 播种器与借用凭据（credential_pool.py:2521 + credential_persistence.py）

池不是凭空来的：`_Seeder`（:2521）从**单例**播种——`_seed_anthropic_singletons`（:
2545）、`_seed_nous_singleton`、`_seed_profile_singleton`、`_seed_qwen_singleton`、
`_seed_minimax_singleton`。`anthropic_credentials.py` 的头注释点出契约：

> ``~/.hermes/.anthropic_oauth.json`` (Hermes PKCE) and the Claude Code file are
> *singletons*: ``credential_pool._seed_from_singletons()`` re-reads them on every
> ``load_pool()``, so a failed write here is a failed refresh.

"借用"凭据（Codex CLI 的 `~/.codex/auth.json`、Claude Code 的
`~/.claude/.credentials.json`）有专门的政策文件。`credential_persistence.py` 管**磁盘
边界**：借用的池行持久化为**仅元数据引用**，原始秘密在到达 `auth.json` 前剥掉（
`sanitize_borrowed_credential_payload`），并且刻意不 import `hermes_cli.auth`——池模型
与 auth-store 写边界共享一套策略而不产生环。还有"已花轮转"侧车（`_spent_rotation_sidecar_path`，
:151）：single-use refresh token 是一次性的，指纹记下来防止把已消费的轮转当成新鲜对。

`credential_sources.py` 统一的是**移除**契约（:1-13）：

> Readers live in ``agent.credential_pool``; what is unified here is **removal**:
> ``hermes auth remove <provider> <N>`` must make the entry stay gone across
> ``load_pool()`` calls. Each source registers a ``RemovalStep`` ... and the
> dispatcher suppresses ``(provider, source_id)`` in auth.json so the seeding
> branch skips the upsert.

不加这个，`hermes auth remove` 会在下一次 `load_pool()` 时被播种器原样复活。
借用 CLI 登录的政策开关 `auth.adopt_external_logins`（默认 True）也在这里：Codex 和
Claude 的 OAuth refresh token 是单次使用且轮转的——Hermes 一旦借走 CLI 的 token 对，
两个程序就共享一个 token 族，谁先刷新谁把对方登出（:24-33）；opt-out 后 Hermes 永不
读/刷新那些文件，并每进程 INFO 一次。

### 4. 刷新与恢复（credential_pool.py:1490 + credential_auth_recovery.py）

`_refresh_entry`（:1490）是刷新总入口，按 provider 分派到 `_refresh_anthropic`（Claude
OAuth PKCE）、Codex（single-use、带 `CODEX_ACCESS_TOKEN_REFRESH_SKEW_SECONDS` 提前量）、
插件 refresh hook（`credential_pool_plugin.py`，#116408）等；失败走
`_recover_failed_refresh` / `_mark_dead_refresh_grant`——终态（`invalid_grant`）会清理
token 并写隔离标记。`_fail_closed_unpersisted_rotation`（:1547）处理最危险的窗口：
轮转已消费但**尚未持久**时绝不放行（fail-closed），宁可拒绝也不把不可复现的 token
族留在内存里。

`credential_auth_recovery.py` 是 401/403 的恢复路径：调度到的凭据认证失败时，先同步
外部来源（auth store / 凭据文件可能已被别的进程刷新），同步失败才标记并轮转——
多进程共享 auth.json 时，"过期"经常只是"别的进程刚刷新、我拿到旧值"。

### 5. 限速捕获与跨会话熔断

```python
# agent/rate_limit_tracker.py:1-19（节选）
"""Rate limit tracking for inference API responses.

Captures ``x-ratelimit-{limit,remaining,reset}-{requests,tokens}[-1h]``
headers (Nous Portal format, also used by OpenRouter / OpenAI-compatible APIs)
and formats them for the /usage slash command. Reset values are seconds."""
_BUCKET_TAGS = (
    ("requests_min", "requests"),
    ("requests_hour", "requests-1h"),
    ("tokens_min", "tokens"),
    ("tokens_hour", "tokens-1h"),
)
```

四个窗口（分钟/小时的请求数与 token 数）一次捕获成 `RateLimitBucket`。
`rate_limit_credits.py` 是 AIAgent Mixin 侧的粘合层：解析响应头进
`_rate_limit_state`/`_credits_state` 并发粘性通知——解析面在 Mixin（保持 `run_agent`
同名的 logger），策略面在 tracker。

`nous_rate_guard.py` 解决一个具体的放大问题：

```python
# agent/nous_rate_guard.py:1-6
"""Cross-session rate limit guard for Nous Portal.

Writes rate limit state to a shared file so all sessions (CLI, gateway, cron,
auxiliary) can check whether Nous Portal is currently rate-limited before making
requests. Without it each 429 fans out into up to 9 calls per turn (3 SDK
retries x 3 Hermes retries), all counted against RPH."""
```

共享文件是跨会话熔断器：所有会话（CLI/网关/cron/auxiliary）请求前先看一眼，一个 429
不再引发每 turn 最多 9 次的连锁。两个阈值讲究：reset < 60s 是上游抖动，不值得跳闸；
welcome tier 的结构化 `rate_limited` 拒绝里，reset ≥ 阈值是配额耗尽（停下、告诉用户
何时刷新、登录可解除），低于阈值则等一等就好。

`credits_tracker.py`（940 行）管 Nous credits：把 `x-nous-credits-*` /
`x-nous-tool-pool-*` 头解析成校验过的 `CreditsState`——**钱是 micros 整数**，
`*_usd` 字符串原样保留（绝不重新解析成 float），schema 版本不认识就 warn-once 放行。

### 6. 用量锚点 —— 本地估算只算增量（usage_anchor.py:1-11）

```python
# agent/usage_anchor.py:1-11
"""Usage-anchored token accounting: the provider's real ``usage.prompt_tokens`` is the only
authoritative context size; the local ``bytes/4`` estimate covers ONLY messages appended since.

An anchor = provider usage at capture + a snapshot of the transcript position it priced:
``base_count`` (len(messages) at capture; the reply is not yet appended and is covered by
``completion_tokens``, so the delta walk skips an assistant row at that index), ``base_last_role``
and ``base_last_fp`` (content fingerprint of the last priced message; compaction, splices and
rewinds replace it → anchor fails closed → full estimation until the next real reading).

The fingerprint (not ``id()``) is the identity: the gateway re-reads the transcript from the DB
every turn and a resumed session runs in a fresh process, so object identity is never stable
across the surfaces where the estimate mattered most (#99421, #104462). The anchor also persists
on the session row (``model_config._usage_anchor``) so a restarted process can restore it; a
restored anchor is honored only while the durable transcript still matches its fingerprint."""
```

计数的信用等级很明确：provider 的真实 `usage.prompt_tokens` 是唯一权威，本地
bytes/4 粗估（model_metadata.md §2）只覆盖锚点之后追加的消息。锚点身份用**内容指纹**
（`_FINGERPRINT_KEYS = ("role", "content", "api_content", "tool_call_id", "tool_calls")`，
:23）而不是 `id()`——网关每 turn 从 DB 重读转录、恢复的会话跑在新进程里，对象身份
在最需要它的地方恰恰不稳定。锚点对不上（压缩/拼接/回退改了转录）就**失败关闭**：
退回全量估算，直到下一次真实读数。锚点随会话行持久化，重启的进程可恢复，恢复的锚点
只在持久转录仍匹配指纹时被采纳。

### 7. 计价与视图

`usage_pricing.py`（799 行）把 token 变成美元：价格优先从 OpenRouter 元数据的
`pricing` 字段（model_metadata.md §4 预热的缓存）与端点 /models 定；`_MODELS_DEV_DIRECT_HOSTS`
（:23-27）列明哪些一方按量计费 API 可以直接用 models.dev 牌价——**且只在直连该域名
（HTTPS:443）时**：代理/中继/自定义端点卖同一个模型 id 可以不同价，订阅路由
（openai-codex、xai-oauth）有自己的政策。显示层为 sub-cent 成本渲染 4 位小数
（"$0.0046" 而不是 "$0.00"）。

`aux_accounting.py` 把 aux 调用的用量归回会话：aux 客户端没有会话句柄，历史上用量
直接丢弃——agent 循环把 `(session_db, session_id)` 发布进 ContextVar（镜像
portal_tags 的作用域纪律，HX002 家族），aux 客户端在它唯一的响应校验咽喉点记账。
`_EXCLUDED_TASKS` 排除 `moa_reference`/`moa_aggregator`——它们已折进
conversation_loop 的 delta，再记一次就双算。

视图四件套共享同一数据面：`billing_usage.py` 是 /usage 与 /subscription 通用条的
美元用量模型；`usage_gauges.py` 按服务器发来的**显示顺序**维护用量窗口余量；
`plan_limits.py` 回答"一个限额挡住了什么、改提供什么"；`account_usage.py`（975 行）
是各 provider 账户用量的取数引擎（Anthropic OAuth、Codex、OpenRouter、Portal…
各有一套窗口），`account_usage_cache.py` 让 `model.options` 在不打网络的情况下知道
订阅用量；`billing_view.py` 是 Remote Spending 屏幕的 surface 无关核心（CLI 与 TUI
JSON-RPC 共用）；`billing_links.py` 给账单类失败配 provider 无关的"恢复链接"。

---

## 核心类/函数

| 符号 | 职责 | 位置 |
|---|---|---|
| `CredentialPool` | 同 provider 多凭据池（选择/轮转/刷新/持久化） | `agent/credential_pool.py:966` |
| `PooledCredential` | 池行：凭据 + 状态 + 冷却 + extra 载荷 | `agent/credential_pool.py:209` |
| `PooledCredential.runtime_api_key` / `runtime_base_url` | 运行时读取面（Nous agent_key、Codex 代理覆盖） | `agent/credential_pool.py:287,308` |
| `select` / `_available_entries` | 可用条目过滤（DEAD/冷却/刷新推迟） | `agent/credential_pool.py:1960,2030` |
| `mark_exhausted_and_rotate` | 标记耗尽并轮转（模型级冷却 / key 级连坐） | `agent/credential_pool.py:2255` |
| `acquire_lease` / `release_lease` | 凭据租约（多会话协调） | `agent/credential_pool.py:2335,2375` |
| `_refresh_entry` / `_refresh_entry_impl` | 按 provider 分派的 token 刷新 | `agent/credential_pool.py:1490,1678` |
| `_fail_closed_unpersisted_rotation` | 轮转未持久时拒绝放行 | `agent/credential_pool.py:1547` |
| `credential_pool_matches_provider` | 池与 provider/base_url 匹配判定 | `agent/credential_pool.py:638` |
| `CredentialPoolAdminMixin` | 加锁的管理端与目标解析 | `agent/credential_pool_admin.py` |
| `CredentialPoolModelCooldownMixin` / `model_cooldown_until` | 模型级冷却簿记 | `agent/credential_pool_model_cooldowns.py` |
| `_Seeder` / `_seed_anthropic_singletons` 等 | 单例 → 池行播种 | `agent/credential_pool.py:2521,2545` |
| `resolve_anthropic_token` | Anthropic 凭据解析链（env → OAuth 池 → 借用） | `agent/anthropic_credentials.py` |
| `RemovalStep` / `adopt_external_logins_enabled` | 移除契约 + 借用登录开关 | `agent/credential_sources.py` |
| `credential_source` 模块 | 给 callable key 的来源命名（不调用它） | `agent/credential_source.py` |
| `sanitize_borrowed_credential_payload` / `fingerprint_secret_value` | 磁盘边界消毒 + 秘密指纹 | `agent/credential_persistence.py` |
| `recover_from_auth_failure` 家族 | 401/403 的同步-再标记-轮转恢复 | `agent/credential_auth_recovery.py` |
| `build_command_token_source` 家族 | key_cmd 挖掘 API key（来源命名不执行） | `agent/command_token_source.py` |
| `resolve_custom_entry_pool` 家族 | `providers:` 条目与内置池 id 冲突的所有权 | `agent/custom_entry_pool.py` |
| `RateLimitBucket` / `_BUCKET_TAGS` | 四窗口限速头部捕获 | `agent/rate_limit_tracker.py:23,10` |
| `capture_rate_limit_state` 家族（Mixin） | 头部 → `_rate_limit_state` + 粘性通知 | `agent/rate_limit_credits.py` |
| `note_nous_rate_limit` / `nous_rate_limited` | 跨会话限速熔断器（共享文件） | `agent/nous_rate_guard.py` |
| `CreditsState` / 解析函数 | Nous credits 头 → 校验状态（micros 整数） | `agent/credits_tracker.py` |
| `UsageAnchor` / `message_fingerprint` | 用量锚点与内容指纹 | `agent/usage_anchor.py` |
| 计价函数（`estimate_cost` 家族） | token → 美元（models.dev 牌价 + 直连域限定） | `agent/usage_pricing.py` |
| `AccountUsageWindow` / fetchers | 各 provider 账户用量窗口 | `agent/account_usage.py` |
| `set_accounting_context` / `record_aux_usage` | aux 调用归账（ContextVar 作用域） | `agent/aux_accounting.py` |
| `build_billing_usage` / gauges / views | 美元用量模型 / 窗口余量 / TUI-CLI 共享视图 | `agent/billing_usage.py` 等 |

## 本组文件清单

| 文件 | 一句话角色 |
|---|---|
| `agent/credential_pool.py` | 池核心：PooledCredential、选择/轮转/冷却/刷新、播种器、单例同步 |
| `agent/credential_pool_admin.py` | 加锁的池管理端与目标解析（hermes auth 管理命令的后端） |
| `agent/credential_pool_model_cooldowns.py` | 模型级限流冷却（凭据保持对兄弟模型可用） |
| `agent/credential_pool_plugin.py` | 插件 provider 的池行刷新（#116408） |
| `agent/credential_pool_timestamps.py` | 池状态/刷新/冷却共用的绝对时间戳解析 |
| `agent/credential_source.py` | 给 callable API key 命名来源（不执行它） |
| `agent/credential_sources.py` | 统一移除契约（hermes auth remove 不被播种复活）+ 借用开关 |
| `agent/credential_auth_recovery.py` | 401/403 恢复：先同步外部来源再标记轮转 |
| `agent/credential_persistence.py` | 磁盘边界：借用行消毒、秘密指纹、已花轮转侧车 |
| `agent/anthropic_credentials.py` | Anthropic 凭据源链 + OAuth PKCE 流 + Claude Code 借用 |
| `agent/command_token_source.py` | key_cmd：跑命令挖出 API key（不 ad-hoc 读凭据） |
| `agent/custom_entry_pool.py` | `providers:` 条目的池 slug 撞上内置池 id 时的所有权 |
| `agent/rate_limit_tracker.py` | x-ratelimit-* 四窗口头部捕获与 /usage 格式化 |
| `agent/rate_limit_credits.py` | AIAgent Mixin：头部 → 状态 + 粘性低额度通知 |
| `agent/credits_tracker.py` | Nous credits 头解析（micros 整数、warn-once 版本门） |
| `agent/nous_rate_guard.py` | 跨会话限速熔断器（共享文件，防 429 放大 9 倍） |
| `agent/usage_anchor.py` | 用量锚点：provider 真值 + 指纹增量的 token 记账 |
| `agent/usage_pricing.py` | token → 美元计价（模型目录牌价、直连域限定、sub-cent 显示） |
| `agent/usage_gauges.py` | 用量窗口余量（服务器发来的一条列表，按显示顺序） |
| `agent/aux_accounting.py` | aux 调用的会话归账（ContextVar、MoA 双算排除） |
| `agent/account_usage.py` | 各 provider 账户用量取数引擎（OAuth/Codex/OR/Portal 窗口） |
| `agent/account_usage_cache.py` | model.options 的免网络订阅用量快照 |
| `agent/subscription_view.py` | /subscription 屏幕的 surface 无关核心 |
| `agent/plan_limits.py` | 用量窗口计划：限额挡住什么、改提供什么 |
| `agent/billing_usage.py` | /usage 与 /subscription 共用的美元用量模型 |
| `agent/billing_view.py` | Remote Spending 屏幕（CLI `_show_billing` 与 TUI JSON-RPC 共用） |
| `agent/billing_links.py` | 账单类失败的 provider 无关恢复链接 |

## 与其他模块的关系

```
turn 主循环（turn_api_call / client_lifecycle._swap_credential）
        │ mark_exhausted_and_rotate / credential_auth_recovery
        ▼
credential_pool.CredentialPool ──► hermes_cli/auth（auth.json 读写、OAuth 刷新）
        │  select()                        ▲ 播种：_seed_from_singletons
        │                                  └── anthropic_credentials / ~/.codex / ~/.claude
        ▼
resolve_provider_client（auxiliary_client.md）── 402/429 ──► 回退链 + pool 轮转
        │
        ▼
每次响应 ──► rate_limit_tracker / credits_tracker / nous_rate_guard（限速面）
        └──► usage_anchor / usage_pricing / aux_accounting（记账面）
                 ▼
        /usage 与 /subscription 视图（billing_usage/view、usage_gauges、plan_limits）
```

- **主循环消费**：`_finalize_routing` 用 `credential_pool_matches_provider` 校验池
  （agent_init.md §2）；`client_lifecycle._swap_credential` 在 401/429 时换凭据并重套
  `pin_model_for_route`；`rate_limit_credits.py` 本身是 `AIAgent` 的一个 Mixin
  （RateLimitCreditsMixin）。
- **aux 消费**：aux 漏斗的回退阶梯调用池轮转与冷却；`aux_accounting` 的 ContextVar 由
  turn_facade 挂载（`acct_token = set_accounting_context(...)`）。
- **model_metadata**：OpenRouter 预热缓存同时喂计价；`estimate_messages_tokens_rough`
  是锚点增量的估算器。
- **hermes_cli**：`hermes auth add/remove/status` 的读者与移除器在这里；
  `hermes_cli.nous_auth_keepalive`（_finalize_routing 启动）靠池的 Nous 行提前续期。

## 总结

- **池是一条状态机**：每行凭据带状态（OK/EXHAUSTED/DEAD）、模型级冷却、刷新计划与
  extra 载荷；选择过滤 DEAD 与冷却（单 use provider 的刷新推迟到锁外）；DEAD 永不经
  TTL 复活。
- **轮转的粒度即失败粒度**：模型级失败（429/权益拒绝）只冷却模型；key 级失败
  （402/429/401）连坐所有共享该 key 的条目——否则轮转永不收敛。
- **凭据有来源也有去处**：单例播种（Hermes OAuth、Claude Code、~/.codex）、key_cmd、
  custom providers；移除必须登记 RemovalStep，否则 `hermes auth remove` 被播种器复活。
  借用凭据在磁盘边界消毒、已花轮转记指纹侧车。
- **限速有三层**：响应头捕获（四窗口）、跨会话熔断（共享文件防一个 429 放大 9 次）、
  credits 状态机（micros 整数，字符串保留，warn-once 版本门）。
- **记账以 provider 为权威**：真实 `usage.prompt_tokens` 是锚点，本地粗估只算增量；
  锚点用内容指纹定身份（跨进程/跨 DB 重读都稳定），对不上就失败关闭退回全量估算。
  aux 调用经 ContextVar 归账，MoA 双算被显式排除。
- **计价认直连**：models.dev 牌价只对一方 API 的直连域名成立，代理与订阅路由各有
  各的账；sub-cent 成本渲染到 4 位小数，绝不显示 $0.00。
