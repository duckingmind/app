import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import test from 'node:test'
import { createLocalDevelopmentRelay } from './local-dev-relay.mjs'

const headers = { 'X-Proxy-App-Relay': 'test-relay-secret' }
const deferred = () => {
  let resolve
  const promise = new Promise((done) => { resolve = done })
  return { promise, resolve }
}

async function fixture({ token = null, sessionStatus = 200, sessionGate = null, saveGate = null } = {}) {
  const state = { token, sessionStatus, registrations: [], sessions: [], revocations: [], loads: 0, clears: 0 }
  const sessionStarted = deferred()
  const saveStarted = deferred()
  const credentialStore = {
    async load() { state.loads++; return state.token },
    async save(value) { saveStarted.resolve(); await saveGate?.promise; state.token = value },
    async clear() { state.clears++; state.token = null },
  }
  const server = createServer(async (request, response) => {
    response.setHeader('Content-Type', 'application/json')
    let body = ''
    for await (const chunk of request) body += chunk
    if (request.url.endsWith('/local-development')) {
      state.registrations.push(JSON.parse(body))
      response.end(JSON.stringify({ data: { id: 'test-app', slug: 'app.example.test' } }))
    } else if (request.url.endsWith('/sessions') && request.method === 'POST') {
      const session = { ...JSON.parse(body), session_id: `session-${state.sessions.length + 1}`, access_token: `ast_test_${state.sessions.length + 1}`, gateway_url: baseURL, account_scope: 'acs_' + 'a'.repeat(64) }
      state.sessions.push(session)
      sessionStarted.resolve()
      await sessionGate?.promise
      response.statusCode = state.sessionStatus
      response.end(JSON.stringify(state.sessionStatus === 200 ? { data: session } : { error: { message: 'session creation failed' } }))
    } else if (request.method === 'DELETE') {
      state.revocations.push(request.url)
      response.end(JSON.stringify({ data: {} }))
    } else {
      response.end(JSON.stringify({ data: { id: 'test-user' } }))
    }
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const baseURL = `http://127.0.0.1:${server.address().port}`
  const relays = []
  const start = async (version = '0.1.0', port = 5173) => {
    const relay = await createLocalDevelopmentRelay({
      baseURL: `${baseURL}/api`, portalURL: baseURL, relaySecret: headers['X-Proxy-App-Relay'],
      appID: 'test-app', appSlug: 'app.example.test', version,
      manifest: { id: 'app.example.test', version }, entryURL: `http://127.0.0.1:${port}/`, credentialStore,
    })
    relays.push(relay)
    await relay.prepareDevelopment({ token: 'developer-token' })
    return relay
  }
  const get = async (relay, path = '/__platform/auth/status', init = {}) => {
    const response = await fetch(relay.relayURL + path, { ...init, headers })
    return { status: response.status, body: await response.json() }
  }
  const login = async (relay, value = 'test-portal-authorization') => {
    const { body } = await get(relay, '/__platform/auth/start')
    return fetch(relay.relayURL + '/auth/callback', {
      method: 'POST', body: new URLSearchParams({ state: body.data.auth_state, access_token: value }),
    })
  }
  const close = async () => {
    sessionGate?.resolve()
    saveGate?.resolve()
    await Promise.all(relays.map((relay) => relay.close()))
    await new Promise((resolve) => server.close(resolve))
  }
  return { state, start, get, login, close, sessionStarted, saveStarted }
}

test('dev restart restores authorization with a fresh session and current version/entry', async () => {
  const f = await fixture()
  try {
    const first = await f.start()
    assert.equal((await f.login(first)).status, 200)
    assert.equal(f.state.token, 'test-portal-authorization')
    await first.close()
    assert.ok(f.state.revocations.some((path) => path.endsWith('/session-1')))
    assert.equal(f.state.token, 'test-portal-authorization')
    const second = await f.start('0.2.0', 5181)
    const status = await f.get(second)
    assert.equal(status.body.data.authenticated, true)
    assert.equal(f.state.sessions.length, 2)
    assert.equal(f.state.sessions[1].version, '0.2.0')
    assert.equal(f.state.registrations[1].entry_url, 'http://127.0.0.1:5181/')
    assert.equal(f.state.registrations[1].manifest.version, '0.2.0')
    assert.doesNotMatch(JSON.stringify(status), /test-portal-authorization|ast_test_/)
    const start = await f.get(second, '/__platform/auth/start')
    assert.equal(start.body.data.authenticated, true)
    assert.equal(start.body.data.force_login, false)
  } finally { await f.close() }
})

test('logout removes persistent authorization and a restart remains signed out', async () => {
  const f = await fixture({ token: 'cached-authorization' })
  try {
    const relay = await f.start()
    assert.equal((await f.get(relay)).body.data.authenticated, true)
    await f.get(relay, '/__platform/auth/logout', { method: 'POST' })
    assert.equal(f.state.token, null)
    await relay.close()
    const restarted = await f.start()
    assert.equal((await f.get(restarted)).body.data.authenticated, false)
    assert.equal(f.state.sessions.length, 1)
  } finally { await f.close() }
})

test('expired cached authorization is removed and requires one fresh platform login', async () => {
  const f = await fixture({ token: 'expired-authorization', sessionStatus: 401 })
  try {
    const relay = await f.start()
    assert.equal((await f.get(relay)).body.data.authenticated, false)
    assert.equal(f.state.token, null)
    const result = await f.get(relay, '/v1/models')
    assert.equal(result.status, 401)
    assert.equal(result.body.force_login, true)
    assert.equal(f.state.sessions.length, 1)
    assert.equal(f.state.registrations.length, 1)
    f.state.sessionStatus = 200
    assert.equal((await f.login(relay, 'fresh-user-authorization')).status, 200)
    assert.equal((await f.get(relay)).body.data.authenticated, true)
    assert.equal(f.state.token, 'fresh-user-authorization')
    assert.equal(f.state.registrations.length, 1)
  } finally { await f.close() }
})

test('temporary restore failure preserves saved authorization and can recover without login', async () => {
  const f = await fixture({ token: 'cached-authorization', sessionStatus: 503 })
  try {
    const relay = await f.start()
    const unavailable = await f.get(relay)
    assert.equal(unavailable.status, 503)
    assert.equal(unavailable.body.code, 'APP_SESSION_CREATE_FAILED')
    assert.equal(f.state.token, 'cached-authorization')
    assert.equal(f.state.clears, 0)
    f.state.sessionStatus = 200
    assert.equal((await f.get(relay)).body.data.authenticated, true)
    assert.equal(f.state.loads, 1)
  } finally { await f.close() }
})

test('concurrent status and API requests restore only one session', async () => {
  const gate = deferred()
  const f = await fixture({ token: 'cached-authorization', sessionGate: gate })
  try {
    const relay = await f.start()
    const results = Promise.all(['/__platform/auth/status', '/__platform/auth/status', '/v1/models'].map((path) => f.get(relay, path)))
    await f.sessionStarted.promise
    gate.resolve()
    assert.ok((await results).every((result) => result.status === 200))
    assert.equal(f.state.loads, 1)
    assert.equal(f.state.registrations.length, 1)
    assert.equal(f.state.sessions.length, 1)
  } finally { await f.close() }
})

test('logout and switching accounts invalidate an in-flight saved-session restore', async (t) => {
  for (const action of ['logout', 'switch']) await t.test(action, async () => {
    const gate = deferred()
    const f = await fixture({ token: 'old-authorization', sessionGate: gate })
    try {
      const relay = await f.start()
      const restore = f.get(relay)
      await f.sessionStarted.promise
      const reset = action === 'logout'
        ? await f.get(relay, '/__platform/auth/logout', { method: 'POST' })
        : await f.get(relay, '/__platform/auth/start?force_login=1')
      assert.equal(reset.status, 200)
      if (action === 'switch') {
        assert.equal(reset.body.data.authenticated, false)
        assert.equal(reset.body.data.force_login, true)
      }
      gate.resolve()
      assert.equal((await restore).status, 409)
      assert.equal((await f.get(relay)).body.data.authenticated, false)
      assert.equal(f.state.token, null)
      assert.ok(f.state.revocations.some((path) => path.endsWith('/session-1')))
    } finally { await f.close() }
  })
})

test('logout waits for an in-flight cache save and cannot resurrect that authorization', async () => {
  const gate = deferred()
  const f = await fixture({ saveGate: gate })
  try {
    const relay = await f.start()
    const login = f.login(relay)
    await f.saveStarted.promise
    const logout = f.get(relay, '/__platform/auth/logout', { method: 'POST' })
    // Wait for the synchronous authentication invalidation before finishing save.
    while ((await f.get(relay, '/health')).body.authenticated) await new Promise((resolve) => setTimeout(resolve, 5))
    gate.resolve()
    assert.equal((await logout).status, 200)
    assert.equal((await login).status, 409)
    assert.equal(f.state.token, null)
    assert.equal((await f.get(relay)).body.data.authenticated, false)
  } finally { await f.close() }
})
