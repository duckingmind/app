import type { AppHandler, AppRuntimeContext } from './runtime.js'

export type AppRuntimeDevPluginOptions = {
  appId: string
  appVersion: string
  entry: string
  basePath: string
  routes?: string[]
  gatewayURL?: string
  maxBodyBytes?: number
  timeoutMs?: number
}

type IncomingRequest = AsyncIterable<Uint8Array> & {
  method?: string
  url?: string
  headers: Record<string, string | string[] | undefined>
  socket?: { encrypted?: boolean }
  on(event: string, listener: (...args: any[]) => void): IncomingRequest
  removeListener(event: string, listener: (...args: any[]) => void): IncomingRequest
}

type OutgoingResponse = {
  statusCode: number
  headersSent?: boolean
  writableEnded?: boolean
  setHeader(name: string, value: string): void
  write(chunk: Uint8Array | string): boolean
  end(chunk?: Uint8Array | string): void
  on(event: string, listener: (...args: any[]) => void): OutgoingResponse
  once(event: string, listener: (...args: any[]) => void): OutgoingResponse
  removeListener(event: string, listener: (...args: any[]) => void): OutgoingResponse
}

type DevServer = {
  middlewares: { use(handler: (request: IncomingRequest, response: OutgoingResponse, next: (error?: unknown) => void) => void): void }
  ssrLoadModule(id: string): Promise<Record<string, unknown>>
  config: { root: string }
}

const DEFAULT_MAX_BODY_BYTES = 1024 * 1024
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000
const GATEWAY_ROUTES = new Set([
  'GET /models',
  'POST /responses',
  'POST /responses/stream',
  'GET /storage/shared/items',
  'PUT /storage/shared/items',
])

function json(status: number, code: string, message: string, requestId: string) {
  return new Response(JSON.stringify({ error: { code, message }, request_id: requestId }), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  })
}

function getHeader(request: IncomingRequest, name: string) {
  const value = request.headers[name.toLowerCase()]
  return Array.isArray(value) ? value[0] : value
}

function isLoopback(hostname: string) {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '')
  return normalized === 'localhost' || normalized === '::1' || /^127(?:\.\d{1,3}){3}$/.test(normalized)
}

function isAllowedLocalRequest(request: IncomingRequest) {
  const host = getHeader(request, 'host')
  if (!host) return false
  try {
    const hostURL = new URL(`http://${host}`)
    if (!isLoopback(hostURL.hostname)) return false
    const origin = getHeader(request, 'origin')
    if (!origin) return true
    const originURL = new URL(origin)
    const protocol = request.socket?.encrypted ? 'https:' : 'http:'
    return originURL.protocol === protocol && isLoopback(originURL.hostname) && originURL.port === hostURL.port
      && originURL.pathname === '/' && !originURL.search && !originURL.hash
  } catch { return false }
}

function gatewayBase(value: string) {
  const url = new URL(value)
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/v1'
    || url.search || url.hash || (url.protocol === 'http:' && !isLoopback(url.hostname))) {
    throw new Error('Gateway URL must be a canonical HTTPS /v1 URL or a loopback HTTP /v1 URL')
  }
  return url.toString().replace(/\/$/, '')
}

function requestId(request: IncomingRequest) {
  const value = getHeader(request, 'x-request-id')
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)
    ? value
    : globalThis.crypto?.randomUUID?.() || `req_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`
}

async function requestBody(request: IncomingRequest, limit: number) {
  const chunks: Uint8Array[] = []
  let length = 0
  for await (const chunk of request) {
    length += chunk.byteLength
    if (length > limit) throw Object.assign(new Error('Request body is too large.'), { status: 413, code: 'PAYLOAD_TOO_LARGE' })
    chunks.push(chunk)
  }
  const body = new Uint8Array(length)
  let offset = 0
  for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength }
  return body
}

async function send(response: Response, outgoing: OutgoingResponse, signal: AbortSignal) {
  outgoing.statusCode = response.status
  for (const name of ['content-type', 'content-length', 'retry-after', 'x-request-id']) {
    const value = response.headers.get(name)
    if (value) outgoing.setHeader(name, value)
  }
  outgoing.setHeader('cache-control', 'no-store')
  if (!response.body) { outgoing.end(); return }
  const reader = response.body.getReader()
  try {
    while (true) {
      signal.throwIfAborted()
      const { done, value } = await reader.read()
      if (done) break
      if (!outgoing.write(value)) await new Promise<void>((resolve, reject) => {
        const drain = () => { cleanup(); resolve() }
        const abort = () => { cleanup(); reject(signal.reason) }
        const cleanup = () => { outgoing.removeListener('drain', drain); signal.removeEventListener('abort', abort) }
        outgoing.once('drain', drain)
        signal.addEventListener('abort', abort, { once: true })
      })
    }
  } finally {
    if (signal.aborted) await reader.cancel(signal.reason).catch(() => undefined)
    reader.releaseLock()
  }
  outgoing.end()
}

