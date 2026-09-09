import React from 'react'
import { createRoot } from 'react-dom/client'
import { createAppClient, type AppSdkError } from '@codex/proxy-app-sdk'
import appManifest from '../manifest.json'
import './styles.css'

type ModelItem = {
  id?: string
  model?: string
  slug?: string
  name?: string
  type?: string
  model_type?: string
  modality?: string
}

type MessageRole = 'user' | 'assistant'
type MessageState = 'complete' | 'streaming' | 'error' | 'stopped'

type ChatMessage = {
  id: string
  role: MessageRole
  content: string
  createdAt: string
  state: MessageState
  error?: string
  requestId?: string
}

type Conversation = {
  id: string
  title: string
  model?: string
  messages: ChatMessage[]
  createdAt: string
  updatedAt: string
}

type ErrorDetail = {
  message: string
  code?: string
  requestId?: string
  status?: number
  details?: unknown
}

type StatusKind = 'loading' | 'ready' | 'working' | 'error'

const app = createAppClient(appManifest.id, { localDevelopment: import.meta.env.DEV, localAppVersion: appManifest.version })
const CONVERSATIONS_KEY = 'chat:conversations'
const MAX_CONVERSATIONS = 20
const MAX_MESSAGES = 80
const MAX_MESSAGE_LENGTH = 24000
const MAX_STORAGE_CONTENT_LENGTH = 18000

const SUGGESTIONS = [
  '帮我把一个模糊想法整理成可执行的计划',
  '解释一个我不太理解的技术概念',
  '为一款新产品想三个有差异化的方向',
]

function makeId(prefix = 'chat') {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
}

function now() {
  return new Date().toISOString()
}

function modelId(item: ModelItem) {
  return String(item.id || item.model || item.slug || '').trim()
}

function modelType(item: ModelItem) {
  return String(item.type || item.model_type || item.modality || '').trim().toLowerCase()
}

function getModels(payload: unknown): ModelItem[] {
  if (Array.isArray(payload)) return payload as ModelItem[]
  if (!payload || typeof payload !== 'object') return []
  const record = payload as Record<string, unknown>
  if (Array.isArray(record.data)) return record.data as ModelItem[]
  if (Array.isArray(record.items)) return record.items as ModelItem[]
  if (record.data && typeof record.data === 'object') {
    const data = record.data as Record<string, unknown>
    if (Array.isArray(data.data)) return data.data as ModelItem[]
    if (Array.isArray(data.items)) return data.items as ModelItem[]
  }
  return []
}

function isTextModel(item: ModelItem) {
  const type = modelType(item)
  if (type === 'text' || type === 'llm' || type === 'language' || type === 'chat') return true
  if (type === 'image' || type === 'video' || type === 'audio' || type === 'music') return false
  const id = modelId(item).toLowerCase()
  return Boolean(id) && !/(image|video|audio|music|embedding|tts|whisper|vision)/.test(id)
}

function normalizeModels(payload: unknown) {
  const seen = new Set<string>()
  return getModels(payload).filter((item) => {
    const id = modelId(item)
    if (!id || !isTextModel(item) || seen.has(id)) return false
    seen.add(id)
    return true
  })
}

function modelName(item: ModelItem) {
  const id = modelId(item)
  return item.name && item.name !== id ? item.name : id
}

function titleFor(content: string) {
  const title = content.replace(/\s+/g, ' ').trim()
  return title.length > 28 ? `${title.slice(0, 28)}...` : title || '新对话'
}

function createConversation(model?: string): Conversation {
  const timestamp = now()
  return { id: makeId('conversation'), title: '新对话', model, messages: [], createdAt: timestamp, updatedAt: timestamp }
}

