import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { unzipSync } from 'fflate'
import { resolveAgentContract } from './agent-contract.mjs'

const exec = promisify(execFile)
const cli = new URL('./proxy-app.mjs', import.meta.url).pathname
const helper = new URL('./agent-contract.mjs', import.meta.url).pathname
const declaration = (name = 'read_value') => ({ name, title: 'Read value', access: 'read', targets: ['web', 'desktop'],
  input_schema: { type: 'object', additionalProperties: false }, output_schema: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'], additionalProperties: false } })
const metadata = { namespace: 'code_fixture', targets: ['web', 'desktop'], contract_version: '1.0.0', summary: 'Read fixture values.', keywords: ['fixture'], guide: { entry: 'agent/guide.md' }, examples: 'agent/examples.json' }
const sourceModule = (definitions = [declaration()], agentMetadata = metadata) => `export const agentMetadata = ${JSON.stringify(agentMetadata)}
const definitions = ${JSON.stringify(definitions)}
export function registerAgentTools(registry, handlers) {
  const collectOnly = handlers === undefined
  const names = new Set()
  const disposers = []
  for (const definition of definitions) {
    names.add(definition.name)
    const handler = collectOnly ? undefined : handlers[definition.name]
    if (!collectOnly && typeof handler !== 'function') throw new Error('Missing handler: ' + definition.name)
    const dispose = collectOnly ? registry.register(definition) : registry.register(definition, handler)
    if (typeof dispose === 'function') disposers.push(dispose)
  }
  for (const name of Object.keys(handlers || {})) if (!names.has(name)) throw new Error('Unknown handler: ' + name)
  return disposers
}`
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'proxy-code-contract-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(join(root, 'src'))
  await mkdir(join(root, 'agent'))
  const manifest = { schema: 'proxy.app/v1', id: 'code-fixture', version: '1.0.0', name: 'Code fixture', permissions: [] }
  await writeFile(join(root, 'manifest.json'), JSON.stringify(manifest))
  await writeFile(join(root, 'src/agent-tools.mjs'), sourceModule())
  await writeFile(join(root, 'index.html'), '<!doctype html>')
  await writeFile(join(root, 'agent/guide.md'), '# Guide\nRead first.\n')
  await writeFile(join(root, 'agent/examples.json'), JSON.stringify([{ capability: 'read_value', input: {}, output: { value: 'ok' } }]))
  await writeFile(join(root, 'package.json'), JSON.stringify({ type: 'module', scripts: { build: 'node build.mjs' } }))
  await writeFile(join(root, 'build.mjs'), "import { mkdir, writeFile } from 'node:fs/promises'; await mkdir('dist'); await writeFile('dist/index.html', '<!doctype html>');")
  return { root, manifest }
}

test('code module is auto-discovered and generates a complete package contract', async t => {
  const { root, manifest } = await fixture(t)
  const effective = await resolveAgentContract(root, manifest)
  assert.equal(effective.agent.entry, undefined)
  assert.equal(effective.agent.contract_source, 'code')
  assert.equal(effective.agent.namespace, 'code_fixture')
  assert.equal(effective.agent.capabilities[0].name, 'read_value')
  assert.deepEqual(effective.agent.capabilities[0].targets, ['web', 'desktop'])
  assert.deepEqual(JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8')), manifest)
  assert.equal(manifest.agent, undefined)
  assert.match((await exec(process.execPath, [cli, 'validate', root])).stdout, /"valid": true/)
})

test('the contract CLI executes when invoked through its package bin symlink', async t => {
  const { root } = await fixture(t)
  const bin = join(root, 'proxy-agent-contract.mjs')
  await symlink(new URL('./agent-contract.mjs', import.meta.url).pathname, bin)
  const destination = join(root, 'dist')
  await exec(process.execPath, [bin, root, destination])
  const generated = JSON.parse(await readFile(join(destination, 'manifest.json'), 'utf8'))
  assert.equal(generated.agent.capabilities[0].name, 'read_value')
})

test('the same registration implementation yields the build catalog and runtime handlers', async t => {
  const { root, manifest } = await fixture(t)
  const effective = await resolveAgentContract(root, manifest)
  const module = await import(`${pathToFileURL(join(root, 'src/agent-tools.mjs')).href}?runtime-test`)
  const handlers = { read_value: async () => ({ value: 'ok' }) }
  const bound = []
  const disposers = module.registerAgentTools({ register(definition, handler) {
    bound.push({ name: definition.name, handler })
    return () => {}
  } }, handlers)
  assert.deepEqual(bound.map(item => item.name), effective.agent.capabilities.map(item => item.name))
  assert.ok(bound.every(item => typeof item.handler === 'function'))
  assert.equal(disposers.length, effective.agent.capabilities.length)
  assert.throws(() => module.registerAgentTools({ register() {} }, {}), /Missing handler: read_value/)
  assert.throws(() => module.registerAgentTools({ register() {} }, { read_value: () => ({}), extra: () => ({}) }), /Unknown handler: extra/)
})

test('declaration-only source modules are rejected instead of becoming a parallel contract', async t => {
  const { root, manifest } = await fixture(t)
  await writeFile(join(root, 'src/agent-tools.mjs'), `export const agentMetadata = ${JSON.stringify(metadata)}\nexport const capabilities = ${JSON.stringify([declaration()])}`)
  await assert.rejects(resolveAgentContract(root, manifest), /must export registerAgentTools\(\); capability arrays are not supported/)
})

test('static source manifest contracts are rejected and code schemas use host validation', async t => {
  const { root, manifest } = await fixture(t)
  await assert.rejects(resolveAgentContract(root, { ...manifest, agent: { enabled: true, namespace: 'manual', capabilities: [] } }), /must not contain manifest\.agent/)
  for (const field of ['access', 'input_schema', 'output_schema']) {
    const missing = declaration()
    delete missing[field]
    await writeFile(join(root, 'src/agent-tools.mjs'), sourceModule([missing]))
    await assert.rejects(resolveAgentContract(root, manifest), new RegExp(`explicitly declare ${field}`))
  }
  await writeFile(join(root, 'src/agent-tools.mjs'), sourceModule([]))
  assert.deepEqual((await resolveAgentContract(root, manifest)).agent.capabilities, [])
  await writeFile(join(root, 'src/agent-tools.mjs'), sourceModule([{ ...declaration(), access: 'write' }]))
  await assert.rejects(resolveAgentContract(root, manifest), /idempotency_key/)
  await writeFile(join(root, 'src/agent-tools.mjs'), sourceModule([declaration(), declaration()]))
  await assert.rejects(resolveAgentContract(root, manifest), /duplicate/)
  await writeFile(join(root, 'src/agent-tools.mjs'), sourceModule([{ ...declaration(), input_schema: { type: 'object', $ref: 'ignored' } }]))
  await assert.rejects(resolveAgentContract(root, manifest), /unsupported schema keyword/)
})

test('code metadata is validated and the conventional source file rejects symlinks', async t => {
  const { root, manifest } = await fixture(t)
  const original = join(root, 'src/agent-tools.mjs')
  await rm(original)
  await symlink(join(root, 'index.html'), original)
  await assert.rejects(resolveAgentContract(root, manifest), /symbolic link/)
  await rm(original)
  await writeFile(original, sourceModule([], { invalid: true }))
  await assert.rejects(resolveAgentContract(root, manifest), /unsupported agentMetadata field/)
})

test('a missing code module means the app has no MCP contract', async t => {
  const { root, manifest } = await fixture(t)
  await rm(join(root, 'src/agent-tools.mjs'))
  assert.equal((await resolveAgentContract(root, manifest)).agent, undefined)
  await assert.rejects(resolveAgentContract(root, { ...manifest, agent: { namespace: 'manual' } }), /must not contain manifest\.agent/)
})

test('every resolution sees updated dependencies rather than a cached imported contract', async t => {
  const { root, manifest } = await fixture(t)
  await writeFile(join(root, 'src/shared.mjs'), sourceModule([declaration('read_first')]))
  await writeFile(join(root, 'src/agent-tools.mjs'), "export { agentMetadata, registerAgentTools } from './shared.mjs'")
  assert.equal((await resolveAgentContract(root, manifest)).agent.capabilities[0].name, 'read_first')
  await writeFile(join(root, 'src/shared.mjs'), sourceModule([declaration('read_updated')]))
  assert.equal((await resolveAgentContract(root, manifest)).agent.capabilities[0].name, 'read_updated')
})

test('build helper and pack generate identical contracts without adding source manifest configuration', async t => {
  const { root, manifest } = await fixture(t)
  await exec(process.execPath, [cli, 'build', root])
  const built = JSON.parse(await readFile(join(root, 'dist/manifest.json'), 'utf8'))
  assert.equal(built.agent.contract_source, 'code')
  assert.equal(built.agent.capabilities[0].name, 'read_value')
  assert.equal(built.agent.entry, undefined)
  assert.equal(JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8')).agent, undefined)
  await exec(process.execPath, [helper, root, 'dist'])
  assert.deepEqual(JSON.parse(await readFile(join(root, 'dist/manifest.json'), 'utf8')), built)
  assert.equal(await readFile(join(root, 'dist/agent/guide.md'), 'utf8'), '# Guide\nRead first.\n')
  const zip = join(root, 'fixture.zip')
  await exec(process.execPath, [cli, 'pack', root, zip])
  const files = unzipSync(new Uint8Array(await readFile(zip)))
  assert.deepEqual(JSON.parse(Buffer.from(files['manifest.json']).toString()), built)
  assert.ok(files['agent/examples.json'])
  await writeFile(join(root, 'src/agent-tools.mjs'), sourceModule([{ ...declaration(), title: 'Updated in code' }]))
  await assert.rejects(exec(process.execPath, [cli, 'validate', root]), /manifest 不一致/)
})

test('a build cannot publish an interface changed while the page bundle was being built', async t => {
  const { root } = await fixture(t)
  await writeFile(join(root, 'build.mjs'), `import { mkdir, writeFile } from 'node:fs/promises'; await mkdir('dist'); await writeFile('dist/index.html', '<!doctype html>'); await writeFile('src/agent-tools.mjs', ${JSON.stringify(sourceModule([{ ...declaration(), title: 'changed during build' }]))});`)
  await assert.rejects(exec(process.execPath, [cli, 'pack', root]), /代码能力契约在构建期间发生变更/)
})
