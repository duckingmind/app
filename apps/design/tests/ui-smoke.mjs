import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { delimiter, dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { createServer } from 'vite'
import react from '@vitejs/plugin-react'
import { createAuthFixture, runAuthChecks } from './auth-smoke.mjs'

// No browser dependency or real account is required. Override this path for
// Linux/Windows Chromium installations; Node 22+ supplies the WebSocket API.
const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const authSmoke = process.argv.includes('--auth')
const authFixture = authSmoke ? createAuthFixture() : null
const browserOverride = process.env.DESIGN_BROWSER_PATH?.trim() || ''
const outputPath = process.env.DESIGN_SMOKE_OUTPUT || join(tmpdir(), authSmoke ? 'design-auth-smoke' : 'design-ui-smoke')
const timeout = 20_000
const browserStartupTimeout = Number(process.env.DESIGN_BROWSER_STARTUP_TIMEOUT || 60_000)
const checks = []
const failures = []
const blockedRequests = []
const runtimeErrors = []
let browser, server, cdp, profile

function pathFromEnvironment(name, ...parts) {
  const root = process.env[name]
  return root ? join(root, ...parts) : ''
}

function browserPathCandidates() {
  const home = homedir()
  const candidates = [
    process.env.CHROME_BIN,
    process.env.CHROMIUM_BIN,
    process.env.BROWSER_BIN,
  ]

  if (process.platform === 'darwin') {
    candidates.push(
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
      join(home, 'Applications/Google Chrome.app/Contents/MacOS/Google Chrome'),
      join(home, 'Applications/Chromium.app/Contents/MacOS/Chromium'),
    )
  } else if (process.platform === 'win32') {
    candidates.push(
      pathFromEnvironment('LOCALAPPDATA', 'Google', 'Chrome', 'Application', 'chrome.exe'),
      pathFromEnvironment('PROGRAMFILES', 'Google', 'Chrome', 'Application', 'chrome.exe'),
      pathFromEnvironment('PROGRAMFILES(X86)', 'Google', 'Chrome', 'Application', 'chrome.exe'),
      pathFromEnvironment('LOCALAPPDATA', 'Chromium', 'Application', 'chrome.exe'),
      pathFromEnvironment('PROGRAMFILES', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      pathFromEnvironment('PROGRAMFILES(X86)', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    )
  } else {
    candidates.push(
      '/usr/bin/google-chrome-stable',
      '/usr/bin/google-chrome',
      '/usr/bin/chromium',
      '/usr/bin/chromium-browser',
      '/usr/bin/microsoft-edge-stable',
      '/usr/bin/microsoft-edge',
      '/snap/bin/chromium',
      '/opt/google/chrome/google-chrome',
    )
  }

  // Also search PATH so package-managed browsers and custom CI images work
  // without requiring a platform-specific path in this test file.
  const executableNames = process.platform === 'win32'
    ? ['chrome.exe', 'msedge.exe', 'chromium.exe']
    : ['google-chrome-stable', 'google-chrome', 'chromium', 'chromium-browser', 'microsoft-edge-stable', 'microsoft-edge']
  for (const directory of (process.env.PATH || '').split(delimiter).filter(Boolean)) {
    for (const name of executableNames) candidates.push(join(directory, name))
  }
  return candidates.filter(Boolean)
}

function expandOverride(value) {
  if (!value || value.includes(sep) || value.includes('/') || value.includes('\\')) return [value]
  return (process.env.PATH || '').split(delimiter).filter(Boolean).map(directory => join(directory, value))
}

async function findBrowser() {
  const explicit = Boolean(browserOverride)
  const candidates = explicit ? expandOverride(browserOverride) : browserPathCandidates()
  const uniqueCandidates = [...new Set(candidates)]
  const accessible = []
  for (const candidate of uniqueCandidates) {
    try {
      await access(candidate)
      accessible.push(candidate)
    } catch {
      // Keep looking; the final error includes the searched paths.
    }
  }
  if (accessible[0]) return accessible[0]

  if (explicit) {
    throw new Error(`DESIGN_BROWSER_PATH does not point to an accessible browser: ${browserOverride}`)
  }
  const shown = uniqueCandidates.slice(0, 14).join(', ')
  throw new Error([
    'No Chrome/Chromium-compatible browser was found for the UI smoke test.',
    `Searched ${uniqueCandidates.length} candidates${shown ? `: ${shown}${uniqueCandidates.length > 14 ? ', …' : ''}` : '.'}`,
    'Install Chrome/Chromium or set DESIGN_BROWSER_PATH to the browser executable.',
  ].join(' '))
}

class CDP {
  constructor(socket) {
    this.socket = socket
    this.nextId = 0
    this.pending = new Map()
    this.listeners = new Map()
    socket.addEventListener('message', ({ data }) => {
      const message = JSON.parse(data)
      if (message.id) {
        const pending = this.pending.get(message.id)
        if (!pending) return
        this.pending.delete(message.id)
        clearTimeout(pending.timer)
        if (message.error) pending.reject(new Error(JSON.stringify(message.error)))
        else pending.resolve(message.result)
      } else {
        for (const listener of this.listeners.get(message.method) || []) listener(message.params)
      }
    })
    socket.addEventListener('close', () => {
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer)
        pending.reject(new Error('Chrome debugger disconnected'))
      }
      this.pending.clear()
    })
  }
  static async connect(url) {
    const socket = new WebSocket(url)
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { socket.close(); reject(new Error('Chrome debugger connection timed out')) }, timeout)
      socket.addEventListener('open', () => { clearTimeout(timer); resolve() }, { once: true })
      socket.addEventListener('error', (event) => { clearTimeout(timer); reject(event.error || new Error('Chrome debugger connection failed')) }, { once: true })
    })
    return new CDP(socket)
  }
  send(method, params = {}) {
    const id = ++this.nextId
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`Chrome command timed out: ${method}`))
      }, timeout)
      this.pending.set(id, { resolve, reject, timer })
      this.socket.send(JSON.stringify({ id, method, params }))
    })
  }
  on(method, listener) {
    const listeners = this.listeners.get(method) || []
    listeners.push(listener)
    this.listeners.set(method, listeners)
  }
}

