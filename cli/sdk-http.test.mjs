import assert from 'node:assert/strict'
import test from 'node:test'
import { createAppClient } from '../proxy-app-sdk/dist/index.js'

const json = (data, status = 200, headers = {}) => new Response(JSON.stringify(data), {
  status,
  headers: { 'Content-Type': 'application/json', ...headers },
})

function makeSession(overrides = {}) {
  return {
    access_token: 'ast_user_1', token_type: 'Bearer', expires_in: 30 * 24 * 60 * 60,
    gateway_url: 'https://api.example.test/v1', app_id: 'app.example.canvas', app_slug: 'app.example.canvas',
    app_version: '1.0.0', account_scope: 'acs_' + 'a'.repeat(64), scopes: ['storage.user'], ...overrides,
  }
}

async function withWindow(callback) {
  const previousWindow = globalThis.window
  globalThis.window = {
    parent: {},
    location: { hostname: 'apps.example', origin: 'https://apps.example' },
    addEventListener() {},
    removeEventListener() {},
    setTimeout,
    clearTimeout,
  }
  try { return await callback() } finally {
    if (previousWindow === undefined) delete globalThis.window
    else globalThis.window = previousWindow
  }
}

test('top-level production documents infer the direct Gateway runtime', async () => {
  const previousWindow = globalThis.window
  const previousFetch = globalThis.fetch
  const calls = []
  const topLevel = {
    location: { hostname: 'apps.example', origin: 'https://apps.example' },
    addEventListener() {},
    removeEventListener() {},
    setTimeout,
    clearTimeout,
  }
  topLevel.parent = topLevel
  globalThis.window = topLevel
  globalThis.fetch = async (path, init) => {
    calls.push({ path: String(path), init })
    return json({ data: [{ id: 'model-1' }] })
  }
  try {
    const app = createAppClient('app.example.canvas')
    await assert.rejects(app.api.request('/models'), { code: 'APP_SESSION_UNAVAILABLE' })
    assert.equal(calls.length, 0)
    app.destroy()
  } finally {
    if (previousWindow === undefined) delete globalThis.window
    else globalThis.window = previousWindow
    if (previousFetch === undefined) delete globalThis.fetch
    else globalThis.fetch = previousFetch
  }
})

test('direct app API requests are sent only to the App Session Gateway', async () => {
  const previousFetch = globalThis.fetch
  const calls = []
  globalThis.fetch = async (path, init) => {
    calls.push({ path: String(path), init })
    return json({ data: [{ id: 'model-1' }] })
  }
  try {
    await withWindow(async () => {
      const app = createAppClient('app.example.canvas', { runtime: 'direct', appSession: makeSession() })
      const result = await app.api.request('/models')
      assert.deepEqual(result.data, [{ id: 'model-1' }])
      assert.equal(calls.length, 1)
      assert.equal(calls[0].path, 'https://api.example.test/v1/models')
      assert.equal(calls[0].init.headers.get('Authorization'), 'Bearer ast_user_1')
      assert.equal(calls[0].init.headers.get('X-App-Version'), '1.0.0')
      app.destroy()
    })
  } finally {
    if (previousFetch === undefined) delete globalThis.fetch
    else globalThis.fetch = previousFetch
  }
})

test('direct runtime without a Portal handoff fails closed without an Admin request', async () => {
  const previousFetch = globalThis.fetch
  let requests = 0
  globalThis.fetch = async () => {
    requests += 1
    return json({ data: [] })
  }
  try {
    await withWindow(async () => {
      const app = createAppClient('app.example.canvas', { runtime: 'direct' })
      await assert.rejects(app.api.request('/models'), { code: 'APP_SESSION_UNAVAILABLE' })
      await assert.rejects(app.platform.createSession(), { code: 'APP_SESSION_UNAVAILABLE' })
      assert.equal(requests, 0)
      app.destroy()
    })
  } finally {
    if (previousFetch === undefined) delete globalThis.fetch
    else globalThis.fetch = previousFetch
  }
})

test('direct runtime reads the authenticated user profile from Gateway', async () => {
  const previousFetch = globalThis.fetch
  const calls = []
  globalThis.fetch = async (path, init) => {
    calls.push({ path: String(path), init })
    return json({ object: 'profile', data: { id: 'user-1', email: 'person@example.test', username: 'person' } })
  }
  try {
    await withWindow(async () => {
      const app = createAppClient('app.example.canvas', { runtime: 'direct', appSession: makeSession() })
      assert.deepEqual(await app.user.getProfile(), { id: 'user-1', email: 'person@example.test', username: 'person' })
      assert.equal(calls.length, 1)
      assert.equal(calls[0].path, 'https://api.example.test/v1/profile')
      assert.equal(calls[0].init.headers.get('Authorization'), 'Bearer ast_user_1')
      app.destroy()
    })
  } finally {
    if (previousFetch === undefined) delete globalThis.fetch
    else globalThis.fetch = previousFetch
  }
})

