# 错误恢复

- `CHAT_NOT_READY`：等待应用连接平台和模型加载完成后重试。
- `CHAT_REVISION_CONFLICT`：重新读取会话，使用新的 revision。
- `CHAT_BUSY`：等待当前生成结束，或先调用 `stop_generation`。
- `CHAT_IDEMPOTENCY_CONFLICT`：同一幂等键不能用于不同参数，请改用新键。
- `CHAT_NOT_FOUND`：重新读取会话列表，确认会话仍存在。
- `CHAT_INVALID_INPUT`：按能力 schema 修正参数后重试。
