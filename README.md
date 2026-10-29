# duckingmind 应用工作区

`cli`、`proxy-app-sdk` 和 `apps/*` 是公开的开发工具与平台子应用。桌面主应用及其派生运行时由私有仓库维护，不属于本项目的开源交付范围；桌面端的内部启动、构建、测试和发布命令只对获授权的维护者提供。

- `proxy-app-sdk/`：面向平台应用的 TypeScript SDK。
- `cli/`：`proxy-app` 命令行工具。
- `apps/*`：可直接运行的 Chat、Design 和 Pelican 子应用；Canvas 的兼容文档与注册信息仍保留在仓库中，但其源码不属于本工作区。
- `docs/*`：应用 manifest、API 和发布规范。

CLI、SDK、示例应用和公开文档中明确标记的代码采用 MIT 许可证。`desktop/`、
`proxy-app-desktop-runtime/` 以及由它们生成的桌面运行时和发布产物是专有内容，保留全部权利，
不因内部 checkout 中存在相关目录而获得复制、修改或再分发许可。完整范围见
[NOTICE.md](NOTICE.md) 和 [桌面端代码边界](docs/DESKTOP_BOUNDARY.md)。演示图片的来源和再分发条款也见
[NOTICE.md](NOTICE.md)。

## 环境要求

- Node.js 22.18 或更高版本
- npm
- 在兼容的 Proxy 平台部署上拥有账号和应用，用于需要登录的开发与发布流程

## 快速开始

公开工作区的开发只需安装 CLI、SDK 和示例应用依赖：

```bash
git clone https://github.com/duckingmind/app.git
cd app
npm ci
npm --prefix proxy-app-sdk run build
```

桌面端源码和依赖仅供获授权的内部维护者使用；桌面构建、发布和桌面冒烟测试命令不属于公开开发接口。

公开工作区常用命令：

```bash
npm run build
npm test
```

子应用在各自目录运行 `npm run dev` 或 `npm run pack`；SDK 在 `proxy-app-sdk` 目录运行 `npm run build`。各目录用 `npm run` 查看完整命令。

桌面宿主构建、发布配置和内部发布说明仅供获授权的内部维护者使用，不属于公开开发接口。
公开 CLI 只生成公开应用包；桌面安装包、更新元数据和签名材料由私有发布流水线生成。边界说明见[桌面端代码边界](docs/DESKTOP_BOUNDARY.md)。

构建和校验命令不需要平台凭证。CLI 从已导出的 shell 变量读取配置，不会自动加载
`.env` 文件。请将凭证保存在 shell 环境或 CI 的密钥存储中。

如果不使用工作区版本，也可以全局安装已发布的 CLI：

```bash
npm install --global @ducking-mind/proxy-app-cli
```

## 创建并运行应用

初始化应用目录，然后启动开发服务：

```bash
npx proxy-app init apps/my-app --name "My App"
npx proxy-app dev apps/my-app --port 5173
```

`init` 会创建起始项目和 manifest。已有平台应用时，将 `manifest.id` 设为其公开 slug（或稳定 `app_...` ID），
即可直接运行 `dev`、`upload` 和 `publish`，无需 `link` 或 `repair`。新应用才需要运行 `create`。
应用目录必须包含 `manifest.json` 和构建脚本。

新项目默认包含 Web 与私有桌面宿主兼容目标、一个 `read_metadata` 能力示例，以及能力指南和 schema 示例。公开 CLI 只构建和发布 Web 应用。
添加业务能力前请先阅读[应用开发指南](docs/APP_DEVELOPMENT.md)。

应用清单无需填写 `apis`、`permissions`、`backend`、`pricing`。省略时默认开放全部当前公开 Gateway 接口和 KV，
采用平台后端；申请开放前需在“我的应用”设置按调用抽成比例。已有应用仍可用显式列表缩小能力范围。

已有平台应用安装好项目依赖、配置正确的公开 slug 后，在各自目录内运行 `npm run dev` 即可开发，不需要应用名称前缀或本地绑定。例如 Chat：

