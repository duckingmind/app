#!/usr/bin/env node

import { spawn } from 'node:child_process'
import { lstat, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { dirname, join, resolve, sep } from 'node:path'
import { createServer as createTCPServer } from 'node:net'
import { zipSync } from 'fflate'
import { createLocalDevelopmentRelay } from './local-dev-relay.mjs'
import { createLocalCredentialStore } from './local-dev-credentials.mjs'
import { assertSafeArtifactFile, assertSafeArtifactDirectory } from './artifact-security.mjs'
import { readLocalFunctionSources } from './runtime-sources.mjs'
import { resolveAgentContract } from './agent-contract.mjs'
import { DEFAULT_PLATFORM_GATEWAY_URL, platformAPIBaseURL, platformPortalURL } from './platform-settings.mjs'
import { createBackendContainerSpec, dockerClientEnvironment, verifyDockerEngine } from './backend-container.mjs'

const MAX_BUNDLE_BYTES = 50 * 1024 * 1024
const APP_BACKEND_TYPES = new Set(['platform', 'container'])
const APP_CONTAINER_RUNTIME = 'node22'
const APP_BACKEND_DEV_PATH = '/api'
const ALLOWED_PERMISSIONS = new Set(['user.profile.read', 'platform.capabilities.read', 'storage.user', 'notification', 'theme.read', 'locale.read'])
const ALLOWED_APIS = new Set(['model.responses', 'model.chat', 'model.messages', 'model.embeddings', 'model.images', 'model.videos', 'model.music', 'model.voice_design', 'model.tts'])
const ALLOWED_PRICING_MODES = new Set(['commission'])
const ALLOWED_CATEGORIES = new Set(['ecommerce', 'comic', 'other'])
const RESERVED_AGENT_NAMESPACES = new Set(['app', 'codex', 'desktop', 'proxy', 'system'])
const BUNDLE_IGNORED_FILES = new Set(['.proxy-app.json', '.proxy-app-session.json', '.proxy-app-build', '.proxy-app-runtime'])
const APP_WORKSPACE_PATH = '/portal/user/app-workspace'
// Public slugs are used verbatim, including single-segment names such as
// "canvas". The platform's opaque app_id remains a separate compatibility
// format; accepting a slug must not reinterpret it as that durable identity.
const PLATFORM_APP_ID_PATTERN = /^app_[a-z0-9][a-z0-9._-]{2,119}$/
const PUBLIC_APP_SLUG_PATTERN = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/
const validPublicAppSlug = value => typeof value === 'string' && value.length <= 120 && value === value.trim() && PUBLIC_APP_SLUG_PATTERN.test(value)
const validAppIdentifier = value => typeof value === 'string' && value === value.trim() && (PLATFORM_APP_ID_PATTERN.test(value) || validPublicAppSlug(value))
const publicAppAliases = app => Array.isArray(app?.app_aliases) ? app.app_aliases.filter(validPublicAppSlug) : []
const matchesAppIdentity = (identifier, appID, slug, aliases = []) => identifier === appID
  || validPublicAppSlug(identifier) && (identifier === slug || aliases.includes(identifier))
const appBinding = app => ({
  app_id: app.id, slug: app.slug,
  ...(publicAppAliases(app).length ? { app_aliases: publicAppAliases(app) } : {}),
})

const { normalizeManifestAgent } = await import(new URL('./agent-runtime/protocol.mjs', import.meta.url))
const { loadAgentPackage, copyAgentPackage } = await import(new URL('./agent-runtime/package-guide.mjs', import.meta.url))

function usage() {
  console.log(`在应用目录内，常用命令：
  proxy-app dev       开发授权与检查通过后启动应用
  proxy-app pack      重新构建 → 校验 → 生成 ZIP
  proxy-app upload    重新构建、打包并上传待发布版本，不切换线上版本
  proxy-app publish   手动发布当前 manifest 版本；缺少上传产物时先构建上传
  proxy-app publish --version 0.1.0   切换到已上传版本，也可回滚

首次使用：proxy-app init <app-dir>，安装依赖后运行 proxy-app create。
  应用开发使用 manifest.id 中的公开 slug；管理命令仍可使用 app_id。
pack 无需提前执行 build 或 validate；已上传的版本由 publish 直接推进发布。

完整命令（app-dir 默认当前目录）：
  proxy-app init [app-dir] [--name <name>]
  proxy-app create [app-dir] [--name <name>] [--category other] [--description text]
  proxy-app status [app-dir]
  proxy-app doctor [app-dir]
  proxy-app dev [app-dir] [--port <port>] [--no-auth-cache]
  proxy-app validate [app-dir]
  proxy-app build [app-dir]
  proxy-app pack [app-dir] [-o <output.zip>]
  proxy-app upload [app-dir] [-o <output.zip>]
  proxy-app publish [app-dir] [-o <output.zip> | --version <uploaded-version>]

  upload 只上传；publish 显式切换线上版本。首次使用 publish 仍需申请应用开放。
  --version 仅选择已上传版本，不构建、不上传、不修改本地 manifest。
  backend.type=container 仅支持本地联调；云端构建和容器路由尚未开放。
  容器后端本地运行需要已启动的 Docker Engine；服务进程在只读、非特权 Node 22 容器中启动。
  -o 与 --output 等价，也兼容原来的 <app-dir> <output.zip> 写法。
  --source 仅供 pack/upload 调试源码，跳过构建，不用于正式发布。
  应用分类：ecommerce（电商）、comic（漫剧）、other（其他，默认）。

Publish environment:
  PROXY_PLATFORM_URL  Optional single-origin platform URL; derives API (/api) and login Portal
  PROXY_API_BASE_URL  default: https://www.duckingmind.com/api
                       Optional override when the platform uses a separate API host
  PROXY_PORTAL_URL    Optional login Portal override; default: https://www.duckingmind.com
  PROXY_PLATFORM_GATEWAY_URL  Gateway target for Vite /v1 proxy; default: ${DEFAULT_PLATFORM_GATEWAY_URL}
  PROXY_USER_ACCESS_TOKEN  Platform user session for management, CI or developer authorization; never passed to the app
  PROXY_ACCESS_TOKEN       Legacy alias for PROXY_USER_ACCESS_TOKEN

  Local development:
  proxy-app dev <app-dir> [--port 5173]
  An explicitly requested occupied port fails with a clear error; the default port may advance automatically.
  Checks the app binding and developer permission before starting the app.
  First authorize the developer using the terminal login URL; then app users
  sign in separately for their own App Session, models, quota and billing.
  App business traffic always uses the App Session Gateway (/v1). Vite sends
  /v1 directly to the Gateway; set PROXY_PLATFORM_GATEWAY_URL only when using
  a different Gateway environment. Runtime user sessions stay in the browser;
  the local authorization callback handles developer setup only.
  macOS stores developer authorization in Keychain.
  --no-auth-cache uses memory only. If a cached developer account cannot access
  the app, dev automatically asks you to authorize with the app creator account.

Platform verification:
  Publish builds and uploads new candidates before requesting application opening.
  Once the application is open, later versions publish without another review.
`)
}

function option(args, name, fallback = '') {
  const index = args.indexOf(name)
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback
}

function reservePort(port) {
  return new Promise((resolvePromise, reject) => {
    // A platform health check or browser may connect while this socket reserves
    // the selected port. Destroy probes immediately so server.close() cannot
    // wait forever for a connection the temporary listener never serves.
    const server = createTCPServer((socket) => socket.destroy())
    let settled = false
    const settle = (callback, value) => {
      if (settled) return
      settled = true
      callback(value)
    }
    server.once('error', (error) => {
      if (error?.code === 'EADDRINUSE') settle(resolvePromise, null)
      else settle(reject, error)
    })
    server.listen({ host: '127.0.0.1', port, exclusive: true }, () => {
      settle(resolvePromise, {
        port,
        release: () => {
          if (!server.listening) return Promise.resolve()
          return new Promise((resolveClose) => server.close(() => resolveClose()))
        },
      })
    })
  })
}

async function reserveAvailablePort(startPort) {
  for (let port = startPort; port <= 65535; port += 1) {
    const reservation = await reservePort(port)
    if (reservation) return reservation
  }
  throw new Error(`从端口 ${startPort} 开始没有可用的本地端口`)
}

function commandArguments(command, args) {
  const configurations = {
    init: { values: ['--name'], max: 1 },
    create: { values: ['--name', '--category', '--description'], max: 1 },
    repair: { max: 2 }, link: { max: 2 }, status: { max: 1 }, doctor: { max: 1 },
    validate: { max: 1 }, build: { max: 1 },
    dev: { values: ['--port'], flags: ['--no-auth-cache'], max: 1 },
    pack: { values: ['--output'], flags: ['--source'], max: 2 },
    upload: { values: ['--output'], flags: ['--source'], max: 2 },
    publish: { values: ['--output', '--version'], max: 2 },
  }
  const config = configurations[command]
  if (!config) throw new Error(`unknown command: ${command}`)
  const positional = []
  const options = []
  const seen = new Set()
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--') { positional.push(...args.slice(i + 1)); break }
    if (!arg.startsWith('-')) { positional.push(arg); continue }
    const key = arg === '-o' ? '--output' : arg
    if (![...(config.values || []), ...(config.flags || [])].includes(key)) {
      throw new Error(`unsupported ${command} option: ${arg}${command === 'dev' ? '; local development always uses the real platform' : ''}`)
    }
    if (seen.has(key)) throw new Error(`duplicate option: ${key}`)
    seen.add(key)
    options.push(key)
    if (config.values?.includes(key)) {
      if (args[i + 1] === undefined || args[i + 1].startsWith('-') || !args[i + 1].trim()) throw new Error(`missing value for ${arg}`)
      options.push(args[++i])
    }
  }
  if (positional.length > config.max) throw new Error(`too many arguments for ${command}`)
  if (command === 'repair') {
    if (!positional.length) return { appDir: '.', appID: '', options }
    return { appDir: positional.length === 2 ? positional[0] : '.', appID: positional.at(-1), options }
  }
  if (command === 'link') {
    if (!positional.length) return { appDir: '.', appID: '', options }
    return { appDir: positional.length === 2 ? positional[0] : '.', appID: positional.at(-1), options }
  }
  const output = option(options, '--output') || positional[1]
  if (seen.has('--output') && positional[1]) throw new Error('specify output once: use --output or the positional output path')
  if (command === 'publish' && seen.has('--version')) {
    if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(option(options, '--version'))) throw new Error('--version must be a valid version such as 0.1.0')
    if (output) throw new Error('--version selects an uploaded version without building; do not specify an output path')
  }
  return { appDir: positional[0] || '.', output, options }
}

