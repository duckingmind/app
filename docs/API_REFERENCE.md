# Proxy App API 参考

本文是 Proxy 应用开发的接口索引。接口按调用场景分为四组：

1. **Bridge 控制能力**：运行在 Portal iframe 中的纯前端应用，通过 SDK 的
   `postMessage` 与宿主通信。
2. **运行面 API**：模型和媒体请求，使用绑定当前用户的 App Session 访问
   `llm-gateway-go` 的统一 `/v1/*` 数据面。
3. **应用管理控制面**：创建应用、上传版本和提交审核，只能由应用拥有者在
   Portal 或发布 CLI 中调用，不能从公开的应用前端调用。
4. **App HTTP Runtime**：本地及 direct 模式通过 `/api/app-runtime/v1/*` 读取资料、能力和用户存储，使用 v2 AppSession。

> **先看结论**：App 使用 App HTTP Runtime、旧包 Bridge 和 `/v1` 数据面接口。
> 开发者工作台、应用市场、供应商 Agent、管理后台和内部接口都不是 App API。
> 应用只提交平台模型 ID 和平台公开能力参数，Provider、Endpoint、Offer、供应商
> 账号、成本与价格由平台在服务端调度，不能由 App 指定。

> **协议状态**：本地 HTTP 传输及下文资源接口已实现，部署需先升级 Gateway/Admin。
> Bridge 小节用于已发布的 iframe 旧包兼容。完整 page runtime、PKCE、CAS 等目标
> 仍见 [HTTP_RUNTIME_DESIGN.md](HTTP_RUNTIME_DESIGN.md)，不能将目标设计全部视为已上线。

## 1. 调用方式和身份

### 1.1 iframe 应用

应用不应保存 Portal Cookie 或用户 JWT。应用启动后由宿主
通过 SDK 握手提供短期 `ast_` App Session：

```ts
import { createAppClient } from '@ducking-mind/proxy-app-sdk'

const app = createAppClient('app.proxy.example')
await app.platform.createSession()
const models = await app.api.request('/models')
```

Session 包含应用、用户、安装、版本和 Scope，有效期较短并只存于
内存。SDK 在收到 `401` 时会向宿主请求刷新；刷新失败时应提示用户重新打开
应用。应用不能自行拼接或覆盖 `app_id`、版本或任何平台内部字段。

### 1.2 本地开发

本地现在默认调用 `/v1` 和 `/api/app-runtime/v1`，不使用 Bridge RPC。旧 SDK 使用
`proxy-app dev <app-dir> --legacy-bridge` 启用兼容；新 SDK 需显式 localBridgePath 才选择旧路径。

本地开发不依赖宿主 iframe，但需要平台用户登录。`proxy-app dev` 在本机回环地址启动
真实平台 Relay：

```text
本地浏览器 -> 本地 Vite -> 本地 Relay -> admin-api-go / llm-gateway-go
```

在 Vite 配置中使用 SDK 提供的代理适配器。执行 `proxy-app dev` 时，CLI 会自动注入本地
Relay 地址；应用首次请求会打开平台登录，之后使用当前用户的真实 App Session：

```ts
import { defineConfig } from 'vite'
import { createPlatformDevProxy } from '@ducking-mind/proxy-app-sdk/vite'

export default defineConfig({
  base: './',
  server: {
    host: '127.0.0.1',
    proxy: createPlatformDevProxy(),
  },
})
```

```bash
proxy-app dev <app-dir>
```

本地 Relay 不实现模型、调度或计费逻辑：它只在内存中保存登录用户的 Portal 会话，并调用
平台创建短期 App Session。模型目录、文本、图片、视频、供应商调度、额度和计费均由真实
平台处理。Portal Token 不会进入应用进程，数据面只转发 `ast_` App Session。

### 1.3 已实现的 App HTTP Runtime

以下路径使用 `Authorization: Bearer ast_*`，要求 `token_version=2` 且 audience 包含
`proxy-app-runtime`。在现有 Session 创建端点传 `runtime_protocol: 2` 可获得此 token；
无此参数的旧客户端继续取得 gateway-only v1 token。业务身份只取自 token 与数据库记录。

