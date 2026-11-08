# platforms_framework.md —— 适配器框架：BasePlatformAdapter、MessageEvent 与平台注册表

## 文件概览

先纠正一个直觉错误：`gateway/platforms/`（42 个文件）**不是**各平台的适配器集合——它是**适配器框架**加上 3 个内置 HTTP 平台。真正的 26 个聊天平台适配器（Telegram、Discord、Slack……）都是插件，住在 `plugins/platforms/<name>/adapter.py`，在 import 时把自己注册进 `gateway/platform_registry.py::platform_registry`；网关按需实例化。框架这一层提供的是：所有适配器的公共基类与投递括号（`base.py`）、归一化入站事件（`event.py`）、注册表（`platform_registry.py`）、多路复用安全的 secret/YAML 读取（`_shared.py`）、媒体缓存与投递目标等横切设施。本篇清单覆盖全部 17 个框架文件（webhook/msgraph/api_server 三个内置平台共 25 个文件留给 `builtin_platforms.md`）。

## 关键代码走读

### 1. BasePlatformAdapter：一个适配器要回答什么

基类的类属性就是一张「能力自述表」，网关读它来决定行为，**绝不 if 平台名**：

```python
# 来源：gateway/platforms/base.py:1809-1856（节选）
class BasePlatformAdapter(ABC):
    """Base class for platform adapters: connect/auth, receive, send, handle media."""

    supports_code_blocks: bool = False     # ``` 渲染成真代码块
    supports_status_text: bool = False     # typing 指示器渲染 TEXT（状态行）
    # Can wake a fresh turn AFTER a turn ends (detached-subagent completions); False for stateless
    # adapters (API server). Propagated to ``HERMES_SESSION_ASYNC_DELIVERY`` so tools never promise
    # a delivery they can't keep.
    supports_async_delivery: bool = True
    splits_long_messages: bool = False     # send() 自切块 → 路由器跳过截断
    typed_command_prefix: str = "/"        # 客户端吃掉开头 "/" 的平台给 "!"
    # A human can answer "session restored — what next?"; webhook-style platforms set False so
    # auto-resume finishes the work instead of asking nobody.
    interactive_resume: bool = True
    # Port-binding adapter that answers ``/p/<profile>/...`` for every served profile on the default
    # listener under ``gateway.multiplex_profiles``.
    serves_profile_prefix: bool = False
    # Back-reference to the running ``GatewayRunner`` (set by gateway/run.py); ``build_source``
    # resolves the inbound profile via ``runner._profile_name_for_source``.
    gateway_runner = None
```

`__init__`（base.py:1858-1925）里藏着第一道忙碌守卫的全部状态：`_active_sessions`（session_key → interrupt Event）、`_pending_messages`（忙碌期待处理）、`_requeue_counts`（弹回退避，#123229）、`_post_delivery_callbacks`（投递后一次性回调，带 generation 防陈旧 run 清掉新 run 的回调）。注意两个「runner 事后安装」的字段——`_busy_text_mode` 和 `_human_delay_range_ms`——注释明说构造期读进程 env 会把启动 profile 的值冻进每个 profile 的适配器（#116893/#116895），这是 Profile scope 在框架层的落点。

抽象/半抽象接口很窄：`connect()` / `disconnect()`（连接与令牌锁）、`send()`（返回 `SendResult`）、`stop_typing()`；辅以一组可覆盖的呈现钩子（`format_message`、`format_tool_event`、`render_message_event`）。每个适配器还要选一个基础 toolset（Telegram → `"messaging"`）。

**凭据作用域锁**是接口的一部分（gateway/AGENTS.md § Token locks）：用唯一凭据连接的适配器在 `connect()`/`start()` 里调 `gateway.status.acquire_scoped_lock()`、断开时释放，两个 profile 就永远不能共享同一个 bot token。canonical 实现见 `plugins/platforms/irc/adapter.py`。基类的 `_acquire_platform_lock`（base.py:2143）是封装层。

### 2. SendResult 与发送错误分类

```python
# 来源：gateway/platforms/base.py:1596-1611
class SendResult:
    """Result of sending a message."""
    success: bool
    message_id: Optional[str] = None
    error: Optional[str] = None
    # Adapter-specific metadata. Contracts: raw_response["partial_overflow"] (Telegram edit-overflow
    # partial: the stream consumer sends the missing tail); raw_response["failure_notice_sent"] ...
    raw_response: Any = None
    retryable: bool = False  # transient connection error — base retries automatically
    retry_after: Optional[float] = None  # server-requested delay (Telegram FloodWait) beats our backoff
    # Extra ids (send order) when a payload was split; ``message_id`` is then the LAST id so
    # later edits target the newest chunk.
    continuation_message_ids: tuple = ()
    # SEND_ERROR_KINDS member (failures only) via :func:`classify_send_error`, so consumers
    # branch without substring-matching ``error``.
    error_kind: Optional[str] = None
