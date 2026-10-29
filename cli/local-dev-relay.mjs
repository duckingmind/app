import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'

const PLATFORM_AUTH_TIMEOUT_MS = 30 * 1000

async function readBody(request, limit = 16 * 1024) {
  const chunks = []
  let length = 0
  for await (const chunk of request) {
    length += chunk.length
    if (length > limit) throw Object.assign(new Error('request body is too large'), { statusCode: 413 })
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

async function readResponse(response) {
  const text = await response.text()
  if (!text.trim()) return { text, payload: null, invalidJSON: true }
  try {
    const payload = JSON.parse(text)
    return {
      text,
      payload,
      invalidJSON: !payload || typeof payload !== 'object' || Array.isArray(payload),
    }
  } catch {
    return { text, payload: null, invalidJSON: true }
  }
}

function unwrap(value) {
  return value && Object.prototype.hasOwnProperty.call(value, 'data') ? value.data : value
}

function relayError(code, message, stage, statusCode = 502, cause) {
  const error = new Error(message)
  error.code = code
  error.stage = stage
  error.statusCode = statusCode
  if (cause) error.cause = cause
  return error
}

function errorCode(payload) {
  const error = payload?.error
  return String((error && typeof error === 'object' ? error.code : '') || payload?.code || '').trim()
}

function errorMessage(payload, fallback) {
  const error = typeof payload?.error === 'string' ? payload.error : payload?.error?.message
  return error || payload?.message || fallback
}

function visibleErrorMessage(error) {
  switch (error?.code) {
    case 'APP_PLATFORM_UNAVAILABLE': return '无法连接平台，请确认平台服务已启动或网络可用后重试。'
    case 'APP_PLATFORM_TIMEOUT': return '平台响应超时，请稍后重试。'
    case 'APP_PLATFORM_INVALID_RESPONSE': return `平台返回了非 JSON 或格式无效的响应（HTTP ${error?.statusCode || 502}），请检查平台 API 地址、路由及服务配置。`
    case 'APP_LOGIN_SESSION_EXPIRED': return '开发者授权已过期，请重新运行 proxy-app dev。'
    case 'APP_APP_REGISTRATION_FAILED':
      if ([401, 403, 404].includes(error?.statusCode)) {
        const account = error?.currentAccount ? ` 当前登录账户：${error.currentAccount}。` : ''
        const platform = error?.platformAPI ? ` 平台 API 地址：${error.platformAPI}。` : ''
        const reason = error.statusCode === 403 ? '当前账户无权开发此应用' : error.statusCode === 404 ? '该平台上没有当前账户拥有的同 slug 应用' : '开发者授权已失效'
        return `${reason}。${account}${platform}请使用应用创建者账户登录，并确认 manifest.json 的 id 与平台应用 slug 完全一致。`
      }
      if (error?.statusCode === 400) return '应用开发登记参数不符合平台要求，请检查 manifest.json 的 id、version、权限和能力声明。'
      return `应用开发登记失败（HTTP ${error?.statusCode || 502}），请根据请求编号检查平台日志。`
    default: return String(error?.message || '平台开发授权失败，请重试。').slice(0, 240)
  }
}

function htmlEscape(value) {
  return String(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character])
}

function safeURL(value, label) {
  let parsed
  try { parsed = new URL(value) } catch { throw new Error(label + ' must be a valid http(s) URL') }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error(label + ' must be an http(s) URL without credentials, query, or hash')
  }
  return parsed.origin + parsed.pathname.replace(/\/$/, '')
}

