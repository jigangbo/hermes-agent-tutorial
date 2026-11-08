# 测试体系

> 原则一句话：**测试写的是行为契约，不是实现快照。** 本文讲 Hermes 怎么把这句话变成机器可执行的制度。完整规则在 `tests/AGENTS.md`。

## 运行测试：永远用 runner

**永远用 `scripts/run_tests.sh`，绝不裸跑 `pytest`。** runner 强制 CI 对等：凭据变量清空、`TZ=UTC`、`LANG=C.UTF-8`、`HERMES_HOME` 指向临时目录、每文件子进程隔离（`scripts/run_tests_parallel.py`，无 xdist，worker 按 CPU 扩展）—— 防止模块级 dict/ContextVars 跨文件泄漏。带 API key 在大机器上裸跑 pytest 曾反复造成"本地过 CI 挂"（反向亦然）。

```bash
scripts/run_tests.sh                                    # 全量
scripts/run_tests.sh tests/gateway/                     # 一个目录
scripts/run_tests.sh tests/agent/test_foo.py -k test_x  # 文件粒度；-k 收窄
scripts/run_tests.sh -v --tb=long                       # pytest 旗标透传
```

测试解释器用检出的 bootstrapped Python 现构建（非就地同步）：

```bash
python -m pm.build_env --source . --out .venv --group dev --group test
```

runner 会清掉 `PYTHONPATH`，所以仅激活 PM shell 不等于有 pytest；换输出目录时用 `HERMES_PYTHON` 指定解释器。

- **Flake 政策**：失败文件在新子进程重试一次（`--file-retries`；`HERMES_TEST_FILE_RETRIES=0` 关闭）；被信号杀掉或超时的文件**永不重试**（重跑失控进程是双倍破坏）。重试变绿会标 `⚠ FLAKY` 并打印两份输出 —— 这是待修的 bug，不是噪音。
- **睡眠棘轮（HX013）**：测试里新增 `time.sleep`/`asyncio.sleep` 直接失败 —— 用 `Event` 等待，或 `tests.waiting.wait_until` / `async_wait_until` 轮询。计时测试不得假设 runner 空闲：墙钟界 ≥2s、事件同步。

## 放置规则

- **镜像源码树**：`tests/<顶层源码目录>/`（`tests/hermes_cli/`、`tests/agent/`、`tests/hermes_state/`、`tests/gateway/relay/`……）；安装/更新脚本测试在 `tests/scripts/{install,desktop_update}/`；只有根级模块（`batch_runner`、`utils`、`hermes_constants`、打包）直接放 `tests/`。
- **文件名不带 issue 号**：写进模块 docstring（`test_89315_x.py` → `test_x.py` + "Regression for #89315"）。
- **CI 分道由改动文件决定**：`scripts/ci/classify_changes.py` 按变更文件挑任务。断言 `package.json`/`.ts` 的 **Python** 测试在 JS-only PR 上根本不会跑（PR 绿、main 红）—— 那属于 vitest 套件。

## 绝不伪造宿主 OS

真正按平台不同的行为，**就在那个平台上测**：

```python
@pytest.mark.platforms("linux")      # 一个标记 + 任意 spec 串（any-of）+ 可选 arch 过滤
def test_linux_detach(...): ...
```

绝不 patch `sys.platform`。判据：**如果测试需要解释器相信自己在另一个 OS 上才能过，它就该在那个 OS 上跑**。`IS_WINDOWS` 旗标 + 调 `windows_detach_flags()` 是伪造。跨平台连走的测试要拆开 —— 宿主原生分支在 Linux 上测，其余分支各自带标记。

`platforms` 标记的合法形态（conftest 在收集期拒绝一个测试堆多个 `platforms()`）：

| 写法 | 含义 |
|------|------|
| `platforms("linux")` | 仅原生 Linux |
| `platforms("linux", "macos")` | 一个标记、两个 spec：任一平台可跑 |
| `platforms("not macos")` | 除 macOS 外都跑 |
| `platforms("windows", arch="arm64")` | 原生 Windows 且 arm64 |
| `platforms("posix")` | Linux 或 macOS |

spec 取值：`linux`、`macos`、`windows`、`posix`、`any`、`not <spec>`；历史标记 `linux_only` 等已全部移除。**用标记，不用裸 `skipif`** —— `scripts/ci/list_os_marked_tests.py` 靠解析标记里的 spec 决定每条 OS lane import 哪些文件；`skipif(sys.platform != "win32")` 写法会在所有 lane 上都静默不跑。

