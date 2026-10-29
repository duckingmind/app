import { AppSdkError } from './types.js'
import { agent } from './agent.js'
import type { AppRuntimeRequestInit, AppRuntimeStreamEvent } from './types.js'
export { uploadApplicationMediaAsset, MAX_APPLICATION_MEDIA_ASSET_BYTES } from './media-assets.js'
export type { ApplicationMediaAssetApi, ApplicationMediaAssetUploadInput } from './media-assets.js'
export type {
  AppHandler,
  AppFunctionsManifest,
  AppRequestFunctionManifest,
  AppRuntimeContext,
  AppRuntimeUser,
  AppTask,
  AppTaskContext,
  AppTaskFunction,
  AppTaskFunctionManifest,
} from './runtime.js'
export { agent, createAgentBridge, dispatchAgentInvocation } from './agent.js'
export type { AgentAccess, AgentTarget, AgentEnvironment, AgentBridge, AgentCapabilityDeclaration, AgentContractMetadata, AgentCapabilityRegistration, AgentRuntimeCapabilityRegistration, AgentHandler, AgentInvocationContext, AgentRuntimeRegistration, AgentRuntimeStatus, AgentNextAction } from './agent.js'
import type { AppApiRequestInit, AppApiResponseType, AppApiStreamEvent, AppAuthStatus, AppClientOptions, AppProfile, AppSession, ElectronHostBridge, LocalLoginOptions, StorageBatchOperation, StorageEntry, StorageEntryAuthor, StorageListOptions, StorageListResult, StorageOperationOptions, StorageWriteOptions, WorkspaceStorage } from './types.js'
export { AppSdkError }
export type { AppApiRequestInit, AppApiResponseType, AppApiStreamEvent, AppAuthStatus, AppClientOptions, AppProfile, AppRuntimeRequestInit, AppRuntimeStreamEvent, AppSession, ElectronHostBridge, LocalLoginOptions, StorageBatchOperation, StorageEntry, StorageEntryAuthor, StorageListOptions, StorageListResult, StorageOperationOptions, StorageWriteOptions, WorkspaceStorage } from './types.js'

const PLATFORM_APP_ID_PATTERN = /^app_[a-z0-9][a-z0-9._-]{2,119}$/
const PUBLIC_APP_SLUG_PATTERN = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/
const validPublicAppSlug = (value: unknown): value is string =>
  typeof value === 'string' && value.length <= 120 && value === value.trim() && PUBLIC_APP_SLUG_PATTERN.test(value)
const APP_SESSION_DEFAULT_TTL_SECONDS = 30 * 24 * 60 * 60
const GATEWAY_SESSION_STORAGE_PREFIX = 'proxy-app:gateway-session:'
const APP_TASK_ID_PATTERN = '[A-Za-z0-9][A-Za-z0-9._:-]{0,127}'
const APP_API_ROUTES: Array<{ method: string; pattern: RegExp }> = [
  // Server-side application functions. The Gateway binds app/version/user
  // identity from the App Session; the browser supplies only the function
  // path or task payload.
  { method: 'POST', pattern: /^\/app-runtime\/request$/ },
  { method: 'POST', pattern: /^\/app-runtime\/tasks$/ },
  { method: 'GET', pattern: new RegExp(`^\\/app-runtime\\/tasks\\/${APP_TASK_ID_PATTERN}$`) },
  { method: 'POST', pattern: new RegExp(`^\\/app-runtime\\/tasks\\/${APP_TASK_ID_PATTERN}\\/cancel$`) },
  { method: 'GET', pattern: /^\/storage\/items$/ },
  { method: 'PUT', pattern: /^\/storage\/items$/ },
  { method: 'DELETE', pattern: /^\/storage\/items$/ },
  { method: 'GET', pattern: /^\/storage\/keys$/ },
  { method: 'POST', pattern: /^\/storage\/batch$/ },
  { method: 'GET', pattern: /^\/storage\/shared\/items$/ },
  { method: 'PUT', pattern: /^\/storage\/shared\/items$/ },
  { method: 'DELETE', pattern: /^\/storage\/shared\/items$/ },
  { method: 'GET', pattern: /^\/storage\/shared\/keys$/ },
  { method: 'POST', pattern: /^\/storage\/shared\/batch$/ },
  { method: 'GET', pattern: /^\/storage\/workspace\/items$/ },
  { method: 'PUT', pattern: /^\/storage\/workspace\/items$/ },
  { method: 'DELETE', pattern: /^\/storage\/workspace\/items$/ },
  { method: 'GET', pattern: /^\/storage\/workspace\/keys$/ },
  { method: 'POST', pattern: /^\/storage\/workspace\/batch$/ },
  { method: 'GET', pattern: /^\/models$/ },
  { method: 'GET', pattern: /^\/images\/models$/ },
  { method: 'GET', pattern: /^\/media\/storage\/usage$/ },
  { method: 'GET', pattern: /^\/media\/assets$/ },
  { method: 'POST', pattern: /^\/media\/assets\/upload-intents$/ },
  { method: 'GET', pattern: new RegExp(`^\\/media\\/assets\\/${APP_TASK_ID_PATTERN}$`) },
  { method: 'PATCH', pattern: new RegExp(`^\\/media\\/assets\\/${APP_TASK_ID_PATTERN}$`) },
  { method: 'DELETE', pattern: new RegExp(`^\\/media\\/assets\\/${APP_TASK_ID_PATTERN}$`) },
  { method: 'POST', pattern: new RegExp(`^\\/media\\/assets\\/${APP_TASK_ID_PATTERN}\\/complete$`) },
  { method: 'DELETE', pattern: new RegExp(`^\\/media\\/assets\\/${APP_TASK_ID_PATTERN}\\/upload-intent$`) },
  { method: 'GET', pattern: /^\/videos\/models$/ },
  { method: 'GET', pattern: /^\/music\/models$/ },
  { method: 'GET', pattern: /^\/voice-design\/models$/ },
  { method: 'POST', pattern: /^\/responses$/ },
  { method: 'POST', pattern: /^\/responses\/compact$/ },
  { method: 'POST', pattern: /^\/responses\/stream$/ },
  { method: 'POST', pattern: /^\/chat\/completions$/ },
  { method: 'POST', pattern: /^\/estimates$/ },
  { method: 'POST', pattern: /^\/messages$/ },
  { method: 'POST', pattern: /^\/messages\/count_tokens$/ },
  { method: 'POST', pattern: /^\/images\/generations$/ },
  { method: 'POST', pattern: /^\/images\/edits$/ },
  { method: 'GET', pattern: new RegExp(`^\/images\/by-idempotency-key\/${APP_TASK_ID_PATTERN}$`) },
  { method: 'GET', pattern: new RegExp(`^\\/images\\/tasks\\/${APP_TASK_ID_PATTERN}$`) },
  { method: 'POST', pattern: /^\/videos$/ },
  { method: 'GET', pattern: new RegExp(`^/videos/by-idempotency-key/${APP_TASK_ID_PATTERN}$`) },
  { method: 'GET', pattern: new RegExp(`^\\/videos\\/${APP_TASK_ID_PATTERN}$`) },
  { method: 'DELETE', pattern: new RegExp(`^\\/videos\\/${APP_TASK_ID_PATTERN}$`) },
  { method: 'POST', pattern: /^\/music\/generations$/ },
  { method: 'GET', pattern: new RegExp(`^/music/by-idempotency-key/${APP_TASK_ID_PATTERN}$`) },
  { method: 'GET', pattern: new RegExp(`^\\/music\\/tasks\\/${APP_TASK_ID_PATTERN}$`) },
  { method: 'DELETE', pattern: new RegExp(`^\\/music\\/tasks\\/${APP_TASK_ID_PATTERN}$`) },
  { method: 'POST', pattern: /^\/voice-design\/generations$/ },
  { method: 'GET', pattern: new RegExp(`^\\/voice-design\\/by-idempotency-key\\/${APP_TASK_ID_PATTERN}$`) },
  { method: 'GET', pattern: new RegExp(`^\\/voice-design\\/tasks\\/${APP_TASK_ID_PATTERN}$`) },
  { method: 'DELETE', pattern: new RegExp(`^\\/voice-design\\/tasks\\/${APP_TASK_ID_PATTERN}$`) },
]
const APP_STREAM_ROUTES = [
  { method: 'POST', pattern: /^\/app-runtime\/request$/ },
  { method: 'POST', pattern: /^\/responses\/stream$/ },
  { method: 'POST', pattern: /^\/chat\/completions$/ },
  { method: 'POST', pattern: /^\/messages$/ },
]
const STORAGE_METHODS = new Set([
  'storage.user.get',
  'storage.user.get_entry',
  'storage.user.get_many',
  'storage.user.list',
  'storage.user.batch',
  'storage.user.set',
  'storage.user.delete',
  // Shared application storage is an application-owned namespace. The
  // namespace is selected by the Gateway from the App Session; callers never
  // send a scope, user id, or application id.
  'storage.shared.get',
  'storage.shared.get_entry',
  'storage.shared.get_many',
  'storage.shared.list',
  'storage.shared.batch',
  'storage.shared.set',
  'storage.shared.delete',
  // Workspace storage is bound by the platform to the active workspace in
  // the App Session. Callers never select or submit a workspace id.
  'storage.workspace.get',
  'storage.workspace.get_entry',
  'storage.workspace.get_many',
  'storage.workspace.list',
  'storage.workspace.batch',
  'storage.workspace.set',
  'storage.workspace.delete',
])
// These methods are local host services and never map to an HTTP route. Keep
// this list explicit so a session cannot grant a Gateway route by echoing it
// in `host_capabilities`.
const GATEWAY_ONLY_HOST_METHODS = new Set(['media.image.readCached'])
const DIRECT_HTTP_METHODS = new Set(['user.profile.read'])
const LOCAL_HTTP_METHODS = new Set(['user.profile.read'])
function isStorageMethod(method: string) {
  return STORAGE_METHODS.has(method)
}

function isLoopbackHostname(hostname: string) {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, '')
  return normalized === 'localhost' || normalized === '::1' || /^127(?:\.\d{1,3}){3}$/.test(normalized)
}

// The App Session data plane is the public LLM Gateway. These host labels are
// the Portal/Admin control plane in the deployed product; accepting one here
// would send a user-bound bearer to an Admin endpoint merely because it uses a
// canonical-looking `/v1` path.
function isControlPlaneHostname(hostname: string) {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '')
  return /(?:^|[.-])(?:admin|admin-api|admin-go|codex-admin-api|portal|www)(?:[.-]|$)/.test(normalized)
}

