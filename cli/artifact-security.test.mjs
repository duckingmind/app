import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtemp, mkdir, writeFile, rm, access, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import test from 'node:test'
import { assertSafeArtifactFile, assertSafeArtifactDirectory } from './artifact-security.mjs'

const exec = promisify(execFile)
// Generated fixtures, never working credentials.
const syntheticSecret = 'sk-' + '7a41c28b95ef603d'.repeat(3)
const syntheticJWT = 'ast_' + Buffer.from('{"alg":"HS256","typ":"JWT"}').toString('base64url') + '.' + Buffer.from('{"sub":"synthetic-fixture","exp":1}').toString('base64url') + '.' + 'ab7CD9ef0123GH45'.repeat(3)

for (const [name, data, rule] of [
  ['assets/app.js.map', '{}', 'source-map-file'],
  ['assets/app.JS.MAP', '{}', 'source-map-file'],
  ['assets/app.js', 'console.log(1);\n//# sourceMappingURL=data:application/json;base64,e30=', 'source-map-reference'],
  ['assets/app.css', 'body{}\n/*# sourceMappingURL=https://example.test/source.map */', 'source-map-reference'],
  ['secrets/server.key', 'binary', 'private-key-file'],
  ['secrets/identity.p12', 'binary', 'private-key-file'],
  ['secrets/id_ed25519', 'binary', 'private-key-file'],
  ['assets/app.js', 'const privateKey="-----BEGIN RSA PRIVATE KEY-----\\nsynthetic"', 'private-key-content'],
  ['assets/app.js', JSON.stringify({ apiKey: syntheticSecret }), 'embedded-api-key'],
  ['assets/app.js', JSON.stringify({ token: syntheticJWT }), 'embedded-session-jwt'],
  ['assets/app.js', 'const k="ghp_' + 'Ab5Cd7e8F012'.repeat(4) + '"', 'embedded-github-token'],
  ['nested/.ENV.local', 'KEY=fixture', 'sensitive file'],
]) {
  test(`artifact scanner rejects ${rule} in ${name} without disclosing content`, () => {
    assert.throws(() => assertSafeArtifactFile(name, data), error => {
      assert.match(error.message, new RegExp(rule))
      assert.ok(error.message.includes(name))
      assert.ok(!error.message.includes(syntheticSecret))
      assert.ok(!error.message.includes(syntheticJWT))
      assert.ok(!error.message.includes('BEGIN RSA'))
      return true
    })
  })
}

test('SDK token handling, minified code, public keys and documentation placeholders are safe', () => {
  for (const [name, data] of [
    ['assets/sdk.js', 'function t(n){if(n.startsWith("ast_"))return n;throw Error("api_key required")};const e="sk-",r="token",a="accessToken",i="BEGIN";'],
    ['guide.md', 'api_key: sk-your-api-key; token: YOUR_TOKEN; sk-' + 'x'.repeat(48)],
    ['guide.md', 'sk-proj-placeholder_' + 'x'.repeat(40)],
    ['public.pem', '-----BEGIN PUBLIC KEY-----\nfixture\n-----END PUBLIC KEY-----'],
    ['certificate.pem', '-----BEGIN CERTIFICATE-----\nfixture\n-----END CERTIFICATE-----'],
    ['id_rsa.pub', 'ssh-rsa public-fixture'],
    ['assets/app.js', 'let t="sourceMappingURL",r=".map";console.log(t,r)'],
  ]) assert.doesNotThrow(() => assertSafeArtifactFile(name, new TextEncoder().encode(data)))
})

test('explicit local source packages may contain maps but never credentials', () => {
  assert.doesNotThrow(() => assertSafeArtifactFile('app.js.map', '{}', { allowSourceMaps: true }))
  assert.doesNotThrow(() => assertSafeArtifactFile('app.js', '//# sourceMappingURL=data:application/json;base64,e30=', { allowSourceMaps: true }))
  assert.throws(() => assertSafeArtifactFile('app.js', syntheticSecret, { allowSourceMaps: true }), /embedded-api-key/)
})

test('a placeholder does not hide the next embedded credential', () => {
  assert.throws(() => assertSafeArtifactFile('app.js', 'sk-' + 'x'.repeat(48) + ' ' + syntheticSecret), /embedded-api-key/)
})

