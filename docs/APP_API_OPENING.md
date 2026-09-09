# App 开放 API 架构与边界

> 面向应用构建者的逐接口参考请先阅读 [`API_REFERENCE.md`](./API_REFERENCE.md)。
> 本文主要说明两个 Go 项目的边界、认证模型和实施约束。

本文是当前实现的 API 合同，定义纯前端 App 如何调用平台能力。目标是让 App
不拥有开发者后端、不接触用户 API Key，同时获得统一的文本、图片、视频和音乐
接口，并由平台统一完成权限、调度、计费和审计。本文中的接口已经实现；它不是
待开发接口清单。

## 1. 当前接口分布

本地 SDK/CLI 已增加 `/api/app-runtime/v1` 的 AppSession HTTP 资源接口，模型仍走 `/v1`。
下文 Bridge 描述保留用于旧 iframe 应用；新 HTTP 端点和部署顺序见 [API_REFERENCE.md](API_REFERENCE.md)。
新接口不经过 Portal JWT 中间件，也不会在服务端把 HTTP 请求重新包装为 Bridge RPC。

| 项目 | 当前职责 | 对 App 的结论 |
| --- | --- | --- |
| `admin-api-go` | Portal 登录、应用市场、安装/购买、应用版本上传、Bridge、余额和控制面 | 负责 App 身份、授权、版本和商业规则，不承载高并发模型流 |
| `llm-gateway-go` | 统一 `/v1/*` 数据面，并验证用户 App Session | 负责模型/媒体请求执行；用户和订阅规则决定请求额度与并发，不复制协议实现 |
| `portal` | 市场、我的应用、应用管理工作台、AppHost | 只负责 UI 和 iframe 宿主，不把 Portal Cookie 注入 App |
| `app` | SDK、CLI、示例和 manifest | 调用 App HTTP Runtime、旧 Bridge 或 `/v1` 数据面，不实现自有后端 |

现有 `admin-api-go` 的 `/api/portal/user/apps/:id/bridge` 适合用户资料、存储、
通知、主题和语言等小型控制操作；应用调用 `llm-gateway-go` 的
`/v1/responses`、`/v1/chat/completions`、
`/v1/embeddings`、图片生成/编辑/任务查询、视频任务和音乐任务数据面；个人 API
使用同一组 `/v1/*` 路径。App Session 绑定当前用户、应用、版本和 Scope；请求配额、
并发和费用归用户，应用只负责能力声明、资源隔离和商业归属。

### App 运行时允许调用的接口

App 运行时的唯一入口是 SDK；v2 页面使用 HTTP Runtime，v1 iframe 保留 Bridge：

- HTTP Runtime：`app.user`、`app.storage`、`app.theme`、`app.locale` 和
  `app.platform.capabilities()` 映射到 `/api/app-runtime/v1/*`；通知在 v2 由应用 UI 渲染。
- Bridge（旧包）：`app.user`、`app.storage`、`app.notification`、`app.theme`、`app.locale`、
  `app.platform.capabilities()` 和 `app.platform.createSession()`。
- 数据面：SDK 白名单中的统一 `/v1` 路由，完整列表和相对 SDK 路径见
  [`API_REFERENCE.md`](./API_REFERENCE.md) 第 3 节。

SDK 使用相对路径，例如 `/responses`；网络请求由 Session 的 `gateway_url` 拼接为
`/v1/responses`。App 不应直接拼接地址或构造 Bridge `postMessage`。

### App 运行时禁止调用的接口

`/admin/*`、`/internal/*`、`/api/portal/*`、`/api/market/*`、
`/api/media-agent/v1/*`、`/v1/usage`、`/v1/usage/status`、个人 API 历史别名以及
未列入 SDK 白名单的 `/v1` 路由，均不属于 App API。供应商、Endpoint、Offer、上游
账号和价格也不属于 App 请求可配置内容。

## 2. 当前外部 API

### 2.1 创建 App Session（`admin-api-go`）

当前实现：

```http
POST /api/portal/user/apps/{app_id}/sessions
Authorization: Bearer <Portal access token>
Content-Type: application/json

{
  "version": "1.2.0"
}
```

响应只返回短期、内存使用的 App Token，不返回用户 API Key：

```json
{
  "data": {
    "access_token": "ast_xxx",
    "token_type": "Bearer",
    "expires_in": 900,
    "gateway_url": "https://api.example.com/v1",
    "app_id": "app_internal_id",
    "app_slug": "app.proxy.abc123",
    "app_version": "1.2.0",
    "scopes": ["platform.models.read", "platform.llm.invoke"]
  }
}
```

创建 Session 时必须由 `admin-api-go` 服务端完成：

1. 校验用户已安装应用；一次性收费应用必须已购买。
2. 解析可运行版本和 manifest 权限；未发布版本仅对应用拥有者可见。
3. 在服务端固化版本的商业模式快照。供应商成本、平台费率、用户扣费和分账
   明细不进入浏览器 Token 或应用运行时响应。
