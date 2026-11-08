# platform_adapters.md —— 26 个平台插件与 Telegram 适配器解剖

## 文件概览

Hermes 的真正平台适配器不在 `gateway/platforms/`（那里只有框架，见 `platforms_framework.md`），而是 26 个**插件**：每个平台一个目录 `plugins/platforms/<name>/`，内含 `adapter.py`（继承 `BasePlatformAdapter`）与 `plugin.yaml`，import 时经 `ctx.register_platform()` 注册进 `gateway/platform_registry.py::platform_registry`。本章给出 26 个平台的分组清单（每平台一行：一句话特点 + adapter.py 路径），然后以最大的原生适配器之一 Telegram 为例解剖一个 `adapter.py` 的内部结构（7,385 行，与 Discord 的 7,308 行并列全仓库最大适配器）。

## 26 平台分组清单

### A. 主流聊天平台

| 平台 | 目录 / adapter.py | 一句话特点 |
|------|-------------------|-----------|
| Telegram | `plugins/platforms/telegram/adapter.py` | 7,385 行；MarkdownV2、UTF-16 计长、forum topics、断线保持入站（本篇深讲） |
| Discord | `plugins/platforms/discord/adapter.py` | 7,308 行，最大适配器：语音混音/opus、slash 授权、组件（按钮）授权、guild scope 隔离、自动建 thread |
| Slack | `plugins/platforms/slack/adapter.py` | 6,961 行；Block Kit、thread 水印、原生流式（`draft_stream_is_message`，四条流式不变量的主战场） |
| Matrix | `plugins/platforms/matrix/adapter.py` | 3,283 行；E2E 加密（Olm/Megolm）、服务器 scope |
| Signal | `plugins/platforms/signal/adapter.py` | signal-cli 桥、UUID 主键（`user_id_alt` 的由来） |
| LINE | `plugins/platforms/line/adapter.py` | 60 秒单次 reply token 硬时限；`_keep_typing` 子类化范式的出处（中途气泡 + RequestCache 状态机） |
| 微信（个人） | `plugins/platforms/weixin/adapter.py` | 个人微信接入 |
| 企业微信 | `plugins/platforms/wecom/adapter.py` | 原生 msgtype "stream" 流式（stream consumer 的 native 传输之一） |
| QQ（官方机器人） | `plugins/platforms/qqbot/adapter.py` | QQ 官方开放平台 |
| 钉钉 | `plugins/platforms/dingtalk/adapter.py` | DingTalk AI Cards（REQUIRES_EDIT_FINALIZE 强制最终编辑的案例） |
| 飞书 | `plugins/platforms/feishu/adapter.py` | 4,536 行；union_id（`user_id_alt`）、卡片消息、长连接事件 |
| iMessage | `plugins/platforms/bluebubbles/adapter.py` | 经 BlueBubbles 桥接 iMessage |

### B. 团队/办公与通知渠道

| 平台 | 目录 / adapter.py | 一句话特点 |
|------|-------------------|-----------|
| MS Teams | `plugins/platforms/teams/adapter.py` | 与内置 msgraph webhook（变更通知入站）配对的聊天发送面 |
| Mattermost | `plugins/platforms/mattermost/adapter.py` | 自托管 Slack 替代 |
| Google Chat | `plugins/platforms/google_chat/adapter.py` | HTTP 事件未确认前跑在 `retryable_ingress()`（parked 路由回 503，释放去重认领） |
| Email | `plugins/platforms/email/adapter.py` | SMTP 发送 + IMAP 收信，主题/thread 映射 |
| ntfy | `plugins/platforms/ntfy/adapter.py` | 推送通知通道（广播面报告 `dm`，`/login` 据此拒绝） |
| SMS | `plugins/platforms/sms/adapter.py` | 359 行，最小适配器之一 |

### C. 协议/自托管/代理类

