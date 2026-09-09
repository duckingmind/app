import { AppSdkError } from './types.js'
import type { AppApiRequestInit, AppApiResponseType, AppApiStreamEvent, AppClientOptions, AppProfile, AppSession, BridgeRequest, BridgeResponse, HostChallengeMessage, HostReadyMessage, HostReadyRequest, LocalLoginDetails, LocalLoginFailureMessage, SessionRefreshRequest, SessionRefreshResponse } from './types.js'
export { AppSdkError }
export type { AppApiRequestInit, AppApiResponseType, AppApiStreamEvent, AppClientOptions, AppProfile, AppSession, BridgeRequest, BridgeResponse, HostChallengeMessage, HostReadyMessage, HostReadyRequest, LocalLoginDetails, LocalLoginFailureMessage, SessionRefreshRequest, SessionRefreshResponse } from './types.js'

type PendingCall = {
  resolve: (value: any) => void
  reject: (error: Error) => void
  timer: number
}

type SessionWaiter = {
  requestId: string
  previousToken?: string
  resolve: (value: AppSession) => void
  reject: (error: Error) => void
  timer: number
}

type ChallengeWaiter = {
  resolve: (challenge: string) => void
  reject: (error: Error) => void
  timer: number
}

const BRIDGE_PROTOCOL = 'proxy-app/v1'
const APP_ID_PATTERN = /^[a-z0-9]+(?:[.-][a-z0-9]+)+(?:[.-][a-z0-9]+)*$/
const APP_TASK_ID_PATTERN = '[A-Za-z0-9][A-Za-z0-9._:-]{0,127}'
const APP_API_ROUTES: Array<{ method: string; pattern: RegExp }> = [
  { method: 'GET', pattern: /^\/models$/ },
  { method: 'GET', pattern: /^\/images\/models$/ },
  { method: 'GET', pattern: /^\/videos\/models$/ },
  { method: 'GET', pattern: /^\/music\/models$/ },
  { method: 'POST', pattern: /^\/responses$/ },
  { method: 'POST', pattern: /^\/responses\/compact$/ },
  { method: 'POST', pattern: /^\/responses\/stream$/ },
  { method: 'POST', pattern: /^\/chat\/completions$/ },
  { method: 'POST', pattern: /^\/embeddings$/ },
  { method: 'POST', pattern: /^\/messages$/ },
  { method: 'POST', pattern: /^\/messages\/count_tokens$/ },
  { method: 'POST', pattern: /^\/images\/generations$/ },
  { method: 'POST', pattern: /^\/images\/edits$/ },
  { method: 'GET', pattern: new RegExp(`^\\/images\\/tasks\\/${APP_TASK_ID_PATTERN}$`) },
  { method: 'POST', pattern: /^\/videos$/ },
  { method: 'GET', pattern: new RegExp(`^\\/videos\\/${APP_TASK_ID_PATTERN}$`) },
  { method: 'GET', pattern: new RegExp(`^\\/videos\\/${APP_TASK_ID_PATTERN}\\/content$`) },
  { method: 'DELETE', pattern: new RegExp(`^\\/videos\\/${APP_TASK_ID_PATTERN}$`) },
  { method: 'POST', pattern: /^\/music\/generations$/ },
  { method: 'GET', pattern: new RegExp(`^\\/music\\/tasks\\/${APP_TASK_ID_PATTERN}$`) },
  { method: 'GET', pattern: new RegExp(`^\\/music\\/tasks\\/${APP_TASK_ID_PATTERN}\\/content$`) },
  { method: 'DELETE', pattern: new RegExp(`^\\/music\\/tasks\\/${APP_TASK_ID_PATTERN}$`) },
]
const APP_STREAM_ROUTES = [
  { method: 'POST', pattern: /^\/responses\/stream$/ },
  { method: 'POST', pattern: /^\/chat\/completions$/ },
  { method: 'POST', pattern: /^\/messages$/ },
]

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
  const routes = streaming ? APP_STREAM_ROUTES : APP_API_ROUTES
  const normalizedMethod = (method || 'GET').toUpperCase()
  return routes.some((route) => route.method === normalizedMethod && route.pattern.test(pathname))
}