test('voice design Gateway routes are available through the SDK allowlist', async () => {
  const previousFetch = globalThis.fetch
  const calls = []
  globalThis.fetch = async (path, init) => {
    calls.push({ path: String(path), init })
    return json({ ok: true })
  }
  try {
    await withWindow(async () => {
      const app = createAppClient('app.example.canvas', { runtime: 'direct', appSession: makeSession() })
      try {
        const routes = [
          ['/voice-design/models', 'GET'],
          ['/voice-design/generations', 'POST'],
          ['/voice-design/by-idempotency-key/voice-submit-1', 'GET'],
          ['/voice-design/tasks/task-1', 'GET'],
          ['/voice-design/tasks/task-1/content', 'GET'],
          ['/voice-design/tasks/task-1', 'DELETE'],
        ]
        for (const [path, method] of routes) await app.api.request(path, { method, ...(method === 'POST' ? { body: '{}' } : {}) })
        assert.deepEqual(calls.map(call => [new URL(call.path).pathname.replace(/^\/v1/, ''), call.init.method || 'GET']), routes)
        await assert.rejects(app.api.request('/voice-design/models', { method: 'POST', body: '{}' }), { code: 'APP_API_PATH_NOT_ALLOWED' })
        await assert.rejects(app.api.request('/voice-design/by-idempotency-key/voice-submit-1', { method: 'POST', body: '{}' }), { code: 'APP_API_PATH_NOT_ALLOWED' })
        await assert.rejects(app.api.request('/voice-design/tasks/task-1/content', { method: 'DELETE' }), { code: 'APP_API_PATH_NOT_ALLOWED' })
      } finally { app.destroy() }
    })
  } finally {
    if (previousFetch === undefined) delete globalThis.fetch
    else globalThis.fetch = previousFetch
  }
})

test('request tracing preserves binary and native media responses', async () => {
  const previousFetch = globalThis.fetch
  const bytes = new Uint8Array([82, 73, 70, 70, 16, 0, 0, 0, 87, 65, 86, 69])
  globalThis.fetch = async path => String(path).endsWith('/content')
    ? new Response(bytes, { headers: { 'Content-Type': 'audio/wav', 'X-Request-ID': 'media-trace' } })
    : json({ id: 'voice-task' }, 200, { 'X-Request-ID': 'metadata-trace' })
  try {
    await withWindow(async () => {
      const app = createAppClient('app.example.canvas', { runtime: 'direct', appSession: makeSession() })
      try {
        const path = '/voice-design/tasks/voice-task/content'
        for (const responseType of ['blob', 'auto']) {
          const blob = await app.api.request(path, { responseType })
          assert.ok(blob instanceof Blob)
          assert.equal(blob.type, 'audio/wav')
          assert.deepEqual(new Uint8Array(await blob.arrayBuffer()), bytes)
        }
        const buffer = await app.api.request(path, { responseType: 'arrayBuffer' })
        assert.ok(buffer instanceof ArrayBuffer)
        assert.deepEqual(new Uint8Array(buffer), bytes)
        const response = await app.api.request(path, { responseType: 'response' })
        assert.ok(response instanceof Response)
        assert.equal(response.headers.get('X-Request-ID'), 'media-trace')
        assert.deepEqual(new Uint8Array(await response.arrayBuffer()), bytes)
        assert.deepEqual(await app.api.request('/voice-design/tasks/voice-task'), { id: 'voice-task', request_id: 'metadata-trace' })
      } finally { app.destroy() }
    })
  } finally {
    if (previousFetch === undefined) delete globalThis.fetch
    else globalThis.fetch = previousFetch
  }
})

