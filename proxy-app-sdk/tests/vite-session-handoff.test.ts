import assert from 'node:assert/strict'
import test from 'node:test'
import { createServer } from 'node:http'
import { createPlatformDevProxy, createPlatformDevSessionPlugin } from '../src/vite.ts'

test('local development proxies only Gateway and the optional app backend', () => {
  const previous = { ...process.env }
  process.env.PROXY_PLATFORM_GATEWAY_URL = 'http://127.0.0.1:9002/v1'
  process.env.PROXY_APP_BACKEND_URL = ''
  process.env.PROXY_APP_DEV_AUTH_RELAY_URL = 'http://127.0.0.1:51234'
  process.env.PROXY_APP_DEV_AUTH_RELAY_SECRET = 'r'.repeat(64)
  try {
    const proxy = createPlatformDevProxy()!
    assert.ok(proxy['/v1'])
    assert.equal(Object.keys(proxy).some((path) => path.includes('__proxy-app/auth')), false)
    assert.equal(Object.keys(proxy).some((path) => path.includes('51234')), false)
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key]
    for (const [key, value] of Object.entries(previous)) process.env[key] = value
  }
})

test('local development proxy remains absent when no data-plane target is configured', () => {
  const previous = { ...process.env }
  process.env.PROXY_PLATFORM_GATEWAY_URL = ''
  process.env.PROXY_APP_BACKEND_URL = ''
  process.env.PROXY_APP_DEV_AUTH_RELAY_URL = 'http://127.0.0.1:51234'
  process.env.PROXY_APP_DEV_AUTH_RELAY_SECRET = 'r'.repeat(64)
  try {
    assert.equal(createPlatformDevProxy(), undefined)
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key]
    for (const [key, value] of Object.entries(previous)) process.env[key] = value
  }
})

test('local App Session exchange forwards only the HttpOnly device grant to the exact development endpoint', async (t) => {
  let forwarded = 0
  const upstream = createServer((request, response) => {
    forwarded += 1
    assert.equal(request.method, 'POST')
    assert.equal(request.url, '/api/market/apps/pelican/development-sessions')
    assert.equal(request.headers.cookie, 'codex_device_token=browser-grant')
    assert.equal(request.headers['x-app-development-grant'], 'development-preview-grant-0123456789')
    assert.equal(request.headers.origin, 'http://127.0.0.1:9004')
    assert.equal(request.headers['x-request-id'], 'local-exchange-1')
    const chunks: Buffer[] = []
    request.on('data', chunk => chunks.push(Buffer.from(chunk)))
    request.on('end', () => {
      assert.deepEqual(JSON.parse(Buffer.concat(chunks).toString('utf8')), { expected_version: '0.3.7' })
      response.writeHead(200, { 'content-type': 'application/json', 'x-request-id': 'admin-exchange-1' })
      response.end(JSON.stringify({ data: { access_token: 'ast_session' } }))
    })
  })
  await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise<void>(resolve => upstream.close(() => resolve())))
  const address = upstream.address()
  assert.ok(address && typeof address !== 'string')

  let middleware: ((request: any, response: any, next: (error?: unknown) => void) => void) | undefined
  const plugin = createPlatformDevSessionPlugin({
    apiURL: `http://127.0.0.1:${address.port}/api`,
    portalURL: 'http://127.0.0.1:9004',
    appId: 'pelican',
    appVersion: '0.3.7',
    developmentGrant: 'development-preview-grant-0123456789',
  })
  plugin.configureServer({ middlewares: { use(handler) { middleware = handler } } })
  assert.ok(middleware)

  const grantResponse = await new Promise<{ status: number; body: string }>(resolve => {
    const response = {
      statusCode: 200,
      setHeader() {},
      end(body = '') { resolve({ status: this.statusCode, body }) },
    }
    middleware!({
      method: 'GET', url: '/__proxy-app/auth/grant',
      // Same-origin browser GETs may omit Origin; Fetch Metadata remains a
      // browser-controlled signal and must allow the local preview grant.
      headers: { host: '127.0.0.1:5173', 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'cors', 'sec-fetch-dest': 'empty' },
      socket: { encrypted: false }, resume() {},
    }, response, () => { throw new Error('the grant route must be handled') })
  })
  assert.equal(grantResponse.status, 200)
  assert.equal(JSON.parse(grantResponse.body).data.development_grant, 'development-preview-grant-0123456789')

  const responsePromise = new Promise<{ status: number; headers: Record<string, string>; body: string }>(resolve => {
    const headers: Record<string, string> = {}
    const response = {
      statusCode: 200,
      setHeader(name: string, value: string) { headers[name.toLowerCase()] = value },
      end(body = '') { resolve({ status: this.statusCode, headers, body }) },
    }
    const request = {
      method: 'POST',
      url: '/__proxy-app/auth/session',
      headers: {
        host: '127.0.0.1:5173',
        origin: 'http://127.0.0.1:5173',
        'content-type': 'application/json',
        'sec-fetch-site': 'same-origin',
        'x-request-id': 'local-exchange-1',
        cookie: 'codex_device_token=browser-grant; portal-only=must-not-forward',
      },
      socket: { encrypted: false },
      async *[Symbol.asyncIterator]() { yield JSON.stringify({ expected_version: '0.3.7' }) },
    }
    middleware!(request, response, () => { throw new Error('the session route must be handled') })
  })
  const result = await responsePromise
  assert.equal(result.status, 200)
  assert.equal(result.headers['cache-control'], 'private, no-store')
  assert.equal(result.headers['x-request-id'], 'admin-exchange-1')
  assert.deepEqual(JSON.parse(result.body), { data: { access_token: 'ast_session' } })
  assert.equal(forwarded, 1)
})

test('local App Session exchange rejects cross-origin requests before forwarding cookies', async () => {
  let forwarded = 0
  const upstream = createServer(() => { forwarded += 1 })
  await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve))
  const address = upstream.address()
  assert.ok(address && typeof address !== 'string')
  try {
    let middleware: ((request: any, response: any, next: (error?: unknown) => void) => void) | undefined
    createPlatformDevSessionPlugin({
      apiURL: `http://127.0.0.1:${address.port}/api`,
      portalURL: 'http://127.0.0.1:9004',
      appId: 'pelican',
      appVersion: '0.3.7',
      developmentGrant: 'development-preview-grant-0123456789',
    }).configureServer({ middlewares: { use(handler) { middleware = handler } } })
    const result = await new Promise<{ status: number; body: string }>(resolve => {
      const response = {
        statusCode: 200,
        setHeader() {},
        end(body = '') { resolve({ status: this.statusCode, body }) },
      }
      middleware!({
        method: 'POST',
        url: '/__proxy-app/auth/session',
        headers: {
          host: '127.0.0.1:5173',
          origin: 'http://evil.example',
          'content-type': 'application/json',
          cookie: 'codex_device_token=browser-grant',
        },
        socket: { encrypted: false },
        resume() {},
      }, response, () => { throw new Error('the session route must be handled') })
    })
    assert.equal(result.status, 403)
    assert.equal(JSON.parse(result.body).code, 'APP_SESSION_CSRF_REJECTED')
    assert.equal(forwarded, 0)
  } finally {
    await new Promise<void>(resolve => upstream.close(() => resolve()))
  }
})