test('desktop build artifact directory checks nested files and rejects links', async t => {
  const root = await mkdtemp(join(tmpdir(), 'proxy-desktop-artifact-scan-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(join(root, 'assets'))
  await writeFile(join(root, 'assets/app.js'), 'console.log("sdk")')
  await assertSafeArtifactDirectory(root)
  await writeFile(join(root, 'assets/app.js.map'), '{}')
  await assert.rejects(assertSafeArtifactDirectory(root), /source-map-file.*assets\/app.js.map/)
  await rm(join(root, 'assets/app.js.map'))
  await symlink(join(root, 'assets/app.js'), join(root, 'linked.js'))
  await assert.rejects(assertSafeArtifactDirectory(root), /symbolic links/)
})

test('production CLI pack blocks built maps and embedded keys before writing a ZIP', async t => {
  const root = await mkdtemp(join(tmpdir(), 'proxy-app-artifact-scan-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await writeFile(join(root, 'manifest.json'), JSON.stringify({ schema: 'proxy.app/v1', id: 'app.test.scanner', version: '1.0.0', name: 'Artifact scanner', backend: { type: 'platform' }, permissions: [] }))
  await writeFile(join(root, 'package.json'), JSON.stringify({ private: true, scripts: { build: 'node build.mjs' } }))
  await writeFile(join(root, 'build.mjs'), 'import { mkdir, readFile, writeFile } from "node:fs/promises";await mkdir("dist",{recursive:true});for (const [name,data] of Object.entries(JSON.parse(await readFile("fixture.json","utf8")))) await writeFile("dist/"+name,data);')
  const output = join(root, 'release.zip')
  for (const [files, rule] of [
    [{ 'app.js.map': '{}' }, 'source-map-file'],
    [{ 'app.js': 'const key=' + JSON.stringify(syntheticSecret) }, 'embedded-api-key'],
  ]) {
    await writeFile(join(root, 'fixture.json'), JSON.stringify({ 'index.html': '<!doctype html>', ...files }))
    await assert.rejects(exec(process.execPath, [new URL('./proxy-app.mjs', import.meta.url).pathname, 'pack', root, '-o', output]), error => {
      assert.ok(error.stderr.includes(rule))
      assert.ok(!error.stderr.includes(syntheticSecret))
      return true
    })
    await assert.rejects(access(output))
  }
})

test('upload --source cannot use the local source-map exemption', async t => {
  const root = await mkdtemp(join(tmpdir(), 'proxy-app-source-upload-scan-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await writeFile(join(root, 'manifest.json'), JSON.stringify({ schema: 'proxy.app/v1', id: 'app.test.scanner', version: '1.0.0', name: 'Artifact scanner', backend: { type: 'platform' }, permissions: [] }))
  await writeFile(join(root, '.proxy-app.json'), JSON.stringify({ app_id: 'scanner-app', slug: 'app.test.scanner' }))
  await writeFile(join(root, 'index.html'), '<!doctype html>')
  await writeFile(join(root, 'index.js.map'), '{}')

  // upload resolves the remote app before building/scanning. Keep that order
  // intact and provide only the lookup response needed to reach local scanning.
  const requests = []
  const server = createServer((request, response) => {
    requests.push({ method: request.method, url: request.url })
    response.setHeader('Content-Type', 'application/json')
    if (request.method === 'GET' && request.url === '/api/portal/user/app-workspace') {
      response.end(JSON.stringify({ data: { items: [{ id: 'scanner-app', slug: 'app.test.scanner', status: 'draft', versions: [] }] } }))
      return
    }
    response.writeHead(404).end(JSON.stringify({ error: 'unexpected fixture request' }))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(async () => new Promise(resolve => server.close(resolve)))

  const output = join(root, 'upload.zip')
  await assert.rejects(exec(process.execPath, [new URL('./proxy-app.mjs', import.meta.url).pathname, 'upload', root, '--source', '-o', output], {
    env: {
      ...process.env,
      PROXY_USER_ACCESS_TOKEN: 'synthetic-management-token',
      PROXY_API_BASE_URL: `http://127.0.0.1:${server.address().port}/api`,
    },
  }), /source-map-file/)
  assert.deepEqual(requests, [{ method: 'GET', url: '/api/portal/user/app-workspace' }], 'scanner must reject the bundle before upload')
  await assert.rejects(access(output))
})
