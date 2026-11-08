# 系统架构专题 — 导览

本目录是整个教程的「骨架层」：在进入任何具体模块的逐文件走读之前，先用 7 篇横向专题建立全局心智模型。这些文档不逐行讲代码，而是回答「为什么这样设计」。

## 文档列表

| 文档 | 回答的问题 |
|------|-----------|
| [全局架构总览](big_picture.md) | 这个项目由哪几层组成？数据怎么流？ |
| [一次对话的完整生命周期](turn_lifecycle.md) | 用户按回车之后，代码走了哪条路？ |
| [提示词缓存不变量](caching_invariants.md) | 为什么"不许改历史"是铁律？怎么实现的？ |
| [状态与存储模型](state_model.md) | 会话、消息、压缩谱系存在哪？怎么保证并发安全？ |
| [工具系统全景](tool_system.md) | 一个工具从注册到被模型调用经过几道关？ |
| [安全边界模型](security_model.md) | 审批、SSRF、路径守卫、插件准入怎么分层设防？ |
| （跨切面主题分散在各模块 index 中） | 多 profile 复用、facade+siblings 模式 |

## 每篇专题的源码锚点

专题文档是"横向"的，但每篇都有承重的源文件。知道锚点在哪，读专题时才能随时下钻：

| 专题 | 主要源文件锚点 | 纵向下钻 |
|------|--------------|---------|
| 全局架构总览 | `run_agent.py`、`cli.py`、`gateway/run.py`、`hermes_cli/web_server.py` | [02_core](../02_core/index.md) |
| turn 生命周期 | `agent/conversation_loop.py`、`agent/turn_pipeline.md` 所覆盖的 33 个 `turn_*.py` | [03_agent](../03_agent/index.md) |
| 提示词缓存不变量 | `agent/system_prompt.py`、`agent/turn_request_assembly.py`、`agent/prompt_caching.py` | [03_agent/prompt_caching](../03_agent/prompt_caching.md) |
| 状态与存储模型 | `hermes_state.py` + 66 个 `hermes_state_*.py` 兄弟 | [07_state](../07_state/index.md) |
| 工具系统全景 | `model_tools.py`、`toolsets.py`、`tools/registry.py` | [04_tools](../04_tools/index.md) |
| 安全边界模型 | `tools/approval*.py`、`tools/url_safety.py`、`SECURITY.md` | [04_tools/approval_safety](../04_tools/approval_safety.md) |

## 建议读法

1. 先读 [全局架构总览](big_picture.md)，记住那张分层图；
2. 再读 [一次对话的完整生命周期](turn_lifecycle.md)，把分层图"跑"一遍；
3. [提示词缓存不变量](caching_invariants.md) 是全项目最重要的设计不变量 —— 理解它，后面 `agent/` 里 80% 的"奇怪"设计都会变得合理；
4. 其余三篇按需读：做后端必读 [状态与存储模型](state_model.md)，做工具/插件必读 [工具系统全景](tool_system.md) 与 [安全边界模型](security_model.md)。

## 横向 vs 纵向：这套专题和模块目录的关系

- **01 本目录（横向）**：跨模块回答一个主题 —— 比如缓存不变量同时牵涉 `agent/`（组装）、`gateway/`（卫生兜底）与 `hermes_state_*`（谱系缓存键）。
- **02-16 模块目录（纵向）**：顺着源码目录逐文件走读 —— 每篇文档都有「本组文件清单表」，是找"某个文件归属哪篇"的索引。

读法约定：横向专题建立"为什么"，纵向模块落实"是什么在哪"。两边互相引用 —— 专题里出现的每个文件，都能在某个模块文档的清单表里找到它的行。

## 关键术语速查

专题文档里反复出现的词，先混个脸熟（每个词在对应专题里有完整展开）：

| 术语 | 一句话 |
|------|--------|
| turn | 一次"模型调用 + 工具执行"的迭代单元；会话由多轮 turn 组成 |
| 会话（session） | 一条持久化的对话线（state.db 里一行，带来源标签） |
| 压缩（compaction） | 把长会话拆成"摘要头 + 保留尾"的新会话，经 `parent_session_id` 成谱系 |
| 谱系根（lineage root） | 压缩链的第一个会话 id；缓存键作用域取它，所以轮换不断缓存 |
| facade + siblings | 门面文件留公共入口，行为住 `<stem>_<topic>.py` 兄弟 |
| 租约（lease） | 跨进程的 turn 准入凭证（TTL + 续租 + 停滞看门狗） |
| check_fn | 服务门控工具的可达性回答函数（"这个工具现在可用吗"） |
| profile | 一个独立的 `HERMES_HOME`（自己的 config/state.db）；一个进程可服务多个 |
| mutation 回执 | "改状态"的闭合事务：要么完整发生，要么完全没发生 |

## 两条贯穿全部代码的设计不变量

1. **逐对话提示词缓存是神圣的** —— 过去上下文不可变、工具集不可中途更换、系统提示词会话期内字节稳定；唯一被允许的"破坏"是上下文压缩（这是一次刻意的、有补偿的缓存失效）。详见 [提示词缓存不变量](caching_invariants.md)。
2. **核心是窄腰，能力在边缘** —— 每个模型工具都会随每次 API 调用发送，所以核心工具门槛极高；新能力应该以「CLI 命令 + 技能」「服务门控工具（check_fn）」「插件」的形式到达边缘，而不是长进核心。

另一个无处不在的工程约束：**一个进程服务多个 profile**。所有非 turn 期代码（启动探测、驱逐、ticker、RPC 方法、线程跳转、子进程派生）必须显式绑定所属 profile 的作用域 —— `os.environ`、模块全局变量、导入期常量都只持有启动 profile 的值，未绑定的读取就是一次静默的跨 profile 泄漏。这是仓库自己承认的头号 bug 类型，也是阅读代码时最需要警惕的地方。

## 读专题时的三个自检问题

每读完一篇，合上文档回答对应的问题；答不上来就回去重读那一节：

| 读完 | 应能回答 |
|------|---------|
| big_picture | 一条 Telegram 消息、一次 REPL 输入、一次桌面点击，分别在哪个进程/哪个入口进入同一个核心？ |
| turn_lifecycle | turn 的五个阶段各自由哪些文件串起来？哪一步是"真正调用模型"的那一行？ |
| caching_invariants | 为什么改历史消息比多花 token 更贵？压缩为什么被允许破坏缓存？ |
| state_model | 为什么"改历史"必须走回执事务？WAL 模式下谁在写、谁在读？ |
| tool_system | 从模型吐出 tool_calls 到工具真正执行，中间经过几道门？哪几道是安全相关的？ |
| security_model | 哪一层是真正的安全边界？为什么模式扫描不算 containment？ |

## 下一步

专题读完就可以进模块目录了。按依赖顺序，下一站是 [02 核心门面层](../02_core/index.md) —— 根目录门面文件是所有模块的"入口清单"，读完就知道系统有哪些零件、各自住在哪。
