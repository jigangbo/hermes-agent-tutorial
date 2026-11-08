# codex_runtime.md — OpenAI Responses / Codex 运行时

## 文件概览

`codex_responses`（HTTP Responses API）与 `codex_app_server`（子进程 codex CLI）是 Hermes
里最重的两种 wire。前者由 agent/transports/codex.py + 无状态适配器支撑；后者干脆**把整个
turn 交给 codex 子进程跑**——codex 拥有 loop、工具列表和模型侧线程（thread），Hermes 只
负责投影事件、审批桥接与转录拼接。

| 文件 | 行数 | 角色 |
|---|---|---|
| `agent/codex_responses_adapter.py` | 1,359 | 无状态转换/normalize：Responses 输入项、加密 reasoning blob、endpoint quirks |
| `agent/codex_runtime.py` | 1,481 | 两条运行时路径的入口：`run_codex_app_server_turn` / `run_codex_stream` |
| `agent/codex_runtime_history_seed.py` | 65 | 全新线程的"历史种子"：把 Hermes 前文渲染成一次性 developerInstructions |
| `agent/codex_service_tiers.py` | 212 | 速度档位（ultrafast/priority）与 Daybreak：只按账户目录协商，绝不盲目降级 |
| `agent/codex_headers.py` | 128 | 请求身份头：originator/UA、JWT 派生的账户头、zstd 压缩钩子 |
| `agent/transports/codex.py` | 977 | Responses 传输层（四步数据路径，见 model_providers.md） |
| `agent/transports/codex_app_server.py` | 381 | stdio JSON-RPC 2.0 客户端（握手、thread/start、turn/start） |
| `agent/transports/codex_app_server_session.py` | 849 | 会话适配器：一线程一会话，审批桥接、取消翻译、TurnResult |
| `agent/transports/codex_event_projector.py` | 171 | `item/*` 通知 → OpenAI 形态消息的投影器 |

两条路径的关系：

```
codex_responses（HTTP）                    codex_app_server（子进程）
  turn_api_call                             run_codex_app_server_turn
      │                                         │
      ▼                                         ▼
transports/codex.py  ──适配──►            _ensure_codex_session
codex_responses_adapter                        │ 惰性 spawn
      │                                        ▼
      ▼                              CodexAppServerSession（一线程一 Hermes 会话）
run_codex_stream                          │  turn/start + 流式 item/*
  _CodexResponseAssembler ──┐              ▼
      │                    │        CodexEventProjector（item/* → OpenAI 消息）
      ▼                    ▼              │
  NormalizedResponse    流式 delta ◄──────┘ 事件桥 make_codex_app_server_event_bridge
```

---

## 关键代码走读

### 1. `run_codex_app_server_turn` —— 一个 turn 的完整移交（codex_runtime.py:748）

```python
# agent/codex_runtime.py:748-793（节选）
def run_codex_app_server_turn(agent, *, user_message: str, original_user_message: Any, messages: list[dict[str, Any]],
                              effective_task_id: str, should_review_memory: bool = False,
                              turn_id: Any = None) -> dict[str, Any]:
    """Hand the turn to a ``codex app-server`` subprocess and project its events into ``messages``.
    Returns the chat_completions result shape. The user message is ALREADY in ``messages`` — never append it again."""
    # Defense in depth for compression.checkpoint_required: agent init refuses the combination, but
    # api_mode is mutable. Explicit-True check matches compress_context().
    if getattr(agent, "compression_checkpoint_required", False) is True:
        from agent.conversation_compression_checkpoint import _checkpoint_blocked
        raise _checkpoint_blocked("codex_app_server owns the authoritative thread and compacts it "
                                  "without a truthful pre-compaction transcript boundary")
    _ensure_codex_session(agent, messages)
    try:
        _start_codex_thread(agent)
        wire_model = _codex_wire_model(agent, getattr(agent, "_codex_session_model_provider", None))
        turn = agent._codex_session.run_turn(
            user_input=user_message,
            model=wire_model, reasoning_effort=_codex_turn_effort(agent, wire_model),
            service_tier=_codex_turn_service_tier(agent))
    except Exception as exc:
        logger.exception("codex app-server turn failed")
        _close_codex_session(agent)
        return _turn_result(..., final_response=f"Codex app-server turn failed: {exc}. "
                           f"Fall back to default runtime with `/codex-runtime auto`.")
    interrupt = _consume_user_interrupt(agent, turn.interrupted)
    # Wedged client (turn deadline blown, OAuth refresh died, subprocess exited): retire it. Post-tool
    # silence alone no longer retires — it only logs a warning (#112928).
    if getattr(turn, "should_retire", False):
        logger.warning("codex app-server session retired (turn error: %s)", turn.error)
        _close_codex_session(agent)
    reply = _transform_codex_reply(agent, turn, turn_id)
    # The binding is published only once the transcript it belongs to is durable, and never for a
    # retired thread (the next agent would only resume into the same wedge).
    if _persist_projected_messages(agent, turn, messages) and not getattr(turn, "should_retire", False):
        _store_codex_thread_id(agent, turn.thread_id)
```

