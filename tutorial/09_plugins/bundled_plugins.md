# 09.4 内置插件 19 组清单 —— plugins/ 目录逐组导览

`plugins/` 顶层除 3 个共享模块（`plugin_loader.py`、`plugin_storage.py`、`plugin_utils.py`）外，有 **19 组内置插件**。本篇逐组一行角色 + 各组的发现机制注记，可当字典用。行号引用均为 `plugins/<组>/__init__.py`。

## 文件概览

| 组 | 形态 | 一行角色 |
|----|------|---------|
| `platforms/` | 26 个适配器 | **最大组**（151 个 .py）：IRC、飞书、telegram、discord、slack、signal、matrix、whatsapp(_cloud)、wecom/weixin、qqbot、dingtalk、email、sms、ntfy、line、a2a 等——聊天平台进网关 |
| `model-providers/` | 提供方目录 | 声明式 ProviderProfile（anthropic、openai、alibaba、azure-foundry、ai-gateway、arcee…），懒发现 + last-writer-wins |
| `memory/` | 提供方目录 | MemoryProvider ABC（byterover、retaindb 留任至 2026-10-15 移除）+ query_rewrite/config_schema 辅助 |
| `context_engine/` | 单引擎目录 | ContextEngine ABC；`context.engine` 配置点名（默认核心 Compressor），bundled 赢 |
| `image_gen/` | 提供方目录 | 图像生成提供方（openai、fal、deepinfra、krea、meta-ai、openrouter…） |
| `video_gen/` | 提供方目录 | 视频生成提供方（deepinfra、fal、openrouter、xai） |
| `delegation/` | `default/` | 委派路由——`plugins/delegation/default` **就是**今天的委派路由本体 |
| `browser/` | 后端目录 | 浏览器后端（browser_use、browserbase、firecrawl） |
| `computer_use/` | `cua/` | 计算机使用驱动：内置 `cua` 也在里面，`computer_use.backend` 每次调用时读、无 fallback |
| `web/` | 提供方目录 | 网络搜索提供方（brave_free、ddgs、exa、firecrawl、keenable…）经 `ctx.register_web_search_provider()` |
| `cron_providers/` | `chronos/` | cron 调度器提供方；内置 InProcessCronScheduler 是核心、不可被摘除，`cron.provider` 选 |
| `config_backends/` | `remote/` | 配置后端（`HERMES_CONFIG_BACKEND`）——**不**经通用插件 loader 发现（先有鸡后有蛋，见下） |
| `dashboard_auth/` | 多方式目录 | 仪表盘鉴权（basic、nous、self_hosted、session_token、drain） |
| `kanban/` | dashboard+systemd | 看板 |
| `disk-cleanup/` | 单插件 | 会话临时文件自动清理（钩子驱动的先例插件） |
| `google_meet/` | 单插件 | agent 加入 Meet、抓字幕转写、跟进（headless Chromium + 可选 Realtime 语音） |
| `teams_pipeline/` | 单插件 | Teams 会议管线——只注册操作员侧 CLI 面（agent 经 terminal 工具调用），无模型工具 |
| `security-guidance/` | 单插件 | 文件写入的快速模式匹配安全提示（追加 guidance 块，文件照常写入） |
| `hermes-achievements/` | dashboard+docs | 成就系统（带 dashboard 面与测试） |

## 关键代码走读

### 1. config_backends：为什么它绕过通用 loader

```python
# plugins/config_backends/__init__.py:1-5 (docstring)
"""Config backends (``HERMES_CONFIG_BACKEND``). Selected by ``hermes_cli.config_backend``
directly from the environment, never discovered through the general plugin loader: that loader
reads config.yaml, and the backend is what serves config.yaml (D11). User plugins cannot supply a
config backend."""
```

这是全部 19 组里唯一"从环境直接选、不进发现"的组——加载器要读 config.yaml，而 config.yaml 恰恰由这个后端伺服。鸡生蛋问题让它必须是硬连线；也因此**用户插件不能提供配置后端**。

### 2. computer_use：一次一个、按名激活、无回退

```python
# plugins/computer_use/__init__.py:1-4 (docstring)
"""Computer-use provider discovery: bundled ``plugins/computer_use/<name>/`` (the built-in ``cua`` driver lives
here too) then user ``$HERMES_HOME/plugins/<name>/`` (bundled wins on collision). Exactly one provider is active:
``computer_use.backend`` in the active profile's config.yaml names its directory (default ``cua``), read per call.
Only that provider is imported; the others stay on disk, so a plugin that is installed but not selected is just an
option in ``hermes tools``. A configured name that resolves to nothing fails; there is no fallback driver."""
```

