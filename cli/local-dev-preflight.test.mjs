import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import test from 'node:test'
import { createLocalDevelopmentRelay } from './local-dev-relay.mjs'

const headers = { 'X-Proxy-App-Relay': 'preflight-relay-secret' }
const deferred = () => {
  let resolve
  const promise = new Promise((done) => { resolve = done })
  return { promise, resolve }
}

async function fixture({ developerToken = null, userToken = null, registrationStatus = 200, registrationGate = null, truncateRegistrationBody = false, invalidRegistrationJSON = null, currentAccount = 'developer@example.test' } = {}) {
  const state = { registrationStatus, truncateRegistrationBody, invalidRegistrationJSON, registrations: [], profiles: [], sessions: [], runtime: [], revocations: [] }
  const createStore = (token) => ({
    token, loads: 0, saves: [], clears: 0,
    async load() { this.loads++; return this.token },
    async save(value) { this.saves.push(value); this.token = value },
    async clear() { this.clears++; this.token = null },
  })
  const developerStore = createStore(developerToken)
  const userStore = createStore(userToken)
  const registrationStarted = deferred()
  const server = createServer(async (request, response) => {
    let body = ''
    for await (const chunk of request) body += chunk
    response.setHeader('Content-Type', 'application/json')
    if (request.url.endsWith('/local-development')) {
      state.registrations.push({ authorization: request.headers.authorization, body: JSON.parse(body) })
      registrationStarted.resolve()
      await registrationGate?.promise
      response.statusCode = state.registrationStatus
      response.setHeader('X-Request-ID', 'preflight-registration-1')
      if (state.invalidRegistrationJSON !== null) {
        if (state.invalidRegistrationJSON.startsWith('<')) response.setHeader('Content-Type', 'text/html')
        response.end(state.invalidRegistrationJSON)
        return
      }
      if (state.truncateRegistrationBody) {
        response.setHeader('Content-Length', '200')
        response.flushHeaders()
        response.write('{"data":')
        setTimeout(() => response.destroy(), 10)
        return
      }
      response.end(JSON.stringify(state.registrationStatus === 200
        ? { data: { id: 'app-1', slug: 'app.example.canvas' } }
        : { code: 'REGISTRATION_REJECTED', error: 'development registration rejected' }))
      return
    }
    if (request.method === 'GET' && request.url === '/api/portal/user/profile') {
      state.profiles.push(request.headers.authorization)
      response.end(JSON.stringify({ data: { email: currentAccount } }))
      return
    }
    if (request.url.endsWith('/sessions') && request.method === 'POST') {
      const index = state.sessions.length + 1
      state.sessions.push({ authorization: request.headers.authorization, body: JSON.parse(body) })
      response.end(JSON.stringify({ data: {
        session_id: 'session-' + index, access_token: 'ast-user-' + index,
        account_scope: 'acs_' + 'a'.repeat(64),
        gateway_url: baseURL, app_version: '0.1.0',
      } }))
      return
    }
    if (request.method === 'DELETE') {
      state.revocations.push({ authorization: request.headers.authorization, url: request.url })
      response.end(JSON.stringify({ data: {} }))
      return
    }
    state.runtime.push({ authorization: request.headers.authorization, url: request.url })
    response.end(JSON.stringify({ data: { id: 'ordinary-user' } }))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const baseURL = 'http://127.0.0.1:' + server.address().port
  const relay = await createLocalDevelopmentRelay({
    baseURL: baseURL + '/api', portalURL: baseURL, relaySecret: headers['X-Proxy-App-Relay'],
    appID: 'app-1', appSlug: 'app.example.canvas', version: '0.1.0',
    manifest: { id: 'app.example.canvas', version: '0.1.0' }, entryURL: 'http://127.0.0.1:5173/',
    credentialStore: userStore, developerCredentialStore: developerStore,
  })
  const get = async (path = '/__platform/auth/status', init = {}) => {
    const response = await fetch(relay.relayURL + path, { ...init, headers })
    return { status: response.status, body: await response.json() }
  }
  const callback = async (details, token) => {
    const response = await fetch(relay.relayURL + '/auth/callback', {
      method: 'POST', body: new URLSearchParams({ state: details.auth_state, access_token: token }),
    })
    return { status: response.status, body: await response.text() }
  }
  const beginPreparation = async (options = {}) => {
    const requested = deferred()
    const completion = relay.prepareDevelopment({ ...options, onAuthorizationRequired: (details) => requested.resolve(details) })
    completion.catch(() => undefined)
    return { completion, details: await Promise.race([requested.promise, completion.then(() => { throw new Error('preflight completed without requesting expected authorization') })]) }
  }
  const close = async () => {
    registrationGate?.resolve()
    await relay.close()
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
  }
  return { state, relay, developerStore, userStore, registrationStarted, get, callback, beginPreparation, close }
}

test('development preflight blocks login and model/runtime requests without touching platform or user credentials', { timeout: 5000 }, async () => {
  const f = await fixture({ userToken: 'cached-ordinary-user' })
  try {
    for (const path of ['/__platform/auth/status', '/__platform/auth/start', '/__platform/auth/start?force_login=1', '/__platform/auth/status', '/__platform/auth/start', '/v1/models', '/v1/models']) {
      const result = await f.get(path)
      assert.equal(result.status, 503, path)
      assert.equal(result.body.code, 'APP_DEVELOPMENT_NOT_READY', path)
      assert.doesNotMatch(JSON.stringify(result), /cached-ordinary-user/)
    }
    assert.equal(f.userStore.loads, 0)
    assert.equal(f.userStore.clears, 0)
    assert.equal(f.userStore.token, 'cached-ordinary-user')
    assert.deepEqual(f.state, { registrationStatus: 200, truncateRegistrationBody: false, invalidRegistrationJSON: null, registrations: [], profiles: [], sessions: [], runtime: [], revocations: [] })
  } finally { await f.close() }
})

test('explicit developer preflight registers once and never creates or restores a user session', { timeout: 5000 }, async () => {
  const f = await fixture({ userToken: 'cached-ordinary-user' })
  try {
    await f.relay.prepareDevelopment({ token: 'developer-token' })
    await f.relay.prepareDevelopment({ token: 'unused-second-developer-token' })
    assert.deepEqual(f.state.registrations, [{
      authorization: 'Bearer developer-token',
      body: { entry_url: 'http://127.0.0.1:5173/', manifest: { id: 'app.example.canvas', version: '0.1.0' } },
    }])
    assert.equal(f.state.sessions.length, 0)
    assert.equal(f.userStore.loads, 0)
    assert.deepEqual(f.userStore.saves, [])
    assert.equal(f.userStore.token, 'cached-ordinary-user')
    const status = await f.get()
    assert.equal(status.body.data.authenticated, true)
    assert.equal(f.state.sessions[0].authorization, 'Bearer cached-ordinary-user')
    assert.equal((await f.get('/v1/models')).status, 200)
    assert.equal(f.state.runtime[0].authorization, 'Bearer ast-user-1')
    assert.equal(f.state.registrations.length, 1)
    assert.doesNotMatch(JSON.stringify(status), /developer-token|cached-ordinary-user|ast-user-1/)
  } finally { await f.close() }
})

test('runtime stays blocked while registration is in flight and concurrent prepare calls share it', { timeout: 5000 }, async () => {
  const gate = deferred()
  const f = await fixture({ developerToken: 'cached-developer-token', registrationGate: gate })
  try {
    const first = f.relay.prepareDevelopment()
    const second = f.relay.prepareDevelopment()
    await f.registrationStarted.promise
    const blocked = await f.get()
    assert.equal(blocked.status, 503)
    assert.equal(blocked.body.code, 'APP_DEVELOPMENT_NOT_READY')
    assert.equal(f.state.sessions.length, 0)
    gate.resolve()
    await Promise.all([first, second])
    assert.equal(f.state.registrations.length, 1)
    assert.equal(f.developerStore.loads, 1)
    assert.equal((await f.get()).body.data.authenticated, false)
  } finally { await f.close() }
})

test('development authorization has its own callback state and cannot be replayed as user login', { timeout: 5000 }, async () => {
  const f = await fixture({ userToken: 'cached-ordinary-user' })
  try {
    const { completion, details } = await f.beginPreparation()
    assert.equal(details.relay_url, f.relay.relayURL)
    const query = new URLSearchParams(new URL(details.login_url).hash.split('?')[1])
    assert.equal(query.get('proxy_app_auth'), '1')
    assert.equal(query.get('proxy_app_state'), details.auth_state)
    assert.equal(query.get('proxy_app_relay'), f.relay.relayURL)
    assert.equal(query.get('proxy_app_force_login'), null)
    assert.equal(f.userStore.loads, 0)
    assert.equal((await f.callback({ auth_state: 'wrong-state' }, 'attacker-token')).status, 400)
    assert.equal(f.state.registrations.length, 0)
    const accepted = await f.callback(details, 'developer-browser-token')
    assert.equal(accepted.status, 200)
    assert.doesNotMatch(accepted.body, /developer-browser-token|cached-ordinary-user/)
    await completion
    assert.equal(f.developerStore.token, 'developer-browser-token')
    assert.equal(f.userStore.token, 'cached-ordinary-user')
    assert.deepEqual(f.userStore.saves, [])
    assert.equal(f.state.sessions.length, 0)
    assert.equal((await f.callback(details, 'replayed-token')).status, 400)
    assert.equal(f.state.registrations.length, 1)
    assert.equal(f.state.sessions.length, 0)
  } finally { await f.close() }
})

test('cached developer authorization is reused independently of the runtime account', { timeout: 5000 }, async () => {
  const f = await fixture({ developerToken: 'cached-developer-token' })
  try {
    await f.relay.prepareDevelopment({ onAuthorizationRequired: () => assert.fail('valid developer cache must not reopen login') })
    assert.equal(f.state.registrations[0].authorization, 'Bearer cached-developer-token')
    assert.equal((await f.get()).body.data.authenticated, false)
    for (const token of ['ordinary-user-one', 'ordinary-user-two']) {
      const start = await f.get('/__platform/auth/start?force_login=1')
      assert.equal(start.status, 200)
      assert.equal((await f.callback(start.body.data, token)).status, 200)
      assert.equal((await f.get('/v1/models')).status, 200)
      assert.equal((await f.get('/__platform/auth/logout', { method: 'POST' })).status, 200)
      assert.equal((await f.get()).body.data.authenticated, false)
    }
    assert.equal(f.state.registrations.length, 1)
    assert.deepEqual(f.state.sessions.map((session) => session.authorization), ['Bearer ordinary-user-one', 'Bearer ordinary-user-two'])
    assert.deepEqual(f.state.runtime.map((call) => call.authorization), ['Bearer ast-user-1', 'Bearer ast-user-2'])
    assert.equal(f.developerStore.token, 'cached-developer-token')
    assert.equal(f.developerStore.clears, 0)
    assert.equal(f.userStore.token, null)
  } finally { await f.close() }
})

for (const status of [401, 403, 404]) test('cached developer registration HTTP ' + status + ' automatically requests fresh creator authorization', { timeout: 5000 }, async () => {
  const f = await fixture({ developerToken: 'rejected-developer-token', userToken: 'ordinary-user-token', registrationStatus: status })
  try {
    const { completion, details } = await f.beginPreparation()
    assert.equal(f.developerStore.token, null)
    assert.equal(f.developerStore.clears, 1)
    assert.equal(f.userStore.token, 'ordinary-user-token')
    assert.equal(f.userStore.loads, 0)
    assert.equal(details.force_login, true)
    const query = new URLSearchParams(new URL(details.login_url).hash.split('?')[1])
    assert.equal(query.get('proxy_app_force_login'), '1')
    assert.equal((await f.get()).status, 503)
    f.state.registrationStatus = 200
    assert.equal((await f.callback(details, 'fresh-developer-token')).status, 200)
    await completion
    assert.equal(f.developerStore.token, 'fresh-developer-token')
    assert.equal(f.state.sessions.length, 0)
    assert.deepEqual(f.state.registrations.map((call) => call.authorization), ['Bearer rejected-developer-token', 'Bearer fresh-developer-token'])
  } finally { await f.close() }
})

test('manifest and service failures are reported by preflight and preserve developer credentials', { timeout: 10000 }, async (t) => {
  for (const status of [400, 409, 503]) await t.test('registration HTTP ' + status, async () => {
    const f = await fixture({ developerToken: 'cached-developer-token', userToken: 'ordinary-user-token', registrationStatus: status })
    try {
      await assert.rejects(f.relay.prepareDevelopment({ onAuthorizationRequired: () => assert.fail('registration errors are not a user login prompt') }), (error) => {
        assert.equal(error.code, 'APP_APP_REGISTRATION_FAILED')
        assert.equal(error.stage, 'app_registration')
        assert.equal(error.statusCode, status)
        assert.equal(error.requestId, 'preflight-registration-1')
        assert.equal(error.upstreamCode, 'REGISTRATION_REJECTED')
        assert.doesNotMatch(error.message, /cached-developer-token|ordinary-user-token/)
        return true
      })
      assert.equal(f.developerStore.token, 'cached-developer-token')
      assert.equal(f.developerStore.clears, 0)
      assert.equal(f.userStore.loads, 0)
      assert.equal(f.userStore.clears, 0)
      assert.equal(f.state.sessions.length, 0)
      assert.equal((await f.get()).status, 503)
      assert.equal(f.state.registrations.length, 1)
    } finally { await f.close() }
  })
})

test('HTTP 200 with HTML, an empty body or non-object JSON fails preflight before runtime can start', { timeout: 10000 }, async (t) => {
  const invalidResponses = [
    ['HTML page', '<!doctype html><html><body>private-upstream-message</body></html>'],
    ['empty body', ''],
    ['JSON primitive', 'true'],
    ['JSON null', 'null'],
    ['JSON array', '[]'],
  ]
  for (const [name, invalidRegistrationJSON] of invalidResponses) await t.test(name, async () => {
    const f = await fixture({ developerToken: 'cached-developer-token', userToken: 'ordinary-user-token', invalidRegistrationJSON })
    try {
      await assert.rejects(f.relay.prepareDevelopment(), (error) => {
        assert.equal(error.code, 'APP_PLATFORM_INVALID_RESPONSE')
        assert.equal(error.stage, 'app_registration')
        assert.equal(error.statusCode, 502)
        assert.equal(error.message, '平台返回了无效响应，请检查平台 API 地址及服务配置。')
        assert.doesNotMatch(error.message, /private-upstream-message|cached-developer-token|ordinary-user-token/)
        return true
      })
      for (const path of ['/__platform/auth/start', '/__platform/auth/status', '/v1/models', '/v1/models']) {
        const blocked = await f.get(path)
        assert.equal(blocked.status, 503, path)
        assert.equal(blocked.body.code, 'APP_DEVELOPMENT_NOT_READY', path)
      }
      assert.equal(f.state.registrations.length, 1)
      assert.equal(f.state.sessions.length, 0)
      assert.equal(f.state.runtime.length, 0)
      assert.equal(f.developerStore.token, 'cached-developer-token')
      assert.equal(f.developerStore.clears, 0)
      assert.equal(f.userStore.loads, 0)
      assert.equal(f.userStore.clears, 0)
    } finally { await f.close() }
  })
})

test('a truncated registration response cannot mark development ready and preserves retryable credentials', { timeout: 5000 }, async () => {
  const f = await fixture({ developerToken: 'cached-developer-token', truncateRegistrationBody: true })
  try {
    await assert.rejects(f.relay.prepareDevelopment(), { code: 'APP_PLATFORM_UNAVAILABLE', stage: 'app_registration', statusCode: 502 })
    assert.equal((await f.get()).status, 503)
    assert.equal(f.state.sessions.length, 0)
    assert.equal(f.developerStore.token, 'cached-developer-token')
    assert.equal(f.developerStore.clears, 0)
    assert.equal(f.userStore.loads, 0)
    f.state.truncateRegistrationBody = false
    await f.relay.prepareDevelopment()
    assert.equal((await f.get()).body.data.authenticated, false)
    assert.equal(f.state.registrations.length, 2)
  } finally { await f.close() }
})

test('browser development-registration failure identifies the signed-in account and platform', { timeout: 5000 }, async () => {
  const f = await fixture({ registrationStatus: 404, currentAccount: 'mail6@example.test' })
  try {
    const { completion, details } = await f.beginPreparation()
    const query = new URLSearchParams(new URL(details.login_url).hash.split('?')[1])
    assert.equal(query.get('proxy_app_force_login'), null)
    const failed = await f.callback(details, 'developer-browser-token')
    assert.equal(failed.status, 404)
    assert.match(failed.body, /开发环境检查失败/)
    assert.match(failed.body, /当前登录账户：mail6@example\.test/)
    assert.match(failed.body, /平台 API 地址：http:\/\/127\.0\.0\.1:\d+\/api/)
    assert.match(failed.body, /应用 slug：app\.example\.canvas/)
    assert.doesNotMatch(failed.body, /proxy-app (?:link|repair)|developer-browser-token|window\.close|proxy_app_force_login/)
    await assert.rejects(completion, {
      code: 'APP_APP_REGISTRATION_FAILED', stage: 'app_registration', statusCode: 404,
      requestId: 'preflight-registration-1', upstreamCode: 'REGISTRATION_REJECTED',
    })
    assert.equal((await f.callback(details, 'replayed-token')).status, 400)
    assert.equal((await f.get()).status, 503)
    assert.equal(f.state.sessions.length, 0)
    assert.deepEqual(f.state.registrations.map((call) => call.authorization), ['Bearer developer-browser-token'])
    assert.deepEqual(f.state.profiles, ['Bearer developer-browser-token'])
  } finally { await f.close() }
})

test('a fresh creator authorization failure stops preflight without another login loop', { timeout: 5000 }, async () => {
  const f = await fixture({ developerToken: 'wrong-developer-token', userToken: 'ordinary-user-token', registrationStatus: 404 })
  try {
    let prompts = 0
    const requested = deferred()
    const completion = f.relay.prepareDevelopment({ onAuthorizationRequired: (details) => { prompts++; requested.resolve(details) } })
    completion.catch(() => undefined)
    const details = await requested.promise
    assert.equal(details.force_login, true)
    const query = new URLSearchParams(new URL(details.login_url).hash.split('?')[1])
    assert.equal(query.get('proxy_app_force_login'), '1')
    assert.equal(f.state.registrations.length, 1)
    assert.equal((await f.callback(details, 'still-wrong-developer-token')).status, 404)
    await assert.rejects(completion, { code: 'APP_APP_REGISTRATION_FAILED', stage: 'app_registration', statusCode: 404 })
    assert.equal(prompts, 1)
    assert.deepEqual(f.state.registrations.map((call) => call.authorization), ['Bearer wrong-developer-token', 'Bearer still-wrong-developer-token'])
    assert.equal(f.developerStore.token, null)
    assert.equal(f.developerStore.clears, 1)
    assert.equal(f.userStore.token, 'ordinary-user-token')
    assert.equal(f.userStore.loads, 0)
    assert.equal((await f.get()).status, 503)
    assert.equal((await f.callback(details, 'replayed-token')).status, 400)
  } finally { await f.close() }
})

test('explicit management credentials fail directly and preserve unrelated cached authorization', { timeout: 10000 }, async (t) => {
  for (const status of [401, 403, 404]) await t.test('registration HTTP ' + status, async () => {
    const f = await fixture({ developerToken: 'cached-developer-token', userToken: 'ordinary-user-token', registrationStatus: status })
    try {
      await assert.rejects(f.relay.prepareDevelopment({ token: 'explicit-developer-token', onAuthorizationRequired: () => assert.fail('caller supplied credentials must not start an interactive login') }), { stage: 'app_registration', statusCode: status })
      assert.equal(f.developerStore.loads, 0)
      assert.equal(f.developerStore.clears, 0)
      assert.equal(f.developerStore.token, 'cached-developer-token')
      assert.equal(f.userStore.token, 'ordinary-user-token')
      assert.equal(f.userStore.loads, 0)
      assert.deepEqual(f.state.registrations.map((call) => call.authorization), ['Bearer explicit-developer-token'])
    } finally { await f.close() }
  })
})

test('aborting development authorization invalidates its callback and allows an explicit retry', { timeout: 5000 }, async () => {
  const f = await fixture()
  try {
    const controller = new AbortController()
    const { completion, details } = await f.beginPreparation({ signal: controller.signal })
    controller.abort()
    await assert.rejects(completion, { name: 'AbortError' })
    assert.notEqual((await f.callback(details, 'cancelled-developer-token')).status, 200)
    assert.equal(f.state.registrations.length, 0)
    assert.equal((await f.get()).status, 503)
    await f.relay.prepareDevelopment({ token: 'retry-developer-token' })
    assert.equal((await f.get()).body.data.authenticated, false)
    assert.equal(f.state.registrations.length, 1)
  } finally { await f.close() }
})

test('an already aborted preflight does not load credentials or contact the platform', { timeout: 5000 }, async () => {
  const f = await fixture({ developerToken: 'cached-developer-token', userToken: 'ordinary-user-token' })
  try {
    const controller = new AbortController()
    controller.abort()
    await assert.rejects(f.relay.prepareDevelopment({ signal: controller.signal, onAuthorizationRequired: () => assert.fail('cancelled startup must not request authorization') }), { name: 'AbortError' })
    assert.equal(f.developerStore.loads, 0)
    assert.equal(f.developerStore.clears, 0)
    assert.equal(f.userStore.loads, 0)
    assert.equal(f.state.registrations.length, 0)
    assert.equal(f.state.sessions.length, 0)
  } finally { await f.close() }
})

test('closing a relay rejects pending development authorization without creating sessions or clearing saved users', { timeout: 5000 }, async () => {
  const f = await fixture({ userToken: 'ordinary-user-token' })
  try {
    const { completion } = await f.beginPreparation()
    await f.relay.close()
    await assert.rejects(completion)
    assert.equal(f.state.registrations.length, 0)
    assert.equal(f.state.sessions.length, 0)
    assert.equal(f.userStore.token, 'ordinary-user-token')
    assert.equal(f.userStore.loads, 0)
    assert.equal(f.userStore.clears, 0)
  } finally { await f.close() }
})