| 平台 | 目录 / adapter.py | 一句话特点 |
|------|-------------------|-----------|
| WhatsApp（Baileys 桥） | `plugins/platforms/whatsapp/adapter.py` | 非官方桥；与 Cloud API 共享 `whatsapp_common.py::WhatsAppBehaviorMixin`；桥按 profile 独立（pid+端口+启动时间的 pidfile 认领） |
| WhatsApp Cloud | `plugins/platforms/whatsapp_cloud/adapter.py` | Meta 官方 Cloud API；同一行为 mixin，独立 `Platform.*` 枚举可并存 |
| IRC | `plugins/platforms/irc/adapter.py` | 619 行；**token lock 的 canonical 实现**（`acquire_scoped_lock` 防两 profile 共享一个 nick） |
| Nostr | `plugins/platforms/buzz/adapter.py` | 1,966 行；Nostr 协议 |
| SimpleX | `plugins/platforms/simplex/adapter.py` | 隐私优先消息协议 |
| A2A | `plugins/platforms/a2a/adapter.py` | agent-to-agent 协议面 |
| Raft | `plugins/platforms/raft/adapter.py` | 广播面（对 `/login` 报 `dm`） |
| Photon | `plugins/platforms/photon/adapter.py` | 1,758 行；Photon 接入 |

每个目录除 `adapter.py` 外通常还有 `plugin.yaml`（声明 `requires_env`/`optional_env`、setup 提示）与若干辅助模块（如 discord 的语音混音、telegram 的 update_admission.py）。

## 关键代码走读：Telegram 适配器解剖

### 1. 类声明与能力自述

```python
# 来源：plugins/platforms/telegram/adapter.py:519-557（节选）
class TelegramAdapter(TelegramHeldInboundMixin, TelegramTopicRoutingMixin, BasePlatformAdapter):
    """Telegram bot adapter: users/groups, MarkdownV2 replies, forum topics, media."""

    MAX_MESSAGE_LENGTH = 4096
    supports_code_blocks = True  # MarkdownV2 renders fenced code blocks
    splits_long_messages = True  # send() chunks via truncate_message(MAX_MESSAGE_LENGTH)
    RICH_MESSAGE_MAX_CHARS = 32768  # Bot API 10.1 rich cap; above it use legacy chunking
    MEDIA_GROUP_WAIT_SECONDS = 0.8
    HELD_INBOUND_MAX = 64  # inbound events held across a disconnect window; oldest dropped first
    # send() can race a disconnect blip; failing "Not connected" (retryable=False) parks the answer in the
    # delivery ledger until next boot, so wait briefly for _bot (or a replacement adapter) instead.
    _RECONNECT_WAIT_SECONDS = 15.0
    ...
    # edit_message applies MarkdownV2 only on finalize=True; without this flag stream_consumer skips
    # the final edit when raw text is unchanged.
    # Fixes #25710.
    REQUIRES_EDIT_FINALIZE: bool = True
    FALLBACK_ON_FINAL_EDIT_FLOOD: bool = True  # retrying a final edit burns the same flood budget
```

开头的类属性是给框架看的「问卷」：长度上限 4096、按 **UTF-16 code units** 计长（`message_len_fn` 返回 `utf16_len`，adapter.py:581-584——emoji 会占两个 UTF-16 码元，用 `len` 会超限）、`REQUIRES_EDIT_FINALIZE` 让 stream consumer 在原始文本未变时也强制做最终编辑。两个 mixin 排在基类前面（WhatsApp 同款纪律）：`TelegramHeldInboundMixin` 在断连窗口内持有入站事件（最多 64 条，最旧先丢），`TelegramTopicRoutingMixin` 管论坛话题路由。`_RECONNECT_WAIT_SECONDS` 的注释展示这个代码库的典型因果链：send 与断连竞态 → 非 retryable 失败 → 回复被投递账本扣押到下次启动 → 与其如此，不如短等 15 秒换重连的 bot。

### 2. 构造：update 收据要活过适配器替换