三个细节是所有"按名激活"组的通用模式：只 import 被选中的那个（其余留在磁盘上，装了没选只是 `hermes tools` 里的一个选项）；bundled 赢碰撞（同 memory 系的 bundled-first）；配置的名字解析不到就失败——**没有回退驱动**。

### 3. cron_providers：内置的不能被摘

```python
# plugins/cron_providers/__init__.py:1-4 (docstring)
"""Cron scheduler provider discovery: bundled ``plugins/cron_providers/<name>/`` then user
``$HERMES_HOME/plugins/<name>/`` (bundled wins on collision). The built-in InProcessCronScheduler
is core, not discovered here, so the fallback can't be removed; one provider is active
(``cron.provider`` in config.yaml, empty = built-in)."""
```

与 computer_use 对照着读：计算机使用把内置驱动也放进插件目录（`cua` 是默认名），cron 的内置调度器留在核心——目录发现系不存在"选中空目录时的兜底"，所以兜底必须住核心。

### 4. web：通用 ctx 方法注册的提供方

```python
# plugins/web/__init__.py:1-3 (注释)
# Bundled web search providers: plugins/web/<name>/{plugin.yaml, __init__.py, provider.py}
# (image_gen plugin layout). They auto-load via kind: backend and register via
# ctx.register_web_search_provider() into agent.web_search_registry.
```

`web` 组走的是通用插件路径（`kind: backend` 自动加载 + `ctx.register_web_search_provider()`），而不是专用目录发现——和 image_gen 同构。这说明 19 组里其实混着两种接入：专用 ABC 目录（memory/context_engine/computer_use/cron）与通用 ctx 注册（web/image_gen/model-providers 经 `register_provider`）。

### 5. memory：对新成员关闭

```python
# plugins/memory/__init__.py:1-9 (docstring 节选)
"""Memory provider plugin discovery: bundled ``plugins/memory/<name>/``, user
``$HERMES_HOME/plugins/<name>/``, project ``./.hermes/plugins/<name>/`` (opt-in via
HERMES_ENABLE_PROJECT_PLUGINS), then ``hermes_agent.memory_providers`` entry points.
Precedence is deliberately the REVERSE of PluginManager's later-source-wins:
bundled wins, then user, project, entry point — a provider is activated by name
(``memory.provider``, one at a time), so a directory dropped into the working tree
must never shadow a shipped provider. Changing this order is a breaking change."""
```

`memory.provider` 按**名**激活、一次一个——所以发现顺序必须是 bundled-first：用户往工作树里扔一个同名目录不许遮蔽出货的提供方。这与通用插件的 later-wins 恰好相反（index.md 的对照表）。目录内现在只剩 byterover、retaindb 两个老成员（2026-10-15 移除倒计时）加两个共享辅助文件；hindsight、honcho、supermemory、mem0、openviking、holographic 等已迁往 plugin-catalog（`hermes_cli/memory_provider_migration.py` 自动迁移）。

### 6. 三个钩子驱动的"先例"插件

```python
# plugins/security-guidance/__init__.py:1-5 (docstring 节选)
"""security-guidance plugin — fast pattern-matched security warnings on file writes.

Scans content written by ``write_file`` / ``patch`` / ``skill_manage`` for known dangerous patterns
and appends a ``⚠️ Security guidance`` block to the tool result; the file is still written ..."""

# plugins/disk-cleanup/__init__.py:1-5 (docstring 节选)
"""disk-cleanup plugin — auto-cleanup of ephemeral Hermes session files.

``pre_tool_call`` + ``post_tool_call`` silently track test/temp paths CREATED by write_file/patch/terminal;
``on_session_end`` runs :func:`disk_cleanup.quick` when any test file was tracked this turn; ..."""
```

这两个组加上 teams_pipeline（"只注册操作员侧 CLI 面、无模型工具"）演示了通用插件系统的三种典型形态：纯 hook 观察者（security-guidance）、hook + 生命周期副作用（disk-cleanup）、CLI-only 能力（teams_pipeline）。google_meet 则示范了"插件携带 SKILL.md + CLI + 桥接层"的复合形态。

### 7. platforms：最大组的两条纪律

26 个适配器全部遵循 `gateway/AGENTS.md` 的 token-lock 与 scoped-secret 规则（AGENTS.md："`irc`、`feishu` are canonical"）；平台 YAML 只许经 `PlatformConfig.extra`（`_shared.apply_yaml_bridge`）与 `platform_gate_env` 通道生效——**平台插件永不改 `os.environ`**。核心特例一律变成 `PlatformEntry` seam（`trusted_inbound`、`display_tier`、`shared_env_prefixes`），没有名字检查。