| 方法与路径（前缀 `/api/app-runtime/v1`） | 权限与响应 data |
| --- | --- |
| `GET /session` | 当前 app/user/version/scopes/expiry |
| `GET /profile` | `user.profile.read`；id、username、avatar_url，不返回邮箱 |
| `GET /capabilities` | 当前实际获准的 HTTP 能力列表 |
| `GET /preferences?kind=theme` | `theme.read`；`{mode:"system"}` |
| `GET /preferences?kind=locale` | `locale.read`；`{locale:"en-US"}` |
| `GET /storage/items?key=...` | `storage.user`；JSON value 或 null |
| `PUT /storage/items?key=...` | `storage.user`；body `{value:...}`，返回 `{success:true}` |
| `DELETE /storage/items?key=...` | `storage.user`；返回 `{success:true}` |

JSON 响应为 `{data,request_id}` 或 `{error:{code,message},request_id}`，均不缓存。
存储保留现有 app/user namespace、160 字符 key 和 256 KiB value 上限；当前为最后写入生效，
没有 CAS、分页、幂等结果重放或环境 namespace。SDK 发送幂等 header 不代表上述存储能力已经实现。
`notification.show` 在 HTTP 模式明确报不支持，普通 toast 应由应用 UI 渲染。

本地 `/api/app-runtime/v1/auth/start|status|logout` 由开发代理处理，仅为旧登录流程的 HTTP 入口，
并不是设计中的生产 PKCE 端点。发布包目前仍是 iframe；direct 模式需外部提供 v2 AppSession 和续期回调。

### 1.4 调用主体

App Session 同时绑定用户、应用、安装、版本和 Scope。请求频率、额度、并发、余额、
任务与资产均归当前用户；应用只提供功能和授权边界。平台不再创建长期服务端应用凭证。

### 1.5 请求 ID 和幂等

`X-Request-ID` 用于链路追踪；有副作用的请求还应发送独立的
`Idempotency-Key`（SDK 会自动生成）。重试同一个业务操作时复用同一个
`Idempotency-Key`，而新的业务操作必须生成新的 ID。媒体任务的查询、取消和
内容读取必须使用平台返回的任务 ID。

## 2. Bridge 控制 API

Bridge 协议为 `proxy-app/v1`，通常不需要手工构造消息，直接使用 SDK 方法。
Bridge 的 `appId` 来自初始化时的平台应用标识，服务端会再次校验安装和授权。

| SDK 调用 | Bridge method | 所需权限 | 说明 |
| --- | --- | --- | --- |
| `app.platform.capabilities()` | `platform.capabilities.list` | 无 | 获取当前平台支持的 Bridge 能力 |
| `app.user.getProfile()` | `user.profile.read` | `user.profile.read` | 读取脱敏的当前用户资料 |
| `app.storage.get(key)` | `storage.user.get` | `storage.user` | 读取应用和用户隔离的数据 |
| `app.storage.set(key, value)` | `storage.user.set` | `storage.user` | 写入应用和用户隔离的数据 |
| `app.storage.delete(key)` | `storage.user.delete` | `storage.user` | 删除应用和用户隔离的数据 |
| `app.notification.show(title, body)` | `notification.show` | `notification` | 在平台容器中展示通知 |
| `app.theme.read()` | `theme.read` | `theme.read` | 读取当前主题模式 |
| `app.locale.read()` | `locale.read` | `locale.read` | 读取当前语言区域 |
| `app.platform.createSession()` | `session-refresh-request` | 宿主授权 | 刷新短期 App Session |

### Bridge 数据约束

- Storage key 必须是安全的相对键名，单个 value 最大 256 KiB。
- `notification.show` 的标题最多 120 个字符，正文最多 500 个字符。
- 写入、删除和通知请求需要唯一 `requestId`，重复请求会返回
  `APP_REQUEST_REPLAYED`。

## 3. 运行面 API（`llm-gateway-go`）

运行面基地址由 Session 的 `gateway_url` 返回，通常形如
`https://api.example.com/v1`。SDK 的 `app.api` 方法仍接收相对路径，实际请求
会拼接成下表中的 `/v1/*` 网络路径。

