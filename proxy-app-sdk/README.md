# @ducking-mind/proxy-app-sdk

面向 Proxy App 平台应用的 TypeScript SDK，包含公开的应用 KV 用户存储能力。
SDK 为 server 页面、本地开发、桌面应用和独立 HTTP 集成提供统一客户端。

## 安装

```bash
npm install @ducking-mind/proxy-app-sdk
```

该软件包包含 ESM JavaScript 和 TypeScript 类型声明。在本仓库中开发时，可使用
`npm run build` 从源码构建 SDK。

## 创建客户端

```ts
import { createAppClient, AppSdkError } from '@ducking-mind/proxy-app-sdk'

const app = createAppClient('canvas')

const models = await app.api.request('/models')

for await (const event of app.api.stream('/responses/stream', {
  method: 'POST',
  body: JSON.stringify({ model: 'your-model', input: 'Hello' }),
})) {
  console.log(event.data)
}
```

应用标识可以是公开 slug（例如 `canvas`、`my-app`、`app.proxy.canvas`），也继续支持平台分配的
`app_...` 稳定 ID。公开 slug 长度为 1–120，规则为 `^[a-z0-9]+(?:[.-][a-z0-9]+)*$`；SDK 不会
自动添加 `app.proxy.` 前缀。应用使用平台提供的 App Session，并将其附加到获准的数据请求。

公开 slug 不是授权身份。Server 模式先验证平台返回的稳定 `app_id` 和账户范围，再发送业务请求；
应用改名后，旧包中的 slug 只能通过平台返回的 `app_aliases` 匹配，不能自行去掉前缀猜测映射。
首次确认稳定 ID 后，后续刷新不会切换到另一个应用。

## Gateway API

客户端提供以下数据面能力：

- `app.storage.get/set/delete()`：存储用户范围内的 JSON 值；`app.storage.getMany(keys)` 可一次读取最多 100 个键。
- `app.storage.getEntry(key)`：读取值、`revision` 和 `updatedAt`，供有条件更新使用；`getEntries(keys)` 批量读取这些信息，缺失项返回 `null`。
- `app.storage.list({ prefix, cursor, limit })`：分页列出当前应用用户范围内的键；`app.storage.batch(operations)`：在一个事务中批量写入或删除最多 100 项。写入支持 `expectedRevision` 乐观并发控制，冲突时抛出 `APP_STORAGE_CONFLICT`。
- `app.sharedStorage.*`：访问应用公共空间，所有该应用的用户共享同一份键值数据。它和 `app.storage.*` 的个人空间分离；公共/个人空间由平台和 App Session 决定，SDK 不接受 `scope`、`namespace`、`user_id`、`app_id` 或 `workspace_id` 参数。公共浏览器运行时只允许读取和写入，删除共享键由平台后台控制。
- `app.workspaceStorage.*`：访问当前平台已绑定团队工作空间的键值数据，同一团队中的成员共享一份数据。工作空间由 Portal 在启动应用时完成成员、状态和空间类型校验，并绑定到 App Session；应用和前端不能选择、替换或伪造工作空间。团队成员可以读取、写入、批量修改和按版本删除，`getEntry()`/`getEntries()` 同样返回服务端记录的最后写入作者。
- 公共空间的 `getEntry()`/`getEntries()` 会额外返回服务端解析的 `author.id` 和 `author.name`。作者信息来自写入者的 App Session，应用不得信任 JSON 值内自带的 `userId`、`userName` 字段；普通 `get()`/`getMany()` 仍只返回值。
- `app.api.request()`：访问已公开的模型、响应、媒体、任务和 KV 路由；`app.api.stream()` 读取已公开的 SSE 路由。
- `app.user.getProfile()`：读取当前调用用户的最小资料（`id`、`email`、`username`，以及可选的 `avatar_url`）。direct runtime 使用 Gateway `GET /v1/profile`，不需要模型、媒体或 KV scope；本地开发使用 `/__platform/auth/profile`，server runtime 使用同源 `/api/app-runtime/v1/profile`。Gateway 资料接口不会返回余额、手机号、API Key 或其他账户管理字段。

`app.notification.show()`、`app.theme.read()`、`app.locale.read()` 和
`app.platform.capabilities()` 属于宿主控制面 API，当前 SDK 会在发送前拒绝，不会转发到 Admin Runtime。
`app.platform.call()` 也只允许 App Session `host_capabilities` 中明确声明的本地能力（例如
`media.image.readCached`）；它不能调用任意控制面方法或绕过声明。

