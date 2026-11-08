# 面向用户的自动化入口 —— 蓝图、建议、记事本与看板派发的关系

## 文件概览

cron/ 除了「跑任务」，还有一组帮用户**迈出第一步**的文件：`blueprint_catalog.py`（自动化蓝图目录——用户永远不写裸 cron 表达式）、`blueprint_plugins.py`（插件贡献的蓝图）、`suggestion_catalog.py` + `suggestions.py`（开箱即用的建议任务，一键接受）、`notepad.py`（跨唤醒的每任务 KV 记事本）、`bot_chat_legacy.py`（已退役 CLI 通道的遗留投递排水）。它们与看板（kanban）没有直接代码耦合，但共享同一片问题域——「把工作排队交给 agent」——所以本篇同时讲清 cron 与 `hermes_cli/kanban*` 看板派发器的分工边界（详细看板机制见 `tutorial/06_cli/kanban.md`）。

## 关键代码走读

### 蓝图：只有一个任务引擎

```python
# cron/blueprint_catalog.py:1-5
"""Automation Blueprints — one slot-schema definition per automation that every surface renders
natively: dashboard form (``blueprint_form_schema``), pre-filled ``/blueprint`` slash command
(``blueprint_slash_command``), agent seed prompt, docs deep-link. ``fill_blueprint`` validates
values into ``cron.jobs.create_job`` kwargs — there is no second job engine. Users never type raw
cron: ``schedule_template`` fixes the recurrence; only human parts (time, weekdays) are slots."""
```

设计要点有三层。**第一**，蓝图只是一个「槽位 schema」：`schedule_template` 钉死重复节奏，人类只填时间、星期几这类自由部分——杜绝用户写出 `0 9 * * 99` 这种坏表达式。**第二**，`fill_blueprint` 验证后落进 `cron.jobs.create_job` 的 kwargs——同一个引擎、同一套不变量校验，没有第二条创建通道。**第三**，同一份蓝图被四个表面原生渲染：仪表盘表单、预填的 `/blueprint` slash 命令、agent 种子 prompt、文档深链：

```python
# cron/blueprint_catalog.py（blueprint_slash_command 附近）
def blueprint_slash_command(blueprint: AutomationBlueprint, values: Optional[dict[str, Any]] = None) -> str:
    """Build the flattened ``/blueprint <key> slot=val …`` command string. Uses each slot's default
    when ``values`` is omitted (ready-to-paste for docs/dashboard). Free-text slots are quoted."""
```

插件可以贡献自己的蓝图（`blueprint_plugins.py`）：`ctx.register_automation_blueprint` 传入与内置相同的字段，`build_plugin_blueprint` 校验（坏输入抛 `ValueError`，注册方记录并忽略），键名强制命名空间为 `<plugin>:<key>`——**插件永远不能遮蔽内置蓝图**。`plugin_blueprints()` 在调用时读*活动 profile* 的插件管理器：插件按 profile 加载，这里没有任何跨 profile 缓存。

### 建议：同意优先，绝不自动创建

```python
# cron/suggestion_catalog.py:1-8
"""Curated catalog of starter cron-job suggestions.

These are the built-in automations Hermes can offer a new user out of the box — the ``catalog``
source of the unified suggestion surface. Each entry is a ready-to-run ``cron.jobs.create_job`` spec
wrapped as a suggestion; the user accepts via ``/suggestions``. Nothing here auto-schedules.

The "important-mail monitor" entry (``classify_items.py``: poll -> LLM-score urgency -> surface
above-threshold) is ONE catalog automation, not a standalone feature. New entries: append a
CatalogEntry with a self-contained prompt (cron jobs run with no chat context)."""
```

`suggestions.py` 是统一建议面：无论来源是 `catalog`（策展 starters）、`blueprint`（技能里的 `blueprint:` 块）、`usage`（自我改进回顾）还是 `integration`（已连接账号），每个建议都是一个可运行的 job spec，用户**接受**（`accept_suggestion`，行 167——调 `cron.jobs.create_job`）或**拒绝**（`dismiss_suggestion`，行 161——按 `dedup_key` 闩住，绝不重复骚扰）。存储镜像 `cron/jobs.py` 的纪律：原子替换、0600 权限。关键词是 **consent-first**：没有任何代码路径会替用户自动建任务。

