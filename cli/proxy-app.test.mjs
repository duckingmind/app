import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createServer } from 'node:http'
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { createConnection, createServer as createTCPServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import test from 'node:test'
import { unzipSync } from 'fflate'

const exec = promisify(execFile)
const cli = new URL('./proxy-app.mjs', import.meta.url)

async function installBuildFixture(appDir) {
  await writeFile(join(appDir, 'package.json'), JSON.stringify({
    name: 'proxy-app-build-fixture', private: true, type: 'module', scripts: { build: 'node build-fixture.mjs' },
  }))
  await writeFile(join(appDir, 'build-fixture.mjs'), `import { mkdir, readFile, writeFile } from 'node:fs/promises'
const manifest = JSON.parse(await readFile('manifest.json', 'utf8'))
const previous = await readFile('build-count.txt', 'utf8').catch(() => '0')
const build = Number(previous) + 1
await writeFile('build-count.txt', String(build))
if (process.env.PROXY_TEST_BUILD_FAIL === '1') {
  console.error('fixture build failed')
  process.exit(17)
}
if (process.env.PROXY_TEST_BUILD_NOOP === '1') process.exit(0)
if (process.env.PROXY_TEST_BUILD_DELAY_MS) {
  console.log('fixture build waiting')
  await new Promise(resolve => setTimeout(resolve, Number(process.env.PROXY_TEST_BUILD_DELAY_MS)))
}
await mkdir('dist', { recursive: true })
await writeFile('dist/index.html', '<!doctype html><script type="module" src="./app.js"></script>')
await writeFile('dist/app.js', 'globalThis.builtApp = ' + JSON.stringify({ id: manifest.id, version: manifest.version, build }))
if (process.env.PROXY_TEST_MUTATE_MANIFEST === '1') {
  await writeFile('manifest.json', JSON.stringify({ ...manifest, version: '9.9.9' }))
}
`)
}

async function buildCount(appDir) {
  return Number(await readFile(join(appDir, 'build-count.txt'), 'utf8').catch(() => '0'))
}

function bundleContents(bundle) {
  const files = unzipSync(new Uint8Array(bundle))
  const manifest = JSON.parse(Buffer.from(files['manifest.json']).toString())
  const builtApp = JSON.parse(Buffer.from(files['app.js']).toString().replace('globalThis.builtApp = ', ''))
  return { manifest, builtApp, files }
}

async function releaseFixture(t, { binding = true } = {}) {
  const temp = await mkdtemp(join(tmpdir(), 'proxy-app-release-build-'))
  const appDir = join(temp, 'demo')
  const requests = []
  const remoteApp = { id: 'app-build', slug: 'app.proxy.buildfixture', status: 'draft', versions: [] }
  const server = createServer(async (request, response) => {
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    const entry = { method: request.method, url: request.url }
    requests.push(entry)
    response.setHeader('Content-Type', 'application/json')
    if (request.method === 'GET' && request.url === '/api/portal/user/app-workspace') {
      response.end(JSON.stringify({ data: { items: [remoteApp] } }))
    } else if (request.method === 'POST' && request.url === '/api/portal/user/app-workspace/app-build/versions') {
      const form = await new Response(Buffer.concat(chunks), { headers: { 'Content-Type': request.headers['content-type'] } }).formData()
      entry.bundle = Buffer.from(await form.get('file').arrayBuffer())
      const { manifest } = bundleContents(entry.bundle)
      const version = { version: manifest.version, review_status: 'draft', artifact_size: entry.bundle.length }
      remoteApp.versions = [...remoteApp.versions.filter(item => item.version !== version.version), version]
      response.end(JSON.stringify({ data: version }))
    } else if (request.method === 'POST' && request.url === '/api/portal/user/app-workspace/app-build/opening') {
      entry.body = JSON.parse(Buffer.concat(chunks).toString())
      response.end(JSON.stringify({ data: { success: true } }))
    } else if (request.method === 'POST' && /^\/api\/portal\/user\/app-workspace\/app-build\/versions\/[^/]+\/publish$/.test(request.url)) {
      const selected = decodeURIComponent(request.url.split('/').at(-2))
      const version = remoteApp.versions.find(item => item.version === selected)
      if (!version) {
        response.statusCode = 404
        response.end(JSON.stringify({ error: 'version not found' }))
      } else {
        version.review_status = 'published'
        remoteApp.current_version = selected
        response.end(JSON.stringify({ data: { success: true } }))
      }
    } else {
      response.statusCode = 404
      response.end(JSON.stringify({ error: 'unexpected fixture request' }))
    }
  })
  await new Promise((resolvePromise) => server.listen(0, '127.0.0.1', resolvePromise))
  t.after(async () => {
    await new Promise((resolvePromise) => server.close(resolvePromise))
    await rm(temp, { recursive: true, force: true })
  })
  const env = { ...process.env, PROXY_USER_ACCESS_TOKEN: 'fixture-management-token', PROXY_API_BASE_URL: `http://127.0.0.1:${server.address().port}/api` }
  await exec(process.execPath, [cli.pathname, 'init', appDir], { env })
  const manifest = JSON.parse(await readFile(join(appDir, 'manifest.json'), 'utf8'))
  manifest.id = remoteApp.slug
  await writeFile(join(appDir, 'manifest.json'), JSON.stringify(manifest))
  if (binding) await writeFile(join(appDir, '.proxy-app.json'), JSON.stringify({ app_id: remoteApp.id, slug: remoteApp.slug }))
  await installBuildFixture(appDir)
  return { appDir, temp, env, requests, remoteApp, manifest }
}

test('upload resolves an existing app from manifest.id without a local link file', async t => {
  const fixture = await releaseFixture(t, { binding: false })
  const result = await exec(process.execPath, [cli.pathname, 'upload', fixture.appDir], { env: fixture.env })
  assert.match(result.stdout, /"uploaded"/)
  const uploaded = fixture.requests.find(request => request.bundle)
  assert.ok(uploaded, 'upload request should be sent without .proxy-app.json')
  assert.equal(bundleContents(uploaded.bundle).manifest.id, fixture.remoteApp.slug)
})

test('init generates an automatic local identifier and validates', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'proxy-app-cli-'))
  const app = join(temp, 'demo')
  try {
    await exec(process.execPath, [cli.pathname, 'init', app, '--name', 'Demo'])
    const manifest = JSON.parse(await readFile(join(app, 'manifest.json'), 'utf8'))
    assert.match(manifest.id, /^app\.proxy\.local\.[a-f0-9]{16}$/)
    assert.equal(manifest.name, 'Demo')
    assert.equal(manifest.desktop, undefined)
    assert.equal(manifest.runtime, undefined)
    assert.equal(manifest.backend, undefined)
    assert.equal(manifest.pricing, undefined)
    assert.equal(manifest.permissions, undefined)
    assert.equal(manifest.apis, undefined)
    assert.equal(manifest.agent, undefined)
    assert.match(await readFile(join(app, 'src', 'agent-tools.mjs'), 'utf8'), /export const agentMetadata/)
    const agentTools = await readFile(join(app, 'src', 'agent-tools.mjs'), 'utf8')
    assert.match(agentTools, /export function registerAgentTools/)
    assert.match(agentTools, /registry\.register\(\{/)
    assert.match(agentTools, /async \(\) => \(\{ appId: app\.id/)
    assert.doesNotMatch(agentTools, /export const capabilities/)
    const module = await import(`${pathToFileURL(join(app, 'src', 'agent-tools.mjs')).href}?runtime-test`)
    const registered = []
    const disposers = module.registerAgentTools({ register(declaration, handler) { registered.push({ declaration, handler }); return () => {} } }, manifest)
    assert.deepEqual(registered.map(({ declaration }) => declaration.name), ['read_metadata'])
    assert.equal(typeof registered[0].handler, 'function')
    assert.deepEqual(await registered[0].handler(), { appId: manifest.id, version: manifest.version, name: manifest.name })
    assert.equal(disposers.length, 1)
    const main = await readFile(join(app, 'src', 'main.ts'), 'utf8')
    assert.match(main, /registerAgentTools\(/)
    assert.doesNotMatch(main, /capability\('read_metadata'\)/)
    const mainSource = await readFile(join(app, 'src', 'main.ts'), 'utf8')
    assert.match(mainSource, /runtime: import\.meta\.env\.DEV \? 'local' : undefined/)
    assert.match(mainSource, /appVersion: manifest\.version/)
    assert.match(mainSource, /VITE_PROXY_PORTAL_URL/)
    const pkg = JSON.parse(await readFile(join(app, 'package.json'), 'utf8'))
    const cliPackage = JSON.parse(await readFile(new URL('./package.json', import.meta.url), 'utf8'))
    assert.equal(pkg.scripts.dev, 'proxy-app dev')
    assert.equal(pkg.scripts['dev:server'], 'vite')
    assert.equal(pkg.devDependencies[cliPackage.name], `^${cliPackage.version}`)
    assert.equal(JSON.parse(await readFile(join(app, 'agent', 'examples.json'), 'utf8'))[0].capability, 'read_metadata')
    assert.match(await readFile(join(app, 'README.md'), 'utf8'), /应用开发指南/)
    assert.match(await readFile(join(app, 'README.md'), 'utf8'), /npm run dev/)
    assert.match(await readFile(join(app, 'README.md'), 'utf8'), /公开 slug/)
    assert.doesNotMatch(await readFile(join(app, 'README.md'), 'utf8'), /proxy-app link <app-id>/)
    assert.match(await readFile(join(app, 'vite.config.ts'), 'utf8'), /base: '\.\/'/)
    assert.match(await readFile(join(app, 'vite.config.ts'), 'utf8'), /createPlatformDevSessionPlugin\(\)/)
    const result = await exec(process.execPath, [cli.pathname, 'validate', app])
    assert.match(result.stdout, /"valid": true/)
  } finally {
    await rm(temp, { recursive: true, force: true })
  }
})

test('validate accepts legacy runtime and desktop metadata', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'proxy-app-retired-runtime-'))
  const app = join(temp, 'demo')
  try {
    await exec(process.execPath, [cli.pathname, 'init', app, '--name', 'Retired runtime'])
    const manifestPath = join(app, 'manifest.json')
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
    await writeFile(manifestPath, JSON.stringify({ ...manifest, runtime: { type: 'iframe', entry: 'index.html' } }))
    await assert.doesNotReject(exec(process.execPath, [cli.pathname, 'validate', app]))
    await writeFile(manifestPath, JSON.stringify({ ...manifest, desktop: { supported: true } }))
    await assert.doesNotReject(exec(process.execPath, [cli.pathname, 'validate', app]))
  } finally {
    await rm(temp, { recursive: true, force: true })
  }
})

