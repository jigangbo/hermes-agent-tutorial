# platform_misc.md — agent/ 其余一切:凭据保险库、密钥来源链、i18n、LSP、桌宠、监控、验证与杂项

## 文件概览

这是 agent/ 的**兜底篇**:前面各篇讲完 turn 循环、压缩、模型、凭据池、记忆、媒体之后剩下的
所有文件,按主题分成八组收拢。每组 2-5 句 + 表格;vault 族与 LSP 集成做深度走读。各组共享的
底色还是那两条:**密钥/机密数据绝不流入模型可见面**(vault 是 model-blind 的、密钥来源只进
环境、脱敏 fail-closed),**注册表模式处处复用**(vault 后端、secret 来源、locale 包全走
`PluginContext.register_*`)。

```text
agent/ 的"平台层"全景:
  凭据三链                         集成与体验                    守护与杂项
  ┌──────────────────┐            ┌────────────────────┐        ┌──────────────────┐
  │ secret_sources/ 7 │ 启动时     │ lsp/ 14 文件        │        │ monitoring/ 9 文件│
  │ proxy_sources/ 2  │ 环境注入   │  写后诊断           │        │  fire-and-forget │
  │ secret_scope      ├───────────>│ pet/ 11 文件        │        │  OTLP 出口       │
  │ vault 族 12 文件   │ 沙箱出口   │  桌宠(CLI/TUI/桌面) │       │ verify 族 7 文件  │
  │  model-blind      │ 代理注入   │ i18n 3 文件         │        │ misc 19 文件      │
  │                   │            │ acp 族 3 文件       │        │                  │
  └──────────────────┘            └────────────────────┘        └──────────────────┘
```

| 组 | 文件数 | 一句话 |
|---|---|---|
| vault 族 | 12 | model-blind 浏览器填密保险库 + 登录后端注册表 |
| secret_sources/ + proxy_sources/ + secret_scope | 10 | 启动时把外部密钥管理器解析成环境变量;沙箱出口代理 |
| i18n 族 | 3 | 分层 locale 目录(插件包 > 用户覆盖 > 内置) |
| lsp/ | 14 | 真语言服务器的写后诊断(门控于 git workspace) |
| pet/ | 11 | Petdex 桌宠引擎(CLI/TUI/桌面共享核心,纯显示层) |
| monitoring/ | 9 | 网关健康与脱敏诊断的 fire-and-forget OTLP 出口 |
| verify 族 | 7 | 被动验证证据台账 + turn 结束验证闸 |
| 杂项 | 19 | 脱敏、轨迹、标题生成、webhook、ACP、看门狗补丁等 |

---

## 关键代码走读

### 1. vault 族(深讲):model-blind 的凭据保险库

浏览器自动填密需要"知道密码"——但模型**永远**不该看到密码。`vault_store.py` 的设计把这件事
做成结构性保证:元数据(类型/标签/来源)与加密载荷同住,model 只见不透明句柄;明文只在浏览器
填充路径上服务端解析,不进工具结果、日志或会话库:

```python
# agent/vault_store.py:1-18(docstring 节选)
"""Local encrypted vault for browser autofill secrets.

Profile-scoped, model-blind credential store. Metadata (kind, label, origin,
timestamps) lives alongside an encrypted secret payload; the payload is
encrypted at rest with a locally generated Fernet key. The model only ever
sees opaque handles + metadata — secret values are resolved server-side by
the browser fill path and never enter tool results, logs, or the session DB.
...
- Three item kinds: ``login`` (password-only secret), ``payment`` (card fields) and
  ``address``; ``PAYMENT_FIELDS`` / ``ADDRESS_FIELDS`` are the canonical payload names."""
```

存储是 profile 作用域的:`<HERMES_HOME>/vault/` 下 0600 的密钥文件 + 密文文件,跨进程用 fcntl/
msvcrt 文件锁;`vault.key_storage: keychain`(opt-in)把密钥搬进 OS 凭据库(`vault_keychain.py`,
经 `keyring` 包),home 只剩非密钥指针 `vault.keyref`——备份与同步目录从此只有密文。`VaultStore`
的方法面覆盖 add/list/remove、TOTP(`normalize_otp_secret` 接受 otpauth:// URI 并保留非默认的
位数/周期/算法)、以及密钥迁移(`migrate_key`,file↔keychain 双向)。每种载荷字段都钉死到
WHATWG autocomplete token(`PAYMENT_FIELDS`/`ADDRESS_FIELDS`),填表端不用猜用户的字段命名。

