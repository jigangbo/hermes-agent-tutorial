# Shared Metrics 可观测性子系统

## 文件概览

`hermes_cli/observability/` 共 32 个 py 文件 + `schemas/` 4 个 JSON schema（v1..v4），实现 **shared_metrics：同意门控的用量遥测**。设计分层：

- **门**：`shared_metrics_consent.py`——唯一的同意答案；未同意一切为 no-op；
- **采集 API**：`shared_metrics_events.py`（进程级事实）、`shared_metrics_gateway.py`（网关/cron）、`shared_metrics_desktop.py`——调用点直接调，raw 值进、永不抛；
- **契约**：`shared_metrics_contract.py`（有界产品契约）+ `shared_metrics_fields.py`（字段构造器）+ `shared_metrics_catalog.py`（公开名目录）；
- **领域事实**：busy/connectors/efficiency/engagement/harness/loop/model/install/setup/update/startup/process/disabled/drift/prepared_compaction/signals 等一个主题一文件；
- **出口**：`shared_metrics.py`（SQLite 聚合 + 本地导出）、`shared_metrics_sender.py`（上传 Nous 遥测服务）、`relay_shared_metrics.py`（NeMo Relay 直连）、`shared_metrics_subscriber.py`（Relay 订阅者）、`shared_metrics_send_config.py`（传输配置）。

## 关键代码走读

一条事件的数据流：

**调用点 → `_emit()`（enabled 门）→ `fields_` 归一化 → `relay_shared_metrics.record_process_mark` → SQLite 聚合 → 每日导出包 → sender 上传。**

中途任何异常都在 `_emit` 的 try 内吞掉——遥测永远不影响用户的 turn；字段构造器返回 `None` 时该 mark 整个不落盘。

### 同意是唯一开关

```python
# hermes_cli/observability/shared_metrics_consent.py:1-10（节选）
"""The one shared-metrics consent answer, and the terminal's first-run offer.

Every surface reads and writes the same two keys in the profile's config.yaml:
``telemetry.shared_metrics.enabled`` (collect) and ``.send`` (upload daily). The offer has two
answers, and each sets both keys: "Share with Nous" turns both on, "No thanks" turns both off.
The question counts as answered once either key is written explicitly; the shipped defaults are
not an answer.
```

要点：

- 两个键 `telemetry.shared_metrics.enabled`（收集）与 `.send`（每日上传）**总是成对写**；出厂默认不算回答；
- 消息网关**从不**询问——聊天参与者不是安装所有者；终端在 `hermes setup` 末尾问，未回答的 profile 在首次交互 `hermes` 前问一次；桌面把征求画成 composer strip；
- 「No thanks」若缺 `offer_version`（早于 type-ahead 修复，启动中误按 Enter 可能 unseen 保存）会再问一次并附原因。

### 调用点 API：no-op 默认、永不抛

```python
# hermes_cli/observability/shared_metrics_events.py:1-8（节选）
"""Call-site API for process-level shared-metrics facts.

Setup completion, slash commands, compression, model switches, fallbacks and extension installs
happen outside any single tool or model call, so their producers call these functions directly.
Every function takes RAW values (normalization lives in shared_metrics_fields), is a no-op unless
shared metrics are enabled, and never raises into the caller.
"""

def _emit(mark: str, build: Callable[..., dict[str, str] | None], **raw: Any) -> None:
    try:
        from .relay_shared_metrics import enabled, record_process_mark

        if not enabled():
            return
        data = build(**raw)
        if data is not None:
            record_process_mark(mark, data)
    except Exception:
```

### record_slash_command：CLI 每条命令的计数点

```python
# hermes_cli/observability/shared_metrics_events.py:50-51
def record_slash_command(*, command: str, surface: str) -> None:
    _emit(contract.SLASH_COMMAND_MARK, fields_.slash_command_fields, command=command, surface=surface)
```

调用方是 `cli.py` `process_command`（`cli.py:1164`）——canonical 名 + surface（`"cli"`）。类属性 `_slash_metrics_surface: str | None = "cli"` 的注释说明了 None 的语义：另一个进程拥有计数（TUI slash worker 场景由 tui_gateway 记账），避免双计。

### 持久化与发送

`shared_metrics.py` 用 SQLite（`hermes_cli.sqlite_util.write_txn`）做持久聚合，按天导出 JSON 包（`utils.atomic_json_write`），atexit 兜底 flush。schema 版本 v1→v4 演进记录在 `observability/schemas/hermes.shared_metrics.v*.schema.json`——旧版本行经 `shared_metrics_drift.py`「conform」（未知维度形状整行降级）而不是丢弃。

### schema 演进与 drift 收敛

| schema | 内容要点 |
|---|---|
| v1 | 第一片：slash 命令、压缩、provider setup 等进程级事实 |
| v2 | 参与度/效率/模型质量等日聚合行 |
| v3 | connector 链路、harness 准确性、v5 信号（shared_metrics_signals） |
| v4 | 桌面自报、install.run、prepared compaction |

`shared_metrics_drift.py` 的职责：一个更早 build 或旧目录写入的行，其维度形状当前契约已不认识时，`conform_counter_dimensions()` 把它收敛成已知形状、`counter_dimensions_shape_is_known()` 判定是否整行降级——**数据向前兼容，而不是静默丢弃**。发送侧 `shared_metrics_send_config.py` 决定包怎么传，`shared_metrics_sender.py` 执行上传，`shared_metrics_subscriber.py` 是 Relay 订阅端。

