import { garmentSheet, loadImage, type Photo } from './images.ts'

export type ReviewContext = {
  images: { label: string; url: string }[]
}

const MAX_IMAGE_CHARACTERS = 80000
const MAX_CONTEXT_BYTES = 180000
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const INLINE_IMAGE =
  /^data:image\/(jpeg|png|webp);base64,((?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?)$/

export function reviewContextKey(workId: string): string {
  if (typeof workId !== 'string' || !UUID.test(workId))
    throw new Error('复检素材的作品编号无效')
  return `design:review:${workId.toLowerCase()}`
}

function hasImageSignature(mime: string, base64: string): boolean {
  let bytes: string
  try {
    bytes = atob(base64.slice(0, 24))
  } catch {
    return false
  }
  const signature = (expected: number[]) =>
    expected.every((byte, index) => bytes.charCodeAt(index) === byte)
  if (mime === 'jpeg') return signature([0xff, 0xd8, 0xff])
  if (mime === 'png')
    return signature([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  return bytes.slice(0, 4) === 'RIFF' && bytes.slice(8, 12) === 'WEBP'
}

export function parseReviewContext(value: unknown): ReviewContext {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('复检素材格式不正确')
  const context = value as Record<string, unknown>
  if (
    Object.keys(context).length !== 1 ||
    !Object.hasOwn(context, 'images') ||
    !Array.isArray(context.images) ||
    context.images.length < 1 ||
    context.images.length > 2
  )
    throw new Error('复检素材需要 1 至 2 张参考预览')

  const images = context.images.map((item: unknown) => {
    if (!item || typeof item !== 'object' || Array.isArray(item))
      throw new Error('复检参考预览格式不正确')
    const image = item as Record<string, unknown>
    if (
      Object.keys(image).length !== 2 ||
      !Object.hasOwn(image, 'label') ||
      !Object.hasOwn(image, 'url') ||
      typeof image.label !== 'string' ||
      !image.label.trim() ||
      image.label.length > 80 ||
      /[\u0000-\u001f\u007f]/.test(image.label)
    )
      throw new Error('复检参考预览缺少有效标签')
    if (
      typeof image.url !== 'string' ||
      image.url.length > MAX_IMAGE_CHARACTERS
    )
      throw new Error('复检参考预览大小超过限制')
    const match = INLINE_IMAGE.exec(image.url)
    if (!match || !match[2] || !hasImageSignature(match[1], match[2]))
      throw new Error('复检素材只支持内联 JPEG、PNG 或 WebP 图片')
    return { label: image.label.trim(), url: image.url }
  })
  const parsed = { images }
  if (
    new TextEncoder().encode(JSON.stringify(parsed)).byteLength >
    MAX_CONTEXT_BYTES
  )
    throw new Error('复检素材总大小超过存储限制')
  return parsed
}

async function compressedPreview(file: File): Promise<string> {
  const objectURL = URL.createObjectURL(file)
  try {
    const image = await loadImage(objectURL)
    if (!image.naturalWidth || !image.naturalHeight)
      throw new Error('复检预览图片尺寸无效')
    const canvas = document.createElement('canvas')
    const context = canvas.getContext('2d')
    if (!context) throw new Error('当前浏览器无法准备复检预览')
    // Keep the entire reference board. Lower resolution only when JPEG quality
    // reduction alone cannot fit the Bridge storage budget.
    for (const longestEdge of [960, 816, 694, 590, 502, 426, 362, 308, 256]) {
      const scale = Math.min(
        1,
        longestEdge / Math.max(image.naturalWidth, image.naturalHeight),
      )
      canvas.width = Math.max(1, Math.round(image.naturalWidth * scale))
      canvas.height = Math.max(1, Math.round(image.naturalHeight * scale))
      context.fillStyle = '#ffffff'
      context.fillRect(0, 0, canvas.width, canvas.height)
      context.drawImage(image, 0, 0, canvas.width, canvas.height)
      for (const quality of [0.82, 0.7, 0.58, 0.46, 0.34]) {
        const preview = canvas.toDataURL('image/jpeg', quality)
        if (!preview.startsWith('data:image/jpeg;base64,'))
          throw new Error('当前浏览器无法导出复检预览')
        if (preview.length <= MAX_IMAGE_CHARACTERS) return preview
      }
    }
    throw new Error('复检预览无法压缩到存储限制内，请减少原图数量')
  } finally {
    URL.revokeObjectURL(objectURL)
  }
}

export async function prepareReviewContext(
  products: Photo[],
  references: Photo[],
): Promise<ReviewContext> {
  if (!products.length && !references.length)
    throw new Error('缺少可用于复检的原始素材')
  if (products.length > 6 || references.length > 20)
    throw new Error('复检素材最多支持 6 张商品原图和 20 张风格参考')
  const images: ReviewContext['images'] = []
  if (products.length) {
    const file = await garmentSheet(products, 'PRODUCT')
    images.push({
      label: `商品原图 PRODUCT · ${products.length} 张压缩预览，无法确认的细节需人工核对`,
      url: await compressedPreview(file),
    })
  }
  if (references.length) {
    const file = await garmentSheet(references, 'STYLE')
    images.push({
      label: `风格参考 STYLE · ${references.length} 张压缩预览，无法确认的细节需人工核对`,
      url: await compressedPreview(file),
    })
  }
  return parseReviewContext({ images })
}
