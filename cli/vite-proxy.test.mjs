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

test('Vite sends business traffic to Gateway and exposes no general browser auth route', () => {
  withEnvironment({
    PROXY_PLATFORM_GATEWAY_URL: 'https://gateway.example.test/v1',
    PROXY_PLATFORM_BRIDGE_URL: 'http://relay.example.test/bridge',
    PROXY_PLATFORM_AUTH_URL: 'https://relay.example.test/auth',
    PROXY_PLATFORM_RELAY_SECRET: 'relay-secret',
  }, () => {
    const proxy = createPlatformDevProxy()
    assert.ok(proxy)
    assert.equal(proxy['/v1'].target, 'https://gateway.example.test')
    assert.equal(proxy['/v1'].rewrite('/v1/models?scope=all'), '/v1/models?scope=all')
    assert.equal(proxy['/auth'], undefined)

    for (const entry of [proxy['/v1']]) {
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
      assert.equal(headers['x-proxy-app-relay'], undefined)

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
    PROXY_APP_BACKEND_URL: undefined,
  }, () => assert.equal(createPlatformDevProxy(), undefined))

  withEnvironment({ PROXY_PLATFORM_GATEWAY_URL: 'https://user:pass@example.test/v1' }, () => {
    assert.throws(() => createPlatformDevProxy(), /without credentials/)
  })

  withEnvironment({ PROXY_PLATFORM_GATEWAY_URL: 'https://gateway.example.test/v1' }, () => {
    assert.throws(() => createPlatformDevProxy({ path: '/__platform/v1' }), /path must be \/v1/)
    assert.throws(() => createPlatformDevProxy({ defaultGatewayPath: '/api/app-runtime/v1' }), /path must be \/v1/)
  })
})

test('local Vite proxy does not expose CLI relay authentication routes', () => {
  withEnvironment({
    PROXY_PLATFORM_GATEWAY_URL: undefined,
    PROXY_APP_BACKEND_URL: undefined,
    PROXY_APP_DEV_AUTH_RELAY_URL: 'http://127.0.0.1:51234',
    PROXY_APP_DEV_AUTH_RELAY_SECRET: 'r'.repeat(64),
  }, () => {
    assert.equal(createPlatformDevProxy(), undefined)
  })
})

test('Vite proxies same-origin app API requests to the loopback container backend', () => {
  withEnvironment({
    PROXY_PLATFORM_GATEWAY_URL: undefined,
    PROXY_PLATFORM_AUTH_URL: undefined,
    PROXY_APP_BACKEND_URL: 'http://127.0.0.1:8080',
    PROXY_PLATFORM_RELAY_SECRET: 'should-not-reach-backend',
  }, () => {
    const proxy = createPlatformDevProxy()
    assert.deepEqual(Object.keys(proxy || {}), ['/api'])
    assert.equal(proxy['/api'].target, 'http://127.0.0.1:8080')
    assert.equal(proxy['/api'].rewrite('/api/design/plans?dry_run=1'), '/api/design/plans?dry_run=1')

    const events = captureProxyEvents(proxy['/api'].configure)
    const headers = {
      cookie: 'portal-session',
      origin: 'http://localhost:5173',
      referer: 'http://localhost:5173/',
      'x-proxy-app-relay': 'spoofed-relay',
      authorization: 'Bearer app-session',
    }
    events.get('proxyReq')({ removeHeader(name) { delete headers[name] } })
    assert.equal(headers.cookie, undefined)
    assert.equal(headers.origin, undefined)
    assert.equal(headers.referer, undefined)
    assert.equal(headers['x-proxy-app-relay'], undefined)
    assert.equal(headers.authorization, 'Bearer app-session')

    const responseHeaders = { 'content-type': 'application/json' }
    events.get('proxyRes')({ headers: responseHeaders })
    assert.equal(responseHeaders['cache-control'], 'no-store')
    assert.equal(responseHeaders['x-proxy-app-route'], 'backend')
  })
})

test('app backend proxy accepts loopback origins only', () => {
  for (const backendURL of [
    'https://backend.example.test',
    'http://user:pass@127.0.0.1:8080',
    'http://127.0.0.1:8080/backend',
    'http://127.0.0.1:8080?target=other',
  ]) {
    withEnvironment({ PROXY_APP_BACKEND_URL: backendURL }, () => {
      assert.throws(() => createPlatformDevProxy(), /must be a loopback http\(s\) origin/)
    })
  }
})

test('Vite proxy ignores legacy Admin Runtime and bridge environment variables', () => {
  withEnvironment({
    PROXY_PLATFORM_GATEWAY_URL: 'https://gateway.example.test/v1',
    PROXY_PLATFORM_RUNTIME_URL: 'https://platform.example.test/api/app-runtime/v1',
    PROXY_PLATFORM_BRIDGE_URL: undefined,
    PROXY_PLATFORM_AUTH_URL: undefined,
    PROXY_PLATFORM_RELAY_SECRET: 'relay-secret',
  }, () => {
    const proxy = createPlatformDevProxy()
    assert.ok(proxy)
    assert.deepEqual(Object.keys(proxy), ['/v1'])
    assert.equal(proxy['/api/app-runtime/v1'], undefined)
    assert.equal(proxy['/__platform/bridge'], undefined)
  })
})

test('development proxy exposes only the Gateway path', () => {
  withEnvironment({
    PROXY_PLATFORM_GATEWAY_URL: 'https://gateway.example.test/v1',
    PROXY_PLATFORM_RUNTIME_URL: 'https://admin.example.test/api/app-runtime/v1',
    PROXY_PLATFORM_BRIDGE_URL: 'https://admin.example.test/bridge',
    PROXY_PLATFORM_AUTH_URL: 'https://relay.example.test/auth',
    PROXY_PLATFORM_RELAY_SECRET: undefined,
  }, () => {
    const proxy = createPlatformDevProxy()
    assert.deepEqual(Object.keys(proxy || {}), ['/v1'])
    assert.equal(proxy['/api/app-runtime/v1'], undefined)
    assert.equal(proxy['/__platform/bridge'], undefined)
  })
})

test('legacy runtime, bridge and auth configuration never create routes', () => {
  withEnvironment({
    PROXY_PLATFORM_GATEWAY_URL: 'https://gateway.example.test/v1',
    PROXY_PLATFORM_RUNTIME_URL: 'https://admin.example.test/api/app-runtime/v1',
    PROXY_PLATFORM_BRIDGE_URL: 'https://admin.example.test/bridge',
    PROXY_PLATFORM_AUTH_URL: 'http://127.0.0.1:9000/auth',
    PROXY_PLATFORM_RELAY_SECRET: 'relay-secret',
  }, () => {
    const proxy = createPlatformDevProxy()
    assert.ok(proxy)
    assert.deepEqual(Object.keys(proxy), ['/v1'])
    assert.equal(proxy['/v1'].rewrite('/v1/models'), '/v1/models')
    assert.equal(proxy['/api/app-runtime/v1'], undefined)
    assert.equal(proxy['/__platform/bridge'], undefined)
    assert.equal(proxy['/auth'], undefined)
  })
})
