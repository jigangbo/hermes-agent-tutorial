# 消息发送与定时任务工具组 —— send_message、cronjob 与 kanban

## 文件概览

agent 怎么「主动说话」和「按时干活」？消息侧 21 个文件以 `send_message_tool.py` 为门面（跨平台发送/列目标/回应），配平台 sender、目标解析、飞书/微软/Discord 适配、Bot Mode 的 agent 间私信链路、托管网关的身份与信任件。定时侧 6 个文件：`cronjob_tools.py` 是 `cronjob_manage` 工具（一个动作导向的压缩工具管增删改查/暂停/触发），`kanban_tools.py` 用一个循环注册 17 个看板工具。这组有个反直觉的事实要先立住：**`send_message` 刻意不注册为模型可调的工具**——agent 不该自己拍板跨平台发消息；真正注册的是 `cronjob_manage`、`react_to_message`、看板工具和连接器。本篇深讲 send_message_tool.py 与 cronjob_tools.py。

## 关键代码走读

### 1. send_message_tool.py：不注册的注册表

门面文件开头就有一段加粗级的声明（NOTE 注释）：`send_message` 故意不是 agent 可调工具，但它的助手函数被 cron 投递、`hermes send` CLI、看板通知器、opt-in MCP 服务器导入。这是一个「库优先」的设计——发送能力是基础设施，暴露给谁由调用方决定：

```python
# 来源：tools/send_message_tool.py:1-32（节选）
"""Send Message Tool -- cross-channel messaging via platform APIs (send, list targets,
react); works in both CLI and gateway contexts."""
...
from tools.send_message_targets import (
    _HOME_CHANNEL_ENV_OVERRIDES, resolve_send_target, unknown_platform_error,
)
from tools.send_message_senders import (
    _AUDIO_EXTS, _DEFAULT_CAPTION_LIMIT, _IMAGE_EXTS, _NO_DELIVERABLE, _VIDEO_EXTS, _VOICE_EXTS,
    _adapter_media_method, _error, _live_adapter, _media_caption_split, _plugin_standalone_sender,
    _registry_standalone_send, _resolve_slack_user_target, _sanitize_error_text,
    _send_matrix_via_adapter, _send_telegram)
from tools.registry import tool_error

# A bare Slack user id (session metadata / home-channel config) is opened as a DM; same shape the
# slack plugin's target parser turns into ``user:U...``.
_SLACK_USER_ID_RE = re.compile(r"^\s*(U[A-Z0-9]{8,})\s*$")

# NOTE: ``send_message`` is intentionally NOT registered as an agent-callable model tool
# (the agent must not fire cross-platform messages on its own); cron delivery, the
# ``hermes send`` CLI, the kanban notifier and the opt-in MCP server import the helpers.


def prepare_send_message_platforms() -> None:
    """Load enabled standalone plugins before tool schemas/cache keys are built."""
```

两兄弟的分工：`send_message_targets.py` 做**目标解析**——把 `platform:chat_id[:thread]` 三段式解析成各平台的 id（含主频道 env 覆盖 `_HOME_CHANNEL_ENV_OVERRIDES`），错误也按平台给出可行动提示（`unknown_platform_error`）；`send_message_senders.py` 做**发送**——按扩展名分类媒体（`_IMAGE_EXTS`/`_VOICE_EXTS`/`_AUDIO_EXTS`/`_VIDEO_EXTS`）、按平台选适配器媒体方法、Telegram/Matrix 有专属路径、插件可注册独立 sender、错误文本一律脱敏（`_sanitize_error_text`）。

### 2. 注册的边界：谁可以给模型「说话权」

组内真正注册进 registry 的只有 `react_to_message_tool.py`（桌面应用的 emoji 回应——用户 tapback 的对偶，属 `desktop_ui` toolset 的会话能力）；发消息的「模型可见面」由别处提供：委派的孩子默认被禁 `send_message`（delegation 的 blocked 清单），消息平台会话里 agent 对用户的回复走 gateway 适配器本身而非工具。这个不对称是刻意的安全姿态：**回复≠广播**。