function apiSettings() {
  const token = process.env.PROXY_USER_ACCESS_TOKEN || process.env.PROXY_ACCESS_TOKEN
  const baseURL = platformAPIBaseURL()
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

function validateBackendManifest(backend) {
  if (backend === undefined || backend?.type === undefined || backend?.type === 'platform') return
  if (!APP_BACKEND_TYPES.has(backend.type)) throw new Error('manifest.backend.type must be platform or container')
  if (backend.type !== 'container') return
  const supportedFields = new Set(['type', 'runtime', 'entry', 'port', 'health_check', 'routes', 'resources'])
  for (const name of Object.keys(backend)) {
    if (!supportedFields.has(name)) throw new Error(`unsupported manifest.backend field: ${name}`)
  }
  if (backend.runtime !== APP_CONTAINER_RUNTIME) throw new Error(`manifest.backend.runtime must be ${APP_CONTAINER_RUNTIME}`)
  if (typeof backend.entry !== 'string') throw new Error('manifest.backend.entry is required for container backends')
  let entry
  try {
    entry = safeRelative(backend.entry)
  } catch (error) {
    throw new Error(`manifest.backend.entry is invalid: ${error.message}`)
  }
  if (backend.entry.replaceAll('\\', '/') !== entry) {
    throw new Error('manifest.backend.entry must be a normalized relative path')
  }
  if (!entry.startsWith('server/')) throw new Error('manifest.backend.entry must be inside server/')
  if (entry.split('/').some((part) => part === '.' || part === '')) throw new Error('manifest.backend.entry must be a normalized relative path')
  if (!['.js', '.mjs', '.cjs'].includes(entry.slice(entry.lastIndexOf('.')).toLowerCase())) {
    throw new Error('manifest.backend.entry must be a JavaScript file (.js, .mjs, or .cjs)')
  }
  if (!Number.isInteger(backend.port) || backend.port < 1 || backend.port > 65535) {
    throw new Error('manifest.backend.port must be an integer between 1 and 65535')
  }
  if (backend.health_check !== undefined && (
    typeof backend.health_check !== 'string' || !backend.health_check.startsWith('/') ||
    backend.health_check.startsWith('//') || /[?#\\]/.test(backend.health_check) || backend.health_check.split('/').includes('..')
  )) {
    throw new Error('manifest.backend.health_check must be an absolute safe path')
  }
  if (backend.routes !== undefined) {
    if (!Array.isArray(backend.routes) || backend.routes.length === 0) throw new Error('manifest.backend.routes must be a non-empty array')
    const seen = new Set()
    for (const route of backend.routes) {
      if (typeof route !== 'string' || !route.startsWith(`${APP_BACKEND_DEV_PATH}/`) ||
        route.startsWith('//') || /[?#\\]/.test(route) || route.split('/').includes('..') ||
        !(route.endsWith('/*') || !route.includes('*'))) {
        throw new Error(`manifest.backend.routes entries must be safe ${APP_BACKEND_DEV_PATH} paths`)
      }
      if (seen.has(route)) throw new Error(`duplicate manifest.backend.routes entry: ${route}`)
      seen.add(route)
    }
  }
  if (backend.resources !== undefined) {
    const resources = backend.resources
    if (!resources || typeof resources !== 'object' || Array.isArray(resources)) throw new Error('manifest.backend.resources must be an object')
    const bounds = { cpu_millicores: [50, 4000], memory_mib: [64, 8192], max_concurrency: [1, 1000] }
    for (const [name, value] of Object.entries(resources)) {
      const range = bounds[name]
      if (!range) throw new Error(`unsupported manifest.backend.resources field: ${name}`)
      if (!Number.isInteger(value) || value < range[0] || value > range[1]) {
        throw new Error(`manifest.backend.resources.${name} must be an integer between ${range[0]} and ${range[1]}`)
      }
    }
  }
}

// Runtime Host evaluates release entries as ES modules in QuickJS. Keep the
// CLI contract aligned with Admin so a package cannot pass local validation
// and then fail publication because its entry is CommonJS.
const FUNCTION_ENTRY_EXTENSIONS = new Set(['.js', '.mjs'])
const FUNCTION_SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'])

function validateFunctionPath(value, field, { source = false } = {}) {
  if (typeof value !== 'string') throw new Error(`manifest.functions.${field} must be a string`)
  let normalized
  try {
    normalized = safeRelative(value)
  } catch (error) {
    throw new Error(`manifest.functions.${field} is invalid: ${error.message}`)
  }
  if (value.replaceAll('\\', '/') !== normalized || normalized.split('/').some(part => part === '.' || part === '')) {
    throw new Error(`manifest.functions.${field} must be a normalized relative path`)
  }
  const extension = normalized.slice(normalized.lastIndexOf('.')).toLowerCase()
  const allowed = source ? FUNCTION_SOURCE_EXTENSIONS : FUNCTION_ENTRY_EXTENSIONS
  if (!allowed.has(extension)) {
    throw new Error(`manifest.functions.${field} must be a ${source ? 'TypeScript or JavaScript' : 'JavaScript'} file`)
  }
  if (!source && !normalized.startsWith('runtime/')) throw new Error(`manifest.functions.${field} must be inside runtime/`)
  if (source && !normalized.startsWith('src/')) throw new Error(`manifest.functions.${field} must be inside src/`)
  return normalized
}

function validateFunctionRoutes(routes, field) {
  if (routes === undefined) return
  if (!Array.isArray(routes) || routes.length === 0) throw new Error(`manifest.functions.${field}.routes must be a non-empty array`)
  const seen = new Set()
  for (const route of routes) {
    if (typeof route !== 'string' || !route.startsWith('/api/') || route.startsWith('//') || /[?#\\]/.test(route) || route.split('/').includes('..') || route.includes('*') && !route.endsWith('/*')) {
      throw new Error(`manifest.functions.${field}.routes entries must be safe /api/ paths`)
    }
    if (seen.has(route)) throw new Error(`duplicate manifest.functions.${field}.routes entry: ${route}`)
    seen.add(route)
  }
}

function validateFunctionsManifest(functions) {
  if (functions === undefined) return
  if (!functions || typeof functions !== 'object' || Array.isArray(functions)) throw new Error('manifest.functions must be an object')
  const names = Object.keys(functions)
  if (!names.length || names.some(name => !['request', 'task'].includes(name))) throw new Error('manifest.functions may contain only request and task')
  for (const name of names) {
    const descriptor = functions[name]
    if (!descriptor || typeof descriptor !== 'object' || Array.isArray(descriptor)) throw new Error(`manifest.functions.${name} must be an object`)
    const supported = name === 'request'
      ? new Set(['entry', 'source', 'routes', 'timeout_ms'])
      : new Set(['entry', 'source', 'concurrency', 'max_attempts', 'timeout_ms'])
    for (const field of Object.keys(descriptor)) if (!supported.has(field)) throw new Error(`unsupported manifest.functions.${name} field: ${field}`)
    validateFunctionPath(descriptor.entry, `${name}.entry`)
    if (descriptor.source !== undefined) validateFunctionPath(descriptor.source, `${name}.source`, { source: true })
    if (name === 'request') {
      validateFunctionRoutes(descriptor.routes, name)
      if (!descriptor.routes?.length) throw new Error('manifest.functions.request.routes must declare at least one /api/ path')
      if (descriptor.timeout_ms !== undefined && (!Number.isInteger(descriptor.timeout_ms) || descriptor.timeout_ms < 100 || descriptor.timeout_ms > 10 * 60 * 1000)) {
        throw new Error('manifest.functions.request.timeout_ms must be an integer between 100 and 600000')
      }
    } else {
      const bounds = { concurrency: [1, 1000], max_attempts: [1, 20], timeout_ms: [100, 3_600_000] }
      for (const [field, value] of Object.entries(descriptor)) {
        const range = bounds[field]
        if (!range) continue
        if (!Number.isInteger(value) || value < range[0] || value > range[1]) throw new Error(`manifest.functions.task.${field} must be an integer between ${range[0]} and ${range[1]}`)
      }
    }
  }
  if (functions.request && functions.task && functions.request.entry === functions.task.entry) {
    throw new Error('manifest.functions.request.entry and task.entry must be different')
  }
}

function validateDatabaseManifest(database) {
  if (database !== undefined) throw new Error('manifest.database is no longer supported; use context.platform.request() through Gateway APIs')
}

async function validateFunctionEntries(appDir, artifactRoot, functions, { requireArtifact = false } = {}) {
  if (!functions) return
  for (const [name, descriptor] of Object.entries(functions)) {
    if (descriptor.source && !(await exists(join(resolve(appDir), safeRelative(descriptor.source))))) {
      throw new Error(`manifest.functions.${name}.source does not exist: ${descriptor.source}`)
    }
    const entry = safeRelative(descriptor.entry)
    if (requireArtifact && !(await exists(join(artifactRoot, entry)))) {
      throw new Error(`manifest.functions.${name}.entry does not exist in build output: ${entry}`)
    }
  }
}

async function validateBackendEntry(appDir, backend) {
  if (backend?.type !== 'container') return
  const relative = safeRelative(backend.entry)
  const segments = relative.split('/')
  let current = resolve(appDir)
  for (const segment of segments) {
    current = join(current, segment)
    const info = await lstat(current).catch((error) => {
      if (error.code === 'ENOENT') throw new Error(`manifest.backend.entry does not exist: ${relative}`)
      throw error
    })
    if (info.isSymbolicLink()) throw new Error(`manifest.backend.entry cannot contain symbolic links: ${relative}`)
    if (current !== join(resolve(appDir), relative) && !info.isDirectory()) throw new Error(`manifest.backend.entry parent is not a directory: ${relative}`)
  }
  const info = await lstat(current)
  if (!info.isFile()) throw new Error(`manifest.backend.entry must be a regular file: ${relative}`)
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
  if (!validAppIdentifier(manifest.id)) throw new Error('manifest.id is invalid; expected a 1–120 character lowercase slug or platform app_id')
  if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(manifest.version || '')) throw new Error('manifest.version is invalid')
  if (typeof manifest.name !== 'string' || !manifest.name.trim()) throw new Error('manifest.name is required')
  if (manifest.backend !== undefined && (!manifest.backend || typeof manifest.backend !== 'object' || Array.isArray(manifest.backend))) {
    throw new Error('manifest.backend must be an object')
  }
  validateBackendManifest(manifest.backend)
  validateFunctionsManifest(manifest.functions)
  validateDatabaseManifest(manifest.database)
  // Permissions are optional metadata. An omitted list means the app accepts
  // the platform's currently supported public capabilities; an explicit list
  // remains available for legacy packages that intentionally narrow access.
  if (manifest.permissions !== undefined && !Array.isArray(manifest.permissions)) throw new Error('manifest.permissions must be an array')
  const permissions = new Set()
  for (const permission of manifest.permissions || []) {
    if (!ALLOWED_PERMISSIONS.has(permission)) throw new Error(`unsupported app permission: ${permission}`)
    if (permissions.has(permission)) throw new Error(`duplicate app permission: ${permission}`)
    permissions.add(permission)
  }
  const sourceManifest = structuredClone(manifest)
  if (manifest.agent !== undefined && (!manifest.agent || typeof manifest.agent !== 'object' || Array.isArray(manifest.agent))) throw new Error('manifest.agent must be an object')
  if (manifest.agent?.enabled !== undefined && typeof manifest.agent.enabled !== 'boolean') throw new Error('manifest.agent.enabled must be boolean')
  manifest = await resolveAgentContract(appDir, manifest)
  if (manifest.agent !== undefined) {
    if (!manifest.agent || typeof manifest.agent !== 'object' || Array.isArray(manifest.agent)) throw new Error('manifest.agent must be an object')
    if (manifest.agent.enabled !== undefined && typeof manifest.agent.enabled !== 'boolean') throw new Error('manifest.agent.enabled must be boolean')
    try {
      const agent = normalizeManifestAgent(manifest)
      if (agent) {
        if (RESERVED_AGENT_NAMESPACES.has(agent.namespace)) throw new Error(`reserved agent namespace: ${agent.namespace}`)
        if (!Array.isArray(manifest.agent.capabilities)) throw new Error('manifest.agent.capabilities must be an array')
      }
    } catch (error) {
      throw new Error(`invalid manifest.agent: ${error.message}`)
    }
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
  if (manifest.pricing !== undefined) {
    const pricing = manifest.pricing
    const mode = pricing.mode
    const oneTimePrice = pricing.one_time_price || 0
    const commissionRate = pricing.commission_rate || 0
    if (mode === 'free') throw new Error('free app pricing is no longer supported; configure commission pricing on the platform')
    if (mode === 'one_time') throw new Error('one-time app pricing is no longer supported; configure commission pricing on the platform')
    if (!ALLOWED_PRICING_MODES.has(mode)) throw new Error('manifest.pricing.mode must be commission')
    if (!/^[A-Z]{3,10}$/.test(pricing.currency || 'USD')) throw new Error('manifest.pricing.currency is invalid')
    if (!Number.isFinite(oneTimePrice) || !Number.isFinite(commissionRate) || oneTimePrice < 0 || commissionRate < 0) throw new Error('manifest.pricing values must be non-negative numbers')
    if (commissionRate <= 0 || commissionRate > 100 || oneTimePrice !== 0) throw new Error('commission pricing requires commission_rate between 0 and 100 and zero one_time_price')
  }
  // Every application uses the same top-level page. Hosting mode and desktop
  // support are platform policy rather than app manifest configuration. Keep
  // accepting those fields when reading older manifests; they are ignored.
  const entry = 'index.html'
  return { manifest, sourceManifest, entry }
}

async function validateApp(appDir, { checkBuildManifest = true, source = false } = {}) {
  const root = resolve(appDir)
  const { manifest, entry } = await readManifest(root)
  await validateBackendEntry(root, manifest.backend)
  // The package identity is carried by manifest.id. A legacy sidecar may be
  // present, but it is deliberately ignored here: local validation must not
  // turn the removed link/repair workflow into an upload prerequisite. The
  // server performs the authoritative identity check against the app selected
  // by the management API before accepting a version.
  const artifactRoot = !source && (await exists(join(root, 'dist'))) ? join(root, 'dist') : root
  if (!(await exists(join(artifactRoot, entry)))) throw new Error(`runtime entry is missing: ${entry}`)
  if (artifactRoot !== root && /(?:src|href)=["']\//i.test(await readFile(join(artifactRoot, entry), 'utf8'))) {
    throw new Error("built entry contains root-relative assets; configure the bundler to emit relative URLs (Vite: base: './')")
  }
  if (manifest.assets?.icon && !(await exists(join(artifactRoot, safeRelative(manifest.assets.icon))))) {
    console.warn(`warning: manifest.assets.icon is missing: ${manifest.assets.icon}`)
  }
  await validateFunctionEntries(root, artifactRoot, manifest.functions, { requireArtifact: artifactRoot !== root })
  if (checkBuildManifest && artifactRoot !== root && await exists(join(artifactRoot, 'manifest.json'))) {
    const builtManifest = JSON.parse(await readFile(join(artifactRoot, 'manifest.json'), 'utf8'))
    if (JSON.stringify(builtManifest) !== JSON.stringify(manifest)) {
      throw new Error('构建产物与当前 manifest 不一致，请运行 proxy-app pack 重新构建打包。')
    }
  }
  await loadAgentPackage(artifactRoot, manifest)
  return { root, artifactRoot, manifest, entry }
}

function run(command, args, cwd, env = process.env) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: 'inherit', detached: process.platform !== 'win32', shell: process.platform === 'win32' })
    let canceled = false
    const stop = (signal) => {
      canceled = true
      try {
        if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, signal)
        else child.kill(signal)
      } catch { /* The build may already have exited. */ }
    }
    const interrupt = () => stop('SIGINT')
    const terminate = () => stop('SIGTERM')
    const cleanup = () => {
      process.removeListener('SIGINT', interrupt)
      process.removeListener('SIGTERM', terminate)
    }
    process.once('SIGINT', interrupt)
    process.once('SIGTERM', terminate)
    child.on('error', (error) => { cleanup(); reject(error) })
    child.on('close', (code, signal) => {
      cleanup()
      if (code === 0 && !canceled) resolvePromise()
      else reject(new Error(`${command} exited with ${code ?? signal}${canceled ? ' (构建已取消)' : ''}`))
    })
  })
}

