import assert from 'node:assert/strict'
import test from 'node:test'
import { buildTryOnPrompt, friendlyErrorMessage, friendlyResourceErrorMessage, historyForStorage, PendingTaskError, pollImage, resourceDiagnostic, resourceDiagnosticList, restoreHistory, sizeForRatio, submitImage, TerminalTaskError, type Api, type ImageModel, type Work } from '../src/core.ts'

type RequestOptions = Parameters<Api['request']>[1]

function apiWith(respond: (path: string, init?: RequestOptions) => unknown): Api {
  return { request: async <T>(path: string, init?: RequestOptions) => await respond(path, init) as T }
}

test('application image requests declare URL persistence and preserve explicit formats', async () => {
  for (const requested of [undefined, 'url', 'b64_json']) {
    for (const multipart of [false, true]) {
      const form = new FormData()
      form.set('prompt', 'draw')
      if (requested) form.set('response_format', requested)
      const body = multipart ? form : JSON.stringify({ prompt: 'draw', ...(requested ? { response_format: requested } : {}) })
      const api = apiWith((_path, init) => {
        const format = init?.body instanceof FormData
          ? init.body.get('response_format')
          : JSON.parse(String(init?.body)).response_format
        assert.equal(format, requested || 'url')
        return { data: [{ url: 'https://cdn.example/result.png' }] }
      })
      await submitImage(api, multipart ? '/images/edits' : '/images/generations', body)
      assert.equal(form.get('response_format'), requested || null, 'do not mutate the caller request')
    }
  }
})

test('gateway errors provide an actionable model recovery message', () => {
  assert.match(friendlyErrorMessage(Object.assign(new Error('Bad Gateway'), {
    status: 502,
    details: { error: { code: 'upstream_unavailable', message: 'upstream 502' } },
  })), /模型设置.*刷新.*切换.*已提交.*不会自动重复提交/)
  assert.match(friendlyErrorMessage(new Error('上游服务暂时不可用，请再次重试。')), /模型设置.*刷新.*切换/)
  assert.match(friendlyErrorMessage(Object.assign(new Error('model_not_found'), {
    status: 404,
    code: 'model_not_found',
  })), /模型.*不可用.*刷新模型列表.*切换可用模型/)
})

test('quota and expired sessions point to the correct recovery action', () => {
  assert.match(friendlyErrorMessage(Object.assign(new Error('quota exhausted'), { status: 402, code: 'insufficient_balance' })), /额度.*切换其他可用模型/)
  assert.match(friendlyErrorMessage(Object.assign(new Error('rate limited'), { status: 429 })), /请求受限.*切换其他可用模型/)
  assert.match(friendlyErrorMessage(Object.assign(new Error('expired'), { status: 401 })), /账户连接已过期.*重新加载应用/)
})

test('storage rate limits explain that synchronization is throttled', () => {
  const error = {
    status: 429,
    code: 'APP_API_ERROR',
    details: { error: { code: 'APP_RATE_LIMITED', message: 'too many runtime requests' } },
  }
  assert.match(friendlyResourceErrorMessage(error, 'history'), /作品记录同步请求过于频繁/)
  assert.match(friendlyResourceErrorMessage(error, 'preferences'), /偏好设置同步请求过于频繁/)
  assert.doesNotMatch(friendlyResourceErrorMessage(error, 'history'), /模型请求受限|切换.*模型/)
})

test('model catalog rate limits retain model recovery guidance', () => {
  const message = friendlyResourceErrorMessage({ status: 429, code: 'APP_RATE_LIMITED' }, 'models')
  assert.match(message, /模型目录请求过于频繁.*刷新/)
})

test('workspace resource failures keep recovery copy specific to the failed resource', () => {
  assert.match(
    friendlyResourceErrorMessage({ status: 503, code: 'APP_API_ERROR', details: { error: { code: 'UPSTREAM_UNAVAILABLE' } } }, 'history'),
    /作品记录服务暂时不可用.*重试/,
  )
  assert.match(
    friendlyResourceErrorMessage({ status: 403, code: 'APP_API_ERROR', details: { error: { code: 'PERMISSION_DENIED' } } }, 'preferences'),
    /偏好设置暂无访问权限.*检查应用权限/,
  )
  assert.match(
    friendlyResourceErrorMessage({ code: 'APP_NETWORK_ERROR', message: 'request failed' }, 'models'),
    /模型列表连接失败.*网络或平台运行时/,
  )
})

