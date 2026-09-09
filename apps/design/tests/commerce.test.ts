import assert from 'node:assert/strict'
import test from 'node:test'
import { referenceInstructions, referenceLayout, runCommerceJobs } from '../src/commerce.ts'
import { TerminalTaskError, type Api, type Work } from '../src/core.ts'

type RequestOptions = Parameters<Api['request']>[1]

function apiWith(respond: (path: string, init?: RequestOptions) => unknown): Api {
  return { request: async <T>(path: string, init?: RequestOptions) => await respond(path, init) as T }
}

function work(id: string): Work {
  return {
    id, batch: 'batch-1', kind: 'product', title: id, scene: '商品套图', pose: '商品细节',
    ratio: '1:1', model: 'image-model', createdAt: '2026-09-08T00:00:00Z', status: 'queued', images: [],
  }
}

function recorder(works: Work[]) {
  const states = new Map(works.map(item => [item.id, { ...item }]))
  const updates: { id: string; patch: Partial<Work> }[] = []
  return {
    states, updates,
    onUpdate: (id: string, patch: Partial<Work>) => {
      updates.push({ id, patch })
      states.set(id, { ...states.get(id)!, ...patch })
    },
  }
}

test('reference layout keeps product identity separate from a style board within the model limit', () => {
  assert.deepEqual(referenceLayout(6, 0, 6), { productSheet: false, referenceSheet: false })
  assert.deepEqual(referenceLayout(6, 0, 1), { productSheet: true, referenceSheet: false })
  assert.deepEqual(referenceLayout(6, 1, 6), { productSheet: true, referenceSheet: false })
  assert.deepEqual(referenceLayout(1, 4, 2), { productSheet: false, referenceSheet: true })
  assert.deepEqual(referenceLayout(6, 4, 2), { productSheet: true, referenceSheet: true })
  assert.deepEqual(referenceLayout(0, 4, 1), { productSheet: false, referenceSheet: true })
  assert.throws(() => referenceLayout(1, 1, 1), /至少支持两张/)
  for (const maximum of [0, -1, 1.5, NaN]) assert.throws(() => referenceLayout(1, 0, maximum), /未声明/)
})

test('reference instructions identify ordered inputs and suppress reference-board artifacts', () => {
  const products = referenceInstructions(3, 0, false)
  assert.match(products, /全部输入图片.*3张原始外观参考/)
  assert.doesNotMatch(products, /图1为排版|图2起|已合并/)

  const mixed = referenceInstructions(6, 4, true)
  assert.match(mixed, /图1为排版与视觉风格参考/)
  assert.match(mixed, /4张视觉参考.*STYLE 编号/)
  assert.match(mixed, /图2起.*6张原始外观参考.*PRODUCT 编号/)
  assert.match(mixed, /不把参考板的拼贴布局、分隔或编号输出/)
  assert.match(mixed, /不编造销量、奖项或性能数值/)

  const referenceOnly = referenceInstructions(0, 1, false)
  assert.match(referenceOnly, /图1为排版/)
  assert.doesNotMatch(referenceOnly, /图2起|原始外观参考|PRODUCT/)
})

test('commerce jobs submit sequentially with a distinct stable idempotency key and prepared body', async () => {
  const works = [work('job-1'), work('job-2')]
  const tracker = recorder(works)
  const events: string[] = []
  const api = apiWith((path, init) => {
    assert.equal(path, '/images/edits')
    assert.equal(init?.method, 'POST')
    const body = init?.body as FormData
    const index = Number(body.get('index'))
    assert.equal(new Headers(init?.headers).get('Idempotency-Key'), works[index].id)
    events.push(`post-${index}`)
    return { data: [{ url: `https://cdn.example/${index}.png` }] }
  })
  await runCommerceJobs({
    api, works, signal: new AbortController().signal,
    prepare: async index => {
      if (index) assert.equal(tracker.states.get(works[index - 1].id)?.status, 'completed')
      events.push(`prepare-${index}`)
      const body = new FormData(); body.append('index', String(index)); return body
    },
    onProgress: index => events.push(`progress-${index}`),
    onUpdate: tracker.onUpdate,
  })
  assert.deepEqual(events, ['progress-0', 'prepare-0', 'post-0', 'progress-1', 'prepare-1', 'post-1'])
  assert.deepEqual([...tracker.states.values()].map(item => item.status), ['completed', 'completed'])
  assert.equal(tracker.states.get('job-2')?.images[0].url, 'https://cdn.example/1.png')
})