test('TTS Gateway routes are available through the SDK allowlist with narrow methods', async () => {
  const previousFetch = globalThis.fetch
  const calls = []
  globalThis.fetch = async (path, init) => {
    calls.push({ path: String(path), init })
    return json({ ok: true })
  }
  try {
    await withWindow(async () => {
      const app = createAppClient('app.example.canvas', { runtime: 'direct', appSession: makeSession() })
      try {
        const routes = [
          ['/tts/models', 'GET'],
          ['/tts/generations', 'POST'],
          ['/tts/by-idempotency-key/tts-submit-1', 'GET'],
          ['/tts/tasks/task-1', 'GET'],
          ['/tts/tasks/task-1/content', 'GET'],
          ['/tts/tasks/task-1', 'DELETE'],
        ]
        for (const [path, method] of routes) await app.api.request(path, { method, ...(method === 'POST' ? { body: '{}' } : {}) })
        assert.deepEqual(calls.map(call => [new URL(call.path).pathname.replace(/^\/v1/, ''), call.init.method || 'GET']), routes)
        await assert.rejects(app.api.request('/tts/models', { method: 'POST', body: '{}' }), { code: 'APP_API_PATH_NOT_ALLOWED' })
        await assert.rejects(app.api.request('/tts/by-idempotency-key/tts-submit-1', { method: 'POST', body: '{}' }), { code: 'APP_API_PATH_NOT_ALLOWED' })
        await assert.rejects(app.api.request('/tts/tasks/task-1/content', { method: 'DELETE' }), { code: 'APP_API_PATH_NOT_ALLOWED' })
      } finally { app.destroy() }
    })
  } finally {
    if (previousFetch === undefined) delete globalThis.fetch
    else globalThis.fetch = previousFetch
  }
})

test('music submission lookup is available through the SDK allowlist without write methods', async () => {
  const previousFetch = globalThis.fetch
  const calls = []
  globalThis.fetch = async (path, init) => {
    calls.push({ path: String(path), init })
    return json({ id: 'music-task-1', status: 'unknown' })
  }
  try {
    await withWindow(async () => {
      const app = createAppClient('app.example.canvas', { runtime: 'direct', appSession: makeSession() })
      try {
        const path = '/music/by-idempotency-key/canvas-music-submit-1'
        const result = await app.api.request(path)
        assert.deepEqual({ id: result.id, status: result.status }, { id: 'music-task-1', status: 'unknown' })
        assert.equal(calls[0].path, 'https://api.example.test/v1' + path)
        assert.equal(calls[0].init.method || 'GET', 'GET')
        await assert.rejects(app.api.request(path, { method: 'POST', body: '{}' }), { code: 'APP_API_PATH_NOT_ALLOWED' })
        await assert.rejects(app.api.request(path, { method: 'DELETE' }), { code: 'APP_API_PATH_NOT_ALLOWED' })
      } finally { app.destroy() }
    })
  } finally {
    if (previousFetch === undefined) delete globalThis.fetch
    else globalThis.fetch = previousFetch
  }
})

test('direct SDK keeps a valid short-lived session until expiry before refreshing it', async () => {
  const previousFetch = globalThis.fetch
  const previousNow = Date.now
  let now = 1_800_000_000_000
  let refreshes = 0
  globalThis.fetch = async () => json({ data: [{ id: 'model-1' }] })
  Date.now = () => now
  try {
    await withWindow(async () => {
      const app = createAppClient('app.example.canvas', {
        runtime: 'direct',
        appSession: makeSession({ expires_in: 3600 }),
        refreshAppSession: async () => {
          refreshes++
          return makeSession({ access_token: 'ast_user_2' })
        },
      })
      try {
        assert.equal((await app.auth.status()).authenticated, true)
        await app.api.request('/models')
        assert.equal(refreshes, 0, 'an active session must not depend on an early refresh')
        now += 3_600_000
        assert.equal((await app.auth.status()).authenticated, true)
        assert.equal(refreshes, 1, 'an expired session may use its configured refresh callback')
      } finally { app.destroy() }
    })
  } finally {
    Date.now = previousNow
    if (previousFetch === undefined) delete globalThis.fetch
    else globalThis.fetch = previousFetch
  }
})

test('API errors omit diagnostic URLs while preserving their request ID', async () => {
  const previousFetch = globalThis.fetch
  const requestId = '3074d4a6-6231-4b73-b8e4-a68739fe46b7'
  globalThis.fetch = async () => json({
    error: {
      code: 'UPSTREAM_ERROR',
      message: `unexpected status 502 Bad Gateway: 上游服务暂时不可用，请再次重试。, url: [http://localhost:9002/responses](http://localhost:9002/responses), request id: ${requestId}`,
      request_id: requestId,
    },
  }, 502)
  try {
    await withWindow(async () => {
      const app = createAppClient('app.example.canvas', { runtime: 'direct', appSession: makeSession() })
      let captured
      try {
        await assert.rejects(app.api.request('/responses', { method: 'POST', body: '{}' }), error => {
          captured = error
          return true
        })
        assert.doesNotMatch(captured.message, /url:|localhost:9002/i)
        assert.match(captured.message, new RegExp(`request id: ${requestId}`))
        assert.equal(captured.requestId, requestId)
      } finally { app.destroy() }
    })
  } finally {
    if (previousFetch === undefined) delete globalThis.fetch
    else globalThis.fetch = previousFetch
  }
})