function gatewayBaseIsAllowed(value: string, allowRelative = false) {
  try {
    if (typeof value !== 'string' || value.length === 0 || value !== value.trim() || /[\\?#]/.test(value)) return false

    const absolute = /^[a-z][a-z\d+.-]*:\/\//i.test(value)
    if (!absolute && (!value.startsWith('/') || value.startsWith('//'))) return false

    // Retain the source pathname as well as URL.pathname: URL normalizes dot
    // segments, while this boundary accepts only the canonical literal paths.
    const rawPathname = absolute
      ? (() => {
          const authorityStart = value.indexOf('://') + 3
          const pathStart = value.indexOf('/', authorityStart)
          return pathStart < 0 ? '' : value.slice(pathStart)
        })()
      : value
    const origin = typeof window !== 'undefined' && /^https?:\/\//i.test(window.location.origin)
      ? window.location.origin
      : 'https://proxy-app.invalid'
    const parsed = absolute ? new URL(value) : new URL(value, origin)
    if (parsed.username || parsed.password || !['https:', 'http:'].includes(parsed.protocol)) return false
    if (rawPathname !== parsed.pathname) return false
    const loopback = isLoopbackHostname(parsed.hostname)
    if (isControlPlaneHostname(parsed.hostname)) return false
    // Plain HTTP is reserved for a loopback Gateway in local development. A production
    // Gateway URL must be HTTPS even when its path is otherwise canonical.
    if (absolute && parsed.protocol === 'http:' && !loopback) return false

    if (parsed.pathname === '/v1') return absolute || loopback || allowRelative
    return false
  } catch {
    return false
  }
}

/**
 * Read the user-bound Gateway App Session previously returned by Portal login.
 *
 * This value stays scoped to the current browser tab and is deliberately
 * different from the Portal login token. Applications use it only to call
 * the public Gateway data plane; a missing or malformed session fails closed
 * and never triggers a request to the Admin runtime.
 */
export function readAppSessionFromStorage(appId: string, allowRelativeGateway = false): AppSession | undefined {
  if (typeof appId !== 'string' || !appId.trim() || typeof sessionStorage === 'undefined') return undefined
  const storageKey = (identity: string) => `${GATEWAY_SESSION_STORAGE_PREFIX}${encodeURIComponent(identity)}`
  const isSession = (value: unknown): value is AppSession => {
    if (!isRecord(value)) return false
    const record = value as Partial<AppSession>
    return typeof record.access_token === 'string'
      && record.access_token.startsWith('ast_')
      && typeof record.gateway_url === 'string'
      && gatewayBaseIsAllowed(record.gateway_url, allowRelativeGateway)
      && typeof record.app_id === 'string'
      && record.app_id.trim().length > 0
      && typeof record.app_slug === 'string'
      && record.app_slug.trim().length > 0
      && typeof record.app_version === 'string'
      && record.app_version.trim().length > 0
      && typeof record.expires_in === 'number'
      && Number.isFinite(record.expires_in)
      && record.expires_in > 0
      && Array.isArray(record.scopes)
      && record.scopes.every((scope) => typeof scope === 'string')
      && (record.app_aliases === undefined || (Array.isArray(record.app_aliases) && record.app_aliases.every((alias) => typeof alias === 'string')))
      && (record.app_id === appId || record.app_slug === appId || record.app_aliases?.includes(appId) === true)
  }
  try {
    const candidates = new Set<string>([storageKey(appId)])
    for (let index = 0; index < sessionStorage.length; index += 1) {
      const key = sessionStorage.key(index)
      if (key?.startsWith(GATEWAY_SESSION_STORAGE_PREFIX)) candidates.add(key)
    }
    for (const key of candidates) {
      const raw = sessionStorage.getItem(key)
      if (!raw) continue
      let value: unknown
      try { value = JSON.parse(raw) } catch { continue }
      if (isSession(value)) return value
    }
  } catch {
    // Disabled or partitioned storage is equivalent to a missing App Session.
  }
  return undefined
}

function appRequestPath(rawPath: string) {
  if (typeof rawPath !== 'string' || !rawPath.startsWith('/') || rawPath.startsWith('//') || rawPath.includes('\\')) return null
  const queryStart = rawPath.search(/[?#]/)
  const rawPathname = queryStart >= 0 ? rawPath.slice(0, queryStart) : rawPath
  if (!rawPathname || rawPathname.split('/').some((part) => part === '.' || part === '..')) return null
  try {
    const parsed = new URL(rawPath, 'https://proxy-app.invalid')
    if (parsed.origin !== 'https://proxy-app.invalid' || parsed.hash) return null
    return parsed.pathname
  } catch {
    return null
  }
}

function isAllowedAppRoute(rawPath: string, method: string, streaming = false) {
  const pathname = appRequestPath(rawPath)
  if (!pathname) return false
  if (pathname.startsWith('/storage/')) {
    try {
      const params = new URL(rawPath, 'https://proxy-app.invalid').searchParams
      for (const field of ['scope', 'namespace', 'storage_scope', 'storage_namespace', 'owner_id', 'owner_type', 'user_id', 'app_id', 'workspace_id', 'workspaceId']) {
        if (params.has(field)) return false
      }
    } catch { return false }
  }
  const routes = streaming ? APP_STREAM_ROUTES : APP_API_ROUTES
  const normalizedMethod = (method || 'GET').toUpperCase()
  return routes.some((route) => route.method === normalizedMethod && route.pattern.test(pathname))
}

function assertStorageScopeFreeRequest(rawPath: string, init: RequestInit) {
  const pathname = appRequestPath(rawPath)
  if (!pathname?.startsWith('/storage/')) return
  const headers = new Headers(init.headers)
  if (headers.has('x-workspace-id')) {
    throw createSdkError('APP_STORAGE_INVALID_REQUEST', 'Workspace selection is controlled by the platform')
  }
  if (typeof init.body !== 'string') return
  let value: unknown
  try { value = JSON.parse(init.body) } catch { return }
  const forbidden = ['scope', 'namespace', 'storage_scope', 'storage_namespace', 'owner_id', 'owner_type', 'user_id', 'app_id', 'workspace_id', 'workspaceId']
  const assertRecord = (candidate: unknown) => {
    if (!isRecord(candidate)) return
    if (forbidden.some(field => Object.prototype.hasOwnProperty.call(candidate, field))) {
      const field = forbidden.find(name => Object.prototype.hasOwnProperty.call(candidate, name))!
      throw createSdkError('APP_STORAGE_INVALID_REQUEST', `${field} is controlled by the platform`)
    }
  }
  assertRecord(value)
  if (isRecord(value) && Array.isArray(value.operations)) value.operations.forEach(assertRecord)
}

function generateRequestId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return `req_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`
}

function createSdkError(code: string, message: string, requestId?: string, status?: number, details?: unknown) {
  const error = new AppSdkError(code, sanitizeApiErrorMessage(message), requestId, status, details)
  return error
}

function isStoredSessionExpired(session: AppSession) {
  try {
    const payload = session.access_token.replace(/^ast_/, '').split('.')[1]
    if (!payload) return false
    const encoded = payload.replace(/-/g, '+').replace(/_/g, '/')
    const claims = JSON.parse(atob(encoded + '='.repeat((4 - encoded.length % 4) % 4)))
    return typeof claims.exp === 'number' && claims.exp * 1000 <= Date.now()
  } catch {
    return false
  }
}

function storedSessionExpiresAt(session: AppSession) {
  try {
    const payload = session.access_token.replace(/^ast_/, '').split('.')[1]
    if (payload) {
      const encoded = payload.replace(/-/g, '+').replace(/_/g, '/')
      const claims = JSON.parse(atob(encoded + '='.repeat((4 - encoded.length % 4) % 4)))
      if (typeof claims.exp === 'number') return claims.exp * 1000
    }
  } catch { /* Fall back to the server's relative lifetime. */ }
  return Date.now() + session.expires_in * 1000
}

async function loadLocalDevelopmentAppSession(appId: string, appVersion: string): Promise<AppSession> {
  const session = readAppSessionFromStorage(appId, true)
  if (!session || session.app_version !== appVersion || isStoredSessionExpired(session)) throw createSdkError('APP_LOGIN_REQUIRED', '请先登录平台账户', undefined, 401)
  return { ...session, gateway_url: '/v1' }
}

function isAppSessionFor(value: unknown, appId: string): value is AppSession {
  if (!isRecord(value) || typeof value.access_token !== 'string' || !value.access_token.startsWith('ast_')
    || typeof value.gateway_url !== 'string' || typeof value.expires_in !== 'number' || value.expires_in <= 0
    || typeof value.app_id !== 'string' || typeof value.app_slug !== 'string') return false
  return value.app_id === appId || value.app_slug === appId
    || (Array.isArray(value.app_aliases) && value.app_aliases.includes(appId))
}

async function openLocalDevelopmentLogin(appId: string, appVersion: string, portalURL: string, forceLogin = false): Promise<AppSession> {
  if (typeof window === 'undefined' || typeof window.open !== 'function') {
    throw createSdkError('APP_LOGIN_UNAVAILABLE', '本地登录需要在浏览器中打开。')
  }
  let portal: URL
  try {
    portal = new URL(portalURL)
  } catch {
    throw createSdkError('APP_LOGIN_UNAVAILABLE', '本地 Portal 地址无效，请检查开发环境配置。')
  }
  if (!['http:', 'https:'].includes(portal.protocol) || portal.username || portal.password || portal.search || portal.hash
    || (portal.pathname !== '/' && portal.pathname !== '')) {
    throw createSdkError('APP_LOGIN_UNAVAILABLE', '本地 Portal 地址无效，请检查开发环境配置。')
  }
  const appOrigin = window.location.origin
  if (!['http:', 'https:'].includes(window.location.protocol) || !appOrigin) {
    throw createSdkError('APP_LOGIN_UNAVAILABLE', '本地登录需要通过 HTTP 浏览器页面打开。')
  }
  const authState = generateRequestId()
  // Open synchronously during the user's click. Fetching the Portal URL first
  // would lose transient browser activation and cause popup blockers to reject it.
  const popup = window.open('about:blank', 'proxy-app-login', 'popup,width=520,height=720')
  if (!popup) throw createSdkError('APP_LOGIN_POPUP_BLOCKED', '浏览器阻止了登录窗口，请允许弹窗后重试。')

  const requestId = generateRequestId()
  let timer: ReturnType<typeof setTimeout> | undefined
  let closeTimer: ReturnType<typeof setInterval> | undefined
  let onMessage: ((event: MessageEvent) => void) | undefined
  try {
    const grantResponse = await fetch('/__proxy-app/auth/grant', { credentials: 'same-origin', cache: 'no-store' })
    const grantPayload = await grantResponse.json().catch(() => null)
    const grantData = isRecord(grantPayload) && isRecord(grantPayload.data) ? grantPayload.data : null
    const developmentGrant = typeof grantData?.development_grant === 'string' ? grantData.development_grant : ''
    if (!grantResponse.ok || developmentGrant.length < 32) {
      const code = isRecord(grantPayload) && typeof grantPayload.code === 'string' ? grantPayload.code : 'APP_DEVELOPMENT_GRANT_INVALID'
      const message = isRecord(grantPayload) && typeof grantPayload.message === 'string' ? grantPayload.message : '本地预览授权已失效，请重新运行 proxy-app dev。'
      throw createSdkError(code, message, requestId, grantResponse.status || 403, grantPayload)
    }
    const login = new URL(portal.origin)
    login.hash = '/login?' + new URLSearchParams({
      proxy_app_browser: '1',
      proxy_app_state: authState,
      proxy_app_origin: appOrigin,
      proxy_app_id: appId,
      proxy_app_version: appVersion,
      proxy_app_development_grant: developmentGrant,
      ...(forceLogin ? { proxy_app_force_login: '1' } : {}),
    }).toString()
    const completed = new Promise<AppSession>((resolve, reject) => {
      onMessage = (event: MessageEvent) => {
        if (event.source !== popup || event.origin !== portal.origin || !isRecord(event.data)
          || event.data.protocol !== 'proxy-app/auth/v1' || event.data.state !== authState) return
        if (event.data.type === 'login-complete') {
          const value = event.data.app_session
          if (!isAppSessionFor(value, appId) || value.app_version !== appVersion) {
            reject(createSdkError('APP_SESSION_INVALID', '平台未返回有效的应用会话。', requestId, 502))
            return
          }
          resolve({ ...value, gateway_url: '/v1' } as AppSession)
        }
        else if (event.data.type === 'login-failed') {
          const failure = isRecord(event.data.error) ? event.data.error : {}
          const code = typeof failure.code === 'string' ? failure.code : 'APP_LOGIN_FAILED'
          const message = typeof failure.message === 'string' ? failure.message : '平台登录失败，请重试。'
          const failureRequestId = typeof failure.requestId === 'string' ? failure.requestId : requestId
          reject(createSdkError(code, message, failureRequestId, typeof failure.status === 'number' ? failure.status : 401, failure))
        }
      }
      window.addEventListener('message', onMessage)
      timer = setTimeout(() => reject(createSdkError('APP_LOGIN_TIMEOUT', '登录超时，请重新登录。', requestId, 408)), 10 * 60 * 1000)
      closeTimer = setInterval(() => {
        if (popup.closed) reject(createSdkError('APP_LOGIN_CANCELLED', '登录已取消，可以再次登录。', requestId, 401))
      }, 500)
    })
    popup.location.replace(login.href)
    return await completed
  } finally {
    if (timer) clearTimeout(timer)
    if (closeTimer) clearInterval(closeTimer)
    if (onMessage) window.removeEventListener('message', onMessage)
    if (!popup.closed) popup.close()
  }
}

/**
 * Published app login stays on the Portal origin. The Portal owns the HttpOnly
 * device cookie, exchanges it for an exact-version app session, and returns
 * only that app session to this tab through a state-checked postMessage.
 */
async function openPublishedAppLogin(appId: string, appVersion: string, portalURL: string, forceLogin = false): Promise<AppSession> {
  if (typeof window === 'undefined' || typeof window.open !== 'function') {
    throw createSdkError('APP_LOGIN_UNAVAILABLE', '登录需要在浏览器中打开。')
  }
  if (!appVersion?.trim()) throw createSdkError('APP_LOGIN_UNAVAILABLE', '应用版本信息不可用，请刷新页面后重试。')
  let portal: URL
  try { portal = new URL(portalURL) } catch {
    throw createSdkError('APP_LOGIN_UNAVAILABLE', 'Portal 地址无效，请检查应用配置。')
  }
  if (!['https:', 'http:'].includes(portal.protocol) || portal.username || portal.password || portal.search || portal.hash
    || (portal.pathname !== '/' && portal.pathname !== '') || portal.origin !== window.location.origin) {
    throw createSdkError('APP_LOGIN_UNAVAILABLE', '已发布应用必须通过 Portal 同源页面登录。')
  }

  const authState = generateRequestId()
  const login = new URL(portal.origin)
  login.hash = '/login?' + new URLSearchParams({
    proxy_app_browser: '1',
    proxy_app_origin: window.location.origin,
    proxy_app_id: appId,
    proxy_app_version: appVersion,
    proxy_app_state: authState,
    ...(forceLogin ? { proxy_app_force_login: '1' } : {}),
  }).toString()
  // Open synchronously in the user gesture so popup blockers do not reject it.
  const popup = window.open('about:blank', 'proxy-app-login', 'popup,width=520,height=720')
  if (!popup) throw createSdkError('APP_LOGIN_POPUP_BLOCKED', '浏览器阻止了登录窗口，请允许弹窗后重试。')

  const requestId = generateRequestId()
  let timer: ReturnType<typeof setTimeout> | undefined
  let closeTimer: ReturnType<typeof setInterval> | undefined
  let onMessage: ((event: MessageEvent) => void) | undefined
  try {
    const completed = new Promise<AppSession>((resolve, reject) => {
      onMessage = (event: MessageEvent) => {
        if (event.source !== popup || event.origin !== portal.origin || !isRecord(event.data)
          || event.data.protocol !== 'proxy-app/auth/v1' || event.data.state !== authState) return
        if (event.data.type === 'login-complete') {
          const value = event.data.app_session
          if (!isAppSessionFor(value, appId) || value.app_version !== appVersion) {
            reject(createSdkError('APP_SESSION_INVALID', '平台未返回当前版本对应的应用会话。', requestId, 502))
            return
          }
          resolve(value as AppSession)
        } else if (event.data.type === 'login-failed') {
          const failure = isRecord(event.data.error) ? event.data.error : {}
          const code = typeof failure.code === 'string' ? failure.code : 'APP_LOGIN_FAILED'
          const message = typeof failure.message === 'string' ? failure.message : '平台登录失败，请重试。'
          const failureRequestId = typeof failure.requestId === 'string' ? failure.requestId : requestId
          reject(createSdkError(code, message, failureRequestId, typeof failure.status === 'number' ? failure.status : 401, failure))
        }
      }
      window.addEventListener('message', onMessage)
      timer = setTimeout(() => reject(createSdkError('APP_LOGIN_TIMEOUT', '登录超时，请重新登录。', requestId, 408)), 10 * 60 * 1000)
      closeTimer = setInterval(() => {
        if (popup.closed) reject(createSdkError('APP_LOGIN_CANCELLED', '登录已取消，可以再次登录。', requestId, 401))
      }, 500)
    })
    popup.location.replace(login.href)
    return await completed
  } finally {
    if (timer) clearTimeout(timer)
    if (closeTimer) clearInterval(closeTimer)
    if (onMessage) window.removeEventListener('message', onMessage)
    if (!popup.closed) popup.close()
  }
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null
}

function unwrapElectronResult<T>(value: unknown): T {
  // Errors cannot retain custom properties when thrown through contextBridge.
  // New hosts return a plain envelope; older hosts still return raw values.
  if (!isRecord(value) || value.__proxyIPCResult !== true) return value as T
  if (value.ok === true) return value.value as T
  const failure = isRecord(value.error) ? value.error : {}
  const error = new AppSdkError(
    typeof failure.code === 'string' ? failure.code : 'APP_ELECTRON_HOST_ERROR',
    typeof failure.message === 'string' ? sanitizeApiErrorMessage(failure.message) : 'Desktop host request failed',
    typeof failure.requestId === 'string' ? failure.requestId : undefined,
    typeof failure.status === 'number' ? failure.status : undefined,
    failure,
  )
  if (typeof failure.executionStarted === 'boolean') error.executionStarted = failure.executionStarted
  if (typeof failure.authReason === 'string') error.authReason = failure.authReason
  throw error
}

function storageWritePayload(input: Record<string, any>, deleting = false) {
  for (const field of ['scope', 'namespace', 'storage_scope', 'storage_namespace', 'owner_id', 'owner_type', 'user_id', 'app_id', 'workspace_id', 'workspaceId']) {
    if (Object.prototype.hasOwnProperty.call(input, field)) {
      throw createSdkError('APP_STORAGE_INVALID_REQUEST', `${field} is controlled by the platform`)
    }
  }
  const { expectedRevision, expected_revision, ...payload } = input
  if (expectedRevision !== undefined && expected_revision !== undefined && expectedRevision !== expected_revision) {
    throw createSdkError('APP_STORAGE_INVALID_REVISION', 'Conflicting expected revision fields')
  }
  const revision = expected_revision !== undefined ? expected_revision : expectedRevision
  if (revision !== undefined && (!Number.isSafeInteger(revision) || revision < (deleting ? 1 : 0))) {
    throw createSdkError('APP_STORAGE_INVALID_REVISION', deleting
      ? 'Expected revision for deletion must be a positive safe integer'
      : 'Expected revision must be a nonnegative safe integer')
  }
  return { ...payload, ...(revision !== undefined ? { expected_revision: revision } : {}) }
}

function storageIdempotencyPayload(input: Record<string, any>) {
  const { idempotencyKey, idempotency_key, ...payload } = input
  if (idempotencyKey !== undefined && idempotency_key !== undefined && idempotencyKey !== idempotency_key)
    throw createSdkError('APP_STORAGE_INVALID_IDEMPOTENCY_KEY', 'Conflicting idempotency key fields')
  const key = idempotency_key !== undefined ? idempotency_key : idempotencyKey
  if (key !== undefined && (typeof key !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(key)))
    throw createSdkError('APP_STORAGE_INVALID_IDEMPOTENCY_KEY', 'Idempotency key must contain 1 to 128 letters, digits, dots, underscores, colons or hyphens')
  return { ...payload, idempotency_key: key ?? generateRequestId() }
}

function normalizeStorageEntry<T>(entry: (StorageEntry<T> & { updated_at?: string | null; author_user_id?: string; author_user_name?: string | null }) | null): StorageEntry<T> | null {
  if (entry === null) return null
  const updatedAt = entry.updatedAt !== undefined ? entry.updatedAt : entry.updated_at
  const authorId = entry.author?.id || entry.author_user_id
  const authorName = entry.author?.name !== undefined ? entry.author.name : entry.author_user_name
  const author: StorageEntryAuthor | undefined = authorId ? { id: authorId, ...(authorName !== undefined ? { name: authorName } : {}) } : undefined
  return { key: entry.key, value: entry.value, revision: entry.revision, ...(updatedAt !== undefined ? { updatedAt } : {}), ...(author ? { author } : {}) }
}

function storageRequestPayload(method: string, payload: unknown) {
  const input = isRecord(payload) ? payload : {}
  // Storage namespaces are a server-side policy. Reject attempts to smuggle
  // one through the generic call surface instead of silently accepting a
  // client-selected scope.
  for (const field of ['scope', 'namespace', 'storage_scope', 'storage_namespace', 'owner_id', 'owner_type', 'user_id', 'app_id', 'workspace_id', 'workspaceId']) {
    if (Object.prototype.hasOwnProperty.call(input, field)) {
      throw createSdkError('APP_STORAGE_INVALID_REQUEST', `${field} is controlled by the platform`)
    }
  }
  if (method === 'storage.user.set' || method === 'storage.user.delete' || method === 'storage.shared.set' || method === 'storage.shared.delete' || method === 'storage.workspace.set' || method === 'storage.workspace.delete') {
    return storageIdempotencyPayload(storageWritePayload(input, method.endsWith('.delete')))
  }
  if (method === 'storage.user.batch' || method === 'storage.shared.batch' || method === 'storage.workspace.batch') {
    if (!Array.isArray(input.operations) || input.operations.length < 1 || input.operations.length > 100) {
      throw createSdkError('APP_STORAGE_INVALID_OPERATION', 'Storage batch must contain 1 to 100 operations')
    }
    return {
      ...storageIdempotencyPayload(input),
      operations: input.operations.map((operation: unknown) => {
        if (!isRecord(operation) || !['put', 'set', 'delete'].includes(operation.op)) {
          throw createSdkError('APP_STORAGE_INVALID_OPERATION', 'Storage batch operation is invalid')
        }
        if (operation.idempotencyKey !== undefined || operation.idempotency_key !== undefined)
          throw createSdkError('APP_STORAGE_INVALID_OPERATION', 'Idempotency keys apply to the whole batch, not individual operations')
        return storageWritePayload(operation, operation.op === 'delete')
      }),
    }
  }
  return payload
}

function isJsonContentType(contentType: string) {
  const mediaType = contentType.split(';', 1)[0].trim().toLowerCase()
  return mediaType === 'application/json' || mediaType.endsWith('+json')
}

function hasRequestBody(body: RequestInit['body']) {
  return body !== undefined && body !== null
}

/**
 * Fetch sets the correct content type for FormData, URLSearchParams and
 * binary bodies itself. For JSON strings (the SDK's normal API payload), set
 * the header explicitly so Gin's JSON binder can decode the request even when
 * an application omitted it.
 */
function shouldDefaultJsonContentType(body: RequestInit['body']) {
  if (!hasRequestBody(body)) return false
  if (typeof body === 'string') return true
  if (typeof URLSearchParams !== 'undefined' && body instanceof URLSearchParams) return false
  if (typeof FormData !== 'undefined' && body instanceof FormData) return false
  if (typeof Blob !== 'undefined' && body instanceof Blob) return false
  if (typeof ArrayBuffer !== 'undefined' && body instanceof ArrayBuffer) return false
  if (typeof ArrayBuffer !== 'undefined' && ArrayBuffer.isView(body)) return false
  if (typeof ReadableStream !== 'undefined' && body instanceof ReadableStream) return false
  return true
}

type ParsedApiError = {
  code?: string
  message?: string
  requestId?: string
}

function sanitizeApiErrorMessage(message: string) {
  // Transport wrappers may append the local Gateway URL to an otherwise
  // user-facing message. Keep the request ID for support, but never expose
  // the endpoint (which can contain internal host or routing details).
  return message
    .replace(/,?\s*url:\s*(?:\[[^\]]+\]\([^)]+\)|\[[^\]]+\]|https?:\/\/[^\s,\]]+)\s*(?=,?\s*request[ _]id:|$)/ig, '')
    .replace(/,\s*,/g, ',')
    .trim()
}

