import {
  MAX_IMAGE_BYTES,
  MAX_STITCH_HEIGHT,
  MAX_STITCH_PIXELS,
  checkImageDimensions,
  checkImageSignature,
  headerDimensions,
  imageAddress,
  imageMime,
} from './imageSafety.ts'
import { fetchDesignResource } from './network-boundary.ts'

export type Photo = { id: string; name: string; url: string; file?: File }
export type ImageOptions = { signal?: AbortSignal; timeoutMs?: number }

const IMAGE_TIMEOUT_MS = 30_000
const MAX_FILE_BYTES = 10 * 1024 * 1024

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new DOMException('图片处理已取消', 'AbortError')
}

function throwIfAborted(signal: AbortSignal) {
  if (signal.aborted) throw abortReason(signal)
}

async function imageOperation<T>(
  options: ImageOptions,
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController()
  const abort = () => controller.abort(options.signal?.reason)
  options.signal?.addEventListener('abort', abort, { once: true })
  if (options.signal?.aborted) abort()
  const timeout = setTimeout(
    () => controller.abort(new Error('图片处理超时，请稍后重试')),
    options.timeoutMs ?? IMAGE_TIMEOUT_MS,
  )
  try {
    throwIfAborted(controller.signal)
    return await operation(controller.signal)
  } finally {
    clearTimeout(timeout)
    options.signal?.removeEventListener('abort', abort)
  }
}

function releaseImage(image: HTMLImageElement) {
  image.removeAttribute('src')
}

function releaseCanvas(canvas: HTMLCanvasElement) {
  canvas.width = 0
  canvas.height = 0
}

async function fetchImageWithSignal(
  url: string,
  signal: AbortSignal,
  byteLimit = MAX_IMAGE_BYTES,
  limitMessage = '图片超过 80 MB，请压缩后重试',
): Promise<Blob> {
  const response = await fetchDesignResource(imageAddress(url), { credentials: 'omit', signal })
  let reader: ReadableStreamDefaultReader<Uint8Array<ArrayBuffer>> | undefined
  const cancel = () => {
    if (reader) void reader.cancel().catch(() => {})
    else void response.body?.cancel().catch(() => {})
  }
  signal.addEventListener('abort', cancel, { once: true })
  try {
    throwIfAborted(signal)
    if (!response.ok) throw new Error('图片下载失败，链接可能已过期')
    const mime = imageMime(response.headers.get('content-type'))
    const size = Number(response.headers.get('content-length'))
    if (Number.isFinite(size) && size > byteLimit)
      throw new Error(limitMessage)
    if (!response.body) throw new Error('图片内容为空')
    reader = response.body.getReader()
    const chunks: BlobPart[] = []
    let bytes = 0
    while (true) {
      const part = await reader.read()
      throwIfAborted(signal)
      if (part.done) break
      bytes += part.value.byteLength
      if (bytes > byteLimit) throw new Error(limitMessage)
      chunks.push(part.value)
    }
    if (!bytes) throw new Error('图片内容为空')
    const blob = new Blob(chunks, { type: mime })
    const prefix = new Uint8Array(await blob.slice(0, 12).arrayBuffer())
    throwIfAborted(signal)
    checkImageSignature(prefix, mime)
    return blob
  } catch (error) {
    cancel()
    if (signal.aborted) throw abortReason(signal)
    throw error
  } finally {
    signal.removeEventListener('abort', cancel)
    reader?.releaseLock()
  }
}

async function loadImageBlob(blob: Blob, signal: AbortSignal): Promise<HTMLImageElement> {
  throwIfAborted(signal)
  const header = new Uint8Array(await blob.slice(0, 1024 * 1024).arrayBuffer())
  throwIfAborted(signal)
  const dimensions = headerDimensions(header, blob.type)
  if (dimensions) checkImageDimensions(dimensions.width, dimensions.height)
  return new Promise((resolve, reject) => {
    const image = new Image()
    const url = URL.createObjectURL(blob)
    let settled = false
    const finish = (error?: unknown) => {
      if (settled) return
      settled = true
      image.onload = null
      image.onerror = null
      signal.removeEventListener('abort', abort)
      URL.revokeObjectURL(url)
      if (error) {
        releaseImage(image)
        reject(error)
      } else resolve(image)
    }
    // The operation owns the timeout; this callback also handles a cancellation
    // between the header read and installing the image event handlers.
    const abort = () => finish(abortReason(signal))
    image.onload = () => {
      try {
        checkImageDimensions(image.naturalWidth, image.naturalHeight)
        finish()
      } catch (error) {
        finish(error)
      }
    }
    image.onerror = () => finish(new Error('图片加载失败，请重新上传或更换图片'))
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
    else {
      try {
        image.src = url
      } catch (error) {
        finish(error)
      }
    }
  })
}

