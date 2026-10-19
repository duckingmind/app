# 参与贡献

1. 使用 Node.js 22.18 或更高版本；使用 nvm 时执行 `nvm use`。
2. 在 `app` 目录安装公开工作区依赖：`npm ci`，再执行 `npm --prefix proxy-app-sdk run build`。
3. 按修改范围验证：子应用在 `apps/<应用名>` 运行自己的测试与 `npm run pack`。提交前从 `app` 目录执行 `node scripts/verify-workspaces.mjs`，覆盖 SDK、CLI、子应用及 npm 打包预检。桌面测试和发布验收只由有权访问内部桌面源码的维护者执行。
4. SDK 或 CLI 的公开行为发生变化时，请同步更新 `docs/API_REFERENCE.md`、`docs/APP_MARKET.md` 和示例应用。
5. 不提交访问令牌、`.proxy-app.json`、ZIP、`dist` 或 `node_modules`。

应用应保持纯前端运行模型。新增平台能力时，请通过明确的权限和 SDK 方法开放，不要在示例中加入私有后端或服务凭证。

桌面主应用及其派生的桌面运行时属于内部专有代码，不接受未经授权的复制、移植、再分发或外部贡献。
公开 PR 不应新增桌面源码、资源、发布配置或生成运行时；需要修复桌面端时，请通过内部维护流程提交。公开仓库的边界见
[桌面端代码边界](docs/DESKTOP_BOUNDARY.md)。

提交 PR 时请说明具体问题、修改后的行为和验证结果。安全问题请按照 [SECURITY.md](SECURITY.md) 私下报告。新增图片必须提供可再分发许可与来源，现有演示素材的限制见 [NOTICE.md](NOTICE.md)。
