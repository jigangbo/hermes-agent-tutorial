# utilities —— utils.py、hermes_time.py、hermes_yaml.py

> 阅读前提：无。三个小而密的底座文件；每一个函数都是某次生产事故的结晶。

## 文件概览

| 文件 | 行数 | 定位 |
|---|---|---|
| utils.py | 869 | 共享工具函数：原子写、文件签名缓存键、URL 主机判定、代理环境归一 |
| hermes_time.py | 150 | 时区感知时钟：`now()` 按用户配置的 IANA 时区返回 |
| hermes_yaml.py | 98 | 全仓库统一的 YAML 1.1 策略（ruamel 封装） |

`utils.py` 被 `run_agent.py` 直接 import（`base_url_host_matches`、`env_float` 等），是事实上的"第三常量层"——但它允许少量 lazy import（`agent.retry_utils`、`hermes_cli.config`）。

## 关键代码走读（utils.py）

### 1. 原子写三件套

```python
# utils.py:379-419（节选）
def _atomic_write(path, write, *, prefix, encoding="utf-8", mode=None, preserve_owner=True,
                  binary=False, fsync_dir=False) -> None:
    """Temp file + fsync + :func:`atomic_replace`, then re-apply owner/mode.
    ...
    The temp file is removed on any failure — ``BaseException`` on purpose, so
    KeyboardInterrupt / SystemExit still clean up.
    """
    from hermes_constants import mkdir_under_hermes_home
    mkdir_under_hermes_home(path.parent)
    if mode is None and not path.exists():
        mode = default_new_file_mode()
    original_owner = _preserve_file_owner(path) if preserve_owner else None
    fd, tmp_path = mkstemp_beside(path, prefix=prefix, suffix=".tmp")
    try:
        with os.fdopen(fd, "wb" if binary else "w", encoding=None if binary else encoding) as f:
            if mode is not None and hasattr(os, "fchmod"):
                os.fchmod(f.fileno(), mode)
            write(f)
            f.flush()
            os.fsync(f.fileno())
        replaced = Path(atomic_replace(tmp_path, path))  # symlink-preserving actual destination
        _restore_file_metadata(replaced, original_owner, mode)
        if fsync_dir:
            fsync_directory(replaced.parent)
    except BaseException:
        with suppress(OSError):
            os.unlink(tmp_path)
        raise
```

公共入口 `atomic_write_text`（行 428）/ `atomic_write_bytes`（行 444）/ `atomic_json_write`（行 469）/ `atomic_yaml_write`（行 518）共享这条路径。几个讲究：

- **mkstemp 0600 起步**：密钥文件永不在 umask 可读窗口暴露；但**新**的非密钥文件按 `default_new_file_mode()`（`0o666 & ~umask`）恢复——否则所有新建缓存/状态文件被静默收紧到 0600，破坏共享卷挂载。
- **`atomic_replace`（行 238）**：先解析 symlink（原地写真实文件、链接存活）；`os.replace` 失败时按错误分流——EXDEV/EBUSY 立即 copy/fsync/unlink；Windows 句柄争用（winerror 5/32/33）抖动重试 4 次，仍失败走 `_rewrite_in_place` 最后手段（不原子但窗口更小，且保留目标 ACL）。
- **surrogate 安全**：`_dump_json`（行 452）对非 UTF-8 argv/路径产生的孤立代理字符回退 `ensure_ascii=True`，JSON round-trip 后原样还原。
- **round-trip YAML**：`atomic_roundtrip_yaml_save`（行 618）是 config.yaml 的**唯一落盘原语**——ruamel rt 模式加载、逐节点合并（未变的节点连注释带引号原样保留）、YAML 1.1 歧义词（`off/yes/no`…）在任何深度强制双引号，否则 `approvals.mode: off` 会被读回 `False`。

### 2. 文件签名缓存键

```python
# utils.py:42-57
def file_signature(st: os.stat_result) -> tuple[int, int, int, int]:
    """Change-detection key for a stat result: ``(st_mtime_ns, st_size, st_ino, st_ctime_ns)``.

    mtime + size alone miss a replacement that preserves both (``cp -p``, ``rsync -t``, ...).
    """
    return (st.st_mtime_ns, st.st_size, st.st_ino, st.st_ctime_ns)

# 文件系统时间戳粒度粗（~4ms），同 tick 写入会让签名"racily clean"：
RACY_MTIME_WINDOW_NS = 2_000_000_000
```

