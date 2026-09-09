import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import test from 'node:test'
import { createLocalDevelopmentRelay } from './local-dev-relay.mjs'

async function startServer(handler) {
  const server = createServer(handler)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  return {
    server,
    baseURL: 'http://127.0.0.1:' + address.port,
    close: () => new Promise((resolve) => server.close(resolve)),
  }
}

async function jsonRequest(url, init = {}) {
  const response = await fetch(url, init)
  return { response, body: await response.json() }
}

async function loginRelay(relay, token = 'portal_user_token') {
  const start = await jsonRequest(relay.relayURL + '/api/app-runtime/v1/auth/start', { headers: { 'X-Proxy-App-Relay': 'relay-secret' } })
  const response = await fetch(relay.relayURL + '/auth/callback', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ state: start.body.data.auth_state, access_token: token }),
  })
  assert.equal(response.status, 200, await response.text())
}

test('HTTP runtime forwards method, query, body and metadata with the user App Session', async () => {
  const calls = []
  let sessionRequest
  const platform = await startServer(async (request, response) => {
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    const body = Buffer.concat(chunks).toString('utf8')
    calls.push({ method: request.method, url: request.url, headers: request.headers, body })
    response.setHeader('Content-Type', 'application/json')
    if (request.url?.includes('/local-development')) { response.end(JSON.stringify({ data: {} })); return }
    if (request.url === '/api/portal/user/apps/app-1/sessions' && request.method === 'POST') {
      sessionRequest = JSON.parse(body)
      response.end(JSON.stringify({ data: {
        session_id: 'session-1', access_token: 'ast_user_1', gateway_url: platform.baseURL,
        app_id: 'app-1', app_slug: 'app.example.chat', app_version: '0.1.0', scopes: ['storage.user'],
      } }))
      return
    }
    if (request.url?.startsWith('/api/portal/user/apps/app-1/sessions/')) { response.end(JSON.stringify({ data: {} })); return }
    if (request.url?.startsWith('/api/app-runtime/v1/storage/items')) {
      response.setHeader('ETag', 'revision-2')
      response.setHeader('X-Request-ID', 'runtime-request-1')
      response.setHeader('Set-Cookie', 'unrelated-platform-cookie=secret')
      response.end(JSON.stringify({ data: request.method === 'GET' ? { text: 'saved value' } : { success: true } }))
      return
    }
    if (request.url === '/api/app-runtime/v1/profile') {
      response.statusCode = 403
      response.setHeader('X-Request-ID', 'runtime-forbidden-1')
      response.end(JSON.stringify({ error: { code: 'APP_PERMISSION_DENIED', message: 'permission denied' } }))
      return
    }
    response.statusCode = 404
    response.end(JSON.stringify({ error: 'not found' }))
  })
  const relay = await createLocalDevelopmentRelay({
    baseURL: platform.baseURL + '/api', portalURL: platform.baseURL, relaySecret: 'relay-secret',
    appID: 'app-1', appSlug: 'app.example.chat', version: '0.1.0',
    manifest: { schema: 'proxy.app/v1', id: 'app.example.chat', version: '0.1.0' }, entryURL: 'http://127.0.0.1:5173/',
  })
  try {
    const unauthorized = await jsonRequest(relay.relayURL + '/api/app-runtime/v1/profile', { headers: { 'X-Proxy-App-Relay': 'relay-secret' } })
    assert.equal(unauthorized.response.status, 401)
    assert.equal(unauthorized.body.code, 'APP_LOGIN_REQUIRED')
    await loginRelay(relay)
    assert.deepEqual(sessionRequest, { version: '0.1.0', runtime_protocol: 2 })
    const authStatus = await jsonRequest(relay.relayURL + '/api/app-runtime/v1/auth/status', { headers: { 'X-Proxy-App-Relay': 'relay-secret' } })
    assert.equal(authStatus.body.data.authenticated, true)
    const write = await jsonRequest(relay.relayURL + '/api/app-runtime/v1/storage/items?key=design%3Adraft', {
      method: 'PUT', headers: {
        'X-Proxy-App-Relay': 'relay-secret', Authorization: 'Bearer attacker', Cookie: 'browser=secret',
        Origin: 'http://127.0.0.1:5173', 'X-App-Version': 'local', 'Content-Type': 'application/json',
        'X-Request-ID': 'app-request-1', 'Idempotency-Key': 'operation-1', 'If-Match': 'revision-1',
      }, body: JSON.stringify({ value: { text: 'saved value' } }),
    })
    assert.equal(write.response.status, 200)
    assert.deepEqual(write.body, { data: { success: true } })
    assert.equal(write.response.headers.get('etag'), 'revision-2')
    assert.equal(write.response.headers.get('x-request-id'), 'runtime-request-1')
    assert.equal(write.response.headers.get('set-cookie'), null)
    const runtimeCall = calls.find((call) => call.url?.startsWith('/api/app-runtime/v1/storage/items'))
    assert.equal(runtimeCall.method, 'PUT')
    assert.equal(runtimeCall.url, '/api/app-runtime/v1/storage/items?key=design%3Adraft')
    assert.deepEqual(JSON.parse(runtimeCall.body), { value: { text: 'saved value' } })
    assert.equal(runtimeCall.headers.authorization, 'Bearer ast_user_1')
    assert.equal(runtimeCall.headers['x-app-version'], '0.1.0')
    assert.equal(runtimeCall.headers['x-request-id'], 'app-request-1')
    assert.equal(runtimeCall.headers['idempotency-key'], 'operation-1')
    assert.equal(runtimeCall.headers['if-match'], 'revision-1')
    assert.equal(runtimeCall.headers.cookie, undefined)
    assert.equal(runtimeCall.headers.origin, undefined)
    assert.equal(runtimeCall.headers['x-proxy-app-relay'], undefined)
    const forbidden = await jsonRequest(relay.relayURL + '/api/app-runtime/v1/profile', { headers: { 'X-Proxy-App-Relay': 'relay-secret' } })
    assert.equal(forbidden.response.status, 403)
    assert.equal(forbidden.body.error.code, 'APP_PERMISSION_DENIED')
    assert.equal(forbidden.response.headers.get('x-request-id'), 'runtime-forbidden-1')
    assert.equal(calls.filter((call) => call.url === '/api/portal/user/apps/app-1/sessions' && call.method === 'POST').length, 1)
    const bridge = await jsonRequest(relay.relayURL + '/bridge', { method: 'POST', headers: { 'X-Proxy-App-Relay': 'relay-secret' } })
    assert.equal(bridge.response.status, 404)
    assert.equal(bridge.body.error.code, 'APP_LEGACY_BRIDGE_DISABLED')
    assert.equal(calls.some((call) => call.url?.includes('/bridge')), false)
    const logout = await jsonRequest(relay.relayURL + '/api/app-runtime/v1/auth/logout', { method: 'POST', headers: { 'X-Proxy-App-Relay': 'relay-secret' } })
    assert.equal(logout.response.status, 200)
    const loggedOut = await jsonRequest(relay.relayURL + '/api/app-runtime/v1/auth/status', { headers: { 'X-Proxy-App-Relay': 'relay-secret' } })
    assert.equal(loggedOut.body.data.authenticated, false)
    assert.equal(calls.some((call) => call.url?.startsWith('/api/app-runtime/v1/auth/')), false)
  } finally {
    await relay.close()
    await platform.close()
  }
})