```python
# 来源：plugins/platforms/telegram/adapter.py:586-603（节选）
    def __init__(self, config: PlatformConfig):
        super().__init__(config, Platform.TELEGRAM)
        extra = self.config.extra
        self._app: Optional[Application] = None
        self._seen_update_ids: dict = {}
        self._inflight_update_ids: dict = {}
        # Completed update IDs survive adapter replacement and restarts (update_admission.py).
        # Resolved now: secondary profiles construct adapters inside their own home scope.
        from hermes_constants import get_hermes_home
        self._update_receipt_dir = get_hermes_home()
        self._update_receipts_loaded: set = set()
        self._update_receipts_dirty: set = set()
        self._update_receipt_flush: Optional[asyncio.Task] = None
        self._bot: Optional[Bot] = None
```

`_seen_update_ids` / `_inflight_update_ids` 是 getUpdates 的去重与并发防抖；已完成的 update id 会落盘（`_update_receipt_dir`）——适配器被替换、进程重启后，Telegram 的同一批 update 不会被二次消费。`get_hermes_home()` 在构造时解析是刻意的：次要 profile 的适配器在自己的 home 作用域里构造（这正是 Profile scope 的「绑定点」之一）。

### 3. 论坛话题：chat_type 的归一与建题

Telegram 的 forum 群组对网关是第五种 chat_type：

```python
# 来源：plugins/platforms/telegram/adapter.py:809-815
    @staticmethod
    def _normalize_chat_type(chat_type: Any, *, is_forum: bool) -> str:
        """Telegram chat type → gateway chat type (``private``→``dm``, ``supergroup``→forum/group)."""
        ...
            return "forum" if is_forum else "group"
```

`chat_type="forum"` 进入 `SessionSource`，配合 `thread_id`（话题 id）参与 session_key 派生；`_forum_topic_send_kwargs`（:1051）为 forum 与 DM 话题生成发送参数（注意 :1110 的注释：General 话题下 `sendChatAction` 仍**必须**带 `message_thread_id` 才能把「正在输入」气泡放进 General）。DM 里还能反向建题（`create_forum_topic`，Bot API 9.4+，:2500）——这是 `TelegramTopicRoutingMixin` 的题材恢复与话题延续能力的底层。

### 4. 事件上报路径（组装视角）

Telegram 适配器的入站组装链：PTB handler 收 update → 去重/在飞登记 → `_canonicalize(event.source)`（**身份最先**，见 platforms_framework.md）→ `_normalize_chat_type` + mention 模式匹配 + `reply_to` 上下文抓取 → 组 `MessageEvent`（`_group_allow_from` 按 dm/group 选允许名单键，:966）→ `handle_message`。出站链：`send()` → MarkdownV2 渲染（失败落 `bad_format`，基类分类器接手转纯文本重试）→ 长度切块（`splits_long_messages`）→ `SendResult(message_id=最后一块 id, continuation_message_ids=全部块)`。

## 核心类/函数

| 符号 | 位置 | 职责 |
|------|------|------|
| `TelegramAdapter` | plugins/platforms/telegram/adapter.py:519 | Telegram 全量适配器（轮询/webhook 双模式） |
| `TelegramHeldInboundMixin` | telegram 包 | 断线窗口持入站（HELD_INBOUND_MAX=64） |
| `TelegramTopicRoutingMixin` | telegram 包 | 论坛话题路由/恢复/建题 |
| `_normalize_chat_type()` | adapter.py:809 | private→dm、supergroup→forum/group 归一 |
| `message_len_fn` | adapter.py:582 | UTF-16 计长（平台计数差异的框架钩子） |
| `WhatsAppBehaviorMixin` | gateway/platforms/whatsapp_common.py | 双 WhatsApp 适配器共享的门控/allowlist/mention/markdown |
| `DiscordAdapter` | plugins/platforms/discord/adapter.py | 语音混音/opus、组件授权、guild scope |
| `SlackAdapter` | plugins/platforms/slack/adapter.py | Block Kit、原生流式（stream-is-the-message 四不变量） |
| `irc` 适配器的 `acquire_scoped_lock` 调用 | plugins/platforms/irc/adapter.py | 令牌作用域锁 canonical 示范 |

## 本组文件清单

