import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile, rm, cp, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { unzipSync } from 'fflate'
const exec = promisify(execFile)
test('CLI rejects source manifests that manually maintain Agent configuration', async t => {
  const root = await mkdtemp(join(tmpdir(), 'proxy-agent-manifest-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const manifest = { schema: 'proxy.app/v1', id: 'app.test.agent', version: '1.0.0', name: 'Fixture', backend: { type: 'platform' }, permissions: [], pricing: { mode: 'free' }, agent: { enabled: true, namespace: 'fixture', capabilities: [{ name: 'rename', access: 'write', input_schema: { type: 'object' } }] } }
  await writeFile(join(root, 'index.html'), '<!doctype html>')
  await writeFile(join(root, 'manifest.json'), JSON.stringify(manifest))
  await assert.rejects(exec(process.execPath, [new URL('./proxy-app.mjs', import.meta.url).pathname, 'validate', root]), /must not contain manifest\.agent/)
})

test('CLI builds and packages declared guides, and validate checks artifact references', async t => {
  const root = await mkdtemp(join(tmpdir(), 'proxy-agent-build-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const cli = new URL('./proxy-app.mjs', import.meta.url).pathname
  const manifest = { schema: 'proxy.app/v1', id: 'app.test.guide', version: '1.0.0', name: 'Guide fixture', backend: { type: 'platform' }, permissions: [] }
  await mkdir(join(root, 'src'))
  await mkdir(join(root, 'agent'))
  await writeFile(join(root, 'manifest.json'), JSON.stringify(manifest))
  await writeFile(join(root, 'src/agent-tools.mjs'), `export const agentMetadata = ${JSON.stringify({ namespace: 'guide_fixture', targets: ['web', 'desktop'], contract_version: '1.0.0', summary: 'Read fixture values.', keywords: ['fixture'], guide: { entry: 'agent/guide.md' }, examples: 'agent/examples.json' })}
export function registerAgentTools(registry, runtime) {
  const collectOnly = runtime === undefined
  const dispose = registry.register({ name: 'read_value', access: 'read', input_schema: { type: 'object', additionalProperties: false }, output_schema: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'], additionalProperties: false } }, collectOnly ? undefined : async () => ({ value: runtime.value }))
  return typeof dispose === 'function' ? [dispose] : []
}`)
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'guide-fixture', private: true, type: 'module', scripts: { build: 'node build.mjs' } }))
  await writeFile(join(root, 'build.mjs'), "import {mkdir,writeFile} from 'node:fs/promises'; await mkdir('dist'); await writeFile('dist/index.html','<!doctype html><title>Fixture</title>');")
  await writeFile(join(root, 'agent/guide.md'), '# Guide\nRead state before editing.\n')
  await writeFile(join(root, 'agent/examples.json'), JSON.stringify([{ capability: 'read_value', input: {}, output: { value: 'hello' } }]))
  const zip = join(root, 'guide.zip')
  await exec(process.execPath, [cli, 'pack', root, zip])
  const files = unzipSync(new Uint8Array(await readFile(zip)))
  assert.equal(Buffer.from(files['agent/guide.md']).toString(), '# Guide\nRead state before editing.\n')
  assert.equal(JSON.parse(Buffer.from(files['manifest.json']).toString()).agent.contract_version, '1.0.0')
  assert.ok(files['agent/examples.json'])
  await rm(join(root, 'dist/agent/guide.md'))
  await assert.rejects(exec(process.execPath, [cli, 'validate', root]), /missing|unreadable/)
  await writeFile(join(root, 'agent/examples.json'), JSON.stringify([{ capability: 'read_value', input: {}, output: { value: 42 } }]))
  await assert.rejects(exec(process.execPath, [cli, 'build', root]), /examples.*expected string/)
})

test('published CLI includes shared agent validation without a sibling desktop checkout', async t => {
  const root = await mkdtemp(join(tmpdir(), 'proxy-agent-cli-package-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const cliRoot = new URL('./', import.meta.url).pathname
  await exec(process.execPath, [join(cliRoot, 'prepare-agent-runtime.mjs')])
  for (const file of ['proxy-app.mjs', 'backend-container.mjs', 'platform-settings.mjs', 'local-dev-relay.mjs', 'local-dev-credentials.mjs', 'runtime-sources.mjs', 'artifact-security.mjs', 'agent-contract.mjs']) await cp(join(cliRoot, file), join(root, file))
  await cp(join(cliRoot, 'agent-runtime'), join(root, 'agent-runtime'), { recursive: true })
  await symlink(new URL('../node_modules/', import.meta.url).pathname, join(root, 'node_modules'))
  const fixture = join(root, 'fixture')
  await mkdir(fixture)
  await writeFile(join(fixture, 'index.html'), '<!doctype html>')
  await writeFile(join(fixture, 'manifest.json'), JSON.stringify({ schema: 'proxy.app/v1', id: 'app.test.published', version: '1.0.0', name: 'Published fixture', backend: { type: 'platform' }, permissions: [] }))
  assert.match((await exec(process.execPath, [join(root, 'proxy-app.mjs'), 'validate', fixture])).stdout, /"valid": true/)
  const pkg = JSON.parse(await readFile(join(cliRoot, 'package.json'), 'utf8'))
  assert.ok(pkg.files.includes('agent-runtime/protocol.mjs'))
  assert.ok(pkg.files.includes('agent-runtime/package-guide.mjs'))
  assert.equal(pkg.files.includes('agent-runtime/runtime-status.mjs'), false)
  assert.ok(pkg.files.includes('agent-contract.mjs'))
  assert.ok(pkg.files.includes('backend-container.mjs'))
  assert.ok(pkg.files.includes('runtime-sources.mjs'))
})

test('public CLI contract package does not expose private host execution helpers', async () => {
  const protocol = await import(new URL('./agent-runtime/protocol.mjs', import.meta.url))
  const guide = await import(new URL('./agent-runtime/package-guide.mjs', import.meta.url))
  for (const name of ['validateRuntimeRegistration', 'normalizeRuntimeCapability', 'toMcpTool', 'createInvocation', 'serializeError', 'describeAgentContract', 'appManifestIdentityMatches']) {
    assert.equal(protocol[name], undefined, `${name} must remain private to the desktop host`)
  }
  for (const name of ['loadWebAgentPackage', 'renderAgentReference']) assert.equal(guide[name], undefined)
  assert.equal(typeof protocol.normalizeManifestAgent, 'function')
  assert.equal(typeof protocol.validateValue, 'function')
  assert.equal(typeof guide.loadAgentPackage, 'function')
  assert.equal(typeof guide.copyAgentPackage, 'function')
})