function parseApiErrorBody(body: unknown): ParsedApiError {
  if (typeof body === 'string') {
    const message = sanitizeApiErrorMessage(body.trim())
    return { message: message || undefined }
  }
  if (!isRecord(body)) return {}

  const errorValue = body.error
  const nested = isRecord(errorValue) ? errorValue : undefined
  const message = nested?.message || (typeof errorValue === 'string' ? errorValue : undefined) || body.message
  const code = nested?.code || body.code
  const requestId = nested?.request_id || nested?.requestId || body.request_id || body.requestId
  return {
    code: typeof code === 'string' && code.trim() ? code.trim() : undefined,
    message: typeof message === 'string' && message.trim() ? sanitizeApiErrorMessage(message.trim()) : undefined,
    requestId: typeof requestId === 'string' && requestId.trim() ? requestId.trim() : undefined,
  }
}

async function readErrorBody(response: Response): Promise<unknown> {
  const contentType = response.headers.get('Content-Type') || ''
  // Error responses from the gateway are JSON. Keep text/plain support for
  // auth/proxy failures and avoid trying to decode a binary media body.
  if (contentType && !isJsonContentType(contentType) && !contentType.toLowerCase().startsWith('text/')) return null
  const text = await response.text().catch(() => '')
  if (!text.trim()) return null
  if (isJsonContentType(contentType) || !contentType) {
    try { return JSON.parse(text) as unknown } catch { /* fall through to text */ }
  }
  return text
}

