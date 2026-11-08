# 提示词缓存不变量

> 这是全项目最重要的设计文档。LLM API 的 prompt caching 按**前缀逐字节匹配**计费折扣：请求的前 N 个 token 若与上次完全一致，就命中缓存。任何对历史上下文的改动都会使缓存前缀失效，成本成倍增加。Hermes 把这条经济学事实上升为架构铁律。

## 铁律原文（摘自根 AGENTS.md）

> **Per-conversation prompt caching is sacred.** Mutating past context, swapping toolsets, reloading memories or rebuilding the system prompt mid-conversation breaks the cached prefix and multiplies the user's cost; the ONE exception is context compression.

翻译成四条禁令：

1. **不可变更过去上下文** —— 转录只追加（append-only），永不改写历史消息；
2. **不可中途更换工具集** —— `agent.tools` 在 init 时定死（`agent/agent_init.py:1019`）；
3. **不可中途重载记忆/重建系统提示词** —— 系统提示词会话期内**字节稳定**；
4. **唯一例外是上下文压缩** —— 一次刻意的、有补偿的缓存失效。

## 实现的五个支柱

### 支柱 1：三层系统提示词（agent/system_prompt.py，889 行）

```
stable 层   身份/指引/环境事实          —— 整个会话一字不变
context 层  工作区快照、调用方 system_message、context 文件 —— 会话开始时定格
volatile 层 skills 索引、记忆、USER.md、时间戳 —— 依然只在会话开始时生成
```

三层用 `\n\n` 拼接。关键在 volatile 层的纪律：它虽然叫"易变"，但**只在会话开始时构建一次**；会话中途需要注入的新信息（技能命令展开、子目录提示）**绝不进系统提示词**，而是骑在 user 消息或工具结果上（`agent/skill_commands.py`、`agent/subdirectory_hints.py`）。

### 支柱 2：append-only 转录 + 请求级装饰副本（agent/turn_request_assembly.py）

每次迭代 `assemble_api_request`（行 106）构建**请求本地副本**：`api_messages`、`tools_for_api`。规范数据 `agent.messages` 与 `agent.tools` 保持原始、永不装饰。所有 provider 特定标记（如 Anthropic 的 `cache_control`）都打在副本上。缓存计划**最后**构建 —— 在一切转录变更之后。`_canonicalize_api_tool_calls` 做逐位规范化，保证前缀逐字节一致。

### 支柱 3：降级重标记（conversation_loop.py:1290）

fallback 切换到另一个 provider 时 `_redecorate_prompt_cache_for_provider` 会重新打缓存标记 —— 换供应商可以，但缓存断点必须跟上。

### 支柱 4：纯函数缓存规划器（agent/prompt_caching.py）

Anthropic `cache_control` 断点规划是纯函数：4 个断点（静态系统前缀尾、系统结尾、最后两条非系统消息；5m/1h TTL）。`agent/prompt_cache_boundary.py` 让消息构建者**声明**自己 user 消息里的"稳定脚手架边界"（技能/cron/webhook 注入），断点放置无需重新解析；`agent/prompt_cache_scope.py` 把物理会话 id 映射到**压缩谱系根**作为缓存键作用域（legacy 轮换会铸造新 id，谱系根保持缓存身份连续）。

### 支柱 5：压缩是唯一合法的破坏（agent/context_compressor.py，5,725 行）

压缩流程本身被设计成"最小化缓存损失"：
- 默认阈值 50%（`compression.threshold`，可按模型覆盖）—— 不是越早越好，而是让每次破坏都值得；
- 保护头尾、摘要中段、先无 LLM 剪枝旧工具结果（`context_compressor_prune.py`）；
- 破坏后新前缀立即稳定下来，进入下一轮长缓存命中周期；
- **micro_compaction 默认关闭**（`agent/micro_compaction.py`）—— 它逐轮重写前缀，是缓存杀手；
- 网关侧另有 85% 的会话卫生兜底（`gateway/run_turn_hygiene.py`），明确只是安全网，不与 agent 的 50% 重复。

## 守护者清单：不变量住在哪些文件里

想确认"这条纪律真的被守护着"，按表下钻（每行都能在对应模块文档里找到逐文件走读）：

