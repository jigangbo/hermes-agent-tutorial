# 代码健康门禁

> `python scripts/check` 是 CI 全部阻塞检查的本地同款（含 CI 钉版工具）。它不只是 lint —— 是把架构决策变成可执行规则的检查族。规则的唯一事实源是 `scripts/code_health/config.py`：每条规则的 id、范围、修复文案都住在那里。

## 棘轮（ratchet）：只降不升

尺寸与复杂度按单元棘轮化。目标值（`config.py::TARGETS`，"unit" 的粒度是函数与文件）：

| 指标 | 目标 | 含义 |
|------|------|------|
| CC | ≤ 20 | 每函数圈复杂度（Python 用 ruff C901 口径） |
| FUNC_LINES | ≤ 300 | 每函数行数 |
| NESTING | ≤ 6 | 单函数内嵌套控制流层数 |
| FILE_LINES | ≤ 2,000 | 每文件行数 |

- **已经超标的单元只许下降**：超标单元以 base revision 的实测值作为自己的上限，只能往下走。修法：把函数挪进兄弟文件抵消增长，或把新测试放进新测试文件。
- **行为进兄弟文件，不进门面**；名字阶梯（name ladder）变成 dict → handler。

这保证了"大文件"只是历史存量，永远不会更糟 —— 这是对抗仓库腐化最便宜也最有效的机制。

理解粒度：棘轮按**单元**记账（函数级指标看函数，文件级指标看文件），搬动代码会带走它自己的 cap，这就是"offset the growth in the same PR"的原理。

**总开关 `ENFORCEMENT = "blocking"` 从 main 读，不从被测分支读**（CI 读合并提交的第一父提交，本地读 `origin/main`）—— 一个 PR 永远无法放松对自己的检查。想降级某条规则，是对 main 的一行提交；单条规则也可以用 `blocking=False` 单独降为告警。

## 规则族举隅（config.py::RULES）

| 规则 | 禁止 | 正确做法 |
|------|------|---------|
| HX001 | 硬编码 `~/.hermes` | `get_hermes_home()` / `display_hermes_home()` |
| HX003 | 从 argv 子串猜进程身份 | `gateway.status.looks_like_gateway_command_line` 等 |
| HX002/4/5/12 | 非 turn 期代码未绑 profile 作用域 | 显式绑定（见环境篇） |
| HX013 | 测试里新增裸 `sleep` | `wait_until` / `Event` |
| HX006 | subprocess/urlopen 无超时 | 传 `timeout=`；kill 后用 `wait()` 收尸 |
| HX007 | async def 里同步配置 I/O | `await asyncio.to_thread(load_config)` |
| HX008 | `asyncio.get_event_loop()` | 协程内用 `get_running_loop()`，入口用 `asyncio.run()` |
| S110 / BLE001 / E722 | 吞异常三兄弟：`except: pass`、盲捕 `Exception`、裸 `except:` | 精确捕获；兜底边界必须 re-raise 或 `logger.exception(...)` |
| RUF006 | 悬空 asyncio task | 持有引用并处理异常 |
| ASYNC230/240 | async def 里阻塞 open()/路径调用 | `await asyncio.to_thread(...)` |
| S113 | HTTP 请求无超时 | 传 `timeout=` |
| F821/F841 | 未定义名字 / 未用局部变量 | 导入或删除（`tui_gateway/*` 豁免 F821 —— 方法模块由 `bind_module` 注入名字） |

启发式规则先以 warning 运行，等冻结回放（`python -m scripts.code_health.replay`）证明其在已合并 PR 上的命中大多是真问题后再转 blocking —— 用证据而非品味决定哪些规则拦人。

## noqa 的代价

`# noqa` **不能**豁免棘轮发现（规则以 `--ignore-noqa` 运行）。要豁免必须写：

```python
# health: allow <RULE> -- <为什么这条豁免是安全的>
```

为什么？行内静默豁免会让规则慢慢失血；带理由的豁免让每次例外都可审计。

## 其他门禁组件

