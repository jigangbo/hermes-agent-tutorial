# 策展人 —— 技能生命周期维护

## 文件概览

策展人是**后台的技能园丁**：跟踪 agent 创建技能的使用情况、按不活动自动迁移生命周期状态（`active → stale → archived`）、可选地 fork 一个 AIAgent 做 LLM 整合评审。核心在 `agent/curator.py`（1,218 行），备份/回滚在 `agent/curator_backup.py`（492 行），CLI 在 `hermes_cli/curator.py`（`hermes curator status|run|pause|resume|pin|unpin|archive|restore|prune|backup|rollback`），遥测在 `tools/skill_usage.py`。**触发是「不活动」而不是 cron 守护进程**：当 agent 空闲且上次运行距今超过 `interval_hours`（默认 7 天）时，`maybe_run_curator()` 才跑一遍——它寄生在 agent 的空闲心跳上，没有自己的定时器。

## 关键代码走读

### 触发门：空闲 + 间隔 + 认领

```python
# agent/curator.py:1204-1215
def maybe_run_curator(*, idle_for_seconds: Optional[float] = None, on_summary: Optional[Callable[[str], None]] = None) -> Optional[dict[str, Any]]:
    """Best-effort: run a curator pass if all gates pass. Returns the result dict if a pass was started, else None. Never raises."""
    try:
        # Idle gating: only enforce when the caller provided a measurement.
        if not should_run_now() or (idle_for_seconds is not None and idle_for_seconds < get_min_idle_hours() * 3600.0):
            return None
        if not _claim_run():  # the holder's own pass is the one counted; every tick would re-count it
            return None
        try:
            return run_curator_review(on_summary=on_summary, trigger="scheduled")
        finally:
            _release_run_claim()
    except Exception as e:
        logger.debug("maybe_run_curator failed: %s", e, exc_info=True)
        return None
```

三道门全部是「够格才跑」：时间门（`should_run_now()` 读 `.curator_state` 的 `last_run_at` 对比 `interval_hours`）、空闲门（调用方提供 `idle_for_seconds` 时要求 ≥ `min_idle_hours`，默认 2 小时）、认领门（`_claim_run()` 防止多个宿主/线程同时跑——持有者自己的 pass 才计入，否则每个心跳都会重复计数）。整个函数永不抛异常：策展人是 best-effort 的背景维护，故障只能降级为日志。调度状态持久在 `~/.hermes/skills/.curator_state`（`load_state`/`save_state`，行 30-53：last_run_at、paused、run_count 等，原子写）。

### 自动迁移：证据锚点与保护名单

```python
# agent/curator.py:209-221
def apply_automatic_transitions(now: Optional[datetime] = None) -> dict[str, int]:
    """Move every curator-managed skill between active/stale/archived based on its latest real activity; pinned skills are
    never touched. Built-ins are seeded with a baseline record on first sight so their inactivity clock starts NOW, not at epoch.
    Returns a counter dict."""
    from tools import skill_usage as _u

    now = now or datetime.now(UTC)
    stale_cutoff = now - timedelta(days=get_stale_after_days())
    archive_cutoff = now - timedelta(days=get_archive_after_days())
    # Cron-referenced skills are in use by definition (usage only bumps when a
    # job fires, so paused/rare jobs would age them out). Treat as pinned.
    protected = _cron_referenced_skills()
```

`apply_automatic_transitions`（行 209-263）是确定性的不活动行走，几个判定细节全是真实故障的伤疤：

- **锚点取「最后真实活动」或 `created_at`**——从未活跃的技能锚在创建时刻，不许按 epoch 起算自灭。
- **`use_count == 0` 是证据缺失，不是陈旧**：比 `stale_after_days`（默认 14 天）年轻的从未使用技能永不归档。
- **内置技能首见时播种基线记录**（`seed_record_if_missing` / `reanchor_clock`）——时钟从「策展人第一次看见」起算，不从 1970 年起算。
- **保护名单**：pinned 技能、被 cron 任务 `skills`/`skill` 字段引用的技能（遥测只在任务真的点火时 +1，暂停/低频任务会冤枉老化它们——按 pinned 对待）、锁定技能，全部跳过。

