import { agent, type AgentHandler, type AgentInvocationContext } from '@ducking-mind/proxy-app-sdk'
import { registerAgentTools } from './agent-tools.mjs'

export type ChatAgentConversation = {
  id: string
  title: string
  model?: string
  messages: Array<{
    id: string
    role: 'user' | 'assistant'
    content: string
    createdAt: string
    state: string
    error?: string
    requestId?: string
    mode?: string
    previewText?: string
    voiceId?: string
    taskId?: string
    idempotencyKey?: string
    attachmentNames?: string[]
    attachmentAssetIds?: string[]
    media?: Array<{ id: string; type: string; assetId?: string; contentType?: string; name?: string }>
  }>
  createdAt: string
  updatedAt: string
}
export type ChatAgentModel = { id: string; name: string; type?: string }
export type ChatAgentSnapshot = {
  ready: boolean
  reason?: string
  revision: string
  models: ChatAgentModel[]
  conversations: ChatAgentConversation[]
  activeConversationId: string
  selectedModel: string
  generating: boolean
}
export type ChatAgentHost = {
  snapshot(): ChatAgentSnapshot
  createConversation(model: string | undefined): ChatAgentConversation
  sendMessage(conversationId: string, content: string, model: string, signal: AbortSignal): Promise<{ conversation: ChatAgentConversation; assistantMessageId: string; status: string }>
  stopGeneration(): { stopped: boolean }
}
type Input = Record<string, unknown>
type Context = Pick<AgentInvocationContext, 'signal'>

type AgentMessageLike = ChatAgentConversation['messages'][number] & Record<string, unknown>

/** Project persisted UI messages into the stable, URL-free Agent contract. */
export function projectAgentConversation<T extends { id: string; title: string; model?: string; createdAt: string; updatedAt: string; messages: AgentMessageLike[] }>(conversation: T): ChatAgentConversation {
  return {
    id: conversation.id,
    title: conversation.title,
    ...(conversation.model ? { model: conversation.model } : {}),
    createdAt: conversation.createdAt,
    updatedAt: conversation.updatedAt,
    messages: conversation.messages.map((message) => ({
      id: message.id,
      role: message.role,
      content: message.content,
      createdAt: message.createdAt,
      state: message.state,
      ...(message.error ? { error: message.error } : {}),
      ...(message.requestId ? { requestId: message.requestId } : {}),
      ...(message.mode ? { mode: message.mode } : {}),
      ...(typeof message.previewText === 'string' ? { previewText: message.previewText } : {}),
      ...(typeof message.voiceId === 'string' ? { voiceId: message.voiceId } : {}),
      ...(message.taskId ? { taskId: message.taskId } : {}),
      ...(message.idempotencyKey ? { idempotencyKey: message.idempotencyKey } : {}),
      ...(message.attachmentNames ? { attachmentNames: message.attachmentNames } : {}),
      ...(message.attachmentAssetIds ? { attachmentAssetIds: message.attachmentAssetIds } : {}),
      ...(Array.isArray(message.media) ? { media: message.media.flatMap((asset) => {
        if (!asset || typeof asset !== 'object') return []
        const value = asset as Record<string, unknown>
        if (typeof value.id !== 'string' || typeof value.type !== 'string') return []
        return [{
          id: value.id,
          type: value.type,
          ...(typeof value.assetId === 'string' ? { assetId: value.assetId } : {}),
          ...(typeof value.contentType === 'string' ? { contentType: value.contentType } : {}),
          ...(typeof value.name === 'string' ? { name: value.name } : {}),
        }]
      }) } : {}),
    })),
  }
}

const asString = (value: unknown, field: string, max: number) => {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw Object.assign(new Error(`${field} 无效`), { code: 'CHAT_INVALID_INPUT', executionStarted: false })
  return value.trim()
}
const page = (input: Input) => {
  const offset = input.offset === undefined ? 0 : Number(input.offset)
  const limit = input.limit === undefined ? 20 : Number(input.limit)
  if (!Number.isInteger(offset) || offset < 0 || offset > 10000 || !Number.isInteger(limit) || limit < 1 || limit > 50) throw Object.assign(new Error('分页参数无效'), { code: 'CHAT_INVALID_INPUT', executionStarted: false })
  return { offset, limit }
}
const requireReady = (host: ChatAgentHost) => {
  const snapshot = host.snapshot()
  if (!snapshot.ready) throw Object.assign(new Error(snapshot.reason || '聊天应用尚未连接平台'), { code: 'CHAT_NOT_READY', executionStarted: false, retryable: true, nextAction: { type: 'wait' } })
  return snapshot
}
const requireWrite = (input: Input, snapshot: ChatAgentSnapshot) => {
  const key = asString(input.idempotency_key, 'idempotency_key', 128)
  if (key.length < 8) throw Object.assign(new Error('idempotency_key 至少需要 8 个字符'), { code: 'CHAT_INVALID_INPUT', executionStarted: false })
  if (input.expected_revision !== snapshot.revision) throw Object.assign(new Error('会话已变化，请重新读取会话后重试'), { code: 'CHAT_REVISION_CONFLICT', executionStarted: false, retryable: false, nextAction: { type: 'inspect_state', capability: 'read_conversations' } })
  return key
}