async function buildApp(appDir) {
  const root = resolve(appDir)
  if (process.env.PROXY_APP_BUILD_ACTIVE === root) throw new Error('package.json 的 build 脚本不能调用 proxy-app build/pack/upload/publish，请直接调用 Vite 等构建工具。')
  const before = await readManifest(root)
  const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
  if (!pkg.scripts?.build) throw new Error('package.json 缺少 build 脚本，无法重新构建应用。')
  const staging = join(root, '.proxy-app-build')
  const dist = join(root, 'dist')
  try { await mkdir(staging) } catch (error) {
    if (error.code === 'EEXIST') throw new Error('该应用正在构建（.proxy-app-build）。若上次进程异常退出，请先检查此目录内保留的旧 dist，再清理目录重试。')
    throw error
  }
  let previousDist = false
  let started = false
  let preserveBackup = false
  try {
    if (await exists(dist)) {
      await rename(dist, join(staging, 'dist'))
      previousDist = true
    }
    started = true
    console.log('正在重新构建应用…')
    await run('npm', ['run', 'build'], root, { ...process.env, PROXY_APP_BUILD_ACTIVE: root })
    const outputInfo = await lstat(dist).catch((error) => { if (error.code !== 'ENOENT') throw error; return null })
    if (!outputInfo?.isDirectory() || outputInfo.isSymbolicLink()) throw new Error('build output is missing or invalid: build 脚本必须生成真实的 dist 目录。')
    await copyAgentPackage(root, dist, before.manifest)
    const info = await validateApp(root, { checkBuildManifest: false })
    if (info.artifactRoot === root) throw new Error('build output is missing: build 脚本必须生成 dist 目录，不能把源码作为发布包。')
    if (JSON.stringify(before.manifest) !== JSON.stringify(info.manifest)) {
      throw new Error('manifest 或代码能力契约在构建期间发生变更，请重新运行 proxy-app pack，避免配置与资源版本不一致。')
    }
    // Stamp only newly generated output, never a successful no-op over old dist.
    await writeFile(join(info.artifactRoot, 'manifest.json'), JSON.stringify(info.manifest, null, 2) + '\n')
    return info
  } catch (error) {
    if (started) {
      try {
        await rm(dist, { recursive: true, force: true })
        if (previousDist) await rename(join(staging, 'dist'), dist)
      } catch {
        preserveBackup = true
        throw new Error(`${error.message}\n旧构建保留在 ${staging}，请检查后恢复。`)
      }
    }
    throw error
  } finally {
    if (!preserveBackup) await rm(staging, { recursive: true, force: true })
  }
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
  if (process.env.PROXY_APP_DEV_ACTIVE === root) {
    throw new Error('package.json 的 dev:server 脚本必须直接调用 Vite 等开发服务器，不能调用 proxy-app dev 或 npm run dev。')
  }
  const { manifest } = await readManifest(root)
  await validateBackendEntry(root, manifest.backend)
  const functionFiles = await readLocalFunctionSources(root, manifest)
  const supportedOptions = new Set(['--port', '--no-auth-cache'])
  for (const arg of args) {
    if (arg.startsWith('--') && !supportedOptions.has(arg)) {
      throw new Error(`unsupported dev option: ${arg}; local development always uses the real platform`)
    }
  }
  // Development starts with the public manifest identity. Owner-authorized
  // registration resolves the stable ID in memory before creating sessions.
  const binding = { app_id: manifest.id, slug: manifest.id }
  const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
  const backend = manifest.backend?.type === 'container' ? manifest.backend : null
  const gatewayURL = process.env.PROXY_PLATFORM_GATEWAY_URL?.trim() || DEFAULT_PLATFORM_GATEWAY_URL
  let backendContainer
  if (backend) {
    const dockerBin = process.env.PROXY_APP_DOCKER_BIN || 'docker'
    const dockerEnv = dockerClientEnvironment(process.env)
    await verifyDockerEngine({ dockerBin, env: dockerEnv })
    backendContainer = await createBackendContainerSpec({
      appDir: root,
      backend,
      appID: manifest.id,
      version: manifest.version,
      gatewayURL,
      dockerBin,
      dockerEnv,
    })
  }
  const devScript = ['dev:server', 'dev'].find(name => typeof pkg.scripts?.[name] === 'string' && pkg.scripts[name].trim())
  if (!devScript) throw new Error('package.json 缺少 dev:server 脚本，请配置 Vite 等开发服务器启动命令。')
  const requestedPort = option(args, '--port', process.env.PROXY_APP_DEV_PORT || '5173')
  if (!/^\d+$/.test(requestedPort) || Number(requestedPort) < 1 || Number(requestedPort) > 65535) throw new Error('--port must be between 1 and 65535')
  const configuredEntryURL = process.env.PROXY_APP_DEV_URL?.trim() || ''
  const portWasExplicit = args.includes('--port') || Boolean(process.env.PROXY_APP_DEV_PORT?.trim())
  let portReservation = configuredEntryURL ? null : portWasExplicit
    ? await reservePort(Number(requestedPort))
    : await reserveAvailablePort(Number(requestedPort))
  if (!configuredEntryURL && portWasExplicit && !portReservation) {
    throw new Error(`端口 ${requestedPort} 已被占用；请停止占用该端口的旧开发服务器，或改用 --port <可用端口> 后重试。`)
  }
  const selectedPort = portReservation?.port || Number(requestedPort)
  if (!configuredEntryURL && selectedPort !== Number(requestedPort)) {
    console.warn(`端口 ${requestedPort} 已被占用，改用 ${selectedPort}。`)
  }
  const entryURL = configuredEntryURL || `http://127.0.0.1:${selectedPort}/`
  let parsedEntryURL
  try { parsedEntryURL = new URL(entryURL) } catch { throw new Error('PROXY_APP_DEV_URL must be a valid loopback http(s) URL') }
  if (!['http:', 'https:'].includes(parsedEntryURL.protocol) || !['localhost', '127.0.0.1', '::1'].includes(parsedEntryURL.hostname) || parsedEntryURL.username || parsedEntryURL.password) {
    await portReservation?.release()
    throw new Error('PROXY_APP_DEV_URL must use localhost, 127.0.0.1, or ::1 without credentials')
  }
  let backendPortReservation = null
  if (backend) {
    backendPortReservation = await reservePort(backend.port)
    if (!backendPortReservation) {
      await portReservation?.release()
      throw new Error(`应用后端端口 ${backend.port} 已被占用；请修改 manifest.backend.port 后重试。`)
    }
  }
  const baseURL = platformAPIBaseURL()
  const portalURL = platformPortalURL()
  const storeSettings = { baseURL, portalURL, appID: binding.app_id, projectPath: root }
  const developerCredentialStore = args.includes('--no-auth-cache') ? null : createLocalCredentialStore({
    ...storeSettings, purpose: 'development',
  })
  const cachedOperations = (store) => {
    if (!store) return null
    let fallbackReported = store.kind !== 'keychain'
    const operation = (method) => async (...values) => {
      try { return await store[method](...values) }
      finally {
        if (!fallbackReported && store.kind === 'memory') {
          fallbackReported = true
          console.warn(store.reason)
        }
      }
    }
    return { load: operation('load'), save: operation('save'), clear: operation('clear') }
  }
  let relay
  try {
    relay = await createLocalDevelopmentRelay({
      baseURL,
      portalURL,
      appID: binding.app_id,
      appSlug: manifest.id,
      version: manifest.version,
      manifest,
      functionFiles,
      entryURL,
      developerCredentialStore: cachedOperations(developerCredentialStore),
    })
  } catch (error) {
    await portReservation?.release()
    await backendPortReservation?.release()
    throw error
  }
  const {
    PROXY_USER_ACCESS_TOKEN: _userToken,
    PROXY_ACCESS_TOKEN: _legacyToken,
    PROXY_API_BASE_URL: _apiBaseURL,
    PROXY_PORTAL_URL: _portalURL,
    PROXY_PUBLIC_URL: _publicURL,
    PROXY_APP_DEV_URL: _entryURL,
    PROXY_APP_DEV_PORT: _devPort,
    PROXY_APP_DEV_AUTH_RELAY_URL: _staleAuthRelayURL,
    PROXY_APP_DEV_AUTH_RELAY_SECRET: _staleAuthRelaySecret,
    PROXY_APP_DEV_SESSION_GRANT: _staleDevelopmentSessionGrant,
    PROXY_PLATFORM_GATEWAY_URL: _gatewayURL,
    PROXY_PLATFORM_RUNTIME_URL: _runtimeURL,
    PROXY_PLATFORM_BRIDGE_URL: _bridgeURL,
    PROXY_PLATFORM_AUTH_URL: _authURL,
    PROXY_APP_BACKEND_URL: _inheritedBackendURL,
    PROXY_APP_BACKEND_PATH: _inheritedBackendPath,
    ...safeChildEnv
  } = process.env
  // Keep the same-origin Vite proxy pointed at Gateway. Runtime user sessions
  // are obtained by the Portal in the browser; the CLI relay is limited to
  // developer authorization and draft registration.
  const selectedGatewayURL = _gatewayURL?.trim() || gatewayURL
  const browserPortalURL = new URL(portalURL).origin
  const childEnv = {
    ...safeChildEnv,
    PROXY_APP_DEV_ACTIVE: root,
    PROXY_PLATFORM_GATEWAY_URL: selectedGatewayURL,
    VITE_PROXY_PORTAL_URL: browserPortalURL,
    PROXY_APP_DEV_SESSION_API_URL: baseURL,
    PROXY_APP_DEV_SESSION_PORTAL_URL: browserPortalURL,
    PROXY_APP_DEV_SESSION_ID: manifest.id,
    PROXY_APP_DEV_SESSION_VERSION: manifest.version,
    ...(backend ? {
      PROXY_APP_BACKEND_URL: `http://127.0.0.1:${backend.port}`,
      PROXY_APP_BACKEND_PATH: APP_BACKEND_DEV_PATH,
    } : {}),
  }
  const preparation = new AbortController()
  let canceledSignal = ''
  const cancel = (signal) => { canceledSignal = signal; preparation.abort() }
  const interrupt = () => cancel('SIGINT')
  const terminate = () => cancel('SIGTERM')
  const removePreparationListeners = () => {
    process.removeListener('SIGINT', interrupt)
    process.removeListener('SIGTERM', terminate)
  }
  process.once('SIGINT', interrupt)
  process.once('SIGTERM', terminate)
  try {
    console.log(`正在检查开发应用：${manifest.id}@${manifest.version}`)
    console.log(`平台 API 地址：${baseURL}`)
    console.log(`开发授权缓存：${developerCredentialStore?.kind === 'keychain' ? 'macOS 钥匙串，与应用用户登录独立保存' : '仅当前进程内存'}`)
    await relay.prepareDevelopment({
      token: _userToken || _legacyToken || '',
      signal: preparation.signal,
      onAuthorizationRequired: ({ login_url }) => {
        console.log('开发环境尚未授权，或已有开发授权已失效。请使用应用创建者账户打开以下链接：')
        console.log('开发者授权入口：')
        console.log(login_url)
        console.log('完成开发者授权并通过应用登记检查后才会启动本地应用。按 Ctrl+C 取消。')
      },
    })
    childEnv.PROXY_APP_DEV_SESSION_GRANT = relay.getDevelopmentSessionGrant()
    console.log('开发应用检查通过。')
    preparation.signal.throwIfAborted()
    preparation.signal.throwIfAborted()
    removePreparationListeners()
    console.log(`Local app: ${entryURL}`)
    if (backend) {
      console.log(`Local app backend: http://127.0.0.1:${backend.port}${APP_BACKEND_DEV_PATH}/*`)
      console.log(`Backend runtime: Docker (${backend.runtime}); source is mounted read-only and app dependencies are installed in container tmpfs.`)
    }
    console.log('App transport: Gateway App Session (/v1); browser requests never leave the Gateway data plane.')
    console.log('App Session: sign in through the Portal when prompted; the browser keeps it in this tab.')
    await portReservation?.release()
    portReservation = null
    await backendPortReservation?.release()
    backendPortReservation = null
    const children = []
    if (backendContainer) children.push(backendContainer)
    children.push({
      command: 'npm',
      args: ['run', devScript, '--', '--host', '127.0.0.1', '--port', String(selectedPort), '--strictPort'],
      cwd: root,
      env: childEnv,
      name: 'npm',
    })
    await runChildren(children)
  } catch (error) {
    if (!canceledSignal) {
      const guidance = []
      if (error?.stage === 'app_registration' && ['APP_APP_REGISTRATION_FAILED', 'APP_LOGIN_SESSION_EXPIRED'].includes(error?.code)) {
        if ([403, 404].includes(error.statusCode)) {
          guidance.push('请核对 manifest.json 中的 id（应用 slug）与上述平台地址，确认应用已在该平台创建。开发不需要绑定或 repair。')
          guidance.push('请使用应用创建者账户完成开发授权，并确认终端显示的平台地址与应用所在平台一致。')
          guidance.push('如果设置了 PROXY_USER_ACCESS_TOKEN，请确认它属于应用创建者；旧账户令牌请清除或取消设置后重新运行普通 proxy-app dev。')
        } else if (error.statusCode === 401) {
          guidance.push('请确认 PROXY_USER_ACCESS_TOKEN 属于应用创建者；如果该变量是旧账户令牌，请清除或取消设置后重新运行普通 proxy-app dev。')
        }
      }
      if (typeof error.requestId === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(error.requestId)) {
        guidance.push(`请求编号：${error.requestId}`)
      }
      if (guidance.length) error.message += '\n' + guidance.join('\n')
      throw error
    }
    console.error('已取消开发环境初始化，本地应用未启动。')
    process.exitCode = canceledSignal === 'SIGINT' ? 130 : 143
  } finally {
    removePreparationListeners()
    await portReservation?.release()
    await backendPortReservation?.release()
    await relay.close()
  }
}