test('container backend manifest validates a safe Node entry and rejects unsupported fields', async (t) => {
  const temp = await mkdtemp(join(tmpdir(), 'proxy-app-container-manifest-'))
  const appDir = join(temp, 'demo')
  t.after(() => rm(temp, { recursive: true, force: true }))
  await exec(process.execPath, [cli.pathname, 'init', appDir])
  await mkdir(join(appDir, 'server'), { recursive: true })
  await writeFile(join(appDir, 'server', 'index.mjs'), 'export {}\n')
  const manifestPath = join(appDir, 'manifest.json')
  const base = JSON.parse(await readFile(manifestPath, 'utf8'))
  const backend = {
    type: 'container', runtime: 'node22', entry: 'server/index.mjs', port: 8080,
    health_check: '/healthz', routes: ['/api/*'],
    resources: { cpu_millicores: 500, memory_mib: 512, max_concurrency: 40 },
  }
  await writeFile(manifestPath, JSON.stringify({ ...base, backend }))
  const valid = await exec(process.execPath, [cli.pathname, 'validate', appDir])
  assert.equal(JSON.parse(valid.stdout).valid, true)

  for (const invalid of [
    { ...backend, runtime: 'node20' },
    { ...backend, entry: '../server/index.mjs' },
    { ...backend, entry: 'server//index.mjs' },
    { ...backend, entry: 'src/index.mjs' },
    { ...backend, port: 65536 },
    { ...backend, health_check: '//example.test/health' },
    { ...backend, routes: ['/v1/*'] },
    { ...backend, routes: ['/api/*', '/api/*'] },
    { ...backend, resources: { memory_mib: 0 } },
  ]) {
    await writeFile(manifestPath, JSON.stringify({ ...base, backend: invalid }))
    await assert.rejects(exec(process.execPath, [cli.pathname, 'validate', appDir]), /manifest\.backend/)
  }
  await writeFile(manifestPath, JSON.stringify({ ...base, backend: { ...backend, entry: 'server/missing.mjs' } }))
  await assert.rejects(exec(process.execPath, [cli.pathname, 'validate', appDir]), /entry does not exist/)
})

test('container package includes server sources, while current cloud upload remains closed', async (t) => {
  const fixture = await releaseFixture(t)
  const manifestPath = join(fixture.appDir, 'manifest.json')
  await mkdir(join(fixture.appDir, 'server'), { recursive: true })
  await writeFile(join(fixture.appDir, 'server', 'index.mjs'), 'export const backend = true\n')
  await writeFile(manifestPath, JSON.stringify({ ...fixture.manifest, backend: {
    type: 'container', runtime: 'node22', entry: 'server/index.mjs', port: 8080,
  } }))
  const output = join(fixture.temp, 'container-app.zip')
  await exec(process.execPath, [cli.pathname, 'pack', fixture.appDir, output], { env: fixture.env })
  const files = unzipSync(new Uint8Array(await readFile(output)))
  assert.equal(Buffer.from(files['server/index.mjs']).toString(), 'export const backend = true\n')
  assert.equal(JSON.parse(Buffer.from(files['manifest.json']).toString()).backend.type, 'container')
  await assert.rejects(exec(process.execPath, [cli.pathname, 'upload', fixture.appDir], { env: fixture.env }), /尚未支持云端容器后端/)
  assert.equal(fixture.requests.some(request => request.method === 'POST'), false)
})

test('pack includes a compiled stateless handler from the build output', async (t) => {
  const fixture = await releaseFixture(t)
  const buildPath = join(fixture.appDir, 'build-fixture.mjs')
  const build = await readFile(buildPath, 'utf8')
  await writeFile(buildPath, `${build}\nawait mkdir('dist/runtime', { recursive: true })\nawait writeFile('dist/runtime/handler.js', "export const handler = async () => new Response('ok')\\n")\n`)
  const output = join(fixture.temp, 'handler-app.zip')
  await exec(process.execPath, [cli.pathname, 'pack', fixture.appDir, output], { env: fixture.env })
  const files = unzipSync(new Uint8Array(await readFile(output)))
  assert.equal(Buffer.from(files['runtime/handler.js']).toString(), "export const handler = async () => new Response('ok')\n")
})

test('pack includes both one-time and task function entries', async (t) => {
  const fixture = await releaseFixture(t)
  const manifestPath = join(fixture.appDir, 'manifest.json')
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  manifest.functions = {
    request: { entry: 'runtime/handler.js', source: 'src/runtime/handler.ts', routes: ['/api/demo/run'] },
    task: { entry: 'runtime/task.js', source: 'src/runtime/task.ts', concurrency: 4, max_attempts: 2, timeout_ms: 900000 },
  }
  await writeFile(manifestPath, JSON.stringify(manifest))
  await mkdir(join(fixture.appDir, 'src', 'runtime'), { recursive: true })
  await writeFile(join(fixture.appDir, 'src', 'runtime', 'handler.ts'), 'export const handler = true\n')
  await writeFile(join(fixture.appDir, 'src', 'runtime', 'task.ts'), 'export const taskFunction = true\n')
  const buildPath = join(fixture.appDir, 'build-fixture.mjs')
  const build = await readFile(buildPath, 'utf8')
  await writeFile(buildPath, `${build}\nawait mkdir('dist/runtime', { recursive: true })\nawait writeFile('dist/runtime/handler.js', 'export const handler = true\\n')\nawait writeFile('dist/runtime/task.js', 'export const taskFunction = true\\n')\n`)
  const output = join(fixture.temp, 'two-functions.zip')
  await exec(process.execPath, [cli.pathname, 'pack', fixture.appDir, output], { env: fixture.env })
  const files = unzipSync(new Uint8Array(await readFile(output)))
  assert.equal(Buffer.from(files['runtime/handler.js']).toString(), 'export const handler = true\n')
  assert.equal(Buffer.from(files['runtime/task.js']).toString(), 'export const taskFunction = true\n')
  assert.deepEqual(JSON.parse(Buffer.from(files['manifest.json']).toString()).functions.task, manifest.functions.task)
})

test('validate and pack accept short public slugs without adding a prefix', async t => {
  const temp = await mkdtemp(join(tmpdir(), 'proxy-app-short-slug-'))
  const appDir = join(temp, 'demo')
  t.after(() => rm(temp, { recursive: true, force: true }))
  await exec(process.execPath, [cli.pathname, 'init', appDir])
  const manifestPath = join(appDir, 'manifest.json')
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  for (const slug of ['canvas', 'x', '7', 'canvas-v2', 'studio.canvas', 'app.proxy.canvas', 'a'.repeat(120), 'app_stable_canvas']) {
    await writeFile(manifestPath, JSON.stringify({ ...manifest, id: slug }))
    const result = await exec(process.execPath, [cli.pathname, 'validate', appDir])
    assert.equal(JSON.parse(result.stdout).id, slug)
  }
  for (const slug of ['', 'Canvas', 'canvas_', 'canvas..test', 'canvas.-test', '-canvas', 'canvas-', 'canvas test', 'canvas/app', 'canvas\n', 'app_stable_canvas\n', 'a'.repeat(121), 'a.'.repeat(60) + 'a', 7]) {
    await writeFile(manifestPath, JSON.stringify({ ...manifest, id: slug }))
    await assert.rejects(exec(process.execPath, [cli.pathname, 'validate', appDir]), /manifest.id is invalid/)
  }
  await writeFile(manifestPath, JSON.stringify({ ...manifest, id: 'canvas' }))
  await installBuildFixture(appDir)
  await exec(process.execPath, [cli.pathname, 'pack', appDir])
  const bundle = bundleContents(await readFile(join(appDir, `canvas-${manifest.version}.zip`)))
  assert.equal(bundle.manifest.id, 'canvas')
  assert.equal(bundle.builtApp.id, 'canvas')
  const validated = await exec(process.execPath, [cli.pathname, 'validate', appDir])
  assert.equal(JSON.parse(validated.stdout).id, 'canvas')
})

test('create and link preserve short public slugs while retaining the platform stable binding', async t => {
  const temp = await mkdtemp(join(tmpdir(), 'proxy-app-short-binding-'))
  const appDir = join(temp, 'demo')
  const app = { id: 'app_stable_canvas', slug: 'canvas', app_aliases: ['app.proxy.canvas'] }
  const server = createServer((request, response) => {
    response.setHeader('Content-Type', 'application/json')
    if (request.url !== '/api/portal/user/app-workspace') {
      response.writeHead(404).end('{}')
      return
    }
    response.end(JSON.stringify({ data: request.method === 'POST' ? app : { items: [app] } }))
  })
  await new Promise(resolvePromise => server.listen(0, '127.0.0.1', resolvePromise))
  t.after(async () => {
    await new Promise(resolvePromise => server.close(resolvePromise))
    await rm(temp, { recursive: true, force: true })
  })
  const env = { ...process.env, PROXY_USER_ACCESS_TOKEN: 'fixture-token', PROXY_API_BASE_URL: `http://127.0.0.1:${server.address().port}/api` }
  await exec(process.execPath, [cli.pathname, 'init', appDir], { env })
  await exec(process.execPath, [cli.pathname, 'create', appDir], { env })
  const manifestPath = join(appDir, 'manifest.json')
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  assert.equal(manifest.id, app.id)
  assert.deepEqual(JSON.parse(await readFile(join(appDir, '.proxy-app.json'), 'utf8')), {
    app_id: app.id, slug: 'canvas', app_aliases: ['app.proxy.canvas'],
  })
  // Saved aliases came from the selected platform app, not prefix guessing.
  await writeFile(manifestPath, JSON.stringify({ ...manifest, id: 'app.proxy.canvas' }))
  await exec(process.execPath, [cli.pathname, 'validate', appDir], { env })
  await exec(process.execPath, [cli.pathname, 'link', appDir, app.id], { env })
  assert.equal(JSON.parse(await readFile(manifestPath, 'utf8')).id, app.id)
  assert.equal(JSON.parse(await readFile(join(appDir, '.proxy-app.json'), 'utf8')).slug, 'canvas')
})

