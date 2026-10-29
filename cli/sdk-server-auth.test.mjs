import assert from 'node:assert/strict'
import test from 'node:test'
import { createAppClient } from '../proxy-app-sdk/dist/index.js'

test('legacy server runtime option sends the handed-off App Session to Gateway', async () => {
  const previousWindow = globalThis.window
  const previousFetch = globalThis.fetch
  const calls = []
  const browser = new EventTarget()
  Object.assign(browser, { location: { hostname: 'apps.example', origin: 'https://apps.example' } })
  globalThis.window = browser
  globalThis.fetch = async (path, init) => {
    calls.push({ path: String(path), init })
    return new Response(JSON.stringify({ data: [{ id: 'model-1' }] }), {
      headers: { 'Content-Type': 'application/json' },
    })
  }

  try {
    const app = createAppClient('app.example.canvas', {
      runtime: 'server',
      appSession: {
        access_token: 'ast_user_1',
        token_type: 'Bearer',
        expires_in: 3600,
        gateway_url: 'https://api.example.test/v1',
        app_id: 'app.example.canvas',
        app_slug: 'app.example.canvas',
        app_version: '1.0.0',
        scopes: ['platform.models.read'],
      },
    })
    try {
      assert.deepEqual((await app.api.request('/models')).data, [{ id: 'model-1' }])
      assert.equal(calls.length, 1)
      assert.equal(calls[0].path, 'https://api.example.test/v1/models')
      assert.equal(calls[0].init.headers.get('Authorization'), 'Bearer ast_user_1')
      assert.equal(calls[0].init.credentials, 'omit')
      assert.equal(calls.some(call => call.path.includes('/api/app-runtime/')), false)
    } finally {
      app.destroy()
    }
  } finally {
    if (previousWindow === undefined) delete globalThis.window
    else globalThis.window = previousWindow
    if (previousFetch === undefined) delete globalThis.fetch
    else globalThis.fetch = previousFetch
  }
})
