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

test('direct runtime without a browser App Session fails closed without an Admin request', async () => {
  const previousFetch = globalThis.fetch
  const previousSessionStorage = globalThis.sessionStorage
  globalThis.sessionStorage = {
    getItem: () => null,
    setItem() {},
    removeItem() {},
    length: 0,
    key: () => null,
  }
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
    if (previousSessionStorage === undefined) delete globalThis.sessionStorage
    else globalThis.sessionStorage = previousSessionStorage
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
          ['/voice-design/tasks/task-1', 'DELETE'],
        ]
        for (const [path, method] of routes) await app.api.request(path, { method, ...(method === 'POST' ? { body: '{}' } : {}) })
        assert.deepEqual(calls.map(call => [new URL(call.path).pathname.replace(/^\/v1/, ''), call.init.method || 'GET']), routes)
        await assert.rejects(app.api.request('/voice-design/models', { method: 'POST', body: '{}' }), { code: 'APP_API_PATH_NOT_ALLOWED' })
        await assert.rejects(app.api.request('/voice-design/by-idempotency-key/voice-submit-1', { method: 'POST', body: '{}' }), { code: 'APP_API_PATH_NOT_ALLOWED' })
        await assert.rejects(app.api.request('/voice-design/tasks/task-1/content', { method: 'GET' }), { code: 'APP_API_PATH_NOT_ALLOWED' })
        await assert.rejects(app.api.request('/voice-design/tasks/task-1/content', { method: 'DELETE' }), { code: 'APP_API_PATH_NOT_ALLOWED' })
      } finally { app.destroy() }
    })
  } finally {
    if (previousFetch === undefined) delete globalThis.fetch
    else globalThis.fetch = previousFetch
  }
})

