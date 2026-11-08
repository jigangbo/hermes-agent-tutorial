# 安全边界模型

> Hermes 是一个能跑终端、开浏览器、发消息、花钱调模型的代理 —— 攻击面天然巨大。本文讲它的分层防御：从最内圈的进程自保，到最外圈的插件准入。

## 防御层次图

```
外圈 ── 插件目录准入 ── plugin-catalog/：人工合并 PR + 40 位 SHA 锁定 + 能力声明
        │                skills/plugins 安全扫描（dangerous 拒绝，caution 警告）
        │                removed.yaml 黑名单（canonicalized repo URL 匹配即拒绝）
        │
   ── 密钥治理 ── agent/secret_scope.get_secret（永不读 os.environ）
        │          credentials 走 Hermes（hermes auth add <plugin>:<id>）
        │          proxy_bypass.py / ssl_verify.py 传输层
        │
   ── 网络守卫 ── tools/url_safety.py：SSRF 防护（拦截私网/内网地址）
        │          tools/website_policy.py：哪些站点允许抓取
        │          webhook 环境只给 4 个安全工具（_HERMES_WEBHOOK_SAFE_TOOLS）
        │
   ── 文件/命令守卫 ── tools/threat_patterns.py：危险命令模式
        │                tools/path_security.py：路径校验（skills/cron/凭据文件）
        │                tools/self_repo_guard.py：禁止改写运行中 checkout 的 git 操作
        │                tools/file_tools_write_guards.py：写守卫（拒绝规则、二进制检测）
        │                tools/credential_files.py：暴露前检测凭据文件
        │                tools/osv_check.py：安装前 OSV 漏洞检查
        │
   ── 审批管线 ── tools/approval*.py（21 个文件）：谁能批准什么、从哪个表面批准
        │          approval_floors.py：每类动作的最低审批级别
        │          approval_yolo.py：/yolo 开关（会话级放开，可恢复）
        │          编辑模式映射（acp_adapter/modes.py）：default/accept_edits/dont_ask
        │
内圈 ── 进程自保 ── agent/runtime_self_protection.py、estop.py
                   剥离敏感输出（agent/redact.py、redact_connstr.py）
                   秘密作用域（agent/secret_scope.py）
```

## 三条值得记住的信任判断

### 1. SHA 锁定就是信任模型

plugin-catalog 的准入规则（`plugin-catalog/README.md`，与网站文档逐字镜像、CI 校验）：人工合并的 PR 准入（没有自助注册表）、**必须 40 位完整 SHA 锁定**（分支/标签/短 SHA 拒收）、**禁止自更新代码**（SHA 是信任锚，SHA 升级 = 新的再审 PR）、声明的能力必须在 SHA 处属实、无运行时覆盖 Hermes 核心。安装时如果命中 `removed.yaml`，直接拒绝。

### 2. 秘钥永远不过环境变量

多 profile 复用让 `os.environ` 成为泄漏源（它持有**启动 profile** 的值）。所有插件/提供方读密钥必须走 `agent.secret_scope.get_secret`（按 `hermes_home_key()` 作用域，fail-closed）。平台适配器禁止改 `os.environ` —— YAML 配置经 `_shared.apply_yaml_bridge` 进 `PlatformConfig.extra`。

### 3. 不可信环境降级运行

- webhook 进来的请求只配 4 个只读工具；
- `agent/memory_context.py` 的围栏（fence）把召回的记忆内容标记隔离，`StreamingContextScrubber` 再从输出里剥掉围栏，防提示注入回流；
- 网关对最终响应做过滤与净化（`response_filters.py`、`_sanitize_gateway_response`）。

## 输入表面：内容从哪里进来（SECURITY.md §2.1）

信任模型的第一个定义就是"输入表面"—— 任何让内容进入 agent 上下文的通道。每个表面都有自己的守卫组合，读安全相关代码时先问"这个内容从哪个表面进来"：

