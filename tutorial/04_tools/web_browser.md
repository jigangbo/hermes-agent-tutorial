# 浏览器与网页工具组 —— browser_exec 与 web_search

## 文件概览

浏览器组 25 个文件 + 网页组 8 个文件，共 33 个。浏览器侧只有**一个**核心工具 `browser_exec`（`browser_use_cli.py`，通过 browser-harness 走 CDP 驱动真实浏览器），外加两个 CDP 伴生工具 `browser_cdp`（裸协议透传）和 `browser_dialog`（应答原生 JS 对话框）。它背后是一套分工明确的系统：`browser_session.py` 决定这次调用连哪个 CDP 端点（操作者覆盖 > 云端 > 本地），`browser_launcher.py` 负责 Chromium 进程的生老病死，`browser_supervisor.py` 持续监听对话框和 frame 事件。网页侧 `web_tools.py` 提供 `web_search`/`web_extract`，但真正的厂商实现全部住在 `plugins/web/<vendor>/` 里——本模块只管选型、安全门、缓存与截断。需要澄清一个「考古现场」：`browser_tool.py` 和 `browser_tool_install.py` 是**冻结的旧 updater 兼容存根**，真正的浏览器工具早已迁移。

## 关键代码走读

### 1. browser_tool.py：一块化石的自白

先看这个最短的文件，它讲了一段架构史：

```python
# 来源：tools/browser_tool.py:1-5
"""Frozen old-updater compatibility stub (tests/compat/old_updater_surface.json, ``bare`` list).

The built-in browser_* tools and agent-browser are gone; ``browser_exec`` (``tools/browser_use_cli.py``)
is the browser. A pre-PM ``hermes update`` still running mid-swap imports this module and the name below
from the NEW tree, so both must keep existing. Nothing else belongs here.
"""


def warm_agent_browser_npx_cache(timeout: float = 60.0) -> bool:
    """Frozen old-updater surface: nothing is warmed (there is no agent-browser to warm); always False."""
    return False
```

场景是：旧的 `hermes update` 在换代码中途还会 import 新树里的这个模块和函数名，所以它们必须存在——但仅此而已，**任何人都不应该再往这里加东西**。AGENTS.md 也专门强调 browser_tool/browser_tool_install 是 frozen stubs, never grow them。

### 2. browser_session.py：CDP 端点从哪来

`browser_exec` 每次调用都要一个 CDP 端点。`get_session_info(cache_key)` 按固定优先级解析（AGENTS.md 记载的阶梯：操作者 `BU_CDP_*` 环境变量 > CDP 覆盖（live `/browser connect` > `BROWSER_CDP_URL` > `browser.cdp_url`）> 混合 `::local` sidecar > 云厂商（失败则本地会话标记 `fallback_from_cloud`）> 本地）。创建新会话的分支代码把前三级写得很清楚：

```python
# 来源：tools/browser_session.py:279-291
def _create_session_for_key(cache_key: str, force_local: bool) -> dict[str, Any]:
    """Fresh session (runs OUTSIDE the lock: cloud mode makes a network call, a launch takes seconds)."""
    from tools.browser_session_cdp import get_cdp_override
    from tools.browser_session_cloud import get_cloud_provider
    override = get_cdp_override()
    if override and not force_local:
        logger.info("Created CDP browser session for %s", cache_key)
        return _session_record("cdp", override, {"cdp_override": True})
    if force_local:
        return _create_local_session(cache_key, allow_real_profile=False)
    provider = get_cloud_provider()
    if provider is None:
        return _create_local_session(cache_key)
    return _create_cloud_session_or_fallback(cache_key, provider)
```

本地分支不是进一步的 fallback 链：默认用 `browser_launcher` 启动的打包 Chromium；只有配置 `browser.engine: lightpanda` 才用 Lightpanda（绝不自动尝试）；`browser.use_real_profile` 开启且用户同意时才把用户真实浏览器 profile 快照成 Hermes 自己的副本使用（`browser_session_real_profile.py`）。**一个 cache key 一个浏览器**（`--remote-debugging-port=0` + DevToolsActivePort 文件）。会话过期或后端死亡时的替换逻辑在 `_reuse_or_evict`（`browser_session.py:317-329`）：先查过期、再查死活（Chromium 崩了、Lightpanda serve 退了都算），坏会话走单会话清理再重建。

