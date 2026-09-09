#!/usr/bin/env node

import { spawn } from 'node:child_process'
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { dirname, join, resolve, sep } from 'node:path'
import { zipSync } from 'fflate'
import { createLocalDevelopmentRelay } from './local-dev-relay.mjs'

const MAX_BUNDLE_BYTES = 50 * 1024 * 1024
const ALLOWED_PERMISSIONS = new Set(['user.profile.read', 'storage.user', 'notification', 'theme.read', 'locale.read'])
const ALLOWED_APIS = new Set(['model.responses', 'model.chat', 'model.messages', 'model.embeddings', 'model.images', 'model.videos', 'model.music'])
const ALLOWED_PRICING_MODES = new Set(['free', 'one_time', 'commission'])
const ALLOWED_CATEGORIES = new Set(['productivity', 'creative', 'developer', 'data', 'communication', 'education', 'finance', 'other'])
const BUNDLE_IGNORED_FILES = new Set(['.proxy-app.json'])
const APP_WORKSPACE_PATH = '/portal/user/app-workspace'

function usage() {
  console.log(`Usage:
  proxy-app init <app-dir> [--name <name>]
  proxy-app create <app-dir> [--category productivity] [--description text]
  proxy-app link <app-dir> <app-id>
  proxy-app status <app-dir>
  proxy-app doctor <app-dir>
  proxy-app dev <app-dir> [--port <port>] [--legacy-bridge]
  proxy-app validate <app-dir>
  proxy-app build <app-dir>
  proxy-app pack <app-dir> [output.zip]
  proxy-app upload <app-dir> [output.zip]
  proxy-app publish <app-dir> [output.zip]

  Add --source to pack/upload only for local debugging; release packages require dist.
  Categories: productivity, creative, developer, data, communication, education, finance, other.

Publish environment:
  PROXY_API_BASE_URL  default: http://localhost:9003/api
  PROXY_USER_ACCESS_TOKEN  Current platform user session for app management/CI only; never passed to the app
  PROXY_ACCESS_TOKEN       Legacy alias for PROXY_USER_ACCESS_TOKEN

  Local development:
  proxy-app dev <app-dir> [--port 5173]
  Starts a real platform relay. The app opens platform login on first use;
  requests then use the signed-in user's App Session, models, routing, quota
  and billing. No separate developer identity or runtime credential exists.
  HTTP APIs are the default. --legacy-bridge enables v1 Bridge compatibility.

Platform verification:
  Build and pack the app, upload the ZIP, then publish the selected version.
`)
}

function option(args, name, fallback = '') {
  const index = args.indexOf(name)
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback
}

function outputArgument(args) {
  return args.slice(1).find((arg) => arg !== '--source') || undefined
}

function apiSettings() {
  const token = process.env.PROXY_USER_ACCESS_TOKEN || process.env.PROXY_ACCESS_TOKEN
  const baseURL = (process.env.PROXY_API_BASE_URL || 'http://localhost:9003/api').replace(/\/$/, '')
  if (!token) throw new Error('PROXY_USER_ACCESS_TOKEN is required for app management commands; it is never passed to the app runtime')
  return { token, baseURL }
}

function responseError(body, fallback) {
  const message = typeof body?.error === 'string' ? body.error : body?.error?.message || body?.message
  const code = body?.code || body?.error?.code
  return `${message || fallback}${code ? ` (${code})` : ''}`
}

async function apiJSON(path, init = {}) {
  const { token, baseURL } = apiSettings()
  const response = await fetch(`${baseURL}${path}`, { ...init, headers: { Authorization: `Bearer ${token}`, ...(init.headers || {}) } })
  const body = await response.json().catch(() => ({}))
  if (!response.ok) {
    const message = typeof body.error === 'string' ? body.error : body.error?.message || body.message
    const code = body.code || body.error?.code
    throw new Error(`${message || `request failed: HTTP ${response.status}`}${code ? ` (${code})` : ''}`)
  }
  return body.data || body
}

