import assert from 'node:assert/strict'
import test from 'node:test'
import { createAppClient } from '../dist/index.js'

test('browser session admission uses the Portal handoff and lets the first API call reach Gateway directly', async () => {
  const previousWindow = globalThis.window
  const previousFetch = globalThis.fetch
  const listeners = new Map<string, (event: any) => void>()
  const topLevel: any = {
    location: { hostname: 'portal.example.test', origin: 'https://portal.example.test' },
    addEventListener: (name: string, handler: (event: any) => void) => listeners.set(name, handler),
    removeEventListener: (name: string) => listeners.delete(name),
  }
  topLevel.parent = topLevel
  globalThis.window = topLevel
  const requests: Array<{ url: string; init?: RequestInit }> = []
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    requests.push({ url: String(url), init })
    return new Response(JSON.stringify({ data: [{ id: 'model-a' }] }), { headers: { 'content-type': 'application/json' } })
  }) as typeof fetch
  try {
    const app = createAppClient('canvas', {
      runtime: 'direct',
      appSession: {
        access_token: 'ast_portal_issued_session', token_type: 'Bearer', expires_in: 3600,
        gateway_url: 'https://api.example.test/v1', app_id: 'app_canvas', app_slug: 'canvas',
        app_version: '1.0.0', account_scope: `acs_${'a'.repeat(64)}`, scopes: [],
      },
    })
    const session = await app.platform.createSession()
    assert.equal(session.access_token, 'ast_portal_issued_session')
    assert.equal(requests.length, 0, 'session admission should not send an extra Gateway probe')

    await app.api.request('/models')
    assert.equal(requests.length, 1)
    assert.equal(requests[0].url, 'https://api.example.test/v1/models')
    assert.equal(new Headers(requests[0].init?.headers).get('authorization'), 'Bearer ast_portal_issued_session')

    const status = await app.auth.status()
    assert.equal(status.authenticated, true)
    assert.equal(status.accountScope, `acs_${'a'.repeat(64)}`)
    assert.equal(requests.length, 2)
    assert.equal(requests[1].url, 'https://api.example.test/v1/profile', 'live validation remains available when explicitly requested')
    app.destroy()
  } finally {
    if (previousWindow === undefined) delete (globalThis as any).window
    else globalThis.window = previousWindow
    globalThis.fetch = previousFetch
  }
})

test('an expired direct session fails locally without issuing a Gateway preflight', async () => {
  const previousWindow = globalThis.window
  const previousFetch = globalThis.fetch
  globalThis.window = {
    location: { hostname: 'portal.example.test', origin: 'https://portal.example.test' },
    addEventListener() {},
    removeEventListener() {},
  } as any
  let requestCount = 0
  globalThis.fetch = (async () => {
    requestCount += 1
    return new Response('{}', { headers: { 'content-type': 'application/json' } })
  }) as typeof fetch
  try {
    const expiredPayload = Buffer.from(JSON.stringify({ exp: 1 })).toString('base64url')
    const app = createAppClient('canvas', {
      runtime: 'direct',
      appSession: {
        access_token: `ast_header.${expiredPayload}.signature`, token_type: 'Bearer', expires_in: 3600,
        gateway_url: 'https://api.example.test/v1', app_id: 'app_canvas', app_slug: 'canvas',
        app_version: '1.0.0', account_scope: `acs_${'a'.repeat(64)}`, scopes: [],
      },
    })
    await assert.rejects(app.platform.createSession(), { code: 'APP_SESSION_EXPIRED', status: 401 })
    assert.equal(requestCount, 0)
    app.destroy()
  } finally {
    if (previousWindow === undefined) delete (globalThis as any).window
    else globalThis.window = previousWindow
    globalThis.fetch = previousFetch
  }
})

test('published browser login exchanges the Portal cookie and returns the app session to this tab', async () => {
  const previousWindow = globalThis.window
  const previousFetch = globalThis.fetch
  const listeners = new Map<string, (event: any) => void>()
  const popup = {
    closed: false,
    requestedURL: '',
    location: { replace(url: string) { popup.requestedURL = url } },
    close() { popup.closed = true },
  }
  const topLevel: any = {
    location: { hostname: 'portal.example.test', origin: 'https://portal.example.test' },
    open: () => popup,
    addEventListener: (name: string, handler: (event: any) => void) => listeners.set(name, handler),
    removeEventListener: (name: string) => listeners.delete(name),
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
  }
  topLevel.parent = topLevel
  globalThis.window = topLevel
  const requests: Array<{ url: string; init?: RequestInit }> = []
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    requests.push({ url: String(url), init })
    return new Response(JSON.stringify({ data: [{ id: 'model-a' }] }), { headers: { 'content-type': 'application/json' } })
  }) as typeof fetch
  try {
    const app = createAppClient('pelican', { runtime: 'direct', appVersion: '0.3.6', portalURL: 'https://portal.example.test' })
    const login = app.auth.login()
    await new Promise(resolve => setImmediate(resolve))
    const popupURL = new URL(popup.requestedURL)
    assert.equal(popupURL.origin, 'https://portal.example.test')
    assert.equal(popupURL.hash.startsWith('#/login?'), true)
    const params = new URLSearchParams(popupURL.hash.slice('#/login?'.length))
    assert.equal(params.get('proxy_app_browser'), '1')
    assert.equal(params.get('proxy_app_origin'), 'https://portal.example.test')
    assert.equal(params.get('proxy_app_id'), 'pelican')
    assert.equal(params.get('proxy_app_version'), '0.3.6')
    const state = params.get('proxy_app_state')
    assert.ok(state)

    listeners.get('message')!({
      source: popup,
      origin: 'https://portal.example.test',
      data: { protocol: 'proxy-app/auth/v1', type: 'login-complete', state, app_session: {
        session_id: 'session-1', access_token: 'ast_browser_login_token', token_type: 'Bearer', expires_in: 3600,
        gateway_url: 'https://api.example.test/v1', app_id: 'app_pelican', app_slug: 'pelican',
        app_version: '0.3.6', scopes: [],
      } },
    })
    await login
    assert.equal(popup.closed, true)
    await app.api.request('/models')
    assert.equal(requests[0].url, 'https://api.example.test/v1/models')
    assert.equal(new Headers(requests[0].init?.headers).get('authorization'), 'Bearer ast_browser_login_token')
    assert.equal(requests[0].init?.credentials, 'omit')
    app.destroy()
  } finally {
    if (previousWindow === undefined) delete (globalThis as any).window
    else globalThis.window = previousWindow
    globalThis.fetch = previousFetch
  }
})

