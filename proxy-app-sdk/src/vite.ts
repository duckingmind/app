/// <reference path="./node-shims.d.ts" />

/**
 * Vite development proxy for the platform data plane.
 *
 * The proxy is intentionally opt-in through an environment variable. It is
 * only meant for a loopback Vite server; production app bundles never use it.
 */

/** Same-origin paths used by page apps in development and production. */
export const PLATFORM_DEV_PROXY_PATH = '/v1'
export const PLATFORM_DEV_GATEWAY_ENV = 'PROXY_PLATFORM_GATEWAY_URL'
export const APP_BACKEND_DEV_ENV = 'PROXY_APP_BACKEND_URL'
export const APP_BACKEND_DEV_PATH = '/api'
export const APP_SESSION_EXCHANGE_PATH = '/__proxy-app/auth/session'
export const APP_SESSION_GRANT_PATH = '/__proxy-app/auth/grant'

type ProcessLike = {
  env?: Record<string, string | undefined>
}

export type PlatformDevProxyOptions = {
  /** Full online gateway URL, normally https://api.example.com/v1. */
  gatewayURL?: string
  /** Local path exposed by Vite and used by the App SDK. */
  path?: string
  /** Default gateway path when only an origin is supplied. */
  defaultGatewayPath?: string
  /** Optional loopback app backend used by `proxy-app dev`. */
  backendURL?: string
}

export type PlatformDevSessionPluginOptions = {
  apiURL?: string
  portalURL?: string
  appId?: string
  appVersion?: string
  developmentGrant?: string
}

export type PlatformDevProxyConfig = {
  target: string
  changeOrigin: boolean
  secure: boolean
  ws: boolean
  timeout: number
  proxyTimeout: number
  rewrite: (requestPath: string) => string
  // Keep this structural type compatible with both Vite 5 and Vite 8's
  // http-proxy server declarations.
  configure: (...args: any[]) => void
}

function environmentValue(name: string) {
  const processValue = (globalThis as typeof globalThis & { process?: ProcessLike }).process
  return processValue?.env?.[name]?.trim() || ''
}

function normalizePath(value: string, fallback: string) {
  const path = value.trim() || fallback
  if (!path.startsWith('/') || path.includes('..') || path.includes('?') || path.includes('#')) {
    throw new Error(`platform gateway path must be an absolute safe path: ${path}`)
  }
  return path.replace(/\/+$/, '') || '/'
}

function splitGatewayURL(rawURL: string, defaultGatewayPath: string) {
  let parsed: URL
  try {
    parsed = new URL(rawURL)
  } catch {
    throw new Error(`${PLATFORM_DEV_GATEWAY_ENV} must be a valid http(s) URL`)
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error(`${PLATFORM_DEV_GATEWAY_ENV} must be an http(s) URL without credentials, query, or hash`)
  }
  const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '')
  const loopback = hostname === 'localhost' || hostname === '::1' || /^127(?:\.\d{1,3}){3}$/.test(hostname)
  const pathStart = rawURL.indexOf('/', rawURL.indexOf('://') + 3)
  const rawPath = pathStart < 0 ? '/' : rawURL.slice(pathStart)
  if (rawURL.includes('\\') || rawPath !== parsed.pathname ||
    (parsed.pathname !== '/' && parsed.pathname !== defaultGatewayPath) ||
    /(?:^|[.-])(?:admin|admin-api|admin-go|codex-admin-api|portal|www)(?:[.-]|$)/.test(hostname) ||
    (parsed.protocol === 'http:' && !loopback)) {
    throw new Error('platform proxy must use the canonical Gateway /v1 URL')
  }
  return {
    origin: parsed.origin,
    path: normalizePath(parsed.pathname === '/' ? defaultGatewayPath : parsed.pathname, defaultGatewayPath),
    secure: parsed.protocol === 'https:',
  }
}

function splitBackendURL(rawURL: string) {
  let parsed: URL
  try {
    parsed = new URL(rawURL)
  } catch {
    throw new Error(`${APP_BACKEND_DEV_ENV} must be a loopback http(s) URL`)
  }
  const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '')
  const loopback = hostname === 'localhost' || hostname === '::1' || /^127(?:\.\d{1,3}){3}$/.test(hostname)
  if (!loopback || !['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) {
    throw new Error(`${APP_BACKEND_DEV_ENV} must be a loopback http(s) origin without credentials, path, query, or hash`)
  }
  return { origin: parsed.origin, secure: parsed.protocol === 'https:' }
}