function safeRelative(value) {
  const normalized = String(value || '').replaceAll('\\', '/')
  if (!normalized || normalized.startsWith('/') || normalized.includes('\0')) throw new Error(`invalid relative path: ${value}`)
  if (normalized.split('/').some((part) => part === '..')) throw new Error(`path traversal is not allowed: ${value}`)
  return normalized.split('/').filter(Boolean).join('/')
}

async function exists(path) {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

async function readManifest(appDir) {
  let manifest
  try {
    manifest = JSON.parse(await readFile(join(appDir, 'manifest.json'), 'utf8'))
  } catch (error) {
    throw new Error(`manifest.json is missing or invalid: ${error.message}`)
  }
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) throw new Error('manifest must be a JSON object')
  if (manifest.schema !== 'proxy.app/v1') throw new Error('manifest.schema must be proxy.app/v1')
  if (!/^[a-z0-9]+(?:[.-][a-z0-9]+)+(?:[.-][a-z0-9]+)*$/.test(manifest.id || '')) throw new Error('manifest.id is invalid')
  if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(manifest.version || '')) throw new Error('manifest.version is invalid')
  if (typeof manifest.name !== 'string' || !manifest.name.trim()) throw new Error('manifest.name is required')
  if (manifest.runtime?.type !== 'iframe') throw new Error('manifest.runtime.type must be iframe')
  if (manifest.backend?.type !== 'platform') throw new Error('manifest.backend.type must be platform')
  if (!Array.isArray(manifest.permissions)) throw new Error('manifest.permissions must be an array')
  const permissions = new Set()
  for (const permission of manifest.permissions) {
    if (!ALLOWED_PERMISSIONS.has(permission)) throw new Error(`unsupported app permission: ${permission}`)
    if (permissions.has(permission)) throw new Error(`duplicate app permission: ${permission}`)
    permissions.add(permission)
  }
  if (manifest.apis !== undefined && !Array.isArray(manifest.apis)) throw new Error('manifest.apis must be an array')
  const apis = new Set()
  for (const api of manifest.apis || []) {
    if (!ALLOWED_APIS.has(api)) throw new Error(`unsupported app API: ${api}`)
    if (apis.has(api)) throw new Error(`duplicate app API: ${api}`)
    apis.add(api)
  }
  if (manifest.pricing !== undefined && (!manifest.pricing || typeof manifest.pricing !== 'object' || Array.isArray(manifest.pricing))) {
    throw new Error('manifest.pricing must be an object')
  }
  const pricing = manifest.pricing || { mode: 'free', currency: 'CNY' }
  const mode = pricing.mode || 'free'
  const oneTimePrice = pricing.one_time_price || 0
  const commissionRate = pricing.commission_rate || 0
  if (!ALLOWED_PRICING_MODES.has(mode)) throw new Error('manifest.pricing.mode must be free, one_time, or commission')
  if (!/^[A-Z]{3,10}$/.test(pricing.currency || 'CNY')) throw new Error('manifest.pricing.currency is invalid')
  if (!Number.isFinite(oneTimePrice) || !Number.isFinite(commissionRate) || oneTimePrice < 0 || commissionRate < 0) throw new Error('manifest.pricing values must be non-negative numbers')
  if (mode === 'free' && (oneTimePrice !== 0 || commissionRate !== 0)) throw new Error('free pricing requires zero one_time_price and commission_rate')
  if (mode === 'one_time' && (oneTimePrice <= 0 || commissionRate !== 0)) throw new Error('one_time pricing requires positive one_time_price and zero commission_rate')
  if (mode === 'commission' && (commissionRate <= 0 || commissionRate > 100 || oneTimePrice !== 0)) throw new Error('commission pricing requires commission_rate between 0 and 100 and zero one_time_price')
  const entry = safeRelative(manifest.runtime.entry)
  return { manifest, entry }
}