test('fee estimates use only POST /estimates in direct, local and server runtimes', async t => {
  for (const runtime of ['direct', 'local', 'server']) {
    await t.test(runtime, async () => {
      const previousFetch = globalThis.fetch
      const calls = []
      const estimate = { estimated: true, known: false, amount: null, currency: 'USD', reason_code: 'pricing_unavailable' }
      globalThis.fetch = async (path, init) => {
        calls.push({ path: String(path), init })
        if (runtime === 'server' && String(path).endsWith('/session')) return json({ data: {
          app_id: 'app.example.canvas', app_slug: 'app.example.canvas', app_version: '1.0.0',
          account_scope: 'acs_' + 'a'.repeat(64), expires_in: 30 * 24 * 60 * 60,
        } })
        return json(estimate)
      }
      try {
        await withWindow(async () => {
          const app = createAppClient('app.example.canvas', { runtime, ...(runtime === 'direct' ? { appSession: makeSession() } : {}) })
          try {
            const body = JSON.stringify({ model: 'image-1', model_type: 'image', operation: 'generation', parameters: { n: 2, size: '1024x1024' } })
            const result = await app.api.request('/estimates', { method: 'POST', body })
            assert.deepEqual({ ...result, request_id: undefined }, { ...estimate, request_id: undefined })
            const request = calls.at(-1)
            assert.equal(request.path, runtime === 'direct' ? 'https://api.example.test/v1/estimates' : runtime === 'server' ? '/api/app-runtime/v1/gateway/estimates' : '/v1/estimates')
            assert.equal(request.init.method, 'POST')
            assert.equal(request.init.body, body)
            assert.equal(request.init.headers.get('Content-Type'), 'application/json')
            if (runtime === 'direct') assert.equal(request.init.headers.get('Authorization'), 'Bearer ast_user_1')
            if (runtime === 'server') {
              assert.equal(request.init.credentials, 'include')
              assert.equal(request.init.headers.has('Authorization'), false)
            }
            for (const [path, method] of [['/estimates', 'GET'], ['/estimates', 'DELETE'], ['/estimates/submit', 'POST'], ['/cost/estimate', 'POST']]) {
              await assert.rejects(app.api.request(path, { method }), { code: 'APP_API_PATH_NOT_ALLOWED' })
            }
            await assert.rejects((async () => {
              for await (const _event of app.api.stream('/estimates', { method: 'POST', body })) {}
            })(), { code: 'APP_API_PATH_NOT_ALLOWED' })
            assert.equal(calls.length, runtime === 'server' ? 2 : 1)
          } finally { app.destroy() }
        })
      } finally {
        if (previousFetch === undefined) delete globalThis.fetch
        else globalThis.fetch = previousFetch
      }
    })
  }
})

test('Electron estimate requests strip AbortSignal before IPC and discard cancelled results', async () => {
  await withWindow(async () => {
    const calls = []
    let resolveRequest
    const app = createAppClient('app.example.canvas', {
      runtime: 'electron',
      electronHost: { request: (path, init) => {
        assert.equal(Object.hasOwn(init, 'signal'), false)
        calls.push({ path, init })
        return new Promise(resolve => { resolveRequest = resolve })
      } },
    })
    try {
      const controller = new AbortController()
      controller.abort()
      await assert.rejects(app.api.request('/estimates', { method: 'POST', body: '{}', signal: controller.signal }), { name: 'AbortError' })
      assert.equal(calls.length, 0)
      const pendingController = new AbortController()
      const pending = app.api.request('/estimates', { method: 'POST', body: '{}', signal: pendingController.signal })
      assert.equal(calls.length, 1)
      assert.equal(calls[0].path, '/estimates')
      assert.equal(calls[0].init.body, '{}')
      pendingController.abort()
      await assert.rejects(pending, { name: 'AbortError' })
      resolveRequest({ estimated: true, known: true, amount: 1 })
      const current = app.api.request('/estimates', { method: 'POST', body: '{}' })
      resolveRequest({ estimated: true, known: true, amount: 0.1 })
      assert.deepEqual(await current, { estimated: true, known: true, amount: 0.1 })
      assert.equal(calls.length, 2)
    } finally { app.destroy() }
  })
})

