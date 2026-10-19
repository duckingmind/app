import assert from 'node:assert/strict'
import test from 'node:test'
import { createAppClient } from '../proxy-app-sdk/dist/index.js'

const scopeA = 'acs_' + 'a'.repeat(64)
const scopeB = 'acs_' + 'b'.repeat(64)
const appSessionLifetimeSeconds = 30 * 24 * 60 * 60
const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { 'Content-Type': 'application/json' },
})
const metadata = (overrides = {}) => ({ data: {
  app_id: 'app.example.canvas', app_slug: 'app.example.canvas', app_version: '1.0.0',
  user_id: 'user-A', account_scope: scopeA, expires_in: appSessionLifetimeSeconds, scopes: ['storage.user'],
  runtime_gateway_url: '/api/app-runtime/v1/gateway', ...overrides,
} })
const turn = () => new Promise(resolve => setImmediate(resolve))

async function withBrowser(fetcher, run, appId = 'app.example.canvas') {
  const previous = { window: globalThis.window, document: globalThis.document, fetch: globalThis.fetch, now: Date.now }
  const timers = new Map()
  const calls = [], events = [], destinations = []
  let now = 1_800_000_000_000, timerID = 0
  const browser = new EventTarget()
  Object.assign(browser, {
    parent: {},
    location: { hostname: 'apps.example', origin: 'https://apps.example', hash: '#/canvas/doc-42', replace: value => destinations.push(value) },
    setTimeout: (callback, delay) => { timers.set(++timerID, { callback, at: now + delay }); return timerID },
    clearTimeout: id => timers.delete(id),
  })
  browser.addEventListener('proxy-app:session-ended', event => events.push(event.detail))
  const document = new EventTarget()
  document.visibilityState = 'visible'
  globalThis.window = browser
  globalThis.document = document
  Date.now = () => now
  globalThis.fetch = async (path, init) => {
    calls.push({ path: String(path), init })
    return fetcher(String(path), init, calls)
  }
  const app = createAppClient(appId, { runtime: 'server' })
  const fire = (name, fields = {}) => browser.dispatchEvent(Object.assign(new Event(name), fields))
  const advance = async ms => {
    now += ms
    for (const [id, timer] of [...timers]) {
      if (timer.at <= now && timers.delete(id)) timer.callback()
    }
    await turn()
  }
  try { await run({ app, browser, document, calls, timers, events, destinations, advance, fire }) }
  finally {
    app.destroy()
    for (const key of ['window', 'document', 'fetch']) {
      if (previous[key] === undefined) delete globalThis[key]
      else globalThis[key] = previous[key]
    }
    Date.now = previous.now
  }
}

test('SDK accepts public slugs without rewriting them and resolves the stable identity before writes', async t => {
  for (const slug of ['canvas', 'x', '7', 'canvas-v2', 'studio.canvas', 'a'.repeat(120), 'app_stable_canvas']) {
    await t.test(slug.length > 30 ? '120 character slug' : slug, async () => {
      await withBrowser(path => path.endsWith('/session')
        ? json(metadata({ app_id: 'app_stable_canvas', app_slug: slug === 'app_stable_canvas' ? 'canvas' : slug }))
        : json({ data: { success: true } }), async ({ app, calls }) => {
        await app.storage.set('draft', { title: 'short slug' })
        assert.equal(app.appId, slug)
        assert.equal(calls[0].init.headers.get('X-App-ID'), slug)
        assert.equal(calls[1].init.headers.get('X-App-ID'), 'app_stable_canvas')
        assert.equal(calls[1].init.headers.get('X-App-Account-Scope'), scopeA)
      }, slug)
    })
  }
})

test('SDK rejects malformed or overlong public slugs instead of normalizing them', () => {
  for (const slug of ['', 'Canvas', 'canvas_', 'canvas..test', 'canvas.-test', '-canvas', 'canvas-', 'canvas test', 'canvas/app', 'canvas\n', 'app_stable_canvas\n', 'a'.repeat(121), 'a.'.repeat(60) + 'a', null, 42]) {
    assert.throws(() => createAppClient(slug), { code: 'APP_INVALID_ID' }, String(slug))
  }
})

