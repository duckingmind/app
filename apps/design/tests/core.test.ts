import assert from 'node:assert/strict'
import test from 'node:test'
import { buildTryOnPrompt, historyForStorage, PendingTaskError, pollImage, restoreHistory, sizeForRatio, submitImage, TerminalTaskError, type Api, type ImageModel, type Work } from '../src/core.ts'

type RequestOptions = Parameters<Api['request']>[1]

function apiWith(respond: (path: string, init?: RequestOptions) => unknown): Api {
  return { request: async <T>(path: string, init?: RequestOptions) => await respond(path, init) as T }
}

test('accepted 504 transitions to polling without a second POST', async () => {
  const requests: string[] = []
  const tracked: string[] = []
  const api = apiWith((path, init) => {
    requests.push(`${init?.method || 'GET'} ${path}`)
    if (init?.method === 'POST') throw { details: { task_id: 'image_task_1', polling_url: 'https://untrusted.invalid/task' } }
    return { status: 'completed', data: [{ url: 'https://cdn.example/result.png' }] }
  })
  assert.equal((await submitImage(api, '/images/edits', new FormData(), { onTask: id => tracked.push(id), interval: 0 }))[0].url, 'https://cdn.example/result.png')
  assert.deepEqual(requests, ['POST /images/edits', 'GET /images/tasks/image_task_1'])
  assert.deepEqual(tracked, ['image_task_1'])
})

test('synchronous images and base64 are accepted without polling', async () => {
  let calls = 0
  const result = await submitImage(apiWith(() => { calls++; return { data: [{ b64_json: 'aGVsbG8=' }] } }), '/images/generations', '{}')
  assert.equal(result[0].url, 'data:image/png;base64,aGVsbG8=')
  assert.equal(calls, 1)
})

test('network failure is never automatically resubmitted', async () => {
  let calls = 0
  await assert.rejects(submitImage(apiWith(() => { calls++; throw new Error('network error') }), '/images/edits', new FormData()), /network/)
  assert.equal(calls, 1)
})

test('stopping before submission makes no request', async () => {
  const controller = new AbortController()
  controller.abort()
  let calls = 0
  await assert.rejects(submitImage(apiWith(() => { calls++ }), '/images/edits', new FormData(), { signal: controller.signal }), { name: 'AbortError' })
  assert.equal(calls, 0)
})

for (const acceptedAsError of [false, true]) {
  test(`stopping a submitted request preserves the ${acceptedAsError ? '504' : 'successful'} task handle before ending the wait`, async () => {
    const controller = new AbortController()
    const requests: string[] = []
    const tracked: string[] = []
    let finishSubmission!: () => void
    const submission = new Promise<void>(resolve => { finishSubmission = resolve })
    const api = apiWith(async (path, init) => {
      requests.push(`${init?.method || 'GET'} ${path}`)
      assert.equal(init?.signal, undefined)
      assert.equal(new Headers(init?.headers).get('Idempotency-Key'), 'work-123')
      await submission
      if (acceptedAsError) throw { details: { task_id: 'image_task_stopped' } }
      return { task_id: 'image_task_stopped', status: 'in_progress' }
    })
    const result = submitImage(api, '/images/edits', new FormData(), {
      signal: controller.signal,
      idempotencyKey: 'work-123',
      onTask: id => tracked.push(id),
    })
    controller.abort()
    assert.deepEqual(tracked, [])
    finishSubmission()
    await assert.rejects(result, { name: 'AbortError' })
    assert.deepEqual(tracked, ['image_task_stopped'])
    assert.deepEqual(requests, ['POST /images/edits'])
  })
}

test('stopping a submitted request retains an already completed image', async () => {
  const controller = new AbortController()
  const api = apiWith(() => {
    controller.abort()
    return { data: [{ url: 'https://cdn.example/completed.png' }] }
  })
  assert.deepEqual(await submitImage(api, '/images/generations', '{}', { signal: controller.signal }), [{ url: 'https://cdn.example/completed.png' }])
})

test('poll exhaustion preserves the task identifier for recovery', async () => {
  await assert.rejects(pollImage(apiWith(() => ({ status: 'in_progress' })), 'image_task_2', { interval: 0, attempts: 2 }), (e: unknown) => e instanceof PendingTaskError && e.taskId === 'image_task_2')
})

test('polling handles terminal failure, cancellation and invalid task IDs', async () => {
  for (const status of ['failed', 'cancelled', 'expired', 'refunded']) {
    await assert.rejects(pollImage(apiWith(() => ({ status, error: { message: 'quota exhausted' } })), 'image_task_3'), (error: unknown) => error instanceof TerminalTaskError && error.message === 'quota exhausted')
  }
  await assert.rejects(pollImage(apiWith(() => { throw new Error('must not call') }), '../../admin'), /编号无效/)
  const controller = new AbortController(); controller.abort()
  await assert.rejects(pollImage(apiWith(() => { throw new Error('must not call') }), 'image_task_3', { signal: controller.signal }), { name: 'AbortError' })
})

