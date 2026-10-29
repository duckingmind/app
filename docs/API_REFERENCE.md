# 应用 API 参考

本文介绍应用可以使用的公开 API，包括按应用和用户隔离的 KV 持久存储。建议通过 SDK 调用平台能力，SDK 会统一处理相对路径、会话、响应解码和流式响应，使本地开发与线上运行保持一致。

## 创建客户端

```ts
import { createAppClient, AppSdkError } from '@ducking-mind/proxy-app-sdk'

const app = createAppClient('app.example')
```

应用标识由平台创建应用时提供。应用包中只能保存公开配置，不能包含用户密码、模型服务密钥或发布凭证。

## 用户资料与存储

```ts
await app.storage.set('draft', { title: '示例' })
const draft = await app.storage.get<{ title: string }>('draft')
await app.storage.delete('draft')
```

`storage.user` 按应用和当前用户隔离保存 JSON 数据。请使用稳定、简短的键名，并处理空值、登录失败和权限不足等情况。

应用可使用 `const profile = await app.user.getProfile()` 读取 Gateway `GET /v1/profile`。返回当前凭证绑定用户的 `id`、`email`、`username` 和可选的 `avatar_url`，不要求模型、媒体或 KV scope，也不消耗模型额度。本地开发和已发布应用都由 SDK 使用 App Session 直接请求 Gateway；宿主控制面能力（例如 `app.platform.capabilities()`）不属于公开 Gateway 能力。

`await app.auth.status()` 返回 `{ authenticated, accountScope? }`。`accountScope` 是不含凭证的
平台、应用、账号分区标识，同一账号刷新会话和升级应用后保持不变。应用应以它隔离 IndexedDB、
草稿、媒体缓存与当前工作区；标识变化时先停止旧请求，再加载新分区。不要把旧缓存自动导入新账号。
已登录的旧会话缺少该字段时，SDK/宿主会先尝试补全会话信息或有界刷新一次。仍缺失时抛出
`APP_ACCOUNT_SCOPE_UNAVAILABLE`，此时不能使用共享默认分区继续自动云同步；应提示检查平台/宿主。
网页应用的 `app.auth.loginMode` 为 `host`：用户在平台入口完成登录并打开应用，应用只提供状态检查和重试，不发起浏览器登录请求。桌面应用的登录由受信任的 Electron 宿主处理，浏览器应用不会访问 `/auth/*`。
该标识不是鉴权凭据；服务器签名密钥或平台公开地址变更可能产生新分区，云端数据不因此删除。

## 通用应用 KV 存储

KV 是应用级、用户范围的持久存储。默认清单无需声明权限，用户登录应用后会话自动包含 KV 能力。
平台从短期 App Session 识别应用和当前用户，应用不能通过参数指定其他应用或用户。
数据会跨设备、页面刷新和同一应用的版本保留；浏览器缓存只适合做临时加速，不能作为 KV 的替代品。

应用不在 `manifest.json` 中声明存储作用域或权限。平台根据应用策略和签名 App Session
决定可用能力；前端不能通过 manifest 或请求字段扩大权限。

| SDK 方法 | 行为 |
| --- | --- |
| `get<T>(key)` | 读取 JSON 值；缺失返回 `null`。 |
| `getEntry<T>(key)` | 返回 `{ key, value, revision, updatedAt }`；缺失返回 `null`。已保存的 JSON `null` 仍有版本号，可与缺失区分。 |
| `getMany<T>(keys)` | 一次读取 1–100 个键，返回键到值的映射，缺失键对应 `null`。 |
| `getEntries<T>(keys)` | 批量返回键到 `{ key, value, revision, updatedAt }` 的映射，缺失键对应 `null`。 |
| `list({ prefix, cursor, limit })` | 按键分页，返回 `{ keys, nextCursor? }`；每页 1–100 个键，默认 100。 |
| `set(key, value, { expectedRevision?, idempotencyKey? })` | 写入值并返回 `{ success, revision }`。 |
| `delete(key, { expectedRevision?, idempotencyKey? })` | 删除键；无条件删除缺失键仍成功。 |
| `batch(operations, { idempotencyKey? })` | 一个原子批次按顺序执行 1–100 个 `put` / `delete`，返回与操作顺序一致的结果数组。任一校验、版本冲突或配额失败都会整批回滚。 |

使用 `draft/`、`settings/`、`works/` 等键前缀划分业务空间，配合 `list({ prefix })` 检索。
键名限 1–160 个 ASCII 字符，可用字母、数字、`.`、`_`、`:`、`/`、`-`，不能包含 `..`。
建议统一小写，避免依赖排序规则对大小写的处理差异。前缀只组织当前用户的数据，不提供跨用户共享权限。

```ts
// 批量恢复列表，不逐键请求。
const page = await app.storage.list({ prefix: 'works/', limit: 40 })
const works = page.keys.length ? await app.storage.getMany(page.keys) : {}
// page.nextCursor 存在时，可作为下次 list 的 cursor。

// 详情和索引一起提交。
await app.storage.batch([
  { op: 'put', key: 'works/example', value: { title: '示例', taskId: 'task-id' } },
  { op: 'put', key: 'indexes/works', value: ['example'] },
])

// 保护读取后更新：已有记录须匹配版本，缺失记录仅允许创建。
const entry = await app.storage.getEntry<{ title: string }>('draft/current')
try {
  await app.storage.set('draft/current', { title: '新标题' }, {
    expectedRevision: entry?.revision ?? 0,
  })
} catch (error) {
  if (error instanceof AppSdkError && error.code === 'APP_STORAGE_CONFLICT') {
    // 重新读取服务端数据，合并用户修改后再提交；不要改成无条件覆盖。
    throw new Error('草稿已在其他窗口更新，请重新加载并合并修改')
  }
  throw error
}
```

