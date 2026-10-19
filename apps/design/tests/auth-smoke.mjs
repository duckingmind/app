import assert from 'node:assert/strict'

// The browser uses the real SDK, with a disposable local OAuth host. No real
// credentials, platform services or billable model requests are involved.
const validScope = `acs_${'a'.repeat(64)}`
const readyModel = 'OAuth 编辑模型'

export function createAuthFixture() {
  const fixture = { state: null }
  fixture.reset = (options = {}) => {
    fixture.state = {
      authenticated: false, scope: validScope, statusError: '', loginError: '',
      completeLogin: true, callbackAuthenticated: true, postMessage: true,
      requests: { status: 0, starts: [], protected: [] }, ...options,
    }
  }
  fixture.reset()
  fixture.plugin = {
    name: 'design-oauth-fixture',
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const url = new URL(request.url, `http://${request.headers.host}`)
        const { pathname } = url
        const state = fixture.state
        const json = (data, status = 200) => {
          response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
          response.end(JSON.stringify(data))
        }
        // Gateway-only apps use the local auth relay for login metadata. The
        // relay is control-plane orchestration; model/media/KV traffic below
        // remains on the Gateway's /v1 data plane.
        if (pathname === '/__platform/auth/status') {
          state.requests.status++
          if (state.statusError) return json({ error: { code: state.statusError, message: 'Fixture status failure' } }, 503)
          return json({ data: { authenticated: state.authenticated, ...(state.authenticated && state.scope ? { account_scope: state.scope } : {}) } })
        }
        if (pathname === '/__platform/auth/start') {
          state.requests.starts.push(url.searchParams.get('force_login'))
          if (state.loginError) return json({ error: { code: state.loginError, message: 'Fixture login failure' } }, 409)
          if (url.searchParams.has('force_login')) state.authenticated = false
          const authState = `fixture-${state.requests.starts.length}`
          return json({ data: {
            authenticated: false, auth_state: authState, relay_url: url.origin,
            login_url: `${url.origin}/__auth-fixture/login?state=${authState}`,
          } })
        }
        if (pathname === '/__auth-fixture/login') {
          if (state.completeLogin) state.authenticated = state.callbackAuthenticated
          response.writeHead(200, { 'Content-Type': 'text/html' })
          const message = JSON.stringify({ protocol: 'proxy-app/auth/v1', type: 'login-complete', state: url.searchParams.get('state') })
          response.end(`<!doctype html><title>Fixture OAuth</title><p>Local OAuth callback</p><script>
            ${state.completeLogin && state.postMessage ? `window.opener?.postMessage(${message}, ${JSON.stringify(url.origin)}); window.close();` : ''}
          </script>`)
          return
        }
        if (pathname.startsWith('/v1/')) {
          state.requests.protected.push({ path: pathname, authenticated: state.authenticated, validScope: state.scope === validScope })
          if (!state.authenticated) return json({ error: { code: 'APP_LOGIN_REQUIRED', message: 'Sign in' } }, 401)
          if (pathname === '/v1/images/models') return json({ data: [{
            id: 'auth-edit', name: readyModel, available: true,
            supported_operations: ['edit', 'generation'], max_input_images: 6,
            supported_sizes: ['1024x1024', '768x1024', '1024x768'],
          }] })
          if (pathname === '/v1/models') return json({ data: [{ id: 'auth-text', supports_vision: true, supports_responses: true }] })
          if (pathname === '/v1/storage/items' && request.method === 'GET') {
            const keys = url.searchParams.getAll('keys')
            return json({ data: keys.length ? Object.fromEntries(keys.map(key => [key, null])) : null })
          }
          if (pathname === '/v1/storage/keys') return json({ data: { keys: [], next_cursor: '' } })
          if (pathname === '/v1/storage/items') return json({ data: { success: true, revision: 1 } })
          return json({ error: { code: 'FIXTURE_UNEXPECTED_REQUEST', message: pathname } }, 500)
        }
        // A regression guard: an app that accidentally re-enables the old
        // Admin Runtime or bridge must fail visibly in this fixture.
        if (pathname.startsWith('/api/app-runtime/') || pathname === '/__platform/bridge') {
          return json({ error: { code: 'ADMIN_RUNTIME_FORBIDDEN', message: pathname } }, 403)
        }
        next()
      })
    },
  }
  return fixture
}

