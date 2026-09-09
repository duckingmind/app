import assert from 'node:assert/strict'
import test from 'node:test'
import type { Work } from '../src/core.ts'
import { createWorkStorage } from '../src/workStorage.ts'

const HISTORY_KEY = 'design:works:v1'
function work(id: string): Work {
  return {
    id, batch: 'batch-one', title: `商品 ${id}`, scene: '商品套图', pose: '保留产品外观',
    ratio: '1:1', model: 'image-model', createdAt: '2026-09-08T00:00:00Z', kind: 'product',
    status: 'queued', images: [],
  }
}

function memory(initial: Record<string, unknown> = {}) {
  const values = new Map(Object.entries(initial))
  const writes: string[] = []
  const deletes: string[] = []
  let failWrite = ''
  let failDelete = ''
  return {
    values, writes, deletes,
    set failWrite(key: string) { failWrite = key },
    set failDelete(key: string) { failDelete = key },
    storage: {
      async get<T>(key: string): Promise<T | null> { return structuredClone(values.get(key) ?? null) as T | null },
      async set(key: string, value: unknown) {
        writes.push(key)
        if (key === failWrite) throw new Error(`write unavailable: ${key}`)
        values.set(key, structuredClone(value))
      },
      async delete(key: string) {
        deletes.push(key)
        if (key === failDelete) throw new Error(`delete unavailable: ${key}`)
        values.delete(key)
      },
    },
  }
}

test('24 long plans and quality reports persist without truncating the active batch', async () => {
  const store = memory()
  const repository = createWorkStorage(store.storage)
  const works = Array.from({ length: 24 }, (_, position) => ({
    ...work(`job-${position}`), position, batchSize: 24,
    pose: '具体商品外观与独立排版要求。'.repeat(500),
    plan: { direction: '统一视觉方向', brief: '保留真实商品细节与清晰的图片文字。'.repeat(500) },
    quality: { status: 'needs_review' as const, summary: '需人工核对小字', issues: ['文字过小，请逐图核对'], checkedAt: '2026-09-08T00:01:00Z' },
    text: '商品标题与五条真实卖点', reviewKey: `design:review:job-${position}`,
  }))
  assert.ok(new TextEncoder().encode(JSON.stringify(works)).length > 180000)
  await repository.save(works)
  const index = store.values.get(HISTORY_KEY) as Record<string, unknown>[]
  assert.equal(index.length, 24)
  assert.ok(new TextEncoder().encode(JSON.stringify(index)).length < 10000)
  assert.equal(index.some(entry => 'pose' in entry || 'plan' in entry || 'images' in entry), false)
  assert.deepEqual(index.map(entry => entry.position), works.map(entry => entry.position))
  assert.equal(store.writes.at(-1), HISTORY_KEY)
  const restored = await createWorkStorage(store.storage).load()
  assert.equal(restored.length, 24)
  assert.equal(restored[23].pose, works[23].pose)
  assert.deepEqual(restored[23].plan, works[23].plan)
  assert.deepEqual(restored[23].quality, works[23].quality)
  assert.equal(restored[23].reviewKey, works[23].reviewKey)
  assert.equal(restored[23].status, 'skipped')
})

test('oversized work fails preflight before any detail or index is written', async () => {
  const previous = [work('old')]
  const store = memory({ [HISTORY_KEY]: previous })
  await assert.rejects(createWorkStorage(store.storage).save([
    work('first'), { ...work('too-large'), pose: '字'.repeat(61000) },
  ]), /超过 180 KB/)
  assert.deepEqual(store.writes, [])
  assert.deepEqual(store.values.get(HISTORY_KEY), previous)
})

test('detail write failure leaves the previous index intact and does not start cleanup', async () => {
  const previous = [work('old')]
  const store = memory({ [HISTORY_KEY]: previous })
  store.failWrite = 'design:work:second'
  const repository = createWorkStorage(store.storage)
  await assert.rejects(repository.save([work('first'), work('second')]), /write unavailable/)
  assert.deepEqual(store.values.get(HISTORY_KEY), previous)
  assert.equal(store.writes.includes(HISTORY_KEY), false)
  assert.deepEqual(store.deletes, [])
  store.failWrite = ''
  await repository.save([work('first'), work('second')])
  assert.equal((store.values.get(HISTORY_KEY) as unknown[]).length, 2)
  assert.equal(store.writes.filter(key => key === 'design:work:first').length, 1)
})

test('index commit failure propagates without deleting the previous documents', async () => {
  const store = memory()
  const repository = createWorkStorage(store.storage)
  await repository.save([{ ...work('old'), reviewKey: 'design:review:old' }])
  const before = structuredClone(store.values.get(HISTORY_KEY))
  store.failWrite = HISTORY_KEY
  await assert.rejects(repository.save([work('new')]), /write unavailable/)
  assert.deepEqual(store.values.get(HISTORY_KEY), before)
  assert.ok(store.values.has('design:work:old'))
  assert.deepEqual(store.deletes, [])
})

test('an instance skips unchanged detail documents but persists every status and task handle change', async () => {
  const store = memory()
  const repository = createWorkStorage(store.storage)
  const first = work('first')
  await repository.save([first])
  await repository.save([{ ...first }])
  assert.equal(store.writes.filter(key => key === 'design:work:first').length, 1)
  await repository.save([{ ...first, status: 'running', taskId: 'image_task_pending' }])
  assert.equal(store.writes.filter(key => key === 'design:work:first').length, 2)
  const restored = await repository.load()
  assert.equal(restored[0].status, 'paused')
  assert.equal(restored[0].taskId, 'image_task_pending')
})

