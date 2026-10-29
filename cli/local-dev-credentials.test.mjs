import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, readdir, rm, stat, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createLocalCredentialStore } from './local-dev-credentials.mjs'

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'proxy-app-credentials-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const projectPath = join(root, 'project')
  await mkdir(projectPath)
  const records = new Map()
  const calls = []
  let failure = null
  const runCommand = async (file, args, options) => {
    calls.push({ file, args, options })
    if (failure) throw new Error(failure)
    if (args[0] === '-i') {
      const match = /^add-generic-password -U -s ([a-z.-]+) -a ([a-f0-9]{64}) -w (proxy-app-token-v1:[A-Za-z0-9+/]+=*)\n$/.exec(options.input)
      assert.ok(match, 'only one fixed-format command can enter the security parser')
      records.set(match[1] + ':' + match[2], match[3])
      return { exitCode: 0, stdout: '' }
    }
    const key = args[args.indexOf('-s') + 1] + ':' + args[args.indexOf('-a') + 1]
    if (!records.has(key)) return { exitCode: 44, stdout: '' }
    if (args[0] === 'find-generic-password') return { exitCode: 0, stdout: records.get(key) + '\n' }
    assert.equal(args[0], 'delete-generic-password')
    records.delete(key)
    return { exitCode: 0, stdout: '' }
  }
  const options = {
    baseURL: 'https://platform.example/api', portalURL: 'https://platform.example',
    appID: 'app-1', projectPath, platform: 'darwin', runCommand,
    stateDirectory: join(root, 'cache'),
  }
  return { root, options, calls, records, fail: (value) => { failure = value }, create: (overrides = {}) => createLocalCredentialStore({ ...options, ...overrides }) }
}

test('secure cache restores across instances and never puts a token in subprocess argv', async (t) => {
  const f = await fixture(t)
  const token = 'fake-portal-token-"\'\\\n\r\u0000你好 $(not-a-command) `example`'
  const store = f.create()
  assert.equal(store.kind, 'keychain')
  assert.equal(await store.load(), null)
  await store.save(token)
  assert.equal(await f.create().load(), token)
  assert.equal(store.reason, '')
  assert.deepEqual(await readdir(f.options.stateDirectory), [])
  for (const call of f.calls) {
    assert.equal(call.file, '/usr/bin/security')
    assert.ok(!JSON.stringify(call.args).includes('fake-portal-token'))
    assert.ok(!JSON.stringify(call.args).includes(Buffer.from(token).toString('base64')))
    assert.ok(!call.options.input.includes('fake-portal-token'))
    assert.ok(call.options.timeoutMs > 0 && call.options.timeoutMs <= 5000)
  }
})

test('cache identity normalizes URLs and symlinks while isolating platform, Portal, app and project', async (t) => {
  const f = await fixture(t)
  const projectLink = join(f.root, 'project-link')
  const otherProject = join(f.root, 'other-project')
  await symlink(f.options.projectPath, projectLink)
  await mkdir(otherProject)
  await f.create().save('scope-token')
  assert.equal(await f.create({
    baseURL: 'https://PLATFORM.example:443/api///', portalURL: 'https://platform.example/',
    projectPath: projectLink, appID: ' app-1 ', version: 'next', entryURL: 'http://127.0.0.1:6000/',
  }).load(), 'scope-token')
  for (const overrides of [
    { baseURL: 'https://other.example/api' }, { baseURL: 'https://platform.example/other-api' },
    { portalURL: 'https://other.example' }, { appID: 'app-2' }, { projectPath: otherProject },
  ]) assert.equal(await f.create(overrides).load(), null)
})

test('unsupported systems use memory without writing credentials or calling security', async (t) => {
  const f = await fixture(t)
  const store = f.create({ platform: 'linux' })
  assert.equal(store.kind, 'memory')
  assert.match(store.reason, /仅保存在开发进程内存中/)
  await store.save('memory-token')
  assert.equal(await store.load(), 'memory-token')
  assert.equal(await f.create({ platform: 'linux' }).load(), null)
  await store.clear()
  assert.equal(await store.load(), null)
  assert.equal(f.calls.length, 0)
  await assert.rejects(readdir(f.options.stateDirectory), { code: 'ENOENT' })
})

