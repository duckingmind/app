import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import test from 'node:test'
import { createLocalDevelopmentRelay } from './local-dev-relay.mjs'

const headers = { 'X-Proxy-App-Relay': 'relay-secret' }

function store(token) {
  return {
    token,
    saves: [],
    clears: 0,
    async load() { return this.token },
    async save(value) { this.saves.push(value); this.token = value },
    async clear() { this.clears += 1; this.token = null },
  }
}

async function body(request) {
  const chunks = []
  for await (const chunk of request) chunks.push(chunk)
  return Buffer.concat(chunks)
}

async function jsonRequest(url, init = {}) {
  const response = await fetch(url, { ...init, headers: { ...headers, ...(init.headers || {}) } })
  return { response, body: await response.json() }
}

async function fixture(t, options = {}) {
  const appSlug = options.appSlug || 'app.example.canvas'
  const calls = []
  const sessions = []
  const revoked = []
  let modelCalls = 0
  let server
  server = createServer(async (request, response) => {
    const raw = await body(request)
    const entry = { method: request.method, url: request.url, authorization: request.headers.authorization, headers: request.headers, body: raw }
    calls.push(entry)
    response.setHeader('Content-Type', 'application/json')
    if (request.method === 'POST' && request.url === `/api/portal/user/app-workspace/by-slug/${appSlug}/local-development`) {
      response.end(JSON.stringify({ data: { id: 'app-1', slug: appSlug } }))
      return
    }
    if (request.method === 'POST' && request.url === '/api/portal/user/apps/app-1/sessions') {
      const token = `ast-user-${sessions.length + 1}`
      sessions.push({ token, body: JSON.parse(raw.toString() || '{}') })
      response.end(JSON.stringify({ data: {
        session_id: `session-${sessions.length}`, access_token: token, account_scope: 'acs_' + 'a'.repeat(64),
        gateway_url: `http://127.0.0.1:${server.address().port}`, app_version: '0.1.0',
        expires_in: options.sessionExpiresIn,
      } }))
      return
    }
    if (request.method === 'DELETE' && request.url.startsWith('/api/portal/user/apps/app-1/sessions/')) {
      revoked.push(request.url)
      response.end(JSON.stringify({ data: {} }))
      return
    }
    if (request.method === 'GET' && request.url === '/api/portal/user/profile') {
      response.end(JSON.stringify({ data: { id: 'user-1', email: 'pelican@example.test', username: 'Pelican creator', avatar_url: 'https://example.test/avatar.png' } }))
      return
    }
    if (request.url === '/v1/models') {
      modelCalls += 1
      if (options.expireOnce && modelCalls === 1) {
        response.statusCode = 401
        response.end(JSON.stringify({ error: { auth_reason: 'APP_SESSION_EXPIRED', execution_started: false } }))
        return
      }
      response.end(JSON.stringify({ data: [{ id: 'model-1' }] }))
      return
    }
    if (request.method === 'POST' && request.url === '/v1/estimates') {
      response.end(JSON.stringify({ estimated: true, known: true, amount: 0.12, currency: 'USD' }))
      return
    }
    response.statusCode = 404
    response.end(JSON.stringify({ code: 'not_found' }))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${server.address().port}`
  const developer = store(options.developerToken || 'developer-token')
  const user = store(options.userToken || 'user-token')
  const relay = await createLocalDevelopmentRelay({
    baseURL: origin + '/api', portalURL: origin, relaySecret: 'relay-secret',
    appID: options.initialAppID || 'app-1', appSlug, version: '0.1.0',
    manifest: { id: appSlug, version: '0.1.0' }, entryURL: 'http://127.0.0.1:5173/',
    credentialStore: user, developerCredentialStore: developer,
  })
  t.after(async () => {
    await relay.close()
    await new Promise(resolve => server.close(resolve))
  })
  await relay.prepareDevelopment()
  return { relay, origin, calls, sessions, revoked, developer, user, get: (path, init) => jsonRequest(relay.relayURL + path, init) }
}

test('local relay uses the dedicated auth relay and creates a Gateway App Session', async t => {
  const fixtureData = await fixture(t)
  const status = await fixtureData.get('/__platform/auth/status')
  assert.equal(status.response.status, 200, JSON.stringify(status.body))
  assert.equal(status.body.data.authenticated, true)
  assert.match(status.body.data.account_scope, /^acs_[a-f0-9]{64}$/)
  assert.deepEqual(fixtureData.sessions[0].body, { version: '0.1.0', runtime_protocol: 1 })
  assert.equal(fixtureData.calls.some(call => call.url.includes('/api/app-runtime') || call.url.includes('/bridge')), false)
})

test('slug-only development adopts the server identity for sessions and logout without repair', async t => {
  const f = await fixture(t, { initialAppID: 'canvas', appSlug: 'canvas' })
  const status = await f.get('/__platform/auth/status')
  assert.equal(status.response.status, 200)
  assert.equal(status.body.data.app_id, 'app-1')
  assert.equal(f.calls[0].url, '/api/portal/user/app-workspace/by-slug/canvas/local-development')
  assert.ok(f.calls.some(call => call.url === '/api/portal/user/apps/app-1/sessions'))
  await f.get('/__platform/auth/logout', { method: 'POST' })
  assert.ok(f.revoked.includes('/api/portal/user/apps/app-1/sessions/session-1'))
  assert.equal(f.calls.some(call => call.url.includes('/apps/canvas/')), false)
})

test('local relay forwards only /v1 Gateway requests with the user App Session', async t => {
  const fixtureData = await fixture(t)
  const result = await fixtureData.get('/v1/models')
  assert.equal(result.response.status, 200)
  assert.deepEqual(result.body, { data: [{ id: 'model-1' }] })
  const gatewayCall = fixtureData.calls.find(call => call.url === '/v1/models')
  assert.equal(gatewayCall.authorization, 'Bearer ast-user-1')
  assert.equal(gatewayCall.headers.cookie, undefined)
  assert.equal(gatewayCall.headers.origin, undefined)
})

test('local relay exposes the signed-in profile without forwarding it to the Gateway', async t => {
  const fixtureData = await fixture(t)
  const result = await fixtureData.get('/v1/profile')
  assert.equal(result.response.status, 200, JSON.stringify(result.body))
  assert.deepEqual(result.body.data, {
    id: 'user-1',
    email: 'pelican@example.test',
    username: 'Pelican creator',
    avatar_url: 'https://example.test/avatar.png',
  })
  assert.equal(fixtureData.calls.filter(call => call.url === '/v1/profile').length, 0)
  assert.equal(fixtureData.calls.filter(call => call.url === '/api/portal/user/profile').length, 1)
})

test('local relay forwards estimates as a single estimate request with App Session auth', async t => {
  const fixtureData = await fixture(t)
  const body = JSON.stringify({ model: 'image-1', model_type: 'image', operation: 'generation', parameters: { n: 2 } })
  const result = await fixtureData.get('/v1/estimates', {
    method: 'POST', body, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer developer-token', Cookie: 'portal=secret' },
  })
  assert.equal(result.response.status, 200)
  assert.equal(result.body.amount, 0.12)
  const gatewayCalls = fixtureData.calls.filter(call => call.url.startsWith('/v1/'))
  assert.equal(gatewayCalls.length, 1)
  assert.equal(gatewayCalls[0].url, '/v1/estimates')
  assert.equal(gatewayCalls[0].method, 'POST')
  assert.equal(gatewayCalls[0].body.toString(), body)
  assert.equal(gatewayCalls[0].authorization, 'Bearer ast-user-1')
  assert.equal(gatewayCalls[0].headers.cookie, undefined)
})

test('local relay rejects Admin Runtime and legacy Bridge paths', async t => {
  const fixtureData = await fixture(t)
  for (const path of ['/api/app-runtime/v1/storage/items', '/bridge', '/api/portal/user/apps/app-1/bridge']) {
    const result = await fixtureData.get(path)
    assert.equal(result.response.status, 404, path)
    assert.equal(result.body.code, 'LOCAL_DEV_ROUTE_NOT_FOUND', path)
  }
  assert.equal(fixtureData.calls.some(call => call.url.includes('/bridge')), false)
})

test('Gateway session expiry is refreshed once before retrying the same request', async t => {
  const fixtureData = await fixture(t, { expireOnce: true })
  const result = await fixtureData.get('/v1/models')
  assert.equal(result.response.status, 200)
  assert.equal(fixtureData.sessions.length, 2)
  assert.equal(fixtureData.calls.filter(call => call.url === '/v1/models').length, 2)
})

test('local relay keeps a valid session through its TTL and refreshes only after Gateway reports expiry', async t => {
  const fixtureData = await fixture(t, { expireOnce: true, sessionExpiresIn: 3600 })
  const firstStatus = await fixtureData.get('/__platform/auth/status')
  assert.equal(firstStatus.response.status, 200)
  const secondStatus = await fixtureData.get('/__platform/auth/status')
  assert.equal(secondStatus.response.status, 200)
  assert.equal(fixtureData.sessions.length, 1)

  const result = await fixtureData.get('/v1/models')
  assert.equal(result.response.status, 200)
  assert.equal(fixtureData.sessions.length, 2)
  assert.equal(fixtureData.calls.filter(call => call.url === '/v1/models').length, 2)
})

test('logout removes the cached user credential and blocks later Gateway calls', async t => {
  const fixtureData = await fixture(t)
  await fixtureData.get('/__platform/auth/status')
  const logout = await fixtureData.get('/__platform/auth/logout', { method: 'POST' })
  assert.equal(logout.response.status, 200, JSON.stringify(logout.body))
  assert.equal(fixtureData.user.token, null)
  const afterLogout = await fixtureData.get('/v1/models')
  assert.equal(afterLogout.response.status, 401)
  assert.equal(afterLogout.body.code, 'APP_LOGIN_REQUIRED')
  assert.equal(fixtureData.revoked.length, 1)
})

test('relay does not replay an upstream 502 response', async t => {
  const fixtureData = await fixture(t)
  const original = fixtureData.calls
  const result = await fixtureData.get('/v1/unknown')
  assert.equal(result.response.status, 404)
  assert.equal(original.filter(call => call.url === '/v1/unknown').length, 1)
})
