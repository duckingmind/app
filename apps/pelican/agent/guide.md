# 鹈鹕画室能力指南

鹈鹕画室提供可自定义的 SVG 鹈鹕骑车插画。用户还可以在界面自由绘画、导出 PNG / SVG，并将作品保存到当前浏览器的本地收藏。外部 Codex 通过主应用 MCP 调用业务能力，应用本身不运行 Agent。

`read_metadata` 返回 manifest 中的 `appId`、`version`、`name`。`read_studio` 返回当前标题、完整插画设置、收藏数量和不透明 `revision`。`update_studio` 局部修改标题或插画设置；`save_artwork` 收藏当前作品，不触发文件下载。

写操作必须使用最近读取的 `expected_revision` 和 8–128 字符的 `idempotency_key`。新操作使用新键，同一操作重试复用完全相同的键和所有参数。超时或断连后先读取实际状态，不能仅凭超时判定失败。页面内缓存最近 256 次完成的写入；页面重载后缓存不会保留。

标题最多 40 字符。场景可选 `coast`、`meadow`、`sunset`；配色可选 `teal`、`coral`、`mustard`、`lavender`；翅膀可选 `light`、`dark`。`lineWeight` 范围为 1.5–4，`variant` 为 0–99 的整数，`decorations` 是布尔值。未声明参数会被拒绝。
