import { AppSdkError } from './types.js'
import { agent } from './agent.js'
export { agent, createAgentBridge, dispatchAgentInvocation } from './agent.js'
export type { AgentAccess, AgentTarget, AgentEnvironment, AgentBridge, AgentCapabilityDeclaration, AgentContractMetadata, AgentCapabilityRegistration, AgentHandler, AgentInvocationContext, AgentRuntimeRegistration, AgentRuntimeStatus, AgentNextAction } from './agent.js'
import type { AppApiRequestInit, AppApiResponseType, AppApiStreamEvent, AppAuthStatus, AppClientOptions, AppProfile, AppSession, ElectronHostBridge, LocalLoginDetails, LocalLoginFailureMessage, LocalLoginOptions, StorageBatchOperation, StorageEntry, StorageEntryAuthor, StorageListOptions, StorageListResult, StorageOperationOptions, StorageWriteOptions, WorkspaceStorage } from './types.js'
export { AppSdkError }
export type { AppApiRequestInit, AppApiResponseType, AppApiStreamEvent, AppAuthStatus, AppClientOptions, AppProfile, AppSession, ElectronHostBridge, LocalLoginDetails, LocalLoginFailureMessage, LocalLoginOptions, StorageBatchOperation, StorageEntry, StorageEntryAuthor, StorageListOptions, StorageListResult, StorageOperationOptions, StorageWriteOptions, WorkspaceStorage } from './types.js'

const PLATFORM_APP_ID_PATTERN = /^app_[a-z0-9][a-z0-9._-]{2,119}$/
const PUBLIC_APP_SLUG_PATTERN = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/
const validPublicAppSlug = (value: unknown): value is string =>
  typeof value === 'string' && value.length <= 120 && value === value.trim() && PUBLIC_APP_SLUG_PATTERN.test(value)
// Keep historical server IDs readable, but do not widen this validator to
// bare public slugs. A new slug still has to resolve to a server-owned ID.
const SERVER_APP_ID_PATTERN = /^(?:app_[a-z0-9][a-z0-9._-]{2,119}|[a-z0-9]+(?:[.-][a-z0-9]+)+)$/
const SERVER_SESSION_CHECK_AGE_MS = 60_000
const APP_SESSION_DEFAULT_TTL_SECONDS = 30 * 24 * 60 * 60
const SERVER_REFRESH_RETRY_MS = [1_000, 3_000, 10_000, 30_000]
const PORTAL_AUTH_CHANGE_KEY = 'proxy-app:auth-change'
const GATEWAY_SESSION_STORAGE_PREFIX = 'proxy-app:gateway-session:'
let runtimeCookieFlight: Promise<unknown> = Promise.resolve()
async function withRuntimeCookieLock<T>(operation: () => Promise<T>): Promise<T> {
  if (typeof navigator !== 'undefined' && navigator.locks?.request) {
    return await navigator.locks.request('proxy-app:runtime-session', operation)
  }
  // Older browsers still serialize clients in this document. Server-side
  // expected-account checks remain the authority across other documents.
  const flight = runtimeCookieFlight.catch(() => undefined).then(operation)
  runtimeCookieFlight = flight.then(() => undefined, () => undefined)
  return flight
}
const APP_TASK_ID_PATTERN = '[A-Za-z0-9][A-Za-z0-9._:-]{0,127}'
const APP_API_ROUTES: Array<{ method: string; pattern: RegExp }> = [
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
  { method: 'POST', pattern: /^\/media\/assets$/ },
  { method: 'GET', pattern: new RegExp(`^\\/media\\/assets\\/${APP_TASK_ID_PATTERN}$`) },
  { method: 'PATCH', pattern: new RegExp(`^\\/media\\/assets\\/${APP_TASK_ID_PATTERN}$`) },
  { method: 'DELETE', pattern: new RegExp(`^\\/media\\/assets\\/${APP_TASK_ID_PATTERN}$`) },
  { method: 'GET', pattern: /^\/videos\/models$/ },
  { method: 'GET', pattern: /^\/music\/models$/ },
  { method: 'GET', pattern: /^\/voice-design\/models$/ },
  { method: 'GET', pattern: /^\/tts\/models$/ },
  { method: 'POST', pattern: /^\/responses$/ },
  { method: 'POST', pattern: /^\/responses\/compact$/ },
  { method: 'POST', pattern: /^\/responses\/stream$/ },
  { method: 'POST', pattern: /^\/chat\/completions$/ },
  { method: 'POST', pattern: /^\/embeddings$/ },
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
  { method: 'GET', pattern: new RegExp(`^\\/videos\\/${APP_TASK_ID_PATTERN}\\/content$`) },
  { method: 'DELETE', pattern: new RegExp(`^\\/videos\\/${APP_TASK_ID_PATTERN}$`) },
  { method: 'POST', pattern: /^\/music\/generations$/ },
  { method: 'GET', pattern: new RegExp(`^/music/by-idempotency-key/${APP_TASK_ID_PATTERN}$`) },
  { method: 'GET', pattern: new RegExp(`^\\/music\\/tasks\\/${APP_TASK_ID_PATTERN}$`) },
  { method: 'GET', pattern: new RegExp(`^\\/music\\/tasks\\/${APP_TASK_ID_PATTERN}\\/content$`) },
  { method: 'DELETE', pattern: new RegExp(`^\\/music\\/tasks\\/${APP_TASK_ID_PATTERN}$`) },
  { method: 'POST', pattern: /^\/voice-design\/generations$/ },
  { method: 'GET', pattern: new RegExp(`^\\/voice-design\\/by-idempotency-key\\/${APP_TASK_ID_PATTERN}$`) },
  { method: 'GET', pattern: new RegExp(`^\\/voice-design\\/tasks\\/${APP_TASK_ID_PATTERN}$`) },
  { method: 'GET', pattern: new RegExp(`^\\/voice-design\\/tasks\\/${APP_TASK_ID_PATTERN}\\/content$`) },
  { method: 'DELETE', pattern: new RegExp(`^\\/voice-design\\/tasks\\/${APP_TASK_ID_PATTERN}$`) },
  { method: 'POST', pattern: /^\/tts\/generations$/ },
  { method: 'GET', pattern: new RegExp(`^\\/tts\\/by-idempotency-key\\/${APP_TASK_ID_PATTERN}$`) },
  { method: 'GET', pattern: new RegExp(`^\\/tts\\/tasks\\/${APP_TASK_ID_PATTERN}$`) },
  { method: 'GET', pattern: new RegExp(`^\\/tts\\/tasks\\/${APP_TASK_ID_PATTERN}\\/content$`) },
  { method: 'DELETE', pattern: new RegExp(`^\\/tts\\/tasks\\/${APP_TASK_ID_PATTERN}$`) },
]
const APP_STREAM_ROUTES = [
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
// These methods are local host services and never map to an HTTP runtime
// route. Keep this list explicit: a session must not turn an Admin Runtime
  // method (for example `user.profile.read`) into an allowed Gateway route
// call merely by echoing it in `host_capabilities`.
const GATEWAY_ONLY_HOST_METHODS = new Set(['media.image.readCached'])
const SERVER_HTTP_METHODS = new Set([
  'user.profile.read',
  'platform.capabilities.list',
  'theme.read',
  'locale.read',
])
// The profile method uses the authenticated Gateway profile route in production
// and the equivalent local relay bridge during local development.
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
    // Plain HTTP is reserved for the local development relay. A production
    // Gateway URL must be HTTPS even when its path is otherwise canonical.
    if (absolute && parsed.protocol === 'http:' && !loopback) return false

    if (parsed.pathname === '/v1') return absolute || loopback || allowRelative
    return false
  } catch {
    return false
  }
}

