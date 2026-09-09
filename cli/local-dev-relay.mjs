import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import { Readable } from 'node:stream'

const HOP_BY_HOP_HEADERS = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade'])
const SENSITIVE_HEADERS = new Set(['host', 'authorization', 'cookie', 'origin', 'referer', 'content-length', 'x-proxy-app-relay'])
const PLATFORM_AUTH_TIMEOUT_MS = 30 * 1000

function copyRequestHeaders(request) {
  const headers = new Headers()
  for (const [name, value] of Object.entries(request.headers)) {
    const lower = name.toLowerCase()
    if (HOP_BY_HOP_HEADERS.has(lower) || SENSITIVE_HEADERS.has(lower)) continue
    if (Array.isArray(value)) headers.set(name, value.join(', '))
    else if (value !== undefined) headers.set(name, value)
  }
  return headers
}

function copyResponseHeaders(response, target) {
  response.headers.forEach((value, name) => {
    const lower = name.toLowerCase()
    if (!HOP_BY_HOP_HEADERS.has(lower) && !['content-encoding', 'content-length', 'set-cookie'].includes(lower)) target.setHeader(name, value)
  })
}

async function readBody(request, limit = 16 * 1024 * 1024) {
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > limit) throw new Error('local development request body is too large')
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

async function readJSON(response) {
  const text = await response.text().catch(() => '')
  if (!text.trim()) return {}
  try { return JSON.parse(text) } catch { return { message: text } }
}

function unwrap(payload) {
  return payload && Object.prototype.hasOwnProperty.call(payload, 'data') ? payload.data : payload
}

function errorMessage(payload, fallback) {
  const error = typeof payload?.error === 'string' ? payload.error : payload?.error?.message
  return error || payload?.message || fallback
}

function errorCode(payload) {
  const error = payload?.error
  const code = typeof error === 'object' && error ? error.code : undefined
  return String(code || payload?.code || '').trim()
}

async function retryableSessionExpiry(response, runtimeRequest) {
  if (response?.status !== 401) return false
  const payload = await readJSON(response.clone())
  const error = payload?.error
  const reason = typeof error === 'object' && error ? error.auth_reason : undefined
  const executionStarted = typeof error === 'object' && error && Object.prototype.hasOwnProperty.call(error, 'execution_started')
    ? error.execution_started
    : payload?.execution_started
  return (runtimeRequest ? errorCode(payload) : reason) === 'APP_SESSION_EXPIRED' && executionStarted === false
}

function relayError(code, message, stage, statusCode = 502, cause) {
  const error = new Error(message)
  error.code = code
  error.stage = stage
  error.statusCode = statusCode
  if (cause) error.cause = cause
  return error
}

function visibleErrorMessage(error) {
  switch (error?.code) {
    case 'APP_PLATFORM_UNAVAILABLE': return '无法连接平台，请确认平台服务已启动或网络可用后重试。'
    case 'APP_PLATFORM_TIMEOUT': return '平台响应超时，请稍后重试。'
    case 'APP_LOGIN_SESSION_EXPIRED': return '平台登录态已失效，请重新登录。'
    case 'APP_LOGIN_NOT_ALLOWED': return '当前账户无权使用此应用，请切换账户后重试。'
    case 'APP_APP_REGISTRATION_FAILED':
      if (error?.upstreamCode === 'APP_LOCAL_MANIFEST_CONFLICT' || error?.message === 'local development version already exists with a different manifest; bump manifest.version') return '平台登录已完成，但本地 manifest 与已上传或发布的同版本内容不同。请更新 manifest.version 后重启 proxy-app dev。'
      if (error?.statusCode === 403) return '当前登录账户无权开发此应用，请使用创建该应用的账户登录。'
      if (error?.statusCode === 404) return '应用不存在，或当前账户不是应用创建者。请检查 .proxy-app.json 中的应用绑定。'
      return '应用开发登记失败（HTTP ' + error?.statusCode + '），请根据请求编号检查平台日志。'
    case 'APP_SESSION_CREATE_FAILED': return '用户 App Session 创建失败，请稍后重试。'
    case 'APP_SESSION_INVALID': return '平台返回的用户 App Session 无效，请稍后重试。'
    default: return String(error?.message || '平台登录失败，请重试。').slice(0, 240)
  }
}