function responseRequestId(response: Response, fallback?: string) {
  return response.headers.get('X-Request-ID')?.trim() || fallback
}

function createApiError(response: Response, body: unknown, fallbackRequestId: string) {
  const parsed = parseApiErrorBody(body)
  const requestId = responseRequestId(response, parsed.requestId || fallbackRequestId)
  const error = new AppSdkError(
    parsed.code || 'APP_API_ERROR',
    parsed.message || `App API request failed (${response.status})`,
    requestId,
    response.status,
    body,
  )
  const bodyRecord = isRecord(body) ? body : undefined
  const nested = bodyRecord && isRecord(bodyRecord.error) ? bodyRecord.error : undefined
  const authReason = nested?.auth_reason ?? bodyRecord?.auth_reason
  const executionStarted = nested && Object.prototype.hasOwnProperty.call(nested, 'execution_started')
    ? nested.execution_started
    : bodyRecord?.execution_started
  if (typeof authReason === 'string') error.authReason = authReason
  if (typeof executionStarted === 'boolean') error.executionStarted = executionStarted
  return error
}

function isGatewaySessionExpired(response: Response, body: unknown) {
  if (response.status !== 401 || !isRecord(body)) return false
  const nested = isRecord(body.error) ? body.error : undefined
  const reason = nested?.auth_reason || body.auth_reason || nested?.code || body.code
  const executionStarted = nested && Object.prototype.hasOwnProperty.call(nested, 'execution_started')
    ? nested.execution_started
    : body.execution_started
  return reason === 'APP_SESSION_EXPIRED' && executionStarted === false
}

function assertLocalRuntimeResponse(response: Response, requestId: string) {
  if ((response.headers.get('Content-Type') || '').toLowerCase().includes('text/html')) {
    throw new AppSdkError('LOCAL_DEV_RUNTIME_NOT_CONFIGURED', '本地开发运行时未启动，请使用 proxy-app dev 启动应用。', requestId, response.status)
  }
}

async function decodeResponse(response: Response, responseType: AppApiResponseType = 'auto'): Promise<unknown> {
  if (responseType === 'response') return response
  if (responseType === 'blob') return response.blob()
  if (responseType === 'arrayBuffer') return response.arrayBuffer()

  const contentType = response.headers.get('Content-Type') || ''
  const shouldReadJson = responseType === 'json' || (responseType === 'auto' && isJsonContentType(contentType))
  const shouldReadText = responseType === 'text' || (responseType === 'auto' && contentType.toLowerCase().startsWith('text/'))
  if (responseType === 'auto' && contentType && !shouldReadJson && !shouldReadText) return response.blob()
  const text = await response.text()
  if (!text.trim()) return null
  if (shouldReadJson) {
    try { return JSON.parse(text) as unknown } catch { return text }
  }
  if (shouldReadText) return text
  if (responseType === 'auto' && !contentType) {
    try { return JSON.parse(text) as unknown } catch { return text }
  }
  // A caller explicitly asking for JSON should get the same best-effort
  // behavior as the historical SDK. All known binary responses are handled
  // above through their Content-Type or an explicit responseType.
  return text
}

function attachResponseRequestId(value: unknown, response: Response, fallback: string): unknown {
  const requestId = responseRequestId(response, fallback)
  if (!requestId || !isRecord(value) || Array.isArray(value)) return value
  // Only JSON records can be copied safely. Spreading binary or native
  // responses loses their contents and breaks media playback and downloads.
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) return value
  if (typeof value.request_id === 'string' && value.request_id.trim()) return value
  return { ...value, request_id: requestId }
}

