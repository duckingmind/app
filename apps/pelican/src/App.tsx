import React, { useEffect, useRef, useState } from 'react'
import { AlertCircle, Check, CheckCircle2, ChevronDown, Feather, Info, Loader2, RefreshCw, Send, Sparkles, X } from 'lucide-react'
import { AppSdkError, createAppClient, type AppSession } from '@ducking-mind/proxy-app-sdk'
import appManifest from '../manifest.json'
import { mergeGalleryItems, type GalleryItem } from './gallery-storage'
import {
  generationTaskStorageKeys,
  generationTaskSubmission,
  readPendingGenerationSubmission,
  readStoredGenerationTask,
  writePendingGenerationSubmission,
  writeStoredGenerationTask,
} from './gateway'
import './styles.css'

// Development and Electron keep their host-owned authentication flows. A
// published browser app exchanges its Portal device cookie for its own session.
const electronHost = typeof window !== 'undefined' && Boolean((window as Window & { proxyApp?: unknown }).proxyApp)
const EXPLICIT_LOGOUT_KEY = 'proxy-app:explicit-logout'
function explicitPortalLogout() {
  try { return localStorage.getItem(EXPLICIT_LOGOUT_KEY) === '1' } catch { return false }
}
async function exchangeAppSession(): Promise<AppSession> {
  if (explicitPortalLogout()) {
    throw new AppSdkError('APP_LOGIN_REQUIRED', '请先登录平台账户。', undefined, 401)
  }
  let workspaceID = ''
  try {
    const stored = JSON.parse(localStorage.getItem('workspace-store') || 'null') as { state?: { activeWorkspaceId?: unknown } } | null
    if (typeof stored?.state?.activeWorkspaceId === 'string') workspaceID = stored.state.activeWorkspaceId
  } catch { /* The server defaults to the signed-in user's personal workspace. */ }
  const response = await fetch(`/api/market/apps/${encodeURIComponent(appManifest.id)}/sessions`, {
    method: 'POST',
    credentials: 'same-origin',
    cache: 'no-store',
    redirect: 'error',
    headers: {
      'Content-Type': 'application/json',
      ...(workspaceID ? { 'X-Workspace-ID': workspaceID } : {}),
    },
    body: JSON.stringify({ expected_version: appManifest.version }),
  })
  const payload = record(await response.json().catch(() => null))
  if (!response.ok) {
    throw new AppSdkError(
      typeof payload?.code === 'string' ? payload.code : 'APP_SESSION_EXCHANGE_FAILED',
      typeof payload?.message === 'string' ? payload.message : typeof payload?.error === 'string' ? payload.error : '无法获取应用会话。',
      undefined,
      response.status,
      payload,
    )
  }
  const session = record(payload?.data)
  const aliases = Array.isArray(session?.app_aliases) ? session.app_aliases : []
  if (!session
    || typeof session.session_id !== 'string'
    || typeof session.access_token !== 'string'
    || !session.access_token.startsWith('ast_')
    || typeof session.gateway_url !== 'string'
    || typeof session.app_id !== 'string'
    || typeof session.app_slug !== 'string'
    || typeof session.app_version !== 'string'
    || session.app_version !== appManifest.version
    || !(session.app_id === appManifest.id || session.app_slug === appManifest.id || aliases.includes(appManifest.id))) {
    throw new AppSdkError('APP_SESSION_INVALID', '平台返回的应用会话无效。')
  }
  return session as unknown as AppSession
}
async function exchangeDevelopmentAppSession(): Promise<AppSession> {
  if (explicitPortalLogout()) {
    throw new AppSdkError('APP_LOGIN_REQUIRED', '请先登录平台账户。', undefined, 401)
  }
  let workspaceID = ''
  try {
    const stored = JSON.parse(localStorage.getItem('workspace-store') || 'null') as { state?: { activeWorkspaceId?: unknown } } | null
    if (typeof stored?.state?.activeWorkspaceId === 'string') workspaceID = stored.state.activeWorkspaceId
  } catch { /* The server defaults to the signed-in user's personal workspace. */ }
  const response = await fetch('/__proxy-app/auth/session', {
    method: 'POST',
    credentials: 'same-origin',
    cache: 'no-store',
    redirect: 'error',
    headers: {
      'Content-Type': 'application/json',
      ...(workspaceID ? { 'X-Workspace-ID': workspaceID } : {}),
    },
    body: JSON.stringify({ expected_version: appManifest.version }),
  })
  const payload = record(await response.json().catch(() => null))
  const requestId = response.headers.get('x-request-id') || undefined
  if (!response.ok) {
    throw new AppSdkError(
      typeof payload?.code === 'string' ? payload.code : 'APP_SESSION_EXCHANGE_FAILED',
      typeof payload?.message === 'string' ? payload.message : typeof payload?.error === 'string' ? payload.error : '无法获取本地开发应用会话。',
      requestId,
      response.status,
      payload,
    )
  }
  const session = record(payload?.data)
  const aliases = Array.isArray(session?.app_aliases) ? session.app_aliases : []
  if (!session
    || typeof session.session_id !== 'string'
    || typeof session.access_token !== 'string'
    || !session.access_token.startsWith('ast_')
    || typeof session.app_id !== 'string'
    || typeof session.app_slug !== 'string'
    || typeof session.app_version !== 'string'
    || session.app_version !== appManifest.version
    || !(session.app_id === appManifest.id || session.app_slug === appManifest.id || aliases.includes(appManifest.id))) {
    throw new AppSdkError('APP_SESSION_INVALID', '平台返回的本地开发会话无效。', requestId, 502)
  }
  return { ...session, gateway_url: '/v1' } as unknown as AppSession
}
const app = createAppClient(appManifest.id, {
  runtime: import.meta.env.DEV ? 'local' : electronHost ? 'electron' : 'direct',
  portalURL: import.meta.env.DEV ? (import.meta.env.VITE_PROXY_PORTAL_URL || 'https://www.duckingmind.com') : window.location.origin,
  appVersion: appManifest.version,
  ...(import.meta.env.DEV
    ? { refreshAppSession: exchangeDevelopmentAppSession }
    : !electronHost ? { refreshAppSession: exchangeAppSession } : {}),
  localDevelopment: import.meta.env.DEV,
  localAppVersion: appManifest.version,
})
const PROMPT = '创建一个HTML，内容是SVG绘制一个鹈鹕骑自行车的2D动画，你不需要任何测试创建一个HTML，内容是SVG绘制一个鹈鹕骑自行车的2D动画，你不需要任何测试'
const GALLERY_PREFIX = 'pelican/results/'
const GALLERY_PAGE_SIZE = 100
const GENERATION_TASK_STORAGE_KEYS = generationTaskStorageKeys(appManifest.id, appManifest.version)