### 3. cronjob_tools.py：一个工具，一个心跳

`cronjob_manage` 是「压缩的动作导向」设计——schema 里一个 `action` 枚举管 create/list/update/pause/resume/remove/trigger，避免每动作一个工具的 schema 膨胀。手工 `cronjob(action="run")` 会在进程内执行任务，为了让调用方的不活跃看门狗不误杀，执行期间按 10 秒心跳续命（与 base.py 的活动节奏一致、远低于默认 1800s 超时），并设 6 小时硬顶防「显式无限超时」的任务永久压制看门狗：

```python
# 来源：tools/cronjob_tools.py:1-6, 19-27（节选）
"""Cron job management tool: one compressed action-oriented `cronjob_manage` tool
(schema/context bloat avoided); `cronjob()` stays callable for direct Python callers."""
...
# Heartbeat cadence keeping the caller's inactivity watchdog at bay while a manual
# `cronjob(action="run")` executes in-process (comfortably below HERMES_AGENT_TIMEOUT).
# Mirrors the 10s cadence of tools/environments/base.py::touch_activity_if_due (delegate_task's heartbeat
# uses 30s) — comfortably below the 1800s default HERMES_AGENT_TIMEOUT. See #76502.
_CRON_RUN_HEARTBEAT_INTERVAL = 10.0
# Hard ceiling: with HERMES_CRON_TIMEOUT=0 a truly hung run would otherwise mask the
# gateway watchdog forever; past this the heartbeat stops and the watchdog regains authority.
_CRON_RUN_HEARTBEAT_CEILING = 6 * 3600.0
```

任务逻辑全部委托给 `cron/jobs.py`（claim/get/list/parse_schedule/pause/remove/resolve/trigger/update）——工具层只做参数规整（`cronjob_job_args.py`）与安全扫描（`cronjob_prompt_scan.py`：用户手写的 prompt 是不可信内容，吃**严格**威胁模式集）。注册带 `dynamic_schema_overrides`，schema 随配置活着：

```python
# 来源：tools/cronjob_tools.py:1263-1270
registry.register(
    name="cronjob_manage",
    toolset="cronjob",
    schema=CRONJOB_SCHEMA,
    handler=_cronjob_handler,
    check_fn=check_cronjob_requirements,
    emoji="⏰",
    dynamic_schema_overrides=_cronjob_schema_overrides,
)
```

### 4. kanban_tools.py：表驱动注册的样板

17 个看板工具的注册是全库最工整的表驱动：schema、handler、emoji 排成 `_TOOLS` 表，一个 for 循环逐个注册，orchestrator 专属工具走另一道 check_fn：

```python
# 来源：tools/kanban_tools.py:1300-1316（节选）
    ("kanban_schedule", KANBAN_SCHEDULE_SCHEMA, _handle_schedule, "⏰"),
    ("kanban_request_review", KANBAN_REQUEST_REVIEW_SCHEMA, _handle_request_review, "👀"),
...
for _name, _sch, _handler, _emoji in _TOOLS:
    _gate = _check_kanban_orchestrator_mode if _name in _ORCHESTRATOR_TOOLS else _check_kanban_mode
    registry.register(name=_name, toolset="kanban", schema=_sch, handler=_handler, emoji=_emoji,
                      check_fn=_gate)
```

这份表还解释了 registry.py 发现逻辑里「模块级 for 也算注册」分支的来历。schema 文本字节冻结在 `kanban_tools_schemas.py`（模型可见字符串改动要走评审），工具集上下文（某次 schema 构建显式选中哪些看板）在 `kanban_toolset_context.py`。看板本身是 kanban 调度器（cron/AGENTS.md 管辖）的工具面。

### 5. Bot Mode 与托管网关件