test('resource diagnostics expose only safe request metadata', () => {
  const error = {
    status: 503,
    code: 'APP_API_ERROR',
    request_id: 'req-123',
    details: {
      error: {
        code: 'UPSTREAM_UNAVAILABLE',
        message: 'provider token=secret-value',
      },
    },
  }
  assert.deepEqual(resourceDiagnostic(error), { code: 'UPSTREAM_UNAVAILABLE', status: 503, requestId: 'req-123' })
  assert.deepEqual(resourceDiagnosticList({ errors: { images: error, text: { status: 429, code: 'APP_RATE_LIMITED' } } }), [
    { code: 'UPSTREAM_UNAVAILABLE', status: 503, requestId: 'req-123' },
    { code: 'APP_RATE_LIMITED', status: 429 },
  ])
})

test('specific route failures survive generic SDK wrappers without claiming an upstream call', () => {
  for (const code of ['PROVIDER_DISPATCH_BLOCKED', 'account_pool_unavailable', 'route_unavailable', 'no_alternative_provider']) {
    const message = friendlyErrorMessage({
      code: 'APP_API_ERROR', status: 503,
      details: { error: { code, message: '上游服务暂时不可用' } },
    })
    assert.match(message, /暂无可用服务通道/)
    assert.doesNotMatch(message, /已提交|已调用|未提交|未调用/)
  }
})

test('upstream resource shortages are not reported as user balance or session failures', () => {
  for (const code of ['UPSTREAM_QUOTA_UNAVAILABLE', 'UPSTREAM_AUTH_UNAVAILABLE', 'UPSTREAM_ACCOUNT_UNAVAILABLE', 'UPSTREAM_CHALLENGE']) {
    const message = friendlyErrorMessage({ code, status: 503, message: '当前模型资源暂时不可用' })
    assert.match(message, /上游模型资源/)
    assert.doesNotMatch(message, /账户连接已过期|当前模型额度/)
  }
})

test('timeouts retain task recovery guidance and accepted media remains pending', () => {
  for (const error of [
    { status: 504, message: 'Gateway Timeout' },
    { code: 'APP_API_ERROR', status: 502, details: { error_type: 'upstream_timeout' } },
  ]) {
    const message = friendlyErrorMessage(error)
    assert.match(message, /模型响应超时.*作品中继续查询.*不会自动重复提交/)
  }
  assert.match(friendlyErrorMessage({ status: 504, details: {
    task_id: 'accepted-task', error: { code: 'media_task_timeout' },
  } }), /仍在处理中.*无需重新生成/)
})

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

test('base64 results retain their actual JPEG, WebP or PNG format for validation and downloads', async () => {
  for (const [mime, bytes] of [
    ['jpeg', [255, 216, 255, 224, 0, 16, 74, 70, 73, 70, 0, 1]],
    ['webp', [82, 73, 70, 70, 24, 0, 0, 0, 87, 69, 66, 80]],
    ['png', [137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13]],
  ] as const) {
    const encoded = btoa(String.fromCharCode(...bytes))
    const images = await submitImage(apiWith(() => ({ data: [{ b64_json: `\n${encoded}\n` }] })), '/images/generations', '{}')
    assert.equal(images[0].url, `data:image/${mime};base64,${encoded}`)
  }
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

test('refresh preserves completed images and final reports while ending an interrupted check', () => {
  const work: Work = {
    id: 'checked-image', batch: 'review-batch', kind: 'tryon', title: '正面全身',
    scene: '影棚', pose: '站姿', ratio: '3:4', model: 'image-model',
    status: 'completed', createdAt: '2026-09-11T08:00:00Z',
    images: [{ url: 'https://cdn.example/completed.png' }],
  }
  const works: Work[] = [
    { ...work, id: 'checking', quality: { status: 'checking', summary: '', issues: [], checkedAt: '' } },
    { ...work, id: 'passed', quality: { status: 'passed', summary: '未发现明显问题。', issues: [], checkedAt: '2026-09-11T08:01:00Z' } },
    { ...work, id: 'needs-review', quality: { status: 'needs_review', summary: '袖口细节可进一步核对。', issues: ['【无法判断】参考图袖口被遮挡，无法核对其细节。'], checkedAt: '2026-09-11T08:02:00Z' } },
  ]

  const restored = restoreHistory(JSON.parse(JSON.stringify(historyForStorage(works))))

  assert.equal(restored.length, 3)
  for (const item of restored) {
    assert.equal(item.status, 'completed')
    assert.deepEqual(item.images, work.images)
  }
  assert.equal(restored[0].quality?.status, 'unavailable')
  assert.match(restored[0].quality!.summary, /检查未完成.*图片已保留.*详情.*重新检查/)
  assert.deepEqual(restored[0].quality?.issues, [])
  assert.equal(restored[0].quality?.checkedAt, '')
  assert.deepEqual(restored[1].quality, works[1].quality)
  assert.deepEqual(restored[2].quality, works[2].quality)
  assert.equal(works[0].quality?.status, 'checking')
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