test('the local credential cache stores developer authorization only', async (t) => {
  const f = await fixture(t)
  const store = f.create()
  await store.save('developer-token')
  assert.equal(await f.create().load(), 'developer-token')
  assert.throws(() => f.create({ purpose: 'runtime' }), /只支持开发者授权/)
  const developer = f.create({ purpose: 'development' })
  assert.equal(await developer.load(), 'developer-token')
  assert.equal(await f.create({ purpose: 'development', version: '0.2.0', entryURL: 'http://127.0.0.1:6000/' }).load(), 'developer-token')
  await developer.clear()
  assert.equal(await f.create().load(), null)
})

test('missing Keychain entries are normal and do not disable secure persistence', async (t) => {
  const f = await fixture(t)
  const store = f.create()
  assert.equal(await store.load(), null)
  assert.equal(store.kind, 'keychain')
  await store.clear()
  assert.equal(store.kind, 'keychain')
  await store.save('new-token')
  assert.equal(await f.create().load(), 'new-token')
})

test('logout removes the stored credential and leaves only a private non-secret invalidation marker', async (t) => {
  const f = await fixture(t)
  const store = f.create()
  await store.save('logout-token')
  await store.clear()
  assert.equal(f.records.size, 0)
  assert.equal(await store.load(), null)
  assert.equal(await f.create().load(), null)
  const markers = await readdir(f.options.stateDirectory)
  assert.equal(markers.length, 1)
  const marker = join(f.options.stateDirectory, markers[0])
  assert.ok(!(await readFile(marker, 'utf8')).includes('logout-token'))
  assert.equal((await stat(marker)).mode & 0o777, 0o600)
})

test('a failed Keychain delete cannot restore an old login after restarting', async (t) => {
  const f = await fixture(t)
  const store = f.create()
  await store.save('old-account-token')
  f.fail('security denied access: old-account-token')
  await store.clear()
  assert.equal(store.kind, 'memory')
  assert.ok(!store.reason.includes('old-account-token'))
  assert.equal(await store.load(), null)
  assert.equal(f.records.size, 1)
  f.fail(null)
  const callsBeforeLoad = f.calls.length
  assert.equal(await f.create().load(), null)
  assert.equal(f.calls.length, callsBeforeLoad, 'the invalidation marker blocks reading the old credential')
  await f.create().save('replacement-token')
  assert.equal(await f.create().load(), 'replacement-token')
})

test('failed replacement keeps the new login in memory and blocks restoring the previous account', async (t) => {
  const f = await fixture(t)
  await f.create().save('previous-account-token')
  const store = f.create()
  f.fail('unsafe stderr contains new-account-token')
  await store.save('new-account-token')
  assert.equal(store.kind, 'memory')
  assert.equal(await store.load(), 'new-account-token')
  assert.ok(!store.reason.includes('new-account-token'))
  f.fail(null)
  assert.equal(await f.create().load(), null)
  await store.save('another-memory-token')
  assert.equal(await store.load(), 'another-memory-token')
  assert.equal(await f.create().load(), null)
})

test('read failures fall back without exposing stderr or invalidating a valid saved credential', async (t) => {
  const f = await fixture(t)
  await f.create().save('saved-token')
  f.fail('sensitive subprocess stderr: saved-token')
  const store = f.create()
  assert.equal(await store.load(), null)
  assert.equal(store.kind, 'memory')
  assert.ok(!store.reason.includes('saved-token'))
  f.fail(null)
  assert.equal(await f.create().load(), 'saved-token')
})

test('interactive exit zero without saving cannot enable restoring a missing or previous token', async (t) => {
  for (const previousToken of [null, 'previous-account-token']) {
    const f = await fixture(t)
    if (previousToken) await f.create().save(previousToken)
    const store = f.create({
      runCommand: async (file, args, options) => args[0] === '-i'
        ? { exitCode: 0, stdout: '', stderr: 'simulated save failure: new-account-token' }
        : f.options.runCommand(file, args, options),
    })
    await store.save('new-account-token')
    assert.equal(store.kind, 'memory')
    assert.equal(await store.load(), 'new-account-token')
    assert.ok(!store.reason.includes('new-account-token'))
    assert.equal((await readdir(f.options.stateDirectory)).length, 1)
    assert.equal(await f.create().load(), null)
  }
})