test('HTTP runtime refreshes expired sessions once for concurrent requests', async () => {
  let sessionCount = 0
  const platform = await startServer(async (request, response) => {
    response.setHeader('Content-Type', 'application/json')
    if (request.url?.includes('/local-development')) { response.end(JSON.stringify({ data: {} })); return }
    if (request.url === '/api/portal/user/apps/app-1/sessions' && request.method === 'POST') {
      sessionCount += 1
      if (sessionCount > 1) await new Promise((resolve) => setTimeout(resolve, 25))
      response.end(JSON.stringify({ data: {
        session_id: 'session-' + sessionCount, access_token: 'ast_user_' + sessionCount, gateway_url: platform.baseURL,
        app_id: 'app-1', app_slug: 'app.example.chat', app_version: '0.1.0', scopes: ['storage.user'],
      } }))
      return
    }
    if (request.url?.startsWith('/api/portal/user/apps/app-1/sessions/')) { response.end(JSON.stringify({ data: {} })); return }
    if (request.url === '/api/app-runtime/v1/profile') {
      if (request.headers.authorization === 'Bearer ast_user_1') {
        response.statusCode = 401
        response.end(JSON.stringify({ error: { code: 'APP_SESSION_EXPIRED', execution_started: false, message: 'expired' } }))
      } else response.end(JSON.stringify({ data: { id: 'user-1' } }))
      return
    }
    response.statusCode = 404
    response.end(JSON.stringify({ error: 'not found' }))
  })
  const relay = await createLocalDevelopmentRelay({
    baseURL: platform.baseURL + '/api', portalURL: platform.baseURL, relaySecret: 'relay-secret',
    appID: 'app-1', appSlug: 'app.example.chat', version: '0.1.0',
    manifest: { schema: 'proxy.app/v1', id: 'app.example.chat', version: '0.1.0' }, entryURL: 'http://127.0.0.1:5173/',
  })
  try {
    await loginRelay(relay)
    const results = await Promise.all(Array.from({ length: 4 }, () => jsonRequest(relay.relayURL + '/api/app-runtime/v1/profile', {
      headers: { 'X-Proxy-App-Relay': 'relay-secret' },
    })))
    for (const result of results) {
      assert.equal(result.response.status, 200)
      assert.deepEqual(result.body, { data: { id: 'user-1' } })
    }
    assert.equal(sessionCount, 2)
  } finally {
    await relay.close()
    await platform.close()
  }
})

