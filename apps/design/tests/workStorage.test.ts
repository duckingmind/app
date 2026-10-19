import assert from 'node:assert/strict'
import test from 'node:test'
import type { Work } from '../src/core.ts'
import { createWorkStorage, workForStorage } from '../src/workStorage.ts'
const KEY = 'design:works:v1'
type Operation = { op: 'put' | 'delete'; key: string; value?: unknown; expectedRevision?: number }
function work(id: string, patch: Partial<Work> = {}): Work {
  return { id, batch: 'batch', title: id, scene: '', pose: '', ratio: '1:1', model: 'model',
    createdAt: '2026-09-20', kind: 'product', status: 'queued', images: [], ...patch }
}
function memory(initial: Record<string, unknown> = {}) {
  const values = new Map(Object.entries(initial)), revisions = new Map(Object.keys(initial).map(key => [key, 1]))
  const receipts = new Map<string, { json: string; result: unknown }>()
  let sequence = 1
  const calls: { operations: Operation[]; key: string }[] = []
  let fail: (operations: Operation[]) => boolean = () => false
  let loseReply: (operations: Operation[]) => boolean = () => false
  let afterRead: (() => Promise<void>) | undefined
  const storage = {
    async get<T>(key: string) { return structuredClone(values.get(key) ?? null) as T | null },
    async getEntry<T>(key: string) { return values.has(key) ? { value: structuredClone(values.get(key)) as T, revision: revisions.get(key)! } : null },
    async getMany<T>(keys: string[]) {
      const result = Object.fromEntries(keys.map(key => [key, structuredClone(values.get(key) ?? null) as T | null]))
      if (afterRead) { const run = afterRead; afterRead = undefined; await run() }
      return result
    },
    async batch(operations: Operation[], options?: { idempotencyKey?: string }) {
      const key = options?.idempotencyKey || ''
      assert.ok(key)
      assert.ok(operations.length <= 100)
      assert.ok(Buffer.byteLength(JSON.stringify({ operations })) <= 1 << 20)
      calls.push({ operations: structuredClone(operations), key })
      const json = JSON.stringify(operations)
      if (receipts.has(key)) { const receipt = receipts.get(key)!; assert.equal(receipt.json, json); return structuredClone(receipt.result) }
      if (fail(operations)) throw new Error('storage unavailable')
      for (const operation of operations) if (operation.expectedRevision !== undefined && operation.expectedRevision !== (revisions.get(operation.key) || 0))
        throw Object.assign(new Error('revision conflict'), { code: 'APP_STORAGE_CONFLICT' })
      const result = operations.map(operation => {
        if (operation.op === 'put') { values.set(operation.key, structuredClone(operation.value)); revisions.set(operation.key, ++sequence) }
        else { values.delete(operation.key); revisions.delete(operation.key) }
        return { key: operation.key, success: true, ...(operation.op === 'put' ? { revision: revisions.get(operation.key) } : {}) }
      })
      receipts.set(key, { json, result: structuredClone(result) })
      if (loseReply(operations)) throw new Error('reply lost')
      return result
    },
  }
  return { values, calls, storage,
    set fail(value: typeof fail) { fail = value }, set loseReply(value: typeof loseReply) { loseReply = value }, set afterRead(value: typeof afterRead) { afterRead = value } }
}

test('small snapshots atomically commit immutable details and conditional index, unchanged saves do nothing', async () => {
  const store = memory(), repository = createWorkStorage(store.storage)
  await repository.save([work('one'), work('two')])
  assert.equal(store.calls.length, 1)
  assert.equal(store.calls[0].operations.at(-1)?.key, KEY)
  assert.equal(store.calls[0].operations.at(-1)?.expectedRevision, 0)
  const index = store.values.get(KEY) as { detailKey: string }[]
  assert.match(index[0].detailKey, /^design:work:v2:[a-f0-9-]{36}$/)
  await repository.save([work('one'), work('two')])
  assert.equal(store.calls.length, 1)
  await repository.save([work('one', { title: 'changed' }), work('two')])
  assert.equal(store.values.has(index[0].detailKey), false)
  assert.equal(store.values.has(index[1].detailKey), true)
  assert.equal((await createWorkStorage(store.storage).load())[0].title, 'changed')
})

