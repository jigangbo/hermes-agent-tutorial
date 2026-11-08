# Prompt 缓存规划器（agent/ 缓存四件套）

## 文件概览

Hermes 对 Anthropic 式 prompt caching 的支持由四个小文件组成，每个都是纯函数或
进程内登记表，不依赖 `AIAgent`：

| 文件 | 角色 |
|---|---|
| `prompt_caching.py` | 规划器：决定每请求把 4 个 `cache_control` 断点放在哪 |
| `prompt_cache_boundary.py` | 声明式边界：构建者注册 user 消息里的稳定脚手架前缀 |
| `prompt_cache_scope.py` | 作用域：物理会话 id → 压缩谱系根，保证轮换/分支不串缓存桶 |
| `cache_bounds.py` | 长寿命进程内缓存的通用淘汰原语 |
| `prompt_refresh.py` | 运维触发的 prompt 刷新 epoch（一次性断缓存的受控方式） |

理论基础（为什么「每会话 prompt 缓存神圣」、什么操作会破坏缓存前缀）在
`01_architecture/caching_invariants.md`，本篇是它的实现篇。四件套的设计动机
一致：**缓存的键是字节级前缀，任何「聪明」的运行时改写都是缓存杀手**，所以
Hermes 只在请求装配的最后一刻做标记，且全部标记是请求本地的（copy-on-write，
不落库）。

## 关键代码走读

### 1. 四断点布局：`apply_anthropic_cache_control`

默认布局是 4 个断点：静态系统前缀尾、系统提示尾、最后两条非系统消息（没有静态
前缀时退化为 1 个系统断点 + 最后 3 条消息）。函数是幂等的：先剥离旧装饰再重贴，
第二次调用绝不会累积出第 5 个标记：

```python
# agent/prompt_caching.py:345（节选）
def apply_anthropic_cache_control(
    api_messages: list[dict[str, Any]], cache_ttl: str = "5m", native_anthropic: bool = False,
    static_system_prefix: str | None = None, tool_part_markers: bool = True,
) -> list[dict[str, Any]]:
    """Apply Anthropic cache-control markers to API messages.

    With a matching ``static_system_prefix`` the prefix and full system prompt each get a
    marker and the remaining two go to the latest cacheable non-system messages; otherwise
    the legacy system-and-3 layout applies. Idempotent: prior decoration is stripped from a
    per-message copy first, so a second call (or messages a prior call already planned) can never
    accumulate past 4 markers (#90971). Returns a shallow list copy with deep copies of modified
    messages.
    """
    messages = _strip_prior_decoration(list(api_messages))
    marker = _build_marker(cache_ttl)
    breakpoints_used = 0
    if messages[0].get("role") == "system":
        messages[0] = copy.deepcopy(messages[0])
        breakpoints_used = _apply_system_cache_markers(messages[0], marker, static_system_prefix,
                                                       native_anthropic=native_anthropic)
    non_sys = [i for i, m in enumerate(messages) if m.get("role") != "system"
               and _can_carry_marker(m, native_anthropic=native_anthropic, tool_part_markers=tool_part_markers)]
    for idx in non_sys[-(4 - breakpoints_used):]:
        messages[idx] = copy.deepcopy(messages[idx])
        _apply_cache_marker(messages[idx], marker, native_anthropic=native_anthropic, ...)
    _split_unmarked_scaffolds(messages)
    return messages
```

细节三连：

- `_apply_system_cache_markers`（行 178）把存储中的系统提示**保持为一个字符串**，
  只在请求里拆成 `[前缀, 后缀]` 两个 part —— 落库形状永不变。
- `_can_carry_marker`（行 102）与 `_apply_cache_marker` 必须一致：envelope 布局
  只认 content part 内的标记，空 content 的消息浪费断点；LiteLLM 式路由
  （`tool_part_markers=False`）上 part 级标记会变成
  `tool_result.content[0]` → 不可重试的 400。
- `_split_unmarked_scaffolds`（行 88）：**没带标记的脚手架也要拆**。provider 缓存
  键在内容上，两个 text part 和一个字符串是不同内容 —— 技能消息带着断点时被拆过，
  滚动标记窗口移走之后必须保持同样的 parts，否则下一次请求重写整个脚手架（#81867）。