async function validateApp(appDir) {
  const root = resolve(appDir)
  const { manifest, entry } = await readManifest(root)
  const artifactRoot = (await exists(join(root, 'dist'))) ? join(root, 'dist') : root
  if (!(await exists(join(artifactRoot, entry)))) throw new Error(`runtime entry is missing: ${entry}`)
  if (artifactRoot !== root && /(?:src|href)=["']\//i.test(await readFile(join(artifactRoot, entry), 'utf8'))) {
    throw new Error("built entry contains root-relative assets; configure the bundler to emit relative URLs (Vite: base: './')")
  }
  if (manifest.assets?.icon && !(await exists(join(artifactRoot, safeRelative(manifest.assets.icon))))) {
    console.warn(`warning: manifest.assets.icon is missing: ${manifest.assets.icon}`)
  }
  return { root, artifactRoot, manifest, entry }
}

function run(command, args, cwd) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd, stdio: 'inherit', shell: process.platform === 'win32' })
    child.on('error', reject)
    child.on('exit', (code, signal) => code === 0 ? resolvePromise() : reject(new Error(`${command} exited with ${code ?? signal}`)))
  })
}

function runChild(command, args, cwd, env) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: 'inherit', shell: process.platform === 'win32' })
    const stop = () => child.kill('SIGTERM')
    process.once('SIGINT', stop)
    process.once('SIGTERM', stop)
    child.on('error', reject)
    child.on('exit', (code, signal) => {
      process.removeListener('SIGINT', stop)
      process.removeListener('SIGTERM', stop)
      if (code === 0 || signal === 'SIGINT' || signal === 'SIGTERM') resolvePromise()
      else reject(new Error(`${command} exited with ${code ?? signal}`))
    })
  })
}

async function devApp(appDir, args) {
  const root = resolve(appDir)
  const { manifest } = await readManifest(root)
  const supportedOptions = new Set(['--port', '--legacy-bridge'])
  for (const arg of args) {
    if (arg.startsWith('--') && !supportedOptions.has(arg)) {
      throw new Error(`unsupported dev option: ${arg}; local development always uses the real platform`)
    }
  }
  const binding = await projectBinding(root)
  if (binding.slug !== manifest.id) throw new Error('应用标识与本地绑定不一致，请先运行 proxy-app link 或重新创建应用')
  const requestedPort = option(args, '--port', process.env.PROXY_APP_DEV_PORT || '5173')
  if (!/^\d+$/.test(requestedPort) || Number(requestedPort) < 1 || Number(requestedPort) > 65535) throw new Error('--port must be between 1 and 65535')
  const entryURL = process.env.PROXY_APP_DEV_URL || `http://127.0.0.1:${requestedPort}/`
  let parsedEntryURL
  try { parsedEntryURL = new URL(entryURL) } catch { throw new Error('PROXY_APP_DEV_URL must be a valid loopback http(s) URL') }
  if (!['http:', 'https:'].includes(parsedEntryURL.protocol) || !['localhost', '127.0.0.1', '::1'].includes(parsedEntryURL.hostname) || parsedEntryURL.username || parsedEntryURL.password) {
    throw new Error('PROXY_APP_DEV_URL must use localhost, 127.0.0.1, or ::1 without credentials')
  }
  const relaySecret = randomUUID()
  const baseURL = (process.env.PROXY_API_BASE_URL || 'http://localhost:9003/api').replace(/\/$/, '')
  const portalURL = process.env.PROXY_PORTAL_URL || process.env.PROXY_PUBLIC_URL || 'http://localhost:9004'
  const legacyBridge = args.includes('--legacy-bridge')
  const relay = await createLocalDevelopmentRelay({
    baseURL,
    portalURL,
    relaySecret,
    appID: binding.app_id,
    appSlug: manifest.id,
    version: manifest.version,
    manifest,
    entryURL,
    legacyBridge,
  })
  const {
    PROXY_USER_ACCESS_TOKEN: _userToken,
    PROXY_ACCESS_TOKEN: _legacyToken,
    PROXY_API_BASE_URL: _apiBaseURL,
    PROXY_PORTAL_URL: _portalURL,
    PROXY_PUBLIC_URL: _publicURL,
    PROXY_APP_DEV_URL: _entryURL,
    PROXY_APP_DEV_PORT: _devPort,
    PROXY_PLATFORM_GATEWAY_URL: _gatewayURL,
    PROXY_PLATFORM_RUNTIME_URL: _runtimeURL,
    PROXY_PLATFORM_BRIDGE_URL: _bridgeURL,
    PROXY_PLATFORM_AUTH_URL: _authURL,
    PROXY_PLATFORM_RELAY_SECRET: _inheritedRelaySecret,
    ...safeChildEnv
  } = process.env
  const childEnv = {
    ...safeChildEnv,
    PROXY_PLATFORM_GATEWAY_URL: `${relay.relayURL}/v1`,
    ...(!legacyBridge ? { PROXY_PLATFORM_RUNTIME_URL: `${relay.relayURL}/api/app-runtime/v1` } : { PROXY_PLATFORM_BRIDGE_URL: `${relay.relayURL}/bridge` }),
    PROXY_PLATFORM_AUTH_URL: `${relay.relayURL}/auth`,
    PROXY_PLATFORM_RELAY_SECRET: relaySecret,
  }
  console.log(`Proxy App platform relay ready: ${relay.relayURL}`)
  console.log(`Local app: ${entryURL}`)
  console.log(`Runtime transport: ${legacyBridge ? 'legacy Bridge compatibility' : 'same-origin HTTP (/v1, /api/app-runtime/v1)'}`)
  console.log('Platform mode: sign in from the app to use real models, provider routing, quota and billing.')
  try {
    await runChild('npm', ['run', 'dev', '--', '--host', '127.0.0.1', '--port', requestedPort, '--strictPort'], root, childEnv)
  } finally {
    await relay.close()
  }
}

