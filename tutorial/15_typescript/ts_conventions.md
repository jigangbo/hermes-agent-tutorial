# 15.6 TypeScript 工程约定 —— nanostores、路由根与生成物

## 概览

根 `AGENTS.md` 为 TS（desktop、TUI、website）定了一套短而硬的约定：

- feature 自有 nanostores 优于穿线状态；
- 薄路由根；
- 窄 hooks 与同址（colocated）action 模块；
- props 与共享形状用 `interface`；
- 表驱动派发优于条件阶梯；
- `src/app` 路由、`src/store` 原子、`src/lib` 纯函数。

这一篇把这些一行式展开成可操作的图景，并补上 TS 端最有特色的工程机制：**生成物 + 漂移测试**。

## 状态：feature 自有的 nanostores 阶梯

状态放在谁手里，答案是"最窄的家"——一条从组件到全局的阶梯：

```
组件内 useState / ref          ← 短命交互细节；热协调（不能重绘的）放 ref
    ▲ 最窄
请求形状的服务端数据             ← query 层：要失效重取的那种
    ▲
feature 自有 nanostores        ← store/ 原子 + 同址 action 模块；跨"远距"表面的才配升上来
    ▲
持久化状态                     ← key 里必须声明作用域：global / 连接 / profile / 会话 / 项目 / 窗口
```

三条推论（desktop `AGENTS.md` 的原文精神）：

- **新全局 store 是一个声明**："许多遥远表面都需要它"——这个主张要挣得来。
- **状态与权威同住**：
  - backend 权威的（别的表面也能改）在渲染器里只是缓存——合并不覆盖、乐观上屏可见回滚、陈旧异步结果永不赢（generation 计数 / request token）；
  - Electron 权威机器事实；
  - renderer 只拥有本窗口呈现。
- **跨接缝（版本、profile、本地/远程/云、旧后端）一律走每策略一条有序阶梯**：
  - 优先级是数据；
  - 候选先探测再信；
  - 读失败降级下一档，权威写失败必须上浮或回滚；
  - 缺能力不是暂时性故障；
  - 重试有界，终点是恢复手段。

`src/app` 路由、`src/store` 原子、`src/lib` 纯函数是物理归属，不是建议。

desktop 的 `src/store/` 436 个文件、`lib/` 499 个文件就是这么长出来的。

## 路由根：薄壳 + 注册表

路由根文件只做常量、类型与注册，不做行为。

desktop 的 `apps/desktop/src/app/routes.ts` 是范本——开头就是路由常量表：

```ts
// apps/desktop/src/app/routes.ts:9-24
export const SESSION_ROUTE_PREFIX = '/'
export const NEW_CHAT_ROUTE = '/'
export const SETTINGS_ROUTE = '/settings'
export const COMMAND_CENTER_ROUTE = '/command-center'
// … CRON / PROFILES / AGENTS / MESSAGING / WEBHOOKS / ARTIFACTS …
```

- 页面组件是薄根：装配 feature 的组件树、订阅 store，自己不留逻辑。
- 跨 feature 的发现走 `contrib/registry`（`src/contrib/`，29 文件）——贡献点注册表让新面板以数据形式挂进 shell，而不是改路由根的 if 链。
- web/ 的 19 个 pages 同理：每个 page 文件只是该表面的薄根。

## interface 与表驱动派发

- **形状一律 `interface`**：
  - 组件 props、跨模块共享的数据形状；
  - `apps/shared` 里的 wire 类型是编译器守卫的极端形态。
- **表驱动派发优于条件阶梯**：名字的阶梯长成字典→handler。
  - desktop slash 的 `DESKTOP_COMMAND_SPECS`（`desktop-slash-commands.ts:202`）是"命令→桌面表面"的表；
  - `TS_ONLY_NO_DESKTOP_SURFACE`（`desktop-slash-commands.ts:412`）是"原因→命令列表"的表；
  - 判定函数（`:738`/`:771`/`:789`）读表而不是 if-else 阶梯；
  - Python 侧同款规则（新 RPC 是 `methods_<topic>.py` 表项，不是 `if method == ...` 链），两侧同构。

