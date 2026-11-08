# hermes_platform/ —— 机器事实与资源解析的统一层

## 文件概览

`hermes_platform/` 是全仓库机器事实与可执行资源解析的**唯一权威**。包 docstring 一句话定纲：

> Machine facts and resource resolution for every Hermes surface. Host facts describe the machine running this interpreter; resolution has no side effects.

两个子层、两条纪律。**host/**（`facts.py`、`darwin_pci.py`、`gpu_adapters.py`、`products.py`、`runtime.py`、`summary.py`）回答「这台机器是什么」：OS、架构（仿真下也报原生架构）、CPU、内存、GPU。读取来源只有 registry/sysctl/IOKit/procfs/sysfs——**绝不**环境变量、绝不 subprocess、绝不 GPU 驱动库。**resolver/**（`core.py`、`app.py`、`availability.py`、`base.py`、`known_dirs.py`）回答「某个工具/app 在哪、什么状态」：被动、无副作用——`locate_command` 只读文件元数据。**declaration.py** 是顶层声明模块（应用需求的注册与查询）。根 AGENTS.md 的铁律「机器事实与可执行查找走 hermes_platform」就是指这里。

## 关键代码走读

### 架构：仿真之下报真身

```python
# hermes_platform/host/facts.py:1-5
"""Cached OS, architecture, CPU, memory and GPU facts for the current machine.

Native architecture remains accurate when the Python process is emulated. Facts read the registry,
sysctl, IOKit, procfs or sysfs: never the environment, a subprocess or a GPU driver library."""
```

四个架构函数各司其职：`normalize_arch()`（行 29）把 `x86_64`/`aarch64`/`i686` 等别名收拢成规范名；`process_arch()`（行 41）报**这个 Python 进程**的架构；`native_arch()`（行 80）报**机器**的架构——即使在 Rosetta/WOW64 仿真下：

```python
# hermes_platform/host/facts.py:79-90
@functools.cache
def native_arch() -> str:
    """Return the machine architecture even when this process is emulated."""
    if sys.platform == "win32":
        try:
            wow64 = _wow64_native_machine()
        except (OSError, AttributeError, TypeError, ValueError):
            wow64 = None
        return windows_native_arch(wow64_native=wow64, machine=platform.machine())
    if sys.platform == "darwin" and process_arch() == "amd64" and _darwin_translated():
        return "arm64"
    return process_arch()
```

Windows 走 `IsWow64Process2`（`_wow64_native_machine()`，行 53-71——ctypes 直接调 kernel32，`GetCurrentProcess.restype` 必须重定义为 HANDLE，否则伪句柄被截断成 c_int）；macOS 走 `sysctl.proc_translated`（Rosetta）。为什么较真：一个 x64 Python 跑在 arm64 Windows 上会选错下载 target、装错 artifact——`pm/store.py::_native_machine` 与工具解析全都消费这里的答案。`windows_native_arch()`（行 48-50）是纯函数：`IMAGE_FILE_MACHINE` 常量映射 + 回退，方便数据化测试。

### CPU/内存/GPU：每个平台一条只读通道

```python
# hermes_platform/host/facts.py:162-169
@functools.cache
def cpu_model() -> str:
    """Return the CPU model, or an empty string when unavailable."""
    if sys.platform == "win32":
        return _winreg_str(_CPU_KEY, "ProcessorNameString")
    if sys.platform == "darwin":
        return _sysctl_str(b"machdep.cpu.brand_string")
    return parse_cpuinfo(_read_text("/proc/cpuinfo"), device_tree_model=_read_text("/proc/device-tree/model", 512))
```

模式固定：Windows 读注册表（`HARDWARE\DESCRIPTION\System\CentralProcessor\0`）、macOS 读 sysctl、Linux 读 procfs/sysfs（CPU 型号还能回退到设备树 model——树莓派这类 ARM 板）。全部 `functools.cache`：事实是缓存的机器快照，进程内不变。GPU 的解析分两级：`classify_gpu_vendors()`（行 254）按 PCI vendor id 分类（`10de`=nvidia、`1002`=amd、`8086`=intel，独显优先）；数据来源 Windows 读显示类注册表键（`_windows_display_adapters`，行 297）、Linux 读 `/sys/class/drm/card*/device/vendor`、macOS 走 `darwin_pci.py` 的 IOKit registry（Apple silicon 没有 PCI 显示控制器，Intel Mac 才有名字）。`gpu_adapters.py` 是 Windows 专用的 DXGI 视角：Task Manager 显示的「GPU 内存」= DXGI 专用显存 + 共享系统内存之和——核显几乎没有专用显存，共享配额才是真实池子（31.5GB 机器上的 Intel Arc B390 拿到 18GB）。读法是 ctypes 手扒 vtable（`_RELEASE, _ENUM_ADAPTERS1, _GET_DESC1 = 2, 12, 10`），同样无 env、无 subprocess。

### 平台识别：从事实推导产品

```python
# hermes_platform/host/products.py:1-6
"""NVIDIA platform recognition derived from host facts.

Recognition uses OS-reported CPU, GPU or PCI identity without environment-variable input.
"""

