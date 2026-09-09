import assert from 'node:assert/strict'
import test from 'node:test'
import { createAppClient } from '../proxy-app-sdk/dist/index.js'

async function withBrowser(callback) {
  const previousWindow = globalThis.window
  const previousFetch = globalThis.fetch
  const listeners = []
  const browser = {
    location: { hostname: '127.0.0.1', origin: 'http://127.0.0.1:5173' },
    addEventListener(name) { listeners.push(name) },
    removeEventListener() {},
    setTimeout,
    clearTimeout,
    postMessage() { throw new Error('HTTP runtime must not use Bridge postMessage') },
  }
  browser.parent = browser
  globalThis.window = browser
  try { await callback(listeners) } finally {
    if (previousWindow === undefined) delete globalThis.window
    else globalThis.window = previousWindow
    globalThis.fetch = previousFetch
  }
}

const json = (data, status = 200, headers = {}) => new Response(JSON.stringify(data), {
  status, headers: { 'Content-Type': 'application/json', ...headers },
})

test('local SDK uses same-origin HTTP resources and never sends a Bridge envelope', async () => {
  await withBrowser(async (listeners) => {
    const calls = []
    globalThis.fetch = async (path, init = {}) => {
      calls.push({ path, ...init })
      if (path.endsWith('/profile')) return json({ data: { id: 'user-1' } })
      if (path.endsWith('/capabilities')) return json({ data: [] })
      if (path.includes('/preferences?kind=theme')) return json({ data: { mode: 'dark' } })
      if (path.includes('/preferences?kind=locale')) return json({ data: { locale: 'zh-CN' } })
      if (path === '/v1/models') return json({ data: [{ id: 'real-model' }] })
      return json({ data: init.method === 'GET' ? { draft: true } : { success: true } })
    }
    const app = createAppClient('app.example.design', { runtime: 'local', localAppVersion: '0.2.0' })
    try {
      assert.deepEqual(await app.user.getProfile(), { id: 'user-1' })
      assert.deepEqual(await app.platform.capabilities(), [])
      assert.deepEqual(await app.theme.read(), { mode: 'dark' })
      assert.deepEqual(await app.locale.read(), { locale: 'zh-CN' })
      assert.deepEqual(await app.storage.get('draft/a & b'), { draft: true })
      await app.storage.set('draft/a & b', { name: 'draft' })
      await app.storage.delete('draft/a & b')
      assert.deepEqual(await app.api.request('/models'), { data: [{ id: 'real-model' }] })
      assert.equal(listeners.includes('message'), false)
      assert.ok(calls.every(({ path }) => path.startsWith('/api/app-runtime/v1/') || path.startsWith('/v1/')))
      const writes = calls.filter(({ method }) => method === 'PUT' || method === 'DELETE')
      assert.equal(writes[0].path, '/api/app-runtime/v1/storage/items?key=draft%2Fa+%26+b')
      assert.equal(writes[0].body, JSON.stringify({ value: { name: 'draft' } }))
      assert.ok(writes.every(({ headers }) => headers.get('Idempotency-Key')))
      assert.ok(writes.every(({ headers }) => headers.get('X-App-Version') === '0.2.0'))
      assert.ok(calls.every(({ body }) => !body || !body.includes('proxy-app/v1')))
      const count = calls.length
      await assert.rejects(app.notification.show('notice'), { code: 'APP_RUNTIME_METHOD_NOT_SUPPORTED' })
      assert.equal(calls.length, count)
    } finally { app.destroy() }
  })
})

test('local SDK preserves non-login HTTP 401 errors and request IDs', async () => {
  await withBrowser(async () => {
    globalThis.fetch = async () => json({ error: { code: 'APP_TOKEN_INVALID', message: 'Session is invalid' } }, 401, { 'X-Request-ID': 'upstream-request' })
    const app = createAppClient('app.example.design', { runtime: 'local' })
    try {
      await assert.rejects(app.storage.get('draft'), { code: 'APP_TOKEN_INVALID', message: 'Session is invalid', status: 401, requestId: 'upstream-request' })
    } finally { app.destroy() }
  })
})

