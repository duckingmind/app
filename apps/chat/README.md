# 即刻对话

即刻对话是一个基于 Proxy App 平台文本模型的多轮聊天应用。它支持流式
回复、会话管理和用户级历史记录，适合作为聊天应用或文本模型集成的示例。

## 功能

- 创建、切换和删除会话
- 从当前账户可用的模型中选择文本模型
- 流式显示回复，并可随时停止生成
- 对失败或中断的回复主动重试
- 复制回复内容
- 根据首条消息生成会话标题
- 刷新后恢复当前账户的会话历史

会话数据通过 SDK 的 `storage.user` 保存，不同用户之间相互隔离。模型由
平台目录提供，应用不会要求开发者在前端放置模型服务凭据。

## 运行

在本仓库的 `app` 目录执行：

```bash
npm install
npm run sdk:build
npm run chat:build
npm run app -- validate apps/chat
npm run app -- dev apps/chat
```

首次请求模型时，开发环境可能要求完成平台登录。只使用 `npm run chat:dev`
可以预览界面，但没有平台开发运行时，模型请求不会工作。

## 构建和打包

```bash
npm run chat:build
npm run chat:pack
```

打包文件默认写入 `app/dist/chat.zip`。上传 ZIP 到开发者控制台后，在宿主中
测试版本，确认权限和模型调用正常，再提交发布。

应用清单声明 `storage.user` 权限和 `model.responses` 能力。宿主会在运行时
提供短期会话；应用只通过 `@ducking-mind/proxy-app-sdk` 访问公开的平台 API。
