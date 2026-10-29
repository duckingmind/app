import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'
import { createAppRuntimeDevPlugin } from '../src/vite-runtime.ts'

class Incoming extends EventEmitter {
  method = 'POST'
  url = '/api/test'
  headers: Record<string, string> = {
    host: '127.0.0.1:5178',
    origin: 'http://127.0.0.1:5178',
    'content-type': 'application/json',
    accept: 'text/event-stream',
    authorization: 'Bearer ast_browser_session',
    'x-app-version': '0.2.8',
    'x-request-id': 'req_adapter_test',
  }
  private readonly chunks: Uint8Array[]
  constructor(chunks: Uint8Array[] = [new TextEncoder().encode('{}')]) { super(); this.chunks = chunks }
  async *[Symbol.asyncIterator]() { for (const chunk of this.chunks) yield chunk }
}

class Outgoing extends EventEmitter {
  statusCode = 0
  headersSent = false
  writableEnded = false
  headers: Record<string, string> = {}
  chunks: Uint8Array[] = []
  setHeader(name: string, value: string) { this.headers[name.toLowerCase()] = value; this.headersSent = true }
  write(chunk: Uint8Array | string) { this.chunks.push(typeof chunk === 'string' ? new TextEncoder().encode(chunk) : chunk); return true }
  end(chunk?: Uint8Array | string) { if (chunk) this.write(chunk); this.writableEnded = true }
}

async function waitForEnd(response: Outgoing) {
  for (let index = 0; index < 50 && !response.writableEnded; index += 1) await new Promise(resolve => setTimeout(resolve, 2))
  assert.equal(response.writableEnded, true)
}

function install(plugin: ReturnType<typeof createAppRuntimeDevPlugin>, handler: (...args: any[]) => unknown) {
  let middleware: ((request: any, response: any, next: (error?: unknown) => void) => void) | undefined
  plugin.configureServer({
    middlewares: { use(value) { middleware = value } },
    ssrLoadModule: async () => ({ handler }),
    config: { root: process.cwd() },
  } as any)
  assert.ok(middleware)
  return middleware!
}

test('mounts the request handler and forwards the browser App Session to Gateway', async () => {
  const previousFetch = globalThis.fetch
  const calls: Array<{ url: string; init?: RequestInit }> = []
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init })
    assert.equal(String(url), 'https://gateway.example.test/v1/responses/stream')
    assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer ast_browser_session')
    assert.equal(new Headers(init?.headers).get('x-app-version'), '0.2.8')
    return new Response('data: {"delta":"ok"}\n\ndata: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } })
  }) as typeof fetch
  try {
    const plugin = createAppRuntimeDevPlugin({ appId: 'pelican', appVersion: '0.2.8', entry: '/src/runtime/handler.ts', basePath: '/api/test', gatewayURL: 'https://gateway.example.test/v1' })
    const middleware = install(plugin, async (_request, context) => context.platform.request('/responses/stream', { method: 'POST', body: '{}' }))
    const outgoing = new Outgoing()
    middleware(new Incoming(), outgoing, () => undefined)
    await waitForEnd(outgoing)
    assert.equal(outgoing.statusCode, 200)
    assert.match(new TextDecoder().decode(Uint8Array.from(outgoing.chunks.flatMap(chunk => [...chunk]))), /data:/)
    assert.equal(calls.length, 1)
  } finally { globalThis.fetch = previousFetch }
})

test('requires the browser App Session instead of reading a local credential file', async () => {
  const plugin = createAppRuntimeDevPlugin({ appId: 'pelican', appVersion: '0.2.8', entry: '/src/runtime/handler.ts', basePath: '/api/test', gatewayURL: 'https://gateway.example.test/v1' })
  const middleware = install(plugin, async () => new Response('should not run'))
  const request = new Incoming()
  delete request.headers.authorization
  const outgoing = new Outgoing()
  middleware(request, outgoing, () => undefined)
  await waitForEnd(outgoing)
  assert.equal(outgoing.statusCode, 401)
  assert.match(new TextDecoder().decode(Uint8Array.from(outgoing.chunks.flatMap(chunk => [...chunk]))), /APP_LOGIN_REQUIRED/)
})

test('passes unrelated Vite requests to the next middleware', () => {
  const plugin = createAppRuntimeDevPlugin({ appId: 'pelican', appVersion: '0.2.8', entry: '/src/runtime/handler.ts', basePath: '/api/test', gatewayURL: 'https://gateway.example.test/v1' })
  const middleware = install(plugin, async () => new Response('ok'))
  let nextCalls = 0
  middleware(Object.assign(new Incoming(), { method: 'GET', url: '/assets/app.js' }), new Outgoing(), () => { nextCalls += 1 })
  assert.equal(nextCalls, 1)
})