Bot Mode 让多个 Hermes 实例互为同伴。`bot_mode_dm.py` 的 `message_agent` 工具是 agent 间私信；`bot_mode_dm_chain.py` 做链式门控（把目标解析到目标身份所属的连接）；`_coordination` 管向多个队友的扇出与撤销自己的请求；`_outcome` 为每个请求产出一句给发送者醒来看的普通话；`bot_mode_probe.py` 是 Bot Chat 系统提示的 roster 探针；`bot_relay.py` 是跨连接中继——**连接本身就是同伴集合**；`bot_live_delivery.py` 是规范的 Bot Chat 传输 + 遗留投递回执；`bot_failure_reasons.py` 给失败原因定类型码。托管网关件在 tools/ 根目录：`managed_gateway_auth.py`（第一方网关的 bearer 信任）、`managed_gateway_identity.py`（调用者身份：谁在调用、哪个回合）、`managed_tool_gateway.py`（Nous 托管 vendor passthrough 的通用助手）。

### 6. 厂商适配三件套

`feishu_lark.py` 是飞书 doc/drive 工具共享的 lark_oapi 公共层；`feishu_doc_tool.py` 读文档，`feishu_drive_tool.py` 管评论（列出/回复/新增）。`microsoft_graph_auth.py`（client-credentials 应用令牌）与 `microsoft_graph_client.py`（REST 客户端助手）服务 Microsoft 系集成；`discord_tool.py` 用 REST API + bot token 做服务器自省与管理。

## 核心类/函数

| 符号 | 职责 | 位置 |
|---|---|---|
| `resolve_send_target`（send_message_targets） | `platform:chat_id[:thread]` → 平台 id 的目标解析 | `tools/send_message_targets.py` |
| `send_*` / `_plugin_standalone_sender`（send_message_senders） | 各平台 sender、媒体分类、插件独立 sender、错误脱敏 | `tools/send_message_senders.py` |
| `prepare_send_message_platforms` | schema/缓存键构建前加载启用的独立插件 | `tools/send_message_tool.py` |
| `react_to_message`（注册名） | 桌面应用的 emoji 回应（`desktop_ui` toolset） | `tools/react_to_message_tool.py:113` |
| `cronjob_manage`（注册名） | 定时任务的唯一工具面（create/list/update/.../trigger） | `tools/cronjob_tools.py:1263` |
| `_cronjob_handler` / `cronjob()` | 工具入口与直接 Python 调用入口（含 run 心跳） | `tools/cronjob_tools.py` |
| `_scan_cron_prompt`（cronjob_prompt_scan） | 用户 prompt 的严格威胁扫描 | `tools/cronjob_prompt_scan.py` |
| `kanban_*` 17 个工具（表驱动注册） | 看板的模型面（模式门控的 check_fn） | `tools/kanban_tools.py:1313` |
| `message_agent`（bot_mode_dm） | Bot Mode agent 间私信工具 | `tools/bot_mode_dm.py` |
| `gateway_config.connectors_available`（managed_gateway_auth） | 托管网关的 bearer 信任与身份（见 connectors.md） | `tools/managed_gateway_auth.py` |
| `feishu_doc_read` 等注册名 | 飞书文档/评论工具 | `tools/feishu_doc_tool.py` |

## 本组文件清单

消息群（21 个文件）：

