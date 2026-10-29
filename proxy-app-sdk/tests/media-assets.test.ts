import assert from 'node:assert/strict'
import test from 'node:test'
import { uploadApplicationMediaAsset } from '../src/media-assets.ts'

function api(handler: (path: string, options?: RequestInit) => unknown | Promise<unknown>) {
  const calls: Array<{ path: string; options?: RequestInit }> = []
  return {
    calls,
    client: {
      request: async <T,>(path: string, options?: RequestInit) => {
        calls.push({ path, options })
        return await handler(path, options) as T
      },
    },
  }
}

test('small durable image assets use the same COS handshake as every other size', async () => {
  const file = new File([new Uint8Array([1, 2, 3])], 'small.png', { type: 'image/png' })
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => new Response(null, { status: 200 })
  const calls = api(path => path.endsWith('/upload-intents')
    ? { asset_id: 'asset-1', status: 'pending', upload_url: 'https://cos.example.test/object', size_bytes: file.size, content_type: file.type }
    : { id: 'asset-1' })
  try {
    const asset = await uploadApplicationMediaAsset<{ id: string }>(calls.client, { file, idempotencyKey: 'chat-image-1' })
    assert.deepEqual(asset, { id: 'asset-1' })
    assert.deepEqual(calls.calls.map(call => call.path), ['/media/assets/upload-intents', '/media/assets/asset-1/complete'])
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('reports measured browser upload progress before completion confirmation', async () => {
  const file = new File([new Uint8Array([1, 2, 3, 4])], 'progress.png', { type: 'image/png' })
  const updates: Array<{ phase: string; percent?: number; loadedBytes?: number }> = []
  const originalXHR = globalThis.XMLHttpRequest
  class FakeXHR {
    status = 200
    responseType = ''
    upload: { onprogress?: (event: { lengthComputable: boolean; loaded: number; total: number }) => void } = {}
    onload?: () => void
    onerror?: () => void
    ontimeout?: () => void
    onabort?: () => void
    open() {}
    setRequestHeader() {}
    send() {
      this.upload.onprogress?.({ lengthComputable: true, loaded: 2, total: file.size })
      this.upload.onprogress?.({ lengthComputable: true, loaded: file.size, total: file.size })
      queueMicrotask(() => this.onload?.())
    }
    abort() { this.onabort?.() }
  }
  globalThis.XMLHttpRequest = FakeXHR as unknown as typeof XMLHttpRequest
  const calls = api(path => path.endsWith('/upload-intents')
    ? { asset_id: 'asset-progress', status: 'pending', upload_url: 'https://cos.example.test/object', size_bytes: file.size, content_type: file.type }
    : { id: 'asset-progress' })
  try {
    await uploadApplicationMediaAsset<{ id: string }>(calls.client, {
      file,
      idempotencyKey: 'progress-key',
      onProgress: update => updates.push(update),
    })
  } finally {
    globalThis.XMLHttpRequest = originalXHR
  }
  assert.deepEqual(updates.map(update => [update.phase, update.percent]), [
    ['preparing', 0],
    ['uploading', 0],
    ['uploading', 50],
    ['uploading', 100],
    ['uploading', 100],
    ['completing', 95],
    ['completing', 100],
  ])
})

test('upload-intent failures propagate without replaying media through Gateway', async () => {
  const file = new File([new Uint8Array([1])], 'unavailable.png', { type: 'image/png' })
  const failure = Object.assign(new Error('storage unavailable'), { status: 503, code: 'media_storage_unavailable' })
  const calls = api(() => { throw failure })
  await assert.rejects(uploadApplicationMediaAsset(calls.client, { file, idempotencyKey: 'outage-key' }), error => error === failure)
  assert.deepEqual(calls.calls.map(call => call.path), ['/media/assets/upload-intents'])
})

test('COS failure aborts its intent and never replays file bytes', async () => {
  const file = new File([new Uint8Array([1])], 'cos.png', { type: 'image/png' })
  const calls = api(path => path.endsWith('/upload-intents')
    ? { asset_id: 'asset-cos', status: 'pending', upload_url: 'https://cos.example.test/object', size_bytes: file.size, content_type: file.type }
    : { aborted: true })
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => new Response(null, { status: 503 })
  try {
    await assert.rejects(uploadApplicationMediaAsset(calls.client, { file, idempotencyKey: 'cos-failure' }), { code: 'APP_MEDIA_DIRECT_UPLOAD_FAILED' })
  } finally {
    globalThis.fetch = originalFetch
  }
  assert.deepEqual(calls.calls.map(call => [call.path, call.options?.method]), [
    ['/media/assets/upload-intents', 'POST'],
    ['/media/assets/asset-cos/upload-intent', 'DELETE'],
  ])
})

test('ambiguous completion keeps the intent available for idempotent reconciliation', async () => {
  const file = new File([new Uint8Array([1])], 'pending.png', { type: 'image/png' })
  const failure = Object.assign(new Error('gateway unavailable'), { status: 503 })
  const calls = api(path => {
    if (path.endsWith('/upload-intents')) return { asset_id: 'asset-pending', status: 'pending', upload_url: 'https://cos.example.test/object', size_bytes: file.size, content_type: file.type }
    throw failure
  })
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => new Response(null, { status: 200 })
  try {
    await assert.rejects(uploadApplicationMediaAsset(calls.client, { file, idempotencyKey: 'completion-key' }), error => error === failure)
  } finally {
    globalThis.fetch = originalFetch
  }
  assert.deepEqual(calls.calls.map(call => call.path), ['/media/assets/upload-intents', '/media/assets/asset-pending/complete'])
})

test('a resource-level 404 from upload-intent propagates without replaying media', async () => {
  const file = new File([new Uint8Array([1])], 'missing.png', { type: 'image/png' })
  const missing = Object.assign(new Error('asset does not exist'), { status: 404, code: 'media_asset_not_found' })
  const calls = api(() => { throw missing })
  await assert.rejects(uploadApplicationMediaAsset(calls.client, { file, idempotencyKey: 'missing-asset-key' }), error => error === missing)
  assert.deepEqual(calls.calls.map(call => call.path), ['/media/assets/upload-intents'])
})