| 文件 | 角色 |
|------|------|
| `plugins/platforms/telegram/adapter.py` | Telegram：MarkdownV2、forum topics、UTF-16、held inbound（7,385 行） |
| `plugins/platforms/discord/adapter.py` | Discord：最大适配器，语音/组件授权/自动 thread（7,308 行） |
| `plugins/platforms/slack/adapter.py` | Slack：Block Kit、原生流式（6,961 行） |
| `plugins/platforms/feishu/adapter.py` | 飞书：卡片、union_id、长连接（4,536 行） |
| `plugins/platforms/matrix/adapter.py` | Matrix：E2E 加密（3,283 行） |
| `plugins/platforms/buzz/adapter.py` | Nostr（1,966 行） |
| `plugins/platforms/google_chat/adapter.py` | Google Chat：retryable ingress（1,812 行） |
| `plugins/platforms/photon/adapter.py` | Photon（1,758 行） |
| `plugins/platforms/qqbot/adapter.py` | QQ 官方机器人（1,672 行） |
| `plugins/platforms/weixin/adapter.py` | 个人微信（1,434 行） |
| `plugins/platforms/whatsapp/adapter.py` | WhatsApp Baileys 桥（1,404 行） |
| `plugins/platforms/whatsapp_cloud/adapter.py` | WhatsApp Cloud API（1,137 行） |
| `plugins/platforms/email/adapter.py` | Email：SMTP/IMAP（1,031 行） |
| `plugins/platforms/line/adapter.py` | LINE：60s reply token 范式（998 行） |
| `plugins/platforms/signal/adapter.py` | Signal：UUID 主键（984 行） |
| `plugins/platforms/teams/adapter.py` | MS Teams 聊天面（870 行） |
| `plugins/platforms/wecom/adapter.py` | 企业微信：原生 stream 流式（887 行） |
| `plugins/platforms/dingtalk/adapter.py` | 钉钉：AI Cards（866 行） |
| `plugins/platforms/mattermost/adapter.py` | Mattermost（764 行） |
| `plugins/platforms/bluebubbles/adapter.py` | iMessage（724 行） |
| `plugins/platforms/simplex/adapter.py` | SimpleX（719 行） |
| `plugins/platforms/raft/adapter.py` | Raft 广播面（587 行） |
| `plugins/platforms/irc/adapter.py` | IRC：token lock canonical（619 行） |
| `plugins/platforms/a2a/adapter.py` | A2A（898 行） |
| `plugins/platforms/ntfy/adapter.py` | ntfy 通知（381 行） |
| `plugins/platforms/sms/adapter.py` | SMS（359 行） |
| `plugins/platforms/<name>/plugin.yaml` | 每目录一份：清单、env 声明、setup 提示 |

（行数为写作时快照，仅示相对体量。）

## 与其他模块的关系

- 每个适配器只依赖**框架**（`BasePlatformAdapter` + `PlatformEntry` 钩子 + `_shared` scoped 读取），经 `ctx.register_platform()` 注册——`platforms_framework.md` 是本篇的前置。
- 适配器的入站事件最终都汇入 `message_flow.md` 的 7 步链路；流式行为（draft/native stream）与 `streaming.md` 的消费者契约耦合。
- 凭据唯一型适配器（IRC、Telegram 等）在 connect 时取 `acquire_scoped_lock()`，是 Profile scope「一个凭据只属一个 profile」的执法点。
- WhatsApp 桥的 pidfile 认领（pid+start time+port）与 `_update_platform_runtime_status` 的 `needs_attention` 写入点，见 gateway/AGENTS.md § Unserved is reported。

## 总结

26 个插件适配器是「能力住在边缘」的最直接体现：核心（gateway 框架）只定义问卷，每个平台在插件里作答。体量从 SMS 的 359 行到 Telegram/Discord 的 7,300+ 行不等，但结构同构：能力自述的类属性 → 构造期解析 profile 作用域 → 入站归一（身份最先）→ 出站 SendResult + 错误分类。平台 API 的怪癖（UTF-16 计长、60 秒 reply token、forum 的 General 气泡）全部留在插件注释与测试里，框架绝不为其开分支。想写第 27 个平台，从 `platforms_framework.md` 第 6 节的 ADDING_A_PLATFORM 摘要开始，抄 `irc/`（最小完整示例）与 `line/`（子类化范式）。
