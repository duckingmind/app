// A lossless 4096 × 4096 RGBA PNG can exceed 64 MiB. Keep 4K exports usable
// while bounding compressed input and the much larger decoded allocation.
export const MAX_IMAGE_BYTES = 80 * 1024 * 1024
export const MAX_IMAGE_PIXELS = 40_000_000
export const MAX_IMAGE_EDGE = 30_000
export const MAX_STITCH_PIXELS = 36_000_000
export const MAX_STITCH_HEIGHT = 30_000

export function imageMime(value: string | null): string {
  const mime = value?.split(';', 1)[0].trim().toLowerCase() || ''
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(mime))
    throw new Error('仅支持 JPG、PNG 或 WebP 图片')
  return mime
}

export function imageAddress(value: string): string {
  const url = value.trim()
  if (!url) throw new Error('图片地址无效')
  const scheme = /^[a-z][a-z\d+.-]*:/i.exec(url)?.[0].toLowerCase()
  if (scheme === 'data:') {
    const prefix = /^data:image\/(?:png|jpeg|webp);base64,/i.exec(url)
    if (!prefix) throw new Error('仅支持 JPG、PNG 或 WebP 图片')
    const payload = url.slice(prefix[0].length).replace(/[\t\n\f\r ]/g, '')
    if (payload.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4)
      throw new Error('图片超过 80 MB，请压缩后重试')
    if (!/^[a-z\d+/]*={0,2}$/i.test(payload)) throw new Error('图片地址无效')
    return prefix[0] + payload
  } else if (scheme && !['http:', 'https:', 'blob:'].includes(scheme)) {
    throw new Error('图片地址无效')
  }
  if (/[\u0000-\u001f\u007f\\]/.test(url)) throw new Error('图片地址无效')
  // No scheme means a bundled Vite asset. Keep its path relative to the app.
  return url
}

export function checkImageDimensions(width: number, height: number): void {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1)
    throw new Error('图片尺寸无效')
  if (width > MAX_IMAGE_EDGE || height > MAX_IMAGE_EDGE || width * height > MAX_IMAGE_PIXELS)
    throw new Error('图片尺寸过大，请压缩到 4000 万像素以内且单边不超过 30000 像素')
}

export function checkImageSignature(bytes: Uint8Array, mime: string): void {
  const matches = (offset: number, values: number[]) =>
    values.every((value, index) => bytes[offset + index] === value)
  const valid = mime === 'image/png'
    ? matches(0, [137, 80, 78, 71, 13, 10, 26, 10])
    : mime === 'image/jpeg'
      ? matches(0, [255, 216, 255])
      : mime === 'image/webp' && matches(0, [82, 73, 70, 70]) && matches(8, [87, 69, 66, 80])
  if (!valid) throw new Error('图片内容与格式不符，请重新上传或更换图片')
}

// Check common raster headers before handing bytes to the browser decoder.
// Unusual headers still go through the mandatory naturalWidth/Height check.
export function headerDimensions(bytes: Uint8Array, mime: string): { width: number; height: number } | undefined {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (mime === 'image/png' && bytes.length >= 24)
    return { width: view.getUint32(16), height: view.getUint32(20) }
  if (mime === 'image/webp' && bytes.length >= 30) {
    const chunk = String.fromCharCode(...bytes.subarray(12, 16))
    const uint24 = (offset: number) => bytes[offset] + bytes[offset + 1] * 256 + bytes[offset + 2] * 65536
    if (chunk === 'VP8X') return { width: uint24(24) + 1, height: uint24(27) + 1 }
    if (chunk === 'VP8 ' && bytes[23] === 157 && bytes[24] === 1 && bytes[25] === 42)
      return { width: view.getUint16(26, true) & 0x3fff, height: view.getUint16(28, true) & 0x3fff }
  }
  if (mime === 'image/webp' && bytes.length >= 25 && String.fromCharCode(...bytes.subarray(12, 16)) === 'VP8L' && bytes[20] === 47)
    return { width: 1 + bytes[21] + ((bytes[22] & 63) << 8), height: 1 + (bytes[22] >> 6) + (bytes[23] << 2) + ((bytes[24] & 15) << 10) }
  if (mime === 'image/jpeg') {
    let offset = 2
    while (offset + 3 < bytes.length && bytes[offset] === 255) {
      while (bytes[offset] === 255) offset++
      const marker = bytes[offset++]
      if (marker === 217 || marker === 218) break
      if (marker === 1 || (marker >= 208 && marker <= 216)) continue
      if (offset + 2 > bytes.length) break
      const length = view.getUint16(offset)
      if (length < 2 || offset + length > bytes.length) break
      if (length >= 7 && [192, 193, 194, 195, 197, 198, 199, 201, 202, 203, 205, 206, 207].includes(marker))
        return { width: view.getUint16(offset + 5), height: view.getUint16(offset + 3) }
      offset += length
    }
  }
  return undefined
}