function platformRequest(gateway: string, accessToken: string, appVersion: string, requestId: string, signal: AbortSignal) {
  return async (path: string, init: RequestInit = {}) => {
    if (typeof path !== 'string' || !path.startsWith('/') || path.startsWith('//') || path.includes('\\') || path.includes('#')) throw new TypeError('Gateway path must be a safe absolute path')
    const url = new URL(path, 'https://proxy-app.invalid')
    if (url.origin !== 'https://proxy-app.invalid' || url.pathname.split('/').some(part => part === '.' || part === '..')) throw new TypeError('Gateway path must be a safe relative API path')
    const method = (init.method || 'GET').toUpperCase()
    if (!GATEWAY_ROUTES.has(`${method} ${url.pathname}`)) throw Object.assign(new Error('Gateway route is not available to this app runtime.'), { status: 403, code: 'APP_RUNTIME_ROUTE_DENIED' })
    const headers = new Headers(init.headers)
    headers.set('Authorization', `Bearer ${accessToken}`)
    headers.set('X-App-Version', appVersion)
    headers.set('X-Request-ID', requestId)
    return fetch(`${gateway}${url.pathname}${url.search}`, {
      ...init,
      method,
      headers,
      signal: AbortSignal.any([signal, AbortSignal.timeout(DEFAULT_TIMEOUT_MS), ...(init.signal ? [init.signal] : [])]),
      credentials: 'omit',
      redirect: 'error',
    })
  }
}

