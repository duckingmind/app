import { Zip, ZipPassThrough } from 'fflate'
import type { Work } from './core.ts'
import { fetchImage, imageExtension } from './images.ts'

const MAX_ARCHIVE_BYTES = 128 * 1024 * 1024
const encoder = new TextEncoder()

/** Keep model titles and restored identifiers within a single portable filename. */
export function archiveName(value: string): string {
  const cleaned = value.normalize('NFKC')
    .replace(/[^\p{L}\p{N}\p{M} _()-]+/gu, '_')
    .replace(/\s+/g, ' ')
    .replace(/^[ _-]+|[ _-]+$/g, '')
  let name = ''
  let bytes = 0
  for (const character of cleaned) {
    bytes += encoder.encode(character).length
    if (bytes > 120) break
    name += character
  }
  name = name.trim() || 'work'
  return /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(name) ? `_${name}` : name
}

/** Append each file in chunks; never hold a second complete copy of every image. */
export async function createWorksArchive(
  works: Work[],
  options: { fetchImage?: typeof fetchImage; maxBytes?: number } = {},
): Promise<Blob> {
  const maximum = options.maxBytes ?? MAX_ARCHIVE_BYTES
  const download = options.fetchImage ?? fetchImage
  const chunks: BlobPart[] = []
  let failure: Error | null = null
  let finished = false
  let totalBytes = 0
  let entries = 0
  const archive = new Zip((error, data, final) => {
    if (error) failure = error
    else chunks.push(new Uint8Array(data))
    finished = final
  })

  async function append(name: string, blob: Blob) {
    if (totalBytes + blob.size > maximum)
      throw new Error('本次打包内容过大，请减少作品数量后分批下载')
    totalBytes += blob.size
    const entry = new ZipPassThrough(name)
    archive.add(entry)
    const reader = blob.stream().getReader()
    let sinceYield = 0
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        entry.push(value)
        if (failure) throw failure
        sinceYield += value.byteLength
        if (sinceYield >= 1024 * 1024) {
          await new Promise<void>(resolve => setTimeout(resolve, 0))
          sinceYield = 0
        }
      }
      entry.push(new Uint8Array(), true)
      if (failure) throw failure
      entries++
    } finally {
      await reader.cancel().catch(() => undefined)
      reader.releaseLock()
    }
  }

  try {
    let imageIndex = 0
    let listingIndex = 0
    for (const work of works) {
      for (const image of work.images) {
        const blob = await download(image.url)
        const prefix = String(++imageIndex).padStart(2, '0')
        await append(`${prefix}-${archiveName(work.title)}.${imageExtension(blob)}`, blob)
      }
      if (work.text) {
        const prefix = String(++listingIndex).padStart(2, '0')
        await append(`listing-${prefix}-${archiveName(work.id)}.txt`, new Blob([work.text]))
      }
    }
    if (!entries) throw new Error('暂无可下载的作品')
    archive.end()
    if (failure) throw failure
    if (!finished) throw new Error('作品打包未完成，请重新下载')
    return new Blob(chunks, { type: 'application/zip' })
  } finally {
    archive.terminate()
  }
}
