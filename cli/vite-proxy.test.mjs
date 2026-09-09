import assert from 'node:assert/strict'
import test from 'node:test'
import { createPlatformDevProxy } from '../proxy-app-sdk/dist/vite.js'

function withEnvironment(values, callback) {
  const previous = {}
  for (const [name, value] of Object.entries(values)) {
    previous[name] = process.env[name]
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
  try {
    return callback()
  } finally {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  }
}

function captureProxyEvents(configure) {
  const handlers = new Map()
  configure({ on(name, handler) { handlers.set(name, handler) } })
  return handlers
}

test('Vite proxy rewrites gateway and bridge paths and isolates browser metadata', () => {
  withEnvironment({
    PROXY_PLATFORM_GATEWAY_URL: 'https://gateway.example.test/v1',
    PROXY_PLATFORM_BRIDGE_URL: 'http://relay.example.test/bridge',
    PROXY_PLATFORM_AUTH_URL: 'http://relay.example.test/auth',
    PROXY_PLATFORM_RELAY_SECRET: 'relay-secret',
  }, () => {
    const proxy = createPlatformDevProxy()
    assert.ok(proxy)
    assert.equal(proxy['/__platform/v1'].target, 'https://gateway.example.test')
    assert.equal(proxy['/__platform/v1'].rewrite('/__platform/v1/models?scope=all'), '/v1/models?scope=all')
    assert.equal(proxy['/__platform/bridge'].target, 'http://relay.example.test')
    assert.equal(proxy['/__platform/bridge'].rewrite('/__platform/bridge?version=1'), '/bridge?version=1')
    assert.equal(proxy['/__platform/auth'].target, 'http://relay.example.test')
    assert.equal(proxy['/__platform/auth'].rewrite('/__platform/auth/start'), '/auth/start')

    for (const entry of [proxy['/__platform/v1'], proxy['/__platform/bridge'], proxy['/__platform/auth']]) {
      const events = captureProxyEvents(entry.configure)
      const headers = { cookie: 'portal-cookie', origin: 'http://localhost:5173', referer: 'http://localhost:5173/', authorization: 'Bearer ast_local' }
      events.get('proxyReq')({
        removeHeader(name) { delete headers[name] },
        setHeader(name, value) { headers[name.toLowerCase()] = value },
      })
      assert.equal(headers.cookie, undefined)
      assert.equal(headers.origin, undefined)
      assert.equal(headers.referer, undefined)
      assert.equal(headers.authorization, 'Bearer ast_local')
      assert.equal(headers['x-proxy-app-relay'], 'relay-secret')

      const responseHeaders = { 'content-type': 'application/json' }
      events.get('proxyRes')({ headers: responseHeaders })
      assert.equal(responseHeaders['cache-control'], 'no-store')
      assert.equal(responseHeaders['x-proxy-app-dev'], '1')
    }
  })
})

test('Vite proxy rejects unsafe gateway URLs and is disabled without configuration', () => {
  withEnvironment({
    PROXY_PLATFORM_GATEWAY_URL: undefined,
    PROXY_PLATFORM_BRIDGE_URL: undefined,
    PROXY_PLATFORM_RELAY_SECRET: undefined,
  }, () => assert.equal(createPlatformDevProxy(), undefined))

  withEnvironment({ PROXY_PLATFORM_GATEWAY_URL: 'https://user:pass@example.test/v1' }, () => {
    assert.throws(() => createPlatformDevProxy(), /without credentials/)
  })
})

test('Vite proxy exposes production-shaped HTTP paths for page runtime', () => {
  withEnvironment({
    PROXY_PLATFORM_GATEWAY_URL: 'https://gateway.example.test/v1',
    PROXY_PLATFORM_RUNTIME_URL: 'https://platform.example.test/api/app-runtime/v1',
    PROXY_PLATFORM_BRIDGE_URL: undefined,
    PROXY_PLATFORM_AUTH_URL: undefined,
    PROXY_PLATFORM_RELAY_SECRET: 'relay-secret',
  }, () => {
    const proxy = createPlatformDevProxy()
    assert.ok(proxy)
    assert.equal(proxy['/v1'].target, 'https://gateway.example.test')
    assert.equal(proxy['/v1'].rewrite('/v1/models?scope=all'), '/v1/models?scope=all')
    assert.equal(proxy['/api/app-runtime/v1'].target, 'https://platform.example.test')
    assert.equal(proxy['/api/app-runtime/v1'].rewrite('/api/app-runtime/v1/storage/items?key=x'), '/api/app-runtime/v1/storage/items?key=x')
    const events = captureProxyEvents(proxy['/api/app-runtime/v1'].configure)
    const headers = { cookie: 'portal-cookie', origin: 'http://localhost:5173', referer: 'http://localhost:5173/' }
    events.get('proxyReq')({
      removeHeader(name) { delete headers[name] },
      setHeader(name, value) { headers[name.toLowerCase()] = value },
    })
    assert.equal(headers.cookie, undefined)
    assert.equal(headers.origin, undefined)
    assert.equal(headers['x-proxy-app-relay'], 'relay-secret')
  })
})

test('gateway-only development proxy exposes the production path and legacy alias', () => {
  withEnvironment({
    PROXY_PLATFORM_GATEWAY_URL: 'https://gateway.example.test/v1',
    PROXY_PLATFORM_BRIDGE_URL: undefined,
    PROXY_PLATFORM_AUTH_URL: undefined,
    PROXY_PLATFORM_RELAY_SECRET: undefined,
  }, () => {
    const proxy = createPlatformDevProxy()
    assert.deepEqual(Object.keys(proxy || {}), ['/v1', '/__platform/v1'])
  })
})