function normalizeMessage(value: unknown): ChatMessage | null {
  if (!value || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  const role = record.role === 'user' || record.role === 'assistant' ? record.role : null
  const content = typeof record.content === 'string' ? record.content.slice(0, MAX_STORAGE_CONTENT_LENGTH) : ''
  if (!role || (!content && record.state !== 'streaming')) return null
  const state = record.state === 'error' || record.state === 'stopped' || record.state === 'streaming' ? record.state : 'complete'
  return {
    id: typeof record.id === 'string' && record.id ? record.id : makeId('message'),
    role,
    content,
    createdAt: typeof record.createdAt === 'string' ? record.createdAt : now(),
    state: state === 'streaming' ? 'stopped' : state,
    error: typeof record.error === 'string' ? record.error : undefined,
    requestId: typeof record.requestId === 'string' ? record.requestId : undefined,
  }
}

function normalizeConversation(value: unknown): Conversation | null {
  if (!value || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  const rawMessages = Array.isArray(record.messages) ? record.messages : []
  const messages = rawMessages.map(normalizeMessage).filter((item): item is ChatMessage => Boolean(item)).slice(-MAX_MESSAGES)
  return {
    id: typeof record.id === 'string' && record.id ? record.id : makeId('conversation'),
    title: typeof record.title === 'string' && record.title ? record.title : titleFor(messages.find((item) => item.role === 'user')?.content || ''),
    model: typeof record.model === 'string' ? record.model : undefined,
    messages,
    createdAt: typeof record.createdAt === 'string' ? record.createdAt : now(),
    updatedAt: typeof record.updatedAt === 'string' ? record.updatedAt : now(),
  }
}

function normalizeConversations(value: unknown) {
  if (!Array.isArray(value)) return []
  const seen = new Set<string>()
  return value.map(normalizeConversation).filter((item): item is Conversation => {
    if (!item || seen.has(item.id)) return false
    seen.add(item.id)
    return true
  }).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, MAX_CONVERSATIONS)
}

function errorDetail(error: unknown): ErrorDetail {
  const sdkError = error as Partial<AppSdkError>
  const message = typeof sdkError?.message === 'string' && sdkError.message.trim()
    ? sdkError.message.trim()
    : '暂时无法连接平台，请稍后重试。'
  return {
    message,
    code: typeof sdkError?.code === 'string' ? sdkError.code : undefined,
    requestId: typeof sdkError?.requestId === 'string' ? sdkError.requestId : undefined,
    status: typeof sdkError?.status === 'number' ? sdkError.status : undefined,
    details: sdkError?.details,
  }
}

function isLocalRuntime() {
  if (typeof window === 'undefined') return false
  return ['localhost', '127.0.0.1', '[::1]', '::1'].includes(window.location.hostname)
}

function platformErrorDetail(error: unknown): ErrorDetail {
  const detail = errorDetail(error)
  if (!isLocalRuntime()) return detail
  if (detail.code === 'APP_LOGIN_POPUP_BLOCKED' || detail.code === 'APP_LOGIN_REQUIRED') {
    return {
      ...detail,
      code: 'APP_LOGIN_REQUIRED',
      message: '请完成 OAuth 授权后继续。若授权窗口未出现，请点击“OAuth 授权”。',
    }
  }
  if (detail.code === 'APP_APP_REGISTRATION_FAILED') {
    return {
      ...detail,
      message: detail.message || '应用本地开发登记失败，请确认当前登录账户拥有该应用，并检查本地项目绑定。',
    }
  }
  if (detail.code === 'APP_SESSION_CREATE_FAILED' || detail.code === 'APP_SESSION_INVALID') {
    return {
      ...detail,
      message: detail.message || '应用会话创建失败，请重新授权后再试。',
    }
  }
  if (detail.code === 'LOCAL_DEV_RUNTIME_NOT_CONFIGURED' || detail.status === 404) {
    return {
      ...detail,
      code: 'LOCAL_PROXY_NOT_CONFIGURED',
      message: '本地开发运行时没有响应。请使用 proxy-app dev 启动应用，不要直接运行 vite。',
    }
  }
  if (detail.status === 502 || detail.status === 503 || detail.status === 504) {
    return {
      ...detail,
      code: 'LOCAL_GATEWAY_UNAVAILABLE',
      message: '本地平台连接暂时不可用，请确认 proxy-app dev 已启动，并检查平台登录状态。',
    }
  }
  return detail
}

const OAUTH_ERROR_CODES = new Set([
  'APP_LOGIN_REQUIRED',
  'APP_LOGIN_POPUP_BLOCKED',
  'APP_LOGIN_TIMEOUT',
  'APP_LOGIN_FAILED',
  'APP_LOGIN_SESSION_EXPIRED',
  'APP_LOGIN_TOKEN_INVALID',
  'APP_LOGIN_STATE_INVALID',
])

const APP_SETUP_ERROR_CODES = new Set([
  'APP_APP_REGISTRATION_FAILED',
  'APP_SESSION_CREATE_FAILED',
  'APP_SESSION_INVALID',
  'APP_SESSION_REFRESH_FAILED',
])

function requiresOAuthAuthorization(detail: ErrorDetail | null) {
  return Boolean(detail?.code && OAUTH_ERROR_CODES.has(detail.code))
}

function requiresAppSetup(detail: ErrorDetail | null) {
  return Boolean(detail?.code && APP_SETUP_ERROR_CODES.has(detail.code))
}

function errorTitle(detail: ErrorDetail) {
  if (detail.code === 'NO_TEXT_MODELS') return '平台已连接，但没有可用模型'
  if (requiresOAuthAuthorization(detail)) return '需要 OAuth 授权'
  if (detail.code === 'APP_LOGIN_NOT_ALLOWED') return '当前账户无权开发此应用'
  if (requiresAppSetup(detail)) return '应用接入未完成'
  if (detail.code === 'LOCAL_PROXY_NOT_CONFIGURED') return '本地开发代理未启动'
  if (detail.code === 'LOCAL_GATEWAY_UNAVAILABLE') return '本地代理无法连接平台'
  return '平台连接遇到问题'
}

function errorActionLabel(detail: ErrorDetail) {
  if (requiresOAuthAuthorization(detail)) return 'OAuth 授权'
  if (detail.code === 'APP_LOGIN_NOT_ALLOWED') return '重新登录'
  if (requiresAppSetup(detail)) return '重新检查'
  if (detail.code === 'NO_TEXT_MODELS') return '重新检查'
  return '重新连接'
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? value as Record<string, unknown> : null
}

function parseEventPayload(value: unknown): unknown {
  if (typeof value !== 'string') return value
  try { return JSON.parse(value) as unknown } catch { return value }
}

function readStreamDelta(value: unknown): string {
  const parsed = parseEventPayload(value)
  if (typeof parsed === 'string') return parsed
  const record = asRecord(parsed)
  if (!record) return ''
  if (typeof record.delta === 'string') return record.delta
  if (typeof record.text_delta === 'string') return record.text_delta
  const choices = Array.isArray(record.choices) ? record.choices : []
  const choice = asRecord(choices[0])
  const delta = choice ? choice.delta : undefined
  if (typeof delta === 'string') return delta
  const deltaRecord = asRecord(delta)
  return deltaRecord && typeof deltaRecord.content === 'string' ? deltaRecord.content : ''
}

function readStreamFailure(value: unknown): string {
  const parsed = parseEventPayload(value)
  const record = asRecord(parsed)
  if (!record) return ''
  const response = asRecord(record.response) || record
  const nested = asRecord(response.error)
  const message = nested?.message || (typeof response.error === 'string' ? response.error : undefined) || record.message
  const type = String(record.type || '')
  return (type === 'response.failed' || type === 'error' || type.endsWith('.error')) && typeof message === 'string' ? message : ''
}

function readResponseText(value: unknown): string {
  const record = asRecord(value)
  if (!record) return typeof value === 'string' ? value : ''
  if (typeof record.output_text === 'string') return record.output_text
  if (typeof record.text === 'string') return record.text
  if (typeof record.content === 'string') return record.content
  const output = Array.isArray(record.output) ? record.output : []
  const parts: string[] = []
  for (const item of output) {
    const outputItem = asRecord(item)
    if (!outputItem) continue
    if (typeof outputItem.text === 'string') parts.push(outputItem.text)
    const content = Array.isArray(outputItem.content) ? outputItem.content : []
    for (const contentItem of content) {
      const contentRecord = asRecord(contentItem)
      if (contentRecord && typeof contentRecord.text === 'string') parts.push(contentRecord.text)
    }
  }
  return parts.join('\n')
}

function formatTime(value: string) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  return date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
}