```

`error_kind` 是七值封闭枚举（`SEND_ERROR_KINDS`，base.py:1623：too_long / bad_format / forbidden / not_found / rate_limited / transient / unknown），由表驱动的 `_SEND_ERROR_CLASSIFIERS`（:1648）从异常文本里分类——消费方按类分支，不做子串匹配。`not_found` 还要再分「整个聊天没了」与「只是子聊天没了」（`is_chat_level_not_found`，:1669）：只有前者允许把目标标记为死。`retry_after` 与 `classify_send_error` 一起支撑 `delivery_ledger` 的 flood 策略（见 message_flow.md 第 6 步）。

### 3. send_final_ledgered：投递括号

每个最终回复都过 `send_final_ledgered`（base.py:4281，走读见 `message_flow.md` 第 6 步）：在**当前** transport 上先记投递义务、发送重试、按结果结账，返回的二元组里带上真正完成发送的 adapter——`message_id` 的所有权（后续 edit、ephemeral 删除）归它。同一括号还负责释放崩溃恢复的 turn marker（`_release_turn_marker`，:4306）：账本一旦接管恢复义务，durable 活跃标记就该撤了。

### 4. MessageEvent：归一化的入站形状

`event.py` 是叶子模块（adapters、helpers、runner 都 import 它，所以它不许 import 回 `gateway.platforms.*`）。`MessageType` 枚举九类（text/location/photo/video/audio/voice/document/sticker/command）；`MessageEvent` 的字段纪律与安全属性（`internal`、`allow_gateway_control`、`ledger_message_id`、`reply_anchor_override`）已在 `message_flow.md` 第 1 步走读。这里补两个容易漏的方法：

- `is_command()` / `get_command()`（event.py:176-186）：先剥掉 Desktop 的 `@image:`/`@file:` 附件引用前缀（`_ATTACHMENT_REF_RE`）再识别斜杠，文件路径形式的假命令（含 `/`）直接判 None。
- `absorb_reply_expected()` / `extend_media()`（:150-163）：照片连发合并成一条事件时，寻址标志按「addressed 优先、unknown 次之」吸收，附件按平行数组拼装。

### 5. platform_registry：插件自注册

```python
# 来源：gateway/platform_registry.py:42-58（节选）
@dataclass
class PlatformEntry:
    """Metadata and factory for a single platform adapter."""

    name: str  # config.yaml identifier (e.g. "irc")
    label: str  # human-readable
    adapter_factory: Callable[[Any], Any]  # PlatformConfig -> adapter (factory allows custom init)
    # PASSIVE dependency probe (deps importable RIGHT NOW); must be side-effect free since it
    # runs from status displays and the config enablement pass, which may never pip-install.
    check_fn: Callable[[], bool]
    ...
    # ACTIVE dependency installer: make the platform's dependencies available, installing them
    # (pm.sync_venv) if needed. ... Called by ``create_adapter()`` when ``check_fn`` returns False.
    ensure_deps_fn: Optional[Callable[[], bool]] = None
