# 08.1 进程模型 —— 附加、空闲退出与多 profile 作用域

tui_gateway 的进程模型只有一条主轴：**渲染器附加到共享网关 owner，绝不 spawn 私有 agent**。这一篇读三组文件：附加链（`gateway_runtime_attach.py`）、承载进程（`server.py` 的 profile 作用域）、以及可选的 turn 隔离子进程（`host_supervisor.py` + `compute_host.py`）。

## 文件概览

| 文件 | 行数级 | 角色 |
|------|--------|------|
| `hermes_cli/gateway_runtime_attach.py` | 97 | 一次客户端附加：发现/拉起 owner，铸造一次性票据 |
| `ui-tui/scripts/gateway_bootstrap.py` | 83 | Ink 的附加引导，薄包装上一行 |
| `tui_gateway/server.py` | 2041 | JSON-RPC 门面：方法表、会话表、`@_profile_scoped` |
| `tui_gateway/launch_profile_policy.py` | 244 | 多 profile 托管的策略开关与环境冻结 |
| `tui_gateway/host_supervisor.py` | — | compute-host 子进程的监督者（dashboard.turn_isolation） |
| `tui_gateway/compute_host.py` | — | 持久 compute-host 子进程本体：行 JSON over stdin/stdout |

## 关键代码走读

### 1. 附加：一次调用找到（或拉起）owner 并铸造票据

`attach_gateway` 是任何本地客户端（`hermes gateway attach`、Ink bootstrap）共同走的唯一入口：

```python
# hermes_cli/gateway_runtime_attach.py:68-97 (节选)
def attach_gateway(home: str | Path, *, start: bool, recover: bool = False, timeout: float) -> GatewayAttach:
    home = gateway_profile_home(home)
    receipt = (ensure_gateway_runtime(home, timeout=timeout, idle_exit=True) if start
               else discover_gateway_endpoint(home, timeout=min(timeout, DISCOVER_TIMEOUT)))
    if not start and recover and not attachable(receipt):
        receipt = ensure_gateway_runtime(home, timeout=timeout, idle_exit=True)
    if not attachable(receipt):
        return GatewayAttach(receipt)
    try:
        # A profile served by the default multiplexer has no socket of its own; the host mints its ticket.
        return GatewayAttach(receipt, _session_ticket(home, receipt.endpoint))
    except DiscoveryError as exc:
        raise TicketUnavailable(exc.reason, exc.bounded_detail(500)) from exc
```

注意三点：`idle_exit=True`——由此拉起的 daemon **空闲自灭**，这正是"Ink 关掉 TUI 后 owner 不会永久驻留"的机制；`--recover` 模式在 owner 崩溃/空闲退出/被 stop/版本过旧时重新 ensure，让打开着的 TUI 能自愈；票据是**一次性凭据**，"never log it, never put it in a repr"（模块 docstring 原话）。

附加前还有一步防污染——把客户端启动期的策略性环境变量从进程里剥掉，否则拉起的 daemon 会把这些值当作 daemon 级默认：

```python
# hermes_cli/gateway_runtime_attach.py:20-25, 30-35 (节选)
CLIENT_LAUNCH_ENV = (
    "HERMES_MODEL", "HERMES_INFERENCE_MODEL", "HERMES_TUI_PROVIDER", "HERMES_INFERENCE_PROVIDER",
    "HERMES_TUI_TOOLSETS", "HERMES_TUI_SKILLS", "HERMES_CWD", "TERMINAL_CWD", "HERMES_YOLO",
    "HERMES_ACCEPT_HOOKS", "HERMES_TUI_CHECKPOINTS", "HERMES_TUI_PASS_SESSION_ID", "HERMES_KANBAN_BOARD",
    "HERMES_TUI_CLIENT_ENV",
)

def scrub_client_launch_env() -> None:
    for key in CLIENT_LAUNCH_ENV:
        os.environ.pop(key, None)
```

注释点明原因：`hermes --tui` 钉住的看板 `HERMES_KANBAN_BOARD` 如果传进 daemon，会让**之后**的每一场 chat、每个 Desktop 窗口、每个 cron 任务都解析到这台终端的启动期看板，而不是各 profile 自己的 `kanban/current`。启动策略应在 `session.create` 里随会话旅行，不进 daemon 默认。

Ink 侧的引导只是薄包装（`ui-tui/scripts/gateway_bootstrap.py:53`）：