- `scripts/boundary_lint.py`（带 baseline）：**核心-插件边界** —— 核心不 import 具体内置插件，插件只用已发布 API（`hermes_cli/data/plugin_api.json` + `ctx`）。新跨越直接 CI 失败，存量已 baseline 化（细节见 [09_plugins/boundary_lint](../09_plugins/boundary_lint.md)）。
- `scripts/check_config_yaml_*`：配置系统一致性。
- `scripts/gen_*.py` 生成器 + 陈旧性测试：跨语言契约（Pydantic → TS、桌面 slash 注册表）靠生成保持同步 —— **改协议只改 Python 一侧**，生成物提交进库，漂移即红。
- `scripts/check_profile_scope_patterns.py`：profile 作用域模式扫描（HX002 族，见 [env_setup](env_setup.md)）。

## 范围豁免：哪些代码不受哪些规则管

`config.py` 用路径组表达"规则管到哪"（不是所有规则都全局生效）：

| 路径组 | 成员 | 语义 |
|--------|------|------|
| `PY_EXCLUDE` | `website/*`、`*/node_modules/*` | 永不检查 |
| `TS_EXCLUDE` | PY_EXCLUDE + `*.d.ts`、`*/dist/*`、`*/build/*`、`*/generated/*` | 生成物与声明文件不测尺寸 |
| `TESTS` | `tests/*`、`*/tests/*`、`tests-js/*`、`*/conftest.py` | 多数风格规则豁免测试（尺寸棘轮仍管） |
| `SINGLE_PROFILE` | TESTS + `scripts/*`、`skills/*`、`optional-skills/*`、`evals/*`、`setup.py` | 一次性进程只服务单 profile —— profile 作用域规则不适用 |

还有一条元规则 **MEASURE**：文件必须能被解析和测量才有资格被评判 —— 语法错误先修语法。

## 一次"门禁红了"的典型走法

```
python scripts/check
  → FILE_LINES: agent/context_compressor.py 5,725 > cap 5,725
      fix 文案: offset the growth in the same PR: move an existing function or class
      into a topical sibling <stem>_<topic>.py ...
  → 正确反应：把一个既有函数挪进兄弟文件（挪走的代码保留它自己的 cap），
    而不是删注释/压行来"凑数"
  → 若确属例外：# health: allow FILE_LINES -- <理由>，并在 PR 里说明
```

这个流程的关键设计：**修复文案由规则作者写、面向 agent**（config.py 的 docstring 原话："A rule's fix is the text the agent reads at the moment it trips the rule"）—— 门禁的输出不是冷冰冰的编号，而是下一步该做什么。

最后提醒：`scripts/check` 会先为每个候选提交（正在提交的 index、每个被推送分支的 tip）物化一份独立快照再判定 —— 钩子被同一 clone 的所有 worktree 共享，但**被检的是候选本身**，所以"我本地切在别的分支"不影响判定结果。

## 文档也是门禁对象

- 移动/改名符号**不做 re-export shim**（内部路径不是 API），但必须在同一 PR 里修好所有文档引用：grep `website/docs`、`skills/`、每个 `AGENTS.md`。
- `plugin-catalog/README.md` 的准入规则与开发者指南逐字镜像 —— CI 校验镜像一致。
- 根 `AGENTS.md` 上限 12k 字符、每条 root→area 链上限 30k —— `scripts/check` 强制，超了就写进 `website/docs/developer-guide/` 长文。

## 遇到门禁红了怎么办

1. 读规则的 `fix` 文案 —— `config.py` 里每条规则都写明仓库专属修法（比如 FILE_LINES 超标的修法是"挪一个既有函数进兄弟文件抵消"，而不是"删注释"）；
2. 超标的存量单元走"只降不升"，不要试图一次性修到目标值；
3. 确认豁免合理后用 `# health: allow` 带理由豁免，并在 PR 描述里说明；
4. 警告级的启发式规则（WARN_UNTIL_REPLAYED 未转正的）不算阻塞，但反复命中说明代码味道不对，顺手修掉；
5. 怀疑规则本身误报：拿 `python -m scripts.code_health.replay` 的回放证据开讨论 —— 规则靠证据转正/降级，流程对贡献者同样开放。