### 3. browser_launcher.py 与崩溃收割

每个被启动的 Chromium 都被「父优先」地停止，并登记在一个 0700 私有目录里（一次性 profile 的在 `<HERMES_HOME>/cache/browser/chromium-records`，持久 profile 的在主机锁目录、每个 OS 用户一份）。后来者进程可以据此收割崩溃主人的浏览器——但必须先核对 pid + 启动时间 + argv 里的 `--user-data-dir` 令牌，防止 PID 复用误伤无辜进程。`browser_launcher_holders.py` 处理多进程共享同一持久 profile 浏览器的持有人记账。

### 4. browser_supervisor.py：常驻的 CDP 听诊器

对话框（alert/confirm）会阻塞页面，模型自己没法发现——需要一个旁路监听者。`CDPSupervisor` 每个带 CDP 端点的 task_id 一个：一条常驻 WebSocket，在所有 attach 的会话（顶层页 + 自动 attach 的 OOPIF/worker 目标）上订阅 `Page`/`Runtime`/`Target` 事件，把待决对话框和 frame 树放在线程安全快照里。它**不在工具 schema 里**——它的产出通过 `browser_dialog` 工具抵达模型：

```python
# 来源：tools/browser_supervisor.py:1-9
"""Persistent CDP supervisor for browser dialog + frame detection.

One ``CDPSupervisor`` per Hermes ``task_id`` with a reachable CDP endpoint: one
persistent WebSocket, ``Page`` / ``Runtime`` / ``Target`` events on every attached
session (top page + auto-attached OOPIF / worker targets), pending dialogs + frame
tree exposed via a thread-safe snapshot. Not in the tool schema — output reaches the
agent via ``browser_dialog``. Dialog capture and frame tracking
are mixins (``browser_supervisor_dialogs`` / ``browser_supervisor_frames``).
Design spec: ``website/docs/developer-guide/browser-supervisor.md``.
"""
```

对话框和 frame 两个半场拆成 mixin（`browser_supervisor_dialogs.py` / `browser_supervisor_frames.py`）；`browser_supervisor_capture.py` 把捕获到的 CDP 连接句柄交给受信的进程内插件。

### 5. web_tools.py：厂商无关的搜索/抽取门面

`web_search`/`web_extract` 的厂商实现（Firecrawl、Parallel、Exa、SearXNG……）全部住在 `plugins/web/<vendor>/provider.py`，通过 `agent.web_search_registry` 注册。本模块持有选型级联（`web.search_backend`/`web.extract_backend` 按能力配置）、安全门（每个 URL 过 `url_safety`）、缓存（`web_result_cache.py`，默认 20 分钟 TTL）和无钥匙救援环：

```python
# 来源：tools/web_tools.py:1-10
#!/usr/bin/env python3
"""Generic web_search / web_extract tools over pluggable backends.

Backend is selected during ``hermes tools`` (``web.backend`` in config.yaml; per
capability via ``web.search_backend`` / ``web.extract_backend``). Every vendor
implementation lives in ``plugins/web/<vendor>/provider.py`` and registers with
``agent.web_search_registry``; this module owns selection, safety gates,
caching, keyless rescue, and the truncate-and-store result pipeline.
Debug: ``WEB_TOOLS_DEBUG=true`` writes ``logs/web_tools_debug_<UUID>.json``.
"""
```

对厂商 provider 的调用永远包在防御性探针里——provider 坏了不能把整个搜索工具打崩：

```python
# 来源：tools/web_tools.py:89-97
def _probe(provider, method: str, context: str = "") -> Optional[bool]:
    """``bool(provider.<method>())``, or ``None`` if it raised (a broken provider is unavailable; *context* is
    appended to the debug log line, e.g. " during readiness check")."""
    try:
        return bool(getattr(provider, method)())
    except Exception as exc:
        name = getattr(provider, "name", provider)
        logger.debug("web provider %r.%s() raised%s: %s", name, method, context, exc)
        return None
```