```python
# ui-tui/scripts/gateway_bootstrap.py:53-64 (节选)
    attached = attach_gateway(get_hermes_home().resolve(), start=start, recover=recover, timeout=30)
    ...
    endpoint = attached.receipt.endpoint
    url, protocols = gateway_ws_target(endpoint, attached.ticket)
    return {"url": url, "protocols": protocols,
            "profile_id": endpoint.profile_id, "instance_id": endpoint.instance_id}
```

### 2. 多 profile：第一个"第二个家"改变整个进程

一个 `serve`/dashboard 进程可能承载多个 profile 家。`server.py::_profile_home` 在注册第二个家时触发策略翻转：

```python
# tui_gateway/server.py:467-477 (节选)
    if home.resolve() == Path(_hermes_home).resolve():
        return None  # already the launch profile (no override needed)
    if home not in _served_profile_homes:
        # This process now hosts a second profile home: freeze the launch env as the launch
        # profile's own and flip get_secret() to fail closed, so an unscoped read for a
        # secondary raises instead of returning the launch profile's os.environ value
        from tui_gateway.launch_profile_policy import activate_multi_profile_hosting
        activate_multi_profile_hosting()
    _served_profile_homes.add(home)
```

而 `launch_profile_policy.py` 的模块 docstring 是理解这一整层的钥匙：多路复用激活**之前**，一个未被作用域包裹的 `get_secret()` 调用会静默借到启动 profile 的 `os.environ` 值——这是最危险的 fail-open。激活后读失败改为抛异常：

```python
# tui_gateway/launch_profile_policy.py:46-51
def activate_multi_profile_hosting() -> None:
    """This process now hosts a profile home other than its launch home: freeze the launch env
    and make unscoped credential reads fail closed (``get_secret`` raises instead of borrowing)."""
    from agent.secret_scope import set_multiplex_active
    capture_launch_env()
    set_multiplex_active(True)
```

`capture_launch_env()`（33-43 行）在第一个次要家注册**前**把 `os.environ` 快照冻结——"最后一次可证明环境属于启动 profile 的时刻"。此后启动 profile 自己的 turn 也必须走 `launch_secret_scope`（冻结 env + 自己的 `.env`），不再读活体环境，因为次要上下文可能已污染了 `os.environ`（#107422）。

### 3. `@_profile_scoped`：每个触状态方法的护栏

```python
# tui_gateway/server.py:485-514 (节选)
def _profile_scoped(handler):
    """Bind ``params['profile']``'s full runtime scope (HERMES_HOME + secrets + terminal policy) around a
    handler, ...
    No ``profile`` param but a ``session_id`` naming a live session: that session's ``profile_home``
    is the scope. ... a ``config.set`` from a focused worker session otherwise persisted into the
    LAUNCH profile's config.yaml while the worker's stayed unchanged (#85669)."""
    def wrapper(rid, params):
        p = params if isinstance(params, dict) else {}
        if str(p.get("profile") or "").strip():
            home = _profile_home(p.get("profile"))
            profile_home = str(home) if home else None
        else:
            session = _sessions.get(str(p.get("session_id") or ""))
            profile_home = session.get("profile_home") if isinstance(session, dict) else connection_profile_home()
        with _session_profile_runtime_scope({"profile_home": profile_home or None}):
            return handler(rid, params)
    return wrapper
```

作用域令牌（home + secret scope + terminal scope）由 `model_switch.py::_profile_runtime_scope_tokens(profile_home)` 生成。docstring 给出的反例值得记住：**只设 `get_hermes_home_override()` 的方法是"半绑定"**——config 路径解析对了，凭据和 `TERMINAL_*` 策略还是启动 profile 的。排查方式：`rg -n "^(async )?def " tui_gateway/methods_*.py | rg -v _profile_scoped`。

### 4. compute-host：可选的 turn 隔离子进程

`dashboard.turn_isolation` 开启时，agent turn 跑在一个持久的 `python -m tui_gateway.compute_host` 子进程里，避免重 agent 线程与事件循环争 GIL。监督者维护一张路由表，声明每个 mutator 方法如何穿越进程边界：

```python
# tui_gateway/host_supervisor.py:28-35
MUTATOR_ROUTE_TABLE: dict[str, str] = {
    "prompt.submit": "turn-path", "session.interrupt": "turn-path", "reload.mcp": "run-concurrent",
    "session.save": "run-concurrent", "session.compress": "idle-gated",
    "prompt.submit.truncate": "idle-gated", "slash.model": "idle-gated",
    "slash.personality": "idle-gated", "slash.prompt": "idle-gated", "slash.compress": "idle-gated",
    "slash.refine": "idle-gated",
    "session.reset": "idle-gated", "session.history.reload": "idle-gated",
    "slash.retry": "idle-gated"}
```

