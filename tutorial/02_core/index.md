# 02 核心门面层（Root Facades）总览

> 阅读前提：已读完 [01_architecture/big_picture.md](../01_architecture/big_picture.md)。本章讲的是根目录那一层"看起来很大、其实很薄"的文件。

## 什么是 facade + siblings 模式

Hermes 的前身是几个三千到五千行的"上帝文件"。拆分方式不是按层，而是按**主题**（topic），最终沉淀出一个全仓库通用的布局约定（根 `AGENTS.md` § Facade + siblings layout）：

- **门面（facade）**：`run_agent.py`、`cli.py`、`hermes_state.py`、`model_tools.py` 这类保留原名的大文件。它只保留两样东西——**公共入口点**（构造函数、`run()`、`main()`）和**其他包会 import 的名字**。它是全仓库对外的"地址簿"。
- **兄弟（sibling）**：`<stem>_<topic>.py`，例如 `hermes_state_compression.py`、`agent/turn_facade.py`。每个兄弟只拥有**一个主题**，真正的行为代码住在这里。
- **兄弟在函数体内 late-import 门面**：兄弟文件绝不写模块级循环导入，而是在函数内部 `from hermes_state import SessionDB`。这一条规则带来一个非常重要的副作用——

### 为什么"函数内 import 门面"使门面成为 patch seam

```python
# hermes_state_compression.py（兄弟，示意）
def compress_session(db, session_id):
    from hermes_state import SessionDB   # ← 函数体内才 import 门面
    ...
```

生产代码运行时解析的是 `hermes_state.SessionDB` 这个**门面上的名字**。因此：

- `monkeypatch.setattr("hermes_state.SessionDB", fake)` 生效——因为兄弟在调用瞬间才去门面取名字；
- 而 patch 定义模块（`hermes_state_compression.SessionDB`）会**静默失效**——没人从那里读。

根 AGENTS.md 把这条写成规则："**Patch where production reads**"。反过来讲，**门面是所有测试和 monkeypatch 的合法接缝**；兄弟模块内部互相引用时也遵循同样模式。

### 三条配套纪律

1. **行为永远写进兄弟，不写进门面**——门面只加"名字"，不加逻辑；行数与复杂度按单元设棘轮（`scripts/code_health/config.py`），已经超标的单元只许下降。
2. **移动符号不提供 re-export shim**——内部路径不是 API；搬家必须在同一个 PR 里 grep 修完 `website/docs`、`skills/`、每份 `AGENTS.md`。
3. **找代码按主题 grep，而不是读门面**——门面几百个 re-export 是机械拆分的产物（cli.py 的 `#116911`），不代表实现位置。

## 根目录文件地图

根目录共 86 个 `.py`（其中 `hermes_state.py` + 64 个 `hermes_state_*.py` 兄弟占了 65 个）。按角色分组：

```
hermes-agent/（根目录 *.py）
│
├── ① 门面（facade）
│   ├── run_agent.py (1,565)   AIAgent 门面：14 个 mixin；turn 循环在 agent/turn_*.py
│   ├── cli.py (1,792)         HermesCLI 门面：18 个 mixin；REPL 逻辑在 hermes_cli/cli_*.py
│   ├── hermes_state.py (1,738) SessionDB 门面：18 个 mixin；SQLite 实现在 hermes_state_*.py ×64
│   └── model_tools.py (1,018) 工具注册表之上的编排层（发现/组面/派发）
│
├── ② 契约与配置表
│   ├── toolsets.py (507)              TOOLSETS 字典 + 解析器（名字 → 工具名集合）
│   ├── toolset_distributions.py (106) 批量跑数据时的工具集概率分布
│   └── registration_lifecycle.py (95) 可替换注册的所有权租约（代际模型）
│
├── ③ 常量与路径（import-safe，无重依赖）
│   ├── hermes_constants.py (1,490)      get_hermes_home() 等全部 profile 感知路径
│   ├── hermes_constants_scratch.py      scratch 目录保留规则（idle 检测 + 收割）
│   ├── hermes_constants_scratch_detach.py scratch 清理的分离子进程
│   └── hermes_constants_scratch_stuck.py  删不掉的 scratch 记录（POSIX）
│
├── ④ 启动与可观测性
│   ├── hermes_bootstrap.py (622)       每个入口点的第一个 import（UTF-8/PM 激活…）
│   ├── hermes_logging.py (1,053)       日志子系统（轮转/脱敏/队列化）
│   └── hermes_startup_watchdog.py (513) 启动活性看门狗（事件循环之前也能开枪）
│
├── ⑤ 主机事实 / ACL
│   └── hermes_dir_acl.py (462)         Windows 提权进程建目录后的用户 ACL 修复
│
├── ⑥ 状态库兄弟（65 个文件里这一组就是全部主题）
│   ├── hermes_state.py            门面
│   └── hermes_state_*.py ×64      sessions/messages/compression/fts/wal/repair/…
│
└── ⑦ 工具函数与离线工具
    ├── utils.py (869)                  原子写/文件签名/URL 主机判定/代理环境归一
    ├── hermes_time.py (150)            时区感知时钟 now()
    ├── hermes_yaml.py (98)             YAML 1.1 统一策略（ruamel）
    ├── trajectory_compressor.py (867)  离线轨迹压缩器（非循环内压缩）
    └── batch_runner.py (1,024)         JSONL 提示词数据集批量跑 agent
```

