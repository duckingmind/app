import React from 'react'
import { createRoot } from 'react-dom/client'
import { agent, createAppClient, readAppSessionFromStorage, type AppSdkError } from '@ducking-mind/proxy-app-sdk'
import appManifest from '../manifest.json'
import { registerChatAgent } from './chatAgent'
import { conversationForMode, conversationKind, conversationMatchesMode, creativeTaskSummaries, messageMatchesMode, sortConversations } from './conversations'
import { createLocalChatPersistence } from './chatPersistence'
import { deliverMediaAssets } from './mediaDelivery'
import { singleFlight } from './singleFlight'
import ParameterPopover from './ParameterPopover'
import { ParameterChoices, RatioMark } from './ParameterChoices'
import { clipboardImageFiles, MAX_REFERENCE_IMAGE_SIZE, prepareReferenceImageFile, readReferenceAsset, readReferenceAssetFile, referenceImageAccept, restoreReferenceAsset, responsesContentWithImages, SUPPORTED_REFERENCE_IMAGE_TYPES, uploadReferenceAsset, videoImageReference, type ReferenceAsset } from './referenceUpload'
import {
  assetsFromResponse,
  creativeReferenceTransport,
  creativeModelId,
  errorMessage,
  imageAspectRatios,
  imageGenerationParameters,
  imageOptions,
  imageSettingsSummary,
  resolveImageSettings,
  updateImageSettings,
  modelDurationOptions,
  modelValues,
  modelsForMode,
  preferredModel,
  taskContentType,
  taskCancelPath,
  taskIdFrom,
  taskPath,
  taskStatus,
  submissionLookupPath,
  voiceIdFrom,
  type CreativeAsset,
  type CreativeMode,
  type CreativeModel,
  type ImageSettings,
} from './creative'
import './styles.css'

type ModelItem = CreativeModel

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
  mode?: CreativeMode
  previewText?: string
  voiceId?: string
  media?: CreativeAsset[]
  taskId?: string
  idempotencyKey?: string
  attachmentNames?: string[]
  attachmentAssetIds?: string[]
  /** Ephemeral Responses input; signed URLs are stripped before persistence. */
  requestContent?: unknown
}

type Conversation = {
  id: string
  title: string
  model?: string
  messages: ChatMessage[]
  createdAt: string
  updatedAt: string
  mode?: CreativeMode
}

type DraftReference = {
  id: string
  file: File
  preview: string
  assetId?: string
  url?: string
  contentType?: string
  uploadState?: 'restoring' | 'uploading' | 'ready' | 'error'
  uploadError?: string
}
type ConversationDraft = { input: string; references: DraftReference[]; previewText?: string }
type StoredDraftReference = { id: string; name: string; assetId: string; contentType?: string }
type StoredConversationDraft = { input: string; references: StoredDraftReference[]; previewText?: string }
type CreativeRetryRequest = {
  conversationId: string
  mode: Exclude<CreativeMode, 'chat'>
  content: string
  previewText?: string
  references: DraftReference[]
  model: string
  assistantId: string
}

type ErrorDetail = {
  message: string
  code?: string
  requestId?: string
  status?: number
  details?: unknown
}

type StatusKind = 'loading' | 'ready' | 'working' | 'error'

type ChatToast = {
  detail: ErrorDetail
  action?: 'login' | 'retry' | 'none'
}

const electronHost = typeof window !== 'undefined' && Boolean((window as Window & { proxyApp?: unknown }).proxyApp)
const appSession = !import.meta.env.DEV && !electronHost ? readAppSessionFromStorage(appManifest.id) : undefined
const app = createAppClient(appManifest.id, {
  runtime: import.meta.env.DEV ? 'local' : electronHost ? 'electron' : 'direct',
  ...(appSession ? { appSession } : {}),
  localDevelopment: import.meta.env.DEV,
  localAppVersion: appManifest.version,
  ...(import.meta.env.DEV && import.meta.env.VITE_PROXY_PORTAL_URL
    ? { portalURL: import.meta.env.VITE_PROXY_PORTAL_URL }
    : {}),
})
function appApiGet<T = unknown>(path: string) {
  const accountScope = app.session()?.account_scope || 'unauthenticated'
  return singleFlight(`chat:api:get:${accountScope}:${path}`, () => app.api.request<T>(path))
}

function createChatSession() {
  const session = app.session()
  const sessionScope = session?.account_scope || session?.access_token || 'unauthenticated'
  return singleFlight(`chat:platform:create-session:${sessionScope}`, () => app.platform.createSession())
}

const referenceAssetApi = { request: appApiGet }
const CONVERSATIONS_KEY = 'chat:conversations'
const DRAFTS_KEY = 'chat:drafts'
const MAX_CONVERSATIONS = 20
const MAX_MESSAGES = 80
const MAX_MESSAGE_LENGTH = 24000
const MAX_STORAGE_CONTENT_LENGTH = 18000
const MAX_LOCAL_CONVERSATION_CHARS = 1_000_000
const MAX_LOCAL_DRAFT_CHARS = 500_000
const MAX_CREATIVE_REFERENCES = 4
const MAX_CHAT_ATTACHMENTS = 16
const MAX_IMAGE_EDIT_REQUEST_BYTES = 96 * 1024 * 1024
const MEDIA_POLL_INTERVAL_MS = 1800
const MEDIA_POLL_ATTEMPTS = 100
const MAX_AUTO_RECOVERY_TASKS = 3
const MAX_STORED_DRAFTS = 40
let activeAgentCleanup: (() => void) | null = null

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    activeAgentCleanup?.()
    activeAgentCleanup = null
  })
}

const SUGGESTIONS = [
  '帮我把一个模糊想法整理成可执行的计划',
  '解释一个我不太理解的技术概念',
  '为一款新产品想三个有差异化的方向',
]

const CREATIVE_MODES: Array<{ id: CreativeMode; label: string; symbol: string }> = [
  { id: 'chat', label: '对话', symbol: '◌' },
  { id: 'image', label: '图片', symbol: '▧' },
  { id: 'video', label: '视频', symbol: '▷' },
  { id: 'music', label: '音频', symbol: '♫' },
]

function modeLabel(mode: CreativeMode) {
  if (mode === 'voice') return '音色设计'
  return CREATIVE_MODES.find((item) => item.id === mode)?.label || '对话'
}

function isAudioMode(mode: CreativeMode) {
  return mode === 'music' || mode === 'voice'
}

function conversationKindLabel(kind: ReturnType<typeof conversationKind>) {
  if (kind === 'mixed') return '混合'
  return modeLabel(kind)
}

function optionsFor(model: ModelItem | undefined, key: string, fallbackKey = key) {
  return modelValues(model, key, fallbackKey)
}

function maxReferenceImages(model?: ModelItem) {
  const capabilities = model?.platform_capabilities
  const referenceValue = model?.max_reference_images ?? capabilities?.max_reference_images
  const inputValue = model?.max_input_images ?? capabilities?.max_input_images
  const referenceLimit = Number(referenceValue)
  const inputLimit = Number(inputValue)
  if (referenceValue != null && Number.isInteger(referenceLimit) && referenceLimit > 0) return referenceLimit
  if (inputValue != null && Number.isInteger(inputLimit) && inputLimit >= 0) return inputLimit
  if (referenceValue != null && Number.isInteger(referenceLimit) && referenceLimit >= 0) return referenceLimit
  return MAX_CREATIVE_REFERENCES
}

function maxAttachmentsForMode(mode: CreativeMode, model?: ModelItem) {
  return mode === 'chat' ? MAX_CHAT_ATTACHMENTS : Math.min(MAX_CREATIVE_REFERENCES, maxReferenceImages(model))
}

function supportsReferenceImages(model: ModelItem | undefined, mode: 'image' | 'video') {
  if (!model) return false
  const declaredModes = model.supported_input_modes ?? model.platform_capabilities?.supported_input_modes
  if (Array.isArray(declaredModes)) {
    return declaredModes.some((value) => ['image', 'reference', 'references', 'reference_image', 'single_reference', 'multi_reference'].includes(String(value).trim().toLowerCase()))
  }
  const referenceTypes = optionsFor(model, 'supported_reference_types')
  if (referenceTypes.some((value) => value.trim().toLowerCase() === 'image')) return true
  const operations = optionsFor(model, 'supported_operations').map((value) => value.trim().toLowerCase())
  if (mode === 'image' && operations.includes('edit')) return true
  const referenceValue = model.max_reference_images ?? model.platform_capabilities?.max_reference_images
  const inputValue = model.max_input_images ?? model.platform_capabilities?.max_input_images
  return [referenceValue, inputValue].some((value) => Number.isInteger(Number(value)) && Number(value) > 0)
}

function selectedOption(value: string, options: string[], model: ModelItem | undefined, fallbackKey: string) {
  if (options.includes(value)) return value
  const defaults = model?.default_parameters || model?.platform_capabilities?.default_parameters as Record<string, unknown> | undefined
  const fallback = defaults?.[fallbackKey]
  if ((typeof fallback === 'string' || typeof fallback === 'number') && options.includes(String(fallback))) return String(fallback)
  return options[0] || ''
}

function videoResolutionLabel(value: string) {
  const normalized = value.trim()
  const match = normalized.match(/^(\d+)\s*([pPkK])$/)
  return match ? `${match[1]}${match[2].toUpperCase()}` : normalized
}

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

function createConversation(model?: string, mode: CreativeMode = 'chat'): Conversation {
  const timestamp = now()
  return { id: makeId('conversation'), title: '新对话', model, mode, messages: [], createdAt: timestamp, updatedAt: timestamp }
}

function fitStorageSnapshot(value: Conversation[]) {
  const snapshot = value.map((conversation) => ({
    ...conversation,
    messages: conversation.messages.map((message) => ({
      ...message,
      requestContent: undefined,
      content: message.content.slice(0, MAX_STORAGE_CONTENT_LENGTH),
      attachmentNames: message.attachmentNames?.slice(0, message.mode === 'chat' ? MAX_CHAT_ATTACHMENTS : MAX_CREATIVE_REFERENCES),
      attachmentAssetIds: message.attachmentAssetIds?.slice(0, message.mode === 'chat' ? MAX_CHAT_ATTACHMENTS : MAX_CREATIVE_REFERENCES),
      // Base64 is useful for the immediate preview but can exceed the app's
      // per-value storage limit. Keep durable asset identities instead.
      media: message.media?.map((asset) => ({
        ...asset,
        // Signed delivery URLs expire; the stable platform asset ID is enough
        // to refresh them when this conversation is opened again.
        url: asset.assetId || asset.url.startsWith('data:') || asset.url.startsWith('blob:') ? '' : asset.url,
      })),
    })),
  }))
  // Keep local history within a conservative share of the browser's per-origin
  // storage quota, pruning the oldest messages first when needed.
  while (snapshot.length && JSON.stringify(snapshot).length > MAX_LOCAL_CONVERSATION_CHARS) {
    const oldest = snapshot[snapshot.length - 1]
    if (oldest.messages.length > 1) oldest.messages.shift()
    else snapshot.pop()
  }
  return snapshot
}

function normalizeMessage(value: unknown): ChatMessage | null {
  if (!value || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  const role = record.role === 'user' || record.role === 'assistant' ? record.role : null
  const content = typeof record.content === 'string' ? record.content.slice(0, MAX_STORAGE_CONTENT_LENGTH) : ''
  const rawTaskId = typeof record.taskId === 'string' ? record.taskId : undefined
  const rawIdempotencyKey = typeof record.idempotencyKey === 'string' ? record.idempotencyKey : undefined
  const rawMode = record.mode === 'image' || record.mode === 'video' || record.mode === 'music' || record.mode === 'voice' || record.mode === 'chat' ? record.mode : undefined
  const media = Array.isArray(record.media) ? record.media.flatMap((entry) => {
    if (!entry || typeof entry !== 'object') return []
    const item = entry as Record<string, unknown>
    const type = item.type === 'image' || item.type === 'video' || item.type === 'audio' ? item.type : null
    if (!type) return []
    return [{
      id: typeof item.id === 'string' ? item.id : makeId('asset'),
      type,
      url: typeof item.url === 'string' ? item.url.slice(0, 4096) : '',
      assetId: typeof item.assetId === 'string' ? item.assetId : undefined,
      contentType: typeof item.contentType === 'string' ? item.contentType : undefined,
      name: typeof item.name === 'string' ? item.name : undefined,
    } satisfies CreativeAsset]
  }).slice(0, 12) : undefined
  if (!role || (!content && record.state !== 'streaming' && !media?.length && !rawTaskId && !rawIdempotencyKey)) return null
  const state = record.state === 'error' || record.state === 'stopped' || record.state === 'streaming' ? record.state : 'complete'
  const attachmentLimit = rawMode === 'chat' ? MAX_CHAT_ATTACHMENTS : MAX_CREATIVE_REFERENCES
  return {
    id: typeof record.id === 'string' && record.id ? record.id : makeId('message'),
    role,
    content,
    createdAt: typeof record.createdAt === 'string' ? record.createdAt : now(),
    state: state === 'streaming' && !rawTaskId && !rawIdempotencyKey ? 'stopped' : state,
    error: typeof record.error === 'string' ? record.error : undefined,
    requestId: typeof record.requestId === 'string' ? record.requestId : undefined,
    mode: rawMode,
    previewText: typeof record.previewText === 'string' ? record.previewText.slice(0, 500) : undefined,
    voiceId: typeof record.voiceId === 'string' ? record.voiceId.slice(0, 256) : undefined,
    media,
    taskId: rawTaskId,
    idempotencyKey: rawIdempotencyKey,
    attachmentNames: Array.isArray(record.attachmentNames) ? record.attachmentNames.filter((item): item is string => typeof item === 'string').slice(0, attachmentLimit) : undefined,
    attachmentAssetIds: Array.isArray(record.attachmentAssetIds) ? record.attachmentAssetIds.filter((item): item is string => typeof item === 'string' && Boolean(item.trim())).slice(0, attachmentLimit) : undefined,
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
    mode: record.mode === 'image' || record.mode === 'video' || record.mode === 'music' || record.mode === 'voice' || record.mode === 'chat' ? record.mode : 'chat',
    messages,
    createdAt: typeof record.createdAt === 'string' ? record.createdAt : now(),
    updatedAt: typeof record.updatedAt === 'string' ? record.updatedAt : now(),
  }
}

function normalizeConversations(value: unknown) {
  if (!Array.isArray(value)) return []
  const seen = new Set<string>()
  const normalized = value.map(normalizeConversation).filter((item): item is Conversation => {
    if (!item || seen.has(item.id)) return false
    seen.add(item.id)
    return true
  })
  return sortConversations(normalized, MAX_CONVERSATIONS)
}

function normalizeStoredDrafts(value: unknown): Record<string, Record<CreativeMode, StoredConversationDraft>> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const result: Record<string, Record<CreativeMode, StoredConversationDraft>> = {}
  for (const [key, raw] of Object.entries(value as Record<string, unknown>).slice(-MAX_STORED_DRAFTS)) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue
    const modeDrafts = {} as Record<CreativeMode, StoredConversationDraft>
    for (const mode of ['chat', 'image', 'video', 'music', 'voice'] as CreativeMode[]) {
      const candidate = (raw as Record<string, unknown>)[mode]
      if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) continue
      const record = candidate as Record<string, unknown>
      const references = Array.isArray(record.references)
        ? record.references.flatMap((reference) => {
          if (!reference || typeof reference !== 'object') return []
          const item = reference as Record<string, unknown>
          const assetId = typeof item.assetId === 'string' ? item.assetId.trim() : ''
          if (!assetId) return []
          return [{
            id: typeof item.id === 'string' && item.id ? item.id : makeId('reference'),
            name: typeof item.name === 'string' && item.name ? item.name : 'reference-image.png',
            assetId,
            ...(typeof item.contentType === 'string' && item.contentType ? { contentType: item.contentType } : {}),
          } satisfies StoredDraftReference]
        }).slice(0, mode === 'chat' ? MAX_CHAT_ATTACHMENTS : MAX_CREATIVE_REFERENCES)
        : []
      const input = typeof record.input === 'string' ? record.input.slice(0, MAX_MESSAGE_LENGTH) : ''
      const previewText = typeof record.previewText === 'string' ? record.previewText.slice(0, 500) : undefined
      if (!input && !references.length && !previewText) continue
      modeDrafts[mode] = { input, references, ...(previewText ? { previewText } : {}) }
    }
    if (Object.keys(modeDrafts).length) result[key] = modeDrafts
  }
  return result
}

function storedDraftSnapshot(value: Record<string, ConversationDraft>): Record<string, Record<string, StoredConversationDraft>> {
  const snapshot: Record<string, Record<string, StoredConversationDraft>> = {}
  for (const [key, draft] of Object.entries(value).slice(-MAX_STORED_DRAFTS)) {
    const separator = key.lastIndexOf(':')
    if (separator <= 0) continue
    const conversationId = key.slice(0, separator)
    const mode = key.slice(separator + 1) as CreativeMode
    if (!['chat', 'image', 'video', 'music', 'voice'].includes(mode)) continue
    const references = draft.references
      .filter((reference): reference is DraftReference & { assetId: string } => Boolean(reference.assetId))
      .slice(0, mode === 'chat' ? MAX_CHAT_ATTACHMENTS : MAX_CREATIVE_REFERENCES)
      .map((reference) => ({
        id: reference.id,
        name: reference.file.name || 'reference-image.png',
        assetId: reference.assetId,
        ...(reference.contentType ? { contentType: reference.contentType } : {}),
      }))
    if (!draft.input.trim() && !references.length && !draft.previewText?.trim()) continue
    if (!snapshot[conversationId]) snapshot[conversationId] = {}
    snapshot[conversationId][mode] = { input: draft.input.slice(0, MAX_MESSAGE_LENGTH), references, ...(draft.previewText ? { previewText: draft.previewText.slice(0, 500) } : {}) }
  }
  return snapshot
}