test('logout and account switching invalidate delayed refresh results', { timeout: 10000 }, async (t) => {
  for (const action of ['logout', 'switch account']) {
    await t.test(action, async () => {
      let sessionCount = 0
      let releaseRefresh
      const refreshGate = new Promise((resolve) => { releaseRefresh = resolve })
      let signalRefreshStarted
      const refreshStarted = new Promise((resolve) => { signalRefreshStarted = resolve })
      const revoked = []
      const runtimeTokens = []
      const platform = await startServer(async (request, response) => {
        response.setHeader('Content-Type', 'application/json')
        if (request.url?.includes('/local-development')) { response.end(JSON.stringify({ data: {} })); return }
        if (request.url === '/api/portal/user/apps/app-1/sessions' && request.method === 'POST') {
          const index = ++sessionCount
          const user = request.headers.authorization === 'Bearer portal_user_two' ? 'two' : 'one'
          if (index === 2) { signalRefreshStarted(); await refreshGate }
          response.end(JSON.stringify({ data: {
            session_id: 'session-' + index, access_token: 'ast_' + user + '_' + index, gateway_url: platform.baseURL,
            app_id: 'app-1', app_slug: 'app.example.chat', app_version: '0.1.0', scopes: ['storage.user'],
          } }))
          return
        }
        if (request.url?.startsWith('/api/portal/user/apps/app-1/sessions/')) {
          revoked.push({ url: request.url, authorization: request.headers.authorization })
          response.end(JSON.stringify({ data: {} }))
          return
        }
        if (request.url === '/api/app-runtime/v1/profile') {
          runtimeTokens.push(request.headers.authorization)
          if (request.headers.authorization === 'Bearer ast_one_1') {
            response.statusCode = 401
            response.end(JSON.stringify({ error: { code: 'APP_SESSION_EXPIRED', execution_started: false, message: 'expired' } }))
          } else response.end(JSON.stringify({ data: { authorization: request.headers.authorization } }))
          return
        }
        response.statusCode = 404
        response.end(JSON.stringify({ error: 'not found' }))
      })
      const relay = await createLocalDevelopmentRelay({
        baseURL: platform.baseURL + '/api', portalURL: platform.baseURL, relaySecret: 'relay-secret',
        appID: 'app-1', appSlug: 'app.example.chat', version: '0.1.0',
        manifest: { schema: 'proxy.app/v1', id: 'app.example.chat', version: '0.1.0' }, entryURL: 'http://127.0.0.1:5173/',
      })
      try {
        await loginRelay(relay)
        const oldRequest = jsonRequest(relay.relayURL + '/api/app-runtime/v1/profile', { headers: { 'X-Proxy-App-Relay': 'relay-secret' } })
        await refreshStarted
        if (action === 'logout') {
          const logout = await jsonRequest(relay.relayURL + '/api/app-runtime/v1/auth/logout', { method: 'POST', headers: { 'X-Proxy-App-Relay': 'relay-secret' } })
          assert.equal(logout.response.status, 200)
        } else await loginRelay(relay, 'portal_user_two')
        releaseRefresh()
        const staleResult = await oldRequest
        assert.equal(staleResult.response.status, 409)
        assert.equal(staleResult.body.code, 'APP_AUTH_CHANGED')
        const status = await jsonRequest(relay.relayURL + '/api/app-runtime/v1/auth/status', { headers: { 'X-Proxy-App-Relay': 'relay-secret' } })
        assert.equal(status.body.data.authenticated, action !== 'logout')
        assert.deepEqual(revoked.find((item) => item.url.endsWith('/session-2')), {
          url: '/api/portal/user/apps/app-1/sessions/session-2', authorization: 'Bearer portal_user_token',
        })
        assert.deepEqual(runtimeTokens, ['Bearer ast_one_1'])
        if (action !== 'logout') {
          const current = await jsonRequest(relay.relayURL + '/api/app-runtime/v1/profile', { headers: { 'X-Proxy-App-Relay': 'relay-secret' } })
          assert.equal(current.response.status, 200)
          assert.equal(current.body.data.authorization, 'Bearer ast_two_3')
        }
      } finally {
        releaseRefresh()
        await relay.close()
        await platform.close()
      }
    })
  }
})