test('server slug rename accepts only platform-approved aliases and keeps the stable ID pinned', async t => {
  for (const slug of ['app.proxy.canvas', 'canvas']) {
    await t.test(`approved alias ${slug}`, async () => {
      await withBrowser(() => json(metadata({ app_id: 'app_stable_canvas', app_slug: 'whiteboard', app_aliases: [slug] })), async ({ app, calls }) => {
        await app.auth.status()
        await app.refreshSession()
        assert.equal(app.session().app_id, 'app_stable_canvas')
        assert.equal(app.session().app_slug, 'whiteboard')
        assert.deepEqual(app.session().app_aliases, [slug])
        assert.equal(calls[1].init.headers.get('X-App-ID'), 'app_stable_canvas')
      }, slug)
    })
  }
  for (const [name, appId, fields] of [
    ['prefix is not an alias', 'app.proxy.canvas', { app_id: 'app_stable_canvas', app_slug: 'canvas' }],
    ['bare slug is not a stable identity', 'canvas', { app_id: 'canvas', app_slug: 'canvas' }],
    ['stable IDs cannot be aliases', 'app_stable_canvas', { app_id: 'app_other_canvas', app_slug: 'canvas', app_aliases: ['app_stable_canvas'] }],
  ]) {
    await t.test(name, async () => {
      await withBrowser(() => json(metadata(fields)), async ({ app, calls }) => {
        await assert.rejects(app.storage.set('draft', {}), { code: 'APP_SESSION_INVALID' })
        assert.equal(calls.length, 1, 'must reject before any business operation')
      }, appId)
    })
  }
  await t.test('a valid alias cannot change an initialized client identity', async () => {
    await withBrowser(path => json(metadata({ app_id: path.endsWith('/refresh') ? 'app_other_canvas' : 'app_stable_canvas', app_slug: 'canvas', app_aliases: ['app.proxy.canvas'] })), async ({ app, calls }) => {
      await app.auth.status()
      await assert.rejects(app.refreshSession(), { code: 'APP_SESSION_INVALID' })
      assert.equal(app.session().app_id, 'app_stable_canvas')
      assert.equal(calls.length, 2)
    }, 'app.proxy.canvas')
  })
})

test('server bootstrap pins account scope before the first business write and normalizes approved aliases', async () => {
  await withBrowser(path => path.endsWith('/session')
    ? json(metadata({ app_id: 'app_stable_canvas', app_slug: 'app.renamed.canvas', app_aliases: ['app.example.canvas'] }))
    : json({ data: { success: true } }), async ({ app, calls }) => {
    await app.storage.set('draft', { title: 'A draft' })
    assert.equal(calls[0].path, '/api/app-runtime/v1/session')
    assert.equal(calls[1].init.headers.get('X-App-ID'), 'app_stable_canvas')
    assert.equal(calls[1].init.headers.get('X-App-Account-Scope'), scopeA)
    assert.equal(app.session().account_scope, scopeA)
    assert.equal(app.session().app_id, 'app_stable_canvas')
  })
})

test('server metadata cannot switch to an unrelated app or account', async t => {
  await t.test('unrelated app', async () => {
    await withBrowser(() => json(metadata({ app_id: 'app.other.app', app_slug: 'app.other.app', app_aliases: ['app.unrelated.old'] })), async ({ app, events }) => {
      await assert.rejects(app.auth.status(), { code: 'APP_SESSION_INVALID' })
      assert.equal(events[0].code, 'APP_SESSION_INVALID')
    })
  })
  await t.test('changed scope on refresh', async () => {
    await withBrowser(path => json(metadata(path.endsWith('/refresh') ? { user_id: 'user-B', account_scope: scopeB } : {})), async ({ app, calls, events }) => {
      await app.auth.status()
      await assert.rejects(app.refreshSession(), { code: 'APP_ACCOUNT_CHANGED' })
      assert.equal(calls[1].init.headers.get('X-App-Account-Scope'), scopeA)
      assert.equal(app.session().account_scope, scopeA)
      await assert.rejects(app.storage.set('draft', {}), { code: 'APP_ACCOUNT_CHANGED' })
      assert.equal(calls.length, 2)
      assert.equal(events.length, 1)
    })
  })
})