```

`check_fn` 与 `ensure_deps_fn` 拆成两个字段是一段血泪史（#79812，registry 注释整段保留）：曾经把主动安装器注册成 `check_fn`，结果**每个状态展示页都顺手 pip install**（桌面端 94% 死循环）；换成被动探针，`create_adapter()` 又提前返回 None，依赖永远装不上（Teams 死锁）。拆开后两个调用点各自正确。插件侧经 `PluginContext.register_platform()` 注册；网关侧 `GatewayRunner._create_adapter()` 先查注册表、再走遗留内置路径——没有任何 `if platform ==` 链。其余字段同样是声明式钩子：`apply_yaml_config_fn`（YAML→env 桥，必须用 `_shared.apply_yaml_bridge` 造，手写 `os.environ[...] =` 会 first-profile-wins）、`trusted_inbound`（事件总线类平台跳过允许名单；注释警告：聊天平台**永远不许**设它）、`standalone_sender_fn`（无共驻网关的 cron 投递）等。

### 6. ADDING_A_PLATFORM.md 摘要

加新平台的推荐路径是插件：在 `plugins/platforms/`（或 `~/.hermes/plugins/`）建目录，写 `plugin.yaml` + `adapter.py`（继承 `BasePlatformAdapter`，在 `register(ctx)` 里 `ctx.register_platform()`），**核心代码零改动**。要点：

- **env 使能钩子**：`env_enablement_fn` 用 `_shared.seed_extra_from_env` 建表驱动（所有读取过 `_shared.get_scoped_secret`，多路复用安全，绝不 `os.getenv`）。
- **YAML 桥**：`apply_yaml_config_fn` 声明 `(yaml_key, ENV_VAR, kind)` 表，交 `_shared.apply_yaml_bridge`——只在未设置时写 env（env > YAML），且从不在次要 profile 作用域下写。
- **平台特有 UX 用子类化而非扩核**：LINE 的 60 秒单次 reply token 这类硬时限，覆盖 `_keep_typing` 叠加中途气泡、务必 `await super()._keep_typing(...)`，`finally` 里拆自己的任务（完整范式见 `plugins/platforms/line/`）。
- **同平台双传输共享行为 mixin**：WhatsApp 的 Baileys 桥与 Cloud API 两个适配器共用 `whatsapp_common.py::WhatsAppBehaviorMixin`（门控、允许名单、mention 解析、WhatsApp 风味 markdown）；mixin 必须放在基类**前面**（`class WhatsAppAdapter(Mixin, BasePlatformAdapter)`），它的 `format_message` 才能覆盖基类默认。两个适配器注册不同的 `Platform.*` 枚举值，网关可同时跑两套。

## 核心类/函数

| 符号 | 位置 | 职责 |
|------|------|------|
| `BasePlatformAdapter` | platforms/base.py:1809 | 适配器基类：能力自述属性、忙碌守卫状态、投递括号、呈现钩子 |
| `SendResult` | platforms/base.py:1596 | 发送结果（message_id、retryable、error_kind、continuation ids） |
| `classify_send_error()` | platforms/base.py:1662 | 表驱动错误分类，未识别一律 `unknown`（不误判为良性） |
| `send_final_ledgered()` | platforms/base.py:4281 | 记账→发送→结账的投递括号，返回真正发送的 adapter |
| `MessageEvent` / `MessageType` | platforms/event.py:66/46 | 归一入站事件与九类消息类型 |
| `PlatformEntry` | platform_registry.py:42 | 注册表条目：factory、check_fn（被动）、ensure_deps_fn（主动）、声明式钩子 |
| `register()` / `create_adapter()` | platform_registry.py | 插件自注册；网关按名实例化 |
| `get_scoped_secret()` | platforms/_shared.py | 唯一的 scoped 凭据读取实现（适配器里 import 为 `_get_scoped_secret`） |
| `apply_yaml_bridge()` | platforms/_shared.py | YAML→env 桥：只在未设置时写，多路复用下次要 profile 永不写 env |
| `CachedMedia` | platforms/base.py:1444 | 下载媒体的缓存条目与 context 注记 |
| `ExecApprovalPrompt` | platforms/base.py:1574 | 命令审批提示的呈现形状 |

## 本组文件清单

### A. 框架核心（gateway/platforms/）

| 文件 | 角色 |
|------|------|
| `base.py` | BasePlatformAdapter、SendResult、SendResult 错误分类、媒体缓存函数、投递括号 |
| `event.py` | MessageEvent/MessageType/ProcessingOutcome（叶子模块） |
| `_shared.py` | get_scoped_secret / extra_or_secret / seed_extra_from_env / env_is_connected / platform_gate_env / apply_yaml_bridge |
| `_http_client_limits.py` | 出站 HTTP 客户端的超时/体积上限 |
| `helpers.py` | 去重、markdown 转换、typing 元数据等适配器助手 |
| `access_policy_mixin.py` | 访问策略 mixin（允许名单/群策略的组合件） |
| `media_cache.py` | 入站/出站媒体缓存目录与清理 |
| `send_targets.py` | 发送目标解析助手 |
| `docker_media_paths.py` | Docker 沙箱路径到宿主路径的媒体翻译 |
| `tcp_site.py` | 端口绑定型适配器的 TCP 站点辅助（webhook/api_server 共用） |
| `shared_ingress.py` | 多路复用下次要 profile 共享默认监听器（/p/<profile>/） |
| `base_exec_approval.py` | 命令审批提示的基类逻辑 |
| `base_log_safety.py` | 日志脱敏基类逻辑 |
| `base_post_delivery.py` | 投递后一次性回调的基类逻辑 |
| `base_streaming_tts.py` | 流式 TTS 适配器基类（配合 streaming_tts_consumer） |
| `whatsapp_common.py` | WhatsAppBehaviorMixin：Baileys 桥与 Cloud API 共享的行为 |
| `ADDING_A_PLATFORM.md` | 加平台 step-by-step 指南（本篇第 6 节的摘要来源） |
| `__init__.py` | 包标记 |

### B. 网关侧的注册与插件接线

| 文件 | 角色 |
|------|------|
| `platform_registry.py` | PlatformEntry + 注册表 + create_adapter（check/ensure 双字段设计） |
| `platform_activation.py` | 平台启用/依赖就绪判定（配合注册表） |
| `platform_env.py` | 平台环境变量目录（setup 展示） |
| `plugin_command_choice.py` | 插件命令与内置命令同名时的仲裁 |
| `plugin_keyless_inject.py` | 无密钥插件的注入 |
| `plugin_messages.py` | 插件消息辅助 |

## 与其他模块的关系

- **plugins/platforms/**（26 个适配器）是本框架最大的消费者：它们只依赖 `BasePlatformAdapter` + `PlatformEntry` + `_shared`，通过 `ctx.register_platform()` 注册，经 `plugin_api.json` 边界访问核心（`scripts/boundary_lint.py` 拦截越界）。
- **GatewayRunner**（`run_adapters.py`）经注册表实例化适配器、安装 runner 侧 handler（busy 文本模式、human delay、授权回调），并把 intake/delivery 两个适配器缝接进 authz。
- **3 个内置 HTTP 平台**（webhook、msgraph、api_server）直接住在本目录，因为它们不依赖任何外部 SDK——见 `builtin_platforms.md`。
- **relay/** 的 RelayAdapter 也继承 BasePlatformAdapter，但把能力声明全部换成了握手协商的 `CapabilityDescriptor`——见 `relay.md`。

## 总结

框架层的全部设计都指向一句话：**让「加一个平台」不需要动核心**。适配器用类属性自述能力（网关读属性，不做平台分支）；用 `PlatformEntry` 的声明式钩子自述依赖与配置（被动探针与主动安装器分离，两个调用点各自正确）；用 `_shared` 的 scoped 读取自述凭据来源（多路复用下永远不会读错 profile）。少数必须共享的协议行为（WhatsApp 双传输）下沉为 mixin 且强制排在基类前面。读完本篇再去读任何一个 `plugins/platforms/*/adapter.py`，都会发现它只是在回答同一张问卷。