test('publish accepts an old slug only when the selected platform app confirms its alias', async t => {
  const f = await releaseFixture(t)
  f.remoteApp.slug = 'canvas'
  f.remoteApp.status = 'published'
  f.remoteApp.current_version = '0.0.1'
  f.manifest.id = 'app.proxy.canvas'
  await writeFile(join(f.appDir, 'manifest.json'), JSON.stringify(f.manifest))
  await writeFile(join(f.appDir, '.proxy-app.json'), JSON.stringify({ app_id: f.remoteApp.id, slug: 'app.proxy.canvas' }))
  await assert.rejects(exec(process.execPath, [cli.pathname, 'publish', f.appDir], { env: f.env }), /应用不存在或当前账户无权访问/)
  assert.equal(f.requests.some(request => request.method === 'POST'), false)
  assert.equal(await buildCount(f.appDir), 0)
  f.remoteApp.app_aliases = ['app.proxy.canvas']
  await exec(process.execPath, [cli.pathname, 'publish', f.appDir], { env: f.env })
  assert.equal(f.remoteApp.current_version, f.manifest.version)
  const uploaded = f.requests.find(request => request.bundle)
  assert.equal(bundleContents(uploaded.bundle).manifest.id, 'app.proxy.canvas')
  assert.equal(f.remoteApp.slug, 'canvas', 'publishing an old package must not rename the app back')
})

test('pack rebuilds stale artifacts and supports current-directory and legacy output arguments', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'proxy-app-cli-pack-'))
  const app = join(temp, 'demo')
  try {
    await exec(process.execPath, [cli.pathname, 'init', app])
    await installBuildFixture(app)
    const firstOutput = join(temp, 'legacy output.zip')
    await exec(process.execPath, [cli.pathname, 'pack', app, firstOutput])
    const first = bundleContents(await readFile(firstOutput))
    assert.equal(first.builtApp.build, 1)
    assert.equal(first.builtApp.id, first.manifest.id)
    assert.equal(first.builtApp.version, first.manifest.version)
    await writeFile(join(app, 'dist', 'old-chunk.js'), 'globalThis.obsoleteBuild = true')

    const manifest = { ...JSON.parse(await readFile(join(app, 'manifest.json'), 'utf8')), id: 'app.proxy.relinked', version: '0.2.0' }
    await writeFile(join(app, 'manifest.json'), JSON.stringify(manifest))
    await assert.rejects(exec(process.execPath, [cli.pathname, 'validate'], { cwd: app }), /manifest|构建|build/i)
    await exec(process.execPath, [cli.pathname, 'pack', '-o', 'artifacts with spaces/latest app.zip'], { cwd: app })
    const rebuilt = bundleContents(await readFile(join(app, 'artifacts with spaces/latest app.zip')))
    assert.deepEqual(rebuilt.builtApp, { id: manifest.id, version: '0.2.0', build: 2 })
    assert.equal(rebuilt.manifest.id, manifest.id)
    assert.equal(rebuilt.manifest.version, manifest.version)
    assert.equal(rebuilt.manifest.agent.contract_source, 'code')
    assert.equal(await buildCount(app), 2)
    assert.deepEqual(Object.keys(rebuilt.files).sort(), ['agent/examples.json', 'agent/guide.md', 'agent/workflow.md', 'app.js', 'index.html', 'manifest.json'])

    await exec(process.execPath, [cli.pathname, 'pack'], { cwd: app })
    assert.equal(bundleContents(await readFile(join(app, `${manifest.id}-${manifest.version}.zip`))).builtApp.build, 3)
  } finally {
    await rm(temp, { recursive: true, force: true })
  }
})

test('source packaging remains an explicit debugging escape hatch without building', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'proxy-app-cli-source-'))
  const app = join(temp, 'demo')
  try {
    await exec(process.execPath, [cli.pathname, 'init', app])
    await installBuildFixture(app)
    const output = join(temp, 'source.zip')
    await exec(process.execPath, [cli.pathname, 'pack', '--source', '--output', output], {
      cwd: app, env: { ...process.env, PROXY_TEST_BUILD_FAIL: '1' },
    })
    assert.equal(await buildCount(app), 0)
    const files = unzipSync(new Uint8Array(await readFile(output)))
    assert.ok(files['src/main.ts'])
    assert.ok(files['manifest.json'])
  } finally {
    await rm(temp, { recursive: true, force: true })
  }
})

for (const command of ['upload', 'publish']) {
  test(`${command} builds a new draft exactly once and uploads the freshly built bundle`, async (t) => {
    const fixture = await releaseFixture(t)
    await mkdir(join(fixture.appDir, 'dist'), { recursive: true })
    await writeFile(join(fixture.appDir, 'dist', 'index.html'), '<html>old build</html>')
    await writeFile(join(fixture.appDir, 'dist', 'app.js'), 'globalThis.builtApp = {"id":"app.proxy.old","version":"0.0.1","build":0}')
    await exec(process.execPath, [cli.pathname, command, '--output', 'release output/latest.zip'], { cwd: fixture.appDir, env: fixture.env })
    assert.equal(await buildCount(fixture.appDir), 1)
    const uploads = fixture.requests.filter((request) => request.bundle)
    assert.equal(uploads.length, 1)
    const { manifest, builtApp } = bundleContents(uploads[0].bundle)
    const generatedManifest = JSON.parse(await readFile(join(fixture.appDir, 'dist', 'manifest.json'), 'utf8'))
    assert.deepEqual(manifest, generatedManifest)
    assert.deepEqual(builtApp, { id: fixture.manifest.id, version: fixture.manifest.version, build: 1 })
    assert.deepEqual(uploads[0].bundle, await readFile(join(fixture.appDir, 'release output/latest.zip')))
    assert.equal(fixture.requests.filter((request) => request.url.endsWith('/opening')).length, command === 'publish' ? 1 : 0)
  })
}

for (const command of ['pack', 'upload', 'publish']) {
  test(`${command} never packages or uploads stale dist when its build fails`, async (t) => {
    const fixture = await releaseFixture(t)
    const oldOutput = join(fixture.temp, 'previous.zip')
    await exec(process.execPath, [cli.pathname, 'pack', fixture.appDir, oldOutput], { env: fixture.env })
    const oldBundle = await readFile(oldOutput)
    const oldEntry = await readFile(join(fixture.appDir, 'dist', 'index.html'))
    const oldScript = await readFile(join(fixture.appDir, 'dist', 'app.js'))
    const oldManifest = await readFile(join(fixture.appDir, 'dist', 'manifest.json'))
    const manifest = { ...fixture.manifest, version: '0.2.0' }
    await writeFile(join(fixture.appDir, 'manifest.json'), JSON.stringify(manifest))
    const failedOutput = join(fixture.temp, 'failed.zip')
    await assert.rejects(exec(process.execPath, [cli.pathname, command, fixture.appDir, failedOutput], {
      env: { ...fixture.env, PROXY_TEST_BUILD_FAIL: '1' },
    }), /fixture build failed/)
    assert.equal(await buildCount(fixture.appDir), 2)
    await assert.rejects(readFile(failedOutput), { code: 'ENOENT' })
    assert.deepEqual(await readFile(oldOutput), oldBundle)
    assert.deepEqual(await readFile(join(fixture.appDir, 'dist', 'index.html')), oldEntry)
    assert.deepEqual(await readFile(join(fixture.appDir, 'dist', 'app.js')), oldScript)
    assert.deepEqual(await readFile(join(fixture.appDir, 'dist', 'manifest.json')), oldManifest)
    assert.equal(fixture.requests.some((request) => request.method === 'POST'), false)
  })
}

for (const command of ['pack', 'upload']) {
  test(`${command} rejects a successful no-op build and restores the previous artifacts`, async (t) => {
    const fixture = await releaseFixture(t)
    await exec(process.execPath, [cli.pathname, 'build'], { cwd: fixture.appDir, env: fixture.env })
    const oldEntry = await readFile(join(fixture.appDir, 'dist', 'index.html'))
    const oldScript = await readFile(join(fixture.appDir, 'dist', 'app.js'))
    const oldManifest = await readFile(join(fixture.appDir, 'dist', 'manifest.json'))
    await writeFile(join(fixture.appDir, 'manifest.json'), JSON.stringify({ ...fixture.manifest, id: fixture.remoteApp.slug, version: '0.2.0' }))
    const output = join(fixture.temp, 'no-op.zip')
    await assert.rejects(exec(process.execPath, [cli.pathname, command, '-o', output], {
      cwd: fixture.appDir, env: { ...fixture.env, PROXY_TEST_BUILD_NOOP: '1' },
    }), /build output is missing|dist/)
    assert.equal(await buildCount(fixture.appDir), 2)
    await assert.rejects(readFile(output), { code: 'ENOENT' })
    assert.deepEqual(await readFile(join(fixture.appDir, 'dist', 'index.html')), oldEntry)
    assert.deepEqual(await readFile(join(fixture.appDir, 'dist', 'app.js')), oldScript)
    assert.deepEqual(await readFile(join(fixture.appDir, 'dist', 'manifest.json')), oldManifest)
    assert.equal(fixture.requests.some((request) => request.method === 'POST'), false)
  })
}

test('a concurrent pack is rejected without replacing the active build artifacts', async (t) => {
  const fixture = await releaseFixture(t)
  const firstOutput = join(fixture.temp, 'active.zip')
  const secondOutput = join(fixture.temp, 'concurrent.zip')
  const first = startCLI(['pack', fixture.appDir, firstOutput], {
    env: { ...fixture.env, PROXY_TEST_BUILD_DELAY_MS: '3000' },
  })
  t.after(async () => { first.child.kill('SIGTERM'); await first.completed })
  await first.waitForOutput(/fixture build waiting/)
  await assert.rejects(exec(process.execPath, [cli.pathname, 'pack', fixture.appDir, secondOutput], {
    env: fixture.env,
  }), /正在.*构建|构建.*正在|already|并发|busy|锁/i)
  const completed = await first.completed
  assert.equal(completed.error, null, completed.stderr)
  assert.equal(await buildCount(fixture.appDir), 1)
  assert.equal(bundleContents(await readFile(firstOutput)).builtApp.build, 1)
  await assert.rejects(readFile(secondOutput), { code: 'ENOENT' })
})

for (const signal of ['SIGINT', 'SIGTERM']) {
  test(`pack ${signal} restores the previous build and permits a subsequent pack`, async (t) => {
    const fixture = await releaseFixture(t)
    await exec(process.execPath, [cli.pathname, 'build'], { cwd: fixture.appDir, env: fixture.env })
    const oldScript = await readFile(join(fixture.appDir, 'dist', 'app.js'))
    const oldManifest = await readFile(join(fixture.appDir, 'dist', 'manifest.json'))
    const output = join(fixture.temp, 'canceled.zip')
    const invocation = startCLI(['pack', fixture.appDir, output], {
      env: { ...fixture.env, PROXY_TEST_BUILD_DELAY_MS: '5000' },
    })
    t.after(async () => { invocation.child.kill('SIGTERM'); await invocation.completed })
    await invocation.waitForOutput(/fixture build waiting/)
    invocation.child.kill(signal)
    const completed = await invocation.completed
    assert.ok(completed.error)
    assert.match(completed.stderr, /构建已取消/)
    assert.deepEqual(await readFile(join(fixture.appDir, 'dist', 'app.js')), oldScript)
    assert.deepEqual(await readFile(join(fixture.appDir, 'dist', 'manifest.json')), oldManifest)
    await assert.rejects(readFile(output), { code: 'ENOENT' })
    await exec(process.execPath, [cli.pathname, 'pack', fixture.appDir, output], { env: fixture.env })
    assert.equal(bundleContents(await readFile(output)).builtApp.build, 3)
  })
}