export function createAppClient(appId: string, options: AppClientOptions = {}) {
  if (typeof appId !== 'string' || appId !== appId.trim() || (!PLATFORM_APP_ID_PATTERN.test(appId) && !validPublicAppSlug(appId))) {
    throw new AppSdkError('APP_INVALID_ID', 'appId must be a 1–120 character lowercase slug or platform app_id')
  }
  const localHost = typeof window !== 'undefined' && ['localhost', '127.0.0.1', '::1'].includes(window.location.hostname)
  const detectedElectronHost = options.electronHost || (typeof window !== 'undefined' ? (window as Window & { proxyApp?: import('./types.js').ElectronHostBridge }).proxyApp : undefined)
  // Published applications get an App Session through the Portal browser
  // login flow and call the Gateway directly. Old `server` clients use it too.
  const configuredRuntime = options.runtime || (detectedElectronHost ? 'electron' : (options.localDevelopment || localHost ? 'local' : 'direct'))
  const runtime = configuredRuntime === 'server' ? 'direct' : configuredRuntime
  if (!['direct', 'local', 'electron'].includes(runtime)) {
    throw new AppSdkError('APP_RUNTIME_UNSUPPORTED', `Unsupported app runtime: ${runtime}`)
  }
  const localDevelopment = runtime === 'local'
  const directRuntime = runtime === 'direct'
  const electronRuntime = runtime === 'electron'
  const refreshAppSession = options.refreshAppSession
  const localGatewayPath = options.localGatewayPath || '/v1'
  const timeoutMs = options.timeoutMs ?? 10000
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new AppSdkError('APP_INVALID_TIMEOUT', 'timeoutMs must be a positive number')
  let session: AppSession | null = null
  let bearerSessionExpiresAt = 0
  let refreshPromise: Promise<AppSession> | null = null
  let localSessionLoadPromise: Promise<AppSession> | null = null
  // `auth.status()` may explicitly probe Gateway. Ordinary startup consumes
  // the Portal-issued session metadata and lets the first real API request
  // perform authoritative Gateway validation.
  let gatewaySessionValidationToken = ''
  let gatewaySessionValidationPromise: Promise<AppSession> | null = null
  let accountScopeRecovery: { session: AppSession; token: string; promise: Promise<void> } | null = null
  let destroyed = false
  let gatewaySessionError: AppSdkError | null = null

  const unsupportedAppMethodError = (method: string) => createSdkError(
    'APP_RUNTIME_METHOD_NOT_SUPPORTED',
    `This app can only call Gateway data-plane methods or approved host capabilities: ${method}`,
  )

  // A host capability is a deliberately narrow local service (for example,
  // the desktop image cache). It is not a permission to proxy arbitrary
  // platform or Admin Runtime requests. The session is the authoritative
  // allowlist and is refreshed together with the account-bound session.
  const hasHostCapability = (method: string) =>
    GATEWAY_ONLY_HOST_METHODS.has(method) && (
      session?.host_capabilities?.includes(method) === true ||
      detectedElectronHost?.capabilities?.includes(method) === true
    )

  const assertAppMethod = (method: string, allowHostCapability = false) => {
    if (isStorageMethod(method)
      || (localDevelopment && LOCAL_HTTP_METHODS.has(method))
      || (directRuntime && DIRECT_HTTP_METHODS.has(method))
      || (allowHostCapability && hasHostCapability(method))) return
    throw unsupportedAppMethodError(method)
  }

  const gatewayBase = () => {
    if (gatewaySessionError) throw gatewaySessionError
    const base = session?.gateway_url
    if (!base) throw createSdkError('APP_SESSION_UNAVAILABLE', 'App data-plane session is not ready')
    if (!gatewayBaseIsAllowed(base, localDevelopment)) {
      throw createSdkError('APP_GATEWAY_URL_INVALID', 'App session must use a canonical Gateway /v1 URL')
    }
    return base.replace(/\/$/, '')
  }

  const acceptSession = (next: AppSession) => {
    if (gatewayBaseIsAllowed(next.gateway_url, localDevelopment)) {
      gatewaySessionError = null
      bearerSessionExpiresAt = storedSessionExpiresAt(next)
      if (localDevelopment || directRuntime) {
        try {
          sessionStorage.setItem(`${GATEWAY_SESSION_STORAGE_PREFIX}${encodeURIComponent(appId)}`, JSON.stringify(next))
        } catch {
          // A blocked sessionStorage should not prevent the current tab from
          // using a session returned by the authenticated Portal.
        }
      }
      return true
    }
    gatewaySessionError = createSdkError('APP_GATEWAY_URL_INVALID', 'App session must use a canonical Gateway /v1 URL')
    session = null
    return false
  }

  if (localDevelopment) {
  // Local development receives the same Gateway App Session as production.
  // A session is scoped to this browser tab and came from the Portal's
  // same-origin device-cookie exchange.
    const storedSession = readAppSessionFromStorage(appId, true)
    const suppliedSession = options.appSession || (storedSession && (!options.localAppVersion || storedSession.app_version === options.localAppVersion) ? storedSession : undefined)
    if (suppliedSession) {
      if (!suppliedSession.access_token?.startsWith('ast_') || !suppliedSession.gateway_url) {
        throw new AppSdkError('APP_SESSION_INVALID', 'local runtime received an invalid Gateway App Session')
      }
      session = suppliedSession
    } else {
      // Keep a non-authenticated client constructible so the UI can render a
      // reconnect state. No request can be made until a Gateway session exists.
      session = {
        access_token: '',
        token_type: 'Bearer',
        expires_in: APP_SESSION_DEFAULT_TTL_SECONDS,
        gateway_url: localGatewayPath.replace(/\/$/, ''),
        app_id: appId,
        app_slug: appId,
        app_version: options.localAppVersion || 'local',
        scopes: [],
      }
    }
  } else if (directRuntime) {
    // A published first-party page may be constructed before the Portal
    // App Session is available (for example after a direct refresh or
    // when browser sessionStorage is blocked). Keep the client alive so the
    // platform gate can show a reconnect state; never fall back to the Admin
    // runtime just to recover a missing Gateway credential.
    const suppliedSession = options.appSession || readAppSessionFromStorage(appId)
    if (suppliedSession) {
      if (!suppliedSession.access_token?.startsWith('ast_') || !suppliedSession.gateway_url) {
        throw new AppSdkError('APP_SESSION_INVALID', 'direct runtime received an invalid user App Session')
      }
      session = suppliedSession
    }
  } else if (electronRuntime) {
    if (!detectedElectronHost) throw new AppSdkError('APP_ELECTRON_HOST_UNAVAILABLE', 'Electron host bridge is not available')
  }

  if (localDevelopment && !gatewayBaseIsAllowed(localGatewayPath, true)) {
    throw createSdkError('APP_GATEWAY_URL_INVALID', 'Local app runtime must use a canonical Gateway URL')
  }
  // A direct runtime can be constructed before a Portal App Session is
  // available (for example after a hard refresh with blocked sessionStorage).
  // Keep the client alive so the host can render its reconnect state; do not
  // dereference a missing session or fall back to the Admin runtime.
  if (directRuntime && session && !gatewayBaseIsAllowed(session.gateway_url)) {
    throw createSdkError('APP_GATEWAY_URL_INVALID', 'App session must use a canonical Gateway /v1 URL')
  }
  if ((directRuntime || localDevelopment) && session?.access_token) acceptSession(session)

  const cleanup = () => {
    gatewaySessionError = null
    gatewaySessionValidationToken = ''
    gatewaySessionValidationPromise = null
    localSessionLoadPromise = null
  }

  const login = async (loginOptions: LocalLoginOptions = {}) => {
    if (electronRuntime) {
      return unwrapElectronResult<void>(await detectedElectronHost!.auth.login(loginOptions))
    }
    if (localDevelopment) {
      const appVersion = options.localAppVersion || session?.app_version || 'local'
      let nextSession: AppSession | undefined
      if (refreshAppSession && loginOptions.forceLogin !== true) {
        try {
          nextSession = await refreshAppSession()
        } catch (error) {
          const code = error instanceof AppSdkError ? error.code : ''
          if (code !== 'DEVICE_TOKEN_INVALID' && code !== 'APP_LOGIN_REQUIRED') throw error
        }
      }
      if (!nextSession) {
        nextSession = await openLocalDevelopmentLogin(
          appId,
          appVersion,
          options.portalURL || 'https://www.duckingmind.com',
          loginOptions.forceLogin === true,
        )
      } else {
        nextSession = { ...nextSession, gateway_url: localGatewayPath.replace(/\/$/, '') }
      }
      if (!gatewayBaseIsAllowed(nextSession.gateway_url, true)) {
        throw createSdkError('APP_SESSION_INVALID', '平台返回的应用会话与当前应用不匹配。')
      }
      acceptSession(nextSession)
      session = nextSession
      gatewaySessionValidationToken = ''
      return
    }
    if (directRuntime) {
      const nextSession = await openPublishedAppLogin(
        appId,
        options.appVersion || session?.app_version || '',
        options.portalURL || (typeof window !== 'undefined' ? window.location.origin : ''),
        loginOptions.forceLogin === true,
      )
      if (!gatewayBaseIsAllowed(nextSession.gateway_url)) {
        throw createSdkError('APP_SESSION_INVALID', '平台返回的应用会话与当前应用不匹配。')
      }
      acceptSession(nextSession)
      session = nextSession
      gatewaySessionValidationToken = ''
      return
    }
    throw createSdkError('APP_LOGIN_UNAVAILABLE', directRuntime ? '请通过平台入口获取 App Session' : '登录由平台宿主管理')
  }

  const logout = async () => {
    if (electronRuntime) return unwrapElectronResult<void>(await detectedElectronHost!.auth.logout())
    if (!localDevelopment && !directRuntime) return
    session = null
    bearerSessionExpiresAt = 0
    gatewaySessionValidationToken = ''
    try {
      sessionStorage.removeItem(`${GATEWAY_SESSION_STORAGE_PREFIX}${encodeURIComponent(appId)}`)
    } catch {
      // A blocked sessionStorage is already equivalent to a logged-out tab.
    }
    // Portal owns the HttpOnly device cookie. App logout only clears this tab's
    // App Session and does not log the user out of the Portal.
  }

  /**
   * Explicitly check a browser App Session through Gateway without starting
   * a login flow. Normal app startup uses the signed Portal handoff directly;
   * this method is reserved for callers that specifically need live status.
   */
  const validAccountScope = (scope: unknown): scope is string =>
    typeof scope === 'string' && /^acs_[a-f0-9]{64}$/.test(scope)
  const accountScopeUnavailable = () => createSdkError('APP_ACCOUNT_SCOPE_UNAVAILABLE', '平台未返回有效的账户标识，请检查平台与宿主版本。')

  // An old session can still be authenticated while missing newer account
  // metadata. Recover through the authoritative platform, never from a token
  // or profile identifier. One status operation makes at most one refresh.
  const recoverAccountScope = async (current: AppSession): Promise<void> => {
    const token = current.access_token
    if (accountScopeRecovery?.session === current && accountScopeRecovery.token === token) return accountScopeRecovery.promise
    const assertCurrent = () => {
      if (destroyed || session !== current || current.access_token !== token)
        throw createSdkError('APP_AUTH_CHANGED', '账户授权已改变，请重新检查登录状态。')
    }
    const promise = (async () => {
      if (directRuntime && !refreshAppSession) throw accountScopeUnavailable()
      assertCurrent()
      await refreshSession()
      if (destroyed) throw createSdkError('APP_AUTH_CHANGED', '应用已关闭，请重新打开应用。')
      if (!validAccountScope(session?.account_scope)) throw accountScopeUnavailable()
    })()
    const recovery = { session: current, token, promise }
    accountScopeRecovery = recovery
    try { await promise } finally { if (accountScopeRecovery === recovery) accountScopeRecovery = null }
  }

  const authStatus = async (): Promise<AppAuthStatus> => {
    if (destroyed) throw createSdkError('APP_AUTH_CHANGED', '账户授权已改变，请重新检查登录状态。')
    if (gatewaySessionError) throw gatewaySessionError
    const scopedStatus = (authenticated: boolean, scope: unknown): AppAuthStatus => {
      if (authenticated && !validAccountScope(scope)) throw accountScopeUnavailable()
      return { authenticated, ...(authenticated ? { accountScope: scope as string } : {}) }
    }
    if (electronRuntime) {
      const status = unwrapElectronResult<AppAuthStatus>(await detectedElectronHost!.auth.status())
      const { accountScope, ...rest } = status
      return { ...rest, ...scopedStatus(status.authenticated, accountScope) }
    }
    if (!session?.access_token && localDevelopment) {
      try {
        await refreshSession()
      } catch (error) {
        if (error instanceof AppSdkError && error.code === 'APP_LOGIN_REQUIRED') return { authenticated: false }
        throw error
      }
    }
    if (!session?.access_token) return { authenticated: false }
    await validateGatewaySession(session)
    return scopedStatus(true, session.account_scope)
  }

  const httpCall = async <T>(method: string, payload?: unknown): Promise<T> => {
    // HTTP calls are limited to the Gateway data plane. Electron host
    // capabilities use preload IPC and never become HTTP routes.
    assertAppMethod(method)
    const input = isRecord(payload) ? payload : {}
    let path: string
    let httpMethod = 'GET'
    let body: string | undefined
    switch (method) {
      case 'user.profile.read':
        path = '/profile'
        break
      case 'platform.capabilities.list':
        path = '/capabilities'
        break
      case 'theme.read':
        path = '/preferences?kind=theme'
        break
      case 'locale.read':
        path = '/preferences?kind=locale'
        break
      case 'storage.user.get':
      case 'storage.user.get_entry':
      case 'storage.user.get_many':
      case 'storage.user.list':
      case 'storage.user.batch':
      case 'storage.user.set':
      case 'storage.user.delete':
      case 'storage.shared.get':
      case 'storage.shared.get_entry':
      case 'storage.shared.get_many':
      case 'storage.shared.list':
      case 'storage.shared.batch':
      case 'storage.shared.set':
      case 'storage.shared.delete':
      case 'storage.workspace.get':
      case 'storage.workspace.get_entry':
      case 'storage.workspace.get_many':
      case 'storage.workspace.list':
      case 'storage.workspace.batch':
      case 'storage.workspace.set':
      case 'storage.workspace.delete':
        {
        const storageKind = method.startsWith('storage.workspace.') ? 'workspace' : method.startsWith('storage.shared.') ? 'shared' : 'user'
        const itemPath = storageKind === 'user' ? '/storage/items' : `/storage/${storageKind}/items`
        const keysPath = storageKind === 'user' ? '/storage/keys' : `/storage/${storageKind}/keys`
        const batchPath = storageKind === 'user' ? '/storage/batch' : `/storage/${storageKind}/batch`
        if (method.endsWith('.get_many')) {
          if (!Array.isArray(input.keys) || input.keys.length < 1 || input.keys.length > 100 || input.keys.some((key) => typeof key !== 'string' || !key.trim()))
            throw createSdkError('APP_STORAGE_INVALID_KEY', 'Storage keys must be a non-empty array of at most 100 strings')
          const params = new URLSearchParams()
          // `keys` explicitly requests a key map, including a single key.
          for (const key of input.keys) params.append('keys', key)
          if (input.include_metadata === true) params.set('include_metadata', 'true')
          path = `${itemPath}?${params}`
        } else if (method.endsWith('.list')) {
          const params = new URLSearchParams()
          if (typeof input.prefix === 'string' && input.prefix) params.set('prefix', input.prefix)
          if (typeof input.cursor === 'string' && input.cursor) params.set('cursor', input.cursor)
          if (typeof input.limit === 'number') params.set('limit', String(input.limit))
          path = `${keysPath}?${params}`
        } else if (method.endsWith('.batch')) {
          if (!Array.isArray(input.operations) || input.operations.length < 1 || input.operations.length > 100)
            throw createSdkError('APP_STORAGE_INVALID_OPERATION', 'Storage batch must contain 1 to 100 operations')
          httpMethod = 'POST'
          body = JSON.stringify({ operations: input.operations })
          path = batchPath
        } else {
          if (typeof input.key !== 'string' || !input.key.trim()) throw createSdkError('APP_STORAGE_INVALID_KEY', 'Storage key must be a non-empty string')
          path = `${itemPath}?${new URLSearchParams({ key: input.key })}`
          if (method.endsWith('.get_entry')) path += '&include_metadata=true'
        }
        const expectedRevision = typeof input.expected_revision === 'number'
          ? input.expected_revision
          : typeof input.expectedRevision === 'number' ? input.expectedRevision : undefined
        if (method.endsWith('.set')) { httpMethod = 'PUT'; body = JSON.stringify({ value: input.value, ...(expectedRevision !== undefined ? { expected_revision: expectedRevision } : {}) }) }
        if (method.endsWith('.delete')) {
          httpMethod = 'DELETE'
          if (expectedRevision !== undefined) path += `&expected_revision=${encodeURIComponent(String(expectedRevision))}`
        }
        break
        }
      default:
        throw createSdkError('APP_RUNTIME_METHOD_NOT_SUPPORTED', `App HTTP runtime does not support ${method}`)
    }
    await ensureBearerSession()
    const requestId = generateRequestId()
    const idempotencyKey = typeof input.idempotency_key === 'string' ? input.idempotency_key : generateRequestId()
    let sentToken = ''
    const request = () => {
      sentToken = session?.access_token || ''
      const headers = new Headers({ Accept: 'application/json', 'X-Request-ID': requestId })
      if (sentToken) headers.set('Authorization', `${session?.token_type || 'Bearer'} ${sentToken}`)
      if (session?.app_version) headers.set('X-App-Version', session.app_version)
      if (body !== undefined) headers.set('Content-Type', 'application/json')
      if (httpMethod !== 'GET') headers.set('Idempotency-Key', idempotencyKey)
      const init: RequestInit = { method: httpMethod, headers, body, credentials: 'omit', redirect: 'error' }
      return fetch(`${gatewayBase()}${path}`, init)
    }
    let response = await request()
    if (localDevelopment) assertLocalRuntimeResponse(response, requestId)
    if (response.status === 401) {
      // A failed explicit status probe must not be memoized; a later
      // `auth.status()` call should retry Gateway instead of trusting the
      // previous result.
      gatewaySessionValidationToken = ''
      const body = await readErrorBody(response.clone())
      if (isGatewaySessionExpired(response, body)) {
        await refreshSession()
        response = await request()
      } else if (await waitForSessionRotation(sentToken)) {
        response = await request()
      }
    }
    const result = await response.json().catch(() => null)
    if (!response.ok) throw createApiError(response, result, requestId)
    const value = isRecord(result) && Object.prototype.hasOwnProperty.call(result, 'data') ? result.data : result
    return value as T
  }

  const call = async <T>(method: string, payload?: unknown): Promise<T> => {
    payload = storageRequestPayload(method, payload)
    assertAppMethod(method, runtime === 'electron')
    if (electronRuntime) return unwrapElectronResult<T>(await detectedElectronHost!.call(method, payload))
    return httpCall<T>(method, payload)
  }
  window.addEventListener('beforeunload', cleanup)

  const refreshSession = async (): Promise<AppSession> => {
    if (destroyed) throw createSdkError('APP_AUTH_CHANGED', '应用已关闭，请重新打开应用。')
    if (gatewaySessionError) throw gatewaySessionError
    if (electronRuntime) {
      if (refreshPromise) return refreshPromise
      refreshPromise = authStatus().then(status => {
        const { account_scope: _previousScope, ...base } = session || {
          access_token: '', token_type: 'Bearer', expires_in: 0, gateway_url: '',
          app_id: appId, app_slug: appId, app_version: options.localAppVersion || 'desktop', scopes: [],
        }
        return { ...base, ...(status.accountScope ? { account_scope: status.accountScope } : {}) }
      }).finally(() => { refreshPromise = null })
      return refreshPromise
    }
    if (localDevelopment || directRuntime) {
      if (localDevelopment && !session?.access_token) {
        if (localSessionLoadPromise) return localSessionLoadPromise
      const loadSession = refreshAppSession
        ? refreshAppSession()
        : loadLocalDevelopmentAppSession(appId, options.localAppVersion || 'local')
      const pending = loadSession.then((issuedSession) => {
          if (destroyed) throw createSdkError('APP_AUTH_CHANGED', '应用已关闭，请重新打开应用。')
        const nextSession = localDevelopment
          ? { ...issuedSession, gateway_url: localGatewayPath.replace(/\/$/, '') }
          : issuedSession
          if (!gatewayBaseIsAllowed(nextSession.gateway_url, true)) {
            throw createSdkError('APP_GATEWAY_URL_INVALID', 'Refreshed App Session must use a canonical Gateway /v1 URL')
          }
          acceptSession(nextSession)
          session = nextSession
          return nextSession
        }).finally(() => {
          if (localSessionLoadPromise === pending) localSessionLoadPromise = null
        })
        localSessionLoadPromise = pending
        return pending
      }
      if (!session?.access_token && !refreshAppSession) {
        throw createSdkError('APP_SESSION_UNAVAILABLE', 'App data-plane session is not ready')
      }
      if (!refreshAppSession) {
        if (localDevelopment && bearerSessionExpiresAt <= Date.now()) {
          throw createSdkError('APP_LOGIN_REQUIRED', '本地应用会话已过期，请重新登录平台。', undefined, 401)
        }
        return session!
      }
      if (refreshPromise) return refreshPromise
      const previousSession = session
      const previousToken = session?.access_token
      refreshPromise = refreshAppSession().then((issuedSession) => {
        if (destroyed || session !== previousSession || session?.access_token !== previousToken)
          throw createSdkError('APP_AUTH_CHANGED', '账户授权已改变，请重新检查登录状态。')
        const nextSession = localDevelopment
          ? { ...issuedSession, gateway_url: localGatewayPath.replace(/\/$/, '') }
          : issuedSession
        if (!nextSession?.access_token?.startsWith('ast_') || !nextSession.gateway_url) {
          throw createSdkError('APP_SESSION_INVALID', 'OAuth refresh did not return a valid user App Session')
        }
        if (!gatewayBaseIsAllowed(nextSession.gateway_url, localDevelopment)) {
          throw createSdkError('APP_GATEWAY_URL_INVALID', 'Refreshed App Session must use a canonical Gateway /v1 URL')
        }
        acceptSession(nextSession)
        session = nextSession
        return nextSession
      }).finally(() => {
        refreshPromise = null
      })
      return refreshPromise
    }
    throw createSdkError('APP_SESSION_REFRESH_UNAVAILABLE', 'App session refresh is not available for this runtime')
  }

  const validateGatewaySession = async (current: AppSession): Promise<AppSession> => {
    // Browser runtimes use the Gateway as the single source of truth for
    // admission. Electron keeps its host-owned auth/status contract because
    // the bearer never lives in the renderer.
    if (!directRuntime && !localDevelopment) return current
    const token = current.access_token
    if (!token) throw createSdkError('APP_SESSION_UNAVAILABLE', 'App data-plane session is not ready')
    if (gatewaySessionValidationToken === token && session?.access_token === token) return session
    if (gatewaySessionValidationPromise) return gatewaySessionValidationPromise
    const promise = (async () => {
      // `auth.status()` is an explicit live check, so it uses the smallest
      // authenticated Gateway route. Normal startup does not call this path.
      try {
        await httpCall<AppProfile>('user.profile.read')
      } catch (error) {
        const failure = error && typeof error === 'object' ? error as { status?: unknown; authReason?: unknown } : {}
        // Local development has no server-side user credential or refresh
        // relay. A rejected session must trigger the app's explicit Portal
        // login action, which exchanges the HttpOnly device cookie again.
        if (localDevelopment && failure.status === 401 && session?.access_token === token && !options.refreshAppSession) {
          throw createSdkError('APP_LOGIN_REQUIRED', '当前应用会话已失效，请重新登录平台。', (error as AppSdkError)?.requestId, 401, error)
        }
        if ((!localDevelopment && !directRuntime) || failure.status !== 401 || session?.access_token !== token) throw error
        await refreshSession()
        await httpCall<AppProfile>('user.profile.read')
      }
      const verified = session
      if (!verified?.access_token) throw createSdkError('APP_SESSION_UNAVAILABLE', 'App data-plane session is not ready')
      gatewaySessionValidationToken = verified.access_token
      return verified
    })().finally(() => {
      gatewaySessionValidationPromise = null
    })
    gatewaySessionValidationPromise = promise
    return promise
  }

  const createPlatformSession = async (): Promise<AppSession> => {
    // Portal already authenticated and issued this user-bound App Session.
    // Admit from its trusted handoff metadata without a duplicate Gateway
    // preflight; Gateway validates the bearer on each actual data-plane call.
    let current = session?.access_token && bearerSessionExpiresAt > Date.now()
      ? session
      : await refreshSession()
    if (directRuntime || localDevelopment) {
      if (current.access_token && bearerSessionExpiresAt <= Date.now()) {
        throw createSdkError(
          localDevelopment ? 'APP_LOGIN_REQUIRED' : 'APP_SESSION_EXPIRED',
          localDevelopment ? '本地应用会话已过期，请重新登录平台。' : '平台授权已过期，请重新登录。',
          undefined,
          401,
        )
      }
      if (current.access_token && !validAccountScope(current.account_scope)) {
        await recoverAccountScope(current)
        current = session || current
      }
      if (current.access_token && !validAccountScope(current.account_scope)) throw accountScopeUnavailable()
    }
    return current
  }

  const ensureBearerSession = async () => {
    if (electronRuntime) return
    if (localDevelopment) {
      if (session?.access_token && bearerSessionExpiresAt > Date.now()) return
      if (session?.access_token) {
        await refreshSession()
      } else {
        const status = await authStatus()
        if (!status.authenticated) {
          // Keep background/data-plane calls silent. Login is an explicit UI
          // action; a missing session must not open a popup as a side effect
          // of loading models or restoring storage.
          throw createSdkError('APP_LOGIN_REQUIRED', '请先登录平台账户', undefined, 401)
        }
        if (!session?.access_token) throw createSdkError('APP_SESSION_UNAVAILABLE', 'App data-plane session is not ready')
        if (bearerSessionExpiresAt <= Date.now()) await refreshSession()
      }
      return
    }
    if (!session?.access_token) return
    // Direct consumers can supply their own rotation callback. If they have
    // none, retain manual-token use until expiry instead of rejecting an
    // otherwise valid request during the renewal window.
    if (directRuntime && !options.refreshAppSession) return
    if (bearerSessionExpiresAt <= Date.now()) await refreshSession()
  }

  // A request can be sent with the previous bearer while another call replaces
  // the App Session. Gateway may return a generic credential_invalid instead
  // of an explicit expiry response. Retry only when
  // this client can prove that its session changed after the request started;
  // unrelated authentication failures must still surface to the caller.
  const waitForSessionRotation = async (sentToken: string): Promise<boolean> => {
    if (!sentToken) return false
    const pending = refreshPromise
    if (pending) await pending
    return Boolean(session?.access_token && session.access_token !== sentToken)
  }

  return {
    appId,
    destroy() {
      destroyed = true
      cleanup()
      window.removeEventListener('beforeunload', cleanup)
      session = null
    },
    refreshSession,
    call,
    user: {
      getProfile: () => call<AppProfile>('user.profile.read'),
    },
    storage: {
      get: <T>(key: string) => call<T | null>('storage.user.get', { key }),
      getEntry: async <T>(key: string): Promise<StorageEntry<T> | null> => {
        const entry = await call<StorageEntry<T> & { updated_at?: string | null } | null>('storage.user.get_entry', { key })
        return normalizeStorageEntry(entry)
      },
      getMany: <T>(keys: string[]) => call<Record<string, T | null>>('storage.user.get_many', { keys }),
      getEntries: async <T>(keys: string[]): Promise<Record<string, StorageEntry<T> | null>> => {
        const entries = await call<Record<string, (StorageEntry<T> & { updated_at?: string | null }) | null>>('storage.user.get_many', { keys, include_metadata: true })
        return Object.fromEntries(Object.entries(entries).map(([key, entry]) => [key, normalizeStorageEntry(entry)]))
      },
      set: (key: string, value: unknown, options: StorageWriteOptions = {}) => call<{ success: boolean; revision?: number }>('storage.user.set', {
        key, value, expected_revision: options.expectedRevision, idempotency_key: options.idempotencyKey,
      }),
      delete: (key: string, options: StorageWriteOptions = {}) => call<{ success: boolean }>('storage.user.delete', {
        key, expected_revision: options.expectedRevision, idempotency_key: options.idempotencyKey,
      }),
      list: async (options: StorageListOptions = {}) => {
        const value = await call<StorageListResult & { next_cursor?: string }>('storage.user.list', options)
        return { keys: value.keys, ...((value.nextCursor || value.next_cursor) ? { nextCursor: value.nextCursor || value.next_cursor } : {}) }
      },
      batch: async (operations: StorageBatchOperation[], options: StorageOperationOptions = {}) => {
        const value = await call<Array<{ key: string; success: boolean; revision?: number }> | { results: Array<{ key: string; success: boolean; revision?: number }> }>('storage.user.batch', {
          operations, idempotency_key: options.idempotencyKey,
        })
        return Array.isArray(value) ? value : value.results
      },
    },
    /**
     * Application-owned shared storage. The Gateway derives the namespace
     * from the App Session, so this API deliberately exposes no scope or
     * namespace argument. It is visible to every user of this application.
     */
    sharedStorage: {
      get: <T>(key: string) => call<T | null>('storage.shared.get', { key }),
      getEntry: async <T>(key: string): Promise<StorageEntry<T> | null> => {
        const entry = await call<StorageEntry<T> & { updated_at?: string | null } | null>('storage.shared.get_entry', { key })
        return normalizeStorageEntry(entry)
      },
      getMany: <T>(keys: string[]) => call<Record<string, T | null>>('storage.shared.get_many', { keys }),
      getEntries: async <T>(keys: string[]): Promise<Record<string, StorageEntry<T> | null>> => {
        const entries = await call<Record<string, (StorageEntry<T> & { updated_at?: string | null }) | null>>('storage.shared.get_many', { keys, include_metadata: true })
        return Object.fromEntries(Object.entries(entries).map(([key, entry]) => [key, normalizeStorageEntry(entry)]))
      },
      set: (key: string, value: unknown, options: StorageWriteOptions = {}) => call<{ success: boolean; revision?: number }>('storage.shared.set', {
        key, value, expected_revision: options.expectedRevision, idempotency_key: options.idempotencyKey,
      }),
      delete: (key: string, options: StorageWriteOptions = {}) => call<{ success: boolean }>('storage.shared.delete', {
        key, expected_revision: options.expectedRevision, idempotency_key: options.idempotencyKey,
      }),
      list: async (options: StorageListOptions = {}) => {
        const value = await call<StorageListResult & { next_cursor?: string }>('storage.shared.list', options)
        return { keys: value.keys, ...((value.nextCursor || value.next_cursor) ? { nextCursor: value.nextCursor || value.next_cursor } : {}) }
      },
      batch: async (operations: StorageBatchOperation[], options: StorageOperationOptions = {}) => {
        const value = await call<Array<{ key: string; success: boolean; revision?: number }> | { results: Array<{ key: string; success: boolean; revision?: number }> }>('storage.shared.batch', {
          operations, idempotency_key: options.idempotencyKey,
        })
        return Array.isArray(value) ? value : value.results
      },
    },
    /**
     * Team workspace storage. The platform binds the active Workspace to the
     * App Session; methods intentionally accept no workspace id or scope.
     */
    workspaceStorage: {
      get: <T>(key: string) => call<T | null>('storage.workspace.get', { key }),
      getEntry: async <T>(key: string): Promise<StorageEntry<T> | null> => {
        const entry = await call<StorageEntry<T> & { updated_at?: string | null } | null>('storage.workspace.get_entry', { key })
        return normalizeStorageEntry(entry)
      },
      getMany: <T>(keys: string[]) => call<Record<string, T | null>>('storage.workspace.get_many', { keys }),
      getEntries: async <T>(keys: string[]): Promise<Record<string, StorageEntry<T> | null>> => {
        const entries = await call<Record<string, (StorageEntry<T> & { updated_at?: string | null }) | null>>('storage.workspace.get_many', { keys, include_metadata: true })
        return Object.fromEntries(Object.entries(entries).map(([key, entry]) => [key, normalizeStorageEntry(entry)]))
      },
      set: (key: string, value: unknown, options: StorageWriteOptions = {}) => call<{ success: boolean; revision?: number }>('storage.workspace.set', {
        key, value, expected_revision: options.expectedRevision, idempotency_key: options.idempotencyKey,
      }),
      delete: (key: string, options: StorageWriteOptions = {}) => call<{ success: boolean }>('storage.workspace.delete', {
        key, expected_revision: options.expectedRevision, idempotency_key: options.idempotencyKey,
      }),
      list: async (options: StorageListOptions = {}) => {
        const value = await call<StorageListResult & { next_cursor?: string }>('storage.workspace.list', options)
        return { keys: value.keys, ...((value.nextCursor || value.next_cursor) ? { nextCursor: value.nextCursor || value.next_cursor } : {}) }
      },
      batch: async (operations: StorageBatchOperation[], options: StorageOperationOptions = {}) => {
        const value = await call<Array<{ key: string; success: boolean; revision?: number }> | { results: Array<{ key: string; success: boolean; revision?: number }> }>('storage.workspace.batch', {
          operations, idempotency_key: options.idempotencyKey,
        })
        return Array.isArray(value) ? value : value.results
      },
    } satisfies WorkspaceStorage,
    notification: {
      show: (title: string, body?: string) => call<{ success: boolean }>('notification.show', { title, body }),
    },
    theme: {
      read: () => call<{ mode: string }>('theme.read'),
    },
    locale: {
      read: () => call<{ locale: string }>('locale.read'),
    },
    platform: {
      /** Read the current browser session (refreshing after expiry) or host-owned auth status. */
      createSession: createPlatformSession,
      capabilities: () => call<Array<{ method: string; scope?: string; description: string }>>('platform.capabilities.list'),
      call: <T = unknown>(method: string, payload?: unknown) => call<T>(method, payload),
    },
    auth: {
      /** Browser applications receive sessions from the Portal login flow. */
      loginMode: (localDevelopment || electronRuntime ? 'app' : 'host') as 'app' | 'host',
      /** Explicit recovery behavior for a runtime without credentials of its own. */
      recoveryMode: (localDevelopment || electronRuntime ? 'login' : 'host') as 'login' | 'host',
      /** Ask the owning host to recover the Gateway App Session. */
      login,
      /** Clear this tab's App Session so another platform user can sign in. */
      logout,
      /** Read authentication state without initiating a login flow. */
      status: authStatus,
    },
    session: () => session,
    agent,
    api: {
      request: async <T = unknown>(path: string, init: AppApiRequestInit = {}): Promise<T> => {
        // Validate before the Electron IPC branch as well: the host owns the
        // actual Gateway URL, but the renderer still must not submit Admin
        // Runtime paths to its general request bridge.
        if (!isAllowedAppRoute(path, init.method || 'GET')) {
          throw createSdkError('APP_API_PATH_NOT_ALLOWED', 'App API path is not allowed')
        }
        assertStorageScopeFreeRequest(path, init)
        if (electronRuntime) {
          // AbortSignal cannot cross Electron IPC. Cancellation is local to
          // the caller; the host may still finish a request already sent.
          const { responseType = 'auto', signal, ...requestInit } = init
          signal?.throwIfAborted()
          let normalized = requestInit
          if (requestInit.body && typeof requestInit.body !== 'string' && !(requestInit.body instanceof ArrayBuffer)) {
            const encoded = new Request('http://proxy-app.invalid', { method: requestInit.method || 'GET', headers: requestInit.headers, body: requestInit.body })
            normalized = { ...requestInit, body: await encoded.arrayBuffer(), headers: encoded.headers }
          }
          signal?.throwIfAborted()
          const bridgeInit = { ...normalized, headers: Array.from(new Headers(normalized.headers || {}).entries()) }
          let cancel: (() => void) | undefined
          const aborted = new Promise<never>((_, reject) => {
            if (!signal) return
            cancel = () => reject(signal.reason ?? new DOMException('Aborted', 'AbortError'))
            signal.addEventListener('abort', cancel, { once: true })
          })
          let result: unknown
          try {
            result = await Promise.race([detectedElectronHost!.request(path, bridgeInit), aborted])
            signal?.throwIfAborted()
          } finally {
            if (cancel) signal?.removeEventListener('abort', cancel)
          }
          const value = unwrapElectronResult<unknown>(result)
          if (isRecord(value) && value.__proxyBinary === true && value.body instanceof ArrayBuffer) {
            if (responseType === 'arrayBuffer') return value.body as T
            if (responseType === 'blob' || responseType === 'auto') return new Blob([value.body], { type: String(value.contentType || 'application/octet-stream') }) as T
          }
          return value as T
        }
        if (gatewaySessionError) throw gatewaySessionError
        await ensureBearerSession()
        if (!session?.access_token) throw createSdkError('APP_SESSION_UNAVAILABLE', 'App data-plane session is not ready')
        const requestId = generateRequestId()
        // Keep the trace ID and operation idempotency key independent. The
        // gateway intentionally treats X-Request-ID as a trace value, while
        // Idempotency-Key identifies a write operation across retries.
        const idempotencyKey = generateRequestId()
        const { responseType = 'auto', ...fetchInit } = init
        let sentToken = ''
        const request = () => {
          sentToken = session?.access_token || ''
          const headers = new Headers(init.headers)
          headers.set('Authorization', `${session!.token_type || 'Bearer'} ${sentToken}`)
          if (session?.app_version) headers.set('X-App-Version', session.app_version)
          if (!headers.has('X-Request-ID')) headers.set('X-Request-ID', requestId)
          if ((init.method || 'GET').toUpperCase() !== 'GET' && !headers.has('Idempotency-Key')) headers.set('Idempotency-Key', idempotencyKey)
          if (!headers.has('Content-Type') && shouldDefaultJsonContentType(init.body)) headers.set('Content-Type', 'application/json')
          // App API paths are relative to the App Session's Gateway URL.
          const requestInit: RequestInit = { ...fetchInit, headers, credentials: 'omit', redirect: 'error' }
          return fetch(`${gatewayBase()}${path}`, requestInit)
        }
        let response = await request()
        if (localDevelopment) assertLocalRuntimeResponse(response, requestId)
        if (response.status === 401) {
          const body = await readErrorBody(response.clone())
          if (isGatewaySessionExpired(response, body)) {
            await refreshSession()
            response = await request()
          } else if (await waitForSessionRotation(sentToken)) {
            response = await request()
          }
        }
        if (!response.ok) {
          const body = await readErrorBody(response)
          throw createApiError(response, body, requestId)
        }
        const value = attachResponseRequestId(await decodeResponse(response, responseType), response, requestId) as T
        return value
      },
      stream: async function* <T = unknown>(path: string, init: RequestInit = {}): AsyncGenerator<AppApiStreamEvent<T>> {
        // As with ordinary API requests, the allowlist must run before IPC;
        // otherwise an Electron host can become an Admin Runtime transport.
        if (!isAllowedAppRoute(path, init.method || 'GET', true)) {
          throw createSdkError('APP_API_PATH_NOT_ALLOWED', 'App streaming path is not allowed')
        }
        if (electronRuntime) {
          if (!detectedElectronHost?.stream) throw createSdkError('APP_ELECTRON_STREAM_UNAVAILABLE', 'Electron host streaming is not available in this shell')
          const { signal, ...requestInit } = init
          signal?.throwIfAborted()
          let normalized = requestInit
          if (init.body && typeof init.body !== 'string' && !(init.body instanceof ArrayBuffer)) {
            const encoded = new Request('http://proxy-app.invalid', { method: init.method || 'GET', headers: init.headers, body: init.body })
            normalized = { ...requestInit, body: await encoded.arrayBuffer(), headers: encoded.headers }
          }
          signal?.throwIfAborted()
          const streamId = generateRequestId()
          const bridgeInit = { ...normalized, __proxyStreamId: streamId, headers: Array.from(new Headers(normalized.headers || {}).entries()) }
          const iterator = detectedElectronHost.stream(path, bridgeInit)[Symbol.asyncIterator]()
          let cancel: (() => void) | undefined
          const aborted = new Promise<never>((_, reject) => {
            if (!signal) return
            cancel = () => {
              void Promise.resolve(detectedElectronHost.cancelStream?.(streamId)).catch(() => {})
              reject(signal.reason ?? new DOMException('Aborted', 'AbortError'))
            }
            signal.addEventListener('abort', cancel, { once: true })
          })
          // A caller may abort while processing a yielded event.
          void aborted.catch(() => {})
          try {
            while (true) {
              signal?.throwIfAborted()
              const next = await Promise.race([iterator.next(), aborted])
              signal?.throwIfAborted()
              if (next.done) break
              yield unwrapElectronResult<AppApiStreamEvent<T>>(next.value)
            }
          } finally {
            if (cancel) signal?.removeEventListener('abort', cancel)
            // An async generator queues return() behind a pending next(). The
            // side channel closes its port first and wakes that pending read.
            await detectedElectronHost.cancelStream?.(streamId)
            const closed = iterator.return?.()
            if (signal?.aborted && !detectedElectronHost.cancelStream) {
              // Older hosts cannot cancel a pending bridge read. Do not hang
              // the caller or interpret local cancellation as a server result.
              void Promise.resolve(closed).catch(() => {})
            } else await closed
          }
          return
        }
        if (gatewaySessionError) throw gatewaySessionError
        await ensureBearerSession()
        if (!session?.access_token) throw createSdkError('APP_SESSION_UNAVAILABLE', 'App data-plane session is not ready')
        const requestId = generateRequestId()
        const idempotencyKey = generateRequestId()
        let sentToken = ''
        const request = () => {
          sentToken = session?.access_token || ''
          const headers = new Headers(init.headers)
          headers.set('Accept', 'text/event-stream')
          headers.set('Authorization', `${session!.token_type || 'Bearer'} ${sentToken}`)
          if (session?.app_version) headers.set('X-App-Version', session.app_version)
          if (!headers.has('X-Request-ID')) headers.set('X-Request-ID', requestId)
          if ((init.method || 'GET').toUpperCase() !== 'GET' && !headers.has('Idempotency-Key')) headers.set('Idempotency-Key', idempotencyKey)
          if (!headers.has('Content-Type') && shouldDefaultJsonContentType(init.body)) headers.set('Content-Type', 'application/json')
          const requestInit: RequestInit = { ...init, headers, credentials: 'omit', redirect: 'error' }
          return fetch(`${gatewayBase()}${path}`, requestInit)
        }
        let response = await request()
        if (localDevelopment) assertLocalRuntimeResponse(response, requestId)
        if (response.status === 401) {
          const body = await readErrorBody(response.clone())
          if (isGatewaySessionExpired(response, body)) {
            await refreshSession()
            response = await request()
          } else if (await waitForSessionRotation(sentToken)) {
            // A concurrent refresh may revoke the bearer after the stream
            // request was sent. Retry only with the confirmed replacement;
            // generic 401 responses without a rotation remain terminal.
            response = await request()
          }
        }
        if (!response.ok) {
          const body = await readErrorBody(response)
          throw createApiError(response, body, requestId)
        }
        if (!response.body) {
          throw new AppSdkError(
            'APP_API_EMPTY_STREAM',
            'App API stream response has no body',
            responseRequestId(response, requestId),
            response.status,
          )
        }

        const reader = response.body.getReader()
        const decoder = new TextDecoder()
        let buffer = ''
        let eventName: string | undefined
        let dataLines: string[] = []
        let streamDone = false
        const flush = (): AppApiStreamEvent<T> | undefined => {
          if (!dataLines.length) return undefined
          const rawData = dataLines.join('\n')
          dataLines = []
          const currentEvent = eventName
          eventName = undefined
          if (rawData === '[DONE]') {
            streamDone = true
            return undefined
          }
          let data: T
          try { data = JSON.parse(rawData) as T } catch { data = rawData as T }
          return { event: currentEvent, data }
        }

        try {
          while (!streamDone) {
            const chunk = await reader.read()
            buffer += decoder.decode(chunk.value || new Uint8Array(), { stream: !chunk.done })
            const lines = buffer.split(/\r?\n/)
            buffer = lines.pop() || ''
            for (const line of lines) {
              if (line === '') {
                const event = flush()
                if (event) yield event
                if (streamDone) break
              } else if (line.startsWith('event:')) {
                eventName = line.slice(6).trim()
              } else if (line.startsWith('data:')) {
                dataLines.push(line.slice(5).trimStart())
              }
            }
            if (chunk.done) break
          }
          if (!streamDone) {
            if (buffer.startsWith('data:')) dataLines.push(buffer.slice(5).trimStart())
            else if (buffer.startsWith('event:')) eventName = buffer.slice(6).trim()
            const event = flush()
            if (event) yield event
          }
        } finally {
          await reader.cancel().catch(() => undefined)
        }
      },
    },
  }
}