## 核心类/函数

| 符号 | 文件 | 职责 |
|---|---|---|
| `OFFER_CHOICES` | shared_metrics_consent.py | 征求的两个答案（label, enabled, send） |
| `_emit()` | shared_metrics_events.py:30 | 统一出口：enabled 门 + 永不抛 |
| `record_slash_command()` | shared_metrics_events.py:50 | slash 命令计数 |
| `record_compression()` | shared_metrics_events.py:59 | 压缩事件（trigger/outcome/tokens） |
| `record_tool_search()` | shared_metrics_events.py:53 | connector 工具搜索（scope/hits/outcome） |
| `COUNTER_METRICS` / `SUM_METRICS` 等 | shared_metrics_contract.py | 有界契约常量 |
| `CLIENT_ACTIVE_METRIC` / `MILESTONE_METRIC` | shared_metrics_contract.py | 客户端活跃与里程碑契约名 |
| `slash_command_fields()` | shared_metrics_fields.py | raw 值 → 字段（归一化在此） |
| `record_process_mark()` | relay_shared_metrics.py | 进程 mark 落入 Relay 管道 |
| `enabled()` | relay_shared_metrics.py | 同意门查询 |
| `conform_counter_dimensions()` | shared_metrics_drift.py | 旧维度形状收敛 |
| `collect_snapshot()` | shared_metrics_snapshot.py | 每日一次的安装配置快照 |

## 本组文件清单

| 文件 | 职责 |
|---|---|
| __init__.py | 第一方可观测性集成包入口 |
| shared_metrics.py | 持久聚合与本地导出（SQLite + 每日 JSON 包） |
| shared_metrics_consent.py | 唯一同意答案 + 终端首跑征求 |
| shared_metrics_events.py | 进程级事实调用点 API（slash/压缩/模型切换/回退） |
| shared_metrics_gateway.py | 网关与 cron 的调用点 API |
| shared_metrics_desktop.py | 桌面自报事实：区域使用/摩擦/首跑步骤 |
| shared_metrics_contract.py | 第一片共享指标的有界产品契约 |
| shared_metrics_fields.py | 决策数据的字段构造器（归一化） |
| shared_metrics_catalog.py | 公开名目录：包可携带的唯一非枚举名 |
| shared_metrics_busy.py | 忙碌期到达与当日并发峰值 |
| shared_metrics_connectors.py | connector 搜索→执行链、批处理与搜索行 |
| shared_metrics_efficiency.py | 单 turn 成本、用户丢弃率、Hermes 的收益点 |
| shared_metrics_engagement.py | 每日参与汇总、会话计数、切换前 turn 数 |
| shared_metrics_harness.py | agent-harness 准确性：编辑匹配/循环守卫/工具后恢复 |
| shared_metrics_install.py | 安装快照：版本滞后/发布通道/粗粒度硬件 |
| shared_metrics_install_run.py | hermes.install.run：install.sh/install.ps1 全新安装 |
| shared_metrics_setup.py | hermes.provider_setup.count：provider 连接的起点/成功/失败/放弃 |
| shared_metrics_loop.py | 学习循环、委派、执行后端指标 |
| shared_metrics_model.py | 每模型质量、摩擦与上下文压力 |
| shared_metrics_prepared_compaction.py | 预备压缩的采纳与浪费方式 |
| shared_metrics_process.py | hermes.process.exit：进程（含 watchdog 杀掉的 turn）如何结束 |
| shared_metrics_disabled.py | 用户关闭/移除内置物的计数 |
| shared_metrics_drift.py | 旧版本/旧目录存储行的收敛 |
| shared_metrics_signals.py | v5 信号：模型伸手被禁工具、功能首采 |
| shared_metrics_startup.py | 启动/附着延迟：每进程启动一行分桶 |
| shared_metrics_snapshot.py | 每日一次的安装配置快照采集 |
| shared_metrics_update.py | `hermes update` 与桌面自更新的指标 |
| shared_metrics_send_config.py | 传输配置 |
| shared_metrics_sender.py | 导出包上传 Nous 遥测服务 |
| shared_metrics_subscriber.py | 持久片的 Relay 订阅者 |
| relay_shared_metrics.py | NeMo Relay 直连集成 |
| schemas/（4 个 JSON） | hermes.shared_metrics.v1..v4.schema.json |

## 与其他模块的关系

- **cli.py**：`process_command` 记 slash 命令；`run()` 挂 `shared_metrics_startup.cli_prompt_ready_handler`。
- **gateway/**：网关面经 `shared_metrics_gateway` 上报（chat 参与者永不被问同意）。
- **web_routers/shared_metrics.py**：dashboard 的 `/api/shared-metrics/consent` 端点。
- **apps/desktop/**：桌面经 RPC（consent-strip.tsx）读写同一对同意键。
- **AGENTS.md 铁律**：遥测必须有 opt-in 门——本子系统的同意键就是那道门。

## 总结

整套遥测的骨架是三句话：**同意（两个键成对写，默认不是回答）→ 原子事件（raw 进、永不抛、未同意即 no-op）→ 契约收敛（schema 有界、旧行 drift-conform 而不丢）**。新增指标 = 契约加一行 + fields 加一个构造器 + 主题文件加一个调用点。
