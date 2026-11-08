# 审批与安全组 —— 危险命令的门、模式库与 SSRF 防线

## 文件概览

模型能跑 shell、能写文件、能发网络请求——如果没有一层「先问过人吗」的闸门，一次提示注入就足以酿祸。本组 21 个文件构成了 Hermes 的审批与安全地堡：`approval.py` 是危险命令审批的门面（门禁状态机 + 三个人类确认入口），`threat_patterns.py` 是全项目共用的提示注入/提示木马/外泄正则库，`url_safety.py` 挡住指向内网的 SSRF 请求，`self_repo_guard.py` 则防止 agent 用 git 改写自己脚下的代码检出。它们被终端工具、execute_code、memory、skills 安装、MCP 等几乎所有「有杀伤力」的工具调用。本篇深讲这四个核心文件，其余 17 个作为配套清单。

## 关键代码走读

### 1. approval.py：会话审批状态的中央账本

审批的前提是「记得之前答应过什么」。模块顶部一组由全局锁保护的状态字典，就是每个会话的审批账本——已批准命令、yolo 开关、永久白名单（按 profile 分桶）：

```python
# 来源：tools/approval.py:51-62
_lock = threading.Lock()
_pending: dict[str, dict] = {}
_session_approved: dict[str, set] = {}
_session_yolo: set[str] = set()
# Session keys whose launch YOLO (`hermes chat --yolo` session policy) was already seeded by
# ``tools.approval_yolo.apply_launch_yolo``: once per boundary, so a later `/yolo` off sticks.
_launch_yolo_applied: set[str] = set()
_permanent_approved: set = set()
# Routed multiplex profiles: one permanent allowlist per profile home (see ``_permanent_set``).
_permanent_approved_by_home: dict[str, set] = {}
```

一个立刻值得留意的细节是**启动时冻结的 YOLO 环境变量**：

```python
# 来源：tools/approval.py:46-48
# Frozen at import: reading os.environ per call would let any skill running in the process set
# this and bypass every approval check (prompt-injection escalation path).
_YOLO_MODE_FROZEN: bool = is_truthy_value(os.getenv("HERMES_YOLO_MODE", ""))
```

为什么冻结？如果每次调用都读环境变量，进程里跑着的任何一个技能（可能正被注入）都能临时把 `HERMES_YOLO_MODE` 设成真值，从而绕过所有审批。import 时拍快照，运行期改环境就无效了。

### 2. 连续拒绝熔断器：给「死磕」的 agent 踩刹车

当「智能审批」（辅助 LLM 当安全评审员）连续拒绝一个命令时，模型常常会换个写法再试。每试一次就烧一次 guardian LLM 调用，且行为逼近绕过。所以有一个按会话计数的熔断器：默认连续 3 次 deny 后，拒绝消息升级为硬性停止指令，且**只改工具结果文本、不动历史**——保持提示缓存前缀不变：

```python
# 来源：tools/approval.py:113-117
    return (
        f" CIRCUIT BREAKER: {count} consecutive commands were blocked by "
        "the security reviewer. STOP attempting variations of this "
        "operation. Report the blocked operation to the user and either ask them to run it manually or use /approve."
    )
```

计数本身（`_record_denial`，`approval.py:82-90`）用「弹出再插回」维持最近活跃会话在字典尾端，超 256 个会话就从最老的开始逐出。

### 3. threat_patterns.py：一份带「作用域」的攻击模式库

这是被 `agent/prompt_builder.py`、`tools/memory_tool.py`、`agent/tool_dispatch_helpers.py` 三处共用的正则库。它的两个设计决定值得细品。第一，每条模式带一个**累积作用域**：`"all"` 到处用，`"context"` 只用于非用户撰写的上下文内容（抓来的网页、记忆、工具结果——warn 级），`"strict"` 只用于用户中介的写入（记忆、技能安装——可阻断）。第二，模式必须锚定 C2（命令与控制）词汇或无歧义攻击行为，**禁止锚定命令式英语**——「you must」在正经的 AGENTS.md 里太常见了：