### 触碰边界：只碰 `created_by: "agent"`

```python
# tools/skill_usage.py:1-6（docstring 节选）
"""Skill usage telemetry + provenance for the Curator: a sidecar ``~/.hermes/skills/.usage.json`` keyed by
skill name (never frontmatter — keeps telemetry out of user-authored SKILL.md and off bundled/hub skills).
Counter bumps are best-effort (DEBUG-logged failures never break the tool call); writes are atomic under a
cross-process lock. Curator management is an explicit ``created_by: agent`` marker written by skill_manage —
never inferred from location. Lifecycle: active -> stale -> archived (moved to .archive/); ``pinned`` opts
out of auto transitions, orthogonal to state."""
```

策展人的最大铁律是**触碰范围**：只碰 `created_by: "agent"` 的技能——这是一个由 `skill_manage` 显式写入的标记，**绝不从位置推断**（bundled 与 hub 安装的技能天然越界；`skills.disabled` 名单里的技能 `skill_view` 都拒绝）。`curator.prune_builtins` 允许确定性不活动行走归档内置技能，但它们**永不进入 LLM pass 的候选名单**——fork 出的 agent 必须只被提供它有权读写的技能。第二条铁律是**永不删除**：archive 是上限（进 `~/.hermes/skills/.archive/`，可恢复）；`skill_manage(action="delete")` 拒绝 pinned 技能，但 patch/edit/write_file/remove_file 仍然可用——agent 可以继续改进它，只是不能除名。

### LLM 整合：opt-in 的 fork

```python
# agent/curator.py:268-276
CURATOR_DRY_RUN_BANNER = (
    "═══════════════════════════════════════════════════════════════\n"
    "DRY-RUN — REPORT ONLY. DO NOT MUTATE THE SKILL LIBRARY.\n"
    "═══════════════════════════════════════════════════════════════\n"
    "\n"
    "This is a PREVIEW pass. Follow every instruction below EXCEPT:\n"
    "\n"
    "  • DO NOT call skill_manage with action=patch, create, delete, "
    "write_file, or remove_file.\n"
    ...
```

LLM fork 默认**关闭**（`DEFAULT_CONSOLIDATE = False`，行 30）：确定性迁移总是跑（只要策展人启用），LLM 整合（pin/archive/consolidate/patch 建议）必须显式打开。fork 走 `auxiliary` 客户端（`_run_llm_review`，行 1087），**绝不触碰主会话的 prompt cache**——这正是根 AGENTS.md「提示词缓存神圣」不变量在后台任务上的投影。dry-run 模式在 prompt 顶部立起横幅：这是预览 pass，你的输出就是交付物，描述你*会*做什么；评审者读完报告再决定是否 `hermes curator run`（无旗标）真跑。

### 备份与回滚：可撤销的撤销

```python
# agent/curator_backup.py:1-4
"""Curator snapshot + rollback. Before any mutating curator pass, ``~/.hermes/skills/`` is tar.gz'd under
``~/.hermes/skills/.curator_backups/<utc-iso>/`` with a ``manifest.json``. Rollback first snapshots the CURRENT tree (so it is
itself undoable), then extracts the chosen snapshot into place. ...
Each snapshot also copies ``~/.hermes/cron/jobs.json`` as
``cron-jobs.json``: the consolidation pass rewrites cron ``skills``/``skill`` references in place, so rollback restores those two
fields (only) — the rest is live state."""
```

每次变更 pass 前整树快照（排除 `.curator_backups/`、`.hub/`、`.git/`；包含 `.usage.json`、`.archive/`、`.curator_state`——回滚连「上次运行时间」一起恢复，策展人不会立刻重新开火）。回滚**先给当前树拍快照**——回滚本身也可撤销。快照顺带抄走 `cron/jobs.json`：整合 pass 会原地改写 cron 任务的 `skills`/`skill` 引用，回滚只恢复这两个字段、其余维持现势——跨文件的引用一致性被显式建模。