test('published browser login rejects sessions from another app version', async () => {
  const previousWindow = globalThis.window
  const popup = {
    closed: false,
    requestedURL: '',
    location: { replace(url: string) { popup.requestedURL = url } },
    close() { popup.closed = true },
  }
  const topLevel: any = {
    location: { hostname: 'portal.example.test', origin: 'https://portal.example.test' },
    addEventListener(name: string, handler: (event: any) => void) { this.listener = handler },
    removeEventListener() {},
    open() { return popup },
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
  }
  topLevel.parent = topLevel
  globalThis.window = topLevel
  try {
    const app = createAppClient('pelican', { runtime: 'direct', appVersion: '0.3.6', portalURL: 'https://portal.example.test' })
    const login = app.auth.login()
    await new Promise(resolve => setImmediate(resolve))
    const query = new URLSearchParams(new URL(popup.requestedURL).hash.slice('#/login?'.length))
    const state = query.get('proxy_app_state')!
    topLevel.listener({
      source: popup, origin: 'https://portal.example.test',
      data: { protocol: 'proxy-app/auth/v1', type: 'login-complete', state, app_session: {
        access_token: 'ast_test_token', gateway_url: 'https://api.example.test/v1', app_id: 'app_pelican',
        app_slug: 'pelican', app_version: '0.3.5', expires_in: 3600,
      } },
    })
    await assert.rejects(login, { code: 'APP_SESSION_INVALID' })
    app.destroy()
  } finally {
    if (previousWindow === undefined) delete (globalThis as any).window
    else globalThis.window = previousWindow
  }
})

test('local development login preserves the Portal exchange error code and request ID', async () => {
  const previousWindow = globalThis.window
  const previousFetch = globalThis.fetch
  const popup = {
    closed: false,
    requestedURL: '',
    location: { replace(url: string) { popup.requestedURL = url } },
    close() { popup.closed = true },
  }
  const listeners = new Map<string, (event: any) => void>()
  const topLevel: any = {
    location: { protocol: 'http:', hostname: '127.0.0.1', origin: 'http://127.0.0.1:5173' },
    addEventListener(name: string, handler: (event: any) => void) { listeners.set(name, handler) },
    removeEventListener(name: string) { listeners.delete(name) },
    open() { return popup },
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
  }
  topLevel.parent = topLevel
  globalThis.window = topLevel
  globalThis.fetch = async (input: any) => {
    assert.equal(String(input), '/__proxy-app/auth/grant')
    return { ok: true, status: 200, async json() { return { data: { development_grant: 'development-preview-grant-0123456789' } } } } as any
  }
  try {
    const app = createAppClient('pelican', {
      runtime: 'local',
      localDevelopment: true,
      localAppVersion: '0.3.7',
      portalURL: 'http://127.0.0.1:9004',
    })
    const login = app.auth.login()
    await new Promise(resolve => setImmediate(resolve))
    const query = new URLSearchParams(new URL(popup.requestedURL).hash.slice('#/login?'.length))
    const state = query.get('proxy_app_state')!
    assert.equal(query.get('proxy_app_development_grant'), 'development-preview-grant-0123456789')
    listeners.get('message')!({
      source: popup,
      origin: 'http://127.0.0.1:9004',
      data: {
        protocol: 'proxy-app/auth/v1',
        type: 'login-failed',
        state,
        error: {
          code: 'APP_DEVELOPMENT_APP_UNAVAILABLE',
          message: 'development app unavailable',
          status: 404,
          requestId: 'missing-development-app',
        },
      },
    })
    await assert.rejects(login, {
      code: 'APP_DEVELOPMENT_APP_UNAVAILABLE',
      status: 404,
      requestId: 'missing-development-app',
    })
    assert.equal(popup.closed, true)
    app.destroy()
  } finally {
    globalThis.fetch = previousFetch
    if (previousWindow === undefined) delete (globalThis as any).window
    else globalThis.window = previousWindow
  }
})