```bash
cd apps/chat
npm run dev
```

命令会先完成开发授权与平台检查，再启动平台代理和支持热更新的 Vite。

## 平台认证

创建、关联、查看、上传或发布应用的命令需要平台用户访问令牌。请按照所用平台的
官方认证流程，在运行命令的 shell 中设置平台地址和令牌：

```bash
export PROXY_PLATFORM_URL="https://platform.example"
export PROXY_USER_ACCESS_TOKEN="<platform-user-token>"

npx proxy-app create apps/my-app
npx proxy-app status apps/my-app
```

不要提交访问令牌、Cookie、供应商凭证或本地关联文件。`PROXY_USER_ACCESS_TOKEN`
仅用于应用管理，不会传递给应用运行时。CI 任务应通过自身的密钥管理器提供该变量。

## 构建与发布

打包命令自动重新构建和校验，无需连续执行多条准备命令：

```bash
npx proxy-app pack apps/my-app
```

发布新版本直接执行（缺少上传产物时会自动构建、校验、打包并上传）：

```bash
npx proxy-app publish apps/my-app
```

应用目录内可省略路径，常用 `proxy-app dev`、`proxy-app pack`、`proxy-app publish`。
单独上传用 `proxy-app upload`，也会自动构建，但不切换线上版本；`build`、`validate`、`doctor`、`status` 继续支持单独执行。
`pack` 支持 `-o dist/app.zip` 指定输出，也兼容原有位置参数。

构建失败不会使用旧 `dist` 打包或上传。已上传版本的 `publish` 使用服务端产物，避免覆盖已审核内容。每次发布新版本时，
请递增 `manifest.json` 中的版本号。首次 `publish` 提交应用开放申请，所选版本作为预览材料；
批准应用开放后，该版本成为线上版本。已开放应用上传后续版本只保存候选草稿，测试后手动执行 `publish` 或在版本管理点击“设为线上版本”，无需重复审核。
使用 `status` 查看本地关联信息、应用开放申请和远端版本状态。

新建应用本身不需要审核。应用开放前已上传的其他草稿，可在应用开放后直接发布；
已有待审申请时需先撤回才能换版本。版本发布会保留应用的暂停或平台禁用状态。
历史抽成版本可在版本管理点击“切换到此版本”回滚，也可执行 `proxy-app publish apps/my-app --version 0.1.4`，无需改动本地 manifest 或重新上传；切换前请核对该历史版本的收费快照。
界面中从应用卡片“申请开放”，版本管理用于上传、测试和手动切换线上版本。完整说明见 [应用开放与版本管理](docs/APP_LIFECYCLE.md)。

用户无需安装应用，可直接打开已开放的应用。收费方式统一为按调用抽成。首次申请开放时在页面配置收费，或由 CLI 使用 manifest 中的 `pricing` 初始化配置；之后的版本自动继承，发布时无需重复配置。新开放申请和新版本发布必须使用有效抽成比例；已保存比例只能降低。历史一次性收费订单和版本快照保留用于审计，但不再向用户收费；历史免费和一次性收费应用需明确设置抽成后再提交或发布新版本，已有会话和订单不重新计费。

完整命令参考请参阅 [cli/README.md](cli/README.md)。

## 仓库结构

```text
app/
├── cli/                  # proxy-app CLI
├── proxy-app-sdk/        # TypeScript SDK
├── apps/                 # 平台子应用
└── docs/                 # 平台开发文档
```

相关文档：

- [应用开发指南](docs/APP_DEVELOPMENT.md)
- [应用市场指南](docs/APP_MARKET.md)
- [无状态 JavaScript 服务端运行时架构](../docs/APP_CONTAINER_RUNTIME_DESIGN.md)
- [API 参考](docs/API_REFERENCE.md)
- [参与贡献](CONTRIBUTING.md)
- [安全策略](SECURITY.md)