test('unmarked or already-executing 401 responses are preserved without replay', async () => {
  const failures = [
    { error: { code: 'upstream_error', message: 'provider unauthorized' } },
    { error: { auth_reason: 'APP_SESSION_EXPIRED', message: 'no execution marker' } },
    { error: { auth_reason: 'APP_SESSION_EXPIRED', execution_started: true, message: 'already dispatched' } },
    { error: { auth_reason: 'APP_SESSION_REVOKED', execution_started: false, message: 'revoked' } },
  ]
  const runtimeFailures = [
    { error: { code: 'APP_SESSION_INVALID', message: 'invalid session' } },
    { error: { code: 'APP_SESSION_EXPIRED', message: 'no execution marker' } },
    { error: { code: 'APP_SESSION_EXPIRED', execution_started: true, message: 'already dispatched' } },
  ]
  let sessionCount = 0
  let gatewayCalls = 0
  let runtimeCalls = 0
  const platform = await startServer(async (request, response) => {
    response.setHeader('Content-Type', 'application/json')
    if (request.url?.includes('/local-development')) { response.end(JSON.stringify({ data: {} })); return }
    if (request.url === '/api/portal/user/apps/app-1/sessions' && request.method === 'POST') {
      sessionCount += 1
      response.end(JSON.stringify({ data: {
        session_id: 'session-' + sessionCount, access_token: 'ast_user_' + sessionCount, gateway_url: platform.baseURL,
        app_id: 'app-1', app_slug: 'app.example.chat', app_version: '0.1.0', scopes: ['storage.user'],
      } }))
      return
    }
    if (request.url?.startsWith('/api/portal/user/apps/app-1/sessions/')) { response.end(JSON.stringify({ data: {} })); return }
    if (request.url?.startsWith('/v1/responses')) {
      gatewayCalls += 1
      const index = Number(new URL(request.url, platform.baseURL).searchParams.get('failure'))
      response.statusCode = 401
      response.setHeader('X-Request-ID', 'provider-failure-' + index)
      response.end(JSON.stringify(failures[index]))
      return
    }
    if (request.url?.startsWith('/api/app-runtime/v1/storage/items')) {
      runtimeCalls += 1
      const index = Number(new URL(request.url, platform.baseURL).searchParams.get('failure'))
      response.statusCode = 401
      response.end(JSON.stringify(runtimeFailures[index]))
      return
    }
    response.statusCode = 404
    response.end(JSON.stringify({ error: 'not found' }))
  })
  const relay = await createLocalDevelopmentRelay({
    baseURL: platform.baseURL + '/api', portalURL: platform.baseURL, relaySecret: 'relay-secret',
    appID: 'app-1', appSlug: 'app.example.chat', version: '0.1.0',
    manifest: { schema: 'proxy.app/v1', id: 'app.example.chat', version: '0.1.0' }, entryURL: 'http://127.0.0.1:5173/',
  })
  try {
    await loginRelay(relay)
    for (let index = 0; index < failures.length; index += 1) {
      const result = await jsonRequest(relay.relayURL + '/v1/responses?failure=' + index, {
        method: 'POST', headers: { 'X-Proxy-App-Relay': 'relay-secret', 'Idempotency-Key': 'operation-' + index }, body: JSON.stringify({ input: 'test' }),
      })
      assert.equal(result.response.status, 401)
      assert.equal(result.response.headers.get('x-request-id'), 'provider-failure-' + index)
      assert.deepEqual(result.body, failures[index])
    }
    for (let index = 0; index < runtimeFailures.length; index += 1) {
      const invalid = await jsonRequest(relay.relayURL + '/api/app-runtime/v1/storage/items?key=work&failure=' + index, {
        method: 'PUT', headers: { 'X-Proxy-App-Relay': 'relay-secret' }, body: JSON.stringify({ value: 'test' }),
      })
      assert.equal(invalid.response.status, 401)
      assert.deepEqual(invalid.body, runtimeFailures[index])
    }
    assert.equal(gatewayCalls, failures.length)
    assert.equal(runtimeCalls, runtimeFailures.length)
    assert.equal(sessionCount, 1)
  } finally {
    await relay.close()
    await platform.close()
  }
})