function runChildren(specifications) {
  return new Promise((resolvePromise, reject) => {
    const children = []
    let stopping = false
    let settled = false
    let firstError = null
    let remaining = specifications.length
    const removeSignalHandlers = () => {
      process.removeListener('SIGINT', onInterrupt)
      process.removeListener('SIGTERM', onTerminate)
    }
    const stopChild = (child, signal = 'SIGTERM') => {
      if (!child.pid || child.exitCode !== null || child.signalCode !== null) return
      try {
        if (process.platform !== 'win32') process.kill(-child.pid, signal)
        else child.kill(signal)
      } catch { /* Child exited between the state check and signal. */ }
    }
    const finish = () => {
      if (settled || remaining > 0) return
      settled = true
      removeSignalHandlers()
      if (firstError) reject(firstError)
      else resolvePromise()
    }
    const stopAll = () => {
      if (stopping) return
      stopping = true
      for (const child of children) stopChild(child)
      const forceKill = setTimeout(() => {
        for (const child of children) stopChild(child, 'SIGKILL')
      }, 5000)
      forceKill.unref()
    }
    const onInterrupt = () => { stopAll() }
    const onTerminate = () => { stopAll() }
    process.once('SIGINT', onInterrupt)
    process.once('SIGTERM', onTerminate)
    for (const specification of specifications) {
      const child = spawn(specification.command, specification.args, {
        cwd: specification.cwd,
        env: specification.env,
        stdio: 'inherit',
        detached: process.platform !== 'win32',
        shell: process.platform === 'win32',
      })
      children.push(child)
      let childFinished = false
      const finishChild = (error) => {
        if (childFinished) return
        childFinished = true
        if (error && !firstError) firstError = error
        remaining -= 1
        if (error) stopAll()
        finish()
      }
      child.once('error', (error) => {
        finishChild(error)
      })
      child.once('close', (code, signal) => {
        const unexpectedError = !stopping && code !== 0 ? new Error(`${specification.name} exited with ${code ?? signal}`) : null
        finishChild(unexpectedError)
        if (!stopping) stopAll()
      })
    }
  })
}

