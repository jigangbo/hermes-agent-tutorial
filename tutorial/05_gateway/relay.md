# relay.md —— 网关↔connector 转发通道（实验性）

## 文件概览

`gateway/relay/`（13 个文件，全部标注 EXPERIMENTAL）实现一条实验性通道：把「每个平台一个适配器」的模型换成**一个通用 RelayAdapter**。外部 **connector**（例如 Hermes Cloud 的 Team Gateway）拥有真实平台的 bot（Telegram/Discord/Slack token 在它手里），网关通过 WebSocket 主动拨出与其相连；connector 把平台消息转发给网关、网关把回复转回。激活方式：设置 `GATEWAY_RELAY_URL`（或 `gateway.relay_url`）——此时 `gateway/config_env.py::_relay` 会**关闭所有直连适配器**（该部署根本配不出自己的 bot）。本篇用一张 ASCII 说明三方拓扑，然后走读 RelayAdapter、CapabilityDescriptor 握手、egress 授权、账号 linking 与生产传输。

```
        Hermes 实例 (gateway)                 connector (拥有真实 bot)              平台
┌─────────────────────────────┐  WS (网关拨出)  ┌──────────────────────┐   Bot API   ┌──────────┐
│ RelayAdapter (Platform.RELAY)│◀──────────────▶│ Team Gateway/Cloud    │◀──────────▶│ Telegram │
│  hello → descriptor 握手     │  hello/inbound  │  · 平台 token、租户    │◀──────────▶│ Discord  │
│  outbound/inbound_ack …      │  outbound/result│  · egress 授权地板     │◀──────────▶│ Slack …  │
└─────────────────────────────┘  passthrough    └──────────────────────┘            └──────────┘
   直连适配器全部关闭 (config_env._relay)          一个 connector 可服务多实例
```

为什么值得一条独立通道：社区/托管部署配不起自己的 bot（没有服务器、不想管 token），或者平台侧只允许一个租户 bot；connector 把「连接平台」变成服务，网关把「理解消息」留在实例侧——信任边界由帧协议与 egress 授权显式划定。

## 关键代码走读

### 1. RelayAdapter：一个适配器顶 N 个平台

```python
# 来源：gateway/relay/adapter.py:116-133（节选）
class RelayAdapter(RelayDiscordInteractionMixin, BasePlatformAdapter):
    """Generic relay adapter advertising a connector-negotiated capability profile."""

    # Connector egress splits against negotiated max_message_length, so the
    # gateway-level cap must not pre-truncate relay deliveries.
    splits_long_messages = True

    def __init__(
        self,
        config: PlatformConfig,
        descriptor: CapabilityDescriptor,
        transport: Optional[RelayTransport] = None,
    ) -> None:
        # Fronts many platforms but presents to the runner as Platform.RELAY.
        super().__init__(config, Platform.RELAY)
        self._transport = transport
        self._apply_descriptor(descriptor)
        # Per-chat egress routing caches learned from inbound events (send() only
        # receives a chat_id). The connector's egress guard resolves the owning tenant
        # from OUTBOUND metadata.scope_id / user_id, so we re-attach what we saw
        # inbound (_capture_scope).
        self._scope_by_chat: dict[str, str] = {}
        ...
        # chat_id -> UNDERLYING platform ("discord", ...): one adapter fronts N
        # platforms on one WS and a reply must egress through the platform the
        # inbound came from. Empty for a single-platform gateway (connector default).
        self._platform_by_chat: dict[str, str] = {}
        # chat_id -> Hermes profile the connector routed the inbound to (multiplex mode). Echoed
        # on every outbound frame's metadata so the connector can stamp the SAME profile on the
        # next passthrough_forward for that chat; empty on a single-profile gateway.
        self._profile_by_chat: dict[str, str] = {}
```