登录**后端**是注册表模式的又一次复用,但契约相反:后端只列**元数据**、按句柄解析**一个**密码。
外部管理器(1Password/Bitwarden)需要会话解锁,锁定时 `resolve_password` 抛 `UnlockRequired` 让
surface 去提示;句柄用 `prefix` 命名空间化,`backend_for_handle` 不需要查表:

```python
# agent/vault_backends/base.py:47-56
    @abstractmethod
    def list_items(self) -> list[VaultItemMeta]:
        """Metadata only. Locked external backends return [] (the agent sees a lock hint instead)."""

    @abstractmethod
    def get_meta(self, handle: str) -> Optional[VaultItemMeta]: ...

    @abstractmethod
    def resolve_password(self, handle: str) -> str:
        """Server-side only; raises ``UnlockRequired`` when locked."""

    def resolve_otp(self, handle: str) -> Optional[str]:
        """Current one-time code for a login that stores a TOTP seed, else None (the user is asked).
        Server-side only, like resolve_password."""
        return None
```

四个内建后端:`local`(Fernet vault,恒可用)、`onepassword`/`bitwarden`(CLI 子进程,会话令牌
`OP_SESSION_*`/`BW_SESSION` 只存进程内存的闭包里、空闲 TTL 到期即弃,永不写 env/磁盘——
`vault_backends/unlock.py`)、`browser`(真实浏览器 profile 的已存密码,**只读**:list 只读快照
`Login Data` 的明文列,resolution 让浏览器自己在原 origin 上解密、Hermes 经 CDP 读回——没有
解密代码,复用 `browser.use_real_profile` 的既有同意)。解锁提示由 surface 拥有
(`set_unlock_prompt_callback`);无头上下文(cron/webhook/单查询)不装回调、保险库保持锁定——
和审批无人应答时的姿态一致。

插件后端走 `vault_backend_registry.py` 注册(`ctx.register_login_backend`),拒绝规则是全仓库最
严的静态审查之一——因为注册时要读 `provider.name`,属性钩子会在守卫外跑插件代码:

```python
# agent/vault_backend_registry.py:45-60(节选)
def static_name(provider) -> str:
    """The backend's name, judged without running plugin code (``ValueError`` with a fixed message when refused).

    Registration reads ``provider.name``; a property, a ``__getattribute__`` hook or a ``__class__`` override
    would run the plugin's code there, outside any guard, and its exception text would reach the loader log."""
    cls = type(provider)
    if not issubclass(cls, LoginBackend):
        raise ValueError("login backend must subclass LoginBackend")
    if cls.__getattribute__ is not object.__getattribute__ or any("__class__" in vars(k) for k in cls.__mro__[:-1]):
        raise ValueError("login backend must not override attribute access")
    name, prefix = inspect.getattr_static(provider, "name", None), inspect.getattr_static(provider, "prefix", None)
    if type(name) is not str or type(prefix) is not str:
        raise ValueError("login backend name and prefix must be plain string attributes")
    error = _namespace_error(name) or ("" if prefix == f"{name}:" else "login backend prefix must be '<name>:'")
    if error:
        raise ValueError(error)
    return name
```

插件后端最终只能以 `vault_backends/plugin.py` 的 `PluginLoginBackend` 包装形态到达 vault 工具:
命名空间取注册键(永不读插件可变属性)、只发句柄不给页面/CDP/主密码、`needs_unlock` 恒 False、
**异常替换为固定文本**在 except 之外抛出(插件错误文本里的机密到不了任何工具结果/日志/异常链)、
返回值在守卫内校验并拷贝成 core 对象(读插件对象的属性字段也可能跑插件代码)。填密的目标控件由
`vault_login_classifier.py` 选——OpenInstinct 内核分类器的 Python 移植(~170 行):autocomplete
token 精确匹配 100 分、type=password 90、`new-password`/`one-time-code` 与"确认新密码"文案硬
排除。

### 2. 密钥来源链:secret_sources/ + proxy_sources/ + secret_scope

`secret_sources/` 解决"API key 不想躺在 .env 里":启动时(`.env` 加载后、其余 Hermes 读
`os.environ` 前)把外部密钥管理器解析成环境变量形状的值。契约刻意窄——**只读、启动期、同步、
每 fetch 一次**(注册表强制墙钟超时)、永不抛、永不交互提示(错误进 `FetchResult.error` 带
`ErrorKind`);`SECRET_SOURCE_API_VERSION` 门控插件兼容。三个内建后端:`bitwarden`(Bitwarden
**Secrets Manager** `bws`,PM 工具库自动装固定版本、SHA-256 校验;唯一 bootstrap 密钥是 .env
里的 access token)、`onepassword`(`op://vault/item/field` 引用逐个 `op read`,Hermes 永不代替
用户认证)、`command`(用户自己的 helper 走 `/bin/sh -c`,key 只经 `HERMES_SECRET_KEY` 传递、
3s 硬超时 + 1MiB 输出帽、失败只记结构化字段)。`registry.apply_all` 统一排序("mapped 胜 bulk"、
先声明先得)、`override_existing` 语义(可胜 .env/shell,永不胜另一来源、永不胜受保护变量)与
来源溯源。两半缓存(进程内 + 磁盘)共享在 `_cache.py`,磁盘半原子写 0600、纯 best-effort——
缓存问题不许阻塞启动。