async function packApp(appDir, output, { allowSource = false, allowSourceMaps = allowSource } = {}) {
  const info = allowSource ? await validateApp(appDir, { source: true }) : await buildApp(appDir)
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
  if (info.artifactRoot !== info.root && info.manifest.backend?.type === 'container') {
    await collect(join(info.root, 'server'), 'server')
  }
  if (JSON.stringify((await readManifest(info.root)).manifest) !== JSON.stringify(info.manifest)) {
    throw new Error('manifest 或代码能力契约在打包期间发生变更，请重新运行 proxy-app pack。')
  }
  files['manifest.json'] = new TextEncoder().encode(JSON.stringify(info.manifest, null, 2) + '\n')
  for (const [filePath, data] of Object.entries(files)) {
    assertSafeArtifactFile(filePath, data, { allowSourceMaps })
  }
  const bundle = zipSync(files, { level: 9 })
  if (bundle.length > MAX_BUNDLE_BYTES) throw new Error(`bundle is larger than ${MAX_BUNDLE_BYTES} bytes`)
  await mkdir(dirname(outputPath), { recursive: true })
  await writeFile(outputPath, bundle)
  console.log(JSON.stringify({ output: outputPath, id: info.manifest.id, version: info.manifest.version, size: bundle.length, sha256: createHash('sha256').update(bundle).digest('hex') }, null, 2))
  return { ...info, outputPath }
}