### 2. 一次性请求跳过：`is_one_shot_request`

标记不是免费的：Anthropic 上缓存写入按 1.25x（5m）/ 2x（1h）计费。一条后面
没人会再读的请求贴标记只买一个永远读不到的写入：

```python
# agent/prompt_caching.py:35
def is_one_shot_request(messages: list[dict[str, Any]] | None, tools: list[dict[str, Any]] | None) -> bool:
    """True for a request no later call can read back from cache: no tools, no assistant/tool
    turns, at most one user turn (compression summaries, titles, MoA synthesis). A marker there
    only buys a cache write (1.25x input at 5m, 2x at 1h) that nothing ever reads. A caller that
    already decorated the request (a MoA advisor's first iteration, whose prefix later
    iterations replay) decided it will reuse it, so that decision wins over the shape."""
    if tools:
        return False
    msgs = [m for m in messages or [] if isinstance(m, dict)]
    if any("cache_control" in m or _has_part_marker(m.get("content")) for m in msgs):
        return False
    roles = [m.get("role") for m in msgs]
    return roles.count("user") <= 1 and not any(r in ("assistant", "tool") for r in roles)
```

判断「caller 已贴标记即视为声明复用」是这条规则的关键软化：形状不决定命运，
意图优先。

### 3. 声明式边界：`prompt_cache_boundary.py`

技能/webhook/cron 构建者把一大块静态脚手架和一小段易变尾巴拼进一条 user 消息。
只有构建者知道尾巴从哪开始 —— 所以构建者在构建时注册，规划器请求时查表。刻意
**不做**请求时重新解析标记字符串：标记可能合法地出现在技能正文里，任何分隔符
启发式都会缩小缓存前缀或吞掉易变字节：

```python
# agent/prompt_cache_boundary.py:26
def register_stable_prefix(prefix: str) -> None:
    """Record ``prefix`` as the stable scaffold of a just-built message."""
    if not prefix:
        return
    with _lock:
        _prefixes[prefix] = None
        _prefixes.move_to_end(prefix)
        while len(_prefixes) > _MAX_ENTRIES:            # 32 条
            _prefixes.popitem(last=False)
        while len(_prefixes) > 1 and sum(map(len, _prefixes)) > _MAX_CHARS:  # 4MB
            _prefixes.popitem(last=False)
```

```python
# agent/prompt_cache_boundary.py:39
def find_stable_prefix(content: str) -> Optional[str]:
    """Longest registered *proper* prefix of ``content`` with a non-whitespace tail.

    The tail must be non-whitespace so the split never yields an empty text
    block (Anthropic rejects it with HTTP 400). A hit refreshes the entry's LRU
    position so a scaffold fired every minute by cron is not evicted by a
    burst of one-off skill invocations.
    """
    with _lock:
        best: Optional[str] = None
        for prefix in _prefixes:
            if (content.startswith(prefix) and content[len(prefix):].strip()
                    and (best is None or len(prefix) > len(best))):
                best = prefix
        if best is not None:
            _prefixes.move_to_end(best)  # after the scan: never mutate mid-iteration
        return best
```

进程本地、miss 即回退整条消息策略 —— 登记表只是优化，不是正确性依赖。

### 4. 作用域：压缩谱系根 `prompt_cache_scope.py`

老式压缩轮换会在会话中途铸造新的物理 `session_id`，请求于是掉进新的缓存桶。
`resolve_prompt_cache_scope()` 把物理 id 映射到**压缩谱系根**，让压缩轮换保持
缓存作用域，而 `/new`、分支、委派子代理各自隔离：

```python
# agent/prompt_cache_scope.py:1（模块 docstring，节选）
"""Rotation-stable logical cache scope for prompt_cache_key derivation.

Legacy compression rotation mints a new physical ``session_id`` mid-conversation, moving it
into a fresh cache bucket. ``resolve_prompt_cache_scope()`` maps the physical id to the ROOT
of its compression lineage — NOT ``get_conversation_root`` (the Portal-attribution walk),
which would collapse /branch children and delegate trees into one id. ``/new`` starts a
fresh scope; fork children (branch, delegate, tool-tagged) are isolated. Hosts minting one id
per RESPONSE declare the conversation via ``gateway_session_key``, which wins over the lineage
walk and is hashed to ``gwk_<sha256[:24]>`` (it embeds platform/chat/user identifiers).
"""
```