async function evaluate(fn, ...args) {
  const result = await cdp.send('Runtime.evaluate', {
    expression: `(${fn.toString()})(...${JSON.stringify(args)})`,
    awaitPromise: true, returnByValue: true,
  }).catch(error => { throw new Error(`${error.message}; evaluating: ${fn.toString().slice(0, 180)}`) })
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text)
  }
  return result.result.value
}

async function waitFor(fn, message, ...args) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const result = await cdp.send('Runtime.evaluate', {
      expression: `Boolean((${fn.toString()})(...${JSON.stringify(args)}))`,
      returnByValue: true,
    })
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text)
    if (result.result.value) return
    await delay(50)
  }
  const alerts = await evaluate(() => [...document.querySelectorAll('[role="alert"]')].map(node => node.textContent))
  throw new Error(`${message}; alerts: ${JSON.stringify(alerts)}`)
}

async function click(selector) {
  const point = await evaluate((selector) => {
    const element = [...document.querySelectorAll(selector)].find(node => {
      const rect = node.getBoundingClientRect()
      const style = getComputedStyle(node)
      return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden'
    })
    if (!element) {
      const matches = [...document.querySelectorAll(selector)].map(node => {
        const rect = node.getBoundingClientRect()
        const style = getComputedStyle(node)
        return { tag: node.tagName, text: node.textContent?.trim(), rect: [rect.x, rect.y, rect.width, rect.height], display: style.display, visibility: style.visibility }
      })
      throw new Error(`No visible element: ${selector}; matches: ${JSON.stringify(matches)}`)
    }
    if (element.disabled) throw new Error(`Element is disabled: ${selector}`)
    element.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' })
    const rect = element.getBoundingClientRect()
    return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }
  }, selector)
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point })
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point })
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point })
}

async function key(key) {
  const keyCode = { Escape: 27, ArrowDown: 40, ArrowUp: 38, Enter: 13, Home: 36, End: 35, Tab: 9 }[key]
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key, code: key, windowsVirtualKeyCode: keyCode })
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code: key, windowsVirtualKeyCode: keyCode })
}