`proxy_sources/iron_proxy.py` 是出口侧的镜像:沙箱(Docker/Modal/SSH)里只有**不透明代理令牌**,
iron-proxy——TLS 拦截式默认拒绝出口防火墙——在出去的路上把令牌换成真凭据,泄露的令牌在可信
代理边界之外无用;CA、`proxy.yaml`、mappings、pidfile 都在 `<hermes_home>/proxy/`,失败只警告、
绝不阻塞启动。`secret_scope.py` 是多路网关的另一半:每个 profile 的 `.env` **不能**并进
`os.environ`(A 的密钥会漏进 B 的 turn 和子进程),`set_secret_scope` 以 ContextVar 装载活跃
profile 的密钥(经 `copy_context()` 传进 worker 线程),多路激活而作用域未设时 `get_secret`
**直接抛**而非回落——与 `web_search_provider.get_provider_env` 的防线互为表里。

### 3. i18n 族:三层目录、每层可残缺

`i18n.py` 用扁平点号键解析五层目录(插件语言包 → 用户覆盖 `$HERMES_HOME/locales/<lang>.yaml` →
内置 `locales/<lang>.yaml` → 同链的 `en` → 裸键);`t()` 是热路径,每 `(home, lang)` 缓存一份
合并字典,包注册时失效。语言解析序:显式 `lang=` > `HERMES_LANGUAGE` > `display.language` >
`en`;任何有层供给的 id 都接受,所以纯包语言(`pl`)在插件加载瞬间即可用。`i18n_layers.py` 拥有
插件包与用户覆盖两层,且包是**多表面**的(`<lang>.yaml` 给 core、`<lang>.tui.yaml`/
`<lang>.desktop.yaml` 对 Python 不透明、经 `i18n.catalog` 供渲染器);`i18n_languages.py` 是
内置 locale 的表(endonym + RTL 方向),与桌面 TS 侧的 `LOCALE_ENDONYMS` 必须一致(有测试钉住)。

### 4. lsp/ 集成(深讲):写后诊断的完整管线

LSP 让 pyright/gopls 等真语言服务器成为写后校验器。门控是第一条原则——**LSP 只在 git
workspace 里跑**(`lsp/workspace.py`),Telegram 网关里 home 目录的聊天永不孵化守护进程;
`lsp/__init__.py` 的 `get_service()` 返回单例或 None。服务层(`lsp/manager.py`)桥接同步的
file_operations 层与异步客户端:一个后台线程里的 asyncio 循环,每 `(server_id, workspace_root)`
一个惰性客户端,pyright 这类 multi_root 服务器只有一个客户端、更多根经
`didChangeWorkspaceFolders` 挂上去:

```python
# agent/lsp/manager.py:1-12(docstring 节选)
"""Service-level orchestration for LSP clients.
:class:`LSPService` bridges the synchronous file_operations layer and the async
:class:`agent.lsp.client.LSPClient`: one asyncio loop in a background thread, one lazily
spawned client per ``(server_id, workspace_root)`` — servers flagged ``multi_root`` (pyright) get ONE
client per ``server_id`` and further roots (typically sibling git worktrees) are attached to the running
process via ``workspace/didChangeWorkspaceFolders`` — a **broken-set** of pairs that failed
to spawn/initialize (retried only after ``lsp.broken_retry_seconds``; never, by default), and a **delta baseline**
per file (``snapshot_baseline()`` runs BEFORE a write; the next ``get_diagnostics_sync()``
returns only diagnostics not in it).  Off unless config enables it."""
```