4. 生成有 `aud`、`exp`、`jti` 的签名 Token，并限制单个用户/应用的 Session 数量。
5. 记录 `app_session.created` 审计事件；注销应用、撤销安装或下架时可通过
   `jti` 黑名单立即失效。

Token 的最小 Claims：

```json
{
  "iss": "proxy-admin-api",
  "aud": "proxy-llm-gateway",
  "sub": "user_id",
  "app_id": "app_internal_id",
  "app_slug": "app.proxy.abc123",
  "app_version": "1.2.0",
  "installation_id": "install_xxx",
  "scopes": ["platform.models.read", "platform.llm.invoke"],
  "jti": "session_xxx",
  "iat": 1780000000,
  "exp": 1780000900
}
```

`app_id` 是内部数据库 ID，`app_slug` 是 manifest 和 Bridge 使用的公开标识。
客户端不能通过请求体或 `X-App-ID` 覆盖 Claims；请求头中的 App 标识只用于
链路追踪，不能用于认证。

### 2.2 App 数据面（`llm-gateway-go`）

应用与个人 API 共用以下运行面路径：

```text
/v1/models
/v1/responses
/v1/responses/stream
/v1/chat/completions
/v1/embeddings
/v1/images/generations
/v1/images/edits
/v1/images/tasks/:id (GET)
/v1/videos (POST)
/v1/videos/:id (GET)
/v1/videos/:id/content (GET)
/v1/videos/:id (DELETE)
```

应用运行面只接受浏览器宿主为当前用户签发的短期 `ast_`。个人 API Key 也使用
`/v1/*`。网关根据认证上下文执行 Scope、用户配额和资源归属校验：

```http
Authorization: Bearer ast_xxx
X-Request-ID: req_xxx
X-App-Version: 1.2.0
```

`X-Request-ID` 是链路追踪标识；有副作用的请求还应发送独立的
`Idempotency-Key`。重试同一业务操作时复用 `Idempotency-Key`，不能重复扣款。
`X-App-Version` 仅用于诊断，实际版本以 Token 为准。

网关不把普通用户 API Key 和 App Token 混为一种主体；两类调用在内部复用协议处理器，
通过认证上下文执行用户配额、速率、CORS、审计和灰度策略。App Session 不提供个人
`/v1/*`、`/responses`、`/models` 等兼容别名。

## 3. 两个 Go 项目的实现边界

### `admin-api-go`

`appmarket` 当前负责 Session、安装关系和 App 控制面：

- `app_sessions` 持久化 `id`、`user_id`、`app_id`、`installation_id`、`version`、
  `jti_hash`、`expires_at`、`revoked_at`、`last_seen_at`。
- `POST /api/portal/user/apps/:id/sessions`：由 Portal 宿主或本地开发 Relay 创建真实、短期的用户 App Session，App 前端不直接调用。创建时平台绑定当前登录用户、应用、安装、版本和 Scope。
- `DELETE /api/portal/user/apps/:id/sessions/:session_id`：由 Portal 撤销 Session。
- `GET /api/portal/user/apps/:id/api-catalog`：返回已安装版本允许的 API 和权限，
  不返回供应商密钥或内部路由信息。
- `GET /api/portal/user/app-workspace/:id/versions/:version/api-catalog`：应用拥有者
  查看自己上传的草稿、审核中或已发布版本的 API 目录，无需先安装。
- `Bridge` 继续处理平台原子能力；线上 `app.platform.createSession()` 触发宿主刷新，
  本地 Relay 通过用户登录回调获取用户态后调用同一套 Session 接口，不复制或绕过线上授权逻辑。
- 应用下架、卸载、购买退款、版本撤回时撤销相关 Session。

当前实现使用 `admin-api-go` 与 `llm-gateway-go` 共享配置的专用 HS256
Session Secret；生产环境必须独立于用户 JWT Secret，并通过密钥管理系统轮换。
后续迁移 RS256/EdDSA 时应增加 `kid`、JWKS 缓存和双签名过渡，不能只切换算法而
让旧 Session 失效。无论采用哪种算法，网关都不能在每个请求回调控制面数据库。

### `llm-gateway-go`

当前通过 `CodexAuth` middleware 和 App Principal：

- 个人认证和应用认证都挂载在 `/v1`；先校验对应会话，再校验 `scopes` 和请求方法。
  同一组协议处理器按当前用户执行配额，并按应用维度执行审计和资源隔离。
- 将 Claims 转成现有请求上下文的独立主体：`user_id`、`app_id`、`app_version`、
  `installation_id`、`pricing_snapshot`、`request_id`。
- `CodexAuth` 处理个人 API Key 和短期 App Session；App Session 只能进入 `/v1/*`
  数据面，且不能伪造 `UserAPIKey` 数据库记录。