test('an already stopped batch never prepares or submits jobs', async () => {
  const works = [work('job-1')]
  const tracker = recorder(works)
  const controller = new AbortController(); controller.abort()
  await runCommerceJobs({
    api: apiWith(() => assert.fail('must not submit')),
    works, signal: controller.signal, onUpdate: tracker.onUpdate,
    prepare: async () => { assert.fail('must not prepare'); return new FormData() },
  })
  assert.deepEqual(tracker.updates, [])
})

test('stopping during image preparation skips the unsubmitted job and leaves later jobs to the owner', async () => {
  const works = [work('job-1'), work('job-2')]
  const tracker = recorder(works)
  const controller = new AbortController()
  await assert.rejects(runCommerceJobs({
    api: apiWith(() => assert.fail('must not submit')),
    works, signal: controller.signal, onUpdate: tracker.onUpdate,
    prepare: async () => { controller.abort(); return new FormData() },
  }), { name: 'AbortError' })
  assert.equal(tracker.states.get('job-1')?.status, 'skipped')
  assert.equal(tracker.states.get('job-2')?.status, 'queued')
})

test('a failed preparation stops the batch before any image request', async () => {
  const works = [work('job-1'), work('job-2')]
  const tracker = recorder(works)
  let prepared = 0
  await assert.rejects(runCommerceJobs({
    api: apiWith(() => assert.fail('must not submit')),
    works, signal: new AbortController().signal, onUpdate: tracker.onUpdate,
    prepare: async () => { prepared++; throw new Error('图片加载失败') },
  }), /图片加载失败/)
  assert.equal(prepared, 1)
  assert.equal(tracker.states.get('job-1')?.status, 'failed')
  assert.equal(tracker.states.get('job-2')?.status, 'queued')
})

test('stopping an accepted POST preserves its task handle for polling without submitting the next job', async () => {
  const works = [work('job-1'), work('job-2')]
  const tracker = recorder(works)
  const controller = new AbortController()
  let calls = 0
  await assert.rejects(runCommerceJobs({
    api: apiWith((_path, init) => {
      calls++; assert.equal(init?.signal, undefined)
      controller.abort()
      throw { details: { task_id: 'image_task_waiting' } }
    }),
    works, signal: controller.signal, onUpdate: tracker.onUpdate,
    prepare: async () => new FormData(),
  }), { name: 'AbortError' })
  assert.equal(calls, 1)
  assert.equal(tracker.states.get('job-1')?.taskId, 'image_task_waiting')
  assert.equal(tracker.states.get('job-1')?.status, 'paused')
  assert.equal(tracker.states.get('job-2')?.status, 'queued')
})

test('a completed submitted image survives stop while subsequent jobs remain unsubmitted', async () => {
  const works = [work('job-1'), work('job-2')]
  const tracker = recorder(works)
  const controller = new AbortController()
  let calls = 0
  await runCommerceJobs({
    api: apiWith(() => { calls++; controller.abort(); return { data: [{ url: 'https://cdn.example/finished.png' }] } }),
    works, signal: controller.signal, onUpdate: tracker.onUpdate,
    prepare: async () => new FormData(),
    onCompleted: async () => assert.fail('must not begin quality review after stopping'),
  })
  assert.equal(calls, 1)
  assert.equal(tracker.states.get('job-1')?.status, 'completed')
  assert.equal(tracker.states.get('job-1')?.images.length, 1)
  assert.equal(tracker.states.get('job-2')?.status, 'queued')
})

test('a terminal task failure is failed, whereas a polling connection error remains resumable', async () => {
  for (const terminal of [true, false]) {
    const works = [work('job-1'), work('job-2')]
    const tracker = recorder(works)
    const paths: string[] = []
    await assert.rejects(runCommerceJobs({
      api: apiWith((path, init) => {
        paths.push(path)
        if (init?.method === 'POST') return { task_id: 'image_task_1', status: 'in_progress' }
        if (terminal) return { status: 'failed', error: { message: 'reference rejected' } }
        throw new Error('polling disconnected')
      }),
      works, signal: new AbortController().signal, onUpdate: tracker.onUpdate,
      prepare: async () => new FormData(),
    }), error => terminal ? error instanceof TerminalTaskError : error instanceof Error && error.message === 'polling disconnected')
    assert.deepEqual(paths, ['/images/edits', '/images/tasks/image_task_1'])
    assert.equal(tracker.states.get('job-1')?.taskId, 'image_task_1')
    assert.equal(tracker.states.get('job-1')?.status, terminal ? 'failed' : 'paused')
    assert.equal(tracker.states.get('job-2')?.status, 'queued')
  }
})