test('legacy relay requires the current user login and enables Bridge only when requested', async () => {
  const calls = []
  let sessionCount = 0
  const platform = await startServer(async (request, response) => {
    calls.push({ method: request.method, url: request.url, authorization: request.headers.authorization })
    response.setHeader('Content-Type', 'application/json')
    if (request.url === '/api/portal/user/app-workspace/app-1/local-development') {
      response.end(JSON.stringify({ data: { ok: true } }))
      return
    }
    if (request.url === '/api/portal/user/apps/app-1/sessions' && request.method === 'POST') {
      sessionCount += 1
      response.end(JSON.stringify({ data: {
        session_id: 'session-' + sessionCount,
        access_token: 'ast_user_' + sessionCount,
        token_type: 'Bearer',
        expires_in: 900,
        gateway_url: platform.baseURL,
        app_id: 'app-1',
        app_slug: 'app.example.chat',
        app_version: '0.1.0',
        scopes: ['model.responses'],
      } }))
      return
    }
    if (request.url === '/api/portal/user/apps/app-1/sessions/session-1' && request.method === 'DELETE') {
      response.end(JSON.stringify({ data: { success: true } }))
      return
    }
    if (request.url === '/api/portal/user/apps/app-1/bridge') {
      response.end(JSON.stringify({ data: { id: 'legacy-user' } }))
      return
    }
    if (request.url === '/v1/models') {
      if (request.headers.authorization !== 'Bearer ast_user_1') {
        response.statusCode = 401
        response.end(JSON.stringify({ error: 'invalid internal token' }))
        return
      }
      response.end(JSON.stringify({ data: [{ id: 'model-for-user' }] }))
      return
    }
    response.statusCode = 404
    response.end(JSON.stringify({ error: 'not found' }))
  })
  const relay = await createLocalDevelopmentRelay({
    legacyBridge: true,
    baseURL: platform.baseURL + '/api',
    portalURL: platform.baseURL,
    relaySecret: 'relay-secret',
    appID: 'app-1',
    appSlug: 'app.example.chat',
    version: '0.1.0',
    manifest: { schema: 'proxy.app/v1', id: 'app.example.chat', version: '0.1.0' },
    entryURL: 'http://127.0.0.1:5173/',
  })
  try {
    const unauthenticated = await jsonRequest(relay.relayURL + '/v1/models', { headers: { 'X-Proxy-App-Relay': 'relay-secret' } })
    assert.equal(unauthenticated.response.status, 401)
    assert.equal(unauthenticated.body.code, 'APP_LOGIN_REQUIRED')
    assert.match(unauthenticated.body.login_url, /proxy_app_auth=1/)

    const callback = await fetch(relay.relayURL + '/auth/callback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ state: unauthenticated.body.auth_state, access_token: 'portal_user_token' }),
    })
    assert.equal(callback.status, 200)
    const callbackHTML = await callback.text()
    assert.match(callbackHTML, /login-complete/)
    assert.match(callbackHTML, /<\/script>/)
    assert.equal(callbackHTML.includes('<\\/script>'), false)
    assert.equal(callbackHTML.includes('portal_user_token'), false)

    const authenticated = await jsonRequest(relay.relayURL + '/v1/models', { headers: { 'X-Proxy-App-Relay': 'relay-secret' } })
    assert.equal(authenticated.response.status, 200)
    assert.deepEqual(authenticated.body.data, [{ id: 'model-for-user' }])
    const authStatus = await jsonRequest(relay.relayURL + '/auth/status', { headers: { 'X-Proxy-App-Relay': 'relay-secret' } })
    assert.equal(authStatus.response.status, 200)
    assert.equal(authStatus.body.data.authenticated, true)
    assert.equal(calls.filter((call) => call.url?.includes('/sessions')).length, 1)
    assert.equal(calls.find((call) => call.url === '/v1/models').authorization, 'Bearer ast_user_1')
    assert.equal(calls.find((call) => call.url?.includes('/local-development')).authorization, 'Bearer portal_user_token')
    assert.equal(calls.some((call) => call.url === '/v1/models' && call.authorization === 'Bearer portal_user_token'), false)
    const bridge = await jsonRequest(relay.relayURL + '/bridge', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Proxy-App-Relay': 'relay-secret' },
      body: JSON.stringify({ protocol: 'proxy-app/v1', requestId: 'request-legacy', runtimeId: 'runtime-legacy', method: 'user.profile.read' }),
    })
    assert.equal(bridge.response.status, 200)
    assert.deepEqual(bridge.body, { data: { id: 'legacy-user' } })
    assert.equal(calls.find((call) => call.url === '/api/portal/user/apps/app-1/bridge').authorization, 'Bearer portal_user_token')

    const logout = await jsonRequest(relay.relayURL + '/auth/logout', {
      method: 'POST',
      headers: { 'X-Proxy-App-Relay': 'relay-secret' },
    })
    assert.equal(logout.response.status, 200)
    const afterLogout = await jsonRequest(relay.relayURL + '/v1/models', { headers: { 'X-Proxy-App-Relay': 'relay-secret' } })
    assert.equal(afterLogout.response.status, 401)
    assert.equal(afterLogout.body.code, 'APP_LOGIN_REQUIRED')
    const loggedOutStatus = await jsonRequest(relay.relayURL + '/auth/status', { headers: { 'X-Proxy-App-Relay': 'relay-secret' } })
    assert.equal(loggedOutStatus.response.status, 200)
    assert.equal(loggedOutStatus.body.data.authenticated, false)
  } finally {
    await relay.close()
    await platform.close()
  }
})