不传 `expectedRevision` 时采用最后一次成功写入的值。传 `0` 表示仅创建，正数表示必须匹配
当前版本；条件删除只接受正数。`revision` 是服务端分配的安全整数，删除重建也不会复用，
不要假设从 1 开始或连续加 1。批量操作同样支持 `expectedRevision`。

SDK 每次写入调用默认生成新的幂等键。如果网络中断导致无法确定保存结果，应用重试时须传入
同一个 `idempotencyKey`，并保留原值、操作顺序和 `expectedRevision`。服务端在同一应用、同一用户下
保存成功操作的回执，24 小时内重复请求返回原结果及原版本号，不再次写入。回执与数据在同一事务提交，
服务重启不影响重试；每次重试仍检查当前会话和权限。超过窗口不保证回执重放，仍受版本条件保护。

幂等回执有独立容量预算：每位用户在所有应用合计最多 50,000 条有效回执、64 MiB 回执结果 JSON。
过期回执不占此预算；已存在回执的重放不受预算影响。超额的新操作会返回
`APP_STORAGE_QUOTA_EXCEEDED` 并整笔回滚，须等待回执过期后再提交，删除业务键不会释放回执预算。

```ts
const entry = await app.storage.getEntry('draft/current')
const value = { title: '新标题' }
const options = {
  expectedRevision: entry?.revision ?? 0,
  idempotencyKey: crypto.randomUUID(),
}
// 如响应丢失，保留 value 和 options，用同一次操作重试。
await app.storage.set('draft/current', value, options)
```

幂等键为 1–128 个 ASCII 字母、数字或 `.`、`_`、`:`、`-`。同键提交不同操作会返回
`APP_STORAGE_IDEMPOTENCY_CONFLICT`；修改内容后应创建新的操作和幂等键。不要通过获取新版本号后
盲目重试旧内容来解决冲突。幂等重放只确认原操作结果，并不表示数据此后未被其他操作更新。

单个值序列化后最多 256 KiB，整个批量 JSON 请求最多 1 MiB；容量按 JSON 的 UTF-8 字节计数，
包括多字节字符。默认每位用户在所有应用合计最多 10,000 个键、64 MiB。
配额按批次最终状态检查，因此满额时可以在一个事务内删除旧键并新增替代键。
容量策略调整后仍允许删除。存储请求需要有效应用会话，并受键数量、容量和载荷大小约束；不使用应用层请求频率限制。
模型和平台桥接调用的频率超限返回 `APP_RATE_LIMITED`。

| HTTP 状态 / 错误码 | 处理方式 |
| --- | --- |
| `409 APP_STORAGE_CONFLICT` | 重新读取、合并后有条件提交。 |
| `409 APP_STORAGE_IDEMPOTENCY_CONFLICT` | 同一幂等键被用于不同操作；修正客户端操作标识的复用方式。 |
| `403 APP_STORAGE_QUOTA_EXCEEDED` | 业务数据超额时清理不用的键或调整容量；幂等回执超额时等待有效回执过期。重复提交不会解决容量问题。 |
| `413 PAYLOAD_TOO_LARGE` | 缩小值或拆分批次；拆分后的多个请求不构成一个事务。 |
| `429 APP_RATE_LIMITED` | 合并批量读取、节流自动保存，参考 `Retry-After` 响应头退避重试。 |
| `500 APP_STORAGE_UNAVAILABLE` | 保留当前编辑，稍后重试；不要因此清空已有作品。 |

### HTTP 资源与响应

#### 地址职责

Canvas 使用两个后端平面。平台源地址和模型数据网关不是同一个地址，不能把所有请求都拼到
`api.duckingmind.com`：

| 能力 | 请求根地址（生产） | 鉴权 | 服务职责 |
| --- | --- | --- | --- |
| Portal、应用市场、安装、授权和创建 App Session | `https://www.duckingmind.com/api/...` | Portal 页面使用登录 Cookie；应用会话换票使用 HttpOnly 设备 Cookie | `codex-admin-api` 控制面 |
| 应用身份预检 | `https://api.example.com/v1/profile` | `Bearer ast_*` App Session | `llm-gateway` 数据面；应用不访问 `/auth/*` 或宿主控制面 |
| 应用函数请求和任务 | Session 的 `gateway_url` 下的 `/v1/app-runtime/*` | `Bearer ast_...` App Session | `codex-llm-gateway` → 私有 Runtime Host |
| 用户 KV Storage | Session 的 `gateway_url` 下的 `/v1/storage/*` | `Bearer ast_...` App Session 或用户 API Key | `codex-llm-gateway` |
| 模型、图片、视频、响应流和媒体资产 | Session 返回的 `gateway_url`，当前为 `https://api.duckingmind.com/v1` | `Bearer ast_...` App Session | `codex-llm-gateway` 数据面 |