test('two tabs cannot restore deleted details or overwrite another tab additions', async () => {
  const store = memory()
  await createWorkStorage(store.storage).save([work('old')])
  const first = createWorkStorage(store.storage), second = createWorkStorage(store.storage)
  await first.load(); const stale = await second.load()
  await first.save([])
  await assert.rejects(second.save([work('new'), ...stale]), { code: 'APP_STORAGE_CONFLICT' })
  assert.deepEqual(await createWorkStorage(store.storage).load(), [])
  await assert.rejects(second.save([work('new')]), { code: 'APP_STORAGE_CONFLICT' })
  await second.load()
  await second.save([work('new')])
  assert.equal((await createWorkStorage(store.storage).load())[0].id, 'new')
})

test('two tabs editing the same work reject the stale writer without changing the winning detail', async () => {
  const store = memory()
  await createWorkStorage(store.storage).save([work('same')])
  const a = createWorkStorage(store.storage), b = createWorkStorage(store.storage)
  await a.load(); await b.load()
  await a.save([work('same', { title: 'winner' })])
  await assert.rejects(b.save([work('same', { title: 'stale' })]), { code: 'APP_STORAGE_CONFLICT' })
  assert.equal((await createWorkStorage(store.storage).load())[0].title, 'winner')
})

test('large snapshots stage bounded immutable chunks, publish the index last, and keep all 40 works', async () => {
  const store = memory(), repository = createWorkStorage(store.storage)
  const works = Array.from({ length: 40 }, (_, index) => work(`job-${index}`, { pose: '很长的独立描述。'.repeat(5000), position: index, batchSize: 40 }))
  await repository.save(works)
  assert.ok(store.calls.length > 2)
  for (const call of store.calls.slice(0, -1)) assert.equal(call.operations.some(operation => operation.key === KEY), false)
  const restored = await createWorkStorage(store.storage).load()
  assert.equal(restored.length, 40)
  assert.equal(restored[39].pose, works[39].pose)
  assert.equal(restored[39].position, 39)
})

test('failed staged replacement cannot partially change the currently published works', async () => {
  const store = memory(), repository = createWorkStorage(store.storage)
  const original = Array.from({ length: 12 }, (_, index) => work(`work-${index}`, { pose: 'old' }))
  await repository.save(original)
  store.fail = operations => operations.some(operation => operation.key === KEY)
  await assert.rejects(repository.save(original.map(item => ({ ...item, pose: 'x'.repeat(150000) }))), /storage unavailable/)
  const visible = await createWorkStorage(store.storage).load()
  assert.ok(visible.every(item => item.pose === 'old'))
  store.fail = () => false
  await repository.save(original.map(item => ({ ...item, pose: 'x'.repeat(150000) })))
  assert.ok((await createWorkStorage(store.storage).load()).every(item => item.pose.length === 150000))
})

test('lost commit replies reuse original idempotency key and operations before a changed snapshot', async () => {
  const store = memory(), repository = createWorkStorage(store.storage)
  let once = true
  store.loseReply = operations => operations.some(operation => operation.key === KEY) && once && !(once = false)
  await assert.rejects(repository.save([work('one')]), /reply lost/)
  const first = store.calls[0]
  await repository.save([work('one', { title: 'changed' })])
  assert.equal(store.calls[1].key, first.key)
  assert.deepEqual(store.calls[1].operations, first.operations)
  assert.equal((await createWorkStorage(store.storage).load())[0].title, 'changed')
})

test('lost staged replies also retain their identity and never rewrite already committed chunks', async () => {
  const store = memory(), repository = createWorkStorage(store.storage)
  let once = true
  store.loseReply = () => once && !(once = false)
  const works = Array.from({ length: 15 }, (_, i) => work(`long-${i}`, { pose: 'a'.repeat(150000) }))
  await assert.rejects(repository.save(works), /reply lost/)
  await repository.save(works)
  assert.equal(store.calls[0].key, store.calls[1].key)
  assert.equal((await repository.load()).length, 15)
})

test('oversized, unsafe, duplicate work is rejected before any storage write', async () => {
  const store = memory(), repository = createWorkStorage(store.storage)
  await assert.rejects(repository.save([work('large', { pose: 'a'.repeat(180001) })]), /180 KB/)
  await assert.rejects(repository.save([work('../bad')]), /编号无效/)
  await assert.rejects(repository.save([work('same'), work('same')]), /重复/)
  assert.equal(store.calls.length, 0)
})