function defaultAgentNamespace(identifier) {
  return identifier.replace(/^app\./, '').replace(/[^a-z0-9]+/g, '_').slice(0, 48) || 'app'
}

async function replaceGeneratedNamespace(root, previous, next) {
  if (!previous || previous === next) return
  for (const relative of ['agent/guide.md', 'agent/workflow.md', 'README.md', 'src/agent-tools.mjs']) {
    const target = join(root, relative)
    const source = await readFile(target, 'utf8').catch(() => null)
    if (source !== null) {
      const replaced = source.replaceAll(`proxy_${previous}_`, `proxy_${next}_`)
        .replaceAll(`"namespace": "${previous}"`, `"namespace": "${next}"`)
        .replaceAll(`namespace: ${JSON.stringify(previous)}`, `namespace: ${JSON.stringify(next)}`)
        .replaceAll(`'namespace': '${previous}'`, `'namespace': '${next}'`)
        .replaceAll(`namespace: '${previous}'`, `namespace: '${next}'`)
      if (replaced !== source) await writeFile(target, replaced)
    }
  }
}

async function replaceGeneratedIdentifier(root, previous, next) {
  if (!previous || previous === next) return
  const target = join(root, 'agent', 'examples.json')
  const source = await readFile(target, 'utf8').catch(() => null)
  if (source !== null) await writeFile(target, source.replaceAll(previous, next))
}

async function writeProject(root, app) {
  const cliPackage = JSON.parse(await readFile(new URL('./package.json', import.meta.url), 'utf8'))
  await mkdir(join(root, 'src'), { recursive: true })
  await mkdir(join(root, 'agent'), { recursive: true })
  const namespace = defaultAgentNamespace(app.slug)
  const manifest = {
    schema: 'proxy.app/v1', id: app.slug, version: '0.1.0', name: app.name, description: app.description || '',
  }
  await writeFile(join(root, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n')
  await writeFile(join(root, 'index.html'), '<!doctype html>\n<html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Proxy App</title></head><body><main id="app"></main><script type="module" src="/src/main.ts"></script></body></html>\n')
  await writeFile(join(root, 'src', 'agent-tools.mjs'), [
    '// This module is shared by the application and the package builder.',
    '// Keep metadata JSON-serializable and keep each handler beside its registry entry.',
    'export const agentMetadata = Object.freeze({',
    '  namespace: ' + JSON.stringify(namespace) + ", targets: ['web', 'desktop'], contract_version: '1.0.0',",
    '  summary: ' + JSON.stringify(app.name + ' 的应用能力') + ', keywords: [' + JSON.stringify(app.name) + '],',
    "  guide: { entry: 'agent/guide.md', topics: [{ id: 'workflow', title: '调用流程', entry: 'agent/workflow.md' }] },",
    "  examples: 'agent/examples.json',",
    '})',
    '',
    'export function registerAgentTools(registry, app) {',
    "  if (!registry || typeof registry.register !== 'function') throw new TypeError('agent registry must expose register()')",
    '  const collectOnly = app === undefined',
    "  if (!collectOnly && (!app || typeof app !== 'object')) throw new TypeError('app metadata is required')",
    '  const unregister = registry.register({',
    "    name: 'read_metadata', title: '读取应用元数据', description: '读取应用的标识、名称和版本。',",
    "    access: 'read', idempotent: true, targets: ['web', 'desktop'],",
    "    input_schema: { type: 'object', properties: {}, required: [], additionalProperties: false },",
    "    output_schema: { type: 'object', properties: { appId: { type: 'string' }, version: { type: 'string' }, name: { type: 'string' } }, required: ['appId', 'version', 'name'], additionalProperties: false },",
    "  }, collectOnly ? undefined : async () => ({ appId: app.id, version: app.version, name: app.name }))",
    "  return typeof unregister === 'function' ? [unregister] : []",
    '}',
  ].join('\n') + '\n')
  await writeFile(join(root, 'src', 'agent-tools.d.mts'), `import type { AgentCapabilityDeclaration, AgentContractMetadata } from '@ducking-mind/proxy-app-sdk'\nexport const agentMetadata: AgentContractMetadata\nexport function registerAgentTools(\n  registry: { register(declaration: AgentCapabilityDeclaration, handler?: ((input: unknown, context: unknown) => unknown) | undefined): (() => void) | undefined },\n  app?: { id: string; version: string; name: string },\n): Array<() => void>\n`)
  await writeFile(join(root, 'src', 'main.ts'), `import { agent, createAppClient } from '@ducking-mind/proxy-app-sdk'\nimport manifest from '../manifest.json'\nimport { registerAgentTools } from './agent-tools.mjs'\n\nconst client = createAppClient(manifest.id, {\n  runtime: import.meta.env.DEV ? 'local' : undefined,\n  localDevelopment: import.meta.env.DEV,\n  localAppVersion: manifest.version,\n  appVersion: manifest.version,\n  portalURL: import.meta.env.DEV ? (import.meta.env.VITE_PROXY_PORTAL_URL || 'https://www.duckingmind.com') : window.location.origin,\n})\nconst root = document.querySelector<HTMLElement>('#app')\nif (root) root.textContent = manifest.name\n\nconst disposers = registerAgentTools({\n  register(declaration, handler) {\n    if (typeof handler !== 'function') throw new Error('Agent handler is missing: ' + declaration.name)\n    return agent.register(declaration, handler)\n  },\n}, manifest)\nconst unregister = () => disposers.splice(0).reverse().forEach(dispose => dispose())\nif (import.meta.hot) import.meta.hot.dispose(unregister)\nagent.setStatus({ state: 'ready' }, { scope: 'app', priority: 1 })\nvoid agent.ready()\n`)
  await writeFile(join(root, 'vite.config.ts'), "import { defineConfig } from 'vite'\nimport { createPlatformDevProxy, createPlatformDevSessionPlugin } from '@ducking-mind/proxy-app-sdk/vite'\n\nexport default defineConfig({\n  base: './',\n  plugins: [createPlatformDevSessionPlugin()],\n  server: {\n    host: '127.0.0.1',\n    proxy: createPlatformDevProxy(),\n  },\n})\n")
  await writeFile(join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler', resolveJsonModule: true, strict: true, skipLibCheck: true, lib: ['ES2022', 'DOM', 'DOM.Iterable'], types: ['vite/client', 'node'], noEmit: true }, include: ['src', 'vite.config.ts'] }, null, 2) + '\n')
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: app.slug.replaceAll('.', '-'), private: true, type: 'module', scripts: { dev: 'proxy-app dev', 'dev:server': 'vite', typecheck: 'tsc --noEmit', build: 'npm run typecheck && vite build' }, dependencies: { '@ducking-mind/proxy-app-sdk': '^0.2.0' }, devDependencies: { [cliPackage.name]: `^${cliPackage.version}`, '@types/node': '^22.18.0', typescript: '^5.2.2', vite: '^8.2.2' }, engines: { node: '>=22.18' } }, null, 2) + '\n')
  await writeFile(join(root, 'agent', 'guide.md'), `# ${app.name} 能力说明\n\n这是由 “proxy-app init” 生成的能力指南。外部 Codex 通过主应用 MCP 调用能力，应用本身不实现 Agent。\n\n当前提供 “proxy_${namespace}_read_metadata”，用于确认应用 ID、版本和名称。能力契约与处理器在 “src/agent-tools.mjs” 的同一条 registry.register 调用中实现；构建执行注册函数并收集发布目录，无需在 manifest 中重复声明能力。\n`)
  await writeFile(join(root, 'agent', 'workflow.md'), `# 调用流程\n\n1. 先读取应用状态和本指南。\n2. 调用 “proxy_${namespace}_read_metadata” 确认当前版本。\n3. 新增写能力时，先读取业务 revision，并为每次新操作生成唯一 “idempotency_key”。\n4. Web 和私有桌面宿主共用同一套 manifest；仅在能力确实支持时缩小 “targets”。桌面宿主源码和构建流程不属于公开 CLI。\n`)
  await writeFile(join(root, 'agent', 'examples.json'), JSON.stringify([{ capability: 'read_metadata', input: {}, output: { appId: app.slug, version: '0.1.0', name: app.name } }], null, 2) + '\n')
  await writeFile(join(root, 'README.md'), `# ${app.name}\n\n## 开发\n\n~~~bash\nnpm install\nnpx proxy-app create\nnpm run dev\n~~~\n\n已有平台应用时跳过 create，将 manifest.id 设为平台应用的公开 slug 后直接运行 npm run dev，无需 link 或 repair。启动时会先完成开发者授权与应用检查，再运行开发服务器，不要求手工配置用户 token。底层服务器命令配置在 package.json 的 dev:server 中。\n\n## 能力接入\n\n本项目生成 Web 目标，并保留供私有桌面宿主识别的 “desktop” 兼容目标；公开 CLI 只构建和发布 Web 应用。能力契约与处理器必须在 “src/agent-tools.mjs” 的同一条 registry.register 调用中实现；CLI 执行 “registerAgentTools” 并从实际注册路径生成发布目录。不要导出独立能力数组，也不要在源码 manifest 声明 Agent 配置。新增能力后同步业务指南和示例，再运行：\n\n~~~bash\nnpx proxy-app validate\nnpx proxy-app pack\n~~~\n\n完整约定见仓库的 [应用开发指南](https://github.com/duckingmind/app/blob/main/docs/APP_DEVELOPMENT.md)。\n`)
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
  console.log(JSON.stringify({ created: root, identifier: app.slug, next: [`cd ${root}`, 'npm install', 'npx proxy-app create', 'npm run dev', 'npx proxy-app pack'] }, null, 2))
}