| 不变量 | 守护文件 | 机制一句话 |
|--------|---------|-----------|
| 系统提示词会话期内字节稳定 | `agent/system_prompt.py` + `agent/prompt_builder.py` | 三层只在会话开始构建一次，`\n\n` 拼接后冻结 |
| 转录 append-only | `agent/conversation_loop.py`（:139-158 注释是范本） | 中途注入（steer、记忆预取、预算警告）只骑最新的工具结果行 |
| 请求重放当初的精确字节 | `agent/turn_request_assembly.py` 的 `api_content` sidecar | 规范数据不动，请求用 sidecar 重放 |
| 缓存断点规划 | `agent/prompt_caching.py`（纯函数，4 断点） | 静态系统前缀尾 / 系统结尾 / 最后两条非系统消息 |
| 注入点声明边界 | `agent/prompt_cache_boundary.py` | 消息构建者声明 user 消息里的"稳定脚手架边界" |
| 缓存键跨轮换连续 | `agent/prompt_cache_scope.py` | 物理会话 id → 压缩谱系根 |
| 降级后断点跟上 | `conversation_loop.py:1290` `_redecorate_prompt_cache_for_provider` | 换 provider 时重打 cache 标记 |
| 工具集 init 定死 | `agent/agent_init.py:1019` | `agent.tools` 构造期一次成型 |
| 中途注入有合法出口 | `agent/skill_commands.py`、`agent/subdirectory_hints.py` | 斜杠命令展开/子目录提示骑在 user 消息上，绝不进系统提示词 |
| 大结果不挤占前缀 | `agent/tool_result_storage.py` | 超大工具结果外置存储，行内留引用 |

## 两道阈值，别混淆

| 层 | 阈值 | 定位 |
|----|------|------|
| agent 层（`compression.threshold`） | 默认 50%，可按模型覆盖 | 主动的、设计好的压缩时机 —— 让每次缓存破坏都值得 |
| 网关层（`gateway/run_turn_hygiene.py`） | 85% | 明确只是**安全网** —— 兜住"没走正常压缩路径"的会话，不与 agent 的 50% 重复 |

理解这个分工很重要：网关兜底的存在不意味着 agent 层可以不做压缩 —— 两层各自独立计数，语义不同。

## 违反铁律的代码长什么样（真实约束）



严格角色交替也由此而来：`assistant(tool_calls) → tool → user` 是合法序列；唯一的独立 user 例外是 `/steer`（用户中途插话）。任何"在会话中途往系统提示词里加一句话"的需求，都会被审阅者用这条不变量否决 —— 正确做法是找到 user/tool 消息的注入点。

## 读代码时的自查清单

| 场景 | 问自己 |
|------|--------|
| 想改 `agent.messages` 里的旧消息？ | 停。用 `hermes_state_rewind` 的 carrier-aware 回退，或开新分支（`hermes_state_mutation_branch.py`） |
| 想按会话阶段换工具集？ | 停。toolsets 在 init 定死；子代理可以有自己的工具面（delegate_tool_toolsets.py），父会话不行 |
| 想把新知识塞进系统提示词？ | 停。找 user 消息/工具结果注入点（skill_commands、subdirectory_hints 是范例） |
| 想每轮更新时间戳/记忆块？ | 停。放在 volatile 层并在会话开始定格；真需要更新就触发一次压缩 |
| 想在会话中途调 `session_tool_scope`？ | 属于服务门控（check_fn 回答可达性），不是每会话表面切换 |

## 与其他文档的关系

| 文档 | 与缓存不变量的关系 |
|------|------------------|
| [一次对话的完整生命周期](turn_lifecycle.md) | 循环阶段视角：缓存计划在请求组装的哪一步构建 |
| [03_agent/compression](../03_agent/compression.md) | 压缩引擎细节：唯一合法的缓存破坏如何最小化损失 |
| [03_agent/prompt_caching](../03_agent/prompt_caching.md) | 断点规划器与边界声明的逐文件走读 |
| [状态与存储模型](state_model.md) | 压缩谱系怎么成为缓存键作用域（物理 id 轮换、谱系根连续） |
| [05_gateway/streaming](../05_gateway/streaming.md) | 网关侧流式为什么可以边生成边投递而不碰缓存前缀 |
| [02_core/toolsets](../02_core/toolsets.md) | 工具集为什么 init 定死：TOOLSETS 字典与各平台预设 |
| [16_dev_guide/contribution](../16_dev_guide/contribution.md) | 想加"会话中途改上下文"的功能时，rubric 会用这条不变量评审你 |
