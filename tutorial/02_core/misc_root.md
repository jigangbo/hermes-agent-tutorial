# misc_root —— trajectory_compressor.py、batch_runner.py、registration_lifecycle.py

> 阅读前提：无。三个不属于"agent 运行时主链"的独立工具，但都是根目录正式成员。

## 文件概览

| 文件 | 行数 | 一句话 |
|---|---|---|
| trajectory_compressor.py | 867 | **离线**轨迹压缩器：把已保存的 agent 轨迹压进 token 预算（不是循环内压缩！） |
| batch_runner.py | 1,024 | 批量跑 agent：JSONL 提示词数据集 + 多进程池 + checkpoint 恢复 |
| registration_lifecycle.py | 95 | 可替换运行时注册的**所有权租约**（代际模型，不是值比较） |

## 关键代码走读（trajectory_compressor.py）

### 1. 它不是循环内的上下文压缩

```python
# trajectory_compressor.py:1-12
"""Trajectory Compressor — post-process agent trajectories into a token budget.

Strategy: protect the head (system, human, first gpt, first tool) and the last N
turns; from the middle, summarize only as many turns as needed (never splitting a
<tool_call>/<tool_response> pair) and replace them with one human summary turn.

Usage:
    python trajectory_compressor.py --input=data/my_run            # directory
    python trajectory_compressor.py --input=data/trajectories.jsonl --sample_percent=15
    python trajectory_compressor.py --input=data/trajectories.jsonl --output=out.jsonl --target_max_tokens=16000
"""
```

`agent/context_compressor.py` 是**运行中会话**的压缩引擎；本文件是**事后批处理**工具：输入 JSONL 轨迹文件或目录，输出压缩后的数据集。策略是"保头（system/首条 human/首条 gpt/首条 tool）+ 保尾 N 轮，中间只摘要到刚好达标，绝不切开 `<tool_call>/<tool_response>` 对，用一条 human 摘要轮替换"。它刻意避免导入重型上下文压缩器——`_response_finish_reason`（行 41）直接声明"local copy of `agent.context_compressor._response_finish_reason`: this standalone CLI deliberately avoids importing the heavy context compressor"；只有 `agent.compression_marker.elide_middle` 这类纯函数被复用。

### 2. 配置与指标

```python
# trajectory_compressor.py:105-134（节选）
@dataclass
class CompressionConfig:
    """Configuration for trajectory compression (tokenizer / targets / protected turns / summarizer / output / processing / metrics)."""
    tokenizer_name: str = "moonshotai/Kimi-K2-Thinking"
    target_max_tokens: int = 15250
    summary_target_tokens: int = 750
    protect_first_system: bool = True
    ...
    summarization_model: str = "google/gemini-3-flash-preview"
    base_url: str = OPENROUTER_BASE_URL
    api_key_env: str = "OPENROUTER_API_KEY"
    num_workers: int = 4
    max_concurrent_requests: int = 50  # Max concurrent API calls for summarization
    per_trajectory_timeout: int = 300
```

配置经 `_YAML_SECTIONS`（行 93，`yaml_key:attr` 映射）从 `configs/trajectory_compression.yaml` 装载。`TrajectoryCompressor`（行 281）的 `compress_trajectory`（行 554）/ `compress_trajectory_async`（行 563）执行单条压缩；`TrajectoryMetrics`（行 153）/ `AggregateMetrics`（行 186）产出逐条与汇总指标（压缩比、删除轮数、摘要 API 调用/错误数），`main`（行 831，fire CLI）支持 `--sample_percent`、`--dry_run`。

## 关键代码走读（batch_runner.py）

### 1. 批处理骨架

```python
# batch_runner.py:1-7
"""Batch Agent Runner — run the agent over a JSONL prompt dataset in parallel.

Batches are processed by a multiprocessing pool with per-batch ``batch_N.jsonl`` output,
checkpointing for ``--resume``, trajectories in from/value format, and tool-usage
statistics aggregated across all batches. See ``main`` (fire CLI) for usage.
"""
```

开头同样遵守"bootstrap 第一"（行 9-15，带半更新树容错）。`ALL_POSSIBLE_TOOLS = set(TOOL_TO_TOOLSET_MAP.keys())`（行 46）从 model_tools **自动派生**，保证每条轨迹的 `tool_stats` schema 一致（适配 Arrow/Parquet 的 HF 数据集），并在合并轨迹时过滤幻觉出的工具名。

### 2. BatchRunner 与工具集分布

```python
# batch_runner.py:428-466（节选）
class BatchRunner:
    """Manages batch processing of agent prompts with checkpointing and statistics."""

    def __init__(self, dataset_file, batch_size, run_name, distribution="default", max_iterations=10,
                 base_url=None, api_key=None, model="claude-opus-4-20250514", num_workers=4, ...):
        """Load the dataset (truncated to *max_samples*), validate *distribution*, create batches.

        ``ephemeral_system_prompt`` is used during execution but NOT saved to trajectories. ...
        """
        params = dict(locals())
        ...
        # Batch runs are their own execution surface; declaring it here keeps every
        # worker's task-run telemetry attributable instead of falling back to "unknown".
        self.platform = "batch"

        if not validate_distribution(distribution):
            raise ValueError(f"Unknown distribution: {distribution}. ...")
```