test('pack rejects a manifest changed during compilation instead of mixing artifact identities', async (t) => {
  const fixture = await releaseFixture(t)
  const output = join(fixture.temp, 'changed-manifest.zip')
  await assert.rejects(exec(process.execPath, [cli.pathname, 'pack', fixture.appDir, output], {
    env: { ...fixture.env, PROXY_TEST_MUTATE_MANIFEST: '1' },
  }), /manifest.*(?:changed|变更|变化|修改)|(?:changed|变更|变化|修改).*manifest/i)
  assert.equal(await buildCount(fixture.appDir), 1)
  await assert.rejects(readFile(output), { code: 'ENOENT' })
})

test('pack stops recursive package build commands before a second build starts', async (t) => {
  const fixture = await releaseFixture(t)
  await writeFile(join(fixture.appDir, 'package.json'), JSON.stringify({
    name: 'proxy-app-recursive-build-fixture', private: true, type: 'module', scripts: { build: 'node recursive-build.mjs' },
  }))
  await writeFile(join(fixture.appDir, 'recursive-build.mjs'), `import { spawnSync } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
const previous = await readFile('build-count.txt', 'utf8').catch(() => '0')
await writeFile('build-count.txt', String(Number(previous) + 1))
const child = spawnSync(process.execPath, [${JSON.stringify(cli.pathname)}, 'pack'], { stdio: 'inherit' })
process.exit(child.status ?? 1)
`)
  await assert.rejects(exec(process.execPath, [cli.pathname, 'pack'], {
    cwd: fixture.appDir, env: fixture.env, timeout: 5000,
  }), /build.*不能调用 proxy-app/)
  assert.equal(await buildCount(fixture.appDir), 1)
  await assert.rejects(readFile(join(fixture.appDir, `${fixture.manifest.id}-${fixture.manifest.version}.zip`)), { code: 'ENOENT' })
})

test('CLI rejects unknown options and missing option values before running a build', async (t) => {
  const fixture = await releaseFixture(t)
  for (const args of [
    ['pack', '--unknown'], ['upload', '--unknown'], ['publish', '--source'], ['validate', '--unknown'],
    ['pack', '-o'], ['pack', '--output'], ['upload', '--output', '--unknown'], ['dev', '--port'], ['create', '--category'],
    ['publish', '--version'], ['upload', '--version', '0.1.0'],
  ]) {
    await assert.rejects(exec(process.execPath, [cli.pathname, ...args], { cwd: fixture.appDir, env: fixture.env }),
      /unknown option|unsupported .*option|requires.*value|missing.*value|expected.*value/i)
  }
  assert.equal(await buildCount(fixture.appDir), 0)
  assert.equal(fixture.requests.length, 0)
})

test('publish rejects invalid version selection and output conflicts before contacting the platform', async (t) => {
  const fixture = await releaseFixture(t)
  for (const args of [
    ['--version', '../../version'], ['--version', 'latest'],
    ['--version', '0.1.0', '--version', '0.2.0'],
    ['--version', '0.1.0', '-o', 'ignored.zip'],
    ['.', 'ignored.zip', '--version', '0.1.0'],
  ]) {
    await assert.rejects(exec(process.execPath, [cli.pathname, 'publish', ...args], { cwd: fixture.appDir, env: fixture.env }), /version|output/i)
  }
  assert.equal(fixture.requests.length, 0)
  assert.equal(await buildCount(fixture.appDir), 0)
})

test('upload only stores the candidate of an open app; a later publish explicitly switches it', async (t) => {
  const fixture = await releaseFixture(t)
  fixture.remoteApp.status = 'published'
  fixture.remoteApp.current_version = '0.0.1'
  fixture.remoteApp.versions = [{ version: '0.0.1', review_status: 'published', artifact_size: 1024 }]
  const uploaded = await exec(process.execPath, [cli.pathname, 'upload'], { cwd: fixture.appDir, env: fixture.env })
  assert.match(uploaded.stdout, /线上版本未切换/)
  assert.equal(fixture.remoteApp.current_version, '0.0.1')
  assert.deepEqual(fixture.requests.filter(request => request.method === 'POST').map(request => request.url), ['/api/portal/user/app-workspace/app-build/versions'])
  assert.equal(fixture.remoteApp.versions.find(version => version.version === fixture.manifest.version).review_status, 'draft')
  assert.equal(await buildCount(fixture.appDir), 1)
  fixture.requests.length = 0
  await exec(process.execPath, [cli.pathname, 'publish'], { cwd: fixture.appDir, env: { ...fixture.env, PROXY_TEST_BUILD_FAIL: '1' } })
  assert.equal(fixture.remoteApp.current_version, fixture.manifest.version)
  assert.deepEqual(fixture.requests.filter(request => request.method === 'POST').map(request => request.url), [`/api/portal/user/app-workspace/app-build/versions/${fixture.manifest.version}/publish`])
  assert.equal(await buildCount(fixture.appDir), 1)
})

test('publish of a new version explicitly switches after a single build and upload', async (t) => {
  const fixture = await releaseFixture(t)
  fixture.remoteApp.status = 'published'
  fixture.remoteApp.current_version = '0.0.1'
  await exec(process.execPath, [cli.pathname, 'publish'], { cwd: fixture.appDir, env: fixture.env })
  assert.deepEqual(fixture.requests.filter(request => request.method === 'POST').map(request => request.url), [
    '/api/portal/user/app-workspace/app-build/versions',
    `/api/portal/user/app-workspace/app-build/versions/${fixture.manifest.version}/publish`,
  ])
  assert.equal(await buildCount(fixture.appDir), 1)
  assert.equal(fixture.remoteApp.current_version, fixture.manifest.version)
})

test('publish --version rolls back without changing the manifest or building and repeats idempotently', async (t) => {
  const fixture = await releaseFixture(t)
  fixture.remoteApp.status = 'paused'
  fixture.remoteApp.current_version = '0.3.0'
  fixture.remoteApp.versions = [
    { version: '0.2.0', review_status: 'published', artifact_size: 1024 },
    { version: '0.3.0', review_status: 'published', artifact_size: 2048 },
  ]
  const originalManifest = await readFile(join(fixture.appDir, 'manifest.json'), 'utf8')
  await rm(join(fixture.appDir, 'package.json'))
  const result = await exec(process.execPath, [cli.pathname, 'publish', '--version', '0.2.0'], { cwd: fixture.appDir, env: fixture.env })
  const published = JSON.parse(result.stdout)
  assert.equal(published.previous_version, '0.3.0')
  assert.equal(published.version, '0.2.0')
  assert.equal(fixture.remoteApp.current_version, '0.2.0')
  assert.equal(fixture.remoteApp.status, 'paused')
  assert.deepEqual(fixture.requests.filter(request => request.method === 'POST').map(request => request.url), ['/api/portal/user/app-workspace/app-build/versions/0.2.0/publish'])
  fixture.requests.length = 0
  const repeated = await exec(process.execPath, [cli.pathname, 'publish', fixture.appDir, '--version', '0.2.0'], { env: fixture.env })
  assert.equal(JSON.parse(repeated.stdout).changed, false)
  assert.equal(fixture.requests.some(request => request.method === 'POST'), false)
  assert.equal(await readFile(join(fixture.appDir, 'manifest.json'), 'utf8'), originalManifest)
  assert.equal(await buildCount(fixture.appDir), 0)
})

test('default publish also reactivates a historical published manifest version', async (t) => {
  const fixture = await releaseFixture(t)
  fixture.remoteApp.status = 'published'
  fixture.remoteApp.current_version = '0.3.0'
  fixture.remoteApp.versions = [{ version: fixture.manifest.version, review_status: 'published', artifact_size: 1024 }]
  await exec(process.execPath, [cli.pathname, 'publish'], { cwd: fixture.appDir, env: { ...fixture.env, PROXY_TEST_BUILD_FAIL: '1' } })
  assert.equal(fixture.remoteApp.current_version, fixture.manifest.version)
  assert.equal(await buildCount(fixture.appDir), 0)
  assert.deepEqual(fixture.requests.filter(request => request.method === 'POST').map(request => request.url), [`/api/portal/user/app-workspace/app-build/versions/${fixture.manifest.version}/publish`])
})

test('explicit version selection requires an uploaded artifact instead of building a missing candidate', async (t) => {
  const fixture = await releaseFixture(t)
  fixture.remoteApp.current_version = '0.1.0'
  fixture.remoteApp.versions = [{ version: '0.2.0', review_status: 'draft', artifact_size: 0 }]
  for (const version of ['0.2.0', '0.4.0']) {
    await assert.rejects(exec(process.execPath, [cli.pathname, 'publish', '--version', version], { cwd: fixture.appDir, env: fixture.env }), /尚未上传/)
  }
  assert.equal(fixture.requests.some(request => request.method === 'POST'), false)
  assert.equal(await buildCount(fixture.appDir), 0)
})

test('explicit uploaded versions keep the first-opening review flow and its pending-application guard', async (t) => {
  const fixture = await releaseFixture(t)
  fixture.remoteApp.versions = [{ version: '0.2.0', review_status: 'draft', artifact_size: 1024 }]
  await exec(process.execPath, [cli.pathname, 'publish', '--version', '0.2.0'], { cwd: fixture.appDir, env: fixture.env })
  assert.deepEqual(fixture.requests.filter(request => request.method === 'POST'), [{
    method: 'POST', url: '/api/portal/user/app-workspace/app-build/opening', body: { version: '0.2.0' },
  }])
  fixture.remoteApp.opening_request = { id: 'first-opening', status: 'pending', version: '0.2.0' }
  fixture.requests.length = 0
  await exec(process.execPath, [cli.pathname, 'publish', '--version', '0.2.0'], { cwd: fixture.appDir, env: fixture.env })
  assert.equal(fixture.requests.some(request => request.method === 'POST'), false)
  fixture.remoteApp.opening_request.version = '0.3.0'
  await assert.rejects(exec(process.execPath, [cli.pathname, 'publish', '--version', '0.2.0'], { cwd: fixture.appDir, env: fixture.env }), /预览版本 0\.3\.0/)
  assert.equal(fixture.requests.some(request => request.method === 'POST'), false)
  assert.equal(await buildCount(fixture.appDir), 0)
})

