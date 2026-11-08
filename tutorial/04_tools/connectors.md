# 服务连接器组 —— manage_connections 与工具网关

## 文件概览

`connectors/` 是 tools/ 里唯一的「包式」工具组：发现机制只扫描 `tools/<pkg>/tool.py` 一个入口，包内其余 33 个文件全是库。它提供 `manage_connections` 工具——模型把用户连接到外部应用的统一入口，分两类目标：**托管连接器账户**（Gmail、Notion 等，经 Nous 托管网关调用，凭据永不下发）与**本地 MCP 服务器**（从捆绑目录安装、OAuth 授权）。18 个根文件按「目录/契约/账户/操作/派发/展示」切分，`gateway/` 子包 8 个文件是与托管网关的 HTTP 客户端层，`portal/` 子包 5 个文件管门户策略与授权卡。一个刻意的设计：**这个工具不能断开、删除或撤销账户**——那是留给用户在门户里做的决定。

## 关键代码走读

### 1. tool.py：一个入口，两类后端

`manage_connections` 的 handler 极薄：解析目标（裸 slug 或 `{"name": "gmail"}` 是托管账户；`{"name": "linear", "mcp": true}` 是本地 MCP 服务器），校验动作，然后按目标类型分派到两条路径：

```python
# 来源：tools/connectors/tool.py:17-48（节选）
def manage_connections(
    args: dict[str, Any],
    *,
    client_factory: Optional[Callable[[], Any]] = None,
    mcp_backend: Optional[Any] = None,
    session_id: Optional[str] = None,
    tool_call_id: Optional[str] = None,
    turn_id: Optional[str] = None,
    connection_callback: Optional[Callable[[dict[str, Any]], Optional[str]]] = None,
    connectors_available: Optional[Callable[[], bool]] = None,
    card_surface: bool = False,
) -> str:
    action = str(args.get("action") or "status").strip().lower()
    managed, mcp_targets, target_error = normalize_targets(args.get("connectors"))
    if target_error:
        return tool_error(target_error)
    action_error = validate_action(action, managed, mcp_targets)
    if action_error:
        return tool_error(action_error)

    if action in MCP_ACTIONS:
        return run_mcp_operation(
            mcp_targets, action, backend=mcp_backend,
            connection_callback=connection_callback, session_id=session_id, tool_call_id=tool_call_id,
        )

    return run_managed_action(
        action, managed, args,
        client_factory=client_factory, session_id=session_id, tool_call_id=tool_call_id, turn_id=turn_id,
        connection_callback=connection_callback, connectors_available=connectors_available,
        card_surface=card_surface,
    )
```

很多名字两边都存在（Linear 既是托管连接器也有 MCP 服务器），所以 schema 的长描述把裁决权交给**用户自己的话**：用户说「MCP 服务器」「本地安装」才加 `mcp: true`；描述里还写死了红线——"This tool can NOT disconnect, delete, or revoke an account — that is deliberately user-only"。

### 2. 注册：门户门控决定 schema 存在

注册处的注释解释了一个「门内门外一致」的设计：门户没给这个账户开连接器功能，用户就**根本看不到**这个工具（schema 都不出现），模型自然无从调用、也不会把网关的 404 转述给用户；handler 再跑同一道门，保证 RPC 路径与缓存 schema 一致：

```python
# 来源：tools/connectors/tool.py:153-170
registry.register(
    name="manage_connections",
    toolset="connections",
    schema=MANAGE_CONNECTIONS_SCHEMA,
    # The portal gate decides schema presence: an account the portal has not enabled for
    # connectors never sees the tool, so the model cannot call it and read the gateway's
    # 404 back to them. The handler runs the same gate so the RPC path (methods_connectors) and
    # a cached schema agree. Read as a module attribute so tests patch
    # ``gateway.config.connectors_available`` at one seam.
    handler=lambda args, **kw: manage_connections(
        args, session_id=kw.get("session_id"), tool_call_id=kw.get("tool_call_id"),
        connectors_available=gateway_config.connectors_available,
    ),
    check_fn=lambda: gateway_config.connectors_available(),
    emoji="🔗",
)
```

`check_fn` 与 handler 读**同一个模块属性**，测试只需在 `gateway.config.connectors_available` 一个接缝上打补丁。旁边还有一个 `manage_catalog`（toolset `catalog`）——客户端 surface 的目录浏览工具，没有卡片回调时答复 CLI 指引。

### 3. catalog.py 与 catalog_tool.py：目录的两副面孔

