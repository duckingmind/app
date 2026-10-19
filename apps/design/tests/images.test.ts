import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import { fetchImage, loadImage, readPhoto, stitchImages } from '../src/images.ts'
import {
  MAX_IMAGE_BYTES,
  checkImageDimensions,
  headerDimensions,
  imageAddress,
} from '../src/imageSafety.ts'

function png(width = 4096, height = 4096): Uint8Array {
  const bytes = new Uint8Array(24)
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10])
  const view = new DataView(bytes.buffer)
  view.setUint32(16, width)
  view.setUint32(20, height)
  return bytes
}

function response(bytes = png(), mime = 'image/png') {
  return new Response(bytes, { headers: { 'content-type': mime } })
}

function mockGlobal(t: TestContext, name: string, value: unknown) {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, name)
  Object.defineProperty(globalThis, name, { configurable: true, writable: true, value })
  t.after(() => {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor)
    else Reflect.deleteProperty(globalThis, name)
  })
}

function browser(t: TestContext, sizes = [{ width: 4096, height: 4096 }], hang = false) {
  const urls = new Map<string, Blob>()
  const revoked: string[] = []
  const images: MockImage[] = []
  const canvases: MockCanvas[] = []
  const draws: { width: number; height: number; x: number; y: number; canvasWidth: number; canvasHeight: number }[] = []
  let active = 0
  let peak = 0
  let id = 0
  class MockImage {
    naturalWidth: number
    naturalHeight: number
    onload: (() => void) | null = null
    onerror: (() => void) | null = null
    currentSource = ''
    constructor() {
      const size = sizes[images.length % sizes.length]
      this.naturalWidth = size.width
      this.naturalHeight = size.height
      images.push(this)
    }
    set src(value: string) {
      this.currentSource = value
      active++
      peak = Math.max(peak, active)
      if (!hang) queueMicrotask(() => { if (this.currentSource) this.onload?.() })
    }
    removeAttribute(name: string) {
      assert.equal(name, 'src')
      if (this.currentSource) active--
      this.currentSource = ''
    }
  }
  class MockCanvas {
    width = 0
    height = 0
    constructor() { canvases.push(this) }
    getContext() {
      return {
        fillStyle: '',
        fillRect() {},
        drawImage: (_image: MockImage, x: number, y: number, width: number, height: number) => {
          draws.push({ x, y, width, height, canvasWidth: this.width, canvasHeight: this.height })
        },
      }
    }
    toBlob(callback: (blob: Blob) => void) {
      callback(new Blob([new Uint8Array([255, 216, 255])], { type: 'image/jpeg' }))
    }
  }
  mockGlobal(t, 'Image', MockImage)
  mockGlobal(t, 'document', { createElement: (name: string) => {
    assert.equal(name, 'canvas')
    return new MockCanvas()
  } })
  t.mock.method(URL, 'createObjectURL', (blob: Blob) => {
    const url = `blob:mock-${++id}`
    urls.set(url, blob)
    return url
  })
  t.mock.method(URL, 'revokeObjectURL', (url: string) => {
    revoked.push(url)
    urls.delete(url)
  })
  return { urls, revoked, images, canvases, draws, active: () => active, peak: () => peak }
}

test('image addresses keep bundled, blob and inline raster sources and reject executable formats', () => {
  for (const url of ['/assets/example.webp', './assets/example.webp', 'assets/example.webp', 'blob:example', 'https://example.test/photo.png', 'data:image/png;base64,AAAA'])
    assert.equal(imageAddress(url), url)
  for (const url of ['javascript:alert(1)', 'data:text/html;base64,AAAA', 'data:image/svg+xml;base64,AAAA', 'file:///photo.png', '', '\u0000javascript:alert(1)'])
    assert.throws(() => imageAddress(url), /地址|支持/)
  assert.equal(imageAddress('data:image/png;base64,AA\nAA'), 'data:image/png;base64,AAAA')
})