test('link supports the current app directory and the original app-directory argument', async (t) => {
  const fixture = await releaseFixture(t)
  for (const args of [['link', fixture.remoteApp.id], ['link', fixture.appDir, fixture.remoteApp.id]]) {
    await rm(join(fixture.appDir, '.proxy-app.json'))
    const result = await exec(process.execPath, [cli.pathname, ...args], { cwd: fixture.appDir, env: fixture.env })
    assert.equal(JSON.parse(result.stdout).app_id, fixture.remoteApp.id)
    assert.deepEqual(JSON.parse(await readFile(join(fixture.appDir, '.proxy-app.json'), 'utf8')), {
      app_id: fixture.remoteApp.id, slug: fixture.remoteApp.slug,
    })
  }
})

test('init, build, validate, status and doctor accept the current application directory', async (t) => {
  const fixture = await releaseFixture(t)
  const emptyDir = join(fixture.temp, 'current directory app')
  await mkdir(emptyDir)
  await exec(process.execPath, [cli.pathname, 'init', '--name', 'Current directory app'], { cwd: emptyDir })
  assert.equal(JSON.parse(await readFile(join(emptyDir, 'manifest.json'), 'utf8')).name, 'Current directory app')

  await exec(process.execPath, [cli.pathname, 'build'], { cwd: fixture.appDir, env: fixture.env })
  assert.equal(await buildCount(fixture.appDir), 1)
  const validated = await exec(process.execPath, [cli.pathname, 'validate'], { cwd: fixture.appDir, env: fixture.env })
  assert.equal(JSON.parse(validated.stdout).valid, true)
  const status = await exec(process.execPath, [cli.pathname, 'status'], { cwd: fixture.appDir, env: fixture.env })
  assert.equal(JSON.parse(status.stdout).app_id, fixture.remoteApp.id)
  assert.equal(JSON.parse(status.stdout).current_version, null)
  fixture.remoteApp.current_version = '0.0.1'
  const publishedStatus = JSON.parse((await exec(process.execPath, [cli.pathname, 'status'], { cwd: fixture.appDir, env: fixture.env })).stdout)
  assert.equal(publishedStatus.current_version, '0.0.1')
  assert.equal(publishedStatus.local_version, fixture.manifest.version)
  const doctor = await exec(process.execPath, [cli.pathname, 'doctor'], { cwd: fixture.appDir, env: fixture.env })
  assert.equal(JSON.parse(doctor.stdout).ok, true)
  assert.equal(await buildCount(fixture.appDir), 1)
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

test('validate rejects one-time app pricing with a migration hint', async t => {
  const temp = await mkdtemp(join(tmpdir(), 'proxy-app-cli-one-time-pricing-'))
  const appDir = join(temp, 'demo')
  t.after(() => rm(temp, { recursive: true, force: true }))
  await exec(process.execPath, [cli.pathname, 'init', appDir])
  const manifestPath = join(appDir, 'manifest.json')
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  manifest.pricing = { mode: 'one_time', one_time_price: 9.9, currency: 'USD' }
  await writeFile(manifestPath, JSON.stringify(manifest))
  await assert.rejects(exec(process.execPath, [cli.pathname, 'validate', appDir]), /one-time app pricing is no longer supported; configure commission pricing on the platform/)
})

test('validate supports omitted pricing or commission and rejects explicit free pricing', async t => {
  const temp = await mkdtemp(join(tmpdir(), 'proxy-app-cli-commission-pricing-'))
  const appDir = join(temp, 'demo')
  t.after(() => rm(temp, { recursive: true, force: true }))
  await exec(process.execPath, [cli.pathname, 'init', appDir])
  const manifestPath = join(appDir, 'manifest.json')
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  assert.equal(manifest.pricing, undefined)
  assert.equal(JSON.parse((await exec(process.execPath, [cli.pathname, 'validate', appDir])).stdout).valid, true)
  manifest.pricing = { mode: 'free' }
  await writeFile(manifestPath, JSON.stringify(manifest))
  await assert.rejects(exec(process.execPath, [cli.pathname, 'validate', appDir]), /free app pricing is no longer supported/)
  manifest.pricing = { mode: 'commission', commission_rate: 8 }
  await writeFile(manifestPath, JSON.stringify(manifest))
  assert.equal(JSON.parse((await exec(process.execPath, [cli.pathname, 'validate', appDir])).stdout).valid, true)
  manifest.pricing.commission_rate = 0
  await writeFile(manifestPath, JSON.stringify(manifest))
  await assert.rejects(exec(process.execPath, [cli.pathname, 'validate', appDir]), /commission pricing requires commission_rate/)
})

test('legacy explicit permissions and APIs accept the complete public catalog and reject unknown names', async t => {
  const temp = await mkdtemp(join(tmpdir(), 'proxy-app-cli-public-catalog-'))
  const appDir = join(temp, 'demo')
  t.after(() => rm(temp, { recursive: true, force: true }))
  await exec(process.execPath, [cli.pathname, 'init', appDir])
  const manifestPath = join(appDir, 'manifest.json')
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  manifest.permissions = ['user.profile.read', 'platform.capabilities.read', 'storage.user', 'notification', 'theme.read', 'locale.read']
  manifest.apis = ['model.responses', 'model.chat', 'model.messages', 'model.embeddings', 'model.images', 'model.videos', 'model.music', 'model.voice_design', 'model.tts']
  await writeFile(manifestPath, JSON.stringify(manifest))
  assert.equal(JSON.parse((await exec(process.execPath, [cli.pathname, 'validate', appDir])).stdout).valid, true)
  manifest.permissions.push('unknown.permission')
  await writeFile(manifestPath, JSON.stringify(manifest))
  await assert.rejects(exec(process.execPath, [cli.pathname, 'validate', appDir]), /unsupported app permission/)
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

test('upload ignores a stale legacy binding and resolves the app from manifest.id', async t => {
  const fixture = await releaseFixture(t)
  await writeFile(join(fixture.appDir, '.proxy-app.json'), JSON.stringify({ app_id: 'app-old', slug: 'app.proxy.old' }))
  const result = await exec(process.execPath, [cli.pathname, 'upload', fixture.appDir], { env: fixture.env })
  assert.match(result.stdout, /"uploaded"/)
  const uploaded = fixture.requests.find(request => request.bundle)
  assert.ok(uploaded)
  assert.equal(uploaded.url, `/api/portal/user/app-workspace/${fixture.remoteApp.id}/versions`)
  assert.equal(bundleContents(uploaded.bundle).manifest.id, fixture.remoteApp.slug)
})

test('publish reuses uploaded drafts and uploads local-only drafts before submission', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'proxy-app-cli-api-'))
  const appDir = join(temp, 'demo')
  const requests = []
  const remoteApp = {
    id: 'app-1',
    slug: 'app.proxy.generated123',
    name: 'Quoted app',
    status: 'draft',
    versions: [{ version: '0.1.0', review_status: 'draft', artifact_size: 1024 }],
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
    if (request.method === 'POST' && request.url === '/api/portal/user/app-workspace/app-1/opening') {
      response.end(JSON.stringify({ data: { success: true } }))
      return
    }
    if (request.method === 'POST' && request.url === '/api/portal/user/app-workspace/app-1/versions') {
      remoteApp.versions[0].artifact_size = 1024
      response.end(JSON.stringify({ data: { ...remoteApp.versions[0], upload_result: 'draft_uploaded' } }))
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
    await exec(process.execPath, [cli.pathname, 'create', '--category', 'ecommerce'], { env, cwd: appDir })
    await installBuildFixture(appDir)
    const manifest = JSON.parse(await readFile(join(appDir, 'manifest.json'), 'utf8'))
    assert.equal(manifest.id, remoteApp.id)
    assert.equal(JSON.parse(await readFile(join(appDir, 'agent', 'examples.json'), 'utf8'))[0].output.appId, remoteApp.id)
    const createBody = JSON.parse(requests.find((item) => item.method === 'POST' && item.url.endsWith('/app-workspace')).body)
    assert.equal(createBody.slug, undefined)
    assert.equal(createBody.name, "Quoted ' app")
    assert.equal(createBody.category, 'ecommerce')

    const result = await exec(process.execPath, [cli.pathname, 'publish', appDir], { env })
    assert.match(result.stdout, /"success": true/)
    assert.equal(requests.filter((item) => item.method === 'POST' && item.url === '/api/portal/user/app-workspace/app-1/versions').length, 0)
    assert.equal(requests.filter((item) => item.url.endsWith('/opening')).length, 1)
    assert.deepEqual(JSON.parse(requests.find((item) => item.url.endsWith('/opening')).body), { version: '0.1.0' })
    assert.equal(requests.some((item) => item.url.endsWith('/submit')), false)
    assert.equal(await buildCount(appDir), 0)
    remoteApp.versions[0].artifact_size = 0
    const localDraftResult = await exec(process.execPath, [cli.pathname, 'publish', appDir], { env })
    assert.match(localDraftResult.stdout, /"draft_uploaded"/)
    assert.equal(await buildCount(appDir), 1)
    const finalRequests = requests.filter((item) => item.method === 'POST').slice(-2)
    assert.equal(finalRequests[0].url, '/api/portal/user/app-workspace/app-1/versions')
    assert.equal(finalRequests[1].url, '/api/portal/user/app-workspace/app-1/opening')
    for (const openingRequest of [null, { id: 'previous-opening', status: 'withdrawn', version: '0.1.0' }, { id: 'previous-opening', status: 'rejected', version: '0.1.0' }]) {
      remoteApp.opening_request = openingRequest
      remoteApp.versions[0].review_status = 'review'
      requests.length = 0
      const renewed = await exec(process.execPath, [cli.pathname, 'publish', appDir], { env })
      assert.match(renewed.stdout, /应用开放申请已提交/)
      assert.deepEqual(requests.filter((item) => item.method === 'POST').map((item) => item.url), ['/api/portal/user/app-workspace/app-1/opening'])
      assert.equal(await buildCount(appDir), 1)
    }
  } finally {
    await new Promise((resolvePromise) => server.close(resolvePromise))
    await rm(temp, { recursive: true, force: true })
  }
})

test('publish releases existing later drafts without review and blocks parallel first applications', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'proxy-app-cli-lifecycle-'))
  const appDir = join(temp, 'demo')
  const requests = []
  const remoteApp = {
    id: 'app-lifecycle', slug: '', status: 'published', current_version: '0.0.1',
    versions: [{ version: '0.1.0', review_status: 'draft', artifact_size: 1024 }],
  }
  const server = createServer(async (request, response) => {
    for await (const _chunk of request) { /* consume the request */ }
    requests.push({ method: request.method, url: request.url })
    response.setHeader('Content-Type', 'application/json')
    if (request.method === 'GET' && request.url === '/api/portal/user/app-workspace') {
      response.end(JSON.stringify({ data: { items: [remoteApp] } }))
    } else if (request.method === 'POST' && request.url === '/api/portal/user/app-workspace/app-lifecycle/versions/0.1.0/publish') {
      response.end(JSON.stringify({ data: { success: true } }))
    } else {
      response.statusCode = 404
      response.end(JSON.stringify({ message: 'Unexpected lifecycle request' }))
    }
  })
  await new Promise((resolvePromise) => server.listen(0, '127.0.0.1', resolvePromise))
  const env = { ...process.env, PROXY_USER_ACCESS_TOKEN: 'lifecycle-test-token', PROXY_API_BASE_URL: `http://127.0.0.1:${server.address().port}/api` }
  try {
    await exec(process.execPath, [cli.pathname, 'init', appDir], { env })
    remoteApp.slug = JSON.parse(await readFile(join(appDir, 'manifest.json'), 'utf8')).id
    await writeFile(join(appDir, '.proxy-app.json'), JSON.stringify({ app_id: remoteApp.id, slug: remoteApp.slug }))
    for (const [status, versionStatus] of [['published', 'draft'], ['paused', 'rejected'], ['disabled', 'draft'], ['published', 'review']]) {
      remoteApp.status = status
      remoteApp.versions[0].review_status = versionStatus
      requests.length = 0
      const result = await exec(process.execPath, [cli.pathname, 'publish', appDir], { env })
      assert.match(result.stdout, /线上版本已手动切换/)
      assert.deepEqual(requests.filter((request) => request.method === 'POST').map((request) => request.url), ['/api/portal/user/app-workspace/app-lifecycle/versions/0.1.0/publish'])
    }
    remoteApp.current_version = ''
    remoteApp.status = 'review'
    remoteApp.versions[0].review_status = 'review'
    requests.length = 0
    const pending = await exec(process.execPath, [cli.pathname, 'publish', appDir], { env })
    assert.match(pending.stdout, /应用开放申请正在审核/)
    assert.equal(requests.some((request) => request.method === 'POST'), false)
    remoteApp.versions[0].version = '0.2.0'
    requests.length = 0
    await assert.rejects(exec(process.execPath, [cli.pathname, 'publish', appDir], { env }), /预览版本 0\.2\.0/)
    assert.equal(requests.some((request) => request.method === 'POST'), false)
    remoteApp.opening_request = { id: 'opening-current', status: 'pending', version: '0.1.0' }
    remoteApp.versions[0].review_status = 'draft'
    requests.length = 0
    const canonicalPending = await exec(process.execPath, [cli.pathname, 'publish', appDir], { env })
    assert.match(canonicalPending.stdout, /"id": "opening-current"/)
    assert.equal(requests.some((request) => request.method === 'POST'), false)
    const currentStatus = await exec(process.execPath, [cli.pathname, 'status', appDir], { env })
    assert.equal(JSON.parse(currentStatus.stdout).opening_request.id, 'opening-current')
    remoteApp.opening_request.version = '0.3.0'
    requests.length = 0
    await assert.rejects(exec(process.execPath, [cli.pathname, 'publish', appDir], { env }), /预览版本 0\.3\.0/)
    assert.equal(requests.some((request) => request.method === 'POST'), false)
    remoteApp.status = 'disabled'
    await assert.rejects(exec(process.execPath, [cli.pathname, 'publish', appDir], { env }), /解除限制后才能申请开放/)
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
    if (request.method === 'POST' && request.url === '/api/portal/user/app-workspace/by-slug/app.example.demo/local-development') {
      response.end(JSON.stringify({ data: { id: 'app-1', slug: 'app.example.demo', local_development_grant: 'development-preview-grant-0123456789' } }))
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
    PROXY_PLATFORM_GATEWAY_URL: '',
    PROXY_APP_DEV_AUTH_RELAY_URL: 'https://attacker.example/auth',
    PROXY_APP_DEV_AUTH_RELAY_SECRET: 'attacker-controlled',
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
  gatewayURL: process.env.PROXY_PLATFORM_GATEWAY_URL,
  hasRuntime: Boolean(process.env.PROXY_PLATFORM_RUNTIME_URL),
  hasBridge: Boolean(process.env.PROXY_PLATFORM_BRIDGE_URL),
  hasAuth: Boolean(process.env.PROXY_PLATFORM_AUTH_URL),
  authRelayURL: process.env.PROXY_APP_DEV_AUTH_RELAY_URL,
  hasAuthRelaySecret: Boolean(process.env.PROXY_APP_DEV_AUTH_RELAY_SECRET),
}))
process.exit(1)
`)
    await assert.rejects(exec(process.execPath, [cli.pathname, 'dev', appDir, '--port', '5187', '--no-auth-cache'], { env }), /npm exited with 1/)
    const childResult = JSON.parse(await readFile(resultPath, 'utf8'))
    assert.equal(childResult.hasManagementSession, false)
    assert.equal(childResult.hasPlatformAPI, false)
    assert.equal(childResult.hasGateway, true)
    assert.equal(childResult.gatewayURL, 'https://api.duckingmind.com/v1')
    assert.equal(childResult.hasRuntime, false)
    assert.equal(childResult.hasBridge, false)
    assert.equal(childResult.hasAuth, false)
    assert.equal(childResult.authRelayURL, undefined)
    assert.equal(childResult.hasAuthRelaySecret, false)
    assert.equal(requests.length, 1)
    assert.equal(requests[0].url, '/api/portal/user/app-workspace/by-slug/app.example.demo/local-development')
    assert.equal(requests[0].authorization, 'Bearer management-session-that-must-not-leak')
    assert.equal(JSON.parse(requests[0].body).entry_url, 'http://127.0.0.1:5187/')
  } finally {
    await new Promise((resolvePromise) => platform.close(resolvePromise))
    await rm(temp, { recursive: true, force: true })
  }
})

test('container backend runs beside the frontend with isolated environment and shared shutdown', async (t) => {
  const fixture = await devFixture(t)
  const backendPortServer = createTCPServer()
  await new Promise((resolvePromise) => backendPortServer.listen(0, '127.0.0.1', resolvePromise))
  const backendPort = backendPortServer.address().port
  await new Promise((resolvePromise) => backendPortServer.close(resolvePromise))

  const manifestPath = join(fixture.appDir, 'manifest.json')
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  await writeFile(manifestPath, JSON.stringify({ ...manifest, backend: {
    type: 'container', runtime: 'node22', entry: 'server/index.mjs', port: backendPort,
    routes: ['/api/*'],
  } }))
  await mkdir(join(fixture.appDir, 'server'), { recursive: true })
  await writeFile(join(fixture.appDir, 'server', 'index.mjs'), `import { createServer } from 'node:http'
