# 08.3 契约即文档 —— tui_gateway/contracts/（25 个文件）

## 文件概览

| 文件 | 行数 | 角色 |
|------|------|------|
| `tui_gateway/contracts/registry.py` | 231 | 契约目录：三张表 + 运行时校验 + 完整性断言 |
| `tui_gateway/contracts/base.py` | 56 | `Params` / `Result` / `Payload` / `WireEnum` 基类 |
| `tui_gateway/contracts/events.py` | — | 每个事件名的 `Payload` 模型 |
| `tui_gateway/contracts/server_requests.py` | — | 每个 server→client 请求的 Params/Result |
| `tui_gateway/contracts/canonical.py` 等 4 个 `canonical_*.py` | — | `hermes-gateway-v1` 规范方法目录 |
| `scripts/gen_gateway_contracts.py` | 400 | 渲染 TS + OpenRPC |
| `tests/tui_gateway/contracts/test_generated.py` | — | 陈旧性测试（CI 门） |

25 个文件里，每个 client→server 方法、每个 server→client 请求、每个事件通知各一个 Pydantic 类。**Wire 在 Python 里声明，为 TypeScript 生成**——`base.py` 的 docstring 说得最直白：Python 是 JSON-RPC wire 的唯一事实源。

## 关键代码走读

### 1. 三个基类立住建模规则

```python
# tui_gateway/contracts/base.py:32-52
class Params(BaseModel):
    """Client→server method params / server→client request params. Unknown keys are rejected."""

    model_config = ConfigDict(extra="forbid", populate_by_name=True)


class Result(BaseModel):
    """Method / server-request result. Serialised with ``exclude_none=False`` so an explicit
    ``null`` stays a ``null`` on the wire (clients distinguish absent from null)."""

    model_config = ConfigDict(extra="forbid")


class Payload(BaseModel):
    """Notification payload (``event`` frame ``params.payload``)."""

    model_config = ConfigDict(extra="forbid")


class WireEnum(StrEnum):
    """A closed string set on the wire; renders as a TS literal union."""
```

建模规则（docstring 原文归纳）：字段名就是 `snake_case` 的 wire 拼写；闭合集合用 `StrEnum`（渲染成 TS 字面量联合）；判别字段用 `Literal`；`X | None = None` 渲染成 `x?: X | null`；**契约里禁止 `dict[str, Any]`**——要么声明形状，要么用 `JsonValue`。少量刻意 `extra="allow"` 的 payload（皮肤、宠物、goal 状态）其闭合形状归别的模块所有，用 `OpenPayload` 子类。

### 2. 三张表 + 声明函数

```python
# tui_gateway/contracts/registry.py:61-68
METHODS: dict[str, MethodContract] = {}
# ``hermes-gateway-v1`` verbs only ``gateway/session_controls.py::AuthorityConnection`` serves
# (``contracts/canonical.py``), plus explicit overrides where a shared name has a different wire.
CANONICAL_METHODS: dict[str, MethodContract] = {}
SERVER_REQUESTS: dict[str, ServerRequestContract] = {}
EVENTS: dict[str, EventContract] = {}
# Dynamic ``hermes-gateway-v1`` namespaces the session authority serves after its own verbs.
CANONICAL_NAMESPACES: dict[str, NamespaceContract] = {}
```

表由 `contracts.*` 主题模块在 import 时填充；读表的是 `tui_gateway/server.py`（运行时校验）和 `scripts/gen_gateway_contracts.py`（TS/OpenRPC 渲染）。四个声明函数：

```python
# tui_gateway/contracts/registry.py:85-115 (节选)
def method(name: str, *, params: type[Params], result: type[Result], doc: str = "") -> MethodContract:
    entry = MethodContract(name, params, result, doc)
    _declare(METHODS, entry)
    return entry


def canonical_method(name: str, *, params: type[Params], result: type[Result], doc: str = "") -> MethodContract:
    entry = MethodContract(name, params, result, doc)
    _declare(CANONICAL_METHODS, entry)
    return entry


def canonical_namespace(name: str, *, prefix: str, capability: str, params: type[Params],
                        doc: str = "") -> NamespaceContract:
    if not name.startswith(prefix):
        raise RuntimeError(f"namespace {name!r} must start with its prefix {prefix!r}")
    entry = NamespaceContract(name, prefix, capability, params, doc)
    _declare(CANONICAL_NAMESPACES, entry)
    return entry


def server_request(name: str, *, params: type[Params], result: type[Result], doc: str = "") -> ServerRequestContract:
    ...


def event(name: str, payload: type[Payload] | None = None, *, doc: str = "") -> EventContract:
    ...
```

`_declare`（77-82 行）拒绝同一传输目录里的重复声明；`server.py::register_method` 则在 import 时拒绝没有契约的注册名——**wire 上不存在未声明的表面**。方法名只在运行时存在的家族（`plugin.<plugin_id>.<name>`）是一个 `canonical_namespace` 条目而不是逐个方法：

```python
# tui_gateway/contracts/canonical.py:380
canonical_namespace("plugin.{plugin_id}.{name}", prefix="plugin.", capability="plugin-rpc-v1", ...)
```

