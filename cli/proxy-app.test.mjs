import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import test from 'node:test'

const exec = promisify(execFile)
const cli = new URL('./proxy-app.mjs', import.meta.url)

test('init generates an automatic local identifier and validates', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'proxy-app-cli-'))
  const app = join(temp, 'demo')
  try {
    await exec(process.execPath, [cli.pathname, 'init', app, '--name', 'Demo'])
    const manifest = JSON.parse(await readFile(join(app, 'manifest.json'), 'utf8'))
    assert.match(manifest.id, /^app\.proxy\.local\.[a-f0-9]{16}$/)
    assert.equal(manifest.name, 'Demo')
    assert.match(await readFile(join(app, 'vite.config.ts'), 'utf8'), /base: '\.\/'/)
    const result = await exec(process.execPath, [cli.pathname, 'validate', app])
    assert.match(result.stdout, /"valid": true/)
  } finally {
    await rm(temp, { recursive: true, force: true })
  }
})

test('pack refuses unbuilt source trees by default', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'proxy-app-cli-pack-'))
  const app = join(temp, 'demo')
  try {
    await exec(process.execPath, [cli.pathname, 'init', app])
    await assert.rejects(exec(process.execPath, [cli.pathname, 'pack', app]), /build output is missing/)
    await exec(process.execPath, [cli.pathname, 'pack', app, '--source'])
  } finally {
    await rm(temp, { recursive: true, force: true })
  }
})

test('validate rejects undeclared open API names', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'proxy-app-cli-manifest-'))
  const app = join(temp, 'demo')
  try {
    await exec(process.execPath, [cli.pathname, 'init', app])
    const manifestPath = join(app, 'manifest.json')
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
    manifest.apis = ['model.unknown']
    await writeFile(manifestPath, JSON.stringify(manifest))
    await assert.rejects(exec(process.execPath, [cli.pathname, 'validate', app]), /unsupported app API/)
  } finally {
    await rm(temp, { recursive: true, force: true })
  }
})

test('create rejects unsupported categories before contacting the platform', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'proxy-app-cli-category-'))
  const app = join(temp, 'demo')
  try {
    await exec(process.execPath, [cli.pathname, 'init', app])
    await assert.rejects(exec(process.execPath, [cli.pathname, 'create', app, '--category', 'unknown']), /unsupported app category/)
  } finally {
    await rm(temp, { recursive: true, force: true })
  }
})

test('pack rejects sensitive files and symbolic links', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'proxy-app-cli-bundle-'))
  const app = join(temp, 'demo')
  try {
    await exec(process.execPath, [cli.pathname, 'init', app])
    await writeFile(join(app, '.env'), 'PROXY_ACCESS_TOKEN=secret\n')
    await assert.rejects(exec(process.execPath, [cli.pathname, 'pack', app, '--source']), /sensitive file cannot be included/)
    await rm(join(app, '.env'))
    await writeFile(join(temp, 'outside.txt'), 'outside\n')
    await symlink(join(temp, 'outside.txt'), join(app, 'linked.txt'))
    await assert.rejects(exec(process.execPath, [cli.pathname, 'pack', app, '--source']), /symbolic links are not allowed/)
  } finally {
    await rm(temp, { recursive: true, force: true })
  }
})

test('upload explains a manifest and local binding mismatch', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'proxy-app-cli-binding-'))
  const appDir = join(temp, 'demo')
  try {
    await exec(process.execPath, [cli.pathname, 'init', appDir])
    await writeFile(join(appDir, '.proxy-app.json'), JSON.stringify({ app_id: 'app-1', slug: 'app.proxy.bound' }))
    await assert.rejects(
      exec(process.execPath, [cli.pathname, 'upload', appDir, '--source'], { env: { ...process.env, PROXY_ACCESS_TOKEN: 'test-token' } }),
      /应用标识不匹配，请先同步当前应用绑定，再重新 build 和 pack/,
    )
  } finally {
    await rm(temp, { recursive: true, force: true })
  }
})