export function registerChatAgent(host: ChatAgentHost) {
  const handlers: Record<string, AgentHandler<Input, unknown>> = {}
  const operations = new Map<string, { fingerprint: string; promise: Promise<unknown> }>()
  const write = (name: string, handler: AgentHandler<Input, unknown>) => {
    handlers[name] = async (input, context) => {
      const args = (input && typeof input === 'object' && !Array.isArray(input) ? input : {}) as Input
      const snapshot = requireReady(host)
      const key = requireWrite(args, snapshot)
      const fingerprint = JSON.stringify(args)
      const operationKey = `${name}:${key}`
      const previous = operations.get(operationKey)
      if (previous) {
        if (previous.fingerprint !== fingerprint) throw Object.assign(new Error('同一幂等键不能用于不同参数'), { code: 'CHAT_IDEMPOTENCY_CONFLICT', executionStarted: false })
        return previous.promise
      }
      const promise = Promise.resolve().then(() => handler(args, context)).finally(() => { if (operations.get(operationKey)?.promise === promise) operations.delete(operationKey) })
      operations.set(operationKey, { fingerprint, promise })
      return promise
    }
  }
  handlers.read_conversations = async (input) => {
    const snapshot = requireReady(host); const { offset, limit } = page((input || {}) as Input)
    const items = snapshot.conversations.slice(offset, offset + limit).map(({ messages, ...conversation }) => ({ ...conversation, messageCount: messages.length }))
    return { revision: snapshot.revision, conversations: items, total: snapshot.conversations.length, nextOffset: offset + limit < snapshot.conversations.length ? offset + limit : null }
  }
  handlers.read_messages = async (input) => {
    const snapshot = requireReady(host); const args = (input || {}) as Input; const conversationId = asString(args.conversation_id, 'conversation_id', 128); const { offset, limit } = page(args)
    const conversation = snapshot.conversations.find(item => item.id === conversationId)
    if (!conversation) throw Object.assign(new Error('会话不存在'), { code: 'CHAT_NOT_FOUND', executionStarted: false })
    const messages = conversation.messages.slice(offset, offset + limit)
    const safeConversation = projectAgentConversation(conversation)
    return { revision: snapshot.revision, conversationId, messages: safeConversation.messages.slice(offset, offset + limit), total: conversation.messages.length, nextOffset: offset + limit < conversation.messages.length ? offset + limit : null }
  }
  handlers.list_models = async () => {
    const snapshot = requireReady(host)
    return { revision: snapshot.revision, models: snapshot.models, selectedModel: snapshot.selectedModel }
  }
  write('create_conversation', async (input) => {
    const snapshot = requireReady(host); const model = input.model === undefined ? snapshot.selectedModel : asString(input.model, 'model', 200)
    if (model && !snapshot.models.some(item => item.id === model)) throw Object.assign(new Error('模型不可用'), { code: 'CHAT_INVALID_INPUT', executionStarted: false })
    const conversation = host.createConversation(model)
    return { revision: host.snapshot().revision, conversation: projectAgentConversation(conversation) }
  })
  write('send_message', async (input, context) => {
    const snapshot = requireReady(host); const conversationId = asString(input.conversation_id, 'conversation_id', 128); const content = asString(input.content, 'content', 24000)
    const model = input.model === undefined ? (snapshot.conversations.find(item => item.id === conversationId)?.model || snapshot.selectedModel) : asString(input.model, 'model', 200)
    if (!model || !snapshot.models.some(item => item.id === model)) throw Object.assign(new Error('模型不可用'), { code: 'CHAT_INVALID_INPUT', executionStarted: false })
    if (snapshot.generating) throw Object.assign(new Error('已有消息正在生成，请等待完成或先停止'), { code: 'CHAT_BUSY', executionStarted: false, retryable: true, nextAction: { type: 'wait' } })
    const result = await host.sendMessage(conversationId, content, model, context.signal)
    return { revision: host.snapshot().revision, ...result, conversation: projectAgentConversation(result.conversation as ChatAgentConversation & { messages: AgentMessageLike[] }) }
  })
  write('stop_generation', async () => {
    const result = host.stopGeneration()
    return { revision: host.snapshot().revision, ...result }
  })
  const disposers = registerAgentTools({
    register(declaration, handler) {
      if (typeof handler !== 'function') throw new Error(`Chat handler is missing: ${declaration.name}`)
      return agent.register(declaration, handler as AgentHandler)
    },
  }, handlers)
  return () => disposers.reverse().forEach(dispose => dispose())
}
