# GUI 自动化与桌面组 —— computer_use、bot_desktop 与桌面桥接

## 文件概览

模型怎么操作图形界面？三条路，三个文件群。`tools/computer_use/`（13 个文件）是 `computer_use` 工具的包：经 cua-driver 在 macOS/Windows/Linux 上做后台桌面控制——截图、鼠标、键盘、滚动、拖拽，**不抢用户的鼠标和键盘焦点**。`tools/bot_desktop/`（11 个文件）更进一步：给每个 Hermes profile 配一台专属的无头 Xfce 虚拟桌面（Xvnc over Unix socket），agent 在自己的屏幕上活动，与用户互不打扰。最后 16 个桌面桥接工具（`desktop_ui.py`、`preview_tool.py`、`tour_tool.py` 等）是「点桌面的手」：通过渲染器事件操控 Hermes 桌面应用自身的窗格、预览、主题和引导。本篇深讲 `computer_use/tool.py`、`computer_use/backend.py` 与 `bot_desktop/runtime.py`。

## 关键代码走读

### 1. tool.py：硬拦截清单先于审批

`computer_use` 的安全模型分两层：先有**无条件硬拦截**（不走审批，直接拒绝），再有常规审批门。硬拦截的对象是「登录出/锁屏会杀掉 Hermes 自己所在会话」这类组合键，以及 `type` 动作里的危险 shell 模式（管道下载执行、fork 炸弹）：

```python
# 来源：tools/computer_use/tool.py:44-54
_BLOCKED_KEY_COMBOS = {
    frozenset({"cmd", "shift", "backspace"}), frozenset({"cmd", "option", "backspace"}),  # empty trash / force delete
    frozenset({"cmd", "ctrl", "q"}), frozenset({"cmd", "shift", "q"}),                    # lock screen / log out
    frozenset({"cmd", "option", "shift", "q"}), frozenset({"win", "l"}),                  # force log out / lock
    frozenset({"ctrl", "option", "delete"}), frozenset({"ctrl", "option", "del"}), frozenset({"option", "f4"}),
}
_KEY_ALIASES = {"command": "cmd", "control": "ctrl", "alt": "option", "⌘": "cmd", "⌥": "option",
                "windows": "win", "super": "win", "meta": "win"}
_BLOCKED_TYPE_PATTERNS = [re.compile(p, re.IGNORECASE) for p in (  # dangerous shell patterns for `type` (last one: fork bomb)
    r"curl\s+[^|]*\|\s*bash", r"curl\s+[^|]*\|\s*sh", r"wget\s+[^|]*\|\s*bash",
    r"\bsudo\s+rm\s+-[rf]", r"\brm\s+-rf\s+/\s*$", r":\s*\(\)\s*\{\s*:\|:\s*&\s*\}")]
```

细节见真章：组合键的规范化把 `Alt`/`alt`/`option` 统一成 `option`、把 `meta`/`super` 统一成 `win`——因为 cua-driver 也接受连字符写法，`ctrl-alt-delete` 若不规范化拆分就会绕过黑名单（`_canon_key_combo` 按 `+` **和** `-` 双分隔符拆）。

### 2. 截图去重：静态屏幕别再发同一张图

GUI 自动化的典型循环是「截图→行动→再截图」。屏幕没变时，每步都重发同一张 ~1200px 图纯属烧钱。tool.py 给每个会话维护一份「上一帧指纹」：同一目标（app, window）的字节级相同截图，返回正常文本元数据加一句「屏幕未变」，省掉图像块；连续省略有上限，保证压缩（只保留最新带图工具结果）不会把注释所指的图弄丢：

```python
# 来源：tools/computer_use/tool.py:94-116（节选）
# Screenshot dedup: a tight capture→act→capture loop on a static screen resends the same ~1200px image every step.
# Every delivered frame is hashed (sha256 over mime + base64 payload); when the next capture of the SAME target
# (app, window) in the SAME session is byte-identical, the tool returns the normal text metadata (element index
# included) plus an explicit "screen unchanged" note and omits the image block. Append-only — no prior transcript
# message is rewritten, so prompt-cache prefixes stay intact. ...
def _screenshot_dedup_check(session_id: str, digest: str, target: tuple[str, str]) -> bool:
    """True when this capture should be delivered WITHOUT its image: the previous frame for this session had identical
    bytes for the same target and the omission streak is below _SCREENSHOT_DEDUP_MAX_STREAK. Any miss (new pixels,
    new target, streak exhausted, first capture) resets the stored state to this digest so the image goes out."""
    with _screenshot_dedup_lock:
        state = _last_screenshot_state.get(session_id)
        if (state is not None and state.get("digest") == digest and state.get("target") == target
                and int(state.get("streak", 0)) < _SCREENSHOT_DEDUP_MAX_STREAK):
            state["streak"] = int(state.get("streak", 0)) + 1
            return True
        _last_screenshot_state[session_id] = {"digest": digest, "target": target, "streak": 0}
        return False
```

