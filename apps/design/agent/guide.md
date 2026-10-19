# 衣境设计室 Agent 指南

衣境设计室把商品素材转换为商品套图、A+ 详情、虚拟试穿或风格复刻作品。Agent 通过 `proxy_design_` 工具调用应用内真实编辑器流程，模型和账号状态由应用控制。

先调用 `read_configuration` 和 `list_models`，确认应用已登录、选择一个可用图片模型和文案模型。图片通过 `begin_asset`、`append_asset`、`finish_asset` 分块导入，避免在一次 MCP 请求中传输大文件。随后用 `configure` 写入模式、素材 ID、比例和生成参数，再调用 `submit_generation`。提交只表示已接受，使用 `list_works` 查询状态。

图片结果通过 `read_result` 返回有界 base64 分块，不返回签名地址。每次写操作都必须携带 `expected_revision` 和新的 `idempotency_key`；同一请求重试时复用原键和全部参数。
