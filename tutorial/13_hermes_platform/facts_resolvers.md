# host facts 与 resolver 族深读 —— 从 procfs 到 AppDef

## 文件概览

本篇把 `hermes_platform` 的两个子层拆开细读：**host/** 的每个事实函数（读哪里、为什么绝不读 env），与 **resolver/** 的完整解析链（`Observation` 词汇 → `locate_command` → `AppResolver` → `availability` 七态）。全部 15 个文件在文末清单中逐行归档。

## 关键代码走读

### host/facts.py：一条事实、三个平台、一个回退链

```python
# hermes_platform/host/facts.py:204-244（节选）
def parse_meminfo_total(text: str) -> int | None:
    """Return ``MemTotal`` from ``/proc/meminfo`` text, in bytes."""
    for line in text.splitlines():
        if line.startswith("MemTotal:"):
            fields = line.split()
            if len(fields) >= 2 and fields[1].isdigit():
                return int(fields[1]) * 1024
    return None


@functools.cache
def ram_total_bytes() -> int | None:
    """Return the physical memory visible to this OS, or ``None`` when unavailable."""
    try:
        if sys.platform == "win32":
            return _windows_ram_total()
        if sys.platform == "darwin":
            return _sysctl_u64(b"hw.memsize") or None
    except (AttributeError, OSError, TypeError, ValueError):
        return None
    return parse_meminfo_total(_read_text("/proc/meminfo", 4096))
```

代码组织是「**解析器纯函数 + 平台读取器 + 缓存门面**」三层：`parse_meminfo_total(text)` 是纯函数（对文本负责，数据化测试友好），`_windows_ram_total()`/`_sysctl_u64()` 是平台读取器（ctypes/procfs），`ram_total_bytes()` 是缓存门面。CPU vendor 也有同等结构：`parse_cpuinfo_vendor()`（行 179-188）先认 x86 的 `vendor_id`，再认 arm64 Linux 的 `CPU implementer` 十六进制码（`0x41`=ARM、`0x61`=Apple、`0x4E`=NVIDIA…）。注释里的一个细节值得记住：Windows 报的是 SoC vendor（N1X 机器上就是 `NVIDIA`），arm64 Linux 报的是核心设计者——两者语义不同但都是「这台机器的芯片是谁家的」。

### GPU：注册表行到 vendor 分类

```python
# hermes_platform/host/facts.py:280-293
def parse_windows_display_adapters(rows: list[tuple[str, str, str]]) -> list[tuple[str, str, str]]:
    """``(vendor id, device id, description)`` per adapter from ``(subkey, MatchingDeviceId, DriverDesc)`` rows.

    Virtual adapters (no ``VEN_`` id, such as the remote-display driver) are skipped; an
    adapter subkey without a readable id keeps empty ids so it counts as unreadable."""
    adapters = []
    for subkey, matching_id, description in rows:
        upper = matching_id.upper()
        if "VEN_" in upper:
            adapters.append((_hex_after(upper, "VEN_"), _hex_after(upper, "DEV_"), description))
        elif subkey.isdigit() and not matching_id:
            adapters.append(("", "", description))
    return adapters
```

Windows 的显示适配器住在注册表显示类键（`{4d36e968-…}`）下；解析器区分三种情况：有 `VEN_` 的物理卡（提出 vendor/device id）、无 id 的子键（保留空 id、计入「不可读」——分类结果是 `unknown` 而不是 `none`，行 259-262）、无 `VEN_` 的虚拟适配器（远程显示驱动，跳过）。分类器 `_GPU_PRIORITY = ("nvidia", "amd", "intel")` 让独显在混合机器上赢过核显。数据流：注册表行 → `parse_windows_display_adapters`（纯）→ `_windows_display_adapters`（缓存）→ `classify_gpu_vendors`（纯）。

### macOS 两条 ctypes 长廊

`host/darwin_pci.py` 读 IOKit registry 的 PCI 显示控制器（`kCFStringEncodingUTF8`、base class `0x03`、上限 256 设备）——Intel Mac 从这里拿到 GPU vendor，Apple silicon 没有 PCI 显示控制器（这是事实，不是缺陷）。`host/gpu_adapters.py` 走 DXGI：

```python
# hermes_platform/host/gpu_adapters.py:1-8
"""Windows graphics adapters as DXGI reports them.

Task Manager's "GPU memory" for an adapter is DXGI's dedicated video memory plus shared system
memory, and that sum is what Windows lets the adapter allocate. An integrated GPU has almost no
dedicated memory, so its shared allowance is its real pool: an Intel Arc B390 on a 31.5 GB machine
gets 18 GB. Read through ctypes without environment-variable input or subprocesses."""
```

ctypes 手扒 COM vtable（`_RELEASE, _ENUM_ADAPTERS1, _GET_DESC1 = 2, 12, 10`——IUnknown::Release、IDXGIFactory1::EnumAdapters1、IDXGIAdapter1::GetDesc1 的槽位号），`_SOFTWARE_FLAG = 0x2` 排除 Microsoft Basic Render Driver 这种软件适配器。返回的 `Adapter` 记录 `dedicated_video_memory` 与 `shared_system_memory` 两个字段——「能分配多少」是两者之和，这正是 Task Manager 显示的数字。

### summary.py：账户事实的来源边界

```python
# hermes_platform/host/summary.py:1-7
"""One summary of this machine and its OS account, for the desktop first-run onboarding.

Hardware facts come from ``hermes_platform.host``. Account facts (full name, locale) come from OS
user records through ``pwd`` or Win32/CoreFoundation calls, never from environment variables such
as HOME or LANG, and never from a subprocess or the network. They describe the machine that runs
the Hermes backend; when the desktop app drives a remote backend, that is not the user's laptop."""
```

账户摘要（全名、locale）有三条来源禁令：**绝不** `HOME`/`LANG` 等环境变量、**绝不** subprocess、**绝不**网络。理由写在最后一句：桌面 app 可能驱动一台**远程**后端——`HOME` 说的是 shell 会话，`pwd`/Win32/CoreFoundation 说的才是「跑后端的这台机器上的账户」。`_NON_NAMES`（admin/guest/root/user…）把泛化账户名从「人名候选」里剔除，`_HANDLE_CHARS`（数字、下划线、@、路径分隔）识别出 handle 形态的名字。

### resolver/core.py：ABSENT、None、"" 的三态

```python
# hermes_platform/resolver/core.py:57-67
@dataclass(frozen=True)
class LookupContext:
    """`path`: ABSENT = caller did not say (ambient), None = ambient, "" = search nothing."""

    path: str | None | _Absent = ABSENT
    pathext: str | None = None

    def effective_path(self) -> str | None:
        if isinstance(self.path, str):
            return self.path
        return None
```

`LookupContext.path` 的三种「没给」值语义不同：`ABSENT`（哨兵单例，行 19-26）= 调用者没表态（用环境 PATH）；`None` = 明确要用环境 PATH；`""` = 什么都不搜（`_which` 行 95-96 直接短路）。`pathext` 显式传入时（Windows）不读 `os.environ` 的 PATHEXT 而是**不改变环境地**尊重调用者的值。这套三态让「测试注入 PATH」与「生产用环境 PATH」是同一个代码路径，而不是两套分支。

### app.py → availability.py：从 AppDef 到七态

```python
# hermes_platform/resolver/app.py:1-7
"""Desktop-application resolver over an `AppDef` (parsed from an MCP manifest's `app:` block).

`locate` stats every declared location in order (fixed paths, PATH, uninstall entries, the flatpak,
snap and Applications directories) and lists directories for a `*` path segment; the first present
one wins. `inspect` reads the version source in-process.
`probe` re-reads the vendor's runtime file on every call; the bearer token in it never
leaves this module."""
```

AppDef 来自 MCP 清单的 `app:` 块——位置列表是声明式的：固定路径、PATH、卸载注册表项、flatpak/snap/Applications 目录，`*` 段做目录展开，**按序 stat、第一个存在的胜出**。三级努力各守各的边界：`inspect` 只在进程内开文件；`probe` 每次重读厂商运行时文件且 bearer token **永不离开本模块**（安全边界编码在模块边界上）。`availability.py` 把声明块折算成七态：

```python
# hermes_platform/resolver/availability.py:20-29
AvailabilityState = Literal[
    "available",
    "installed_not_running",
    "missing_app",
    "version_too_old",
    "unsupported_os",
    "unsupported_gpu",
    "no_requirements",
]
```

它跑的只有 `locate`、`inspect` 和缓存的 GPU fact，**永不 probe、永不 spawn、永不 connect、自己无缓存**——需要 TTL 的调用方（工具注册表）已经有 TTL，两层缓存是重复计费。这个模块的存在让 MCP 目录与技能 offer 门可以共享同一个「这台机器能不能提供该条目」的答案。

## 核心类/函数

| 符号 | 位置 | 职责 |
|---|---|---|
| `parse_cpuinfo()` / `parse_cpuinfo_vendor()` | `facts.py:96/179` | procfs 纯解析（含 ARM implementer 表） |
| `parse_meminfo_total()` / `_windows_ram_total()` | `facts.py:204/214` | 内存事实的纯解析与平台读取 |
| `classify_gpu_vendors()` | `facts.py:254` | vendor id → GPU 类（`unknown` vs `none` 有别） |
| `parse_windows_display_adapters()` | `facts.py:280` | 注册表行 → 三类适配器 |
| `_linux_gpu_vendor_ids()` | `facts.py:265` | sysfs DRM 卡扫描（上限 16） |
| `_sysctl_int/u64/str` | `facts.py:124-159` | macOS sysctl 三件套 |
| `_winreg_str()` | `facts.py:113` | 注册表字符串读取 |
| IOKit PCI 读取 | `darwin_pci.py` | `_data_int`、`_DISPLAY_CLASS` |
| DXGI vtable 读取 | `gpu_adapters.py` | `_RELEASE/_ENUM_ADAPTERS1/_GET_DESC1` |
| `classify_nvidia_platform()` / `is_nvidia_n1x_pci_id()` | `products.py:12/15` | NVIDIA 产品分类 |
| `_NON_NAMES` / `_HANDLE_CHARS` | `summary.py` | 泛名过滤 / handle 形态识别 |
| `ABSENT` / `_Absent` | `core.py:19/26` | 「没表态」哨兵 |
| `Observation.not_checked()` | `core.py:45` | 未检查态的工厂 |
| `_which()` / `_known_dir_variants()` | `core.py:94/143` | PATH 查找 / PATHEXT 变体 |
| `locate_command()` | `core.py:116` | 显式路径→PATH→known_dirs 三段定位 |
| `Effort.LOCAL/NETWORK/DIAGNOSTIC` | `base.py:11-15` | probe 能力分级 |
| `Inspection` / `Probe` | `base.py:19` | 两级非被动结果 |
| `AppResolver` 三方法 | `app.py` | locate/inspect/probe |
| `AppDef` / `AppLocation` / `LOCATION_KINDS` | `app.py` | 清单声明词汇 |
| `AvailabilityState` 七态 | `availability.py:20` | offer 门结果词汇 |
| `known_dirs` 各表 | `known_dirs.py` | 生态分组目录表 |

## 本组文件清单（15 文件全清单）

| 文件 | 角色 | 关键符号 |
|---|---|---|
| `hermes_platform/__init__.py` | 层定位 docstring | — |
| `hermes_platform/declaration.py` | 声明注册表（MCP/技能共享） | `parse_declaration`, `lookup` |
| `hermes_platform/host/__init__.py` | host 子包入口 | — |
| `hermes_platform/host/facts.py` | 事实门面 + 三平台读取 | `native_arch`, `ram_total_bytes` |
| `hermes_platform/host/darwin_pci.py` | macOS PCI 显示控制器 | IOKit registry |
| `hermes_platform/host/gpu_adapters.py` | Windows DXGI 适配器内存 | 专用+共享 |
| `hermes_platform/host/products.py` | NVIDIA 平台识别 | `NvidiaPlatform` |
| `hermes_platform/host/runtime.py` | WSL/Termux 谓词 | `is_wsl`, `is_termux` |
| `hermes_platform/host/summary.py` | 一机一账户摘要 | onboarding |
| `hermes_platform/resolver/__init__.py` | 词汇再导出 | `__all__` |
| `hermes_platform/resolver/core.py` | 结果类型 + 被动定位 | `Observation`, `locate_command` |
| `hermes_platform/resolver/base.py` | 努力分级协议 | `Effort` |
| `hermes_platform/resolver/app.py` | AppDef 解析器 | bearer token 边界 |
| `hermes_platform/resolver/availability.py` | 七态可用性 | 无缓存 |
| `hermes_platform/resolver/known_dirs.py` | PATH 外目录表 | 棘轮测试 |

## 与其他模块的关系

- **pm/store.py**：`native_arch()` → 下载 target triple（musl/bionic 变体也在 triple 里）。
- **tools/**：`check_fn` 可用性探测消费 `locate_command`；MCP 目录消费 `availability`。
- **apps/desktop/**：`summary.py` 喂首启 onboarding；browser/chromium 能力查询消费 app 解析。
- **tests/test_managed_runtime_resolution.py**：known_dirs 的棘轮——目录字面量出本模块即失败。
- **agent/**：浏览器/computer-use 的应用级目标解析（AppDef）。

## 总结

两个子层共享一条实现哲学：**「读取」与「判断」分离**。每个事实函数都是「纯解析器（可数据化测试）+ 平台读取器（ctypes/procfs/registry）+ 缓存门面」的三明治；每个解析器都输出 `Observation`（分支于 state、detail 不被解析），把「机器说了什么」与「代码怎么决策」切开。这样，平台差异被压缩进读取器的几行 ctypes，决策逻辑成为跨平台纯函数——这正是它能作为全仓库唯一权威而不膨胀的原因。
