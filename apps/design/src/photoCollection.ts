import type { Photo } from './images.ts'

export type PhotoUpdate = Photo[] | ((previous: Photo[]) => Photo[])
export type PhotoSnapshot = { photos: Photo[]; loading: boolean }

type CollectionOptions = {
  limit: number
  readPhoto: (file: File) => Promise<Photo>
  revokeObjectURL: (url: string) => void
  onError: (message: string) => void
  limitMessage?: () => string | undefined
}

function fileKey(file: File) {
  return JSON.stringify([file.name, file.size, file.type, file.lastModified])
}

function uniquePhotos(photos: Photo[]) {
  const ids = new Set<string>()
  const urls = new Set<string>()
  const files = new Set<string>()
  return photos.filter((photo) => {
    const file = photo.file && fileKey(photo.file)
    if (ids.has(photo.id) || urls.has(photo.url) || (file && files.has(file)))
      return false
    ids.add(photo.id)
    urls.add(photo.url)
    if (file) files.add(file)
    return true
  })
}

/** Owns only object URLs returned by readPhoto; caller-provided examples stay borrowed. */
export function createPhotoCollection(options: CollectionOptions) {
  let snapshot: PhotoSnapshot = { photos: [], loading: false }
  let active = true
  let lifetime = 0
  let pending: { photos: Photo[] } | undefined
  const ownedUrls = new Set<string>()
  const listeners = new Set<() => void>()

  function notify() {
    for (const listener of listeners) listener()
  }

  function releaseUnused() {
    const retained = new Set([
      ...snapshot.photos.map((photo) => photo.url),
      ...(pending?.photos.map((photo) => photo.url) || []),
    ])
    for (const url of ownedUrls) {
      if (retained.has(url)) continue
      ownedUrls.delete(url)
      options.revokeObjectURL(url)
    }
  }

  function limitError() {
    options.onError(
      options.limitMessage?.() ||
        `最多上传 ${options.limit} 张图片，请减少所选图片数量`,
    )
  }

  function setPhotos(update: PhotoUpdate) {
    if (!active) return
    const photos = uniquePhotos(
      typeof update === 'function' ? update([...snapshot.photos]) : update,
    )
    if (photos.length > options.limit) {
      limitError()
      return
    }
    // Replacement, removal and reset all invalidate an in-flight upload batch.
    pending = undefined
    snapshot = { photos, loading: false }
    releaseUnused()
    notify()
  }

  async function add(files: File[]): Promise<Photo[]> {
    if (!active || pending || !files.length) return []
    const existing = new Set(
      snapshot.photos.flatMap((photo) => (photo.file ? [fileKey(photo.file)] : [])),
    )
    const selected = files.filter((file) => {
      const key = fileKey(file)
      if (existing.has(key)) return false
      existing.add(key)
      return true
    })
    if (!selected.length) return []
    if (snapshot.photos.length + selected.length > options.limit) {
      limitError()
      return []
    }
    const operation = { photos: [] as Photo[] }
    pending = operation
    snapshot = { ...snapshot, loading: true }
    notify()
    try {
      for (const file of selected) {
        const photo = await options.readPhoto(file)
        if (photo.url.startsWith('blob:')) ownedUrls.add(photo.url)
        if (!active || pending !== operation) return []
        operation.photos.push(photo)
      }
      // Validate against the current collection when decoding finishes, too.
      const photos = uniquePhotos([...snapshot.photos, ...operation.photos])
      if (photos.length > options.limit) {
        limitError()
        return []
      }
      const accepted = photos.filter((photo) => !snapshot.photos.includes(photo))
      pending = undefined
      snapshot = { photos, loading: false }
      releaseUnused()
      notify()
      return accepted
    } catch (error) {
      if (active && pending === operation)
        options.onError(error instanceof Error ? error.message : '图片读取失败')
      return []
    } finally {
      // A cancelled upload must not clear the loading state of its replacement.
      if (pending === operation) {
        pending = undefined
        snapshot = { ...snapshot, loading: false }
        notify()
      }
      releaseUnused()
    }
  }

  return {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    setPhotos,
    add,
    remove: (id: string) => setPhotos((photos) => photos.filter((photo) => photo.id !== id)),
    clear: () => setPhotos([]),
    mount() {
      active = true
      const lease = ++lifetime
      return () => {
        if (lease !== lifetime) return
        active = false
        pending = undefined
        snapshot = { ...snapshot, loading: false }
        releaseUnused()
        // React StrictMode immediately reattaches effects. Keep displayed URLs
        // alive for that replay, while rejecting late uploads synchronously.
        queueMicrotask(() => {
          if (active || lease !== lifetime) return
          snapshot = { photos: [], loading: false }
          releaseUnused()
        })
      }
    },
  }
}
