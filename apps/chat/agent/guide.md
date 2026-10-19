# 即刻对话 Agent 指南

Chat 的 Agent 能力面向当前用户的会话和文本模型。先调用 `list_models` 与 `read_conversations`，再使用最近一次返回的 `revision` 作为写入操作的 `expected_revision`。每个写入操作都必须生成 8–128 字符的 `idempotency_key`，重试时复用完全相同的键和参数。

`send_message` 会等待流式回复完成并返回助手消息；长时间没有响应时可调用 `stop_generation`。停止只代表本地停止等待，已经提交到平台的请求仍可能完成。会话内容按当前用户隔离保存，Agent 不会获得平台令牌或底层请求地址。