test('server runtime uses the HttpOnly cookie and same-origin Gateway proxy', async () => {
  const previousFetch = globalThis.fetch
  const calls = []
  globalThis.fetch = async (path, init) => {
    calls.push({ path: String(path), init })
    if (String(path).endsWith('/session')) {
      return json({ data: {
        app_id: 'app.example.canvas', app_slug: 'app.example.canvas', app_version: '1.0.0',
        runtime_gateway_url: '/api/app-runtime/v1/gateway', account_scope: 'acs_' + 'a'.repeat(64), scopes: ['storage.user'],
      } })
    }
    return json({ data: [{ id: 'model-1' }] })
  }
  try {
    await withWindow(async () => {
      const app = createAppClient('app.example.canvas', { runtime: 'server' })
      assert.deepEqual(await app.auth.status(), { authenticated: true, accountScope: 'acs_' + 'a'.repeat(64) })
      const result = await app.api.request('/models')
      assert.deepEqual(result.data, [{ id: 'model-1' }])
      assert.equal(calls[0].path, '/api/app-runtime/v1/session')
      assert.equal(calls[1].path, '/api/app-runtime/v1/gateway/models')
      assert.equal(calls[1].init.credentials, 'include')
      assert.equal(calls[1].init.headers.has('Authorization'), false)
      assert.equal(new Headers(calls[0].init.headers).get('X-App-ID'), 'app.example.canvas')
      assert.equal(calls[1].init.headers.get('X-App-ID'), 'app.example.canvas')
      app.destroy()
    })
  } finally {
    if (previousFetch === undefined) delete globalThis.fetch
    else globalThis.fetch = previousFetch
  }
})

test('server runtime rotates the cookie session once after pre-execution expiry', async () => {
  const previousFetch = globalThis.fetch
  const calls = []
  let gatewayAttempts = 0
  globalThis.fetch = async (path, init) => {
    calls.push({ path: String(path), init })
    if (String(path).endsWith('/session')) return json({ data: {
      app_id: 'app.example.canvas', app_slug: 'app.example.canvas', app_version: '1.0.0',
      runtime_gateway_url: '/api/app-runtime/v1/gateway', account_scope: 'acs_' + 'a'.repeat(64), scopes: [],
    } })
    if (String(path).endsWith('/session/refresh')) return json({ data: {
      app_id: 'app.example.canvas', app_slug: 'app.example.canvas', app_version: '1.0.0',
      runtime_gateway_url: '/api/app-runtime/v1/gateway', account_scope: 'acs_' + 'a'.repeat(64), scopes: [],
    } })
    gatewayAttempts += 1
    if (gatewayAttempts === 1) return json({ error: { code: 'APP_SESSION_EXPIRED', execution_started: false } }, 401)
    return json({ data: [{ id: 'model-1' }] })
  }
  try {
    await withWindow(async () => {
      const app = createAppClient('app.example.canvas', { runtime: 'server' })
      await app.auth.status()
      const result = await app.api.request('/models')
      assert.deepEqual(result.data, [{ id: 'model-1' }])
      assert.equal(calls.filter(call => call.path.endsWith('/session/refresh')).length, 1)
      assert.equal(calls.find(call => call.path.endsWith('/session/refresh')).init.method, 'POST')
      app.destroy()
    })
  } finally {
    if (previousFetch === undefined) delete globalThis.fetch
    else globalThis.fetch = previousFetch
  }
})

test('KV writes use Gateway storage routes with idempotency and revision metadata', async () => {
  const previousFetch = globalThis.fetch
  const calls = []
  globalThis.fetch = async (path, init) => {
    calls.push({ path: String(path), init })
    return json({ data: { success: true, revision: 3 } })
  }
  try {
    await withWindow(async () => {
      const app = createAppClient('app.example.canvas', { runtime: 'direct', appSession: makeSession() })
      assert.deepEqual(await app.storage.set('draft', { ready: true }, { expectedRevision: 2, idempotencyKey: 'write-1' }), { success: true, revision: 3 })
      assert.equal(calls[0].path, 'https://api.example.test/v1/storage/items?key=draft')
      assert.equal(calls[0].init.headers.get('Idempotency-Key'), 'write-1')
      assert.equal(calls[0].init.headers.get('X-App-Version'), '1.0.0')
      assert.deepEqual(JSON.parse(calls[0].init.body), { value: { ready: true }, expected_revision: 2 })
      app.destroy()
    })
  } finally {
    if (previousFetch === undefined) delete globalThis.fetch
    else globalThis.fetch = previousFetch
  }
})

