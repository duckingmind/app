# 推荐工作流

1. 读取配置和模型目录。
2. 上传商品图、参考图或模特图并记录每次返回的 revision。
3. 使用 `configure` 设置 `mode`、`imageModel`、`textModel`、`ratio` 以及对应模式的素材和参数。
4. 调用 `submit_generation`，保存返回的 `batchId`。
5. 分页调用 `list_works`，直到作品状态为 `completed` 或 `failed`。
6. 对已完成作品调用 `read_result`，按 `exportId` 和 `nextOffset` 读取全部图片。