type ReasoningLevel = { effort?: string; description?: string }
type Model = { id?: string; model?: string; slug?: string; name?: string; display_name?: string; type?: string; model_type?: string; modality?: string; default_reasoning_level?: string | null; supported_reasoning_levels?: ReasoningLevel[] }
type UserProfile = { id?: string; email?: string; username?: string; name?: string; avatar_url?: string }
type ErrorDetail = { message: string; requestId?: string; code?: string }
type Toast = ErrorDetail & { id: number; kind: 'error' | 'success' | 'info' }
type TaskPlaceholder = {
  phase: 'submitting' | 'checking' | 'queued' | 'running' | 'saving' | 'retrying' | 'canceling'
  message: string
  percent?: number
  runtime?: { elapsed_ms?: number; heartbeat_age_ms?: number; heartbeat_stale?: boolean }
}
type SelectOption = { value: string; label: string; description?: string }
type AppFunctionTask<T = unknown> = {
  id: string
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'canceled'
  progress?: { percent?: number; message?: string }
  runtime?: { phase?: string; platform_wait_phase?: string; elapsed_ms?: number; heartbeat_age_ms?: number; heartbeat_stale?: boolean; timeout_remaining_ms?: number; worker_assigned?: boolean; worker_responsive?: boolean; worker_ping_age_ms?: number; platform_request_active?: boolean; platform_request_duration_ms?: number; platform_status?: number; last_progress_age_ms?: number }
  result?: T
  error?: { code?: string; message?: string }
}
type GenerationTaskResult = { saved?: boolean; item_id?: string; model?: string; reasoning_effort?: string; request_id?: string }

const AUTH_ERROR_CODES = new Set(['APP_LOGIN_REQUIRED', 'APP_LOGIN_POPUP_BLOCKED', 'APP_LOGIN_TIMEOUT', 'APP_LOGIN_FAILED', 'APP_LOGIN_SESSION_EXPIRED', 'APP_LOGIN_TOKEN_INVALID', 'APP_LOGIN_STATE_INVALID', 'DEVICE_TOKEN_INVALID', 'insufficient_scope', 'APP_PERMISSION_DENIED'])
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
function newRequestId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  return `req_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`
}
async function requestTask<T = unknown>(suffix: string, init: RequestInit = {}): Promise<{ task: AppFunctionTask<T>; request_id?: string }> {
  return app.api.request(`/app-runtime/tasks${suffix}`, init)
}