客户端以 `runtime.describe` 里的 `plugin-rpc-v1` 能力为门，未知的家族成员像普通未知方法一样答 `-32601`。

### 3. 运行时校验：谁在严格模式下失败

```python
# tui_gateway/contracts/registry.py:118-151 (节选)
# Params are validated on every call: an unknown or mistyped key is the CLIENT's bug and answers
# JSON-RPC ``4000`` with the field path, never a silent ignore. Results and payloads are OUR bug when
# raises, which is what makes the suite the gate.

STRICT = bool(os.environ.get("HERMES_TEST_ISOLATION"))

class ContractViolation(AssertionError):
    """A result or payload the gateway produced does not match its declared contract."""


def _report(kind: str, name: str, exc: ValidationError) -> None:
    if STRICT:
        raise ContractViolation(f"{kind} {name!r} violates its contract: {exc}") from exc
    logger.error("%s %r violates its wire contract: %s", kind, name, exc)


def validate_params(contract, params) -> tuple[dict | None, str | None]:
    """Reject UNKNOWN keys (``4000`` with the key path) — the one check no handler performs, and the
    one that catches a renamed or misspelled field on either side. ..."""
    try:
        contract.params.model_validate(params)
    except ValidationError as exc:
        for err in exc.errors():
            if err.get("type") == "extra_forbidden":
                loc = ".".join(str(p) for p in err.get("loc", ())) or "params"
                return None, (f"invalid params for {contract.name}: {loc}: ... — the client and "
                              "the Hermes backend are out of sync (different versions); run `hermes update` "
                              "and restart both")
    return params, None
```

职责划分很精妙：`validate_params` 只拦**未知键**（捕获改名/拼错字段这一类两端失同步），必填与类型错误留给 handler——因为 handler 拥有自己的域码（`4006` 缺 session_id、`4015` 坏 url），客户端已经在分支这些码。配套的 `check_params_accepted`（169 行）反向闭环：handler **成功**接受了契约认为非法的参数，说明契约比 wire 更窄。`check_result` / `check_payload` 检查产出方向，`HERMES_TEST_ISOLATION=1` 下抛 `ContractViolation`，生产只记日志。

规范侧（canonical）另有 `canonical_param_problems`（154 行）：未知**和缺失**键都回 `4001 invalid_params`——闭合集合的 handler 本来就手工强制了这一点。

### 4. 完整性断言与代码生成

```python
# tui_gateway/contracts/registry.py:202-219 (节选)
def assert_complete(methods: dict[str, object], emitted_events: set[str], server_requests: set[str]) -> None:
    """Every registered method / emitted event name / sent server request has a contract, and no
    contract is orphaned. Raises with the full lists."""
    problems = []
    if missing := sorted(set(methods) - set(METHODS)):
        problems.append(f"methods without a contract: {missing}")
    if orphan := sorted(set(METHODS) - set(methods)):
        problems.append(f"method contracts with no handler: {orphan}")
    ...
    if problems:
        raise ContractViolation("tui_gateway/contracts is incomplete:\n  " + "\n  ".join(problems))
```

生成器读这四张表渲染两个文件（`scripts/gen_gateway_contracts.py:39-40`）：

```python
# scripts/gen_gateway_contracts.py:39-46
TS_OUT = ROOT / "apps" / "shared" / "src" / "gateway-contract.generated.ts"
OPENRPC_OUT = ROOT / "apps" / "shared" / "src" / "gateway-contract.openrpc.json"
...
HEADER = (
    "// GENERATED by scripts/gen_gateway_contracts.py from tui_gateway/contracts — DO NOT EDIT.\n"
    "// Regenerate: .venv/bin/python scripts/gen_gateway_contracts.py\n"
    "// tests/tui_gateway/contracts/test_generated.py fails when this file is stale.\n"
)
```

TS 输出携带 `RpcMethods`、`ServerRequestMap`、`BackendGatewayEventMap` 与每个值形状；canonical 同一生成器输出 `CanonicalRpcMethods` 与 OpenRPC 的 `x-canonical-methods` / `x-canonical-namespaces`，不拓宽 `RpcMethods`。生成器刻意用一个小的 JSON-Schema 子集渲染器——遇到不支持的 schema 就在生成时抛错，逼你在模型侧修，而不是在输出侧绕。

**迭代闭环**：改模型 → 跑生成器 → `tsc` 立刻向每个消费者展示字段搬家了；忘了重新生成，`test_generated.py` 在 Python 侧让 CI 失败。

### 5. handler 注册端

```python
# tui_gateway/server.py:775-786
def register_method(name: str, fn) -> None:
    """The ONE registration seam (``@method`` here and ``HandlerRegistry.install`` for the split
    modules). ``tests/tui_gateway/contracts/test_generated.py::test_every_method_has_a_contract`` and the
    generator's ``assert_complete`` fail when a registered name has no contract."""
    _methods[name] = fn


def method(name: str):
    def dec(fn):
        register_method(name, fn)
        return fn
    return dec
```