### 记事本：跨唤醒的游标与水印

```python
# cron/notepad.py:1-7
"""Per-job durable KV notepad (cursors, watermarks) carried across cron wake-ups; profile-local
SQLite next to the executions ledger (same connection/pragma pattern as ``cron/executions.py``).

Caps are a documented contract: ``MAX_VALUE_BYTES`` (16 KB per value, UTF-8) and
``MAX_JOB_TOTAL_BYTES`` (64 KB per job, key+value). Oversized writes raise ``ValueError`` and leave
the store untouched — the notepad is prompt-injected each run. Write path is the CLI
(``hermes cron notepad <job_id> set ...``) via the terminal tool; no model tool is added."""
```

任务的每次运行默认没有记忆；`notepad` 给它一个持久 KV（游标、水位线、上次见过的 id）。两个上限是**文档契约**：超限写入抛 `ValueError` 且完全不动 store——因为记事本每次运行都会注入 prompt，一个 16KB 的值就可能挤占任务上下文。写路径刻意只有 CLI（经终端工具），**不加模型工具**——这正是根 AGENTS.md「足迹阶梯」的体现：终端 + 文件已能完成的事，不新增核心工具。`render_notepad_section`（行 149）负责把内容渲染进 prompt。

### 遗留排水：证据永不删除

```python
# cron/bot_chat_legacy.py:1-7
"""``cron/bot_chat_pending``: Bot Chat outputs whose target owner was not running yet.

``defer`` parks one (a cross-profile target whose gateway is down or still starting), and
the retired CLI lane left records of the same shape behind. Each still-``queued`` record is handed,
under its own id, to the target profile's live owner through the canonical
``tools.bot_live_delivery.deliver_to_live_owner`` door (idempotent per id). Records are
never deleted: they keep their final status as evidence, exactly as the old drain did.
A ``claimed`` record was an uncertain CLI turn and is never resent."""
```

退役通道的遗留记录被 `scheduler_tick._pre_dispatch_housekeeping`（`drain_legacy_pending()`）每次 tick 顺手排走：按记录自身 id 经规范投递门幂等移交；`claimed` 的记录曾是一次不确定的 CLI turn，永不重发。记录保留终态作为证据——与 `delivery_queue` 的「丢失好过重复」一脉相承。

## cron vs 看板派发：同一片问题域的两条通道

| 维度 | cron 任务（本模块） | 看板任务（`hermes_cli/kanban*`） |
|---|---|---|
| 触发 | 时间（cron/interval/一次性） | 看板状态（任务变 ready 即派发） |
| 存储 | 每 profile 的 `jobs.json` | 跨 worker 共享的 SQLite 看板 |
| 通道 | 独立 cron 会话（`skip_memory=True`） | 派发器 spawn 的 worker + 专用 `kanban_*` 工具集 |
| 隔离边界 | profile（home） | **board** 是硬边界（`HERMES_KANBAN_BOARD` 钉进 env）；tenant 是软命名空间 |
| 交付 | output/ + 多平台投递 | 任务状态机（complete/request-review/…）+ 经拥有 profile 的通知 |

看板派发器是长循环（默认 60s）：回收过期 claim、提升 ready 任务、原子认领、spawn 分配到的 profile——默认跑在网关内（`kanban.dispatch_in_gateway: true`），独立部署用 `plugins/kanban/systemd/hermes-kanban-dispatcher.service`。两条通道在两处相遇：**cron 运行可能恰好与一个看板 worker 同机共存**——所以看板的 prompt 注入点（`agent_init`、system prompt 回退、stop nudge）用 `agent/delegation_context.py::owned_kanban_task()` 解析所有权，工具可见性（toolset 里有 `kanban_show`）与继承的 `HERMES_KANBAN_TASK` 环境变量都不算所有权；失败熔断是 `kanban.failure_limit`（默认 2 次连续非成功自动 block），worker 以 `KANBAN_TERMINAL_PROVIDER_EXIT_CODE`（78——凭据被吊销、模型下架）退出时第一次就熔断且粘滞。看板全貌见 `tutorial/06_cli/kanban.md`。