function resolveTargetOrigin(explicit?: string) {
  if (explicit) return explicit
  try {
    if (typeof document !== 'undefined' && document.referrer) {
      const origin = new URL(document.referrer).origin
      if (origin && origin !== 'null') return origin
    }
    // A sandboxed iframe may intentionally have an opaque origin and may not
    // expose a referrer. Its own location is the Vite/app origin, not the
    // embedding host, so using window.location.origin here makes every
    // challenge response target the wrong window origin. The host validates
    // event.source and the per-mount challenge, so wildcard delivery is the
    // correct fallback for this protocol case.
    if (typeof window !== 'undefined' && window.parent !== window) return '*'
    if (typeof window !== 'undefined' && window.location.origin !== 'null') return window.location.origin
  } catch {
    // Sandboxed iframes can have an opaque origin.
  }
  return '*'
}

function generateRequestId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return `req_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`
}

function generateRuntimeId() {
  return generateRequestId().replace(/^req_/, 'runtime_')
}

function generateBridgeChallenge() {
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    const bytes = new Uint8Array(32)
    crypto.getRandomValues(bytes)
    return Array.from(bytes, value => value.toString(16).padStart(2, '0')).join('')
  }
  // Older WebViews may not expose getRandomValues. The request id still uses
  // crypto.randomUUID when available and is only a compatibility fallback;
  // the host also binds the challenge to the first iframe load.
  return `${generateRequestId()}-${generateRequestId()}`
}