注意注释里对不变量的自觉：**只追加、不改写历史消息**，提示缓存前缀才不被破坏。

### 3. backend.py：任何驱动的统一形状

`ComputerUseBackend` 是抽象接口：cua-driver（MCP 模式）、插件驱动、测试 noop 都实现它。核心数据形状是 `UIElement`（一个可交互元素）与 `CaptureResult`（一次截屏）。特别值得学的是 `element_token` 的陈旧性防御——快照里的元素索引可能在行动前失效，一个不透明 token 让「点在过期元素上」显式报错，而不是静默解析到另一个元素：

```python
# 来源：tools/computer_use/backend.py:15-35（节选）
@dataclass
class UIElement:
    """One interactable element on the current screen."""

    index: int                       # 1-based SOM index
    role: str                        # AX role (AXButton, AXTextField, ...)
    label: str = ""                  # AXTitle / AXDescription / AXValue snippet
    bounds: tuple[int, int, int, int] = (0, 0, 0, 0)  # x, y, w, h (logical px)
    app: str = ""                    # owning bundle ID or app name
    pid: int = 0                     # owning process PID
    window_id: int = 0               # SkyLight / CG window ID
    attributes: dict[str, Any] = field(default_factory=dict)
    # Opaque per-snapshot handle from cua-driver, passed alongside `index` for explicit stale-detection: a
    # stale token errors instead of silently re-resolving to a different element. None on older drivers.
    element_token: Optional[str] = None
```

`CaptureResult` 则定义三种模式：`vision`（只给 PNG）、`ax`（只给无障碍元素表）、`som`（默认，PNG 上叠加编号标记，`elements` 给出索引→元素映射）。后端由插件工厂 `ComputerUseProvider` 提供（`plugins.computer_use` 注册），config 的 `computer_use.backend` 精确选一个。

### 4. bot_desktop/runtime.py：一人一屏

Bot Desktop 给每个 profile 开一台无头 Xfce，经 RFB（远帧缓冲）Unix socket 供桌面应用观看与驱动。全部状态收在 `<HERMES_HOME>/bot-desktop/` 下且**都按 profile 分域**——N 个 profile 在一个网关里就是 N 台桌面，一屏一 bot：

```python
# 来源：tools/bot_desktop/runtime.py:1-8（docstring 节选）
"""Bot Desktop runtime: one headless Xfce desktop per Hermes profile, served over RFB on a private
Unix socket, viewed and driven from Hermes Desktop.

Layout under ``<HERMES_HOME>/bot-desktop/``: ``display`` (allocated X display number), ``rfb.sock``
(Xvnc RFB Unix socket, 0600), ``Xauthority``, ``env`` (DISPLAY/XAUTHORITY/DBUS_SESSION_BUS_ADDRESS
published by the launcher once Xfce's bus exists), ``launcher.pid``, ``launcher.log``, ``xdg/``
(per-profile XDG_CONFIG_HOME so two profiles never share xfconf). Everything is profile-scoped via
``get_hermes_home()`` so N profiles in one gateway get N desktops: one screen per bot on the shared
machine.
```

`desktop_env()` 是关键的接缝：cua-driver 和有头 Chromium spawn 时合并这份环境变量，agent 的输入就落在**这个 profile 的屏幕**上而不是别处。`browser_session_sandbox.py` 则把 bot 的 Chromium 放进终端后端的沙箱里跑（Bot Desktop 摆放模式）；`lease.py` 管理「谁正在用这台桌面」的租约，`idle_watch.py` 看空闲，`rfb_filter.py` 过滤 RFB 协议消息，`thumbnail.py` 出缩略图。

### 5. computer_use_tool.py：包入口注册的垫片

发现机制只扫描 `tools/<pkg>/tool.py`，所以 `computer_use/` 包需要这个入口文件完成注册；而 `tools/computer_use_tool.py` 是**顶层的发现垫片**——`tools/*.py` 平铺文件也会被自动 import，它把包里的注册逻辑顺带激活：