test('workspaceStorage uses the server-bound workspace KV routes without accepting a workspace id', async () => {
  const previousFetch = globalThis.fetch
  const calls = []
  globalThis.fetch = async (path, init) => {
    calls.push({ path: String(path), init })
    const url = new URL(String(path))
    if (url.pathname.endsWith('/keys')) return json({ data: { keys: ['team/draft'], next_cursor: '' } })
    if (url.searchParams.get('include_metadata') === 'true') return json({ data: {
      key: 'team/draft', value: { title: 'Team draft' }, revision: 4,
      updated_at: '2026-10-17T00:00:00Z', author: { id: 'user-1', name: 'Member' },
    } })
    if (init.method === 'POST') return json({ data: { results: [{ key: 'team/draft', success: true, revision: 5 }] } })
    if (init.method === 'PUT') return json({ data: { success: true, revision: 5 } })
    if (init.method === 'DELETE') return json({ data: { success: true } })
    return json({ data: { title: 'Team draft' } })
  }
  try {
    await withWindow(async () => {
      const app = createAppClient('app.example.canvas', { runtime: 'direct', appSession: makeSession() })
      try {
        assert.deepEqual(await app.workspaceStorage.get('team/draft'), { title: 'Team draft' })
        assert.deepEqual(await app.workspaceStorage.getEntry('team/draft'), {
          key: 'team/draft', value: { title: 'Team draft' }, revision: 4,
          updatedAt: '2026-10-17T00:00:00Z', author: { id: 'user-1', name: 'Member' },
        })
        assert.deepEqual(await app.workspaceStorage.list({ prefix: 'team/' }), { keys: ['team/draft'] })
        assert.deepEqual(await app.workspaceStorage.set('team/draft', { title: 'Updated' }, {
          expectedRevision: 4, idempotencyKey: 'team-write-1',
        }), { success: true, revision: 5 })
        assert.deepEqual(await app.workspaceStorage.batch([{ op: 'put', key: 'team/draft', value: { title: 'Batch' }, expectedRevision: 5 }], {
          idempotencyKey: 'team-batch-1',
        }), [{ key: 'team/draft', success: true, revision: 5 }])
        assert.deepEqual(await app.workspaceStorage.delete('team/draft', { expectedRevision: 5, idempotencyKey: 'team-delete-1' }), { success: true })
        assert.deepEqual(calls.map(call => [new URL(call.path).pathname, call.init.method || 'GET']), [
          ['/v1/storage/workspace/items', 'GET'],
          ['/v1/storage/workspace/items', 'GET'],
          ['/v1/storage/workspace/keys', 'GET'],
          ['/v1/storage/workspace/items', 'PUT'],
          ['/v1/storage/workspace/batch', 'POST'],
          ['/v1/storage/workspace/items', 'DELETE'],
        ])
        assert.equal(calls[3].init.headers.get('Idempotency-Key'), 'team-write-1')
        assert.deepEqual(JSON.parse(calls[3].init.body), { value: { title: 'Updated' }, expected_revision: 4 })
        assert.equal(calls[4].init.headers.get('Idempotency-Key'), 'team-batch-1')
        assert.equal(calls[5].init.headers.get('Idempotency-Key'), 'team-delete-1')
        assert.equal(calls.some(call => /workspace[_-]?id/i.test(call.path) || /workspace[_-]?id/i.test(call.init.body || '')), false)
        assert.deepEqual((await app.api.request('/storage/workspace/items?key=team%2Fraw', {
          method: 'PUT', body: JSON.stringify({ value: { workspace_id: 'application-data-is-not-a-scope' } }),
        })).data, { success: true, revision: 5 })
        await assert.rejects(app.call('storage.workspace.set', { key: 'x', value: 1, workspace_id: 'other-team' }), { code: 'APP_STORAGE_INVALID_REQUEST' })
        await assert.rejects(app.api.request('/storage/workspace/items?workspace_id=other-team'), { code: 'APP_API_PATH_NOT_ALLOWED' })
        await assert.rejects(app.api.request('/storage/workspace/items', {
          method: 'PUT', body: JSON.stringify({ value: 1, workspace_id: 'other-team' }),
        }), { code: 'APP_STORAGE_INVALID_REQUEST' })
        await assert.rejects(app.api.request('/storage/workspace/items?key=x', {
          method: 'PUT', headers: { 'X-Workspace-ID': 'other-team' }, body: JSON.stringify({ value: 1 }),
        }), { code: 'APP_STORAGE_INVALID_REQUEST' })
        assert.equal(calls.length, 7)
      } finally { app.destroy() }
    })
  } finally {
    if (previousFetch === undefined) delete globalThis.fetch
    else globalThis.fetch = previousFetch
  }
})

