# Contributing

1. 使用 Node.js 20.19 或更高版本。
2. 安装依赖：`npm ci`。
3. 修改后运行：`npm test && npm run build`。
4. SDK 的 Bridge 协议变更必须同步更新 `docs/APP_MARKET.md` 和示例应用。
5. 不提交访问令牌、`.proxy-app.json`、ZIP、`dist` 或 `node_modules`。

应用必须保持纯前端运行模型。新增平台能力时，应通过具名权限和 SDK 方法开放，不应加入开发者自有后端示例。