| 方法 | 路径 | Scope | 返回/行为 |
| --- | --- | --- | --- |
| `GET` | `/v1/models` | `platform.models.read` | 可用模型目录（不含供应商密钥和内部 Endpoint） |
| `GET` | `/v1/images/models` | `platform.models.read` + `platform.images.read` | 图片模型目录（需要同时具备模型目录和图片读取权限） |
| `GET` | `/v1/videos/models` | `platform.models.read` + `platform.videos.read` | 视频模型目录（需要同时具备模型目录和视频读取权限） |
| `GET` | `/v1/music/models` | `platform.models.read` + `platform.music.read` | 音乐模型目录，包含模式、时长和输出格式 |
| `POST` | `/v1/responses` | `platform.llm.invoke` | Responses 协议，JSON |
| `POST` | `/v1/responses/compact` | `platform.llm.invoke` | Responses 压缩请求 |
| `POST` | `/v1/responses/stream` | `platform.llm.invoke` | Responses SSE 流 |
| `POST` | `/v1/chat/completions` | `platform.llm.invoke` | OpenAI Chat Completions 协议 |
| `POST` | `/v1/embeddings` | `platform.llm.invoke` | Embeddings |
| `POST` | `/v1/images/generations` | `platform.images.generate` | 创建图片生成任务/结果 |
| `POST` | `/v1/images/edits` | `platform.images.generate` | 图片编辑 |
| `GET` | `/v1/images/tasks/{id}` | `platform.images.read` | 查询图片任务 |
| `POST` | `/v1/videos` | `platform.videos.generate` | 创建异步视频任务 |
| `GET` | `/v1/videos/{id}` | `platform.videos.read` | 查询视频任务 |
| `GET` | `/v1/videos/{id}/content` | `platform.videos.read` | 读取生成的视频内容 |
| `DELETE` | `/v1/videos/{id}` | `platform.videos.cancel` | 取消视频任务 |
| `POST` | `/v1/music/generations` | `platform.music.generate` | 创建异步音乐生成任务 |
| `GET` | `/v1/music/tasks/{id}` | `platform.music.read` | 查询音乐任务 |
| `GET` | `/v1/music/tasks/{id}/content` | `platform.music.read` | 读取生成的音频内容 |
| `DELETE` | `/v1/music/tasks/{id}` | `platform.music.cancel` | 取消音乐任务 |

示例：

```ts
const response = await app.api.request('/responses', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    model: 'gpt-5.5',
    input: '用三句话介绍这个应用',
  }),
})
```

流式调用：

```ts
for await (const event of app.api.stream('/responses/stream', {
  method: 'POST',
  body: JSON.stringify({ model: 'gpt-5.5', input: 'hello' }),
})) {
  render(event.data)
}
```

### 运行面规则

- 网关根据 Session 中的 Scope 和用户身份做校验；请求体
  中的 `app_id`、`app_version` 和任何价格字段都不具备信任属性。
- 应用不能选择供应商、Endpoint、Offer 或上游账号，只能选择平台目录公开的
  模型和能力参数。
- 平台会在执行时完成用量计费、供应商结算和应用收益分账。价格、成本、费率和
  分账字段不属于应用运行时 API；失败或取消按实际用量结算，多余预扣会释放。
- 任务和资产按 `user_id + app_id` 隔离。应用 A 不能读取应用 B 或用户个人
  请求创建的任务。
- 具体模型参数、图片尺寸、视频时长和可用性以对应模型目录（如
  `/images/models`、`/videos/models`）及错误响应为准。

### 3.1 图片：同步优先，超时转任务

`POST /v1/images/generations` 和 `POST /v1/images/edits` 是同步优先接口：

默认同步等待窗口为 10 分钟（600 秒）。这是客户端等待上限，不是任务生命周期；
任务仍由后台继续执行，最长生命周期由 `task_deadline_seconds` 控制。

1. 成功且在等待窗口内完成时，返回 OpenAI Images 风格的
   `{"created": ..., "data": [...]}`。
