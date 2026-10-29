import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createBackendContainerSpec, dockerClientEnvironment } from './backend-container.mjs'

async function backendFixture(t, lockfiles = ['package-lock.json']) {
  const appDir = await mkdtemp(join(tmpdir(), 'proxy-app-backend-container-'))
  t.after(() => rm(appDir, { recursive: true, force: true }))
  await mkdir(join(appDir, 'server'))
  await writeFile(join(appDir, 'server', 'index.mjs'), 'export {}\n')
  await writeFile(join(appDir, 'package.json'), JSON.stringify({ name: 'fixture', private: true }))
  for (const filename of lockfiles) {
    await writeFile(join(appDir, filename), filename === 'yarn.lock'
      ? '# yarn lockfile v1\n'
      : JSON.stringify({ name: 'fixture', lockfileVersion: 3, packages: { '': { name: 'fixture' } } }))
  }
  return appDir
}

const backend = { entry: 'server/index.mjs', port: 8080, resources: { cpu_millicores: 500, memory_mib: 384 } }

test('container spec runs locked Node dependencies with a restricted local runtime', async (t) => {
  const appDir = await backendFixture(t)
  const spec = await createBackendContainerSpec({
    appDir, backend, appID: 'app.example', version: '1.2.3',
    gatewayURL: 'http://127.0.0.1:9002/v1',
    dockerEnv: { PATH: '/usr/bin', PROXY_USER_ACCESS_TOKEN: 'host-only-secret' },
  })

  assert.equal(spec.image, 'node:22-bookworm-slim')
  assert.equal(spec.name, '应用后端容器')
  for (const flag of [
    '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges:true',
    '--user=1000:1000', '--pids-limit=128', '--memory=384m', '--cpus=0.5',
  ]) assert.ok(spec.args.includes(flag), `expected ${flag}`)
  assert.ok(spec.args.includes('--mount=type=bind,src=' + join(appDir, 'server') + ',dst=/workspace/server,readonly'))
  assert.ok(spec.args.some((value) => value.includes(',dst=/workspace/package-lock.json,readonly')))
  assert.ok(spec.args.includes('--publish=127.0.0.1:8080:8080/tcp'))
  assert.ok(spec.args.includes('--env=PROXY_PLATFORM_GATEWAY_URL=http://host.docker.internal:9002/v1'))
  assert.ok(spec.args.includes('--env=HOME=/tmp/home'))
  assert.ok(spec.args.includes('--env=COREPACK_HOME=/tmp/corepack'))
  assert.ok(!spec.args.some((value) => value.includes('PROXY_USER_ACCESS_TOKEN')))
  assert.match(spec.args.at(-1), /mkdir -p \/tmp\/home; npm ci .*--no-audit --no-fund/)
  assert.ok(spec.args.at(-1).includes("exec node --watch -- '/workspace/server/index.mjs'"))
  assert.ok(!spec.args.at(-1).includes('npm install'))
  assert.deepEqual(spec.env, { PATH: '/usr/bin' })
})

test('container spec refuses an unlocked or unsupported dependency tree', async (t) => {
  const noLock = await backendFixture(t, [])
  await assert.rejects(createBackendContainerSpec({ appDir: noLock, backend, appID: 'app.example', version: '1.0.0' }), /requires a dependency lockfile/)

  const pnpm = await backendFixture(t, ['pnpm-lock.yaml'])
  await assert.rejects(createBackendContainerSpec({ appDir: pnpm, backend, appID: 'app.example', version: '1.0.0' }), /requires a dependency lockfile/)

  const duplicate = await backendFixture(t, ['package-lock.json', 'yarn.lock'])
  await assert.rejects(createBackendContainerSpec({ appDir: duplicate, backend, appID: 'app.example', version: '1.0.0' }), /exactly one lockfile/)

  const yarnV2 = await backendFixture(t, ['yarn.lock'])
  await writeFile(join(yarnV2, 'yarn.lock'), '__metadata:\n  version: 6\n')
  await assert.rejects(createBackendContainerSpec({ appDir: yarnV2, backend, appID: 'app.example', version: '1.0.0' }), /supports Yarn Classic/)
})

test('container spec rejects sensitive and symbolic-link backend sources', async (t) => {
  const secret = await backendFixture(t)
  await writeFile(join(secret, 'server', '.env'), 'PRIVATE=value\n')
  await assert.rejects(createBackendContainerSpec({ appDir: secret, backend, appID: 'app.example', version: '1.0.0' }), /sensitive file/)

  const linked = await backendFixture(t)
  const outside = join(linked, 'outside.mjs')
  await writeFile(outside, 'export {}\n')
  await symlink(outside, join(linked, 'server', 'linked.mjs'))
  await assert.rejects(createBackendContainerSpec({ appDir: linked, backend, appID: 'app.example', version: '1.0.0' }), /cannot contain symbolic links/)
})

test('Docker CLI environment allowlist excludes app and platform credentials', () => {
  assert.deepEqual(dockerClientEnvironment({
    PATH: '/usr/bin', HOME: '/tmp/home', DOCKER_CONTEXT: 'desktop-linux',
    PROXY_USER_ACCESS_TOKEN: 'secret', PROXY_PLATFORM_RELAY_SECRET: 'secret', AWS_SECRET_ACCESS_KEY: 'secret',
  }), { PATH: '/usr/bin', HOME: '/tmp/home', DOCKER_CONTEXT: 'desktop-linux' })
})

test('published CLI file allowlist includes the container runtime module', async () => {
  const pkg = JSON.parse(await readFile(new URL('./package.json', import.meta.url), 'utf8'))
  assert.ok(pkg.files.includes('backend-container.mjs'))
})