async function upload(selector, imageSelector, file = 'sample-00.webp') {
  const { root } = await cdp.send('DOM.getDocument')
  const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector })
  assert.ok(nodeId, `Upload control exists: ${selector}`)
  await cdp.send('DOM.setFileInputFiles', { nodeId, files: [join(appRoot, 'src/assets', file)] })
  await waitFor(selector => {
    const image = document.querySelector(selector)
    return image?.src.startsWith('blob:') && image.complete && image.naturalWidth > 0
  }, `Upload did not render: ${selector}`, imageSelector)
  return evaluate(selector => document.querySelector(selector).src, imageSelector)
}

async function moduleTab(index, expectedSelector, expectedRoute) {
  await click(`.mode-nav .mode-tab:nth-child(${index})`)
  await waitFor(selector => [...document.querySelectorAll(selector)].some(node => node.getClientRects().length), 'Module did not become visible', expectedSelector)
  if (expectedRoute) {
    assert.deepEqual(await evaluate(() => {
      const params = new URLSearchParams(location.search)
      return { module: params.get('module') || 'product', view: params.get('view') || 'studio' }
    }), expectedRoute, `Route did not update for navigation to ${expectedRoute.module || expectedRoute.view}`)
  }
}

async function screenshot(name) {
  await evaluate(async () => {
    // Headless Chrome may throttle frame callbacks after a viewport change.
    // Bound visual settling rather than waiting indefinitely on paused frames.
    await Promise.race([
      new Promise(resolve => setTimeout(resolve, 500)),
      (async () => {
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
        await Promise.all(document.getAnimations()
          .filter(animation => animation.playState === 'running' && animation.effect?.getComputedTiming().iterations !== Infinity)
          .map(animation => animation.finished.catch(() => {})))
      })(),
    ])
  })
  const { data } = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
  await writeFile(join(outputPath, `${name}.png`), Buffer.from(data, 'base64'))
}

async function assertFloatingFeedback(selector) {
  const state = await evaluate(selector => {
    const layer = document.querySelector('.feedback-layer')
    const element = document.querySelector(selector)
    const rect = element?.getBoundingClientRect()
    return {
      layers: document.querySelectorAll('.feedback-layer').length,
      fixed: layer && getComputedStyle(layer).position === 'fixed',
      contained: !!element && !!layer?.contains(element),
      legacyBars: document.querySelectorAll('.global-progress, .toast-stack').length,
      fits: !!rect && rect.left >= -1 && rect.right <= innerWidth + 1 && rect.top >= -1 && rect.bottom <= innerHeight + 1,
      overflow: document.documentElement.scrollWidth > innerWidth + 1,
    }
  }, selector)
  assert.deepEqual(state, { layers: 1, fixed: true, contained: true, legacyBars: 0, fits: true, overflow: false }, `Feedback must float without overflowing: ${selector}`)
}

async function bounds(selector) {
  return evaluate(selector => {
    const { x, y, width, height } = document.querySelector(selector).getBoundingClientRect()
    return { x, y, width, height }
  }, selector)
}

async function reloadPage() {
  const loaded = new Promise(resolve => cdp.on('Page.loadEventFired', resolve))
  await cdp.send('Page.reload', { ignoreCache: true })
  await loaded
  await delay(25)
}

async function check(name, fn) {
  try {
    await fn()
    checks.push(name)
    console.log(`✓ ${name}`)
  } catch (error) {
    failures.push({ name, error: error.stack || error.message })
    await screenshot(`failure-${failures.length}`).catch(() => {})
    console.error(`✗ ${name}: ${error.message}`)
  }
}