| 文件 | 一句话角色 |
|---|---|
| `tools/send_message_tool.py` | 门面：发送/列目标/回应的助手库（**不注册**为模型工具）。 |
| `tools/send_message_senders.py` | 平台 sender 与媒体分类、错误脱敏。 |
| `tools/send_message_targets.py` | 目标解析（platform:chat_id:thread → id）与主频道覆盖。 |
| `tools/react_to_message_tool.py` | `react_to_message`：桌面 emoji 回应工具。 |
| `tools/discord_tool.py` | Discord 服务器自省与管理（REST + bot token）。 |
| `tools/feishu_doc_tool.py` | 飞书文档读取工具。 |
| `tools/feishu_drive_tool.py` | 飞书云盘评论工具。 |
| `tools/feishu_lark.py` | lark_oapi 公共层（doc/drive 共享）。 |
| `tools/microsoft_graph_auth.py` | Microsoft Graph 应用令牌认证助手。 |
| `tools/microsoft_graph_client.py` | Microsoft Graph REST 客户端助手。 |
| `tools/bot_relay.py` | Bot Mode 跨连接中继（连接即同伴集合）。 |
| `tools/bot_mode_dm.py` | `message_agent`：agent 间私信工具。 |
| `tools/bot_mode_dm_chain.py` | 私信目标的链式身份门控。 |
| `tools/bot_mode_dm_coordination.py` | 多队友扇出与自撤请求的协调。 |
| `tools/bot_mode_dm_outcome.py` | 每个请求结果的一句话回执。 |
| `tools/bot_mode_probe.py` | Bot Chat 系统提示的 roster 探针。 |
| `tools/bot_live_delivery.py` | 规范 Bot Chat 传输 + 遗留投递回执。 |
| `tools/bot_failure_reasons.py` | Bot 回合与中继回复的类型化失败码。 |
| `tools/managed_gateway_auth.py` | 第一方网关的 bearer 信任。 |
| `tools/managed_gateway_identity.py` | 托管网关调用的调用者身份。 |
| `tools/managed_tool_gateway.py` | Nous 托管 vendor passthrough 的通用助手。 |

cron/kanban 群（6 个文件）：

| 文件 | 一句话角色 |
|---|---|
| `tools/cronjob_tools.py` | `cronjob_manage` 工具：动作导向的定时任务管理。 |
| `tools/cronjob_job_args.py` | 任务参数的规整、校验与结果塑形。 |
| `tools/cronjob_prompt_scan.py` | 用户 prompt 的严格威胁扫描。 |
| `tools/kanban_tools.py` | 17 个看板工具的表驱动注册与处理。 |
| `tools/kanban_tools_schemas.py` | 看板工具 schema（字节冻结的模型可见文本）。 |
| `tools/kanban_toolset_context.py` | 一次 schema 构建中的显式看板选择上下文。 |

## 与其他模块的关系

- `cron/`（调度器）：`cron/jobs.py` 是任务逻辑的真身；`cron/AGENTS.md` 管调度器不变量与 kanban 派发。工具层只是壳。
- `gateway/`：平台适配器（Telegram/Slack/…）是消息的送达端；`send_message_senders` 的 `_live_adapter` 复用它们的连接。网关的 busy/idle 审批与投递回执与 `bot_live_delivery` 对接。
- `plugins/`：独立 sender 插件与 STT/TTS 插件同机制；`prepare_send_message_platforms` 在 schema 构建前加载。
- `tools/delegate_tool_toolsets.py`：`send_message` 在孩子的 blocked 清单里——叶子不许对外广播。
- `cronjob` 的持久性承诺：AGENTS.md 明说「必须活过重启的工作用 cronjob 或 terminal(background=true, notify_on_complete=True)」——后台委派是进程本地的，定时任务是持久的。

## 总结

这一组的主题是**能力的边界画在哪里**。`send_message` 拥有全部发送能力却拒绝成为模型工具——广播权留给 cron 投递、CLI 和看板通知这些「有正当理由」的调用方；`cronjob_manage` 相反，把八种操作压进一个动作枚举的工具，schema 不膨胀，任务逻辑原封不动地留在 `cron/` 调度器里；kanban 用 17 行注册表展示了表驱动如何让「多工具」变成零负担。安全细节同样成体系：用户手写的 cron prompt 吃严格威胁扫描，手工 run 有心跳续命 + 6 小时硬顶，Bot Mode 的每条私信都过链式身份门。最后记住那个持久性分工：后台委派怕重启，定时任务不怕——选错载体，工作就会在下次部署时消失。