/**
 * Read the user-bound Gateway session handed off by the Portal launcher.
 *
 * The handoff is scoped to this browser tab and is deliberately different
 * from the Portal login token.  Applications use it only to call the public
 * Gateway data plane; a missing or malformed handoff is a closed state and
 * never triggers a request to the Admin runtime.
 */
export function readAppSessionFromStorage(appId: string): AppSession | undefined {
  if (typeof appId !== 'string' || !appId.trim() || typeof sessionStorage === 'undefined') return undefined
  const storageKey = (identity: string) => `${GATEWAY_SESSION_STORAGE_PREFIX}${encodeURIComponent(identity)}`
  const matchesApp = (value: AppSession) => value.app_id === appId || value.app_slug === appId || value.app_aliases?.includes(appId) === true
  const isSession = (value: unknown): value is AppSession => {
    if (!isRecord(value)) return false
    const record = value as Partial<AppSession>
    return typeof record.access_token === 'string'
      && record.access_token.startsWith('ast_')
      && typeof record.gateway_url === 'string'
      && gatewayBaseIsAllowed(record.gateway_url)
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
      if (isSession(value) && matchesApp(value)) return value
    }
  } catch {
    // Disabled or partitioned storage is equivalent to a missing handoff.
  }
  return undefined
}

// Server-runtime pages are served by the Portal and authenticate through an
// HttpOnly, same-origin cookie. Keep the API prefix path-only so a manifest or
// application cannot redirect credentialed requests to another origin.
function serverRuntimeBaseIsAllowed(value: string) {
  if (typeof value !== 'string' || value.length === 0 || value !== value.trim() || /[\\?#]/.test(value)) return false
  if (!value.startsWith('/') || value.startsWith('//')) return false
  try {
    const parsed = new URL(value, 'https://proxy-app.invalid')
    return parsed.origin === 'https://proxy-app.invalid' && parsed.pathname === '/api/app-runtime/v1' && parsed.pathname === value
  } catch {
    return false
  }
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

function invalidLocalAuthResponse(response?: Response, requestId?: string) {
  return createSdkError('LOCAL_DEV_RUNTIME_NOT_CONFIGURED', '本地登录接口返回了无效响应，请使用 proxy-app dev 启动应用并检查开发代理配置。', requestId, response?.status)
}

async function readLocalAuthResponse(response: Response): Promise<LocalLoginDetails> {
  const requestId = responseRequestId(response, generateRequestId())!
  assertLocalRuntimeResponse(response, requestId)
  const body = await readErrorBody(response)
  if (!response.ok) throw createApiError(response, body, requestId)
  const value = isRecord(body) && Object.prototype.hasOwnProperty.call(body, 'data') ? body.data : body
  if (!isRecord(value)) throw invalidLocalAuthResponse(response, requestId)
  return value as LocalLoginDetails
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
  // Published applications use the Portal handoff and call the Gateway
  // directly. Electron and local development remain explicit host runtimes.
  // Keep `server` only as an explicit legacy option; it is never inferred.
  const runtime = options.runtime || (detectedElectronHost ? 'electron' : (options.localDevelopment || localHost ? 'local' : 'direct'))
  if (!['direct', 'server', 'local', 'electron'].includes(runtime)) {
    throw new AppSdkError('APP_RUNTIME_UNSUPPORTED', `Unsupported app runtime: ${runtime}`)
  }
  const localDevelopment = runtime === 'local'
  const directRuntime = runtime === 'direct'
  const serverRuntime = runtime === 'server'
  const electronRuntime = runtime === 'electron'
  const serverRuntimePath = options.serverRuntimePath || '/api/app-runtime/v1'
  if (serverRuntime && !serverRuntimeBaseIsAllowed(serverRuntimePath)) {
    throw new AppSdkError('APP_RUNTIME_PATH_INVALID', 'server runtime path must be a same-origin path')
  }
  let serverGatewayPath = `${serverRuntimePath.replace(/\/$/, '')}/gateway`
  const localGatewayPath = options.localGatewayPath || '/v1'
  // Authentication is a local relay concern. Application data always uses
  // the Gateway URL carried by the App Session.
  const localAuthBasePath = '/__platform/auth'
  const localProfilePath = `${localAuthBasePath}/profile`
  const localAuthPath = options.localAuthPath || `${localAuthBasePath}/start`
  const localAuthStatusPath = options.localAuthStatusPath || localAuthPath.replace(/\/start\/?$/, '/status')
  const localLogoutPath = options.localLogoutPath || `${localAuthBasePath}/logout`
  const timeoutMs = options.timeoutMs ?? 10000
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new AppSdkError('APP_INVALID_TIMEOUT', 'timeoutMs must be a positive number')
  let session: AppSession | null = null
  let bearerSessionExpiresAt = 0
  let refreshPromise: Promise<AppSession> | null = null
  let serverRetryTimer: number | undefined
  let serverAppID = appId
  let serverAccountScope: string | undefined
  let serverUserID: string | undefined
  let serverSessionExpiresAt = 0
  let serverSessionCheckedAt = 0
  let serverRefreshFailures = 0
  let serverSessionError: AppSdkError | null = null
  let serverAbortController = new AbortController()
  let accountScopeRecovery: { session: AppSession; token: string; promise: Promise<void> } | null = null
  let localLoginPromise: Promise<void> | null = null
  let pendingLocalLogin: LocalLoginDetails | null = null
  let cancelLocalLogin: ((error: unknown) => void) | null = null
  let localAuthGeneration = 0
  let destroyed = false
  let gatewaySessionError: AppSdkError | null = null

  const assertServerSessionActive = () => {
    if (!serverRuntime) return
    if (serverSessionError) throw serverSessionError
    if (destroyed) throw createSdkError('APP_AUTH_CHANGED', '应用已关闭，请重新打开应用。')
    const portal = serverUserID ? portalIdentity() : null
    if (portal && portal.user_id !== serverUserID) {
      throw endServerSession(createSdkError('APP_ACCOUNT_CHANGED', '平台账户已退出或切换，请重新打开应用。', undefined, 409))
    }
  }
  const endServerSession = (error: AppSdkError) => {
    if (serverSessionError) return serverSessionError
    serverSessionError = error
    localAuthGeneration += 1
    if (serverRetryTimer !== undefined) window.clearTimeout(serverRetryTimer)
    serverRetryTimer = undefined
    serverAbortController.abort(error)
    if (typeof window.dispatchEvent === 'function' && typeof CustomEvent !== 'undefined') {
      window.dispatchEvent(new CustomEvent('proxy-app:session-ended', {
        detail: { appId, accountScope: serverAccountScope, code: error.code, message: error.message },
      }))
    }
    return error
  }
  const serverFailure = (error: AppSdkError) => {
    if (serverRuntime && (
      error.status === 401
      || ['APP_ACCOUNT_CHANGED', 'APP_AUTH_CHANGED', 'APP_VERSION_CHANGED', 'APP_SESSION_INVALID', 'APP_SESSION_EXPIRED', 'APP_SESSION_REVOKED', 'APP_DISABLED'].includes(error.code)
      || error.authReason === 'APP_SESSION_REVOKED'
    )) return endServerSession(error)
    return error
  }
  const serverHeaders = () => {
    const headers = new Headers({ 'X-App-ID': serverAppID })
    if (serverAccountScope) headers.set('X-App-Account-Scope', serverAccountScope)
    return headers
  }
  const portalIdentity = () => {
    try {
      const raw = window.localStorage?.getItem(PORTAL_AUTH_CHANGE_KEY)
      const value = raw ? JSON.parse(raw) as unknown : null
      return isRecord(value) && (value.user_id === null || typeof value.user_id === 'string')
        && typeof value.at === 'number' && Number.isFinite(value.at) && typeof value.nonce === 'string' ? value : null
    } catch { return null }
  }
  const fetchWithServerSession = async (path: string, init: RequestInit): Promise<Response> => {
    assertServerSessionActive()
    // Combine caller cancellation with account/logout cancellation. Newer
    // browsers supply AbortSignal.any; the fallback retains caller cancellation
    // and still rejects all late results through the checks below.
    const signalAny = (AbortSignal as typeof AbortSignal & { any?: (signals: AbortSignal[]) => AbortSignal }).any
    const signal = init.signal
      ? signalAny ? signalAny.call(AbortSignal, [init.signal, serverAbortController.signal]) : init.signal
      : serverAbortController.signal
    try {
      const response = await fetch(path, { ...init, signal })
      assertServerSessionActive()
      return response
    } catch (error) {
      assertServerSessionActive()
      throw error
    }
  }

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
    if (isStorageMethod(method) || ((localDevelopment || directRuntime) && LOCAL_HTTP_METHODS.has(method)) || (serverRuntime && SERVER_HTTP_METHODS.has(method)) || (allowHostCapability && hasHostCapability(method))) return
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

  const runtimeBase = () => serverRuntime ? serverRuntimePath.replace(/\/$/, '') : gatewayBase()
  const gatewayRequestBase = () => serverRuntime ? serverGatewayPath : gatewayBase()

  const acceptSession = (next: AppSession) => {
    if (serverRuntime || gatewayBaseIsAllowed(next.gateway_url)) {
      gatewaySessionError = null
      if (!serverRuntime) bearerSessionExpiresAt = Date.now() + next.expires_in * 1000
      return true
    }
    gatewaySessionError = createSdkError('APP_GATEWAY_URL_INVALID', 'App session must use a canonical Gateway /v1 URL')
    session = null
    return false
  }

  if (localDevelopment) {
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
  } else if (directRuntime) {
    // A published first-party page may be constructed before the Portal
    // session handoff is available (for example after a direct refresh or
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
  } else if (serverRuntime) {
    // The Portal owns the App Session. The SDK discovers only non-secret
    // metadata from the same-origin session endpoint; the credential remains
    // in an HttpOnly cookie and is never exposed to application JavaScript.
  } else if (electronRuntime) {
    if (!detectedElectronHost) throw new AppSdkError('APP_ELECTRON_HOST_UNAVAILABLE', 'Electron host bridge is not available')
  }

  if (localDevelopment && !gatewayBaseIsAllowed(localGatewayPath, true)) {
    throw createSdkError('APP_GATEWAY_URL_INVALID', 'Local app runtime must use a canonical Gateway URL')
  }
  // A direct runtime can be constructed before the Portal handoff is
  // available (for example after a hard refresh with blocked sessionStorage).
  // Keep the client alive so the host can render its reconnect state; do not
  // dereference a missing session or fall back to the Admin runtime.
  if (directRuntime && session && !gatewayBaseIsAllowed(session.gateway_url)) {
    throw createSdkError('APP_GATEWAY_URL_INVALID', 'App session must use a canonical Gateway /v1 URL')
  }
  if (directRuntime && session) acceptSession(session)

  const cleanup = () => {
    if (serverRetryTimer !== undefined) {
      window.clearTimeout(serverRetryTimer)
      serverRetryTimer = undefined
    }
    localAuthGeneration += 1
    if (serverRuntime) {
      serverAbortController.abort()
      window.removeEventListener('storage', handlePortalAuthChange)
      window.removeEventListener('focus', recoverVisibleServerSession)
      window.removeEventListener('online', recoverVisibleServerSession)
      window.removeEventListener('pageshow', recoverVisibleServerSession)
      window.removeEventListener('pagehide', handleServerPageHide)
      if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', recoverVisibleServerSession)
    }
    pendingLocalLogin = null
    cancelLocalLogin?.(createSdkError('APP_LOGIN_CANCELLED', '登录已取消'))
    gatewaySessionError = null
  }

  const ensureLocalLogin = async (details?: LocalLoginDetails, userInitiated = false, forcePortalLogin = false) => {
    if (destroyed) throw createSdkError('APP_LOGIN_CANCELLED', '应用已关闭，登录已取消')
    if (localLoginPromise) return localLoginPromise
    localAuthGeneration += 1
    localLoginPromise = (async () => {
      const generation = localAuthGeneration
      const controller = new AbortController()
      let cancellation: unknown
      let cancelAttempt: (error: unknown) => void = () => undefined
      let popup: Window | null = userInitiated ? window.open('about:blank', 'proxy-app-login', 'popup,width=480,height=720') : null
      const cancelLogin = (error: unknown) => {
        cancellation = error
        controller.abort()
        cancelAttempt(error)
        try { popup?.close() } catch {}
      }
      cancelLocalLogin = cancelLogin
      const assertActive = () => {
        if (cancellation) throw cancellation
        if (destroyed || generation !== localAuthGeneration) throw createSdkError('APP_LOGIN_CANCELLED', '登录已取消')
      }
      const runAttempt = async (suppliedDetails?: LocalLoginDetails) => {
        assertActive()
        let loginDetails = suppliedDetails?.login_url ? suppliedDetails : (!userInitiated && !forcePortalLogin ? pendingLocalLogin : null)
        if (!loginDetails?.login_url) {
          const startPath = forcePortalLogin ? `${localAuthPath}${localAuthPath.includes('?') ? '&' : '?'}force_login=1` : localAuthPath
          const start = await fetch(startPath, { headers: { Accept: 'application/json' }, cache: 'no-store', signal: controller.signal })
          assertActive()
          loginDetails = await readLocalAuthResponse(start)
          assertActive()
        }
        if (!forcePortalLogin && loginDetails?.authenticated === true) {
          pendingLocalLogin = null
          return
        }
        if (typeof loginDetails?.login_url !== 'string' || !loginDetails.login_url || typeof loginDetails.auth_state !== 'string' || !loginDetails.auth_state) {
          throw invalidLocalAuthResponse()
        }
        forcePortalLogin = forcePortalLogin || loginDetails.force_login === true
        const loginURL = new URL(loginDetails.login_url)
        if (forcePortalLogin) {
          // The Portal reads HashRouter parameters inside #/login. Keep the
          // same final URL for the popup, callbacks and manual fallback links.
          if (loginURL.hash.startsWith('#/')) {
            const queryStart = loginURL.hash.indexOf('?')
            const route = queryStart < 0 ? loginURL.hash : loginURL.hash.slice(0, queryStart)
            const query = new URLSearchParams(queryStart < 0 ? '' : loginURL.hash.slice(queryStart + 1))
            query.set('proxy_app_force_login', '1')
            loginURL.hash = `${route}?${query}`
          } else loginURL.searchParams.set('proxy_app_force_login', '1')
        }
        loginDetails = { ...loginDetails, login_url: loginURL.toString(), force_login: forcePortalLogin }
        pendingLocalLogin = loginDetails
        const state = loginDetails.auth_state
        // The callback document is served by the loopback relay, not by the
        // Portal origin contained in login_url. Validate the postMessage
        // against the relay origin so OAuth completion can wake the app.
        const loginOrigin = loginDetails.relay_url ? new URL(loginDetails.relay_url).origin : loginURL.origin
        const loginResult = new Promise<void>((resolve, reject) => {
          let settled = false
          let pollTimer: number | null = null
          const clearAttempt = () => {
            window.clearTimeout(timer)
            if (pollTimer !== null) window.clearInterval(pollTimer)
            window.removeEventListener('message', onMessage)
          }
          const finish = () => {
            if (settled) return
            settled = true
            clearAttempt()
            resolve()
          }
          const fail = (error: unknown) => {
            if (settled) return
            settled = true
            clearAttempt()
            reject(error)
          }
          cancelAttempt = fail
          const timer = window.setTimeout(() => {
            fail(createSdkError('APP_LOGIN_TIMEOUT', '平台登录超时，请重试', undefined, undefined, loginDetails))
          }, 5 * 60 * 1000)
          const onMessage = (event: MessageEvent) => {
            if (event.origin !== loginOrigin) return
            const message = event.data
            if (!message || message.protocol !== 'proxy-app/auth/v1' || message.state !== state) return
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
              const status = await readLocalAuthResponse(statusResponse)
              if (settled) return
              if (typeof status.authenticated !== 'boolean') throw invalidLocalAuthResponse(statusResponse)
              if (status?.authenticated === true) {
                pendingLocalLogin = null
                finish()
              }
            } catch (error) {
              if (error instanceof AppSdkError && error.code === 'LOCAL_DEV_RUNTIME_NOT_CONFIGURED') fail(error)
              // The callback message remains the primary fast path; a
              // transient status request failure should not fail login.
            }
          }
          pollTimer = window.setInterval(() => { void pollStatus() }, 1000)
        })
        try {
          options.onLoginRequired?.(loginDetails)
          assertActive()
          if (popup && !popup.closed) popup.location.replace(loginURL.toString())
          else {
            popup = window.open(loginURL.toString(), 'proxy-app-login', 'popup,width=480,height=720')
            if (!popup) {
              throw createSdkError(
                'APP_LOGIN_POPUP_BLOCKED',
                '浏览器阻止了登录窗口，请点击“登录平台”后重试。',
                undefined,
                undefined,
                loginDetails,
              )
            }
          }
          await loginResult
        } catch (error) {
          cancelAttempt(error)
          await loginResult.catch(() => undefined)
          throw error
        } finally {
          cancelAttempt = () => undefined
        }
      }
      try {
        try {
          await runAttempt(details)
          assertActive()
        } catch (error) {
          assertActive()
          // A cached Portal token can look valid until the relay exchanges it.
          // Retry once with a fresh login in the same popup; never keep
          // auto-submitting an expired token or retry permission/network errors.
          const staleLogin = error instanceof AppSdkError && ['APP_LOGIN_SESSION_EXPIRED', 'APP_LOGIN_TOKEN_INVALID'].includes(error.code)
          if (forcePortalLogin || !staleLogin) throw error
          forcePortalLogin = true
          pendingLocalLogin = null
          await runAttempt()
          assertActive()
        }
      } finally {
        if (cancelLocalLogin === cancelLogin) cancelLocalLogin = null
        try { popup?.close() } catch {}
      }
    })().finally(() => { localLoginPromise = null })
    return localLoginPromise
  }

  const localLoginRequired = async (response: Response, requestId: string) => {
    if (response.status !== 401) return false
    const body = await readErrorBody(response.clone())
    const parsed = parseApiErrorBody(body)
    if (parsed.code !== 'APP_LOGIN_REQUIRED') return false
    const details = isRecord(body) ? body as LocalLoginDetails : undefined
    await ensureLocalLogin(details, false, details?.force_login === true)
    return true
  }

  const login = async (loginOptions: LocalLoginOptions = {}) => {
    if (serverRuntime) {
      if (destroyed) throw createSdkError('APP_AUTH_CHANGED', '应用已关闭，请重新打开应用。')
      const hash = window.location.hash || ''
      const safeHash = hash.length <= 4096 && !/[\x00-\x1f\x7f\\]/.test(hash)
        && !/%(?:0[0-9a-f]|1[0-9a-f]|7f|5c)/i.test(hash)
        && (!hash || hash.startsWith('#/') && !hash.startsWith('#//')) ? hash : ''
      const query = new URLSearchParams({ runtime_recovery: '1' })
      if (safeHash) query.set('runtime_hash', safeHash)
      const preview = new URLSearchParams(window.location.search || '').getAll('runtime_preview')
      if (preview.length === 1 && preview[0].length <= 128 && /^[A-Za-z0-9][A-Za-z0-9._+-]*$/.test(preview[0])) query.set('version', preview[0])
      // Only the server runtime owns this same-origin Portal handoff. A
      // manifest, gateway response or caller cannot choose another login URL.
      const target = new URL('/', window.location.origin)
      target.hash = `/apps/${encodeURIComponent(serverAppID)}?${query}`
      endServerSession(createSdkError('APP_AUTH_CHANGED', '正在返回平台重新连接账户。'))
      window.location.replace(target.toString())
      return
    }
    if (electronRuntime) {
      localAuthGeneration += 1
      return unwrapElectronResult<void>(await detectedElectronHost!.auth.login(loginOptions))
    }
    if (!localDevelopment) throw createSdkError('APP_LOGIN_UNAVAILABLE', directRuntime ? '请通过平台 OAuth 获取 App Session' : '登录由平台宿主管理')
    await ensureLocalLogin(undefined, true, loginOptions.forceLogin === true)
  }

  const logout = async () => {
    localAuthGeneration += 1
    if (serverRuntime) {
      const headers = serverHeaders()
      headers.set('Accept', 'application/json')
      headers.set('X-App-Runtime-Logout', '1')
      // Suspend before dispatch: queued work and late results must not resume
      // while the cookie-backed grant is being revoked.
      endServerSession(createSdkError('APP_AUTH_CHANGED', '账户已退出，请重新登录。'))
      await withRuntimeCookieLock(async () => {
        const controller = new AbortController()
        const timer = window.setTimeout(() => controller.abort(createSdkError('APP_SESSION_LOGOUT_TIMEOUT', '退出请求超时，请返回平台确认登录状态。', undefined, 408)), timeoutMs)
        try {
          const response = await fetch(`${serverRuntimePath}/session/logout`, {
            method: 'POST', headers, credentials: 'include', cache: 'no-store', redirect: 'error', signal: controller.signal,
          })
          const body = await readErrorBody(response)
          controller.signal.throwIfAborted()
          if (!response.ok) throw createApiError(response, body, generateRequestId())
        } catch (error) {
          if (controller.signal.aborted) throw controller.signal.reason
          throw error
        } finally {
          window.clearTimeout(timer)
        }
      })
      return
    }
    if (electronRuntime) return unwrapElectronResult<void>(await detectedElectronHost!.auth.logout())
    if (!localDevelopment) return
    pendingLocalLogin = null
    cancelLocalLogin?.(createSdkError('APP_LOGIN_CANCELLED', '正在退出账户，登录已取消'))
    const response = await fetch(localLogoutPath, { method: 'POST', headers: { Accept: 'application/json' } })
    const result = await readLocalAuthResponse(response)
    if (!('success' in result) || result.success !== true) throw invalidLocalAuthResponse(response)
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
    pendingLocalLogin = null
  }

  /**
   * Check whether a local relay already has a platform login.  Unlike an API
   * request this endpoint never starts the login flow, so apps can restore a
   * previously linked account during startup without unexpectedly opening a
   * popup. Direct runtime uses its supplied user-bound App Session as the
   * authentication signal.
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
      if (directRuntime && !options.refreshAppSession) throw accountScopeUnavailable()
      assertCurrent()
      await refreshSession()
      if (destroyed) throw createSdkError('APP_AUTH_CHANGED', '应用已关闭，请重新打开应用。')
      if (!validAccountScope(session?.account_scope)) throw accountScopeUnavailable()
    })()
    const recovery = { session: current, token, promise }
    accountScopeRecovery = recovery
    try { await promise } finally { if (accountScopeRecovery === recovery) accountScopeRecovery = null }
  }

  const fetchServerSession = async (rotate = false): Promise<AppSession> => {
    assertServerSessionActive()
    const headers = serverHeaders()
    headers.set('Accept', 'application/json')
    headers.set('X-Request-ID', generateRequestId())
    const controller = new AbortController()
    const timer = window.setTimeout(() => controller.abort(createSdkError('APP_SESSION_REFRESH_TIMEOUT', '平台会话检查超时，请稍后重试。', undefined, 408)), timeoutMs)
    let response: Response
    let body: unknown
    try {
      response = await fetchWithServerSession(`${serverRuntimePath.replace(/\/$/, '')}/session${rotate ? '/refresh' : ''}`, {
        method: rotate ? 'POST' : 'GET', headers,
        credentials: 'include', cache: 'no-store', redirect: 'error', signal: controller.signal,
      })
      body = await readErrorBody(response)
      controller.signal.throwIfAborted()
    } catch (error) {
      assertServerSessionActive()
      if (controller.signal.aborted) throw controller.signal.reason
      throw error
    } finally {
      window.clearTimeout(timer)
    }
    assertServerSessionActive()
    if (!response.ok) {
      // Metadata lookup is read-only. It may recover an expired cookie once;
      // this never replays an application operation or a missing credential.
      if (!rotate && isGatewaySessionExpired(response, body)) return fetchServerSession(true)
      const error = createApiError(response, body, generateRequestId())
      throw response.status === 401 ? endServerSession(error) : serverFailure(error)
    }
    const value = isRecord(body) && Object.prototype.hasOwnProperty.call(body, 'data') ? body.data : body
    const aliases = isRecord(value) && Array.isArray(value.app_aliases) ? value.app_aliases.filter(validPublicAppSlug) : []
    if (!isRecord(value) || typeof value.app_id !== 'string' || value.app_id !== value.app_id.trim() || !SERVER_APP_ID_PATTERN.test(value.app_id)
      || (session ? value.app_id !== serverAppID : value.app_id !== appId && (!validPublicAppSlug(appId) || value.app_slug !== appId && !aliases.includes(appId)))) {
      throw endServerSession(createSdkError('APP_SESSION_INVALID', 'Server runtime returned an invalid app session'))
    }
    if (!validAccountScope(value.account_scope)) throw accountScopeUnavailable()
    const portal = portalIdentity()
    if ((serverAccountScope && value.account_scope !== serverAccountScope)
      || (serverUserID && value.user_id !== serverUserID)
      || (portal && (portal.user_id === null || portal.user_id !== value.user_id))) {
      throw endServerSession(createSdkError('APP_ACCOUNT_CHANGED', '账户已切换，请重新打开应用。', undefined, 409))
    }
    const loadedVersion = session?.app_version || options.localAppVersion
    if (loadedVersion && value.app_version !== loadedVersion) {
      throw endServerSession(createSdkError('APP_VERSION_CHANGED', '应用版本已更新，请重新打开应用。', undefined, 409))
    }
    const expiresAt = typeof value.expires_at === 'string' ? Date.parse(value.expires_at) : NaN
    const expiresIn = typeof value.expires_in === 'number' && Number.isFinite(value.expires_in)
      ? value.expires_in
      : Number.isFinite(expiresAt) ? Math.max(0, Math.floor((expiresAt - Date.now()) / 1000)) : APP_SESSION_DEFAULT_TTL_SECONDS
    const origin = typeof window !== 'undefined' && /^https?:\/\//i.test(window.location.origin)
      ? window.location.origin
      : 'https://proxy-app.invalid'
    if (typeof value.runtime_gateway_url === 'string') {
      try {
        const parsedGateway = new URL(value.runtime_gateway_url, origin)
        const expectedPrefix = `${serverRuntimePath.replace(/\/$/, '')}/gateway`
        if (parsedGateway.origin !== origin || parsedGateway.search || parsedGateway.hash || !parsedGateway.pathname.startsWith(`${expectedPrefix}/`) && parsedGateway.pathname !== expectedPrefix) {
          throw new Error('invalid runtime gateway')
        }
        serverGatewayPath = parsedGateway.pathname.replace(/\/$/, '')
      } catch {
        throw createSdkError('APP_GATEWAY_URL_INVALID', 'Server runtime returned an invalid Gateway URL')
      }
    }
    const runtimeGatewayURL = `${origin}${serverGatewayPath}`
    const next: AppSession = {
      access_token: '',
      token_type: 'Cookie',
      expires_in: expiresIn,
      gateway_url: runtimeGatewayURL,
      app_id: typeof value.app_id === 'string' ? value.app_id : appId,
      app_slug: typeof value.app_slug === 'string' ? value.app_slug : appId,
      app_aliases: aliases,
      app_version: typeof value.app_version === 'string' ? value.app_version : session?.app_version || options.localAppVersion || 'server',
      account_scope: value.account_scope,
      scopes: Array.isArray(value.scopes)
        ? value.scopes.filter((scope): scope is string => typeof scope === 'string')
        : session?.scopes || [],
    }
    if (!acceptSession(next)) throw gatewaySessionError || createSdkError('APP_SESSION_INVALID', 'Server runtime returned an invalid app session')
    serverAppID = value.app_id
    serverAccountScope = value.account_scope
    if (typeof value.user_id === 'string' && value.user_id) serverUserID = value.user_id
    session = next
    serverSessionCheckedAt = Date.now()
    serverSessionExpiresAt = Number.isFinite(expiresAt) ? expiresAt : serverSessionCheckedAt + expiresIn * 1000
    serverRefreshFailures = 0
    if (serverRetryTimer !== undefined) window.clearTimeout(serverRetryTimer)
    serverRetryTimer = undefined
    return next
  }

  const scheduleServerRetry = (delay: number, rotate = false) => {
    if (destroyed || serverSessionError) return
    if (serverRetryTimer !== undefined) window.clearTimeout(serverRetryTimer)
    serverRetryTimer = window.setTimeout(() => {
      serverRetryTimer = undefined
      void requestServerSession(rotate).catch(() => { /* retry policy is owned by the single flight below */ })
    }, delay)
  }
  const requestServerSession = (rotate: boolean): Promise<AppSession> => {
    assertServerSessionActive()
    if (refreshPromise) return refreshPromise
    refreshPromise = withRuntimeCookieLock(() => {
      assertServerSessionActive()
      return fetchServerSession(rotate)
    }).catch(error => {
      const transient = !(error instanceof AppSdkError) || error.status === 408 || error.status === 429 || (error.status || 0) >= 500
      if (!serverSessionError && !destroyed && transient && serverRefreshFailures < SERVER_REFRESH_RETRY_MS.length) {
        scheduleServerRetry(SERVER_REFRESH_RETRY_MS[serverRefreshFailures++], rotate)
      }
      throw error
    }).finally(() => { refreshPromise = null })
    return refreshPromise
  }
  const ensureServerSession = async () => {
    assertServerSessionActive()
    const expired = Boolean(session && serverSessionExpiresAt <= Date.now())
    if (!session || expired || Date.now() - serverSessionCheckedAt >= SERVER_SESSION_CHECK_AGE_MS) {
      await requestServerSession(expired)
    }
    assertServerSessionActive()
  }
  const recoverVisibleServerSession = (event?: Event) => {
    if (destroyed || serverSessionError || (typeof document !== 'undefined' && document.visibilityState === 'hidden')) return
    // Waking after a suspended timer or regaining connectivity starts a new
    // bounded retry window, but shares any already-running request.
    serverRefreshFailures = 0
    const restored = event?.type === 'pageshow' && (event as PageTransitionEvent).persisted
    const recovery = restored
      ? Promise.resolve().then(() => requestServerSession(Boolean(session && serverSessionExpiresAt <= Date.now())))
      : ensureServerSession()
    void recovery.catch(() => { /* surfaced by status/API calls; transient failures have bounded retries */ })
  }
  const handleServerPageHide = (event: PageTransitionEvent) => {
    if (!event.persisted) { cleanup(); return }
    // bfcache preserves this client. Do not permanently abort its controller;
    // pageshow revalidates identity and can rearm a transient retry.
    if (serverRetryTimer !== undefined) window.clearTimeout(serverRetryTimer)
    serverRetryTimer = undefined
  }
  const handlePortalAuthChange = (event: StorageEvent) => {
    if (event.key !== PORTAL_AUTH_CHANGE_KEY || !event.newValue || destroyed || serverSessionError) return
    try {
      const latest = window.localStorage?.getItem(PORTAL_AUTH_CHANGE_KEY)
      if (latest !== undefined && latest !== event.newValue) return
      const value = JSON.parse(event.newValue) as unknown
      if (!isRecord(value) || !(value.user_id === null || typeof value.user_id === 'string') || typeof value.at !== 'number' || typeof value.nonce !== 'string') return
      // Before bootstrap resolves, compare the latest persisted identity with
      // the returned metadata instead of assuming every login is a switch.
      if (value.user_id === null || (serverUserID && value.user_id !== serverUserID)) {
        endServerSession(createSdkError('APP_ACCOUNT_CHANGED', '平台账户已退出或切换，请重新打开应用。', undefined, 409))
      }
    } catch { /* Ignore unrelated or malformed cross-tab storage updates. */ }
  }

  const authStatus = async (): Promise<AppAuthStatus> => {
    const generation = localAuthGeneration
    const assertActive = () => {
      if (destroyed || generation !== localAuthGeneration)
        throw createSdkError('APP_AUTH_CHANGED', '账户授权已改变，请重新检查登录状态。')
    }
    assertActive()
    if (gatewaySessionError) throw gatewaySessionError
    const scopedStatus = (authenticated: boolean, scope: unknown): AppAuthStatus => {
      if (authenticated && !validAccountScope(scope)) throw accountScopeUnavailable()
      return { authenticated, ...(authenticated ? { accountScope: scope as string } : {}) }
    }
    if (electronRuntime) {
      const status = unwrapElectronResult<AppAuthStatus>(await detectedElectronHost!.auth.status())
      assertActive()
      const { accountScope, ...rest } = status
      return { ...rest, ...scopedStatus(status.authenticated, accountScope) }
    }
    if (serverRuntime) {
      await ensureServerSession()
      assertActive()
      if (session && !validAccountScope(session.account_scope)) {
        await refreshSession()
        assertActive()
      }
      return scopedStatus(Boolean(session?.app_id), session?.account_scope)
    }
    if (!localDevelopment) {
      await ensureBearerSession()
      if (session?.access_token && !validAccountScope(session.account_scope)) await recoverAccountScope(session)
      assertActive()
      return scopedStatus(Boolean(session?.access_token), session?.account_scope)
    }
    const response = await fetch(localAuthStatusPath, {
      headers: { Accept: 'application/json' },
      cache: 'no-store',
    })
    const value = await readLocalAuthResponse(response)
    assertActive()
    if (typeof value.authenticated !== 'boolean') throw invalidLocalAuthResponse(response)
    return scopedStatus(value.authenticated, value.account_scope)
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
    if (serverRuntime) await ensureServerSession()
    else await ensureBearerSession()
    const requestId = generateRequestId()
    const idempotencyKey = typeof input.idempotency_key === 'string' ? input.idempotency_key : generateRequestId()
    const request = () => {
      const headers = new Headers({ Accept: 'application/json', 'X-Request-ID': requestId })
      if (!serverRuntime && session?.access_token) headers.set('Authorization', `${session.token_type || 'Bearer'} ${session.access_token}`)
      if (serverRuntime) serverHeaders().forEach((value, key) => headers.set(key, value))
      if (session?.app_version) headers.set('X-App-Version', session.app_version)
      if (body !== undefined) headers.set('Content-Type', 'application/json')
      if (httpMethod !== 'GET') headers.set('Idempotency-Key', idempotencyKey)
      const init: RequestInit = { method: httpMethod, headers, body, credentials: serverRuntime ? 'include' : 'omit', redirect: 'error' }
      const target = localDevelopment && method === 'user.profile.read'
        ? localProfilePath
        : `${runtimeBase()}${path}`
      return serverRuntime ? fetchWithServerSession(target, init) : fetch(target, init)
    }
    let response = await request()
    if (localDevelopment) assertLocalRuntimeResponse(response, requestId)
    if (localDevelopment && await localLoginRequired(response, requestId)) {
      response = await request()
      assertLocalRuntimeResponse(response, requestId)
    } else if (!localDevelopment && response.status === 401) {
      const body = await readErrorBody(response.clone())
      if (isGatewaySessionExpired(response, body)) {
        await refreshSession()
        response = await request()
      }
    }
    const result = await response.json().catch(() => null)
    assertServerSessionActive()
    if (!response.ok) throw serverFailure(createApiError(response, result, requestId))
    const value = isRecord(result) && Object.prototype.hasOwnProperty.call(result, 'data') ? result.data : result
    return value as T
  }

  const call = async <T>(method: string, payload?: unknown): Promise<T> => {
    payload = storageRequestPayload(method, payload)
    assertAppMethod(method, runtime === 'electron')
    if (electronRuntime) return unwrapElectronResult<T>(await detectedElectronHost!.call(method, payload))
    return httpCall<T>(method, payload)
  }
  if (!serverRuntime) window.addEventListener('beforeunload', cleanup)

  const refreshSession = async (): Promise<AppSession> => {
    if (destroyed) throw createSdkError('APP_AUTH_CHANGED', '应用已关闭，请重新打开应用。')
    if (gatewaySessionError) throw gatewaySessionError
    if (localDevelopment || electronRuntime) {
      if (refreshPromise) return refreshPromise
      // These hosts own the credential. Ask them to validate/recover the
      // session and return only public metadata to the renderer.
      refreshPromise = authStatus().then(status => {
        const { account_scope: _previousScope, ...base } = session || {
          access_token: '', token_type: 'Bearer', expires_in: 0, gateway_url: '',
          app_id: appId, app_slug: appId, app_version: options.localAppVersion || 'desktop', scopes: [],
        }
        return { ...base, ...(status.accountScope ? { account_scope: status.accountScope } : {}) }
      }).finally(() => { refreshPromise = null })
      return refreshPromise
    }
    if (serverRuntime) {
      // The first explicit createSession is a metadata lookup. Once a cookie
      // session is known, refresh rotates it through the refresh endpoint.
      return requestServerSession(Boolean(session))
    }
    if (directRuntime) {
      if (!session?.access_token && !options.refreshAppSession) {
        throw createSdkError('APP_SESSION_UNAVAILABLE', 'App data-plane session is not ready')
      }
      if (!options.refreshAppSession) {
        return session!
      }
      if (refreshPromise) return refreshPromise
      const previousSession = session
      const previousToken = session?.access_token
      refreshPromise = options.refreshAppSession().then((nextSession) => {
        if (destroyed || session !== previousSession || session?.access_token !== previousToken)
          throw createSdkError('APP_AUTH_CHANGED', '账户授权已改变，请重新检查登录状态。')
        if (!nextSession?.access_token?.startsWith('ast_') || !nextSession.gateway_url) {
          throw createSdkError('APP_SESSION_INVALID', 'OAuth refresh did not return a valid user App Session')
        }
        if (!gatewayBaseIsAllowed(nextSession.gateway_url)) {
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

  // An auth failure freezes the old server client and aborts its requests so
  // stale work cannot continue under another account. The explicit
  // `platform.createSession()` action is the login gate's recovery path, so it
  // must create a fresh request boundary before checking the browser cookie
  // again. Otherwise a valid cookie issued by the Portal would be hidden by
  // the previous APP_SESSION_INVALID state forever.
  const createPlatformSession = async (): Promise<AppSession> => {
    if (serverRuntime && serverSessionError) {
      serverSessionError = null
      serverAbortController = new AbortController()
      refreshPromise = null
      gatewaySessionError = null
      session = null
      serverAppID = appId
      serverAccountScope = undefined
      serverUserID = undefined
      serverSessionCheckedAt = 0
      serverSessionExpiresAt = 0
      serverRefreshFailures = 0
    }
    return refreshSession()
  }

  const ensureBearerSession = async () => {
    if (localDevelopment || electronRuntime || serverRuntime || !session?.access_token) return
    // Direct consumers can supply their own rotation callback. If they have
    // none, retain manual-token use until expiry instead of rejecting an
    // otherwise valid request during the renewal window.
    if (directRuntime && !options.refreshAppSession) return
    if (bearerSessionExpiresAt <= Date.now()) await refreshSession()
  }

  if (serverRuntime) {
    window.addEventListener('storage', handlePortalAuthChange)
    window.addEventListener('focus', recoverVisibleServerSession)
    window.addEventListener('online', recoverVisibleServerSession)
    window.addEventListener('pageshow', recoverVisibleServerSession)
    window.addEventListener('pagehide', handleServerPageHide)
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', recoverVisibleServerSession)
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
      /** Refresh a direct session, or validate/recover a credential-owning host session. */
      createSession: createPlatformSession,
      capabilities: () => call<Array<{ method: string; scope?: string; description: string }>>('platform.capabilities.list'),
      call: <T = unknown>(method: string, payload?: unknown) => call<T>(method, payload),
    },
    auth: {
      /** Whether this runtime can start login itself or requires its platform host. */
      loginMode: (localDevelopment || electronRuntime ? 'app' : 'host') as 'app' | 'host',
      /** Explicit recovery behavior; server runtimes relaunch through the trusted Portal. */
      recoveryMode: (serverRuntime ? 'redirect' : localDevelopment || electronRuntime ? 'login' : 'host') as 'redirect' | 'login' | 'host',
      /** Open local/desktop login or explicitly relaunch a server runtime through the Portal. */
      login,
      /** Clear the local relay session so another platform user can sign in. */
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
        if (serverRuntime) await ensureServerSession()
        else await ensureBearerSession()
        if (!session && !serverRuntime) throw createSdkError('APP_SESSION_UNAVAILABLE', 'App data-plane session is not ready')
        const requestId = generateRequestId()
        // Keep the trace ID and operation idempotency key independent. The
        // gateway intentionally treats X-Request-ID as a trace value, while
        // Idempotency-Key identifies a write operation across retries.
        const idempotencyKey = generateRequestId()
        const { responseType = 'auto', ...fetchInit } = init
        const request = () => {
          const headers = new Headers(init.headers)
          if (!serverRuntime) headers.set('Authorization', `${session?.token_type || 'Bearer'} ${session?.access_token || ''}`)
          if (serverRuntime) {
            headers.delete('Authorization')
            serverHeaders().forEach((value, key) => headers.set(key, value))
          }
          if (session?.app_version) headers.set('X-App-Version', session.app_version)
          if (!headers.has('X-Request-ID')) headers.set('X-Request-ID', requestId)
          if ((init.method || 'GET').toUpperCase() !== 'GET' && !headers.has('Idempotency-Key')) headers.set('Idempotency-Key', idempotencyKey)
          if (!headers.has('Content-Type') && shouldDefaultJsonContentType(init.body)) headers.set('Content-Type', 'application/json')
          // App API paths are relative to the App Session's Gateway URL.
          const requestInit: RequestInit = { ...fetchInit, headers, credentials: serverRuntime ? 'include' : 'omit', redirect: 'error' }
          return serverRuntime ? fetchWithServerSession(`${gatewayRequestBase()}${path}`, requestInit) : fetch(`${gatewayRequestBase()}${path}`, requestInit)
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
          assertServerSessionActive()
          throw serverFailure(createApiError(response, body, requestId))
        }
        const value = attachResponseRequestId(await decodeResponse(response, responseType), response, requestId) as T
        assertServerSessionActive()
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
        if (serverRuntime) await ensureServerSession()
        else await ensureBearerSession()
        if (!session && !serverRuntime) throw createSdkError('APP_SESSION_UNAVAILABLE', 'App data-plane session is not ready')
        const requestId = generateRequestId()
        const idempotencyKey = generateRequestId()
        const request = () => {
          const headers = new Headers(init.headers)
          headers.set('Accept', 'text/event-stream')
          if (!serverRuntime) headers.set('Authorization', `${session?.token_type || 'Bearer'} ${session?.access_token || ''}`)
          if (serverRuntime) {
            headers.delete('Authorization')
            serverHeaders().forEach((value, key) => headers.set(key, value))
          }
          if (session?.app_version) headers.set('X-App-Version', session.app_version)
          if (!headers.has('X-Request-ID')) headers.set('X-Request-ID', requestId)
          if ((init.method || 'GET').toUpperCase() !== 'GET' && !headers.has('Idempotency-Key')) headers.set('Idempotency-Key', idempotencyKey)
          if (!headers.has('Content-Type') && shouldDefaultJsonContentType(init.body)) headers.set('Content-Type', 'application/json')
          const requestInit: RequestInit = { ...init, headers, credentials: serverRuntime ? 'include' : 'omit', redirect: 'error' }
          return serverRuntime ? fetchWithServerSession(`${gatewayRequestBase()}${path}`, requestInit) : fetch(`${gatewayRequestBase()}${path}`, requestInit)
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
          assertServerSessionActive()
          throw serverFailure(createApiError(response, body, requestId))
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
            assertServerSessionActive()
            buffer += decoder.decode(chunk.value || new Uint8Array(), { stream: !chunk.done })
            const lines = buffer.split(/\r?\n/)
            buffer = lines.pop() || ''
            for (const line of lines) {
              if (line === '') {
                const event = flush()
                if (event) { assertServerSessionActive(); yield event }
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
            if (event) { assertServerSessionActive(); yield event }
          }
        } finally {
          await reader.cancel().catch(() => undefined)
        }
      },
    },
  }
}