## 核心类/函数

| 符号 | 位置 | 职责 |
|---|---|---|
| `AutomationBlueprint` / `BlueprintSlot` | `blueprint_catalog.py` | 槽位 schema 定义 |
| `blueprint_form_schema()` | `blueprint_catalog.py` | 仪表盘表单渲染 |
| `blueprint_slash_command()` | `blueprint_catalog.py` | 预填 `/blueprint <key> slot=val …` |
| `fill_blueprint()` | `blueprint_catalog.py` | 验证槽位值 → `create_job` kwargs |
| `build_plugin_blueprint()` | `blueprint_plugins.py` | 校验 + `<plugin>:<key>` 命名空间 |
| `plugin_blueprints()` | `blueprint_plugins.py` | 调用时读活动 profile 的插件管理器 |
| `CatalogEntry` / `CATALOG` | `suggestion_catalog.py:27` | 策展 starter 任务条目 |
| `seed_catalog_suggestions()` | `suggestion_catalog.py:118` | 把目录条目播种成建议 |
| `load_suggestions()` / `accept_suggestion()` / `dismiss_suggestion()` | `suggestions.py:79/167/161` | 建议面三原语（consent-first） |
| `set_note()` / `get_note()` / `list_notes()` | `notepad.py:79/108/126` | KV 记事本（16KB/64KB 契约） |
| `render_notepad_section()` | `notepad.py:149` | 注入 prompt 的渲染 |
| `drain_legacy_pending()` | `bot_chat_legacy.py` | 遗留记录按 id 幂等移交 |

## 本组文件清单

| 文件 | 角色 | 关键符号 |
|---|---|---|
| `cron/blueprint_catalog.py` | 自动化蓝图目录（唯一 job 引擎） | `AutomationBlueprint`, `fill_blueprint` |
| `cron/blueprint_plugins.py` | 插件贡献蓝图 | `build_plugin_blueprint`, `plugin_blueprints` |
| `cron/suggestion_catalog.py` | 策展 starter 任务目录 | `CatalogEntry`, `seed_catalog_suggestions` |
| `cron/suggestions.py` | 统一建议面（consent-first） | `accept_suggestion`, `dismiss_suggestion` |
| `cron/notepad.py` | 每任务持久 KV 记事本 | `set_note`, `MAX_VALUE_BYTES` |
| `cron/bot_chat_legacy.py` | 退役通道遗留排水 | `drain_legacy_pending` |
| `cron/scripts/classify_items.py` | 「重要邮件监视」目录条目的实际脚本 | poll → LLM 打分 → 超阈呈现 |

## 与其他模块的关系

- **hermes_cli/kanban*.py**：看板 CLI 门面 + 14 个 `kanban_*.py` 兄弟（boards/db/db_connect/db_dispatch/…）；cron 与它共享「排队交给 agent」的问题域但不共享代码。派发器 spawn 的 worker 用 `tools/kanban_tools.py` 的专用工具集（足迹阶梯第 3 级：schema 占位在任务外为零）。
- **tools/blueprints.py**：技能 frontmatter 里的 `blueprint:` 块变成 `blueprint` 来源的建议。
- **tools/bot_live_delivery.py**：遗留排水的规范投递门（按 id 幂等）。
- **agent/delegation_context.py**：`owned_kanban_task()` / `DELEGATED_CHILD_ENV_MARKER`——cron 与看板 worker 同机时的所有权判定与后代围栏（围栏是路径不是旗标）。
- **gateway/kanban_watchers_notifier.py**：看板通知经任务拥有 profile 的适配器发出，绝不走 multiplexer 的启动适配器。

## 总结

这一族文件回答「用户怎么从零开始有一个自动化」：蓝图把 cron 表达式藏进槽位、建议把第一个任务变成一键同意、记事本给无状态的任务一个跨唤醒的游标、遗留排水保证退役通道不留悬案。它们全部汇入唯一的 `create_job` 引擎——没有第二套任务语义。与看板的分工也由此清晰：**cron 管时间驱动的重复，看板管状态驱动的一次性协作**。