function displayError(detail: ErrorDetail) {
  return detail.requestId ? `${detail.message}（请求编号 ${detail.requestId}）` : detail.message
}

function App() {
  const [models, setModels] = React.useState<ModelItem[]>([])
  const [selectedModel, setSelectedModel] = React.useState('')
  const [conversations, setConversations] = React.useState<Conversation[]>([])
  const [activeId, setActiveId] = React.useState('')
  const [input, setInput] = React.useState('')
  const [loading, setLoading] = React.useState(true)
  const [generating, setGenerating] = React.useState(false)
  const [status, setStatus] = React.useState('正在连接平台...')
  const [statusKind, setStatusKind] = React.useState<StatusKind>('loading')
  const [error, setError] = React.useState<ErrorDetail | null>(null)
  const [mobileSidebar, setMobileSidebar] = React.useState(false)
  const [copiedId, setCopiedId] = React.useState('')
  const [loadAttempt, setLoadAttempt] = React.useState(0)
  const textareaRef = React.useRef<HTMLTextAreaElement>(null)
  const messagesRef = React.useRef<HTMLDivElement>(null)
  const abortRef = React.useRef<AbortController | null>(null)
  const conversationsRef = React.useRef<Conversation[]>([])
  const activeIdRef = React.useRef('')
  const selectedModelRef = React.useRef('')
  const saveTimerRef = React.useRef<number | null>(null)
  const saveQueueRef = React.useRef(Promise.resolve())

  const persistNow = React.useCallback((value: Conversation[]) => {
    const snapshot = value.map((conversation) => ({
      ...conversation,
      messages: conversation.messages.map((message) => ({ ...message, content: message.content.slice(0, MAX_STORAGE_CONTENT_LENGTH) })),
    }))
    saveQueueRef.current = saveQueueRef.current.then(async () => {
      await app.storage.set(CONVERSATIONS_KEY, snapshot)
    }).catch(() => undefined)
  }, [])

  const updateConversations = React.useCallback((updater: (current: Conversation[]) => Conversation[], immediate = false) => {
    const next = updater(conversationsRef.current)
    conversationsRef.current = next
    setConversations(next)
    if (immediate) {
      if (saveTimerRef.current !== null) window.clearTimeout(saveTimerRef.current)
      saveTimerRef.current = null
      persistNow(next)
    } else if (saveTimerRef.current === null) {
      saveTimerRef.current = window.setTimeout(() => {
        saveTimerRef.current = null
        persistNow(conversationsRef.current)
      }, 350)
    }
  }, [persistNow])

  React.useEffect(() => {
    let active = true
    const load = async () => {
      setLoading(true)
      setError(null)
      setModels([])
      setSelectedModel('')
      selectedModelRef.current = ''
      try {
        await app.platform.createSession()
        const [modelsPayload, conversationsPayload] = await Promise.all([
          app.api.request('/models'),
          app.storage.get<unknown>(CONVERSATIONS_KEY),
        ])
        if (!active) return
        const availableModels = normalizeModels(modelsPayload)
        const stored = normalizeConversations(conversationsPayload)
        const loaded = stored.length ? stored : [createConversation(modelId(availableModels[0] || {}))]
        conversationsRef.current = loaded
        setConversations(loaded)
        const firstModel = modelId(availableModels.find((item) => stored[0]?.model === modelId(item)) || availableModels[0] || {})
        selectedModelRef.current = firstModel
        setSelectedModel(firstModel)
        setActiveId(loaded[0].id)
        activeIdRef.current = loaded[0].id
        setModels(availableModels)
        if (availableModels.length) {
          setStatus('平台已就绪')
          setStatusKind('ready')
        } else {
          setError({
            code: 'NO_TEXT_MODELS',
            message: '应用已连接平台，但当前没有可用的文本模型。请在平台模型目录启用至少一个文本模型后重试。',
          })
          setStatus('已连接，但没有可用模型')
          setStatusKind('error')
        }
        if (!stored.length) persistNow(loaded)
      } catch (loadError) {
        if (!active) return
        const detail = platformErrorDetail(loadError)
        setError(detail)
        setStatus(displayError(detail))
        setStatusKind('error')
      } finally {
        if (active) setLoading(false)
      }
    }
    void load()
    return () => {
      active = false
      abortRef.current?.abort()
      if (saveTimerRef.current !== null) window.clearTimeout(saveTimerRef.current)
    }
  }, [loadAttempt, persistNow])

  React.useEffect(() => {
    activeIdRef.current = activeId
    if (!activeId) return
    window.requestAnimationFrame(() => messagesRef.current?.scrollTo({ top: messagesRef.current.scrollHeight, behavior: 'smooth' }))
  }, [activeId])

  const activeConversation = conversations.find((conversation) => conversation.id === activeId) || conversations[0]
  const activeMessages = activeConversation?.messages || []
  const currentModel = models.find((item) => modelId(item) === selectedModel)
  const noTextModels = error?.code === 'NO_TEXT_MODELS'

  const retryConnection = (message = '正在重新连接平台...') => {
    setError(null)
    setStatus(message)
    setStatusKind('loading')
    setLoadAttempt((attempt) => attempt + 1)
  }

  const loginPlatform = async () => {
    setError(null)
    setStatus('正在打开 OAuth 授权...')
    setStatusKind('loading')
    try {
      await app.auth.login()
      retryConnection('授权完成，正在加载应用...')
    } catch (loginError) {
      const detail = platformErrorDetail(loginError)
      setError(detail)
      setStatus(displayError(detail))
      setStatusKind('error')
    }
  }

  const selectConversation = (id: string) => {
    if (generating) return
    const conversation = conversationsRef.current.find((item) => item.id === id)
    if (!conversation) return
    const nextModel = conversation.model && models.some((item) => modelId(item) === conversation.model)
      ? conversation.model
      : selectedModelRef.current || modelId(models[0] || {})
    setActiveId(id)
    activeIdRef.current = id
    selectedModelRef.current = nextModel
    setSelectedModel(nextModel)
    setError(null)
    setMobileSidebar(false)
  }

  const newConversation = () => {
    if (generating) return
    const conversation = createConversation(selectedModelRef.current || modelId(models[0] || {}))
    updateConversations((current) => [conversation, ...current].slice(0, MAX_CONVERSATIONS), true)
    setActiveId(conversation.id)
    activeIdRef.current = conversation.id
    setInput('')
    setError(null)
    setStatus('新对话已创建')
    setStatusKind('ready')
    setMobileSidebar(false)
    window.requestAnimationFrame(() => textareaRef.current?.focus())
  }

  const removeConversation = (id: string) => {
    if (generating) return
    const remaining = conversationsRef.current.filter((conversation) => conversation.id !== id)
    const next = remaining.length ? remaining : [createConversation(selectedModelRef.current || modelId(models[0] || {}))]
    updateConversations(() => next, true)
    const nextActive = id === activeIdRef.current ? next[0].id : activeIdRef.current
    setActiveId(nextActive)
    activeIdRef.current = nextActive
    setError(null)
  }

  const changeModel = (value: string) => {
    selectedModelRef.current = value
    setSelectedModel(value)
    updateConversations((current) => current.map((conversation) => conversation.id === activeIdRef.current ? { ...conversation, model: value, updatedAt: now() } : conversation), true)
    setStatus(value ? '模型已切换' : '请选择一个模型')
    setStatusKind(value ? 'ready' : 'error')
  }

  const updateMessage = (conversationId: string, messageId: string, updater: (message: ChatMessage) => ChatMessage, immediate = false) => {
    updateConversations((current) => current.map((conversation) => conversation.id === conversationId
      ? { ...conversation, updatedAt: now(), messages: conversation.messages.map((message) => message.id === messageId ? updater(message) : message) }
      : conversation), immediate)
  }

  const executeStream = async (conversationId: string, assistantId: string, requestMessages: ChatMessage[], model: string) => {
    const controller = new AbortController()
    abortRef.current?.abort()
    abortRef.current = controller
    setGenerating(true)
    setError(null)
    setStatus('正在生成回复...')
    setStatusKind('working')
    let output = ''
    let lastEventData: unknown = null
    try {
      for await (const event of app.api.stream<Record<string, unknown>>('/responses/stream', {
        method: 'POST',
        signal: controller.signal,
        body: JSON.stringify({
          model,
          input: requestMessages.map((message) => ({ role: message.role, content: message.content })),
        }),
      })) {
        lastEventData = event.data
        const streamFailure = readStreamFailure(event.data)
        if (streamFailure) throw new Error(streamFailure)
        const delta = readStreamDelta(event.data)
        if (delta) {
          output += delta
          updateMessage(conversationId, assistantId, (message) => ({ ...message, content: output, state: 'streaming' }))
        }
      }
      if (!output.trim()) {
        const record = asRecord(lastEventData)
        output = readResponseText(record?.response || lastEventData)
      }
      if (!output.trim()) throw new Error('平台没有返回可展示的文本。')
      updateMessage(conversationId, assistantId, (message) => ({ ...message, content: output.trim(), state: 'complete' }), true)
      setStatus('回复完成')
      setStatusKind('ready')
    } catch (streamError) {
      if (controller.signal.aborted) {
        updateMessage(conversationId, assistantId, (message) => ({ ...message, content: output, state: 'stopped', error: output ? '已停止生成' : '生成已停止' }), true)
        setStatus('已停止生成')
        setStatusKind('ready')
        return
      }
      const detail = platformErrorDetail(streamError)
      updateMessage(conversationId, assistantId, (message) => ({ ...message, content: output, state: 'error', error: detail.message, requestId: detail.requestId }), true)
      setError(detail)
      setStatus(displayError(detail))
      setStatusKind('error')
    } finally {
      if (abortRef.current === controller) abortRef.current = null
      setGenerating(false)
    }
  }

  const sendMessage = async () => {
    const content = input.trim()
    const conversation = conversationsRef.current.find((item) => item.id === activeIdRef.current)
    const model = selectedModelRef.current
    if (!content || !conversation || generating || !model) return
    const userMessage: ChatMessage = { id: makeId('message'), role: 'user', content: content.slice(0, MAX_MESSAGE_LENGTH), createdAt: now(), state: 'complete' }
    const assistantMessage: ChatMessage = { id: makeId('message'), role: 'assistant', content: '', createdAt: now(), state: 'streaming' }
    const requestMessages = [...conversation.messages, userMessage]
    updateConversations((current) => current.map((item) => item.id === conversation.id
      ? { ...item, title: item.messages.some((message) => message.role === 'user') ? item.title : titleFor(userMessage.content), model, updatedAt: now(), messages: [...requestMessages, assistantMessage].slice(-MAX_MESSAGES) }
      : item), true)
    setInput('')
    await executeStream(conversation.id, assistantMessage.id, requestMessages.slice(-MAX_MESSAGES), model)
  }

  const retryMessage = async (messageId: string) => {
    if (generating || !activeConversation || !selectedModelRef.current) return
    const index = activeConversation.messages.findIndex((message) => message.id === messageId)
    if (index < 0 || activeConversation.messages[index].role !== 'assistant') return
    const requestMessages = activeConversation.messages.slice(0, index)
    if (!requestMessages.some((message) => message.role === 'user')) return
    const assistantMessage: ChatMessage = { id: makeId('message'), role: 'assistant', content: '', createdAt: now(), state: 'streaming' }
    updateConversations((current) => current.map((item) => item.id === activeConversation.id
      ? { ...item, messages: [...requestMessages, assistantMessage], updatedAt: now() }
      : item), true)
    await executeStream(activeConversation.id, assistantMessage.id, requestMessages, selectedModelRef.current)
  }

  const stopGeneration = () => abortRef.current?.abort()

  const copyMessage = async (message: ChatMessage) => {
    if (!message.content) return
    try {
      await navigator.clipboard.writeText(message.content)
      setCopiedId(message.id)
      window.setTimeout(() => setCopiedId((current) => current === message.id ? '' : current), 1400)
    } catch {
      setStatus('复制失败，请手动选择文本')
      setStatusKind('error')
    }
  }

  const handleInputKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      void sendMessage()
    }
  }

  const chooseSuggestion = (suggestion: string) => {
    setInput(suggestion)
    window.requestAnimationFrame(() => textareaRef.current?.focus())
  }

  return (
    <main className="app-shell">
      <aside className={`sidebar ${mobileSidebar ? 'sidebar-open' : ''}`}>
        <div className="sidebar-head">
          <div className="brand"><span className="brand-icon" aria-hidden="true">✦</span><div><strong>即刻对话</strong><small>PROXY CHAT</small></div></div>
          <button className="mobile-close icon-button" type="button" onClick={() => setMobileSidebar(false)} aria-label="关闭会话栏" title="关闭会话栏">×</button>
        </div>
        <button className="new-chat" type="button" onClick={newConversation} disabled={loading || generating}><span aria-hidden="true">＋</span> 新对话</button>
        <div className="conversation-label"><span>最近对话</span><small>{conversations.length}</small></div>
        <div className="conversation-list">
          {conversations.map((conversation) => (
            <div className={`conversation-item ${conversation.id === activeId ? 'active' : ''}`} key={conversation.id}>
              <button className="conversation-select" type="button" onClick={() => selectConversation(conversation.id)}>
                <span className="conversation-symbol" aria-hidden="true">◌</span>
                <span className="conversation-text"><strong>{conversation.title}</strong><small>{conversation.messages.length ? formatTime(conversation.updatedAt) : '空白对话'}</small></span>
              </button>
              <button className="delete-conversation" type="button" onClick={() => removeConversation(conversation.id)} disabled={generating} title="删除对话" aria-label={`删除对话：${conversation.title}`}>×</button>
            </div>
          ))}
          {!conversations.length && <p className="sidebar-empty">还没有对话</p>}
        </div>
        <div className="sidebar-footer">
          <span className={`connection-dot ${statusKind === 'error' ? 'offline' : ''}`} />
          <span>{loading ? '正在连接' : noTextModels ? '已连接 · 无文本模型' : models.length ? '平台已连接' : '连接异常'}</span>
          <span className="footer-spacer" />
          <span className="privacy-mark" title="会话按当前用户隔离保存">⌁</span>
        </div>
      </aside>

      {mobileSidebar && <button className="sidebar-overlay" type="button" onClick={() => setMobileSidebar(false)} aria-label="关闭会话栏" />}

      <section className="chat-panel">
        <header className="chat-header">
          <button className="mobile-menu icon-button" type="button" onClick={() => setMobileSidebar(true)} aria-label="打开会话栏" title="打开会话栏">☰</button>
          <div className="chat-title"><span className="title-dot" /><div><strong>{activeConversation?.title || '新对话'}</strong><small>{activeMessages.length ? `${activeMessages.length} 条消息` : '开始一段新的对话'}</small></div></div>
          <div className="header-actions">
            <label className="model-select" title="选择平台文本模型">
              <span>模型</span>
              <select value={selectedModel} onChange={(event) => changeModel(event.target.value)} disabled={loading || generating || !models.length} aria-label="选择平台文本模型">
                {!models.length && <option value="">{loading ? '正在加载模型' : '暂无可用文本模型'}</option>}
                {models.map((item) => <option value={modelId(item)} key={modelId(item)}>{modelName(item)}</option>)}
              </select>
              <b aria-hidden="true">⌄</b>
            </label>
            <div className={`status-chip ${statusKind}`}><i />{statusKind === 'working' ? '生成中' : statusKind === 'error' ? '需要处理' : statusKind === 'loading' ? '连接中' : '已就绪'}</div>
          </div>
        </header>

        {error && <div className={`error-banner ${error.code === 'NO_TEXT_MODELS' ? 'model-empty' : ''} ${error.code === 'LOCAL_PROXY_NOT_CONFIGURED' || error.code === 'LOCAL_GATEWAY_UNAVAILABLE' ? 'local-proxy-error' : ''}`} role="alert"><span className="error-badge">!</span><div className="error-copy"><strong>{errorTitle(error)}</strong><span>{error.message}</span>{error.requestId && <small>请求编号 {error.requestId}</small>}{requiresOAuthAuthorization(error) || error.code === 'APP_LOGIN_NOT_ALLOWED' ? <button className="error-retry" type="button" onClick={() => void loginPlatform()}>{errorActionLabel(error)}</button> : <button className="error-retry" type="button" onClick={() => retryConnection()}>{errorActionLabel(error)}</button>}</div>{error.code !== 'NO_TEXT_MODELS' && <button type="button" onClick={() => setError(null)} aria-label="关闭错误提示" title="关闭">×</button>}</div>}

        <div className="messages" ref={messagesRef}>
          {!activeMessages.length && noTextModels && (
            <div className="connection-state model-state" role="status">
              <div className="connection-state-icon" aria-hidden="true">⌁</div>
              <p className="connection-state-kicker">平台连接正常</p>
              <h1>还没有可用的文本模型</h1>
              <p className="connection-state-copy">当前账户没有可用的文本模型，请检查平台模型配置和应用权限。</p>
              <div className="connection-actions">
                <button className="connection-primary" type="button" onClick={() => retryConnection()}>重新检查模型</button>
              </div>
            </div>
          )}
          {!activeMessages.length && loading && (
            <div className="connection-state loading-state" role="status" aria-live="polite">
              <div className="connection-state-icon loading-icon" aria-hidden="true">...</div>
              <p className="connection-state-kicker">正在建立连接</p>
              <h1>正在读取平台模型</h1>
              <p className="connection-state-copy">正在通过本地开发代理连接平台，并加载当前应用可用的文本模型。</p>
            </div>
          )}
          {!activeMessages.length && !loading && !noTextModels && error && (
            <div className="connection-state model-state" role="status">
              <div className="connection-state-icon" aria-hidden="true">!</div>
              <p className="connection-state-kicker">{requiresOAuthAuthorization(error) ? 'OAuth 授权未完成' : error.code === 'APP_LOGIN_NOT_ALLOWED' ? '当前账户无权访问' : requiresAppSetup(error) ? '应用接入未完成' : '连接未完成'}</p>
              <h1>暂时无法开始对话</h1>
              <p className="connection-state-copy">{error.message}</p>
              <button className="connection-primary" type="button" onClick={requiresOAuthAuthorization(error) || error.code === 'APP_LOGIN_NOT_ALLOWED' ? () => void loginPlatform() : () => retryConnection()}>{errorActionLabel(error)}</button>
            </div>
          )}
          {!activeMessages.length && !loading && !noTextModels && !error && (
            <div className="welcome">
              <div className="welcome-symbol" aria-hidden="true">✦</div>
              <p className="welcome-kicker">GOOD TO HAVE YOU HERE</p>
              <h1>今天想聊点什么？</h1>
              <p className="welcome-copy">把问题、想法或正在做的事交给我，我们一起把它理清楚。</p>
              <div className="suggestions">
                {SUGGESTIONS.map((suggestion) => <button type="button" key={suggestion} onClick={() => chooseSuggestion(suggestion)}>{suggestion}<span aria-hidden="true">↗</span></button>)}
              </div>
            </div>
          )}
          {activeMessages.map((message) => (
            <article className={`message-row ${message.role}`} key={message.id}>
              <div className="avatar" aria-hidden="true">{message.role === 'user' ? '我' : '✦'}</div>
              <div className="message-column">
                <div className="message-meta"><strong>{message.role === 'user' ? '你' : '即刻对话'}</strong><time>{formatTime(message.createdAt)}</time></div>
                <div className={`message-bubble ${message.state}`}>
                  {message.content ? <div className="message-content">{message.content}</div> : message.state === 'streaming' ? <div className="typing"><i /><i /><i /></div> : null}
                  {message.state === 'error' && <div className="message-error">{message.error || '这条消息生成失败'}{message.requestId && <small>请求编号 {message.requestId}</small>}</div>}
                  {message.state === 'stopped' && <div className="message-stopped">{message.error || '生成已停止'}</div>}
                </div>
                {message.role === 'assistant' && <div className="message-actions">
                  <button type="button" onClick={() => void copyMessage(message)} disabled={!message.content || message.state === 'streaming'} title="复制回复" aria-label="复制回复">{copiedId === message.id ? '✓ 已复制' : '⧉ 复制'}</button>
                  {(message.state === 'error' || message.state === 'stopped') && <button type="button" onClick={() => void retryMessage(message.id)} disabled={generating || !selectedModel} title="重试回复" aria-label="重试回复">↻ 重试</button>}
                </div>}
              </div>
            </article>
          ))}
        </div>

        <div className="composer-wrap">
          {!currentModel && !loading && !noTextModels && <div className="model-notice">当前没有可用的文本模型，暂时无法发送消息。</div>}
          <div className="composer">
            <textarea ref={textareaRef} value={input} onChange={(event) => setInput(event.target.value.slice(0, MAX_MESSAGE_LENGTH))} onKeyDown={handleInputKeyDown} placeholder={currentModel ? '输入消息，开始对话...' : '等待平台模型可用'} disabled={loading || generating || !currentModel} aria-label="消息输入框" />
            <div className="composer-bottom"><span>{input.length ? `${input.length.toLocaleString()}/${MAX_MESSAGE_LENGTH.toLocaleString()}` : ' '}</span>{generating ? <button className="stop-button" type="button" onClick={stopGeneration}><span aria-hidden="true">■</span> 停止生成</button> : <button className="send-button" type="button" onClick={() => void sendMessage()} disabled={!input.trim() || loading || !currentModel}><span aria-hidden="true">↗</span> 发送</button>}</div>
          </div>
          <p className="composer-note">内容由平台模型生成，请核验重要信息</p>
        </div>
      </section>
    </main>
  )
}

createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>)