子进程本体（`compute_host.py`）用帧类型 → 处理器方法名的表分发：

```python
# tui_gateway/compute_host.py:61-66
class ComputeHost:
    # frame ``type`` -> handler method name (resolved per call so monkeypatches take effect).
    _FRAME_HANDLERS: dict[str, str] = {
        "turn.start": "_handle_turn_start", "interrupt": "_handle_interrupt",
        "respond": "_handle_respond", "reload_mcp": "_handle_reload_mcp",
        "control": "_handle_control", "shutdown": "_handle_shutdown"}
```

## 核心类/函数

| 名称 | 位置 | 职责 |
|------|------|------|
| `attach_gateway` | `hermes_cli/gateway_runtime_attach.py:68` | 发现/拉起 owner + 铸造一次性票据（`GatewayAttach`） |
| `scrub_client_launch_env` | 同上 :30 | 附加前剥离 `CLIENT_LAUNCH_ENV` 策略变量 |
| `activate_multi_profile_hosting` | `tui_gateway/launch_profile_policy.py:46` | 冻结启动 env + 翻转 `get_secret` fail-closed |
| `activate_multi_profile_hosting_eagerly` | 同上 :71 | 宿主启动时一次性判定（懒激活会漏掉已跑过的启动期工作） |
| `launch_profile_runtime_scope` | 同上 :187 | 启动 profile 的完整运行时作用域（home+secret+terminal） |
| `_profile_scoped` | `tui_gateway/server.py:485` | 方法装饰器：按 `profile`/`session_id` 解析作用域 |
| `_profile_home` | 同上 :455 附近 | 解析 profile 名 → 家目录；第二个家触发策略翻转 |
| `ComputeHost` | `tui_gateway/compute_host.py:61` | turn 隔离子进程：帧分发、心跳、父进程守卫 |
| `MUTATOR_ROUTE_TABLE` | `tui_gateway/host_supervisor.py:28` | mutator 方法 → turn-path/run-concurrent/idle-gated |
| `_claim_launch_home` | `tui_gateway/entry.py:303` | stdio 服务器用 `gateway.lock` 抢占启动家，冲突即拒 |

## 本组文件清单

| 文件 | 一句话 |
|------|--------|
| `tui_gateway/server.py` | 门面：方法表 `_methods`、会话表 `_sessions`、`write_json`、`@_profile_scoped` |
| `tui_gateway/launch_profile_policy.py` | 多 profile 托管策略：环境冻结、fail-closed 翻转、启动 profile 作用域 |
| `tui_gateway/host_supervisor.py` | compute-host 监督：注册表 `dashboard-compute-host.json`、重生窗口、控制帧等待 |
| `tui_gateway/compute_host.py` | compute-host 子进程：turn 线程池、心跳、`shutdown` 排空 |
| `tui_gateway/compute_host_bridge.py` | 父进程侧的 compute-host RPC 桥 |
| `tui_gateway/entry.py` | stdio JSON-RPC 入口（现主要供开发 harness） |
| `hermes_cli/gateway_runtime_attach.py` | 附加原语（owner 发现 + 票据），CLI 与 Ink 共用 |
| `ui-tui/scripts/gateway_bootstrap.py` | Ink 的附加引导（TS 经 `localGatewayBootstrap.ts` 调起） |

## 与其他模块的关系

- `gateway/runtime_ownership.py`：`process_ownership.reserve` 是启动家唯一 owner 的仲裁（`gateway.lock`）；`entry.py::main` 冲突时退出并提示"attach to it instead"。
- `agent/secret_scope.py`：`set_multiplex_active` / `is_multiplex_active` 是 fail-closed 的实际开关，每次 `get_secret` 都读它。
- `gateway/session_controls.py::AuthorityConnection`：票务 WS socket 上的会话权威；本模块的 sidecar 方法经 `ws_legacy_fallback.py` 作受限 fallback。
- `tools/environments/local.py::served_profile_child_env`：任何为所服务 profile 派生子进程（slash worker、`hermes -p X` worker）都从它取环境，绝不 `dict(os.environ)`。

## 总结

进程模型可以压缩成三句话：**渲染器永远附加到共享 owner**（`attach_gateway`，按需拉起、空闲退出、`--recover` 自愈）；**第一个次要 profile 家把进程变成 fail-closed 多租户**（`launch_profile_policy` 冻结环境 + `@_profile_scoped` 包住每个触状态方法）；**重 turn 可选下放到 compute-host 子进程**（`MUTATOR_ROUTE_TABLE` 决定谁能穿越边界）。读懂这三条，`server.py` 里任何一个 handler 为什么长那样就都有了答案。