async function packApp(appDir, output, { allowSource = false } = {}) {
  const info = await validateApp(appDir)
  if (info.artifactRoot === info.root && !allowSource) {
    throw new Error('build output is missing; run proxy-app build before packing (use --source only for local debugging)')
  }
  const outputPath = resolve(output || join(info.root, `${info.manifest.id}-${info.manifest.version}.zip`))
  const files = {}
  const collect = async (directory, prefix = '') => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (['node_modules', '.git', 'dist'].includes(entry.name) || BUNDLE_IGNORED_FILES.has(entry.name) || entry.name.endsWith('.zip')) continue
      if (entry.name === '.env' || entry.name.startsWith('.env.') || entry.name === '.npmrc') {
        throw new Error(`sensitive file cannot be included in app bundle: ${entry.name}`)
      }
      if (entry.isSymbolicLink()) throw new Error(`symbolic links are not allowed in app bundles: ${entry.name}`)
      const absolute = join(directory, entry.name)
      const archivePath = prefix ? `${prefix}/${entry.name}` : entry.name
      if (entry.isDirectory()) await collect(absolute, archivePath)
      else files[archivePath] = new Uint8Array(await readFile(absolute))
    }
  }
  if (info.artifactRoot === info.root) await collect(info.root)
  else await collect(info.artifactRoot)
  files['manifest.json'] = new Uint8Array(await readFile(join(info.root, 'manifest.json')))
  const bundle = zipSync(files, { level: 9 })
  if (bundle.length > MAX_BUNDLE_BYTES) throw new Error(`bundle is larger than ${MAX_BUNDLE_BYTES} bytes`)
  await mkdir(dirname(outputPath), { recursive: true })
  await writeFile(outputPath, bundle)
  console.log(JSON.stringify({ output: outputPath, id: info.manifest.id, version: info.manifest.version, size: bundle.length, sha256: createHash('sha256').update(bundle).digest('hex') }, null, 2))
  return { ...info, outputPath }
}

