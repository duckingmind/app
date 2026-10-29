# Pelican Probe

Pelican Probe 通过 Gateway 持久任务生成 HTML/SVG 动画，并把结果写入应用共享画廊。

## 任务链路

浏览器通过 Proxy App SDK 的 `/v1/app-runtime/tasks` 提交、查询和取消任务。提交请求只等 Gateway 持久化任务并返回 task ID；模型调用在此之后由 Runtime Host 执行。前端状态轮询与提交分离，只负责显示进度和取回已保存结果。正式环境使用已发布版本，本地开发使用登记到草稿版本的 `functions.task` 源码；CLI 开发者授权只产生该应用/版本的本地预览许可，应用用户仍用自己的 Portal 账户获得自己的 App Session。任务函数通过 Gateway 调用模型和共享存储接口。

任务函数最多执行两次，以便恢复一次瞬时失败；任务重试会复用原任务幂等键。上游若已处理请求但响应在传输中丢失，第二次执行仍可能产生重复模型调用或费用，是否去重取决于上游是否支持该幂等键。当前应用版本为 `0.3.7`；本地开发需重启 CLI 重新登记草稿版本，生产环境需发布此版本。

开发和生产使用同一条任务链路。Vite 只负责提供页面并把浏览器请求代理到 Gateway，不执行任务。CLI 在本地开发登记时发送 `runtime/task.mjs` 到平台并保存到对应草稿版本；构建产物中的同一文件会随应用 ZIP 上传。

Gateway 接受任务后，即使关闭页面也会继续执行。页面仅在任务处于活动状态时约每 1.2 秒查询一次；任务 ID 和待确认提交的幂等信息保存在浏览器中，重新打开页面会恢复状态跟踪。提交响应丢失时会复用原幂等键，避免创建重复任务。生产浏览器使用 Portal 的 HttpOnly 设备 Cookie 换取绑定 Pelican 及当前发布版本的 App Session；该 Session 仅保存在当前标签页的 `sessionStorage`，不进入 URL 或 `localStorage`。已完成结果保存在应用共享 KV 中。

## 生产环境登录与启动

Pelican 的生产入口由应用静态资源路由直接返回 `index.html`。页面发现当前标签页没有可用的 App Session 时会打开 Portal 登录弹窗；Portal 使用 HttpOnly 设备 Cookie 向 `/api/market/apps/pelican/sessions` 换取绑定 Pelican、当前发布版本和所选工作区的 Gateway App Session，再通过校验过的 `postMessage` 交回应用标签页。Cookie 留在 Portal，应用只得到自己的 App Session。

换票接口只接受同源 JSON POST，并在服务端根据 URL 中的应用身份解析当前已发布版本；请求体不能选择 `app_id`、用户或工作区。App Session 过期后 Pelican 使用 Portal Cookie 重新换票；若 Cookie 缺失或无效，用户先在 Portal 登录，Portal 会设置新的 HttpOnly Cookie 后重试。Gateway 任务、模型请求、用户资料和共享画廊仍由 App Session 授权，并继续通过 Gateway 执行。

## 本地开发

运行 `npm run dev` 启动 `proxy-app dev`。CLI 只完成开发者授权和应用登记；页面通过 Portal 登录弹窗获取绑定本地草稿版本的 App Session，Vite 只把 `/v1` 业务请求代理到配置的 Gateway。CLI 和 Vite 不保存用户会话。要使用本地 Gateway：

```sh
PROXY_PLATFORM_GATEWAY_URL=http://127.0.0.1:9002/v1 npm run dev
```

App Session 必须由目标 Gateway 环境签发，并绑定对应应用版本。使用本地平台时，CLI 的平台服务也应指向同一环境，例如：

```sh
PROXY_PLATFORM_URL=http://127.0.0.1:9004 \
PROXY_PLATFORM_GATEWAY_URL=http://127.0.0.1:9002/v1 \
npm run dev
```

如果 API 与 Portal 使用不同地址，可分别设置 `PROXY_API_BASE_URL` 和 `PROXY_PORTAL_URL`。使用其他环境签发的 Session 访问本地 Gateway，可能返回 `credential_invalid`。

本地运行 `proxy-app dev` 时，CLI 会在启动 Vite 前把本地 `runtime/task.mjs` 登记到应用创建者的草稿版本，并生成仅限该应用/版本的短期本地预览许可；修改该文件后重启 CLI 更新草稿。应用用户可以用自己的 Portal 账户登录本地预览，AST 的用户归属、工作区、配额和画廊权限仍是该用户自己的。预览许可不能换取其他应用或版本的会话。若提交任务返回 `APP_RUNTIME_FUNCTION_UNAVAILABLE`，请检查 Admin 与 Gateway 是否访问了包含该应用版本和函数源码的同一套数据，以及 App Session 的版本是否匹配。Runtime Host 只有在 Gateway 实际派发任务后才会记录 invocation 日志。

联调时可在浏览器 Network 面板确认任务请求发往 `/v1/app-runtime/tasks`；成功提交会返回 task ID，Runtime Host 应出现对应 invocation 日志。模型或共享存储调用失败时，在 Runtime Host 按 task ID 和 `task_attempt` 查找 `runtime.platform.request.failed`，再用该记录的 `gateway_request_id` 搜索 Gateway 日志。Runtime 默认记录 HTTP 状态、公开错误码和耗时，不记录请求/响应正文、提示词或凭证。

模型响应时间较长时，页面仍会轮询 Gateway 保存的任务状态；Runtime 接受任务后先上报一次初始运行态，随后每 30 秒上报运行阶段和心跳。任务卡会区分等待 Runtime Worker、等待 Gateway/模型响应、读取响应内容、Worker 未响应和心跳过期；心跳过期只表示状态流中断，不等于模型已失败。Pelican 的 Runtime 时限为 35 分钟，以覆盖 Gateway 单次 15 分钟响应等待及一次受限节点切换；任务时限到达前由 Gateway 负责决定路由结果，浏览器不等待模型 HTTP 请求。

## 开发命令

```sh
npm install
npm run dev
```

`npm run dev:server` 只启动 Vite，不会生成本地 App Session。使用 `npm run dev` 让 CLI 完成开发者登记后，应用仍通过 Portal 登录获取用户会话；生产环境使用相同的 Portal Cookie 换票流程。