test('server session stays valid through its TTL and refreshes only after expiry', async () => {
  let expiresAt = 0, refreshes = 0
  await withBrowser(path => {
    if (path.endsWith('/refresh')) {
      refreshes++
      expiresAt = Date.now() + appSessionLifetimeSeconds * 1000
      return json(metadata({ expires_at: new Date(expiresAt).toISOString(), expires_in: appSessionLifetimeSeconds }))
    }
    if (!expiresAt) expiresAt = Date.now() + 20_000
    if (Date.now() >= expiresAt) return json({ error: { code: 'APP_SESSION_EXPIRED', execution_started: false } }, 401)
    const expiresIn = Math.ceil((expiresAt - Date.now()) / 1000)
    return json(metadata({ expires_at: new Date(expiresAt).toISOString(), expires_in: expiresIn }))
  }, async ({ app, advance, timers, calls }) => {
    await app.auth.status()
    assert.equal(timers.size, 0, 'a valid session does not schedule a proactive platform refresh')
    await advance(19_999)
    assert.equal((await app.auth.status()).authenticated, true)
    assert.equal(refreshes, 0)
    assert.equal(calls.length, 1)
    await advance(1)
    assert.equal((await app.auth.status()).authenticated, true)
    assert.equal(refreshes, 1)
    assert.equal(calls.at(-1).path, '/api/app-runtime/v1/session/refresh')
  })
})

test('transient session checks retry with bounded backoff and recover on wake', async () => {
  let unavailable = true, checks = 0
  await withBrowser(path => {
    if (path.endsWith('/session') && !path.endsWith('/refresh')) {
      checks++
      if (checks > 1 && unavailable) throw new TypeError('Failed to fetch')
    }
    return json(metadata())
  }, async ({ app, advance, timers, fire, calls }) => {
    await app.auth.status()
    await advance(61_000)
    await assert.rejects(app.auth.status(), /Failed to fetch/)
    for (const delay of [1_000, 3_000, 10_000, 30_000]) await advance(delay)
    assert.equal(checks, 6)
    assert.equal(timers.size, 0)
    unavailable = false
    const before = calls.length
    fire('online'); fire('focus'); fire('pageshow')
    await turn()
    assert.equal(calls.length, before + 1)
    assert.equal(timers.size, 0)
  })
})

test('cross-tab logout/account switch freezes an old client and rejects its late response', async () => {
  let complete
  await withBrowser(path => path.endsWith('/session') ? json(metadata()) : new Promise(resolve => { complete = resolve }), async ({ app, fire, events, calls }) => {
    await app.auth.status()
    const pending = app.storage.get('draft')
    await turn()
    fire('storage', { key: 'proxy-app:auth-change', newValue: JSON.stringify({ user_id: 'user-A', at: Date.now(), nonce: 'same-account' }) })
    assert.equal(events.length, 0)
    fire('storage', { key: 'proxy-app:auth-change', newValue: JSON.stringify({ user_id: 'user-B', at: Date.now(), nonce: 'switched' }) })
    complete(json({ data: { title: 'stale' } }))
    await assert.rejects(pending, { code: 'APP_ACCOUNT_CHANGED' })
    await assert.rejects(app.api.request('/models'), { code: 'APP_ACCOUNT_CHANGED' })
    assert.equal(calls.length, 2)
    assert.equal(events.length, 1)
    assert.equal(events[0].appId, 'app.example.canvas')
  })
})

test('account-change, missing-cookie and post-execution failures never replay business operations', async t => {
  for (const error of [
    { code: 'APP_ACCOUNT_CHANGED', execution_started: false, status: 409 },
    { code: 'APP_SESSION_INVALID', status: 401 },
    { code: 'APP_SESSION_EXPIRED', execution_started: true, status: 401 },
  ]) {
    await t.test(error.code, async () => {
      await withBrowser(path => path.endsWith('/session') ? json(metadata()) : json({ error }, error.status), async ({ app, calls }) => {
        await assert.rejects(app.api.request('/responses', { method: 'POST', body: '{}' }), { code: error.code })
        assert.equal(calls.filter(call => call.path.endsWith('/responses')).length, 1)
        assert.equal(calls.some(call => call.path.endsWith('/refresh')), false)
      })
    })
  }
})

test('metadata expiry can refresh once, while missing credentials require explicit Portal relaunch', async () => {
  let first = true
  await withBrowser(path => {
    if (path.endsWith('/session') && first) { first = false; return json({ error: { code: 'APP_SESSION_EXPIRED', execution_started: false } }, 401) }
    return json(metadata())
  }, async ({ app, calls }) => {
    await app.auth.status()
    assert.equal(calls[1].path, '/api/app-runtime/v1/session/refresh')
  })
  await withBrowser(() => json({ error: { code: 'APP_SESSION_INVALID' } }, 401), async ({ app, calls, destinations }) => {
    await assert.rejects(app.auth.status(), { code: 'APP_SESSION_INVALID' })
    assert.equal(calls.length, 1)
    assert.equal(app.auth.recoveryMode, 'redirect')
    await app.auth.login()
    const target = new URL(destinations[0])
    assert.equal(target.origin, 'https://apps.example')
    assert.equal(target.pathname, '/')
    assert.equal(target.hash.split('?')[0], '#/apps/app.example.canvas')
    assert.equal(new URLSearchParams(target.hash.split('?')[1]).get('runtime_hash'), '#/canvas/doc-42')
  })
})