> `setup.py` 是打包残留，不属于运行时门面层；`hermes_cli/`、`agent/`、`tools/`、`gateway/` 等包是兄弟们的家，见各自目录的 `AGENTS.md`。

## 各文档链接

| 文档 | 覆盖文件 | 一句话 |
|---|---|---|
| [run_agent.md](run_agent.md) | run_agent.py | AIAgent：14 个 mixin 的门面 + 60 参数的纯转发 `__init__` |
| [model_tools.md](model_tools.md) | model_tools.py | 工具发现、组面解析管线、10 步派发管线 |
| [toolsets.md](toolsets.md) | toolsets.py, toolset_distributions.py | 三层工具集 + 21 个平台包 + 批量分布 |
| [cli.md](cli.md) | cli.py | 交互 REPL：18 个 mixin、斜杠派发表、prompt_toolkit 五步启动 |
| [hermes_state.md](hermes_state.md) | hermes_state.py + 64 兄弟 | SQLite 状态库：WAL、谱系、写路径纪律 |
| [hermes_constants.md](hermes_constants.md) | hermes_constants*.py ×4 | 永不硬编码 `~/.hermes`（HX001）的家 |
| [bootstrap_logging.md](bootstrap_logging.md) | hermes_bootstrap.py, hermes_logging.py | 第一个 import 与日志子系统 |
| [platform_acl.md](platform_acl.md) | hermes_dir_acl.py, hermes_startup_watchdog.py | Windows 目录 ACL + 启动看门狗 |
| [utilities.md](utilities.md) | utils.py, hermes_time.py, hermes_yaml.py | 原子写、时钟、YAML 策略 |
| [misc_root.md](misc_root.md) | trajectory_compressor.py, batch_runner.py, registration_lifecycle.py | 离线工具与注册租约 |

## 实用指南：找代码按主题 grep

门面文件不是阅读起点。记住这一条命令形状：

```bash
# 想找"会话标题"怎么实现的？不要打开 hermes_state.py 通读——
grep -rn "def .*title" hermes_state_*.py
# → hermes_state_titles.py: SessionTitlesMixin

# 想找"压缩谱系"？
grep -rn "def .*lineage" hermes_state_*.py run_agent.py agent/

# 想找某个斜杠命令？
grep -n "_handle_new_command" hermes_cli/cli_*.py
```

反向亦然：在 issue 报错栈里看到 `hermes_state.py:1014` 时，先看门面那一行是不是"生产读取点"（这里是 `_execute_write`），再顺着它的调用者找实现——修 bug 的 patch 应该打在门面接缝上。

三条判断经验：

1. **门面里只有两类代码**：`__init__` 转发器（`run_agent.py:236`）和 re-export 块（`cli.py:34-212`）。看到别的，通常是有意留下的"架构重量"方法（如 `_execute_tool_calls`），文档会点名。
2. **`_forward` / `_lazy_shim` 是把名字钉在门面上的两种手段**：`agent/lazy_forward.py` 的 `forward("agent.xxx", "func")` 让 `AIAgent._build_system_prompt` 仍然可从门面访问，而实现在兄弟里；`cli.py` 的 `_lazy_shim()` 则把重 import 推迟到第一次调用。
3. **看行号先看门面**：报错栈里出现 `run_agent.py:1308`、`hermes_state.py:1014` 这类门面行号时，那正是"生产读取"的位置——patch 接缝就在那里，而不是 `agent/tool_executor.py` 或 `hermes_state_messages.py`。

## 本章的读法建议

按依赖顺序读，而不是按文件大小读：

1. **先读 [hermes_constants.md](hermes_constants.md)**——`get_hermes_home()` 是所有路径的根，后续每篇都在引用它。
2. **再读 [run_agent.md](run_agent.md) 与 [model_tools.md](model_tools.md)**——这两个文件定义"一个 turn 是什么"（agent 门面 + 工具面 + 派发）。
3. **然后读 [toolsets.md](toolsets.md)**——工具集是二者的数据契约。
4. **[cli.md](cli.md) 与 [hermes_state.md](hermes_state.md)** 是两个最大的 mixin 门面，读的时候重点看"门面保留了什么"（分发表 / 写路径心脏），mixin 细节留给 06_cli 与 07_state。
5. **[bootstrap_logging.md](bootstrap_logging.md)、[platform_acl.md](platform_acl.md)、[utilities.md](utilities.md)、[misc_root.md](misc_root.md)** 是外围，可随时穿插。

每篇文档的「本组文件清单」表都是地图索引：一行一个源文件、一个不漏——目录树本身就是权威（"Counts shift constantly; the filesystem is canonical"），发现行数对不上时以磁盘为准。

## 总结

- 门面 = 公共入口 + 兼容导出；兄弟 = 按主题的实现；兄弟函数内 late-import 门面，使门面成为唯一可靠的 patch 接缝。
- 根目录 86 个 `.py` 里，65 个属于状态库一家；其余按"门面 / 契约表 / 常量 / 启动 / ACL / 工具"分组。
- 阅读任何一个门面文档时，把"本组文件清单"当作地图索引用——每一个源文件一行，一个不漏。
