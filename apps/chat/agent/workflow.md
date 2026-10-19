# 推荐流程

1. 调用 `list_models`，确认可用的文本模型。
2. 调用 `read_conversations`，选择会话；没有合适会话时调用 `create_conversation`。
3. 发送前再次读取会话，使用返回的 `revision` 调用 `send_message`。
4. 用返回的助手消息展示结果；如需历史记录，调用 `read_messages` 分页读取。
5. 如果生成时间过长，使用最新 revision 调用 `stop_generation`。
