# 即刻对话

一个使用 Proxy App 平台文本能力的多轮聊天应用。应用会从平台模型目录读取可用的文本模型，通过 App Session 调用 `/v1/responses/stream`，并把当前用户的会话历史保存到 `storage.user`。

应用只选择平台公开的文本模型，不接触供应商、Endpoint、报价、余额或上游凭证。会话、消息和当前模型选择都属于当前用户；流式生成过程中关闭页面，已经收到的内容会作为“已中断”消息恢复，不会伪装成成功回复。

## 功能

- 新建、切换和删除会话
- 多轮上下文对话
- 从平台目录选择文本模型
- 流式回复、停止生成、失败重试
- 复制 AI 回复
- 会话标题根据第一条消息自动生成
- 用户隔离存储，刷新后恢复会话
- 无可用模型、Session 失败和请求失败的明确状态

## 本地开发

在 `app` 目录执行：

```bash
npm install
npm run chat:build
node cli/proxy-app.mjs validate apps/chat
node cli/proxy-app.mjs doctor apps/chat
```

本地调试通过 CLI 启动真实平台 Relay。首次请求模型时会打开平台登录窗口，登录账户就是
本地调试和扣费账户：

```bash
npm run app -- dev apps/chat --port 5174
# 服务地址为 http://127.0.0.1:5174/
```

本地返回的模型、图片和视频来自真实平台，使用平台真实模型、供应商调度、权限、额度和
计费。不要手工设置 `PROXY_PLATFORM_GATEWAY_URL`，该变量由 CLI 注入并指向本机 Relay。

代理只处理平台 `/v1` 数据面，并原样支持文本 JSON、Responses SSE、图片和视频二进制；不转发 Portal Cookie 或 JWT，也不会进入发布 ZIP。直接执行 `npm run chat:dev` 只适合 UI 开发，不能调用平台接口。

正式发布包仍使用：

```bash
npm run chat:pack
```

上传 ZIP 后，在平台进入“开发者中心 → 版本管理 → 开发者自测”验证发布包。独立打开本地地址用于源码开发；发布包运行时仍由平台 AppHost 创建 Session。应用不会读取 Portal Cookie、JWT 或 API Key。若 `5174` 已被其他进程占用，开发服务器会直接失败，请关闭占用进程后再启动。

正式链路如下：

```text
创建平台应用
→ 构建并上传 ZIP 草稿
→ 开发者中心 · 版本管理 · 开发者自测
→ 平台创建真实 App Session
→ 真实模型、权限、供应商调度、额度和计费
→ 应用 SDK 调用 /v1/models 和 /v1/responses/stream
```

构建并打包：

```bash
npm run chat:pack
```

进入平台后，`AppHost` 会为当前用户和当前版本签发短期 Session。应用只拿到公开模型目录和 `/v1/responses/stream`，供应商、Endpoint、价格、凭证和 Portal 登录态都不会进入应用。