test('direct SDK authenticates runtime HTTP calls and refreshes once with stable write identity', async () => {
  await withBrowser(async (listeners) => {
    const session = { access_token: 'ast_test_1', token_type: 'Bearer', expires_in: 900, gateway_url: '/v1', app_id: 'app-1', app_slug: 'app.example.design', app_version: '0.2.0', scopes: ['storage.user'] }
    const calls = []
    globalThis.fetch = async (path, init) => {
      calls.push({ path, ...init })
      return calls.length === 1 ? json({ error: { code: 'APP_SESSION_EXPIRED', execution_started: false } }, 401) : json({ data: { success: true } })
    }
    let refreshes = 0
    const app = createAppClient('app.example.design', {
      runtime: 'direct', appSession: session, runtimeBasePath: '/api/app-runtime/v1',
      refreshAppSession: async () => { refreshes += 1; return { ...session, access_token: 'ast_test_2' } },
    })
    try {
      assert.deepEqual(await app.storage.set('draft', null), { success: true })
      assert.equal(refreshes, 1)
      assert.equal(calls[0].headers.get('Authorization'), 'Bearer ast_test_1')
      assert.equal(calls[1].headers.get('Authorization'), 'Bearer ast_test_2')
      assert.equal(calls[0].headers.get('Idempotency-Key'), calls[1].headers.get('Idempotency-Key'))
      assert.equal(calls[0].headers.get('X-Request-ID'), calls[1].headers.get('X-Request-ID'))
      assert.equal(listeners.includes('message'), false)
    } finally { app.destroy() }
  })
})

test('direct SDK only refreshes Gateway requests after an explicit pre-execution expiry', async () => {
  await withBrowser(async () => {
    const session = { access_token: 'ast_test_1', token_type: 'Bearer', expires_in: 900, gateway_url: '/v1', app_id: 'app-1', app_slug: 'app.example.design', app_version: '0.2.0', scopes: ['model.responses'] }
    const calls = []
    globalThis.fetch = async (path, init) => {
      calls.push({ path, ...init })
      return calls.length === 1
        ? json({ error: { auth_reason: 'APP_SESSION_EXPIRED', execution_started: false, message: 'expired before dispatch' } }, 401)
        : json({ data: { id: 'response-1' } })
    }
    let refreshes = 0
    const app = createAppClient('app.example.design', {
      runtime: 'direct', appSession: session,
      refreshAppSession: async () => { refreshes += 1; return { ...session, access_token: 'ast_test_2' } },
    })
    try {
      assert.deepEqual(await app.api.request('/responses', { method: 'POST', body: JSON.stringify({ input: 'hello' }) }), { data: { id: 'response-1' } })
      assert.equal(refreshes, 1)
      assert.equal(calls.length, 2)
      assert.equal(calls[0].headers.get('Idempotency-Key'), calls[1].headers.get('Idempotency-Key'))
    } finally { app.destroy() }
  })
})

test('direct SDK preserves provider 401 responses without refreshing or replaying', async () => {
  await withBrowser(async () => {
    const session = { access_token: 'ast_test_1', token_type: 'Bearer', expires_in: 900, gateway_url: '/v1', app_id: 'app-1', app_slug: 'app.example.design', app_version: '0.2.0', scopes: ['model.responses'] }
    let calls = 0
    globalThis.fetch = async () => {
      calls += 1
      return json({ error: { code: 'upstream_authentication_error', message: 'provider rejected credentials' } }, 401, { 'X-Request-ID': 'provider-request-1' })
    }
    let refreshes = 0
    const app = createAppClient('app.example.design', {
      runtime: 'direct', appSession: session,
      refreshAppSession: async () => { refreshes += 1; return { ...session, access_token: 'ast_test_2' } },
    })
    try {
      await assert.rejects(app.api.request('/responses', { method: 'POST', body: JSON.stringify({ input: 'hello' }) }), {
        code: 'upstream_authentication_error', message: 'provider rejected credentials', status: 401, requestId: 'provider-request-1',
      })
      assert.equal(refreshes, 0)
      assert.equal(calls, 1)
    } finally { app.destroy() }
  })
})
