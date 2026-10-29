import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { lstat, readFile, readdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'

export const LOCAL_BACKEND_IMAGE = 'node:22-bookworm-slim'

const LOCKFILES = Object.freeze([
  { file: 'package-lock.json', install: 'npm ci --prefix /workspace --cache /tmp/npm-cache --no-audit --no-fund' },
  { file: 'yarn.lock', install: 'corepack yarn@1.22.22 --cwd /workspace install --frozen-lockfile --non-interactive --cache-folder /tmp/yarn-cache --modules-folder /workspace/node_modules' },
])

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`
}

function dockerMountPath(value) {
  return resolve(value).replaceAll('\\', '\\\\').replaceAll(',', '\\,')
}

function dockerMount(source, target, readOnly = false) {
  return `type=bind,src=${dockerMountPath(source)},dst=${target}${readOnly ? ',readonly' : ''}`
}

function safeContainerLabel(value) {
  return String(value).replace(/[^A-Za-z0-9_.-]/g, '-').slice(0, 120) || 'app'
}

async function backendSources(serverDir) {
  const root = await lstat(serverDir).catch((error) => {
    if (error.code === 'ENOENT') throw new Error('container backend source directory is missing: server/')
    throw error
  })
  if (!root.isDirectory() || root.isSymbolicLink()) throw new Error('container backend source must be a regular server/ directory')

  const visit = async (directory, relative = '') => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      const name = relative ? `${relative}/${entry.name}` : entry.name
      if (entry.isSymbolicLink()) throw new Error(`container backend source cannot contain symbolic links: server/${name}`)
      if (entry.name === 'node_modules') throw new Error('server/node_modules is not mounted; declare backend dependencies in the app package.json')
      if (entry.name === '.npmrc' || entry.name === '.env' || entry.name.startsWith('.env.')) {
        throw new Error(`sensitive file cannot be mounted into the local backend container: server/${name}`)
      }
      if (entry.isDirectory()) await visit(path, name)
      else if (!entry.isFile()) throw new Error(`container backend source contains an unsupported file: server/${name}`)
    }
  }
  await visit(serverDir)
}

async function dependencySetup(root) {
  const found = []
  for (const item of LOCKFILES) {
    const path = join(root, item.file)
    const info = await lstat(path).catch((error) => {
      if (error.code === 'ENOENT') return null
      throw error
    })
    if (!info) continue
    if (!info.isFile() || info.isSymbolicLink()) throw new Error(`backend dependency lock must be a regular file: ${item.file}`)
    found.push({ ...item, path })
  }
  if (found.length > 1) throw new Error('container backend requires exactly one lockfile; remove the unused npm/yarn/pnpm lockfiles')
  const selected = found[0]
  if (!selected) {
    throw new Error('container backend requires a dependency lockfile (package-lock.json or a Yarn Classic yarn.lock); run npm install or yarn install first')
  }
  if (selected?.file === 'yarn.lock' && !(await readFile(selected.path, 'utf8')).startsWith('# yarn lockfile v1')) {
    throw new Error('local container development currently supports Yarn Classic lockfiles; use package-lock.json for other package managers')
  }
  return { install: selected.install, lockfile: selected }
}

function gatewayForContainer(value) {
  try {
    const url = new URL(value)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('invalid gateway URL')
    if (['localhost', '127.0.0.1', '::1'].includes(url.hostname)) url.hostname = 'host.docker.internal'
    return url.toString()
  } catch {
    throw new Error('PROXY_PLATFORM_GATEWAY_URL must be an absolute HTTP(S) URL')
  }
}

export async function createBackendContainerSpec({ appDir, backend, appID, version, gatewayURL, dockerBin = 'docker', dockerEnv = process.env } = {}) {
  const root = resolve(appDir)
  const serverDir = join(root, 'server')
  await backendSources(serverDir)

  const packagePath = join(root, 'package.json')
  const packageInfo = await lstat(packagePath).catch((error) => {
    if (error.code === 'ENOENT') throw new Error('container backend requires an app package.json')
    throw error
  })
  if (!packageInfo.isFile() || packageInfo.isSymbolicLink()) throw new Error('container backend package.json must be a regular file')

  const { install, lockfile } = await dependencySetup(root)
  const identity = safeContainerLabel(appID)
  const rootHash = createHash('sha256').update(root).digest('hex').slice(0, 10)
  const containerName = `proxy-app-dev-${identity.slice(0, 36)}-${rootHash}-${process.pid}`
  const cpu = ((backend.resources?.cpu_millicores ?? 1000) / 1000).toFixed(3).replace(/0+$/, '').replace(/\.$/, '')
  const memory = backend.resources?.memory_mib ?? 512
  const env = {
    HOME: '/tmp/home',
    TMPDIR: '/tmp',
    COREPACK_HOME: '/tmp/corepack',
    NODE_ENV: 'development',
    PORT: String(backend.port),
    HOST: '0.0.0.0',
    PROXY_APP_ID: appID,
    PROXY_APP_VERSION: version,
    PROXY_APP_BACKEND_HOST: '0.0.0.0',
    PROXY_APP_BACKEND_PORT: String(backend.port),
    ...(gatewayURL ? { PROXY_PLATFORM_GATEWAY_URL: gatewayForContainer(gatewayURL) } : {}),
    ...(backend.resources?.max_concurrency ? { PROXY_APP_MAX_CONCURRENCY: String(backend.resources.max_concurrency) } : {}),
  }

  const args = [
    'run', '--rm', '--init', '--pull=missing',
    `--name=${containerName}`,
    '--label=proxy.app.dev=true',
    `--label=proxy.app.id=${safeContainerLabel(appID)}`,
    `--label=proxy.app.version=${safeContainerLabel(version)}`,
    '--user=1000:1000',
    '--read-only',
    '--cap-drop=ALL',
    '--security-opt=no-new-privileges:true',
    '--pids-limit=128',
    `--memory=${memory}m`,
    `--memory-swap=${memory}m`,
    `--cpus=${cpu}`,
    '--ulimit=nofile=1024:1024',
    '--add-host=host.docker.internal:host-gateway',
    `--publish=127.0.0.1:${backend.port}:${backend.port}/tcp`,
    '--tmpfs=/workspace:rw,nosuid,nodev,size=1024m,uid=1000,gid=1000,mode=755',
    '--tmpfs=/tmp:rw,nosuid,nodev,size=256m,uid=1000,gid=1000,mode=1777',
    `--mount=${dockerMount(serverDir, '/workspace/server', true)}`,
    `--mount=${dockerMount(packagePath, '/workspace/package.json', true)}`,
    ...(lockfile ? [`--mount=${dockerMount(lockfile.path, `/workspace/${lockfile.file}`, true)}`] : []),
    '--workdir=/workspace',
    ...Object.entries(env).map(([name, value]) => `--env=${name}=${value}`),
    '--entrypoint=/bin/sh',
    LOCAL_BACKEND_IMAGE,
    '-lc',
    `set -eu; mkdir -p /tmp/home; ${install}; exec node --watch -- ${shellQuote(`/workspace/${backend.entry}`)}`,
  ]

  return {
    command: dockerBin,
    args,
    cwd: root,
    env: dockerClientEnvironment(dockerEnv),
    name: '应用后端容器',
    containerName,
    image: LOCAL_BACKEND_IMAGE,
  }
}

export function dockerClientEnvironment(source = process.env) {
  const allowed = [
    'PATH', 'HOME', 'USERPROFILE', 'DOCKER_HOST', 'DOCKER_CONTEXT',
    'DOCKER_CONFIG', 'DOCKER_CERT_PATH', 'DOCKER_TLS_VERIFY',
    'DOCKER_API_VERSION', 'DOCKER_DEFAULT_PLATFORM', 'TMPDIR', 'TEMP', 'TMP', 'SYSTEMROOT',
  ]
  return Object.fromEntries(allowed.filter((name) => source[name] !== undefined).map((name) => [name, source[name]]))
}

export async function verifyDockerEngine({ dockerBin = 'docker', env = dockerClientEnvironment(), timeoutMs = 8_000 } = {}) {
  await new Promise((resolvePromise, reject) => {
    const child = spawn(dockerBin, ['info', '--format={{.ServerVersion}}'], { stdio: ['ignore', 'ignore', 'pipe'], env })
    let settled = false
    let stderr = ''
    let timer
    const finish = (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (error) reject(error)
      else resolvePromise()
    }
    timer = setTimeout(() => {
      child.kill('SIGTERM')
      finish(new Error('Docker Engine 检查超时；请确认 Docker Desktop 或 Docker Engine 已启动。'))
    }, timeoutMs)
    timer.unref?.()
    child.stderr.on('data', (chunk) => {
      if (stderr.length < 4_000) stderr += chunk.toString('utf8').slice(0, 4_000 - stderr.length)
    })
    child.once('error', (error) => {
      finish(new Error(`无法启动 Docker CLI：${error.message}`))
    })
    child.once('close', (code) => {
      if (code === 0) return finish()
      const detail = stderr.trim().split('\n').at(-1)
      finish(new Error(`Docker Engine 不可用${detail ? `：${detail}` : ''}；请启动 Docker Desktop 或 Docker Engine 后重试。`))
    })
  })
}
