import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { lstat, mkdir, unlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

const SERVICE = 'cn.proxy-app.local-development'
const VALUE_PREFIX = 'proxy-app-token-v1:'
const TIMEOUT_MS = 5000
const MAX_OUTPUT_BYTES = 128 * 1024
// security -i reads a bounded line buffer. A longer line can be split into
// several commands, so it must never be submitted even though it is base64.
const MAX_INTERACTIVE_COMMAND_BYTES = 4000
const MEMORY_REASON = '系统安全凭证存储不可用，当前授权仅保存在开发进程内存中。'
const INVALIDATION_REASON = '无法更新本地授权失效记录，当前授权仅保存在开发进程内存中。'

function normalizeURL(value) {
  let url
  try { url = new URL(value) } catch { throw new Error('开发授权缓存需要有效的平台地址。') }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('开发授权缓存的平台地址不能包含凭证、查询参数或片段。')
  }
  return url.origin + url.pathname.replace(/\/+$/, '')
}

function credentialAccount({ baseURL, portalURL, appID, projectPath, purpose }) {
  if (!baseURL || !appID?.trim() || !projectPath) throw new Error('开发授权缓存配置不完整。')
  let project
  try { project = realpathSync(projectPath) } catch { throw new Error('开发授权缓存需要已存在的项目路径。') }
  const identity = [
    normalizeURL(baseURL), normalizeURL(portalURL || baseURL), appID.trim(), project,
  ]
  // Keep existing runtime cache identities intact. Developer authorization is
  // a separate capability and must survive an app user's logout/account switch.
  if (purpose === 'development') identity.push('development')
  return createHash('sha256').update(JSON.stringify(identity)).digest('hex')
}

// No shell is involved. Only a fixed command, a hash and base64 data reach the
// interactive parser; quotes, newlines and command syntax in a token stay data.
function encodeToken(token) {
  return VALUE_PREFIX + Buffer.from(token, 'utf8').toString('base64')
}

function decodeToken(value) {
  const stored = value.replace(/\r?\n$/, '')
  if (!stored.startsWith(VALUE_PREFIX)) return null
  const encoded = stored.slice(VALUE_PREFIX.length)
  if (!encoded || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) return null
  const token = Buffer.from(encoded, 'base64').toString('utf8')
  return token && encodeToken(token) === stored ? token : null
}

function runSecurityCommand(file, args, { input = '', timeoutMs }) {
  return new Promise((resolve) => {
    let child
    let timer
    let finished = false
    let stdout = ''
    let bytes = 0
    const finish = (exitCode) => {
      if (finished) return
      finished = true
      clearTimeout(timer)
      resolve({ exitCode, stdout: exitCode === 0 ? stdout : '' })
    }
    try {
      child = spawn(file, args, { stdio: ['pipe', 'pipe', 'pipe'], shell: false, windowsHide: true })
      timer = setTimeout(() => { child.kill('SIGKILL'); finish(null) }, timeoutMs)
      child.on('error', () => finish(null))
      child.on('close', (code) => finish(code))
      child.stdout.on('data', (chunk) => {
        bytes += chunk.length
        if (bytes > MAX_OUTPUT_BYTES) { child.kill('SIGKILL'); finish(null) }
        else stdout += chunk.toString('utf8')
      })
      // security may echo input in errors; never forward or retain stderr.
      child.stderr.resume()
      child.stdin.on('error', () => finish(null))
      child.stdin.end(input)
    } catch { finish(null) }
  })
}

/**
 * Cache a Portal login for one platform, app and real project directory.
 * App versions and local server ports intentionally do not affect its identity.
 * runCommand is injectable and returns { exitCode, stdout }; it receives
 * (executable, args, { input, timeoutMs }). Tokens never appear in args.
 * stateDirectory contains only non-secret invalidation markers, never tokens.
 */
