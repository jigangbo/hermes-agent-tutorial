# 08.2 RPC 传输层 —— 换行分隔的 JSON-RPC、双向请求与 Transport 家族

## 文件概览

| 文件 | 行数 | 角色 |
|------|------|------|
| `tui_gateway/transport.py` | 359 | `Transport` 协议 + `StdioTransport` / `FanoutTransport` / `TeeTransport` |
| `tui_gateway/ws.py` | 763 | WebSocket 传输：读循环、队列车道、token 合并、重放 |
| `tui_gateway/entry.py` | 425 | stdio 传输：stdin 读循环（现主要供开发 harness） |
| `tui_gateway/server_requests.py` | 436 | server→client 请求：`send()` 阻塞等待应答 |
| `tui_gateway/rpc_dispatch.py` | 100 | JSON-RPC 准入 + worker 池分发（重绑定到 server 命名空间） |

## 关键代码走读

### 1. wire：一种帧格式，两种承载

`ws.py` 的模块 docstring 一句话立住整层的设计原则——**两个传输共用同一个 dispatcher**：

```text
# tui_gateway/ws.py:1-4 (docstring 节选)
"""WebSocket transport for the tui_gateway JSON-RPC server: reuses :func:`tui_gateway.server.dispatch`
verbatim so every RPC, slash command, approval flow and agent event takes the same handlers as Ink over
stdio. Wire protocol is identical to stdio (newline-delimited JSON-RPC both ways; ``gateway.ready`` right
after accept). Mount as ``@app.websocket("/api/ws") async def ws(ws): await handle_ws(ws)``."""
```

协议是 peer-to-peer 的 JSON-RPC，双向都是换行分隔帧。stdio 侧的读循环（`entry.py:387-421`）逐行 `json.loads` 后交给 `dispatch`；WS 侧入口是 `handle_ws`（`ws.py:431`）。连接建立后第一帧都是 `gateway.ready`（携带 skin、`change_events`、`replay_epoch`），`entry.py:371-375` 就是 stdio 侧的发射点。

### 2. Transport 协议与 ContextVar

```python
# tui_gateway/transport.py:37-59 (节选)
@runtime_checkable
class Transport(Protocol):
    """Minimal interface every transport implements."""

    def write(self, obj: dict) -> bool:
        """Emit one JSON frame. Return ``False`` when the peer is gone."""

    def close(self) -> None:
        """Release any resources owned by this transport."""

_current_transport: contextvars.ContextVar[Optional[Transport]] = contextvars.ContextVar(
    "hermes_gateway_transport", default=None
)
```

请求的传输放在 ContextVar 里，这样 worker 池里的 handler 写回正确的 peer；没有绑定时 `write_json` 回落到模块级 `StdioTransport`（惰性解析 `_real_stdout`，测试 monkey-patch 才能生效）。

三个实现各有分工：

- **`StdioTransport`**（98-130 行）：串行锁 + flush；`write()` 返回 `False` 仅表示 peer 已走，其他错误必须 re-raise 进 crash log（`_raise_unless_peer_gone`，66-80 行）——UnicodeEncodeError 不能伪装成"干净断开"。
- **`FanoutTransport`**（143 行起）：多订阅者的**有界**信箱。慢 socket 不许拖住发射 turn 或健康订阅者——`_MAX_PENDING_FRAMES = 16384`、`_MAX_PENDING_BYTES = 4MB`，溢出者丢订阅、被关闭让客户端重连重放。
- **`TeeTransport`**（334 行起）：PTY 子进程用——每帧同时写 stdio（Ink）和 back-WS（仪表盘侧边栏），副通道尽力而为绝不阻塞主路。

序列化集中在 `serialize_frame`（83-95 行）：不可序列化的 payload 变成带原 id 的 `-32603` 错误帧，而不是让 executor 吞掉 TypeError 后客户端永远等待（#92506）。

### 3. server→client 请求：agent 问用户

这是协议最独特的半边。每个"问渲染器"的桥（clarify、approval、sudo、secret、vault 提示、桌面 GUI 读、MCP 安装同意、tour）都是一次 `send()` 加一个应答帧——没有成对的 `*.request` 通知 / `*.respond` 方法。

```python
# tui_gateway/server_requests.py:53-98 (节选)
class ServerRequest:
    def __init__(self, sid: str, method: str, params: dict, *, qids=None, on_result=None) -> None:
        self.id = f"srq-{uuid.uuid4().hex[:12]}"
        self.sid = sid
        self.method = method
        self.params = dict(params)
        self.replayable = can_replay_request(method, params)
        self.event = threading.Event()
        self.result: dict | None = None
        ...

    def frame(self) -> dict:
        return {"jsonrpc": "2.0", "id": self.id, "method": self.method,
                "params": {"session_id": self.sid, **self.params}}
```

id 是 `srq-<12 hex>`：字符串永不与客户端铸造的整数 id 冲突，随机部分让 compute-host 子进程的请求与父进程的到达同一 socket 时也能区分。

`send()` 在 agent 线程上阻塞等待：