`www` 是当前平台源地址的历史命名；它承载官网页面，同时由 Ingress 将 `/api` 转给 Admin API。
`api` 当前只暴露模型网关的 `/v1` 和 `/responses` 路径。应用必须使用 App Session 返回的
`gateway_url`，不要自行把平台源地址改成网关地址，也不要把内部 `runtime.gateway_base_url`
返回浏览器。私有部署只需要替换平台源地址和 Session 返回的网关地址，路径职责不变。

因此，下面两个 `storage` 不是同一个接口：

- `/v1/storage/*` 是 Gateway 的 KV 接口。App Session 访问应用隔离空间；普通用户 API Key 访问独立的用户空间；两种命名空间不会串读；
- `/v1/media/storage/usage` 是媒体文件空间用量，属于 Gateway 媒体数据面，使用 `client.api` 调用。

应用函数使用同一个 Gateway 数据面凭证：

```text
POST /v1/app-runtime/request
POST /v1/app-runtime/tasks
GET  /v1/app-runtime/tasks/{id}
POST /v1/app-runtime/tasks/{id}/cancel
```

`app_id`、`app_version` 和 `user_id` 由 Gateway 从 `ast_*` App Session 推导，应用请求不能
自行提交或覆盖。一次性函数的输入输出、任务状态、幂等键和错误处理见
[`应用运行时开发接口`](../../llm-gateway-go/docs/APP_RUNTIME_API.md)。旧的 Admin
`/api/app-runtime/v1/*` 业务代理已下线。

SDK 已按上述边界路由请求：`app.storage.*` 使用 `session.gateway_url` 下的 Gateway 路径，
`app.api.request(...)` 和 `app.api.stream(...)` 也使用 `session.gateway_url`。应用同源时可以使用相对路径；
独立静态域名不得把自身资源域名当作 API 域名。

KV 公开接口以 Gateway 的 `/v1` 为基础路径。SDK 使用 `app.storage.*`，不要通过
`app.api.request('/storage/items')` 调用；`app.api.request('/media/storage/usage')` 是媒体空间用量接口。

| 请求 | 返回的 `data` |
| --- | --- |
| `GET /storage/items?key=...` | JSON 值或 `null`。 |
| `GET /storage/items?key=...&include_metadata=true` | 值和元数据或 `null`。 |
| `GET /storage/items?keys=...&keys=...` | 键到值的映射；单个 `keys` 也返回映射。 |
| `GET /storage/items?keys=...&keys=...&include_metadata=true` | 键到值及元数据的映射，缺失键对应 `null`。 |
| `GET /storage/keys?prefix=...&cursor=...&limit=100` | `{ keys, next_cursor }`，末页游标为空字符串。 |
| `PUT /storage/items?key=...` | 请求 `{ value, expected_revision? }`，返回 `{ success, revision }`。 |
| `DELETE /storage/items?key=...&expected_revision=...` | `{ success }`。条件参数可省略。 |
| `POST /storage/batch` | 请求 `{ operations: [{ op, key, value?, expected_revision? }] }`，返回 `{ results }`。 |

读取时选择 `key` 或重复的 `keys` 参数，不能混用。批量读取使用 `keys=a&keys=b`，不要传 JSON
数组或逗号分隔值。`include_metadata=true` 可用于单个 `key` 或批量 `keys`。写入时 `value` 必填，支持任意 JSON
值，包括 `null`，不支持 `undefined`。所有参数都应使用 `URLSearchParams` 等工具进行 URL 编码。

HTTP 写入、删除及批量操作可在 `Idempotency-Key` 请求头中传幂等键；省略时仍兼容原有调用，
但无法确认响应丢失的成功操作。Bridge 使用原有 `storage.user.set`、`storage.user.delete`、
`storage.user.batch`，在 payload 顶层传 `idempotency_key`；批量元数据读取使用原有
`storage.user.get_many`，附加 `include_metadata: true`，没有新增接口或 Bridge 方法。

分页时原样传回 `next_cursor`，并保持 `prefix` 不变；空字符串表示末页。分页不是固定数据快照，
列表和后续批量读取之间记录可能已被删除，需处理 `null`。

单值读取：

```json
{"data":{"theme":"dark"},"request_id":"req_123"}
```

带元数据读取（示例版本号仅展示格式，以实际返回值为准）：

```json
{"data":{"key":"profile/settings","value":{"theme":"dark"},"revision":12,"updated_at":"2026-09-13T08:00:00Z"},"request_id":"req_124"}
```

批量读取：

```json
{"data":{"profile/settings":{"theme":"dark"},"draft/title":null},"request_id":"req_125"}
```

分页列出键（末页示例）：

```json
{"data":{"keys":["profile/settings"],"next_cursor":""},"request_id":"req_130"}
```

写入：

```json
{"data":{"success":true,"revision":13},"request_id":"req_126"}
```

删除：

```json
{"data":{"success":true},"request_id":"req_127"}
```

批量操作（结果与请求顺序一致，删除结果不含 `revision`）：

```json
{"data":{"results":[{"key":"draft/title","success":true,"revision":14},{"key":"draft/old","success":true}]},"request_id":"req_128"}
```

### 直接 HTTP 调用

线上 KV 请求使用 Session 返回的 `gateway_url`，路径为 `/v1/storage/*`。应用级 KV 每次请求携带用户 App Session；用户级 KV 也可使用已验证的用户 API Key。使用 direct runtime 时，`app.user.getProfile()` 通过 Gateway `GET /v1/profile` 读取最小资料；宿主控制面方法的运行时边界见上面的“用户资料与存储”。
有 JSON 请求体时设置 `Content-Type`：