2. 如果供应商任务仍在执行，返回 `504`，错误详情包含 `task_id`、状态和
   `polling_url`，并带 `Cache-Control: no-store` 与 `Retry-After: 2` 响应头。
   这是“已受理但尚未完成”，不要再次提交创建请求；按 `Retry-After` 间隔轮询。
3. 使用 `GET /v1/images/tasks/{id}` 查询，直到 `status` 为 `completed`；成功后
   从 `data[].url` 或 `data[].b64_json` 读取结果。

成功响应示例：

```json
{
  "created": 1780000000,
  "data": [{"url": "https://cdn.example.com/image.png"}]
}
```

超时响应示例：

```json
{
  "error": {
    "type": "timeout_error",
    "code": "media_task_timeout",
    "message": "media task continues in the background"
  },
  "task_id": "image_task_01J...",
  "status": "in_progress",
  "polling_url": "/v1/images/tasks/image_task_01J..."
}
```

SDK 抛出的 `AppSdkError` 会保留 HTTP 状态和响应体：

```ts
import { AppSdkError } from '@ducking-mind/proxy-app-sdk'

try {
  const result = await app.api.request('/images/generations', {
    method: 'POST',
    body: JSON.stringify({ model: 'image-public', prompt: '一座安静的图书馆' }),
  })
} catch (error) {
  if (error instanceof AppSdkError && error.code === 'media_task_timeout') {
    const details = error.details as { polling_url?: string; task_id?: string }
    const task = await app.api.request(details.polling_url!.replace('/v1', ''))
  }
}
```

图片编辑使用 `multipart/form-data`，SDK 不应手动设置 `Content-Type`，否则会丢失
multipart boundary：

```ts
const body = new FormData()
body.append('model', 'image-public')
body.append('prompt', '把背景改成夜景')
body.append('image', file)
const result = await app.api.request('/images/edits', { method: 'POST', body })
```

### 3.2 视频：始终是异步任务

`POST /v1/videos` 只创建任务并返回 `202`。保存返回的 `id`，轮询
`GET /v1/videos/{id}`；状态为 `completed` 后，再用
`GET /v1/videos/{id}/content` 并设置 `responseType: 'blob'` 读取视频。不要重复
提交创建请求；同一业务操作重试必须复用原来的 `Idempotency-Key`。仍在排队或执行时
可使用 `DELETE /v1/videos/{id}` 取消。

```ts
const task = await app.api.request<{ id: string }>('/videos', {
  method: 'POST',
  body: JSON.stringify({ model: 'video-public', prompt: '镜头缓慢推进森林' }),
})

let status: { status: string; content_url?: string }
do {
  await new Promise((resolve) => setTimeout(resolve, 2000))
  status = await app.api.request(`/videos/${task.id}`)
} while (status.status === 'pending' || status.status === 'in_progress')

if (status.status === 'completed') {
  const video = await app.api.request<Blob>(`/videos/${task.id}/content`, { responseType: 'blob' })
}
```

### 3.3 音乐：与视频相同的任务模式

音乐接口使用 `/music/generations` 创建异步任务，使用
`/music/tasks/{id}` 查询、`/music/tasks/{id}/content` 获取二进制音频，或使用
`DELETE /music/tasks/{id}` 取消。参数必须来自 `/music/models` 返回的能力目录。

### 3.4 App 不可调用的接口

以下接口即使在服务端存在，也不属于 App 运行时 API：

| 路径 | 原因 |
| --- | --- |
| `/internal/*`、`/admin/*` | 网关和后台内部控制接口 |
| `/api/portal/*`、`/api/market/*` | Portal、安装和开发者控制面 |
| `/api/media-agent/v1/*` | 供应商 Agent/Worker 运行协议 |
| `/v1/usage`、`/v1/usage/status` | 用户用量和账户状态接口，不向 App 暴露 |
| `/v1/edits`、`/v1/images/variations` | 非 App 白名单接口；variations 当前未实现 |
| `/models`、`/responses`、`/backend-api/codex/models` | 个人 API 或历史兼容别名 |

