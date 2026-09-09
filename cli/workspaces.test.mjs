import assert from 'node:assert/strict'
import { readFile, readdir, realpath } from 'node:fs/promises'
import test from 'node:test'

const root = new URL('../', import.meta.url)
const readJSON = async (path) => JSON.parse(await readFile(new URL(path, root), 'utf8'))

test('app workspaces and lockfile resolve to the application directories', async () => {
  const pkg = await readJSON('package.json')
  const lock = await readJSON('package-lock.json')
  assert.deepEqual(lock.packages[''].workspaces, pkg.workspaces)
  const entries = await readdir(new URL('apps/', root), { withFileTypes: true })
  const applications = entries.filter((entry) => entry.isDirectory()).map((entry) => `apps/${entry.name}`)
  assert.deepEqual(pkg.workspaces.filter((path) => path.startsWith('apps/')).sort(), applications.sort())

  for (const path of pkg.workspaces) {
    const workspace = await readJSON(`${path}/package.json`)
    const locked = lock.packages[path]
    assert.ok(locked, `missing lockfile workspace: ${path}`)
    assert.equal(locked.name, workspace.name)
    assert.equal(locked.extraneous, undefined)
    assert.deepEqual(lock.packages[`node_modules/${workspace.name}`], { resolved: path, link: true })
    if (path.startsWith('apps/')) {
      assert.equal(workspace.private, true, 'application packages must not publish to npm')
      await readJSON(`${path}/manifest.json`)
    }
  }
  assert.ok(Object.keys(lock.packages).every((path) => !path.startsWith('examples/')))
})

test('installed workspace links point to the current source directories', async () => {
  const pkg = await readJSON('package.json')
  for (const path of pkg.workspaces) {
    const workspace = await readJSON(`${path}/package.json`)
    assert.equal(
      await realpath(new URL(`node_modules/${workspace.name}`, root)),
      await realpath(new URL(path, root)),
    )
  }
})