function splitSessionExchangeConfig(options: PlatformDevSessionPluginOptions) {
  const apiURL = options.apiURL?.trim() || environmentValue('PROXY_APP_DEV_SESSION_API_URL')
  const portalURL = options.portalURL?.trim() || environmentValue('PROXY_APP_DEV_SESSION_PORTAL_URL')
  const appId = options.appId?.trim() || environmentValue('PROXY_APP_DEV_SESSION_ID')
  const appVersion = options.appVersion?.trim() || environmentValue('PROXY_APP_DEV_SESSION_VERSION')
  const developmentGrant = options.developmentGrant?.trim() || environmentValue('PROXY_APP_DEV_SESSION_GRANT')
  if (!apiURL && !portalURL && !appId && !appVersion && !developmentGrant) return null
  if (!apiURL || !portalURL || !appId || !appVersion || !developmentGrant) {
    throw new Error('local App Session exchange requires API, Portal, app ID, app version, and preview grant settings')
  }
  let api: URL
  let portal: URL
  try { api = new URL(apiURL); portal = new URL(portalURL) } catch {
    throw new Error('local App Session exchange requires valid API and Portal URLs')
  }
  if (!['http:', 'https:'].includes(api.protocol) || api.username || api.password || api.search || api.hash || api.pathname.replace(/\/$/, '') !== '/api') {
    throw new Error('local App Session exchange API URL must be an http(s) /api base URL')
  }
  if (api.protocol === 'http:' && !isLoopback(api.hostname)) {
    throw new Error('local App Session exchange API must use HTTPS outside loopback')
  }
  if (!['http:', 'https:'].includes(portal.protocol) || portal.username || portal.password || portal.pathname !== '/' || portal.search || portal.hash) {
    throw new Error('local App Session exchange Portal URL must be an origin')
  }
  if (portal.protocol === 'http:' && !isLoopback(portal.hostname)) {
    throw new Error('local App Session exchange Portal must use HTTPS outside loopback')
  }
  if (!/^(?:app_[a-z0-9][a-z0-9._-]{2,119}|[a-z0-9]+(?:[.-][a-z0-9]+)*)$/.test(appId)) {
    throw new Error('local App Session exchange app ID is invalid')
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/.test(appVersion)) {
    throw new Error('local App Session exchange app version is invalid')
  }
  if (developmentGrant.length < 32 || developmentGrant.length > 8192) {
    throw new Error('local App Session exchange preview grant is invalid')
  }
  return { apiBase: api.origin + api.pathname.replace(/\/$/, ''), portalOrigin: portal.origin, appId, appVersion, developmentGrant }
}

function isLoopback(hostname: string) {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '')
  return host === 'localhost' || host === '::1' || /^127(?:\.\d{1,3}){3}$/.test(host)
}

type LocalSessionRequest = {
  method?: string
  url?: string
  headers: Record<string, string | string[] | undefined>
  socket?: { encrypted?: boolean }
  resume?: () => void
  [Symbol.asyncIterator]?: () => AsyncIterator<Uint8Array | string>
}

type LocalSessionResponse = {
  statusCode?: number
  writableEnded?: boolean
  setHeader(name: string, value: string): void
  end(body?: string): void
}

function headerValue(request: LocalSessionRequest, name: string) {
  const value = request.headers[name.toLowerCase()]
  return Array.isArray(value) ? value[0] || '' : value || ''
}

function localSessionJSON(response: LocalSessionResponse, status: number, payload: unknown, requestId: string) {
  if (response.writableEnded) return
  response.statusCode = status
  response.setHeader('Content-Type', 'application/json; charset=utf-8')
  response.setHeader('Cache-Control', 'private, no-store')
  response.setHeader('Pragma', 'no-cache')
  response.setHeader('X-Request-ID', requestId)
  response.setHeader('X-Content-Type-Options', 'nosniff')
  response.setHeader('Referrer-Policy', 'no-referrer')
  response.end(JSON.stringify(payload))
}