export function visionChallenge() {
  const values = crypto.getRandomValues(new Uint32Array(6))
  const answer = Array.from(values, value => String(value % 10)).join('')
  const canvas = document.createElement('canvas')
  canvas.width = 440
  canvas.height = 150
  const ctx = canvas.getContext('2d')!
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  ctx.fillStyle = '#172c25'
  ctx.font = 'bold 80px monospace'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(answer, canvas.width / 2, canvas.height / 2)
  return { image: canvas.toDataURL('image/png'), answer }
}

export async function reviewImage(url: string, options: ImageOptions = {}) {
  const image = await loadImage(url, options)
  const scale = Math.min(1, 1200 / Math.max(image.naturalWidth, image.naturalHeight))
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(image.naturalWidth * scale))
  canvas.height = Math.max(1, Math.round(image.naturalHeight * scale))
  try {
    const ctx = canvasContext(canvas)
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    ctx.drawImage(image, 0, 0, canvas.width, canvas.height)
    return canvas.toDataURL('image/jpeg', 0.88)
  } finally {
    releaseImage(image)
    releaseCanvas(canvas)
  }
}

export function loadImage(url: string, options: ImageOptions = {}): Promise<HTMLImageElement> {
  return imageOperation(options, async signal =>
    loadImageBlob(await fetchImageWithSignal(url, signal), signal),
  )
}

function canvasContext(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  const context = canvas.getContext('2d')
  if (!context) throw new Error('当前浏览器无法处理图片')
  return context
}

function canvasBlob(canvas: HTMLCanvasElement, options: ImageOptions = {}): Promise<Blob> {
  return imageOperation(options, signal => new Promise((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener('abort', abort)
      reject(abortReason(signal))
    }
    signal.addEventListener('abort', abort, { once: true })
    try {
      canvas.toBlob(blob => {
        signal.removeEventListener('abort', abort)
        if (signal.aborted) reject(abortReason(signal))
        else if (blob) resolve(blob)
        else reject(new Error('图片处理失败'))
      }, 'image/jpeg', 0.92)
    } catch (error) {
      signal.removeEventListener('abort', abort)
      reject(error)
    }
  }))
}

export async function readPhoto(file: File): Promise<Photo> {
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type))
    throw new Error('请选择 JPG、PNG 或 WebP 图片')
  if (file.size > MAX_FILE_BYTES) throw new Error('每张图片不能超过 10 MB')
  const url = URL.createObjectURL(file)
  try {
    const image = await loadImage(url)
    try {
      if (Math.min(image.naturalWidth, image.naturalHeight) < 64)
        throw new Error('图片边长至少为 64 像素')
      return { id: crypto.randomUUID(), name: file.name, url, file }
    } finally {
      releaseImage(image)
    }
  } catch (e) {
    URL.revokeObjectURL(url)
    throw e
  }
}

export async function normalizedFile(photo: Photo): Promise<File> {
  const image = await loadImage(photo.url)
  const scale = Math.min(
    1,
    1600 / Math.max(image.naturalWidth, image.naturalHeight),
  )
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(image.naturalWidth * scale))
  canvas.height = Math.max(1, Math.round(image.naturalHeight * scale))
  try {
    const ctx = canvasContext(canvas)
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    ctx.drawImage(image, 0, 0, canvas.width, canvas.height)
    return new File([await canvasBlob(canvas)], `${photo.id}.jpg`, {
      type: 'image/jpeg',
    })
  } finally {
    releaseImage(image)
    releaseCanvas(canvas)
  }
}