- 复用现有 provider selection、failover、SSE、媒体任务和响应适配器。
- 在 billing/usage log 中增加 App 维度，至少写入 `app_id`、`app_version`、
  `installation_id`、`app_request_id` 和服务端收费快照；收费快照只用于平台
  内部结算和审计，不作为应用 API 字段返回。
- `/v1/models` 对 App Session 只返回平台允许且该 App scope 可用的模型能力；不能暴露
  供应商账号、内部 endpoint 或管理字段。

内部控制接口 `/internal/*`、`/api/v1/*`（管理 API Key/导入等）继续使用内部
Token 或管理 API Key，绝不开放给 App。

## 4. 计费闭环

实际模型/媒体请求的价格由 `llm-gateway-go` 在执行时计算。应用请求不能传入或
覆盖价格、供应商、费率或分账字段。以下结算步骤是平台内部实现约束，不是应用
应用构建者需要调用或理解的开放 API。

当前实现采用 reserve → execute → settle/refund：

1. 网关根据平台内部规则预扣并在请求结束后按实际用量结算。
2. 上游失败、超时或客户端断流按平台退款规则处理。
3. 请求幂等、重试和 SSE 重连不能产生重复扣款。
4. 应用拥有者只在应用收益中心查看结算结果，不通过应用 API 获取成本拆分。

真实扣款、供应商结算和应用分账只能在网关可信执行路径发生，应用拥有者不通过
应用 API 获取成本拆分。

## 5. App SDK 使用方式

SDK 不读取 Portal Cookie、JWT 或用户 API Key。当前调用方式为：

```ts
const session = await app.platform.createSession()
const result = await app.api.request('/responses', {
  method: 'POST',
  body: JSON.stringify({ model: 'gpt-5.5', input: 'hello' }),
})
```

SDK 在内存中保存线上 Session，过期后通过宿主重新申请；本地模式不向浏览器暴露
Portal Token，SDK 在本地访问同源 `/__platform/v1`、`/__platform/bridge` 和
`/__platform/auth` 的真实开发 Relay，Relay 再使用用户态 App Session 转发请求。
线上则由 AppHost 注入真实 Session。两种模式共用同一套平台授权、配额、计费和调度逻辑；
本地 Relay 与 AppHost 都只负责运行适配，不实现模型或计费。

App manifest 应声明 API scope，例如：

```json
{
  "permissions": ["storage.user"],
  "apis": ["model.responses", "model.chat"]
}
```

审核时锁定 `apis`；Session 的 scope 必须是 manifest 声明、平台允许、用户授权
三者的交集。

## 6. 安全和运营要求

- App Token 有效期建议 15 分钟，刷新必须重新经过 `admin-api-go` 授权。
- 使用专用 Session Secret 轮换；网关拒绝未知 issuer/audience、过期 Token 和
  已撤销的 `jti`。`X-Request-ID` 只是链路追踪值，不参与重放判断；有副作用的
  业务操作使用独立的 `Idempotency-Key`。
- 应用从浏览器调用 `/v1` 时只允许配置的 Portal Origin；采用 sandbox iframe 时需显式配置
  `null` 这个不透明 Origin，仍禁止 `Access-Control-Allow-Origin: *` 搭配凭证；
  iframe 仍使用 `postMessage` 的 source 校验。
- 请求体、文件大小、并发、单用户/单 App 速率和每日预算都要在网关限制。
- 日志默认脱敏 prompt、Token 和邮箱；管理员查看完整内容需要独立审计权限。
- API 响应统一包含 `request_id`、稳定 `code`、`type`、`message`，流式错误也
  必须带 request ID。

## 7. 应用上线检查

1. 在 `manifest.json` 只声明实际使用的 `apis` 和 Bridge `permissions`。
2. 使用 SDK 的相对路径，例如 `/responses`、`/images/generations`、`/videos`；
   不要在 App 中拼接 `/v1`，Session 的 `gateway_url` 已包含该前缀。
3. 图片成功按 `created + data` 处理；默认同步等待窗口为 10 分钟，收到 `media_task_timeout` 时保存任务 ID，
   按响应头 `Retry-After` 查询 `/images/tasks/{id}`，不要重新提交生成请求。
4. 视频和音乐保存任务 ID，轮询任务接口，完成后再读取 `/content`；取消使用对应
   的 `DELETE` 接口。
5. 提交审核前用应用管理目录确认版本的 `data_plane` 和 `bridge`，并确保错误处理
   保留 `AppSdkError.requestId`。

## 8. 明确禁止的方案

- App 直接携带用户 `sk-*` API Key 请求 `/v1/*`。
- 通过 `X-App-ID`、请求体 `app_id` 或前端价格字段做身份和计费依据。
- 在 `admin-api-go` 中同步代理全部模型响应和 SSE 流。
- 让 `llm-gateway-go` 每次请求访问 `admin-api-go` 或数据库验证安装状态。
- 把 `/admin/*`、`/internal/*`、`/api/v1/*` 复用为 App API。