```python
# tui_gateway/server_requests.py:208-248 (节选)
def send(method: str, sid: str, params: dict, *, timeout: float | None,
         qids=None, transport=None) -> dict | None:
    """Send one request and block for the response ``result`` (a dict).

    Returns ``None`` when the renderer never answered (timeout, cancel, or an error response ...).
    """
    if transport is None and _unanswerable(method, sid):
        return None
    req = ServerRequest(sid, method, params, qids=qids)
    req.transport = transport
    _register(req)
    try:
        req.event.wait(timeout)
    except BaseException:
        # The wait itself died ...: withdraw the request or it stays in _open forever
        with _lock:
            still_open = _open.pop(req.id, None) is req
        if still_open:
            _emit_cancel(req, "interrupted")
        raise
    with _lock:
        # The verdict is the state committed under the lock, never wait()'s return value ...
        timed_out = _open.pop(req.id, None) is req
        answered, result, locked = req.answered, req.result, dict(req.locked)
    if answered:
        return result
    if timed_out:
        _emit_cancel(req, "timeout")
        ...
    return None
```

超时/取消发出**一条** `request.cancel {id, method, reason}` 事件，所有渲染器用同一方式拆卡。已不在 `_open` 里的应答帧直接丢弃——等待早已返回。重连路径：未应答的请求由 `session.resume` / `session.events.since` 经 `open_requests(sid)`（394 行）重放，通知重放环永远不必携带"还在等答案的问题"。

两个护栏值得记住：

- **能力协商**：客户端连接时声明 `client.capabilities {server_requests: true}` → `advertise()`（148 行）登记；从不声明的 WS 客户端是"早于 server→client 请求的构建"，`send()` 快速返回 `None` 而不是让 agent 白等 clarify 的 300 秒（#112548）。
- **窗口归属**：`preview.read` / `preview.act` / `terminal.read` / `window.read` / `tour` 只由显示该会话的窗口应答；其他窗口以 `NOT_SHOWN_CODE = 4404`（131 行）谢绝，且谢绝不结算请求——除非所有应答客户端都谢绝了（#113348/#119333）。

### 4. dispatch：长 handler 进 worker 池

```python
# tui_gateway/rpc_dispatch.py:50-96 (节选)
def dispatch(req: dict, transport: Optional[Transport] = None) -> dict | None:
    """Route inbound RPCs — long handlers to the pool (returns None; the worker writes its own
    response via the bound transport), everything else inline (returns the response dict)."""
    t = transport or _stdio_transport
    token = bind_transport(t)
    try:
        from tui_gateway import server_requests
        if server_requests.is_response_frame(req):
            # The renderer answering one of OUR requests (clarify, approval, ...): no response frame goes back.
            if not server_requests.resolve_response(req, t) and not _relay_compute_host_response(req):
                logger.debug("dropping response for unknown server request id=%r", req.get("id"))
            return None
        normalized = _normalize_request(req)
        if isinstance(normalized, dict):
            return normalized
        if normalized[1] not in _LONG_HANDLERS:
            return handle_request(req)
        ...
        ctx = contextvars.copy_context()  # the pool worker must see the bound transport
        ...
        def run():
            try:
                resp = _handle_admitted_request(req)
            except Exception as exc:
                ...
                resp = _err(req.get("id"), -32000, f"handler error: {exc}")
            if resp is not None:
                t.write(resp)
        future = _pool.submit(lambda: ctx.run(run))
        ...
        return None
    finally:
        reset_transport(token)
```

分发决策：先判**应答帧**（渲染器回答我们的问题，原路返回 `None`），再判 `retirement`（后端退役期统一拒答 5035），再走准入 `_handle_admitted_request`（8-47 行）——契约校验（未知参数键回 `4000` 带字段路径）→ 执行 handler → `check_params_accepted`/`check_result` 回验。列入 `_LONG_HANDLERS` 的方法复制 context 后投进 `_pool`，worker 自己写应答帧。

### 5. WS 读循环的车道

`handle_ws` 不是简单串行——一个长 handler 不许饿死心跳：

- `_WS_DISPATCH_QUEUE_MAX = 256`（99 行）：每连接一个 dispatcher 任务按到达序消费队列，读循环继续应答 `gateway.ping`。
- 并发读车道：`session.context_breakdown`、`session.transcript` 这类只投影已有状态的昂贵读进 `_WS_CONCURRENT_READ_LIMIT = 2` 的并发槽（104-107 行）。
- `clarify.lock` 与一切应答帧**绝不排队**——串行车道上可能正跑着等它答案的 handler。
- 流式 token 合并：`message.delta` / `reasoning.delta` / `thinking.delta` 缓冲 33ms（约 30fps）批量刷，其余事件刷缓冲前先走，保持顺序（128-130 行）。

### 6. write_json：出帧的最后一站