设计核心是「**每个 chat 学一条路由缓存**」：`send()` 只拿得到 chat_id，但 connector 的租户判定需要 `scope_id`/`user_id`/底层平台/路由 profile——全部从入站事件里捕获（`_capture_scope`），出站时回贴到 metadata。`_profile_by_chat` 的回声是 Profile scope 在 relay 上的形态：`_with_scope`（adapter.py:1119）把路由 profile 盖在**每一帧**出站 metadata 上，`follow_up` 从 key 命名空间推导它，connector 下一次 `passthrough_forward` 就盖同一个章。能力一律来自握手协商的 descriptor（`_descriptor_for_chat`、`max_message_length_for_chat` 全部查表），adapter 自己不做平台分支——Slack 的特例也走 `_slack_flag`/`_relay_slack_extra` 这类「connector 报告的开关」。流式侧维护「开启中的 draft」与「已封缄 draft」两张表（`_open_draft_by_chat`/`_sealed_draft_by_chat`），把 stream-is-the-message 契约落到帧上（封缄墓碑与 connector 侧镜像，防迟到的帧重开已封缄流）。

### 2. CapabilityDescriptor：握手即能力契约

```python
# 来源：gateway/relay/descriptor.py:17-58（节选）
# Bump additively (never reinterpret an existing field); a breaking change
# requires updating both repos in lockstep.
CONTRACT_VERSION = 1


@dataclass(frozen=True)
class CapabilityDescriptor:
    """Immutable capability profile negotiated at relay handshake (frozen: fixed for the connection)."""

    contract_version: int
    platform: str
    label: str
    max_message_length: int
    supports_draft_streaming: bool
    supports_edit: bool
    supports_threads: bool
    markdown_dialect: str
    len_unit: str  # "chars" | "utf16"
    ...
    # Outbound op names the connector implements for this platform. Empty = the
    # connector predates the field; callers MUST treat that as LEGACY_OPS, not
    # "nothing supported". Tuple keeps the frozen dataclass hashable.
    supported_ops: tuple = ()

    # Assumed capability set when a legacy connector sends no supported_ops.
    LEGACY_OPS = ("send", "edit", "typing", "follow_up")

    def supports_op(self, op: str) -> bool:
        """Whether the connector advertises ``op`` (legacy set when none advertised).

        A NEW op is therefore only True when explicitly advertised — capability
        can be probed without trying the op and parsing an error."""
        return op in (self.supported_ops or self.LEGACY_OPS)
```

connector 在握手时交出一份**冻结**的 capability 档案：它替哪个平台出头、字数上限、draft/edit/thread、markdown 方言、计长单位（Telegram 类平台报 `utf16`）。`from_json` 的信任边界规范化值得注意：垃圾的 `max_message_length` 映射到文档化的 4096 默认值，`supported_ops` 变成非空字符串元组——畸形输入永远不破坏握手。schema 演进只许**加法**（新字段默认 False/空，旧 connector 对旧网关安全）；`supports_op` 的默认 LEGACY_OPS 让「没报 ops」读作旧集合而不是「全不支持」，新 op 则必须显式广告——能力探测不用试错。

### 3. egress.py：出口授权（P5）

```python
# 来源：gateway/relay/egress.py:1-20（节选）
"""Gateway-side relay EGRESS AUTHORIZATION (P5).

Two halves of one security surface, kept together because they are the same
concern seen from both ends of the wire:

**(a) Target hygiene.** The ``send_message`` model tool takes a free-form
``target`` string (``'platform:chat_id'``). Nothing stopped a model from
naming an arbitrary chat id and having the gateway emit an outbound frame for
it. The connector now refuses such a frame (its egress-authorization floor),
but the gateway must not *silently* ask: a destination the gateway has no
record of is refused HERE, with a visible tool error naming the target.
:func:`authorize_relay_target` is that guard; :func:`attested_relay_targets`
is the set of destinations this gateway can show a provenance for (operator
home channel, channel directory, its own gateway session origins).

**(b) Decline visibility.** The connector answers an unauthorized destination
with a DEFINITE, non-ambiguous failure whose text is deliberately UNIFORM
(``"<platform> egress declined: target is not an approved destination for
this connection"``) — it must not leak whether the destination belongs to
another tenant or to nobody. :func:`is_egress_decline` recognises THAT a
decline happened; it never tries to parse WHY. Egress lanes that legitimately
degrade a *transport drop* (advisory progress, cosmetic reactions, media
falling back to a text notice) must NOT degrade a decline — a refusal that
turns into a different op, or into a wrong "op unavailable" reason, is a
security event laundered into an apparent success."""
```