test('local relay returns a structured OAuth failure to the app and clears the login state', async () => {
  const platform = await startServer(async (_request, response) => {
    response.setHeader('Content-Type', 'application/json')
    response.setHeader('X-Request-ID', 'registration-request-1')
    response.statusCode = 503
    response.end(JSON.stringify({ code: 'APP_DATA_PLANE_NOT_CONFIGURED', error: 'platform unavailable' }))
  })
  const relay = await createLocalDevelopmentRelay({
    baseURL: platform.baseURL + '/api',
    portalURL: platform.baseURL,
    relaySecret: 'relay-secret',
    appID: 'app-1',
    appSlug: 'app.example.chat',
    version: '0.1.0',
    manifest: { schema: 'proxy.app/v1', id: 'app.example.chat', version: '0.1.0' },
    entryURL: 'http://127.0.0.1:5173/',
  })
  try {
    const login = await jsonRequest(relay.relayURL + '/auth/start', { headers: { 'X-Proxy-App-Relay': 'relay-secret' } })
    const callback = await fetch(relay.relayURL + '/auth/callback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ state: login.body.data.auth_state, access_token: 'portal_user_token' }),
    })
    const body = await callback.text()
    assert.equal(callback.status, 503)
    assert.match(body, /login-failed/)
    assert.match(body, /APP_APP_REGISTRATION_FAILED/)
    assert.match(body, /APP_DATA_PLANE_NOT_CONFIGURED/)
    assert.match(body, /registration-request-1/)
    assert.match(body, /应用开发登记失败/)
    assert.equal(body.includes('portal_user_token'), false)

    const retry = await jsonRequest(relay.relayURL + '/auth/start', { headers: { 'X-Proxy-App-Relay': 'relay-secret' } })
    assert.notEqual(retry.body.data.auth_state, login.body.data.auth_state)
  } finally {
    await relay.close()
    await platform.close()
  }
})

