import { uploadApplicationMediaAsset } from '@ducking-mind/proxy-app-sdk'

export const MAX_REFERENCE_IMAGE_SIZE = 10 * 1024 * 1024
export const COMPRESS_REFERENCE_IMAGE_THRESHOLD = 3 * 1024 * 1024
export const TARGET_COMPRESSED_REFERENCE_IMAGE_SIZE = 4 * 1024 * 1024
export const MAX_REFERENCE_IMAGE_DIMENSION = 2048
export const SUPPORTED_REFERENCE_IMAGE_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/jpg',
  'image/webp',
  'image/gif',
])

function normalizedImageType(value: string) {
  return String(value || '').trim().toLowerCase().split(';', 1)[0]
}

export function referenceImageAccept() {
  return [...SUPPORTED_REFERENCE_IMAGE_TYPES].join(',')
}

function compressedReferenceName(name: string, mimeType: string) {
  const extension = mimeType === 'image/jpeg' ? 'jpg' : 'webp'
  const base = name.replace(/\.[^.]+$/, '')
  return `${base || 'image'}.${extension}`
}

function loadImageFile(file: File) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const url = URL.createObjectURL(file)
    const image = new Image()
    image.onload = () => {
      URL.revokeObjectURL(url)
      resolve(image)
    }
    image.onerror = () => {
      URL.revokeObjectURL(url)
      reject(new Error('图片读取失败'))
    }
    image.src = url
  })
}

function canvasBlob(canvas: HTMLCanvasElement, type: string, quality: number) {
  return new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, type, quality))
}

/** Match the portal's image upload limits while keeping app uploads on the shared asset flow. */
export async function prepareReferenceImageFile(file: File, maxSize = MAX_REFERENCE_IMAGE_SIZE): Promise<File> {
  const type = normalizedImageType(file.type)
  if (!SUPPORTED_REFERENCE_IMAGE_TYPES.has(type)) throw new Error('目前仅支持 PNG、JPG、WebP 或 GIF 图片')
  if (file.size <= 0) throw new Error('图片文件为空')
  if (file.size <= COMPRESS_REFERENCE_IMAGE_THRESHOLD) return file

  const image = await loadImageFile(file)
  const dimensions = [MAX_REFERENCE_IMAGE_DIMENSION, 1600, 1280, 1024]
  const qualities = [0.86, 0.78, 0.7, 0.62, 0.54]
  let best: Blob | null = null

  for (const maxDimension of dimensions) {
    const scale = Math.min(1, maxDimension / Math.max(image.naturalWidth || image.width, image.naturalHeight || image.height))
    const width = Math.max(1, Math.round((image.naturalWidth || image.width) * scale))
    const height = Math.max(1, Math.round((image.naturalHeight || image.height) * scale))
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const context = canvas.getContext('2d')
    if (!context) continue
    context.drawImage(image, 0, 0, width, height)

    for (const quality of qualities) {
      const blob = await canvasBlob(canvas, 'image/webp', quality) || await canvasBlob(canvas, 'image/jpeg', quality)
      if (!blob) continue
      if (!best || blob.size < best.size) best = blob
      if (blob.size <= TARGET_COMPRESSED_REFERENCE_IMAGE_SIZE) {
        return new File([blob], compressedReferenceName(file.name, blob.type), { type: blob.type, lastModified: Date.now() })
      }
    }
  }

  if (best && best.size <= maxSize) {
    return new File([best], compressedReferenceName(file.name, best.type), { type: best.type, lastModified: Date.now() })
  }
  if (file.size <= maxSize) return file
  throw new Error(`图片压缩后仍超过 ${Math.round(maxSize / 1024 / 1024)} MiB，请换一张较小的图片`)
}

export type ClipboardImageItem = {
  kind?: string
  type?: string
  getAsFile?: () => File | null
}

export type ClipboardImageData = {
  files?: ArrayLike<File> | null
  items?: ArrayLike<ClipboardImageItem> | null
}

const imageExtension = (contentType: string) => {
  const subtype = contentType.toLowerCase().split('/', 2)[1] || 'png'
  return subtype === 'jpeg' ? 'jpg' : subtype.replace(/[^a-z0-9]+/g, '') || 'png'
}

/**
 * Browsers expose a pasted screenshot through ClipboardItem#getAsFile().
 * clipboardData.files is populated for file-manager copies only, so prefer
 * image items when present and fall back to the FileList for copied files.
 */
export function clipboardImageFiles(data: ClipboardImageData): File[] {
  const itemFiles = Array.from(data.items || [])
    .filter((item) => item?.kind === 'file' || typeof item?.getAsFile === 'function')
    .map((item, index) => {
      const file = item.getAsFile?.()
      if (!file) return null
      const contentType = normalizedImageType(String(file.type || item.type || ''))
      if (!SUPPORTED_REFERENCE_IMAGE_TYPES.has(contentType)) return null
      if (file.name) return file
      return new File([file], `pasted-image-${index + 1}.${imageExtension(contentType)}`, {
        type: contentType,
        lastModified: file.lastModified || Date.now(),
      })
    })
    .filter((file): file is File => Boolean(file))
  if (itemFiles.length) return itemFiles
  return Array.from(data.files || []).filter((file) => SUPPORTED_REFERENCE_IMAGE_TYPES.has(normalizedImageType(file.type)))
}

export type ReferenceAssetResponse = {
  id?: unknown
  type?: unknown
  content_type?: unknown
  size_bytes?: unknown
  url?: unknown
  content_url?: unknown
  thumbnail_url?: unknown
}

