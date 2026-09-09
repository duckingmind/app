# Proxy 应用开发规范

Proxy 应用当前兼容运行在平台 iframe 沙箱中的 v1 纯前端应用。迁移后的 v2 应用运行在
平台域名下的顶层页面，通过 `@codex/proxy-app-sdk` 的 HTTP 运行面调用平台服务，不依赖
AppHost 或 Bridge。

> **协议状态**：本文已有 Bridge 表格和路径描述属于 v1 旧包兼容契约；v2 目标设计见
> [HTTP_RUNTIME_DESIGN.md](HTTP_RUNTIME_DESIGN.md)。v2 本地 `proxy-app dev` 只做
> `/v1/*`、`/api/app-runtime/v1/*` 的 HTTP 代理，`/__platform/bridge` 不属于 v2 依赖。

模型、媒体等高吞吐开放接口的跨项目边界见 [`APP_API_OPENING.md`](./APP_API_OPENING.md)。

## 快速流程

```text
proxy-app init
→ npm install
→ 本地开发和构建
→ proxy-app create（平台自动生成应用标识）
→ proxy-app upload（上传版本）
→ proxy-app publish（提交审核）
→ 审核通过后进入应用市场
```

`init` 只生成本地临时标识，便于 Bridge 在开发阶段运行；`create` 才会向平台注册应用并绑定平台生成的标识。不要把本地临时标识当作正式应用 ID。

应用标识由平台生成，应用拥有者不需要填写反向域名。CLI 会把返回的公开 `slug` 写入 `manifest.id`，并将内部 `app_id` 保存在 `.proxy-app.json`。该文件禁止提交到 GitHub。

## 什么时候进入应用市场

上传版本不会立即上架。只有管理员审核通过后，版本才会成为线上版本，应用才会出现在应用市场：

```text
创建应用
→ 上传 ZIP
→ 测试版本
→ 配置商业化方式
→ 提交审核
→ 管理员审核通过
→ 自动进入应用市场
```

应用状态和版本状态分别表示不同事情：

| 范围 | 状态 | 含义 |
| --- | --- | --- |
| 应用 | 草稿 | 尚未有线上版本 |
| 应用 | 审核中 | 首个版本正在审核 |
| 应用 | 已上架 | 有一个版本正在市场提供 |
| 应用 | 已暂停上架 | 开发者暂时隐藏市场入口，已安装用户仍可使用 |
| 应用 | 平台已下线 | 平台停止市场展示和新安装 |
| 版本 | 待提交 | 已上传，等待开发者提交审核 |
| 版本 | 审核中 | 已提交，等待平台处理 |
| 版本 | 已发布 | 审核通过并可作为线上版本 |
| 版本 | 需修改 | 审核未通过，需要修复后重新上传 |

新版本审核期间，用户继续使用旧的线上版本。审核拒绝的是当前版本，不会自动下线已经发布的旧版本。上传包是不可覆盖的，修复代码后请提高 `manifest.version`，重新构建并上传。

### 应用包的存储与访问

应用上传后不会写入 `admin-api` 或 CDN 所在机器的本地目录。平台会校验 ZIP，
将包内文件按版本目录写入应用专用的公有 COS/CDN 源站，数据库只保存版本目录、
入口文件和校验值：

```text
上传 ZIP
  -> admin-api 校验并拆包
  -> 公有 COS/CDN apps/{app_id}/versions/{version}/...
  -> 审核通过后才向应用市场返回线上入口地址
```

线上访问链路是：

```text
浏览器 -> 公有 COS/CDN
```

应用市场仍然只展示审核通过的版本，不会把 COS 密钥返回给浏览器。需要注意：公有
桶意味着只要知道对象 URL，上传后的草稿资源也可以被直接访问；因此上传包必须经过
敏感文件校验，版本目录应使用不可猜测的应用 ID 和不可变版本号。如果必须做到“审核
前完全不可访问”，应改回私有桶 + 资源网关方案。

应用线上静态资源使用独立的公有 COS/CDN 桶。配置 `app_market.asset_storage` 后，
上传文件会写入该桶，并返回公有对象地址；`app_market.asset_storage.cdn_base_url`
可配置为自定义 CDN 域名。这个配置不能填写 `storage.cdn_base_url`：后者是
媒体对象存储 URL，不能和应用包混用。预览版本仍使用带签名的预览网关，不会进入公有桶。

本地目录 `storage.local_fallback_directory` 仅用于媒体生成失败时的临时兜底，
不参与应用包上传、发布或读取。生产环境不应依赖它保存应用静态文件。

## Manifest

```json
{
  "schema": "proxy.app/v1",
  "id": "app.proxy.20260829142209f046",
  "version": "0.1.0",
  "name": "Todo Demo",
  "description": "A Proxy app",
  "runtime": { "type": "iframe", "entry": "index.html" },
  "permissions": ["storage.user"],
  "apis": ["model.responses"],
  "backend": { "type": "platform" },
  "pricing": { "mode": "free", "currency": "CNY" }
}
```

必填字段：`schema`、`id`、`version`、`name`、`runtime.type`、`runtime.entry`。`backend.type` 固定为 `platform`，表示后端能力由平台提供，不需要自建 `app-backend` 服务。

`apis` 是可选的开放数据面声明，取值为 `model.responses`、`model.chat`、`model.messages`、`model.embeddings`、`model.images`、`model.videos` 或 `model.music`。声明只代表应用申请能力，实际可用范围还要经过平台审核、用户授权和 App Session 三重校验。

应用权限必须来自平台允许集合：