**wine2e 实况车道**：mock 复现不了的真 Windows 进程拓扑声明（venv-holder 扫描、进程树父子、detach 语义），走按需 workflow `windows-venv-e2e.yml` 在真 `windows-latest` runner 上跑 `tests/hermes_cli/test_venv_holder_windows_live.py` —— 只在推 `wine2e/**` 分支时触发。工作法：先写探针钉住正确行为 → 推分支在未修代码上复现 → 修到车道绿 → 开 PR。断言对象是按 argv 找到的网关**祖先**而非直接父进程（venv shim 让每次 spawn 都是 launcher/worker 链）。

## 隔离两件套：不碰用户家目录、不出网

- **测试不写 `~/.hermes/`**；profile 测试还要 mock `Path.home()`（同时设 `HERMES_HOME` —— 代码读的是环境变量）：

```python
@pytest.fixture
def profile_env(tmp_path, monkeypatch):
    home = tmp_path / ".hermes"; home.mkdir()
    monkeypatch.setattr(Path, "home", lambda: tmp_path)
    monkeypatch.setenv("HERMES_HOME", str(home))
    return home
```

- **测试不出网**：`tests/conftest.py` 对整个 pytest 进程拒绝一切非本机地址解析。需要的假服务由 fixture 提供（127.0.0.1 服务器、stub 传输、种子缓存）。仅 `@pytest.mark.live`（密钥金丝雀）与 `@pytest.mark.allow_network`（PM 工具链/轮子下载）放行；测试派生的子进程在围栏外 —— 给它们一个种子 HOME。

## 新增测试前的四个问题

1. **它断言的是行为还是实现？** "切模型后消息里的 cache 断点被重打"是行为；"`_redecorate_prompt_cache_for_provider` 在 1290 行被调用"是实现快照（禁用形状）。
2. **它放哪个目录？** 镜像源码树：测 `gateway/relay/` 的就放 `tests/gateway/relay/`。根级模块（`batch_runner`、`utils`、`hermes_constants`、打包）才直接放 `tests/`。
3. **它需要哪个平台？** 宿主差异用 `@pytest.mark.platforms(...)`；平台无关的保持无标记。
4. **它碰网/碰家目录吗？** 都不碰 —— 需要 HTTP 就起 127.0.0.1 fixture，需要 HOME 就重定向 `HERMES_HOME`。

## CI 分道速览

| 分道 | 触发 | 内容 |
|------|------|------|
| Python 套件 | 改动 Python 文件 | `scripts/run_tests.sh`（run_tests_parallel 子进程隔离） |
| vitest 套件 | 改动 TS/JS/package.json | `apps/*`、`ui-tui` 的 JS 测试 —— 断言 TS 行为的测试放这里，不是 `tests/*.py` |
| wine2e | 仅推 `wine2e/**` 分支 | 真 Windows 进程拓扑 E2E（见上文） |
| 密钥金丝雀 | 定时/手动 | `@pytest.mark.live` —— 唯一合法出网的测试 |

分道归属由 `scripts/ci/classify_changes.py` 按改动文件决定 —— 这就是"Python 测试断言 .ts 文件永远不跑"事故的根源：分道器只在 Python 文件改动时跑 Python 套件。

## 行为契约 vs 禁用形状

- **行为契约**：断言"这个行为应该如此"。**禁用形状**（完整清单见 `tests/AGENTS.md`）：
  - source-reading test —— 读源码再断言源码长这样（change-detector）；
  - 对着常量抄一遍的"快照"断言 —— 改常量就得改测试，测试却没守住任何行为；
  - 用 patch `sys.platform` 伪装的跨平台测试；
  - 写死真实网络/真实 `~/.hermes` 的测试。
- 每个修复带 **1-2 个不变量测试**，且要证明在 base 分支上是红的（"proven red on the base"）—— 没有"红过"的测试可能恒绿，什么都守不住；在 base 上跑一遍并贴出失败输出，是 PR 描述里最有说服力的一行。

## 一分钟记住本篇

- 跑测试只有一条路：`scripts/run_tests.sh`；
- 测试是行为契约：禁 source-reading、禁伪 OS、禁出网、禁写 `~/.hermes/`；
- 平台差异用 `platforms` 标记在真平台上测，永不 patch `sys.platform`；
- 修复要带在 base 上红过的不变量测试。