function fitStoredDraftSnapshot(value: Record<string, ConversationDraft>) {
  const snapshot = storedDraftSnapshot(value)
  let serialized = JSON.stringify(snapshot)
  while (Object.keys(snapshot).length && serialized.length > MAX_LOCAL_DRAFT_CHARS) {
    const oldestConversation = Object.keys(snapshot)[0]
    const oldestMode = Object.keys(snapshot[oldestConversation])[0]
    if (!oldestMode) {
      delete snapshot[oldestConversation]
    } else {
      delete snapshot[oldestConversation][oldestMode]
      if (!Object.keys(snapshot[oldestConversation]).length) delete snapshot[oldestConversation]
    }
    serialized = JSON.stringify(snapshot)
  }
  return snapshot
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
      message: app.auth.loginMode === 'app'
        ? '请完成桌面宿主授权后重试。'
        : '本地应用会话由 proxy-app dev 在启动时交接，请重新启动开发服务。',
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
  return app.auth.loginMode === 'app' && Boolean(detail?.code && OAUTH_ERROR_CODES.has(detail.code))
}

function canStartInteractiveLogin() {
  return app.auth.loginMode === 'app'
}

function requiresAppSetup(detail: ErrorDetail | null) {
  return Boolean(detail?.code && APP_SETUP_ERROR_CODES.has(detail.code))
}

function errorTitle(detail: ErrorDetail) {
  if (detail.code === 'NO_TEXT_MODELS') return '平台已连接，但没有可用模型'
  if (requiresOAuthAuthorization(detail)) return '需要 OAuth 授权'
  if (detail.code === 'APP_LOGIN_NOT_ALLOWED') return canStartInteractiveLogin() ? '当前账户无权开发此应用' : '应用会话不可用'
  if (requiresAppSetup(detail)) return '应用接入未完成'
  if (detail.code === 'LOCAL_PROXY_NOT_CONFIGURED') return '本地开发代理未启动'
  if (detail.code === 'LOCAL_GATEWAY_UNAVAILABLE') return '本地代理无法连接平台'
  return '平台连接遇到问题'
}

function errorActionLabel(detail: ErrorDetail) {
  if (requiresOAuthAuthorization(detail)) return 'OAuth 授权'
  if (detail.code === 'APP_LOGIN_NOT_ALLOWED') return canStartInteractiveLogin() ? '重新登录' : '重新打开应用'
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

function formatConversationDate(value: string) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  const today = new Date()
  if (date.toDateString() === today.toDateString()) return formatTime(value)
  const yesterday = new Date(today)
  yesterday.setDate(today.getDate() - 1)
  if (date.toDateString() === yesterday.toDateString()) return '昨天'
  return date.toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' })
}

function isChatMessage(message: ChatMessage, conversationMode: CreativeMode = 'chat') {
  if (message.mode) return message.mode === 'chat'
  if (message.media?.length || message.taskId || message.idempotencyKey) return false
  return conversationMode === 'chat'
}

function displayError(detail: ErrorDetail) {
  return detail.requestId ? `${detail.message}（请求编号 ${detail.requestId}）` : detail.message
}

function MessageAttachment({
  assetId,
  onPreview,
}: {
  assetId: string
  onPreview: (src: string) => void
}) {
  const [asset, setAsset] = React.useState<ReferenceAsset | null>(null)
  const [loading, setLoading] = React.useState(Boolean(assetId))
  const [failed, setFailed] = React.useState(false)
  const [attempt, setAttempt] = React.useState(0)

  React.useEffect(() => {
    if (!assetId) return
    let active = true
    setLoading(true)
    setFailed(false)
    void readReferenceAsset(referenceAssetApi, assetId).then((next) => {
      if (active) setAsset(next)
    }).catch(() => {
      if (active) setFailed(true)
    }).finally(() => {
      if (active) setLoading(false)
    })
    return () => { active = false }
  }, [assetId, attempt])

  if (!assetId) return <span className="message-attachment-unavailable" role="status">图片无法预览</span>
  const src = asset?.thumbnailURL || asset?.url || ''
  return <div className="message-attachment">
    {src
      ? <button type="button" className="message-attachment-preview" onClick={() => onPreview(asset?.url || src)} aria-label="预览图片" title="点击查看大图">
        <img src={src} alt="图片附件" loading="lazy" />
      </button>
      : <span className="message-attachment-unavailable" role={failed ? 'status' : undefined}>{loading ? '图片加载中…' : '图片暂不可用'}</span>}
    {failed && <button type="button" className="message-attachment-retry" onClick={() => setAttempt((current) => current + 1)}>重试</button>}
  </div>
}

