# @ducking-mind/proxy-app-cli

`proxy-app` 是用于创建、开发、校验、打包和发布 Proxy 平台应用的命令行工具。

## 安装

CLI 需要 Node.js 22.18 或更高版本。使用 npm 安装已发布的软件包：

```bash
npm install --global @ducking-mind/proxy-app-cli
```

在本仓库中开发时，可以从仓库根目录运行工作区版本：

```bash
npx proxy-app --help
```

## 命令

在包含 `manifest.json` 的应用目录里，日常命令如下：

```bash
proxy-app dev       # 开发检查通过后启动
proxy-app pack      # 重新构建、校验并生成 ZIP
proxy-app upload    # 构建并上传待发布版本，保持线上版本
proxy-app publish   # 手动发布当前 manifest 版本，缺包时先构建上传
proxy-app publish --version 0.1.0  # 切换到指定已上传版本，也可回滚
```

不必先执行 `build`、`validate` 再执行 `pack`，也不必为了发布新版本连续执行 `pack`、`upload`、`publish`。
每次调用 `pack` 都重新运行应用的 `npm run build`，随后校验、打包；构建失败会直接停止，不使用旧 `dist`。
构建前会暂存旧 `dist`，要求本次真正生成新目录；失败时恢复旧产物。同一应用的构建同时只能运行一次。
`publish` 遇到已经上传的同版本则沿用服务端产物推进发布，不重建、不覆盖该版本。发布修改后的源码请先递增版本号。
上传成功不会自动切换线上版本。测试完成后执行 `publish`，才会将所选版本设为当前线上版本。
`publish --version <version>` 可选择历史已发布版本回滚，也可发布已上传草稿；不修改本地 manifest，
不要求本地版本号与目标一致，不构建或上传。目标尚未上传时直接报错，目标已是当前线上版本时不重复切换。

桌面宿主不属于本 CLI 的开源交付范围。CLI 只生成公开应用包；桌面安装包、更新元数据和签名材料由内部私有发布流水线生成。

首次创建应用：

```bash
# 创建起始应用
proxy-app init apps/my-app --name "My App"

cd apps/my-app
npm install
proxy-app create --category ecommerce
npm run dev
```

应用目录内统一使用 `npm run dev`，参数可以通过 `npm run dev -- --port 5175` 传入。新项目的 `dev` 脚本调用 CLI，`dev:server` 脚本启动底层 Vite；CLI 完成授权和平台检查后再调用 `dev:server`。旧项目只有底层 `dev` 脚本时，仍可直接使用 `proxy-app dev` 启动。缓存开发账户无权访问应用时，CLI 会自动清除缓存并请求新的创建者授权。

`init` 生成的项目统一使用根目录 `index.html` 入口，并包含一个可被主应用注册的
`read_metadata` 示例、`src/agent-tools.mjs`、`agent/guide.md`、工作流和校验示例。能力定义只在代码模块中维护，
源码 manifest 不包含 Agent 配置；CLI 自动发现 `src/agent-tools.mjs`，处理器注册使用同一份完整定义。构建自动生成发布契约，
不要同时手工维护 manifest 的能力清单。新增能力的最短流程见
[应用开发指南](../docs/APP_DEVELOPMENT.md)。

新项目的 manifest 不需要 `apis`、`permissions`、`backend`、`pricing`。省略时默认使用平台 Gateway，
开放全部当前公开接口和 KV；收费在“我的应用”中设置，提交开放申请前必须填写按调用抽成比例。已有应用可保留显式数组来缩小能力范围，显式空数组表示不使用。
所有应用都由 Portal 以同源顶层文档启动，资料、KV 和 Gateway 请求使用 App Session Cookie。本地开发源码会自动选择 `local`。
入口统一为应用根目录的 `index.html`。旧应用即使仍带有 `runtime` 或 `desktop` 字段也会继续兼容读取；这些字段不参与运行方式选择，历史 iframe 运行方式仍不再支持。

已有项目后续发布时，将旧 `manifest.agent` 中的元数据和能力数组迁移到 `src/agent-tools.mjs` 的
`agentMetadata` 和 `capabilities`，再从源码 manifest 删除 `agent`。已经发布的旧版应用包仍保持兼容；迁移后由 CLI 从代码声明生成新版发布能力目录。