`file_cache_version`（行 104）= 签名 + racy 内容摘要（文件太新时直接哈希字节，等它"沉淀"），`load_yaml_file_readonly`（行 696）用它缓存解析结果。这是全仓库"改了配置就生效"类缓存键的统一来源。

### 3. URL 主机判定（安全边界）

```python
# utils.py:861-869
def base_url_host_matches(base_url: str, domain: str) -> bool:
    """True when the base URL's hostname is ``domain`` or a subdomain.

    Safer than ``domain in base_url`` (``evil.com/moonshot.ai`` / ``moonshot.ai.evil`` must not
    match). Accepts bare hosts, full URLs, and URLs with paths.
    """
    hostname = base_url_hostname(base_url)
    domain = (domain or "").strip().lower().rstrip(".")
    return bool(hostname and domain) and (hostname == domain or hostname.endswith("." + domain))
```

`base_url_hostname`（行 818）容忍裸 `host[:port]`（无 scheme 也 parse）；`base_url_origin`（行 841）返回 `(scheme, host, port)`——把 bearer 密钥交给新 URL 前必须三比较，只比 host 会放行 HTTPS→HTTP 降级。`model_forces_max_completion_tokens`（行 835）识别拒绝 `max_tokens` 的 OpenAI 家族。

### 4. 其余高频函数

`env_int` / `env_float`（行 723/728）容错读取环境变量；`normalize_proxy_env_vars`（行 793）把 `socks://` 归一成 httpx 要的 `socks5://`、把 httpx 0.28.1 编译不了的 IPv6 NO_PROXY 条目改写成裸字面量；`rmtree_readonly`（行 344）能删只读树（Windows git 对象、Nix store 拷贝）；`read_json_or_empty`（行 486，`utf-8-sig` 防 Windows 编辑器 BOM）与 `safe_json_loads`（行 679）是"读半边降级"样板；`unlink_files_older_than`（行 325）是唯一的按龄清扫。

## 关键代码走读（hermes_time.py）

```python
# hermes_time.py:147-150
def now() -> datetime:
    """Current time as a tz-aware datetime: configured zone, else server-local."""
    tz = get_timezone()
    return datetime.now(tz) if tz is not None else datetime.now().astimezone()
```

时区解析顺序：`HERMES_TIMEZONE` env（但**多路复用网关下忽略**——env 只携带 default profile 的值，路由 profile 必须读自己的 config.yaml，`_env_timezone` 行 67）→ config.yaml `timezone` → 服务器本地。缓存按"来源身份"键控（`(来源, 名字/配置路径)`）——一个进程多路复用 profile 时，无键全局缓存会把第一个 profile 的时区泄漏给后续（桌面多路复用 cron ticker 把别人的 `next_run_at` 写进自己库的案例）。另外两个小件：`safe_strftime`（行 52）修复 Windows ANSI 码页时区名经 surrogateescape 解码后的 `strftime` 崩溃（#102910，且对有效文本字节级等同 strftime 以保系统提示词缓存稳定）；`_repair_surrogates`（行 35）把坏解码文本救回或替换 U+FFFD。

## 关键代码走读（hermes_yaml.py）

```python
# hermes_yaml.py:1-5,28-38
"""Shared YAML 1.1 policy for config, manifests, and frontmatter.

Ruamel's native schema includes bare y/n booleans and rejects duplicate keys.
Every operation owns its parser/emitter; instances must not be shared by threads.
"""

def safe_load(stream):
    """Read standard YAML data; existing configs use YAML 1.1 booleans.

    The pure parser defines what parses: Windows ARM64 has no C extension, and libyaml rejects
    documents the pure parser accepts (``[{url: http://h}]``), so a C rejection is re-read pure.
    """
    document = stream if isinstance(stream, (str, bytes)) else stream.read()
    try:
        return _load(document, pure=False)
    except YAMLError:
        return _load(document, pure=True)
```