两半合起来才是完整的安全面：网关侧**目标卫生**（模型不能凭空指一个 chat_id 就让网关发帧——无出处记录的目标在网关就拒，工具报错点名目标），connector 侧是**授权地板**（网关漏问它也拒）。`EGRESS_DECLINE_CODE = "egress_declined"`（:30）是结构化拒绝的首选信号；兜底匹配那句刻意**单一化**的拒绝文本——只识别「发生了拒绝」，绝不解析「为什么拒」（不泄漏目标属于别的租户还是不存在，finding F-005）。最锋利的一条规则在结尾：可以把「传输丢包」降级的通知/表情/媒体通道，**不许**把「拒绝」降级——拒绝被洗成另一种 op 或「op 不可用」就是安全事件伪装成功。

### 4. link.py 与 ws_transport.py：账号绑定与生产传输

```python
# 来源：gateway/relay/link.py:1-8（节选）
"""Account linking to the shared Team Gateway bot, done from the instance itself.

A relay-fronted deployment (Hermes Cloud with Team Gateway) reaches Telegram, Discord and Slack
only through the connector's SHARED bot: the gateway turns every direct adapter off
(``config_env._relay``), and the connector routes a chat account's messages to this instance once
that account is linked (``/link <code>`` DMed to the shared bot). The Portal can mint those codes;
this module lets the instance's own dashboard and Desktop do it too ..."""
```

linking 解决「共享 bot 上谁的消息归谁」：用户把 `/link <code>` 发给共享 bot，connector 据此把该账号路由到实例。code 由 per-gateway secret 铸造（secret 只活在网关进程，`self_provision_relay`），dashboard 经控制 socket 的 `relay-link` 动词取；Portal 托管的 agent 是例外——实例铸的 code 无 owner，绑定必须在 Portal 完成。

```python
# 来源：gateway/relay/ws_transport.py:1-7（节选）
"""Production WebSocket RelayTransport — the gateway's live link to the connector.

The gateway dials OUT to the connector's relay endpoint and speaks the
newline-delimited JSON frame protocol of ``website/docs/developer-guide/relay-connector-contract.md``:
gateway -> connector: hello, outbound, interrupt, going_idle, inbound_ack;
connector -> gateway: descriptor, inbound, outbound_result, interrupt_inbound,
going_idle_ack, passthrough_forward. Outbound calls block on a per-request future
keyed by ``requestId`` until the matching ``outbound_result``; a background reader
pumps inbound frames to the registered handler. EXPERIMENTAL schema."""
```

帧协议是对称的 11 种帧；出站调用按 `requestId` 挂 future 等 `outbound_result`（30 秒超时），后台 reader 把 inbound 泵给 handler。WS 升级鉴权在 `auth.py`：`Authorization: Bearer make_upgrade_token(gateway_id, secret)`，线字节必须与 connector 的 TypeScript 实现完全一致（`base64url(f"{payload}:{exp}:{sig}")`，HMAC-SHA256，TTL 300 秒，connector 侧支持多密钥轮换）。`inbound_admission.py` 决定 ACK 时机：接纳在 socket reader 之外的 task 里跑、同 chat 的接纳按到达顺序串行，**帧在接纳返回（或其返回的 task 完成）时才 ACK**——接纳过程可能还需要 `adapter.send()`（忙碌确认、prompt 卡片），而它的 `outbound_result` 只有那个 reader 能送。

## 核心类/函数

