# Proxy App Platform

Open-source SDK, CLI, protocol documentation, and reference applications for
building applications on the Proxy platform.

This repository contains developer tooling and examples. It does not contain
the platform's Portal, Admin API, Gateway, provider credentials, or production
data. The examples call platform capabilities through the SDK; they do not
copy or depend on a private provider service.

Code is MIT licensed. See [NOTICE.md](NOTICE.md) for the separate provenance
and redistribution limits that apply to the design example's demonstration
images.

独立的 Proxy 平台应用工具集，包含：

- `proxy-app-sdk`：支持本地 HTTP 调用、注入 AppSession 的 direct 调用及旧版 iframe/Bridge 的应用 SDK。
- `cli/proxy-app.mjs`：应用初始化、开发、构建、校验、打包、上传和提交审核工具。
- `apps/*`：可运行的示例应用。
- `docs/APP_MARKET.md`：应用 manifest、权限、收费和发布规范。
- `docs/API_REFERENCE.md`：Bridge、运行面、控制面和市场接口的逐接口参考。
- `docs/APP_API_OPENING.md`：`admin-api-go` 与 `llm-gateway-go` 的 App 开放 API 边界和实施方案。
- `docs/ARCHITECTURE.md`：框架分层、身份边界、本地开发和发布闭环。
- `docs/HTTP_RUNTIME_DESIGN.md`：完整目标设计及分阶段实施状态，涵盖开发、线上、认证、存储与旧包迁移。

> **运行协议状态**：当前仓库仍支持已发布的 v1 iframe 应用及其 Bridge 兼容路径。
> 本地开发现在默认通过 Vite/loopback 代理调用 `/v1/*` 与 `/api/app-runtime/v1/*`，
> 模型、资料和存储不再使用 Bridge。需要同时更新 Admin API 和 Gateway，再重启 CLI。
> 登录仍保留旧流程的一次性窗口通知；PKCE、生产顶层入口、存储 CAS 和开发数据隔离尚未完成。
> `--legacy-bridge` 为使用旧 SDK 的应用保留兼容，不会自动改变新 SDK 的 HTTP 默认行为。

## Quick start

```bash
git clone https://github.com/duckingmind/app.git
cd app
npm ci
npm run sdk:build
npm run example:build
npm run example:validate
```

Requirements: Node.js 22.12 or later (use `nvm use` for Node.js 22).
The CLI reads exported shell variables; it does not load `.env` automatically.
`.env.example` lists the supported platform settings. Keep management tokens
in the shell or CI secret store; never put them in a committed file.

These checks do not need a platform account. Full verification is
`npm run release:check`. Runtime login, models and storage need a compatible
Proxy platform deployment; this repository does not start the platform servers.
New checkouts must create or link their own platform application before `dev`
or `doctor`, because `.proxy-app.json` is local and is not included in Git.

## 创建应用

应用标识由平台生成，应用拥有者不需要手工填写反向域名：

```bash
npm run app -- init apps/my-app
```

本地应用通过 `proxy-app dev` 独立运行。CLI/Vite 启动 HTTP 代理，将相对路径请求转发到真实平台。
应用首次访问平台能力时打开平台登录；登录账户会获得真实 App Session，模型目录、供应商
调度、权限、额度和计费都按该账户执行。应用管理会话只用于 `create`、`upload`、
`publish` 等命令，不会传给应用，也不是应用运行时凭证。

```bash
npm run app -- dev apps/chat --port 5174
```

`dev` 不读取 `PROXY_ACCESS_TOKEN`，也不会把 Portal Cookie 或用户 JWT 注入应用进程。
默认平台地址为 `PROXY_API_BASE_URL=http://localhost:9003/api`，Portal 地址为
`PROXY_PORTAL_URL=http://localhost:9004`；本地 Relay 会在登录后创建开发版本和用户态 App Session。

部署顺序为 Gateway（兼容 v1/v2 token）→ Admin（新增 Runtime API 与按需签发 v2 token）→ SDK/CLI。
HTTP 运行会话使用 `runtime_protocol: 2`，与发布包的 manifest schema 版本无关；旧 Host 默认仍签发 v1 token。
旧 SDK 连接旧平台时可运行 `npm run app -- dev apps/chat --legacy-bridge`；新版 SDK 如需此兼容模式，
须显式设置 `localBridgePath: '/__platform/bridge'`。当前数据仍按 app/user 存储，开发调用也会读写该用户的同一份数据。

## 发布应用

应用标识由平台生成。推荐先初始化本地工程，再通过 CLI 创建平台应用；CLI 会自动保存 `app_id` 并把平台 `slug` 写入 `manifest.id`。