```http
Authorization: Bearer <App Session>
Accept: application/json
Content-Type: application/json
```

App Session 由平台应用授权流程提供，以 `ast_` 开头，默认有效期为 30 天；普通模型 API Key、CLI 发布令牌
和平台登录 Cookie 不能代替它。不要在源码、URL、日志或浏览器持久化存储中保存 Session。
应用页面与平台同源时可使用相对路径；如果应用静态资源来自独立域名，应使用平台提供的运行时地址，
不要将资源域名当作 API 域名。

本地使用 `proxy-app dev` 和 Vite 代理，代理会为相同路径附加有效会话，无需在前端写入令牌。
本地存储仍由所连接的平台持久保存；相同平台、应用和用户共用数据，测试建议使用单独的应用或键前缀。

以下 curl 示例用于已取得 App Session 的独立 HTTP 客户端。`PLATFORM_ORIGIN` 表示平台源地址
（如 `https://platform.example`，不含 `/api`），`APP_SESSION` 表示当前应用会话，不是发布凭证。独立 HTTP 客户端需要自行重新获取到期会话。
条件写入示例使用 `jq` 从前一次响应提取版本号。

读取单个值（键不存在时 `data` 为 `null`）：

```bash
curl "$GATEWAY_URL/storage/items?key=profile%2Fsettings" \
  -H "Authorization: Bearer $APP_SESSION" \
  -H "Accept: application/json"
```

写入并获取新版本号：

```bash
curl -X PUT "$GATEWAY_URL/storage/items?key=profile%2Fsettings" \
  -H "Authorization: Bearer $APP_SESSION" \
  -H "Content-Type: application/json" \
  -d '{"value":{"theme":"dark"}}'
```

保护并发更新时，先读取元数据，再将返回的 `revision` 作为 `expected_revision`；缺失时使用 `0`
表示仅创建。版本不匹配会返回 `409 APP_STORAGE_CONFLICT`：

```bash
KV_ENTRY=$(curl --fail-with-body "$GATEWAY_URL/storage/items?key=profile%2Fsettings&include_metadata=true" \
  -H "Authorization: Bearer $APP_SESSION") || exit 1
KV_REVISION=$(printf '%s' "$KV_ENTRY" | jq -er 'if has("data") then (.data.revision // 0) else error("invalid response") end') || exit 1
KV_WRITE=$(curl --fail-with-body -X PUT "$GATEWAY_URL/storage/items?key=profile%2Fsettings" \
  -H "Authorization: Bearer $APP_SESSION" \
  -H "Content-Type: application/json" \
  -d "{\"value\":{\"theme\":\"light\"},\"expected_revision\":$KV_REVISION}") || exit 1
KV_REVISION=$(printf '%s' "$KV_WRITE" | jq -er '.data.revision') || exit 1
```

删除键（使用上例写入后返回的新版本号；省略条件参数则无条件删除）：

```bash
curl -X DELETE "$GATEWAY_URL/storage/items?key=profile%2Fsettings&expected_revision=$KV_REVISION" \
  -H "Authorization: Bearer $APP_SESSION" \
  -H "Accept: application/json"
```

按前缀分页列出键：

```bash
curl "$GATEWAY_URL/storage/keys?prefix=profile%2F&limit=100" \
  -H "Authorization: Bearer $APP_SESSION" \
  -H "Accept: application/json"
```

批量写入或删除最多 100 个操作，整批成功或整批失败：

```bash
curl -X POST "$GATEWAY_URL/storage/batch" \
  -H "Authorization: Bearer $APP_SESSION" \
  -H "Content-Type: application/json" \
  -d '{"operations":[
    {"op":"put","key":"draft/title","value":"示例"},
    {"op":"delete","key":"draft/old"}
  ]}'
```

成功响应统一为 `{ "data": ..., "request_id": "..." }`，SDK 方法直接返回 `data`。错误响应统一为
`{ "error": { "code": "...", "message": "..." }, "request_id": "..." }`。SDK 将请求参数
`expectedRevision` 转换为 HTTP 的 `expected_revision`，将响应中的 `updated_at` 和 `next_cursor`
转换为 `updatedAt` 和 `nextCursor`。`request_id` 可用于排查失败请求，请在客户端日志
中保留它，但不要记录 App Session 或完整数据值。

HTTP 错误示例：

```json
{"error":{"code":"APP_STORAGE_CONFLICT","message":"storage revision conflict"},"request_id":"req_129"}
```

除前述容量和并发错误外，还需处理：

| HTTP 状态 / 错误码 | 含义与处理 |
| --- | --- |
| `400 APP_INVALID_REQUEST` | 检查键名、参数组合、JSON 值、批量操作数量和版本号。 |
| `401 APP_SESSION_INVALID` | 会话缺失或无效；检查运行时配置，重新通过平台应用授权流程获取会话。 |
| `401 APP_SESSION_EXPIRED` | 当错误中同时有 `execution_started: false` 时，可刷新会话并重试一次，无需每次重新登录。 |
| `403 APP_SESSION_REVOKED` / `APP_DISABLED` | 会话已撤销或应用被停用；停止重试，重新检查应用授权或应用状态。 |
| `403 APP_PERMISSION_DENIED` | 当前会话未包含 `storage.user` 宿主权限。检查平台会话和权限配置；Gateway 模型 scope 不由 `manifest.apis` 决定。 |
| `403 APP_SHARED_STORAGE_DENIED` | 当前应用未被平台启用公共空间，或会话不是绑定用户的 App Session；公共空间由服务端策略决定，前端不能开启。 |
| `409 APP_VERSION_CHANGED` | 请求的 `X-App-Version` 与会话版本不匹配；重新打开对应版本并获取匹配会话。 |

