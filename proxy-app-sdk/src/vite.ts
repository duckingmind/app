/**
 * Vite development proxy for the platform data plane.
 *
 * The proxy is intentionally opt-in through an environment variable. It is
 * only meant for a loopback Vite server; production app bundles never use it.
 */

/** Same-origin paths used by page-runtime apps in development and production. */
export const PLATFORM_DEV_PROXY_PATH = '/v1'
export const PLATFORM_DEV_LEGACY_PROXY_PATH = '/__platform/v1'
export const PLATFORM_DEV_RUNTIME_PATH = '/api/app-runtime/v1'
export const PLATFORM_DEV_GATEWAY_ENV = 'PROXY_PLATFORM_GATEWAY_URL'
export const PLATFORM_DEV_RUNTIME_ENV = 'PROXY_PLATFORM_RUNTIME_URL'
export const PLATFORM_DEV_BRIDGE_ENV = 'PROXY_PLATFORM_BRIDGE_URL'
export const PLATFORM_DEV_RELAY_SECRET_ENV = 'PROXY_PLATFORM_RELAY_SECRET'
export const PLATFORM_DEV_BRIDGE_PATH = '/__platform/bridge'
export const PLATFORM_DEV_AUTH_ENV = 'PROXY_PLATFORM_AUTH_URL'
export const PLATFORM_DEV_AUTH_PATH = '/__platform/auth'

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
  /** Runtime API URL. Defaults to PROXY_PLATFORM_RUNTIME_URL. */
  runtimeURL?: string
  /** Local runtime path exposed by Vite. */
  runtimePath?: string
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
  return {
    origin: parsed.origin,
    path: normalizePath(parsed.pathname === '/' ? defaultGatewayPath : parsed.pathname, defaultGatewayPath),
    secure: parsed.protocol === 'https:',
  }
}

/**
 * Create a Vite server.proxy entry for local platform development.
 *
 * The returned proxy forwards JSON, SSE, multipart, and binary bodies without
 * inspecting them. Browser cookies and origin metadata are deliberately
 * removed; the App Session bearer and request idempotency headers are kept.
 */
export function createPlatformDevProxy(options: PlatformDevProxyOptions = {}): Record<string, PlatformDevProxyConfig> | undefined {
  const rawGatewayURL = options.gatewayURL?.trim() || environmentValue(PLATFORM_DEV_GATEWAY_ENV)
  const rawRuntimeURL = options.runtimeURL?.trim() || environmentValue(PLATFORM_DEV_RUNTIME_ENV)
  const rawBridgeURL = environmentValue(PLATFORM_DEV_BRIDGE_ENV)
  const rawAuthURL = environmentValue(PLATFORM_DEV_AUTH_ENV)
  const relaySecret = environmentValue(PLATFORM_DEV_RELAY_SECRET_ENV)
  if (!rawGatewayURL && !rawRuntimeURL && !rawBridgeURL && !rawAuthURL) return undefined

  const localPath = normalizePath(options.path || PLATFORM_DEV_PROXY_PATH, PLATFORM_DEV_PROXY_PATH)
  const gateway = rawGatewayURL ? splitGatewayURL(rawGatewayURL, options.defaultGatewayPath || '/v1') : null
  const runtime = rawRuntimeURL ? splitGatewayURL(rawRuntimeURL, '/api/app-runtime/v1') : null
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
          if (relaySecret) proxyRequest.setHeader('X-Proxy-App-Relay', relaySecret)
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
    if (!options.path) addProxy(PLATFORM_DEV_LEGACY_PROXY_PATH, gateway, 'gateway')
  }
  if (runtime) addProxy(normalizePath(options.runtimePath || PLATFORM_DEV_RUNTIME_PATH, PLATFORM_DEV_RUNTIME_PATH), runtime, 'runtime')
  if (rawBridgeURL) {
    const bridge = splitGatewayURL(rawBridgeURL, '/bridge')
    config[PLATFORM_DEV_BRIDGE_PATH] = {
      target: bridge.origin,
      changeOrigin: true,
      secure: bridge.secure,
      ws: false,
      timeout: 0,
      proxyTimeout: 0,
      rewrite(requestPath) {
        const queryIndex = requestPath.indexOf('?')
        return `${bridge.path}${queryIndex >= 0 ? requestPath.slice(queryIndex) : ''}`
      },
      configure(proxy: any) {
        proxy.on('proxyReq', (proxyRequest: { removeHeader: (name: string) => void; setHeader: (name: string, value: string) => void }) => {
          proxyRequest.removeHeader('cookie')
          proxyRequest.removeHeader('origin')
          proxyRequest.removeHeader('referer')
          if (relaySecret) proxyRequest.setHeader('X-Proxy-App-Relay', relaySecret)
        })
        proxy.on('proxyRes', (proxyResponse: { headers: Record<string, string | undefined> }) => {
          proxyResponse.headers['cache-control'] = 'no-store'
          proxyResponse.headers['x-proxy-app-dev'] = '1'
        })
      },
    }
  }
  if (rawAuthURL) {
    const auth = splitGatewayURL(rawAuthURL, '/auth')
    config[PLATFORM_DEV_AUTH_PATH] = {
      target: auth.origin,
      changeOrigin: true,
      secure: auth.secure,
      ws: false,
      timeout: 0,
      proxyTimeout: 0,
      rewrite(requestPath) {
        const queryIndex = requestPath.indexOf('?')
        const path = queryIndex >= 0 ? requestPath.slice(0, queryIndex) : requestPath
        const suffix = path.slice(PLATFORM_DEV_AUTH_PATH.length) || '/'
        return `${auth.path}${suffix.startsWith('/') ? suffix : `/${suffix}`}${queryIndex >= 0 ? requestPath.slice(queryIndex) : ''}`
      },
      configure(proxy: any) {
        proxy.on('proxyReq', (proxyRequest: { removeHeader: (name: string) => void; setHeader: (name: string, value: string) => void }) => {
          proxyRequest.removeHeader('cookie')
          proxyRequest.removeHeader('origin')
          proxyRequest.removeHeader('referer')
          if (relaySecret) proxyRequest.setHeader('X-Proxy-App-Relay', relaySecret)
        })
        proxy.on('proxyRes', (proxyResponse: { headers: Record<string, string | undefined> }) => {
          proxyResponse.headers['cache-control'] = 'no-store'
          proxyResponse.headers['x-proxy-app-dev'] = '1'
        })
      },
    }
  }
  return Object.keys(config).length ? config : undefined
}
