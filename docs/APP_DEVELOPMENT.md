# 应用开发指南

这份文档面向第一次创建 Proxy App 的开发者。应用本身只实现界面和业务处理器；外部 Codex 通过主应用发布的本地 MCP 工具调用应用，应用内部不运行 Agent。

## 十分钟创建一个可调用应用

```bash
proxy-app init apps/my-app --name "我的应用"
cd apps/my-app
npm install
proxy-app create
npm run dev
```

已有平台应用只需把 `manifest.id` 设为平台应用的公开 slug，然后在应用目录运行 `npm run dev`；开发授权、平台代理和热更新由 CLI 统一启动，无需绑定或修复。

`init` 会生成 Web 应用，并预置一个 `read_metadata` 能力。Agent manifest 同时保留私有桌面宿主可识别的 `desktop` 兼容目标；该目标只定义应用契约，不提供桌面宿主源码或桌面构建能力。生成的目录包含：

```text
my-app/
├── manifest.json          # 运行目标和应用基础信息
├── src/agent-tools.mjs    # Agent 元数据、能力定义和运行时共用代码
├── src/agent-tools.d.mts  # 能力模块的 TypeScript 类型
├── src/main.ts            # SDK 初始化和处理器注册
├── agent/guide.md         # 应用工作规则
├── agent/workflow.md      # 多步调用流程
├── agent/examples.json    # 经过 schema 校验的调用示例
└── README.md
```

`src/agent-tools.mjs` 是源码侧的 MCP 能力定义，应用处理器通过同一份定义注册；增删该模块或其中的能力会改变构建结果。CLI 按约定发现此模块，并从它生成发布 manifest 中的能力目录。主应用使用这份构建快照，在应用尚未启动时也能发现工具和读取 API 参考。源码 `manifest.json` 不包含 `agent` 配置。

清单也无需填写 `apis`、`permissions`、`backend`、`pricing`：默认使用平台 Gateway，公开数据接口由
平台签发的 App Session 或 API Key scope、账户权益和路由策略控制，应用默认可使用公开 KV。已有应用
可以保留 `apis` 作为能力目录元数据，但它不会额外收窄 Gateway 授权。

## 添加一个能力

在 `src/agent-tools.mjs` 导出 Agent 元数据和完整能力定义，显式填写 `access`、`input_schema` 和 `output_schema`。该模块是项目代码，会在本地构建时加载，应保持不依赖浏览器状态或凭据：

```js
export const agentMetadata = {
  namespace: 'notes',
  targets: ['web', 'desktop'],
  contract_version: '1.0.0',
  summary: '读取和编辑文档。',
  keywords: ['notes', '文档'],
  guide: { entry: 'agent/guide.md' },
  examples: 'agent/examples.json',
}

export const capabilities = [{
  name: 'read_document',
  description: '读取当前文档摘要。',
  access: 'read',
  idempotent: true,
  targets: ['web', 'desktop'],
  input_schema: {
    type: 'object',
    properties: { document_id: { type: 'string' } },
    required: ['document_id'],
    additionalProperties: false,
  },
  output_schema: {
    type: 'object',
    properties: { id: { type: 'string' }, text: { type: 'string' } },
    required: ['id', 'text'],
    additionalProperties: false,
  },
}]

export function capability(name) {
  const declaration = capabilities.find(item => item.name === name)
  if (!declaration) throw new Error('Unknown capability: ' + name)
  return declaration
}
```

处理器注册引用同一份定义：

```ts
import { agent } from '@ducking-mind/proxy-app-sdk'
import { capability } from './agent-tools.mjs'

const unregister = agent.register<{ document_id: string }, { id: string; text: string }>(capability('read_document'), async (input, context) => {
  context.signal.throwIfAborted()
  return editor.readDocument(input.document_id)
})

agent.setStatus({ state: 'ready' }, { scope: 'editor', priority: 10 })
await agent.ready()
```

处理器挂载、登录或文档加载完成后再注册；组件卸载时调用返回的注销函数。

### 迁移已有应用

已发布应用包仍可使用旧版 manifest 契约；迁移仅影响源码校验、构建和后续发布。把旧 `manifest.agent` 中的元数据（`namespace`、`targets`、`contract_version`、`summary`、`keywords`、`guide`、`examples`）移到 `src/agent-tools.mjs` 的 `agentMetadata`，把 `capabilities` 数组原样移到同一文件并继续让业务处理器从 `capability(name)` 取得定义。旧的 `enabled` 和 `entry` 不需要迁移：模块存在时由构建生成启用的发布契约，入口按约定固定为 `src/agent-tools.mjs`。最后删除源码 manifest 中的整个 `agent` 字段，再运行 `proxy-app validate` 和 `proxy-app pack`。

## 写能力的约束

写能力必须在输入 schema 中要求字符串类型的 `idempotency_key`。涉及文档或节点时，同时要求 `expected_revision`，先读取最新状态再提交。超时、断连或进程退出后不要自动重放写入，先读取实际状态；确认同一操作仍需重试时，复用原幂等键和完全相同的参数。

业务前置条件通过 `agent.setStatus()` 表达：

| 状态 | 调用方行为 |
| --- | --- |
| `loading` | 等待应用完成初始化 |
| `auth_required` | 引导用户在主应用或应用内登录 |
| `no_document` | 先列出、打开或创建文档 |
| `ready` | 查询能力可用性后调用 |
| `busy` | 等待当前保存或写操作完成 |
| `error` | 按 `reason`、`retryable` 和 `nextAction` 恢复 |

## Web 与私有桌面宿主兼容目标

新应用由 Portal 以同源顶层页面启动。这样用户资料、KV 和 Gateway 请求都使用平台的 App Session Cookie。
`proxy-app init` 生成的源码在开发环境选择 `local`。manifest 不声明 runtime，入口统一为根目录的 `index.html`。

应用级 `agent.targets` 和能力级 `targets` 只能使用 `web`、`desktop`。这里的 `desktop` 是面向私有平台宿主的兼容目标；宿主源码、Electron 实现和发布流程不在公开仓库中。两种模式共用能力名、schema、授权和错误协议：

- `web`：主应用从云端加载 `index.html`，通过受控 Web Bridge 注册处理器。
- `desktop`：私有主应用下载并校验桌面包，在其受控运行时中注册处理器。

普通浏览器页面没有主应用 Bridge，SDK 会继续运行应用界面，但能力不会发布给 Codex。双目标应用可通过平台提供的桌面入口选择运行模式；公开 CLI 不构建或发布桌面安装包。

## 验证和发布

```bash
proxy-app validate
proxy-app pack -o dist/my-app.zip
```

`validate` 会加载代码能力模块，检查 manifest、目标、Schema、指南路径和示例，并比对已生成的发布契约；`pack` 会重新构建后再校验并输出 ZIP 和 SHA-256。构建前后会重新读取能力模块及依赖，代码契约在构建期间改变时拒绝打包。发布 manifest 自动写入 `contract_source: "code"` 和已校验的 Agent 元数据与能力清单。应用上传后，主应用在安装时只读取生成数据，不执行能力源代码，并再次校验包身份和摘要。

如果需要接入真实平台服务，再执行：

```bash
proxy-app create
npm run dev
proxy-app upload
proxy-app publish
```

桌面宿主协议、生命周期和恢复语义属于私有宿主实现；公开应用只依赖 SDK 中的能力声明和 Web 行为。
CLI 参数见[CLI 参考](../cli/README.md)。
