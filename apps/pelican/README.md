# Pelican Probe

一个用于观察 `llm-gateway` 输出质量的 Proxy App。应用会把固定的原始提示词发送给平台文本模型，并在生成结果画廊中记录 Request ID、用户名称、模型、强度和生成时间，结果保存到平台 KV。

原始提示词会原样发送（包括重复句子）：

```text
创建一个HTML，内容是SVG绘制一个鹈鹕骑自行车的2D动画，你不需要任何测试创建一个HTML，内容是SVG绘制一个鹈鹕骑自行车的2D动画，你不需要任何测试
```

## 开发

```bash
npm install
npm run dev
```

应用启动后会读取平台可用的文本模型、用户资料和应用公共画廊。选择模型并点击“生成动画”即可生成结果；结果写入由平台控制的公共 KV，所有该应用用户读取同一份画廊。KV 权限或请求失败时不会显示或保存本机副本。生成结果卡片直接显示隔离的 HTML/SVG 预览，并展示 Request ID。

平台统一通过顶层 `index.html` 和同源 HttpOnly App Session 调用 Gateway 与 KV；本地开发由 CLI 自动选择本地运行通道。应用清单无需 `apis`、`permissions`、`backend` 和 `pricing`。平台默认为新会话开放所有公开 Gateway 接口和 KV；旧安装在创建新会话时自动补全权限，无需手工重新授权。模型请求通过 `app.api.stream('/responses/stream')` 以 SSE 流式接收，界面依次显示连接、接收和保存状态；只有流正常结束并提取出完整结果后才写入公共 KV，流失败不会保存半截输出。每次请求由应用生成并传入 `X-Request-ID`，该编号随结果展示。应用通过 `app.sharedStorage` 访问公共空间，不能由前端指定存储作用域。预览使用 sandbox 文档，允许 SVG/CSS 动画但不执行模型脚本或访问外部网络。