const server = createServer((request, response) => {
  response.setHeader('content-type', 'application/json')
  response.end(JSON.stringify({
    path: request.url,
    appId: process.env.PROXY_APP_ID,
    appVersion: process.env.PROXY_APP_VERSION,
    port: process.env.PORT,
    host: process.env.HOST,
    hasManagementSession: Boolean(process.env.PROXY_USER_ACCESS_TOKEN),
    hasRelaySecret: Boolean(process.env.PROXY_PLATFORM_RELAY_SECRET),
    hasPlatformAuth: Boolean(process.env.PROXY_PLATFORM_AUTH_URL),
  }))
})
server.listen(Number(process.env.PORT), process.env.HOST)
`)
  await writeFile(join(fixture.appDir, 'package.json'), JSON.stringify({
    name: 'container-dev-test', private: true, scripts: { dev: 'proxy-app dev', 'dev:server': 'node dev-check.mjs' },
  }))
  await writeFile(join(fixture.appDir, 'package-lock.json'), JSON.stringify({
    name: 'container-dev-test', version: '1.0.0', lockfileVersion: 3, requires: true,
    packages: { '': { name: 'container-dev-test', version: '1.0.0' } },
  }))
  await writeFile(join(fixture.appDir, 'dev-check.mjs'), `import { writeFile } from 'node:fs/promises'
let result
for (let attempt = 0; attempt < 40; attempt += 1) {
  try {
    result = await fetch(process.env.PROXY_APP_BACKEND_URL + '/api/design/health').then(response => response.json())
    break
  } catch {
    await new Promise(resolve => setTimeout(resolve, 50))
  }
}
if (!result) throw new Error('local backend did not start')
await writeFile(process.env.PROXY_APP_DEV_RESULT_FILE, JSON.stringify({ result, appBackendURL: process.env.PROXY_APP_BACKEND_URL }))
`)
  const bin = join(fixture.appDir, 'node_modules', '.bin')
  await mkdir(bin, { recursive: true })
  await symlink(cli.pathname, join(bin, 'proxy-app'))
  const docker = join(fixture.appDir, 'docker-fixture.mjs')
  await writeFile(docker, `#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { writeFile } from 'node:fs/promises'
const args = process.argv.slice(2)
if (args[0] === 'info') process.exit(0)
if (args[0] !== 'run') process.exit(2)
await writeFile('docker-args.json', JSON.stringify(args))
const mount = args.find(value => value.startsWith('--mount=') && value.endsWith(',dst=/workspace/server,readonly'))
const serverDir = mount.match(/^--mount=type=bind,src=(.*),dst=\\/workspace\\/server,readonly$/)?.[1]
const command = args.at(-1)
const entry = command.match(/exec node --watch -- '([^']+)'/)?.[1]
if (!serverDir || !entry) throw new Error('Docker runtime arguments are missing the source mount or entry')
const env = Object.fromEntries(args.filter(value => value.startsWith('--env=')).map(value => {
  const separator = value.indexOf('=', 6)
  return [value.slice(6, separator), value.slice(separator + 1)]
}))
const source = entry.replace('/workspace/server/', serverDir + '/')
const child = spawn(process.execPath, ['--watch', source], { env: { PATH: process.env.PATH, ...env }, stdio: 'inherit' })
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => child.kill(signal))
child.once('error', error => { console.error(error); process.exitCode = 1 })
child.once('close', (code, signal) => { process.exitCode = code ?? (signal ? 1 : 0) })
`)
  await chmod(docker, 0o755)

  const completed = await exec('npm', ['run', 'dev', '--', '--port', '5197', '--no-auth-cache'], {
    cwd: fixture.appDir,
    env: { ...fixture.env, PROXY_APP_DOCKER_BIN: docker, PROXY_USER_ACCESS_TOKEN: 'developer-management-token' },
    timeout: 15_000,
  })
  assert.match(completed.stdout, /Local app backend: http:\/\/127\.0\.0\.1:/)
  const result = JSON.parse(await readFile(fixture.resultPath, 'utf8'))
  assert.equal(result.appBackendURL, `http://127.0.0.1:${backendPort}`)
  assert.deepEqual(result.result, {
    path: '/api/design/health',
    appId: 'app.example.demo',
    appVersion: '0.1.0',
    port: String(backendPort),
    host: '0.0.0.0',
    hasManagementSession: false,
    hasRelaySecret: false,
    hasPlatformAuth: false,
  })
  const dockerArgs = JSON.parse(await readFile(join(fixture.appDir, 'docker-args.json'), 'utf8'))
  for (const flag of ['--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges:true', '--user=1000:1000', '--pids-limit=128']) {
    assert.ok(dockerArgs.includes(flag), `missing container hardening flag: ${flag}`)
  }
  assert.ok(dockerArgs.some(value => value.startsWith('--publish=127.0.0.1:')))
  assert.ok(dockerArgs.some(value => value.startsWith('--memory=')))
  assert.ok(dockerArgs.includes('node:22-bookworm-slim'))
  await assert.rejects(fetch(`http://127.0.0.1:${backendPort}/api/design/health`))
})