test('create accepts a platform-generated identifier and publish reuses an uploaded draft', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'proxy-app-cli-api-'))
  const appDir = join(temp, 'demo')
  const requests = []
  const remoteApp = {
    id: 'app-1',
    slug: 'app.proxy.generated123',
    name: 'Quoted app',
    status: 'draft',
    versions: [{ version: '0.1.0', review_status: 'draft' }],
  }
  const server = createServer(async (request, response) => {
    let body = ''
    for await (const chunk of request) body += chunk
    requests.push({ method: request.method, url: request.url, body })
    response.setHeader('Content-Type', 'application/json')
    if (request.method === 'POST' && request.url === '/api/portal/user/app-workspace') {
      response.end(JSON.stringify({ data: { ...remoteApp, versions: [] } }))
      return
    }
    if (request.method === 'GET' && request.url === '/api/portal/user/app-workspace') {
      response.end(JSON.stringify({ data: { items: [remoteApp] } }))
      return
    }
    if (request.method === 'POST' && request.url === '/api/portal/user/app-workspace/app-1/versions/0.1.0/submit') {
      response.end(JSON.stringify({ data: { success: true } }))
      return
    }
    response.statusCode = 404
    response.end(JSON.stringify({ error: 'not found' }))
  })
  await new Promise((resolvePromise) => server.listen(0, '127.0.0.1', resolvePromise))
  const address = server.address()
  const env = { ...process.env, PROXY_ACCESS_TOKEN: 'test-token', PROXY_API_BASE_URL: `http://127.0.0.1:${address.port}/api` }
  try {
    await exec(process.execPath, [cli.pathname, 'init', appDir, '--name', "Quoted ' app"], { env })
    await exec(process.execPath, [cli.pathname, 'create', appDir, '--category', 'productivity'], { env })
    const manifest = JSON.parse(await readFile(join(appDir, 'manifest.json'), 'utf8'))
    assert.equal(manifest.id, remoteApp.slug)
    const createBody = JSON.parse(requests.find((item) => item.method === 'POST' && item.url.endsWith('/app-workspace')).body)
    assert.equal(createBody.slug, undefined)
    assert.equal(createBody.name, "Quoted ' app")

    const result = await exec(process.execPath, [cli.pathname, 'publish', appDir], { env })
    assert.match(result.stdout, /"success": true/)
    assert.equal(requests.filter((item) => item.method === 'POST' && item.url === '/api/portal/user/app-workspace/app-1/versions').length, 0)
    assert.equal(requests.filter((item) => item.url.endsWith('/submit')).length, 1)
  } finally {
    await new Promise((resolvePromise) => server.close(resolvePromise))
    await rm(temp, { recursive: true, force: true })
  }
})