`catalog.py` 是连接器目录的数据层：每个目录条目描述一个可连接的应用（slug、显示名、动作集、需要的授权形态）。`catalog_tool.py` 把它包装成 `manage_catalog` 的 schema 与实现（`MANAGE_CATALOG_SCHEMA`），给桌面/CLI 一个浏览目录的 surface。目录条目与托管网关的动作表在 `contract.py` 定型——**每个连接器声明它能做什么**，派发层据此校验调用合法性。

### 4. gateway/ 子包：托管调用的客户端层

托管连接器的实际工具调用（读邮件、建工单）发生在 Nous 托管网关侧；本地只留一个薄客户端。`gateway/` 八个文件的分工：`client.py` 是 HTTP 客户端，`config.py` 是可用性与配置（含被 check_fn 引用的 `connectors_available`），`names.py` 定义 `connectors__<connector>__<tool>` 的工具命名与解析（`parse_connector_name`——`model_tools.handle_function_call` 在派发前就靠它识别连接器名字），`bridge.py` 把网关工具桥接进 registry，`wire.py` 定义线上格式，`merge.py` 合并多连接器的目录，`files.py` 处理文件上传类调用，`errors.py` 把网关错误分类（`CONNECTION_REQUIRED` 就是从这里来的——模型看到它应该调 `connect`）。

### 5. portal/ 子包：授权卡与策略

`portal/` 五个文件管「用户在场」的体验：`policy.py` 是门户策略（哪些账户/动作被允许），`client.py` 是门户 API 客户端，`tools_cache.py` 缓存门户下发的工具清单，`wire.py` 线上格式，`errors.py` 错误分类。桌面、终端 UI、交互 CLI 上，`connect` 会展示一张卡片并**阻塞**直到每个应用连上/跳过/超时（结果列 connected/skipped/not_connected，绝不夹带链接）；没有卡片的表面（一次性运行、定时任务、消息平台）则返回每应用的 `connect_url` 给**用户**在浏览器打开——描述里专门叮嘱模型"never open it yourself"。

### 6. dispatch.py / run.py / operation.py：调用的一生

一个托管工具调用从模型发出 `connectors__gmail__search` 开始：`model_tools` 识别连接器名 → `gateway/names.parse_connector_name` 拆出连接器与工具 → `dispatch.py` 找到目标账户（`account.py` 管多账户别名，如 `work`）与凭据位置 → `run.py` 执行 HTTP 往返 → `operation.py`/`contract.py` 校验动作契约 → `display.py` 把结果渲染成模型文本，`data_use.py` 记录数据用途，`live.py` 支持活动连接状态查询，`turn.py` 处理回合侧的上下文（比如 `managed_tool_gateway.py` 与 `managed_gateway_auth.py`/`managed_gateway_identity.py` 在 tools/ 根目录为托管网关提供 bearer 信任与调用者身份）。

## 核心类/函数

| 符号 | 职责 | 位置 |
|---|---|---|
| `manage_connections` | 唯一的用户连接入口：解析目标、校验动作、两条后端分派 | `tools/connectors/tool.py:17` |
| `MANAGE_CONNECTIONS_SCHEMA` | 长描述 schema：托管/MCP 的裁决规则与红线 | `tools/connectors/tool.py:51` |
| `run_managed_action` | 托管动作执行（status/connect/reconnect/rename/display） | `tools/connectors/managed.py` |
| `run_mcp_operation` | MCP 动作执行（install/enable/authorize，弹审批卡） | `tools/connectors/mcp.py` |
| `normalize_targets` / `validate_action` | 目标与动作的输入校验 | `tools/connectors/targets.py` |
| `parse_connector_name`（gateway.names） | `connectors__<connector>__<tool>` 命名解析 | `tools/connectors/gateway/names.py` |
| `connectors_available`（gateway.config） | 门户门控探针：schema 存在与 handler 共用同一真相 | `tools/connectors/gateway/config.py` |
| `manage_catalog` | 目录浏览工具（`catalog` toolset） | `tools/connectors/catalog_tool.py` |
| `ConnectorAccount`（account） | 多账户模型：主账户 + 别名账户 | `tools/connectors/account.py` |
| `dispatch_connector_batch` | tool search 桥接的连接器批量调用 | `tools/connectors/dispatch.py` |

## 本组文件清单

connectors/ 包共 34 个文件（含 3 个 `__init__.py`）：