try {
  const browserPath = await findBrowser()
  await mkdir(outputPath, { recursive: true })
  profile = await mkdtemp(join(tmpdir(), 'design-smoke-profile-'))
  server = await createServer({
    root: appRoot, configFile: false, base: '/',
    cacheDir: join(profile, 'vite-cache'),
    plugins: [react(), ...(authFixture ? [authFixture.plugin] : [])],
    // OAuth exercises the same installed SDK that the app bundles.
    resolve: { alias: authSmoke ? {} : { '@ducking-mind/proxy-app-sdk': join(appRoot, 'tests/fixtures/sdk-smoke.js') } },
    server: { host: '127.0.0.1', port: 0, hmr: false },
    logLevel: 'error',
  })
  await server.listen()
  const origin = server.resolvedUrls.local[0].replace(/\/$/, '')
  browser = spawn(browserPath, [
    '--headless=new', '--remote-debugging-port=0', '--no-first-run',
    '--no-default-browser-check', '--disable-background-networking', '--disable-component-update',
    '--disable-sync', '--disable-features=MediaRouter', '--window-size=1440,1000',
    `--user-data-dir=${profile}`, 'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] })
  const endpoint = await new Promise((resolve, reject) => {
    let output = ''
    const timer = setTimeout(() => reject(new Error(`Chrome startup timed out after ${browserStartupTimeout} ms: ${output.slice(-1000)}`)), browserStartupTimeout)
    browser.once('error', error => { clearTimeout(timer); reject(error) })
    browser.once('exit', code => { clearTimeout(timer); reject(new Error(`Chrome exited during startup (${code}): ${output.slice(-1000)}`)) })
    browser.stderr.on('data', chunk => {
      output = `${output}${chunk}`.slice(-8192)
      const match = output.match(/DevTools listening on (ws:\/\/[^\s]+)/)
      if (match) { clearTimeout(timer); resolve(match[1]) }
    })
  })
  const debugOrigin = new URL(endpoint).origin.replace('ws:', 'http:')
  const targets = await fetch(`${debugOrigin}/json/list`).then(response => response.json())
  cdp = await CDP.connect(targets.find(target => target.type === 'page').webSocketDebuggerUrl)
  cdp.on('Runtime.exceptionThrown', ({ exceptionDetails }) => {
    runtimeErrors.push(exceptionDetails.exception?.description || exceptionDetails.text)
  })
  cdp.on('Fetch.requestPaused', ({ requestId, request }) => {
    const allowed = request.url.startsWith(`${origin}/`) || /^(data:|blob:|about:)/.test(request.url)
    if (!allowed) blockedRequests.push(request.url)
    void cdp.send(allowed ? 'Fetch.continueRequest' : 'Fetch.failRequest',
      allowed ? { requestId } : { requestId, errorReason: 'BlockedByClient' }).catch(error => runtimeErrors.push(error.message))
  })
  await cdp.send('Runtime.enable')
  await cdp.send('Page.enable')
  await cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*' }] })
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false })
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: `(${(() => {
    window.__designSmoke = { requests: [], revoked: [], challenges: {} }
    const revoke = URL.revokeObjectURL
    URL.revokeObjectURL = function(url) {
      window.__designSmoke.revoked.push(url)
      return revoke.call(this, url)
    }
    // Observe only the rendered challenge; never weaken application validation.
    const labels = new WeakMap()
    const fillText = CanvasRenderingContext2D.prototype.fillText
    CanvasRenderingContext2D.prototype.fillText = function(text, ...args) {
      if (this.canvas.width === 440 && this.canvas.height === 150 && /^\d{6}$/.test(String(text))) labels.set(this.canvas, String(text))
      return fillText.call(this, text, ...args)
    }
    const toDataURL = HTMLCanvasElement.prototype.toDataURL
    HTMLCanvasElement.prototype.toDataURL = function(...args) {
      const value = toDataURL.apply(this, args)
      if (labels.has(this)) window.__designSmoke.challenges[value] = labels.get(this)
      return value
    }
  }).toString()})()` })
  if (authSmoke) {
    await runAuthChecks({ fixture: authFixture, origin, cdp, evaluate, waitFor, click, screenshot, check })
  } else {
  await cdp.send('Page.navigate', { url: origin })
  await waitFor(() => document.querySelector('[aria-label="模式导航"]') &&
    document.querySelector('[aria-label="商品套图图片模型"]')?.textContent.includes('Smoke 编辑模型'), 'Application did not initialize')

  await check('Product upload, removal, and reset release preview URLs', async () => {
    const input = '[aria-label="商品套图设置"] input[type="file"]'
    const preview = '[aria-label="商品套图设置"] .pk-photo img'
    const removed = await upload(input, preview)
    await click('[aria-label="移除商品图 1"]')
    await waitFor(url => !document.querySelector('[aria-label="移除商品图 1"]') && window.__designSmoke.revoked.includes(url), 'Removed product URL was not released', removed)
    const reset = await upload(input, preview)
    await click('[aria-label="新建任务"]')
    await waitFor(url => !document.querySelector('[aria-label="移除商品图 1"]') && window.__designSmoke.revoked.includes(url), 'Reset product URL was not released', reset)
  })

  await check('Model dropdown disables incompatible capabilities and supports keyboard navigation', async () => {
    await click('[aria-label="商品套图图片模型"]')
    const options = await evaluate(() => [...document.querySelectorAll('[role="option"]')].map(node => ({ text: node.textContent, disabled: node.getAttribute('aria-disabled') })))
    for (const name of ['缺少参考图能力', '仅文字生图', '不支持当前比例']) {
      assert.equal(options.find(option => option.text.includes(name))?.disabled, 'true', `${name} is disabled`)
    }
    await key('Home')
    await key('ArrowDown')
    await key('Enter')
    assert.equal(await evaluate(() => document.activeElement?.getAttribute('aria-label')), '商品套图图片模型')
    assert.equal(await evaluate(() => document.querySelector('[role="listbox"]')), null)
    assert.match(await evaluate(() => document.querySelector('[aria-label="商品套图图片模型"]').textContent), /Smoke 编辑模型/)
  })

  await check('All creation modules switch and clone previews release on remove/reset', async () => {
    await moduleTab(2, '[aria-label="详情页设置"]', { module: 'detail', view: 'studio' })
    await moduleTab(4, '[aria-label="复刻设置"]', { module: 'clone', view: 'studio' })
    const preview = '[aria-label="复刻设置"] .cm-photo img'
    const removed = await upload('[aria-label="上传参考图片"]', preview)
    await click('[aria-label="移除参考图片 1"]')
    await waitFor(url => !document.querySelector('[aria-label="移除参考图片 1"]') && window.__designSmoke.revoked.includes(url), 'Removed clone URL was not released', removed)
    const reset = await upload('[aria-label="上传参考图片"]', preview)
    await click('[aria-label="新建任务"]')
    await waitFor(url => !document.querySelector('[aria-label="移除参考图片 1"]') && window.__designSmoke.revoked.includes(url), 'Reset clone URL was not released', reset)
    await screenshot('clone-desktop')
  })

  await check('Restored try-on history renders inside the try-on canvas', async () => {
    // Reload resets the per-module view; the mock storage restores existing work.
    await reloadPage()
    await waitFor(() => document.querySelector('[aria-label="模式导航"]') &&
      document.querySelector('[aria-label="商品套图图片模型"]')?.textContent.includes('Smoke 编辑模型'), 'Account mock did not restore')
    await moduleTab(3, '[aria-label="拍摄设置"]', { module: 'tryon', view: 'studio' })
    await waitFor(() => document.querySelector('.collection-canvas .work img')?.alt === '已恢复的试穿作品', 'Restored try-on work did not reach the canvas')
    await screenshot('tryon-restored-desktop')
  })

  await check('Settings modal keeps its dropdown interactive and Escape closes in order', async () => {
    await click('[title="模型设置"]')
    await waitFor(() => document.querySelector('dialog[open]'), 'Settings dialog did not open')
    await click('[aria-label="全局图片模型"]')
    assert.equal(await evaluate(() => !!document.querySelector('dialog[open] [role="listbox"]')), true)
    assert.equal(await evaluate(() => [...document.querySelectorAll('[role="option"]')].find(node => node.textContent.includes('仅单张参考图'))?.getAttribute('aria-disabled')), 'true')
    await key('Escape')
    assert.equal(await evaluate(() => !!document.querySelector('dialog[open]') && !document.querySelector('[role="listbox"]')), true)
    await key('Escape')
    await waitFor(() => !document.querySelector('dialog[open]'), 'Escape did not dismiss settings dialog')
    assert.equal(await evaluate(() => document.activeElement?.getAttribute('aria-label')), '模型设置')
  })

  await check('Try-on generation shows new results and completes local quality checks', async () => {
    await click('[title="新建任务"]')
    await waitFor(() => document.querySelector('.tryon-canvas .example-workspace'), 'New task did not reset the try-on canvas')
    const garment = await upload('[aria-label="上传服装图片"]', '.garment-grid img')
    await click('[aria-label="移除服装 1"]')
    await waitFor(url => window.__designSmoke.revoked.includes(url), 'Removed garment URL was not released', garment)
    await upload('[aria-label="上传服装图片"]', '.garment-grid img')
    await click('.generate-footer .primary.full')
    await waitFor(() => document.querySelectorAll('.collection-canvas .work img').length === 3 &&
      !document.querySelector('[aria-label="新建任务"]').disabled, 'Try-on generation did not display all three results')
    const requests = await evaluate(() => window.__designSmoke.requests)
    assert.equal(requests.filter(path => path === '/images/edits').length, 3)
    assert.equal(requests.filter(path => path === '/responses').length, 4, 'One vision challenge and three quality checks')
    assert.equal(await evaluate(() => document.querySelectorAll('[role="alert"]').length), 0)
    await waitFor(() => JSON.parse(localStorage.getItem('design-ui-smoke-storage'))?.['design:works:v1']?.length === 4, 'Generated work was not persisted')
    await waitFor(() => Object.values(JSON.parse(localStorage.getItem('design-ui-smoke-storage')))
      .filter(value => value?.kind === 'tryon' && value?.quality?.status === 'passed').length === 3,
    'Completed quality reports were not persisted')
    const saved = await evaluate(() => Object.values(JSON.parse(localStorage.getItem('design-ui-smoke-storage'))).filter(value => value?.kind === 'tryon' && value?.quality))
    assert.equal(saved.length, 3)
    assert.ok(saved.every(work => work.quality.status === 'passed'))
    await screenshot('tryon-generated-desktop')
  })

  await check('Generated try-on results survive reload and render on a narrow viewport', async () => {
    // The previous check leaves the emulated viewport narrow. Restore a desktop
    // viewport before navigating so the top-level mode tabs remain reachable;
    // apply the narrow viewport after the restored try-on canvas is selected.
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false })
    await reloadPage()
    await waitFor(() => document.querySelector('[aria-label="模式导航"]') &&
      document.querySelector('[aria-label="商品套图图片模型"]')?.textContent.includes('Smoke 编辑模型'), 'Account mock did not restore')
    await moduleTab(3, '[aria-label="拍摄设置"]', { module: 'tryon', view: 'studio' })
    await waitFor(() => document.querySelectorAll('.collection-canvas .work img').length === 3, 'Generated try-on history was not restored')
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: false })
    await waitFor(() => document.documentElement.scrollWidth <= innerWidth + 1, 'Narrow viewport has horizontal overflow')
    await screenshot('tryon-mobile')
    await moduleTab(5, '.results-workspace', { module: 'tryon', view: 'works' })
    assert.equal(await evaluate(() => document.querySelectorAll('.workspace .work img').length), 4)
  })

  const openFeedbackCase = async controls => {
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false })
    await evaluate(controls => sessionStorage.setItem('design-smoke-controls', JSON.stringify(controls)), controls)
    await cdp.send('Page.navigate', { url: `${origin}/?feedback_case=${Date.now()}` })
    await waitFor(() => document.querySelector('[aria-label="模式导航"]'), 'Feedback case did not mount')
  }
  const resourcesReady = () => waitFor(() => !document.querySelector('.resource-loading-toast') &&
    document.querySelector('[aria-label="商品套图图片模型"]')?.textContent.includes('Smoke 编辑模型'), 'Feedback case did not restore resources')

  await check('Workspace loading floats above the page and model dialog without shifting either layout', async () => {
    await openFeedbackCase({ holds: ['models'] })
    await waitFor(() => document.querySelector('.resource-loading-toast') && window.__designSmoke.pending.includes('models'), 'Loading fixture did not pause')
    const page = await bounds('.app-body')
    await assertFloatingFeedback('.resource-loading-toast')
    await screenshot('workspace-loading-desktop')
    const feedbackStyle = () => evaluate(() => {
      const style = getComputedStyle(document.querySelector('.feedback-layer'))
      return { alignItems: style.alignItems, justifyContent: style.justifyContent, gap: style.gap, marginBottom: style.marginBottom, fontSize: style.fontSize }
    })
    const defaultStyle = await feedbackStyle()
    await click('[aria-label="预览商品原图示例"]')
    await waitFor(() => document.querySelector('.pk-dialog[open] .feedback-layer .resource-loading-toast'), 'Loading feedback did not follow the product preview')
    await assertFloatingFeedback('.resource-loading-toast')
    assert.deepEqual(await feedbackStyle(), defaultStyle, 'Product preview heading styles must not leak into the feedback host')
    await screenshot('workspace-loading-product-preview')
    await click('[aria-label="关闭商品预览"]')
    await waitFor(() => !document.querySelector('.pk-dialog[open]'), 'Product preview did not close')
    await click('[aria-label="模型设置"]')
    await waitFor(() => document.querySelector('dialog[open] .feedback-layer .resource-loading-toast'), 'Loading feedback did not follow the native dialog')
    const fields = await bounds('.model-dialog-fields')
    await assertFloatingFeedback('.resource-loading-toast')
    await evaluate(() => window.__designSmoke.release('models'))
    await resourcesReady()
    assert.deepEqual(await bounds('.model-dialog-fields'), fields, 'Resource loading must not change dialog content geometry')
    await key('Escape')
    await waitFor(() => !document.querySelector('dialog[open]'), 'Model dialog did not close')
    assert.deepEqual(await bounds('.app-body'), page, 'Resource loading must not push the workspace down')
  })

  await check('Resource errors remain floating, dismissible, and retryable inside model settings', async () => {
    await openFeedbackCase({ failures: ['models'] })
    await waitFor(() => document.querySelector('[aria-label="资源加载状态"]'), 'Resource error did not surface')
    await assertFloatingFeedback('[aria-label="资源加载状态"]')
    const page = await bounds('.app-body')
    await evaluate(() => { document.querySelector('.feedback-layer').dataset.smokeIdentity = 'resource-feedback' })
    await click('[aria-label="模型设置"]')
    await waitFor(() => document.querySelector('dialog[open] .feedback-layer [aria-label="资源加载状态"]'), 'Resource error was covered by the native dialog')
    assert.equal(await evaluate(() => document.querySelector('dialog[open] .feedback-layer')?.dataset.smokeIdentity), 'resource-feedback', 'Opening settings must move the existing feedback host')
    const fields = await bounds('.model-dialog-fields')
    await assertFloatingFeedback('[aria-label="资源加载状态"]')
    await screenshot('resource-error-settings-desktop')
    await click('[aria-label="关闭资源加载提示"]')
    await waitFor(() => !document.querySelector('[aria-label="资源加载状态"]'), 'Resource error close action was not clickable above the dialog')
    assert.deepEqual(await bounds('.model-dialog-fields'), fields, 'Closing an error must not shift the settings form')
    await key('Escape')
    assert.deepEqual(await bounds('.app-body'), page, 'Dismissing feedback must not shift the page')

    await openFeedbackCase({ failures: ['models'] })
    await waitFor(() => document.querySelector('[aria-label="资源加载状态"]'), 'Retry fixture did not surface')
    await click('[aria-label="模型设置"]')
    await waitFor(() => document.querySelector('dialog[open] .feedback-layer [aria-label="资源加载状态"]'), 'Retry feedback did not reach the dialog')
    await evaluate(() => {
      window.__designSmoke.controls.failures = []
      document.querySelector('.resource-toast-actions button').dataset.smokeRetry = 'true'
    })
    await click('[data-smoke-retry="true"]')
    await resourcesReady()
    await waitFor(() => !document.querySelector('[aria-label="资源加载状态"]'), 'Retry did not clear recovered resources')
    await key('Escape')
  })

  await check('Generation progress collapses without cancelling work and stops only on explicit request', async () => {
    await openFeedbackCase({ holds: ['responses'] })
    await resourcesReady()
    await upload('[aria-label="商品套图设置"] input[type="file"]', '[aria-label="商品套图设置"] .pk-photo img')
    const page = await bounds('.app-body')
    await click('.pk-submit')
    await waitFor(() => document.querySelector('.task-activity[aria-label="任务进度"]') && window.__designSmoke.pending.includes('responses'), 'Generation did not pause at local validation')
    await assertFloatingFeedback('.task-activity')
    assert.deepEqual(await bounds('.app-body'), page, 'Task progress must not add a row above the workspace')
    await screenshot('task-progress-desktop')
    await click('[aria-label="收起任务进度"]')
    await waitFor(() => document.querySelector('.task-activity-chip'), 'Progress did not collapse')
    assert.deepEqual(await evaluate(() => window.__designSmoke.aborted), [], 'Collapsing feedback must not cancel the task')
    assert.deepEqual(await evaluate(() => window.__designSmoke.pending), ['responses'])
    await assertFloatingFeedback('.task-activity-chip')
    await click('[aria-label="查看任务进度"]')
    await waitFor(() => document.querySelector('.task-activity'), 'Progress did not reopen')
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: false })
    await assertFloatingFeedback('.task-activity')
    await screenshot('task-progress-mobile')
    await click('[aria-label="停止后续生成"]')
    await waitFor(() => !document.querySelector('.task-activity, .task-activity-chip') && window.__designSmoke.aborted.includes('responses'), 'Explicit stop did not cancel the pending validation')
    assert.equal(await evaluate(() => window.__designSmoke.requests.filter(path => path === '/images/edits' || path === '/images/generations').length), 0, 'No image task may be submitted after cancellation')
    await waitFor(() => document.querySelector('.feedback-layer [role="alert"]'), 'Cancellation feedback did not surface')
    await assertFloatingFeedback('.feedback-layer [role="alert"]')
    await screenshot('task-stopped-mobile')
  })

  await check('Task feedback remains interactive above native dialogs and retains collapsed state when they close', async () => {
    await openFeedbackCase({ holds: ['responses'] })
    await resourcesReady()
    await click('[aria-label="模型设置"]')
    await waitFor(() => document.querySelector('dialog[open]'), 'Settings did not open for validation')
    await evaluate(() => [...document.querySelectorAll('dialog[open] button')].find(button => button.textContent === '校验图片理解能力')?.setAttribute('data-smoke-validate', 'true'))
    const fields = await bounds('.model-dialog-fields')
    await click('[data-smoke-validate="true"]')
    await waitFor(() => document.querySelector('dialog[open] .feedback-layer .task-activity') && window.__designSmoke.pending.includes('responses'), 'Validation progress did not float inside the dialog')
    await assertFloatingFeedback('.task-activity')
    assert.deepEqual(await bounds('.model-dialog-fields'), fields, 'Progress must not shift dialog form fields')
    await click('[aria-label="收起任务进度"]')
    await waitFor(() => document.querySelector('dialog[open] .task-activity-chip'), 'Progress inside dialog did not collapse')
    await key('Escape')
    await waitFor(() => !document.querySelector('dialog[open]') && document.querySelector('.task-activity-chip'), 'Closing dialog remounted or lost collapsed feedback')
    assert.deepEqual(await evaluate(() => window.__designSmoke.aborted), [], 'Closing settings must not stop pending validation')
    await click('[aria-label="查看任务进度"]')
    await click('[aria-label="停止后续生成"]')
    await waitFor(() => !document.querySelector('.task-activity, .task-activity-chip'), 'Validation did not stop from the relocated feedback')
    await assertFloatingFeedback('.feedback-layer [role="alert"]')
  })

  }
  assert.deepEqual(blockedRequests, [], 'No requests may leave the isolated local server')
  assert.deepEqual(runtimeErrors, [], 'No uncaught browser exceptions')
  await writeFile(join(outputPath, 'report.json'), JSON.stringify({ checks, failures, screenshots: outputPath, blockedRequests, runtimeErrors }, null, 2))
  assert.deepEqual(failures, [], 'Browser regression checks failed')
  console.log(`Passed ${checks.length} browser checks. Screenshots: ${outputPath}`)
} catch (error) {
  if (cdp) {
    await screenshot('failure').catch(() => {})
    const body = await evaluate(() => document.body.innerText).catch(() => '')
    await writeFile(join(outputPath, 'failure.txt'), `${error.stack}\n\n${body}\n\nBrowser errors:\n${runtimeErrors.join('\n')}`).catch(() => {})
  }
  console.error(error)
  process.exitCode = 1
} finally {
  if (cdp) cdp.socket.close()
  if (browser && browser.exitCode === null) {
    const exited = new Promise(resolve => browser.once('exit', resolve))
    browser.kill('SIGTERM')
    await Promise.race([exited, delay(2000)])
    if (browser.exitCode === null) browser.kill('SIGKILL')
    await Promise.race([exited, delay(2000)])
  }
  await server?.close()
  if (profile) await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
}