## 核心类/函数

| 符号 | 位置 | 职责 |
|---|---|---|
| `maybe_run_curator()` | `curator.py:1204` | 三道门（时间/空闲/认领）+ 永不抛 |
| `should_run_now()` | `curator.py` | `interval_hours` 时间门 |
| `_claim_run()` / `_release_run_claim()` | `curator.py` | 并发 pass 互斥 |
| `run_curator_review()` | `curator.py` | 一次完整 pass（迁移 + 可选 LLM） |
| `apply_automatic_transitions()` | `curator.py:209` | 确定性 active/stale/archived 行走 |
| `_cron_referenced_skills()` | `curator.py` | cron 引用的技能按 pinned 对待 |
| `_run_llm_review()` | `curator.py:1087` | auxiliary fork 的 LLM 评审 |
| `CURATOR_REVIEW_PROMPT` / `CURATOR_DRY_RUN_BANNER` | `curator.py:268/292` | fork prompt 与 dry-run 横幅 |
| `load_state()` / `save_state()` / `set_paused()` | `curator.py:33/48/56` | `.curator_state` 读写 |
| `load_config_section`（语义） | `_read_config_section` | `curator:` 配置节读取 |
| `record_snapshot()` / `rollback()` | `curator_backup.py` | tar.gz 快照 + 可撤销回滚 |
| `DEFAULT_KEEP = 2` | `curator_backup.py:29` | 快照保留数 |
| `bump_use/view/patch`（语义） | `tools/skill_usage.py` | 遥测计数（原子 + 跨进程锁） |
| `curated_report()` | `tools/skill_usage.py` | 策展视角的技能全表 |
| `set_state()` / `STATE_*` | `tools/skill_usage.py` | 生命周期状态写入 |
| CLI 动词表 | `hermes_cli/curator.py` | status/run/pause/resume/pin/unpin/archive/restore/prune/backup/rollback |

## 本组文件清单

| 文件 | 角色 | 关键符号 |
|---|---|---|
| `agent/curator.py` | 策展核心（迁移 + LLM fork） | `apply_automatic_transitions`, `maybe_run_curator` |
| `agent/curator_backup.py` | 快照 + 回滚 | `record_snapshot`, `DEFAULT_KEEP` |
| `tools/skill_usage.py` | 遥测 sidecar `.usage.json` | `created_by` 标记消费 |
| `hermes_cli/curator.py` | `hermes curator <verb>` CLI | 11 个动词 |
| `agent/skill_manage`（工具，属 skills_tool 家族） | 策展动作的执行面 | `created_by: agent` 写入点 |

## 与其他模块的关系

- **agent/ 技能运行时**：策展人消费 `skill_view`/`skills_list` 的遥测；运行时视角见 `tutorial/03_agent/skills_runtime.md`。
- **cron/**：cron 任务的 `skills`/`skill` 字段把技能拉进保护名单；整合 pass 改写引用 → 备份抄走 jobs.json。
- **auxiliary 客户端**（`agent/AGENTS.md`）：LLM fork 的模型调用通道，与主会话 prompt cache 隔离。
- **skills hub**（`tools/skills_hub*`）：`.hub/` 目录被备份排除（hub 自管）；`created_by` 标记绝不从位置推断。
- **config.yaml**：`curator:` 节——`enabled, interval_hours, min_idle_hours, stale_after_days, archive_after_days, backup.*`。

## 总结

策展人的设计可以压缩成三个「绝不」：**绝不从位置推断管辖权**（只碰显式 `created_by: "agent"`）、**绝不删除**（archive 是上限、回滚可撤销）、**绝不在主会话上花一个 token**（fork 走 auxiliary、LLM pass 默认关）。生命周期只有一个信号——真实使用的不活动——但每个边界情况（从未使用、内置首见、cron 引用、pinned、锁定）都有显式的锚点或保护规则，因为每一处都是一次真实的误归档。