## 政策注记（AGENTS.md 三条红字）

1. **`plugins/memory/` 对新提供方关闭**（May 2026）。新后端作为独立仓库实现同一 `MemoryProvider` ABC、经 catalog 发现、`hermes memory setup` / `post_setup()` 集成。宿主侧残留代码（`honcho_host_block` 存储类、profile clone/rename 钩子）经 `plugins.memory.import_provider_module` 解析——**绝不** `plugins.memory.<name>` 直 import；通用 seam（`on_profile_created`、`STORAGE_PROVIDER` + `read_config_fields`/`write_config_fields`）一旦目录提供方实现即取代宿主代码，新的 provider 专属宿主代码会被拒。
2. **无新的第三方产品插件**（June 2026）。可观测后端、厂商 SaaS 连接器、分析面板、付费服务绑定都以独立插件仓库发布。理由：每吸收一个产品，就是我们在一个我们不拥有的快速演进的 backend 上背负维护。**`kanban/`、`disk-cleanup/` 是先例，不是邀请**（Langfuse 已移出到官方 catalog 条目）。关掉这类 PR 是耦合决定，不是质量评判。
3. **参考/文档伴随插件住在别的仓库**。`example-dashboard`、`strike-freedom-cockpit`、`plugin-llm-example`、`plugin-llm-async-example` 都在 `hermes-example-plugins`（github.com/NousResearch/hermes-example-plugins），不在本树。

## 核心类/函数（各组对接面）

| 名称 | 位置 | 职责 |
|------|------|------|
| `_discover_providers` | `providers/__init__.py:860` | model-providers 懒发现（entry points 最先=最低优先） |
| `register_provider` | `providers/__init__.py:140` | last-writer-wins 注册点 |
| MemoryProvider 发现 | `plugins/memory/__init__.py` | bundled-first 枚举，不 import 即列举 |
| ContextEngine 发现 | `plugins/context_engine/__init__.py` | `context.engine` 点名激活 |
| 计算机使用发现 | `plugins/computer_use/__init__.py` | 选中即 import、无回退 |
| cron 发现 | `plugins/cron_providers/__init__.py` | 内置调度器留核心做兜底 |
| config 后端选择 | `hermes_cli/config_backend.py` → `plugins/config_backends/` | 环境直选、用户插件不可供 |
| `ctx.register_web_search_provider` | ctx（09.1 篇） | web 组的注册通道 |
| 平台注册表 | `gateway/platform_registry.py` + `plugins/platforms/<name>/adapter.py` | 26 适配器接入 |

## 本组文件清单

| 文件 | 一句话 |
|------|--------|
| `plugins/plugin_loader.py` | 专用系共享的按路径加载器（见 09.1 篇） |
| `plugins/plugin_storage.py` / `plugin_utils.py` | 存储与工具函数 |
| `plugins/platforms/`（26 目录） | 平台适配器（核心树内最大插件面） |
| `plugins/model-providers/` | 声明式模型提供方 |
| `plugins/memory/`（关闭中） | byterover、retaindb 至 2026-10-15 |
| 其余 16 组 | 见开头清单表 |

## 与其他模块的关系

- `agent/` 五个 ABC：`memory_provider.py`、`context_engine.py`、`image_gen_provider.py`、`video_gen_provider.py`、`delegation_provider.py` 是专用插件的对接面；`providers/base.py` 是模型提供方的。
- `gateway/`：platforms 组的全部纪律与 token-lock 规则在那里；`dashboard_auth` 组服务 `hermes_cli/web_server.py` 的鉴权。
- `plugin-catalog/`：memory 组被关闭的成员已迁过去；离核特性（boundary_lint.md 的 LEFT_CORE）也落进 catalog。
- `hermes_example_plugins` 仓库：参考插件的家，与本树零代码共享。

## 总结

19 组插件按接入方式其实是三层的样本集：**通用 ctx 注册**（web、image_gen、teams_pipeline、security-guidance、disk-cleanup、kanban…）、**专用 ABC 目录**（memory、context_engine、computer_use、cron_providers、model-providers、delegation）、**硬连线**（config_backends——鸡生蛋问题的唯一豁免）。政策层面记住三个坐标：memory 关门、第三方产品不收、先例不是邀请。查任何一组前先问一句"它属于哪层"，发现机制与优先序就自动确定了。
