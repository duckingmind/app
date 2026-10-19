import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import { Readable } from 'node:stream'

const HOP_BY_HOP_HEADERS = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade'])
const SENSITIVE_HEADERS = new Set(['host', 'authorization', 'cookie', 'origin', 'referer', 'content-length', 'x-proxy-app-relay'])
const PLATFORM_AUTH_TIMEOUT_MS = 30 * 1000
const validAccountScope = (value) => typeof value === 'string' && /^acs_[a-f0-9]{64}$/.test(value)
const accountScopeUnavailable = () => relayError('APP_ACCOUNT_SCOPE_UNAVAILABLE', '暂时无法确认账户信息，请重新登录后再试；如果仍无法进入，请联系平台管理员。', 'account_scope', 502)

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

async function readJSON(response, strictBody = false) {
  const text = strictBody ? await response.text() : await response.text().catch(() => '')
  if (!text.trim()) {
    if (strictBody) throw new SyntaxError('empty platform response')
    return {}
  }
  try { return JSON.parse(text) } catch (error) {
    if (strictBody) throw error
    return { message: text }
  }
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

async function retryableSessionExpiry(response) {
  if (response?.status !== 401) return false
  const payload = await readJSON(response.clone())
  const error = payload?.error
  const reason = typeof error === 'object' && error ? error.auth_reason : undefined
  const executionStarted = typeof error === 'object' && error && Object.prototype.hasOwnProperty.call(error, 'execution_started')
    ? error.execution_started
    : payload?.execution_started
  return reason === 'APP_SESSION_EXPIRED' && executionStarted === false
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
    case 'APP_PLATFORM_INVALID_RESPONSE': return '平台返回了无效响应，请检查平台 API 地址及服务配置。'
    case 'APP_LOGIN_SESSION_EXPIRED': return '平台登录态已失效，请重新登录。'
    case 'APP_LOGIN_NOT_ALLOWED': return '当前账户无权使用此应用，请切换账户后重试。'
    case 'APP_APP_REGISTRATION_FAILED':
      if (error?.upstreamCode === 'APP_LOCAL_MANIFEST_CONFLICT' || error?.message === 'local development version already exists with a different manifest; bump manifest.version') return '本地 manifest 与已上传或发布的同版本内容不同。请更新 manifest.version 后重启 proxy-app dev。'
      if ([403, 404].includes(error?.statusCode)) {
        const account = error?.currentAccount ? ` 当前登录账户：${error.currentAccount}。` : ''
        const platform = error?.platformAPI ? ` 平台 API 地址：${error.platformAPI}。` : ''
        const reason = error.statusCode === 403 ? '当前账户无权开发此应用' : '该平台上没有当前账户拥有的同 slug 应用'
        return `${reason}。${account}${platform}请使用应用创建时的完整账户登录，并确认 manifest.json 的 id 与平台应用 slug 完全一致。`
      }
      if (error?.statusCode === 400) {
        const code = error?.upstreamCode ? `（${error.upstreamCode}）` : ''
        return '应用开发登记参数不符合平台要求（HTTP 400）' + code + '。请检查 manifest.json 的 id、version、entry、权限和能力声明。'
      }
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
  const url = new URL(normalized)
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '')
  const loopback = hostname === 'localhost' || hostname === '::1' || /^127(?:\.\d{1,3}){3}$/.test(hostname)
  const pathStart = value.indexOf('/', value.indexOf('://') + 3)
  const rawPath = pathStart < 0 ? '/' : value.slice(pathStart)
  if (value !== value.trim() || value.includes('\\') || rawPath !== new URL(value).pathname ||
    (url.pathname !== '/' && url.pathname !== '/v1') ||
    /(?:^|[.-])(?:admin|admin-api|admin-go|codex-admin-api|portal|www)(?:[.-]|$)/.test(hostname) ||
    (url.protocol === 'http:' && !loopback)) {
    throw relayError('APP_GATEWAY_URL_INVALID', 'App Session must use the Gateway /v1 URL', 'app_session')
  }
  return url.origin + '/v1'
}