NvidiaPlatform = Literal["rtx_spark", "dgx_spark", "discrete"]
```

`classify_nvidia_platform()` 用 OS 报告的 CPU/GPU/PCI 身份把机器归入 `rtx_spark`（CPU 标记 `N1X`）/`dgx_spark`（`GB10`、`DGX SPARK` 标记）/`discrete`；`is_nvidia_n1x_pci_id()`（行 15-17）处理 NVML 把 device 号打包到 16 位 vendor id 之上的特例。这一层是**纯函数**：输入事实、输出分类，宿主探测只发生在 facts 层。

### resolver：三级努力模型

```python
# hermes_platform/resolver/base.py:10-20
class Effort(Enum):
    """What `probe` may do. `NETWORK` never implies subprocess; `DIAGNOSTIC` alone may spawn."""

    LOCAL = "local"
    NETWORK = "network"
    DIAGNOSTIC = "diagnostic"


@dataclass(frozen=True)
class Inspection:
    version: Observation[str]
```

resolver 的核心词汇是 `Observation[T]` + `CheckState`（`core.py:29-47`）：消费者**只分支于 `state`**（NOT_CHECKED/PRESENT/ABSENT/UNAVAILABLE/ERROR），`detail` 是给人看的、永不被解析。努力分三级：`locate` 只读文件元数据；`inspect` 可以开文件、进程内调 OS API；`probe` 每次新鲜、永不缓存，是唯一可以开 socket 或 spawn 的层级——且 `NETWORK` 绝不暗含 subprocess。`locate_command()`（`core.py:116-140`）按「显式路径 → PATH → known_dirs」顺序记录每个候选（`Candidate` 带 present 标记），相对路径显式拒绝（会解析到环境 cwd）；Windows 下 known dir 里的裸名按 PATHEXT 枚举变体。

### known_dirs：目录字面量的棘轮

```python
# hermes_platform/resolver/known_dirs.py:1-6
"""Directories where tools install outside PATH, grouped by the ecosystem that owns them.

Every table in Hermes lives here. A directory literal outside this module fails the ratchet in
`tests/test_managed_runtime_resolution.py`. Each table is empty on an OS where the ecosystem
does not install there, so callers compose tables without OS branches."""
```

「工具装在 PATH 之外的规范目录」全部收拢于此，按生态分组：`homebrew_dirs()`（`/opt/homebrew/bin`、`/usr/local/bin`）、`user_local_bin()`、`rust_tool_dirs()`（`~/.cargo/bin`）等。棘轮测试 `tests/test_managed_runtime_resolution.py` 会让**任何出现在本模块之外的目录字面量测试失败**——这是把「散落的硬编码路径」变成「一张表」的机械化手段。每张表在不存在该生态的 OS 上为空，调用者组合表时不需要 OS 分支。

### app 解析与可用性

`resolver/app.py` 是桌面应用解析器：`locate` 按声明顺序 stat 每个位置（固定路径、PATH、卸载注册表项、flatpak/snap/Applications 目录），`*` 路径段展开目录列表，第一个存在的胜出；`inspect` 进程内读版本源（plist/可执行文件元数据）；`probe` 每次重读厂商的运行时文件——其中的 bearer token **永不离开本模块**。`resolver/availability.py` 把 `app`/`requires` 声明块折算成目录条目能否在此主机提供的七态：`available` / `installed_not_running` / `missing_app` / `version_too_old` / `unsupported_os` / `unsupported_gpu` / `no_requirements`。它只跑 `locate`、`inspect` 与缓存的 GPU fact——不 probe、不 spawn、不 connect、自己无缓存（需要 TTL 的调用方——工具注册表——已经有 TTL）。`declaration.py` 提供 `AppSpec`/`RequiresSpec` 的解析与注册表（MCP 清单与技能 offer 时门共享同一套声明语义）。

## 核心类/函数

| 符号 | 位置 | 职责 |
|---|---|---|
| `normalize_arch()` | `host/facts.py:29` | 架构别名收拢 |
| `process_arch()` / `native_arch()` | `host/facts.py:41/80` | 进程架构 / 机器架构（仿真下也正确） |
| `os_family()` | `host/facts.py:35` | `sys.platform` 缓存 |
| `windows_native_arch()` | `host/facts.py:48` | IsWow64Process2 原生机器映射 |
| `_wow64_native_machine()` / `_darwin_translated()` | `host/facts.py:53/74` | WOW64 / Rosetta 探测 |
| `cpu_model()` / `cpu_vendor()` | `host/facts.py:163/192` | 三平台 CPU 事实 |
| `ram_total_bytes()` | `host/facts.py:235` | 物理内存 |
| `classify_gpu_vendors()` | `host/facts.py:254` | PCI vendor → GPU 类（独显优先） |
| `parse_cpuinfo()` / `parse_meminfo_total()` | `host/facts.py:96/204` | procfs 解析（纯函数） |
| `parse_windows_display_adapters()` | `host/facts.py:280` | 注册表适配器行解析（纯函数） |
| 适配器读取（IOKit/DXGI） | `host/darwin_pci.py` / `host/gpu_adapters.py` | macOS PCI / Windows DXGI（专用+共享内存） |
| `classify_nvidia_platform()` | `host/products.py:20` | rtx_spark/dgx_spark/discrete |
| `is_wsl()` / `is_termux()` | `host/runtime.py` | 运行环境谓词（缓存） |
| `machine_summary()`（语义） | `host/summary.py` | 桌面首启 onboarding 的一机一账户摘要 |
| `Observation` / `CheckState` | `resolver/core.py:29/38` | 结果词汇（分支于 state） |
| `Resolution` / `Candidate` | `resolver/core.py:70/51` | 候选与解析（probe 顺序记录） |
| `LookupContext` | `resolver/core.py:58` | path/pathext 注入（ABSENT=None="" 三态） |
| `locate_command()` | `resolver/core.py:116` | 被动命令定位（只读元数据） |
| `Effort` / `Inspection` / `Probe` | `resolver/base.py` | 三级努力模型 |
| `AppResolver.locate/inspect/probe` | `resolver/app.py` | MCP manifest AppDef 解析 |
| `availability` 七态 | `resolver/availability.py` | offer 时的目录门 |
| `homebrew_dirs()` 等表 | `resolver/known_dirs.py` | PATH 外目录的唯一天花板 |
| `register()` / `lookup()` / `parse_app()` | `declaration.py` | 应用需求声明注册表 |

## 本组文件清单（15 文件全清单）

| 文件 | 角色 | 关键符号 |
|---|---|---|
| `hermes_platform/__init__.py` | 包 docstring（层定位） | — |
| `hermes_platform/declaration.py` | 顶层应用需求声明模块 | `AppSpec`, `RequiresSpec`, `register` |
| `hermes_platform/host/__init__.py` | host 子包入口 | — |
| `hermes_platform/host/facts.py` | 缓存的 OS/架构/CPU/内存/GPU 事实 | `native_arch`, `cpu_model` |
| `hermes_platform/host/darwin_pci.py` | macOS IOKit PCI 显示控制器 | ctypes 读 IOKit registry |
| `hermes_platform/host/gpu_adapters.py` | Windows DXGI 适配器（专用+共享内存） | `Adapter`, vtable 槽位 |
| `hermes_platform/host/products.py` | NVIDIA 平台识别 | `classify_nvidia_platform` |
| `hermes_platform/host/runtime.py` | WSL/Termux/容器谓词 | `is_wsl`, `is_termux` |
| `hermes_platform/host/summary.py` | 桌面首启的一机一账户摘要 | 账户 facts 来自 pwd/Win32/CoreFoundation，**永不 HOME/LANG** |
| `hermes_platform/resolver/__init__.py` | resolver 公共词汇再导出 | `Effort`, `Observation`… |
| `hermes_platform/resolver/core.py` | 结果类型 + 被动命令定位 | `Observation`, `locate_command` |
| `hermes_platform/resolver/base.py` | 协议与两级非被动结果 | `Effort`, `Inspection`, `Probe` |
| `hermes_platform/resolver/app.py` | 桌面 app 解析器（AppDef） | `locate`/`inspect`/`probe` |
| `hermes_platform/resolver/availability.py` | 目录条目七态可用性 | `AvailabilityState` |
| `hermes_platform/resolver/known_dirs.py` | PATH 外目录表（棘轮） | `homebrew_dirs` 等 |

## 与其他模块的关系

- **pm/store.py**：`native_arch()` 决定下载 target；PM 独立引导缺此包时才降级自行探测（同一套 IsWow64/sysctl 逻辑）。
- **tools/**：工具可用性检查（`check_fn`）消费 `locate_command` 与 `availability`；工具注册表的 TTL 缓存包住无缓存的 availability。
- **agent/ 浏览器与 computer-use**：桌面 app 解析（AppDef）服务 browser_exec 的应用目标。
- **apps/desktop**：首启 onboarding 消费 `host/summary.py`。
- **根 AGENTS.md**：「机器事实与可执行查找走 hermes_platform」是全仓库级铁律；`~/.hermes` 硬编码禁令的对应面。

## 总结

这个包的纪律可以用两句否定句概括：**事实不问环境变量、解析不产生副作用**。前者的理由是环境变量描述的是「会话」而事实描述的是「机器」（HOME/LANG 会骗人，注册表/sysctl/procfs 不会）；后者的理由是解析结果要被工具注册表、MCP 目录、技能门共享——有副作用的解析会把「探测」变成「安装」。三级努力模型（locate/inspect/probe）把「能做什么」编码进类型，让每个消费者按需选择、让棘轮测试守住目录字面量的天花板。
