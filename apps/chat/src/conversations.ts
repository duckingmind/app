export type ConversationMode = 'chat' | 'image' | 'video' | 'music' | 'voice'
export type ConversationKind = ConversationMode | 'mixed'
export type ConversationFilter = 'all' | ConversationMode

type ConversationMessage = {
  id?: string
  role: 'user' | 'assistant'
  content: string
  mode?: ConversationMode
  media?: Array<{ type: 'image' | 'video' | 'audio' }>
  taskId?: string
  idempotencyKey?: string
  state?: 'complete' | 'streaming' | 'error' | 'stopped' | string
  createdAt?: string
}

export type ConversationLike = {
  createdAt: string
  updatedAt: string
  mode?: ConversationMode
  messages: ConversationMessage[]
}

export function sortConversations<T extends ConversationLike>(value: T[], limit = 20) {
  return [...value].sort((a, b) => {
    const updated = b.updatedAt.localeCompare(a.updatedAt)
    if (updated) return updated
    return b.createdAt.localeCompare(a.createdAt)
  }).slice(0, limit)
}

export function conversationKind(conversation: ConversationLike): ConversationKind {
  const kinds = new Set<ConversationMode>()
  for (const message of conversation.messages) {
    if (message.mode) kinds.add(message.mode)
    for (const asset of message.media || []) {
      if (asset.type === 'image') kinds.add('image')
      if (asset.type === 'video') kinds.add('video')
      if (asset.type === 'audio' && message.mode !== 'voice') kinds.add('music')
    }
    if (message.mode === 'chat' || (!message.mode && conversation.mode === 'chat' && message.role === 'user')) kinds.add('chat')
    if ((!message.mode || message.mode === 'chat') && message.role === 'assistant' && message.content.trim() && !message.media?.length && !message.taskId && !message.idempotencyKey) kinds.add('chat')
  }
  if (kinds.size > 1) return 'mixed'
  return [...kinds][0] || conversation.mode || 'chat'
}

export function messageMatchesMode(message: ConversationMessage, mode: ConversationMode, fallbackMode: ConversationMode = 'chat') {
  if (message.mode) return message.mode === mode
  if (message.media?.some((asset) => asset.type === 'image')) return mode === 'image'
  if (message.media?.some((asset) => asset.type === 'video')) return mode === 'video'
  if (message.media?.some((asset) => asset.type === 'audio')) return mode === 'music'
  return fallbackMode === mode
}

/** Keep the sidebar and active conversation scoped to the selected creation type. */
export function conversationMatchesMode(conversation: ConversationLike, mode: ConversationMode) {
  if (!conversation.messages.length) return (conversation.mode || 'chat') === mode
  const kind = conversationKind(conversation)
  if (kind !== 'mixed') return kind === mode
  return conversation.messages.some((message) => messageMatchesMode(message, mode, conversation.mode || 'chat'))
}

/** Prefer a clean, single-type conversation; fall back to matching legacy mixed history. */
export function conversationForMode<T extends ConversationLike>(conversations: T[], mode: ConversationMode) {
  const sorted = sortConversations(conversations, conversations.length)
  return sorted.find((conversation) => conversationKind(conversation) === mode)
    || sorted.find((conversation) => conversationMatchesMode(conversation, mode))
}

export function conversationMatchesFilter(kind: ConversationKind, filter: ConversationFilter) {
  return filter === 'all' || kind === 'mixed' || kind === filter
}

export type CreativeTaskSummary = {
  conversationId: string
  conversationTitle: string
  messageId: string
  mode: Exclude<ConversationMode, 'chat'>
  prompt: string
  taskId?: string
  idempotencyKey?: string
  status: 'pending' | 'failed'
  updatedAt: string
}

/** Derive the recovery tray from the persisted chat history, so it needs no duplicate task store. */
export function creativeTaskSummaries<T extends ConversationLike & { id: string; title: string }>(conversations: T[]): CreativeTaskSummary[] {
  const tasks: CreativeTaskSummary[] = []
  for (const conversation of conversations) {
    conversation.messages.forEach((message, index) => {
      if (message.role !== 'assistant' || !message.mode || message.mode === 'chat') return
      const failed = message.state === 'error'
      const pending = (message.state === 'streaming' || message.state === 'stopped') && Boolean(message.taskId || message.idempotencyKey)
      if (!failed && !pending) return
      const source = conversation.messages.slice(0, index).reverse().find((candidate) =>
        candidate.role === 'user' && (candidate.mode === message.mode || (!candidate.mode && conversation.mode === message.mode)))
      tasks.push({
        conversationId: conversation.id,
        conversationTitle: conversation.title,
        messageId: message.id || `${conversation.id}:${index}`,
        mode: message.mode,
        prompt: source?.content || '',
        taskId: message.taskId,
        idempotencyKey: message.idempotencyKey,
        status: failed ? 'failed' : 'pending',
        updatedAt: message.createdAt || conversation.updatedAt,
      })
    })
  }
  return tasks.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
}