export function createLocalCredentialStore({
  baseURL, portalURL = '', appID, projectPath,
  purpose = 'runtime',
  platform = process.platform,
  runCommand = runSecurityCommand,
  timeoutMs = TIMEOUT_MS,
  stateDirectory = join(homedir(), 'Library', 'Caches', 'proxy-app', 'credentials'),
}) {
  if (!['runtime', 'development'].includes(purpose)) throw new Error('未知的授权缓存用途。')
  const account = credentialAccount({ baseURL, portalURL, appID, projectPath, purpose })
  const markerPath = join(stateDirectory, account + '.disabled')
  const boundedTimeout = Number.isFinite(timeoutMs) ? Math.max(1, Math.min(timeoutMs, TIMEOUT_MS)) : TIMEOUT_MS
  let kind = platform === 'darwin' ? 'keychain' : 'memory'
  let reason = kind === 'keychain' ? '' : MEMORY_REASON
  let memoryToken = null
  let queue = Promise.resolve()

  const fallback = (message = MEMORY_REASON) => { kind = 'memory'; reason = message }
  const serial = (operation) => {
    const pending = queue.then(operation)
    queue = pending.catch(() => undefined)
    return pending
  }
  const security = async (args, input = '') => {
    let timer
    try {
      const result = await Promise.race([
        Promise.resolve().then(() => runCommand('/usr/bin/security', args, { input, timeoutMs: boundedTimeout })),
        new Promise((resolve) => { timer = setTimeout(() => resolve(null), boundedTimeout) }),
      ])
      if (!result || typeof result.stdout !== 'string' || Buffer.byteLength(result.stdout) > MAX_OUTPUT_BYTES) return null
      return { exitCode: result.exitCode, stdout: result.stdout }
    } catch { return null } finally { clearTimeout(timer) }
  }
  const invalidated = async () => {
    try { await lstat(markerPath); return true } catch (error) {
      if (error?.code === 'ENOENT') return false
      fallback(INVALIDATION_REASON)
      return true
    }
  }
  const invalidate = async () => {
    try {
      await mkdir(stateDirectory, { recursive: true, mode: 0o700 })
      await writeFile(markerPath, 'Automatic restore is disabled until a new authorization is saved.\n', { flag: 'wx', mode: 0o600 })
      return true
    } catch (error) {
      if (error?.code === 'EEXIST') return true
      fallback(INVALIDATION_REASON)
      return false
    }
  }

  return {
    get kind() { return kind },
    get reason() { return reason },
    load: () => serial(async () => {
      if (memoryToken || kind !== 'keychain' || await invalidated()) return memoryToken
      const result = await security(['find-generic-password', '-s', SERVICE, '-a', account, '-w'])
      if (result?.exitCode === 44) return null // errSecItemNotFound
      if (result?.exitCode !== 0) { fallback(); return null }
      const token = decodeToken(result.stdout)
      if (!token) { fallback(); return null }
      memoryToken = token
      return token
    }),
    save: (token) => serial(async () => {
      if (typeof token !== 'string' || !token || Buffer.byteLength(token) > 64 * 1024) {
        throw new Error('开发授权凭证为空或格式无效。')
      }
      memoryToken = token
      if (platform !== 'darwin' || !await invalidate() || kind !== 'keychain') return
      const encoded = encodeToken(token)
      const command = 'add-generic-password -U -s ' + SERVICE + ' -a ' + account + ' -w ' + encoded + '\n'
      if (Buffer.byteLength(command) > MAX_INTERACTIVE_COMMAND_BYTES) { fallback(); return }
      const result = await security(['-i'], command)
      if (result?.exitCode !== 0) { fallback(); return }
      // An interactive command's process status alone does not prove the item
      // was updated. Keep restore disabled until the saved token is verified.
      const saved = await security(['find-generic-password', '-s', SERVICE, '-a', account, '-w'])
      if (saved?.exitCode !== 0 || saved.stdout.replace(/\r?\n$/, '') !== encoded) { fallback(); return }
      try { await unlink(markerPath) } catch (error) {
        if (error?.code !== 'ENOENT') fallback(INVALIDATION_REASON)
      }
    }),
    clear: () => serial(async () => {
      memoryToken = null
      if (platform !== 'darwin' || !await invalidate()) return
      const result = await security(['delete-generic-password', '-s', SERVICE, '-a', account])
      if (result?.exitCode !== 0 && result?.exitCode !== 44) fallback()
      // Keep the marker even if deletion succeeds. Only a successfully saved
      // new login may enable automatic restore after an explicit logout.
    }),
  }
}
