import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { readLocalFunctionSources } from './runtime-sources.mjs'

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'proxy-runtime-sources-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  return root
}

test('reads manifest entries and importable runtime modules in stable order', async t => {
  const root = await fixture(t)
  await mkdir(join(root, 'runtime', 'shared'), { recursive: true })
  await writeFile(join(root, 'runtime', 'task.mjs'), 'export default async () => ({ ok: true })\n')
  await writeFile(join(root, 'runtime', 'shared', 'helper.js'), 'export const helper = true\n')
  await writeFile(join(root, 'runtime', 'notes.txt'), 'ignored')
  const files = await readLocalFunctionSources(root, { functions: { task: { entry: 'runtime/task.mjs' } } })
  assert.deepEqual(files, [
    { path: 'runtime/shared/helper.js', source: 'export const helper = true\n' },
    { path: 'runtime/task.mjs', source: 'export default async () => ({ ok: true })\n' },
  ])
})

test('rejects missing entries, symbolic links, invalid UTF-8, and oversized sources', async t => {
  const root = await fixture(t)
  await assert.rejects(
    readLocalFunctionSources(root, { functions: { task: { entry: 'runtime/task.mjs' } } }),
    /entry is missing/,
  )

  await mkdir(join(root, 'runtime'), { recursive: true })
  await writeFile(join(root, 'outside.mjs'), 'export default true')
  await symlink(join(root, 'outside.mjs'), join(root, 'runtime', 'task.mjs'))
  await assert.rejects(
    readLocalFunctionSources(root, { functions: { task: { entry: 'runtime/task.mjs' } } }),
    /symbolic links/,
  )
  await rm(join(root, 'runtime', 'task.mjs'))
  await writeFile(join(root, 'runtime', 'task.mjs'), Buffer.from([0xff, 0xfe]))
  await assert.rejects(
    readLocalFunctionSources(root, { functions: { task: { entry: 'runtime/task.mjs' } } }),
    /UTF-8/,
  )
  await writeFile(join(root, 'runtime', 'task.mjs'), Buffer.alloc(4 * 1024 * 1024 + 1, 'x'))
  await assert.rejects(
    readLocalFunctionSources(root, { functions: { task: { entry: 'runtime/task.mjs' } } }),
    /exceeds 4 MiB/,
  )
})

test('does not send runtime files when the manifest declares no server function', async t => {
  const root = await fixture(t)
  assert.deepEqual(await readLocalFunctionSources(root, {}), [])
})