## 生成物与漂移测试

TS 端不靠人肉同步跨语言事实，靠**生成物 + 陈旧即 CI 失败**：

| 生成物 | 生成器 | 漂移守卫 | 内容 |
|--------|--------|---------|------|
| `apps/shared/src/gateway-contract.generated.ts` + `gateway-contract.openrpc.json` | `scripts/gen_gateway_contracts.py` | `tests/tui_gateway/contracts/test_generated.py` | RPC 方法/请求/事件的全量类型；改 Pydantic 模型 → 重新生成 → `tsc` 向每个消费者展示字段挪动 |
| `apps/desktop/src/lib/desktop-slash-registry.json` | `scripts/dump_desktop_slash_registry.py` | `tests/hermes_cli/test_desktop_slash_registry.py` + vitest 同名文件 | Python 命令注册表的离线回退快照 |
| `apps/shared/src/catalog-curation.json` | 人工维护的策展数据 | vitest（`catalog-featured.test.ts` 等） | 插件目录策展 |

配套的测试铁律（根测试规则）：

- **Python 测试不得断言 `package.json` / `.ts` 源码**——JS 侧断言放 vitest，否则 JS-only 的 PR 会跑不到断言；
- 测试写**行为契约**（不变式、边界、回滚次序），不写今日快照、不做 change-detector；
- desktop 的测试清单全是接缝行为：resolver 优先级失败档、身份与作用域边界、乐观回滚与陈旧响应次序、本地/远程适配器两侧且 profile 路由完好。

## 体验与安全的行为约定

约定不止于代码形状，还有两条"手感"红线：

- **尊重注意力**：
  - 后台事件永不抢焦点、不导航、不打开表面——只提供，不劫持；
  - loading 周边的每个状态（空、加载、重连、降级/陈旧、耗尽恢复）各有诚实文案与出口；
  - 焦点在哪，键盘归哪，一次取消只做一件事；
  - 昂贵且有态的面（终端、活工具）隐藏时保持存活——可见性不是生命周期。
- **访客内容不自开门**（desktop）：iframe/webview 永不自行驱动 OS 浏览器，一切经 trusted-click 桥 + scheme 白名单（见 `desktop_overview.md`）。

## 工具链速查

| 仓库 | 命令 |
|------|------|
| `ui-tui` | `pnpm run dev` / `build`（hermes-ink + tsc）/ `typecheck` / `lint` / `fmt` / `test`（vitest） |
| `apps/desktop` | `pnpm exec vitest run src/lib/desktop-slash-commands.test.ts`（workspace 依赖装在仓库根）；e2e 用 Playwright |
| 各仓库自有 | `eslint.config.mjs`、`tsconfig*.json`、`vitest.config.ts` |

Python 侧的 CC/行数棘轮是另一套体系（`scripts/code_health/`），不要与 TS 工具链混为一谈。

## 与其他模块的关系

- **`tui_gateway/contracts/`**：所有生成物的上游；"漂移测试"本质上是 Python 契约纪律在 TS 的投影。
- **三个 UI 仓库**：desktop/TUI/web 的目录骨架（app/store/lib、app/domain/lib、pages/lib）是同一套约定的三次落地，读一个会三个。
- **`tests/`（tests/AGENTS.md）**：JS 断言放 vitest 的规则与 Python 测试禁读 TS 源码的规则互为镜像。
- **`scripts/check`**：提交前的阻塞检查入口（Python 侧）；TS 侧各仓库自跑 tsc/eslint/vitest。

## 总结

TS 工程约定可以折叠成一个决策序列：

1. 状态放最窄的家（组件 → query → feature store → 持久化，作用域写进 key）；
2. 形状用 interface、跨语言事实用生成物；
3. 派发用表不用阶梯；
4. 行为契约进 vitest。

而贯穿四个表面的是同一个元规则：

**一切跨边界的一致性都由机器保证**——编译器（生成契约）、CI（漂移测试）、注册表（贡献点）——而不是靠人记得同步。