async function writeProject(root, app) {
  await mkdir(join(root, 'src'), { recursive: true })
  await writeFile(join(root, 'manifest.json'), JSON.stringify({ schema: 'proxy.app/v1', id: app.slug, version: '0.1.0', name: app.name, description: app.description || '', runtime: { type: 'iframe', entry: 'index.html' }, permissions: [], apis: [], backend: { type: 'platform' }, pricing: { mode: 'free', currency: 'CNY' } }, null, 2) + '\n')
  await writeFile(join(root, 'index.html'), '<!doctype html>\n<html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Proxy App</title></head><body><main id="app"></main><script type="module" src="/src/main.ts"></script></body></html>\n')
  await writeFile(join(root, 'src', 'main.ts'), `import { createAppClient } from '@ducking-mind/proxy-app-sdk'\n\nconst client = createAppClient(${JSON.stringify(app.slug)}, { localDevelopment: import.meta.env.DEV, localAppVersion: '0.1.0' })\nconst root = document.querySelector<HTMLElement>('#app')\nif (root) root.textContent = ${JSON.stringify(app.name)}\nvoid client.platform.capabilities().then(console.log)\n`)
  await writeFile(join(root, 'vite.config.ts'), "import { defineConfig } from 'vite'\nimport { createPlatformDevProxy } from '@ducking-mind/proxy-app-sdk/vite'\n\nexport default defineConfig({\n  base: './',\n  server: {\n    host: '127.0.0.1',\n    proxy: createPlatformDevProxy(),\n  },\n})\n")
  await writeFile(join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { target: 'ES2020', module: 'ESNext', moduleResolution: 'Bundler', strict: true, lib: ['ES2020', 'DOM'], types: ['vite/client'], noEmit: true }, include: ['src', 'vite.config.ts'] }, null, 2) + '\n')
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: app.slug.replaceAll('.', '-'), private: true, type: 'module', scripts: { dev: 'vite', typecheck: 'tsc --noEmit', build: 'npm run typecheck && vite build' }, dependencies: { '@ducking-mind/proxy-app-sdk': '^0.1.0' }, devDependencies: { typescript: '^5.2.2', vite: '^8.2.2' } }, null, 2) + '\n')
}

async function replaceIdentifier(root, previous, next) {
  const sourceRoot = join(root, 'src')
  if (!(await exists(sourceRoot))) return
  const walk = async (directory) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const target = join(directory, entry.name)
      if (entry.isDirectory()) await walk(target)
      else if (/\.(?:js|jsx|ts|tsx)$/.test(entry.name)) {
        const source = await readFile(target, 'utf8')
        if (source.includes(previous)) await writeFile(target, source.replaceAll(previous, next))
      }
    }
  }
  await walk(sourceRoot)
}

async function initApp(appDir, args) {
  const root = resolve(appDir)
  if (await exists(root) && (await exists(join(root, 'manifest.json')) || await exists(join(root, 'package.json')))) {
    throw new Error(`directory already contains an app: ${root}`)
  }
  const name = option(args, '--name', root.split(sep).pop() || 'Proxy App')
  const app = { id: '', slug: `app.proxy.local.${randomUUID().replaceAll('-', '').slice(0, 16)}`, name, description: '' }
  await writeProject(root, app)
  console.log(JSON.stringify({ created: root, local_identifier: app.slug, next: [`cd ${root}`, 'npm install', `proxy-app create ${root}`, `proxy-app dev ${root}`, 'npm run build'] }, null, 2))
}