test('dimension guards allow 4K and reject invalid or excessive decoded allocations', () => {
  assert.doesNotThrow(() => checkImageDimensions(4096, 4096))
  assert.doesNotThrow(() => checkImageDimensions(8000, 5000))
  for (const [width, height] of [[0, 10], [10, -1], [Infinity, 1], [1.5, 20], [8000, 5001], [30001, 1]])
    assert.throws(() => checkImageDimensions(width, height), /尺寸/)
  assert.deepEqual(headerDimensions(png(4096, 2048), 'image/png'), { width: 4096, height: 2048 })
  const jpeg = new Uint8Array([255, 216, 255, 194, 0, 17, 8, 8, 0, 16, 0, 3, 1, 17, 0, 2, 17, 1, 3, 17, 1])
  assert.deepEqual(headerDimensions(jpeg, 'image/jpeg'), { width: 4096, height: 2048 })
  const webp = new Uint8Array(30)
  webp.set([86, 80, 56, 88], 12)
  webp.set([255, 15, 0, 255, 7, 0], 24)
  assert.deepEqual(headerDimensions(webp, 'image/webp'), { width: 4096, height: 2048 })
  assert.equal(headerDimensions(new Uint8Array([255, 216, 255]), 'image/jpeg'), undefined)
})

test('bounded downloads preserve raster MIME and omit credentials for relative assets', async t => {
  const fetch = t.mock.method(globalThis, 'fetch', async (url: string, options: RequestInit) => {
    assert.equal(url, '/assets/example.webp')
    assert.equal(options.credentials, 'omit')
    assert.ok(options.signal instanceof AbortSignal)
    return response(png(), 'IMAGE/PNG; charset=binary')
  })
  const blob = await fetchImage('/assets/example.webp')
  assert.equal(blob.type, 'image/png')
  assert.equal(blob.size, 24)
  assert.equal(fetch.mock.callCount(), 1)
})

test('downloads reject wrong MIME and forged raster content and cancel rejected bodies', async t => {
  let cancelled = false
  t.mock.method(globalThis, 'fetch', async () => new Response(new ReadableStream({
    cancel() { cancelled = true },
  }), { headers: { 'content-type': 'image/svg+xml' } }))
  await assert.rejects(fetchImage('https://example.test/photo'), /支持/)
  assert.equal(cancelled, true)
  t.mock.method(globalThis, 'fetch', async () => response(new TextEncoder().encode('<svg></svg>')))
  await assert.rejects(fetchImage('https://example.test/photo'), /格式不符/)
})

test('declared oversized downloads are rejected before reading the response', async t => {
  let cancelled = false
  t.mock.method(globalThis, 'fetch', async () => new Response(new ReadableStream({
    cancel() { cancelled = true },
  }), { headers: { 'content-type': 'image/png', 'content-length': String(MAX_IMAGE_BYTES + 1) } }))
  await assert.rejects(fetchImage('https://example.test/photo'), /80 MB/)
  assert.equal(cancelled, true)
})

test('streamed downloads enforce the byte budget even without Content-Length', async t => {
  let cancelled = false
  let count = 0
  const chunk = new Uint8Array(1024 * 1024)
  chunk.set([255, 216, 255])
  t.mock.method(globalThis, 'fetch', async () => new Response(new ReadableStream({
    pull(controller) { count++; controller.enqueue(chunk) },
    cancel() { cancelled = true },
  }), { headers: { 'content-type': 'image/jpeg' } }))
  await assert.rejects(fetchImage('https://example.test/photo'), /80 MB/)
  assert.equal(cancelled, true)
  assert.ok(count <= 82, 'the source stops as soon as it exceeds the budget')
})

test('a stalled response times out, cancels its reader and releases the lock', async t => {
  let cancelled = false
  const body = new ReadableStream<Uint8Array>({ cancel() { cancelled = true } })
  t.mock.method(globalThis, 'fetch', async () => new Response(body, { headers: { 'content-type': 'image/png' } }))
  await assert.rejects(fetchImage('https://example.test/photo', { timeoutMs: 5 }), /超时/)
  assert.equal(cancelled, true)
  assert.equal(body.locked, false)
})

test('cancellation before download avoids fetching and cancellation during reading cancels the stream', async t => {
  let cancelled = false
  const body = new ReadableStream<Uint8Array>({ cancel() { cancelled = true } })
  const fetch = t.mock.method(globalThis, 'fetch', async () => new Response(body, { headers: { 'content-type': 'image/png' } }))
  const before = new AbortController()
  before.abort()
  await assert.rejects(fetchImage('https://example.test/photo', { signal: before.signal }), { name: 'AbortError' })
  assert.equal(fetch.mock.callCount(), 0)
  const during = new AbortController()
  const pending = fetchImage('https://example.test/photo', { signal: during.signal })
  await Promise.resolve()
  during.abort()
  await assert.rejects(pending, { name: 'AbortError' })
  assert.equal(cancelled, true)
})