test('an uncertain submission is not automatically repeated or followed by another billed job', async () => {
  const works = [work('job-1'), work('job-2')]
  const tracker = recorder(works)
  let calls = 0
  await assert.rejects(runCommerceJobs({
    api: apiWith(() => { calls++; throw new Error('network disconnected') }),
    works, signal: new AbortController().signal, onUpdate: tracker.onUpdate,
    prepare: async () => new FormData(),
  }), /network disconnected/)
  assert.equal(calls, 1)
  assert.equal(tracker.states.get('job-1')?.status, 'failed')
  assert.equal(tracker.states.get('job-1')?.taskId, undefined)
  assert.equal(tracker.states.get('job-2')?.status, 'queued')
})

test('a failed quality hook preserves completed images and task IDs while later generation continues once', async () => {
  for (const reviewError of [new Error('review service unavailable'), new TerminalTaskError('review task rejected')]) {
    const works = [work('job-1'), work('job-2')]
    const tracker = recorder(works)
    const requests: string[] = []
    const reviews: string[] = []
    await runCommerceJobs({
      api: apiWith((_path, init) => {
        const id = new Headers(init?.headers).get('Idempotency-Key')!
        requests.push(id)
        return { task_id: `image_task_${id}`, data: [{ url: `https://cdn.example/${id}.png` }] }
      }),
      works, signal: new AbortController().signal, onUpdate: tracker.onUpdate,
      prepare: async () => new FormData(),
      onCompleted: async (item, images, index) => {
        assert.equal(tracker.states.get(item.id)?.status, 'completed')
        assert.deepEqual(tracker.states.get(item.id)?.images, images)
        assert.equal(item.id, works[index].id)
        reviews.push(item.id)
        if (!index) throw reviewError
      },
    })
    assert.deepEqual(requests, ['job-1', 'job-2'])
    assert.deepEqual(reviews, ['job-1', 'job-2'])
    const first = tracker.states.get('job-1')!
    assert.equal(first.status, 'completed')
    assert.deepEqual(first.images, [{ url: 'https://cdn.example/job-1.png' }])
    assert.equal(first.taskId, 'image_task_job-1')
    assert.equal(first.error, undefined)
    assert.equal(first.quality?.status, 'unavailable')
    assert.equal(first.quality?.summary, reviewError.message)
    assert.ok(Number.isFinite(Date.parse(first.quality!.checkedAt)))
    assert.deepEqual(tracker.updates.find(update => update.patch.quality)?.patch, { quality: first.quality })
    assert.equal(tracker.states.get('job-2')?.status, 'completed')
  }
})

test('stopping during quality review retains the generated image and prevents later submissions', async () => {
  const works = [work('job-1'), work('job-2')]
  const tracker = recorder(works)
  const controller = new AbortController()
  let calls = 0
  await runCommerceJobs({
    api: apiWith(() => { calls++; return { data: [{ url: 'https://cdn.example/completed.png' }] } }),
    works, signal: controller.signal, onUpdate: tracker.onUpdate,
    prepare: async () => new FormData(),
    onCompleted: async () => { controller.abort(); throw new DOMException('review stopped', 'AbortError') },
  })
  assert.equal(calls, 1)
  assert.equal(tracker.states.get('job-1')?.status, 'completed')
  assert.equal(tracker.states.get('job-1')?.images.length, 1)
  assert.equal(tracker.states.get('job-1')?.quality?.status, 'unavailable')
  assert.match(tracker.states.get('job-1')?.quality?.summary || '', /已停止质量检查/)
  assert.equal(tracker.states.get('job-2')?.status, 'queued')
})

test('generation failure never invokes the quality hook', async () => {
  const works = [work('job-1')]
  const tracker = recorder(works)
  await assert.rejects(runCommerceJobs({
    api: apiWith(() => { throw new Error('generation rejected') }),
    works, signal: new AbortController().signal, onUpdate: tracker.onUpdate,
    prepare: async () => new FormData(),
    onCompleted: async () => assert.fail('there is no image to review'),
  }), /generation rejected/)
  assert.equal(tracker.states.get('job-1')?.status, 'failed')
  assert.equal(tracker.states.get('job-1')?.quality, undefined)
})
