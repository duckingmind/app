import React, { useEffect, useRef, useState } from 'react'
import { AlertCircle, Check, CheckCircle2, ChevronDown, Feather, Info, Loader2, RefreshCw, Send, Sparkles, X } from 'lucide-react'
import { createAppClient, readAppSessionFromStorage, type AppSdkError } from '@ducking-mind/proxy-app-sdk'
import appManifest from '../manifest.json'
import './styles.css'

// Production web apps use the Portal's App Session and call the Gateway
// directly. Electron keeps its explicit preload transport; local development
// keeps the CLI auth relay.
const electronHost = typeof window !== 'undefined' && Boolean((window as Window & { proxyApp?: unknown }).proxyApp)
const appSession = !import.meta.env.DEV && !electronHost ? readAppSessionFromStorage(appManifest.id) : undefined
const app = createAppClient(appManifest.id, {
  runtime: import.meta.env.DEV ? 'local' : electronHost ? 'electron' : 'direct',
  ...(appSession ? { appSession } : {}),
  localDevelopment: import.meta.env.DEV,
  localAppVersion: appManifest.version,
})
const PROMPT = '创建一个HTML，内容是SVG绘制一个鹈鹕骑自行车的2D动画，你不需要任何测试创建一个HTML，内容是SVG绘制一个鹈鹕骑自行车的2D动画，你不需要任何测试'
const GALLERY_PREFIX = 'pelican/results/'
const GALLERY_PAGE_SIZE = 100
const MAX_RAW_STORAGE = 105_000
const MAX_HTML_STORAGE = 125_000

type ReasoningLevel = { effort?: string; description?: string }
type Model = { id?: string; model?: string; slug?: string; name?: string; display_name?: string; type?: string; model_type?: string; modality?: string; default_reasoning_level?: string | null; supported_reasoning_levels?: ReasoningLevel[] }
type UserProfile = { id?: string; email?: string; username?: string; name?: string; avatar_url?: string }
type ErrorDetail = { message: string; requestId?: string; code?: string }
type Toast = ErrorDetail & { id: number; kind: 'error' | 'success' | 'info' }
type GalleryItem = { id: string; userId?: string; userName: string; model: string; modelId?: string; reasoningEffort?: string; generatedAt: string; requestId?: string; raw: string; html: string }
type SelectOption = { value: string; label: string; description?: string }

const AUTH_ERROR_CODES = new Set(['APP_LOGIN_REQUIRED', 'APP_LOGIN_POPUP_BLOCKED', 'APP_LOGIN_TIMEOUT', 'APP_LOGIN_FAILED', 'APP_LOGIN_SESSION_EXPIRED', 'APP_LOGIN_TOKEN_INVALID', 'APP_LOGIN_STATE_INVALID', 'insufficient_scope', 'APP_PERMISSION_DENIED'])
const SESSION_ERROR_CODES = new Set(['APP_LOGIN_REQUIRED', 'APP_LOGIN_SESSION_EXPIRED', 'APP_LOGIN_NOT_ALLOWED', 'APP_SESSION_EXPIRED', 'APP_SESSION_INVALID', 'APP_AUTH_CHANGED', 'APP_ACCOUNT_CHANGED'])