test('4K decoding succeeds and frees its temporary URL without revoking the caller source', async t => {
  const state = browser(t)
  t.mock.method(globalThis, 'fetch', async () => response())
  const image = await loadImage('blob:caller-owned')
  assert.equal(image.naturalWidth, 4096)
  assert.equal(state.urls.size, 0)
  assert.deepEqual(state.revoked, ['blob:mock-1'])
  assert.equal(state.images[0].onload, null)
  assert.equal(state.images[0].onerror, null)
  image.removeAttribute('src')
})

test('oversized headers are rejected before allocating a browser image', async t => {
  const state = browser(t)
  t.mock.method(globalThis, 'fetch', async () => response(png(10000, 10000)))
  await assert.rejects(loadImage('https://example.test/photo'), /尺寸过大/)
  assert.equal(state.images.length, 0)
  assert.equal(state.urls.size, 0)
})

test('decoder dimensions are checked independently of the encoded header', async t => {
  const state = browser(t, [{ width: 10000, height: 10000 }])
  t.mock.method(globalThis, 'fetch', async () => response())
  await assert.rejects(loadImage('https://example.test/photo'), /尺寸过大/)
  assert.equal(state.active(), 0)
  assert.equal(state.urls.size, 0)
})

test('decode timeout releases the image, events and temporary URL', async t => {
  const state = browser(t, undefined, true)
  t.mock.method(globalThis, 'fetch', async () => response())
  await assert.rejects(loadImage('https://example.test/photo', { timeoutMs: 5 }), /超时/)
  assert.equal(state.active(), 0)
  assert.equal(state.urls.size, 0)
  assert.equal(state.images[0].onload, null)
  assert.equal(state.images[0].onerror, null)
})

test('accepted uploads keep only the caller-owned preview URL', async t => {
  const state = browser(t)
  t.mock.method(globalThis, 'fetch', async (url: string) => new Response(state.urls.get(url)))
  const file = new File([png()], 'product.png', { type: 'image/png' })
  const photo = await readPhoto(file)
  assert.equal(photo.url, 'blob:mock-1')
  assert.equal(state.urls.size, 1)
  assert.equal(state.active(), 0)
  assert.equal(state.urls.get(photo.url), file)
})

test('stitching decodes one source at a time, fetches once, and preserves module layout', async t => {
  const state = browser(t, [{ width: 1000, height: 2000 }, { width: 500, height: 1000 }])
  const fetch = t.mock.method(globalThis, 'fetch', async () => response())
  const result = await stitchImages(['https://example.test/a.png', 'https://example.test/b.png'])
  assert.equal(result.type, 'image/jpeg')
  assert.equal(fetch.mock.callCount(), 2)
  assert.equal(state.peak(), 1)
  assert.equal(state.active(), 0)
  assert.deepEqual(state.draws, [
    { x: 0, y: 0, width: 500, height: 1000, canvasWidth: 500, canvasHeight: 2000 },
    { x: 0, y: 1000, width: 500, height: 1000, canvasWidth: 500, canvasHeight: 2000 },
  ])
  assert.equal(state.canvases[0].width, 0)
  assert.equal(state.canvases[0].height, 0)
  assert.equal(state.urls.size, 0)
})

test('oversized long pages fail before allocating the output canvas', async t => {
  const state = browser(t, [{ width: 1000, height: 20000 }])
  t.mock.method(globalThis, 'fetch', async () => response(png(1000, 20000)))
  await assert.rejects(stitchImages(['https://example.test/a.png', 'https://example.test/b.png']), /详情页过长/)
  assert.equal(state.peak(), 1)
  assert.equal(state.active(), 0)
  assert.equal(state.canvases.length, 0)
})

test('stitching rejects a combined download budget overflow before reading the next body', async t => {
  const state = browser(t)
  let cancelled = false
  let count = 0
  const first = new Uint8Array(41 * 1024 * 1024)
  first.set(png())
  t.mock.method(globalThis, 'fetch', async () => {
    count++
    if (count === 1) return response(first)
    return new Response(new ReadableStream({ cancel() { cancelled = true } }), {
      headers: { 'content-type': 'image/png', 'content-length': String(first.byteLength) },
    })
  })
  await assert.rejects(stitchImages(['https://example.test/a.png', 'https://example.test/b.png']), /图片总大小超过 80 MB/)
  assert.equal(cancelled, true)
  assert.equal(state.active(), 0)
  assert.equal(state.urls.size, 0)
  assert.equal(state.canvases.length, 0)
})
