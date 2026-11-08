# 09 plugins/ —— 插件系统总览：五套发现系统与一条铁律

`plugins/`（19 组内置插件 + 3 个共享模块）+ `plugin-catalog/`（约 1,150 个 YAML 条目）是 Hermes 的能力扩展层。整个系统压在一句话上（`plugins/AGENTS.md` 首节，Teknium, May 2026）：**插件永不触碰核心**——插件住在自己的目录里，在框架提供的 ABC / hooks / `ctx` 表面内工作；缺能力就**加宽通用插件面**（新 hook、新 ctx 方法），绝不把插件特有逻辑硬编码进核心（PR #5295 就是从 `main.py` 里摘除了 95 行硬编码的 honcho argparse）。

## 五套发现系统

理解 plugins/ 的关键是：**"插件"不是一个单一系统，而是五套并存的发现系统**，每套有自己的目录、优先序和激活方式：

| 类别 | 位置 | 发现机制 | 优先序 |
|------|------|---------|--------|
| 通用插件 | `plugins/<name>/`、`~/.hermes/plugins/`、`./.hermes/plugins/`、pip entry points | `PluginManager`（`hermes_cli/plugins.py`） | **later-wins**（后发现的同名者赢） |
| 记忆提供方 | `plugins/memory/<name>/` | `plugins/memory/__init__.py`：bundled → `$HERMES_HOME/plugins/` → `./.hermes/plugins/`（需 `HERMES_ENABLE_PROJECT_PLUGINS`）→ `hermes_agent.memory_providers` entry points | **bundled-first**（防止投进来的目录遮蔽内置） |
| 模型提供方 | `plugins/model-providers/<name>/` | `providers/__init__.py._discover_providers()`，**懒**（首次 `get_provider_profile()`/`list_providers()` 才跑） | **last-writer-wins**（用户插件覆盖内置 profile） |
| 上下文引擎/图像生成/委派/cron 提供方/配置后端/仪表盘鉴权 | `plugins/context_engine/`、`image_gen/`、`delegation/`、`cron_providers/`、`config_backends/`、`dashboard_auth/` | 各自 ABC + 编排器 + 目录 | 各自独立（通常 bundled 赢） |
| 平台适配器 | `plugins/platforms/<name>/adapter.py` | 网关平台注册表（26 个：irc、飞书、telegram、discord…） | token-lock 与 scoped-secret 规则见 `gateway/AGENTS.md`；禁改 `os.environ` |

## 进程中的发现时刻

```
import model_tools.py（副作用）
        │
        ▼
discover_plugins()  ──幂等；force=True 中途重扫──▶  PluginManager.discover_and_load()
        │                                                ├ 目录扫描 plugins/<name>/ + 用户/项目目录
        │                                                ├ pip entry points（目录同名者优先）
        │                                                ├ register(ctx)：hooks/tools/CLI/locale
        │                                                └ on_plugin_loaded → 激活摘要
        ▼
hooks 由 model_tools.py（pre/post tool）与 run_agent.py（生命周期）调用
```

三条时机纪律（`plugins/AGENTS.md`「Discovery timing pitfall」）：

- `discover_plugins()` 只在 **import `model_tools.py` 的副作用**里跑；不 import 它的代码要显式调用（幂等）。
- 非强制的 `discover_plugins()` 在 `_discovered` 标志上短路；每个中途加载路径（任意表面的 install/enable/update、`reload-plugins` 动词）都跑 `discover_plugins(force=True)`，`PluginManager.on_plugin_loaded` 从这次重扫里对**新加载**的插件发激活摘要（`hermes_cli/plugins_activation.py`：gateway handler 立即活；tools/prompt 下个会话；`deferred.mcp_servers` 等到 `mcp.reload`）。**绝不从 RPC 里发那个事件。**
- 辅助 LLM 调用（titling、压缩、MoA、vision…）从 `agent/auxiliary_hooks.py` 发 `pre_auxiliary_call`/`post_auxiliary_call`，绝不发 turn 范围的 `pre/post_api_request`（#79733）。

## 目录速览