SDK 参数校验也可能抛出 `APP_STORAGE_INVALID_KEY`、`APP_STORAGE_INVALID_REVISION` 或
`APP_STORAGE_INVALID_OPERATION`，这些客户端错误没有 HTTP 状态，应修正参数后再调用。

写请求响应丢失时结果可能已提交，SDK 不会自动重放。24 小时内可保留相同的值、操作顺序、
版本条件和 `Idempotency-Key` 重试，以读取原成功回执；内容变化需要新操作标识。
版本条件用于防止覆盖其他窗口的修改，幂等回执用于确认同一次操作，二者不能互相替代。
不要把读取失败当作数据缺失。

### 应用公共 KV 空间

需要让同一个应用的所有已登录用户看到同一批数据时，使用 `app.sharedStorage.*`。公共空间的实际键只有 `app_id + key`：平台从签名的 App Session 推导 `app_id`，用户 ID 只用于认证、审计和限流，不参与公共键。个人空间仍然是 `app_id + user_id + key`；两种空间使用不同的 SDK 能力和 HTTP 路径，不能互相串读。

公共空间是否可用由平台数据库中的应用策略决定（`shared_storage_enabled`）。应用 manifest、前端配置和请求体都不能开启、关闭或改写该策略；默认应用关闭，只有平台审核并启用的应用可用。公共空间仍要求有效的绑定用户 App Session，不能把浏览器提交的 `scope`、`namespace`、`user_id`、`app_id`、`owner_id` 或 `owner_type` 当作作用域。需要未登录访客读取时，应另设平台控制的只读公开接口，不能把 App Session KV 变成匿名写入接口。

```ts
const page = await app.sharedStorage.list({ prefix: 'pelican/results/', limit: 100 })
const entries = page.keys.length ? await app.sharedStorage.getEntries(page.keys) : {}
await app.sharedStorage.set('pelican/results/result-1', { html: '<svg>...</svg>' }, {
  expectedRevision: 0,
  idempotencyKey: crypto.randomUUID(),
})
```

公共空间的读取、键名、单值与批量大小、版本条件和分页规则与个人 KV 相同。单项写入和批量写入支持幂等重放：SDK 将 `idempotencyKey` 发为 `Idempotency-Key` 请求头，重试必须复用原始幂等键、值、操作顺序和 `expectedRevision`；同一应用下不同用户共用该回执。回执保留 24 小时；不同请求复用同一幂等键会返回 `APP_STORAGE_IDEMPOTENCY_CONFLICT`。共享批量请求在一个事务中提交，任一操作校验、版本冲突或配额失败都会整批回滚。公共浏览器运行时不允许删除共享键，避免任意用户移除所有用户可见的结果；清理由平台后台执行。

公共数据在每个应用下最多保存 10,000 个键和 64 MiB JSON；应用级有效幂等回执最多 50,000 条和 64 MiB。超额写入返回 `APP_STORAGE_QUOTA_EXCEEDED`，并回滚整项或整批；已存在的回执仍可重放。公共画廊由服务端强制追加和读取，浏览器用户不能删除会影响全体用户的键。元数据中的作者 ID 和展示名由服务端根据执行写入的 App Session 记录，不读取客户端 value 中的用户字段。

公共 HTTP 资源使用 App Session 返回的 `gateway_url`：

| 请求 | 返回的 `data` |
| --- | --- |
| `GET /storage/shared/items?key=...` | JSON 值或 `null`。 |
| `GET /storage/shared/items?key=...&include_metadata=true` | 值和元数据或 `null`。 |
| `GET /storage/shared/items?keys=...&keys=...` | 键到值的映射；附加 `include_metadata=true` 返回条目元数据。 |
| `GET /storage/shared/keys?prefix=...&cursor=...&limit=100` | `{ keys, next_cursor }`。 |
| `PUT /storage/shared/items?key=...` | 请求 `{ value, expected_revision? }`，返回 `{ success, revision }`；支持 `Idempotency-Key`。 |
| `DELETE /storage/shared/items?key=...&expected_revision=...` | 浏览器运行时固定返回 `403 APP_SHARED_STORAGE_DELETE_DENIED`；公共键清理由平台后台执行。 |
| `POST /storage/shared/batch` | 请求 `{ operations: [...] }`，返回 `{ results }`；支持 `Idempotency-Key`。 |

这些路径不接受作用域字段。无效或未启用公共策略返回 `403 APP_SHARED_STORAGE_DENIED`；浏览器删除共享键返回 `403 APP_SHARED_STORAGE_DELETE_DENIED`；会话缺失或失效仍返回相应的 `APP_SESSION_*` 错误。公共空间错误响应同样包含 `request_id`，应用应保留请求编号，不能把失败误显示为“没有结果”。

### 团队工作空间 KV