export type ReferenceAsset = {
  id: string
  type: 'image'
  contentType?: string
  sizeBytes?: number
  url?: string
  thumbnailURL?: string
}

export function responsesContentWithImages(content: string, imageURLs: string[]): unknown {
  const parts: Array<Record<string, unknown>> = []
  const text = content.trim()
  if (text) parts.push({ type: 'input_text', text })
  for (const url of imageURLs) {
    if (url.trim()) parts.push({ type: 'input_image', image_url: url.trim() })
  }
  if (parts.length === 1 && parts[0].type === 'input_text') return text
  return parts
}

/** Video tasks receive durable COS URLs instead of another inline byte copy. */
export function videoImageReference(url: string): Record<string, unknown> {
  const value = url.trim()
  let parsed: URL
  try { parsed = new URL(value) } catch { throw new Error('视频参考图片缺少可用的云端地址') }
  const host = parsed.hostname.toLowerCase()
  const localHTTP = parsed.protocol === 'http:' && (
    host === 'localhost' || host.endsWith('.localhost') || host === '127.0.0.1' || host === '::1' || host === '[::1]'
  )
  if ((parsed.protocol !== 'https:' && !localHTTP) || parsed.username || parsed.password) {
    throw new Error('视频参考图片缺少可用的云端地址')
  }
  return { type: 'image_url', image_url: { url: value } }
}

export function referenceAssetFromResponse(value: unknown, expectedSize?: number): ReferenceAsset {
  const record = value && typeof value === 'object' ? value as ReferenceAssetResponse : {}
  const id = typeof record.id === 'string' ? record.id.trim() : ''
  const type = typeof record.type === 'string' ? record.type.trim().toLowerCase() : ''
  const contentType = typeof record.content_type === 'string' ? record.content_type.trim().toLowerCase() : ''
  const sizeBytes = typeof record.size_bytes === 'number' ? record.size_bytes : undefined
  if (!id || type !== 'image' || (expectedSize !== undefined && sizeBytes !== undefined && sizeBytes !== expectedSize)) {
    throw new Error('平台返回了无效的图片资产')
  }
  return {
    id,
    type: 'image',
    ...(contentType ? { contentType } : {}),
    ...(sizeBytes !== undefined ? { sizeBytes } : {}),
    ...((typeof record.url === 'string' && record.url.trim()) ? { url: record.url.trim() } : (typeof record.content_url === 'string' && record.content_url.trim()) ? { url: record.content_url.trim() } : {}),
    ...((typeof record.thumbnail_url === 'string' && record.thumbnail_url.trim()) ? { thumbnailURL: record.thumbnail_url.trim() } : {}),
  }
}

export type ReferenceAssetApi = {
  request<T = unknown>(path: string, options?: RequestInit): Promise<T>
}

/** Read the current delivery metadata for a durable user asset. */
export async function readReferenceAsset(api: ReferenceAssetApi, assetId: string): Promise<ReferenceAsset> {
  const safeID = encodeURIComponent(assetId.trim())
  if (!safeID || safeID === '%2F' || !assetId.trim()) throw new Error('图片资产 ID 无效')
  const response = await api.request('/media/assets/' + safeID) as unknown
  return referenceAssetFromResponse(response)
}

/**
 * Restore a reusable reference for its next operation. Chat/video only need a
 * fresh signed URL; image edits need the original bytes for their one-shot
 * multipart request.
 */
export async function restoreReferenceAsset(
  api: ReferenceAssetApi,
  assetId: string,
  fallbackName = 'reference-image.png',
  includeOriginalBytes = true,
): Promise<{ file: File; preview: string; asset: ReferenceAsset }> {
  const asset = await readReferenceAsset(api, assetId)
  const url = asset.url
  if (!url) throw new Error('图片资产暂时没有可用地址')
  const name = fallbackName.trim() || 'reference-image.png'
  if (!includeOriginalBytes) {
    const contentType = asset.contentType?.toLowerCase().startsWith('image/') ? asset.contentType : 'image/png'
    return { file: new File([], name, { type: contentType }), preview: url, asset: { ...asset, contentType } }
  }
  // A thumbnail is only a display optimization and must never be used as the
  // source bytes for a later edit.
  const downloaded = await fetch(url, { cache: 'no-store', credentials: 'omit', mode: 'cors' })
  if (!downloaded.ok) throw new Error(`图片资产读取失败（${downloaded.status}）`)
  const blob = await downloaded.blob()
  const contentType = asset.contentType?.toLowerCase().startsWith('image/') ? asset.contentType : blob.type || 'image/png'
  if (!contentType.toLowerCase().startsWith('image/')) throw new Error('图片资产内容类型无效')
  const file = new File([blob], name, { type: contentType, lastModified: Date.now() })
  return { file, preview: URL.createObjectURL(file), asset: { ...asset, contentType } }
}

export async function readReferenceAssetFile(api: ReferenceAssetApi, assetId: string, fallbackName = 'reference-image.png') {
  return restoreReferenceAsset(api, assetId, fallbackName, true)
}

export async function uploadReferenceAsset(api: ReferenceAssetApi, file: File, idempotencyKey: string): Promise<ReferenceAsset> {
  if (!file.type.toLowerCase().startsWith('image/')) throw new Error('参考素材必须是图片')
  const response = await uploadApplicationMediaAsset(api, {
    file,
    name: file.name || 'reference-image',
    idempotencyKey,
  })
  return referenceAssetFromResponse(response, file.size)
}