function record(value: unknown): Record<string, unknown> | null { return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null }
function modelsOf(value: unknown): Model[] {
  if (Array.isArray(value)) return value as Model[]
  const root = record(value)
  if (!root) return []
  if (Array.isArray(root.data)) return root.data as Model[]
  if (Array.isArray(root.items)) return root.items as Model[]
  const data = record(root.data)
  return data && Array.isArray(data.data) ? data.data as Model[] : data && Array.isArray(data.items) ? data.items as Model[] : []
}
function modelId(item: Model) { return String(item.id || item.model || item.slug || '').trim() }
function reasoningLevels(item: Model | undefined) {
  const levels = Array.isArray(item?.supported_reasoning_levels)
    ? item.supported_reasoning_levels.map(level => typeof level === 'string' ? level : level?.effort).filter((level): level is string => Boolean(level?.trim()))
    : []
  return [...new Set(levels)]
}
function defaultReasoningLevel(item: Model | undefined) {
  const levels = reasoningLevels(item)
  return levels.includes('high') ? 'high' : item?.default_reasoning_level || levels[0] || ''
}
function reasoningLabel(level: string | undefined) {
  if (!level) return '默认'
  return ({ low: '低', medium: '中', high: '高', xhigh: '极高', max: '最高', ultra: '极高' } as Record<string, string>)[level] || level
}
function isTextModel(item: Model) {
  const type = String(item.type || item.model_type || item.modality || '').toLowerCase()
  if (['image', 'video', 'audio', 'music', 'embedding'].includes(type)) return false
  return Boolean(modelId(item)) && !/(image|video|audio|music|embedding|tts|whisper)/.test(modelId(item).toLowerCase())
}
function responseText(value: unknown): string {
  if (typeof value === 'string') return value
  const root = record(value)
  if (!root) return ''
  for (const key of ['output_text', 'text', 'content']) if (typeof root[key] === 'string') return root[key] as string
  const output = Array.isArray(root.output) ? root.output : []
  const parts: string[] = []
  for (const item of output) {
    const row = record(item)
    if (!row) continue
    // Responses implementations vary: a message may expose its text as
    // `text`, as content parts, or (in some gateways) both. Prefer content
    // parts when present so the same text is not appended twice.
    const contentParts = Array.isArray(row.content)
      ? row.content.map(child => record(child)).filter((part): part is Record<string, unknown> => Boolean(part && typeof part.text === 'string')).map(part => part.text as string)
      : []
    if (contentParts.length) parts.push(...contentParts)
    else if (typeof row.text === 'string') parts.push(row.text)
  }
  return parts.join('\n')
}
function responseModel(value: unknown, fallback: string) {
  const root = record(value)
  const model = root && typeof root.model === 'string' ? root.model.trim() : ''
  if (!model && root?.response) return responseModel(root.response, fallback)
  return model || fallback
}
function responseReasoning(value: unknown, fallback?: string) {
  const root = record(value)
  const reasoning = record(root?.reasoning)
  const effort = reasoning && typeof reasoning.effort === 'string' ? reasoning.effort.trim() : ''
  if (!effort && root?.response) return responseReasoning(root.response, fallback)
  return effort || fallback
}
function responseRequestId(value: unknown): string | undefined {
  const root = record(value)
  if (!root) return undefined
  for (const key of ['request_id', 'requestId']) {
    const candidate = root[key]
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim()
  }
  // Some compatible gateways wrap the response body in `data` or `result`.
  // Keep this tolerant so a valid trace ID is not lost when the envelope
  // changes between the browser and desktop runtimes.
  for (const key of ['data', 'result', 'response']) {
    const nested = responseRequestId(root[key])
    if (nested) return nested
  }
  return undefined
}
function newRequestId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  return `req_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`
}
function streamDelta(value: unknown, eventName?: string): string {
  if (typeof value === 'string') return value === '[DONE]' ? '' : value
  const root = record(value)
  if (!root) return ''

  // Reasoning summaries and tool events can also carry a `delta` field. Only
  // consume explicit output-text events; a missing event/type remains
  // accepted for older OpenAI-compatible gateways that send bare deltas.
  const type = `${eventName || ''} ${typeof root.type === 'string' ? root.type : ''}`.toLowerCase().trim()
  const isReasoning = type.includes('reasoning') || type.includes('analysis')
  const isTextDelta = !type || type.includes('output_text.delta') || type.includes('text_delta') || type === 'delta' || type.includes('content.delta') || type.includes('message.delta')
  const hasChoices = Array.isArray(root.choices)
  if (isReasoning || (!isTextDelta && !hasChoices)) return ''

  // Responses API emits `response.output_text.delta` events with a `delta`
  // string. Some compatible gateways use `text_delta` instead.
  for (const key of ['delta', 'text_delta']) {
    if (typeof root[key] === 'string') return root[key] as string
  }

  // Chat Completions compatible streams put the text under choices[].delta.
  if (Array.isArray(root.choices)) {
    const parts: string[] = []
    for (const choice of root.choices) {
      const row = record(choice)
      const delta = record(row?.delta)
      if (typeof delta?.content === 'string') parts.push(delta.content)
      else if (Array.isArray(delta?.content)) {
        for (const part of delta.content) {
          const content = record(part)
          if (typeof content?.text === 'string') parts.push(content.text)
        }
      } else if (typeof row?.text === 'string') parts.push(row.text)
    }
    return parts.join('')
  }

  return ''
}
function streamFailure(value: unknown, eventName?: string): Error | null {
  const root = record(value)
  if (!root) return null
  const type = `${eventName || ''} ${typeof root.type === 'string' ? root.type : ''}`.toLowerCase()
  const response = record(root.response)
  const errorValue = root.error || response?.error
  const error = record(errorValue)
  const responseStatus = String(response?.status || '').toLowerCase()
  const incomplete = type.includes('incomplete') || responseStatus === 'incomplete'
  const failed = type.includes('failed') || type.includes('error') || responseStatus === 'failed'
  if (!error && !failed && !incomplete) return null
  const message = typeof error?.message === 'string'
    ? error.message
    : incomplete
      ? '模型流式响应未完整结束。'
    : typeof root.message === 'string'
      ? root.message
      : '模型流式响应失败。'
  const failure = new Error(message) as Error & { code?: string; requestId?: string }
  const code = typeof error?.code === 'string' ? error.code : typeof root.code === 'string' ? root.code : undefined
  const requestId = responseRequestId(value)
  if (code) failure.code = code
  if (requestId) failure.requestId = requestId
  return failure
}
function normalizeStoredUserName(value: string) {
  return value === '当前用户' || value === '未获取到用户' ? '未知用户' : value
}
function extractHtml(value: string) {
  const candidates = [...value.matchAll(/```(?:html|xml|svg)?\s*([\s\S]*?)```/gi)].map(match => match[1].trim())
  candidates.push(value.trim())

  for (const source of candidates) {
    if (!source) continue

    const document = source.match(/(?:<!doctype\s+html\b[^>]*>\s*)?<html\b[\s\S]*?<\/html\s*>/i)
    if (document) return document[0]

    const svg = source.match(/<svg\b[\s\S]*?<\/svg\s*>/i)
    if (svg) return `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>html,body{width:100%;height:100%;margin:0}body{display:grid;place-items:center}svg{display:block;max-width:100%;max-height:100%}</style></head><body>${svg[0]}</body></html>`

    // Some models return a useful HTML fragment instead of a full document.
    // Only accept a fragment when the candidate itself begins with markup and
    // contains recognizable visual HTML; never preview explanatory prose.
    if (/^(?:<!--[\s\S]*?-->\s*)*</.test(source) && /<(?:main|body|div|section|article|header|footer|button|canvas|table|form|p|h[1-6])\b/i.test(source)) {
      return `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body>${source}</body></html>`
    }
  }

  return ''
}
function hasPreviewMarkup(value: string) {
  return /<(?:!doctype\s+html|html|svg|body|main|div|section|article|header|footer|button|canvas|table|form|p|h[1-6])\b/i.test(value)
}