```
plugins/
├── plugin_loader.py      # 共享的按路径加载器（memory/cron/context_engine 复用）
├── plugin_storage.py     # 插件存储辅助
├── plugin_utils.py       # 工具函数
├── platforms/            # 26 个平台适配器（最大组）
├── model-providers/      # 声明式 ProviderProfile 提供方
├── memory/               # 记忆提供方（对新成员关闭，迁往目录）
├── browser/ computer_use/ web/ image_gen/ video_gen/ context_engine/
├── delegation/ cron_providers/ config_backends/ dashboard_auth/
├── kanban/ disk-cleanup/ google_meet/ teams_pipeline/
├── security-guidance/ hermes-achievements/
plugin-catalog/           # ~1,150 个 YAML + removed.yaml 黑名单
```

## 兼容契约一览

兼容性是**行为契约**，不是单一的 `PLUGIN_API_VERSION` 或清单级版本号（详见本组 `plugin_api.md`）：

- hook payload 以**关键字字段**增量添加；回调按签名检查——旧窄签名只收到自己声明的字段，`**kwargs` 回调收到完整 payload。
- `PluginContext` 方法绝不移除或改名；新参数可选带默认、尽量 keyword-only。
- 本地 schema 版本只存在于有 wire/持久契约的能力上；旧状态/配置/会话重放被保留或迁移。
- 弃用：每进程一次警告、文档化替代 + 迁移说明、移除前 ≥ 2 个 minor 释放窗口。

## plugin.yaml 清单速查

通用插件的最小骨架与常用字段（完整语义见 plugin_api.md）：

```yaml
name: my-plugin              # 目录名即默认名
version: 1.0.0
description: "一行描述"        # plugin_loader.read_plugin_description 只读这个
kind: general                # general / memory-provider / model-provider…；缺省按源码启发式判型
requires_env:                # 安装/启用时提示的凭据名
  - MY_PLUGIN_API_KEY
config_schema:               # hermes memory setup 等设置流读取的形状
  memory.my_plugin: {...}
provides_locales: ["zh-CN"]  # 清单语言包无需 __init__.py
capabilities:
  provides_tools: [...]
  provides_hooks: [...]
```

通用插件目录里**必须有 `__init__.py`**（`plugins/plugin_loader.py::iter_plugin_dirs` 以它为准，跳过 `_`/`.` 开头目录）；纯清单语言包是唯一的例外。

## 发现的完整时序（从进程启动到钩子可用）

```
进程启动
  ├ load_hermes_dotenv（import 期，先于插件密钥源）
  ├ start_background_plugin_discovery()   # CLI 启动重叠（~150ms，守护线程）
  │      └ 同步消费者经 discover_plugins() join，绝不看到半装载注册表
  ▼
import model_tools.py（副作用）→ discover_plugins()
  ├ PluginManager.discover_and_load()
  │   ├ _collect_directory_manifests()   # plugins/<name>/ + $HERMES_HOME/plugins/ + ./.hermes/plugins/
  │   ├ _scan_entry_points()             # pip entry points（目录同名者优先）
  │   ├ 逐个 import <dir>/__init__.py → register(ctx)
  │   ├ _evict_stale_persistent_registrations()   # 没回来的注册者被清退
  │   └ _refresh_secret_sources_after_discovery() # 插件密钥源补拉
  └ on_plugin_loaded → 激活摘要（gateway handler 立即活；tools 下个会话）
  ▼
turn 中：hooks 由 model_tools.py（pre/post tool）与 run_agent.py（生命周期）分发
```

三条反直觉的时机事实，调试时先查它们：`HERMES_SAFE_MODE=1` 会整体跳过发现；不 import `model_tools.py` 的代码读到的插件状态是空的（要显式 `discover_plugins()`）；中途安装/启用/update 的表面全部走 `force=True` 重扫。

## 宿主隔离一览（`plugins.isolation: host`）

默认 `in_process` 把用户插件 import 进 Hermes 进程；`host` 则把**每个非捆绑插件**放进 per-profile 宿主进程（`hermes_cli/plugin_host.py` 父侧、`plugin_host_child.py` 子侧、`plugin_host_wire.py` 帧协议）。五条不变量（AGENTS.md 原文归纳）：