export function createAppRuntimeDevPlugin(options: AppRuntimeDevPluginOptions) {
  if (!options || typeof options.appId !== 'string' || !/^(?:app_[a-z0-9][a-z0-9._-]{2,119}|[a-z0-9]+(?:[.-][a-z0-9]+)*)$/.test(options.appId)) throw new Error('appId must be a valid app slug or platform app id')
  if (typeof options.appVersion !== 'string' || !options.appVersion.trim()) throw new Error('appVersion is required')
  if (typeof options.entry !== 'string' || !options.entry.startsWith('/') || options.entry.includes('..')) throw new Error('entry must be a safe Vite SSR module id')
  if (typeof options.basePath !== 'string' || !/^\/[A-Za-z0-9._/-]+$/.test(options.basePath) || options.basePath.includes('//') || options.basePath.split('/').some(part => part === '.' || part === '..')) throw new Error('app runtime basePath must be a normalized absolute path')
  const basePath = options.basePath.replace(/\/$/, '') || '/'
  const routes = options.routes?.map(route => {
    if (typeof route !== 'string' || !route.startsWith(`${basePath}/`) || route.startsWith('//') || /[?#\\]/.test(route) || route.split('/').includes('..') || route.includes('*')) throw new Error('routes must be safe exact paths under basePath')
    return route
  })
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  if (!Number.isInteger(maxBodyBytes) || maxBodyBytes < 1 || maxBodyBytes > 10 * 1024 * 1024) throw new Error('maxBodyBytes must be between 1 byte and 10 MiB')
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 10 * 60 * 1000) throw new Error('timeoutMs must be between 100 ms and 10 minutes')
  const env = (globalThis as typeof globalThis & { process?: { env?: Record<string, string | undefined> } }).process?.env
  const gateway = options.gatewayURL?.trim() || env?.PROXY_PLATFORM_GATEWAY_URL?.trim()
  const gatewayURL = gateway ? gatewayBase(gateway) : ''
  let server: DevServer

  return {
    name: 'proxy-app-stateless-runtime-dev',
    enforce: 'pre' as const,
    configureServer(viteServer: DevServer) {
      server = viteServer
      viteServer.middlewares.use((incoming, outgoing, next) => {
        void (async () => {
          const method = (incoming.method || 'GET').toUpperCase()
          let url: URL
          try { url = new URL(incoming.url || '/', 'http://proxy-app.local') } catch { next(); return }
          if (url.pathname !== basePath && !url.pathname.startsWith(`${basePath}/`)) { next(); return }
          if (routes && !routes.includes(url.pathname)) { next(); return }

          const id = requestId(incoming)
          const controller = new AbortController()
          let timedOut = false
          const abort = () => { if (!outgoing.writableEnded) controller.abort(new DOMException('Client disconnected', 'AbortError')) }
          incoming.on('aborted', abort)
          outgoing.on('close', abort)
          const timer = setTimeout(() => { timedOut = true; controller.abort(new DOMException('Runtime request timed out', 'TimeoutError')) }, timeoutMs)
          try {
            if (!isAllowedLocalRequest(incoming)) { await send(json(403, 'APP_RUNTIME_LOCAL_ONLY', 'The app runtime is available only from the local development origin.', id), outgoing, controller.signal); return }
            if (!['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) { await send(json(405, 'METHOD_NOT_ALLOWED', 'Method not allowed.', id), outgoing, controller.signal); return }
            const sessionHeader = new Headers()
            const authorization = getHeader(incoming, 'authorization')
            const appVersion = getHeader(incoming, 'x-app-version')
            if (authorization) sessionHeader.set('authorization', authorization)
            if (appVersion) sessionHeader.set('x-app-version', appVersion)
            const body = method === 'GET' || method === 'HEAD' ? undefined : await requestBody(incoming, maxBodyBytes)
            const headers = new Headers()
            for (const name of ['content-type', 'accept']) { const value = getHeader(incoming, name); if (value) headers.set(name, value) }
            headers.set('X-Request-ID', id)
            const request = new Request(`http://proxy-app.local${url.pathname}${url.search}`, { method, headers, ...(body?.byteLength ? { body } : {}), signal: controller.signal })
            const module = await server.ssrLoadModule(options.entry)
            const handler = (module.handler || module.default) as AppHandler | undefined
            if (typeof handler !== 'function') throw new Error(`Runtime entry must export handler(request, context): ${options.entry}`)
            const session = sessionForRequest(sessionHeader, options.appId, options.appVersion, gatewayURL)
            const context: AppRuntimeContext = {
              appId: options.appId, appVersion: options.appVersion, requestId: id, signal: controller.signal,
              platform: { request: platformRequest(session.gatewayURL, session.accessToken, options.appVersion, id, controller.signal) },
            }
            const result = await handler(request, context)
            if (!(result instanceof Response)) throw new TypeError('App handler must return a Fetch Response')
            await send(result, outgoing, controller.signal)
          } catch (cause) {
            if (outgoing.writableEnded || outgoing.headersSent) { if (!outgoing.writableEnded) outgoing.end(); return }
            const error = cause as Error & { status?: number; code?: string }
            if (controller.signal.aborted && !timedOut) return
            const status = error.status || (timedOut ? 504 : 500)
            const response = json(status, error.code || (timedOut ? 'APP_RUNTIME_TIMEOUT' : 'APP_RUNTIME_FAILED'), status === 401 ? 'Sign in to the platform before calling this app.' : status === 403 ? 'The platform session is not authorized for this app.' : status === 504 ? 'Application runtime request timed out.' : 'Application runtime request failed.', id)
            await send(response, outgoing, controller.signal.aborted ? new AbortController().signal : controller.signal)
            if (status === 500) console.error(`[proxy-app-runtime] ${options.appId}@${options.appVersion} ${id}:`, error.message)
          } finally {
            clearTimeout(timer)
            incoming.removeListener('aborted', abort)
            outgoing.removeListener('close', abort)
          }
        })().catch(next)
      })
    },
  }
}

function sessionForRequest(headers: Headers, appId: string, appVersion: string, gatewayURL: string) {
  const authorization = headers.get('authorization') || ''
  const token = /^Bearer\s+(ast_[A-Za-z0-9._-]{8,4096})$/.exec(authorization)?.[1]
  if (!token) throw Object.assign(new Error('The browser did not provide a valid app session.'), { status: 401, code: 'APP_LOGIN_REQUIRED' })
  if (headers.get('x-app-version') !== appVersion) throw Object.assign(new Error('The browser app version does not match this local handler.'), { status: 403, code: 'APP_SESSION_VERSION_MISMATCH' })
  if (!gatewayURL) throw Object.assign(new Error(`No Gateway URL configured for app ${appId}.`), { status: 503, code: 'LOCAL_GATEWAY_NOT_CONFIGURED' })
  return { accessToken: token, gatewayURL }
}
