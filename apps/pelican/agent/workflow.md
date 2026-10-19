# 创作流程

1. 读取应用状态及本指南，必要时用 `read_metadata` 确认应用身份。
2. 调用 `read_studio` 获取当前标题、插画设置与 `revision`。
3. 为新操作生成幂等键，调用 `update_studio` 修改标题或部分设置。至少提供标题或一项设置。
4. 需要收藏时重新读取状态，将最新 revision 和新的幂等键传给 `save_artwork`。
5. 超时、断连或页面重载后先读取实际状态。确认原操作仍需重试时，复用原键和完全相同的参数。

`update_studio` 返回完整设置及新的 revision。`save_artwork` 返回作品 ID、标题和写入后的 revision；结果表示本机收藏已完成。