// Model output is untrusted application content. Render it in a sandboxed
// document instead of inserting it into the Pelican DOM. SVG and CSS
// animations work in this isolated document; scripts, network access, forms
// and navigation are intentionally disabled.
const PREVIEW_CSP = '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'; img-src data: blob:; font-src data:; media-src data: blob:; script-src \'none\'; connect-src \'none\'; object-src \'none\'; base-uri \'none\'; form-action \'none\';">'

function previewDocument(value: string) {
  const source = hasPreviewMarkup(value) ? value.trim() : extractHtml(value)
  if (!source || !hasPreviewMarkup(source)) return ''
  if (/<html\b/i.test(source)) {
    if (/<head\b/i.test(source)) return source.replace(/(<head\b[^>]*>)/i, `$1${PREVIEW_CSP}`)
    return source.replace(/(<html\b[^>]*>)/i, `$1<head>${PREVIEW_CSP}</head>`)
  }
  return `<!doctype html><html><head>${PREVIEW_CSP}<style>html,body{width:100%;height:100%;margin:0;overflow:hidden}body{display:grid;place-items:center}svg{display:block;max-width:100%;max-height:100%}</style></head><body>${source}</body></html>`
}

function AppSelect({ value, options, onChange, placeholder, ariaLabel, disabled = false }: {
  value: string
  options: SelectOption[]
  onChange: (value: string) => void
  placeholder: string
  ariaLabel: string
  disabled?: boolean
}) {
  const [open, setOpen] = useState(false)
  const [activeIndex, setActiveIndex] = useState(() => Math.max(0, options.findIndex(option => option.value === value)))
  const rootRef = useRef<HTMLDivElement | null>(null)
  const selected = options.find(option => option.value === value)

  useEffect(() => {
    const handlePointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('pointerdown', handlePointerDown)
    return () => document.removeEventListener('pointerdown', handlePointerDown)
  }, [])

  useEffect(() => {
    const selectedIndex = options.findIndex(option => option.value === value)
    setActiveIndex(selectedIndex >= 0 ? selectedIndex : 0)
  }, [options, value])

  function choose(option: SelectOption) {
    onChange(option.value)
    setOpen(false)
  }

  function handleKeyDown(event: React.KeyboardEvent<HTMLButtonElement>) {
    if (disabled) return
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      setOpen(true)
      setActiveIndex(current => {
        if (!options.length) return 0
        const direction = event.key === 'ArrowDown' ? 1 : -1
        return (current + direction + options.length) % options.length
      })
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      if (open && options[activeIndex]) choose(options[activeIndex])
      else setOpen(true)
    } else if (event.key === 'Escape') {
      setOpen(false)
    }
  }

  return <div className={`app-select${open ? ' is-open' : ''}`} ref={rootRef}>
    <button
      type="button"
      className="app-select-trigger"
      aria-label={ariaLabel}
      aria-haspopup="listbox"
      aria-expanded={open}
      disabled={disabled}
      onClick={() => setOpen(current => !current)}
      onKeyDown={handleKeyDown}
    >
      <span className={selected ? 'app-select-value' : 'app-select-placeholder'}>{selected?.label || placeholder}</span>
      <ChevronDown size={15} aria-hidden="true" />
    </button>
    {open && options.length > 0 && <div className="app-select-menu" role="listbox" aria-label={ariaLabel}>
      {options.map((option, index) => <button
        type="button"
        role="option"
        aria-selected={option.value === value}
        className={`app-select-option${index === activeIndex ? ' is-active' : ''}`}
        key={option.value}
        onMouseEnter={() => setActiveIndex(index)}
        onClick={() => choose(option)}
      >
        <span className="app-select-option-copy"><strong>{option.label}</strong>{option.description && <small>{option.description}</small>}</span>
        {option.value === value && <Check size={15} aria-hidden="true" />}
      </button>)}
    </div>}
  </div>
}
function errorDetail(error: unknown): ErrorDetail {
  const e = error as Partial<AppSdkError> & { message?: string }
  return { message: e.message || '请求失败，请检查平台连接和可用模型。', requestId: e.requestId, code: e.code }
}
function isFetchTransportError(error: unknown) {
  return error instanceof TypeError || /failed to fetch|networkerror|load failed/i.test(errorDetail(error).message)
}
function isSessionError(error: unknown) {
  const detail = errorDetail(error)
  return Boolean(detail.code && SESSION_ERROR_CODES.has(detail.code))
}
function formatDate(value: string) {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('zh-CN', { hour12: false })
}
function validGalleryItem(value: unknown): value is GalleryItem {
  const item = record(value)
  // Author identity is supplied by shared KV metadata. Never accept the
  // client-provided userName/userId fields inside the stored value.
  return Boolean(item && typeof item.id === 'string' && typeof item.model === 'string' && typeof item.generatedAt === 'string' && typeof item.raw === 'string' && typeof item.html === 'string')
}
function fitGalleryItem(item: GalleryItem): GalleryItem { return { ...item, raw: item.raw.slice(0, MAX_RAW_STORAGE), html: item.html.slice(0, MAX_HTML_STORAGE) } }
function isStorageScopeError(cause: unknown) {
  const detail = errorDetail(cause)
  return detail.code === 'insufficient_scope' || detail.code === 'APP_PERMISSION_DENIED' || /storage\.user|app permission is not granted/i.test(detail.message)
}
function storageReadToast(cause: unknown): ErrorDetail {
  const detail = errorDetail(cause)
  if (isStorageScopeError(cause)) {
    return {
      ...detail,
      message: '平台 KV 读取被拒绝，当前没有可展示的生成结果。请更新平台服务并重新打开应用，获取包含 KV 能力的新会话。',
    }
  }
  if (detail.code === 'APP_SESSION_EXPIRED' || detail.code === 'APP_SESSION_INVALID' || detail.code === 'APP_AUTH_CHANGED') {
    return { ...detail, message: '平台会话已失效，当前没有可展示的生成结果。请重新打开应用或登录平台。' }
  }
  return { ...detail, message: `平台 KV 暂时无法读取，当前没有可展示的生成结果：${detail.message}` }
}
function mergeGalleryItems(...groups: GalleryItem[][]) {
  const byId = new Map<string, GalleryItem>()
  for (const group of groups) {
    for (const item of group) {
      if (!validGalleryItem(item) || byId.has(item.id)) continue
      byId.set(item.id, item)
    }
  }
  return [...byId.values()].sort((a, b) => b.generatedAt.localeCompare(a.generatedAt))
}
async function loadGallery() {
  let cloud: GalleryItem[] = []
  let kvError: unknown
  try {
    // Results belong to the application gallery, not the current user's
    // private space. The SDK derives this namespace from the App Session;
    // callers cannot select a scope or impersonate another app/user.
    let cursor: string | undefined
    do {
      const page = await app.sharedStorage.list({ prefix: GALLERY_PREFIX, limit: GALLERY_PAGE_SIZE, ...(cursor ? { cursor } : {}) })
      if (page.keys.length) {
        const entries = await app.sharedStorage.getEntries<GalleryItem>(page.keys)
        for (const entry of Object.values(entries)) {
          if (!entry || !validGalleryItem(entry.value)) continue
          const author = entry.author
          cloud.push({
            ...entry.value,
            userId: author?.id,
            userName: normalizeStoredUserName(author?.name || '未知用户'),
          })
        }
      }
      cursor = page.nextCursor
    } while (cursor)
  } catch (cause) { kvError = cause }
  const items = mergeGalleryItems(cloud).map(item => ({ ...item, userName: normalizeStoredUserName(item.userName) })).map(item => item.html && hasPreviewMarkup(item.html) ? item : { ...item, html: extractHtml(item.raw) })
  return { items, kvError }
}

