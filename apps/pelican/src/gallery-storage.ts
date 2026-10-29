export const MAX_GALLERY_ITEMS = 60
export const MAX_RAW_STORAGE = 105_000
export const MAX_HTML_STORAGE = 125_000

export type GalleryItem = {
  id: string
  userId?: string
  userName: string
  model: string
  modelId?: string
  reasoningEffort?: string
  generatedAt: string
  requestId?: string
  raw: string
  html: string
}

function validGalleryItem(value: unknown): value is GalleryItem {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const item = value as Record<string, unknown>
  return typeof item.id === 'string' && typeof item.userName === 'string' && typeof item.model === 'string'
    && typeof item.generatedAt === 'string' && typeof item.raw === 'string' && typeof item.html === 'string'
}

export function fitGalleryItem(item: GalleryItem): GalleryItem {
  return { ...item, raw: item.raw.slice(0, MAX_RAW_STORAGE), html: item.html.slice(0, MAX_HTML_STORAGE) }
}

/** De-duplicates by result id and keeps the newest bounded gallery view. */
export function mergeGalleryItems(...groups: readonly GalleryItem[][]): GalleryItem[] {
  const byId = new Map<string, GalleryItem>()
  for (const group of groups) {
    for (const item of group) {
      if (!validGalleryItem(item) || byId.has(item.id)) continue
      byId.set(item.id, item)
    }
  }
  return [...byId.values()]
    .sort((a, b) => b.generatedAt.localeCompare(a.generatedAt))
    .slice(0, MAX_GALLERY_ITEMS)
}