新问题的完整落地路径（`AGENTS.md` 原文）：发射器里 `_ask("<method>", sid, params, timeout)`、TS 侧 handler（`apps/desktop/.../server-requests.ts` 与 `ui-tui/src/app/createServerRequestHandler.ts`）、契约 `server_request(...)`——三处，缺一不可。新事件同理：`contracts/events.py` 里 `event("<type>", Payload)`，发射器被契约盯住。

一个具体事件的契约长这样：

```python
# tui_gateway/contracts/events.py:40-48 (节选)
class GatewayReadyPayload(Payload):
    """``tui_gateway/entry.py`` (stdio) / ``tui_gateway/ws.py`` (WebSocket) first frame."""

    skin: SkinPayload
    change_events: bool
    replay_epoch: str
    heartbeat: bool | None = None  # WebSocket transport only
    session_authority: bool | None = None
```

每个模型的 docstring 命名它类型的 Python 发射器——发射器是事实源，手写 TS 只曾是地图。

## 核心类/函数

| 名称 | 位置 | 职责 |
|------|------|------|
| `Params` / `Result` / `Payload` | `contracts/base.py:32/38/45` | 三个 `extra="forbid"` 基类 |
| `MethodContract` / `ServerRequestContract` / `EventContract` / `NamespaceContract` | `contracts/registry.py:22/30/40/47` | 四种契约的 frozen dataclass |
| `METHODS` / `CANONICAL_METHODS` / `SERVER_REQUESTS` / `EVENTS` / `CANONICAL_NAMESPACES` | 同上 :61-68 | 五张目录表 |
| `method` / `canonical_method` / `server_request` / `event` / `canonical_namespace` | 同上 :85-115 | 声明入口；重复即 RuntimeError |
| `validate_params` | 同上 :136 | 只拦未知键 → `4000` + 字段路径 |
| `canonical_param_problems` | 同上 :154 | 未知+缺失键 → `4001 invalid_params` |
| `check_result` / `check_payload` | 同上 :179/:186 | 产出方向校验；STRICT 下抛 `ContractViolation` |
| `assert_complete` | 同上 :202 | 无孤儿契约、无无契约方法的完整性门 |
| `Renderer` / `_Schema` | `scripts/gen_gateway_contracts.py` | TS/OpenRPC 渲染；稳定 `$defs` 命名 |
| `register_method` / `method` | `tui_gateway/server.py:775/782` | 唯一注册 seam |

## 本组文件清单

| 文件 | 一句话 |
|------|--------|
| `contracts/base.py` | 基类与建模规则（`JsonValue`、`WireEnum`） |
| `contracts/registry.py` | 目录表、声明函数、运行时校验、完整性断言 |
| `contracts/events.py` | 所有事件 Payload（`SkinPayload`、`GatewayReadyPayload`…） |
| `contracts/server_requests.py` | server→client 请求契约（approval/clarify/…） |
| `contracts/canonical.py` | 规范 `hermes-gateway-v1` 方法（admission、receipt、cancel…） |
| `contracts/canonical_sessions.py` / `canonical_projections.py` / `canonical_stored_reads.py` | 共享名的权威覆盖与投影 |
| `contracts/sessions.py` / `prompt_voice.py` / `tools_commands.py` / `tools_mcp_plugins.py` / `config_free_tier_control.py` / `connectors.py` / `connectors_operation.py` / `display.py` / `groups_bot_relay.py` / `i18n.py` / `machine.py` / `profiles_vault_complete_foreign_subagents.py` / `projects_pets.py` / `billing_delegation_pets.py` / `liveness.py` / `common.py` | 按主题的 Params/Result/Payload 主题模块 |
| `scripts/gen_gateway_contracts.py` | TS + OpenRPC 生成器 |

## 与其他模块的关系

- **`tui_gateway/server.py`**：dispatch 时按契约校验入参与出参；`_event_frame` 发射前调 `check_payload`。
- **`gateway/session_controls.py::AuthorityConnection`**：对 canonical 方法做参数与成功结果的校验（`4001 invalid_params`）。
- **`apps/shared/src/gateway-contract.generated.ts`**：TS 消费者（`ui-tui`、`apps/desktop`）的类型世界从这里生长；`gateway-events.ts` 只叠加客户端本地合成事件与 `GatewayEvent` 信封。
- **`tests/tui_gateway/contracts/test_generated.py`** 与 **`tests/gateway/test_canonical_wire_contract.py`**：分别盯 TS 陈旧与 canonical 覆盖。

## 总结

契约层把"文档"从注释变成了**类型**：`extra="forbid"` 的 Pydantic 模型同时是运行时校验器、TS 类型源和 OpenRPC 文档。方向感要记住：未知入参是客户端 bug（`4000`），出参漂移是自己的 bug（测试里炸）；handler 的域码不被契约抢走。改协议的完整循环——改模型、重新生成、`tsc` 暴露所有消费者——由陈旧性测试兜底。这正是「Python 拥有行为，TypeScript 拥有屏幕」能长期成立的前提：屏幕和行为之间隔着一层机器生成、测试把守的契约。