test('explicit platform session check clears a stale auth failure after Portal reissues the cookie', async () => {
  let available = false
  await withBrowser(() => available
    ? json(metadata())
    : json({ error: { code: 'APP_SESSION_INVALID' } }, 401), async ({ app }) => {
    await assert.rejects(app.auth.status(), { code: 'APP_SESSION_INVALID' })
    available = true
    const session = await app.platform.createSession()
    assert.equal(session.app_id, 'app.example.canvas')
    assert.equal((await app.auth.status()).authenticated, true)
  })
})

test('server logout revokes the current app through the guarded endpoint and blocks queued work', async () => {
  await withBrowser(path => path.endsWith('/session') ? json(metadata()) : json({ data: { success: true } }), async ({ app, calls, events }) => {
    await app.auth.status()
    await app.auth.logout()
    const logout = calls[1]
    assert.equal(logout.path, '/api/app-runtime/v1/session/logout')
    assert.equal(logout.init.method, 'POST')
    assert.equal(logout.init.credentials, 'include')
    assert.equal(logout.init.headers.get('X-App-Runtime-Logout'), '1')
    assert.equal(logout.init.headers.get('X-App-Account-Scope'), scopeA)
    await assert.rejects(app.storage.set('draft', {}), { code: 'APP_AUTH_CHANGED' })
    assert.equal(events.length, 1)
  })
})

test('initial metadata is checked against the latest Portal identity even before any storage event', async () => {
  await withBrowser(() => json(metadata()), async ({ app, browser, calls }) => {
    browser.localStorage = { getItem: () => JSON.stringify({ user_id: 'user-B', at: Date.now(), nonce: 'already-switched' }) }
    await assert.rejects(app.storage.set('draft', {}), { code: 'APP_ACCOUNT_CHANGED' })
    assert.equal(calls.length, 1)
  })
})

test('an existing document cannot silently adopt another app version on refresh', async () => {
  await withBrowser(path => json(metadata(path.endsWith('/refresh') ? { app_version: '2.0.0' } : {})), async ({ app }) => {
    await app.auth.status()
    await assert.rejects(app.refreshSession(), { code: 'APP_VERSION_CHANGED' })
    assert.equal(app.session().app_version, '1.0.0')
  })
})

test('server safe pre-execution replay retains one idempotency key for a write', async () => {
  let attempts = 0
  await withBrowser(path => {
    if (path.endsWith('/session') || path.endsWith('/refresh')) return json(metadata())
    if (++attempts === 1) return json({ error: { code: 'APP_SESSION_EXPIRED', execution_started: false } }, 401)
    return json({ ok: true })
  }, async ({ app, calls }) => {
    await app.api.request('/responses', { method: 'POST', body: '{}' })
    const writes = calls.filter(call => call.path.endsWith('/responses'))
    assert.equal(writes.length, 2)
    assert.ok(writes[0].init.headers.get('Idempotency-Key'))
    assert.equal(writes[0].init.headers.get('Idempotency-Key'), writes[1].init.headers.get('Idempotency-Key'))
  })
})

test('streaming submissions do not retry when execution has already started', async () => {
  await withBrowser(path => path.endsWith('/session') ? json(metadata())
    : json({ error: { code: 'APP_SESSION_EXPIRED', execution_started: true } }, 401), async ({ app, calls }) => {
    await assert.rejects((async () => {
      for await (const _event of app.api.stream('/responses/stream', { method: 'POST', body: '{}' })) {}
    })(), { code: 'APP_SESSION_EXPIRED' })
    assert.equal(calls.filter(call => call.path.endsWith('/responses/stream')).length, 1)
    assert.equal(calls.some(call => call.path.endsWith('/refresh')), false)
  })
})