App 不能通过请求体、查询参数或请求头传入 `provider`、`endpoint_id`、`offer_id`、
供应商 ID、成本、价格或费率。调度始终由平台根据模型能力、供应商 Offer、健康和
容量完成。

## 4. 应用管理控制面 API

以下接口用于“我的应用”和 CLI，认证方式是当前 Portal 用户的 Bearer Token，
不是应用的短期 `ast_` Session。接口位于 `admin-api-go`，基路径通常为
`/api/portal/user`。

### 应用和版本

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `POST` | `/app-workspace` | 创建应用；平台自动生成 `id` 和公开 `slug` |
| `GET` | `/app-workspace` | 获取当前用户拥有的应用及版本 |
| `POST` | `/app-workspace/{id}/versions` | 上传 ZIP 版本 |
| `GET` | `/app-workspace/{id}/versions/{version}/api-catalog` | 查看自己上传版本的实际 API 目录（无需安装） |
| `POST` | `/app-workspace/{id}/versions/{version}/submit` | 提交版本审核 |
| `GET` | `/apps/{id}/api-catalog` | 查看已安装版本可用 API 目录 |

`api-catalog` 返回 `data_plane` 和 `bridge` 两组目录。`permissions` 是该版本
最终授权的 Scope 集合，既包含用户授权的 Bridge Scope，也包含由 manifest
`apis` 自动派生的数据面 Scope；它不是“仅 Bridge 权限”的计数。`data_plane`
只列出该版本 manifest 已声明、平台允许的运行面路由；它不包含供应商、报价、费率
或内部 Endpoint。应用管理目录只能读取当前用户拥有的版本；消费者目录只能读取已
安装版本。

```json
{
  "data": {
    "version": "1.2.0",
    "apis": ["model.responses", "model.images", "model.videos", "model.music"],
    "data_plane": [
      {"method": "GET", "path": "/v1/models", "scope": "platform.models.read", "response": "json"},
      {"method": "GET", "path": "/v1/images/models", "scope": "platform.models.read", "required_scopes": ["platform.models.read", "platform.images.read"], "response": "json"},
      {"method": "GET", "path": "/v1/videos/models", "scope": "platform.models.read", "required_scopes": ["platform.models.read", "platform.videos.read"], "response": "json"},
      {"method": "GET", "path": "/v1/music/models", "scope": "platform.models.read", "required_scopes": ["platform.models.read", "platform.music.read"], "response": "json"},
      {"method": "POST", "path": "/v1/responses/stream", "scope": "platform.llm.invoke", "response": "sse"}
    ],
    "bridge": []
  }
}
```

创建应用示例（不传 slug）：

```json
{
  "name": "任务助手",
  "description": "管理个人任务",
  "category": "productivity"
}
```

### 能力与凭证

| 凭证 | 用途 |
| --- | --- |
| `ast_*` | 子应用运行时的短期用户会话，由平台自动签发和刷新 |
| `sk-*` | 用户自己的服务端程序直接调用 `/v1/*` |

平台不为应用签发长期服务端凭证。历史应用凭证记录仅用于迁移和审计，不能创建、轮换或用于运行时调用。

### 4.5 使用用户 API Key 调用图片和视频

需要由自己的服务端程序直接调用媒体接口时，在 Portal 的“API 密钥”页面创建一个
`sk-*` Key，并确保 Key 处于活跃状态。可调用的图片和视频模型以对应媒体目录返回的
内容为准；如果部署启用了 Key/分组模型限制，再确保绑定分组包含相应的已发布模型。
供应商 API Key 不属于调用方配置，也不能放入请求体或前端代码。

服务端请求使用与文本 API 相同的 Host 和 Bearer 认证：

```bash
export GATEWAY_BASE_URL="https://api.example.com/v1"
export PROXY_API_KEY="sk-..."

curl "$GATEWAY_BASE_URL/images/models" \
  -H "Authorization: Bearer $PROXY_API_KEY"

curl "$GATEWAY_BASE_URL/videos/models" \
  -H "Authorization: Bearer $PROXY_API_KEY"
```