个人存储按应用和用户隔离，公共存储按应用隔离并对该应用的用户共享，团队存储按应用和平台绑定的工作空间隔离；三类数据均跨设备和页面刷新保留。单值最大 256 KiB，整批请求最大 1 MiB；
个人存储默认每位用户在所有应用合计最多 10,000 个键、64 MiB。版本号由服务端分配，删除重建不会复用，
应从 `getEntry()` 读取后作为 `expectedRevision` 传回，不能自行递增。图片和视频通过平台媒体
资产服务保存，KV 只保存任务 / 资产引用。完整示例、HTTP 资源与错误处理见
[通用应用 KV 存储](https://github.com/duckingmind/app/blob/main/docs/API_REFERENCE.md#通用应用-kv-存储)。

应用清单不需要填写 `apis`、`permissions`、`backend`、`pricing` 或作用域字段。公开 Gateway 能力由
平台策略和 App Session 统一决定，前端不能通过清单缩小、扩大或切换个人/公共 KV 空间；应用不能
指定其他用户或应用的存储空间。SDK 会使用平台提供的短期 App Session。读写失败时请根据 `AppSdkError.code` 处理会话过期、
权限不足、版本冲突、配额不足和限流，不要把这些错误当成“键不存在”。

```ts
// 默认清单无需额外配置 KV 权限。
await app.storage.set('settings', { theme: 'dark' })
const settings = await app.storage.get<{ theme: string }>('settings')

// 使用同一份快照、版本和幂等键重试未确认的保存。
const entry = await app.storage.getEntry('draft/current')
const saveOptions = {
  expectedRevision: entry?.revision ?? 0,
  idempotencyKey: crypto.randomUUID(),
}
await app.storage.set('draft/current', { title: '草稿' }, saveOptions)

// 批量获得值和版本信息，缺失键对应 null。
const entries = await app.storage.getEntries(['draft/current', 'settings'])

// 应用公共空间：所有用户读取同一份结果；空间由平台从 App Session 推导。
await app.sharedStorage.set('gallery/item-1', { title: '共享结果' })
const shared = await app.sharedStorage.get<{ title: string }>('gallery/item-1')

// 团队空间：只使用平台绑定的“当前团队”，不要传 workspace_id。
const teamDraft = await app.workspaceStorage.getEntry<{ title: string }>('team/draft')
await app.workspaceStorage.set('team/draft', { title: '团队草稿' }, {
  expectedRevision: teamDraft?.revision ?? 0,
  idempotencyKey: crypto.randomUUID(),
})
```

SDK 每次调用默认生成新的幂等键。响应丢失后再次调用时，须显式复用原 `idempotencyKey` 和原操作内容。
成功回执持久保存，24 小时内重试返回原结果，仍检查当前权限。同键提交不同操作返回
`APP_STORAGE_IDEMPOTENCY_CONFLICT`。个人、团队空间支持 `delete`；公共空间的删除请求会返回 `APP_SHARED_STORAGE_DELETE_DENIED`。三类空间的 `batch` 都支持幂等键。

个人 KV 可使用 `app.storage.*`，公共 KV 可使用 `app.sharedStorage.*`，团队 KV 可使用 `app.workspaceStorage.*`；三者的 HTTP 路径分别是
`/storage/items`、`/storage/keys`、`/storage/batch` 和 `/storage/shared/items`、
`/storage/shared/keys`、`/storage/shared/batch`，以及 `/storage/workspace/items`、
`/storage/workspace/keys`、`/storage/workspace/batch`。通用请求使用 HTTP 的原始 JSON 契约（例如 `expected_revision`），
存储快捷方法使用 `expectedRevision` 并自动转换返回字段。`/media/storage/usage` 用于媒体空间用量。

团队空间只有在 App Session 已绑定一个 active 的 team workspace 时可用。Portal 负责校验当前用户是成员，
并在会话中保存绑定；个人空间、已归档空间、非成员或未绑定会话会被 Gateway 拒绝。SDK 不读取前端提交的
`X-Workspace-ID`、查询参数或 JSON 作用域字段来决定空间，应用只需处理平台返回的会话或存储错误。

媒体资产接口也通过 `app.api.request()` 提供：`GET /media/storage/usage` 查询用量，
`GET /media/assets?page=1&limit=20` 分页列出当前应用用户的资产，
`GET /media/assets/{id}` 读取单项信息并刷新地址，`PATCH /media/assets/{id}` 更新名称、分类、标签、文件夹及收藏状态，
`DELETE /media/assets/{id}` 删除媒体文件。列表中的 `url`
是短期地址，过期后重新读取，不能作为永久链接保存。媒体入口与应用 KV 入口相互独立。
资产库列表使用 `saved_to_library=true`，可组合 `query`、`tag`、`category`、`folder`、`type` 筛选；
省略收藏筛选时仍返回全部媒体文件。PATCH 必须携带读取到的 `expected_revision`（初始为 `0`），
冲突返回 `409 media_asset_revision_conflict`，需重新读取后合并编辑。名称与文件夹最多 100 个字符；
用户标签最多 20 个、每个 40 个字符，去除首尾空白并忽略大小写去重。
`source_app_id` 和 `system_tags` 由服务端记录，不可提交修改，`app:`、`type:`、`source:` 为保留前缀。
从资产库移除使用 `PATCH { expected_revision, saved_to_library: false }`，保留媒体文件及画布引用。
这些路由在 HTTP SDK 与桌面运行时均按明确的方法、路径和单项 ID 白名单开放。
当前没有手动上传到平台资产库的接口；图片文件可通过 `/images/edits` 的 `FormData` 作为任务参考图
上传，但不会自动成为资产库条目。独立素材上传尚未开放；不要用 KV 或生成任务模拟上传接口。

模型和媒体相关操作请使用 `app.api.request()` 或 `app.api.stream()`。可用路由包括
模型目录、Responses、chat completions、embeddings、图像生成/编辑以及视频、音乐或音色设计任务
操作。当前公开路由由平台会话或 API Key 的 scope、账户权益、模型目录和 Gateway 路由策略共同决定；
`manifest.apis` 仅用于兼容性描述，不需要逐项声明，也不会额外收窄授权。

`POST /estimates` 可在提交前预估本次请求费用，参数为
`{ model, model_type: 'image' | 'video' | 'text', operation, parameters }`。
此接口不创建任务、不冻结余额、不扣费。响应 `known: false`、`amount: null`
表示价格暂不可用；不要将它显示为免费。预估金额可能随实际路由和用量变化，最终以结算为准。

`request()` 会自动解析 JSON 和文本，其他媒体以 `Blob` 返回。如果已知响应格式，可将
`responseType` 设置为 `json`、`text`、`blob`、`arrayBuffer` 或 `response`。JSON 字符串
请求体会默认使用 `Content-Type: application/json`；`FormData` 和二进制请求体会原样传递。

## 运行时选项

所有应用统一使用 App Session 的 Gateway 数据面。SDK 只会把 `app.api.*` 请求和 KV 请求送到
App Session 的 `gateway_url`；宿主控制面方法会在发送前失败。Electron 桌面应用可使用会话
`host_capabilities` 中明确声明的本地能力，例如桌面素材缓存。

Gateway-only 是平台架构约束，不是 manifest 字段或 SDK 选项；应用无法通过配置切换到 Admin Runtime。

应用无需配置数据面开关：

```ts
const app = createAppClient('com.example.my-app')
```

生产页面默认使用 `direct` 运行时：SDK 从 Portal 交接到当前标签页的 App Session，直接调用该会话的 Gateway。
本地开发仍应使用 CLI 提供的 `local` 运行时；只有由 Portal 同源输出、并由 HttpOnly Cookie 托管会话的页面才应显式选择 `server`。

对于独立集成，请提供通过平台会话流程获取的 App Session 以及刷新回调：

```ts
const app = createAppClient('com.example.my-app', {
  runtime: 'direct',
  appSession,
  refreshAppSession: async () => getFreshAppSession(),
})
```

由 Portal 直接输出 `index.html` 的应用使用 `server` 运行时。Portal 会把短期
App Session 保存在同源 HttpOnly Cookie 中，SDK 只读取公开的会话元数据，应用脚本不会接触
`ast_` 凭证：

```ts
const app = createAppClient('com.example.my-app', { runtime: 'server' })
```

模型、媒体和 KV 请求会分别通过同源的 `/api/app-runtime/v1/gateway` 和
`/api/app-runtime/v1` 路径发送，并自动携带 Cookie。发布页面不应把 `Authorization` 令牌写入
应用代码、URL 或本地存储。

`server` 会在首次业务请求前读取会话元数据，绑定稳定应用 ID 和账户范围；之后每次请求携带
`X-App-Account-Scope`，不能静默切换到另一个标签页的账户。刷新失败仅对临时网络/服务故障做
有次数上限的退避重试，页面恢复可见、联网后会重新检查。业务请求仍然只在平台明确表示
`APP_SESSION_EXPIRED` 且 `execution_started: false` 时刷新并重试一次。

账户切换、退出或不可恢复的授权失效会停止当前客户端，并发送 `proxy-app:session-ended`
窗口事件，`detail` 包含 `appId`、`accountScope`、`code`、`message`。应用应暂停旧账户的同步，
保留草稿，再由用户明确点击恢复。`app.auth.recoveryMode === 'redirect'` 时调用
`app.auth.login()` 会返回同源 Portal 启动页，并携带当前画布片段路由；它不会自动重放生成任务。
`app.auth.logout()` 会撤销当前服务端应用会话，而不是仅清除页面状态。本地/桌面登录为
`login`，原 `loginMode` 字段保持兼容。

直接集成只使用 App Session 的 `gateway_url`；SDK 会把业务相对路径拼接到 Gateway `/v1`。
应用代码不应配置或硬编码 Admin Runtime 或其他平台私有路径。

独立 HTTP 客户端应使用 App Session 的 `gateway_url`，访问 Gateway 下的 `/storage/items`、
`/storage/keys` 和 `/storage/batch`（完整路径通常为 `/v1/storage/*`）。带 JSON 请求体时设置 `Content-Type`：

```http
Authorization: Bearer <App Session>
Accept: application/json
Content-Type: application/json
```

HTTP 请求使用 `expected_revision`，SDK 参数使用 `expectedRevision`；HTTP 响应的 `updated_at`
和 `next_cursor` 由 SDK 转换为 `updatedAt` 和 `nextCursor`。应用静态资源域名不一定是平台 API
域名；本地开发代理会为同一路径附加会话，无需在应用里配置发布令牌。完整的资源表、curl 示例和响应结构见
[API 参考](https://github.com/duckingmind/app/blob/main/docs/API_REFERENCE.md#通用应用-kv-存储)。

直接 HTTP 写入可附加 `Idempotency-Key` 请求头；SDK 的 `getEntries(keys)` 复用批量读取接口，
对应 `GET /storage/items?keys=...&keys=...&include_metadata=true`。

只有当平台明确报告 App Session 在执行前已过期时，SDK 才会刷新并重试。其他认证错误
会直接返回给调用方。需要主动刷新会话时，请调用 `app.platform.createSession()`。

## 本地开发

使用平台 CLI 运行开发代理，然后注册 Vite 代理：

```ts
import { defineConfig } from 'vite'
import { createPlatformDevProxy } from '@ducking-mind/proxy-app-sdk/vite'

export default defineConfig({
  base: './',
  server: { proxy: createPlatformDevProxy() },
})
```

使用以下命令启动应用：

```bash
proxy-app dev apps/my-app
```

CLI 先完成开发者授权，按 `manifest.id` 的公开 slug 解析平台应用并完成开发登记，通过后才启动应用并提供代理配置。
不需要 `.proxy-app.json`、`repair` 或手工配置用户 token；内部应用 ID 由平台返回并只在代理进程内使用。
首次缺少开发授权时，从终端给出的链接完成授权；slug、开发权限或版本冲突会在启动前报错。
如果缓存的开发账户无权访问应用，CLI 会自动清除开发授权并在下一次 `proxy-app dev <app-directory>` 启动时请求新的创建者授权。
页面启动时使用 `app.auth.status()` 检查已有运行用户授权，不会主动弹出登录窗口。
返回的 `accountScope` 是平台、应用与账号共同确定的不透明缓存分区标识，不是凭证，也不需要
先读取用户资料才能获得。`accountScope` 在会话刷新、应用升级后保持稳定，适合为 IndexedDB、草稿和媒体缓存
分区。账号标识变化时应停止旧操作、重新挂载工作区；不应把旧账号缓存自动同步给新账号。
旧会话缺少该字段时，SDK/宿主会尝试补全平台会话信息或刷新一次 App Session，不主动打开登录窗口。
刷新后仍缺失或格式无效，会抛出 `APP_ACCOUNT_SCOPE_UNAVAILABLE`；应用应保留工作区并提示检查平台/宿主版本，不能使用共享默认分区。
恢复交互优先读取 `app.auth.recoveryMode`：`login` 为本地/桌面登录，`redirect` 为服务器应用返回平台恢复，均可由用户点击调用 `auth.login()`。旧 `loginMode` 字段保持兼容。
`app.platform.createSession()` 在网页宿主/直连模式刷新会话，在本地开发/桌面模式委托持有凭证的宿主校验和恢复会话，仅返回公开状态与元数据。
有授权时恢复应用数据，无授权时显示连接按钮，由用户操作调用 `app.auth.login()`。
普通连接会复用有效的平台登录；只有凭证失效或显式调用
`app.auth.login({ forceLogin: true })` 才要求重新登录。切换账号后应重新加载该账号的作品和偏好。

macOS 上 CLI 使用独立的钥匙串条目保存开发者授权与运行用户授权，支持开发服务重启后恢复；App Session
仍是仅存于进程内存的短期会话。`app.auth.logout()` 只清除运行用户授权和当前会话。
应用内登录、恢复授权和切换用户不会重新登记应用，也不影响开发者授权。
其他系统或钥匙串不可用时退回进程内存；`proxy-app dev <app-directory> --no-auth-cache`
可禁用两类持久缓存。发布构建中不要启用本地开发选项。

`auth.status()` 会对网络或代理配置错误抛出 `AppSdkError`（网络断开也可能是 fetch 错误）；
不要把这些故障当成“未登录”。账号认证与模型、作品加载状态应独立处理，资源失败可以单独重试。

## 错误处理

失败时会抛出 `AppSdkError`，其中包含稳定的 `code`，以及可选的 HTTP `status`、
`requestId` 和结构化 `details`。请明确处理会话和连接错误，以便 UI 提供重试或重新连接
操作：

```ts
try {
  await app.api.request('/models')
} catch (error) {
  if (error instanceof AppSdkError) {
    console.error(error.code, error.requestId, error.details)
  }
}
```

SDK 永远不会向应用暴露平台管理凭证。请让应用会话保持短期有效并仅存放在内存中，
同时只请求应用代码契约中声明的能力。

## 构建与发布

在平台项目根目录使用 CLI 校验并打包应用：

```bash
npm install
npx proxy-app build apps/my-app
npx proxy-app validate apps/my-app
npx proxy-app pack apps/my-app dist/my-app.zip
```

通过开发者控制台上传 ZIP，在宿主中测试该版本，确认无误后再发布。manifest 格式、
权限、API 可用性和审核要求请参阅平台文档。

### 暴露给外部调用方的应用工具能力

项目本身不实现 Agent；`agent` 是历史兼容命名，表示“面向外部 Agent 的能力桥接”。`agent.register(declaration, handler)` 或 `client.agent.register(...)` 将当前子应用的业务处理器及完整能力定义注册给主应用宿主，返回注销函数；`agent.ready()` 可等待注册完成。能力名称、参数 Schema 和读写属性由应用代码定义，并显式声明 `access`、`input_schema` 和 `output_schema`。CLI 自动发现 `src/agent-tools.mjs`，源码 manifest 不声明 MCP 能力；构建时生成发布能力目录，运行时使用同一份定义注册处理器，宿主校验运行时声明与发布契约一致。已发布旧包的 manifest 契约继续兼容。普通 Web 环境中不会对外暴露能力。

主应用在首次安装时发布能力目录，调用时按需启动子应用并等待处理器。业务处理器应在登录和数据就绪后注册，并在失效时注销。确认尚未执行任何业务修改的拒绝可抛出带 `executionStarted: false` 的错误；SDK 会将该标记传给宿主，使后续写操作可以继续。开始修改后不得使用此标记。

完整示例和写入约束见[应用开发指南](../docs/APP_DEVELOPMENT.md)。

`agent.setStatus(status, { scope?, priority? })` 上报 `ready`、`auth_required`、`loading`、`no_document`、`busy` 或 `error`，支持 `reason`、`retryable`、`nextAction` 和当前文档 ID。返回的清理函数只移除自身状态；优先级较高的登录/加载作用域可覆盖编辑器状态。注册与状态上报串行发送并绑定页面 epoch，`agent.ready()` 可等待队列完成。

`agent.environment()` 返回 `{ target: "desktop" | "web", agentAvailable: boolean }`。在主应用的 Web 宿主中返回 `web/true`，能力会通过受控 Web Bridge 暴露给主应用；直接在系统浏览器或没有宿主桥接的云端页面中返回 `web/false`。独立启动、未连接主应用的桌面包返回 `desktop/false`，注册为安全无操作。`agentAvailable` 表示存在主应用能力桥接；外部助手是否获准访问仍由主应用开关与逐次授权控制。

外部 Agent（例如 Codex）通过主应用的发现工具与标准 MCP 工具目录获取能力，通过 `get_app_guide` 或 resources 读取发布契约生成的版本化指南。指南和示例随应用打包，不需要应用修改外部 Codex 的全局配置。