这里的顺序每一环都 load-bearing：

1. **checkpoint 双保险**：`codex_app_server` 自己拥有权威线程并自行压缩，压缩检查点
   模式与它不可共存——agent init 已拒绝该组合，这里再拦一次（api_mode 是可变的）。
2. **会话退役（retire）语义**：turn 超时、OAuth 刷新死、子进程退出 → `should_retire`
   → 关闭会话，下个 turn 重生；仅"工具后沉默"不再触发退役（#112928 修复）。
3. **thread 绑定的发布门**：只有投影消息**先落库**（`_persist_projected_messages`
   返回 True）才把 codex thread_id 存进会话——绑定指向的转录必须已持久；退役线程
   永不发布绑定（下一个 agent 会 resume 进同一个卡死的线程）。
4. **结果形状对齐**：`_turn_result`（:796）返回与 chat_completions 路径完全相同的
   dict 形状，外加 `agent_persisted=True`（网关跳过自己的 DB 写）与 codex 线程/turn id。

### 2. `_ensure_codex_session` —— 懒 spawn、合成感知退役、失败种子（codex_runtime.py:599）

```python
# agent/codex_runtime.py:599-617 + 649-663（节选）
def _ensure_codex_session(agent, messages=None) -> None:
    """Lazily spawn one CodexAppServerSession per AIAgent (reused across turns, closed by the _cleanup hook).
    A live session whose thread was started with a different prompt composition (TUI/Desktop ``/personality``
    or a prompt mirror mutate the agent in place) is retired first so the new thread carries the current one.
    Only the FIRST session of an AIAgent resumes the stored codex thread: a retired/recreated one keeps
    today's fresh-thread behaviour and overwrites the binding once its turn is committed."""
    developer_instructions = _codex_developer_instructions(agent)
    model_provider = _codex_model_provider(agent)
    if getattr(agent, "_codex_session", None) is not None:
        recorded = getattr(agent, "_codex_session_prompt", None)
        if recorded is None or (recorded == developer_instructions
                                and getattr(agent, "_codex_session_model_provider", None) == model_provider):
            return
        _close_codex_session(agent)
    ...
    agent._codex_session_prompt = developer_instructions
    agent._codex_session_model_provider = model_provider
    from agent.codex_runtime_history_seed import render_history_seed
    history_seed = render_history_seed(messages) or None
    agent._codex_session = CodexAppServerSession(
        cwd=..., approval_callback=approval_callback,
        codex_bin=get_configured_codex_binary(load_config()),
        request_routing=_ServerRequestRouting(auto_approve_exec=..., auto_approve_apply_patch=...),
        on_event=make_codex_app_server_event_bridge(agent),
        developer_instructions=developer_instructions or None,
        model=_codex_wire_model(agent, model_provider), model_provider=model_provider,
        resume_thread_id=resume_thread_id, history_seed=history_seed,
    )
```