test('retired media content, TTS, and embeddings routes are rejected before dispatch', async () => {
  const previousFetch = globalThis.fetch
  let requests = 0
  globalThis.fetch = async () => { requests += 1; return json({ ok: true }) }
  try {
    await withWindow(async () => {
      const app = createAppClient('app.example.canvas', { runtime: 'direct', appSession: makeSession() })
      try {
        for (const [path, method] of [
          ['/embeddings', 'POST'],
          ['/tts/models', 'GET'],
          ['/tts/generations', 'POST'],
          ['/tts/by-idempotency-key/tts-submit-1', 'GET'],
          ['/tts/tasks/task-1', 'GET'],
          ['/tts/tasks/task-1/content', 'GET'],
          ['/tts/tasks/task-1', 'DELETE'],
          ['/videos/task-1/content', 'GET'],
          ['/music/tasks/task-1/content', 'GET'],
          ['/voice-design/tasks/task-1/content', 'GET'],
        ]) {
          await assert.rejects(app.api.request(path, { method, ...(method === 'POST' ? { body: '{}' } : {}) }), { code: 'APP_API_PATH_NOT_ALLOWED' })
        }
        assert.equal(requests, 0)
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
        // Status validates the current Gateway session. Rotation happens only
        // when the next business request needs an expired bearer.
        await app.api.request('/models')
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

test('fee estimates use only POST /estimates and route every browser runtime to Gateway', async t => {
  for (const runtime of ['direct', 'local', 'server']) {
    await t.test(runtime, async () => {
      const previousFetch = globalThis.fetch
      const calls = []
      const estimate = { estimated: true, known: false, amount: null, currency: 'USD', reason_code: 'pricing_unavailable' }
      globalThis.fetch = async (path, init) => {
        calls.push({ path: String(path), init })
        return json(estimate, 200, { 'X-Proxy-App-Dev': '1' })
      }
      try {
        await withWindow(async () => {
          const app = createAppClient('app.example.canvas', {
            runtime,
            appSession: makeSession(runtime === 'local' ? { gateway_url: '/v1' } : {}),
          })
          try {
            const body = JSON.stringify({ model: 'image-1', model_type: 'image', operation: 'generation', parameters: { n: 2, size: '1024x1024' } })
            const result = await app.api.request('/estimates', { method: 'POST', body })
            assert.deepEqual({ ...result, request_id: undefined }, { ...estimate, request_id: undefined })
            const request = calls.at(-1)
            assert.equal(request.path, ['direct', 'server'].includes(runtime) ? 'https://api.example.test/v1/estimates' : '/v1/estimates')
            assert.equal(request.init.method, 'POST')
            assert.equal(request.init.body, body)
            assert.equal(request.init.headers.get('Content-Type'), 'application/json')
            assert.equal(request.init.headers.get('Authorization'), 'Bearer ast_user_1')
            for (const [path, method] of [['/estimates', 'GET'], ['/estimates', 'DELETE'], ['/estimates/submit', 'POST'], ['/cost/estimate', 'POST']]) {
              await assert.rejects(app.api.request(path, { method }), { code: 'APP_API_PATH_NOT_ALLOWED' })
            }
            await assert.rejects((async () => {
              for await (const _event of app.api.stream('/estimates', { method: 'POST', body })) {}
            })(), { code: 'APP_API_PATH_NOT_ALLOWED' })
            assert.equal(calls.length, 1)
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

test('legacy server runtime option uses the handed-off bearer session directly', async () => {
  const previousFetch = globalThis.fetch
  const calls = []
  globalThis.fetch = async (path, init) => {
    calls.push({ path: String(path), init })
    return json({ data: [{ id: 'model-1' }] })
  }
  try {
    await withWindow(async () => {
      const app = createAppClient('app.example.canvas', { runtime: 'server', appSession: makeSession() })
      const result = await app.api.request('/models')
      assert.deepEqual(result.data, [{ id: 'model-1' }])
      assert.equal(calls.length, 1)
      assert.equal(calls[0].path, 'https://api.example.test/v1/models')
      assert.equal(calls[0].init.headers.get('Authorization'), 'Bearer ast_user_1')
      assert.equal(calls[0].init.credentials, 'omit')
      assert.equal(calls.some(call => call.path.includes('/api/app-runtime/')), false)
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
        return json({ data: { ok: true } }, 200, { 'X-Proxy-App-Dev': '1' })
      }
      try {
        await withWindow(async () => {
          const app = createAppClient('app.example.canvas', {
            runtime,
            appSession: makeSession(runtime === 'local' ? { gateway_url: '/v1' } : {}),
          })
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
            const gatewayCalls = calls.filter(call => call.path.includes('/v1/storage/'))
            assert.deepEqual(gatewayCalls.map(call => [
              new URL(call.path, 'https://app.example.test').pathname
                .replace(/^\/v1/, ''),
              call.init.method || 'GET',
            ]), routes.map(([path, method]) => [path.split('?')[0], method]))
            assert.equal(gatewayCalls.length, 10)
            assert.deepEqual(JSON.parse(gatewayCalls[1].init.body), { value: 1 })
            for (const call of gatewayCalls) {
              assert.equal(call.init.headers.get('Authorization'), 'Bearer ast_user_1')
            }
            await assert.rejects(app.api.request('/storage/items/other', { method: 'GET' }), { code: 'APP_API_PATH_NOT_ALLOWED' })
            await assert.rejects(app.api.request('/storage/keys', { method: 'POST', body: '{}' }), { code: 'APP_API_PATH_NOT_ALLOWED' })
            await assert.rejects(app.api.request('/storage/items', { method: 'PATCH', body: '{}' }), { code: 'APP_API_PATH_NOT_ALLOWED' })
            await assert.rejects(app.api.request('/storage/batch'), { code: 'APP_API_PATH_NOT_ALLOWED' })
            await assert.rejects(app.api.request('/storage/../models'), { code: 'APP_API_PATH_NOT_ALLOWED' })
            await assert.rejects((async () => {
              for await (const _event of app.api.stream('/storage/batch', { method: 'POST', body: '{}' })) {}
            })(), { code: 'APP_API_PATH_NOT_ALLOWED' })
            assert.equal(calls.length, 10)
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
      for (const path of ['/api/app-runtime/v1/profile', '/bridge', '/v2/models', '/auth/status', '/__platform/auth/status']) {
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

test('a request sent with a superseded session retries once with the rotated bearer', async () => {
  const previousFetch = globalThis.fetch
  const calls = []
  let attempts = 0
  let app
  globalThis.fetch = async (path, init) => {
    calls.push({ path: String(path), init })
    attempts += 1
    if (attempts === 1) {
      // Simulate the relay revoking the bearer while this request is in
      // flight. The SDK already has the replacement session by the time the
      // generic credential_invalid response arrives.
      await app.refreshSession()
      return json({ error: { code: 'credential_invalid' } }, 401)
    }
    return json({ data: { id: 'model-1' } })
  }
  try {
    await withWindow(async () => {
      app = createAppClient('app.example.canvas', {
        runtime: 'direct', appSession: makeSession(),
        refreshAppSession: async () => makeSession({ access_token: 'ast_user_2' }),
      })
      const result = await app.api.request('/models')
      assert.deepEqual(result.data, { id: 'model-1' })
      assert.equal(calls.length, 2)
      assert.equal(calls[1].init.headers.get('Authorization'), 'Bearer ast_user_2')
      app.destroy()
    })
  } finally {
    if (previousFetch === undefined) delete globalThis.fetch
    else globalThis.fetch = previousFetch
  }
})

test('a storage request sent with a superseded session retries once with the rotated bearer', async () => {
  const previousFetch = globalThis.fetch
  const calls = []
  let attempts = 0
  let app
  globalThis.fetch = async (path, init) => {
    calls.push({ path: String(path), init })
    attempts += 1
    if (attempts === 1) {
      await app.refreshSession()
      return json({ error: { code: 'credential_invalid' } }, 401)
    }
    return json({ data: { ok: true } })
  }
  try {
    await withWindow(async () => {
      app = createAppClient('app.example.canvas', {
        runtime: 'direct', appSession: makeSession(),
        refreshAppSession: async () => makeSession({ access_token: 'ast_user_2' }),
      })
      assert.deepEqual(await app.storage.get('canvas:draft'), { ok: true })
      assert.equal(calls.length, 2)
      assert.match(calls[0].path, /\/storage\/items\?key=canvas%3Adraft$/)
      assert.equal(calls[1].init.headers.get('Authorization'), 'Bearer ast_user_2')
      app.destroy()
    })
  } finally {
    if (previousFetch === undefined) delete globalThis.fetch
    else globalThis.fetch = previousFetch
  }
})

test('a stream sent with a superseded session retries once before opening the stream', async () => {
  const previousFetch = globalThis.fetch
  const calls = []
  let attempts = 0
  let app
  globalThis.fetch = async (path, init) => {
    calls.push({ path: String(path), init })
    attempts += 1
    if (attempts === 1) {
      await app.refreshSession()
      return json({ error: { code: 'credential_invalid' } }, 401)
    }
    return new Response('event: message\ndata: {"ok":true}\n\ndata: [DONE]\n\n', {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    })
  }
  try {
    await withWindow(async () => {
      app = createAppClient('app.example.canvas', {
        runtime: 'direct', appSession: makeSession(),
        refreshAppSession: async () => makeSession({ access_token: 'ast_user_2' }),
      })
      const events = []
      for await (const event of app.api.stream('/messages', { method: 'POST', body: '{}' })) events.push(event)
      assert.deepEqual(events, [{ event: 'message', data: { ok: true } }])
      assert.equal(calls.length, 2)
      assert.equal(calls[1].init.headers.get('Authorization'), 'Bearer ast_user_2')
      app.destroy()
    })
  } finally {
    if (previousFetch === undefined) delete globalThis.fetch
    else globalThis.fetch = previousFetch
  }
})

test('local development uses the handed-off App Session and sends all business data to Gateway', async () => {
  const previousFetch = globalThis.fetch
  const calls = []
  globalThis.fetch = async (path, init) => {
    calls.push({ path: String(path), init })
    return json({ data: [{ id: 'model-1' }] }, 200, { 'X-Proxy-App-Dev': '1' })
  }
  try {
    await withWindow(async () => {
      const app = createAppClient('app.example.canvas', { runtime: 'local', appSession: makeSession({ gateway_url: '/v1' }), localGatewayPath: '/v1' })
      const result = await app.api.request('/models')
      assert.deepEqual(result.data, [{ id: 'model-1' }])
      assert.deepEqual(await app.auth.status(), { authenticated: true, accountScope: makeSession().account_scope })
      assert.equal(calls[0].path, '/v1/models')
      assert.equal(calls[0].init.headers.get('Authorization'), 'Bearer ast_user_1')
      assert.equal(calls[1].path, '/v1/profile')
      assert.equal(calls.some(call => call.path.includes('/api/app-runtime') || call.path.includes('/bridge')), false)
      assert.equal(calls.some(call => /\/(?:auth|__platform)(?:\/|$)/.test(call.path)), false)
      app.destroy()
    })
  } finally {
    if (previousFetch === undefined) delete globalThis.fetch
    else globalThis.fetch = previousFetch
  }
})

test('local development without a tab session asks the UI to sign in and makes no auth request', async () => {
  const previousFetch = globalThis.fetch
  const previousWindow = globalThis.window
  const previousStorage = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage')
  const calls = []
  globalThis.window = {
    parent: {},
    location: { hostname: '127.0.0.1', origin: 'http://127.0.0.1:5173', protocol: 'http:' },
    addEventListener() {}, removeEventListener() {}, setTimeout, clearTimeout,
  }
  Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: { length: 0, key: () => null, getItem: () => null, setItem() {}, removeItem() {} } })
  globalThis.fetch = async (path, init) => { calls.push({ path: String(path), init }); return json({ data: [] }) }
  try {
    const app = createAppClient('app.example.local', { runtime: 'local', localAppVersion: '0.3.6' })
    try {
      assert.deepEqual(await app.auth.status(), { authenticated: false })
      await assert.rejects(app.platform.createSession(), { code: 'APP_LOGIN_REQUIRED' })
      assert.deepEqual(calls, [])
    } finally { app.destroy() }
  } finally {
    globalThis.fetch = previousFetch
    if (previousWindow === undefined) delete globalThis.window
    else globalThis.window = previousWindow
    if (previousStorage) Object.defineProperty(globalThis, 'sessionStorage', previousStorage)
    else delete globalThis.sessionStorage
  }
})

test('local development signs in through the Portal and uses the returned tab-scoped App Session', async () => {
  const previousFetch = globalThis.fetch
  const previousWindow = globalThis.window
  const previousStorage = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage')
  const listeners = new Map()
  const calls = []
  let requestedURL = ''
  const popup = {
    closed: false,
    location: { replace(url) { requestedURL = url } },
    close() { this.closed = true },
  }
  const topLevel = {
    parent: {},
    location: { hostname: '127.0.0.1', origin: 'http://127.0.0.1:5173', protocol: 'http:' },
    open: () => popup,
    addEventListener: (name, handler) => listeners.set(name, handler),
    removeEventListener: name => listeners.delete(name),
    setTimeout, clearTimeout, setInterval, clearInterval,
  }
  globalThis.window = topLevel
  Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: { length: 0, key: () => null, getItem: () => null, setItem() {}, removeItem() {} } })
  globalThis.fetch = async (path, init) => {
    calls.push({ path: String(path), init })
    if (String(path) === '/__proxy-app/auth/grant') {
      return json({ data: { development_grant: 'development-preview-grant-0123456789' } })
    }
    return json({ data: [{ id: 'model-1' }] }, 200, { 'X-Proxy-App-Dev': '1' })
  }
  try {
    const app = createAppClient('app.example.local', {
      runtime: 'local', localAppVersion: '0.3.6', portalURL: 'https://portal.example.test',
    })
    try {
      const login = app.auth.login()
      await new Promise(resolve => setImmediate(resolve))
      const popupURL = new URL(requestedURL)
      assert.equal(popupURL.origin, 'https://portal.example.test')
      const params = new URLSearchParams(popupURL.hash.slice('#/login?'.length))
      assert.equal(params.get('proxy_app_browser'), '1')
      assert.equal(params.get('proxy_app_origin'), 'http://127.0.0.1:5173')
      assert.equal(params.get('proxy_app_id'), 'app.example.local')
      assert.equal(params.get('proxy_app_version'), '0.3.6')
      assert.equal(params.get('proxy_app_development_grant'), 'development-preview-grant-0123456789')
      const state = params.get('proxy_app_state')
      assert.ok(state)
      assert.deepEqual(calls.map(call => call.path), ['/__proxy-app/auth/grant'])
      listeners.get('message')({
        source: popup,
        origin: 'https://portal.example.test',
        data: { protocol: 'proxy-app/auth/v1', type: 'login-complete', state, app_session: makeSession({
          app_id: 'app-build', app_slug: 'app.example.local', app_version: '0.3.6', gateway_url: 'https://api.example.test/v1',
        }) },
      })
      await login
      assert.equal(app.session().gateway_url, '/v1')
      assert.equal(popup.closed, true)
      await app.api.request('/models')
      assert.deepEqual(calls.map(call => call.path), ['/__proxy-app/auth/grant', '/v1/models'])
      assert.equal(calls[1].init.credentials, 'omit')
      assert.equal(calls[1].init.headers.get('Authorization'), 'Bearer ast_user_1')
    } finally { app.destroy() }
  } finally {
    globalThis.fetch = previousFetch
    if (previousWindow === undefined) delete globalThis.window
    else globalThis.window = previousWindow
    if (previousStorage) Object.defineProperty(globalThis, 'sessionStorage', previousStorage)
    else delete globalThis.sessionStorage
  }
})

test('a rejected local App Session requires interactive Portal login and is not silently relayed', async () => {
  const previousFetch = globalThis.fetch
  const calls = []
  globalThis.fetch = async (path, init) => {
    calls.push({ path: String(path), init })
    return json({ error: { code: 'credential_invalid' } }, 401, { 'X-Proxy-App-Dev': '1' })
  }
  try {
    await withWindow(async () => {
      const app = createAppClient('app.example.canvas', { runtime: 'local', localAppVersion: '1.0.0', appSession: makeSession({ gateway_url: '/v1' }) })
      try {
        // Session admission consumes the Portal handoff. An explicit live
        // Gateway check is the operation that detects a revoked bearer.
        await assert.rejects(app.auth.status(), { code: 'APP_LOGIN_REQUIRED' })
        assert.deepEqual(calls.map(call => call.path), ['/v1/profile'])
      } finally { app.destroy() }
    })
  } finally {
    if (previousFetch === undefined) delete globalThis.fetch
    else globalThis.fetch = previousFetch
  }
})

test('local development reads the signed-in profile from Gateway with the handed-off App Session', async () => {
  const previousFetch = globalThis.fetch
  const calls = []
  globalThis.fetch = async (path, init) => {
    calls.push({ path: String(path), init })
    return json({ data: { id: 'user-1', username: 'Pelican creator' } }, 200, { 'X-Proxy-App-Dev': '1' })
  }
  try {
    await withWindow(async () => {
      const app = createAppClient('app.example.canvas', { runtime: 'local', appSession: makeSession({ gateway_url: '/v1' }), localGatewayPath: '/v1' })
      assert.deepEqual(await app.user.getProfile(), { id: 'user-1', username: 'Pelican creator' })
      assert.equal(calls[0].path, '/v1/profile')
      assert.equal(calls[0].init.headers.get('Authorization'), 'Bearer ast_user_1')
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
