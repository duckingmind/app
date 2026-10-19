import assert from 'node:assert/strict'
import test from 'node:test'
import { refreshWorkMedia } from '../src/workMedia.ts'
import { resultImages, submitImage, type Api, type Work } from '../src/core.ts'
const work: Work = { id: 'work', batch: 'batch', title: 'image', scene: '', pose: '', ratio: '1:1', model: 'model', createdAt: '2026-09-20', kind: 'product', status: 'completed', images: [], taskId: 'task_1' }
function api(request: (path: string, init?: any) => any): Api { return { request: async (path, init) => request(path, init) } }
test('synchronous responses retain the platform task and asset handles', async () => {
  const ids: string[] = []
  const images = await submitImage(api(() => ({ task_id: 'task_1', data: [{ asset_id: 'asset_1', url: 'https://media.test/new' }] })), '/images/generations', '{}', { onTask: id => { ids.push(id) } })
  assert.deepEqual(ids, ['task_1'])
  assert.deepEqual(images, [{ url: 'https://media.test/new', assetId: 'asset_1' }])
})
test('refresh replaces expired URL using GET only without resubmitting generation', async () => {
  const paths: string[] = []
  const result = await refreshWorkMedia(api((path, init) => { paths.push(path); assert.notEqual(init?.method, 'POST'); return { status: 'completed', data: [{ asset_id: 'asset_1', url: 'https://media.test/fresh' }] } }), { ...work, images: [{ url: 'https://media.test/expired' }] })
  assert.deepEqual(paths, ['/images/tasks/task_1?response_format=url'])
  assert.equal(result.images[0].url, 'https://media.test/fresh')
  assert.deepEqual(result.assetIds, ['asset_1'])
})
test('asset-only saved records resolve via the scoped library and missing media fails', async () => {
  const scoped = { ...work, taskId: undefined, assetIds: ['asset_1'] }
  const result = await refreshWorkMedia(api(path => { assert.equal(path, '/media/assets/asset_1'); return { id: 'asset_1', url: 'https://media.test/asset' } }), scoped)
  assert.equal(result.status, 'completed')
  await assert.rejects(refreshWorkMedia(api(() => ({ id: 'asset_1', url: '' })), scoped), /素材已删除/)
})
test('pending and terminal task states are preserved as recoverable versus failed', async () => {
  assert.equal((await refreshWorkMedia(api(() => ({ status: 'in_progress' })), work)).status, 'paused')
  assert.equal((await refreshWorkMedia(api(() => ({ status: 'failed', error: { message: 'deleted' } })), work)).error, 'deleted')
})
test('task persistence failure propagates before polling begins', async () => {
  let calls = 0
  await assert.rejects(submitImage(api(() => { calls++; return { task_id: 'task_1', status: 'in_progress' } }), '/images/generations', '{}', { onTask: async () => { throw new Error('cannot persist handle') } }), /cannot persist/)
  assert.equal(calls, 1)
})


test('old task responses do not clear existing asset handles and expired tasks recover from assets', async () => {
  const saved = { ...work, assetIds: ['asset_1'] }
  const refreshed = await refreshWorkMedia(api(() => ({ status: 'completed', data: [{ url: 'https://media.test/old-response' }] })), saved)
  assert.deepEqual(refreshed.assetIds, ['asset_1'])
  const paths: string[] = []
  const recovered = await refreshWorkMedia(api(path => {
    paths.push(path)
    if (path.startsWith('/images/tasks/')) throw Object.assign(new Error('missing task'), { status: 404 })
    return { id: 'asset_1', url: 'https://media.test/stable' }
  }), saved)
  assert.equal(recovered.images[0].url, 'https://media.test/stable')
  assert.deepEqual(paths, ['/images/tasks/task_1?response_format=url', '/media/assets/asset_1'])
})