客户端(`lsp/client.py`)的新鲜度用**文档版本**而非时间戳:每次 didChange bump version,每条
存储的诊断带着描述它的版本——慢服务器的残留诊断永远不能冒充当前内容的判定("ghost
diagnostics");`ContentModified`(-32801)指数退避重试。编辑检查(`lsp/edit_check.py`)是一次
协同程上的快检查:同步编辑后快照、等判定;只有判定真有诊断,才对照**编辑前**快照(或复用早前为
同一文本留下的判定)取"本次编辑引入"的增量。两个快照都是**写入本身持有的字节**,不是事后重读
文件——排队时另一个会话可能又写了文件,那不是本次编辑的错误。同步诊断(`lsp/sync_diagnostics.py`)
先问 typescript-language-server 的 `tsserverRequest`(`syntacticDiagnosticsSync`/
`semanticDiagnosticsSync`,暖项目 ~10ms),无同步请求或失败再回落 push/pull 等待。

最精巧的一件是**延迟交付**(`lsp/deferred.py`):`write_file`/`patch` 在字节落盘并验证后立即
返回,语言服务器判定在 LSP 循环上排队,下一次工具结果(或没有工具再跑时的下一次 user turn)
带给该会话的 agent——作为一条**尚未 flush 的新行**,不移动任何缓存字节。同一文件的更新编辑接管
未交付判定(新检查 diff 旧基线,第一笔编辑引入的错误仍然上报,除非第二笔修好了它);turn 的
最后一次工具调用也没丢判定——`track_pending` 按会话追踪在跑的检查,turn 最终答案被接受前
`settle_for_agent` 有界等待并交出全部未交付判定,`agent.turn_stop_gates` 把它们作为新消息递给
模型。配套件:`range_shift.py` 用 difflib 建 pre→post 行移位图,免得"同一错误挪了行号"被当成
全新错误;`reporter.py` 把增量格式化成紧凑的 `<diagnostics>` 块(默认只 ERROR,每文件 20 条帽);
`eventlog.py` 的稳态静默模型(DEBUG 满地跑、INFO 每会话一次、WARNING 才是动作项)让 `agent.log`
仍可 grep;`install.py` 把缺失的服务器二进制装进 Hermes 自有的 `<HERMES_HOME>/lsp/bin/`(用户的
全局工具链不动,失败一律返回 None 让工具层退回内建语法检查);`servers.py` 是每语言 `ServerDef`
注册表,`cli.py` 提供 `hermes lsp status/list/install/restart/which`。

### 5. pet/:桌宠是纯显示层

Petdex 桌宠引擎的 docstring 开宗明义:**无模型工具、无提示词/工具集改动,零缓存影响**。CLI
(Python)与 TUI(Ink,经 tui_gateway)共享同一核心:constants(几何 + `PetState` 行分类,
8 列 × 9 行 Codex 图集或旧 8 行图集)、state(agent 活动 → 状态行的唯一裁决点,优先序与桌面 TS
镜像互钉)、store(`get_hermes_home()/pets/<slug>/` 的安装/枚举,profile 作用域)、render(解
spritesheet、kitty/iTerm2/sixel/half-block 编码,能力检测在 `terminal_image`;Pillow 惰性导入,
缺了降级为空串不抛)、manifest(petdex.dev 公开清单,只读无凭据)、`generate/`(5 文件:
atlas/imagegen/orchestrate/prompts,用图像生成后端造新宠)。

### 6. monitoring/:微秒级 emit、fail-isolated 出口

`monitoring/emitter.py` 是生产者与消费者之间唯一的缝,热路径不变量写得斩钉截铁:`emit()` 必须
微秒级返回、必须不阻塞磁盘/网络、**必须永不抛进调用方**——队列满丢最老的;daemon 线程批量分发
给 fail-isolated 订阅者,什么都不持久化(监控是出站路径,不是存储)。`events.py` 的类型化事件
**内容自由**:无提示词、消息、工具参数、会话历史或用量分析——那些属于 NeMo Relay(见
relay_moa.md)。出站前 `redaction.py` 一把无条件洗(`redact_for_egress` **fail-closed**,脱敏器坏
就不出原文),再 PII 化;`otlp_exporter.py` 映射到 OTel span(可选 extra,惰性导入,`headers_env`
出口时读、永不记录);`gateway_health(_export).py` 与 `cron_health.py` 是两个生产者;`policy.py`
管可重置的伪匿名安装 id。

### 7. verify 族:被动台账 + 有界停机闸

`verification_evidence.py` 记录 agent 在代码工作区里**实际证明了什么**——刻意被动:不跑测试
套件、不阻塞完成、不把定点检查升格为"repo 全绿"。`verification_stop.py` 是唯一动它的闸:
policy-only,当模型刚编辑完代码、没有新鲜证据就试图收工时,把台账转成一次**有界**的后续追问
(nudge 里点名改动路径,截断 8 条/1200 字符)。`verify_hooks.py` 把内建编码指导骑在验证 nudge 上
而非另立默认停机闸(默认 token 成本与"缺验证证据"的决定绑定,`pre_verify` 钩子留给用户/插件
策略);`verify/` 4 文件是 `hermes verify` 的运行器——从 grok-cli 移植的静态 run-recipe 检测
(`recipes.py`,与 `coding_context.detect_project_facts` 分层:字节稳定的提示期事实 vs 深度运行
时配方)、`<project>/.hermes/environment.json` 清单(用户可编辑、有效即胜过新鲜检测)、
bootstrap→build→test→后台 start→readiness→teardown 流程。

### 8. 杂项 19 文件:每个都小而硬

`redact.py`(1,950 行)是全部日志/工具输出脱敏的正则底座(短 token 全遮、长 token 留头 6 尾 4;
`redact_for_egress` 是出站强制版,monitoring/MoA 都压在它上);`redact_connstr.py` 补关键词/值
连接串(ADO.NET/libpq)的密码遮蔽——URL 形式归 redact.py,`.NET` 连接串曾原文漏过。
`trace_upload.py` 把会话转录以 Claude Code JSONL 形状传 HF(默认私有数据集 + 强制脱敏,永不抛);
`trajectory.py` 是轨迹保存 + scratchpad→think 转换的小叶子。`title_generator.py` 两段式会话
标题(模型调用前的确定性即时标题 → 一次小模型升级,溯源 `derived < llm < user`,升级线程用
WeakSet 登记供退出前 join);`notification_presentation.py` 把"仅诊断"唤醒的呈现按 turn 静音
(执行与控件不受影响);`reactions.py` 正则探测用户对 agent 的 affection(`<3`、good bot——
"this is great" 不算),单一事实源喂 CLI 宠物/TUI 红心/桌面红心。`outbound_webhooks.py` 是
`hooks.outbound` 的 fire-and-forget POST(有界队列 + 单 daemon 工人,HMAC-SHA256 签名,目标永远
影响不了 agent 流);`thread_scoped_output.py` 用每线程路由代理替换 `sys.stdout/stderr`
(`contextlib.redirect_stdout` 是进程全局的,后台工人静音自己会静音网关事件循环——装一次、
幂等、永不卸载)。

kanban 侧两个补丁:`kanban_stop.py` 是 worker 的 turn 结束闸(没调终端看板工具就叙述收工 →
有界合成 nudge 续跑,避免 dispatcher 记 protocol violation);`kanban_turn_recovery.py` 把死于
可重试失败的 worker turn 原地重试——同会话同历史、有界预算、显式退避,预算耗尽则**非零**退出
诚实记账。计划面:`plan_prompt.py` 的 `/plan` 是无引擎内建(build_plan_prompt 作为普通 turn 喂
给 agent,系统提示词不动);`plan_snapshot_sync.py` 用 Nous 回复自带的 usage-window 头比对缓存
的账户快照,不一致才后台刷新一次。ACP 三件套:`acp_client.py` 是 `external_process` 模型
provider 的通用 stdio 客户端(每请求短命 ACP 会话,一个 prompt 进、文本块出、OpenAI 形状回);
`acp_openai_bridge.py` 补 ACP 没有 tools 通道的缺口——Hermes 工具 schema **进 prompt 的文本**、
调用从响应文本**解析回来**,各客户端只差 allowlist;`copilot_acp_client.py` 是弃用别名模块(列出
的目录 ACP provider 钉在旧版,整面保留 + 每进程警告一次)。`custom_entry_pool.py` 处理
`providers:` 条目与内建池同 slug 的凭据归属(条目作用域视图,内建的账号永不顶替条目声明的凭据)。
`empty_response_guard.py` 是双保险守卫(均 fail-open):连续两次 usage 在场且 output_tokens==0
的空响应 → 跳过余下重试直达 fallback 链;单次空尝试的预估输入成本超 $0.25 → 重试预算 3→1。
`battery.py` 给 CLI/TUI 状态条读电池(psutil + 几秒 memoize,一律可降级)。

---

## 核心类/函数

| 名称 | 位置 | 职责 |
|---|---|---|
| `VaultStore` / `VaultItemMeta` | agent/vault_store.py:208/169 | Fernet 保险库(CRUD/TOTP/迁移);模型可见元数据 |
| `LoginBackend`(ABC) / `PluginLoginBackend` | agent/vault_backends/base.py:29, plugin.py | 后端契约 + UnlockRequired;插件包装(异常固定文本) |
| `static_name` / `set_unlock_prompt_callback` | agent/vault_backend_registry.py:45, unlock.py | 静态名称审查;主密码提示归 surface |
| `SecretSource`(ABC) / `apply_all` | agent/secret_sources/base.py, registry.py | 只读启动期 fetch 契约;超时/优先序/溯源编排 |
| `get_secret` / `set_secret_scope` | agent/secret_scope.py | 作用域化密钥读取(multiplex 未绑 scope 即抛) |
| `t` / `reset_language_cache` | agent/i18n.py | 五层目录解析的热路径读取与失效 |
| `LSPService` / `LSPClient` | agent/lsp/manager.py, client.py | 同步↔异步桥;版本化新鲜度诊断客户端 |
| `run_edit_check` / `queue_deferred` / `settle_for_agent` | agent/lsp/edit_check.py, deferred.py | 增量判定;延迟交付;turn 收尾有界等待 |
| `build_line_shift` / `reporter` | agent/lsp/range_shift.py, reporter.py | 行移位图(增量去噪);`<diagnostics>` 格式化 |
| `emit` / `redact_for_export` | agent/monitoring/emitter.py, redaction.py | 微秒级 fire-and-forget 总线;出站无条件洗 |
| `derive_pet_state` | agent/pet/state.py | agent 活动 → 状态行的唯一裁决 |
| `record_*` 台账族 / `last_unattributed_run` | agent/verification_evidence.py, verification_stop.py | 被动验证证据;有界停机闸 |
| `run_verify` / `detect_recipe` | agent/verify/runner.py, recipes.py | bootstrap→test→readiness 流程;静态配方 |
| `redact_sensitive_text` / `redact_for_egress` | agent/redact.py | 全局脱敏底座 / 出站强制版 |
| `mask_connection_strings` / `build_trace_jsonl` | agent/redact_connstr.py, trace_upload.py | 连接串遮蔽;HF trace 上传 |
| 标题生成 / 反应探测 | agent/title_generator.py, reactions.py | 两段式标题(溯源阶梯);vibe 检测 |
| `dispatch_outbound_hook` / `thread_scoped_silence` | agent/outbound_webhooks.py, thread_scoped_output.py | 签名 webhook;每线程 stdio 静音 |
| kanban 闸 / 原地重试 | agent/kanban_stop.py, kanban_turn_recovery.py | 终端看板工具 nudge;死亡 turn 原地恢复 |
| `build_plan_prompt` / `maybe_sync_plan_snapshot` | agent/plan_prompt.py, plan_snapshot_sync.py | /plan 提示词;账户快照后台同步 |
| `ACPClient` / `render_tool_bridge_sections` | agent/acp_client.py, acp_openai_bridge.py | ACP stdio 客户端;工具 schema 进 prompt 的桥 |
| `pool_for_custom_entry` / 空响应守卫 / `read_battery` | agent/custom_entry_pool.py, empty_response_guard.py, battery.py | 凭据池视图;确定性空检测;电池读出 |

## 本组文件清单

| 文件 | 组 | 一句话 |
|---|---|---|
| `agent/vault_store.py` | vault | Fernet 加密保险库(model-blind) |
| `agent/vault_keychain.py` | vault | OS 凭据库存钥匙(keychain opt-in) |
| `agent/vault_login_classifier.py` | vault | 填密目标控件分类器(OpenInstinct 移植) |
| `agent/vault_backend_registry.py` | vault | 插件登录后端注册表 + 静态审查 |
| `agent/vault_backends/__init__.py` | vault | 后端包出口 |
| `agent/vault_backends/base.py` | vault | `LoginBackend` 契约 + UnlockRequired |
| `agent/vault_backends/local.py` | vault | 内建 Fernet 后端(恒可用) |
| `agent/vault_backends/onepassword.py` | vault | 1Password 登录项后端(`op` CLI) |
| `agent/vault_backends/bitwarden.py` | vault | Bitwarden 密码库后端(`bw` CLI) |
| `agent/vault_backends/browser.py` | vault | 真实浏览器已存密码(只读,CDP 读回) |
| `agent/vault_backends/plugin.py` | vault | 插件后端的 core 包装(异常固定文本) |
| `agent/vault_backends/unlock.py` | vault | 进程内解锁令牌(闭包持有,TTL) |
| `agent/secret_scope.py` | 密钥链 | 作用域化密钥读取(fail-closed) |
| `agent/secret_sources/__init__.py` | 密钥链 | 来源包出口 |
| `agent/secret_sources/base.py` | 密钥链 | `SecretSource` ABC + FetchResult/ErrorKind |
| `agent/secret_sources/registry.py` | 密钥链 | 注册 + apply_all 编排器 |
| `agent/secret_sources/_cache.py` | 密钥链 | 两半缓存(进程内 + 0600 磁盘) |
| `agent/secret_sources/bitwarden.py` | 密钥链 | BSM `bws` 启动注入 |
| `agent/secret_sources/onepassword.py` | 密钥链 | `op read` 引用解析 |
| `agent/secret_sources/command.py` | 密钥链 | 用户 helper 命令源(硬超时) |
| `agent/proxy_sources/__init__.py` | 密钥链 | 代理来源包出口 |
| `agent/proxy_sources/iron_proxy.py` | 密钥链 | 沙箱出口的凭据注入代理 |
| `agent/i18n.py` | i18n | `t()` 五层目录解析 |
| `agent/i18n_layers.py` | i18n | 插件包 + 用户覆盖层 |
| `agent/i18n_languages.py` | i18n | 内置 locale 表(endonym/RTL) |
| `agent/lsp/__init__.py` | lsp | 服务单例 + git workspace 门控 |
| `agent/lsp/manager.py` | lsp | `LSPService` 同步↔异步桥 |
| `agent/lsp/client.py` | lsp | 异步 LSP 客户端(版本化新鲜度) |
| `agent/lsp/protocol.py` | lsp | JSON-RPC 2.0 帧器 |
| `agent/lsp/servers.py` | lsp | 每语言 `ServerDef` 注册表 |
| `agent/lsp/install.py` | lsp | 二进制自动安装(Hermes 自有目录) |
| `agent/lsp/cli.py` | lsp | `hermes lsp` 子命令 |
| `agent/lsp/workspace.py` | lsp | workspace 门控/信任/项目根解析 |
| `agent/lsp/edit_check.py` | lsp | 不持写检查(增量判定) |
| `agent/lsp/deferred.py` | lsp | 判定延迟交付 + settle |
| `agent/lsp/range_shift.py` | lsp | 行移位图(增量去噪) |
| `agent/lsp/reporter.py` | lsp | `<diagnostics>` 块格式化 |
| `agent/lsp/sync_diagnostics.py` | lsp | tsserver 同步诊断直询 |
| `agent/lsp/eventlog.py` | lsp | 稳态静默的结构化日志 |
| `agent/pet/__init__.py` | pet | 桌宠引擎包出口 |
| `agent/pet/constants.py` | pet | 图集几何 + PetState 分类 |
| `agent/pet/state.py` | pet | 活动 → 状态裁决 |
| `agent/pet/store.py` | pet | on-disk 宠物安装/枚举 |
| `agent/pet/render.py` | pet | spritesheet 解码 + 终端编码 |
| `agent/pet/manifest.py` | pet | petdex 公开清单 |
| `agent/pet/generate/__init__.py` | pet | 生成流水线出口 |
| `agent/pet/generate/atlas.py` | pet | 图集组装 |
| `agent/pet/generate/imagegen.py` | pet | 图像生成调用 |
| `agent/pet/generate/orchestrate.py` | pet | 生成编排 |
| `agent/pet/generate/prompts.py` | pet | 生成提示词 |
| `agent/monitoring/__init__.py` | monitoring | 包出口(`emit`/`get_emitter`) |
| `agent/monitoring/emitter.py` | monitoring | fire-and-forget 事件总线 |
| `agent/monitoring/events.py` | monitoring | 类型化内容自由事件 |
| `agent/monitoring/policy.py` | monitoring | 伪匿名安装 id |
| `agent/monitoring/redaction.py` | monitoring | 出站前无条件洗 |
| `agent/monitoring/otlp_exporter.py` | monitoring | OTLP/HTTP 出口(可选 extra) |
| `agent/monitoring/gateway_health.py` | monitoring | 网关健康信号生产者 |
| `agent/monitoring/gateway_health_export.py` | monitoring | 健康导出运行时(fail-open) |
| `agent/monitoring/cron_health.py` | monitoring | cron 服务健康投影 |
| `agent/verification_evidence.py` | verify | 被动验证证据台账(SQLite) |
| `agent/verification_stop.py` | verify | turn 结束验证闸(policy-only) |
| `agent/verify_hooks.py` | verify | pre_verify 环的 nudge 助手 |
| `agent/verify/__init__.py` | verify | verify 包出口 |
| `agent/verify/environment.py` | verify | 环境清单(.hermes/environment.json) |
| `agent/verify/recipes.py` | verify | 静态 run-recipe 检测 |
| `agent/verify/runner.py` | verify | bootstrap→test→readiness 运行器 |
| `agent/battery.py` | 杂项 | 状态条电池读出 |
| `agent/redact.py` | 杂项 | 全局脱敏底座(1,950 行) |
| `agent/redact_connstr.py` | 杂项 | 连接串密码遮蔽 |
| `agent/trace_upload.py` | 杂项 | HF agent trace 上传 |
| `agent/trajectory.py` | 杂项 | 轨迹保存 + scratchpad 转换 |
| `agent/outbound_webhooks.py` | 杂项 | 签名的 notify-only webhook |
| `agent/reactions.py` | 杂项 | vibe 反应探测 |
| `agent/title_generator.py` | 杂项 | 两段式会话标题 |
| `agent/notification_presentation.py` | 杂项 | 诊断唤醒的 turn 级静音 |
| `agent/kanban_stop.py` | 杂项 | worker 终端看板工具闸 |
| `agent/kanban_turn_recovery.py` | 杂项 | worker turn 原地重试 |
| `agent/thread_scoped_output.py` | 杂项 | 每线程 stdout/stderr 静音 |
| `agent/plan_prompt.py` | 杂项 | /plan 提示词(无引擎) |
| `agent/plan_snapshot_sync.py` | 杂项 | 账户快照后台同步 |
| `agent/acp_client.py` | 杂项 | 通用 ACP stdio 客户端 |
| `agent/acp_openai_bridge.py` | 杂项 | 工具 schema 进 prompt 的桥 |
| `agent/copilot_acp_client.py` | 杂项 | 弃用别名模块 |
| `agent/custom_entry_pool.py` | 杂项 | 自定义条目的凭据池视图 |
| `agent/empty_response_guard.py` | 杂项 | 空响应守卫(双保险) |

## 与其他模块的关系

- **tools/**:`browser_vault`/`browser_exec` 是 vault 填密的消费者(浏览器路径上服务端解析密码);
  `write_file`/`patch` 经 `FileOperations._check_lint_delta` 消费 LSP 诊断;`hermes tools` 面板画
  全部 provider 的 `is_available` 与 vault 后端;`tools.code_execution_env` 的秘密名策略被
  `session_client_env._travels` 复用。
- **plugins/**:vault 后端、secret 来源、locale 包、媒体 provider 都经 `PluginContext.register_*`
  注册;`plugins.isolation: host` 是插件隔离的最终边界(vault 的进程内存防线挡意外不挡同进程
  代码)。
- **hermes_state/**:验证证据台账落 SQLite;会话行与活动投影被 `notification_presentation`、
  `plan_snapshot_sync` 等杂项读写。
- **gateway/**:monitoring 的全部生产者都来自网关运行状态;bot 链(见 relay_moa.md)与
  `gateway.bot_loop_guard` 共享设置;`kanban_turn_recovery` 服务 cron/kanban 调度器的 worker
  生命周期。
- **hermes_cli/**:`hermes vault`(add/list/key migrate)、`hermes lsp`、`hermes verify` 都是本组
  文件的 CLI 面;`apply_all` 由 `hermes_cli.env_loader` 在启动时调用;`copilot_acp_client` 的弃用
  面由插件 compat 契约钉住。
- **agent/其余**:`secret_scope` 支撑 `web_search_provider.get_provider_env` 与 MoA 隐私过滤;
  `redact` 是 monitoring/redaction、MoA、trace_upload 的公共底座;`verification_stop` 的 nudge
  由 `turn_stop_gates` 递给模型;`empty_response_guard` 挂在 turn 重试路径上。
- **apps/desktop**:vault 的 Add 对话框写 `PAYMENT_FIELDS`/`ADDRESS_FIELDS` 规范字段名;pet 的 TS
  镜像(`state` 优先序)与 i18n 的 endonym 表互有测试钉住。

## 总结

兜底篇最大的收获是看清"模式复用"的复利:同一个 `ProviderRegistry` 引擎驱动了媒体 provider、
vault 登录后端、secret 来源、locale 包——注册、命名空间保留、快照/回滚只有一份实现。而 vault
族与 LSP 是两个镜像的教学案例:**vault 把"模型不可见"做成结构**(句柄 + 元数据出去、明文只在
服务端解析路径上存在、插件被剥到只剩句柄、异常固定文本),**LSP 把"不拖慢写路径"做成结构**
(写即返回、判定排队、下一行交付、turn 收尾有界等待)。杂项堆里反复出现同一条纪律:凡是有
副作用的旁路(webhook、轨迹上传、标题升级、快照同步)一律 fire-and-forget + 有界 + 永不抛进主
循环;凡是防御(脱敏、作用域、守卫)一律 fail-closed。这正是 AGENTS.md 里 "no defensive
clutter" 的反面教材检查法——这里的每一层防御背后都站着一个真实事故或一个明确的威胁模型。