async function createApp(appDir, args) {
  const root = resolve(appDir)
  if (await exists(join(root, '.proxy-app.json'))) throw new Error('app is already linked; run proxy-app status to inspect it')
  const { manifest } = await readManifest(root)
  const localIdentifier = manifest.id
  const name = option(args, '--name', manifest.name || root.split(sep).pop() || 'Proxy App')
  const category = option(args, '--category', 'productivity')
  if (!ALLOWED_CATEGORIES.has(category)) throw new Error(`unsupported app category: ${category}`)
  const app = await apiJSON(APP_WORKSPACE_PATH, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, description: option(args, '--description', manifest.description || ''), category }) })
  if (!app || typeof app.id !== 'string' || typeof app.slug !== 'string' || !/^[a-z0-9]+(?:[.-][a-z0-9]+)+(?:[.-][a-z0-9]+)*$/.test(app.slug)) {
    throw new Error('platform returned an invalid app binding; expected id and lowercase reverse-domain slug')
  }
  manifest.id = app.slug
  await writeFile(join(root, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n')
  await replaceIdentifier(root, localIdentifier, app.slug)
  await writeFile(join(root, '.proxy-app.json'), JSON.stringify({ app_id: app.id, slug: app.slug }, null, 2) + '\n')
  console.log(JSON.stringify({ created: root, app_id: app.id, app_identifier: app.slug, next: [`proxy-app upload ${root}`] }, null, 2))
}

async function linkApp(appDir, appID) {
  const root = resolve(appDir)
  const result = await apiJSON(APP_WORKSPACE_PATH)
  const app = (result.items || []).find((item) => item.id === appID)
  if (!app) throw new Error(`application not found: ${appID}`)
  const manifestPath = join(root, 'manifest.json')
  const { manifest } = await readManifest(root)
  if (typeof app.slug !== 'string' || !/^[a-z0-9]+(?:[.-][a-z0-9]+)+(?:[.-][a-z0-9]+)*$/.test(app.slug)) {
    throw new Error(`application has an invalid identifier: ${app.slug || '(missing)'}`)
  }
  const previous = manifest.id
  manifest.id = app.slug
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n')
  await replaceIdentifier(root, previous, app.slug)
  await writeFile(join(root, '.proxy-app.json'), JSON.stringify({ app_id: app.id, slug: app.slug }, null, 2) + '\n')
  console.log(JSON.stringify({ linked: root, app_id: app.id, app_identifier: app.slug }, null, 2))
}

async function projectBinding(appDir) {
  try {
    const config = JSON.parse(await readFile(join(resolve(appDir), '.proxy-app.json'), 'utf8'))
    if (typeof config.app_id === 'string' && config.app_id && typeof config.slug === 'string' && /^[a-z0-9]+(?:[.-][a-z0-9]+)+(?:[.-][a-z0-9]+)*$/.test(config.slug)) return config
  } catch {}
  throw new Error('app binding is missing or invalid; run proxy-app create or proxy-app link first')
}

async function projectAppID(appDir) {
  return (await projectBinding(appDir)).app_id
}

async function developerApp(appDir) {
  const appID = await projectAppID(appDir)
  const result = await apiJSON(APP_WORKSPACE_PATH)
  const app = (result.items || []).find((item) => item.id === appID)
  if (!app) throw new Error(`linked application was not found: ${appID}`)
  return app
}

async function submitAppVersion(appID, manifest) {
  const { token, baseURL } = apiSettings()
  const submit = await fetch(`${baseURL}${APP_WORKSPACE_PATH}/${encodeURIComponent(appID)}/versions/${encodeURIComponent(manifest.version)}/submit`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ pricing_mode: manifest.pricing?.mode || 'free', one_time_price: manifest.pricing?.one_time_price || 0, commission_rate: manifest.pricing?.commission_rate || 0, currency: manifest.pricing?.currency || 'CNY' }) })
  const submitBody = await submit.json().catch(() => ({}))
  if (!submit.ok) throw new Error(responseError(submitBody, `submit failed: HTTP ${submit.status}`))
  return submitBody.data || submitBody
}

async function uploadApp(appDir, output, options = {}) {
  const binding = await projectBinding(appDir)
  const { token, baseURL } = apiSettings()
  const bundleInfo = await packApp(appDir, output, options)
  if (binding.slug !== bundleInfo.manifest.id) {
    throw new Error('应用标识不匹配，请先同步当前应用绑定，再重新 build 和 pack。')
  }
  const bundle = await readFile(bundleInfo.outputPath)
  const form = new FormData(); form.append('file', new Blob([bundle], { type: 'application/zip' }), `${bundleInfo.manifest.id}-${bundleInfo.manifest.version}.zip`)
  const response = await fetch(`${baseURL}${APP_WORKSPACE_PATH}/${encodeURIComponent(binding.app_id)}/versions`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form })
  const body = await response.json().catch(() => ({})); if (!response.ok) throw new Error(responseError(body, `upload failed: HTTP ${response.status}`))
  console.log(JSON.stringify({ uploaded: body.data || body, next: `proxy-app publish ${appDir}` }, null, 2))
  return body.data || body
}

async function publishApp(appDir, output) {
  const info = await validateApp(appDir)
  const remoteApp = await developerApp(appDir)
  if (remoteApp.slug !== info.manifest.id) {
    throw new Error('应用标识不匹配，请先同步当前应用绑定，再重新 build 和 pack。')
  }
  let version = (remoteApp.versions || []).find((item) => item.version === info.manifest.version)
  let uploaded = null
  if (!version) {
    uploaded = await uploadApp(appDir, output)
    version = uploaded
  }
  if (['review', 'published'].includes(version.review_status)) {
    console.log(JSON.stringify({ submitted: false, reason: `version is already ${version.review_status}`, app_id: remoteApp.id, version: info.manifest.version }, null, 2))
    return
  }
  if (!['draft', 'rejected'].includes(version.review_status)) throw new Error(`version cannot be submitted from status: ${version.review_status || 'unknown'}`)
  const submitted = await submitAppVersion(remoteApp.id, info.manifest)
  console.log(JSON.stringify({ uploaded, submitted, app_id: remoteApp.id, version: info.manifest.version }, null, 2))
}