test('generic app API requests allow only the registered KV Gateway routes', async t => {
  for (const runtime of ['direct', 'local', 'server']) {
    await t.test(runtime, async () => {
      const previousFetch = globalThis.fetch
      const calls = []
      globalThis.fetch = async (path, init) => {
        calls.push({ path: String(path), init })
        if (runtime === 'server' && String(path).endsWith('/session')) return json({ data: {
          app_id: 'app.example.canvas', app_slug: 'app.example.canvas', app_version: '1.0.0',
          runtime_gateway_url: '/api/app-runtime/v1/gateway', account_scope: 'acs_' + 'a'.repeat(64),
          expires_in: 30 * 24 * 60 * 60,
        } })
        return json({ data: { ok: true } })
      }
      try {
        await withWindow(async () => {
          const app = createAppClient('app.example.canvas', { runtime, ...(runtime === 'direct' ? { appSession: makeSession() } : {}) })
          try {
            const routes = [
              ['/storage/items?key=draft', 'GET'],
              ['/storage/items?key=draft', 'PUT'],
              ['/storage/items?key=draft', 'DELETE'],
              ['/storage/keys?prefix=draft%2F', 'GET'],
              ['/storage/batch', 'POST'],
              ['/storage/workspace/items?key=draft', 'GET'],
              ['/storage/workspace/items?key=draft', 'PUT'],
              ['/storage/workspace/items?key=draft', 'DELETE'],
              ['/storage/workspace/keys?prefix=draft%2F', 'GET'],
              ['/storage/workspace/batch', 'POST'],
            ]
            for (const [path, method] of routes) await app.api.request(path, { method, ...(method === 'PUT' ? { body: JSON.stringify({ value: 1 }) } : method === 'POST' ? { body: JSON.stringify({ operations: [] }) } : {}) })
            const gatewayCalls = calls.filter(call => call.path.includes('/gateway/') || call.path.includes('/v1/storage/'))
            assert.deepEqual(gatewayCalls.map(call => [
              new URL(call.path, 'https://app.example.test').pathname
                .replace(/^\/v1/, '')
                .replace(/^\/api\/app-runtime\/v1\/gateway/, ''),
              call.init.method || 'GET',
            ]), routes.map(([path, method]) => [path.split('?')[0], method]))
            assert.equal(gatewayCalls.length, 10)
            assert.deepEqual(JSON.parse(gatewayCalls[1].init.body), { value: 1 })
            for (const call of gatewayCalls) {
              if (runtime === 'direct') assert.equal(call.init.headers.get('Authorization'), 'Bearer ast_user_1')
              if (runtime === 'server') {
                assert.equal(call.init.credentials, 'include')
                assert.equal(call.init.headers.has('Authorization'), false)
              }
            }
            await assert.rejects(app.api.request('/storage/items/other', { method: 'GET' }), { code: 'APP_API_PATH_NOT_ALLOWED' })
            await assert.rejects(app.api.request('/storage/keys', { method: 'POST', body: '{}' }), { code: 'APP_API_PATH_NOT_ALLOWED' })
            await assert.rejects(app.api.request('/storage/items', { method: 'PATCH', body: '{}' }), { code: 'APP_API_PATH_NOT_ALLOWED' })
            await assert.rejects(app.api.request('/storage/batch'), { code: 'APP_API_PATH_NOT_ALLOWED' })
            await assert.rejects(app.api.request('/storage/../models'), { code: 'APP_API_PATH_NOT_ALLOWED' })
            await assert.rejects((async () => {
              for await (const _event of app.api.stream('/storage/batch', { method: 'POST', body: '{}' })) {}
            })(), { code: 'APP_API_PATH_NOT_ALLOWED' })
            assert.equal(calls.length, runtime === 'server' ? 11 : 10)
          } finally { app.destroy() }
        })
      } finally {
        if (previousFetch === undefined) delete globalThis.fetch
        else globalThis.fetch = previousFetch
      }
    })
  }
})

test('control-plane methods and retired transport paths are rejected before dispatch', async () => {
  const previousFetch = globalThis.fetch
  let requests = 0
  globalThis.fetch = async () => { requests += 1; return json({ data: {} }) }
  try {
    await withWindow(async () => {
      const app = createAppClient('app.example.canvas', { runtime: 'direct', appSession: makeSession() })
      assert.deepEqual(await app.user.getProfile(), {})
      await assert.rejects(app.platform.capabilities(), { code: 'APP_RUNTIME_METHOD_NOT_SUPPORTED' })
      for (const path of ['/api/app-runtime/v1/profile', '/bridge', '/v2/models']) {
        await assert.rejects(app.api.request(path), { code: 'APP_API_PATH_NOT_ALLOWED' })
      }
      assert.equal(requests, 1)
      app.destroy()
    })
  } finally {
    if (previousFetch === undefined) delete globalThis.fetch
    else globalThis.fetch = previousFetch
  }
})