async function createApp(appDir, args) {
  const root = resolve(appDir)
  if (await exists(join(root, '.proxy-app.json'))) throw new Error('app is already linked; run proxy-app status to inspect it')
  const { sourceManifest: manifest } = await readManifest(root)
  const localIdentifier = manifest.id
  const name = option(args, '--name', manifest.name || root.split(sep).pop() || 'Proxy App')
  const category = option(args, '--category', 'other')
  if (!ALLOWED_CATEGORIES.has(category)) throw new Error(`unsupported app category: ${category}`)
  const app = await apiJSON(APP_WORKSPACE_PATH, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, description: option(args, '--description', manifest.description || ''), category }) })
  if (!app || typeof app.id !== 'string' || !app.id || !validPublicAppSlug(app.slug)) {
    throw new Error('platform returned an invalid app binding; expected app_id and a 1–120 character lowercase slug')
  }
  const previousNamespace = defaultAgentNamespace(localIdentifier)
  const nextNamespace = defaultAgentNamespace(app.id)
  await replaceGeneratedNamespace(root, previousNamespace, nextNamespace)
  manifest.id = app.id
  await replaceGeneratedIdentifier(root, localIdentifier, app.id)
  await writeFile(join(root, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n')
  await replaceIdentifier(root, localIdentifier, app.id)
  await writeFile(join(root, '.proxy-app.json'), JSON.stringify(appBinding(app), null, 2) + '\n')
  console.log(JSON.stringify({ created: root, identifier: app.slug, app_id: app.id, next: [`proxy-app upload ${root}`] }, null, 2))
}

async function linkApp(appDir, appID) {
  const root = resolve(appDir)
  const result = await apiJSON(APP_WORKSPACE_PATH)
  const app = (result.items || []).find((item) => item.id === appID)
  if (!app) throw new Error(`application not found: ${appID}`)
  const manifestPath = join(root, 'manifest.json')
  const { sourceManifest: manifest } = await readManifest(root)
  if (!validPublicAppSlug(app.slug) || typeof app.id !== 'string' || !app.id) {
    throw new Error(`application has an invalid identifier: ${app.slug || '(missing)'}`)
  }
  const previous = manifest.id
  const previousNamespace = defaultAgentNamespace(previous)
  const nextNamespace = defaultAgentNamespace(app.id)
  await replaceGeneratedNamespace(root, previousNamespace, nextNamespace)
  manifest.id = app.id
  await replaceGeneratedIdentifier(root, previous, app.id)
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n')
  await replaceIdentifier(root, previous, app.id)
  await writeFile(join(root, '.proxy-app.json'), JSON.stringify(appBinding(app), null, 2) + '\n')
  console.log(JSON.stringify({ linked: root, identifier: app.slug, app_id: app.id }, null, 2))
}

// Repair is the user-facing binding command. It keeps the legacy slug in the
// local file for compatibility, but users only need to provide app_id.
async function repairApp(appDir, appID) {
  const root = resolve(appDir)
  const existing = await readFile(join(root, '.proxy-app.json'), 'utf8').then(JSON.parse).catch(() => ({}))
  const target = appID || existing.app_id
  if (!target) throw new Error('缺少 app_id，请使用 proxy-app repair <app-id>')
  await linkApp(root, target)
}

// Management commands use the platform app identity carried by manifest.id.
// A sidecar binding may remain in an older checkout, but it is intentionally
// ignored: existing apps can be uploaded/published directly after setting
// manifest.id to the app's public slug (or stable app_id). This keeps the
// development and release flows consistent and avoids making `link` a hidden
// prerequisite for an otherwise valid package.
async function resolveManagedApp(appDir) {
  const root = resolve(appDir)
  const { manifest } = await readManifest(root)
  const result = await apiJSON(APP_WORKSPACE_PATH)
  const items = Array.isArray(result?.items) ? result.items : []
  // Resolve the durable app ID from the public manifest identity. Existing
  // checkouts therefore work without a sidecar file or a link/repair command;
  // stale compatibility sidecars are deliberately ignored.
  const app = items.find((item) => matchesAppIdentity(manifest.id, item?.id, item?.slug, publicAppAliases(item)))
  if (!app) {
    throw new Error(`应用不存在或当前账户无权访问：${manifest.id}。请确认 manifest.id 是该应用的公开 slug；新应用请运行 proxy-app create。`)
  }
  return { root, manifest, app, binding: appBinding(app) }
}

async function developerApp(appDir) {
  return (await resolveManagedApp(appDir)).app
}

async function requestAppOpening(appID, version) {
  // The version is review material for the application opening request.
  // Pricing remains the application's saved configuration.
  return apiJSON(`${APP_WORKSPACE_PATH}/${encodeURIComponent(appID)}/opening`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ version }),
  })
}