网关会话键（host 每响应铸一个 id 的场景）走声明式作用域，哈希
`(source, gateway_session_key, generation)` 三元组：

```python
# agent/prompt_cache_scope.py:160
# Same identity tuple the peer queries use: same key under different sources must not collapse.
carrier = f"{source}|{key}|{generation}"
digest = hashlib.sha256(carrier.encode("utf-8", errors="replace")).hexdigest()[:24]
return f"{_DECLARED_SCOPE_PREFIX}{digest}"
```

`generation` 是持久化的会话代计数：声明键刻意在 `/new` 之后存活，若只哈希键本身
就会跨会话复用同一作用域；压缩**不**推进它。

### 5. TTL 选择：auto 按会话节奏分档

`cache_ttl: auto` 根据谁在推进会话选择 5m/1h。1h 层写入 2x（5m 是 1.25x），
只有轮次间隔超过五分钟才划算 —— 也就是人走开又回来的场景：

```python
# agent/prompt_caching.py:154
AUTO_CACHE_TTL = "auto"
MACHINE_PACED_SOURCES = frozenset({"subagent", "cron", "oneshot", "webhook", "kanban", "api", "tool", "batch"})

def auto_cache_ttl_for_source(source: str | None) -> str:
    """The tier ``auto`` resolves to for a session source: ``5m`` for machine-paced sources,
    ``1h`` for everything a human types into (cli, tui, desktop, messaging platforms)."""
    return "5m" if (source or "").strip().lower() in MACHINE_PACED_SOURCES else "1h"
```

路由能力钳制在 `effective_cache_ttl`（行 164）：Qwen/Alibaba 系只支持 5m；1h
白名单 `MEASURED_1H_PROVIDERS` 只收**实测**保留过 1h 标记的路由 —— 未测路由是
UNMEASURED 而非 known-bad，宁可降档也不发 400。注意模块注释的警告：收窄
`ALIBABA_FAMILY_PROVIDERS` 会直接禁用这些路由的缓存，不要用它来扩 TTL。

### 6. 长寿命缓存边界：`cache_bounds.py`

网关进程活得很久，进程内缓存必须会收缩。这个文件是三个通用原语 + 一个闭环表：

```python
# agent/cache_bounds.py:27
def publish_lru(table: dict, key: Any, value: Any, limit: int, *siblings: dict) -> list:
    """Store ``key`` as most recently used; past ``limit``, drop the least recently used keys from
    ``table`` and every sibling. Returns the evicted keys (for companions that are not dicts)."""
    table.pop(key, None)
    table[key] = value
    evicted = []
    while len(table) > limit:
        stale = next(iter(table))
        evicted.append(stale)
        for scoped in (table, *siblings):
            scoped.pop(stale, None)
    return evicted
```

「sibling 联动淘汰」是核心思想：主表和它的伴生表（如 stamp 表、scope 表）必须
同步收缩，否则淘汰只腾了主表的空间。

### 7. 受控断缓存：`prompt_refresh.py`

`SOUL.md`/技能/项目上下文的编辑在 `/new` 之前永远到不了持续会话（存储的系统提示
逐字重放以保缓存温度）。`hermes sessions refresh-prompts` 记录一个刷新 epoch，
会话下一 turn 开头比对：

```python
# agent/prompt_refresh.py:1（模块 docstring，节选）
"""Adopt an operator's prompt refresh request on a continuing session's next turn.

... At the start of the session's next turn this module compares
that epoch with the one stamped when the session's prompt was built (``model_config``) and, when
the prompt is older, rebuilds it once through the normal builder: history, session id and the
tools[] pin are kept, ``on_session_start`` does not fire, and the new bytes plus the epoch are
persisted so every later turn restores them verbatim. One prefix-cache break per request.

No request recorded means the stored prompt is reused exactly as before: the only extra work is
one ``state_meta`` point read. Nothing watches files and nothing changes mid-turn.
"""
```

设计要点：每会话恰好一次前缀断裂；不监听文件、turn 中途绝不换 prompt（否则
破坏「turn 中不改系统提示」的缓存不变量）；无请求时成本是一次点读。

## 核心类/函数

