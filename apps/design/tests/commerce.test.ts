import assert from 'node:assert/strict'
import test from 'node:test'
import { referenceInstructions, referenceLayout, runCommerceJobs, type ImageJobActivity } from '../src/commerce.ts'
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

test('commerce jobs support a serial limit with a distinct stable idempotency key and prepared body', async () => {
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
    concurrency: 1,
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
    concurrency: 1,
    api: apiWith(() => assert.fail('must not submit')),
    works, signal: controller.signal, onUpdate: tracker.onUpdate,
    prepare: async () => { assert.fail('must not prepare'); return new FormData() },
  })
  assert.equal(tracker.states.get('job-1')?.status, 'skipped')
})

test('stopping during image preparation skips the unsubmitted job and all remaining jobs', async () => {
  const works = [work('job-1'), work('job-2')]
  const tracker = recorder(works)
  const controller = new AbortController()
  await assert.rejects(runCommerceJobs({
    concurrency: 1,
    api: apiWith(() => assert.fail('must not submit')),
    works, signal: controller.signal, onUpdate: tracker.onUpdate,
    prepare: async () => { controller.abort(); return new FormData() },
  }), { name: 'AbortError' })
  assert.equal(tracker.states.get('job-1')?.status, 'skipped')
  assert.equal(tracker.states.get('job-2')?.status, 'skipped')
})

test('a failed preparation stops the batch before any image request', async () => {
  const works = [work('job-1'), work('job-2')]
  const tracker = recorder(works)
  let prepared = 0
  await assert.rejects(runCommerceJobs({
    concurrency: 1,
    api: apiWith(() => assert.fail('must not submit')),
    works, signal: new AbortController().signal, onUpdate: tracker.onUpdate,
    prepare: async () => { prepared++; throw new Error('图片加载失败') },
  }), /图片加载失败/)
  assert.equal(prepared, 1)
  assert.equal(tracker.states.get('job-1')?.status, 'failed')
  assert.equal(tracker.states.get('job-2')?.status, 'skipped')
})