test('account instances do not share cached documents or cleanup targets', async () => {
  const accountA = memory()
  const accountB = memory()
  const first = work('same-id')
  await createWorkStorage(accountA.storage).save([first])
  await createWorkStorage(accountB.storage).save([first])
  assert.ok(accountA.values.has('design:work:same-id'))
  assert.ok(accountB.values.has('design:work:same-id'))
  assert.deepEqual(accountB.writes, ['design:work:same-id', HISTORY_KEY])
  assert.deepEqual(accountB.deletes, [])
})

test('legacy history loads and migrates without dropping its review context or job recovery', async () => {
  const legacy = { ...work('legacy_01'), status: 'running', taskId: 'task_legacy', reviewKey: 'design:review:legacy_01' }
  const store = memory({ [HISTORY_KEY]: [legacy], 'design:review:legacy_01': { images: [] } })
  const repository = createWorkStorage(store.storage)
  const restored = await repository.load()
  assert.equal(restored[0].status, 'paused')
  await repository.save(restored)
  assert.ok(store.values.has('design:work:legacy_01'))
  assert.ok(store.values.has('design:review:legacy_01'))
  assert.equal((store.values.get(HISTORY_KEY) as Record<string, unknown>[])[0].detailKey, 'design:work:legacy_01')
  assert.deepEqual(store.deletes, [])
})

test('image binary is omitted while base64-only completed work keeps its text, plan, quality and a clear warning', async () => {
  const store = memory()
  const repository = createWorkStorage(store.storage)
  const completed: Work = {
    ...work('completed'), status: 'completed', images: [{ url: 'data:image/png;base64,aGVsbG8=' }, { url: 'blob:old-document' }],
    text: '仍可恢复的商品文案', plan: { direction: '简洁', brief: '商品细节' },
    quality: { status: 'passed', summary: '检查完成', issues: [], checkedAt: '2026-09-08T00:01:00Z' },
  }
  await repository.save([completed, { ...completed, id: 'recoverable', taskId: 'image_task_done' }])
  const serialized = JSON.stringify([...store.values])
  assert.doesNotMatch(serialized, /data:image|blob:old-document/)
  const loaded = await repository.load()
  assert.equal(loaded.length, 2)
  assert.equal(loaded[0].text, completed.text)
  assert.deepEqual(loaded[0].plan, completed.plan)
  assert.deepEqual(loaded[0].quality, completed.quality)
  assert.match(loaded[0].error || '', /刷新后无法恢复/)
  assert.equal(loaded[1].status, 'paused')
  assert.equal(loaded[1].taskId, 'image_task_done')
})

test('missing or mismatched indexed documents are explicit load errors, never silently incomplete history', async () => {
  const missing = memory({ [HISTORY_KEY]: [{ id: 'one', detailKey: 'design:work:one' }] })
  await assert.rejects(createWorkStorage(missing.storage).load(), /详情缺失.*重新连接账户/)
  const wrong = memory({ [HISTORY_KEY]: [{ id: 'one', detailKey: 'design:work:one' }], 'design:work:one': work('two') })
  await assert.rejects(createWorkStorage(wrong.storage).load(), /编号不一致/)
  const unsafe = memory({ [HISTORY_KEY]: [{ id: 'one', detailKey: 'some-other-key' }] })
  await assert.rejects(createWorkStorage(unsafe.storage).load(), /详情地址无效/)
})

test('eviction removes old detail and legacy review keys after commit; cleanup failures do not fail saves and are retried', async () => {
  const legacy = { ...work('legacy'), reviewKey: 'design:review:legacy' }
  const store = memory({ [HISTORY_KEY]: [legacy], 'design:review:legacy': { images: [] } })
  const repository = createWorkStorage(store.storage)
  await repository.save([{ ...work('old'), reviewKey: 'design:review:old' }])
  assert.ok(store.deletes.includes('design:review:legacy'))
  store.failDelete = 'design:work:old'
  await repository.save([work('new')])
  assert.equal((store.values.get(HISTORY_KEY) as Record<string, unknown>[])[0].id, 'new')
  assert.ok(store.deletes.includes('design:work:old'))
  assert.ok(store.deletes.includes('design:review:old'))
  store.failDelete = ''
  await repository.save([work('new')])
  assert.equal(store.deletes.filter(key => key === 'design:work:old').length, 2)
  assert.equal(store.values.has('design:work:old'), false)
})

test('shared retained review material is not deleted, and an unrelated legacy key is never removed', async () => {
  const store = memory({ [HISTORY_KEY]: [{ ...work('legacy'), reviewKey: HISTORY_KEY }] })
  const repository = createWorkStorage(store.storage)
  await repository.save([
    { ...work('one'), reviewKey: 'design:review:shared' },
    { ...work('two'), reviewKey: 'design:review:shared' },
  ])
  await repository.save([{ ...work('two'), reviewKey: 'design:review:shared' }])
  assert.equal(store.deletes.includes(HISTORY_KEY), false)
  assert.equal(store.deletes.includes('design:review:shared'), false)
  assert.equal(store.deletes.includes('design:work:one'), true)
})

test('the explicit 40-work retention cap retains every newest-batch row and rejects unsafe or duplicate identifiers', async () => {
  const store = memory()
  const repository = createWorkStorage(store.storage)
  await repository.save(Array.from({ length: 45 }, (_, index) => work(`job-${index}`)))
  assert.equal((store.values.get(HISTORY_KEY) as unknown[]).length, 40)
  assert.equal(store.values.has('design:work:job-39'), true)
  assert.equal(store.values.has('design:work:job-40'), false)
  await assert.rejects(repository.save([work('../unsafe')]), /作品编号无效/)
  await assert.rejects(repository.save([work('same'), work('same')]), /作品编号重复/)
})
