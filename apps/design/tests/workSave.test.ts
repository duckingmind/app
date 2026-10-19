import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import vm from 'node:vm'
import test from 'node:test'
import ts from 'typescript'
import { runCommerceJobs } from '../src/commerce.ts'
import type { Work } from '../src/core.ts'

// Exercise the real React-owned flush routine with its ref dependencies, without mounting a UI or calling the platform.
async function harness() {
  const source = await fs.readFile(new URL('../src/main.tsx', import.meta.url), 'utf8')
  const start = source.indexOf('  function flushWorkSave(): Promise<void> {')
  const end = source.indexOf('\n  function updateWork(', start)
  assert.ok(start >= 0 && end > start)
  const work: Work = { id: 'mock', batch: 'batch', title: 'mock', scene: '', pose: '', ratio: '1:1', model: 'model', createdAt: '2026-09-20', kind: 'product', status: 'queued', images: [] }
  let reject = true
  const notices: string[] = []
  const context = vm.createContext({ Promise, Error, clearTimeout,
    workSaveTimerRef: { current: null }, pendingWorkSaveRef: { current: [work] }, accountRecoveryRef: { current: false },
    workSavePromiseRef: { current: null }, writeQueue: { current: Promise.resolve() }, mounted: { current: true },
    workStorageRef: { current: { async save() { if (reject) throw new Error('storage quota exceeded') } } },
    setNotice: (message: string) => notices.push(message), messageOf: (error: Error) => error.message,
  })
  vm.runInContext(ts.transpileModule(source.slice(start, end), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, context)
  return { context, work, notices, recover: () => { reject = false }, flush: () => vm.runInContext('flushWorkSave()', context) as Promise<void> }
}

test('required storage rejection prevents generation dispatch and retains the failed snapshot for retry', async () => {
  const h = await harness()
  let posts = 0
  const submit = async () => {
    await h.flush()
    await h.context.writeQueue.current
    await runCommerceJobs({ works: [h.work], signal: new AbortController().signal, prepare: async () => '{}', onUpdate() {},
      api: { async request<T>() { posts++; return { data: [{ url: 'https://media.test/mock' }] } as T } } })
  }
  await assert.rejects(submit(), /storage quota exceeded/)
  assert.equal(posts, 0)
  assert.deepEqual(h.context.pendingWorkSaveRef.current, [h.work])
  assert.equal(h.notices.length, 1)
  h.recover()
  await submit()
  assert.equal(posts, 1)
  assert.equal(h.context.pendingWorkSaveRef.current, null)
})

test('an account recovery prevents a required flush even without a queued snapshot', async () => {
  const h = await harness()
  h.context.pendingWorkSaveRef.current = null
  h.context.accountRecoveryRef.current = true
  await assert.rejects(h.flush(), /账户连接/)
})