开发和发布已有应用时，将 `manifest.id` 设为平台应用的公开 slug（或稳定 `app_...` ID），即可直接运行
`proxy-app dev`、`proxy-app upload` 和 `proxy-app publish`；不需要本地绑定文件、`link` 或 `repair`。
`.proxy-app.json` 仅作为旧项目的兼容缓存，仍可由 `create` / `link` / `repair` 生成；`upload`、`publish` 和 `status` 不读取它，始终按 `manifest.id` 查询平台应用。
公开 slug 直接使用输入值，例如 `canvas`、`my-app` 或 `app.proxy.canvas`，不会自动添加前缀；
长度为 1–120，规则为 `^[a-z0-9]+(?:[.-][a-z0-9]+)*$`。`validate`、`pack`、`dev` 都使用同一规则，
并继续兼容平台分配的 `app_...` 稳定 ID。`create` / `link` 的管理绑定仍保存稳定 ID，平台返回的短 slug 原样保留。
改名不会生成新的应用身份；旧包只有在平台记录了对应历史别名时才能继续使用，CLI 不会通过删除前缀猜测绑定。
`pack` / `validate` 只检查当前 manifest 和本地产物，不读取本地绑定文件。管理命令会按 `manifest.id`
解析当前账户可访问的应用；只有 manifest 与目标应用确实不一致时才会停止上传。
所有命令的 `<app-dir>` 都可省略，默认当前目录；
从其他目录操作仍可用 `proxy-app pack apps/my-app`，旧命令保持兼容。

`pack`、`upload`、`publish` 支持 `--output <output.zip>`（简写 `-o`），输出路径相对当前工作目录。
`publish --version` 使用服务端已有产物，不能同时指定输出路径：

```bash
proxy-app pack -o dist/my-app.zip
# 兼容旧的两个位置参数
proxy-app pack apps/my-app dist/my-app.zip
```

默认 ZIP 仍输出到应用目录的 `<manifest.id>-<version>.zip`。`upload` 会自动构建、校验、打包后上传；
`build`、`validate`、`doctor`、`status` 保留为单独构建、只读校验、诊断和状态查询命令。
`status` 同时显示 `local_version` 与线上 `current_version`；尚未首次发布时，`current_version` 为 `null`。
`build` 脚本应直接调用 Vite 等构建工具，不要调用 CLI 的 `pack` 或 `publish`，避免循环构建。

发布命令使用成功构建生成的 `dist/` 输出。每次发布新版本时，应用 manifest 的版本号
必须递增。CLI 构建在 `dist/manifest.json` 保存本次配置快照；后续 `validate` 可检查源码 manifest 是否已改变。
构建或打包期间修改 manifest 会被拒绝。`pack` 重新构建归档，`upload` 将版本发送到平台；应用尚未开放时，`publish` 提交
应用开放申请，将所选版本作为预览材料。应用开放后，上传仍只保存待发布版本，由开发者手动切换线上版本。`--source` 仅用于本地调试；
该选项跳过构建并打包源码目录（不包含旧 dist），使用它生成的源码包不是发布包。

收费方式统一为按调用抽成。应用首次申请开放和后续新版本发布前必须设置有效抽成比例；已保存比例只能降低，不能调高。manifest 中的 `pricing` 可省略，显式声明时仅支持 `commission`，用于初始化收费配置，后续版本继承平台保存的比例。历史免费和 `one_time` 版本继续按原快照结算，新版本需迁移到抽成。