```python
# 来源：tools/computer_use_tool.py:1-5
"""Discovery shim: tools.registry auto-imports ``tools/*.py``, so this top-level
module registers ``computer_use`` for the ``tools/computer_use/`` package."""

from __future__ import annotations

from tools.computer_use.schema import COMPUTER_USE_SCHEMA
from tools.computer_use.tool import (
    check_computer_use_requirements, handle_computer_use, release_computer_use_session, set_approval_callback,
)
```

`schema.py` 持有工具 schema；`doctor.py` 是环境体检（驱动装没装、权限有没有）；`permissions.py` 管 macOS 的辅助功能/录屏授权；`cua_backend*.py` 六个文件是 cua-driver 后端的六个侧面（采集、守护进程、驱动、输入、解析、会话）。

### 6. 桌面桥接工具：session 能力，不是 env 能力

16 个桥接工具（`read_terminal`、`desktop_preview`、`drive_preview`、`annotate_preview`、`focus_pane`、`read_window_below`、`react_to_message`、`gui_tour`、`show_tip`、`set_theme`、`setup_beat`、`desktop_project` 等）全部属于 `desktop_ui`/`project` toolset——由 GUI 网关按**会话平台**折叠进工具表，而不是看后端进程的 `HERMES_DESKTOP=1`。AGENTS.md 讲透了为什么：桌面客户端和后端可以是两台机器（本地、SSH、URL+token、Hermes Cloud），只有前两种才带那个环境变量；环境变量门控在远程拓扑上是静默失效的——工具被剥掉，平台提示却还告诉模型「你在桌面应用里」。`desktop_ui.py` 是所有这些工具通向渲染器事件的桥。

## 核心类/函数

| 符号 | 职责 | 位置 |
|---|---|---|
| `handle_computer_use` | 工具入口：动作分发、硬拦截、审批、后端调用 | `tools/computer_use/tool.py` |
| `_reject_unsafe` | 硬拦截判定（危险组合键、type 危险模式），先于审批 | `tools/computer_use/tool.py:60` |
| `_canon_key_combo` | 组合键别名规范化（防连字符绕过） | `tools/computer_use/tool.py:56` |
| `_screenshot_dedup_check` | 静态屏幕截图去重（省图像块，保缓存前缀） | `tools/computer_use/tool.py:105` |
| `ComputerUseBackend` | 任何驱动实现的抽象接口 | `tools/computer_use/backend.py` |
| `UIElement` / `CaptureResult` | 屏幕元素与截屏结果的统一形状（含陈旧 token） | `tools/computer_use/backend.py:15` |
| `desktop_env`（bot_desktop.runtime） | 供 cua-driver/Chromium 合并的 per-profile 桌面环境 | `tools/bot_desktop/runtime.py` |
| `COMPUTER_USE_SCHEMA` | 工具 schema（动作枚举与参数） | `tools/computer_use/schema.py` |
| `check_computer_use_requirements` | check_fn：驱动可达性探测 | `tools/computer_use/tool.py` |
| `doctor`（computer_use.doctor） | cua-driver 环境体检与修复建议 | `tools/computer_use/doctor.py` |
| `desktop_ui`（模块） | 桥接工具 → 桌面渲染器事件的唯一通路 | `tools/desktop_ui.py` |

## 本组文件清单

computer_use/ 子包（13 个文件）：

| 文件 | 一句话角色 |
|---|---|
| `tools/computer_use/__init__.py` | 包标识（发现的 `__init__.py` 守卫需要它）。 |
| `tools/computer_use/tool.py` | 工具逻辑：硬拦截、审批、会话缓存后端、截图去重。 |
| `tools/computer_use/backend.py` | 抽象后端接口与 UIElement/CaptureResult 形状。 |
| `tools/computer_use/schema.py` | 模型可见的工具 schema。 |
| `tools/computer_use/cua_backend.py` | cua-driver 后端组合根。 |
| `tools/computer_use/cua_backend_capture.py` | 截屏/元素采集侧。 |
| `tools/computer_use/cua_backend_daemon.py` | cua-driver MCP 守护进程管理。 |
| `tools/computer_use/cua_backend_driver.py` | 驱动进程的启动与协议。 |
| `tools/computer_use/cua_backend_input.py` | 鼠标/键盘输入侧。 |
| `tools/computer_use/cua_backend_parse.py` | 驱动输出解析（SOM 元素表等）。 |
| `tools/computer_use/cua_backend_session.py` | 每会话后端状态（原生目标、refs、授权命名空间）。 |
| `tools/computer_use/doctor.py` | 环境体检：驱动、权限、显示器的可诊断性。 |
| `tools/computer_use/permissions.py` | macOS 辅助功能/录屏等权限的检查与请求。 |