test('dev starts a real platform relay without passing the management session to the app', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'proxy-app-cli-dev-'))
  const appDir = join(temp, 'demo')
  const resultPath = join(temp, 'child-result.json')
  const requests = []
  const platform = createServer(async (request, response) => {
    let body = ''
    for await (const chunk of request) body += chunk
    requests.push({ method: request.method, url: request.url, authorization: request.headers.authorization, body })
    response.setHeader('Content-Type', 'application/json')
    if (request.method === 'POST' && request.url === '/api/portal/user/app-workspace/app-1/local-development') {
      response.end(JSON.stringify({ data: { ok: true } }))
      return
    }
    if (request.method === 'POST' && request.url === '/api/portal/user/apps/app-1/sessions') {
      response.end(JSON.stringify({ data: {
        session_id: 'session-1', access_token: 'ast-user-1', token_type: 'Bearer', expires_in: 900,
        gateway_url: `http://127.0.0.1:${platform.address().port}`, app_id: 'app-1', app_slug: 'app.example.demo', app_version: '0.1.0', scopes: [],
      } }))
      return
    }
    if (request.method === 'DELETE' && request.url === '/api/portal/user/apps/app-1/sessions/session-1') {
      response.end(JSON.stringify({ data: { success: true } }))
      return
    }
    if (request.url === '/v1/models') {
      if (request.headers.authorization !== 'Bearer ast-user-1') {
        response.statusCode = 401
        response.end(JSON.stringify({ error: 'invalid app session' }))
        return
      }
      response.end(JSON.stringify({ data: [{ id: 'platform-text', name: '平台文本模型', type: 'text' }] }))
      return
    }
    response.statusCode = 404
    response.end(JSON.stringify({ error: 'not found' }))
  })
  await new Promise((resolvePromise) => platform.listen(0, '127.0.0.1', resolvePromise))
  const platformAddress = platform.address()
  const env = {
    ...process.env,
    PROXY_USER_ACCESS_TOKEN: 'management-session-that-must-not-leak',
    PROXY_API_BASE_URL: `http://127.0.0.1:${platformAddress.port}/api`,
    PROXY_PORTAL_URL: `http://127.0.0.1:${platformAddress.port}`,
    PROXY_APP_DEV_RESULT_FILE: resultPath,
  }
  try {
    await exec(process.execPath, [cli.pathname, 'init', appDir, '--name', 'Dev cleanup'], { env })
    await writeFile(join(appDir, '.proxy-app.json'), JSON.stringify({ app_id: 'app-1', slug: 'app.example.demo' }))
    const manifestPath = join(appDir, 'manifest.json')
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
    manifest.id = 'app.example.demo'
    await writeFile(manifestPath, JSON.stringify(manifest))
    await writeFile(join(appDir, 'package.json'), JSON.stringify({
      name: 'proxy-app-dev-cleanup-test',
      private: true,
      scripts: { dev: 'node dev-exit.mjs' },
    }))
    await writeFile(join(appDir, 'dev-exit.mjs'), `import { writeFile } from 'node:fs/promises'
await writeFile(process.env.PROXY_APP_DEV_RESULT_FILE, JSON.stringify({
  hasManagementSession: Boolean(process.env.PROXY_USER_ACCESS_TOKEN || process.env.PROXY_ACCESS_TOKEN),
  hasPlatformAPI: Boolean(process.env.PROXY_API_BASE_URL),
  hasGateway: Boolean(process.env.PROXY_PLATFORM_GATEWAY_URL),
  hasRuntime: Boolean(process.env.PROXY_PLATFORM_RUNTIME_URL),
  hasBridge: Boolean(process.env.PROXY_PLATFORM_BRIDGE_URL),
  hasAuth: Boolean(process.env.PROXY_PLATFORM_AUTH_URL),
}))
process.exit(1)
`)
    await assert.rejects(exec(process.execPath, [cli.pathname, 'dev', appDir, '--port', '5187'], { env }), /npm exited with 1/)
    const childResult = JSON.parse(await readFile(resultPath, 'utf8'))
    assert.equal(childResult.hasManagementSession, false)
    assert.equal(childResult.hasPlatformAPI, false)
    assert.equal(childResult.hasGateway, true)
    assert.equal(childResult.hasRuntime, true)
    assert.equal(childResult.hasBridge, false)
    assert.equal(childResult.hasAuth, true)
    assert.equal(requests.length, 0)
  } finally {
    await new Promise((resolvePromise) => platform.close(resolvePromise))
    await rm(temp, { recursive: true, force: true })
  }
})

test('dev requires a linked app for the real platform relay', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'proxy-app-cli-dev-real-'))
  const appDir = join(temp, 'demo')
  try {
    await exec(process.execPath, [cli.pathname, 'init', appDir])
    await assert.rejects(exec(process.execPath, [cli.pathname, 'dev', appDir]), /app binding is missing or invalid/)
  } finally {
    await rm(temp, { recursive: true, force: true })
  }
})

test('dev rejects mock mode instead of providing an offline runtime', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'proxy-app-cli-no-mock-'))
  const appDir = join(temp, 'demo')
  try {
    await exec(process.execPath, [cli.pathname, 'init', appDir])
    await assert.rejects(
      exec(process.execPath, [cli.pathname, 'dev', appDir, '--mock']),
      /unsupported dev option: --mock; local development always uses the real platform/,
    )
  } finally {
    await rm(temp, { recursive: true, force: true })
  }
})