/**
 * Loopback-only bridge for the Portal device cookie and a separate, app-scoped
 * preview grant. The grant is exposed only to the local app origin so Portal
 * login can mint a session for the signed-in user without making that user an
 * application developer.
 */
export function createPlatformDevSessionPlugin(options: PlatformDevSessionPluginOptions = {}) {
  const config = splitSessionExchangeConfig(options)
  return {
    name: 'proxy-app-local-cookie-session-exchange',
    apply: 'serve' as const,
    configureServer(server: { middlewares: { use(handler: (request: LocalSessionRequest, response: LocalSessionResponse, next: (error?: unknown) => void) => void): void } }) {
      if (!config) return
      server.middlewares.use((request, response, next) => {
        let parsed: URL
        try { parsed = new URL(request.url || '/', `http://${headerValue(request, 'host') || '127.0.0.1'}`) } catch { next(); return }
        if (parsed.pathname !== APP_SESSION_EXCHANGE_PATH && parsed.pathname !== APP_SESSION_GRANT_PATH) { next(); return }

        const requestIdHeader = headerValue(request, 'x-request-id').trim()
        const requestId = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(requestIdHeader)
          ? requestIdHeader
          : globalThis.crypto.randomUUID()
        const reject = (status: number, code: string, message: string) => {
          request.resume?.()
          localSessionJSON(response, status, { code, error: message, message }, requestId)
        }

        if (parsed.pathname === APP_SESSION_GRANT_PATH) {
          const host = headerValue(request, 'host')
          let appOrigin: URL
          try {
            const scheme = request.socket?.encrypted ? 'https:' : 'http:'
            appOrigin = new URL(`${scheme}//${host}`)
          } catch {
            reject(403, 'APP_SESSION_CSRF_REJECTED', 'Preview grant is available only to the local app origin.')
            return
          }
          const origin = headerValue(request, 'origin')
          const fetchSite = headerValue(request, 'sec-fetch-site').toLowerCase()
          const referer = headerValue(request, 'referer')
          let sameOriginReferer = false
          if (referer) {
            try { sameOriginReferer = new URL(referer).origin === appOrigin.origin } catch { /* reject below */ }
          }
          // Browsers commonly omit Origin on a same-origin GET. Keep the
          // browser-native Sec-Fetch-Site/Referer signals as the CSRF check;
          // an explicit Origin must still match exactly.
          const sameOriginRequest = origin
            ? origin === appOrigin.origin && (!fetchSite || fetchSite === 'same-origin')
            : fetchSite === 'same-origin' || sameOriginReferer
          if (request.method !== 'GET' || parsed.search || parsed.hash || !isLoopback(appOrigin.hostname)
            || !sameOriginRequest
            || fetchSite && fetchSite !== 'same-origin') {
            reject(403, 'APP_SESSION_CSRF_REJECTED', 'Preview grant is available only to a same-origin local app request.')
            return
          }
          request.resume?.()
          localSessionJSON(response, 200, { data: { development_grant: config.developmentGrant } }, requestId)
          return
        }

        if (parsed.search || parsed.hash || request.method !== 'POST') {
          reject(405, 'METHOD_NOT_ALLOWED', 'App Session exchange requires a POST without query parameters.')
          return
        }
        const contentType = headerValue(request, 'content-type').split(';', 1)[0].trim().toLowerCase()
        if (contentType !== 'application/json') {
          reject(415, 'APP_SESSION_INVALID_REQUEST', 'App Session exchange requires application/json.')
          return
        }
        const host = headerValue(request, 'host')
        let appOrigin: URL
        try {
          const scheme = request.socket?.encrypted ? 'https:' : 'http:'
          appOrigin = new URL(`${scheme}//${host}`)
        } catch {
          reject(403, 'APP_SESSION_CSRF_REJECTED', 'App Session exchange must use the local app origin.')
          return
        }
        if (!isLoopback(appOrigin.hostname) || appOrigin.username || appOrigin.password || appOrigin.pathname !== '/') {
          reject(403, 'APP_SESSION_CSRF_REJECTED', 'App Session exchange is available only from a loopback app origin.')
          return
        }
        const requestOrigin = headerValue(request, 'origin')
        const fetchSite = headerValue(request, 'sec-fetch-site').toLowerCase()
        if (!requestOrigin || requestOrigin !== appOrigin.origin || fetchSite && fetchSite !== 'same-origin') {
          reject(403, 'APP_SESSION_CSRF_REJECTED', 'App Session exchange must be a same-origin browser request.')
          return
        }

        // Cookies are scoped by hostname rather than port. Only forward the
        // Portal cookie when app and Portal share the same local scheme/host;
        // otherwise let the SDK use the normal Portal login popup.
        const portal = new URL(config.portalOrigin)
        if (portal.protocol !== appOrigin.protocol || portal.hostname.toLowerCase() !== appOrigin.hostname.toLowerCase()) {
          reject(401, 'DEVICE_TOKEN_INVALID', 'Sign in through the Portal to establish a browser device session.')
          return
        }
        const cookieHeader = headerValue(request, 'cookie')
        const deviceGrant = cookieHeader.match(/(?:^|;\s*)codex_device_token=([^;]+)/)?.[1]?.trim()
        if (!deviceGrant) {
          reject(401, 'DEVICE_TOKEN_INVALID', 'Portal device session is missing or expired.')
          return
        }

        void (async () => {
          let body = ''
          if (request[Symbol.asyncIterator]) {
            for await (const chunk of request as AsyncIterable<Uint8Array | string>) {
              body += typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk)
              if (body.length > 4096) {
                reject(413, 'APP_SESSION_INVALID_REQUEST', 'App Session exchange request is too large.')
                return
              }
            }
          }
          let payload: unknown
          try { payload = JSON.parse(body) } catch {
            reject(400, 'APP_SESSION_INVALID_REQUEST', 'App Session exchange request is invalid.')
            return
          }
          if (!payload || typeof payload !== 'object' || Array.isArray(payload)
            || (payload as Record<string, unknown>).expected_version !== config.appVersion
            || Object.keys(payload).some(key => key !== 'expected_version')) {
            reject(409, 'APP_SESSION_VERSION_MISMATCH', 'Local app version changed; restart the development server.')
            return
          }

          const target = `${config.apiBase}/market/apps/${encodeURIComponent(config.appId)}/development-sessions`
          const controller = new AbortController()
          const timeout = setTimeout(() => controller.abort(), 30_000)
          try {
            const upstream = await fetch(target, {
              method: 'POST',
              redirect: 'error',
              cache: 'no-store',
              signal: controller.signal,
              headers: {
                Accept: 'application/json',
                'Content-Type': 'application/json',
                Cookie: `codex_device_token=${deviceGrant}`,
                'X-App-Development-Grant': config.developmentGrant,
                Origin: config.portalOrigin,
                'Sec-Fetch-Site': 'same-origin',
                'X-Request-ID': requestId,
                ...(headerValue(request, 'x-workspace-id').trim()
                  && headerValue(request, 'x-workspace-id').trim().length <= 128
                  && !/[\r\n]/.test(headerValue(request, 'x-workspace-id'))
                  ? { 'X-Workspace-ID': headerValue(request, 'x-workspace-id').trim() }
                  : {}),
              },
              body: JSON.stringify({ expected_version: config.appVersion }),
            })
            const responseBody = await upstream.text()
            response.statusCode = upstream.status
            response.setHeader('Content-Type', upstream.headers.get('content-type') || 'application/json; charset=utf-8')
            response.setHeader('Cache-Control', 'private, no-store')
            response.setHeader('Pragma', 'no-cache')
            response.setHeader('X-Request-ID', upstream.headers.get('x-request-id') || requestId)
            response.end(responseBody)
          } catch {
            localSessionJSON(response, 502, {
              code: 'APP_SESSION_EXCHANGE_FAILED',
              error: 'Platform App Session exchange could not be reached.',
              message: 'Platform App Session exchange could not be reached.',
            }, requestId)
          } finally {
            clearTimeout(timeout)
          }
        })().catch(() => {
          localSessionJSON(response, 500, {
            code: 'APP_SESSION_EXCHANGE_FAILED',
            error: 'Platform App Session exchange failed.',
            message: 'Platform App Session exchange failed.',
          }, requestId)
        })
      })
    },
  }
}