| 输入表面 | 前置守卫 |
|----------|---------|
| 操作者输入（REPL/TUI/桌面） | 信任最高，但仍过审批管线 |
| 网页抓取 | `tools/url_safety.py` SSRF 防线 + `tools/website_policy.py` 站点策略 |
| 电子邮件 / 网关消息 | message guards（[05_gateway/message_flow](../05_gateway/message_flow.md)） |
| 文件读取 | `tools/file_tools_write_guards.py`、路径校验 |
| MCP 服务器响应 | 工具集隔离（`mcp-*` 豁免语义），响应按工具结果对待 |
| 工具结果 | 输出净化 + 截断（2048 字符错误上限） |

## 信任模型的五个子层（SECURITY.md §2）

安全判断先分清每一层的"承重程度" —— 各层**并不等重**，报告者与操作者应按同一套术语推理：

| 子层 | 内容 | 承重 |
|------|------|------|
| §2.2 OS 级隔离 | 对抗对抗性 LLM 的**唯一**安全边界是操作系统；审批门、脱敏、模式扫描、工具白名单都不是 containment | 真边界 |
| §2.3 凭据作用域 | 凭据分层持有；插件/适配器不直读 `os.environ`（见上文"秘钥永远不过环境变量"） | 进程内纪律 |
| §2.4 进程内启发式 | 一切筛选 LLM 输出的组件都是"在攻击者影响的字符串上工作的启发式"，按此对待 | 尽力而为 |
| §2.5 插件信任 | 目录准入 + SHA 锁定 + removed.yaml 黑名单（见上文"SHA 锁定就是信任模型"） | SHA 锚定 |
| §2.6 外部表面 | 每个外部表面（dashboard、webhook、relay…）有文档化的 stance，例如"仪表盘把 agent 输出渲染为惰性 HTML" | 按表面声明 |

读懂这张表，就能解释为什么"加一个模式扫描"永远不算修复 §3.1 漏洞 —— 承重层在 OS，不在进程内的启发式。

## 审批不是弹窗，是一条管线

```
工具调用 → approval_detection.py 判定是否需要审批
        → approval_floors.py 查最低级别（按动作类别）
        → approval_context.py 组装"谁在问、从哪问、什么策略"
        → approval_smart.py 启发式（同源已批准过？）
        → 需要? → approval_prompt.py 渲染 → 按表面等待：
            CLI:    cli_modal_mixin.py 弹模态
            网关:   approval_gateway_wait.py（消息平台上等你回复）
            TUI:    server_requests.py 反向 JSON-RPC 请求（srq-<n>）
        → approval_provenance.py 记录"为什么没弹窗就跑了"
```

`approval_yolo.py` 提供 `/yolo` 的会话级合同（toggle/restore/carry）；任何自动放行都要经 provenance 记录，可审计。

放行条件的优先级（`tools/approval_floors.py` + `tools/approval.py`）值得记住：**pre-gate 永远在最前** —— `approvals.deny` globs 与永久命令 allowlist 在 yolo / `approvals.mode: off` / cron approve-mode **之前**运行。也就是说开了 `/yolo` 也拦得住 `deny` 名单里的命令：hardline 拒绝不参加任何"模式开关"。

## 仓库自身的安全流程

`SECURITY.md` 是范围权威：§3.1 类发现必须走私下渠道（GitHub Security Advisory / security@nousresearch.com），绝不进公开 issue/PR/commit；§3.2 硬化是普通公开工作。根 AGENTS.md 的贡献准则补了一句重要的工程判断：**"摧毁其所保护的特性的修复"即使做得漂亮也会被拒收**。

## 学习建议

读懂安全模型最有效的路径是顺着一次"危险命令"的旅程走：`terminal` 工具收到 `rm -rf /` → `threat_patterns.py` 命中 → `approval_floors.py` 给出最低级别 → 审批管线拦截 → 你在 Telegram 上收到确认卡片 → 批准/拒绝。然后把每一站映射到 [04_tools/approval_safety](../04_tools/approval_safety.md) 的逐文件走读。