```python
# tui_gateway/server.py:567-584 (节选)
def write_json(obj: dict) -> bool:
    """Emit one JSON frame via the most-specific transport: (1) event frames with a session id → that
    session's transport (async events reach the owner even from threads with no contextvar binding);
    (2) the context-bound transport (:func:`dispatch`); (3) module stdio (tests monkey-patch ``_real_stdout``).
    Every event frame gets a per-session monotonic ``seq`` + replay-ring entry so ``session.events.since`` can resume."""
    from tui_gateway.event_replay import _stamp_event
    from tui_gateway.hosted_room_member_activity import project_room_member_activity
    _stamp_event(obj)
    params = obj.get("params")
    if obj.get("method") == "event" or (isinstance(obj.get("id"), str) and "method" in obj):
        # Event notifications AND server→client requests carry ``params.session_id``; both route to the
        # owning session's transport. ...
        project_room_member_activity(obj, _sessions)
        sid = ((params or {}).get("session_id")) if isinstance(params, dict) else ""
        if sid and (t := (_sessions.get(sid) or {}).get("transport")) is not None:
            return t.write(obj)
    return (current_transport() or _stdio_transport).write(obj)
```

三级路由：会话事件帧 → 会话自己的 transport；server→client 请求同样带 `session_id` 走同一路径；都没有才走 context 绑定/stdio。每个事件帧顺路盖上 per-session 单调 `seq` 并落进重放环。

## 核心类/函数

| 名称 | 位置 | 职责 |
|------|------|------|
| `Transport`（Protocol） | `tui_gateway/transport.py:37` | `write(obj)->bool` + `close()` 最小接口 |
| `serialize_frame` | 同上 :83 | JSON 编码；失败降级为 `-32603` 错误帧 |
| `StdioTransport` | 同上 :98 | 串行锁写 stdout；peer-gone 才返回 False |
| `FanoutTransport` | 同上 :143 | 多订阅者有界信箱；溢出摘除订阅 |
| `TeeTransport` | 同上 :334 | 主路 + 尽力而为副路（PTY→侧边栏镜像） |
| `handle_ws` | `tui_gateway/ws.py:431` | 一个 WS 连接的完整生命周期 |
| `main` / `_serve` | `tui_gateway/entry.py:321/333` | stdio 入口：抢占启动家、发 `gateway.ready`、读循环 |
| `ServerRequest` | `tui_gateway/server_requests.py:53` | 一条 server→client 请求：id/sid/事件/锁/应答 |
| `send` / `send_async` | 同上 :208/:251 | 阻塞问 / 回调问；均先过 `_unanswerable` 能力闸 |
| `resolve_response` / `cancel` / `open_requests` | 同上 :302/:368/:394 | 应答结算 / 撤回 / 重连重放快照 |
| `dispatch` | `tui_gateway/rpc_dispatch.py:50` | 入站路由：应答帧 / 长任务池 / 内联 |
| `write_json` | `tui_gateway/server.py:567` | 出帧三级路由 + `seq` 盖章 |

## 本组文件清单

| 文件 | 一句话 |
|------|--------|
| `tui_gateway/transport.py` | Transport 协议、Stdio/Fanout/Tee、`serialize_frame`、ContextVar 绑定 |
| `tui_gateway/ws.py` | WebSocket 传输：车道队列、token 合并、重放 epoch、会话权威接入 |
| `tui_gateway/entry.py` | stdio 传输：stdin 读循环、私有 RPC stdin（Windows NUL 交换）、sidecar 发布器 |
| `tui_gateway/server_requests.py` | server→client 请求全生命周期 + `NOT_SHOWN` 谢绝协议 |
| `tui_gateway/rpc_dispatch.py` | 准入 + 契约校验 + worker 池分发 |
| `tui_gateway/ws_legacy_fallback.py` | 票务 socket 上非会话方法的 legacy 回退授权 |
| `tui_gateway/_stdin_recovery.py` | 伪 EOF（子进程翻转 O_NONBLOCK）与真 EOF 的区分 |
| `tui_gateway/event_replay.py` | per-session `seq` + 有界重放环（详见 methods_slash.md） |

## 与其他模块的关系

- `tui_gateway/server.py`：`dispatch`/`write_json`/`_ok`/`_err` 都住在门面里，`rpc_dispatch.py` 经 `method_ctx.bind_module` 重绑定后裸引用它们。
- `apps/shared`（TS）：`JsonRpcGatewayClient` + `onRequest` 是客户端半边；`gateway-events.ts` 在契约之上加客户端本地合成事件。
- `gateway/scale_to_zero.py`：WS 客户端每 15s ping 一次，`ws.py` 节流触碰心跳标记文件，让网关 owner 的空闲判定知道"还有 dashboard 客户端挂着"。
- `event_replay.py`：`replay_epoch()` 让客户端识别服务器重启（seq 归 1）并重置水位线。

## 总结

传输层的一切都可以从一句话推出：**peer-to-peer 的换行分隔 JSON-RPC，两种承载（WS/stdio）共用一个 dispatcher**。三个方向（方法调用 / server→client 请求 / 事件通知）中，最需要工程纪律的是中间那个——`send()` 阻塞 agent 线程，所以能力协商、窗口谢绝协议、`request.cancel` 撤回、重连重放缺一不可。理解 `dispatch` 的三岔口（应答帧→结算、长任务→池、其余→内联）和 `write_json` 的三级路由，你就掌握了这条 wire 上的每一次呼吸。