bot_desktop/ 子包（11 个文件）：

| 文件 | 一句话角色 |
|---|---|
| `tools/bot_desktop/runtime.py` | 每 profile 一台无头 Xfce 的运行时与布局。 |
| `tools/bot_desktop/browser.py` | 桌面内浏览器会话的放置与对接。 |
| `tools/bot_desktop/idle_watch.py` | 桌面空闲观察（回收/休眠判定）。 |
| `tools/bot_desktop/install.py` | Xfce/Xvnc 组件的安装引导。 |
| `tools/bot_desktop/lease.py` | 桌面使用租约：谁在驱动这块屏。 |
| `tools/bot_desktop/placement.py` | 窗口摆放策略。 |
| `tools/bot_desktop/resources.py` | 桌面资源（壁纸等随包资产）的路径解析。 |
| `tools/bot_desktop/rfb_filter.py` | RFB 协议消息过滤（供缩略图/预览）。 |
| `tools/bot_desktop/sandbox_host.py` | 作为沙箱宿主时对桌面环境的暴露。 |
| `tools/bot_desktop/thumbnail.py` | 屏幕缩略图生成。 |
| `tools/bot_desktop/launcher.sh` | 启动 Xvnc + Xfce 并发布 env 文件的 shell 启动器。 |

桌面桥接工具（16 个文件）：

| 文件 | 一句话角色 |
|---|---|
| `tools/computer_use_tool.py` | 顶层发现垫片：激活 `computer_use/` 包的注册。 |
| `tools/desktop_ui.py` | 桌面专用工具 → 渲染器事件的桥。 |
| `tools/preview_tool.py` | `desktop_preview`：聊天旁预览窗格的单一工具。 |
| `tools/open_preview_tool.py` | 在预览窗格打开 URL/dev server/文件。 |
| `tools/close_preview_tool.py` | 关闭预览窗格或其中一个标签页。 |
| `tools/read_preview_tool.py` | 读取内嵌浏览器/预览窗格内容。 |
| `tools/drive_preview_tool.py` | 驱动预览窗格（点击、输入、滚动）。 |
| `tools/annotate_preview_tool.py` | 在内嵌浏览器里持久标注元素。 |
| `tools/focus_pane_tool.py` | 显示/聚焦某个窗格（pane.reveal）。 |
| `tools/read_window_tool.py` | 读出桌面窗口正下方压着哪个 OS 窗口。 |
| `tools/set_theme_tool.py` | 设置主题色/明暗/布局或弹出选择卡。 |
| `tools/tip_tool.py` | 指着界面某处说一句话的轻提示工具。 |
| `tools/tour_tool.py` | 高亮 + 解说界面元素的引导漫游。 |
| `tools/tour_presets.py` | `gui_tour` 无步骤启动时的内置漫游预设。 |
| `tools/setup_beat_tool.py` | 仅限 onboarding 的节拍卡工具（经桌面呈现并等待）。 |
| `tools/project_tools.py` | 桌面 Projects（命名工作区）的创建/切换工具。 |

## 与其他模块的关系

- `tools/registry.py`：`computer_use` 经包入口 `tool.py` 注册；桥接工具注册在 `desktop_ui`/`project` toolset（会话能力，非 env 能力）。
- `tools/approval.py`：computer_use 的审批回调与共享授权存储（"always" 就是一条终端式的白名单条目）。
- `tools/browser_session_sandbox.py`：Bot Desktop 模式下 bot 的 Chromium 跑在桌面环境里。
- `tui_gateway/`（GUI 网关）：`_load_enabled_toolsets(platform)` 是把 `desktop_ui` 折叠进会话的唯一装载点。
- `hermes_dir_acl`：后端目录的用户权限加固（`make_user_dir`）。

## 总结

GUI 自动化这一组的三层结构各自回答一个问题。**computer_use** 回答「怎么安全地动手」：硬拦截清单挡住自杀式组合键和管道执行，审批门管剩下的一切，截图去重管成本。**bot_desktop** 回答「在哪动手」：一人一屏的 profile 私有桌面，让 agent 的并发活动与用户彻底解耦。**桌面桥接工具** 回答「怎么跟用户看见的界面协作」：高亮、预览、漫游、主题，全部作为会话能力由 GUI 网关装载——「能力属于会话，不属于进程环境」这条根 AGENTS.md 的裁决在这里有最生动的注脚。