`--distribution` 直接消费 [toolsets.md](toolsets.md) 的 `toolset_distributions`（每个 prompt 独立采样工具集）；`self.platform = "batch"` 让共享指标不会把 worker 归到 "unknown" 执行面。`_AGENT_PASSTHROUGH`（行 59）列出逐字转发给每个 AIAgent 的参数；`_prepare_container_image`（行 178）支持数据集行携带 `image/docker_image`——Docker 后端先 inspect/pull 验证镜像再花 token。`run()`（行 803）是多进程池主循环，`main`（行 871）是 fire CLI（`--resume` 从 checkpoint 续跑）。

### 3. 成功/失败判定

`_tool_call_succeeded`（行 105）：JSON 结果有非空 `error` 或 `success: false` 才算失败；非 JSON 仅在"空或以 `Error:` 开头"时算失败——**非零退出码不是失败**（模型会自我纠正），且不做子串匹配避免误伤。

## 关键代码走读（registration_lifecycle.py）

### 1. 代际而非值：所有权租约

```python
# registration_lifecycle.py:1-5
"""Ownership leases for replaceable runtime registrations.

The coordinator models registration *generations*, not just value identity: the same provider
singleton may be registered again after an older ownership generation was unloaded.
"""
```

同一个 provider 单例可能被再次注册——按"值是否相等"判断归属会错乱，所以模型是**代际（generation）**：

```python
# registration_lifecycle.py:53-62（节选）
    def acquire(self, slot: Hashable, *, current: Any, previous: Any, restore: Callable[[Any], bool],
                finalize: Callable[[Any], None] | None = None) -> ReplacementLease:
        """Attach a new live generation to the matching active predecessor."""
        with self._lock:
            leases = self._active.setdefault(slot, [])
            predecessor = next((c for c in reversed(leases) if c.active and same_registration(c.current, previous)), None)
            lease = ReplacementLease(self, slot, current, previous, restore, finalize, predecessor)
            leases.append(lease)
            return lease
```

`acquire` 把新租约挂到"以 `previous` 为 current 的活跃前驱"上；`dispose`（行 63）按序执行 restore → finalize → 槽位清理（每一步即使前面抛异常也继续跑），并**只有最晚的活跃代际可以改写槽位**——两个代际共享同一对象身份时，注册表层的 CAS 分不清它们，这条规则避免了老代际覆盖新注册。`same_registration`（行 16）只做身份比较（元组逐元素），模块底部 `replacement_coordinator = ReplacementCoordinator()`（行 95）是进程级单例。消费者在插件侧：`hermes_cli/plugins*.py` 用它在插件重载时安全地换入/换出 provider 注册并在失败时回滚到前代。

## 核心类/函数

| 名称 | 位置 | 职责 |
|---|---|---|
| `CompressionConfig` | trajectory_compressor.py:106 | 压缩配置（tokenizer/目标/保护轮/摘要器/并发） |
| `TrajectoryCompressor.compress_trajectory(_async)` | :554/:563 | 单条轨迹的保头保尾压缩 |
| `TrajectoryMetrics` / `AggregateMetrics` | :153/:186 | 逐条/汇总指标 |
| `main` | trajectory_compressor.py:831 | fire CLI（采样/dry-run） |
| `BatchRunner` | batch_runner.py:428 | 数据集装载、分布校验、批次构建 |
| `BatchRunner.run` | batch_runner.py:803 | 多进程池主循环 + checkpoint |
| `_extract_tool_stats` | batch_runner.py:124 | 逐工具 count/success/failure 汇总 |
| `_prepare_container_image` | batch_runner.py:178 | 每条 prompt 的沙箱镜像验证 |
| `main` | batch_runner.py:871 | fire CLI（--resume 等） |
| `ReplacementLease` / `ReplacementCoordinator` | registration_lifecycle.py:24/:40 | 代际租约与槽位协调 |
| `acquire` / `dispose` | registration_lifecycle.py:53/:63 | 挂接前驱 / 回滚到前代 |
| `same_registration` | registration_lifecycle.py:16 | 纯身份比较 |

## 本组文件清单

| 文件 | 行数 | 角色 |
|---|---|---|
| trajectory_compressor.py | 867 | 离线轨迹压缩 CLI（区别于循环内压缩引擎） |
| batch_runner.py | 1,024 | JSONL 数据集批量跑 agent（多进程 + checkpoint） |
| registration_lifecycle.py | 95 | 可替换注册的代际所有权租约 |

## 与其他模块的关系

- **run_agent.py / model_tools.py**：batch_runner 直接 `from run_agent import AIAgent`、`from model_tools import TOOL_TO_TOOLSET_MAP`；trajectory_compressor 复用 `agent.compression_marker.elide_middle` 但拒绝整包导入压缩引擎。
- **toolset_distributions.py**：batch_runner 的 `--distribution`。
- **hermes_cli/plugins*.py**：registration_lifecycle 的唯一运行时消费者（插件重载的回滚语义）。
- **数据产物**：两者都写 JSONL 轨迹（`from/value` 格式、`trajectory_samples.jsonl`），是 RL/评测数据管线的两端。

## 总结

- 三个文件共同点是"围绕主循环但不进主循环"：一个产出训练数据、一个消费提示词数据集、一个守着插件注册的换代安全。
- trajectory_compressor 的"保头保尾 + 不切 tool 对"策略与循环内压缩共享思想但独立实现——离线工具不应背运行时的依赖重量。
- registration_lifecycle 用 95 行讲清了一个通用难题：同一个单例的两次注册，如何按代而非按值回滚。