export async function runAuthChecks({ fixture, origin, cdp, evaluate, waitFor, click, screenshot, check }) {
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: `(${(() => {
    window.__authPopupGestures = []
    const open = window.open.bind(window)
    window.open = (...args) => {
      window.__authPopupGestures.push(navigator.userActivation.isActive)
      return window.__blockAuthPopup ? null : open(...args)
    }
  }).toString()})()` })
  let caseId = 0
  const openCase = async options => {
    await cdp.send('Page.navigate', { url: 'about:blank' })
    await waitFor(() => location.href === 'about:blank', 'Previous case did not close')
    fixture.reset(options)
    await cdp.send('Page.navigate', { url: `${origin}/?auth_case=${++caseId}` })
    await waitFor(() => document.querySelector('[aria-label="模式导航"]'), 'App did not mount')
  }
  const actionReady = label => waitFor(label => {
    const button = document.querySelector(`header [aria-label="${label}"]`)
    return button && !button.disabled
  }, `Missing account action: ${label}`, label)
  const connected = async () => {
    await waitFor(name => document.querySelector('[aria-label="商品套图图片模型"]')?.textContent.includes(name), 'Verified account did not restore models', readyModel)
    await waitFor(() => !document.querySelector('.resource-loading-toast'), 'Resource restoration did not finish')
    assert.ok(fixture.state.requests.protected.length > 0)
    assert.ok(fixture.state.requests.protected.every(request => request.authenticated && request.validScope), 'Only verified accounts can request models/storage')
    assert.equal(await evaluate(() => document.querySelectorAll('[role="alert"]').length), 0)
  }
  const noResources = () => assert.deepEqual(fixture.state.requests.protected, [], 'No account resources before verified OAuth')
  const alertText = () => evaluate(() => [...document.querySelectorAll('[role="alert"]')].map(node => node.textContent).join('\n'))
  const floatingAlert = async () => {
    assert.deepEqual(await evaluate(() => {
      const layer = document.querySelector('.feedback-layer')
      const alerts = [...document.querySelectorAll('[role="alert"]')]
      return {
        layers: document.querySelectorAll('.feedback-layer').length,
        fixed: layer && getComputedStyle(layer).position === 'fixed',
        contained: alerts.length > 0 && alerts.every(alert => layer?.contains(alert)),
        fits: alerts.every(alert => {
          const rect = alert.getBoundingClientRect()
          return rect.left >= -1 && rect.right <= innerWidth + 1 && rect.top >= -1 && rect.bottom <= innerHeight + 1
        }),
        legacyBars: document.querySelectorAll('.global-progress, .toast-stack').length,
      }
    }), { layers: 1, fixed: true, contained: true, fits: true, legacyBars: 0 }, 'Account feedback must stay out of the page layout')
  }
  const recheck = async () => {
    // Use the visible label, because the close icon is also a button.
    await evaluate(() => [...document.querySelectorAll('[role="alert"] button')].find(button => button.textContent === '重新检查')?.setAttribute('data-auth-recheck', 'true'))
    await click('[data-auth-recheck="true"]')
  }

  await check('Authenticated cached session restores resources without opening OAuth', async () => {
    await openCase({ authenticated: true })
    await connected()
    assert.deepEqual(fixture.state.requests.starts, [])
    assert.deepEqual(await evaluate(() => window.__authPopupGestures), [])
  })

  await check('Explicit login opens in the click gesture and verifies the OAuth callback', async () => {
    await openCase()
    await actionReady('登录并连接')
    noResources()
    await click('header [aria-label="登录并连接"]')
    await connected()
    assert.deepEqual(fixture.state.requests.starts, [null])
    assert.deepEqual(await evaluate(() => window.__authPopupGestures), [true])
    await screenshot('oauth-connected')
  })

  await check('A callback cannot admit an unauthenticated session or trigger a login loop', async () => {
    await openCase({ callbackAuthenticated: false })
    await actionReady('登录并连接')
    await click('header [aria-label="登录并连接"]')
    await waitFor(() => document.querySelector('[role="alert"]')?.textContent.includes('登录尚未完成'), 'Unverified callback was accepted')
    await floatingAlert()
    await actionReady('登录并连接')
    noResources()
    assert.deepEqual(fixture.state.requests.starts, [null])
    fixture.state.authenticated = true
    await recheck()
    await connected()
    assert.deepEqual(fixture.state.requests.starts, [null], 'Recheck must not open another popup')
  })

  await check('Missing account scope stays distinct from signed out and can recover by rechecking', async () => {
    await openCase({ authenticated: true, scope: '' })
    await actionReady('重新登录')
    assert.match(await alertText(), /无法确认账户信息/)
    assert.doesNotMatch(await alertText(), /未登录|尚未登录/)
    noResources()
    assert.deepEqual(fixture.state.requests.starts, [])
    await screenshot('account-scope-unavailable')
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: false })
    await floatingAlert()
    assert.equal(await evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true)
    await screenshot('account-scope-mobile')
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false })
    fixture.state.scope = validScope
    await recheck()
    await connected()
    assert.deepEqual(fixture.state.requests.starts, [])
  })

  await check('Explicit scope recovery forces OAuth once and revalidates account metadata', async () => {
    await openCase({ authenticated: true, scope: '' })
    await actionReady('重新登录')
    await click('header [aria-label="重新登录"]')
    await waitFor(() => document.querySelector('[role="alert"]')?.textContent.includes('无法确认账户信息'), 'Missing scope after callback was not reported')
    await actionReady('重新登录')
    assert.deepEqual(fixture.state.requests.starts, ['1'])
    assert.deepEqual(await evaluate(() => window.__authPopupGestures), [true])
    noResources()
  })

  await check('OAuth completion is recovered by polling when the opener message is unavailable', async () => {
    await openCase({ postMessage: false })
    await actionReady('登录并连接')
    await click('header [aria-label="登录并连接"]')
    await connected()
    assert.deepEqual(fixture.state.requests.starts, [null])
  })

  await check('Runtime outages allow retry without misreporting a missing login', async () => {
    await openCase({ statusError: 'PLATFORM_UNAVAILABLE' })
    await waitFor(() => document.querySelector('[role="alert"]')?.textContent.includes('连接平台'), 'Runtime failure did not surface')
    await actionReady('重试连接')
    assert.match(await alertText(), /连接平台/)
    await floatingAlert()
    noResources()
    assert.deepEqual(fixture.state.requests.starts, [])
    fixture.state.statusError = ''
    fixture.state.authenticated = true
    await click('header [aria-label="重试连接"]')
    await connected()
  })

  await check('Blocked popups keep a manual login link and allow a fresh click to retry', async () => {
    await openCase()
    await actionReady('登录并连接')
    await evaluate(() => { window.__blockAuthPopup = true })
    await click('header [aria-label="登录并连接"]')
    await waitFor(() => document.querySelector('[role="alert"]')?.textContent.includes('浏览器阻止'), 'Popup failure did not surface')
    noResources()
    assert.equal(await evaluate(() => !!document.querySelector('[role="alert"] a[target="_blank"]')), true)
    await floatingAlert()
    await screenshot('popup-blocked')
    await evaluate(() => { window.__blockAuthPopup = false })
    await click('header [aria-label="登录并连接"]')
    await connected()
    assert.deepEqual(fixture.state.requests.starts, [null, null])
  })

  await check('Host-owned login offers a status recheck instead of reopening OAuth', async () => {
    await openCase({ loginError: 'APP_LOGIN_UNAVAILABLE' })
    await actionReady('登录并连接')
    await click('header [aria-label="登录并连接"]')
    await actionReady('重新检查登录状态')
    assert.match(await alertText(), /请在平台完成登录/)
    await floatingAlert()
    noResources()
    fixture.state.authenticated = true
    await click('header [aria-label="重新检查登录状态"]')
    await connected()
    assert.deepEqual(fixture.state.requests.starts, [null])
  })
}
