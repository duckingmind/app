import assert from 'node:assert/strict'
import test from 'node:test'
import taskFunction from '../runtime/task.mjs'

const task = {
  id: 'task-123',
  name: 'generate-pelican-animation',
  payload: { model: 'text-model', model_name: 'Text Model', reasoning_effort: 'high' },
  attempt: 1,
  idempotencyKey: 'pelican-request-123',
  createdAt: '2026-10-26T00:00:00.000Z',
}

test('task generates through Gateway and persists the result with task idempotency', async () => {
  const progress: Array<{ percent?: number; message?: string }> = []
  const calls: Array<{ path: string; init?: RequestInit }> = []
  const html = '<!doctype html><html><body><svg><circle cx="4" cy="4" r="3"/></svg></body></html>'
  const context = {
    appId: 'pelican',
    appVersion: '0.3.7',
    user: { id: 'user-1', name: 'Tester' },
    requestId: 'task-123-attempt-1',
    reportProgress: async (value: { percent?: number; message?: string }) => { progress.push(value) },
    platform: {
      request: async (path: string, init?: RequestInit) => {
        calls.push({ path, init })
        if (path.startsWith('/storage/shared/items?') && init?.method !== 'PUT') return Response.json({ data: null })
        if (path === '/responses') return Response.json({
          id: 'resp-1',
          model: 'text-model',
          reasoning: { effort: 'high' },
          output: [{ type: 'message', content: [{ type: 'output_text', text: html }] }],
        }, { headers: { 'x-request-id': 'gateway-request-1' } })
        if (path.startsWith('/storage/shared/items?') && init?.method === 'PUT') return Response.json({ data: { success: true, revision: 1 } })
        throw new Error(`Unexpected Gateway path: ${path}`)
      },
    },
  }

  const result = await taskFunction.handle(task, context as never)
  assert.equal(result.saved, true)
  assert.equal(result.item_id, task.id)
  assert.equal(result.model, 'text-model')
  assert.equal(result.request_id, 'gateway-request-1')
  assert.deepEqual(calls.map(call => new URL(call.path, 'https://gateway.test').pathname), [
    '/storage/shared/items', '/responses', '/storage/shared/items',
  ])
  assert.deepEqual(JSON.parse(String(calls[1].init?.body)), {
    model: 'text-model', input: '创建一个HTML，内容是SVG绘制一个鹈鹕骑自行车的2D动画，你不需要任何测试创建一个HTML，内容是SVG绘制一个鹈鹕骑自行车的2D动画，你不需要任何测试',
    stream: false, store: false, reasoning: { effort: 'high' },
  })
  assert.equal(new Headers(calls[1].init?.headers).get('idempotency-key'), task.idempotencyKey)
  assert.equal(new Headers(calls[2].init?.headers).get('idempotency-key'), 'gallery:task-123')
  const stored = JSON.parse(String(calls[2].init?.body))
  assert.equal(stored.expected_revision, 0)
  assert.equal(stored.value.id, task.id)
  assert.equal(stored.value.html, html)
  assert.equal('userName' in stored.value, false)
  assert.equal(progress.at(-1)?.percent, 100)
})

test('replayed task returns the existing gallery record without charging the model again', async () => {
  const calls: string[] = []
  const context = {
    reportProgress: async () => {},
    platform: {
      request: async (path: string) => {
        calls.push(path)
        return Response.json({ data: {
          key: 'pelican/results/task-123',
          value: { id: 'task-123', model: 'Text Model', modelId: 'text-model', raw: '<svg/>', html: '<html><svg/></html>', generatedAt: task.createdAt, requestId: 'gateway-request-1' },
          author_user_id: 'user-1',
          author_user_name: 'Tester',
        } })
      },
    },
  }
  const result = await taskFunction.handle(task, context as never)
  assert.equal(result.saved, true)
  assert.equal(result.request_id, 'gateway-request-1')
  assert.equal(calls.length, 1)
  assert.match(calls[0], /^\/storage\/shared\/items\?key=/)
})

test('a retried task reuses its Gateway idempotency key after a transient model error', async () => {
  const modelKeys: string[] = []
  let modelCalls = 0
  const html = '<!doctype html><html><body><svg><circle r="3"/></svg></body></html>'
  const context = {
    user: { id: 'user-1', name: 'Tester' },
    reportProgress: async () => {},
    platform: {
      request: async (path: string, init?: RequestInit) => {
        if (path.startsWith('/storage/shared/items?') && init?.method !== 'PUT') return Response.json({ data: null })
        if (path === '/responses') {
          modelCalls++
          modelKeys.push(new Headers(init?.headers).get('idempotency-key') || '')
          if (modelCalls === 1) {
            return Response.json({ error: { code: 'UPSTREAM_ERROR', message: 'temporary upstream failure' } }, { status: 502 })
          }
          return Response.json({
            id: 'resp-retry', model: 'text-model',
            output: [{ type: 'message', content: [{ type: 'output_text', text: html }] }],
          })
        }
        if (path.startsWith('/storage/shared/items?') && init?.method === 'PUT') return Response.json({ data: { success: true, revision: 1 } })
        throw new Error(`Unexpected Gateway path: ${path}`)
      },
    },
  }

  await assert.rejects(taskFunction.handle({ ...task, attempt: 1 }, context as never), (error: { code?: string }) => error.code === 'UPSTREAM_ERROR')
  const result = await taskFunction.handle({ ...task, attempt: 2 }, context as never)

  assert.equal(result.saved, true)
  assert.deepEqual(modelKeys, [task.idempotencyKey, task.idempotencyKey])
})