| 符号 | 位置 | 职责 |
|------|------|------|
| `RelayAdapter` | relay/adapter.py:116 | 通用适配器：descriptor 能力、per-chat 路由缓存、draft 墓碑 |
| `CapabilityDescriptor` | relay/descriptor.py:20 | 冻结握手契约：平台、上限、draft/edit/thread、ops；加法式演进 |
| `RelayTransport`（Protocol） | relay/transport.py:27 | 线协议面：connect/handshake/send/inbound 注册 |
| `WebSocketRelayTransport` | relay/ws_transport.py | 生产传输：11 种帧、requestId future、 teardown 预算 |
| `sign()` / `make_token()` | relay/auth.py | WS 升级 bearer（HMAC-SHA256，与 connector 字节级一致） |
| `authorize_relay_target()` | relay/egress.py | 出站目标卫生（有出处的目标集之外拒绝） |
| `is_egress_decline()` | relay/egress.py | 识别「被拒」；永不解析原因 |
| `admit_relay_delivery()` | relay/inbound_admission.py | 接纳即 ACK：按 chat 串行的接纳 lane |
| `MediaClient.download()/upload()` | relay/media.py | 媒体按引用传输：re-host URL ↔ 本地文件 |
| `_discord_interaction_to_event()` | relay/adapter_discord_interaction.py | 转发的 Discord interaction → MessageEvent |
| `build_manifest()` | relay/command_manifest.py | hello 帧上的 Discord slash 清单（与原生树镜像） |

## 本组文件清单

| 文件 | 角色 |
|------|------|
| `__init__.py` | 包标记 |
| `adapter.py` | RelayAdapter 主体（2,305 行）：能力应用、scope 捕获、draft 表、红撤监控 |
| `adapter_discord_interaction.py` | 转发的 Discord interaction → MessageEvent 归一 |
| `auth.py` | WS 升级 token（HMAC、TTL、多密钥轮换兼容） |
| `command_manifest.py` | hello 帧上的 slash 命令清单（连接器侧幂等注册） |
| `descriptor.py` | CapabilityDescriptor：握手契约、CONTRACT_VERSION、信任边界规范化 |
| `egress.py` | P5 出口授权：目标卫生 + 拒绝可见性 |
| `http_diagnostics.py` | 网关→connector HTTP 路由的非 2xx 归因（识别代理的 403 页） |
| `inbound_admission.py` | 接纳 lane：同 chat 串行、ACK 绑接纳完成 |
| `link.py` | `/link <code>` 账号绑定（实例侧铸造 code、Portal 托管例外） |
| `media.py` | 媒体面客户端：按引用传输（download/upload） |
| `transport.py` | RelayTransport 协议面（生产 WS + 测试内存桩共用） |
| `ws_transport.py` | WebSocketRelayTransport：帧协议、requestId future、断开排水 |

## 与其他模块的关系

- RelayAdapter 继承 `BasePlatformAdapter` 但**不做平台分支**——所有能力问题查 descriptor；这与 `platforms_framework.md` 的「能力自述」哲学同源，只是答案从类属性换成了握手。
- 入站经 `inbound_admission.py` 进 `message_flow.md` 的同一条接纳链（SessionAuthority durable FIFO）；`SessionSource.delivered_via_upstream_relay`（wire 不可见）标记「经认证 WS 而来」，authz 据此键控上游信任。
- Profile scope 的 relay 面：`_with_scope` 每帧回声路由 profile、`follow_up` 从 key 命名空间推导、parked profile 的帧 ACK 且拒收（`ParkedProfileRefusal`——ACK 门控的排水不能被 withheld 卡死）。
- `config_env._relay` 激活时关闭直连适配器，是 `run.md` 配置组里最特殊的一个开关。
- 共享 ingress 平台（Relay）只跑在默认 profile；次要 profile 启用会被记录 remedy（gateway/AGENTS.md § Unserved is reported）。

## 总结

relay 是把「平台连接」外包出去的完整协议面：一个 RelayAdapter 顶 N 个平台、能力靠握手冻结、路由靠 per-chat 缓存学习、身份靠每帧回声。它的安全设计值得单独记：**两端各有一道授权**（网关的目标卫生 + connector 的授权地板），拒绝信号刻意单一化且**永不降级**，能力探测靠显式 ops 广告而非试错。线协议（11 帧、requestId future、接纳即 ACK）与媒体按引用传输则说明「实验性」只是 schema 演进策略的标注，不是工程质量的豁免——每个对端字段不匹配、代理误判、ACK 时序的角落都有编号的思考。
