# Todo Demo

Run with Vite and package the built files with `manifest.json` at the ZIP root. The
example uses `base: './'` so bundled assets continue to work from the platform's
versioned asset URL.

在 `app/` 项目根目录可以使用统一 CLI：

```bash
# 初始化一个新应用脚手架
npm run app -- init apps/my-app --name "我的应用"
npm run app -- create apps/my-app

# 本地开发、校验、构建和打包
npm run app -- dev apps/todo
npm run app -- validate apps/todo
npm run app -- build apps/todo
npm run app -- pack apps/todo /tmp/todo.zip

# 仅上传版本（不提交审核）
PROXY_USER_ACCESS_TOKEN=... npm run app -- upload apps/todo

# 上传并提交审核
PROXY_USER_ACCESS_TOKEN=... npm run app -- publish apps/todo
```
The app uses `@ducking-mind/proxy-app-sdk` for host bridge calls.

从独立项目根目录执行：

```bash
npm install
npm run example:build
npm run example:validate
npm run example:pack
```

Full platform documentation:

```text
../../docs/APP_MARKET.md
```