返回 `None`（而不是抛出）意味着「不可用」，选型级联会落到下一个 provider。`web_tools_rescue.py` 提供「一键无钥匙救援」：已配置的、需要 key 的调用失败时，尝试公共无钥匙 provider 兜底；`web_tools_truncate.py` 是无 LLM 的截断-落盘管线，超长抽取结果存文件给路径。

### 6. browser_use_cli.py：唯一的真·浏览器工具

`browser_exec` 的注册在 `browser_use_cli.py:1035`（`name="browser_exec"`）。它是 Hermes 唯一的核心浏览器工具，通过 browser-harness（browser-use.com 的 CLI 引擎）说话；截图与标签页助手（`browser_use_shot.py`）覆盖 harness 自带的实现。配套的 `browser_vault_tool.py` 提供「模型盲」的自动填表：密码从 vault 取出注入页面，模型只见结果不见密码；`browser_url_policy.py` 在 URL 字面量进 shell/脚本前预扫描，兼含 SSRF 助手。

## 核心类/函数

| 符号 | 职责 | 位置 |
|---|---|---|
| `browser_exec`（注册名） | 唯一核心浏览器工具：navigate/click/type/extract/截图 | `tools/browser_use_cli.py:1035` |
| `get_session_info`（browser_session） | 按 cache key 解析 CDP 端点的固定优先级 | `tools/browser_session.py` |
| `_create_session_for_key` | 新会话创建：CDP 覆盖 > 云 > 本地 | `tools/browser_session.py:279` |
| `_backend_dead` | 判断本地会话进程是否已死（崩溃/退出） | `tools/browser_session.py:295` |
| `launch_chromium`（browser_launcher） | 启动并跟踪打包 Chromium，登记 0700 记录供收割 | `tools/browser_launcher.py` |
| `CDPSupervisor` | 常驻 CDP 监听：对话框捕获 + frame 跟踪 | `tools/browser_supervisor.py` |
| `DialogSupervisionMixin` | 对话框捕获/应答半场（`browser_dialog` 工具的数据源） | `tools/browser_supervisor_dialogs.py` |
| `FrameTrackingMixin` | frame / OOPIF 目标跟踪半场 | `tools/browser_supervisor_frames.py` |
| `browser_cdp`（注册名） | 裸 CDP 协议透传工具 | `tools/browser_cdp_tool.py` |
| `warm_agent_browser_npx_cache` | 冻结的旧 updater 存根：永远 False | `tools/browser_tool.py:8` |
| `web_search` / `web_extract`（注册名） | 厂商无关的搜索/抽取工具 | `tools/web_tools.py` |
| `_probe` | 厂商 provider 方法的防御性调用（异常=不可用） | `tools/web_tools.py:89` |
| `_rescue_search`（web_tools_rescue） | 有钥匙调用失败时的无钥匙救援兜底 | `tools/web_tools_rescue.py` |
| `x_search`（注册名） | xAI 内置 x_search 的 X(Twitter) 搜索工具 | `tools/x_search_tool.py` |

## 本组文件清单

浏览器组（25 个文件）：