要点：

- **prompt 合成变了就退役**：TUI/Desktop 的 `/personality` 会原地改 agent；codex 线程
  的 developerInstructions 是**每请求**都会带上的首条 developer 消息，合成漂移的线程
  必须重开。记录的是**裸 prompt**——history seed 不能算进合成，否则下一 turn 白退役。
- **只有第一个会话 resume 存储线程**：退役重建的会话走 fresh-thread 行为，turn 提交后
  覆写绑定。
- **审批 fail-closed**：CLI 线程装了审批回调才桥接；网关/cron 没人能答审批，默认拒绝
  exec/apply_patch，只有显式 bypass（approvals.mode: off、/yolo）才放行给 codex 沙箱。
- **模型总是随行**（:653-654 注释）：codex home 是共享的，而 Hermes 模型是 per
  profile/session 的——省略 model 会跑成 codex 自己的默认选择。

### 3. 历史种子 —— fresh thread 不许失忆（codex_runtime_history_seed.py:53）

一个 Hermes 会话可能因为 `/model` 切到 openai-codex、存储线程 resume 失败或线程中途
退役而从零开始一个 codex 线程。线程是**模型侧**的连续性存储，codex 不认识 Hermes 的
转录，除非有人告诉它。`render_history_seed` 把前文渲染成一段文本，搭乘
`thread/start.developerInstructions` 一次性注入（codex 会把它作为线程内每个请求的首条
developer 消息，所以上限很重要）：

```python
# agent/codex_runtime_history_seed.py:19-23 + 53-65
# Tail cap on the rendered history; ~8k tokens, resent by codex on every request of the thread.
MAX_HISTORY_SEED_CHARS = 32_000
_TOOL_RESULT_PREVIEW_CHARS = 400

_HEADER = ("Prior conversation from this Hermes session (the thread you are continuing was started fresh; "
           "treat these turns as already having happened):")

def render_history_seed(messages: list[dict[str, Any]] | None) -> str:
    """Prior turns as one text block, newest last; empty when there is nothing before the current
    user message. The trailing user row is the turn being submitted and is never included."""
    rows = list(messages or [])
    if rows and rows[-1].get("role") == "user":
        rows = rows[:-1]
    rendered = [r for r in (_render_row(m) for m in rows if isinstance(m, dict)) if r]
    if not rendered:
        return ""
    body = "\n\n".join(rendered)
    if len(body) > MAX_HISTORY_SEED_CHARS:
        body = "[… earlier turns omitted …]\n\n" + body[-MAX_HISTORY_SEED_CHARS:]
    return f"{_HEADER}\n\n{body}"
```

渲染规则（`_render_row`，:35-50）：user/assistant 原文（assistant 附带 `called tools`
清单）、tool 结果只留 400 字符预览、system 行直接跳过（prompt 合成本来就以
developerInstructions 单独发送）。超长时**保尾不保头**——最近的 turn 才是下一答案
依赖的东西。

### 4. `CodexEventProjector` —— item/* 到 OpenAI 消息的投影（codex_event_projector.py:42）

```python
# agent/transports/codex_event_projector.py:1-8 + 42-67（节选）
"""Projects codex app-server ``item/*`` notifications into OpenAI-shaped messages.

userMessage → user; agentMessage → assistant; reasoning → stashed onto the next
assistant entry; commandExecution / fileChange / mcpToolCall / dynamicToolCall /
webSearch → assistant tool_call + tool result; anything else → opaque assistant note.
Each item yields AT MOST one assistant + one tool entry (message-alternation
invariant). ``is_tool_iteration`` ticks once per completed tool-shaped item.
"""
class CodexEventProjector:
    """Stateful projector; stashes codex's separate reasoning items onto the next assistant message."""

    def __init__(self) -> None:
        self._pending_reasoning: list[str] = []

    def project(self, notification: dict) -> ProjectionResult:
        """Project one notification; only ``item/completed`` materializes messages (deltas are display-only)."""
        if notification.get("method", "") != "item/completed":
            return ProjectionResult()
        item = (notification.get("params", {}) or {}).get("item") or {}
        ...
        if item_type == "reasoning":
            self._pending_reasoning.extend(item.get("summary") or [])
            self._pending_reasoning.extend(item.get("content") or [])
            return ProjectionResult()
```