function htmlEscape(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[character]))
}

function safeScriptJSON(value) {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029')
}

function safeURL(value, label) {
  let parsed
  try { parsed = new URL(value) } catch { throw new Error(label + ' must be a valid http(s) URL') }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error(label + ' must be an http(s) URL without credentials, query, or hash')
  }
  return parsed.origin + parsed.pathname.replace(/\/$/, '')
}

function normalizeGatewayURL(value) {
  const normalized = safeURL(value, 'platform returned gateway URL')
  return normalized.endsWith('/v1') ? normalized : normalized + '/v1'
}

function jsonResponse(response, status, payload) {
  response.statusCode = status
  response.setHeader('Content-Type', 'application/json')
  response.setHeader('Cache-Control', 'no-store')
  response.end(JSON.stringify(payload))
}

/**
 * Real local development relay. It stores only the current signed-in user's
 * Portal token in memory and gives the app an App Session, never the Portal
 * token. The token is obtained through the platform login callback, not from
 * the developer's shell environment, so model calls belong to the user who
 * opened the local app.
 */
export async function createLocalDevelopmentRelay({ baseURL, portalURL = '', relaySecret, appID, appSlug, version, manifest, entryURL, legacyBridge = false }) {
  if (!baseURL || !relaySecret || !appID || !appSlug || !version || !entryURL) throw new Error('local development relay configuration is incomplete')
  const portal = safeURL(baseURL, 'platform API URL')
  const portalOrigin = safeURL(portalURL || portal, 'platform Portal URL')
  const state = { portalToken: '', session: null, refresh: null, login: null, authGeneration: 0, authState: '', authStateIssuedAt: 0, closed: false, revoked: new Set() }
  let server
  let relayURL = ''

  const portalJSON = async (path, init = {}, stage = 'platform', authToken) => {
    const token = authToken === undefined ? state.portalToken : authToken
    if (!token) {
      throw relayError('APP_LOGIN_REQUIRED', 'platform user login is required', stage, 401)
    }
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), PLATFORM_AUTH_TIMEOUT_MS)
    let response
    try {
      response = await fetch(portal + path, {
        ...init,
        signal: controller.signal,
        headers: { Authorization: 'Bearer ' + token, ...(init.headers || {}) },
      })
    } catch (error) {
      clearTimeout(timeout)
      if (error?.name === 'AbortError') throw relayError('APP_PLATFORM_TIMEOUT', 'platform request timed out', stage, 504, error)
      throw relayError('APP_PLATFORM_UNAVAILABLE', 'platform request could not be reached', stage, 502, error)
    }
    clearTimeout(timeout)
    const payload = await readJSON(response)
    if (!response.ok) {
      if (response.status === 401) throw relayError('APP_LOGIN_SESSION_EXPIRED', 'platform user session expired', stage, 401)
      if (response.status === 403) throw relayError('APP_LOGIN_NOT_ALLOWED', 'platform user is not allowed to use this app', stage, 403)
      const code = stage === 'app_registration' ? 'APP_APP_REGISTRATION_FAILED' : stage === 'app_session' ? 'APP_SESSION_CREATE_FAILED' : 'APP_PLATFORM_REQUEST_FAILED'
      const failure = relayError(code, errorMessage(payload, 'platform request failed: HTTP ' + response.status), stage, response.status)
      failure.requestId = response.headers.get('x-request-id') || ''
      failure.upstreamCode = errorCode(payload)
      throw failure
    }
    return unwrap(payload)
  }

  const revoke = async (session, authToken) => {
    const id = session?.session_id
    if (!id || state.revoked.has(id) || !(authToken === undefined ? state.portalToken : authToken)) return
    state.revoked.add(id)
    await portalJSON('/portal/user/apps/' + encodeURIComponent(appID) + '/sessions/' + encodeURIComponent(id), { method: 'DELETE' }, 'platform', authToken).catch(() => undefined)
  }

  const clearAuthentication = async () => {
    const current = state.session
    const token = state.portalToken
    state.authGeneration += 1
    state.session = null
    state.portalToken = ''
    state.refresh = null
    state.login = null
    state.authState = ''
    state.authStateIssuedAt = 0
    await revoke(current, token)
  }

  const assertAuthentication = (generation) => {
    if (state.closed) throw new Error('local development relay is closed')
    if (generation !== state.authGeneration) throw relayError('APP_AUTH_CHANGED', 'local development authentication changed', 'app_session', 409)
  }

  const register = (token) => portalJSON('/portal/user/app-workspace/' + encodeURIComponent(appID) + '/local-development', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ entry_url: entryURL, manifest }),
  }, 'app_registration', token)

  const refresh = async (force = false, generation = state.authGeneration) => {
    assertAuthentication(generation)
    if (state.refresh) return state.refresh
    const refreshToken = state.portalToken
    const previous = force ? state.session : null
    const pending = portalJSON('/portal/user/apps/' + encodeURIComponent(appID) + '/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ version, runtime_protocol: legacyBridge ? 1 : 2 }),
    }, 'app_session', refreshToken).then(async (raw) => {
      if (!raw || typeof raw.access_token !== 'string' || typeof raw.gateway_url !== 'string') throw relayError('APP_SESSION_INVALID', 'platform returned an invalid App Session', 'app_session', 502)
      const next = { ...raw, gateway_url: normalizeGatewayURL(raw.gateway_url) }
      if (state.closed || state.authGeneration !== generation || state.portalToken !== refreshToken) {
        await revoke(next, refreshToken)
        assertAuthentication(generation)
        throw relayError('APP_AUTH_CHANGED', 'local development authentication changed', 'app_session', 409)
      }
      state.session = next
      if (previous && previous.session_id !== next.session_id) await revoke(previous, refreshToken)
      return next
    }).finally(() => {
      if (state.refresh === pending) state.refresh = null
    })
    state.refresh = pending
    return pending
  }

  const loginDetails = () => {
    if (!state.authState || Date.now() - state.authStateIssuedAt > 10 * 60 * 1000) {
      state.authState = randomUUID()
      state.authStateIssuedAt = Date.now()
    }
    const query = new URLSearchParams({ proxy_app_auth: '1', proxy_app_state: state.authState, proxy_app_relay: relayURL })
    return { login_url: portalOrigin + '/#/login?' + query, auth_state: state.authState, relay_url: relayURL }
  }

  const requireLogin = (response, reason) => jsonResponse(response, 401, {
    code: 'APP_LOGIN_REQUIRED',
    error: {
      code: 'APP_LOGIN_REQUIRED',
      message: reason ? visibleErrorMessage(reason) + ' 请重新登录后继续。' : '请登录平台账户后继续',
    },
    ...loginDetails(),
  })

  const callbackHTML = (stateValue, type, error) => {
    const origin = new URL(entryURL).origin
    const isSuccess = type === 'login-complete'
    const message = isSuccess
      ? { protocol: 'proxy-app/auth/v1', type, state: stateValue }
      : {
          protocol: 'proxy-app/auth/v1',
          type: 'login-failed',
          state: stateValue,
          error: {
            code: error?.code || 'APP_LOGIN_FAILED',
            message: visibleErrorMessage(error),
            stage: error?.stage || 'login',
            status: error?.statusCode,
            request_id: error?.requestId || undefined,
            upstream_code: error?.upstreamCode || undefined,
          },
        }
    const title = isSuccess ? '登录成功，正在返回应用...' : visibleErrorMessage(error)
    return '<!doctype html><meta charset="utf-8"><title>平台登录</title><meta name="viewport" content="width=device-width,initial-scale=1"><p>' + htmlEscape(title) + '</p><script>const m=' + safeScriptJSON(message) + ';if(window.opener){window.opener.postMessage(m,' + safeScriptJSON(origin) + ');setTimeout(()=>window.close(),120)}</script>'
  }

  const forward = (target, request, rawBody, token, appVersion) => {
    const headers = copyRequestHeaders(request)
    if (token) headers.set('Authorization', 'Bearer ' + token)
    if (appVersion) headers.set('X-App-Version', appVersion)
    return fetch(target, {
      method: request.method,
      headers,
      body: ['GET', 'HEAD'].includes(request.method || '') ? undefined : rawBody,
      redirect: 'manual',
    })
  }

  const close = async () => {
    if (state.closed) return
    state.closed = true
    await state.refresh?.catch(() => undefined)
    await state.login?.catch(() => undefined)
    const current = state.session
    state.session = null
    await revoke(current)
    if (server?.listening) await new Promise((resolve) => server.close(resolve))
  }

  try {
    server = createServer(async (request, response) => {
      try {
        if (state.closed) throw new Error('local development relay is closed')
        const parsed = new URL(request.url || '/', 'http://127.0.0.1')
        const runtimePrefix = '/api/app-runtime/v1'
        const authPath = parsed.pathname.startsWith(runtimePrefix + '/auth/') ? parsed.pathname.slice(runtimePrefix.length) : parsed.pathname
        const callback = authPath === '/auth/callback' && request.method === 'POST'
        if (!callback && request.headers['x-proxy-app-relay'] !== relaySecret) {
          jsonResponse(response, 403, { code: 'LOCAL_DEV_RELAY_UNAUTHORIZED', error: 'local development relay authentication failed' })
          return
        }
        const rawBody = await readBody(request)
        if (callback) {
          const form = new URLSearchParams(rawBody.toString('utf8'))
          const receivedState = form.get('state') || ''
          const valid = receivedState && receivedState === state.authState && Date.now() - state.authStateIssuedAt <= 10 * 60 * 1000
          response.setHeader('Content-Type', 'text/html; charset=utf-8')
          response.setHeader('Cache-Control', 'no-store')
          if (!valid) {
            response.statusCode = 400
            response.end(callbackHTML(receivedState, 'login-failed', relayError('APP_LOGIN_STATE_INVALID', 'login request expired', 'state_validation', 400)))
            return
          }
          state.authState = ''
          state.authStateIssuedAt = 0
          const previous = state.session
          const previousToken = state.portalToken
          const generation = ++state.authGeneration
          const token = String(form.get('access_token') || '').trim()
          state.session = null
          state.portalToken = token
          state.refresh = null
          const pending = (async () => {
            await revoke(previous, previousToken)
            assertAuthentication(generation)
            if (!token) throw relayError('APP_LOGIN_TOKEN_INVALID', 'platform returned an invalid user session token', 'token_validation', 400)
            await register(token)
            assertAuthentication(generation)
            return refresh(true, generation)
          })()
          state.login = pending
          try {
            await pending
            assertAuthentication(generation)
            response.end(callbackHTML(receivedState, 'login-complete'))
          } catch (error) {
            if (state.authGeneration === generation) await clearAuthentication()
            response.statusCode = error?.statusCode || 502
            response.end(callbackHTML(receivedState, 'login-failed', error))
          } finally {
            if (state.login === pending) state.login = null
          }
          return
        }
        if (parsed.pathname === '/health') { jsonResponse(response, 200, { ok: true, app_id: appID, app_slug: appSlug, app_version: version, runtime_protocol: legacyBridge ? 1 : 2, authenticated: Boolean(state.session) }); return }
        if (authPath === '/auth/start') { jsonResponse(response, 200, { data: { authenticated: Boolean(state.session), ...loginDetails() } }); return }
        if (authPath === '/auth/logout' && request.method === 'POST') {
          await clearAuthentication()
          jsonResponse(response, 200, { data: { success: true } })
          return
        }
        if (authPath === '/auth/status') { jsonResponse(response, 200, { data: { authenticated: Boolean(state.session), app_id: appID, app_version: version } }); return }
        if (parsed.pathname === '/bridge') {
          if (!legacyBridge) {
            jsonResponse(response, 404, { error: { code: 'APP_LEGACY_BRIDGE_DISABLED', message: 'Legacy Bridge is disabled; use the HTTP runtime or start proxy-app dev with --legacy-bridge for an old application.' } })
            return
          }
          if (!state.session) { requireLogin(response); return }
          let bridgeRequest
          try { bridgeRequest = JSON.parse(rawBody.toString('utf8') || '{}') } catch { jsonResponse(response, 400, { code: 'APP_BRIDGE_INVALID_REQUEST', error: 'invalid bridge request' }); return }
          bridgeRequest.appId = appSlug
          const generation = state.authGeneration
          const upstream = await forward(portal + '/portal/user/apps/' + encodeURIComponent(appID) + '/bridge', request, Buffer.from(JSON.stringify(bridgeRequest)), state.portalToken)
          if (state.authGeneration !== generation) {
            await upstream.body?.cancel().catch(() => undefined)
            assertAuthentication(generation)
          }
          if (upstream.status === 401) {
            await clearAuthentication()
            requireLogin(response, relayError('APP_LOGIN_SESSION_EXPIRED', 'platform user session expired', 'bridge', 401))
            return
          }
          response.statusCode = upstream.status
          copyResponseHeaders(upstream, response)
          if (upstream.body) Readable.fromWeb(upstream.body).pipe(response); else response.end()
          return
        }
        const runtimeRequest = parsed.pathname === runtimePrefix || parsed.pathname.startsWith(runtimePrefix + '/')
        const gatewayRequest = parsed.pathname === '/v1' || parsed.pathname.startsWith('/v1/')
        if (runtimeRequest || gatewayRequest) {
          if (!state.session) { requireLogin(response); return }
          const prefix = runtimeRequest ? runtimePrefix : '/v1'
          const suffix = parsed.pathname.slice(prefix.length) || '/'
          const target = (session) => (runtimeRequest ? portal + '/app-runtime/v1' : session.gateway_url) + suffix + parsed.search
          const generation = state.authGeneration
          let current = state.session
          let upstream = await forward(target(current), request, rawBody, current.access_token, current.app_version)
          if (await retryableSessionExpiry(upstream, runtimeRequest)) {
            await upstream.arrayBuffer().catch(() => undefined)
            try {
              assertAuthentication(generation)
              current = state.session && state.session.access_token !== current.access_token ? state.session : await refresh(true, generation)
            } catch (error) {
              assertAuthentication(generation)
              if (error?.code === 'APP_LOGIN_SESSION_EXPIRED' || error?.code === 'APP_LOGIN_NOT_ALLOWED') {
                await clearAuthentication()
                requireLogin(response, error)
                return
              }
              throw error
            }
            assertAuthentication(generation)
            upstream = await forward(target(current), request, rawBody, current.access_token, current.app_version)
          }
          if (state.authGeneration !== generation) {
            await upstream.body?.cancel().catch(() => undefined)
            assertAuthentication(generation)
          }
          response.statusCode = upstream.status
          copyResponseHeaders(upstream, response)
          if (upstream.body) Readable.fromWeb(upstream.body).pipe(response); else response.end()
          return
        }
        jsonResponse(response, 404, { code: 'LOCAL_DEV_ROUTE_NOT_FOUND', error: 'local development route not found' })
      } catch (error) {
        jsonResponse(response, error?.statusCode || (error?.message === 'local development relay is closed' ? 503 : 502), { code: error?.code || 'LOCAL_DEV_RELAY_ERROR', error: error instanceof Error ? error.message : String(error) })
      }
    })
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
    const address = server.address()
    relayURL = 'http://127.0.0.1:' + address.port
    return { relayURL, close }
  } catch (error) {
    await close()
    throw error
  }
}