三条策略：**版本钉 1.1**（`_Yaml11Resolver` 把 `processing_version` 钉回 (1,1)，`off`/`yes` 是布尔——与历史 config 一致，加载侧无需引号）；**C 失败回退纯解析器**（Windows ARM64 无 C 扩展、libyaml 比纯解析器更严，"纯解析器定义什么能 parse"）；**实例不跨线程共享**（每个操作自建 parser/emitter）。写侧 `safe_dump`（行 55）纯 Python emitter（C emitter 丢缩进偏移、转义星外 Unicode）、缩进 `mapping=2, sequence=4, offset=2`；`roundtrip_yaml`（行 89）供注释保留编辑，宽度取 `ROUNDTRIP_YAML_WIDTH = 2**31-1`——ruamel 在转义反斜杠后折行会改变双引号值本身（#119844：一次 no-op 保存把 `D:\Cent...` 折成 `D:\` + 换行，重载成字面空格），超大宽度 = 禁折叠。

## 核心类/函数

| 名称 | 位置 | 职责 |
|---|---|---|
| `atomic_write_text/bytes/json/yaml` | utils.py:428/444/469/518 | temp + fsync + 原子替换 + 元数据恢复 |
| `atomic_replace` | utils.py:238 | symlink 保留的替换；EXDEV/争用分流 |
| `atomic_roundtrip_yaml_save` | utils.py:618 | config.yaml 唯一落盘原语（注释/引号/顺序保留） |
| `atomic_roundtrip_yaml_update` | utils.py:550 | 单点改键（点分路径、贪心字面匹配防 `glm-5: {'3':…}` 幻影） |
| `file_signature` / `file_cache_version` | utils.py:42/104 | 缓存键（mtime+size+ino+ctime + racy 摘要） |
| `base_url_hostname` / `base_url_host_matches` / `base_url_origin` | utils.py:818/861/841 | URL 主机/源判定（防子串误配） |
| `env_int` / `env_float` | utils.py:723/728 | 容错环境变量读取 |
| `normalize_proxy_env_vars` | utils.py:793 | 代理/NO_PROXY 归一 |
| `rmtree_readonly` | utils.py:344 | 可删只读树的 rmtree |
| `load_yaml_file_readonly` | utils.py:696 | 签名缓存的 YAML 解析 |
| `now` / `get_timezone` | hermes_time.py:147/130 | 时区感知时钟与解析 |
| `safe_strftime` | hermes_time.py:52 | locale 时区名安全格式化 |
| `safe_load` / `safe_dump` / `roundtrip_yaml` | hermes_yaml.py:28/55/89 | YAML 1.1 统一策略 |

## 本组文件清单

| 文件 | 行数 | 角色 |
|---|---|---|
| utils.py | 869 | 原子写/缓存键/URL 判定/代理/清扫 |
| hermes_time.py | 150 | 时区感知时钟（按 profile 缓存） |
| hermes_yaml.py | 98 | YAML 1.1 统一策略（ruamel） |

## 与其他模块的关系

- **hermes_constants.py**：`_atomic_write` 建目录走 `mkdir_under_hermes_home`；`hermes_time` 取 `get_config_path`。
- **hermes_cli/config.py**：写 config 最终都落到 `atomic_roundtrip_yaml_save`；`_split_key_path` 被 update 函数借用。
- **run_agent.py / agent/**：`env_float`（API 超时）、`base_url_host_matches`（provider 判定）、`model_forces_max_completion_tokens`（参数形状）直接消费。
- **tools/**：终端/进程管理的超时与代理环境也经 `env_*` 与 `normalize_proxy_env_vars`。

## 总结

- 三个文件合成一条底座定律：**"落盘必原子、键必签名、YAML 必 1.1、时钟必带区"**。
- 每个看似繁琐的分支都有事故编号：折行改变 YAML 值（#119844）、BOM 清空配置、同 tick 缓存键、Windows locale 时区崩溃——读源码时把注释里的 issue 号当作设计依据。
- 它们是"工具函数不该有立场"的反例：这里每个函数都替调用者做出了正确的立场（保 symlink、保注释、保 umask、保 profile 隔离）。
