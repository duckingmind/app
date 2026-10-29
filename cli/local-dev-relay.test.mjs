import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import test from 'node:test'
import { createLocalDevelopmentRelay } from './local-dev-relay.mjs'

function store(token = null) {
  return {
    token,
    loads: 0,
    saves: [],
    clears: 0,
    async load() { this.loads += 1; return this.token },
    async save(value) { this.saves.push(value); this.token = value },
    async clear() { this.clears += 1; this.token = null },
  }
}

async function body(request) {
  const chunks = []
  for await (const chunk of request) chunks.push(chunk)
  return Buffer.concat(chunks)
}

async function fixture(t, {
  developerToken = 'developer-token',
  registrationStatus = 200,
  registrationGrant = 'development-preview-grant-0123456789',
  registrationContentType = 'application/json',
  registrationResponseBody,
  requestId = '',
} = {}) {
  const calls = []
  const platform = createServer(async (request, response) => {
    const raw = await body(request)
    calls.push({ method: request.method, url: request.url, authorization: request.headers.authorization, body: raw })
    response.setHeader('Content-Type', registrationContentType)
    if (request.method === 'POST' && request.url === '/api/portal/user/app-workspace/by-slug/pelican/local-development') {
      response.statusCode = registrationStatus
      if (requestId) response.setHeader('x-request-id', requestId)
      response.end(registrationResponseBody ?? JSON.stringify(registrationStatus === 200
        ? { data: { id: 'app-1', slug: 'pelican', ...(registrationGrant ? { local_development_grant: registrationGrant } : {}) } }
        : { code: 'APP_DEVELOPMENT_REJECTED', error: 'registration failed' }))
      return
    }
    response.statusCode = 404
    response.end(JSON.stringify({ code: 'not_found' }))
  })
  await new Promise(resolve => platform.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${platform.address().port}`
  const developer = store(developerToken)
  const relay = await createLocalDevelopmentRelay({
    baseURL: origin + '/api',
    portalURL: origin,
    appID: 'app-1',
    appSlug: 'pelican',
    version: '0.3.6',
    manifest: { id: 'pelican', version: '0.3.6' },
    functionFiles: [{ path: 'runtime/task.mjs', source: 'export default async () => ({ ok: true })' }],
    entryURL: 'http://127.0.0.1:5173/',
    developerCredentialStore: developer,
  })
  t.after(async () => {
    await relay.close()
    await new Promise(resolve => platform.close(resolve))
  })
  return { relay, calls, developer, platformOrigin: origin, request: (path, init) => fetch(relay.relayURL + path, init) }
}

test('developer preflight registers the draft and exposes no runtime auth routes', async t => {
  const f = await fixture(t)
  await f.relay.prepareDevelopment()
  assert.equal(f.developer.loads, 1)
  assert.equal(f.calls.length, 1)
  assert.equal(f.calls[0].authorization, 'Bearer developer-token')
  assert.deepEqual(JSON.parse(f.calls[0].body), {
    entry_url: 'http://127.0.0.1:5173/',
    manifest: { id: 'pelican', version: '0.3.6' },
    function_files: [{ path: 'runtime/task.mjs', source: 'export default async () => ({ ok: true })' }],
  })
  const health = await f.request('/health').then(response => response.json())
  assert.deepEqual(health, { ok: true, development_ready: true, app_id: 'app-1', app_slug: 'pelican', app_version: '0.3.6' })
  for (const path of ['/auth/start', '/auth/status', '/auth/refresh', '/auth/logout', '/v1/models', '/bridge']) {
    const response = await f.request(path)
    assert.equal(response.status, 404, path)
  }
})

test('first-time developer authorization uses a one-time callback and never returns the token in HTML', async t => {
  const f = await fixture(t, { developerToken: null })
  let authorization
  const prepared = f.relay.prepareDevelopment({ onAuthorizationRequired: details => { authorization = details } })
  while (!authorization) await new Promise(resolve => setTimeout(resolve, 1))
  const login = new URL(authorization.login_url)
  assert.equal(login.origin, f.platformOrigin)
  const query = new URLSearchParams(login.hash.slice('#/login?'.length))
  assert.equal(query.get('proxy_app_auth'), '1')
  assert.equal(query.get('proxy_app_state'), authorization.auth_state)
  assert.equal(query.get('proxy_app_force_login'), '1', 'first developer authorization must not silently reuse the Portal account')
  const callback = await f.request('/auth/callback', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ state: authorization.auth_state, access_token: 'new-developer-token' }),
  })
  const html = await callback.text()
  assert.equal(callback.status, 200)
  assert.doesNotMatch(html, /new-developer-token/)
  await prepared
  assert.equal(f.developer.token, 'new-developer-token')
  assert.equal(f.calls.at(-1).authorization, 'Bearer new-developer-token')
})

test('callback rejects a stale state and does not contact the platform', async t => {
  const f = await fixture(t, { developerToken: null })
  let authorization
  const prepared = f.relay.prepareDevelopment({ onAuthorizationRequired: details => { authorization = details } })
  while (!authorization) await new Promise(resolve => setTimeout(resolve, 1))
  const callback = await f.request('/auth/callback', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ state: 'wrong-state', access_token: 'must-not-be-used' }),
  })
  assert.equal(callback.status, 400)
  assert.equal(f.calls.length, 0)
  await f.relay.close()
  await assert.rejects(prepared, { name: 'AbortError' })
})

test('registration failure blocks startup and preserves the cached developer credential', async t => {
  const f = await fixture(t, { registrationStatus: 503 })
  await assert.rejects(f.relay.prepareDevelopment(), { code: 'APP_APP_REGISTRATION_FAILED', stage: 'app_registration', statusCode: 503 })
  assert.equal(f.developer.token, 'developer-token')
  assert.equal(f.developer.clears, 0)
  assert.equal((await f.request('/health').then(response => response.json())).development_ready, false)
})

test('registration without a local preview grant blocks startup', async t => {
  const f = await fixture(t, { registrationGrant: '' })
  await assert.rejects(f.relay.prepareDevelopment(), { code: 'APP_PLATFORM_INVALID_RESPONSE', stage: 'app_registration' })
  assert.equal((await f.request('/health').then(response => response.json())).development_ready, false)
})

test('non-JSON platform errors preserve the HTTP status and request ID', async t => {
  const f = await fixture(t, {
    registrationStatus: 502,
    registrationContentType: 'text/html; charset=utf-8',
    registrationResponseBody: '<html>upstream unavailable</html>',
    requestId: 'platform-request-502',
  })
  await assert.rejects(f.relay.prepareDevelopment(), {
    code: 'APP_PLATFORM_INVALID_RESPONSE',
    stage: 'app_registration',
    statusCode: 502,
    requestId: 'platform-request-502',
  })
  assert.equal((await f.request('/health').then(response => response.json())).development_ready, false)
})