export default function App() {
  const [models, setModels] = useState<Model[]>([])
  const [selectedModel, setSelectedModel] = useState('')
  const [selectedReasoning, setSelectedReasoning] = useState('')
  const [status, setStatus] = useState<'loading' | 'ready' | 'working' | 'streaming' | 'saving' | 'success' | 'error'>('loading')
  const [toast, setToast] = useState<Toast | null>(null)
  const toastTimerRef = useRef<number | null>(null)
  const [reload, setReload] = useState(0)
  const [loggingIn, setLoggingIn] = useState(false)
  const [userName, setUserName] = useState('读取中…')
  const [userId, setUserId] = useState('')
  const [userEmail, setUserEmail] = useState('')
  const [gallery, setGallery] = useState<GalleryItem[]>([])

  function dismissToast() {
    if (toastTimerRef.current !== null) {
      window.clearTimeout(toastTimerRef.current)
      toastTimerRef.current = null
    }
    setToast(null)
  }
  function showToast(detail: ErrorDetail, kind: Toast['kind'], persistent = false) {
    if (toastTimerRef.current !== null) window.clearTimeout(toastTimerRef.current)
    toastTimerRef.current = null
    const id = Date.now() + Math.floor(Math.random() * 1000)
    setToast({ ...detail, id, kind })
    const requiresLogin = Boolean(detail.code && AUTH_ERROR_CODES.has(detail.code))
    if (!requiresLogin && !persistent) {
      toastTimerRef.current = window.setTimeout(() => {
        setToast(current => current?.id === id ? null : current)
        toastTimerRef.current = null
      }, kind === 'error' ? 9000 : 5000)
    }
  }
  function showError(cause: unknown) { showToast(errorDetail(cause), 'error') }

  useEffect(() => () => {
    if (toastTimerRef.current !== null) window.clearTimeout(toastTimerRef.current)
  }, [])

  // Remove results written by older builds. The current app never reads or
  // writes gallery data from browser storage; results come only from the KV API.
  useEffect(() => {
    try {
      if (typeof localStorage === 'undefined') return
      for (let index = localStorage.length - 1; index >= 0; index -= 1) {
        const key = localStorage.key(index)
        if (key === 'pelican:gallery:v1' || key === 'pelican:gallery:deleted:v1' || key?.startsWith('pelican:results:')) localStorage.removeItem(key)
      }
    } catch { /* Old cache cleanup is best effort. */ }
  }, [])

  useEffect(() => {
    let active = true
    setStatus('loading')
    setUserName('读取中…')
    setUserId('')
    setUserEmail('')
    setGallery([])
    app.platform.createSession().then(async () => {
      const [modelsResult, profileResult, savedResult] = await Promise.allSettled([app.api.request('/models'), app.user.getProfile(), loadGallery()])
      if (!active) return
      const saved = savedResult.status === 'fulfilled' ? savedResult.value : { items: [], kvError: savedResult.reason }
      const profileReadFailed = profileResult.status === 'rejected'
      const profileSessionFailed = profileReadFailed && isSessionError(profileResult.reason)
      // A missing/unsupported profile route does not invalidate the App
      // Session. Gallery entries still come only from the authenticated KV
      // API; clear them only when authentication itself failed.
      setGallery(profileSessionFailed ? [] : saved.items)
      if (saved.kvError) {
        showToast(storageReadToast(saved.kvError), 'error')
      }
      const profile = profileResult.status === 'fulfilled' ? profileResult.value as UserProfile : null
      const profileName = profile?.name || profile?.username || profile?.id || profile?.email
      setUserId(profile?.id || '')
      setUserName(profileName || (profileSessionFailed ? '登录信息不可用' : '当前平台账户'))
      setUserEmail(profile?.email || '')
      if (profileReadFailed) {
        const detail = errorDetail(profileResult.reason)
        const message = detail.code === 'APP_RUNTIME_METHOD_NOT_SUPPORTED'
          ? '当前运行环境不支持用户资料接口，请更新本地开发代理后重试。'
          : detail.code === 'not_found'
            ? '平台未找到用户资料接口（not_found），用户名称暂不可显示。请检查资料接口路径或平台服务版本。'
            : profileSessionFailed
            ? '当前登录用户资料读取失败，请重新登录平台后重试。'
            : `用户资料暂不可用，当前使用通用账户名称：${detail.message}`
        showToast({ message, code: detail.code, requestId: detail.requestId }, 'error')
      }
      if (modelsResult.status === 'rejected') {
        setGallery([])
        setStatus('error')
        showError(modelsResult.reason)
        return
      }
      const available = modelsOf(modelsResult.value).filter(isTextModel).filter((item, index, all) => modelId(item) && all.findIndex(other => modelId(other) === modelId(item)) === index)
      setModels(available)
      const initialModel = available.find(item => modelId(item) === selectedModel) || available[0]
      setSelectedModel(current => available.some(item => modelId(item) === current) ? current : modelId(available[0] || {}))
      setSelectedReasoning(defaultReasoningLevel(initialModel))
      setStatus(available.length ? 'ready' : 'error')
      if (!available.length) showError({ message: '平台已连接，但没有可用的文本模型。' })
    }).catch(cause => { if (active) { setUserName('登录信息不可用'); setUserId(''); setUserEmail(''); setStatus('error'); showError(cause) } })
    return () => { active = false }
  }, [reload])

  async function saveResult(item: GalleryItem) {
    const value = fitGalleryItem(item)
    // The browser may display the current profile, but it cannot author shared
    // records. The server resolves author metadata from the App Session.
    const { userId: _storedUserId, userName: _storedUserName, ...storedValue } = value
    const key = `${GALLERY_PREFIX}${value.id}`
    try {
      const result = await app.sharedStorage.set(key, storedValue)
      if (!result?.success) throw new Error('平台未确认共享 KV 写入。')
    } catch (cause) {
      const detail = errorDetail(cause)
      const message = isStorageScopeError(cause)
        ? 'KV 未保存，生成结果不会保留。请更新平台服务并重新打开应用，获取包含 KV 能力的新会话。'
        : isFetchTransportError(cause)
          ? '浏览器无法连接共享 KV 服务，保存状态不确定。请检查 Gateway 跨域预检和共享 KV 路由，或刷新结果页核对是否已保存。'
          : `KV 写入未成功：${detail.message}`
      showToast({ message, code: detail.code, requestId: detail.requestId }, 'error')
      return false
    }

    // The PUT response confirms the commit. Show it immediately, then fetch
    // the canonical author metadata separately so a failed follow-up GET can
    // never be reported as a failed save.
    const provisional: GalleryItem = {
      ...storedValue,
      userId: value.userId,
      userName: normalizeStoredUserName(value.userName),
    }
    setGallery(current => mergeGalleryItems([provisional], current))
    try {
      const committed = await app.sharedStorage.getEntry<GalleryItem>(key)
      if (committed?.value && validGalleryItem(committed.value)) {
        const displayed: GalleryItem = {
          ...committed.value,
          userId: committed.author?.id,
          userName: normalizeStoredUserName(committed.author?.name || '未知用户'),
        }
        setGallery(current => mergeGalleryItems([displayed], current))
      }
      showToast({ message: '结果已保存' }, 'success')
    } catch (cause) {
      const detail = errorDetail(cause)
      const reason = isFetchTransportError(cause)
        ? '无法读取作者信息，请稍后刷新页面重试。'
        : `读取作者信息失败：${detail.message}`
      // The write was already acknowledged. A follow-up read is only needed
      // to refresh server-owned author metadata, so keep the successful
      // generation state and explain the refresh limitation as an info toast.
      showToast({ message: `结果已保存到平台 KV，但作者信息暂未刷新。${reason}`, code: detail.code, requestId: detail.requestId }, 'info')
    }
    return true
  }
  async function generate() {
    if (!selectedModel) { showError({ message: '请先选择一个文本模型。' }); setStatus('error'); return }
    if (userName === '登录信息不可用' || userName === '读取中…') { showError({ message: '未获取到当前登录用户，请重新登录平台后再生成。' }); setStatus('error'); return }
    const requestId = newRequestId()
    setStatus('working'); dismissToast()
    showToast({ message: '正在生成，请不要关闭网页。' }, 'info', true)
    try {
      const model = models.find(item => modelId(item) === selectedModel)
      const effort = selectedReasoning || defaultReasoningLevel(model)
      let streamText = ''
      let lastData: unknown
      let actualRequestId = requestId
      let receivedFirstEvent = false
      for await (const event of app.api.stream('/responses/stream', {
        method: 'POST',
        headers: { 'X-Request-ID': requestId },
        body: JSON.stringify({ model: selectedModel, input: PROMPT, stream: true, store: false, ...(effort ? { reasoning: { effort } } : {}) }),
      })) {
        lastData = event.data
        actualRequestId = responseRequestId(event.data) || actualRequestId
        const failure = streamFailure(event.data, event.event)
        if (failure) throw failure
        if (!receivedFirstEvent) {
          receivedFirstEvent = true
          setStatus('streaming')
          showToast({ message: '正在接收模型输出，请不要关闭网页。', requestId: actualRequestId }, 'info', true)
        }
        const delta = streamDelta(event.data, event.event)
        if (delta) streamText += delta
      }
      const finalResponse = record(lastData)?.response || lastData
      const text = streamText.trim() ? streamText : responseText(finalResponse)
      if (!text.trim()) throw new Error('模型返回内容为空。')
      setStatus('saving')
      showToast({ message: '模型输出已完成，正在保存结果，请不要关闭网页。', requestId: actualRequestId }, 'info', true)
      const generatedHtml = extractHtml(text)
      const actualModel = responseModel(finalResponse, selectedModel)
      const actualModelInfo = models.find(item => modelId(item) === actualModel)
      const saved = await saveResult({ id: newRequestId(), userId: userId || undefined, userName, model: actualModelInfo?.display_name || actualModelInfo?.name || actualModel, modelId: actualModel, reasoningEffort: responseReasoning(finalResponse, effort), generatedAt: new Date().toISOString(), requestId: actualRequestId, raw: text, html: generatedHtml })
      if (saved) setStatus('success')
      else setStatus('error')
    } catch (cause) {
      setStatus('error')
      const detail = errorDetail(cause)
      showError({ ...detail, requestId: detail.requestId || requestId })
    }
  }
  async function loginPlatform() {
    setLoggingIn(true); setStatus('loading'); setGallery([]); dismissToast()
    try { await app.auth.login(); showToast({ message: '平台登录成功，正在刷新模型。' }, 'success'); setReload(value => value + 1) } catch (cause) { setStatus('error'); showError(cause) } finally { setLoggingIn(false) }
  }
  return <div className="app-shell">
    {toast && <div className={`toast toast-${toast.kind}`} role={toast.kind === 'error' ? 'alert' : 'status'} aria-live={toast.kind === 'error' ? 'assertive' : 'polite'}><div className="toast-icon">{toast.kind === 'error' ? <AlertCircle size={17}/> : toast.kind === 'success' ? <CheckCircle2 size={17}/> : <Info size={17}/>}</div><div className="toast-copy"><strong>{toast.message}</strong>{toast.requestId && <small>请求编号：{toast.requestId}</small>}{toast.code && <small>错误代码：{toast.code}</small>}</div>{toast.code && AUTH_ERROR_CODES.has(toast.code) && <button className="login-button" onClick={loginPlatform} disabled={loggingIn}>{loggingIn ? <><Loader2 size={15} className="spin"/>授权中</> : '登录平台'}</button>}<button className="toast-close" onClick={dismissToast} aria-label="关闭提示"><X size={15}/></button></div>}
    <header className="topbar"><div className="brand"><span className="brand-mark"><Feather size={20}/></span><div><strong>Pelican Probe</strong><small>LLM-GATEWAY OBSERVER</small></div></div><div className="account-chip" title="当前登录平台账户"><span className="account-avatar">{userName.slice(0, 1).toUpperCase()}</span><span className="account-chip-copy"><strong>{userName}</strong><small>{userEmail || '当前平台账户'}</small></span></div></header>
    <main className="main">
      <section className="intro"><div><span className="eyebrow">PELICAN / HTML / SVG</span><h1>生成结果</h1></div></section>
      <section className="control-panel compact-control"><div className="control-row"><label className="model-select"><span>选择模型</span><AppSelect value={selectedModel} options={models.map(item => ({ value: modelId(item), label: item.display_name || item.name || modelId(item), description: modelId(item) }))} onChange={value => { const next = models.find(item => modelId(item) === value); setSelectedModel(value); setSelectedReasoning(defaultReasoningLevel(next)); dismissToast() }} disabled={!models.length || ['working', 'streaming', 'saving', 'loading'].includes(status) || loggingIn} placeholder={status === 'loading' ? '正在读取模型…' : models.length ? '请选择文本模型' : '暂无可用模型'} ariaLabel="选择模型" /></label>{reasoningLevels(models.find(item => modelId(item) === selectedModel)).length > 0 && <label className="model-select model-strength"><span>思考强度</span><AppSelect value={selectedReasoning} options={reasoningLevels(models.find(item => modelId(item) === selectedModel)).map(level => ({ value: level, label: reasoningLabel(level), description: level }))} onChange={value => { setSelectedReasoning(value); dismissToast() }} disabled={['working', 'streaming', 'saving', 'loading'].includes(status) || loggingIn} placeholder="选择思考强度" ariaLabel="思考强度" /></label>}<button className={`generate-button ${status === 'error' ? 'retry' : ''}`} onClick={status === 'error' && !selectedModel ? () => setReload(value => value + 1) : generate} disabled={['working', 'streaming', 'saving', 'loading'].includes(status) || loggingIn || (status !== 'error' && !selectedModel)} title={selectedModel ? `使用 ${selectedModel} 生成` : '请选择模型'}>{status === 'loading' ? <><Loader2 size={17} className="spin"/>连接中</> : status === 'working' ? <><Loader2 size={17} className="spin"/>准备生成</> : status === 'streaming' ? <><Loader2 size={17} className="spin"/>接收中</> : status === 'saving' ? <><Loader2 size={17} className="spin"/>保存中</> : status === 'error' && !selectedModel ? <><RefreshCw size={17}/>重试连接</> : <><Send size={17}/>生成动画</>}</button></div></section>
      <section className="gallery-section"><div className="gallery-heading"><div><span className="eyebrow">HTML / SVG</span><h2>生成结果</h2></div><span className="gallery-count">{gallery.length} 条</span></div>{gallery.length ? <div className="gallery-grid">{gallery.map(item => {
        const preview = previewDocument(item.html || item.raw)
        return <article className="gallery-card" key={item.id}>
          <div className="gallery-preview">
            {preview ? <iframe
              title={`${item.model} SVG 动画预览`}
              srcDoc={preview}
              sandbox=""
              referrerPolicy="no-referrer"
              loading="lazy"
            /> : <div className="gallery-preview-empty"><Sparkles size={20}/><span>模型未返回可预览的 HTML / SVG</span></div>}
          </div>
          <div className="gallery-meta"><strong>模型：{item.model}</strong><span>用户：{item.userName}</span><span>强度：{item.reasoningEffort ? `${reasoningLabel(item.reasoningEffort)}（${item.reasoningEffort}）` : '默认'}</span><time>{formatDate(item.generatedAt)}</time></div>
          <div className="gallery-actions"><span className="request-id" title={item.requestId || 'Request ID'}>Request ID：{item.requestId || '-'}</span></div>
        </article>
      })}</div> : <div className="gallery-empty"><Sparkles size={22}/><span>点击“生成动画”，生成结果会直接显示在这里</span></div>}</section>
      <footer><CheckCircle2 size={14}/> 每次请求只发送上方完整提示词；生成结果仅通过平台 KV 保存和读取。</footer>
    </main>
  </div>
}