需要让同一团队的成员共同读取和维护应用数据时，使用 `app.workspaceStorage.*`。团队 KV 的逻辑键为
`app_id + workspace_id + key`，与个人 KV（`app_id + user_id + key`）和应用公共 KV（`app_id + key`）分别隔离。
它适用于团队内共享的项目状态、协作草稿和团队配置；要求“这个应用的所有用户都看到相同数据”时仍应使用
`app.sharedStorage.*`，不能把整个应用公共空间误当成当前团队空间。

工作空间由 Portal 在启动应用时选择和校验：Portal 检查工作空间存在且处于 active 状态、用户仍是成员，
并只允许 team 类型工作空间作为团队 KV 上下文，然后将已验证的上下文绑定到 App Session。Gateway 每次请求都
从服务端会话推导 workspace ID 并重新检查成员关系；应用不能通过 `X-Workspace-ID`、`workspace_id` 查询参数、
manifest、SDK 参数或 JSON 请求体选择或替换工作空间。个人空间、无绑定上下文、非成员或已归档空间都不能访问团队 KV。

```ts
// 当前团队由 Portal 在打开应用时绑定；方法不接受 workspace_id。
const page = await app.workspaceStorage.list({ prefix: 'project/', limit: 100 })
const entries = page.keys.length ? await app.workspaceStorage.getEntries(page.keys) : {}
const draft = await app.workspaceStorage.getEntry<{ title: string }>('project/draft')
await app.workspaceStorage.set('project/draft', { title: '团队草稿' }, {
  expectedRevision: draft?.revision ?? 0,
  idempotencyKey: crypto.randomUUID(),
})
await app.workspaceStorage.delete('project/obsolete', { expectedRevision: 3 })
```

团队成员拥有团队空间的读、写、批量操作和按版本删除能力。单值 / 批量限制、revision、CAS 和 24 小时幂等回执遵循
Gateway KV 通用规则；冲突时重新读取并合并，响应丢失时使用原幂等键和完全相同的操作重试。`getEntry()` 和
`getEntries()` 返回的作者 ID、展示名和更新时间由服务端从执行写入的 App Session 记录，不读取 JSON 值中的作者字段。

团队 HTTP 资源使用 App Session 对应的 Gateway：

| 请求 | 返回的 `data` |
| --- | --- |
| `GET /storage/workspace/items?key=...` | JSON 值或 `null`。 |
| `GET /storage/workspace/items?key=...&include_metadata=true` | 值、revision、更新时间与服务端作者元数据，缺失键为 `null`。 |
| `GET /storage/workspace/items?keys=...&keys=...` | 键到值的映射；附加 `include_metadata=true` 返回条目元数据。 |
| `GET /storage/workspace/keys?prefix=...&cursor=...&limit=100` | `{ keys, next_cursor }`。 |
| `PUT /storage/workspace/items?key=...` | 请求 `{ value, expected_revision? }`，返回 `{ success, revision }`；支持 `Idempotency-Key`。 |
| `DELETE /storage/workspace/items?key=...&expected_revision=...` | `{ success }`；成员可以删除团队数据，建议带上从 `getEntry()` 读取的 revision。 |
| `POST /storage/workspace/batch` | 请求 `{ operations: [...] }`，返回 `{ results }`；支持 `Idempotency-Key`，整批事务提交。 |

这些路径不接受 workspace ID 或作用域字段。当前绑定会话失效或成员身份变化时，Gateway 返回明确错误和 `request_id`；
应用应将拒绝访问与键不存在区分处理。SDK 为此提供 `app.workspaceStorage.get/getEntry/getMany/getEntries/list/set/delete/batch`，
所有调用都使用平台绑定的当前团队上下文。

图片、视频和大文件应由平台媒体资产服务保存。KV 只保存 `taskId`、资产 ID 和小型 JSON 元数据，
不能上传文件或自动刷新媒体地址。不要把 Base64、大文件或短期签名 URL 作为永久数据写入 KV；
展示时通过相应任务或资产接口重新取得可用地址。KV 不提供客户端可选的 TTL、独立 namespace 参数或 ETag / If-Match；需要跨用户共享时使用上面的服务端控制公共空间。

## 模型与媒体请求

`app.api.request` 接受平台公开的相对路径，并可返回 JSON、文本、二进制数据或原生 `Response`。

```ts
const models = await app.api.request('/models')

const result = await app.api.request('/responses', {
  method: 'POST',
  body: JSON.stringify({
    model: 'model-id-from-platform',
    input: '写一段简短的欢迎语。',
  }),
})

// 任务完成后使用响应中的 asset_id，并从媒体资产接口获取短期签名 URL。
const asset = await app.api.request('/media/assets/asset-id')
const video = await fetch(asset.url)
```

支持的请求类型包括模型目录、文本生成、消息生成、图片生成与编辑、视频、音乐和音色设计任务。`/embeddings`、TTS 以及视频、音乐、音色的历史 `/content` 代理不属于当前 Gateway 数据面；媒体完成后使用 `asset_id` 或服务端返回的短期签名 URL。实际模型与操作范围取决于用户账户权益、模型目录和 Gateway 路由策略；App Session scope 当前不对已 allow-list 的接口逐项限权，`manifest.apis` 用于兼容性描述。应用不能指定上游服务商，也不能提交服务商凭证。

