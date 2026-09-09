# Contributing

1. 使用 Node.js 22.12 或更高版本；使用 nvm 时执行 `nvm use`。
2. 安装依赖：`npm ci`。
3. 修改后运行：`npm run release:check`（包含测试、构建、应用校验和 npm 打包预检）。
4. SDK 的 HTTP 或 Bridge 协议变更必须同步更新 `docs/API_REFERENCE.md`、`docs/APP_MARKET.md` 和示例应用。
5. 不提交访问令牌、`.proxy-app.json`、ZIP、`dist` 或 `node_modules`。

应用必须保持纯前端运行模型。新增平台能力时，应通过具名权限和 SDK 方法开放，不应加入开发者自有后端示例。

提交 PR 时说明具体问题、修改后的行为和验证结果。安全问题请按 [SECURITY.md](SECURITY.md) 私下报告。新增图片必须提供可再分发许可与来源，现有演示素材的限制见 [NOTICE.md](NOTICE.md)。
