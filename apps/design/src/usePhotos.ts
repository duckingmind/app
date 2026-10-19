import { useEffect, useMemo, useRef, useSyncExternalStore } from 'react'
import { readPhoto } from './images.ts'
import { createPhotoCollection } from './photoCollection.ts'

export function usePhotos(
  limit: number,
  onError: (message: string) => void,
  options: { limitMessage?: string } = {},
) {
  const errorRef = useRef(onError)
  const messageRef = useRef(options.limitMessage)
  errorRef.current = onError
  messageRef.current = options.limitMessage
  const collection = useMemo(() => createPhotoCollection({
    limit,
    readPhoto,
    revokeObjectURL: (url) => URL.revokeObjectURL(url),
    onError: (message) => errorRef.current(message),
    limitMessage: () => messageRef.current,
  }), [limit])
  const snapshot = useSyncExternalStore(
    collection.subscribe,
    collection.getSnapshot,
    collection.getSnapshot,
  )
  useEffect(() => collection.mount(), [collection])

  return {
    ...snapshot,
    add: collection.add,
    setPhotos: collection.setPhotos,
    remove: collection.remove,
    clear: collection.clear,
  }
}