for (const identity of ['canvas', 'x', 'canvas-v2', 'app.example.demo', 'app_202609121649161dd4']) {
  test(`dev resolves ${identity} without reading or creating a sidecar binding`, async (t) => {
    const f = await devFixture(t)
    await rm(join(f.appDir, '.proxy-app.json'))
    const manifestPath = join(f.appDir, 'manifest.json')
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
    manifest.id = identity
    await writeFile(manifestPath, JSON.stringify(manifest))
    const result = await exec(process.execPath, [cli.pathname, 'dev', f.appDir, '--no-auth-cache'], {
      env: { ...f.env, PROXY_USER_ACCESS_TOKEN: 'developer-management-token' }, timeout: 10_000,
    })
    assert.match(result.stdout, /开发应用检查通过/)
    assert.equal(f.requests[0].url, `/api/portal/user/app-workspace/by-slug/${identity}/local-development`)
    const started = JSON.parse(await readFile(f.resultPath, 'utf8'))
    assert.equal(started.hasManagementSession, false)
    assert.equal(started.hasAuthRelayURL, false)
    assert.equal(started.hasAuthRelaySecret, false)
    await assert.rejects(readFile(join(f.appDir, '.proxy-app.json')), { code: 'ENOENT' })
  })
}

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


async function devFixture(t, {
  status = 200,
  error = 'platform registration failed',
  code,
  requestId,
  probeEntry = false,
  responseContentType = 'application/json',
  responseBody,
} = {}) {
  const temp = await mkdtemp(join(tmpdir(), 'proxy-app-cli-preflight-'))
  const appDir = join(temp, 'demo')
  const resultPath = join(temp, 'started.json')
  const requests = []
  let probeSocket
  const platform = createServer(async (request, response) => {
    let body = ''
    for await (const chunk of request) body += chunk
    requests.push({ method: request.method, url: request.url, authorization: request.headers.authorization, body })
    response.setHeader('Content-Type', responseContentType)
    if (request.method === 'POST' && /^\/api\/portal\/user\/app-workspace\/by-slug\/[^/]+\/local-development$/.test(request.url)) {
      if (probeEntry) {
        const entryURL = new URL(JSON.parse(body).entry_url)
        probeSocket = createConnection({ host: entryURL.hostname, port: Number(entryURL.port) })
        await new Promise((resolvePromise, reject) => {
          probeSocket.once('connect', resolvePromise)
          probeSocket.once('error', reject)
        })
      }
      response.statusCode = status
      if (requestId) response.setHeader('x-request-id', requestId)
      response.end(responseBody ?? JSON.stringify(status === 200
        ? { data: { id: 'app-1', slug: 'app.example.demo', local_development_grant: 'development-preview-grant-0123456789' } }
        : { error, code }))
      return
    }
    if (request.method === 'GET' && request.url === '/api/portal/user/profile') {
      response.end(JSON.stringify({ data: { email: 'developer@example.test' } }))
      return
    }
    response.statusCode = 500
    response.end(JSON.stringify({ error: 'unexpected runtime request during developer initialization' }))
  })
  await new Promise((resolvePromise) => platform.listen(0, '127.0.0.1', resolvePromise))
  t.after(async () => {
    probeSocket?.destroy()
    await new Promise((resolvePromise) => platform.close(resolvePromise))
    await rm(temp, { recursive: true, force: true })
  })
  const baseURL = `http://127.0.0.1:${platform.address().port}`
  const env = {
    ...process.env,
    PROXY_API_BASE_URL: `${baseURL}/api`,
    PROXY_PORTAL_URL: baseURL,
    PROXY_PLATFORM_URL: '',
    PROXY_PUBLIC_URL: '',
    PROXY_USER_ACCESS_TOKEN: '',
    PROXY_ACCESS_TOKEN: '',
    PROXY_APP_DEV_URL: '',
    PROXY_APP_DEV_PORT: '',
    PROXY_APP_DEV_RESULT_FILE: resultPath,
  }
  await exec(process.execPath, [cli.pathname, 'init', appDir], { env })
  const manifestPath = join(appDir, 'manifest.json')
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  manifest.id = 'app.example.demo'
  await writeFile(manifestPath, JSON.stringify(manifest))
  await writeFile(join(appDir, '.proxy-app.json'), JSON.stringify({ app_id: 'app-1', slug: manifest.id }))
  await writeFile(join(appDir, 'package.json'), JSON.stringify({ name: 'dev-preflight-test', private: true, scripts: { dev: 'node started.mjs' } }))
  await writeFile(join(appDir, 'started.mjs'), `import { writeFile } from 'node:fs/promises'
await writeFile(process.env.PROXY_APP_DEV_RESULT_FILE, JSON.stringify({
  starts: 1,
  args: process.argv.slice(2),
  hasManagementSession: Boolean(process.env.PROXY_USER_ACCESS_TOKEN || process.env.PROXY_ACCESS_TOKEN),
  hasPortalURL: Boolean(process.env.VITE_PROXY_PORTAL_URL),
  hasAuthRelayURL: Boolean(process.env.PROXY_APP_DEV_AUTH_RELAY_URL),
  hasAuthRelaySecret: Boolean(process.env.PROXY_APP_DEV_AUTH_RELAY_SECRET),
}))
console.log('fixture dev server started')
`)
  return { appDir, baseURL, env, resultPath, requests, get probeSocket() { return probeSocket } }
}

async function useGenericDevScript(fixture, serverScript = 'node started.mjs') {
  await writeFile(join(fixture.appDir, 'package.json'), JSON.stringify({
    name: 'generic-dev-test', private: true,
    scripts: { dev: 'proxy-app dev', 'dev:server': serverScript },
  }))
  const bin = join(fixture.appDir, 'node_modules', '.bin')
  await mkdir(bin, { recursive: true })
  await symlink(cli.pathname, join(bin, 'proxy-app'))
}

test('npm run dev checks the app before starting dev:server exactly once', async (t) => {
  const fixture = await devFixture(t)
  await useGenericDevScript(fixture)
  const result = await exec('npm', ['run', 'dev', '--', '--port', '5193', '--no-auth-cache'], {
    cwd: fixture.appDir, env: { ...fixture.env, PROXY_USER_ACCESS_TOKEN: 'developer-management-token' }, timeout: 10_000,
  })
  assert.equal(fixture.requests.length, 1)
  assert.equal(fixture.requests[0].authorization, 'Bearer developer-management-token')
  const started = JSON.parse(await readFile(fixture.resultPath, 'utf8'))
  assert.equal(started.starts, 1)
  assert.equal(started.hasManagementSession, false)
  assert.equal(started.hasPortalURL, true)
  assert.equal(started.hasAuthRelayURL, false)
  assert.equal(started.hasAuthRelaySecret, false)
  const entryURL = new URL(JSON.parse(fixture.requests[0].body).entry_url)
  assert.deepEqual(started.args, ['--host', '127.0.0.1', '--port', entryURL.port, '--strictPort'])
  assert.ok(result.stdout.indexOf('开发应用检查通过') < result.stdout.indexOf('fixture dev server started'))
})

test('one PROXY_PLATFORM_URL configures both API and developer login for a single-origin platform', async (t) => {
  const fixture = await devFixture(t)
  const env = { ...fixture.env, PROXY_PLATFORM_URL: fixture.baseURL, PROXY_USER_ACCESS_TOKEN: '', PROXY_ACCESS_TOKEN: '' }
  delete env.PROXY_API_BASE_URL
  delete env.PROXY_PORTAL_URL
  const invocation = startCLI(['dev', fixture.appDir, '--no-auth-cache'], { env })
  t.after(async () => { invocation.child.kill('SIGTERM'); await invocation.completed })

  const output = await invocation.waitForOutput(/按 Ctrl\+C 取消/)
  assert.match(output, new RegExp(`平台 API 地址：${fixture.baseURL.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/api`))
  const loginLine = output.split('\n').find((line) => /^https?:.*proxy_app_auth=1/.test(line))
  assert.ok(loginLine)
  assert.equal(new URL(loginLine).origin, fixture.baseURL)
  const login = developerLogin(output)
  const callback = await fetch(login.relayURL + '/auth/callback', {
    method: 'POST',
    body: new URLSearchParams({ state: login.state, access_token: 'single-origin-developer-token' }),
  })
  assert.equal(callback.status, 200)
  await callback.text()
  const result = await invocation.completed
  assert.equal(result.error, null, result.stderr)
  assert.equal(fixture.requests.length, 1)
  assert.equal(fixture.requests[0].url, '/api/portal/user/app-workspace/by-slug/app.example.demo/local-development')
})

test('npm run dev does not start dev:server when registration is denied', async (t) => {
  const fixture = await devFixture(t, { status: 403 })
  await useGenericDevScript(fixture)
  await assert.rejects(exec('npm', ['run', 'dev', '--', '--no-auth-cache'], {
    cwd: fixture.appDir, env: { ...fixture.env, PROXY_USER_ACCESS_TOKEN: 'developer-management-token' }, timeout: 10_000,
  }), /开发权限|创建者/)
  assert.equal(fixture.requests.length, 2)
  assert.equal(fixture.requests[1].url, '/api/portal/user/profile')
  await assert.rejects(readFile(fixture.resultPath), { code: 'ENOENT' })
})

test('dev rejects a missing server script before checking the platform', async (t) => {
  const fixture = await devFixture(t)
  await writeFile(join(fixture.appDir, 'package.json'), JSON.stringify({ name: 'missing-dev-test', private: true }))
  await assert.rejects(exec(process.execPath, [cli.pathname, 'dev', '--no-auth-cache'], {
    cwd: fixture.appDir, env: fixture.env, timeout: 10_000,
  }), /缺少 dev:server 脚本/)
  assert.equal(fixture.requests.length, 0)
})

