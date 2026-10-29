import assert from 'node:assert/strict'
import test from 'node:test'
import { createAppClient } from '../proxy-app-sdk/dist/index.js'

test('legacy embedded runtime is rejected', () => {
  assert.throws(() => createAppClient('app.example.bridge', { runtime: 'embedded' }), {
    code: 'APP_RUNTIME_UNSUPPORTED',
  })
})

test('a production document defaults to the direct Gateway runtime and uses the Portal login session', async () => {
  const previousWindow = globalThis.window
  const previousFetch = globalThis.fetch
  const previousSessionStorage = globalThis.sessionStorage
  const session = {
    access_token: 'ast_user_1', token_type: 'Bearer', expires_in: 900,
    gateway_url: 'https://api.example.test/v1', app_id: 'app.example.bridge',
    app_slug: 'app.example.bridge', app_version: '1.0.0', scopes: [],
  }
  const storageKey = 'proxy-app:gateway-session:app.example.bridge'
  const listeners = new Map()
  const messages = []
  const browser = {
    parent: { postMessage: (...args) => messages.push(args) },
    location: { hostname: 'apps.example', origin: 'https://apps.example' },
    addEventListener(name, listener) {
      if (!listeners.has(name)) listeners.set(name, new Set())
      listeners.get(name).add(listener)
    },
    removeEventListener(name, listener) { listeners.get(name)?.delete(listener) },
    setTimeout,
    clearTimeout,
    localStorage: { getItem: () => null },
    dispatchEvent() {},
  }
  globalThis.sessionStorage = {
    length: 1,
    key: index => index === 0 ? storageKey : null,
    getItem: key => key === storageKey ? JSON.stringify(session) : null,
  }
  globalThis.window = browser
  globalThis.fetch = async (path, init) => {
    assert.equal(String(path), 'https://api.example.test/v1/models')
    assert.equal(new Headers(init.headers).get('Authorization'), 'Bearer ast_user_1')
    return new Response(JSON.stringify({ data: [{ id: 'model-1' }] }), {
      headers: { 'Content-Type': 'application/json' },
    })
  }
  try {
    const app = createAppClient('app.example.bridge')
    const result = await app.api.request('/models')
    assert.deepEqual(result.data, [{ id: 'model-1' }])
    assert.deepEqual(messages, [])
    assert.equal(app.session().app_id, 'app.example.bridge')
    app.destroy()
  } finally {
    if (previousWindow === undefined) delete globalThis.window
    else globalThis.window = previousWindow
    if (previousFetch === undefined) delete globalThis.fetch
    else globalThis.fetch = previousFetch
    if (previousSessionStorage === undefined) delete globalThis.sessionStorage
    else globalThis.sessionStorage = previousSessionStorage
  }
})