test('stale session checks time out and schedule a bounded transient retry', async () => {
  let first = true
  await withBrowser((path, init) => {
    if (path.endsWith('/session') && first) { first = false; return json(metadata()) }
    return new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true }))
  }, async ({ app, advance, timers }) => {
    await app.auth.status()
    await advance(61_000)
    const pending = app.auth.status().then(() => null, error => error)
    await turn()
    await advance(10_000)
    assert.equal((await pending).code, 'APP_SESSION_REFRESH_TIMEOUT')
    assert.equal(timers.size, 1)
  })
})

test('explicit Portal recovery preserves only a unique validated preview selector', async t => {
  for (const [search, expected] of [
    ['?runtime_preview=1.2.3-preview', '1.2.3-preview'],
    ['?runtime_preview=1.2.3&runtime_preview=2.0.0', null],
    ['?runtime_preview=https%3A%2F%2Fother.example', null],
  ]) {
    await t.test(search, async () => {
      await withBrowser(() => json(metadata()), async ({ app, browser, destinations }) => {
        browser.location.search = search
        await app.auth.login()
        const query = new URLSearchParams(new URL(destinations[0]).hash.split('?')[1])
        assert.equal(query.get('version'), expected)
      })
    })
  }
})

test('Portal recovery drops unsafe fragments and oversized preview versions', async () => {
  for (const hash of ['#//another.example', '#/canvas/%0aheader', '#/canvas/%5cfile', '#/canvas/\\file', '#/' + 'x'.repeat(4096)]) {
    await withBrowser(() => json(metadata()), async ({ app, browser, destinations }) => {
      browser.location.hash = hash
      browser.location.search = '?runtime_preview=' + 'v'.repeat(129)
      await app.auth.login()
      const query = new URLSearchParams(new URL(destinations[0]).hash.split('?')[1])
      assert.equal(query.has('runtime_hash'), false)
      assert.equal(query.has('version'), false)
    })
  }
})

test('queued stale Portal storage events cannot end a newer authenticated session', async () => {
  await withBrowser(() => json(metadata({ user_id: 'user-B', account_scope: scopeB })), async ({ app, browser, fire, events }) => {
    const current = JSON.stringify({ user_id: 'user-B', at: Date.now(), nonce: 'new-login' })
    browser.localStorage = { getItem: () => current }
    await app.auth.status()
    fire('storage', { key: 'proxy-app:auth-change', newValue: JSON.stringify({ user_id: null, at: Date.now() - 1000, nonce: 'old-logout' }) })
    assert.equal(events.length, 0)
    assert.equal((await app.auth.status()).accountScope, scopeB)
  })
})

test('same-user login notification while bootstrap is pending is checked against returned metadata', async () => {
  let complete
  await withBrowser(() => new Promise(resolve => { complete = resolve }), async ({ app, browser, fire, events }) => {
    const current = JSON.stringify({ user_id: 'user-A', at: Date.now(), nonce: 'login' })
    browser.localStorage = { getItem: () => current }
    const pending = app.auth.status()
    await turn()
    fire('storage', { key: 'proxy-app:auth-change', newValue: current })
    complete(json(metadata()))
    assert.equal((await pending).accountScope, scopeA)
    assert.equal(events.length, 0)
  })
})

test('server logout timeout releases the shared cookie lock', async () => {
  await withBrowser((path, init) => path.endsWith('/session') ? json(metadata())
    : new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true })), async ({ app, advance, timers }) => {
    await app.auth.status()
    const rejected = assert.rejects(app.auth.logout(), { code: 'APP_SESSION_LOGOUT_TIMEOUT' })
    await turn()
    await advance(10_000)
    await rejected
    assert.equal(timers.size, 0)
    const next = createAppClient('app.example.canvas', { runtime: 'server' })
    try { assert.equal((await next.auth.status()).authenticated, true) }
    finally { next.destroy() }
  })
})

test('bfcache page restoration rechecks the session without permanently aborting the client', async () => {
  await withBrowser(() => json(metadata()), async ({ app, fire, advance, timers, calls }) => {
    await app.auth.status()
    fire('beforeunload')
    fire('pagehide', { persisted: true })
    assert.equal(timers.size, 0)
    await advance(1_000)
    fire('pageshow', { persisted: true })
    await turn()
    assert.equal(calls.length, 2)
    assert.equal(calls[1].path, '/api/app-runtime/v1/session')
    assert.equal(calls[1].init.signal.aborted, false)
    assert.equal(timers.size, 0)
    assert.equal((await app.auth.status()).authenticated, true)
  })
})