test('terminal submission failures preserve the handle without polling', async () => {
  for (const status of ['failed', 'cancelled']) {
    let calls = 0
    const tracked: string[] = []
    const api = apiWith(() => {
      calls++
      return { task_id: 'image_task_failed', status, error: { message: 'reference rejected' } }
    })
    await assert.rejects(submitImage(api, '/images/edits', new FormData(), { onTask: id => tracked.push(id) }), (error: unknown) => error instanceof TerminalTaskError && error.message === 'reference rejected')
    assert.deepEqual(tracked, ['image_task_failed'])
    assert.equal(calls, 1)
  }
})

const model: ImageModel = { id: 'image-model', supported_aspect_ratios: ['1:1', '2:3', '9:16'], size_mode: 'both', supported_sizes: ['1024x1024', '1024x1536'], size_constraints: { min_width: 16, max_width: 3840, min_height: 16, max_height: 3840, multiple_of: 16, min_pixels: 655360, max_pixels: 8294400, max_aspect_ratio: 3 } }
test('model advertised ratios take priority over possible variable sizes', () => {
  assert.equal(sizeForRatio(model, '3:4'), null)
  assert.equal(sizeForRatio(model, '2:3'), '1024x1536')
  const [w, h] = sizeForRatio(model, '9:16')!.split('x').map(Number)
  assert.equal(w / h, 9 / 16)
  assert.equal(w % 16, 0)
  assert.equal(h % 16, 0)
  assert.ok(w * h >= 655360)
})

test('recovered history does not restore blob URLs or retry queued submissions', () => {
  const work: Work = { id: 'w1', batch: 'b1', kind: 'tryon', title: '正面', scene: '影棚', pose: '站姿', ratio: '3:4', model: 'm', status: 'running', taskId: 'image_task_1', createdAt: new Date().toISOString(), images: [{ url: 'blob:old-document' }] }
  const restored = restoreHistory([work, { ...work, id: 'w2', taskId: undefined, status: 'queued' }])
  assert.equal(restored[0].status, 'paused')
  assert.equal(restored[1].status, 'skipped')
  assert.deepEqual(restored[0].images, [])
  assert.deepEqual(historyForStorage([{ ...work, status: 'completed', taskId: undefined, images: [{ url: 'data:image/png;base64,aGVsbG8=' }] }]), [])
})

test('clothing references are distinguished from model identity in editing prompt', () => {
  const prompt = buildTryOnPrompt('草坪', '自然行走', '保留刺绣', 6, true)
  assert.match(prompt, /图1是模特身份参考/)
  assert.match(prompt, /6张服饰参考图/)
  assert.match(prompt, /保留刺绣/)
  assert.match(prompt, /不输出拼贴/)
})

test('completed base64 results can be queried by task ID after refreshing', () => {
  const work: Work = { id: 'detail1', batch: 'batch1', kind: 'detail', title: '详情首屏', scene: '详情页', pose: '首屏', ratio: '3:4', model: 'm', status: 'completed', taskId: 'image_task_completed', createdAt: '2026-09-08T08:00:00Z', images: [{ url: 'data:image/png;base64,aGVsbG8=' }], batchSize: 6, position: 0 }
  const [restored] = restoreHistory(historyForStorage([work]))
  assert.equal(restored.status, 'paused')
  assert.equal(restored.taskId, work.taskId)
  assert.deepEqual(restored.images, [])
  assert.equal(restored.batchSize, 6)
  assert.equal(restored.position, 0)
  assert.equal(restoreHistory([{ ...work, images: [{ url: 'https://cdn.example/result.png' }] }])[0].status, 'completed')
  assert.equal(restoreHistory([{ ...work, status: 'failed', images: [] }])[0].status, 'failed')
})

test('commerce history retains listing copy and original batch order without persisting image binaries', () => {
  const work: Work = { id: 'product1', batch: 'batch1', kind: 'product', title: '主图', scene: '商品套图', pose: '白底', ratio: '1:1', model: 'm', status: 'completed', createdAt: '2026-09-08T08:00:00Z', images: [{ url: 'data:image/png;base64,aGVsbG8=' }], text: 'Product title\nVerified features', batchSize: 7, position: 0 }
  const restored = restoreHistory(historyForStorage([work]))
  assert.equal(restored.length, 1)
  assert.equal(restored[0].text, work.text)
  assert.equal(restored[0].batchSize, 7)
  assert.equal(restored[0].position, 0)
  assert.deepEqual(restored[0].images, [])
})