test('legacy documents migrate without Base64, signed URLs or review bytes; handles and text survive', async () => {
  const legacy = work('legacy', { status: 'completed', images: [{ url: 'https://example.test/expired?signature=old', assetId: 'asset_1' }], taskId: 'task_1', reviewKey: 'design:review:legacy', text: 'copy' })
  const store = memory({ [KEY]: [legacy], 'design:review:legacy': { images: [{ url: 'data:image/png;base64,YQ==' }] } })
  const repository = createWorkStorage(store.storage)
  const loaded = await repository.load()
  assert.equal(loaded[0].status, 'completed')
  assert.equal(loaded[0].taskId, 'task_1')
  assert.equal(loaded[0].images[0].assetId, 'asset_1')
  assert.equal(loaded[0].reviewKey, 'design:review:legacy')
  await repository.save(loaded)
  assert.doesNotMatch(JSON.stringify([...store.values]), /data:image|signature=old/)
  assert.equal((await repository.load())[0].text, 'copy')
})

test('stored output strips every temporary image URL while retaining stable asset IDs', () => {
  const stored = workForStorage(work('image', { status: 'completed', images: [
    { url: 'data:image/png;base64,YQ==' }, { url: 'blob:temporary' }, { url: 'https://media.test/temporary', assetId: 'asset_2' },
  ] }))
  assert.deepEqual(stored.images, [])
  assert.deepEqual(stored.assetIds, ['asset_2'])
  assert.doesNotMatch(JSON.stringify(stored), /data:image|blob:|https:/)
})

test('missing and unsafe detail references fail loudly', async () => {
  await assert.rejects(createWorkStorage(memory({ [KEY]: [{ id: 'one', detailKey: 'design:work:one' }] }).storage).load(), /详情缺失/)
  await assert.rejects(createWorkStorage(memory({ [KEY]: [{ id: 'one', detailKey: 'unrelated' }] }).storage).load(), /详情地址无效/)
  await assert.rejects(createWorkStorage(memory({ [KEY]: [{ id: 'one', detailKey: 'design:work:one' }], 'design:work:one': work('two') }).storage).load(), /编号不一致/)
})

test('read retries a concurrently changed index instead of reporting missing old details', async () => {
  const store = memory(), writer = createWorkStorage(store.storage)
  await writer.save([work('one'), work('two')])
  store.afterRead = () => writer.save([work('new')])
  assert.deepEqual((await createWorkStorage(store.storage).load()).map(item => item.id), ['new'])
})

test('delete failure leaves index and its details atomic, retry removes legacy review keys safely', async () => {
  const store = memory(), repository = createWorkStorage(store.storage)
  await repository.save([work('old')])
  store.fail = operations => operations.some(operation => operation.op === 'delete')
  await assert.rejects(repository.save([work('new')]), /storage unavailable/)
  assert.equal((await createWorkStorage(store.storage).load())[0].id, 'old')
  store.fail = () => false
  await repository.save([work('new')])
  assert.equal((await repository.load())[0].id, 'new')
  assert.equal([...store.values.keys()].some(key => key.startsWith('design:work:old:')), false)
})

test('retention caps at 40 and independent accounts keep their own snapshots', async () => {
  const a = memory(), b = memory()
  await createWorkStorage(a.storage).save(Array.from({ length: 45 }, (_, i) => work(`job-${i}`)))
  await createWorkStorage(b.storage).save([work('same')])
  assert.equal((await createWorkStorage(a.storage).load()).length, 40)
  assert.deepEqual((await createWorkStorage(b.storage).load()).map(item => item.id), ['same'])
})


test('legacy URLs without stable handles remain readable and are not silently erased by another autosave', async () => {
  for (const inline of [true, false]) {
    const legacy = work('legacy', { status: 'completed', images: [{ url: 'https://media.test/legacy-signed' }] })
    const initial = inline ? { [KEY]: [legacy] } : { [KEY]: [{ id: 'legacy', detailKey: 'design:work:legacy' }], 'design:work:legacy': legacy }
    const store = memory(initial), repository = createWorkStorage(store.storage)
    const loaded = await repository.load()
    assert.equal(loaded[0].images[0].url, legacy.images[0].url)
    assert.match(loaded[0].error!, /及时下载/)
    await repository.save([work('new'), ...loaded])
    const reloaded = await repository.load()
    assert.equal(reloaded[1].images[0].url, legacy.images[0].url)
    await repository.save([work('new')])
    assert.deepEqual((await repository.load()).map(item => item.id), ['new'])
  }
})

test('long valid work identifiers produce bounded storage keys', async () => {
  const store = memory()
  await createWorkStorage(store.storage).save([work('a'.repeat(160))])
  assert.ok([...store.values.keys()].every(key => key.length <= 160))
  assert.equal((await createWorkStorage(store.storage).load())[0].id.length, 160)
})