test('a failed verification read preserves the invalidation marker even when saving succeeded', async (t) => {
  const f = await fixture(t)
  const store = f.create({
    runCommand: async (file, args, options) => args[0] === 'find-generic-password'
      ? { exitCode: 36, stdout: '', stderr: 'simulated read denial: newly-saved-token' }
      : f.options.runCommand(file, args, options),
  })
  await store.save('newly-saved-token')
  assert.equal(f.records.size, 1)
  assert.equal(store.kind, 'memory')
  assert.equal(await store.load(), 'newly-saved-token')
  assert.ok(!store.reason.includes('newly-saved-token'))
  assert.equal((await readdir(f.options.stateDirectory)).length, 1)
  assert.equal(await f.create().load(), null)
})

test('timeouts and malformed subprocess results are bounded and sanitized', async (t) => {
  const f = await fixture(t)
  const started = Date.now()
  const timedOut = f.create({ timeoutMs: 15, runCommand: () => new Promise(() => {}) })
  assert.equal(await timedOut.load(), null)
  assert.equal(timedOut.kind, 'memory')
  assert.ok(Date.now() - started < 1000)
  for (const result of [
    { exitCode: 1, stdout: 'secret-in-stdout', stderr: 'secret-in-stderr' },
    { exitCode: 0, stdout: 'not-an-encoded-token\n' },
    { exitCode: 0, stdout: 'proxy-app-token-v1:!!!!\n' },
    { exitCode: 0, stdout: 'x'.repeat(128 * 1024 + 1) },
  ]) {
    const store = f.create({ runCommand: async () => result })
    assert.equal(await store.load(), null)
    assert.equal(store.kind, 'memory')
    assert.ok(!store.reason.includes('secret'))
  }
})

test('invalid cache configuration and invalid tokens produce only generic errors', async (t) => {
  const f = await fixture(t)
  for (const overrides of [
    { appID: '' }, { projectPath: '' }, { baseURL: '' },
    { baseURL: 'https://user:do-not-expose@example.test/api' },
    { portalURL: 'https://example.test/?token=do-not-expose' },
    { projectPath: join(f.root, 'missing-do-not-expose') },
  ]) assert.throws(() => f.create(overrides), (error) => !error.message.includes('do-not-expose'))
  const store = f.create()
  await assert.rejects(store.save(''), /凭证为空或格式无效/)
  await assert.rejects(store.save(null), /凭证为空或格式无效/)
  await assert.rejects(store.save('x'.repeat(64 * 1024 + 1)), /凭证为空或格式无效/)
  assert.equal(f.calls.length, 0)
})

test('concurrent saves and logout are serialized so a late save cannot resurrect the login', async (t) => {
  const f = await fixture(t)
  const store = f.create()
  await Promise.all([store.save('first-token'), store.save('second-token'), store.clear()])
  assert.equal(await store.load(), null)
  assert.equal(await f.create().load(), null)
  assert.equal(f.records.size, 0)
})

test('tokens exceeding the security interactive line limit stay in memory and invalidate the old cache', async (t) => {
  const f = await fixture(t)
  await f.create().save('previous-short-token')
  const store = f.create()
  const callsBeforeSave = f.calls.length
  const longToken = 'opaque-token-'.repeat(400)
  await store.save(longToken)
  assert.equal(store.kind, 'memory')
  assert.equal(await store.load(), longToken)
  assert.equal(f.calls.length, callsBeforeSave)
  assert.equal(await f.create().load(), null)
})

test('a marker write failure disables persistence before mutating the Keychain', async (t) => {
  const f = await fixture(t)
  const store = f.create({ stateDirectory: join(f.root, 'project', 'not-created', '\u0000') })
  await store.save('memory-only-token')
  assert.equal(store.kind, 'memory')
  assert.equal(await store.load(), 'memory-only-token')
  assert.equal(f.calls.length, 0)
  assert.match(store.reason, /失效记录/)
})
