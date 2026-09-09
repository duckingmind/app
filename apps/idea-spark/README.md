# 灵感闪现

灵感闪现是一个轻量的创意工作台。输入一个想法，选择创作方向，即可生成
一版可以继续修改的方案。结果可以复制、继续创作、重新生成，或保存为历史
草稿。

## 创作方向

- 营销方案：整理卖点、受众和传播角度
- 短视频脚本：规划开场、镜头和行动
- 产品点子：梳理痛点、功能和差异化

应用从平台模型目录选择可用的文本模型，通过 Responses 流式接口生成内容。
最近的草稿保存在当前用户的 `storage.user` 中，最多保留 6 条。

## 运行

在本仓库的 `app` 目录执行：

```bash
npm install
npm run sdk:build
npm run idea:build
npm run app -- validate apps/idea-spark
npm run app -- dev apps/idea-spark
```

开发环境首次请求模型时可能需要完成平台登录。只运行 Vite 预览可以查看
界面，但需要平台开发运行时才能生成方案。

## 构建和打包

```bash
npm run idea:build
npm run app -- pack apps/idea-spark dist/idea-spark.zip
```

上传 ZIP 到开发者控制台后，在宿主中测试版本，再提交发布。应用清单需要
`storage.user` 权限和 `model.responses` 能力；运行时会话由宿主提供。
