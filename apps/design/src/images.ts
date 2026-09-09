export type Photo = { id: string; name: string; url: string; file?: File }

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

export async function reviewImage(url: string) {
  const image = await loadImage(url)
  const scale = Math.min(1, 1200 / Math.max(image.naturalWidth, image.naturalHeight))
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(image.naturalWidth * scale))
  canvas.height = Math.max(1, Math.round(image.naturalHeight * scale))
  const ctx = canvas.getContext('2d')!
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  ctx.drawImage(image, 0, 0, canvas.width, canvas.height)
  return canvas.toDataURL('image/jpeg', 0.88)
}
const MAX_FILE_BYTES = 10 * 1024 * 1024

export function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image()
    image.crossOrigin = 'anonymous'
    image.onload = () => resolve(image)
    image.onerror = () =>
      reject(new Error('图片加载失败，请重新上传或更换图片'))
    image.src = url
  })
}

function canvasBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) =>
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('图片处理失败'))),
      'image/jpeg',
      0.92,
    ),
  )
}

export async function readPhoto(file: File): Promise<Photo> {
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type))
    throw new Error('请选择 JPG、PNG 或 WebP 图片')
  if (file.size > MAX_FILE_BYTES) throw new Error('每张图片不能超过 10 MB')
  const url = URL.createObjectURL(file)
  try {
    const image = await loadImage(url)
    if (image.naturalWidth * image.naturalHeight > 40000000)
      throw new Error('图片尺寸过大，请压缩到 4000 万像素以内')
    if (Math.min(image.naturalWidth, image.naturalHeight) < 64)
      throw new Error('图片边长至少为 64 像素')
    return { id: crypto.randomUUID(), name: file.name, url, file }
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
  canvas.width = Math.round(image.naturalWidth * scale)
  canvas.height = Math.round(image.naturalHeight * scale)
  const ctx = canvas.getContext('2d')!
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  ctx.drawImage(image, 0, 0, canvas.width, canvas.height)
  return new File([await canvasBlob(canvas)], `${photo.id}.jpg`, {
    type: 'image/jpeg',
  })
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
  const canvas = document.createElement('canvas')
  canvas.width = columns * width
  canvas.height = rows * height
  const ctx = canvas.getContext('2d')!
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  for (let i = 0; i < photos.length; i++) {
    const image = await loadImage(photos[i].url)
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
  }
  return new File([await canvasBlob(canvas)], 'garment-reference.jpg', {
    type: 'image/jpeg',
  })
}

export async function stitchImages(urls: string[]): Promise<Blob> {
  if (!urls.length) throw new Error('暂无已完成的详情模块')
  const images = await Promise.all(urls.map(loadImage))
  const width = Math.min(1200, ...images.map((image) => image.naturalWidth))
  const heights = images.map((image) =>
    Math.round((image.naturalHeight * width) / image.naturalWidth),
  )
  const height = heights.reduce((sum, value) => sum + value, 0)
  if (height > 30000)
    throw new Error('详情页过长，请按模块下载或减少模块后导出')
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')!
  let offset = 0
  images.forEach((image, index) => {
    ctx.drawImage(image, 0, offset, width, heights[index])
    offset += heights[index]
  })
  return canvasBlob(canvas)
}

export async function dataURL(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(new Error('图片读取失败'))
    reader.readAsDataURL(blob)
  })
}

export async function fetchImage(url: string): Promise<Blob> {
  if (!/^(https?:\/\/|data:image\/(png|jpeg|webp);base64,|blob:)/i.test(url))
    throw new Error('图片地址无效')
  const response = await fetch(url, { credentials: 'omit' })
  if (!response.ok) throw new Error('图片下载失败，链接可能已过期')
  const blob = await response.blob()
  if (!blob.type.startsWith('image/')) throw new Error('返回内容不是图片')
  return blob
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