投影器的纪律：**只有 `item/completed` 物化消息**，流式 delta 只做展示；reasoning 是
独立 item，先暂存（stash）再挂到下一条 assistant 消息上，维持 Hermes 的消息交替不变
量（每个 item 至多产生一条 assistant + 一条 tool）。未知 item 类型（plan、hookPrompt…）
投影成不透明备注，绝不伪造 tool_call 结构。tool_call id 用确定性哈希
（`_deterministic_call_id`，:18），保证重放时前缀缓存仍然命中。

会话适配器还做一层**多路复用防护**（`_notification_belongs_to_turn`，
codex_app_server_session.py:89）：一条连接可能同时承载父子 subagent 的线程，显式属于
别的 thread/turn 的通知不许改动本转录。

### 5. `run_codex_stream` 与 `_CodexResponseAssembler` —— HTTP 流式路径（codex_runtime.py:1192）

```python
# agent/codex_runtime.py:1192-1199 + 1211-1214（节选）
def run_codex_stream(agent, api_kwargs: dict, client: Any = None, on_first_delta=None):
    """One streaming Responses API request over raw ``responses.create(stream=True)`` events."""
    ...
    active_client = client or agent._ensure_primary_openai_client(reason="codex_stream_direct")
    max_stream_retries, model = 1, api_kwargs.get("model")
    ...
    # Delta-sink claim for the CURRENT physical attempt (None until the stream opens). A newer attempt that
    # claims the sink supersedes this token; that only silences OUR live callbacks — consumption continues,
    # because stopping here handed the gateway a "completed" response missing its tail (#69486).
    writer_token = {"value": None, "raw_stream": None, "superseded_logged": False}
```

为什么不用 SDK 的 `responses.stream()` 助手？:808-811 的注释给出了原因：SDK 会从
`response.completed.response.output` 重建类型化 Response，而该字段为 null 时直接崩溃。
所以 Hermes 消费**原始 SSE 事件**，从 `output_item.done` 组装最终响应——终帧的
output 可以是 null/[]/字符串/缺席。`_CodexResponseAssembler`（:873）是有状态组装器：
只从终帧读 usage/status/id/service_tier；被 `output_item.added` 宣告但从未确认的
function call 从 delta 结算出来；`message_phases` 保证 commentary 永远不混进答案文本。

两套"_current"令牌值得细读：`_request_is_current` 挡**已退役请求**的迟到帧；
`_writer_is_current` 挡**被更新尝试顶替**的 writer——注意后者只是让旧尝试闭嘴，
消费照常进行到底，否则网关会拿到一条丢了尾巴的"completed"响应（#69486）。

### 6. codex_headers —— 身份、账户头与压缩（codex_headers.py:34）

```python
# agent/codex_headers.py:34-51 + 54-63（节选）
def codex_cloudflare_headers(access_token: str, *, base_url: str = CODEX_AUX_BASE_URL) -> dict[str, str]:
    """Identity and account headers for chatgpt.com/backend-api/codex.

    OpenAI requires third-party harnesses to identify themselves: the official
    endpoint gets Hermes' originator and version, custom endpoints keep the
    codex_cli_rs compatibility identity. The account headers come from the
    OAuth JWT (see :func:`codex_account_headers`).
    """
    if is_official_codex_base_url(base_url):
        headers = {
            "User-Agent": f"HermesAgent/{get_version_info().base_version}",
            "originator": "hermes-agent",
        }
    else:
        headers = {"User-Agent": "codex_cli_rs/0.0.0 (Hermes Agent)", "originator": "codex_cli_rs"}
    headers.update(codex_account_headers(access_token))
    return headers
```