```python
# 来源：tools/threat_patterns.py:1-8（docstring 节选）
"""Shared threat-pattern library (prompt injection / promptware / exfiltration) for
``agent/prompt_builder.py``, ``tools/memory_tool.py`` and ``agent/tool_dispatch_helpers.py``.
Each pattern is ``(regex, pattern_id, scope)``; scope is cumulative: ``"all"`` everywhere,
``"context"`` adds promptware / C2 / role hijack for context files, memory and tool results
(warn-level: that content is not user-authored), ``"strict"`` adds aggressive checks only for
user-mediated writes (memory, skill installs) where a block is resolvable. New patterns must
anchor on C2 vocabulary or unambiguous attack behavior, NOT bossy English ("you must" is common
in legitimate AGENTS.md); filler between tokens is the bounded ``_FILLER``."""
```

具体条目示例——经典注入适用于一切场景；外泄模式则盯住「curl/wget 加上长得像密钥的环境变量」：

```python
# 来源：tools/threat_patterns.py:27,75-77
    (rf'ignore\s+{_FILLER}(previous|all|above|prior)\s+{_FILLER}instructions', "prompt_injection", "all"),
...
    (rf'curl\s+[^\n]{{0,2048}}{_SECRET_VAR}', "exfil_curl", "all"),
    (rf'wget\s+[^\n]{{0,2048}}{_SECRET_VAR}', "exfil_wget", "all"),
    (r'cat\s+[^\n]{0,2048}(\.env|credentials|\.netrc|\.pgpass|\.npmrc|\.pypirc)', "read_secrets", "all"),
```

两个工程细节：`_FILLER = r"(?:\w+\s+){0,8}"` 是**有界**填充——无界的 `(?:\w+\s+)*` 会在长文本上灾难性回溯；`MAX_SCAN_CHARS = 65_536` 给扫描文本封顶，因为扫描器是咨询性的，最坏运行时间必须有界。

### 4. url_safety.py：SSRF 的四道锁

SSRF（服务端请求伪造）的经典剧本：诱导 agent 请求 `http://169.254.169.254/`（云厂商元数据端点，能直接偷到 IAM 临时凭证）。url_safety 的防御分层：元数据 IP **无条件封禁**（连 `security.allow_private_urls: true` 都救不回），整个链路本地段封禁，且连 IPv4-mapped IPv6 形式（`::ffff:169.254.169.254`）都单独列出——因为解析器可能返回那种形式，而 ipaddress 库把它当作不同的地址：

```python
# 来源：tools/url_safety.py:70-87
# Cloud metadata hostnames — always blocked regardless of DNS or config toggle.
_BLOCKED_HOSTNAMES = frozenset({"metadata.google.internal", "metadata.goog"})

# Cloud metadata / credential endpoints (the #1 SSRF target) — always blocked, also in
# IPv4-mapped IPv6 form (resolvers may return ``::ffff:x.x.x.x``; ipaddress treats those as distinct).
_METADATA_V4 = (
    "169.254.169.254",  # AWS/GCP/Azure/DO/Oracle metadata
    "169.254.170.2",    # AWS ECS task metadata (task IAM creds)
    "169.254.169.253",  # Azure IMDS wire server
    "100.100.100.200",  # Alibaba Cloud metadata
)
_ALWAYS_BLOCKED_IPS = frozenset(
    {ipaddress.ip_address(ip) for ip in _METADATA_V4}
    | {ipaddress.ip_address("::ffff:" + ip) for ip in _METADATA_V4}
    | {ipaddress.ip_address("fd00:ec2::254")}  # AWS metadata (IPv6)
)
# Entire link-local range (no legit agent target), plus its IPv4-mapped form.
_ALWAYS_BLOCKED_NETWORKS = tuple(ipaddress.ip_network(n) for n in ("169.254.0.0/16", "::ffff:169.254.0.0/112"))
```

docstring 还点出两个高级攻防：**DNS rebinding（TOCTOU）**——校验时解析到公网、真正连接时 DNS 换成内网——由 `create_ssrf_safe_[async_]client()` 在 TCP connect 时**重新校验并直连已验证的 IP** 关掉；**重定向绕过**由响应钩子对每个跳转目标再次校验。