| 名称 | 文件:行号 | 职责 |
|---|---|---|
| `PromptCachePlan` | prompt_caching.py:15 | 请求本地的 messages+tools 及其标记（frozen dataclass） |
| `apply_anthropic_cache_control()` | prompt_caching.py:345 | 四断点规划器主入口，幂等 |
| `build_prompt_cache_plan()` | prompt_caching.py:313 | 每个解析目的地的计划构建（含工具缓存布局） |
| `is_one_shot_request()` | prompt_caching.py:35 | 一次性请求识别，跳过没人读的标记 |
| `auto_cache_ttl_for_source()` | prompt_caching.py:158 | auto TTL：机器节奏 5m / 人类节奏 1h |
| `effective_cache_ttl()` | prompt_caching.py:164 | TTL 钳制到目的地路由支持档位 |
| `strip_anthropic_cache_control()` | prompt_caching.py:206 | 剥标记 + 还原装饰形状（failover 前重贴用） |
| `_split_unmarked_scaffolds()` | prompt_caching.py:88 | 未标记脚手架也保持 parts 形状（#81867） |
| `register_stable_prefix()` | prompt_cache_boundary.py:26 | 构建者注册稳定脚手架前缀（LRU 32 条/4MB） |
| `find_stable_prefix()` | prompt_cache_boundary.py:39 | 请求时查最长注册前缀，命中刷新 LRU 位次 |
| `resolve_prompt_cache_scope()` | prompt_cache_scope.py:166 | 物理会话 id → 压缩谱系根/声明作用域 |
| `conversation_id()` | prompt_cache_scope.py:40 | 插件键控每会话状态的稳定 id（谱系根） |
| `declared_conversation_scope()` | prompt_cache_scope.py:109 | 网关键 → `gwk_<sha256[:24]>` |
| `drop_expired()` / `evict_oldest()` / `publish_lru()` | cache_bounds.py:11/18/27 | 长寿命缓存淘汰三原语 |
| `stored_prompt_refresh_epoch()` | prompt_refresh.py:50 | 有待应用的刷新 epoch 则返回之 |

## 本组文件清单

| 文件 | 一句话 |
|---|---|
| prompt_caching.py | Anthropic 缓存规划器：四断点、一次性跳过、TTL 钳制（纯函数） |
| prompt_cache_boundary.py | 构建者声明的稳定前缀登记表（进程内 LRU） |
| prompt_cache_scope.py | 缓存作用域解析：谱系根 / gwk_ 声明 / fork 隔离 |
| cache_bounds.py | 长寿命进程内缓存的过期/最老/LRU 淘汰原语 |
| prompt_refresh.py | 运维 prompt 刷新 epoch（一次受控断缓存） |

## 与其他模块的关系

- **01_architecture/caching_invariants.md**：理论篇。本篇四件套是它列出的不变量
  （不改已发送前缀、标记请求本地、压缩即谱系轮换）的执行机构。
- **agent/context_compressor / conversation_compression**：压缩是唯一被认可的
  历史变更，也是最大的缓存破坏者 —— 谱系根作用域、commit fence、压缩后
  `prompt_refresh` epoch 推进都是围绕它的补偿机制。
- **skills/ 构建器**：`register_stable_prefix` 的主要调用方；技能消息的
  `[脚手架, 尾巴]` 拆分形状由此约定。
- **gateway**：`gateway_session_key` 是声明式作用域的来源；网关多路复用多个
  profile 会话时作用域解析必须按会话绑定（HX002 家族规则）。
- **chat_completion_helpers.build_api_kwargs**：规划器的最终消费点 —— 标记在
  请求装配最后一刻贴上，failover 时先 `strip_anthropic_cache_control` 再重贴。

## 总结

这套代码的原则高度统一：**让「保持字节稳定」成为默认，把每一次改写变成显式、
可审计、一次性的动作**。规划器只在请求边界贴 4 个断点且幂等；构建者用登记表
声明边界而不靠启发式解析；作用域走谱系根让压缩不换缓存桶；TTL 按会话节奏分档
并钳制到实测路由能力；运维刷新用 epoch 保证恰好断一次。读完本篇后，回看
`caching_invariants.md` 的每条不变量，都能在这里找到对应的执行文件 —— 这正是
「不变量 → 机制」一一映射的好样本。