同一应用同时只保留一个待审开放申请；需要更换预览版本时，在“我的应用”的应用卡片撤回后重新申请。审核决定对应独立的申请编号，版本只是材料。`status` 会返回 `opening_request`，用于查看当前申请及结果。应用开放后，`publish` 会手动切换到所选版本，无需重复上传或审核；历史产物保留供回滚使用。暂停、平台禁用状态会保留，版本切换不会自动解除限制。详见 [应用开放与版本管理](https://github.com/duckingmind/app/blob/main/docs/APP_LIFECYCLE.md)。

## 平台认证

### 本地开发登录

`proxy-app dev` 先检查开发环境，再启动应用。CLI 使用 `manifest.id` 的公开 slug 和开发者授权，
由平台解析内部应用身份、校验开发权限与当前 manifest，并登记本次本地入口；
内部 `app_id` 仅在进程内用于后续会话和撤销操作，不读取或写入 `.proxy-app.json`，不需要 `repair`。
检查通过后才打印 Local app 地址、运行应用开发服务。
应用不存在、账户无开发权限、版本冲突或平台故障会在终端报错并停止启动，不会延迟到应用内用户登录。
默认从 `5173`（或 `--port` / `PROXY_APP_DEV_PORT` 指定的端口）开始寻找空闲的回环端口；
如果目标端口已被占用，CLI 会自动选择后续可用端口，并使用该实际端口登记入口和启动 Vite。
设置 `PROXY_APP_DEV_URL` 时视为显式入口地址，CLI 不会改写它，端口冲突仍会按显式配置报错。

首次开发没有有效授权时，终端输出“开发者授权入口”。打开该链接、使用应用创建者账户完成授权，
CLI 会继续检查并启动应用；十分钟内未完成会超时，也可用 Ctrl+C 取消。
本地开发不要求手工配置 token。授权失败时，页面会显示当前授权账户、开发者登录页面、API 地址和应用 slug，便于区分账户、slug 与平台地址不匹配。若看到旧式通用错误页，请先停止旧的开发进程，再从应用目录运行 `npm run dev`。

macOS 默认分别缓存开发者授权和应用运行用户授权，按平台地址、应用、项目目录及用途隔离。
每次重启都重新登记当前 manifest 与本地入口，开发权限不能依赖上一次检查结果。
完成开发准备后，应用内用户登录才创建短期 App Session；用户的登录、缓存恢复、退出和切换账户
均不调用开发登记接口，也不清除开发授权。未发布草稿仍受平台访问权限限制，非创建者需使用其有权访问的已发布版本。

开发账户错误时，重新运行 `proxy-app dev apps/my-app` 即可。CLI 会在登记返回账户无权访问的 401、403 或 404 时清除开发账户缓存，并打开一次新的创建者授权入口；运行用户的授权不会被清除。
退出开发服务会撤销本次 App Session，保留两类缓存。应用调用 `app.auth.logout()` 只清除运行用户授权；
`app.auth.login({ forceLogin: true })` 只切换运行用户。平台确认缓存授权过期后才要求重新登录，临时故障保留缓存。

其他系统或钥匙串不可用时，仅使用当前进程内存，不会退回明文文件保存 token。
如需禁用持久缓存，可运行：

```bash
proxy-app dev apps/my-app --no-auth-cache
```

此选项禁用两类缓存，不读取或更新已有的钥匙串授权。CLI 不会把授权凭据写入项目、构建产物或本地应用的浏览器存储。

`build`、`validate`、`pack` 只验证本地产物，不代表远程绑定有效。`doctor` 的绑定检查也是本地结构检查。
上传和发布继续在平台验证应用归属与版本，开发启动前置检查不能替代它们。

### 应用管理与发布

管理命令（`create`、兼容性的 `link`、需要认证的 `status`、`upload` 和 `publish`）需要平台用户
访问令牌。请通过所用平台的官方认证流程获取令牌，并在 shell 或 CI 环境中提供：

```bash
export PROXY_API_BASE_URL="https://platform.example/api"
export PROXY_USER_ACCESS_TOKEN="<platform-user-token>"

proxy-app create apps/my-app
proxy-app upload apps/my-app
proxy-app publish apps/my-app
```

CLI 从已导出的变量读取配置，不会自动加载 `.env` 文件。请勿将令牌、Cookie、供应商
凭证和生成的本地关联文件纳入版本控制。管理令牌仅由 CLI 使用，不会传递给应用运行时。

## 配置

创建应用时，`--category` 支持 `ecommerce`（电商）、`comic`（漫剧）和 `other`（其他，默认）。分类用于应用市场展示，创建后可在“编辑应用资料”中调整。

默认使用线上平台 `https://www.duckingmind.com`，API 地址为 `https://www.duckingmind.com/api`，登录页也使用该域名。其他环境若 Portal 与 API 使用同一域名，只设置 `PROXY_PLATFORM_URL=https://platform.example` 即可；若两者使用不同地址，再额外设置 `PROXY_API_BASE_URL` 或 `PROXY_PORTAL_URL` 覆盖对应地址。连接本地平台时，可分别设置 `PROXY_API_BASE_URL=http://localhost:9003/api` 与 `PROXY_PORTAL_URL=http://localhost:9004`。
管理命令（创建、发布等）仍需 `PROXY_USER_ACCESS_TOKEN`；本地开发使用浏览器授权，不需要这个变量。
若 shell 已全局导出 `PROXY_USER_ACCESS_TOKEN` 或旧别名 `PROXY_ACCESS_TOKEN`，开发命令会优先使用该令牌；想在浏览器中选择创建者账户时先运行 `unset PROXY_USER_ACCESS_TOKEN PROXY_ACCESS_TOKEN`。

manifest、运行时 API 和发布规范请参阅仓库文档：

- [`docs/APP_MARKET.md`](../docs/APP_MARKET.md)
- [`docs/API_REFERENCE.md`](../docs/API_REFERENCE.md)