test('dev rejects a server script that reenters the development launcher', async (t) => {
  const fixture = await devFixture(t)
  await useGenericDevScript(fixture, 'node recursive-dev.mjs')
  await writeFile(join(fixture.appDir, 'recursive-dev.mjs'), `process.argv = [process.execPath, ${JSON.stringify(cli.pathname)}, 'dev']\nawait import(${JSON.stringify(cli.href)})\n`)
  await assert.rejects(exec('npm', ['run', 'dev', '--', '--no-auth-cache'], {
    cwd: fixture.appDir, env: { ...fixture.env, PROXY_USER_ACCESS_TOKEN: 'developer-management-token' }, timeout: 10_000,
  }), /dev:server.*不能调用 proxy-app dev/)
  assert.equal(fixture.requests.length, 1)
  await assert.rejects(readFile(fixture.resultPath), { code: 'ENOENT' })
})

test('dev fails clearly when an explicitly requested port is occupied', async (t) => {
  const fixture = await devFixture(t)
  const busy = createTCPServer()
  await new Promise((resolvePromise) => busy.listen(0, '127.0.0.1', resolvePromise))
  const occupiedPort = busy.address().port
  t.after(async () => {
    await new Promise((resolvePromise) => busy.close(resolvePromise))
  })

  const result = await startCLI(['dev', fixture.appDir, '--port', String(occupiedPort), '--no-auth-cache'], {
    env: { ...fixture.env, PROXY_USER_ACCESS_TOKEN: 'developer-management-token' },
  }).completed
  assert.notEqual(result.error, null)
  assert.match(result.stderr, new RegExp(`端口 ${occupiedPort} 已被占用；请停止占用该端口的旧开发服务器`))
  assert.equal(fixture.requests.length, 0, 'port conflict should be detected before platform registration')
  await assert.rejects(readFile(fixture.resultPath), { code: 'ENOENT' })
})

test('dev releases the reserved port when a platform probe connects during preflight', async (t) => {
  const fixture = await devFixture(t, { probeEntry: true })
  await useGenericDevScript(fixture)
  const invocation = startCLI(['dev', fixture.appDir, '--no-auth-cache'], {
    env: { ...fixture.env, PROXY_USER_ACCESS_TOKEN: 'developer-management-token' },
  })
  t.after(async () => {
    fixture.probeSocket?.destroy()
    invocation.child.kill('SIGTERM')
    await invocation.completed
  })

  const output = await invocation.waitForOutput(/fixture dev server started/)
  assert.match(output, /开发应用检查通过/)
  assert.equal(JSON.parse(await readFile(fixture.resultPath, 'utf8')).starts, 1)
})

function startCLI(args, options = {}) {
  let output = ''
  const listeners = new Set()
  let finished = false
  let child
  const completed = new Promise((resolvePromise) => {
    child = execFile(process.execPath, [cli.pathname, ...args], { ...options, timeout: 10_000 }, (error, stdout, stderr) => {
      finished = true
      resolvePromise({ error, stdout, stderr })
      for (const listener of listeners) listener()
    })
    child.stdout.on('data', (chunk) => {
      output += chunk
      for (const listener of listeners) listener()
    })
  })
  const waitForOutput = (pattern) => new Promise((resolvePromise, reject) => {
    const inspect = () => {
      if (pattern.test(output)) { cleanup(); resolvePromise(output) }
      else if (finished) { cleanup(); reject(new Error('CLI exited before expected output: ' + output)) }
    }
    const timer = setTimeout(() => { cleanup(); reject(new Error('CLI output timed out: ' + output)) }, 5000)
    const cleanup = () => { clearTimeout(timer); listeners.delete(inspect) }
    listeners.add(inspect)
    inspect()
  })
  return { child, completed, waitForOutput }
}

function developerLogin(output) {
  const loginURL = output.split('\n').find((line) => /^https?:.*proxy_app_auth=1/.test(line))
  assert.ok(loginURL, 'developer authorization URL should be printed before the app starts')
  const url = new URL(loginURL)
  const parameters = new URLSearchParams(url.hash.split('?')[1])
  const relayURL = parameters.get('proxy_app_relay')
  const state = parameters.get('proxy_app_state')
  assert.ok(relayURL)
  assert.ok(state)
  return { relayURL, state }
}

for (const scenario of [
  { status: 401, message: /开发者授权已过期|重新登录/ },
  { status: 403, requestId: 'request-binding_403', message: /无权.*开发|开发权限|创建者/ },
  { status: 404, requestId: 'unsafe?developer-management-token', message: /该平台上没有当前账户拥有的同 slug 应用/ },
  { status: 409, requestId: 'request-manifest-409', code: 'APP_LOCAL_MANIFEST_CONFLICT', message: /manifest|版本/ },
  { status: 503, requestId: 'request-service-503', message: /平台|登记失败|服务/ },
]) {
  test(`dev fails before starting the app when developer registration returns HTTP ${scenario.status}`, async (t) => {
    const fixture = await devFixture(t, scenario)
    const result = await startCLI(['dev', fixture.appDir, '--no-auth-cache'], {
      env: { ...fixture.env, PROXY_USER_ACCESS_TOKEN: 'developer-management-token' },
    }).completed
    assert.equal(result.error?.code, 1)
    assert.match(result.stderr, scenario.message)
    if ([401, 403, 404].includes(scenario.status)) assert.match(result.stderr, /PROXY_USER_ACCESS_TOKEN.*清除或取消设置.*普通 proxy-app dev/)
    if ([403, 404].includes(scenario.status)) {
      assert.match(result.stderr, /核对 manifest\.json.*平台地址/)
      assert.doesNotMatch(result.stderr, /proxy-app (?:link|repair)/)
    } else {
      assert.doesNotMatch(result.stderr, /proxy-app link/)
    }
    if (scenario.requestId && scenario.status !== 404) assert.ok(result.stderr.includes(`请求编号：${scenario.requestId}`))
    else assert.doesNotMatch(result.stderr, /请求编号：/)
    assert.match(result.stdout, /正在检查开发应用：app\.example\.demo@/)
    assert.doesNotMatch(result.stdout, /Local app:/)
    assert.doesNotMatch(result.stdout + result.stderr, /developer-management-token/)
    await assert.rejects(readFile(fixture.resultPath), { code: 'ENOENT' })
    assert.equal(fixture.requests.length, [403, 404].includes(scenario.status) ? 2 : 1)
    assert.equal(fixture.requests[0].authorization, 'Bearer developer-management-token')
    if ([403, 404].includes(scenario.status)) {
      assert.equal(fixture.requests[1].url, '/api/portal/user/profile')
      assert.match(result.stderr, /当前登录账户：developer@example\.test/)
      assert.match(result.stderr, /平台 API 地址：http:\/\/127\.0\.0\.1:/)
    }
  })
}

test('dev reports the HTTP status and request ID for a non-JSON platform failure', async (t) => {
  const fixture = await devFixture(t, {
    status: 502,
    requestId: 'request-html-502',
    responseContentType: 'text/html; charset=utf-8',
    responseBody: '<html>upstream unavailable</html>',
  })
  const result = await startCLI(['dev', fixture.appDir, '--no-auth-cache'], {
    env: { ...fixture.env, PROXY_USER_ACCESS_TOKEN: 'developer-management-token' },
  }).completed
  assert.equal(result.error?.code, 1)
  assert.match(result.stderr, /HTTP 502/)
  assert.match(result.stderr, /请求编号：request-html-502/)
  assert.doesNotMatch(result.stderr, /该平台上没有当前账户拥有的同 slug 应用/)
  assert.doesNotMatch(result.stdout + result.stderr, /developer-management-token/)
  await assert.rejects(readFile(fixture.resultPath), { code: 'ENOENT' })
})

test('dev waits for developer callback, then starts with browser-owned user sessions', async (t) => {
  const fixture = await devFixture(t)
  const invocation = startCLI(['dev', '--no-auth-cache'], { env: fixture.env, cwd: fixture.appDir })
  t.after(async () => { invocation.child.kill('SIGTERM'); await invocation.completed })
  const output = await invocation.waitForOutput(/按 Ctrl\+C 取消/)
  const login = developerLogin(output)
  assert.match(output, /开发者授权入口：\nhttps?:/)
  assert.match(output, /完成开发者授权并通过应用登记检查后才会启动本地应用/)
  assert.doesNotMatch(output, /Local app:/)
  assert.equal(fixture.requests.length, 0)
  await assert.rejects(readFile(fixture.resultPath), { code: 'ENOENT' })
  const callback = await fetch(login.relayURL + '/auth/callback', {
    method: 'POST',
    body: new URLSearchParams({ state: login.state, access_token: 'developer-browser-token' }),
  })
  assert.equal(callback.status, 200)
  await callback.text()
  const result = await invocation.completed
  assert.equal(result.error, null, result.stderr)
  assert.match(result.stdout, /开发应用检查通过/)
  assert.match(result.stdout, /Local app:/)
  assert.match(result.stdout, /App Session: sign in through the Portal when prompted; the browser keeps it in this tab\./)
  assert.equal(fixture.requests.length, 1)
  assert.equal(fixture.requests[0].authorization, 'Bearer developer-browser-token')
  const child = JSON.parse(await readFile(fixture.resultPath, 'utf8'))
  assert.equal(child.starts, 1)
  assert.equal(child.hasPortalURL, true)
  assert.equal(child.hasManagementSession, false)
  assert.equal(child.hasAuthRelayURL, false)
  assert.equal(child.hasAuthRelaySecret, false)
})

for (const signal of ['SIGINT', 'SIGTERM']) {
  test(`dev ${signal} cancels pending developer authorization and closes the relay`, async (t) => {
    const fixture = await devFixture(t)
    const invocation = startCLI(['dev', fixture.appDir, '--no-auth-cache'], { env: fixture.env })
    t.after(async () => { invocation.child.kill('SIGKILL'); await invocation.completed })
    const output = await invocation.waitForOutput(/按 Ctrl\+C 取消/)
    const login = developerLogin(output)
    invocation.child.kill(signal)
    const result = await invocation.completed
    assert.equal(result.error?.code, signal === 'SIGINT' ? 130 : 143)
    assert.match(result.stderr, /已取消开发环境初始化/)
    assert.doesNotMatch(result.stdout, /Local app:/)
    assert.equal(fixture.requests.length, 0)
    await assert.rejects(readFile(fixture.resultPath), { code: 'ENOENT' })
    await assert.rejects(fetch(login.relayURL + '/health'))
  })
}