视频创建响应丢失时，可用 `GET /videos/by-idempotency-key/{key}` 只读查找原任务，
无需重新上传参考图。`key` 是创建时发送的原始 `Idempotency-Key`，支持 1–128 位
字母、数字、点、下划线、冒号和连字符，首位须为字母或数字。接口要求视频读取权限，
按当前用户和应用隔离；关闭新建路由后仍可读取，成功响应与 `GET /videos/{id}` 一致。
只有 `404 video_task_not_found` 表示当前没有查到任务；它不取消仍在途的提交。
保留原提交键与参数，不能据此换键重复生成。登录、网络或接口不可用均不能视为未受理。

音乐创建响应丢失时，可用 `GET /music/by-idempotency-key/{key}` 按创建时的原始
`Idempotency-Key` 找回任务。查询只需要 `platform.music.read`，按当前用户和应用隔离，
不会重新生成或取消任务；`404 music_task_not_found` 只表示当前没有可见记录。完成任务的
响应包含稳定 `asset_id`，以及可能过期的 `content_url`；重新打开画布后应通过任务接口或
`GET /media/assets/{id}` 获取新的交付地址，不能把签名 URL 永久写入 KV。

音色设计是当前公开的音频能力。它返回可复用的 `voice_id` 和试听资产；平台当前不提供 TTS 创建、查询、取消或内容下载路由：

```ts
const voices = await app.api.request('/voice-design/models')
const voice = await app.api.request('/voice-design/generations', {
  method: 'POST',
  headers: { 'Idempotency-Key': crypto.randomUUID() },
  body: JSON.stringify({ model: 'minimax-voice-design', prompt: '温暖清晰的青年声音', preview_text: '你好，欢迎来到创作空间。' }),
})
// 轮询 voice-design/tasks/{id}，成功后保存结果中的 voice_id。
```

音色设计支持按幂等键找回任务和取消；完成任务返回的试听资源使用 `asset_id` 或签名 URL。历史 TTS 数据仅用于内部审计，不能通过通用 SDK 重新提交或下载。

图片同步创建遇到连接中断时，服务可能返回 `202` 和 `status: "unknown"`，并附带
`task_id`、`polling_url`、`reconciliation_state: "pending"`。应用应保存任务标识并通过
`GET /images/tasks/{id}` 查询，不能重新提交原图片请求。若响应本身丢失，可用
`GET /images/by-idempotency-key/{key}` 按原始 `Idempotency-Key` 找回任务；查询按当前用户和应用隔离。

应用身份调用图片生成/编辑时，同步成功响应在 `created` / `data` 基础上增加 `task_id`，
每个结果增加 `asset_id`。应用应持久保存这些标识，随后通过图片任务或 `GET /media/assets/{id}`
获取新 URL，不能永久保存当前签名地址。普通非应用 API 调用仍使用原有 OpenAI 图片响应形状。

### 媒体资产管理

图片、视频和音乐任务完成后，平台会托管生成的媒体资产。应用可通过 `app.api.request()` 管理
当前应用和用户范围内的资产；这些接口需要 `platform.images.read` 权限。资产列表中的 `url` 是
短期地址，不能写入 KV 作为永久链接，过期后应重新读取列表或任务结果。

应用可以使用 SDK 的 `uploadApplicationMediaAsset()` 保存需要长期恢复或重复使用的图片、视频或音频，文件最大 100 MiB。
SDK 通过 `POST /media/assets/upload-intents` 获取短期对象存储 PUT 地址，再确认上传；只有旧 Gateway 明确没有直传路由时才兼容 multipart。
COS 或确认服务故障不会让 SDK 把文件再发一次到 Gateway。响应返回稳定的资产 `id` 和短期 `url`；应用应保存 `id`，预览或复用时通过
`GET /media/assets/{id}` 刷新地址，不要把文件或 Base64 内容写入 KV。只供一次上游请求使用的图片编辑参考图可直接以 multipart 发送到
`POST /v1/images/edits`，无需先创建可复用媒体资产。

| 请求 | 说明 |
| --- | --- |
| `GET /v1/media/storage/usage` | 查询媒体空间用量：`used_bytes`、`reserved_bytes`、`quota_bytes`、`available_bytes`、`status`。用量是用户配额汇总，资产访问仍按应用隔离。 |
| `POST /v1/media/assets/upload-intents` | 为持久化媒体申请对象存储直传意图，仅提交文件元数据。 |
| `PUT upload_url` | 将媒体字节直接上传至短期签名的对象存储地址。 |
| `POST /v1/media/assets/{id}/complete` | 验证对象元数据并完成资产托管。 |
| `POST /v1/media/assets` | 兼容未提供直传路由的旧 Gateway multipart 上传。 |
| `GET /v1/media/assets?page=1&limit=20` | 分页列出当前应用和用户的已保存资产，返回 `items`、`total`、`page`、`limit`。 |
| `DELETE /v1/media/assets/{id}` | 删除当前应用和用户拥有的资产，成功返回 `{ deleted: true }`。删除不可逆。 |

```ts
const usage = await app.api.request('/media/storage/usage')
const assets = await app.api.request('/media/assets?page=1&limit=20')
await app.api.request('/media/assets/asset_01J...', { method: 'DELETE' })
```

资产接口只允许访问当前应用和当前用户的数据。删除后用量可能短暂延迟更新；资产地址失效时不要
重试删除或继续使用旧 URL，应重新获取资产或任务内容。

### 网页宿主图片缓存（可选能力）