function App() {
  const [models, setModels] = React.useState<ModelItem[]>([])
  const [selectedModel, setSelectedModel] = React.useState('')
  const [creativeModels, setCreativeModels] = React.useState<Record<'image' | 'video' | 'music' | 'voice', ModelItem[]>>({ image: [], video: [], music: [], voice: [] })
  const [selectedCreativeModels, setSelectedCreativeModels] = React.useState<Record<'image' | 'video' | 'music' | 'voice', string>>({ image: '', video: '', music: '', voice: '' })
  const [conversations, setConversations] = React.useState<Conversation[]>([])
  const [activeId, setActiveId] = React.useState('')
  const [workspaceMode, setWorkspaceMode] = React.useState<CreativeMode>('chat')
  const [input, setInput] = React.useState('')
  const [references, setReferences] = React.useState<DraftReference[]>([])
  const [draggingReferences, setDraggingReferences] = React.useState(false)
  const [imageSettingsByModel, setImageSettingsByModel] = React.useState<Record<string, ImageSettings>>({})
  const [videoDuration, setVideoDuration] = React.useState('')
  const [videoResolution, setVideoResolution] = React.useState('')
  const [videoAspectRatio, setVideoAspectRatio] = React.useState('')
  const [musicDuration, setMusicDuration] = React.useState('')
  const [musicMode, setMusicMode] = React.useState('')
  const [musicFormat, setMusicFormat] = React.useState('')
  const [voicePreviewText, setVoicePreviewText] = React.useState('你好，欢迎来到创作空间。')
  const [taskTrayOpen, setTaskTrayOpen] = React.useState(false)
  const [taskMessageFocus, setTaskMessageFocus] = React.useState<{ conversationId: string; messageId: string } | null>(null)
  const [loading, setLoading] = React.useState(true)
  const [generating, setGenerating] = React.useState(false)
  const [preparingAttachments, setPreparingAttachments] = React.useState(false)
  const [status, setStatus] = React.useState('正在连接平台...')
  const [statusKind, setStatusKind] = React.useState<StatusKind>('loading')
  const [error, setError] = React.useState<ErrorDetail | null>(null)
  const [toast, setToast] = React.useState<ChatToast | null>(null)
  const [mobileSidebar, setMobileSidebar] = React.useState(false)
  const [copiedId, setCopiedId] = React.useState('')
  const [activeReferencePreview, setActiveReferencePreview] = React.useState<{ src: string } | null>(null)
  const [loadAttempt, setLoadAttempt] = React.useState(0)
  const [pendingDeleteId, setPendingDeleteId] = React.useState('')
  const [editingMessageId, setEditingMessageId] = React.useState('')
  const [editingContent, setEditingContent] = React.useState('')
  const [settingsOpen, setSettingsOpen] = React.useState(false)
  const [modelMenuOpen, setModelMenuOpen] = React.useState(false)
  const deleteCancelRef = React.useRef<HTMLButtonElement>(null)
  const deleteDialogRef = React.useRef<HTMLElement>(null)
  const deleteTriggerRef = React.useRef<HTMLElement | null>(null)
  const referencePreviewTriggerRef = React.useRef<HTMLElement | null>(null)
  const referencePreviewCloseRef = React.useRef<HTMLButtonElement>(null)
  const taskTrayTriggerRef = React.useRef<HTMLButtonElement>(null)
  const taskTrayCloseRef = React.useRef<HTMLButtonElement>(null)
  const taskTrayPanelRef = React.useRef<HTMLElement>(null)
  const settingsButtonRef = React.useRef<HTMLButtonElement>(null)
  const settingsPopoverId = React.useId()
  const modelPopoverRef = React.useRef<HTMLDivElement>(null)
  const draftsRef = React.useRef<Record<string, ConversationDraft>>({})
  const localPersistenceRef = React.useRef<ReturnType<typeof createLocalChatPersistence> | null>(null)
  const localStorageWarningShownRef = React.useRef(false)
  const textareaRef = React.useRef<HTMLTextAreaElement>(null)
  const editingTextareaRef = React.useRef<HTMLTextAreaElement>(null)
  const messagesRef = React.useRef<HTMLDivElement>(null)
  const abortRef = React.useRef<AbortController | null>(null)
  const conversationsRef = React.useRef<Conversation[]>([])
  const activeIdRef = React.useRef('')
  const selectedModelRef = React.useRef('')
  const modelsRef = React.useRef<ModelItem[]>([])
  const creativeModelsRef = React.useRef<Record<'image' | 'video' | 'music' | 'voice', ModelItem[]>>({ image: [], video: [], music: [], voice: [] })
  const selectedCreativeModelsRef = React.useRef<Record<'image' | 'video' | 'music' | 'voice', string>>({ image: '', video: '', music: '', voice: '' })
  const generatingRef = React.useRef(false)
  const followMessagesRef = React.useRef(true)
  const agentRevisionRef = React.useRef(makeId('revision'))
  const loadingRef = React.useRef(loading)
  const errorRef = React.useRef<ErrorDetail | null>(error)
  loadingRef.current = loading
  errorRef.current = error
  const saveTimerRef = React.useRef<number | null>(null)
  const toastTimerRef = React.useRef<number | null>(null)
  const toastRemainingRef = React.useRef(8000)
  const toastStartedAtRef = React.useRef<number | null>(null)
  const referenceURLsRef = React.useRef(new Set<string>())
  const referenceUploadPromisesRef = React.useRef(new Map<string, Promise<ReferenceAsset>>())
  const draftSaveTimerRef = React.useRef<number | null>(null)
  const autoRecoveryControllersRef = React.useRef(new Map<string, AbortController>())

  const clearReferenceFiles = (removed = references) => {
    removed.forEach((reference) => {
      if (!reference.preview.startsWith('blob:')) return
      URL.revokeObjectURL(reference.preview)
      referenceURLsRef.current.delete(reference.preview)
    })
    setReferences([])
  }

  const openReferencePreview = (src: string) => {
    referencePreviewTriggerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    setActiveReferencePreview({ src })
  }

  const closeReferencePreview = () => {
    setActiveReferencePreview(null)
    window.requestAnimationFrame(() => {
      if (referencePreviewTriggerRef.current?.isConnected) referencePreviewTriggerRef.current.focus({ preventScroll: true })
    })
  }

  const dismissToast = React.useCallback(() => {
    if (toastTimerRef.current !== null) window.clearTimeout(toastTimerRef.current)
    toastTimerRef.current = null
    toastStartedAtRef.current = null
    toastRemainingRef.current = 8000
    setToast(null)
  }, [])

  const showToast = React.useCallback((detail: ErrorDetail, action?: ChatToast['action']) => {
    if (toastTimerRef.current !== null) window.clearTimeout(toastTimerRef.current)
    toastRemainingRef.current = 8000
    toastStartedAtRef.current = Date.now()
    setToast({ detail, action })
    toastTimerRef.current = window.setTimeout(() => {
      toastTimerRef.current = null
      toastStartedAtRef.current = null
      toastRemainingRef.current = 8000
      setToast(null)
    }, toastRemainingRef.current)
  }, [])

  const pauseToastDismissal = () => {
    if (toastTimerRef.current !== null) {
      if (toastStartedAtRef.current !== null) {
        toastRemainingRef.current = Math.max(0, toastRemainingRef.current - (Date.now() - toastStartedAtRef.current))
      }
      window.clearTimeout(toastTimerRef.current)
      toastTimerRef.current = null
      toastStartedAtRef.current = null
    }
  }

  const resumeToastDismissal = () => {
    if (!toast || toastTimerRef.current !== null) return
    if (toastRemainingRef.current <= 0) {
      dismissToast()
      return
    }
    toastStartedAtRef.current = Date.now()
    toastTimerRef.current = window.setTimeout(() => {
      toastTimerRef.current = null
      toastStartedAtRef.current = null
      toastRemainingRef.current = 8000
      setToast(null)
    }, toastRemainingRef.current)
  }

  React.useEffect(() => {
    if (!error || error.code === 'NO_TEXT_MODELS') return
    const activeConversation = conversationsRef.current.find((conversation) => conversation.id === activeIdRef.current)
    if (activeConversation?.messages.length) showToast(error)
  }, [error, showToast])

  React.useEffect(() => () => {
    if (toastTimerRef.current !== null) window.clearTimeout(toastTimerRef.current)
  }, [])

  React.useEffect(() => {
    if (!activeReferencePreview) return
    referencePreviewCloseRef.current?.focus()
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeReferencePreview()
      if (event.key === 'Tab') {
        event.preventDefault()
        referencePreviewCloseRef.current?.focus()
      }
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [activeReferencePreview])

  React.useEffect(() => {
    if (!taskTrayOpen) return
    taskTrayCloseRef.current?.focus()
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setTaskTrayOpen(false)
        window.requestAnimationFrame(() => taskTrayTriggerRef.current?.focus({ preventScroll: true }))
        return
      }
      if (event.key !== 'Tab') return
      const focusable = Array.from(taskTrayPanelRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled)') || [])
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (!first || !last) return
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [taskTrayOpen])

  React.useEffect(() => {
    if (!pendingDeleteId) return
    deleteCancelRef.current?.focus()
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        closeDeleteConfirmation()
        return
      }
      if (event.key !== 'Tab') return
      const focusable = Array.from(deleteDialogRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled)') || [])
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (!first || !last) return
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [pendingDeleteId])

  const persistNow = React.useCallback((value: Conversation[]) => {
    const snapshot = fitStorageSnapshot(value)
    const saved = localPersistenceRef.current?.saveConversations(snapshot) ?? false
    if (!saved && !localStorageWarningShownRef.current) {
      localStorageWarningShownRef.current = true
      showToast({ code: 'LOCAL_STORAGE_WRITE_FAILED', message: '本地存储空间不足，聊天记录未能保存。请清理浏览器空间后重试。' }, 'none')
    } else if (saved) localStorageWarningShownRef.current = false
  }, [showToast])

  const persistDraftsNow = React.useCallback(() => {
    const snapshot = fitStoredDraftSnapshot(draftsRef.current)
    const saved = localPersistenceRef.current?.saveDrafts(snapshot) ?? false
    if (!saved && !localStorageWarningShownRef.current) {
      localStorageWarningShownRef.current = true
      showToast({ code: 'LOCAL_STORAGE_WRITE_FAILED', message: '本地存储空间不足，草稿未能保存。请清理浏览器空间后重试。' }, 'none')
    } else if (saved) localStorageWarningShownRef.current = false
  }, [showToast])

  const scheduleDraftPersist = React.useCallback(() => {
    if (draftSaveTimerRef.current !== null) return
    draftSaveTimerRef.current = window.setTimeout(() => {
      draftSaveTimerRef.current = null
      persistDraftsNow()
    }, 250)
  }, [persistDraftsNow])

  const updateConversations = React.useCallback((updater: (current: Conversation[]) => Conversation[], immediate = false) => {
    const next = sortConversations(updater(conversationsRef.current), MAX_CONVERSATIONS)
    conversationsRef.current = next
    agentRevisionRef.current = makeId('revision')
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
      modelsRef.current = []
      setCreativeModels({ image: [], video: [], music: [], voice: [] })
      creativeModelsRef.current = { image: [], video: [], music: [], voice: [] }
      setSelectedModel('')
      selectedModelRef.current = ''
      try {
        await createChatSession()
        let accountScope = app.session()?.account_scope || ''
        if (!accountScope) accountScope = (await app.auth.status()).accountScope || ''
        if (!accountScope) throw Object.assign(new Error('无法识别当前平台账户，聊天记录无法安全地保存到本地。'), { code: 'APP_ACCOUNT_SCOPE_UNAVAILABLE' })
        const localPersistence = createLocalChatPersistence({
          storage: window.localStorage,
          legacyStorage: app.storage,
          appId: appManifest.id,
          accountScope,
          conversationsKey: CONVERSATIONS_KEY,
          draftsKey: DRAFTS_KEY,
        })
        localPersistenceRef.current = localPersistence
        const [catalogResults, localState] = await Promise.all([
          Promise.allSettled([
            appApiGet('/models'),
            appApiGet('/images/models'),
            appApiGet('/videos/models'),
            appApiGet('/music/models'),
            appApiGet('/voice-design/models'),
          ]),
          localPersistence.load(),
        ])
        if (!active) return
        const [textResult, imageResult, videoResult, musicResult, voiceResult] = catalogResults
        const availableModels = textResult.status === 'fulfilled' ? modelsForMode(textResult.value, 'chat') : []
        const nextCreativeModels = {
          image: imageResult.status === 'fulfilled' ? modelsForMode(imageResult.value, 'image') : [],
          video: videoResult.status === 'fulfilled' ? modelsForMode(videoResult.value, 'video') : [],
          music: musicResult.status === 'fulfilled' ? modelsForMode(musicResult.value, 'music') : [],
          voice: voiceResult.status === 'fulfilled' ? modelsForMode(voiceResult.value, 'voice') : [],
        }
        if (!availableModels.length && !nextCreativeModels.image.length && !nextCreativeModels.video.length && !nextCreativeModels.music.length && !nextCreativeModels.voice.length
          && textResult.status === 'rejected' && imageResult.status === 'rejected' && videoResult.status === 'rejected' && musicResult.status === 'rejected' && voiceResult.status === 'rejected') {
          throw textResult.reason
        }
        const stored = normalizeConversations(localState.conversations)
        const storedDrafts = normalizeStoredDrafts(localState.drafts)
        draftsRef.current = {}
        for (const [conversationId, modeDrafts] of Object.entries(storedDrafts)) {
          for (const [mode, draft] of Object.entries(modeDrafts) as Array<[CreativeMode, StoredConversationDraft]>) {
            draftsRef.current[`${conversationId}:${mode}`] = {
                input: draft.input,
                previewText: draft.previewText,
              references: draft.references.map((reference) => ({
                id: reference.id,
                file: new File([], reference.name, { type: reference.contentType || 'image/png' }),
                preview: '',
                assetId: reference.assetId,
                contentType: reference.contentType,
                uploadState: 'restoring',
              })),
            }
          }
        }
        const loaded = stored.length ? stored : [createConversation(modelId(availableModels[0] || {}), 'chat')]
        conversationsRef.current = loaded
        agentRevisionRef.current = makeId('revision')
        setConversations(loaded)
        const firstModel = preferredModel(availableModels, stored[0]?.mode === 'chat' ? stored[0]?.model : '')
        const selectedImages = preferredModel(nextCreativeModels.image, stored[0]?.mode === 'image' ? stored[0]?.model : '')
        const selectedVideos = preferredModel(nextCreativeModels.video, stored[0]?.mode === 'video' ? stored[0]?.model : '')
        const selectedMusic = preferredModel(nextCreativeModels.music, stored[0]?.mode === 'music' ? stored[0]?.model : '')
        const selectedVoice = preferredModel(nextCreativeModels.voice, stored[0]?.mode === 'voice' ? stored[0]?.model : '')
        selectedModelRef.current = firstModel
        setSelectedModel(firstModel)
        selectedCreativeModelsRef.current = { image: selectedImages, video: selectedVideos, music: selectedMusic, voice: selectedVoice }
        setSelectedCreativeModels({ image: selectedImages, video: selectedVideos, music: selectedMusic, voice: selectedVoice })
        creativeModelsRef.current = nextCreativeModels
        setCreativeModels(nextCreativeModels)
        setActiveId(loaded[0].id)
        activeIdRef.current = loaded[0].id
        const initialMode = loaded[0].mode || 'chat'
        setWorkspaceMode(initialMode)
        const initialDraft = draftsRef.current[`${loaded[0].id}:${initialMode}`] || { input: '', references: [] }
        setInput(initialDraft.input)
        setVoicePreviewText(initialDraft.previewText || '你好，欢迎来到创作空间。')
        setReferences(initialDraft.references)
        setModels(availableModels)
        modelsRef.current = availableModels
        if (availableModels.length || nextCreativeModels.image.length || nextCreativeModels.video.length || nextCreativeModels.music.length || nextCreativeModels.voice.length) {
          setStatus('平台已就绪')
          setStatusKind('ready')
        } else {
          setError({
            code: 'NO_TEXT_MODELS',
            message: '应用已连接平台，但当前没有可用的文本或媒体模型。请在平台模型目录启用后重试。',
          })
          setStatus('已连接，但没有可用模型')
          setStatusKind('error')
        }
        if (!stored.length) persistNow(loaded)
        if (Object.keys(storedDrafts).length) {
          // Restore the durable asset identities into usable File objects. The
          // original bytes never enter app storage; only the asset ID does.
          void Promise.all(Object.entries(storedDrafts).flatMap(([conversationId, modeDrafts]) =>
            Object.entries(modeDrafts).map(async ([mode, draft]) => {
              if (!draft.references.length) return
              const restoredReferences = await Promise.all(draft.references.map(async (reference) => {
                try {
                  const restored = await restoreReferenceAsset(referenceAssetApi, reference.assetId, reference.name, mode === 'image')
                  if (restored.preview.startsWith('blob:')) referenceURLsRef.current.add(restored.preview)
                  return {
                    id: reference.id,
                    file: restored.file,
                    preview: restored.preview,
                    assetId: restored.asset.id,
                    url: restored.asset.url,
                    contentType: restored.asset.contentType,
                    uploadState: 'ready' as const,
                  }
                } catch (restoreError) {
                  return {
                    id: reference.id,
                    file: new File([], reference.name, { type: reference.contentType || 'image/png' }),
                    preview: '',
                    assetId: reference.assetId,
                    contentType: reference.contentType,
                    uploadState: 'error' as const,
                    uploadError: platformErrorDetail(restoreError).message,
                  }
                }
              }))
              const key = `${conversationId}:${mode}`
              const currentDraft = draftsRef.current[key]
              if (!currentDraft) {
                restoredReferences.forEach((reference) => {
                  if (reference.preview.startsWith('blob:')) {
                    URL.revokeObjectURL(reference.preview)
                    referenceURLsRef.current.delete(reference.preview)
                  }
                })
                return
              }
              const restoredById = new Map(restoredReferences.map((reference) => [reference.id, reference]))
              const references = currentDraft.references.map((reference) => {
                const restored = restoredById.get(reference.id)
                return restored ? { ...reference, ...restored } : reference
              })
              const retainedIDs = new Set(references.map((reference) => reference.id))
              restoredReferences.forEach((reference) => {
                if (retainedIDs.has(reference.id) || !reference.preview.startsWith('blob:')) return
                URL.revokeObjectURL(reference.preview)
                referenceURLsRef.current.delete(reference.preview)
              })
              draftsRef.current[key] = { input: currentDraft.input, references, previewText: currentDraft.previewText }
              scheduleDraftPersist()
              if (activeIdRef.current === conversationId && (conversationsRef.current.find((conversation) => conversation.id === conversationId)?.mode || 'chat') === mode) {
                setInput(currentDraft.input)
                setVoicePreviewText(currentDraft.previewText || '你好，欢迎来到创作空间。')
                setReferences(references)
              }
            })
          ))
        }
        const staleMedia = loaded.flatMap((conversation) => conversation.messages.flatMap((message) =>
          (message.media || []).filter((asset) => asset.assetId).map((asset) => ({ conversationId: conversation.id, messageId: message.id, asset }))
        ))
        if (staleMedia.length) {
          void Promise.all(staleMedia.map(async ({ conversationId, messageId, asset }) => {
            try {
              const refreshed = await appApiGet<Record<string, unknown>>(`/media/assets/${encodeURIComponent(asset.assetId!)}`)
              const url = typeof refreshed.url === 'string' ? refreshed.url : typeof refreshed.content_url === 'string' ? refreshed.content_url : ''
              if (url && active) updateStoredMedia(conversationId, messageId, asset.id, url)
            } catch { /* Keep the saved output visible as an expired asset reference. */ }
          }))
        }
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
      if (saveTimerRef.current !== null) {
        window.clearTimeout(saveTimerRef.current)
        saveTimerRef.current = null
        persistNow(conversationsRef.current)
      }
      if (draftSaveTimerRef.current !== null) {
        window.clearTimeout(draftSaveTimerRef.current)
        draftSaveTimerRef.current = null
        persistDraftsNow()
      }
    }
  }, [loadAttempt, persistDraftsNow, persistNow])

  React.useEffect(() => {
    activeIdRef.current = activeId
    if (!activeId) return
    followMessagesRef.current = true
    window.requestAnimationFrame(() => messagesRef.current?.scrollTo({ top: messagesRef.current.scrollHeight, behavior: 'smooth' }))
  }, [activeId])

  const sortedConversations = React.useMemo(() => sortConversations(conversations, MAX_CONVERSATIONS), [conversations])
  const activeConversation = sortedConversations.find((conversation) => conversation.id === activeId) || sortedConversations[0]
  const activeMode = workspaceMode
  const visibleConversations = React.useMemo(
    () => sortedConversations.filter((conversation) => conversationMatchesMode(conversation, activeMode)),
    [activeMode, sortedConversations],
  )
  const creativeTasks = React.useMemo(() => creativeTaskSummaries(sortedConversations), [sortedConversations])
  const activeMessages = activeConversation?.messages.filter((message) => messageMatchesMode(message, activeMode, activeConversation.mode || 'chat')) || []
  const activeCreationType: 'music' | 'voice' = activeMode === 'voice' ? 'voice' : 'music'
  const modelsForWorkspace = activeMode === 'chat' ? models : creativeModels[activeMode]
  const activeSelectedModel = activeMode === 'chat' ? selectedModel : selectedCreativeModels[activeMode]
  const currentModel = modelsForWorkspace.find((item) => modelId(item) === activeSelectedModel)
  const pendingDeleteConversation = sortedConversations.find((conversation) => conversation.id === pendingDeleteId)
  const noTextModels = error?.code === 'NO_TEXT_MODELS'
  const noModelsForMode = modelsForWorkspace.length === 0
  const activeAudioMode = isAudioMode(activeMode)
  const hasConnectionError = Boolean(error && !noTextModels)
  const visibleStatusKind = statusKind === 'error' && !hasConnectionError ? 'ready' : statusKind

  const currentImageOptions = activeMode === 'image' ? imageOptions(currentModel) : imageOptions(undefined)
  const currentImageSettings = resolveImageSettings(currentModel, imageSettingsByModel[activeSelectedModel])
  const currentImageRatios = activeMode === 'image' ? imageAspectRatios(currentModel, currentImageSettings.resolution) : []
  const changeImageSetting = (patch: Partial<ImageSettings>) => {
    if (activeMode !== 'image' || !currentModel) return
    setImageSettingsByModel((current) => ({
      ...current,
      [activeSelectedModel]: updateImageSettings(currentModel, current[activeSelectedModel] || {}, patch),
    }))
  }

  React.useEffect(() => {
    if (!activeId || !followMessagesRef.current) return
    window.requestAnimationFrame(() => messagesRef.current?.scrollTo({
      top: messagesRef.current.scrollHeight,
      behavior: generating ? 'auto' : 'smooth',
    }))
  }, [activeId, activeMessages.length, activeMessages[activeMessages.length - 1]?.id, activeMessages[activeMessages.length - 1]?.content.length, activeMessages[activeMessages.length - 1]?.state, generating])

  const selectModelForMode = (mode: CreativeMode, requested = '') => {
    const list = mode === 'chat' ? models : creativeModels[mode]
    return preferredModel(list, requested || (mode === 'chat' ? selectedModel : selectedCreativeModels[mode]))
  }

  const draftKey = (conversationId: string, mode: CreativeMode) => `${conversationId}:${mode}`

  const saveActiveDraft = (conversationId = activeIdRef.current, mode = activeMode) => {
    if (!conversationId) return
    draftsRef.current[draftKey(conversationId, mode)] = { input, references: [...references], previewText: mode === 'voice' ? voicePreviewText : undefined }
    scheduleDraftPersist()
  }

  const activateConversation = (conversation: Conversation, closeSidebar = true, preserveCurrentDraft = true, preferredMode?: CreativeMode) => {
    if (preserveCurrentDraft && activeIdRef.current && activeIdRef.current !== conversation.id) saveActiveDraft()
    setSettingsOpen(false)
    setModelMenuOpen(false)
    const nextMode = preferredMode && conversationMatchesMode(conversation, preferredMode)
      ? preferredMode
      : conversation.mode || 'chat'
    const nextModel = selectModelForMode(nextMode, conversation.model)
    const draft = draftsRef.current[draftKey(conversation.id, nextMode)] || { input: '', references: [] }
    setActiveId(conversation.id)
    activeIdRef.current = conversation.id
    setEditingMessageId('')
    setEditingContent('')
    setWorkspaceMode(nextMode)
    if (nextMode === 'chat') {
      selectedModelRef.current = nextModel
      setSelectedModel(nextModel)
    } else {
      const next = { ...selectedCreativeModelsRef.current, [nextMode]: nextModel }
      selectedCreativeModelsRef.current = next
      setSelectedCreativeModels(next)
    }
    setInput(draft.input)
    setVoicePreviewText(draft.previewText || '你好，欢迎来到创作空间。')
    setReferences(draft.references)
    setError(null)
    dismissToast()
    if (closeSidebar) setMobileSidebar(false)
  }

  const closeDeleteConfirmation = () => {
    setPendingDeleteId('')
    window.requestAnimationFrame(() => {
      if (deleteTriggerRef.current?.isConnected) {
        deleteTriggerRef.current.focus()
        return
      }
      const fallback = document.querySelector<HTMLElement>('.conversation-item.active .conversation-select')
        || document.querySelector<HTMLElement>('.new-chat')
      fallback?.focus()
    })
  }

  const retryConnection = (message = '正在重新连接平台...') => {
    dismissToast()
    setError(null)
    setStatus(message)
    setStatusKind('loading')
    setLoadAttempt((attempt) => attempt + 1)
  }

  const loginPlatform = async () => {
    if (!canStartInteractiveLogin()) {
      retryConnection('请从平台重新打开应用以获取新的 App Session。')
      return
    }
    dismissToast()
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
    activateConversation(conversation, true, true, activeMode)
    dismissToast()
  }

  const newConversation = () => {
    if (generating) return
    const modeModel = selectModelForMode(workspaceMode)
    const conversation = createConversation(modeModel, workspaceMode)
    updateConversations((current) => [conversation, ...current].slice(0, MAX_CONVERSATIONS), true)
    activateConversation(conversation)
    setStatus('新对话已创建')
    setStatusKind('ready')
    setMobileSidebar(false)
    window.requestAnimationFrame(() => textareaRef.current?.focus())
  }

  const switchConversationMode = (nextMode: CreativeMode) => {
    if (generating) return
    if (nextMode === activeMode) {
      setMobileSidebar(false)
      return
    }
    saveActiveDraft()
    setSettingsOpen(false)
    setModelMenuOpen(false)
    setMobileSidebar(false)
    setEditingMessageId('')
    setEditingContent('')

    let nextConversation = conversationForMode(conversationsRef.current, nextMode)
    if (!nextConversation) {
      nextConversation = createConversation(selectModelForMode(nextMode), nextMode)
      updateConversations((current) => [nextConversation!, ...current], true)
    }
    activateConversation(nextConversation, true, false, nextMode)
    setStatus(`${modeLabel(nextMode)}工作台已切换`)
    setStatusKind('ready')
  }

  const requestRemoveConversation = (id: string) => {
    if (generating) return
    if (!conversationsRef.current.some((conversation) => conversation.id === id)) return
    deleteTriggerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    setPendingDeleteId(id)
  }

  const removeConversation = () => {
    const id = pendingDeleteId
    if (!id || generating) return
    const deletingActive = id === activeIdRef.current
    if (id === activeIdRef.current) saveActiveDraft()
    const remaining = conversationsRef.current.filter((conversation) => conversation.id !== id)
    const modeConversation = conversationForMode(remaining, activeMode)
    const next = modeConversation
      ? remaining
      : [createConversation(selectModelForMode(activeMode), activeMode), ...remaining].slice(0, MAX_CONVERSATIONS)
    const nextActiveConversation = modeConversation || next[0]
    updateConversations(() => next, true)
    for (const key of Object.keys(draftsRef.current)) {
      if (key.startsWith(`${id}:`)) {
        draftsRef.current[key].references.forEach((reference) => {
          if (reference.preview.startsWith('blob:')) URL.revokeObjectURL(reference.preview)
          referenceURLsRef.current.delete(reference.preview)
        })
        delete draftsRef.current[key]
      }
    }
    persistDraftsNow()
    if (deletingActive && nextActiveConversation) activateConversation(nextActiveConversation, true, false, activeMode)
    setPendingDeleteId('')
    window.requestAnimationFrame(() => {
      if (deletingActive) {
        textareaRef.current?.focus()
        return
      }
      const fallback = document.querySelector<HTMLElement>('.conversation-item.active .conversation-select')
        || document.querySelector<HTMLElement>('.new-chat')
      fallback?.focus()
    })
  }

  const changeModel = (value: string) => {
    setSettingsOpen(false)
    if (activeMode === 'chat') {
      selectedModelRef.current = value
      setSelectedModel(value)
    } else {
      const next = { ...selectedCreativeModelsRef.current, [activeMode]: value }
      selectedCreativeModelsRef.current = next
      setSelectedCreativeModels(next)
    }
    updateConversations((current) => current.map((conversation) => conversation.id === activeIdRef.current ? { ...conversation, mode: activeMode, model: value, updatedAt: now() } : conversation), true)
    setStatus(value ? '模型已切换' : '请选择一个模型')
    setStatusKind(value ? 'ready' : 'error')
  }

  const changeMode = (nextMode: CreativeMode) => {
    if (nextMode === activeMode) {
      setMobileSidebar(false)
      return
    }
    switchConversationMode(nextMode)
    setError(null)
    dismissToast()
  }

  const changeAudioCreationType = (nextMode: 'music' | 'voice') => {
    if (generating || activeMode !== 'music' && activeMode !== 'voice') return
    switchConversationMode(nextMode)
  }

  const cancelCreativeTask = async (task: (typeof creativeTasks)[number]) => {
    if (!task.taskId || task.mode === 'image') return
    const endpoint = taskCancelPath(task.mode, task.taskId)
    if (!endpoint) return
    try {
      const response = await app.api.request<Record<string, unknown>>(endpoint, { method: 'DELETE' })
      const status = String(response.status || response.task_status || '').toLowerCase()
      if (['cancelled', 'canceled'].includes(status)) {
        updateMessage(task.conversationId, task.messageId, (message) => ({ ...message, state: 'complete', content: '任务已取消', error: undefined }), true)
      } else if (taskStatus(response) === 'complete') {
        const media = await deliverMediaAssets(referenceAssetApi, assetsFromResponse(response, taskContentType(task.mode)))
        updateMessage(task.conversationId, task.messageId, (message) => ({ ...message, state: 'complete', media, content: '', error: undefined, ...(task.mode === 'voice' && voiceIdFrom(response) ? { voiceId: voiceIdFrom(response) } : {}) }), true)
      } else {
        updateMessage(task.conversationId, task.messageId, (message) => ({ ...message, state: 'stopped', error: '取消请求已提交，可稍后继续查询。' }), true)
      }
    } catch (cancelError) {
      showToast({ message: `取消任务失败：${platformErrorDetail(cancelError).message}` }, 'none')
    }
  }

  const changeInput = (value: string) => {
    const next = value.slice(0, MAX_MESSAGE_LENGTH)
    setInput(next)
    if (activeIdRef.current) {
      const key = draftKey(activeIdRef.current, activeMode)
      const current = draftsRef.current[key] || { input: '', references: [...references], previewText: activeMode === 'voice' ? voicePreviewText : undefined }
      draftsRef.current[key] = { ...current, input: next }
      scheduleDraftPersist()
    }
  }

  const changeVoicePreviewText = (value: string) => {
    const next = value.slice(0, 500)
    setVoicePreviewText(next)
    if (!activeIdRef.current) return
    const key = draftKey(activeIdRef.current, 'voice')
    const current = draftsRef.current[key] || { input: '', references: [] }
    draftsRef.current[key] = { ...current, previewText: next }
    scheduleDraftPersist()
  }

  const openCreativeTask = (task: (typeof creativeTasks)[number], action?: 'query' | 'edit') => {
    const conversation = conversationsRef.current.find((item) => item.id === task.conversationId)
    const message = conversation?.messages.find((item) => item.id === task.messageId)
    if (!conversation || !message) return
    if (action === 'edit' && message.mode && message.mode !== 'chat') {
      const source = [...conversation.messages.slice(0, conversation.messages.indexOf(message))].reverse().find((item) => item.role === 'user' && (item.mode === message.mode || (!item.mode && conversation.mode === message.mode)))
      if (source) {
        const mode = message.mode
        updateConversations((current) => current.map((item) => item.id === conversation.id ? { ...item, mode, updatedAt: now() } : item), true)
        activateConversation({ ...conversation, mode }, false)
        setInput(source.content)
        setVoicePreviewText(source.previewText || '你好，欢迎来到创作空间。')
        const assetIds = source.attachmentAssetIds || []
        const names = source.attachmentNames || []
        if (assetIds.length && assetIds.length === names.length) {
          void Promise.all(assetIds.map(async (assetId, index) => {
            const restored = await restoreReferenceAsset(referenceAssetApi, assetId, names[index], mode === 'image')
            if (restored.preview.startsWith('blob:')) referenceURLsRef.current.add(restored.preview)
            return { id: makeId('reference'), file: restored.file, preview: restored.preview, assetId: restored.asset.id, url: restored.asset.url, contentType: restored.asset.contentType, uploadState: 'ready' as const }
          })).then((restored) => {
            const key = draftKey(conversation.id, mode)
            draftsRef.current[key] = { input: source.content, previewText: source.previewText, references: restored }
            setReferences(restored)
            scheduleDraftPersist()
          }).catch((restoreError) => {
            setReferences([])
            showToast({ message: `原任务的参考图片暂时无法恢复，请重新添加：${platformErrorDetail(restoreError).message}` }, 'none')
          })
        } else {
          setReferences([])
          if (names.length) showToast({ message: '原任务的参考图片缺少可恢复的资产编号，请重新添加图片。' }, 'none')
        }
        const key = draftKey(conversation.id, mode)
        draftsRef.current[key] = { input: source.content, previewText: source.previewText, references: [] }
        scheduleDraftPersist()
        setTaskTrayOpen(false)
        setTaskMessageFocus({ conversationId: conversation.id, messageId: message.id })
        window.requestAnimationFrame(() => textareaRef.current?.focus())
        return
      }
    }
    activateConversation(conversation)
    setTaskTrayOpen(false)
    setTaskMessageFocus({ conversationId: conversation.id, messageId: message.id })
    if (action === 'query') void refreshMediaMessage(conversation.id, message)
  }

  React.useEffect(() => {
    if (!taskMessageFocus || taskMessageFocus.conversationId !== activeId) return
    window.requestAnimationFrame(() => {
      document.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(taskMessageFocus.messageId)}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    })
  }, [activeId, activeMessages.length, taskMessageFocus])

  const restoreChatPrompt = (conversationId: string, value: string) => {
    const restored = value.slice(0, MAX_MESSAGE_LENGTH)
    const key = draftKey(conversationId, 'chat')
    const current = draftsRef.current[key] || { input: '', references: [] }
    draftsRef.current[key] = { ...current, input: restored }
    if (activeIdRef.current === conversationId) setInput(restored)
  }

  const updateMessage = (conversationId: string, messageId: string, updater: (message: ChatMessage) => ChatMessage, immediate = false) => {
    updateConversations((current) => current.map((conversation) => conversation.id === conversationId
      ? { ...conversation, updatedAt: now(), messages: conversation.messages.map((message) => message.id === messageId ? updater(message) : message) }
      : conversation), immediate)
  }

  const updateStoredMedia = (conversationId: string, messageId: string, assetId: string, url: string) => {
    updateMessage(conversationId, messageId, (message) => ({
      ...message,
      media: message.media?.map((asset) => asset.id === assetId ? { ...asset, url } : asset),
    }), true)
  }

  const refreshAssetMedia = async (conversationId: string, messageId: string, asset: CreativeAsset) => {
    if (!asset.assetId) return
    try {
      const refreshed = await appApiGet<Record<string, unknown>>(`/media/assets/${encodeURIComponent(asset.assetId)}`)
      const url = typeof refreshed.url === 'string' ? refreshed.url : typeof refreshed.content_url === 'string' ? refreshed.content_url : ''
      if (url) updateStoredMedia(conversationId, messageId, asset.id, url)
      else showToast({ message: '暂时无法读取这个创作素材。' }, 'none')
    } catch (refreshError) {
      showToast(platformErrorDetail(refreshError), 'none')
    }
  }

  const restoreRequestMessages = async (messages: ChatMessage[]) => {
    const assetRequests = new Map<string, Promise<ReferenceAsset>>()
    return Promise.all(messages.map(async (message) => {
      if (message.role !== 'user') return { ...message, requestContent: message.content }
      const assetIds = message.attachmentAssetIds || []
      if (!assetIds.length) {
        return { ...message, requestContent: message.requestContent ?? message.content }
      }
      const assets = await Promise.all(assetIds.map((assetId) => {
        if (!assetRequests.has(assetId)) assetRequests.set(assetId, readReferenceAsset(referenceAssetApi, assetId))
        return assetRequests.get(assetId)!
      }))
      const missing = assets.findIndex((asset) => !asset.url)
      if (missing >= 0) throw new Error(`无法恢复“${message.attachmentNames?.[missing] || '图片附件'}”，请稍后重试。`)
      return {
        ...message,
        requestContent: responsesContentWithImages(message.content, assets.map((asset) => asset.url || '')),
      }
    }))
  }

  const executeStream = async (conversationId: string, assistantId: string, requestMessages: ChatMessage[], model: string, externalSignal?: AbortSignal) => {
    const controller = new AbortController()
    abortRef.current?.abort()
    abortRef.current = controller
    const abortFromCaller = () => controller.abort()
    if (externalSignal) {
      if (externalSignal.aborted) controller.abort()
      else externalSignal.addEventListener('abort', abortFromCaller, { once: true })
    }
    generatingRef.current = true
    setGenerating(true)
    dismissToast()
    setError(null)
    setStatus('正在生成回复...')
    setStatusKind('working')
    let output = ''
    let lastEventData: unknown = null
    try {
      const restoredRequestMessages = await restoreRequestMessages(requestMessages)
      for await (const event of app.api.stream<Record<string, unknown>>('/responses/stream', {
        method: 'POST',
        signal: controller.signal,
        body: JSON.stringify({
          model,
          input: restoredRequestMessages.map((message) => ({ role: message.role, content: message.requestContent ?? message.content })),
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
      return { content: output.trim(), state: 'complete' as const }
    } catch (streamError) {
      const lastUserPrompt = [...requestMessages].reverse().find((message) => message.role === 'user')?.content || ''
      if (controller.signal.aborted) {
        updateMessage(conversationId, assistantId, (message) => ({ ...message, content: output, state: 'stopped', error: output ? '已停止生成' : '生成已停止' }), true)
        if (lastUserPrompt) restoreChatPrompt(conversationId, lastUserPrompt)
        setStatus('已停止生成')
        setStatusKind('ready')
        return { content: output, state: 'stopped' as const }
      }
      const detail = platformErrorDetail(streamError)
      updateMessage(conversationId, assistantId, (message) => ({ ...message, content: output, state: 'error', error: detail.message, requestId: detail.requestId }), true)
      if (lastUserPrompt) restoreChatPrompt(conversationId, lastUserPrompt)
      setError(detail)
      setStatus(displayError(detail))
      setStatusKind('error')
      return { content: output, state: 'error' as const, error: detail.message, requestId: detail.requestId }
    } finally {
      externalSignal?.removeEventListener('abort', abortFromCaller)
      if (abortRef.current === controller) abortRef.current = null
      generatingRef.current = false
      setGenerating(false)
    }
  }

  const executeStreamRef = React.useRef(executeStream)
  executeStreamRef.current = executeStream

  const refreshMediaMessage = async (conversationId: string, message: ChatMessage) => {
    if ((!message.taskId && !message.idempotencyKey) || !message.mode || message.mode === 'chat' || generatingRef.current) return
    const recoveryKey = `${conversationId}:${message.id}`
    autoRecoveryControllersRef.current.get(recoveryKey)?.abort()
    autoRecoveryControllersRef.current.delete(recoveryKey)
    const mode = message.mode
    const controller = new AbortController()
    abortRef.current = controller
    generatingRef.current = true
    setGenerating(true)
    setStatus(`正在查询${modeLabel(mode)}任务...`)
    setStatusKind('working')
    let taskId = message.taskId || ''
    const readTask = async (response: Record<string, unknown>) => {
      taskId = taskIdFrom(response) || taskId
      if (taskId && taskId !== message.taskId) {
        updateMessage(conversationId, message.id, (current) => ({ ...current, taskId }), true)
      }
      const media = await deliverMediaAssets(referenceAssetApi, assetsFromResponse(response, taskContentType(mode)))
      const state = taskStatus(response)
      const voiceId = mode === 'voice' ? voiceIdFrom(response) : ''
      if (media.length || (mode === 'voice' && state === 'complete')) {
        updateMessage(conversationId, message.id, (current) => ({ ...current, media, state: 'complete', content: '', error: undefined, ...(voiceId ? { voiceId } : {}) }), true)
        setStatus(`${modeLabel(mode)}创作完成`)
        setStatusKind('ready')
        return 'complete' as const
      }
      if (state === 'failed') {
        updateMessage(conversationId, message.id, (current) => ({ ...current, state: 'error', error: errorMessage(response, `${modeLabel(mode)}创作失败`), content: '' }), true)
        setStatus(`${modeLabel(mode)}任务失败`)
        setStatusKind('error')
        return 'failed' as const
      }
      return 'pending' as const
    }
    try {
      if (!taskId && message.idempotencyKey) {
        const recovered = await app.api.request<Record<string, unknown>>(submissionLookupPath(mode, message.idempotencyKey), { signal: controller.signal })
        if (await readTask(recovered) !== 'pending') return
      }
      if (!taskId) throw new Error('尚未找到可查询的创作任务，请稍后继续查询原提交。')
      for (let attempt = 0; attempt < MEDIA_POLL_ATTEMPTS; attempt += 1) {
        if (controller.signal.aborted) break
        if (attempt) await new Promise<void>((resolve) => window.setTimeout(resolve, MEDIA_POLL_INTERVAL_MS))
        if (controller.signal.aborted) break
        const response = await app.api.request<Record<string, unknown>>(taskPath(mode, taskId), { signal: controller.signal })
        if (await readTask(response) !== 'pending') return
      }
      updateMessage(conversationId, message.id, (current) => ({ ...current, state: 'stopped', content: '', error: '任务仍在后台处理中，可稍后继续查询' }), true)
      setStatus(controller.signal.aborted ? '已停止查询，任务仍在后台运行' : '任务仍在后台处理')
      setStatusKind('ready')
    } catch (refreshError) {
      const detail = platformErrorDetail(refreshError)
      updateMessage(conversationId, message.id, (current) => ({ ...current, state: 'stopped', error: taskId ? '暂时无法查询任务，请稍后重试。' : '提交状态尚未确认，可稍后继续查询原任务。' }), true)
      showToast(detail, 'none')
      setStatus(detail.message)
      setStatusKind('error')
    } finally {
      if (abortRef.current === controller) abortRef.current = null
      generatingRef.current = false
      setGenerating(false)
    }
  }

  const recoverPendingMediaMessage = async (conversationId: string, message: ChatMessage, controller: AbortController) => {
    if (!message.mode || message.mode === 'chat') return
    const mode = message.mode
    let taskId = message.taskId || ''
    const readTask = async (response: Record<string, unknown>) => {
      taskId = taskIdFrom(response) || taskId
      if (taskId && taskId !== message.taskId) updateMessage(conversationId, message.id, (current) => ({ ...current, taskId }), true)
      const media = await deliverMediaAssets(referenceAssetApi, assetsFromResponse(response, taskContentType(mode)))
      const state = taskStatus(response)
      const voiceId = mode === 'voice' ? voiceIdFrom(response) : ''
      if (media.length || (mode === 'voice' && state === 'complete')) {
        updateMessage(conversationId, message.id, (current) => ({ ...current, media, state: 'complete', content: '', error: undefined, ...(voiceId ? { voiceId } : {}) }), true)
        return 'complete' as const
      }
      if (state === 'failed') {
        updateMessage(conversationId, message.id, (current) => ({ ...current, state: 'error', error: errorMessage(response, `${modeLabel(mode)}创作失败`), content: '' }), true)
        return 'failed' as const
      }
      return 'pending' as const
    }
    try {
      if (!taskId && message.idempotencyKey) {
        const recovered = await app.api.request<Record<string, unknown>>(submissionLookupPath(mode, message.idempotencyKey), { signal: controller.signal })
        if (await readTask(recovered) !== 'pending') return
      }
      if (!taskId) {
        updateMessage(conversationId, message.id, (current) => ({ ...current, state: 'stopped', error: '提交状态尚未确认，可点击“查询原提交”重试' }), true)
        return
      }
      for (let attempt = 0; attempt < MEDIA_POLL_ATTEMPTS; attempt += 1) {
        if (controller.signal.aborted) return
        if (attempt) await new Promise<void>((resolve) => window.setTimeout(resolve, MEDIA_POLL_INTERVAL_MS))
        if (controller.signal.aborted) return
        const response = await app.api.request<Record<string, unknown>>(taskPath(mode, taskId), { signal: controller.signal })
        if (await readTask(response) !== 'pending') return
      }
      if (!controller.signal.aborted) updateMessage(conversationId, message.id, (current) => ({ ...current, state: 'stopped', error: '任务仍在后台处理，可点击“继续查询”重试' }), true)
    } catch {
      if (!controller.signal.aborted) updateMessage(conversationId, message.id, (current) => ({ ...current, state: 'stopped', error: '任务暂时无法查询，可点击“继续查询”重试' }), true)
    }
  }

  const recoverPendingMediaMessages = (items: Conversation[]) => {
    const pending = items.flatMap((conversation) => conversation.messages
      .filter((message) => message.role === 'assistant' && message.mode && message.mode !== 'chat'
        && (message.taskId || message.idempotencyKey)
        && (message.state === 'streaming' || message.state === 'stopped'))
      .map((message) => ({ conversationId: conversation.id, message })))
      .slice(-MAX_AUTO_RECOVERY_TASKS)
    for (const { conversationId, message } of pending) {
      const key = `${conversationId}:${message.id}`
      if (autoRecoveryControllersRef.current.has(key)) continue
      const controller = new AbortController()
      autoRecoveryControllersRef.current.set(key, controller)
      void recoverPendingMediaMessage(conversationId, message, controller).finally(() => autoRecoveryControllersRef.current.delete(key))
    }
  }

  React.useEffect(() => {
    if (loading || !activeId) return
    const conversation = conversationsRef.current.find((item) => item.id === activeId)
    if (conversation) recoverPendingMediaMessages([conversation])
    return () => {
      autoRecoveryControllersRef.current.forEach((controller) => controller.abort())
      autoRecoveryControllersRef.current.clear()
    }
  }, [loading, activeId])

  const submitCreative = async (retry?: CreativeRetryRequest) => {
    const content = (retry?.content ?? input).trim()
    const previewText = (retry?.previewText ?? voicePreviewText).trim()
    const conversation = conversationsRef.current.find((item) => item.id === (retry?.conversationId || activeIdRef.current))
    const mode = retry?.mode || activeMode
    const requestedModel = retry?.model || (mode === 'chat' ? selectedModelRef.current : conversation?.model || selectedCreativeModelsRef.current[mode])
    const modelList = mode === 'chat' ? modelsRef.current : creativeModelsRef.current[mode]
    const currentModelForSubmit = modelList.find((item) => modelId(item) === requestedModel) || (retry ? undefined : currentModel)
    if (mode === 'chat' || !content || !conversation || generatingRef.current || !currentModelForSubmit) return
    if (mode === 'voice' && (!previewText || previewText.length > 500)) {
      showToast({ message: '请填写试听文案，最多 500 个字符。' }, 'none')
      return
    }
    const model = creativeModelId(currentModelForSubmit)
    let selectedReferences = retry ? [...retry.references] : [...references]
    const imageSettingsForSubmit = resolveImageSettings(currentModelForSubmit, imageSettingsByModel[model])
    if ((mode === 'image' || mode === 'video') && selectedReferences.length && !supportsReferenceImages(currentModelForSubmit, mode)) {
      showToast({ message: `当前${modeLabel(mode)}模型不支持图片参考素材，请移除素材或选择其他模型。` }, 'none')
      return
    }
    const declaredLimit = maxReferenceImages(currentModelForSubmit)
    if (selectedReferences.length > declaredLimit && declaredLimit >= 0) {
      showToast({ message: `当前模型最多支持 ${declaredLimit} 个参考素材，请减少素材后重试。` }, 'none')
      return
    }
    if (isAudioMode(mode) && selectedReferences.length) {
      showToast({ message: '音频创作请使用文字描述，参考素材可用于图片或视频。' }, 'none')
      return
    }
    const assistantId = retry?.assistantId || makeId('message')
    const idempotencyKey = retry
      ? `${conversation.id}:${assistantId}:retry-${makeId('request')}`.slice(0, 128)
      : `${conversation.id}:${assistantId}`.slice(0, 128)
    const activeDraftKey = draftKey(conversation.id, mode)
    const restoreCreativeDraft = () => {
      const currentDraft = draftsRef.current[activeDraftKey]
      const draftReferences = currentDraft?.references.length === selectedReferences.length
        ? currentDraft.references.map((reference, index) => selectedReferences[index]?.id === reference.id && selectedReferences[index].assetId
          ? { ...reference, ...selectedReferences[index] }
          : reference)
        : selectedReferences
      const restoredReferences = draftReferences.map((reference) => {
        if (referenceURLsRef.current.has(reference.preview)) return reference
        const preview = URL.createObjectURL(reference.file)
        referenceURLsRef.current.add(preview)
        return { ...reference, preview }
      })
      setInput(content)
      setReferences(restoredReferences)
      draftsRef.current[activeDraftKey] = { input: content, references: restoredReferences, previewText: mode === 'voice' ? previewText : undefined }
      scheduleDraftPersist()
    }
    // Reusable chat/video references are durable COS assets. Image edits are
    // one-shot inputs: their bytes go only to the operation-specific multipart
    // request, so no second asset upload is created.
    if (selectedReferences.length && creativeReferenceTransport(mode) === 'cos') {
      generatingRef.current = true
      setGenerating(true)
      setPreparingAttachments(true)
      setStatus('正在上传参考图片...')
      setStatusKind('working')
      try {
        // Keep each reference's key tied to its draft identity. A failed
        // upload can then be retried without creating a second asset, even
        // though a new assistant message ID is allocated for the retry.
        const uploadedReferences = [...selectedReferences]
        for (let index = 0; index < uploadedReferences.length; index += 1) {
          const reference = uploadedReferences[index]
          if (reference.assetId) {
            const asset = await uploadReferenceDraft(reference, conversation.id, mode)
            uploadedReferences[index] = { ...reference, url: asset.url, contentType: asset.contentType, uploadState: 'ready' }
            selectedReferences = [...uploadedReferences]
            continue
          }
          const asset = await uploadReferenceDraft(reference, conversation.id, mode)
          uploadedReferences[index] = { ...reference, assetId: asset.id, url: asset.url, contentType: asset.contentType, uploadState: 'ready' }
          selectedReferences = [...uploadedReferences]
        }
      } catch (uploadError) {
        restoreCreativeDraft()
        const detail = platformErrorDetail(uploadError)
        showToast({ ...detail, message: `参考图片上传失败：${detail.message}` }, 'none')
        setStatus(detail.message)
        setStatusKind('error')
        generatingRef.current = false
        setGenerating(false)
        setPreparingAttachments(false)
        return
      }
      generatingRef.current = false
      setGenerating(false)
      setPreparingAttachments(false)
    } else if (selectedReferences.some((reference) => !reference.file.size)) {
      generatingRef.current = true
      setGenerating(true)
      setPreparingAttachments(true)
      setStatus('正在恢复图片编辑输入...')
      setStatusKind('working')
      try {
        selectedReferences = await Promise.all(selectedReferences.map(async (reference) => {
          if (reference.file.size) return reference
          if (!reference.assetId) throw new Error(`无法恢复“${reference.file.name || '参考图片'}”，请重新添加图片。`)
          const restored = await readReferenceAssetFile(referenceAssetApi, reference.assetId, reference.file.name)
          referenceURLsRef.current.add(restored.preview)
          return {
            ...reference,
            file: restored.file,
            preview: restored.preview,
            assetId: restored.asset.id,
            url: restored.asset.url,
            contentType: restored.asset.contentType,
            uploadState: 'ready' as const,
          }
        }))
      } catch (restoreError) {
        restoreCreativeDraft()
        showToast({ message: `图片编辑输入恢复失败：${platformErrorDetail(restoreError).message}` }, 'none')
        setStatus(platformErrorDetail(restoreError).message)
        setStatusKind('error')
        generatingRef.current = false
        setGenerating(false)
        setPreparingAttachments(false)
        return
      }
      generatingRef.current = false
      setGenerating(false)
      setPreparingAttachments(false)
    }
    if (mode === 'image' && selectedReferences.reduce((total, reference) => total + reference.file.size, 0) > MAX_IMAGE_EDIT_REQUEST_BYTES) {
      restoreCreativeDraft()
      showToast({ message: '本次图片编辑参考图总大小不能超过 96 MiB，请压缩或减少图片后重试。' }, 'none')
      setStatus('图片编辑参考图过大')
      setStatusKind('error')
      return
    }
    const userMessage: ChatMessage = {
      id: makeId('message'), role: 'user', content, createdAt: now(), state: 'complete', mode,
      ...(mode === 'voice' ? { previewText } : {}),
      attachmentNames: selectedReferences.map((item) => item.file.name),
      attachmentAssetIds: selectedReferences.every((item) => item.assetId)
        ? selectedReferences.map((item) => item.assetId!)
        : undefined,
    }
    const assistant: ChatMessage = { id: assistantId, role: 'assistant', content: '', createdAt: now(), state: 'streaming', mode, idempotencyKey }
    updateConversations((current) => current.map((item) => {
      if (item.id !== conversation.id) return item
      const messages = retry
        ? item.messages.map((message) => message.id === assistantId
          ? { ...message, content: '', state: 'streaming' as const, error: undefined, requestId: undefined, media: undefined, taskId: undefined, mode, idempotencyKey }
          : message)
        : [...item.messages, userMessage, assistant].slice(-MAX_MESSAGES)
      return { ...item, title: item.messages.length ? item.title : titleFor(content), mode, model, updatedAt: now(), messages }
    }), true)
    changeInput('')
    clearReferenceFiles(selectedReferences)
    draftsRef.current[activeDraftKey] = { input: '', references: [], previewText: mode === 'voice' ? previewText : undefined }
    scheduleDraftPersist()
    generatingRef.current = true
    setGenerating(true)
    dismissToast()
    setError(null)
    setStatus(`正在生成${modeLabel(mode)}...`)
    setStatusKind('working')
    const controller = new AbortController()
    abortRef.current = controller
    let acceptedTaskId = ''
    let terminalFailure = false
    let terminalMessage = ''
    const readResult = async (response: unknown) => {
      acceptedTaskId = taskIdFrom(response) || acceptedTaskId
      const media = await deliverMediaAssets(referenceAssetApi, assetsFromResponse(response, taskContentType(mode)))
      const voiceId = mode === 'voice' ? voiceIdFrom(response) : ''
      if (voiceId) updateMessage(conversation.id, assistantId, (message) => ({ ...message, voiceId }), true)
      if (acceptedTaskId) updateMessage(conversation.id, assistantId, (message) => ({ ...message, taskId: acceptedTaskId }), true)
      if (media.length || (mode === 'voice' && taskStatus(response) === 'complete')) {
        updateMessage(conversation.id, assistantId, (message) => ({ ...message, media, state: 'complete', content: '', error: undefined, ...(voiceId ? { voiceId } : {}) }), true)
        setStatus(`${modeLabel(mode)}创作完成`)
        setStatusKind('ready')
        return true
      }
      if (taskStatus(response) === 'failed') {
        terminalFailure = true
        terminalMessage = errorMessage(response, `${modeLabel(mode)}创作失败`)
        throw new Error(terminalMessage)
      }
      return false
    }
    try {
      let response: unknown
      if (mode === 'image') {
        const parameters = imageGenerationParameters(currentModelForSubmit, content, imageSettingsForSubmit)
        if (selectedReferences.length) {
          const form = new FormData()
          for (const [key, value] of Object.entries(parameters)) form.append(key, String(value))
          selectedReferences.forEach((reference) => form.append('image[]', reference.file, reference.file.name))
          response = await app.api.request('/images/edits', { method: 'POST', headers: { 'Idempotency-Key': idempotencyKey }, body: form })
        } else {
          response = await app.api.request('/images/generations', { method: 'POST', headers: { 'Idempotency-Key': idempotencyKey }, body: JSON.stringify(parameters) })
        }
      } else if (mode === 'video') {
        const durations = modelDurationOptions(currentModelForSubmit)
        const duration = Number(selectedOption(videoDuration, durations, currentModelForSubmit, 'duration'))
        const resolution = selectedOption(videoResolution, optionsFor(currentModelForSubmit, 'supported_resolutions', 'resolution'), currentModelForSubmit, 'resolution')
        const ratio = selectedOption(videoAspectRatio, optionsFor(currentModelForSubmit, 'supported_aspect_ratios', 'aspect_ratio'), currentModelForSubmit, 'aspect_ratio')
        const refs = selectedReferences.map((reference) => videoImageReference(reference.url || ''))
        const parameters = {
          model, prompt: content, input_mode: refs.length ? 'reference_image' : 'text',
          ...(duration > 0 ? { duration } : {}), ...(resolution ? { resolution } : {}), ...(ratio ? { aspect_ratio: ratio } : {}),
          ...(currentModelForSubmit.supports_audio_generation ? { generate_audio: true } : {}),
          ...(refs.length ? { input_references: refs } : {}),
        }
        response = await app.api.request('/videos', { method: 'POST', headers: { 'Idempotency-Key': idempotencyKey }, body: JSON.stringify(parameters) })
      } else if (mode === 'voice') {
        response = await app.api.request('/voice-design/generations', {
          method: 'POST', headers: { 'Idempotency-Key': idempotencyKey },
          body: JSON.stringify({ model, prompt: content, preview_text: previewText }),
        })
      } else {
        const durations = modelDurationOptions(currentModelForSubmit)
        const duration = Number(selectedOption(musicDuration, durations, currentModelForSubmit, 'duration'))
        const audioMode = selectedOption(musicMode, optionsFor(currentModelForSubmit, 'audio_modes', 'audio_mode'), currentModelForSubmit, 'audio_mode')
        const outputFormat = selectedOption(musicFormat, optionsFor(currentModelForSubmit, 'output_formats', 'output_format'), currentModelForSubmit, 'output_format')
        response = await app.api.request('/music/generations', {
          method: 'POST', headers: { 'Idempotency-Key': idempotencyKey },
          body: JSON.stringify({ model, prompt: content, ...(duration > 0 ? { duration } : {}), ...(audioMode ? { audio_mode: audioMode } : {}), ...(outputFormat ? { output_format: outputFormat } : {}) }),
        })
      }
      if (await readResult(response)) return
      if (!acceptedTaskId) throw new Error('平台没有返回可恢复的任务信息，请稍后查看创作记录。')
      for (let attempt = 0; attempt < MEDIA_POLL_ATTEMPTS; attempt += 1) {
        if (controller.signal.aborted) break
        await new Promise<void>((resolve) => window.setTimeout(resolve, MEDIA_POLL_INTERVAL_MS))
        if (controller.signal.aborted) break
        const statusPayload = await appApiGet(taskPath(mode, acceptedTaskId))
        if (await readResult(statusPayload)) return
      }
      updateMessage(conversation.id, assistantId, (message) => ({ ...message, state: 'stopped', error: '任务仍在后台处理中，可稍后继续查询' }), true)
      setStatus('已保留后台任务')
      setStatusKind('ready')
    } catch (creativeError) {
      const detail = platformErrorDetail(creativeError)
      let taskId = taskIdFrom(creativeError) || acceptedTaskId
      if (!terminalMessage) terminalMessage = detail.message
      if (!taskId) {
        try {
          const recovered = await appApiGet<Record<string, unknown>>(submissionLookupPath(mode, idempotencyKey))
          taskId = taskIdFrom(recovered)
          terminalFailure = taskStatus(recovered) === 'failed'
          if (terminalFailure) terminalMessage = errorMessage(recovered, terminalMessage)
          if (await readResult(recovered)) return
        } catch { /* Keep the same idempotency key so the original submission can be looked up later. */ }
      }
      const definiteRejection = !taskId && !terminalFailure && detail.status !== undefined
        && detail.status >= 400 && detail.status < 500 && ![408, 409, 425, 429].includes(detail.status)
      if (definiteRejection) {
        updateMessage(conversation.id, assistantId, (message) => ({ ...message, state: 'error', error: detail.message, requestId: detail.requestId }), true)
        restoreCreativeDraft()
        showToast(detail, 'none')
        setStatus(detail.message)
        setStatusKind('error')
      } else {
        if (terminalFailure || !taskId) restoreCreativeDraft()
        updateMessage(conversation.id, assistantId, (message) => ({ ...message, state: terminalFailure ? 'error' : 'stopped', taskId: taskId || undefined, error: terminalFailure ? terminalMessage : taskId ? '任务已提交，可继续查询原任务。' : '提交状态尚未确认，可继续查询原提交。', requestId: detail.requestId }), true)
        showToast({ message: terminalFailure ? '创作任务未完成，请查看消息中的错误信息。' : taskId ? '创作任务仍在后台处理，可从消息中继续查询。' : '提交结果尚未确认，请从消息中查询原任务，避免重复提交。' }, 'none')
        setStatus(terminalFailure ? '创作任务失败' : taskId ? '后台任务待查询' : '创作提交状态待确认')
        setStatusKind(terminalFailure ? 'error' : 'ready')
      }
    } finally {
      if (abortRef.current === controller) abortRef.current = null
      generatingRef.current = false
      setGenerating(false)
    }
  }

  const retryCreativeMessage = async (messageId: string) => {
    if (generating || loading || !activeConversation) return
    const index = activeConversation.messages.findIndex((message) => message.id === messageId)
    const target = activeConversation.messages[index]
    if (index < 0 || !target || target.role !== 'assistant' || target.mode === undefined || target.mode === 'chat' || (target.state !== 'error' && !(target.state === 'stopped' && !target.taskId))) return
    const mode = target.mode
    const source = [...activeConversation.messages.slice(0, index)].reverse().find((message) => message.role === 'user' && (message.mode === mode || (!message.mode && activeConversation.mode === mode)))
    if (!source?.content.trim()) {
      showToast({ message: '找不到原始创作描述，请重新输入后生成。' }, 'none')
      return
    }
    const model = selectModelForMode(mode, activeConversation.model)
    if (!model) {
      showToast({ message: `当前没有可用的${modeLabel(mode)}模型，请重新检查平台模型。` }, 'none')
      return
    }
    const key = draftKey(activeConversation.id, mode)
    let draft = draftsRef.current[key] || { input: '', references: [] }
    const expectedReferences = Math.max(source.attachmentNames?.length || 0, source.attachmentAssetIds?.length || 0)
    const expectedAssetIds = source.attachmentAssetIds || []
    const draftMatchesSource = draft.references.length === expectedReferences
      && (expectedAssetIds.length === 0
        ? true
        : expectedAssetIds.length === expectedReferences
          && expectedAssetIds.every((assetId, referenceIndex) => draft.references[referenceIndex]?.assetId === assetId))
    if (!draftMatchesSource) {
      setWorkspaceMode(mode)
      const nextModels = { ...selectedCreativeModelsRef.current, [mode]: model }
      selectedCreativeModelsRef.current = nextModels
      setSelectedCreativeModels(nextModels)
      setInput(source.content)
      if (expectedReferences === 0) {
        draft = { input: source.content, references: [] }
        draftsRef.current[key] = draft
        setReferences([])
      } else if (expectedAssetIds.length === expectedReferences) {
        try {
          const restored = await Promise.all(expectedAssetIds.map(async (assetId, index) => {
            const name = source.attachmentNames?.[index] || `reference-${index + 1}.png`
            const restored = await restoreReferenceAsset(referenceAssetApi, assetId, name, mode === 'image')
            if (restored.preview.startsWith('blob:')) referenceURLsRef.current.add(restored.preview)
            return { id: makeId('reference'), file: restored.file, preview: restored.preview, assetId: restored.asset.id, url: restored.asset.url, contentType: restored.asset.contentType }
          }))
          draft = { input: source.content, references: restored }
          draftsRef.current[key] = draft
          setReferences(restored)
        } catch (restoreError) {
          setReferences(draft.references)
          draftsRef.current[key] = { input: source.content, references: draft.references }
          showToast({ message: `原任务的参考图片暂时无法恢复：${platformErrorDetail(restoreError).message}` }, 'none')
          window.requestAnimationFrame(() => textareaRef.current?.focus())
          return
        }
      } else {
        setReferences(draft.references)
        draftsRef.current[key] = { input: source.content, references: draft.references }
        showToast({ message: `原任务需要 ${expectedReferences} 张参考图片，请重新添加后再重试。` }, 'none')
        window.requestAnimationFrame(() => textareaRef.current?.focus())
        return
      }
    }
    await submitCreative({
      conversationId: activeConversation.id,
      mode,
      content: source.content,
      previewText: source.previewText,
      references: draft.references,
      model,
      assistantId: target.id,
    })
  }

  const sendMessage = async () => {
    if (activeMode !== 'chat') return submitCreative()
    const content = input.trim()
    const conversation = conversationsRef.current.find((item) => item.id === activeIdRef.current)
    const model = selectedModelRef.current
    if ((!content && !references.length) || !conversation || generating || !model) return
    followMessagesRef.current = true
    let selectedReferences = [...references]
    if (selectedReferences.length) {
      generatingRef.current = true
      setGenerating(true)
      setPreparingAttachments(true)
      setStatus('正在上传附件...')
      setStatusKind('working')
      try {
        selectedReferences = await Promise.all(selectedReferences.map(async (reference) => {
          const asset = await uploadReferenceDraft(reference, conversation.id, 'chat')
          return { ...reference, assetId: asset.id, url: asset.url, contentType: asset.contentType, uploadState: 'ready' as const }
        }))
      } catch (uploadError) {
        const detail = platformErrorDetail(uploadError)
        const key = draftKey(conversation.id, 'chat')
        const draft = draftsRef.current[key] || { input: content, references: selectedReferences }
        const nextDraft = { ...draft, input: content }
        setReferences(nextDraft.references)
        draftsRef.current[key] = nextDraft
        scheduleDraftPersist()
        showToast({ ...detail, message: `附件上传失败：${detail.message}` }, 'none')
        setStatus(detail.message)
        setStatusKind('error')
        generatingRef.current = false
        setGenerating(false)
        setPreparingAttachments(false)
        return
      }
      generatingRef.current = false
      setGenerating(false)
      setPreparingAttachments(false)
    }
    const userMessage: ChatMessage = {
      id: makeId('message'), role: 'user', content: content.slice(0, MAX_MESSAGE_LENGTH), createdAt: now(), state: 'complete', mode: 'chat',
      requestContent: responsesContentWithImages(content, selectedReferences.map((reference) => reference.url || '')),
      attachmentNames: selectedReferences.map((reference) => reference.file.name),
      attachmentAssetIds: selectedReferences.map((reference) => reference.assetId || ''),
    }
    const assistantMessage: ChatMessage = { id: makeId('message'), role: 'assistant', content: '', createdAt: now(), state: 'streaming', mode: 'chat' }
    const requestMessages = [...conversation.messages.filter((message) => !message.mode || message.mode === 'chat'), userMessage]
    updateConversations((current) => current.map((item) => item.id === conversation.id
      ? { ...item, mode: 'chat', title: item.messages.some((message) => message.role === 'user') ? item.title : titleFor(userMessage.content), model, updatedAt: now(), messages: [...item.messages, userMessage, assistantMessage].slice(-MAX_MESSAGES) }
      : item), true)
    setInput('')
    clearReferenceFiles(selectedReferences)
    draftsRef.current[draftKey(conversation.id, 'chat')] = { input: '', references: [] }
    scheduleDraftPersist()
    await executeStream(conversation.id, assistantMessage.id, requestMessages.slice(-MAX_MESSAGES), model)
  }

  const handleToastAction = () => {
    const detail = toast?.detail
    if (!detail || toast?.action === 'none') return
    if (canStartInteractiveLogin() && (toast?.action === 'login' || requiresOAuthAuthorization(detail) || detail.code === 'APP_LOGIN_NOT_ALLOWED')) void loginPlatform()
    else retryConnection()
  }

  const activateChatComposer = (conversation: Conversation) => {
    if (activeMode !== 'chat') saveActiveDraft(conversation.id, activeMode)
    const model = preferredModel(modelsRef.current, selectedModelRef.current || (conversation.mode === 'chat' ? conversation.model : ''))
    if (!model) {
      showToast({ code: 'NO_TEXT_MODELS', message: '当前没有可用的对话模型，暂时无法重新生成。' }, 'none')
      return ''
    }
    selectedModelRef.current = model
    setSelectedModel(model)
    setWorkspaceMode('chat')
    const draft = draftsRef.current[draftKey(conversation.id, 'chat')] || { input: '', references: [] }
    setInput(draft.input)
    setReferences(draft.references)
    return model
  }

  const startEditMessage = (message: ChatMessage) => {
    if (generating || message.role !== 'user' || !isChatMessage(message, activeConversation?.mode) || !message.content.trim()) return
    setSettingsOpen(false)
    setModelMenuOpen(false)
    setEditingMessageId(message.id)
    setEditingContent(message.content)
    window.requestAnimationFrame(() => {
      const editor = editingTextareaRef.current
      if (!editor) return
      editor.focus()
      editor.setSelectionRange(editor.value.length, editor.value.length)
      editor.closest('.message-row')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
    })
  }

  const cancelEditMessage = () => {
    const messageId = editingMessageId
    setEditingMessageId('')
    setEditingContent('')
    window.requestAnimationFrame(() => {
      const row = Array.from(document.querySelectorAll<HTMLElement>('[data-message-id]')).find((element) => element.dataset.messageId === messageId)
      row?.querySelector<HTMLButtonElement>('.user-message-actions button')?.focus({ preventScroll: true })
    })
  }

  const submitEditedMessage = async (messageId: string) => {
    const prompt = editingContent.trim()
    if (generating || loading || !prompt || !activeConversation) return
    const index = activeConversation.messages.findIndex((message) => message.id === messageId && message.role === 'user' && isChatMessage(message, activeConversation.mode))
    if (index < 0) return
    const originalMessage = activeConversation.messages[index]
    const chatDraftKey = draftKey(activeConversation.id, 'chat')
    const composerDraft = draftsRef.current[chatDraftKey]
    const clearDuplicatePrompt = Boolean(composerDraft?.input.trim() && composerDraft.input.trim() === originalMessage.content.trim())
    const model = activateChatComposer(activeConversation)
    if (!model) return
    if (clearDuplicatePrompt) {
      const currentDraft = draftsRef.current[chatDraftKey] || { input: '', references: [] }
      draftsRef.current[chatDraftKey] = { ...currentDraft, input: '' }
      if (activeIdRef.current === activeConversation.id) setInput('')
      scheduleDraftPersist()
    }

    const previousMessages = activeConversation.messages.slice(0, index)
    const editedUserMessage: ChatMessage = {
      ...originalMessage,
      content: prompt.slice(0, MAX_MESSAGE_LENGTH),
      mode: 'chat',
      state: 'complete',
      error: undefined,
      requestId: undefined,
    }
    const assistantMessage: ChatMessage = { id: makeId('message'), role: 'assistant', content: '', createdAt: now(), state: 'streaming', mode: 'chat' }
    const requestMessages = [...previousMessages.filter((message) => isChatMessage(message, activeConversation.mode)), editedUserMessage].slice(-MAX_MESSAGES)
    const nextMessages = [...previousMessages, editedUserMessage, assistantMessage].slice(-MAX_MESSAGES)
    updateConversations((current) => current.map((item) => item.id === activeConversation.id
      ? {
        ...item,
        title: previousMessages.some((message) => message.role === 'user') ? item.title : titleFor(prompt),
        mode: 'chat',
        model,
        updatedAt: now(),
        messages: nextMessages,
      }
      : item), true)
    cancelEditMessage()
    followMessagesRef.current = true
    await executeStream(activeConversation.id, assistantMessage.id, requestMessages, model)
  }

  const retryMessage = async (messageId: string) => {
    if (generating || !activeConversation) return
    const index = activeConversation.messages.findIndex((message) => message.id === messageId)
    const target = activeConversation.messages[index]
    if (index < 0 || !target || target.role !== 'assistant' || !isChatMessage(target, activeConversation.mode) || target.media?.length) return
    if (target.state === 'streaming') return
    const model = activateChatComposer(activeConversation)
    if (!model) return
    const requestMessages = activeConversation.messages.slice(0, index).filter((message) => isChatMessage(message, activeConversation.mode))
    if (!requestMessages.some((message) => message.role === 'user')) return
    followMessagesRef.current = true
    const assistantMessage: ChatMessage = { id: makeId('message'), role: 'assistant', content: '', createdAt: now(), state: 'streaming', mode: 'chat' }
    updateConversations((current) => current.map((item) => item.id === activeConversation.id
      ? { ...item, mode: 'chat', model, messages: [...activeConversation.messages.slice(0, index), assistantMessage], updatedAt: now() }
      : item), true)
    await executeStream(activeConversation.id, assistantMessage.id, requestMessages, model)
  }

  const stopGeneration = () => abortRef.current?.abort()

  const agentHost = React.useMemo(() => ({
    snapshot: () => {
      const current = conversationsRef.current
      return {
        ready: !loadingRef.current && !errorRef.current && modelsRef.current.length > 0,
        reason: loadingRef.current ? '正在连接平台' : errorRef.current?.message,
        revision: agentRevisionRef.current,
        models: modelsRef.current.map(item => ({ id: modelId(item), name: modelName(item), type: modelType(item) })),
        conversations: current,
        activeConversationId: activeIdRef.current,
        selectedModel: selectedModelRef.current,
        generating: generatingRef.current,
      }
    },
    createConversation: (model?: string) => {
      if (generatingRef.current) throw Object.assign(new Error('正在生成回复，请完成或停止后再新建对话'), { code: 'CHAT_BUSY', executionStarted: false })
      const selected = preferredModel(modelsRef.current, model || selectedModelRef.current)
      const conversation = createConversation(selected || modelId(modelsRef.current[0] || {}))
      updateConversations(current => [conversation, ...current].slice(0, MAX_CONVERSATIONS), true)
      setActiveId(conversation.id)
      activeIdRef.current = conversation.id
      setWorkspaceMode('chat')
      selectedModelRef.current = selected
      setSelectedModel(selected)
      setEditingMessageId('')
      setEditingContent('')
      const draft = draftsRef.current[draftKey(conversation.id, 'chat')] || { input: '', references: [] }
      setInput(draft.input)
      setReferences(draft.references)
      setError(null)
      return conversation
    },
    sendMessage: async (conversationId: string, content: string, model: string, signal: AbortSignal) => {
      const conversation = conversationsRef.current.find(item => item.id === conversationId)
      if (!conversation) throw Object.assign(new Error('会话不存在'), { code: 'CHAT_NOT_FOUND', executionStarted: false })
      if (generatingRef.current) throw Object.assign(new Error('已有消息正在生成，请先停止'), { code: 'CHAT_BUSY', executionStarted: false })
      const userMessage: ChatMessage = { id: makeId('message'), role: 'user', content: content.slice(0, MAX_MESSAGE_LENGTH), createdAt: now(), state: 'complete', mode: 'chat' }
      const assistantMessage: ChatMessage = { id: makeId('message'), role: 'assistant', content: '', createdAt: now(), state: 'streaming', mode: 'chat' }
      const requestMessages = [...conversation.messages.filter(message => !message.mode || message.mode === 'chat'), userMessage]
      updateConversations(current => current.map(item => item.id === conversation.id
        ? { ...item, mode: 'chat', title: item.messages.some(message => message.role === 'user') ? item.title : titleFor(userMessage.content), model, updatedAt: now(), messages: [...item.messages, userMessage, assistantMessage].slice(-MAX_MESSAGES) }
        : item), true)
      const result = await executeStreamRef.current(conversation.id, assistantMessage.id, requestMessages.slice(-MAX_MESSAGES), model, signal)
      signal.throwIfAborted()
      if (result?.state === 'error') throw Object.assign(new Error(result.error || '回复生成失败'), { code: 'CHAT_GENERATION_FAILED', executionStarted: true, retryable: true, nextAction: { type: 'retry', capability: 'send_message' } })
      const next = conversationsRef.current.find(item => item.id === conversation.id) || conversation
      return { conversation: next, assistantMessageId: assistantMessage.id, status: result?.state || 'completed' }
    },
    stopGeneration: () => {
      const stopped = Boolean(abortRef.current)
      abortRef.current?.abort()
      return { stopped }
    },
  }), [updateConversations])

  React.useEffect(() => {
    activeAgentCleanup?.()
    const cleanup = registerChatAgent(agentHost)
    activeAgentCleanup = cleanup
    return () => {
      if (activeAgentCleanup === cleanup) activeAgentCleanup = null
      cleanup()
    }
  }, [agentHost])
  React.useEffect(() => agent.setStatus(
    loading ? { state: 'loading', reason: '正在连接平台', retryable: true, nextAction: { type: 'wait' } }
      : error ? { state: 'error', reason: error.message, retryable: true, nextAction: { type: 'retry' } }
        : generating ? { state: 'busy', reason: '正在生成回复', retryable: true, nextAction: { type: 'wait' } }
          : !models.length ? { state: 'no_document', reason: '当前没有可用的文本模型', retryable: true, nextAction: { type: 'retry' } }
            : { state: 'ready' },
  { scope: 'chat.app', priority: 20 }), [error, generating, loading, models.length])

  const copyMessage = async (message: ChatMessage) => {
    if (!message.content) return
    try {
      await navigator.clipboard.writeText(message.content)
      setCopiedId(message.id)
      window.setTimeout(() => setCopiedId((current) => current === message.id ? '' : current), 1400)
    } catch {
      showToast({ code: 'COPY_FAILED', message: '复制失败，请手动选择文本' }, 'none')
    }
  }

  const copyVoiceId = async (voiceId: string) => {
    try {
      await navigator.clipboard.writeText(voiceId)
      showToast({ message: '音色编号已复制。' }, 'none')
    } catch {
      showToast({ message: '复制失败，请手动选择音色编号。' }, 'none')
    }
  }

  const handleInputKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing || event.keyCode === 229) return
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      void sendMessage()
    }
  }

  const chooseSuggestion = (suggestion: string) => {
    changeInput(suggestion)
    window.requestAnimationFrame(() => textareaRef.current?.focus())
  }

  const updateDraftReference = (conversationId: string, mode: CreativeMode, referenceId: string, updater: (reference: DraftReference) => DraftReference) => {
    const key = draftKey(conversationId, mode)
    const currentDraft = draftsRef.current[key] || { input: '', references: [] }
    const references = currentDraft.references.map((reference) => reference.id === referenceId ? updater(reference) : reference)
    draftsRef.current[key] = { ...currentDraft, references }
    if (activeIdRef.current === conversationId && activeMode === mode) {
      setReferences((current) => current.map((reference) => reference.id === referenceId ? updater(reference) : reference))
    }
    scheduleDraftPersist()
  }

  const uploadReferenceDraft = (reference: DraftReference, conversationId: string, mode: CreativeMode): Promise<ReferenceAsset> => {
    if (reference.assetId) {
      return readReferenceAsset(referenceAssetApi, reference.assetId).then((asset) => {
        if (!asset.url) throw new Error('图片资产暂时没有可用地址')
        updateDraftReference(conversationId, mode, reference.id, (current) => ({
          ...current,
          assetId: asset.id,
          url: asset.url,
          contentType: asset.contentType,
          uploadState: 'ready',
          uploadError: undefined,
        }))
        return asset
      }).catch((cause) => {
        const detail = platformErrorDetail(cause)
        updateDraftReference(conversationId, mode, reference.id, (current) => ({
          ...current,
          uploadState: 'error',
          uploadError: detail.message,
        }))
        throw cause
      })
    }
    const existing = referenceUploadPromisesRef.current.get(reference.id)
    if (existing) return existing
    const key = `${conversationId}:reference:${reference.id}`.slice(0, 128)
    const promise = uploadReferenceAsset(app.api, reference.file, key).then(async (uploaded) => {
      const asset = uploaded.url ? uploaded : await readReferenceAsset(referenceAssetApi, uploaded.id)
      if (!asset.url) throw new Error('图片已上传，但平台暂时没有返回可用地址')
      updateDraftReference(conversationId, mode, reference.id, (current) => ({
        ...current,
        assetId: asset.id,
        url: asset.url,
        contentType: asset.contentType,
        uploadState: 'ready',
        uploadError: undefined,
      }))
      return asset
    }).catch((cause) => {
      const detail = platformErrorDetail(cause)
      updateDraftReference(conversationId, mode, reference.id, (current) => ({
        ...current,
        uploadState: 'error',
        uploadError: detail.message,
      }))
      throw cause
    }).finally(() => {
      referenceUploadPromisesRef.current.delete(reference.id)
    })
    referenceUploadPromisesRef.current.set(reference.id, promise)
    return promise
  }

  const addReferenceFiles = async (files: File[]) => {
    const mode = activeMode
    const conversationId = activeIdRef.current
    if ((mode !== 'chat' && mode !== 'image' && mode !== 'video') || !conversationId) return
    const accepted = files.filter((file) => SUPPORTED_REFERENCE_IMAGE_TYPES.has(file.type.toLowerCase()))
    if (accepted.length < files.length) showToast({ message: '目前仅支持 PNG、JPG、WebP 或 GIF 图片。' }, 'none')
    const maxFileBytes = mode === 'image' ? MAX_IMAGE_EDIT_REQUEST_BYTES : MAX_REFERENCE_IMAGE_SIZE

    const preparedFiles: File[] = []
    for (const file of accepted) {
      try {
        const prepared = await prepareReferenceImageFile(file, maxFileBytes)
        if (prepared.size > maxFileBytes) throw new Error(`图片压缩后仍超过 ${Math.round(maxFileBytes / 1024 / 1024)} MiB，请换一张较小的图片`)
        preparedFiles.push(prepared)
      } catch (prepareError) {
        showToast({ message: prepareError instanceof Error ? prepareError.message : '图片读取失败，请重新选择。' }, 'none')
      }
    }
    if (!preparedFiles.length) return

    const key = draftKey(conversationId, mode)
    const draft = draftsRef.current[key] || { input: mode === activeMode && conversationId === activeIdRef.current ? input : '', references: [] }
    const existingReferences = draft.references
    const model = mode === activeMode && conversationId === activeIdRef.current ? currentModel : undefined
    const attachmentLimit = maxAttachmentsForMode(mode, model)
    const capacity = Math.max(0, attachmentLimit - existingReferences.length)
    if (!capacity) {
      showToast({ message: `当前最多可添加 ${attachmentLimit} 张图片。` }, 'none')
      return
    }
    if (preparedFiles.length > capacity) showToast({ message: `当前模型最多可添加 ${existingReferences.length + capacity} 张参考图片。` }, 'none')
    const next = preparedFiles.slice(0, capacity).map((file) => {
      const preview = URL.createObjectURL(file)
      referenceURLsRef.current.add(preview)
      return {
        id: makeId('reference'), file, preview,
        uploadState: creativeReferenceTransport(mode) === 'cos' ? 'uploading' as const : 'ready' as const,
      }
    })
    if (!next.length) return

    const updated = [...existingReferences, ...next]
    draftsRef.current[key] = { ...draft, references: updated }
    scheduleDraftPersist()
    if (conversationId === activeIdRef.current && mode === activeMode) setReferences(updated)

    if (creativeReferenceTransport(mode) === 'cos') {
      next.forEach((reference) => {
        void uploadReferenceDraft(reference, conversationId, mode).catch(() => undefined)
      })
    }
  }

  const handleReferenceFiles = (event: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.currentTarget.files || [])
    event.currentTarget.value = ''
    void addReferenceFiles(files)
  }

  const handleComposerPaste = (event: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const files = clipboardImageFiles(event.clipboardData)
    if (!files.length || (activeMode !== 'chat' && activeMode !== 'image' && activeMode !== 'video')) return
    event.preventDefault()
    void addReferenceFiles(files)
  }

  const handleComposerDragOver = (event: React.DragEvent<HTMLDivElement>) => {
    if (activeMode !== 'chat' && activeMode !== 'image' && activeMode !== 'video') return
    if (!Array.from(event.dataTransfer.types).includes('Files')) return
    event.preventDefault()
    event.dataTransfer.dropEffect = 'copy'
    setDraggingReferences(true)
  }

  const handleComposerDragLeave = (event: React.DragEvent<HTMLDivElement>) => {
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDraggingReferences(false)
  }

  const handleComposerDrop = (event: React.DragEvent<HTMLDivElement>) => {
    if (activeMode !== 'chat' && activeMode !== 'image' && activeMode !== 'video') return
    const files = Array.from(event.dataTransfer.files || [])
    if (!files.length) return
    event.preventDefault()
    setDraggingReferences(false)
    void addReferenceFiles(files)
  }

  const removeReference = (id: string) => {
    const reference = references.find((item) => item.id === id)
    if (reference) {
      if (reference.preview.startsWith('blob:')) URL.revokeObjectURL(reference.preview)
      referenceURLsRef.current.delete(reference.preview)
    }
    const updated = references.filter((item) => item.id !== id)
    setReferences(updated)
    draftsRef.current[draftKey(activeIdRef.current, activeMode)] = { input, references: updated }
    referenceUploadPromisesRef.current.delete(id)
    scheduleDraftPersist()
  }

  const retryReference = async (reference: DraftReference) => {
    if (generatingRef.current || !activeIdRef.current) return
    const conversationId = activeIdRef.current
    const mode = activeMode
    updateDraftReference(conversationId, mode, reference.id, (current) => ({ ...current, uploadState: 'uploading', uploadError: undefined }))
    try {
      if (reference.assetId) {
        const restored = await restoreReferenceAsset(referenceAssetApi, reference.assetId, reference.file.name, mode === 'image')
        if (restored.preview.startsWith('blob:')) referenceURLsRef.current.add(restored.preview)
        updateDraftReference(conversationId, mode, reference.id, (current) => ({
          ...current,
          file: restored.file,
          preview: restored.preview,
          assetId: restored.asset.id,
          url: restored.asset.url,
          contentType: restored.asset.contentType,
          uploadState: 'ready',
          uploadError: undefined,
        }))
      } else if (mode === 'image' && reference.file.size > 0) {
        // Image-edit input is intentionally one-shot and never becomes a
        // durable COS asset. A local file can be retried directly in the edit
        // request; after reload the user must re-add it if bytes are gone.
        updateDraftReference(conversationId, mode, reference.id, (current) => ({ ...current, uploadState: 'ready', uploadError: undefined }))
      } else if (mode === 'image') {
        throw new Error('图片编辑输入仅保存在本机，请重新添加图片。')
      } else {
        await uploadReferenceDraft(reference, conversationId, mode)
      }
    } catch (restoreError) {
      const detail = platformErrorDetail(restoreError)
      updateDraftReference(conversationId, mode, reference.id, (current) => ({ ...current, uploadState: 'error', uploadError: detail.message }))
      showToast({ ...detail, message: `图片暂时无法恢复：${detail.message}` }, 'none')
    }
  }

  React.useEffect(() => () => {
    referenceURLsRef.current.forEach((url) => URL.revokeObjectURL(url))
    referenceURLsRef.current.clear()
  }, [])

  React.useEffect(() => {
    if (!modelMenuOpen) return
    const closeOnOutsidePointer = (event: PointerEvent) => {
      const target = event.target as Node
      if (!modelPopoverRef.current?.contains(target)) setModelMenuOpen(false)
    }
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.isComposing || event.keyCode === 229) return
      setModelMenuOpen(false)
      modelPopoverRef.current?.querySelector<HTMLButtonElement>('.model-trigger')?.focus({ preventScroll: true })
    }
    document.addEventListener('pointerdown', closeOnOutsidePointer)
    document.addEventListener('keydown', closeOnEscape)
    return () => {
      document.removeEventListener('pointerdown', closeOnOutsidePointer)
      document.removeEventListener('keydown', closeOnEscape)
    }
  }, [modelMenuOpen])

  const currentSizeOptions = currentImageOptions.resolutionSizes[currentImageSettings.resolution || ''] || currentImageOptions.sizes
  const currentQualityOptions = currentImageOptions.qualities
  const currentResolutionOptions = currentImageOptions.resolutions
  const currentImageCountOptions = currentImageOptions.countOptions
  const currentVideoDurationOptions = modelDurationOptions(currentModel)
  const currentVideoResolutions = (() => {
    const supported = optionsFor(currentModel, 'supported_resolutions', 'resolution')
    return supported.length ? supported : optionsFor(currentModel, 'resolution_tiers', 'resolution_tier')
  })()
  const currentAspectRatios = optionsFor(currentModel, 'supported_aspect_ratios', 'aspect_ratio')
  const currentMusicDurationOptions = modelDurationOptions(currentModel)
  const currentMusicModes = optionsFor(currentModel, 'audio_modes', 'audio_mode')
  const currentMusicFormats = optionsFor(currentModel, 'output_formats', 'output_format')
  const currentImageSize = currentImageSettings.size || ''
  const currentImageQuality = currentImageSettings.quality || ''
  const currentImageResolution = currentImageSettings.resolution || ''
  const currentImageAspectRatio = currentImageSettings.aspectRatio || ''
  const currentImageCountValue = String(currentImageSettings.count || 1)
  const currentImageCountIndex = Math.max(0, currentImageCountOptions.indexOf(Number(currentImageCountValue)))
  const currentVideoDuration = selectedOption(videoDuration, currentVideoDurationOptions, currentModel, 'duration')
  const currentVideoResolution = selectedOption(videoResolution, currentVideoResolutions, currentModel, 'resolution')
  const currentVideoAspectRatio = selectedOption(videoAspectRatio, currentAspectRatios, currentModel, 'aspect_ratio')
  const currentMusicDuration = selectedOption(musicDuration, currentMusicDurationOptions, currentModel, 'duration')
  const currentMusicMode = selectedOption(musicMode, currentMusicModes, currentModel, 'audio_mode')
  const currentMusicFormat = selectedOption(musicFormat, currentMusicFormats, currentModel, 'output_format')
  const modelDisplayLabel = currentModel
    ? modelName(currentModel)
    : loading
      ? '正在加载模型'
      : `暂无可用${modeLabel(activeMode)}模型`
  const hasCurrentImageSettings = currentImageOptions.qualities.length > 0
    || currentImageOptions.resolutions.length > 0
    || currentImageRatios.length > 0
    || currentSizeOptions.length > 0
    || currentImageOptions.maxCount > 1
  const settingsSummary = activeMode === 'image'
    ? hasCurrentImageSettings ? imageSettingsSummary(currentImageSettings, currentModel) : ''
    : activeMode === 'video'
      ? [currentVideoAspectRatio, currentVideoResolution ? videoResolutionLabel(currentVideoResolution) : '', currentVideoDuration ? `${currentVideoDuration} 秒` : ''].filter(Boolean).join(' · ')
      : activeMode === 'music'
        ? [currentMusicDuration ? `${currentMusicDuration}s` : '', currentMusicMode, currentMusicFormat].filter(Boolean).join(' / ')
        : ''

  const renderSettingsChoices = (
    label: string,
    value: string,
    options: string[],
    onChange: (next: string) => void,
    columns = 3,
    suffix = '',
    render?: (option: string) => React.ReactNode,
  ) => <ParameterChoices label={label} value={value} values={options} onChange={onChange} columns={columns}
    render={render || ((option) => `${option}${suffix}`)} />

  const renderDurationControl = (
    label: string,
    value: string,
    options: string[],
    onChange: (next: string) => void
  ) => {
    const numeric = options.length > 3 && options.every((option) => Number.isFinite(Number(option)))
    if (!numeric) return renderSettingsChoices(label, value, options, onChange, 4, 's')
    const index = Math.max(0, options.indexOf(value))
    return <section className="settings-field duration-field">
      <div className="duration-heading"><h4>{label}</h4><strong>{value ? `${value}s` : '—'}</strong></div>
      <input
        type="range"
        min="0"
        max={String(options.length - 1)}
        step="1"
        value={index}
        aria-label={label}
        onChange={(event) => onChange(options[Number(event.currentTarget.value)] || value)}
      />
      <div className="duration-ticks">{options.map((option) => <span key={option}>{option}s</span>)}</div>
    </section>
  }

  const renderDurationSelect = (
    label: string,
    value: string,
    options: string[],
    onChange: (next: string) => void,
  ) => {
    if (!options.length) return null
    return <label className="settings-field settings-select-field">
      <span className="settings-field-label">{label}</span>
      <span className="settings-count-control settings-select-control">
        <select aria-label={label} value={value} onChange={(event) => onChange(event.currentTarget.value)}>
          {options.map((option) => <option key={option} value={option}>{option} 秒</option>)}
        </select>
        <span aria-hidden="true">⌄</span>
      </span>
    </label>
  }

  const closeSettings = () => {
    setSettingsOpen(false)
    settingsButtonRef.current?.focus({ preventScroll: true })
  }

  return (
    <main className="app-shell">
      <aside className={`sidebar ${mobileSidebar ? 'sidebar-open' : ''}`}>
        <div className="sidebar-head">
          <div className="brand"><span className="brand-icon" aria-hidden="true">✦</span><div><strong>即刻对话</strong><small>PROXY CHAT</small></div></div>
          <button className="mobile-close icon-button" type="button" onClick={() => setMobileSidebar(false)} aria-label="关闭工作台菜单" title="关闭工作台菜单">×</button>
        </div>
        <nav className="workspace-mode-menu" aria-label="创作类型">
          <p className="sidebar-section-label">工作台</p>
          {CREATIVE_MODES.map((item) => <button
            key={item.id}
            type="button"
            className={`workspace-mode-button ${activeMode === item.id || item.id === 'music' && activeMode === 'voice' ? 'selected' : ''}`}
            aria-pressed={activeMode === item.id || item.id === 'music' && activeMode === 'voice'}
            onClick={() => changeMode(item.id === 'music' && !creativeModels.music.length && creativeModels.voice.length ? 'voice' : item.id)}
            disabled={generating || loading}
          >
            <span className="workspace-mode-symbol" aria-hidden="true">{item.symbol}</span>
            <span>{item.label}</span>
            {(activeMode === item.id || item.id === 'music' && activeMode === 'voice') && <span className="workspace-mode-current" aria-hidden="true">当前</span>}
          </button>)}
        </nav>
        <button className="new-chat" type="button" onClick={newConversation} disabled={loading || generating}>
          <span aria-hidden="true">＋</span> 新建{modeLabel(activeMode)}
        </button>
        <div className="conversation-label"><span>最近会话</span><small>{visibleConversations.length}</small></div>
        <div className="conversation-list">
          {visibleConversations.map((conversation) => {
            const kind = conversationKind(conversation)
            return <div className={`conversation-item ${conversation.id === activeId ? 'active' : ''}`} key={conversation.id}>
              <button className="conversation-select" type="button" onClick={() => selectConversation(conversation.id)}>
                <span className="conversation-symbol" aria-hidden="true">{kind === 'mixed' ? '✦' : isAudioMode(kind) ? '♫' : CREATIVE_MODES.find((item) => item.id === kind)?.symbol || '◌'}</span>
                <span className="conversation-text"><strong>{conversation.title}</strong><small>{conversation.messages.length ? `${conversationKindLabel(kind)} · ${formatConversationDate(conversation.updatedAt)}` : '空白对话'}</small></span>
              </button>
              <button className="delete-conversation" type="button" onClick={() => requestRemoveConversation(conversation.id)} disabled={generating} title="删除对话" aria-label={`删除对话：${conversation.title}`}>×</button>
            </div>
          })}
          {!visibleConversations.length && <p className="sidebar-empty">该类型还没有会话</p>}
        </div>
        <div className="sidebar-footer">
          <span className={`connection-dot ${hasConnectionError ? 'offline' : ''}`} />
          <span>{loading ? '正在连接' : hasConnectionError ? '连接异常' : noModelsForMode ? `已连接 · 无${modeLabel(activeMode)}模型` : '平台已连接'}</span>
          <span className="footer-spacer" />
          <span className="privacy-mark" title="会话按当前用户隔离保存">⌁</span>
        </div>
      </aside>

      {mobileSidebar && <button className="sidebar-overlay" type="button" onClick={() => setMobileSidebar(false)} aria-label="关闭会话栏" />}

      <section className="chat-panel">
        <header className="chat-header">
          <button className="mobile-menu icon-button" type="button" onClick={() => setMobileSidebar(true)} aria-label="打开工作台菜单" title="打开工作台菜单">☰</button>
          <div className="chat-title"><span className="title-mode-symbol" aria-hidden="true">{activeAudioMode ? '♫' : CREATIVE_MODES.find((item) => item.id === activeMode)?.symbol || '◌'}</span><div><strong>{activeAudioMode ? '音频工作室' : `${modeLabel(activeMode)}工作室`}</strong><small>{activeConversation?.title || '新对话'}{activeMessages.length ? ` · ${activeMessages.length} 条消息` : ' · 开始创作'}</small></div></div>
          <div className="header-actions">
            <button ref={taskTrayTriggerRef} className="task-tray-trigger" type="button" onClick={() => setTaskTrayOpen(true)} aria-haspopup="dialog" aria-expanded={taskTrayOpen} aria-label={`创作任务，${creativeTasks.length} 项待处理任务`}>
              <span aria-hidden="true">◷</span> 创作任务{creativeTasks.length > 0 && <b>{creativeTasks.length}</b>}
            </button>
            <div className={`status-chip ${visibleStatusKind}`}><i />{statusKind === 'working' ? '生成中' : hasConnectionError ? '需要处理' : statusKind === 'loading' ? '连接中' : noModelsForMode ? `暂无${modeLabel(activeMode)}模型` : '已就绪'}</div>
          </div>
        </header>

        {toast && <div
          className={`chat-toast ${toast.detail.code === 'NO_TEXT_MODELS' ? 'model-toast' : ''}`}
          role="alert"
          aria-live="assertive"
          onMouseEnter={pauseToastDismissal}
          onMouseLeave={resumeToastDismissal}
          onFocusCapture={pauseToastDismissal}
          onBlurCapture={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) resumeToastDismissal() }}
        >
          <span className="toast-badge" aria-hidden="true">!</span>
          <div className="toast-copy"><strong>{errorTitle(toast.detail)}</strong><span>{toast.detail.message}</span>{toast.detail.requestId && <small>请求编号 {toast.detail.requestId}</small>}</div>
          {toast.action !== 'none' && <button className="toast-action" type="button" onClick={handleToastAction}>{errorActionLabel(toast.detail)}</button>}
          <button className="toast-close" type="button" onClick={dismissToast} aria-label="关闭提示" title="关闭">×</button>
        </div>}

        <div className="messages" ref={messagesRef} onScroll={(event) => {
          const element = event.currentTarget
          followMessagesRef.current = element.scrollHeight - element.scrollTop - element.clientHeight < 96
        }}>
          {!activeMessages.length && noModelsForMode && !loading && (!error || error.code === 'NO_TEXT_MODELS') && (
            <div className="connection-state model-state" role="status">
              <div className="connection-state-icon" aria-hidden="true">⌁</div>
              <p className="connection-state-kicker">平台连接正常</p>
              <h1>还没有可用的{modeLabel(activeMode)}模型</h1>
              <p className="connection-state-copy">当前账户没有可用的{modeLabel(activeMode)}模型，请检查平台模型配置和应用权限。</p>
              <div className="connection-actions">
                <button className="connection-primary" type="button" onClick={() => retryConnection()}>重新检查模型</button>
              </div>
            </div>
          )}
          {!activeMessages.length && loading && (
            <div className="connection-state loading-state" role="status" aria-live="polite" aria-busy="true">
              <div className="connection-state-icon loading-icon" aria-hidden="true">...</div>
              <p className="connection-state-kicker">正在建立连接</p>
              <h1>正在读取平台模型</h1>
              <p className="connection-state-copy">正在连接平台并读取当前账户可用的模型。</p>
            </div>
          )}
          {!activeMessages.length && !loading && hasConnectionError && error && (
            <div className="connection-state connection-error-state" role="alert" aria-live="assertive">
              <div className="connection-state-icon error-icon" aria-hidden="true">!</div>
              <p className="connection-state-kicker">暂时无法连接</p>
              <h1>{errorTitle(error)}</h1>
              <p className="connection-state-copy">{displayError(error)}</p>
              <div className="connection-actions">
                <button
                  className="connection-primary"
                  type="button"
                  onClick={() => canStartInteractiveLogin() && (requiresOAuthAuthorization(error) || error.code === 'APP_LOGIN_NOT_ALLOWED') ? void loginPlatform() : retryConnection()}
                >{errorActionLabel(error)}</button>
              </div>
            </div>
          )}
          {!activeMessages.length && !loading && !noModelsForMode && !error && (
            <div className="welcome">
              <div className="welcome-symbol" aria-hidden="true">{CREATIVE_MODES.find((item) => item.id === activeMode)?.symbol || '◌'}</div>
              <p className="welcome-kicker">{activeMode === 'chat' ? 'GOOD TO HAVE YOU HERE' : `CREATE WITH ${modeLabel(activeMode).toUpperCase()}`}</p>
              <h1>{activeMode === 'chat' ? '今天想聊点什么？' : `今天想创作什么${modeLabel(activeMode)}？`}</h1>
              <p className="welcome-copy">{activeMode === 'chat' ? '把问题、想法或正在做的事交给我，我们一起把它理清楚。' : `描述你想要的${modeLabel(activeMode)}效果，模型和参数会根据当前平台能力提供。`}</p>
              {activeMode === 'chat' && <div className="suggestions">
                {SUGGESTIONS.map((suggestion) => <button type="button" key={suggestion} onClick={() => chooseSuggestion(suggestion)}>{suggestion}<span aria-hidden="true">↗</span></button>)}
              </div>}
            </div>
          )}
          {activeMessages.map((message) => (
            <article className={`message-row ${message.role}`} key={message.id}>
              <div className="avatar" aria-hidden="true">{message.role === 'user' ? '我' : '✦'}</div>
              <div className="message-column" data-message-id={message.id}>
                <div className="message-meta"><strong>{message.role === 'user' ? '你' : '即刻对话'}</strong><time>{formatTime(message.createdAt)}</time></div>
                <div className={`message-bubble ${message.state}`}>
                  {editingMessageId === message.id ? <div className="message-editing">
                    <div className="message-edit-heading">
                      <div><strong>编辑这条消息</strong><span>修改后会从这里重新生成回复</span></div>
                      {message.attachmentNames?.length ? <span className="message-edit-preserve">图片附件会保留</span> : null}
                    </div>
                    <textarea
                      ref={editingTextareaRef}
                      value={editingContent}
                      maxLength={MAX_MESSAGE_LENGTH}
                      rows={4}
                      aria-label="编辑你的消息"
                      onChange={(event) => setEditingContent(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.nativeEvent.isComposing || event.keyCode === 229) return
                        if (event.key === 'Escape') {
                          event.preventDefault()
                          cancelEditMessage()
                        } else if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                          event.preventDefault()
                          void submitEditedMessage(message.id)
                        }
                      }}
                    />
                    <div className="message-edit-actions">
                      <div className="message-edit-hints">
                        <span>{editingContent.length.toLocaleString()}/{MAX_MESSAGE_LENGTH.toLocaleString()}</span>
                        <span><kbd>⌘/Ctrl</kbd><b>+</b><kbd>Enter</kbd> 重生成</span>
                      </div>
                      <div><button type="button" onClick={cancelEditMessage}>取消</button><button type="button" className="save-edit" onClick={() => void submitEditedMessage(message.id)} disabled={!editingContent.trim() || generating || loading}>保存并重生成</button></div>
                    </div>
                  </div> : message.content ? <div className="message-content">{message.content}</div> : message.state === 'streaming' ? <div className={`typing ${message.mode && message.mode !== 'chat' ? 'creative-typing' : ''}`}><i /><i /><i />{message.mode && message.mode !== 'chat' && <span>正在生成{modeLabel(message.mode)}，完成后会出现在这里</span>}</div> : null}
                  {message.media?.length ? <div className={`generated-media ${message.media[0].type}`}>
                    {message.media.map((asset) => <div className="generated-asset" key={asset.id}>
                      {asset.url && asset.type === 'image' && <a href={asset.url} target="_blank" rel="noreferrer" aria-label={asset.name || '打开生成图片'}><img src={asset.url} alt={asset.name || '生成结果'} loading="lazy" /></a>}
                      {asset.url && asset.type === 'video' && <video src={asset.url} controls preload="metadata" aria-label={asset.name || '生成视频'} />}
                      {asset.url && asset.type === 'audio' && <audio src={asset.url} controls preload="metadata" aria-label={asset.name || '生成音乐'} />}
                      {!asset.url && asset.assetId && <button className="asset-refresh" type="button" onClick={() => void refreshAssetMedia(activeConversation?.id || '', message.id, asset)}>重新获取已保存素材</button>}
                      {!asset.url && !asset.assetId && <span className="asset-unavailable">素材链接已失效，无法恢复</span>}
                    </div>)}
                  </div> : null}
                  {message.voiceId && <div className="voice-id-result"><span>音色编号</span><code>{message.voiceId}</code><button type="button" onClick={() => void copyVoiceId(message.voiceId!)}>复制编号</button></div>}
                  {message.previewText && <div className="voice-preview-result"><strong>试听文案</strong><span>{message.previewText}</span></div>}
                  {message.state === 'error' && <div className="message-error">{message.error || '这条消息生成失败'}{message.requestId && <small>请求编号 {message.requestId}</small>}</div>}
                  {message.state === 'stopped' && <div className="message-stopped">{message.error || '生成已停止'}</div>}
                </div>
                {message.attachmentNames?.length ? <div className="message-attachments" aria-label="消息图片">
                  <div className="message-attachment-list">
                    {message.attachmentNames.map((name, index) => {
                      const assetId = message.attachmentAssetIds?.[index] || ''
                      return assetId
                        ? <MessageAttachment key={`${assetId}-${index}`} assetId={assetId} onPreview={openReferencePreview} />
                        : <span className="message-attachment-unavailable" key={`${name}-${index}`} role="status">图片无法预览</span>
                    })}
                  </div>
                </div> : null}
                {editingMessageId !== message.id && message.role === 'assistant' && (message.content || message.taskId || message.state === 'error' || message.state === 'stopped') && <div className={`message-actions ${message.state === 'error' || message.state === 'stopped' ? 'message-recovery-actions' : ''}`}>
                  {message.content && <button type="button" onClick={() => void copyMessage(message)} disabled={message.state === 'streaming'} title="复制回复" aria-label="复制回复">{copiedId === message.id ? '✓ 已复制' : '⧉ 复制'}</button>}
                  {isChatMessage(message, activeConversation?.mode) && (message.mode === 'chat' || activeMode === 'chat') && !message.media?.length && (message.state === 'error' || message.state === 'stopped' || Boolean(message.content.trim())) && <button type="button" onClick={() => void retryMessage(message.id)} disabled={generating || loading || !models.length} title={message.state === 'error' || message.state === 'stopped' ? '重试回复' : '重新生成回复'} aria-label={message.state === 'error' || message.state === 'stopped' ? '重试回复' : '重新生成回复'}>↻ {message.state === 'error' || message.state === 'stopped' ? '重试' : '重生成'}</button>}
                  {message.mode && message.mode !== 'chat' && (message.state === 'error' || message.state === 'stopped' && !message.taskId) && <button type="button" onClick={() => void retryCreativeMessage(message.id)} disabled={generating || loading} title="重新提交创作任务" aria-label="重新提交创作任务">↻ 重试</button>}
                  {(message.taskId || message.idempotencyKey) && message.mode && message.mode !== 'chat' && (message.state === 'stopped' || message.state === 'streaming') && <button type="button" onClick={() => void refreshMediaMessage(activeConversation?.id || '', message)} disabled={generating} title={message.taskId ? '继续查询任务' : '查询原提交状态'}>↻ {message.taskId ? '继续查询' : '查询原提交'}</button>}
                </div>}
                {editingMessageId !== message.id && message.role === 'user' && isChatMessage(message, activeConversation?.mode) && (message.mode === 'chat' || activeMode === 'chat') && message.content.trim() && <div className="message-actions user-message-actions">
                  <button type="button" onClick={() => startEditMessage(message)} disabled={generating || loading} title="编辑并重生成" aria-label="编辑并重生成">✎ 编辑</button>
                </div>}
              </div>
            </article>
          ))}
        </div>

        {!editingMessageId && <div className="composer-wrap">
          <div className={`composer ${draggingReferences ? 'dragging' : ''}`} onDragOver={handleComposerDragOver} onDragLeave={handleComposerDragLeave} onDrop={handleComposerDrop}>
            {draggingReferences && <div className="drop-hint" aria-live="polite">松开以添加参考图片</div>}
            <div className="composer-input-row">
              {(activeMode === 'chat' || activeMode === 'image' || activeMode === 'video') && <div className="composer-reference-stack" role="group" aria-label="参考图片和上传">
                <div className={`reference-card-stack${references.length ? ' has-references' : ''}`}>
                  {references.map((reference, index) => <div
                    className={`reference-preview ${index === 0 ? 'is-first' : index === 1 ? 'is-second' : index === 2 ? 'is-third' : 'is-later'}`}
                    key={reference.id}
                  >
                    <button className={`reference-preview-image ${reference.preview ? '' : 'unavailable'}`} type="button" onClick={() => reference.preview && openReferencePreview(reference.preview)} disabled={!reference.preview} aria-label="预览图片">
                      {reference.preview ? <img src={reference.preview} alt={reference.file.name} /> : <span>图片<br />未恢复</span>}
                    </button>
                    {(reference.uploadState === 'uploading' || reference.uploadState === 'restoring') && <span className="reference-upload-state" role="status">{reference.uploadState === 'restoring' ? '恢复中' : '上传中'}</span>}
                    {reference.uploadState === 'error' && <button className="reference-upload-state error" type="button" onClick={() => void retryReference(reference)} title={reference.uploadError || '点击重试上传'} aria-label={`重试${reference.file.name}上传`}>!</button>}
                    <button type="button" onClick={() => removeReference(reference.id)} disabled={generating} aria-label={`移除${reference.file.name}`} title="移除图片">×</button>
                  </div>)}
                  <label className="attachment-tile" aria-label={activeMode === 'chat' ? '添加图片附件' : '添加参考图片'}>
                    <input type="file" accept={referenceImageAccept()} multiple onChange={handleReferenceFiles} disabled={loading || generating || !currentModel} />
                    <span aria-hidden="true">＋</span>
                  </label>
                </div>
              </div>}
              {activeMode === 'voice' ? <div className="voice-inputs">
                <textarea ref={textareaRef} value={input} onChange={(event) => changeInput(event.target.value)} onKeyDown={handleInputKeyDown} placeholder={currentModel ? '描述你想要的音色，例如：温暖、清晰、略带磁性的青年女声' : '等待平台音色设计模型可用'} disabled={loading || generating || !currentModel} aria-label="音色描述" />
                <label className="voice-preview-input"><span><strong>试听文案</strong><small>{voicePreviewText.length}/500</small></span><textarea value={voicePreviewText} maxLength={500} rows={2} onChange={(event) => changeVoicePreviewText(event.currentTarget.value)} placeholder="输入用于试听的内容" disabled={loading || generating || !currentModel} aria-label="试听文案" /></label>
              </div> : <textarea ref={textareaRef} value={input} onChange={(event) => changeInput(event.target.value)} onKeyDown={handleInputKeyDown} onPaste={handleComposerPaste} placeholder={currentModel ? activeMode === 'chat' ? '输入消息，开始对话...' : `描述你想创作的${modeLabel(activeMode)}...` : `等待平台${modeLabel(activeMode)}模型可用`} disabled={loading || generating || !currentModel} aria-label={activeMode === 'chat' ? '消息输入框' : `${modeLabel(activeMode)}创作描述`} />}
            </div>
            <div className="composer-bottom">
              <div className="composer-options">
                {activeAudioMode && <div className="audio-type-switch" role="group" aria-label="音频创作类型">
                  <button type="button" className={activeCreationType === 'music' ? 'selected' : ''} onClick={() => changeAudioCreationType('music')} disabled={loading || generating || !creativeModels.music.length}>音乐</button>
                  <button type="button" className={activeCreationType === 'voice' ? 'selected' : ''} onClick={() => changeAudioCreationType('voice')} disabled={loading || generating || !creativeModels.voice.length}>音色设计</button>
                </div>}
                <div className="model-menu-host" ref={modelPopoverRef}>
                  <button
                    type="button"
                    className="model-trigger"
                    aria-expanded={modelMenuOpen}
                    aria-haspopup="listbox"
                    onClick={() => {
                      setSettingsOpen(false)
                      setModelMenuOpen((open) => !open)
                    }}
                    disabled={loading || generating || !modelsForWorkspace.length}
                    title={`选择平台${modeLabel(activeMode)}模型`}
                  >
                    <span>{modelDisplayLabel}</span>
                    <b aria-hidden="true">⌄</b>
                  </button>
                  {modelMenuOpen && modelsForWorkspace.length > 0 && <div className="model-popover" role="listbox" aria-label={`选择平台${modeLabel(activeMode)}模型`}>
                    <p>选择{modeLabel(activeMode)}模型</p>
                    {modelsForWorkspace.map((item) => {
                      const id = modelId(item)
                      const selected = id === activeSelectedModel
                      return <button
                        key={id}
                        type="button"
                        role="option"
                        aria-selected={selected}
                        className={selected ? 'selected' : ''}
                        onClick={() => {
                          changeModel(id)
                          setModelMenuOpen(false)
                        }}
                      >
                        <span>{modelName(item)}</span>
                        {selected && <b aria-hidden="true">✓</b>}
                      </button>
                    })}
                  </div>}
                </div>
                {activeMode !== 'chat' && activeMode !== 'voice' && <div className="settings-popover-host">
                  <button
                    ref={settingsButtonRef}
                    type="button"
                    className="settings-trigger"
                    aria-expanded={settingsOpen}
                    aria-haspopup="dialog"
                    aria-controls={settingsOpen ? settingsPopoverId : undefined}
                    aria-label={`${modeLabel(activeMode)}参数`}
                    onClick={() => {
                      setModelMenuOpen(false)
                      setSettingsOpen((open) => !open)
                    }}
                    disabled={loading || generating || !currentModel}
                    title={settingsSummary || '创作参数'}
                  >
                    {activeMode === 'image' ? <RatioMark value={currentImageAspectRatio || currentImageSize} size={16} /> : <span aria-hidden="true">⚙</span>}
                    <span className="settings-summary">{settingsSummary || '参数'}</span>
                    <b className={settingsOpen ? 'is-open' : ''} aria-hidden="true">⌄</b>
                  </button>
                  {settingsOpen && <ParameterPopover anchor={settingsButtonRef} id={settingsPopoverId}
                    label={`${modeLabel(activeMode)}参数`} onClose={closeSettings} image={activeMode === 'image'} video={activeMode === 'video'}>
                    {activeMode === 'image' && <>
                      <ParameterChoices label="画质" value={currentImageQuality} values={currentQualityOptions}
                        onChange={(quality) => changeImageSetting({ quality })} render={(option) => currentImageOptions.qualityLabels[option] || option} />
                      <ParameterChoices label="清晰度" value={currentImageResolution} values={currentResolutionOptions}
                        onChange={(resolution) => changeImageSetting({ resolution })} render={(option) => option.toUpperCase()} />
                      <ParameterChoices label="比例" value={currentImageAspectRatio} values={currentImageRatios} ratios
                        onChange={(aspectRatio) => changeImageSetting({ aspectRatio })} />
                      {(!currentImageResolution || !currentImageRatios.length) && <ParameterChoices label="图片尺寸" value={currentImageSize} values={currentSizeOptions}
                        columns={2} onChange={(size) => changeImageSetting({ size })} />}
                      {currentImageCountOptions.length > 1 && <div className="settings-field settings-count-field">
                        <span className="settings-field-label">生成数量</span>
                        <div className="settings-count-control" role="group" aria-label="生成数量">
                          <button type="button" aria-label="减少生成数量" disabled={currentImageCountIndex === 0}
                            onClick={() => changeImageSetting({ count: currentImageCountOptions[currentImageCountIndex - 1] })}>−</button>
                          <output aria-live="polite" aria-atomic="true">{currentImageCountValue} 张</output>
                          <button type="button" aria-label="增加生成数量" disabled={currentImageCountIndex >= currentImageCountOptions.length - 1}
                            onClick={() => changeImageSetting({ count: currentImageCountOptions[currentImageCountIndex + 1] })}>+</button>
                        </div>
                      </div>}
                    </>}
                    {activeMode === 'video' && <>
                      <div className="settings-panel-heading">
                        <div className="settings-panel-title"><span className="settings-panel-icon" aria-hidden="true">▦</span><strong>视频参数</strong></div>
                        <span className="settings-panel-hint">修改后下次生成生效</span>
                        <button className="settings-panel-close" type="button" onClick={closeSettings} aria-label="关闭视频参数" title="关闭">×</button>
                      </div>
                      <ParameterChoices label="分辨率" value={currentVideoResolution} values={currentVideoResolutions}
                        onChange={setVideoResolution} columns={3} render={videoResolutionLabel} />
                      <ParameterChoices label="比例" value={currentVideoAspectRatio} values={currentAspectRatios} ratios
                        onChange={setVideoAspectRatio} />
                      {renderDurationSelect('时长', currentVideoDuration, currentVideoDurationOptions, setVideoDuration)}
                    </>}
                    {activeMode === 'music' && <>
                      {renderDurationControl('时长', currentMusicDuration, currentMusicDurationOptions, setMusicDuration)}
                      {renderSettingsChoices('类型', currentMusicMode, currentMusicModes, setMusicMode, 2)}
                      {renderSettingsChoices('格式', currentMusicFormat, currentMusicFormats, setMusicFormat, 2)}
                    </>}
                    {!settingsSummary && <p className="settings-empty">当前模型没有可调整参数</p>}
                  </ParameterPopover>}
                </div>}
              </div>
              <div className="composer-actions">
                <span>{input.length ? `${input.length.toLocaleString()}/${MAX_MESSAGE_LENGTH.toLocaleString()}` : ''}</span>
                {generating ? preparingAttachments
                  ? <button className="stop-button" type="button" disabled><span aria-hidden="true">…</span> 正在上传图片</button>
                  : <button className="stop-button" type="button" onClick={stopGeneration}><span aria-hidden="true">■</span> 停止生成</button>
                  : <button className="send-button" type="button" onClick={() => void sendMessage()} disabled={(!input.trim() && !references.length) || (activeMode === 'voice' && !voicePreviewText.trim()) || loading || !currentModel}><span aria-hidden="true">↗</span> {activeMode === 'chat' ? '发送' : `生成${modeLabel(activeMode)}`}</button>}
              </div>
          </div>
          </div>
          <p className="composer-note">{activeMode === 'chat' ? '内容由平台模型生成，请核验重要信息' : '生成参数来自平台模型能力；创作结果按当前账户保存'}</p>
        </div>}
      </section>
      {taskTrayOpen && <div className="task-tray-overlay" role="dialog" aria-modal="true" aria-labelledby="task-tray-title" onMouseDown={(event) => { if (event.target === event.currentTarget) setTaskTrayOpen(false) }}>
        <section ref={taskTrayPanelRef} className="task-tray-panel" tabIndex={-1}>
          <header className="task-tray-header"><div><p className="task-tray-kicker">CREATIVE TASKS</p><h2 id="task-tray-title">创作任务</h2><p>跨会话恢复仍在处理或需要重试的图片、视频和音频任务。</p></div><button ref={taskTrayCloseRef} type="button" onClick={() => { setTaskTrayOpen(false); window.requestAnimationFrame(() => taskTrayTriggerRef.current?.focus({ preventScroll: true })) }} aria-label="关闭创作任务">×</button></header>
          <div className="task-tray-list">
            {!creativeTasks.length && <div className="task-tray-empty"><span aria-hidden="true">✓</span><strong>没有待处理任务</strong><p>已完成的创作会保留在对应会话中。</p></div>}
            {creativeTasks.map((task) => <article className="task-tray-item" key={`${task.conversationId}:${task.messageId}`}>
              <div className={`task-tray-icon ${task.mode}`} aria-hidden="true">{isAudioMode(task.mode) ? '♫' : task.mode === 'image' ? '▧' : '▷'}</div>
              <div className="task-tray-copy"><div className="task-tray-item-head"><strong>{modeLabel(task.mode)}</strong><span className={task.status}>{task.status === 'failed' ? '失败' : '待恢复'}</span></div><p>{task.prompt || '未填写创作描述'}</p><small>{task.conversationTitle}</small></div>
              <div className="task-tray-actions"><button type="button" onClick={() => openCreativeTask(task)} disabled={generating}>回到对话</button>{task.status === 'pending' && <button type="button" onClick={() => openCreativeTask(task, 'query')} disabled={generating}>继续查询</button>}{task.status === 'failed' && <button type="button" onClick={() => openCreativeTask(task, 'edit')} disabled={generating}>重新编辑</button>}{task.status === 'pending' && task.taskId && task.mode !== 'image' && <button type="button" className="task-cancel" onClick={() => void cancelCreativeTask(task)} disabled={generating}>取消</button>}</div>
            </article>)}
          </div>
        </section>
      </div>}
      {pendingDeleteConversation && <div
        className="delete-dialog-overlay"
        onMouseDown={(event) => { if (event.target === event.currentTarget) closeDeleteConfirmation() }}
      >
        <section ref={deleteDialogRef} className="delete-dialog" role="dialog" aria-modal="true" aria-labelledby="delete-dialog-title" aria-describedby="delete-dialog-description">
          <div className="delete-dialog-icon" aria-hidden="true">×</div>
          <h2 id="delete-dialog-title">删除这段对话？</h2>
          <p id="delete-dialog-description">“{pendingDeleteConversation.title}”及其中的消息和创作记录会从最近对话中移除，无法恢复。</p>
          <div className="delete-dialog-actions">
            <button ref={deleteCancelRef} className="connection-secondary" type="button" onClick={closeDeleteConfirmation}>保留对话</button>
            <button className="delete-confirm" type="button" onClick={removeConversation}>删除对话</button>
          </div>
        </section>
      </div>}
      {activeReferencePreview && <div
        className="reference-preview-overlay"
        role="dialog"
        aria-modal="true"
        aria-label="图片预览"
        onMouseDown={(event) => { if (event.target === event.currentTarget) closeReferencePreview() }}
      >
        <div className="reference-preview-dialog">
          <button ref={referencePreviewCloseRef} className="reference-preview-close" type="button" onClick={closeReferencePreview} aria-label="关闭图片预览" title="关闭">×</button>
          <img src={activeReferencePreview.src} alt="图片预览" />
        </div>
      </div>}
    </main>
  )
}

createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>)