function createSdkError(code: string, message: string, requestId?: string, status?: number, details?: unknown) {
  const error = new AppSdkError(code, message, requestId, status, details)
  return error
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null
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

function parseApiErrorBody(body: unknown): ParsedApiError {
  if (typeof body === 'string') return { message: body.trim() || undefined }
  if (!isRecord(body)) return {}

  const errorValue = body.error
  const nested = isRecord(errorValue) ? errorValue : undefined
  const message = nested?.message || (typeof errorValue === 'string' ? errorValue : undefined) || body.message
  const code = nested?.code || body.code
  const requestId = nested?.request_id || nested?.requestId || body.request_id || body.requestId
  return {
    code: typeof code === 'string' && code.trim() ? code.trim() : undefined,
    message: typeof message === 'string' && message.trim() ? message.trim() : undefined,
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
  return new AppSdkError(
    parsed.code || 'APP_API_ERROR',
    parsed.message || `App API request failed (${response.status})`,
    requestId,
    response.status,
    body,
  )
}

function isRuntimeSessionExpired(response: Response, body: unknown) {
  if (response.status !== 401 || !isRecord(body)) return false
  const nested = isRecord(body.error) ? body.error : undefined
  const code = nested?.code || body.code
  const executionStarted = nested && Object.prototype.hasOwnProperty.call(nested, 'execution_started')
    ? nested.execution_started
    : body.execution_started
  return code === 'APP_SESSION_EXPIRED' && executionStarted === false
}

function isGatewaySessionExpired(response: Response, body: unknown) {
  if (response.status !== 401 || !isRecord(body)) return false
  const nested = isRecord(body.error) ? body.error : undefined
  const reason = nested?.auth_reason || body.auth_reason
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

export function createAppClient(appId: string, options: AppClientOptions = {}) {
  if (!APP_ID_PATTERN.test(appId)) throw new AppSdkError('APP_INVALID_ID', 'appId must be a lowercase reverse-domain identifier')
  const standaloneLocal = typeof window !== 'undefined' && window.parent === window && ['localhost', '127.0.0.1', '::1'].includes(window.location.hostname)
  const runtime = options.runtime || (options.localDevelopment ? 'local' : (standaloneLocal ? 'local' : 'embedded'))
  const localDevelopment = runtime === 'local'
  const directRuntime = runtime === 'direct'
  const localGatewayPath = options.localGatewayPath || '/v1'
  const runtimeBasePath = (localDevelopment ? options.localRuntimePath : options.runtimeBasePath) || '/api/app-runtime/v1'
  const localBridgePath = options.localBridgePath || '/__platform/bridge'
  const localAuthBasePath = options.localBridgePath ? '/__platform/auth' : `${runtimeBasePath.replace(/\/$/, '')}/auth`
  const localAuthPath = options.localAuthPath || `${localAuthBasePath}/start`
  const localAuthStatusPath = options.localAuthStatusPath || localAuthPath.replace(/\/start\/?$/, '/status')
  const localLogoutPath = options.localLogoutPath || `${localAuthBasePath}/logout`
  const targetWindow = options.targetWindow || window.parent
  const targetOrigin = resolveTargetOrigin(options.targetOrigin)
  const timeoutMs = options.timeoutMs ?? 10000
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new AppSdkError('APP_INVALID_TIMEOUT', 'timeoutMs must be a positive number')
  const pending = new Map<string, PendingCall>()
  const runtimeId = generateRuntimeId()
  // The host sends this value only after the iframe's first load. It is kept
  // in memory and echoed on every bridge message so a later opaque-origin
  // document cannot impersonate the original app window.
  let bridgeChallenge: string | null = null
  let hostReady = false
  let session: AppSession | null = null
  const sessionWaiters = new Set<SessionWaiter>()
  const challengeWaiters = new Set<ChallengeWaiter>()
  let refreshPromise: Promise<AppSession> | null = null
  let localLoginPromise: Promise<void> | null = null
  let pendingLocalLogin: LocalLoginDetails | null = null

  if (localDevelopment) {
    session = {
      access_token: '',
      token_type: 'Bearer',
      expires_in: 900,
      gateway_url: localGatewayPath.replace(/\/$/, ''),
      app_id: appId,
      app_slug: appId,
      app_version: options.localAppVersion || 'local',
      scopes: [],
    }
    hostReady = true
  } else if (directRuntime) {
    if (!options.appSession?.access_token?.startsWith('ast_') || !options.appSession.gateway_url) {
      throw new AppSdkError('APP_SESSION_UNAVAILABLE', 'direct runtime requires a user App Session from OAuth')
    }
    session = options.appSession
    hostReady = true
  }

  const cleanup = () => {
    for (const [requestId, call] of pending) {
      window.clearTimeout(call.timer)
      call.reject(createSdkError('APP_BRIDGE_DISCONNECTED', `App bridge disconnected: ${requestId}`, requestId))
      pending.delete(requestId)
    }
    for (const waiter of sessionWaiters) {
      window.clearTimeout(waiter.timer)
      waiter.reject(createSdkError('APP_BRIDGE_DISCONNECTED', 'App bridge disconnected'))
    }
    sessionWaiters.clear()
    for (const waiter of challengeWaiters) {
      window.clearTimeout(waiter.timer)
      waiter.reject(createSdkError('APP_BRIDGE_DISCONNECTED', 'App bridge disconnected'))
    }
    challengeWaiters.clear()
  }

  const waitForChallenge = (): Promise<string> => {
    if (bridgeChallenge) return Promise.resolve(bridgeChallenge)
    return new Promise<string>((resolve, reject) => {
      const waiter: ChallengeWaiter = {
        resolve,
        reject,
        timer: window.setTimeout(() => {
          challengeWaiters.delete(waiter)
          reject(createSdkError('APP_BRIDGE_TIMEOUT', 'App host challenge timed out'))
        }, timeoutMs),
      }
      challengeWaiters.add(waiter)
    })
  }

  const post = (message: BridgeRequest) => {
    targetWindow.postMessage(message, targetOrigin)
  }

  const ensureLocalLogin = async (details?: LocalLoginDetails, userInitiated = false, forcePortalLogin = false) => {
    if (localLoginPromise) return localLoginPromise
    localLoginPromise = (async () => {
      let popup: Window | null = userInitiated ? window.open('about:blank', 'proxy-app-login', 'popup,width=480,height=720') : null
      let cancelLogin: (error: unknown) => void = () => undefined
      let loginResult: Promise<void> | null = null
      try {
        let loginDetails = details?.login_url ? details : pendingLocalLogin
        if (!loginDetails?.login_url) {
          const start = await fetch(localAuthPath, { headers: { Accept: 'application/json' } })
          const body = await start.json().catch(() => ({}))
          if (!start.ok) throw createApiError(start, body, generateRequestId())
          loginDetails = (body && Object.prototype.hasOwnProperty.call(body, 'data') ? body.data : body) as LocalLoginDetails
        }
        if (!loginDetails?.login_url || !loginDetails.auth_state) {
          throw createSdkError('APP_LOGIN_REQUIRED', '请登录平台账户后继续')
        }
        pendingLocalLogin = loginDetails
        const state = loginDetails.auth_state
        // The callback document is served by the loopback relay, not by the
        // Portal origin contained in login_url. Validate the postMessage
        // against the relay origin so OAuth completion can wake the app.
        const loginOrigin = new URL(loginDetails.relay_url || loginDetails.login_url).origin
        loginResult = new Promise<void>((resolve, reject) => {
          let settled = false
          let pollTimer: number | null = null
          const finish = () => {
            if (settled) return
            settled = true
            if (pollTimer !== null) window.clearInterval(pollTimer)
            resolve()
          }
          const fail = (error: unknown) => {
            if (settled) return
            settled = true
            if (pollTimer !== null) window.clearInterval(pollTimer)
            reject(error)
          }
          cancelLogin = fail
          const timer = window.setTimeout(() => {
            window.removeEventListener('message', onMessage)
            try { popup?.close() } catch {}
            fail(createSdkError('APP_LOGIN_TIMEOUT', '平台登录超时，请重试', undefined, undefined, loginDetails))
          }, 5 * 60 * 1000)
          const onMessage = (event: MessageEvent) => {
            if (event.origin !== loginOrigin) return
            const message = event.data
            if (!message || message.protocol !== 'proxy-app/auth/v1' || message.state !== state) return
            window.clearTimeout(timer)
            window.removeEventListener('message', onMessage)
            if (message.type === 'login-complete') {
              pendingLocalLogin = null
              finish()
              return
            }
            if (message.type === 'login-failed') {
              const failure = message as LocalLoginFailureMessage
              fail(createSdkError(
                failure.error?.code || 'APP_LOGIN_FAILED',
                failure.error?.message || '平台登录失败，请重试。',
                failure.error?.request_id,
                failure.error?.status,
                { stage: failure.error?.stage || 'login', upstream_code: failure.error?.upstream_code, ...loginDetails },
              ))
            }
          }
          window.addEventListener('message', onMessage)
          // Some browsers isolate popup opener references or discard the
          // callback document before postMessage is delivered. The relay is
          // authoritative, so poll its same-origin status endpoint as a
          // recovery path. This also covers a callback completed in another
          // tab or after the app was refreshed.
          const pollStatus = async () => {
            if (settled) return
            try {
              const statusResponse = await fetch(localAuthStatusPath, { headers: { Accept: 'application/json' }, cache: 'no-store' })
              if (!statusResponse.ok) return
              const statusBody = await statusResponse.json().catch(() => ({}))
              const status = statusBody?.data || statusBody
              if (status?.authenticated === true) {
                pendingLocalLogin = null
                window.clearTimeout(timer)
                window.removeEventListener('message', onMessage)
                finish()
              }
            } catch {
              // The callback message remains the primary fast path; a
              // transient status request failure should not fail login.
            }
          }
          pollTimer = window.setInterval(() => { void pollStatus() }, 1000)
          options.onLoginRequired?.(loginDetails)
        })
        const loginURL = new URL(loginDetails.login_url)
        if (forcePortalLogin || userInitiated) loginURL.searchParams.set('proxy_app_force_login', '1')
        if (popup) popup.location.replace(loginURL.toString())
        else {
          popup = window.open(loginURL.toString(), 'proxy-app-login', 'popup,width=480,height=720')
          if (!popup) {
            const popupError = createSdkError(
              'APP_LOGIN_POPUP_BLOCKED',
              '浏览器阻止了登录窗口，请点击“登录平台”后重试。',
              undefined,
              undefined,
              loginDetails,
            )
            cancelLogin(popupError)
            throw popupError
          }
        }
        await loginResult
      } catch (error) {
        cancelLogin(error)
        await loginResult?.catch(() => undefined)
        try { popup?.close() } catch {}
        throw error
      }
    })().finally(() => { localLoginPromise = null })
    return localLoginPromise
  }

  const localLoginRequired = async (response: Response, requestId: string) => {
    if (response.status !== 401) return false
    const body = await readErrorBody(response.clone())
    const parsed = parseApiErrorBody(body)
    if (parsed.code !== 'APP_LOGIN_REQUIRED') return false
    const details = isRecord(body) ? body as { login_url?: string; auth_state?: string; relay_url?: string } : undefined
    // The relay may have rejected an expired Portal token. Force the Portal
    // login page to show the form instead of auto-submitting that same stale
    // token back to the relay and looping forever.
    await ensureLocalLogin(details, false, true)
    return true
  }

  const login = async () => {
    if (!localDevelopment) throw createSdkError('APP_LOGIN_UNAVAILABLE', directRuntime ? '请通过平台 OAuth 获取 App Session' : '登录由平台宿主管理')
    await ensureLocalLogin(undefined, true)
  }

  const logout = async () => {
    if (!localDevelopment) return
    const response = await fetch(localLogoutPath, { method: 'POST', headers: { Accept: 'application/json' } })
    const body = await response.json().catch(() => ({}))
    if (!response.ok) throw createApiError(response, body, generateRequestId())
    session = {
      access_token: '',
      token_type: 'Bearer',
      expires_in: 900,
      gateway_url: localGatewayPath.replace(/\/$/, ''),
      app_id: appId,
      app_slug: appId,
      app_version: options.localAppVersion || 'local',
      scopes: [],
    }
    pendingLocalLogin = null
  }

  const httpCall = async <T>(method: string, payload?: unknown): Promise<T> => {
    const input = isRecord(payload) ? payload : {}
    let path: string
    let httpMethod = 'GET'
    let body: string | undefined
    switch (method) {
      case 'user.profile.read': path = '/profile'; break
      case 'platform.capabilities.list': path = '/capabilities'; break
      case 'theme.read': path = '/preferences?kind=theme'; break
      case 'locale.read': path = '/preferences?kind=locale'; break
      case 'storage.user.get':
      case 'storage.user.set':
      case 'storage.user.delete':
        if (typeof input.key !== 'string' || !input.key.trim()) throw createSdkError('APP_STORAGE_INVALID_KEY', 'Storage key must be a non-empty string')
        path = `/storage/items?${new URLSearchParams({ key: input.key })}`
        if (method === 'storage.user.set') { httpMethod = 'PUT'; body = JSON.stringify({ value: input.value }) }
        if (method === 'storage.user.delete') httpMethod = 'DELETE'
        break
      default:
        throw createSdkError('APP_RUNTIME_METHOD_NOT_SUPPORTED', `App HTTP runtime does not support ${method}`)
    }
    const requestId = generateRequestId()
    const idempotencyKey = generateRequestId()
    const request = () => {
      const headers = new Headers({ Accept: 'application/json', 'X-Request-ID': requestId })
      if (session?.access_token) headers.set('Authorization', `${session.token_type || 'Bearer'} ${session.access_token}`)
      if (session?.app_version) headers.set('X-App-Version', session.app_version)
      if (body !== undefined) headers.set('Content-Type', 'application/json')
      if (httpMethod !== 'GET') headers.set('Idempotency-Key', idempotencyKey)
      return fetch(`${runtimeBasePath.replace(/\/$/, '')}${path}`, { method: httpMethod, headers, body })
    }
    let response = await request()
    if (localDevelopment) assertLocalRuntimeResponse(response, requestId)
    if (localDevelopment && await localLoginRequired(response, requestId)) {
      response = await request()
      assertLocalRuntimeResponse(response, requestId)
    } else if (directRuntime && response.status === 401) {
      const body = await readErrorBody(response.clone())
      if (isRuntimeSessionExpired(response, body)) {
        await refreshSession()
        response = await request()
      }
    }
    const result = await response.json().catch(() => null)
    if (!response.ok) throw createApiError(response, result, requestId)
    const value = isRecord(result) && Object.prototype.hasOwnProperty.call(result, 'data') ? result.data : result
    const preference = isRecord(value) ? value : {}
    if (method === 'theme.read') return { mode: preference.mode || 'system' } as T
    if (method === 'locale.read') return { locale: preference.locale || 'en-US' } as T
    return value as T
  }

  const call = async <T>(method: string, payload?: unknown): Promise<T> => {
    if (directRuntime || (localDevelopment && !options.localBridgePath)) return httpCall<T>(method, payload)
    if (localDevelopment) {
      const requestId = generateRequestId()
      let response = await fetch(localBridgePath, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
        body: JSON.stringify({ protocol: BRIDGE_PROTOCOL, requestId, appId, runtimeId, method, payload }),
      })
      assertLocalRuntimeResponse(response, requestId)
      if (await localLoginRequired(response, requestId)) {
        response = await fetch(localBridgePath, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
          body: JSON.stringify({ protocol: BRIDGE_PROTOCOL, requestId, appId, runtimeId, method, payload }),
        })
        assertLocalRuntimeResponse(response, requestId)
      }
      const body = await response.json().catch(() => ({}))
      if (!response.ok || body?.error) {
        const parsed = parseApiErrorBody(body)
        throw new AppSdkError(parsed.code || 'APP_BRIDGE_ERROR', parsed.message || `Bridge request failed (${response.status})`, parsed.requestId || requestId, response.status, body)
      }
      return (body && Object.prototype.hasOwnProperty.call(body, 'data') ? body.data : body.value) as T
    }
    const challenge = await waitForChallenge()
    const requestId = generateRequestId()
    const request: BridgeRequest = {
      protocol: BRIDGE_PROTOCOL,
      requestId,
      appId,
      runtimeId,
      challenge,
      method,
      payload,
    }
    return await new Promise<T>((resolve, reject) => {
      const timer = window.setTimeout(() => {
        pending.delete(requestId)
        reject(createSdkError('APP_BRIDGE_TIMEOUT', `Bridge request timed out: ${method}`, requestId))
      }, timeoutMs)
      pending.set(requestId, { resolve, reject, timer })
      post(request)
    })
  }

  const handleMessage = (event: MessageEvent<BridgeResponse | HostChallengeMessage | HostReadyMessage | SessionRefreshResponse>) => {
    if (event.source !== targetWindow) return
    if (targetOrigin !== '*' && event.origin !== targetOrigin) return
    const message = event.data
    if (!message || message.protocol !== BRIDGE_PROTOCOL) return
    if ('type' in message && message.type === 'host-challenge' && message.appId === appId) {
      if (typeof message.challenge !== 'string' || message.challenge.length < 32) return
      bridgeChallenge = message.challenge
      for (const waiter of challengeWaiters) {
        window.clearTimeout(waiter.timer)
        waiter.resolve(bridgeChallenge)
        challengeWaiters.delete(waiter)
      }
      requestHostReady()
      return
    }
    if (!bridgeChallenge || !('challenge' in message) || message.challenge !== bridgeChallenge) return
    if ('type' in message && message.type === 'host-ready' && message.appId === appId) {
      hostReady = true
      if (message.session) session = message.session
      if (message.session) {
        for (const waiter of sessionWaiters) {
          if (waiter.previousToken && waiter.previousToken === message.session.access_token) continue
          window.clearTimeout(waiter.timer)
          waiter.resolve(message.session)
          sessionWaiters.delete(waiter)
        }
      }
      options.onHostReady?.()
      return
    }
    if ('type' in message && message.type === 'session-refresh-response' && message.appId === appId) {
      if (message.ok && message.session) {
        session = message.session
        hostReady = true
        for (const waiter of sessionWaiters) {
          if (waiter.requestId !== message.requestId) continue
          window.clearTimeout(waiter.timer)
          waiter.resolve(message.session)
          sessionWaiters.delete(waiter)
          break
        }
      } else if (!message.ok) {
        for (const waiter of sessionWaiters) {
          if (waiter.requestId !== message.requestId) continue
          window.clearTimeout(waiter.timer)
          waiter.reject(createSdkError(message.error?.code || 'APP_SESSION_REFRESH_FAILED', message.error?.message || 'App session refresh failed'))
          sessionWaiters.delete(waiter)
          break
        }
      }
      return
    }
    if (!('requestId' in message) || !message.requestId) return
    if (!('value' in message)) return
    const callState = pending.get(message.requestId)
    if (!callState) return
    window.clearTimeout(callState.timer)
    pending.delete(message.requestId)
    if (message.ok) {
      callState.resolve(message.value)
      return
    }
    const code = message.error?.code || 'APP_BRIDGE_ERROR'
    const error = createSdkError(code, message.error?.message || 'Bridge request failed', message.requestId)
    callState.reject(error)
  }

  if (!localDevelopment && !directRuntime) window.addEventListener('message', handleMessage)
  window.addEventListener('beforeunload', cleanup)

  const requestHostReady = () => {
    if (!bridgeChallenge) return
    targetWindow.postMessage({
      protocol: BRIDGE_PROTOCOL,
      type: 'host-ready-request',
      appId,
      challenge: bridgeChallenge,
    } satisfies HostReadyRequest, targetOrigin)
  }

  const refreshSession = async (): Promise<AppSession> => {
    if (localDevelopment) return session!
    if (directRuntime) {
      if (!options.refreshAppSession) {
        throw createSdkError('APP_SESSION_REFRESH_UNAVAILABLE', 'direct runtime requires an OAuth session refresh function')
      }
      if (refreshPromise) return refreshPromise
      refreshPromise = options.refreshAppSession().then((nextSession) => {
        if (!nextSession?.access_token?.startsWith('ast_') || !nextSession.gateway_url) {
          throw createSdkError('APP_SESSION_INVALID', 'OAuth refresh did not return a valid user App Session')
        }
        session = nextSession
        return nextSession
      }).finally(() => {
        refreshPromise = null
      })
      return refreshPromise
    }
    if (refreshPromise) return refreshPromise
    const challenge = await waitForChallenge()
    const requestId = generateRequestId()
    const previousToken = session?.access_token
    const refreshed = new Promise<AppSession>((resolve, reject) => {
      const waiter: SessionWaiter = {
        requestId,
        previousToken,
        resolve,
        reject,
        timer: window.setTimeout(() => {
          sessionWaiters.delete(waiter)
          reject(createSdkError('APP_SESSION_REFRESH_TIMEOUT', 'App session refresh timed out'))
        }, timeoutMs),
      }
      sessionWaiters.add(waiter)
    })
    targetWindow.postMessage({
      protocol: BRIDGE_PROTOCOL,
      type: 'session-refresh-request',
      appId,
      requestId,
      challenge,
    } satisfies SessionRefreshRequest, targetOrigin)
    refreshPromise = refreshed.finally(() => {
      refreshPromise = null
    })
    return refreshPromise
  }

  if (!localDevelopment && !directRuntime) requestHostReady()

  return {
    appId,
    runtimeId,
    ready: () => hostReady,
    destroy() {
      cleanup()
      window.removeEventListener('message', handleMessage)
      window.removeEventListener('beforeunload', cleanup)
      session = null
    },
    requestHostReady,
    refreshSession,
    call,
    user: {
      getProfile: () => call<AppProfile>('user.profile.read'),
    },
    storage: {
      get: <T>(key: string) => call<T | null>('storage.user.get', { key }),
      set: (key: string, value: unknown) => call<{ success: boolean }>('storage.user.set', { key, value }),
      delete: (key: string) => call<{ success: boolean }>('storage.user.delete', { key }),
    },
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
      /** Request a fresh short-lived session from the embedding host. */
      createSession: refreshSession,
      capabilities: () => call<Array<{ method: string; scope?: string; description: string }>>('platform.capabilities.list'),
      call: <T = unknown>(method: string, payload?: unknown) => call<T>(method, payload),
    },
    auth: {
      /** Open the platform login flow from a user gesture during local development. */
      login,
      /** Clear the local relay session so another platform user can sign in. */
      logout,
    },
    session: () => session,
    api: {
      request: async <T = unknown>(path: string, init: AppApiRequestInit = {}): Promise<T> => {
        if (!session) throw createSdkError('APP_SESSION_UNAVAILABLE', 'App data-plane session is not ready')
        if (!isAllowedAppRoute(path, init.method || 'GET')) {
          throw createSdkError('APP_API_PATH_NOT_ALLOWED', 'App API path is not allowed')
        }
        const requestId = generateRequestId()
        // Keep the trace ID and operation idempotency key independent. The
        // gateway intentionally treats X-Request-ID as a trace value, while
        // Idempotency-Key identifies a write operation across retries.
        const idempotencyKey = generateRequestId()
        const { responseType = 'auto', ...fetchInit } = init
        const request = () => {
          const headers = new Headers(init.headers)
          headers.set('Authorization', `${session?.token_type || 'Bearer'} ${session?.access_token || ''}`)
          headers.set('X-App-Version', session?.app_version || '')
          if (!headers.has('X-Request-ID')) headers.set('X-Request-ID', requestId)
          if ((init.method || 'GET').toUpperCase() !== 'GET' && !headers.has('Idempotency-Key')) headers.set('Idempotency-Key', idempotencyKey)
          if (!headers.has('Content-Type') && shouldDefaultJsonContentType(init.body)) headers.set('Content-Type', 'application/json')
          return fetch(`${session?.gateway_url.replace(/\/$/, '') || ''}${path}`, { ...fetchInit, headers })
        }
        let response = await request()
        if (localDevelopment) assertLocalRuntimeResponse(response, requestId)
        if (localDevelopment && await localLoginRequired(response, requestId)) {
          response = await request()
        } else if (!localDevelopment && response.status === 401) {
          const body = await readErrorBody(response.clone())
          if (isGatewaySessionExpired(response, body)) {
            await refreshSession()
            response = await request()
          }
        }
        if (!response.ok) {
          const body = await readErrorBody(response)
          throw createApiError(response, body, requestId)
        }
        return await decodeResponse(response, responseType) as T
      },
      stream: async function* <T = unknown>(path: string, init: RequestInit = {}): AsyncGenerator<AppApiStreamEvent<T>> {
        if (!session) throw createSdkError('APP_SESSION_UNAVAILABLE', 'App data-plane session is not ready')
        if (!isAllowedAppRoute(path, init.method || 'GET', true)) {
          throw createSdkError('APP_API_PATH_NOT_ALLOWED', 'App streaming path is not allowed')
        }
        const requestId = generateRequestId()
        const idempotencyKey = generateRequestId()
        const request = () => {
          const headers = new Headers(init.headers)
          headers.set('Accept', 'text/event-stream')
          headers.set('Authorization', `${session?.token_type || 'Bearer'} ${session?.access_token || ''}`)
          headers.set('X-App-Version', session?.app_version || '')
          if (!headers.has('X-Request-ID')) headers.set('X-Request-ID', requestId)
          if ((init.method || 'GET').toUpperCase() !== 'GET' && !headers.has('Idempotency-Key')) headers.set('Idempotency-Key', idempotencyKey)
          if (!headers.has('Content-Type') && shouldDefaultJsonContentType(init.body)) headers.set('Content-Type', 'application/json')
          return fetch(`${session?.gateway_url.replace(/\/$/, '') || ''}${path}`, { ...init, headers })
        }
        let response = await request()
        if (localDevelopment) assertLocalRuntimeResponse(response, requestId)
        if (localDevelopment && await localLoginRequired(response, requestId)) {
          response = await request()
        } else if (!localDevelopment && response.status === 401) {
          const body = await readErrorBody(response.clone())
          if (isGatewaySessionExpired(response, body)) {
            await refreshSession()
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