| 权限 | SDK | 用途 |
| --- | --- | --- |
| `user.profile.read` | `app.user.getProfile()` | 读取脱敏用户资料 |
| `storage.user` | `app.storage.get/set/delete()` | 应用和用户隔离的持久化数据 |
| `notification` | `app.notification.show()` | 展示平台通知 |
| `theme.read` | `app.theme.read()` | 读取主题 |
| `locale.read` | `app.locale.read()` | 读取语言区域 |

## SDK

```ts
import { createAppClient } from '@codex/proxy-app-sdk'

const app = createAppClient('app.proxy.example')
const profile = await app.user.getProfile()
await app.storage.set('last-opened', new Date().toISOString())
const models = await app.api.request('/models')

for await (const event of app.api.stream('/responses/stream', {
  method: 'POST',
  body: JSON.stringify({ model: 'your-model', input: 'hello' }),
})) {
  console.log(event.data)
}
```

SDK 在 v2 本地/direct 模式发送带 App Session 的 HTTP 请求到 Runtime 与 `/v1`；
v1 iframe 才发送 `proxy-app/v1` Bridge 消息。SDK 不读取 Portal Cookie、JWT、
localStorage 或父页面业务数据。应用应在卸载时
调用 `app.destroy()`。

### 本地开发代理

当前 v1 开发包仍可通过 Relay 兼容 Bridge。v2 开发包使用同一套线上 HTTP 路径，Relay
（如存在）只负责 loopback 转发、登录回调和响应透传，不实现 Bridge RPC、权限或计费逻辑。

`proxy-app dev` 启动真实平台本地开发 Relay。项目必须已通过 `proxy-app create` 或
`proxy-app link` 绑定应用，但不需要在 shell 中设置 `PROXY_ACCESS_TOKEN`。首次调用时，
Relay 打开平台登录；登录账户创建开发版本登记和用户态 App Session。该账户的模型、供应商
调度、额度和计费会真实生效。

Vite 使用 SDK 提供的代理适配器：

```ts
import { defineConfig } from 'vite'
import { createPlatformDevProxy } from '@codex/proxy-app-sdk/vite'

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

代理支持 JSON、SSE、multipart 和二进制响应；正式发布包仍由 AppHost 创建真实 Session。
直接执行 `npm run dev` 不会启动 Relay，只适合静态 UI 开发。

本地 `dev` 和“我的应用 → 版本管理 → 测试版本”都使用真实平台；区别是前者通过
本地 Relay，后者由 Portal AppHost 创建 Session。两者都按当前登录用户执行权限、供应商
调度、额度和计费。

## 商业化

收费配置绑定到版本，提交审核时冻结：

| 模式 | 安装 | 应用费用 |
| --- | --- | --- |
| `free` | 免费 | 无 |
| `one_time` | 余额购买后安装 | 安装时收取一次 |
| `commission` | 免费安装 | 每次应用调用按比例收取 |

平台内部会根据实际用量完成供应商结算、平台服务费和应用收益分账。应用拥有者无需
获取供应商报价、平台费率或用户扣费明细；应用拥有者只需在版本提交时选择应用的
免费安装、一次性购买或按调用抽成模式，收益统一在应用收益中心查看。

## CLI

在项目根目录执行：

```bash
npm install
npm run app -- init apps/my-app --name "我的应用"
PROXY_USER_ACCESS_TOKEN=... npm run app -- create apps/my-app --category productivity
npm run app -- dev apps/my-app
npm run app -- build apps/my-app
npm run app -- validate apps/my-app
PROXY_USER_ACCESS_TOKEN=... npm run app -- status apps/my-app
npm run app -- doctor apps/my-app
npm run app -- pack apps/my-app /tmp/my-app.zip
PROXY_USER_ACCESS_TOKEN=... npm run app -- upload apps/my-app
PROXY_USER_ACCESS_TOKEN=... npm run app -- publish apps/my-app
```

环境变量：

- `PROXY_API_BASE_URL`：平台 API 地址，默认 `http://localhost:9003/api`。
- 应用运行时不使用开发者凭证。`proxy-app dev` 和线上宿主均通过 OAuth 为当前用户创建短期 `ast_*` App Session；`sk-*` 仅供用户自己的服务端程序直接调用平台 API。
- `PROXY_APP_DEV_PORT`：本地开发端口，默认 `5173`；也可以在命令中使用 `--port`。

应用分类使用稳定枚举：`productivity`、`creative`、`developer`、`data`、`communication`、`education`、`finance`、`other`。分类仅用于市场展示和筛选，不影响应用权限。

## 安全与发布检查

- 应用只使用平台 SDK，不请求开发者自有后端。
- 不在源码中提交访问令牌、Cookie 或 `.proxy-app.json`。
- `manifest.id` 由 CLI 与平台同步，不能手工改成其他应用标识。
- ZIP 根目录必须包含 `manifest.json` 和入口 HTML。
- `pack`、`upload`、`publish` 默认要求先生成 `dist`；`--source` 仅供本地调试，不能作为可发布包。
- `doctor` 输出 `ready_for_upload: true` 后再执行上传；未构建或未绑定项目会以非零状态退出。
- 发布前执行 `validate`、`build` 和 `pack`。
- `upload` 不会提交审核；只有 `publish` 或 Portal 操作会进入审核流程。
- `publish` 会先查询同版本是否已上传，已存在的草稿只提交审核，不重复上传；已在审核中或已发布的版本会直接报告当前状态。
- 本地 `dev` 会登记当前绑定应用的本地开发版本；上传 ZIP 后再生成可提交审核的版本。
- 审核通过时，低于当前线上版本的版本不会覆盖线上版本；请按递增版本号发布。
- Vite/其他构建工具必须输出相对资源路径（例如 Vite `base: './'`），因为应用入口运行在平台版本化资产 URL 下。