function htmlResponse(response, status, title, description, link = '') {
  response.statusCode = status
  response.setHeader('Content-Type', 'text/html; charset=utf-8')
  response.setHeader('Cache-Control', 'no-store')
  response.setHeader('Referrer-Policy', 'no-referrer')
  response.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'")
  const anchor = link ? `<a href="${htmlEscape(link)}" rel="noreferrer">打开本地应用</a>` : ''
  response.end(`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${htmlEscape(title)}</title><style>html{color-scheme:dark}body{margin:0;min-height:100vh;display:grid;place-items:center;background:#111;color:#eee;font:15px/1.8 system-ui,sans-serif}main{box-sizing:border-box;width:min(440px,calc(100% - 40px));padding:32px;border:1px solid #383838;border-radius:18px;background:#222}small,p{color:#aaa}h1{font-size:24px;line-height:1.4}p{overflow-wrap:anywhere}a{display:block;margin-top:24px;padding:10px;text-align:center;background:#f1f1f1;color:#202020;border-radius:9px;text-decoration:none}</style><main><small>Proxy App · 开发环境初始化</small><h1>${htmlEscape(title)}</h1><p>${htmlEscape(description)}</p>${anchor}</main></html>`)
}

/**
 * Handles developer authorization and draft registration only. Runtime user
 * sessions are created by the Portal in the browser and never enter this
 * process or its credential store.
 */