export async function garmentSheet(
  photos: Photo[],
  label = 'GARMENT',
): Promise<File> {
  if (!photos.length) throw new Error('请先选择参考图片')
  const columns = photos.length === 1 ? 1 : 2
  const rows = Math.ceil(photos.length / columns)
  const width = 720,
    height = 900
  checkImageDimensions(columns * width, rows * height)
  const canvas = document.createElement('canvas')
  canvas.width = columns * width
  canvas.height = rows * height
  try {
    const ctx = canvasContext(canvas)
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    for (let i = 0; i < photos.length; i++) {
      const image = await loadImage(photos[i].url)
      try {
        const x = (i % columns) * width,
          y = Math.floor(i / columns) * height
        const scale = Math.min(
          (width - 40) / image.naturalWidth,
          (height - 70) / image.naturalHeight,
        )
        const w = image.naturalWidth * scale,
          h = image.naturalHeight * scale
        ctx.drawImage(
          image,
          x + (width - w) / 2,
          y + 50 + (height - 60 - h) / 2,
          w,
          h,
        )
        ctx.fillStyle = '#242424'
        ctx.font = 'bold 24px sans-serif'
        ctx.fillText(`${label} ${i + 1}`, x + 20, y + 32)
      } finally {
        releaseImage(image)
      }
    }
    return new File([await canvasBlob(canvas)], 'garment-reference.jpg', {
      type: 'image/jpeg',
    })
  } finally {
    releaseCanvas(canvas)
  }
}

export async function stitchImages(urls: string[], options: ImageOptions = {}): Promise<Blob> {
  if (!urls.length) throw new Error('暂无已完成的详情模块')
  if (urls.length > 64) throw new Error('详情模块过多，请分批导出')
  return imageOperation({ ...options, timeoutMs: options.timeoutMs ?? 120_000 }, async signal => {
    const sources: { blob: Blob; width: number; height: number }[] = []
    let sourceBytes = 0
    let width = 1200
    // Retain bounded compressed bytes, never a batch of full decoded images.
    // The second pass decodes these same bytes locally without re-downloading.
    for (const url of urls) {
      const blob = await fetchImageWithSignal(
        url,
        signal,
        MAX_IMAGE_BYTES - sourceBytes,
        '详情页图片总大小超过 80 MB，请按模块下载或减少模块后导出',
      )
      sourceBytes += blob.size
      const image = await loadImageBlob(blob, signal)
      try {
        sources.push({ blob, width: image.naturalWidth, height: image.naturalHeight })
        width = Math.min(width, image.naturalWidth)
      } finally {
        releaseImage(image)
      }
    }
    const heights = sources.map(source => Math.max(1, Math.round(source.height * width / source.width)))
    const height = heights.reduce((sum, value) => sum + value, 0)
    if (height > MAX_STITCH_HEIGHT || width * height > MAX_STITCH_PIXELS)
      throw new Error('详情页过长，请按模块下载或减少模块后导出')
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    try {
      const ctx = canvasContext(canvas)
      ctx.fillStyle = '#ffffff'
      ctx.fillRect(0, 0, width, height)
      let offset = 0
      for (let index = 0; index < sources.length; index++) {
        const image = await loadImageBlob(sources[index].blob, signal)
        try {
          ctx.drawImage(image, 0, offset, width, heights[index])
          offset += heights[index]
        } finally {
          releaseImage(image)
        }
      }
      return await canvasBlob(canvas, { signal })
    } finally {
      releaseCanvas(canvas)
    }
  })
}

export async function dataURL(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(new Error('图片读取失败'))
    reader.readAsDataURL(blob)
  })
}

export function fetchImage(url: string, options: ImageOptions = {}): Promise<Blob> {
  return imageOperation(options, signal => fetchImageWithSignal(url, signal))
}

export function saveBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  document.body.append(link)
  link.click()
  link.remove()
  setTimeout(() => URL.revokeObjectURL(url), 30000)
}

export function imageExtension(blob: Blob) {
  return blob.type === 'image/jpeg'
    ? 'jpg'
    : blob.type === 'image/webp'
      ? 'webp'
      : 'png'
}