/**
 * Create a Vite server.proxy entry for local platform development.
 *
 * The Gateway proxy forwards JSON, SSE, multipart, and binary bodies without
 * inspecting them. Authentication happens on the Portal origin, so this local
 * proxy only transports Gateway and app-backend requests. Browser cookies and
 * origin metadata are removed from proxied requests.
 */
export function createPlatformDevProxy(options: PlatformDevProxyOptions = {}): Record<string, PlatformDevProxyConfig> | undefined {
  const rawGatewayURL = options.gatewayURL?.trim() || environmentValue(PLATFORM_DEV_GATEWAY_ENV)
  const rawBackendURL = options.backendURL?.trim() || environmentValue(APP_BACKEND_DEV_ENV)
  if (!rawGatewayURL && !rawBackendURL) return undefined

  if ((options.path !== undefined && options.path !== '/v1') ||
    (options.defaultGatewayPath !== undefined && options.defaultGatewayPath !== '/v1')) {
    throw new Error('platform Gateway proxy path must be /v1')
  }

  const localPath = normalizePath(options.path || PLATFORM_DEV_PROXY_PATH, PLATFORM_DEV_PROXY_PATH)
  const gateway = rawGatewayURL ? splitGatewayURL(rawGatewayURL, options.defaultGatewayPath || '/v1') : null
  const backend = rawBackendURL ? splitBackendURL(rawBackendURL) : null
  const prefix = localPath.replace(/\/$/, '')

  const config: Record<string, PlatformDevProxyConfig> = {}
  const addProxy = (path: string, targetURL: { origin: string; path: string; secure: boolean }, label: string) => {
    config[path] = {
      target: targetURL.origin,
      changeOrigin: true,
      secure: targetURL.secure,
      ws: false,
      // Do not impose a short dev-server timeout on video/image jobs or SSE.
      timeout: 0,
      proxyTimeout: 0,
      rewrite(requestPath) {
        const suffix = requestPath.slice(path.length) || '/'
        return `${targetURL.path}${suffix.startsWith('/') ? suffix : `/${suffix}`}`
      },
      configure(proxy: any) {
        proxy.on('proxyReq', (proxyRequest: { removeHeader: (name: string) => void; setHeader: (name: string, value: string) => void }) => {
          proxyRequest.removeHeader('cookie')
          proxyRequest.removeHeader('origin')
          proxyRequest.removeHeader('referer')
          proxyRequest.removeHeader('x-proxy-app-relay')
        })
        proxy.on('proxyRes', (proxyResponse: { headers: Record<string, string | undefined> }) => {
          // Prevent a browser or an intermediary from caching user-scoped
          // model results, task states, or streamed responses.
          proxyResponse.headers['cache-control'] = 'no-store'
          proxyResponse.headers['x-proxy-app-dev'] = '1'
          proxyResponse.headers['x-proxy-app-route'] = label
        })
      },
    }
  }
  if (gateway) {
    // The configured target is intentionally the gateway, rather than the
    // browser-facing path. This keeps local requests identical to production.
    addProxy(prefix, gateway, 'gateway')
  }
  if (backend) {
    config[APP_BACKEND_DEV_PATH] = {
      target: backend.origin,
      changeOrigin: true,
      secure: backend.secure,
      ws: false,
      timeout: 0,
      proxyTimeout: 0,
      rewrite(requestPath) {
        return requestPath
      },
      configure(proxy: any) {
        proxy.on('proxyReq', (proxyRequest: { removeHeader: (name: string) => void }) => {
          proxyRequest.removeHeader('cookie')
          proxyRequest.removeHeader('origin')
          proxyRequest.removeHeader('referer')
          proxyRequest.removeHeader('x-proxy-app-relay')
        })
        proxy.on('proxyRes', (proxyResponse: { headers: Record<string, string | undefined> }) => {
          proxyResponse.headers['cache-control'] = 'no-store'
          proxyResponse.headers['x-proxy-app-dev'] = '1'
          proxyResponse.headers['x-proxy-app-route'] = 'backend'
        })
      },
    }
  }
  return Object.keys(config).length ? config : undefined
}