export async function createLocalDevelopmentRelay({ baseURL, portalURL = '', appID, appSlug, version, manifest, functionFiles = [], entryURL, developerCredentialStore = null }) {
  if (!baseURL || !appID || !appSlug || !version || !entryURL) throw new Error('local development relay configuration is incomplete')
  const platformAPI = safeURL(baseURL, 'platform API URL')
  const portalOrigin = safeURL(portalURL || platformAPI, 'platform Portal URL')
  const state = { closed: false }
  let server
  let relayURL = ''
  let developmentReady = false
  let developmentPromise = null
  let developmentSessionGrant = ''
  let setupState = ''
  let setupIssuedAt = 0
  let submitSetupToken = null
  let cancelSetup = null

  const portalJSON = async (path, init, stage, token) => {
    if (!token) throw relayError('APP_LOGIN_REQUIRED', 'developer login is required', stage, 401)
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), PLATFORM_AUTH_TIMEOUT_MS)
    let response
    let result
    try {
      response = await fetch(platformAPI + path, {
        ...init,
        signal: init?.signal ? AbortSignal.any([controller.signal, init.signal]) : controller.signal,
        headers: { Authorization: 'Bearer ' + token, ...(init?.headers || {}) },
      })
      result = await readResponse(response)
    } catch (error) {
      if (init?.signal?.aborted) throw init.signal.reason
      if (controller.signal.aborted || error?.name === 'AbortError') throw relayError('APP_PLATFORM_TIMEOUT', 'platform request timed out', stage, 504, error)
      throw relayError('APP_PLATFORM_UNAVAILABLE', 'platform request could not be reached', stage, 502, error)
    } finally {
      clearTimeout(timeout)
    }
    const payload = result.payload
    const requestId = response.headers.get('x-request-id') || response.headers.get('x-trace-id') || ''
    if (result.invalidJSON) {
      const failure = relayError('APP_PLATFORM_INVALID_RESPONSE', `platform returned a non-JSON response (HTTP ${response.status})`, stage, response.status)
      failure.requestId = requestId
      throw failure
    }
    if (!response.ok) {
      const code = errorCode(payload)
      const failure = relayError(response.status === 401 ? 'APP_LOGIN_SESSION_EXPIRED' : stage === 'app_registration' ? 'APP_APP_REGISTRATION_FAILED' : code || 'APP_PLATFORM_REQUEST_FAILED', errorMessage(payload, 'platform request failed: HTTP ' + response.status), stage, response.status)
      failure.requestId = requestId
      failure.upstreamCode = code
      throw failure
    }
    return unwrap(payload)
  }

  const register = async (token, signal) => {
    const details = await portalJSON('/portal/user/app-workspace/by-slug/' + encodeURIComponent(appSlug) + '/local-development', {
      method: 'POST', signal,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ entry_url: entryURL, manifest, ...(functionFiles.length ? { function_files: functionFiles } : {}) }),
    }, 'app_registration', token)
    if (!details || typeof details.id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(details.id)) {
      throw relayError('APP_PLATFORM_INVALID_RESPONSE', 'platform did not return the registered application identity', 'app_registration', 502)
    }
    if (typeof details.local_development_grant !== 'string' || details.local_development_grant.length < 32 || details.local_development_grant.length > 8192) {
      throw relayError('APP_PLATFORM_INVALID_RESPONSE', 'platform did not return a local preview grant', 'app_registration', 502)
    }
    appID = details.id
    developmentSessionGrant = details.local_development_grant
    return details
  }

  const registerWithDiagnostics = async (token, signal) => {
    try {
      return await register(token, signal)
    } catch (error) {
      if (error?.stage === 'app_registration' && [403, 404].includes(error.statusCode)) {
        error.platformAPI = platformAPI
        const profile = await portalJSON('/portal/user/profile', {}, 'account_scope', token).catch(() => null)
        const email = typeof profile?.email === 'string' ? profile.email.trim() : ''
        if (email && email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) error.currentAccount = email
      }
      throw error
    }
  }

  const developmentHTML = error => {
    const title = error ? '开发环境检查失败' : '开发环境已就绪'
    const description = error ? visibleErrorMessage(error) : '应用登记与开发权限检查已通过，本地应用正在启动。'
    return { title, description }
  }

  const prepareDevelopment = ({ token = '', onAuthorizationRequired, signal, forceLogin = false, timeoutMs = 10 * 60 * 1000 } = {}) => {
    if (state.closed || signal?.aborted) return Promise.reject(Object.assign(new Error('开发环境初始化已取消。'), { name: 'AbortError' }))
    if (developmentReady) return Promise.resolve()
    if (developmentPromise) return developmentPromise
    const pending = (async () => {
      let timer
      let rejectCancellation
      const controller = new AbortController()
      const cancellation = new Promise((_, reject) => { rejectCancellation = reject })
      cancellation.catch(() => undefined)
      const cancel = error => { controller.abort(error); rejectCancellation(error) }
      const abort = () => cancel(Object.assign(new Error('开发环境初始化已取消。'), { name: 'AbortError' }))
      cancelSetup = abort
      signal?.addEventListener('abort', abort, { once: true })
      const checkActive = () => { if (state.closed || signal?.aborted) abort() }
      const wait = operation => Promise.race([operation, cancellation])
      try {
        const explicitToken = !forceLogin && typeof token === 'string' ? token.trim() : ''
        let requiresFreshLogin = forceLogin
        let developerToken = explicitToken
        if (!developerToken && !forceLogin) developerToken = await wait(Promise.resolve(developerCredentialStore?.load()))
        // A Portal can already have a valid browser login for a different
        // account than the developer. When the CLI has no explicit or cached
        // credential, require the user to choose the developer account rather
        // than silently accepting the Portal's persisted browser session.
        if (!developerToken && !explicitToken) requiresFreshLogin = true
        checkActive()
        if (developerToken) {
          try {
            await wait(registerWithDiagnostics(developerToken, controller.signal))
            checkActive()
            developmentReady = true
            return
          } catch (error) {
            const retry = error?.code === 'APP_LOGIN_SESSION_EXPIRED' || error?.stage === 'app_registration' && [401, 403, 404].includes(error.statusCode)
            if (!retry || explicitToken) throw error
            await wait(Promise.resolve(developerCredentialStore?.clear()))
            requiresFreshLogin = true
          }
        }
        checkActive()
        if (!onAuthorizationRequired) throw relayError('APP_DEVELOPER_LOGIN_REQUIRED', '请先通过 proxy-app dev 完成开发者授权。', 'development_preflight', 401)
        timer = setTimeout(() => cancel(relayError('APP_DEVELOPER_LOGIN_TIMEOUT', '开发者授权等待超时，请重新运行 proxy-app dev。', 'development_preflight', 408)), Math.max(1, Math.min(timeoutMs, 10 * 60 * 1000)))
        setupState = randomUUID()
        setupIssuedAt = Date.now()
        const receivedToken = new Promise(resolve => { submitSetupToken = resolve })
        const query = new URLSearchParams({ proxy_app_auth: '1', proxy_app_state: setupState, proxy_app_relay: relayURL })
        if (requiresFreshLogin) query.set('proxy_app_force_login', '1')
        await wait(Promise.resolve(onAuthorizationRequired({ login_url: portalOrigin + '/#/login?' + query, auth_state: setupState, relay_url: relayURL, force_login: requiresFreshLogin })))
        developerToken = await wait(receivedToken)
        checkActive()
        if (!developerToken) throw relayError('APP_LOGIN_TOKEN_INVALID', '平台未返回有效的开发者授权，请重新运行 proxy-app dev。', 'development_preflight', 400)
        await wait(registerWithDiagnostics(developerToken, controller.signal))
        checkActive()
        await wait(Promise.resolve(developerCredentialStore?.save(developerToken)).catch(() => undefined))
        checkActive()
        developmentReady = true
      } catch (error) {
        if (error?.name === 'AbortError') throw error
        throw Object.assign(new Error(visibleErrorMessage(error)), {
          code: error?.code, stage: error?.stage, statusCode: error?.statusCode,
          requestId: error?.requestId, upstreamCode: error?.upstreamCode,
          currentAccount: error?.currentAccount, platformAPI: error?.platformAPI,
        })
      } finally {
        clearTimeout(timer)
        signal?.removeEventListener('abort', abort)
        setupState = ''
        setupIssuedAt = 0
        submitSetupToken = null
        cancelSetup = null
      }
    })()
    developmentPromise = pending
    pending.catch(() => { if (developmentPromise === pending) developmentPromise = null })
    return pending
  }

  const close = async () => {
    if (state.closed) return
    state.closed = true
    cancelSetup?.()
    await developmentPromise?.catch(() => undefined)
    if (server?.listening) await new Promise(resolve => server.close(resolve))
  }

  try {
    server = createServer(async (request, response) => {
      try {
        if (state.closed) throw Object.assign(new Error('local developer relay is closed'), { statusCode: 503 })
        const parsed = new URL(request.url || '/', 'http://127.0.0.1')
        if (request.method === 'GET' && parsed.pathname === '/health') {
          response.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
          response.end(JSON.stringify({ ok: true, development_ready: developmentReady, app_id: appID, app_slug: appSlug, app_version: version }))
          return
        }
        if (request.method !== 'POST' || parsed.pathname !== '/auth/callback' || request.socket.remoteAddress && !request.socket.remoteAddress.includes('127.0.0.1') && request.socket.remoteAddress !== '::1' && request.socket.remoteAddress !== '::ffff:127.0.0.1') {
          response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' })
          response.end('not found')
          return
        }
        const contentType = String(request.headers['content-type'] || '').split(';')[0].trim().toLowerCase()
        if (contentType !== 'application/x-www-form-urlencoded') {
          htmlResponse(response, 415, '授权失败', '开发者授权请求格式无效。')
          return
        }
        const form = new URLSearchParams((await readBody(request)).toString('utf8'))
        const receivedState = form.get('state') || ''
        const token = form.get('access_token') || ''
        const valid = setupState && receivedState === setupState && Date.now() - setupIssuedAt <= 10 * 60 * 1000 && submitSetupToken
        if (!valid || !token || token.length > 8192 || form.getAll('state').length !== 1 || form.getAll('access_token').length !== 1) {
          htmlResponse(response, 400, '授权失败', '开发者授权已失效，请重新运行 proxy-app dev。')
          return
        }
        setupState = ''
        setupIssuedAt = 0
        const submit = submitSetupToken
        submitSetupToken = null
        submit(token.trim())
        try {
          await developmentPromise
          const result = developmentHTML()
          htmlResponse(response, 200, result.title, result.description, entryURL)
        } catch (error) {
          const result = developmentHTML(error)
          htmlResponse(response, error?.statusCode || 503, result.title, result.description)
        }
      } catch (error) {
        const result = developmentHTML(error)
        htmlResponse(response, error?.statusCode || 502, result.title, result.description)
      }
    })
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
    relayURL = 'http://127.0.0.1:' + server.address().port
    return { relayURL, prepareDevelopment, getDevelopmentSessionGrant: () => developmentSessionGrant, close }
  } catch (error) {
    await close()
    throw error
  }
}