function waitForTaskPoll(signal: AbortSignal, delayMs = 1200) {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) { reject(signal.reason); return }
    const timer = window.setTimeout(() => { signal.removeEventListener('abort', abort); resolve() }, delayMs)
    const abort = () => { window.clearTimeout(timer); reject(signal.reason || new DOMException('Aborted', 'AbortError')) }
    signal.addEventListener('abort', abort, { once: true })
  })
}

function taskTrackingStorage(): Storage | null {
  try { return typeof window === 'undefined' ? null : window.localStorage } catch { return null }
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

function GalleryTaskPlaceholder({ task, requestId, model }: { task: TaskPlaceholder; requestId?: string; model?: string }) {
  const labels: Record<TaskPlaceholder['phase'], string> = {
    submitting: '提交中', checking: '恢复任务中', queued: '排队中', running: '正在生成',
    saving: '载入结果中', retrying: '连接重试中', canceling: '正在取消',
  }
  return <article className="gallery-card gallery-task-card" aria-busy="true" aria-label={`动画任务${labels[task.phase]}`}>
    <div className={`gallery-preview task-preview task-preview-${task.phase}`}>
      <div className="task-preview-art" aria-hidden="true"><span/><span/><span/><Sparkles size={24}/></div>
      <div className="task-preview-status" role="status" aria-live="polite"><Loader2 size={16} className="spin"/><span>{labels[task.phase]}</span></div>
      <div className={`task-progress${task.percent === undefined ? ' is-indeterminate' : ''}`} role="progressbar" aria-label={task.message} aria-valuemin={0} aria-valuemax={100} {...(task.percent === undefined ? {} : { 'aria-valuenow': Math.round(task.percent) })}><span style={{ width: task.percent === undefined ? '36%' : `${Math.round(task.percent)}%` }}/></div>
    </div>
    <div className="gallery-meta task-meta"><strong>{task.message}</strong><span>{model ? `模型：${model}` : 'SVG 动画生成'}</span></div>
    {requestId && <div className="gallery-actions"><span className="request-id" title={requestId}>请求编号：{requestId}</span></div>}
  </article>
}

function errorDetail(error: unknown): ErrorDetail {
  const e = error as Partial<AppSdkError> & { message?: string }
  const message = e.code === 'APP_SESSION_UNAVAILABLE'
    ? import.meta.env.DEV
      ? '本地应用会话尚未准备好，请通过 proxy-app dev 启动后登录平台。'
      : '应用没有可用的 App Session，请确认已登录平台账户后重试。'
    : e.code === 'APP_SESSION_REFRESH_UNAVAILABLE'
      ? '本地应用会话已过期，请登录平台后重试。'
      : e.code === 'APP_DEVELOPMENT_APP_UNAVAILABLE'
        ? '当前开发环境未找到已登记的本地应用，请确认 Portal、Admin API 和 yarn dev 使用同一平台环境后重启开发服务。'
        : e.code === 'APP_DEVELOPMENT_GRANT_INVALID'
          ? '本地预览授权已失效，请重新运行 yarn dev 后再登录应用。'
        : e.code === 'APP_DEVELOPMENT_VERSION_NOT_FOUND'
          ? '平台尚未登记当前 manifest 版本。请停止并重新运行 yarn dev，让 CLI 重新登记本地开发版本。'
          : e.code === 'APP_SESSION_CSRF_REJECTED'
            ? 'Portal 与 Admin API 的本地地址不匹配，平台拒绝了换取应用会话的请求。请检查 PROXY_PORTAL_URL 和 Admin API 的 Portal 地址配置。'
      : e.code === 'DEVICE_TOKEN_INVALID' || e.code === 'APP_LOGIN_REQUIRED'
        ? '请登录平台账户后重试，登录成功后应用会自动获取新的会话。'
      : e.message || '请求失败，请检查平台连接和可用模型。'
  return { message, requestId: e.requestId, code: e.code }
}
function isSessionError(error: unknown) {
  const detail = errorDetail(error)
  return Boolean(detail.code && SESSION_ERROR_CODES.has(detail.code))
}
function formatDate(value: string) {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('zh-CN', { hour12: false })
}
function durationLabel(milliseconds?: number) {
  if (!Number.isFinite(milliseconds) || (milliseconds || 0) < 0) return ''
  const seconds = Math.floor((milliseconds || 0) / 1000)
  if (seconds < 60) return `${seconds} 秒`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes} 分钟`
  return `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分钟`
}
function runtimeActivity(task: AppFunctionTask<GenerationTaskResult>) {
  const runtime = task.runtime
  if (!runtime) return { message: task.progress?.message || '服务端正在运行；当前 Runtime 尚未提供心跳状态。' }
  const elapsed = durationLabel(runtime.elapsed_ms)
  const heartbeatAge = durationLabel(runtime.heartbeat_age_ms)
  const workerPingAge = durationLabel(runtime.worker_ping_age_ms)
  if (runtime.heartbeat_stale) return { message: `Runtime 心跳已延迟${heartbeatAge ? ` ${heartbeatAge}` : ''}；Gateway 仍将任务标记为运行中，暂时无法确认执行进程是否仍有响应。`, runtime }
  if (runtime.worker_assigned && runtime.worker_responsive === false) return { message: `Runtime Host 仍在上报，但执行 Worker 没有响应健康检测${workerPingAge ? `（最近 Worker 响应 ${workerPingAge} 前）` : ''}${elapsed ? `；已运行 ${elapsed}` : ''}。`, runtime }
  if (runtime.worker_assigned === false || runtime.phase === 'waiting_for_executor') return { message: `任务已进入 Runtime，正在等待执行 Worker 接手${elapsed ? `（已等待 ${elapsed}）` : '。'}`, runtime }
  if (runtime.phase === 'platform_request_waiting_for_headers') return { message: '正在等待模型服务响应。', runtime }
  if (runtime.phase === 'platform_response_body') return { message: `已收到响应，正在读取模型返回内容${elapsed ? `（已运行 ${elapsed}）` : ''}。`, runtime }
  return { message: task.progress?.message || `服务端正在运行，Runtime 心跳正常${elapsed ? `（已运行 ${elapsed}）` : ''}。`, runtime }
}
function validGalleryItem(value: unknown): value is GalleryItem {
  const item = record(value)
  // Author identity is supplied by shared KV metadata. Never accept the
  // client-provided userName/userId fields inside the stored value.
  return Boolean(item && typeof item.id === 'string' && typeof item.model === 'string' && typeof item.generatedAt === 'string' && typeof item.raw === 'string' && typeof item.html === 'string')
}
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
  const [status, setStatus] = useState<'loading' | 'ready' | 'submitting' | 'tracking' | 'canceling' | 'saving' | 'success' | 'error'>('loading')
  const [toast, setToast] = useState<Toast | null>(null)
  const toastTimerRef = useRef<number | null>(null)
  const [reload, setReload] = useState(0)
  const [sessionReady, setSessionReady] = useState(false)
  const [loggingIn, setLoggingIn] = useState(false)
  const [userName, setUserName] = useState('读取中…')
  const [userEmail, setUserEmail] = useState('')
  const [gallery, setGallery] = useState<GalleryItem[]>([])
  const [activeTask, setActiveTask] = useState(() => readStoredGenerationTask(taskTrackingStorage(), GENERATION_TASK_STORAGE_KEYS.activeTask))
  const [pendingSubmission, setPendingSubmission] = useState(() => readPendingGenerationSubmission(taskTrackingStorage(), GENERATION_TASK_STORAGE_KEYS.pendingSubmission))
  const [taskPlaceholder, setTaskPlaceholder] = useState<TaskPlaceholder | null>(() => activeTask
    ? { phase: 'checking', message: '正在恢复服务端任务…' }
    : pendingSubmission ? { phase: 'checking', message: '正在确认任务提交状态…' } : null)
  const activeTaskRef = useRef(activeTask)
  const pendingSubmissionRef = useRef(pendingSubmission)
  const activeTaskIdRef = useRef<string | null>(activeTask?.taskId || null)
  const currentUserIdRef = useRef('')
  const submissionInFlightRef = useRef<string | null>(null)
  const submissionAbortRef = useRef<AbortController | null>(null)

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
  const canInteractiveLogin = app.auth.loginMode === 'app' || (!import.meta.env.DEV && !electronHost)

  function saveActiveTask(value: typeof activeTask) {
    activeTaskRef.current = value
    activeTaskIdRef.current = value?.taskId || null
    writeStoredGenerationTask(taskTrackingStorage(), GENERATION_TASK_STORAGE_KEYS.activeTask, value)
    setActiveTask(value)
    if (!value && !pendingSubmissionRef.current) setTaskPlaceholder(null)
  }

  function savePendingSubmission(value: typeof pendingSubmission) {
    pendingSubmissionRef.current = value
    writePendingGenerationSubmission(taskTrackingStorage(), GENERATION_TASK_STORAGE_KEYS.pendingSubmission, value)
    setPendingSubmission(value)
    if (!value && !activeTaskRef.current) setTaskPlaceholder(null)
  }

  async function submitPendingGeneration(submission: NonNullable<typeof pendingSubmission>, recovering = false) {
    if (submissionInFlightRef.current === submission.requestId) return
    submissionInFlightRef.current = submission.requestId
    const controller = new AbortController()
    submissionAbortRef.current = controller
    setStatus('submitting')
    setTaskPlaceholder({ phase: 'submitting', message: recovering ? '正在安全恢复上次提交…' : '正在提交到服务端…' })
    try {
      const submitted = await requestTask<GenerationTaskResult>('', {
        method: 'POST',
        headers: { 'X-Request-ID': submission.requestId, 'Idempotency-Key': submission.requestId },
        body: JSON.stringify(submission.submission),
        signal: controller.signal,
      })
      const taskId = submitted.task?.id
      if (!taskId) throw Object.assign(new Error('Gateway 未返回任务编号。'), { code: 'APP_RUNTIME_INVALID_TASK' })
      saveActiveTask({ taskId, requestId: submission.requestId, ...(submission.userId ? { userId: submission.userId } : {}) })
      if (pendingSubmissionRef.current?.requestId === submission.requestId) savePendingSubmission(null)
      setStatus('tracking')
      setTaskPlaceholder({
        phase: submitted.task.status === 'queued' ? 'queued' : 'running',
        message: submitted.task.status === 'queued' ? '已提交，正在等待服务端开始…' : '服务端正在生成…',
      })
    } catch (cause) {
      if (controller.signal.aborted) return
      const error = cause as AppSdkError & { status?: number; statusCode?: number }
      const statusCode = error.statusCode || error.status
      const detail = errorDetail(cause)
      if (statusCode && statusCode >= 400 && statusCode < 500 && statusCode !== 408 && statusCode !== 429) {
        if (pendingSubmissionRef.current?.requestId === submission.requestId) savePendingSubmission(null)
        setStatus('error')
        showError({ ...detail, requestId: detail.requestId || submission.requestId })
        return
      }
      setStatus('error')
      setTaskPlaceholder({ phase: 'retrying', message: '暂时无法确认提交结果；可以重试提交。' })
      showToast({ message: `Gateway 暂未确认提交；重试会复用同一个幂等键：${detail.message}`, code: detail.code, requestId: detail.requestId || submission.requestId }, 'info')
    } finally {
      if (submissionInFlightRef.current === submission.requestId) submissionInFlightRef.current = null
      if (submissionAbortRef.current === controller) submissionAbortRef.current = null
    }
  }

  useEffect(() => () => {
    if (toastTimerRef.current !== null) window.clearTimeout(toastTimerRef.current)
    submissionAbortRef.current?.abort()
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
    setSessionReady(false)
    setStatus('loading')
    setUserName('读取中…')
    setUserEmail('')
    setGallery([])
    app.platform.createSession().then(async session => {
      if (session.app_version !== appManifest.version) {
        throw new AppSdkError('APP_SESSION_VERSION_MISMATCH', '应用版本已更新，请重新打开应用。')
      }
      const [modelsResult, profileResult, savedResult] = await Promise.allSettled([app.api.request('/models'), app.user.getProfile(), loadGallery()])
      if (!active) return
      const saved = savedResult.status === 'fulfilled' ? savedResult.value : { items: [], kvError: savedResult.reason }
      const profileReadFailed = profileResult.status === 'rejected'
      const profileSessionFailed = profileReadFailed && isSessionError(profileResult.reason)
      const profile = profileResult.status === 'fulfilled' ? profileResult.value as UserProfile : null
      currentUserIdRef.current = typeof profile?.id === 'string' ? profile.id : ''
      setSessionReady(true)
      // A missing/unsupported profile route does not invalidate the App
      // Session. Gallery entries still come only from the authenticated KV
      // API; clear them only when authentication itself failed.
      setGallery(profileSessionFailed ? [] : saved.items)
      if (saved.kvError) {
        showToast(storageReadToast(saved.kvError), 'error')
      }
      if (pendingSubmissionRef.current && profile?.id && pendingSubmissionRef.current.userId !== profile.id) {
        savePendingSubmission(null)
        showToast({ message: '已清除其他账户未确认的任务提交，请重新发起。' }, 'info')
      }
      if (activeTaskRef.current && profile?.id && activeTaskRef.current.userId && activeTaskRef.current.userId !== profile.id) {
        saveActiveTask(null)
        showToast({ message: '当前账户与保存的任务账户不同，已停止恢复该任务跟踪。' }, 'info')
      }
      const profileName = profile?.name || profile?.username || profile?.id || profile?.email
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
      setStatus(activeTaskIdRef.current ? 'tracking' : available.length ? 'ready' : 'error')
      if (!available.length) showError({ message: '平台已连接，但没有可用的文本模型。' })
    }).catch(cause => { if (active) { setUserName('登录信息不可用'); setUserEmail(''); setStatus('error'); showError(cause) } })
    return () => { active = false }
  }, [reload])

  useEffect(() => {
    if (!sessionReady || !activeTask) return
    if (activeTask.userId && currentUserIdRef.current && activeTask.userId !== currentUserIdRef.current) return
    const controller = new AbortController()
    let active = true

    const track = async () => {
      let retryDelay = 1200
      setStatus('tracking')
      setTaskPlaceholder(current => current || { phase: 'checking', message: '正在查询服务端任务…' })

      while (active && !controller.signal.aborted) {
        try {
          const response = await requestTask<GenerationTaskResult>(`/${encodeURIComponent(activeTask.taskId)}`, { signal: controller.signal })
          const task = response.task
          if (task.status === 'queued' || task.status === 'running') {
            const progress = task.progress
            const activity = task.status === 'running' ? runtimeActivity(task) : null
            setTaskPlaceholder({
              phase: task.status,
              message: activity?.message || progress?.message || (task.status === 'queued' ? '正在等待服务端开始…' : '服务端正在生成…'),
              ...(typeof progress?.percent === 'number' && Number.isFinite(progress.percent) ? { percent: Math.max(0, Math.min(100, progress.percent)) } : {}),
              ...(activity?.runtime ? { runtime: { elapsed_ms: activity.runtime.elapsed_ms, heartbeat_age_ms: activity.runtime.heartbeat_age_ms, heartbeat_stale: activity.runtime.heartbeat_stale } } : {}),
            })
            retryDelay = 1200
            await waitForTaskPoll(controller.signal, retryDelay)
            continue
          }

          if (task.status === 'canceled') {
            if (activeTaskIdRef.current === activeTask.taskId) {
              saveActiveTask(null)
              setStatus('ready')
              showToast({ message: 'Gateway 任务已取消。', requestId: activeTask.requestId }, 'info')
            }
            return
          }
          if (task.status === 'failed') {
            if (activeTaskIdRef.current === activeTask.taskId) {
              saveActiveTask(null)
              setStatus('error')
              showError({ message: task.error?.message || 'Gateway 任务执行失败。', code: task.error?.code || 'TASK_FAILED', requestId: activeTask.requestId })
            }
            return
          }

          const completedResult = task.result
          if (!completedResult?.saved) {
            if (activeTaskIdRef.current === activeTask.taskId) {
              saveActiveTask(null)
              setStatus('error')
              showError({ message: 'Gateway 任务没有确认画廊结果。', code: 'APP_RUNTIME_EMPTY_RESULT', requestId: activeTask.requestId })
            }
            return
          }

          setStatus('saving')
          setTaskPlaceholder({ phase: 'saving', message: '生成完成，正在载入结果…', percent: 100 })
          const itemId = completedResult.item_id || activeTask.taskId
          try {
            const savedEntry = await app.sharedStorage.getEntry<GalleryItem>(`${GALLERY_PREFIX}${itemId}`)
            if (!active || activeTaskIdRef.current !== activeTask.taskId) return
            if (savedEntry?.value && validGalleryItem(savedEntry.value)) {
              const savedItem: GalleryItem = {
                ...savedEntry.value,
                userId: savedEntry.author?.id,
                userName: normalizeStoredUserName(savedEntry.author?.name || '未知用户'),
              }
              setGallery(current => mergeGalleryItems([savedItem], current))
              setStatus('success')
              showToast({ message: '服务端生成完成，结果已保存。', requestId: completedResult.request_id || activeTask.requestId }, 'success')
            } else {
              setStatus('success')
              showToast({ message: '任务已完成并保存，但共享画廊暂时无法读取结果。刷新页面后重试。', requestId: completedResult.request_id || activeTask.requestId }, 'info')
            }
          } catch (cause) {
            if (!active || activeTaskIdRef.current !== activeTask.taskId) return
            const detail = errorDetail(cause)
            setStatus('success')
            showToast({ message: `任务已完成，结果已保存；暂时无法刷新画廊：${detail.message}`, code: detail.code, requestId: detail.requestId || completedResult.request_id || activeTask.requestId }, 'info')
          }
          if (activeTaskIdRef.current === activeTask.taskId) saveActiveTask(null)
          return
        } catch (cause) {
          if (!active || controller.signal.aborted) return
          const error = cause as AppSdkError & { status?: number; statusCode?: number }
          const detail = errorDetail(cause)
          if (detail.code === 'TASK_NOT_FOUND' || error.statusCode === 404 || error.status === 404) {
            if (activeTaskIdRef.current === activeTask.taskId) {
              saveActiveTask(null)
              setStatus('error')
              showError({ ...detail, message: 'Gateway 中已找不到此任务；请重新提交生成。', requestId: detail.requestId || activeTask.requestId })
            }
            return
          }
          setTaskPlaceholder({ phase: 'retrying', message: '任务仍在服务端运行；正在重试连接…' })
          try {
            await waitForTaskPoll(controller.signal, retryDelay)
          } catch {
            return
          }
          retryDelay = Math.min(retryDelay * 2, 10_000)
        }
      }
    }

    void track()
    return () => {
      active = false
      controller.abort()
    }
  }, [activeTask, sessionReady])

  useEffect(() => {
    if (!sessionReady || !pendingSubmission) return
    if (!currentUserIdRef.current) {
      setStatus('error')
      showToast({ message: '有一条未确认的任务提交；读取当前账户身份后才能安全恢复，请重新登录后重试。', requestId: pendingSubmission.requestId }, 'error', true)
      return
    }
    if (pendingSubmission.userId !== currentUserIdRef.current) {
      savePendingSubmission(null)
      showToast({ message: '已清除其他账户未确认的任务提交，请重新发起。' }, 'info')
      return
    }
    if (activeTask?.requestId === pendingSubmission.requestId) {
      savePendingSubmission(null)
      return
    }
    void submitPendingGeneration(pendingSubmission, true)
  }, [sessionReady, pendingSubmission, activeTask])

  async function cancelGeneration() {
    const current = activeTask
    if (!current) return
    setStatus('canceling')
    setTaskPlaceholder({ phase: 'canceling', message: '正在请求取消任务…' })
    try {
      const response = await requestTask(`/${encodeURIComponent(current.taskId)}/cancel`, { method: 'POST' })
      if (response.task.status === 'canceled') {
        saveActiveTask(null)
        setStatus('ready')
        showToast({ message: 'Gateway 已确认任务取消。', requestId: current.requestId }, 'info')
        return
      }
      setStatus('tracking')
      setTaskPlaceholder({ phase: 'running', message: '任务仍在执行，正在同步最新状态…' })
      showToast({ message: '任务已进入其他终态，正在同步最终结果。', requestId: current.requestId }, 'info', true)
    } catch (cause) {
      setStatus('tracking')
      setTaskPlaceholder({ phase: 'running', message: '暂时无法确认取消；仍在跟踪服务端任务…' })
      const detail = errorDetail(cause)
      showToast({ message: `暂时无法确认取消结果，仍在跟踪 Gateway 任务：${detail.message}`, code: detail.code, requestId: detail.requestId || current.requestId }, 'info', true)
    }
  }

  async function generate() {
    if (!selectedModel) { showError({ message: '请先选择一个文本模型。' }); setStatus('error'); return }
    if (userName === '登录信息不可用' || userName === '读取中…') { showError({ message: '未获取到当前登录用户，请重新登录平台后再生成。' }); setStatus('error'); return }
    if (activeTaskIdRef.current) return
    const userId = currentUserIdRef.current
    if (pendingSubmission && !userId) {
      showError({ message: '无法确认当前账户，暂不能安全恢复上次未确认的任务提交。' })
      setStatus('error')
      return
    }
    if (pendingSubmission && pendingSubmission.userId !== userId) savePendingSubmission(null)
    const submission = pendingSubmission?.userId === userId
      ? pendingSubmission
      : (() => {
          const requestId = newRequestId()
          return {
            requestId,
            userId,
            submission: generationTaskSubmission(
              selectedModel,
              models.find(item => modelId(item) === selectedModel)?.display_name || models.find(item => modelId(item) === selectedModel)?.name || selectedModel,
              selectedReasoning || defaultReasoningLevel(models.find(item => modelId(item) === selectedModel)),
              requestId,
            ),
          }
        })()
    if (userId) savePendingSubmission(submission)
    dismissToast()
    void submitPendingGeneration(submission, Boolean(pendingSubmission?.userId === userId))
  }
  async function loginPlatform() {
    setLoggingIn(true); setStatus('loading'); setGallery([]); dismissToast()
    try { await app.auth.login(); showToast({ message: '平台登录成功，正在刷新模型。' }, 'success'); setReload(value => value + 1) } catch (cause) { setStatus('error'); showError(cause) } finally { setLoggingIn(false) }
  }
  const taskModelId = pendingSubmission?.submission.payload.model || selectedModel
  const taskModelName = pendingSubmission?.submission.payload.model_name
    || models.find(item => modelId(item) === taskModelId)?.display_name
    || models.find(item => modelId(item) === taskModelId)?.name
    || taskModelId
  const taskRequestId = activeTask?.requestId || pendingSubmission?.requestId
  return <div className="app-shell">
    {toast && <div className={`toast toast-${toast.kind}`} role={toast.kind === 'error' ? 'alert' : 'status'} aria-live={toast.kind === 'error' ? 'assertive' : 'polite'}><div className="toast-icon">{toast.kind === 'error' ? <AlertCircle size={17}/> : toast.kind === 'success' ? <CheckCircle2 size={17}/> : <Info size={17}/>}</div><div className="toast-copy"><strong>{toast.message}</strong>{toast.requestId && <small>请求编号：{toast.requestId}</small>}{toast.code && <small>错误代码：{toast.code}</small>}</div>{canInteractiveLogin && toast.code && AUTH_ERROR_CODES.has(toast.code) && <button className="login-button" onClick={loginPlatform} disabled={loggingIn}>{loggingIn ? <><Loader2 size={15} className="spin"/>授权中</> : '登录平台'}</button>}<button className="toast-close" onClick={dismissToast} aria-label="关闭提示"><X size={15}/></button></div>}
    <header className="topbar"><div className="brand"><span className="brand-mark"><Feather size={20}/></span><div><strong>Pelican Probe</strong><small>LLM-GATEWAY OBSERVER</small></div></div><div className="account-chip" title="当前登录平台账户"><span className="account-avatar">{userName.slice(0, 1).toUpperCase()}</span><span className="account-chip-copy"><strong>{userName}</strong><small>{userEmail || '当前平台账户'}</small></span></div></header>
    <main className="main">
      <section className="intro"><div><span className="eyebrow">PELICAN / HTML / SVG</span><h1>生成结果</h1></div></section>
      <section className="control-panel compact-control">
        <div className="control-row">
          <label className="model-select"><span>选择模型</span><AppSelect value={selectedModel} options={models.map(item => ({ value: modelId(item), label: item.display_name || item.name || modelId(item), description: modelId(item) }))} onChange={value => { const next = models.find(item => modelId(item) === value); setSelectedModel(value); setSelectedReasoning(defaultReasoningLevel(next)); dismissToast() }} disabled={!models.length || ['submitting', 'tracking', 'canceling', 'saving', 'loading'].includes(status) || loggingIn} placeholder={status === 'loading' ? '正在读取模型…' : models.length ? '请选择文本模型' : '暂无可用模型'} ariaLabel="选择模型" /></label>
          {reasoningLevels(models.find(item => modelId(item) === selectedModel)).length > 0 && <label className="model-select model-strength"><span>思考强度</span><AppSelect value={selectedReasoning} options={reasoningLevels(models.find(item => modelId(item) === selectedModel)).map(level => ({ value: level, label: reasoningLabel(level), description: level }))} onChange={value => { setSelectedReasoning(value); dismissToast() }} disabled={['submitting', 'tracking', 'canceling', 'saving', 'loading'].includes(status) || loggingIn} placeholder="选择思考强度" ariaLabel="思考强度" /></label>}
          <button className={`generate-button ${status === 'error' ? 'retry' : ''} ${activeTask ? 'cancel' : ''}`} onClick={activeTask ? cancelGeneration : status === 'error' && !selectedModel ? () => setReload(value => value + 1) : generate} disabled={status === 'loading' || status === 'submitting' || status === 'canceling' || status === 'saving' || loggingIn || (!activeTask && status !== 'error' && !selectedModel)} title={activeTask ? '请求 Gateway 取消当前任务' : selectedModel ? `使用 ${selectedModel} 生成` : '请选择模型'}>
            {status === 'loading' ? <><Loader2 size={17} className="spin"/>连接中</> : status === 'submitting' ? <><Loader2 size={17} className="spin"/>提交中</> : activeTask ? <><X size={17}/>取消任务</> : status === 'saving' ? <><Loader2 size={17} className="spin"/>保存中</> : status === 'error' && !selectedModel ? <><RefreshCw size={17}/>重试连接</> : <><Send size={17}/>生成动画</>}
          </button>
        </div>
      </section>
      <section className="gallery-section"><div className="gallery-heading"><div><span className="eyebrow">HTML / SVG</span><h2>生成结果</h2></div><span className="gallery-count">{gallery.length} 条</span></div>{gallery.length || taskPlaceholder ? <div className="gallery-grid">
        {taskPlaceholder && <GalleryTaskPlaceholder task={taskPlaceholder} requestId={taskRequestId} model={taskModelName} />}
        {gallery.map(item => {
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
      <footer><CheckCircle2 size={14}/> 模型生成由服务端任务执行；完成后结果会保存到共享画廊。<span className="runtime-mode">执行位置：Gateway → Runtime Host</span></footer>
    </main>
  </div>
}