1. **一切用户代码导入路径要么路由进宿主要么拒绝**——通用插件、memory/context engine/cron 提供方（`load_instance`）、模型提供方 profile（按文件指纹缓存的免凭据提取）、dashboard API（ASGI 桥）都一样；新加载器必须照做。
2. **过不去的东西只有一张表**：`plugin_isolation.HOST_UNSUPPORTED_CTX_METHODS`（活网关/适配器对象）；运行时拒绝与静态审计读同一张。
3. **值跨 wire 保持 ABC 声明的类型**：JSON 只会传 dict/list/标量，`plugin_host_wire.restore` 按 ABC 注解重建（`FetchResult`、`Path`、枚举、引擎代理）。
4. **宿主永不 spawn 宿主**（`HERMES_PLUGIN_HOST_PROCESS=1` 强制 in-process），且不在模块导入持锁时启动。
5. **隔离方在操作员钉死时不能退出**：`isolation_mode()`/`host_launcher()` 经托管 overlay 读——`/etc/hermes/config.yaml` 压过 profile 自己的 config。

对插件作者完全透明：没有新 API，同一个 `ctx`；per-profile 环境经 `served_profile_child_env`，宿主只见自己 profile 的 secrets。

## 插件作者的三条红线（踩了会被机器拦下）

| 红线 | 执法者 | 后果 |
|------|--------|------|
| import 了 `plugin_api.json` 之外的核心名字 | `scripts/boundary_lint.py --check`（CI）+ `hermes plugins validate` 警告 | CI 失败；正确出路是先加 seam（见 boundary_lint.md） |
| 运行时覆盖核心（patch `AIAgent.<method>`、写 `sys.modules`） | catalog 准入规则 9 的 `no core override` 检查 | 条目被拒；hook 缺失就开 issue 加 seam |
| 裸读 `os.environ` 取凭据 | 多路复用下 fail-closed（`get_secret` 抛 `UnscopedSecretError`） | 插件在多 profile 宿主上直接故障；改走 `agent.secret_scope.get_secret` |

反向红线同样硬：**核心代码 import 一个具体的内置插件**（`plugins.platforms.discord.adapter`）会被同一个 lint 抓住——边界是双向的。

## 本组文档导航

| 文档 | 内容 |
|------|------|
| `index.md`（本篇） | 五套发现系统、时机纪律、目录地图 |
| `plugin_api.md` | 已发布 API：钩子点、`ctx` 表面、可实现 ABC、`plugin.yaml` 清单、加载机制 |
| `boundary_lint.py` | 边界治理：`scripts/boundary_lint.py` + baseline、`left_core_migration` |
| `catalog.md` | plugin-catalog/：准入规则、`removed.yaml`、loader 与 CLI 面 |
| `bundled_plugins.md` | 19 组内置插件逐组清单与政策注记 |

> 阅读顺序：先 `index.md` 建立地图，再 `plugin_api.md` 看作者能用什么，`boundary_lint.md` 看核心怎么守住边界，`catalog.md` 看第三方生态的信任模型，最后 `bundled_plugins.md` 当字典查。

## 与其他模块的关系

- **核心侧入口**：`hermes_cli/plugins*.py`（30+ 兄弟模块：loader/dispatch/ledger/cmd_*/manifest…）是通用插件系统的宿主；`model_tools.py` 是发现的触发点与钩子调用点。
- **网关侧**：平台适配器经 `gateway/platform_registry.py` 注册；token-lock 与 scoped-secret 规则在 `gateway/AGENTS.md`。
- **agent 侧**：`agent/memory_provider.py`（MemoryProvider ABC）、`providers/base.py`（ProviderProfile）、`agent/context_engine.py` / `image_gen_provider.py` / `delegation_provider.py` 是各专用插件系的对接面。
- **宿主隔离**：`plugins.isolation: host` 时一切用户代码导入走 `hermes_cli/plugin_host.py` 家族（详见 plugin_api.md 的边界小结）。

## 总结

plugins/ 的设计可以用三组对立统一概括：**通用插件 later-wins**（用户覆盖内置）与**记忆/引擎系 bundled-first**（按名激活者不许被遮蔽）；**目录 + entry points** 双源与**目录为准**（pip 包装同名时以用户安装的目录为准）；**永不触碰核心**的铁律与**加宽通用面**的出口。五套发现系统各管一类能力，共用的地基只有两个：`plugin_loader.py` 的按路径导入，和"钩子在所属 profile 作用域下触发、状态按 `hermes_home_key()` 键控"的多租户纪律。