| 文件 | 一句话角色 |
|---|---|
| `tools/connectors/__init__.py` | 包标识与公开名字（`is_connector_name` 等从这里导出）。 |
| `tools/connectors/tool.py` | 入口：manage_connections 的实现与注册（发现只扫这一个）。 |
| `tools/connectors/catalog.py` | 连接器目录的数据层。 |
| `tools/connectors/catalog_tool.py` | `manage_catalog` 工具的 schema 与实现。 |
| `tools/connectors/contract.py` | 连接器动作契约（每个连接器声明能做什么）。 |
| `tools/connectors/account.py` | 账户模型：多账户、别名（如 work）、连接状态。 |
| `tools/connectors/operation.py` | 动作语义层（动作→网关操作的具体化）。 |
| `tools/connectors/dispatch.py` | 调用派发与连接器批量哨兵。 |
| `tools/connectors/data_use.py` | 数据用途记录。 |
| `tools/connectors/display.py` | 结果的模型可读渲染。 |
| `tools/connectors/live.py` | 活动连接状态查询。 |
| `tools/connectors/managed.py` | 托管动作（status/connect/reconnect/rename/display）执行。 |
| `tools/connectors/mcp.py` | MCP 动作（install/enable/authorize）执行。 |
| `tools/connectors/mcp_launch.py` | 目录 MCP 服务器的启动衔接。 |
| `tools/connectors/mcp_oauth.py` | 目录服务器的 OAuth 授权衔接。 |
| `tools/connectors/run.py` | 托管调用的 HTTP 往返执行。 |
| `tools/connectors/search.py` | 目录/连接器的搜索助手。 |
| `tools/connectors/targets.py` | 目标解析与动作校验（ALIAS_PATTERN、动作集合）。 |
| `tools/connectors/turn.py` | 回合侧上下文（工具调用与连接状态的关系）。 |
| `tools/connectors/gateway/__init__.py` | 网关子包标识。 |
| `tools/connectors/gateway/bridge.py` | 把网关工具桥接进 registry。 |
| `tools/connectors/gateway/client.py` | 托管网关的 HTTP 客户端。 |
| `tools/connectors/gateway/config.py` | 网关可用性与配置（`connectors_available` 的家）。 |
| `tools/connectors/gateway/errors.py` | 网关错误分类（CONNECTION_REQUIRED 等）。 |
| `tools/connectors/gateway/files.py` | 文件上传类调用的处理。 |
| `tools/connectors/gateway/merge.py` | 多连接器目录合并。 |
| `tools/connectors/gateway/names.py` | `connectors__x__y` 工具命名与解析。 |
| `tools/connectors/gateway/wire.py` | 网关线上格式。 |
| `tools/connectors/portal/__init__.py` | 门户子包标识。 |
| `tools/connectors/portal/client.py` | 门户 API 客户端。 |
| `tools/connectors/portal/errors.py` | 门户错误分类。 |
| `tools/connectors/portal/policy.py` | 门户策略：哪些账户/动作被允许。 |
| `tools/connectors/portal/tools_cache.py` | 门户下发工具清单的缓存。 |
| `tools/connectors/portal/wire.py` | 门户线上格式。 |

## 与其他模块的关系

- `tools/registry.py`：`manage_connections` 在 `_HERMES_CORE_TOOLS` 里（toolset `connections`）；`manage_catalog` 属客户端 surface 的 `catalog` toolset（`CLIENT_SURFACE_TOOLSETS`）。
- `model_tools.py`：`handle_function_call` 对连接器名做前置校验（没启用就拒绝；名字畸形有专门报错），tool search 桥的批量调用也在这里分派。
- `tools/mcp_tool.py`：MCP 动作最终落到 MCP 客户端的安装/授权路径；目录安装的服务器进了 `mcp_servers` 配置。
- `tools/managed_gateway_auth.py` / `managed_gateway_identity.py` / `managed_tool_gateway.py`：tools/ 根目录下为所有 Nous 托管 passthrough 提供信任与身份的公共件（本组清单外的近亲）。
- 桌面/GUI：授权卡的呈现面（desktop / 终端 UI / 交互 CLI）由 `card_surface` 参数区分。

## 总结

connectors/ 用一个包、一个入口、一条命名规则（`connectors__<连接器>__<工具>`）把「连接 SaaS」收敛成一个模型工具。它最值得学的三个决策：**门控即 schema**——门户没开户的工具根本不出现在模型眼前，而不是让模型撞 404；**两条后端一类裁决**——托管与 MCP 的歧义交给用户原话，schema 描述就是裁决书；**能力边界写进描述**——不能断开、不能删除、链接只能给用户开，红线直接写在模型每天读的文本里。包式注册的约束（只有 `tool.py` 被扫描）反过来成全了内部自由：30 多个文件可以随便重组，只要入口稳定。