function jsonResponse(response, status, payload) {
  response.statusCode = status
  response.setHeader('Content-Type', 'application/json')
  response.setHeader('Cache-Control', 'no-store')
  response.end(JSON.stringify(payload))
}

/**
 * Development preparation and runtime user login are separate operations.
 * prepareDevelopment registers the manifest before the CLI starts the app.
 * Only runtime login creates App Sessions; developer credentials never fund
 * runtime requests or reach the app. Both credentials may use separate OS stores.
 */
export async function createLocalDevelopmentRelay({ baseURL, portalURL = '', relaySecret, appID, appSlug, version, manifest, entryURL, credentialStore = null, developerCredentialStore = null }) {
  if (!baseURL || !relaySecret || !appID || !appSlug || !version || !entryURL) throw new Error('local development relay configuration is incomplete')
  const portal = safeURL(baseURL, 'platform API URL')
  const portalOrigin = safeURL(portalURL || portal, 'platform Portal URL')
  const state = { portalToken: '', session: null, refresh: null, login: null, restore: null, cacheLoaded: false, forceLogin: false, authGeneration: 0, authState: '', authStateIssuedAt: 0, closed: false, revoked: new Set() }
  let credentialQueue = Promise.resolve()
  const updateCredentials = (operation) => {
    // Serialize writes so an in-flight save cannot resurrect a logged-out account.
    credentialQueue = credentialQueue.then(operation).catch(() => undefined)
    return credentialQueue
  }
  let server
  let relayURL = ''
  let developmentReady = false
  let developmentPromise = null
  let setupState = ''
  let setupIssuedAt = 0
  let submitSetupToken = null
  let cancelSetup = null

  const portalJSON = async (path, init = {}, stage = 'platform', authToken) => {
    const token = authToken === undefined ? state.portalToken : authToken
    if (!token) {
      throw relayError('APP_LOGIN_REQUIRED', 'platform user login is required', stage, 401)
    }
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), PLATFORM_AUTH_TIMEOUT_MS)
    let response
    let payload
    try {
      response = await fetch(portal + path, {
        ...init,
        signal: init.signal ? AbortSignal.any([controller.signal, init.signal]) : controller.signal,
        headers: { Authorization: 'Bearer ' + token, ...(init.headers || {}) },
      })
      payload = await readJSON(response, true)
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new SyntaxError('platform response is not an object')
    } catch (error) {
      if (init.signal?.aborted) throw init.signal.reason
      if (controller.signal.aborted || error?.name === 'AbortError') throw relayError('APP_PLATFORM_TIMEOUT', 'platform request timed out', stage, 504, error)
      if (error instanceof SyntaxError) throw relayError('APP_PLATFORM_INVALID_RESPONSE', 'platform response is invalid', stage, 502, error)
      throw relayError('APP_PLATFORM_UNAVAILABLE', 'platform request could not be reached', stage, 502, error)
    } finally {
      clearTimeout(timeout)
    }
    if (!response.ok) {
      if (stage === 'account_scope') {
        const failure = relayError(errorCode(payload) || 'APP_PLATFORM_REQUEST_FAILED', errorMessage(payload, 'platform request failed: HTTP ' + response.status), stage, response.status)
        failure.requestId = response.headers.get('x-request-id') || ''
        throw failure
      }
      if (response.status === 401) throw relayError('APP_LOGIN_SESSION_EXPIRED', 'platform user session expired', stage, 401)
      if (response.status === 403 && stage !== 'app_registration') throw relayError('APP_LOGIN_NOT_ALLOWED', 'platform user is not allowed to use this app', stage, 403)
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

  const clearAuthentication = async (forceLogin = false) => {
    const current = state.session
    const token = state.portalToken
    state.authGeneration += 1
    state.session = null
    state.portalToken = ''
    state.refresh = null
    state.login = null
    state.restore = null
    state.cacheLoaded = true
    state.forceLogin = forceLogin
    state.authState = ''
    state.authStateIssuedAt = 0
    await Promise.all([revoke(current, token), updateCredentials(() => credentialStore?.clear())])
  }

  const assertAuthentication = (generation) => {
    if (state.closed) throw new Error('local development relay is closed')
    if (generation !== state.authGeneration) throw relayError('APP_AUTH_CHANGED', 'local development authentication changed', 'app_session', 409)
  }

  const register = async (token, signal) => {
    const details = await portalJSON('/portal/user/app-workspace/by-slug/' + encodeURIComponent(appSlug) + '/local-development', {
      method: 'POST',
      signal,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ entry_url: entryURL, manifest }),
    }, 'app_registration', token)
    if (!details || typeof details.id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(details.id)) {
      throw relayError('APP_PLATFORM_INVALID_RESPONSE', 'platform did not return the registered application identity', 'app_registration', 502)
    }
    // The public slug locates the owner-authorized app. All subsequent
    // session/revocation calls use the server-resolved durable identity, not
    // the slug or an obsolete local sidecar. No repair step is required.
    appID = details.id
    return details
  }

  const registerWithDiagnostics = async (token, signal) => {
    try {
      return await register(token, signal)
    } catch (error) {
      if (error?.stage === 'app_registration' && [403, 404].includes(error.statusCode)) {
        error.platformAPI = portal
        // The profile endpoint confirms which account the accepted token
        // represents. Show only that account's own email to make duplicate
        // usernames and near-identical addresses distinguishable.
        const profile = await portalJSON('/portal/user/profile', {}, 'account_scope', token).catch(() => null)
        const email = typeof profile?.email === 'string' ? profile.email.trim() : ''
        if (email && email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) error.currentAccount = email
      }
      throw error
    }
  }

  const developmentRequired = () => relayError('APP_DEVELOPMENT_NOT_READY', '开发环境尚未就绪，请先在终端完成 proxy-app dev 的开发授权与应用登记。', 'development_preflight', 503)
  const abortPreparation = () => Object.assign(new Error('开发环境初始化已取消。'), { name: 'AbortError' })

  const prepareDevelopment = ({ token = '', onAuthorizationRequired, signal, forceLogin = false, timeoutMs = 10 * 60 * 1000 } = {}) => {
    if (state.closed || signal?.aborted) return Promise.reject(abortPreparation())
    if (developmentReady) return Promise.resolve()
    if (developmentPromise) return developmentPromise
    const pending = (async () => {
      let timer
      let rejectCancellation
      const controller = new AbortController()
      const cancellation = new Promise((_, reject) => { rejectCancellation = reject })
      // Install the handler immediately, including while reading the OS store.
      cancellation.catch(() => undefined)
      const cancel = (error) => { controller.abort(error); rejectCancellation(error) }
      const abort = () => cancel(abortPreparation())
      cancelSetup = abort
      signal?.addEventListener('abort', abort, { once: true })
      const checkActive = () => {
        if (state.closed || signal?.aborted) throw abortPreparation()
      }
      const wait = (operation) => Promise.race([operation, cancellation])
      try {
        const explicitToken = !forceLogin && typeof token === 'string' ? token.trim() : ''
        let requiresFreshLogin = forceLogin
        let developerToken = explicitToken
        if (!developerToken && !forceLogin) developerToken = await wait(Promise.resolve(developerCredentialStore?.load()))
        // A missing developer cache does not mean that the Portal session is
        // invalid. Let the Portal reuse its current signed-in account; the
        // registration endpoint still enforces that it is the app creator.
        // Force account selection only when replacing a rejected credential.
        if (!developerToken && !explicitToken) requiresFreshLogin = false
        checkActive()
        if (developerToken) {
          try {
            await wait(registerWithDiagnostics(developerToken, controller.signal))
            checkActive()
            developmentReady = true
            return
          } catch (error) {
            // A cached developer account can be valid for the platform while
            // still belonging to a different app owner.  Registration reports
            // that case as 403/404, the same way it reports an expired
            // developer session as 401.  Drop only the cached credential and
            // offer one fresh developer login; explicit management tokens are
            // caller supplied and must remain an actionable hard failure.
            const registrationNeedsFreshLogin = error?.code === 'APP_LOGIN_SESSION_EXPIRED'
              || (error?.stage === 'app_registration' && [401, 403, 404].includes(error.statusCode))
            if (!registrationNeedsFreshLogin || explicitToken) throw error
            await wait(Promise.resolve(developerCredentialStore?.clear()))
            requiresFreshLogin = true
          }
        }
        checkActive()
        if (!onAuthorizationRequired) throw relayError('APP_DEVELOPER_LOGIN_REQUIRED', '请先通过 proxy-app dev 完成开发者授权。', 'development_preflight', 401)
        timer = setTimeout(() => cancel(relayError('APP_DEVELOPER_LOGIN_TIMEOUT', '开发者授权等待超时，请重新运行 proxy-app dev。', 'development_preflight', 408)), Math.max(1, Math.min(timeoutMs, 10 * 60 * 1000)))
        checkActive()
        setupState = randomUUID()
        setupIssuedAt = Date.now()
        const receivedToken = new Promise((resolve) => { submitSetupToken = resolve })
        const query = new URLSearchParams({ proxy_app_auth: '1', proxy_app_state: setupState, proxy_app_relay: relayURL })
        if (requiresFreshLogin) query.set('proxy_app_force_login', '1')
        const details = { login_url: portalOrigin + '/#/login?' + query, auth_state: setupState, relay_url: relayURL, force_login: query.has('proxy_app_force_login') }
        await wait(Promise.resolve(onAuthorizationRequired(details)))
        developerToken = await wait(receivedToken)
        checkActive()
        if (!developerToken) throw relayError('APP_LOGIN_TOKEN_INVALID', '平台未返回有效的开发者授权，请重新运行 proxy-app dev。', 'development_preflight', 400)
        await wait(registerWithDiagnostics(developerToken, controller.signal))
        checkActive()
        // Runtime user login never reads or clears this store.
        await wait(Promise.resolve(developerCredentialStore?.save(developerToken)).catch(() => undefined))
        checkActive()
        developmentReady = true
      } catch (error) {
        // Preserve structured diagnostic fields, but never print arbitrary
        // upstream text or credentials in the terminal/authorization page.
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

  const refresh = async (force = false, generation = state.authGeneration) => {
    assertAuthentication(generation)
    if (state.refresh) return state.refresh
    const refreshToken = state.portalToken
    const previous = force ? state.session : null
    const pending = portalJSON('/portal/user/apps/' + encodeURIComponent(appID) + '/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // App Sessions are always issued for the Gateway data plane. The old
      // runtime_protocol=2 and Bridge transport are not valid app transports.
      body: JSON.stringify({ version, runtime_protocol: 1 }),
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

  const restoreAuthentication = async () => {
    if (!developmentReady) throw developmentRequired()
    if (state.login) return state.login
    if (state.session) return state.session
    if (state.restore) return state.restore
    const generation = state.authGeneration
    const pending = (async () => {
      if (!state.cacheLoaded) {
        const token = await credentialStore?.load()
        assertAuthentication(generation)
        state.cacheLoaded = true
        state.portalToken = typeof token === 'string' ? token : ''
      }
      if (!state.portalToken) return null
      // Preparation already registered this process's manifest and entry URL.
      // Restoring a runtime user must never mutate the developer's app version.
      return await refresh(false, generation)
    })().catch(async (error) => {
      if (state.authGeneration !== generation || state.closed) throw error
      if (['APP_LOGIN_SESSION_EXPIRED', 'APP_LOGIN_NOT_ALLOWED'].includes(error?.code)) {
        await clearAuthentication(true)
        return null
      }
      // Network or session failures are retryable; retain the saved
      // authorization instead of converting every failure into a login prompt.
      throw error
    }).finally(() => {
      if (state.restore === pending) state.restore = null
    })
    state.restore = pending
    return pending
  }

  const loginDetails = () => {
    if (!state.authState || Date.now() - state.authStateIssuedAt > 10 * 60 * 1000) {
      state.authState = randomUUID()
      state.authStateIssuedAt = Date.now()
    }
    const query = new URLSearchParams({ proxy_app_auth: '1', proxy_app_state: state.authState, proxy_app_relay: relayURL })
    return { login_url: portalOrigin + '/#/login?' + query, auth_state: state.authState, relay_url: relayURL, force_login: state.forceLogin }
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
    // Leave a failed callback open so the SDK can reuse the user-opened popup
    // for one fresh login. Closing it here would trigger popup blockers.
    return '<!doctype html><meta charset="utf-8"><title>平台登录</title><meta name="viewport" content="width=device-width,initial-scale=1"><p>' + htmlEscape(title) + '</p><script>const m=' + safeScriptJSON(message) + ';if(window.opener){window.opener.postMessage(m,' + safeScriptJSON(origin) + ');' + (isSuccess ? 'setTimeout(()=>window.close(),120)' : '') + '}</script>'
  }

  const developmentHTML = (error) => {
    const title = error ? '开发环境检查失败' : '开发环境已就绪'
    const description = error ? visibleErrorMessage(error) : '应用登记与开发权限检查已通过，终端正在启动本地应用。进入应用后可登录需要测试的用户账户。'
    const diagnostic = error
      ? '<p>开发者登录页面：' + htmlEscape(portalOrigin) + '</p><p>平台 API 地址：' + htmlEscape(portal) + '</p><p>应用 slug：' + htmlEscape(appSlug) + '</p>' + (error.requestId ? '<p>请求编号：' + htmlEscape(error.requestId) + '</p>' : '') + '<p>请核对页面显示的完整账户；平台应用要求由创建者账户开发。</p>'
      : '<a href="' + htmlEscape(entryURL) + '" rel="noreferrer">打开本地应用</a>'
    return '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>' + title + '</title><style>html{color-scheme:dark}body{margin:0;min-height:100vh;display:grid;place-items:center;background:#111;color:#eee;font:15px/1.8 system-ui,sans-serif}main{box-sizing:border-box;width:min(440px,calc(100% - 40px));padding:32px;border:1px solid #383838;border-radius:18px;background:#222}small,p{color:#aaa}h1{font-size:24px;line-height:1.4}p{overflow-wrap:anywhere}a{display:block;margin-top:24px;padding:10px;text-align:center;background:#f1f1f1;color:#202020;border-radius:9px;text-decoration:none}a:focus-visible{outline:2px solid #fff;outline-offset:4px}</style><main><small>Proxy App · 开发环境初始化</small><h1>' + title + '</h1><p>' + htmlEscape(description) + '</p>' + diagnostic + '</main></html>'
  }

  const forward = async (target, request, rawBody, token, appVersion, stage) => {
    const headers = copyRequestHeaders(request)
    if (token) headers.set('Authorization', 'Bearer ' + token)
    if (appVersion) headers.set('X-App-Version', appVersion)
    const readOnly = ['GET', 'HEAD'].includes(request.method || '')
    try {
      return await fetch(target, {
        method: request.method,
        headers,
        body: readOnly ? undefined : rawBody,
        redirect: 'manual',
      })
    } catch (cause) {
      const gateway = stage === 'gateway'
      const message = gateway
        ? '无法连接模型网关，请确认网关服务已启动，并检查平台下发的网关地址及网络连接。'
        : '无法连接平台服务，请确认平台服务已启动，并检查平台 API 地址及网络连接。'
      const failure = relayError(gateway ? 'APP_GATEWAY_UNAVAILABLE' : 'APP_PLATFORM_UNAVAILABLE',
        message + (readOnly ? '恢复连接后可重试查询。' : '本次请求结果尚未确认，请先检查任务或操作状态，避免重复提交。'), stage, 502, cause)
      // A transport failure may occur after an upstream mutation was accepted.
      // Never retry here or claim that execution definitely did not start.
      if (!readOnly) failure.executionUnknown = true
      throw failure
    }
  }

  const close = async () => {
    if (state.closed) return
    state.closed = true
    cancelSetup?.()
    await developmentPromise?.catch(() => undefined)
    await state.restore?.catch(() => undefined)
    await state.refresh?.catch(() => undefined)
    await state.login?.catch(() => undefined)
    await credentialQueue
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
        // `/auth` is the relay's local control plane. It is exposed to app
        // pages as `/__platform/auth` by the Vite proxy, while the relay
        // itself never accepts an Admin App Runtime path.
        const authPrefix = '/__platform/auth'
        const authPath = parsed.pathname.startsWith(authPrefix + '/') ? parsed.pathname.slice(authPrefix.length) : parsed.pathname
        const callback = authPath === '/auth/callback' && request.method === 'POST'
        if (!callback && request.headers['x-proxy-app-relay'] !== relaySecret) {
          jsonResponse(response, 403, { code: 'LOCAL_DEV_RELAY_UNAUTHORIZED', error: 'local development relay authentication failed' })
          return
        }
        const rawBody = await readBody(request)
        if (callback) {
          const form = new URLSearchParams(rawBody.toString('utf8'))
          const receivedState = form.get('state') || ''
          if (setupState && receivedState === setupState && Date.now() - setupIssuedAt <= 10 * 60 * 1000 && submitSetupToken) {
            // This callback completes CLI preparation, not an app user login.
            // Consume its state before awaiting I/O to prevent replay.
            setupState = ''
            const submit = submitSetupToken
            submitSetupToken = null
            response.setHeader('Content-Type', 'text/html; charset=utf-8')
            response.setHeader('Cache-Control', 'no-store')
            response.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'")
            submit(String(form.get('access_token') || '').trim())
            try {
              await developmentPromise
              response.end(developmentHTML())
            } catch (error) {
              response.statusCode = error?.statusCode || 503
              response.end(developmentHTML(error))
            }
            return
          }
          const valid = receivedState && receivedState === state.authState && Date.now() - state.authStateIssuedAt <= 10 * 60 * 1000
          response.setHeader('Content-Type', 'text/html; charset=utf-8')
          response.setHeader('Cache-Control', 'no-store')
          if (!valid) {
            response.statusCode = 400
            response.end(callbackHTML(receivedState, 'login-failed', relayError('APP_LOGIN_STATE_INVALID', 'login request expired', 'state_validation', 400)))
            return
          }
          if (!developmentReady) throw developmentRequired()
          state.authState = ''
          state.authStateIssuedAt = 0
          const previous = state.session
          const previousToken = state.portalToken
          const generation = ++state.authGeneration
          const token = String(form.get('access_token') || '').trim()
          state.session = null
          state.portalToken = token
          state.refresh = null
          state.restore = null
          state.cacheLoaded = true
          const pending = (async () => {
            await Promise.all([revoke(previous, previousToken), updateCredentials(() => credentialStore?.clear())])
            assertAuthentication(generation)
            if (!token) throw relayError('APP_LOGIN_TOKEN_INVALID', 'platform returned an invalid user session token', 'token_validation', 400)
            const session = await refresh(true, generation)
            assertAuthentication(generation)
            await updateCredentials(() => {
              if (!state.closed && state.authGeneration === generation) return credentialStore?.save(token)
            })
            assertAuthentication(generation)
            state.forceLogin = false
            return session
          })()
          state.login = pending
          try {
            await pending
            assertAuthentication(generation)
            response.end(callbackHTML(receivedState, 'login-complete'))
          } catch (error) {
            if (!state.closed && state.authGeneration === generation) await clearAuthentication(['APP_LOGIN_SESSION_EXPIRED', 'APP_LOGIN_NOT_ALLOWED'].includes(error?.code))
            response.statusCode = error?.statusCode || 502
            response.end(callbackHTML(receivedState, 'login-failed', error))
          } finally {
            if (state.login === pending) state.login = null
          }
          return
        }
        if (parsed.pathname === '/health') { jsonResponse(response, 200, { ok: true, development_ready: developmentReady, app_id: appID, app_slug: appSlug, app_version: version, runtime_protocol: 1, authenticated: Boolean(state.session) }); return }
        if (!developmentReady) throw developmentRequired()
        if (authPath === '/start' || authPath === '/auth/start') {
          if (parsed.searchParams.get('force_login') === '1') await clearAuthentication(true)
          else await restoreAuthentication()
          jsonResponse(response, 200, { data: { authenticated: Boolean(state.session), ...loginDetails() } })
          return
        }
        if ((authPath === '/logout' || authPath === '/auth/logout') && request.method === 'POST') {
          await clearAuthentication()
          jsonResponse(response, 200, { data: { success: true } })
          return
        }
        if (authPath === '/status' || authPath === '/auth/status') {
          const current = await restoreAuthentication()
          if (current && !validAccountScope(current.account_scope)) {
            // Account scope is returned by the Gateway App Session contract.
            // If an older cached session lacks it, obtain one replacement
            // session through the authenticated control-plane session API;
            // never query the retired Admin App Runtime endpoint.
            const generation = state.authGeneration
            await refresh(true, generation)
            if (!validAccountScope(state.session?.account_scope)) throw accountScopeUnavailable()
          }
          jsonResponse(response, 200, { data: { authenticated: Boolean(state.session), app_id: appID, app_version: version, ...(state.session?.account_scope ? { account_scope: state.session.account_scope } : {}) } })
          return
        }
        // The profile bridge is account metadata, not a Gateway model route.
        // Resolve it with the same platform credential used to mint the App
        // Session so local development shows the signed-in user consistently.
        if (parsed.pathname === '/v1/profile' || parsed.pathname === '/auth/profile') {
          const current = await restoreAuthentication()
          if (!current) { requireLogin(response); return }
          const profile = await portalJSON('/portal/user/profile', {}, 'account_scope', state.portalToken)
          const safeProfile = profile && typeof profile === 'object' ? {
            ...(typeof profile.id === 'string' ? { id: profile.id } : {}),
            ...(typeof profile.email === 'string' ? { email: profile.email } : {}),
            ...(typeof profile.username === 'string' ? { username: profile.username } : {}),
            ...(typeof profile.name === 'string' ? { name: profile.name } : {}),
            ...(typeof profile.avatar_url === 'string' ? { avatar_url: profile.avatar_url } : {}),
          } : {}
          jsonResponse(response, 200, { data: safeProfile })
          return
        }
        const gatewayRequest = parsed.pathname === '/v1' || parsed.pathname.startsWith('/v1/')
        if (gatewayRequest) {
          await restoreAuthentication()
          if (!state.session) { requireLogin(response); return }
          const prefix = '/v1'
          const suffix = parsed.pathname.slice(prefix.length) || '/'
          const target = (session) => session.gateway_url + suffix + parsed.search
          const stage = 'gateway'
          const generation = state.authGeneration
          let current = state.session
          let upstream = await forward(target(current), request, rawBody, current.access_token, current.app_version, stage)
          if (await retryableSessionExpiry(upstream)) {
            await upstream.arrayBuffer().catch(() => undefined)
            try {
              assertAuthentication(generation)
              current = state.session && state.session.access_token !== current.access_token ? state.session : await refresh(true, generation)
            } catch (error) {
              assertAuthentication(generation)
              if (error?.code === 'APP_LOGIN_SESSION_EXPIRED' || error?.code === 'APP_LOGIN_NOT_ALLOWED') {
                await clearAuthentication(true)
                requireLogin(response, error)
                return
              }
              throw error
            }
            assertAuthentication(generation)
            upstream = await forward(target(current), request, rawBody, current.access_token, current.app_version, stage)
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
        const message = error instanceof Error ? error.message : String(error)
        jsonResponse(response, error?.statusCode || (error?.message === 'local development relay is closed' ? 503 : 502), {
          code: error?.code || 'LOCAL_DEV_RELAY_ERROR', error: message, message,
          stage: error?.stage,
          execution_unknown: error?.executionUnknown || undefined,
        })
      }
    })
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
    const address = server.address()
    relayURL = 'http://127.0.0.1:' + address.port
    return { relayURL, prepareDevelopment, close }
  } catch (error) {
    await close()
    throw error
  }
}