test('stopping an accepted POST preserves its task handle for polling without submitting the next job', async () => {
  const works = [work('job-1'), work('job-2')]
  const tracker = recorder(works)
  const controller = new AbortController()
  let calls = 0
  await assert.rejects(runCommerceJobs({
    concurrency: 1,
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
  assert.equal(tracker.states.get('job-2')?.status, 'skipped')
})

test('a completed submitted image survives stop while subsequent jobs remain unsubmitted', async () => {
  const works = [work('job-1'), work('job-2')]
  const tracker = recorder(works)
  const controller = new AbortController()
  let calls = 0
  await runCommerceJobs({
    concurrency: 1,
    api: apiWith(() => { calls++; controller.abort(); return { data: [{ url: 'https://cdn.example/finished.png' }] } }),
    works, signal: controller.signal, onUpdate: tracker.onUpdate,
    prepare: async () => new FormData(),
    onCompleted: async () => assert.fail('must not begin quality review after stopping'),
  })
  assert.equal(calls, 1)
  assert.equal(tracker.states.get('job-1')?.status, 'completed')
  assert.equal(tracker.states.get('job-1')?.images.length, 1)
  assert.equal(tracker.states.get('job-2')?.status, 'skipped')
})

test('a terminal task failure is failed, whereas a polling connection error remains resumable', async () => {
  for (const terminal of [true, false]) {
    const works = [work('job-1'), work('job-2')]
    const tracker = recorder(works)
    const paths: string[] = []
    await assert.rejects(runCommerceJobs({
    concurrency: 1,
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
    assert.equal(tracker.states.get('job-2')?.status, 'skipped')
  }
})

test('an uncertain submission is not automatically repeated or followed by another billed job', async () => {
  const works = [work('job-1'), work('job-2')]
  const tracker = recorder(works)
  let calls = 0
  await assert.rejects(runCommerceJobs({
    concurrency: 1,
    api: apiWith(() => { calls++; throw new Error('network disconnected') }),
    works, signal: new AbortController().signal, onUpdate: tracker.onUpdate,
    prepare: async () => new FormData(),
  }), /network disconnected/)
  assert.equal(calls, 1)
  assert.equal(tracker.states.get('job-1')?.status, 'failed')
  assert.equal(tracker.states.get('job-1')?.taskId, undefined)
  assert.equal(tracker.states.get('job-2')?.status, 'skipped')
})

test('a failed quality hook preserves completed images and task IDs while later generation continues once', async () => {
  for (const reviewError of [new Error('review service unavailable'), new TerminalTaskError('review task rejected')]) {
    const works = [work('job-1'), work('job-2')]
    const tracker = recorder(works)
    const requests: string[] = []
    const reviews: string[] = []
    await runCommerceJobs({
    concurrency: 1,
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

test('stopping during quality review retains generated images and prevents subsequent POSTs', async () => {
  const works = [work('job-1'), work('job-2')]
  const tracker = recorder(works)
  const controller = new AbortController()
  let calls = 0
  await assert.rejects(runCommerceJobs({
    concurrency: 1,
    api: apiWith(() => { calls++; return { data: [{ url: 'https://cdn.example/completed.png' }] } }),
    works, signal: controller.signal, onUpdate: tracker.onUpdate,
    prepare: async () => new FormData(),
    onCompleted: async () => { controller.abort(); throw new DOMException('review stopped', 'AbortError') },
  }), { name: 'AbortError' })
  assert.equal(calls, 1)
  assert.equal(tracker.states.get('job-1')?.status, 'completed')
  assert.equal(tracker.states.get('job-1')?.images.length, 1)
  assert.equal(tracker.states.get('job-1')?.quality?.status, 'unavailable')
  assert.match(tracker.states.get('job-1')?.quality?.summary || '', /已停止质量检查/)
  assert.equal(tracker.states.get('job-2')?.status, 'skipped')
})

test('generation failure never invokes the quality hook', async () => {
  const works = [work('job-1')]
  const tracker = recorder(works)
  await assert.rejects(runCommerceJobs({
    concurrency: 1,
    api: apiWith(() => { throw new Error('generation rejected') }),
    works, signal: new AbortController().signal, onUpdate: tracker.onUpdate,
    prepare: async () => new FormData(),
    onCompleted: async () => assert.fail('there is no image to review'),
  }), /generation rejected/)
  assert.equal(tracker.states.get('job-1')?.status, 'failed')
  assert.equal(tracker.states.get('job-1')?.quality, undefined)
})

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

const tick = () => new Promise<void>(resolve => setImmediate(resolve))
const completedImage = (id: string) => ({ data: [{ url: `https://cdn.example/${id}.png` }] })

test('default image pool dispatches three concurrent requests and reuses only finished slots', async () => {
  const works = Array.from({ length: 6 }, (_, index) => work(`job-${index}`))
  const tracker = recorder(works)
  const requests: string[] = []
  const gates = works.map(() => deferred<ReturnType<typeof completedImage>>())
  const activity: ImageJobActivity[] = []
  let running = 0
  let maximum = 0
  const run = runCommerceJobs({
    api: apiWith(async (path, init) => {
      const id = new Headers(init?.headers).get('Idempotency-Key')!
      const index = works.findIndex(item => item.id === id)
      assert.equal(path, '/images/generations')
      assert.equal(init?.body, JSON.stringify({ index, response_format: 'url' }))
      requests.push(id)
      maximum = Math.max(maximum, ++running)
      try { return await gates[index].promise } finally { running-- }
    }),
    works, path: '/images/generations', signal: new AbortController().signal,
    prepare: async index => JSON.stringify({ index }),
    onUpdate: tracker.onUpdate, onActivity: state => activity.push(state),
  })
  await tick()
  assert.deepEqual(requests, ['job-0', 'job-1', 'job-2'])
  assert.equal(activity.at(-1)?.running, 3)
  gates[1].resolve(completedImage('job-1'))
  await tick()
  assert.deepEqual(requests, ['job-0', 'job-1', 'job-2', 'job-3'])
  assert.equal(tracker.states.get('job-1')?.status, 'completed')
  assert.equal(tracker.states.get('job-0')?.status, 'running')
  for (let index = 0; index < gates.length; index++) gates[index].resolve(completedImage(works[index].id))
  await run
  assert.equal(maximum, 3)
  assert.equal(new Set(requests).size, works.length)
  assert.equal(activity.at(-1)?.completed, works.length)
  assert.equal(activity.at(-1)?.running, 0)
  for (const snapshot of activity) {
    assert.ok(snapshot.running <= 3)
    assert.equal(snapshot.queued + snapshot.running + snapshot.completed + snapshot.failed + snapshot.paused + snapshot.skipped, snapshot.total)
  }
})

test('slow checks do not block image generation and have a separate concurrency limit of two', async () => {
  const works = Array.from({ length: 5 }, (_, index) => work(`job-${index}`))
  const tracker = recorder(works)
  const gates = works.map(() => deferred<void>())
  const requests: string[] = []
  const reviews: string[] = []
  const activity: ImageJobActivity[] = []
  let finished = false
  let reviewing = 0
  let maxReviewing = 0
  const run = runCommerceJobs({
    api: apiWith((_path, init) => {
      const id = new Headers(init?.headers).get('Idempotency-Key')!
      requests.push(id)
      return completedImage(id)
    }),
    works, signal: new AbortController().signal,
    prepare: async () => new FormData(),
    onUpdate: tracker.onUpdate, onActivity: state => activity.push(state),
    onCompleted: async (item, _images, index) => {
      reviews.push(item.id)
      maxReviewing = Math.max(maxReviewing, ++reviewing)
      try { await gates[index].promise } finally { reviewing-- }
    },
  }).then(() => { finished = true })
  await tick()
  assert.equal(requests.length, 5, 'all images must dispatch while the first two checks are pending')
  assert.deepEqual(reviews, ['job-0', 'job-1'])
  assert.ok([...tracker.states.values()].every(item => item.status === 'completed'))
  assert.equal(activity.at(-1)?.reviewing, 2)
  assert.equal(activity.at(-1)?.reviewQueued, 3)
  assert.equal(finished, false, 'the batch waits for its reviews to settle')
  gates[0].resolve()
  await tick()
  assert.deepEqual(reviews, ['job-0', 'job-1', 'job-2'])
  for (const gate of gates) gate.resolve()
  await run
  assert.equal(maxReviewing, 2)
  assert.equal(activity.at(-1)?.reviewing, 0)
  assert.equal(activity.at(-1)?.reviewQueued, 0)
  assert.equal(reviews.length, works.length)
})

test('stopping a concurrent batch starts no new jobs and waits for all submitted results', async () => {
  const works = Array.from({ length: 5 }, (_, index) => work(`job-${index}`))
  const tracker = recorder(works)
  const controller = new AbortController()
  const gates = works.map(() => deferred<ReturnType<typeof completedImage>>())
  const requests: string[] = []
  let finished = false
  const run = runCommerceJobs({
    api: apiWith(async (_path, init) => {
      const id = new Headers(init?.headers).get('Idempotency-Key')!
      const index = works.findIndex(item => item.id === id)
      requests.push(id)
      return gates[index].promise
    }),
    works, signal: controller.signal, prepare: async () => new FormData(),
    onUpdate: tracker.onUpdate,
    onCompleted: async () => assert.fail('stopped batches must not begin a new check'),
  }).then(() => { finished = true })
  await tick()
  assert.equal(requests.length, 3)
  controller.abort()
  assert.equal(finished, false)
  assert.equal(tracker.states.get('job-3')?.status, 'skipped')
  assert.equal(tracker.states.get('job-4')?.status, 'skipped')
  assert.equal(tracker.states.get('job-0')?.status, 'running')
  gates[1].resolve(completedImage('job-1'))
  await tick()
  assert.equal(requests.length, 3)
  assert.equal(finished, false)
  assert.equal(tracker.states.get('job-1')?.status, 'completed')
  gates[0].resolve(completedImage('job-0'))
  gates[2].resolve(completedImage('job-2'))
  await run
  assert.equal(requests.length, 3)
  for (let index = 0; index < 3; index++) {
    assert.equal(tracker.states.get(`job-${index}`)?.status, 'completed')
    assert.equal(tracker.states.get(`job-${index}`)?.images.length, 1)
  }
  assert.equal(tracker.states.get('job-3')?.status, 'skipped')
  assert.equal(tracker.states.get('job-4')?.status, 'skipped')
})

test('a generation failure stops new dispatches, waits for in-flight successes and their checks, and never retries', async () => {
  const works = Array.from({ length: 5 }, (_, index) => work(`job-${index}`))
  const tracker = recorder(works)
  const gates = works.map(() => deferred<ReturnType<typeof completedImage>>())
  const checks = [deferred<void>(), deferred<void>()]
  const failure = new Error('upstream generation failed')
  const requests: string[] = []
  let settled = false
  const run = runCommerceJobs({
    api: apiWith(async (_path, init) => {
      const id = new Headers(init?.headers).get('Idempotency-Key')!
      requests.push(id)
      return gates[works.findIndex(item => item.id === id)].promise
    }),
    works, signal: new AbortController().signal,
    prepare: async () => new FormData(), onUpdate: tracker.onUpdate,
    onCompleted: async (_item, _images, index) => checks[index - 1].promise,
  })
  const outcome = run.then(() => { settled = true; return undefined }, error => { settled = true; return error })
  await tick()
  gates[0].reject(failure)
  await tick()
  assert.equal(settled, false)
  assert.equal(tracker.states.get('job-3')?.status, 'skipped')
  assert.equal(tracker.states.get('job-4')?.status, 'skipped')
  assert.equal(tracker.states.get('job-1')?.status, 'running')
  assert.equal(requests.length, 3)
  gates[1].resolve(completedImage('job-1'))
  gates[2].resolve(completedImage('job-2'))
  await tick()
  assert.equal(settled, false, 'generation failure must also wait for successful images to be checked')
  assert.equal(tracker.states.get('job-1')?.status, 'completed')
  checks[0].reject(new Error('check unavailable'))
  checks[1].resolve()
  assert.equal(await outcome, failure)
  assert.deepEqual(requests, ['job-0', 'job-1', 'job-2'])
  assert.equal(tracker.states.get('job-0')?.status, 'failed')
  assert.equal(tracker.states.get('job-1')?.status, 'completed')
  assert.equal(tracker.states.get('job-1')?.quality?.status, 'unavailable')
  assert.equal(tracker.states.get('job-1')?.images.length, 1)
  assert.equal(tracker.states.get('job-2')?.status, 'completed')
  assert.equal(tracker.states.get('job-3')?.status, 'skipped')
})

test('a failed request prevents other prepared jobs from being submitted after the failure', async () => {
  const works = [work('job-0'), work('job-1'), work('job-2'), work('job-3')]
  const tracker = recorder(works)
  const preparations = [deferred<BodyInit>(), deferred<BodyInit>()]
  const calls: string[] = []
  const run = runCommerceJobs({
    api: apiWith((_path, init) => {
      calls.push(new Headers(init?.headers).get('Idempotency-Key')!)
      throw new Error('generation unavailable')
    }),
    works, signal: new AbortController().signal, onUpdate: tracker.onUpdate,
    prepare: async index => index === 0 ? new FormData() : preparations[index - 1].promise,
  })
  const outcome = run.catch(error => error)
  await tick()
  for (const preparation of preparations) preparation.resolve(new FormData())
  assert.match((await outcome).message, /generation unavailable/)
  assert.deepEqual(calls, ['job-0'])
  assert.equal(tracker.states.get('job-1')?.status, 'skipped')
  assert.equal(tracker.states.get('job-2')?.status, 'skipped')
  assert.equal(tracker.states.get('job-3')?.status, 'skipped')
})

test('stopping checks clears pending checks while awaiting active hooks without discarding images', async () => {
  const works = Array.from({ length: 5 }, (_, index) => work(`job-${index}`))
  const tracker = recorder(works)
  const controller = new AbortController()
  const checks = [deferred<void>(), deferred<void>()]
  const reviews: number[] = []
  const activity: ImageJobActivity[] = []
  let finished = false
  const run = runCommerceJobs({
    api: apiWith((_path, init) => completedImage(new Headers(init?.headers).get('Idempotency-Key')!)),
    works, signal: controller.signal,
    prepare: async () => new FormData(), onUpdate: tracker.onUpdate,
    onActivity: snapshot => activity.push(snapshot),
    onCompleted: async (_item, _images, index) => { reviews.push(index); await checks[index].promise },
  }).then(() => { finished = true })
  await tick()
  assert.equal(activity.at(-1)?.reviewQueued, 3)
  controller.abort()
  assert.equal(finished, false)
  checks[0].resolve()
  await tick()
  assert.equal(finished, false)
  assert.deepEqual(reviews, [0, 1])
  assert.equal(activity.at(-1)?.reviewQueued, 0)
  checks[1].reject(new DOMException('stopped', 'AbortError'))
  await run
  assert.ok([...tracker.states.values()].every(item => item.status === 'completed' && item.images.length === 1))
  for (let index = 1; index < 5; index++) assert.equal(tracker.states.get(`job-${index}`)?.quality?.status, 'unavailable')
  assert.equal(activity.at(-1)?.reviewing, 0)
})

test('completed batches no longer react to abort events after either success or failure', async () => {
  for (const fail of [false, true]) {
    const controller = new AbortController()
    const works = [work('job-0')]
    const tracker = recorder(works)
    const activity: ImageJobActivity[] = []
    const run = runCommerceJobs({
      api: apiWith(() => {
        if (fail) throw new Error('generation rejected')
        return completedImage('job-0')
      }),
      works, signal: controller.signal, prepare: async () => new FormData(),
      onUpdate: tracker.onUpdate, onActivity: snapshot => activity.push(snapshot),
    })
    if (fail) await assert.rejects(run, /generation rejected/)
    else await run
    const updateCount = tracker.updates.length
    const activityCount = activity.length
    controller.abort()
    await tick()
    assert.equal(tracker.updates.length, updateCount)
    assert.equal(activity.length, activityCount)
  }
})
