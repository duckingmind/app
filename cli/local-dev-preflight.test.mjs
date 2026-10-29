import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import test from 'node:test'
import { createLocalDevelopmentRelay } from './local-dev-relay.mjs'

const deferred = () => {
  let resolve
  const promise = new Promise(done => { resolve = done })
  return { promise, resolve }
}

function credentialStore(token = null) {
  return {
    token,
    loads: 0,
    saves: [],
    clears: 0,
    async load() { this.loads++; return this.token },
    async save(value) { this.saves.push(value); this.token = value },
    async clear() { this.clears++; this.token = null },
  }
}

async function body(request) {
  const chunks = []
  for await (const chunk of request) chunks.push(chunk)
  return Buffer.concat(chunks)
}

async function fixture(t, { developerToken = 'developer-token', registrationStatus = 200, registrationGate } = {}) {
  const state = { registrations: [], sessions: [], users: [] }
  const developer = credentialStore(developerToken)
  const platform = createServer(async (request, response) => {
    const raw = await body(request)
    response.setHeader('Content-Type', 'application/json')
    if (request.method === 'POST' && request.url === '/api/portal/user/app-workspace/by-slug/pelican/local-development') {
      state.registrations.push({ authorization: request.headers.authorization, body: JSON.parse(raw.toString() || '{}') })
      await registrationGate?.promise
      response.statusCode = registrationStatus
      response.end(JSON.stringify(registrationStatus === 200
        ? { data: { id: 'app-1', slug: 'pelican', local_development_grant: 'development-preview-grant-0123456789' } }
        : { code: 'APP_DEVELOPMENT_REJECTED', error: 'registration failed' }))
      return
    }
    if (request.url.includes('/sessions')) state.sessions.push(request.url)
    state.users.push(request.url)
    response.statusCode = 404
    response.end(JSON.stringify({ code: 'not_found' }))
  })
  await new Promise(resolve => platform.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${platform.address().port}`
  const relay = await createLocalDevelopmentRelay({
    baseURL: origin + '/api', portalURL: origin, appID: 'app-1', appSlug: 'pelican', version: '0.3.6',
    manifest: { id: 'pelican', version: '0.3.6' },
    functionFiles: [{ path: 'runtime/task.mjs', source: 'export default async () => ({ ok: true })' }],
    entryURL: 'http://127.0.0.1:5173/', developerCredentialStore: developer,
  })
  t.after(async () => {
    await relay.close()
    platform.closeAllConnections()
    await new Promise(resolve => platform.close(resolve))
  })
  const request = (path, init = {}) => fetch(relay.relayURL + path, init)
  return { relay, state, developer, request }
}

test('developer preflight registers the draft and does not expose runtime session endpoints', async t => {
  const f = await fixture(t)
  await f.relay.prepareDevelopment()
  assert.equal(f.state.registrations.length, 1)
  assert.equal(f.state.registrations[0].authorization, 'Bearer developer-token')
  assert.deepEqual(f.state.registrations[0].body.function_files, [{ path: 'runtime/task.mjs', source: 'export default async () => ({ ok: true })' }])
  assert.deepEqual(f.state.sessions, [])
  assert.equal(f.developer.loads, 1)

  const health = await f.request('/health').then(response => response.json())
  assert.equal(health.development_ready, true)
  for (const path of ['/auth/start', '/auth/status', '/auth/refresh', '/auth/logout']) {
    assert.equal((await f.request(path)).status, 404, path)
  }
})

test('first-time developer authorization has a one-time state callback', async t => {
  const f = await fixture(t, { developerToken: null })
  let authorization
  const prepared = f.relay.prepareDevelopment({ onAuthorizationRequired: details => { authorization = details } })
  while (!authorization) await new Promise(resolve => setTimeout(resolve, 1))
  const query = new URLSearchParams(new URL(authorization.login_url).hash.split('?')[1])
  assert.equal(query.get('proxy_app_auth'), '1')
  assert.equal(query.get('proxy_app_state'), authorization.auth_state)
  assert.equal(query.get('proxy_app_force_login'), '1')
  assert.equal(f.state.registrations.length, 0)

  const callback = await f.request('/auth/callback', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ state: authorization.auth_state, access_token: 'new-developer-token' }),
  })
  const html = await callback.text()
  assert.equal(callback.status, 200)
  assert.doesNotMatch(html, /new-developer-token/)
  await prepared
  assert.equal(f.developer.token, 'new-developer-token')
  assert.equal(f.state.registrations[0].authorization, 'Bearer new-developer-token')
  assert.deepEqual(f.state.sessions, [])
})

test('registration failure blocks development and preserves cached developer credentials', async t => {
  const f = await fixture(t, { registrationStatus: 503 })
  await assert.rejects(f.relay.prepareDevelopment(), { code: 'APP_APP_REGISTRATION_FAILED', stage: 'app_registration', statusCode: 503 })
  assert.equal(f.developer.token, 'developer-token')
  assert.equal(f.developer.clears, 0)
  assert.equal((await f.request('/health').then(response => response.json())).development_ready, false)
  assert.equal(f.state.registrations.length, 1)
  assert.deepEqual(f.state.sessions, [])
})

test('an in-flight developer registration can be cancelled before Vite starts', async t => {
  const gate = deferred()
  const f = await fixture(t, { registrationGate: gate })
  const controller = new AbortController()
  const pending = f.relay.prepareDevelopment({ signal: controller.signal })
  await new Promise(resolve => setTimeout(resolve, 10))
  controller.abort()
  await assert.rejects(pending)
  gate.resolve()
  assert.deepEqual(f.state.sessions, [])
})