图片生成在等待窗口内完成时直接返回结果；超时会返回 `task_id`，此时继续轮询任务，
不要重新提交创建请求：

```bash
curl "$GATEWAY_BASE_URL/images/generations" \
  -H "Authorization: Bearer $PROXY_API_KEY" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: image-job-001" \
  -d '{
    "model": "<platform-image-model-id>",
    "prompt": "一张白底电商商品图",
    "size": "1024x1024",
    "n": 1
  }'
```

视频创建始终返回异步任务。保存响应中的 `id`，轮询任务完成后再读取 `/content`：

```bash
curl "$GATEWAY_BASE_URL/videos" \
  -H "Authorization: Bearer $PROXY_API_KEY" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: video-job-001" \
  -d '{
    "model": "<platform-video-model-id>",
    "prompt": "产品展示视频",
    "duration": 5,
    "resolution": "1080p",
    "aspect_ratio": "16:9"
  }'
```

每个有副作用的业务操作都应使用稳定的 `Idempotency-Key`；同一业务重试复用原值，
新的业务生成新的值。调度器会根据已发布能力快照、Offer、健康和容量自动选择供应商，
调用方不能指定 `provider`、`endpoint_id` 或 `offer_id`。

## 5. 市场和安装接口

这些接口由 Portal 使用，应用本身通常不需要调用：

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/api/market/apps` | 公共应用市场列表 |
| `GET` | `/api/market/apps/{id}` | 公共应用详情 |
| `POST` | `/api/portal/user/apps/{id}/purchase` | 一次性收费应用购买 |
| `POST` | `/api/portal/user/apps/{id}/install` | 安装或更新应用 |
| `DELETE` | `/api/portal/user/apps/{id}/install` | 卸载并撤销 Session |
| `POST` | `/api/portal/user/apps/{id}/sessions` | 创建 iframe App Session |
| `DELETE` | `/api/portal/user/apps/{id}/sessions/{session_id}` | 撤销 Session |

一次性收费应用必须先购买再安装；应用拥有者可以测试自己上传的草稿，
测试请求不会产生可提现的应用收益。

## 6. 错误处理

JSON 错误至少包含稳定的 `code` 和可读的 `message`。常见运行面错误：

| HTTP | code | 含义 |
| --- | --- | --- |
| `400` | `invalid_request` | 参数不符合模型或媒体契约 |
| `401` | `credential_invalid` | App Session 无效、过期或已撤销；仅平台确认“过期且尚未执行”时附带 `error.auth_reason=APP_SESSION_EXPIRED` 与 `error.execution_started=false`，客户端最多自动重试一次 |
| `403` | `insufficient_scope` | 缺少接口要求的 Scope |
| `403` | `application_route_not_supported` | App Session 只能访问 Scope 允许的 `/v1/*` 数据面路由 |
| `403` | `resource_access_denied` | 任务或资产不属于当前应用主体 |
| `429` | `user_rate_limited` | 当前用户的请求频率或额度达到上限 |
| `429` | `user_media_concurrency_limited` | 当前用户的媒体在途任务达到上限 |
| `402` | `insufficient_balance` | 用户余额不足 |
| `503` | `service_unavailable` | 网关或媒体控制面暂时不可用 |

Bridge 错误通过 `AppSdkError` 返回，例如 `APP_BRIDGE_TIMEOUT`、
`APP_SESSION_UNAVAILABLE`、`APP_API_PATH_NOT_ALLOWED` 和
`APP_REQUEST_REPLAYED`。生产应用应展示可操作提示，并记录 `requestId` 便于
平台支持定位问题；不要把 Token、Cookie、请求全文或供应商响应写入日志。

## 7. Manifest 声明示例

应用需要在 `manifest.json` 声明希望使用的权限和数据面 API：

```json
{
  "permissions": ["storage.user"],
  "apis": ["model.responses", "model.images", "model.music"],
  "backend": { "type": "platform" }
}
```

声明只是申请能力，最终可用权限是“平台允许、版本审核、用户授权、Session
Scope”四者的交集。更新 `apis` 或 `permissions` 后必须重新上传版本并经过
平台审核。
