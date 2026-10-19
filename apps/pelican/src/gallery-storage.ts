export const LOCAL_GALLERY_KEY = 'pelican:gallery:v1'
export const LOCAL_GALLERY_DELETIONS_KEY = 'pelican:gallery:deleted:v1'
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
  raw: string
  html: string
}

export type GalleryStorage = Pick<Storage, 'getItem' | 'setItem'>

function validGalleryItem(value: unknown): value is GalleryItem {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const item = value as Record<string, unknown>
  return typeof item.id === 'string' && typeof item.userName === 'string' && typeof item.model === 'string'
    && typeof item.generatedAt === 'string' && typeof item.raw === 'string' && typeof item.html === 'string'
}

export function fitGalleryItem(item: GalleryItem): GalleryItem {
  return { ...item, raw: item.raw.slice(0, MAX_RAW_STORAGE), html: item.html.slice(0, MAX_HTML_STORAGE) }
}

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

export function readLocalGallery(storage: GalleryStorage, key = LOCAL_GALLERY_KEY): GalleryItem[] {
  const raw = storage.getItem(key)
  if (!raw) return []
  try {
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) ? mergeGalleryItems(parsed.filter(validGalleryItem)) : []
  } catch {
    return []
  }
}

export function writeLocalGalleryItems(items: readonly GalleryItem[], storage: GalleryStorage, key = LOCAL_GALLERY_KEY): GalleryItem[] {
  const normalized = mergeGalleryItems(items.map(fitGalleryItem))
  let next = normalized
  while (next.length) {
    try {
      storage.setItem(key, JSON.stringify(next))
      return next
    } catch (error) {
      if (!isQuotaError(error) || next.length === 1) throw error
      next = next.slice(0, -1)
    }
  }
  storage.setItem(key, '[]')
  return []
}

export function readDeletedGalleryIds(storage: GalleryStorage, key = LOCAL_GALLERY_DELETIONS_KEY): string[] {
  const raw = storage.getItem(key)
  if (!raw) return []
  try {
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : []
  } catch {
    return []
  }
}

function isQuotaError(error: unknown) {
  if (!error || typeof error !== 'object') return false
  const candidate = error as { name?: string; code?: number }
  return candidate.name === 'QuotaExceededError' || candidate.name === 'NS_ERROR_DOM_QUOTA_REACHED' || candidate.code === 22 || candidate.code === 1014
}

/** Stores newest results first and drops oldest browser copies only when quota requires it. */
export function writeLocalGallery(item: GalleryItem, storage: GalleryStorage, key = LOCAL_GALLERY_KEY): GalleryItem[] {
  let items = mergeGalleryItems([fitGalleryItem(item)], readLocalGallery(storage, key))
  try {
    const deleted = readDeletedGalleryIds(storage).filter(id => id !== item.id)
    storage.setItem(LOCAL_GALLERY_DELETIONS_KEY, JSON.stringify(deleted))
  } catch {
    // The result itself is the important write; tombstone cleanup is best effort.
  }
  return writeLocalGalleryItems(items, storage, key)
}

export function deleteLocalGalleryItem(id: string, storage: GalleryStorage, key = LOCAL_GALLERY_KEY): GalleryItem[] {
  const deleted = new Set(readDeletedGalleryIds(storage))
  deleted.add(id)
  storage.setItem(LOCAL_GALLERY_DELETIONS_KEY, JSON.stringify([...deleted].slice(-MAX_GALLERY_ITEMS * 2)))
  const items = readLocalGallery(storage, key).filter(item => item.id !== id)
  storage.setItem(key, JSON.stringify(items))
  return items
}