### 5. self_repo_guard.py：别锯掉自己坐的树枝

agent 跑在一份 git 检出上。一条 `git checkout` 或 `git reset --hard` 会把进程脚下的文件换成另一个版本——正在运行的代码和磁盘上的代码瞬间脱节。self_repo_guard 扫描 shell 命令，识别出「会改写本检出」的 git 操作。它的难点是 shell 的伪装手段：heredoc、`sudo`/`env`/`nohup` 等包装器、git 全局选项（`git -C 别处 checkout` 是安全的，`git -C 本处 checkout` 不是）。包装器参数表因此显式记录「哪些选项会吃掉一个参数」：

```python
# 来源：tools/self_repo_guard.py:41-53
_NO_OPTIONS: frozenset[str] = frozenset()
# Wrapper executables skipped to reach the real command -> options that consume an argument.
_WRAPPER_OPTIONS_WITH_ARG: dict[str, frozenset[str]] = {
    "sudo": frozenset({
        "-C", "--chdir", "-c", "--close-from", "-g", "--group", "-h", "--host",
        "-p", "--prompt", "-R", "--chroot", "-T", "--command-timeout", "-u", "--user"}),
    "env": frozenset({"-a", "--argv0", "-C", "--chdir", "-S", "--split-string", "-u", "--unset"}),
    "command": _NO_OPTIONS, "builtin": _NO_OPTIONS, "nohup": _NO_OPTIONS, "setsid": _NO_OPTIONS,
    "exec": frozenset({"-a"}), "nice": frozenset({"-n", "--adjustment"}),
    "time": frozenset({"-f", "--format", "-o", "--output"})}
_MAX_RECURSION = 4
# git global options that consume the next argument (-C/--work-tree/-c are acted on).
_GIT_GLOBAL_OPTIONS_WITH_ARG = frozenset(
    {"-C", "-c", "--work-tree", "--git-dir", "--namespace", "--exec-path"})
```

判定用的动词集合也很有讲究（`self_repo_guard.py:19-24`）：`checkout/switch/rebase/merge/pull/restore/clean/cherry-pick/revert/bisect` 是会改工作树的操作，连 `bisect` 都在——注释明说「bisect 会反复检出运行中的根，恰恰是这里防守的偏移风险」。

## 核心类/函数

| 符号 | 职责 | 位置 |
|---|---|---|
| `check_all_command_guards` / `_run_approval_gate` | 危险命令检测后的统一审批门（会话状态、 transports、决定回填） | `tools/approval.py` |
| `_YOLO_MODE_FROZEN` | import 时冻结的 YOLO 环境变量快照，防运行期注入提权 | `tools/approval.py:48` |
| `_record_denial` / `_denial_breaker_addendum` | 智能审批连续拒绝计数与熔断升级文本 | `tools/approval.py:82,99` |
| `apply_launch_yolo`（approval_yolo） | `--yolo` 会话策略的一次性播种，保证 `/yolo off` 之后能真正关掉 | `tools/approval_yolo.py` |
| `detect_dangerous_command` / `detect_hardline_command` | 危险/硬线命令检测（规范化、分词、模式表） | `tools/approval_detection.py` |
| `_smart_verdict`（approval_smart） | 辅助 LLM 风险评估，产出 allow/deny/unsure | `tools/approval_smart.py` |
| `_await_gateway_decision` | 网关审批的阻塞等待（消息平台上的「等你点头」） | `tools/approval_gateway_wait.py` |
| `scan_text`（threat_patterns） | 按累积作用域跑 `(regex, id, scope)` 模式表，返回命中列表 | `tools/threat_patterns.py` |
| `is_safe_url` / `async_is_safe_url` | URL/解析 IP 的 SSRF 判定（含元数据端点硬封禁） | `tools/url_safety.py` |
| `normalize_url_for_request` | IRI→URI 规范化：IDNA 主机 + 百分号编码路径 | `tools/url_safety.py:38` |
| `create_ssrf_safe_client` | 连接期复验 + 直连已验证 IP，关闭 DNS rebinding | `tools/url_safety.py` |
| `evaluate_command`（self_repo_guard） | 判定 shell 命令是否改写本进程的 git 检出 | `tools/self_repo_guard.py` |
| `validate_path`（path_security） | 路径校验助手：穿越组件、越界检测，供 skills/cron/凭证文件共用 | `tools/path_security.py` |