function pendingAppOpening(app) {
  if (Object.hasOwn(app, 'opening_request')) {
    return app.opening_request?.status === 'pending' ? app.opening_request : null
  }
  // Old servers expose the candidate through a version status. Never prefer
  // that compatibility mirror over the application's canonical request.
  const version = (app.versions || []).find((item) => item.review_status === 'review')
  return version ? { version: version.version, status: 'pending' } : null
}

function reportPendingOpening(app, version) {
  const pending = pendingAppOpening(app)
  if (!pending) return false
  if (pending.version !== version) {
    throw new Error(`应用开放申请正在审核（预览版本 ${pending.version}），请在“我的应用”撤回申请后再更换审核材料。`)
  }
  const result = { submitted: false, reason: '应用开放申请正在审核，无需重复提交。', app_id: app.id, opening_request: pending, version }
  console.log(JSON.stringify(result, null, 2))
  return result
}

async function uploadApp(appDir, output, options = {}) {
  const local = await readManifest(resolve(appDir))
  if (local.manifest.backend?.type === 'container') {
    throw new Error('当前平台尚未支持云端容器后端构建与部署；容器后端版本不会上传。可先运行 proxy-app dev 本地联调。')
  }
  const { app } = await resolveManagedApp(appDir)
  const { token, baseURL } = apiSettings()
  const bundleInfo = await packApp(appDir, output, { ...options, allowSourceMaps: false })
  const bundle = await readFile(bundleInfo.outputPath)
  const form = new FormData(); form.append('file', new Blob([bundle], { type: 'application/zip' }), `${bundleInfo.manifest.id}-${bundleInfo.manifest.version}.zip`)
  const response = await fetch(`${baseURL}${APP_WORKSPACE_PATH}/${encodeURIComponent(app.id)}/versions`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form })
  const body = await response.json().catch(() => ({})); if (!response.ok) throw new Error(responseError(body, `upload failed: HTTP ${response.status}`))
  const uploaded = body.data || body
  console.log(JSON.stringify({
    uploaded,
    message: '版本已上传，线上版本未切换。测试后使用 publish 手动发布。',
    next: `proxy-app publish ${appDir} --version ${bundleInfo.manifest.version}`,
  }, null, 2))
  return uploaded
}

async function publishApp(appDir, output, selectedVersion) {
  // Existing uploaded versions are immutable. Only a new/local draft goes
  // through uploadApp's build; no dist is needed to publish a remote version.
  const info = await readManifest(resolve(appDir))
  if (info.manifest.backend?.type === 'container') {
    throw new Error('当前平台尚未支持云端容器后端构建与部署；此应用可通过 proxy-app dev 本地联调，不能 publish。')
  }
  const targetVersion = selectedVersion || info.manifest.version
  let remoteApp = await developerApp(appDir)
  let version = (remoteApp.versions || []).find((item) => item.version === targetVersion)
  if (selectedVersion && (!version || (!version.artifact_size && !version.artifact_sha256))) {
    throw new Error(`版本 ${targetVersion} 尚未上传。--version 只选择已有上传产物，请先上传该版本。`)
  }
  if (!remoteApp.current_version) {
    if (remoteApp.status === 'disabled') throw new Error('应用已被平台禁用，解除限制后才能申请开放。修复包可使用 proxy-app upload 上传。')
    const pending = reportPendingOpening(remoteApp, targetVersion)
    if (pending) return pending
  }
  let uploaded = null
  if (!version || (version.review_status === 'draft' && !version.artifact_size && !version.artifact_sha256)) {
    uploaded = await uploadApp(appDir, output)
    version = uploaded
    remoteApp = await developerApp(appDir)
  }
  if (!remoteApp.current_version) {
    const pending = reportPendingOpening(remoteApp, targetVersion)
    if (pending) return pending
  }
  if (remoteApp.current_version === targetVersion) {
    const result = { submitted: false, changed: false, reason: '该版本已是当前线上版本，无需切换。', app_id: remoteApp.id, version: targetVersion }
    console.log(JSON.stringify(result, null, 2))
    return result
  }
  if (remoteApp.current_version) {
    if (!['draft', 'rejected', 'review', 'published'].includes(version.review_status)) throw new Error(`version cannot be published from status: ${version.review_status || 'unknown'}`)
    const published = await apiJSON(`${APP_WORKSPACE_PATH}/${encodeURIComponent(remoteApp.id)}/versions/${encodeURIComponent(targetVersion)}/publish`, { method: 'POST' })
    const result = { uploaded, published, submitted: false, changed: true, message: '线上版本已手动切换；应用保持当前上架或限制状态。', app_id: remoteApp.id, previous_version: remoteApp.current_version, version: targetVersion }
    console.log(JSON.stringify(result, null, 2))
    return result
  }
  if (!['draft', 'rejected', 'review'].includes(version.review_status)) throw new Error(`version cannot be used as application review material from status: ${version.review_status || 'unknown'}`)
  const submitted = await requestAppOpening(remoteApp.id, targetVersion)
  const result = { uploaded, submitted: true, opening: submitted, changed: false, message: '应用开放申请已提交，所选版本用于预览和审核。', app_id: remoteApp.id, version: targetVersion }
  console.log(JSON.stringify(result, null, 2))
  return result
}

async function statusApp(appDir) {
  const root = resolve(appDir)
  const { manifest } = await readManifest(root)
  const app = await developerApp(root)
  const version = (app.versions || []).find((item) => item.version === manifest.version)
  console.log(JSON.stringify({ linked: true, identifier: app.slug, app_id: app.id, app_status: app.status, current_version: app.current_version || null, opening_request: app.opening_request ?? pendingAppOpening(app), local_version: manifest.version, remote_version: version || null, binding_source: 'manifest.id' }, null, 2))
}

async function doctorApp(appDir) {
  const root = resolve(appDir)
  const checks = []
  const [major, minor] = process.versions.node.split('.').map(Number)
  checks.push({ name: 'node', ok: major > 22 || (major === 22 && minor >= 18), detail: process.version })
  try {
    const info = await validateApp(root)
    checks.push({ name: 'manifest', ok: true, detail: `${info.manifest.id}@${info.manifest.version}` })
    checks.push({ name: 'build', ok: info.artifactRoot !== info.root, detail: info.artifactRoot !== info.root ? 'dist found' : 'dist not found; run proxy-app build' })
  } catch (error) {
    checks.push({ name: 'manifest', ok: false, detail: error.message })
  }
  checks.push({ name: 'binding', ok: true, detail: '使用 manifest.id 解析平台应用，无需 link 或 repair' })
  const valid = checks.every((item) => item.ok)
  console.log(JSON.stringify({ ok: valid, ready_for_upload: valid, checks }, null, 2))
  if (!valid) process.exitCode = 1
}

const [, , command, ...args] = process.argv
try {
  if (!command || command === '--help' || command === '-h' || args.includes('--help') || args.includes('-h')) usage()
  else {
    const { appDir, appID, output, options } = commandArguments(command, args)
    if (command === 'dev') await devApp(appDir, options)
    else if (command === 'init') await initApp(appDir, options)
    else if (command === 'create') await createApp(appDir, options)
    else if (command === 'repair' || command === 'link') await repairApp(appDir, appID)
    else if (command === 'status') await statusApp(appDir)
    else if (command === 'doctor') await doctorApp(appDir)
    else if (command === 'validate') {
      const info = await validateApp(appDir)
      console.log(JSON.stringify({ valid: true, id: info.manifest.id, version: info.manifest.version, entry: info.entry }, null, 2))
    } else if (command === 'build') await buildApp(appDir)
    else if (command === 'pack') await packApp(appDir, output, { allowSource: options.includes('--source') })
    else if (command === 'upload') await uploadApp(appDir, output, { allowSource: options.includes('--source') })
    else if (command === 'publish') await publishApp(appDir, output, option(options, '--version'))
  }
} catch (error) {
  console.error(`proxy app: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
}