官方端点亮明 Hermes 身份；自定义端点保持 `codex_cli_rs` 兼容身份（第三方代理按 codex
客户端白名单放行）。`codex_account_headers`（:54-81）从 OAuth JWT 的
`https://api.openai.com/auth` 声明里挖出 `ChatGPT-Account-ID` 与数据驻留头——缺驻留头
的驻留强制工作区直接 401 "Workspace is not authorized in this region"。畸形 token 丢弃
头部而不抛异常，让问题以 401 面目出现而不是构造期崩溃。另有
`codex_request_compression_hooks`（:84-103）：官方后端上的 POST /responses 请求体做
zstd 压缩（与官方 codex 客户端对齐，无损传输编码，token 与提示词缓存不受影响）。

模块定位也要注意：它是**叶子模块**，故意不依赖庞大的 auxiliary-client 路由器——长寿命
进程可以 import 新增的 client builder 而不必从旧缓存的 auxiliary_client 模块解析新符号
（:1-4 docstring）。

### 7. codex_service_tiers —— 目录驱动的档位协商（codex_service_tiers.py:188）

```python
# agent/codex_service_tiers.py:188-212
def negotiate_request_tier(agent: Any, overrides: dict[str, Any]) -> None:
    """Resolve the current credential on each build without mutating user preference."""
    from agent.codex_headers import is_official_codex_base_url
    requested = overrides.get("service_tier")
    base_url = str(getattr(agent, "base_url", "") or "")
    if (requested not in {"ultrafast", "priority"}
            or getattr(agent, "api_mode", None) != "codex_responses"
            or getattr(agent, "provider", None) != "openai-codex"
            or not is_official_codex_base_url(base_url)):
        return
    token = getattr(agent, "api_key", None)
    if not isinstance(token, str) or not token:
        return
    model = overrides.get("model", getattr(agent, "model", ""))
    supported = _tiers_for_model(token, base_url, model)
    if supported is None:
        return
    candidates = ("ultrafast", "priority") if requested == "ultrafast" else ("priority",)
    effective = next((tier for tier in candidates if tier in supported), "default")
    if effective == "default":
        overrides.pop("service_tier", None)  # Codex represents Standard by omission.
    else:
        overrides["service_tier"] = effective
```

模块 docstring（:1-5）定了调：**未知的发现保留请求档位；只有显式公告的档位清单才允许
降级；响应回显永不驱动选择或重试**。Daybreak 反其道而行——只在目录显式列出
`daybreak_blue` 时才请求（`apply_daybreak`，:143-162，每请求检查，模型切换/凭据轮转/
目录过期都不会把 program 带到不该带的模型或账户上）。ULTRAFAST 则必须协商：后端会
对没有授权的计划静默按默认档服务，所以官方客户端读的那个账户目录才是权威
（`ultrafast_offered`，:165-179）。三条规则同一动机：**宁可保守，不可假装**。

### 8. codex_responses_adapter —— endpoint quirks 与 blob 签发者（codex_responses_adapter.py:23）

```python
# agent/codex_responses_adapter.py:23-48 + 56-62（节选）
class ResponsesEndpointQuirks(NamedTuple):
    """Responses wire quirks of the endpoint, from the ``responses_*`` fields of the profile claiming it
    (``providers.profile_for_host``). Defaults are the generic wire."""
    replay_item_ids: bool = True
    prompt_cache_key: bool = True
    issuer_kind: str = ""
    native_compaction: bool = True
    profile_reasoning: bool = False


def responses_endpoint_quirks(base_url: Any) -> ResponsesEndpointQuirks:
    """Quirks for *base_url*; the generic wire when no registered profile claims it (or none is installed).
    Pure function of the URL and the registry, so every turn replays the same bytes for the same history."""
    from providers import profile_for_host
    profile = profile_for_host(str(base_url or ""))
    if profile is None:
        return _GENERIC_ENDPOINT
    return ResponsesEndpointQuirks(
        replay_item_ids=profile.responses_replay_item_ids, prompt_cache_key=profile.responses_prompt_cache_key,
        issuer_kind=profile.responses_issuer_kind, native_compaction=profile.responses_native_compaction,
        profile_reasoning=profile.responses_profile_reasoning,
    )
```