管理命令需要 Portal 当前登录用户的 `access_token`，不是模型 API Key。CLI 暂无 `login` 命令；令牌获取及不写入 shell 历史的输入方式见 [CLI 认证说明](cli/README.md#management-authentication)。切换平台环境时，需在目标平台重新 `create` 或 `link`，现有示例的 manifest 标识不代表你拥有该应用。

```bash
npm run app -- init apps/my-app --name "我的应用"
PROXY_API_BASE_URL=http://localhost:9003/api \
PROXY_USER_ACCESS_TOKEN=... \
npm run app -- create apps/my-app

npm run app -- build apps/my-app

PROXY_API_BASE_URL=http://localhost:9003/api \
PROXY_USER_ACCESS_TOKEN=... \
npm run app -- upload apps/my-app

PROXY_API_BASE_URL=http://localhost:9003/api \
PROXY_USER_ACCESS_TOKEN=... \
npm run app -- publish apps/my-app
```

`publish` 对已上传的草稿版本是可重复执行的：它会先查询当前用户拥有的应用，仅在版本不存在时上传。使用 `status` 查看本地绑定和远端审核状态。

```bash
PROXY_USER_ACCESS_TOKEN=... npm run app -- status apps/my-app
npm run app -- doctor apps/my-app
```

`upload` 只上传版本，适合先自测；`publish` 上传后同时提交平台审核。CLI 不会绕过审核直接上架。

`pack`、`upload` 和 `publish` 默认只接受 `dist` 构建产物；本地调试如确实需要打包源码，可显式传入 `--source`，该包不能直接提交平台。

发布前建议执行 `npm run app -- doctor <app-dir>`；只有 `ready_for_upload: true` 才进入上传流程。

## 项目结构

```text
app/
├── cli/                  # 发布工具
├── proxy-app-sdk/        # TypeScript SDK
├── apps/                 # 示例应用集合：chat、idea-spark、todo、design
└── docs/                 # 平台协议和开发规范
```

## Public repository boundaries

Before opening a pull request, check `git status --ignored` and
confirm that no `.env`, `.proxy-app.json`, `dist/`, ZIP, local snapshot, token,
cookie, provider key, or production log is staged. The source repository keeps
optimized demo assets needed by the design example, plus source manifests for
the research references. Original downloaded responses under
`apps/design/references/` are ignored because a public URL does not grant
redistribution or commercial-use rights.

The optimized images have the same third-party rights restrictions as their
originals; conversion to WebP does not grant a license. See [NOTICE.md](NOTICE.md).

GitHub CI runs tests and builds. CI does not upload an app, submit a version
for review, or access platform management APIs. App publication remains an
explicit local or separately authorized release step.

应用统一放在 `apps/<name>/`，不再嵌套 `examples`；应用使用平台后端能力，
不需要 `app-backend` 项目。SDK 和 CLI 是可发布的 npm 包，`apps/*` 保持
`private: true`，构建后上传应用市场，不发布到 npm。

应用只能通过平台 API 获取后端能力，不应依赖开发者自有后端或读取 Portal Cookie、JWT 和
平台控制面令牌。应用运行时只拿到短期 App Session，并按当前登录用户计费。

### 发布 SDK 和 CLI

该仓库本身是工具源码仓库。维护者发布 SDK/CLI 后，应用项目即可从 npm 安装：

```bash
npm publish --workspace @codex/proxy-app-sdk
npm publish --workspace @codex/proxy-app-cli
```

新应用脚手架默认依赖 `@codex/proxy-app-sdk@^0.1.0`。如果尚未发布到 npm，先在本地使用 workspace，或将依赖临时替换为已发布的 tarball；不要把 `node_modules` 提交到应用仓库。

## 开放生态分发边界

GitHub 是源码和协作中心，npm 是开发者安装中心，应用市场是用户运行中心：

| 产物 | 发布位置 | 使用者 | 是否进入线上应用包 |
| --- | --- | --- | --- |
| `@codex/proxy-app-sdk` | npm | 应用开发者，在源码工程中安装 | 只打包编译后的应用代码，不携带 SDK 源码和 `node_modules` |
| `@codex/proxy-app-cli` | npm | 应用开发者，本地执行 `proxy-app` | 否，CLI 只在开发机运行 |
| SDK、CLI、协议、示例源码 | GitHub | 维护者和开发者，阅读、提 issue、提交 PR | 否 |
| 独立应用源码 | 开发者自己的 GitHub 仓库 | 应用开发团队 | 否 |
| 应用 `dist` ZIP | 平台上传接口 / 应用市场 | 平台审核和用户 | 是，审核通过后由 CDN 提供 |

推荐的发布链路：

```text
平台框架仓库 GitHub
  -> CI 测试
  -> npm 发布 SDK / CLI

应用源码仓库 GitHub
  -> npm install SDK
  -> proxy-app dev / build / validate
  -> proxy-app pack / upload
  -> 平台审核
  -> 应用市场 CDN
```

版本规则：SDK 和 CLI 使用 npm 的语义化版本；应用使用 `manifest.version`，每次上传
必须递增并生成不可覆盖的 ZIP。GitHub Tag 应与 npm 版本对应，应用源码仓库的 Tag
则与应用版本对应。GitHub Actions 负责测试、构建和生成校验摘要，不直接绕过平台审核
发布应用。

严禁进入 GitHub 或 npm 的内容：Portal Token、`ast_*`、供应商 Key、COS Secret、
`.env`、用户数据和未脱敏生产日志。应用包只允许包含构建后的静态资源、入口文件和
平台要求的 manifest；开发依赖、源码地图和本地配置按发布策略明确排除。