test('App Sessions cannot point to Admin, Portal, or legacy Runtime URLs', async () => {
  await withWindow(async () => {
    for (const gateway_url of [
      '/api/app-runtime/v1', '/bridge', 'https://admin-go.example.test/v1',
      'https://www.example.test/v1', 'https://api.example.test/storage',
    ]) {
      assert.throws(() => createAppClient('app.example.canvas', {
        runtime: 'direct', appSession: makeSession({ gateway_url }),
      }), { code: 'APP_GATEWAY_URL_INVALID' }, gateway_url)
    }
  })
})

test('Gateway session expiry refreshes once before execution and keeps the request on Gateway', async () => {
  const previousFetch = globalThis.fetch
  const calls = []
  let attempts = 0
  globalThis.fetch = async (path, init) => {
    calls.push({ path: String(path), init })
    attempts += 1
    if (attempts === 1) return json({ error: { auth_reason: 'APP_SESSION_EXPIRED', execution_started: false } }, 401)
    return json({ data: { id: 'model-1' } })
  }
  try {
    await withWindow(async () => {
      const app = createAppClient('app.example.canvas', {
        runtime: 'direct', appSession: makeSession(),
        refreshAppSession: async () => makeSession({ access_token: 'ast_user_2' }),
      })
      const result = await app.api.request('/models')
      assert.deepEqual(result.data, { id: 'model-1' })
      assert.equal(calls.length, 2)
      assert.equal(calls[0].path, calls[1].path)
      assert.equal(calls[1].init.headers.get('Authorization'), 'Bearer ast_user_2')
      app.destroy()
    })
  } finally {
    if (previousFetch === undefined) delete globalThis.fetch
    else globalThis.fetch = previousFetch
  }
})

test('local development uses /v1 for data and the dedicated auth relay for login state', async () => {
  const previousFetch = globalThis.fetch
  const calls = []
  globalThis.fetch = async (path, init) => {
    calls.push({ path: String(path), init })
    if (String(path).startsWith('/__platform/auth/')) return json({ data: { authenticated: false } })
    return json({ data: [{ id: 'model-1' }] })
  }
  try {
    await withWindow(async () => {
      const app = createAppClient('app.example.canvas', { runtime: 'local', localGatewayPath: '/v1' })
      const result = await app.api.request('/models')
      assert.deepEqual(result.data, [{ id: 'model-1' }])
      assert.deepEqual(await app.auth.status(), { authenticated: false })
      assert.equal(calls[0].path, '/v1/models')
      assert.equal(calls[1].path, '/__platform/auth/status')
      assert.equal(calls.some(call => call.path.includes('/api/app-runtime') || call.path.includes('/bridge')), false)
      app.destroy()
    })
  } finally {
    if (previousFetch === undefined) delete globalThis.fetch
    else globalThis.fetch = previousFetch
  }
})

test('local development reads the signed-in profile through the relay', async () => {
  const previousFetch = globalThis.fetch
  const calls = []
  globalThis.fetch = async (path, init) => {
    calls.push({ path: String(path), init })
    if (String(path) === '/__platform/auth/profile') return json({ data: { id: 'user-1', username: 'Pelican creator' } })
    return json({ data: { authenticated: true } })
  }
  try {
    await withWindow(async () => {
      const app = createAppClient('app.example.canvas', { runtime: 'local', localGatewayPath: '/v1' })
      assert.deepEqual(await app.user.getProfile(), { id: 'user-1', username: 'Pelican creator' })
      assert.equal(calls[0].path, '/__platform/auth/profile')
      app.destroy()
    })
  } finally {
    if (previousFetch === undefined) delete globalThis.fetch
    else globalThis.fetch = previousFetch
  }
})

test('storage input validation occurs before any Gateway request', async () => {
  const previousFetch = globalThis.fetch
  let requests = 0
  globalThis.fetch = async () => { requests += 1; return json({ data: {} }) }
  try {
    await withWindow(async () => {
      const app = createAppClient('app.example.canvas', { runtime: 'direct', appSession: makeSession() })
      await assert.rejects(app.storage.set('', 1), { code: 'APP_STORAGE_INVALID_KEY' })
      await assert.rejects(app.storage.delete('draft', { expectedRevision: 0 }), { code: 'APP_STORAGE_INVALID_REVISION' })
      await assert.rejects(app.storage.batch([]), { code: 'APP_STORAGE_INVALID_OPERATION' })
      assert.equal(requests, 0)
      app.destroy()
    })
  } finally {
    if (previousFetch === undefined) delete globalThis.fetch
    else globalThis.fetch = previousFetch
  }
})