test('real local relay refreshes a gateway-confirmed expired App Session and revokes the old session on close', async () => {
  let sessionCount = 0
  const revoked = []
  const platform = await startServer(async (request, response) => {
    response.setHeader('Content-Type', 'application/json')
    if (request.url?.includes('/local-development')) {
      response.end(JSON.stringify({ data: {} }))
      return
    }
    if (request.url === '/api/portal/user/apps/app-1/sessions' && request.method === 'POST') {
      sessionCount += 1
      response.end(JSON.stringify({ data: {
        session_id: 'session-' + sessionCount,
        access_token: 'ast_user_' + sessionCount,
        token_type: 'Bearer',
        expires_in: 900,
        gateway_url: platform.baseURL,
        app_id: 'app-1',
        app_slug: 'app.example.chat',
        app_version: '0.1.0',
        scopes: [],
      } }))
      return
    }
    if (request.url?.startsWith('/api/portal/user/apps/app-1/sessions/') && request.method === 'DELETE') {
      revoked.push(request.url)
      response.end(JSON.stringify({ data: { success: true } }))
      return
    }
    if (request.url === '/v1/models') {
      if (request.headers.authorization === 'Bearer ast_user_1') {
        response.statusCode = 401
        response.end(JSON.stringify({ error: { auth_reason: 'APP_SESSION_EXPIRED', execution_started: false, message: 'expired' } }))
      } else {
        response.end(JSON.stringify({ data: [{ id: 'refreshed' }] }))
      }
      return
    }
    response.statusCode = 404
    response.end(JSON.stringify({ error: 'not found' }))
  })
  const relay = await createLocalDevelopmentRelay({
    baseURL: platform.baseURL + '/api',
    portalURL: platform.baseURL,
    relaySecret: 'relay-secret',
    appID: 'app-1',
    appSlug: 'app.example.chat',
    version: '0.1.0',
    manifest: { schema: 'proxy.app/v1', id: 'app.example.chat', version: '0.1.0' },
    entryURL: 'http://127.0.0.1:5173/',
  })
  try {
    const unauthenticated = await jsonRequest(relay.relayURL + '/v1/models', { headers: { 'X-Proxy-App-Relay': 'relay-secret' } })
    assert.equal(unauthenticated.response.status, 401)
    const callback = await fetch(relay.relayURL + '/auth/callback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ state: unauthenticated.body.auth_state, access_token: 'portal_user_token' }),
    })
    assert.equal(callback.status, 200)
    const result = await jsonRequest(relay.relayURL + '/v1/models', { headers: { 'X-Proxy-App-Relay': 'relay-secret' } })
    assert.equal(result.response.status, 200)
    assert.deepEqual(result.body.data, [{ id: 'refreshed' }])
    assert.equal(sessionCount, 2)
  } finally {
    await relay.close()
    assert.deepEqual(revoked, [
      '/api/portal/user/apps/app-1/sessions/session-1',
      '/api/portal/user/apps/app-1/sessions/session-2',
    ])
    await platform.close()
  }
})
