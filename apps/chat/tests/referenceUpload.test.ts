import assert from 'node:assert/strict'
import test from 'node:test'
import { clipboardImageFiles, prepareReferenceImageFile, readReferenceAssetFile, referenceAssetFromResponse, referenceImageAccept, restoreReferenceAsset, responsesContentWithImages, uploadReferenceAsset, videoImageReference } from '../src/referenceUpload.ts'

test('reference image upload uses the portal image types and keeps small files unchanged', async () => {
  const image = new File([new Uint8Array([1, 2, 3])], 'small.png', { type: 'image/png' })
  assert.equal(referenceImageAccept(), 'image/png,image/jpeg,image/jpg,image/webp,image/gif')
  assert.equal(await prepareReferenceImageFile(image), image)
  await assert.rejects(
    prepareReferenceImageFile(new File(['<svg/>'], 'vector.svg', { type: 'image/svg+xml' })),
    /仅支持 PNG、JPG、WebP 或 GIF/,
  )
  await assert.rejects(
    prepareReferenceImageFile(new File([], 'empty.png', { type: 'image/png' })),
    /图片文件为空/,
  )
})

test('clipboard screenshots are read from image items when files is empty', () => {
  const source = new File([new Uint8Array([1, 2, 3])], '', { type: 'image/png' })
  const files = clipboardImageFiles({
    files: [],
    items: [{ kind: 'file', type: 'image/png', getAsFile: () => source }],
  })
  assert.equal(files.length, 1)
  assert.equal(files[0].type, 'image/png')
  assert.equal(files[0].name, 'pasted-image-1.png')
})

test('clipboard text is ignored and file-list images remain supported', () => {
  const image = new File([new Uint8Array([1])], 'copied.png', { type: 'image/png' })
  const text = new File(['hello'], 'note.txt', { type: 'text/plain' })
  assert.deepEqual(clipboardImageFiles({ files: [image, text], items: [{ kind: 'string', type: 'text/plain' }] }).map((file) => file.name), ['copied.png'])
})

test('durable chat reference upload uses the shared COS flow and validates the stable asset identity', async () => {
  const calls: Array<{ path: string; init?: RequestInit }> = []
  const api = {
    request: async <T,>(path: string, init?: RequestInit) => {
      calls.push({ path, init })
      if (path === '/media/assets/upload-intents') return {
        asset_id: 'asset-reference-1', status: 'pending', upload_url: 'https://cos.example.test/reference',
        size_bytes: 3, content_type: 'image/png',
      } as T
      return {
        id: 'asset-reference-1', type: 'image', content_type: 'image/png', size_bytes: 3,
        url: 'https://cdn.example/reference.png',
      } as T
    },
  }
  const file = new File([new Uint8Array([1, 2, 3])], 'source.png', { type: 'image/png' })
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => new Response(null, { status: 200 })
  try {
    const asset = await uploadReferenceAsset(api, file, 'chat-reference-1')
    assert.equal(asset.id, 'asset-reference-1')
    assert.deepEqual(calls.map(call => call.path), [
      '/media/assets/upload-intents',
      '/media/assets/asset-reference-1/complete',
    ])
    assert.equal(calls[0].init?.method, 'POST')
    assert.equal(calls[0].init?.headers && new Headers(calls[0].init.headers).get('Idempotency-Key'), 'chat-reference-1')
    assert.equal(typeof calls[0].init?.body, 'string')
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('asset responses reject a non-image or mismatched file', () => {
  assert.throws(() => referenceAssetFromResponse({ id: 'asset-1', type: 'video', size_bytes: 3 }, 3), /无效的图片资产/)
  assert.throws(() => referenceAssetFromResponse({ id: 'asset-1', type: 'image', size_bytes: 4 }, 3), /无效的图片资产/)
})

test('Responses image content keeps text and every uploaded image in order', () => {
  assert.equal(responsesContentWithImages('  hello  ', []), 'hello')
  assert.deepEqual(responsesContentWithImages('', ['https://cdn.example/one.png']), [
    { type: 'input_image', image_url: 'https://cdn.example/one.png' },
  ])
  assert.deepEqual(responsesContentWithImages('describe these', ['https://cdn.example/one.png', 'https://cdn.example/two.png']), [
    { type: 'input_text', text: 'describe these' },
    { type: 'input_image', image_url: 'https://cdn.example/one.png' },
    { type: 'input_image', image_url: 'https://cdn.example/two.png' },
  ])
})

test('video reference transport uses the durable URL rather than embedding file bytes', () => {
  assert.deepEqual(videoImageReference(' https://cdn.example/reference.png '), {
    type: 'image_url', image_url: { url: 'https://cdn.example/reference.png' },
  })
  assert.throws(() => videoImageReference('data:image/png;base64,YQ=='), /云端地址/)
})

test('video references accept loopback HTTP COS URLs for local development', () => {
  assert.deepEqual(videoImageReference(' http://127.0.0.1:9000/bucket/reference.png '), {
    type: 'image_url', image_url: { url: 'http://127.0.0.1:9000/bucket/reference.png' },
  })
  assert.throws(() => videoImageReference('http://cos.example.test/reference.png'), /云端地址/)
})

test('reusable references refresh metadata without downloading bytes', async () => {
  let fetched = false
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => { fetched = true; return new Response(new Uint8Array([1]), { status: 200 }) }
  try {
    const restored = await restoreReferenceAsset({
      request: async <T,>() => ({ id: 'asset-1', type: 'image', content_type: 'image/png', size_bytes: 4, url: 'https://cdn.example/reference.png' } as T),
    }, 'asset-1', 'reference.png', false)
    assert.equal(restored.file.size, 0)
    assert.equal(restored.preview, 'https://cdn.example/reference.png')
    assert.equal(fetched, false)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('reference restoration reads the original signed URL with browser-safe fetch options', async () => {
  const originalFetch = globalThis.fetch
  let requestedURL = ''
  let requestedInit: RequestInit | undefined
  globalThis.fetch = (async (input, init) => {
    requestedURL = String(input)
    requestedInit = init
    return new Response(new Uint8Array([137, 80, 78, 71]), { status: 200, headers: { 'Content-Type': 'image/png' } })
  }) as typeof fetch
  try {
    const restored = await readReferenceAssetFile({
      request: async <T,>() => ({ id: 'asset-1', type: 'image', content_type: 'image/png', size_bytes: 4, url: 'https://cdn.example/reference.png', thumbnail_url: 'https://cdn.example/thumbnail.png' } as T),
    }, 'asset-1', 'restored.png')
    assert.equal(requestedURL, 'https://cdn.example/reference.png')
    assert.equal(requestedInit?.credentials, 'omit')
    assert.equal(requestedInit?.mode, 'cors')
    assert.equal(requestedInit?.cache, 'no-store')
    assert.equal(restored.file.name, 'restored.png')
    assert.equal(restored.file.type, 'image/png')
    URL.revokeObjectURL(restored.preview)
  } finally {
    globalThis.fetch = originalFetch
  }
})

