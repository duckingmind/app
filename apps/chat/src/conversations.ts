export type ConversationMode = 'chat' | 'image' | 'video' | 'music'
export type ConversationKind = ConversationMode | 'mixed'
export type ConversationFilter = 'all' | ConversationMode

type ConversationMessage = {
  role: 'user' | 'assistant'
  content: string
  mode?: ConversationMode
  media?: Array<{ type: 'image' | 'video' | 'audio' }>
  taskId?: string
  idempotencyKey?: string
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
      if (asset.type === 'audio') kinds.add('music')
    }
    if (message.mode === 'chat' || (!message.mode && conversation.mode === 'chat' && message.role === 'user')) kinds.add('chat')
    if ((!message.mode || message.mode === 'chat') && message.role === 'assistant' && message.content.trim() && !message.media?.length && !message.taskId && !message.idempotencyKey) kinds.add('chat')
  }
  if (kinds.size > 1) return 'mixed'
  return [...kinds][0] || conversation.mode || 'chat'
}

export function conversationMatchesFilter(kind: ConversationKind, filter: ConversationFilter) {
  return filter === 'all' || kind === 'mixed' || kind === filter
}