## 本组文件清单

审批与安全组共 21 个文件：

| 文件 | 一句话角色 |
|---|---|
| `tools/approval.py` | 门面：审批门禁流 + 每会话状态（批准集、yolo、网关队列、熔断器）。 |
| `tools/approval_context.py` | 审批上下文：谁在问、从哪个平台、当前生效哪套策略（contextvars 与配置读取）。 |
| `tools/approval_detection.py` | 危险命令检测：命令规范化、token 化与硬线/危险模式表。 |
| `tools/approval_floors.py` | 门前的地板：永远不进提示的决策（用户 deny 规则、永久白名单、sudo stdin 守卫）。 |
| `tools/approval_gateway_wait.py` | 网关审批的阻塞等待循环（发卡片→等决定→超时）。 |
| `tools/approval_human_wait.py` | 「等人类」的时间记账（按会话），喂给不活跃看门狗。 |
| `tools/approval_prompt.py` | 人机提示面：CLI 提示、插件 transport、MCP elicitation 的呈现与 transport 选择。 |
| `tools/approval_provenance.py` | 一条被标记的命令为什么没弹提示就跑了——白名单/预批准的溯源说明。 |
| `tools/approval_smart.py` | 智能审批：辅助 LLM 对命令做风险评估。 |
| `tools/approval_yolo.py` | `/yolo` 的唯一开关/恢复/延续契约，所有界面都调它。 |
| `tools/write_approval.py` | 记忆与技能写入的写审批门 + 待审存储。 |
| `tools/threat_patterns.py` | 全项目共用的注入/木马/外泄正则库（带作用域）。 |
| `tools/url_safety.py` | SSRF 防护：私网封禁、元数据端点硬封禁、DNS rebinding 与重定向缓解。 |
| `tools/website_policy.py` | 可访问 URL 的站点策略助手（允许/拒绝清单的统一读取）。 |
| `tools/path_security.py` | 工具实现共用的路径校验（skills、cron、credential_files 等）。 |
| `tools/self_repo_guard.py` | 侦测会改写本进程 git 检出的命令。 |
| `tools/osv_check.py` | 用 OSV 做依赖包恶意软件检查（MCP stdio 服务启动前的预检）。 |
| `tools/plugin_guard.py` | 插件守卫：把 skills_guard 引擎用于 `hermes plugins install/update`。 |
| `tools/plugin_guard_context.py` | 插件安装扫描结果的上下文降级判定。 |
| `tools/credential_files.py` | 远程终端后端（Docker/Modal/SSH）的文件透传登记表。 |
| `tools/slash_confirm.py` | 网关侧通用的 slash 命令确认原语。 |

## 与其他模块的关系

- `tools/terminal_tool.py`：执行前把命令交给审批门；`force=True`（用户已确认）只跳过危险命令检查，**永不跳过守卫链的其余部分**。
- `agent/`：`prompt_builder.py` 与 `tool_dispatch_helpers.py` 复用 threat_patterns 扫上下文与工具结果；`agent/secret_scope.py` 决定密钥读取的作用域。
- `gateway/`：消息平台上的审批走 `approval_gateway_wait` 的卡片往返；`/yolo`、`/approve` 等 slash 命令落在 `approval_yolo` 与 `slash_confirm`。
- `tools/mcp_tool_transport.py`：stdio 服务启动前跑 `osv_check` 预检（超时 fail-open，见 mcp.md）。

## 总结

这一组的共同哲学是**把安全决策从「模型自觉」搬到「结构性防线」**：YOLO 环境变量 import 时冻结，注入者改环境无效；威胁模式按内容来源分级，避免把正经文档误杀；SSRF 对元数据端点无条件封禁、对 TOCTOU 在连接期复验；self_repo_guard 逐层剥开 shell 伪装去找那个真正危险的 git 动词。审批状态则是一份带熔断器的会话账本——连拒三次就明确叫停，而不是任由模型换着花样试到天亮。