旧版 opaque iframe 宿主使用隔离源，不能依赖 iframe 自己的 IndexedDB 跨刷新保存图片；当前 Web 应用通过 Portal 登录取得 App Session，再直连 Gateway。
支持图片缓存的网页宿主会在 `app.session()?.host_capabilities` 中公布 `media.image.readCached`。
能力存在时，可通过现有桥接读取当前账户和应用拥有的图片：

```ts
if (app.session()?.host_capabilities?.includes('media.image.readCached')) {
  const { blob } = await app.platform.call<{ blob: Blob; assetId: string; taskId: string }>(
    'media.image.readCached',
    { assetId: 'asset_01J...' },
  )
  // blob 仅用于当前页面展示；云端仍只保存素材/任务标识。
}
```

也可传入 `{ taskId, resultIndex }`；多图任务必须明确结果序号。不能传入 URL、用户或应用标识。
该能力需要当前会话的图片读取权限（或包含读取能力的图片生成权限），每次读取都会先向 Gateway
校验素材访问权限；命中缓存后不再下载图片正文。缓存按账户、应用和素材隔离，不保存会话凭证。
当前单图上限为 16 MiB，总缓存最多 64 张、128 MiB，超限时淘汰较早写入的条目。

宿主未公布该能力或缓存调用失败时，应用应继续通过标准资产/任务 API 获取可用 URL。
`host_capabilities` 仅描述当前宿主的可选服务，不是服务器授权；不能把此缓存当作云端持久存储。

### 流式响应

使用 `stream` 接收服务端事件流：

```ts
for await (const event of app.api.stream('/responses/stream', {
  method: 'POST',
  body: JSON.stringify({ model: 'model-id', input: '请流式输出答案。' }),
})) {
  if (event.data) console.log(event.data)
}
```

SDK 会把每个事件解析为 `{ event?, data }`。服务端发送结束事件后停止读取，并为长时间请求提供取消操作。

## 会话与错误

已发布应用通过 Portal 登录获取绑定应用及版本的短期 `ast_*` App Session：Portal 使用 HttpOnly 设备 Cookie 换票，再将 App Session 交给当前标签页。应用只把该会话附加到 Gateway `/v1/*` 请求中；设备 Cookie 不会暴露给应用代码，App Session 只保存在当前标签页 `sessionStorage`。`proxy-app dev` 的本地页面也通过 Portal 登录弹窗获取绑定草稿版本的会话，Vite 只代理 Gateway `/v1`。

平台错误会抛出 `AppSdkError`，包含稳定的 `code`，以及可选的 HTTP `status`、`requestId` 和结构化 `details`：

```ts
import { AppSdkError } from '@ducking-mind/proxy-app-sdk'

try {
  await app.api.request('/models')
} catch (error) {
  if (error instanceof AppSdkError && error.code === 'APP_LOGIN_REQUIRED') {
    // 显示登录按钮，在用户点击回调中打开 Portal 弹窗。
    console.log('显示“登录平台”按钮')
  }
}
```

网页应用应在用户点击登录按钮时调用 `app.auth.login()`，随后用 `app.platform.createSession()` 重新校验会话。

启动时使用 `app.platform.createSession()` 或 `app.auth.status()` 完成会话预检；网页应用通过 Portal 登录获取 App Session，再由 Gateway `GET /v1/profile` 校验。Portal Cookie 只在 Portal 域内使用；Vite 只代理 Gateway `/v1`。网络、代理配置或资源加载失败应提供重试，不要直接当成未登录。

## 本地开发

安装 CLI 后启动应用：

```bash
npm install --global @ducking-mind/proxy-app-cli
proxy-app dev apps/my-app
```

在 `vite.config.ts` 中注册 SDK 的开发代理：

```ts
import { defineConfig } from 'vite'
import { createPlatformDevProxy } from '@ducking-mind/proxy-app-sdk/vite'

export default defineConfig({
  base: './',
  server: { proxy: createPlatformDevProxy() },
})
```

开发代理只用于本地调试，不会进入发布包，也不替代平台的线上运行环境。

CLI 会先完成开发者授权、应用绑定与 manifest 检查，再启动应用。首次缺少开发授权时，
终端提供授权入口；登记失败在终端报错并阻止应用启动。更换开发账户使用
`proxy-app dev apps/my-app` 会自动复用有效的开发授权；如果缓存账户无权访问应用，CLI 会清除开发授权并请求一次新的创建者授权。应用内用户登录不会执行开发登记。

macOS 仅将开发者授权保存在系统钥匙串，按平台、应用和项目目录隔离。每次启动重新检查开发权限；CLI 不预取或保存用户 App Session。浏览器打开本地应用后通过 Portal 登录弹窗获取会话，并仅在当前标签页 `sessionStorage` 中保存。其他系统或钥匙串不可用时，CLI 只在进程内保存开发者授权，不会把 token 写入项目文件。使用 `proxy-app dev apps/my-app --no-auth-cache` 可禁用开发者授权的持久缓存。

## 安全与兼容

只使用本文和 SDK 文档列出的应用 API。不要读取平台浏览器存储、调用管理接口、嵌入私有地址，或把账户凭证提交到代码仓库。发布前请更新依赖并校验 manifest。

SDK 保留对历史嵌入式应用的有限兼容。新应用使用统一的 `index.html` 入口和 HTTP 客户端；运行模式由平台和宿主决定，不在 manifest 中声明已废弃的 `runtime`、`desktop` 或 iframe 字段。