| 文件 | 一句话角色 |
|---|---|
| `tools/browser_tool.py` | 冻结的旧 updater 兼容存根，勿改勿长。 |
| `tools/browser_tool_install.py` | 同上的冻结存根（安装面）。 |
| `tools/browser_use_cli.py` | `browser_exec` 本体：经 browser-harness 走 CDP 驱动浏览器。 |
| `tools/browser_use_shot.py` | 截图与标签页助手，覆盖 harness 自带实现。 |
| `tools/browser_session.py` | 会话状态中枢：每 cache key 一个会话，固定优先级创建。 |
| `tools/browser_session_cdp.py` | 用户提供的 CDP 端点（/browser connect、env、config）。 |
| `tools/browser_session_cloud.py` | `browser.*` 配置与云浏览器厂商解析（失败回退本地）。 |
| `tools/browser_session_lifecycle.py` | 会话生命周期：不活跃清理、孤儿收割、逐会话拆卸。 |
| `tools/browser_session_real_profile.py` | 把用户默认 Chromium profile 快照成 Hermes 副本使用。 |
| `tools/browser_session_sandbox.py` | 跑在终端后端沙箱里的 bot Chromium（Bot Desktop）。 |
| `tools/browser_supervisor.py` | 常驻 CDP 监听器门面。 |
| `tools/browser_supervisor_capture.py` | 把 CDP 连接句柄交给受信进程内插件。 |
| `tools/browser_supervisor_dialogs.py` | 对话框捕获 + 应答半场。 |
| `tools/browser_supervisor_frames.py` | frame / OOPIF 跟踪半场。 |
| `tools/browser_launcher.py` | Chromium 进程的启动、跟踪与父优先停止。 |
| `tools/browser_launcher_holders.py` | 共享持久 profile 浏览器的跨进程持有人记账。 |
| `tools/browser_lightpanda.py` | Lightpanda 本地引擎（仅显式配置启用）。 |
| `tools/browser_harness_dirs.py` | browser-harness 守护进程的每 profile 运行/临时目录。 |
| `tools/browser_real_profile_logins.py` | 读真实 profile 的已存登录，供 vault 只读后端使用。 |
| `tools/browser_url_policy.py` | `browser_exec` 的 URL 安全预扫描与 SSRF 助手。 |
| `tools/browser_cdp_tool.py` | `browser_cdp`：裸 CDP 透传工具。 |
| `tools/browser_dialog_tool.py` | `browser_dialog`：应答 supervisor 捕获的原生对话框。 |
| `tools/browser_vault_tool.py` | vault 驱动的模型盲自动填表工具。 |
| `tools/browser_vault_context.py` | 在所选后端的 fill_context 里跑 vault 填表/验证码。 |
| `tools/browser_vault_preview.py` | 桌面内嵌浏览器（preview webview）上的 vault 页面操作。 |

网页组（8 个文件）：

| 文件 | 一句话角色 |
|---|---|
| `tools/web_tools.py` | `web_search`/`web_extract` 门面：选型、安全门、缓存、救援、截断。 |
| `tools/web_tools_extract.py` | web_extract 助手：URL 校验、provider 解析、缓存感知派发。 |
| `tools/web_tools_rescue.py` | 失败调用的无钥匙救援环。 |
| `tools/web_tools_truncate.py` | web_extract 的无 LLM 截断-落盘管线。 |
| `tools/web_result_cache.py` | 搜索/抽取结果的 TTL 缓存（默认 20 分钟）。 |
| `tools/x_search_tool.py` | X(Twitter) 搜索工具（xAI x_search Responses API）。 |
| `tools/xai_http.py` | xAI 直连 HTTP 的共享助手。 |
| `tools/openrouter_client.py` | OpenRouter API key 探测（多个工具共用）。 |

## 与其他模块的关系

- `tools/url_safety.py`：`web_tools` 与 `browser_url_policy` 都在请求前过这道 SSRF 闸。
- `tools/browser_vault_tool.py` 依赖 `credential_files.py` 式的凭证边界：密码永不进模型上下文。
- `plugins/web/`：所有搜索/抽取厂商 provider 的家；本模块只认 `agent.web_search_registry` 这个注册接口。
- 桌面 GUI（computer_use.md）：`desktop_preview`/`drive_preview` 操控的是渲染进程的 webview，与 CDP 浏览器是两条路；`browser_vault_preview` 是两者交界。
- `agent/`：`model_tools.py` 的 `_rewrite_browser_cdp`/`_rewrite_browser_exec` 在 schema 描述里动态补充跨工具提示（schema 描述本身禁止点名其他工具）。

## 总结

浏览器组的架构可以背成一句优先级口诀：**覆盖 > 云 > 本地**，而本地又分「同意的真实 profile 快照」与「全新打包 Chromium」两种，Lightpanda 永远不自动上。围绕这一个 `browser_exec`，会话、启动器、supervisor 各司其职——一个是地址簿，一个是进程保姆，一个是常驻听诊器；两个旧存根则安静地躺在原地等最后一次 `hermes update` 落地。网页组恰好相反：本体极薄，全部多样性都推给插件 provider，自己只保留「选哪个、安不安全、缓存多久、崩了怎么办」四个问题的答案。