async function statusApp(appDir) {
  const root = resolve(appDir)
  const { manifest } = await readManifest(root)
  let binding = null
  try { binding = JSON.parse(await readFile(join(root, '.proxy-app.json'), 'utf8')) } catch {}
  if (!binding?.app_id) {
    console.log(JSON.stringify({ linked: false, local_identifier: manifest.id, version: manifest.version, next: `proxy-app create ${appDir}` }, null, 2))
    return
  }
  const app = await developerApp(root)
  const version = (app.versions || []).find((item) => item.version === manifest.version)
  console.log(JSON.stringify({ linked: true, app_id: app.id, app_identifier: app.slug, app_status: app.status, local_version: manifest.version, remote_version: version || null }, null, 2))
}

async function doctorApp(appDir) {
  const root = resolve(appDir)
  const checks = []
  const major = Number(process.versions.node.split('.')[0])
  checks.push({ name: 'node', ok: major >= 20, detail: process.version })
  try {
    const info = await validateApp(root)
    checks.push({ name: 'manifest', ok: true, detail: `${info.manifest.id}@${info.manifest.version}` })
    checks.push({ name: 'build', ok: info.artifactRoot !== info.root, detail: info.artifactRoot !== info.root ? 'dist found' : 'dist not found; run proxy-app build' })
  } catch (error) {
    checks.push({ name: 'manifest', ok: false, detail: error.message })
  }
  try {
    const config = JSON.parse(await readFile(join(root, '.proxy-app.json'), 'utf8'))
    checks.push({ name: 'binding', ok: Boolean(config.app_id && config.slug), detail: config.app_id || 'invalid .proxy-app.json' })
  } catch {
    checks.push({ name: 'binding', ok: false, detail: 'not linked; create or link before upload' })
  }
  const valid = checks.every((item) => item.ok)
  console.log(JSON.stringify({ ok: valid, ready_for_upload: valid, checks }, null, 2))
  if (!valid) process.exitCode = 1
}

const [, , command, ...args] = process.argv
try {
  if (!command || command === '--help' || command === '-h') usage()
  else if (command === 'dev') await devApp(args[0] || '.', args.slice(1))
  else if (command === 'init') await initApp(args[0] || '.', args.slice(1))
  else if (command === 'create') {
    if (!args[0]) throw new Error('create requires <app-dir>')
    await createApp(args[0], args.slice(1))
  }
  else if (command === 'link') {
    if (!args[1]) throw new Error('link requires <app-dir> <app-id>')
    await linkApp(args[0], args[1])
  }
  else if (command === 'status') await statusApp(args[0] || '.')
  else if (command === 'doctor') await doctorApp(args[0] || '.')
  else if (command === 'validate') {
    const info = await validateApp(args[0] || '.')
    console.log(JSON.stringify({ valid: true, id: info.manifest.id, version: info.manifest.version, entry: info.entry }, null, 2))
  } else if (command === 'build') {
    await run('npm', ['run', 'build'], resolve(args[0] || '.'))
    await validateApp(args[0] || '.')
  } else if (command === 'pack') await packApp(args[0] || '.', outputArgument(args), { allowSource: args.includes('--source') })
  else if (command === 'upload') {
    if (!args[0]) throw new Error('upload requires <app-dir>')
    await uploadApp(args[0], outputArgument(args), { allowSource: args.includes('--source') })
  }
  else if (command === 'publish') {
    if (!args[0]) throw new Error('publish requires <app-dir>')
    await publishApp(args[0], args[1])
  } else {
    usage()
    throw new Error(`unknown command: ${command}`)
  }
} catch (error) {
  console.error(`proxy app: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
}