quirks 是 URL 与注册表的**纯函数**（同样的历史每 turn 重放出同样的字节，缓存才不冷）。
另一个关键概念是"签发者"（issuer）：reasoning 的 `encrypted_content` blob 被**密封到签发
它的端点**（HTTP 400 `invalid_encrypted_content`），`_classify_responses_issuer`（:56-72）
给每个端点盖稳定戳——模型切换后重放才能把外来 blob 丢掉。注释还特别叮嘱：openai SDK
会给 `client.base_url` 加尾斜杠、host 大小写不敏感，主传输与 aux 适配器必须把端点**规范化
成同一种 kind**，否则 aux 调用会丢掉主循环铸造的每一个 blob。

---

## 核心类/函数

| 符号 | 职责 | 位置 |
|---|---|---|
| `run_codex_app_server_turn` | 把一个 turn 移交给 codex 子进程并投影事件 | `agent/codex_runtime.py:748` |
| `_ensure_codex_session` | 惰性 spawn 会话；合成/provider 漂移退役；种子注入 | `agent/codex_runtime.py:599` |
| `make_codex_app_server_event_bridge` | codex 通知 → 网关 UI 回调（进度/流式 delta） | `agent/codex_runtime.py:375` |
| `run_codex_stream` | 一条原始 SSE Responses 流式请求（fenced 回调、重试） | `agent/codex_runtime.py:1192` |
| `_CodexResponseAssembler` | 从 output_item.done 组装 Response 形态（不信终帧 output） | `agent/codex_runtime.py:873` |
| `_record_codex_app_server_usage` | 子进程 turn 的 token 用量记账 | `agent/codex_runtime.py:149` |
| `render_history_seed` | 前文 → 一次性 developerInstructions 种子（保尾 32k 字符） | `agent/codex_runtime_history_seed.py:53` |
| `CodexAppServerClient` | stdio JSON-RPC 2.0 客户端（同步，读线程+队列） | `agent/transports/codex_app_server.py:83` |
| `CodexAppServerSession` | 一线程一 Hermes 会话：run_turn、审批桥、取消翻译 | `agent/transports/codex_app_server_session.py` |
| `TurnResult` | 子进程 turn 的结果（projected_messages、should_retire…） | `agent/transports/codex_app_server_session.py:42` |
| `CodexEventProjector` | item/* → OpenAI 消息；reasoning stash；交替不变量 | `agent/transports/codex_event_projector.py:42` |
| `ResponsesEndpointQuirks` / `responses_endpoint_quirks` | 端点 wire 怪癖（URL+注册表的纯函数） | `agent/codex_responses_adapter.py:23,36` |
| `_classify_responses_issuer` | 加密 blob 的签发者戳（跨端点重放丢弃外来 blob） | `agent/codex_responses_adapter.py:56` |
| `strip_unverified_reasoning_items` | 重放前剥离不可信 blob | `agent/codex_responses_adapter.py:125` |
| `codex_cloudflare_headers` / `codex_account_headers` | 身份头 + JWT 派生账户/驻留头 | `agent/codex_headers.py:34,54` |
| `codex_request_compression_hooks` | 官方后端 zstd 请求体压缩钩子 | `agent/codex_headers.py:84` |
| `negotiate_request_tier` | 每请求按账户目录协商 service_tier（不 mutating 偏好） | `agent/codex_service_tiers.py:188` |
| `apply_daybreak` | 目录列出才挂 `access_programs.cyber: daybreak_blue` | `agent/codex_service_tiers.py:143` |
| `daybreak_offered` / `ultrafast_offered` | 开关可见性判定（Unknown=False，不假装有货） | `agent/codex_service_tiers.py:124,165` |

## 本组文件清单

| 文件 | 一句话角色 |
|---|---|
| `agent/codex_responses_adapter.py` | 无状态 Responses 转换/normalize：输入项、加密 blob、endpoint quirks、preflight |
| `agent/codex_runtime.py` | 两条运行时入口：app-server turn 移交 + 原始 SSE 流式；事件桥、用量记账 |
| `agent/codex_runtime_history_seed.py` | fresh codex 线程的历史种子（developerInstructions，保尾 32k） |
| `agent/codex_service_tiers.py` | ultrafast/priority/Daybreak：账户目录权威、显式才降级/请求 |
| `agent/codex_headers.py` | 请求身份/账户/驻留头 + zstd 压缩钩子（叶子模块，不依赖 aux 路由器） |
| `agent/transports/codex.py` | Responses 传输层：prompt_cache_key、effort 钳制、保留名别名 |
| `agent/transports/codex_app_server.py` | codex app-server 的 stdio JSON-RPC 客户端（握手/thread/turn/interrupt） |
| `agent/transports/codex_app_server_session.py` | 会话适配器：一线程一会话、审批桥接、TurnResult、多路复用防护 |
| `agent/transports/codex_event_projector.py` | item/* 通知 → OpenAI 形态消息（交替不变量、确定性 call id） |

## 与其他模块的关系

```
agent_init._resolve_api_mode ── codex_responses / codex_app_server
        │
        ▼
turn_api_call ─┬─ api_mode=codex_responses ─► transports/codex.py ─► codex_responses_adapter
               │        └─ 流式 ─► codex_runtime.run_codex_stream ─► _CodexResponseAssembler
               └─ api_mode=codex_app_server ─► codex_runtime.run_codex_app_server_turn
                        └─► transports/codex_app_server(_session) ─► codex_event_projector
```

- **凭据**：Codex OAuth token 的解析/轮转住在 `credential_pool.py` 与
  `anthropic_credentials.py` 平行的凭据层（见 credentials_rate.md）；`_finalize_routing`
  里 GPT-5.x 自动升 Responses 的判定在 agent_init.py:379-401。
- **回退**：子进程路径失败时 `turn_recovery.activate_codex_app_server_fallback`
  （turn_recovery.py 家族）激活回退；错误分类走 `agent/error_classifier`。
- **审批**：`tools.terminal_tool` 的审批回调与 `tools.approval` 的 bypass 判定在此桥接；
  codex 自带工具（terminal/file/search）不进 Hermes 的工具面。
- **MCP**：`hermes_tools_mcp_server.py` 把 Hermes 侧工具暴露给 codex 子进程
  （见 model_providers.md §6）。
- **辅助调用**：aux 侧的 Responses 适配在 `auxiliary_codex_response.py`；prompt_cache_key
  的共享哈希让 aux 与主传输命中同一缓存桶（transports/chat_completions.py:101）。

## 总结

- **两种 codex 形态**：HTTP Responses（Hermes 拥有 loop）与 codex_app_server
  （codex 拥有 loop，Hermes 投影事件、管审批、拼接转录）。后者返回值刻意对齐
  chat_completions 的结果形状，上游无感。
- **线程是模型侧资产**：合成漂移退役、只有首个会话 resume、绑定只在转录落库后发布、
  退役线程永不发布；fresh 线程用 32k 保尾的历史种子补课，不许失忆。
- **投影有纪律**：只物化 item/completed、reasoning stash 到下一条 assistant、
  每个至多一条 assistant+一条 tool、未知类型不伪造结构、确定性 call id 保缓存。
- **流式防御成对出现**：退役请求的迟到帧（fenced）与被顶替 writer 的帧（superseded）
  分别隔离；superseded 只静音不中断——消费到完成，尾巴不能丢（#69486）。
- **身份与档位都向"权威目录"看齐**：官方端点亮 Hermes 身份、自定义端点保持 codex 兼容；
  service_tier 只有显式公告才降级、Daybreak 只在目录列出才请求、响应回显永不驱动决策。
- **endpoint quirks 是纯函数**：URL+注册表决定线形怪癖与 blob 签发者，保证同样历史
  每次重放出同样字节。
