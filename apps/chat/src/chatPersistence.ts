import { singleFlight } from './singleFlight.ts'

type LegacyStorageEntry = {
  value: unknown | null
  revision: number
}

export type LegacyChatStorage = {
  getEntry<T = unknown>(key: string): Promise<LegacyStorageEntry | null>
  delete(key: string, options?: { expectedRevision?: number }): Promise<unknown>
}

export type LocalChatState = {
  conversations: unknown
  drafts: unknown
}

type LocalValue = { available: boolean; present: boolean; value: unknown }

function readJson(storage: Storage, key: string): LocalValue {
  try {
    const serialized = storage.getItem(key)
    if (serialized === null) return { available: true, present: false, value: null }
    try {
      return { available: true, present: true, value: JSON.parse(serialized) }
    } catch {
      storage.removeItem(key)
      return { available: true, present: false, value: null }
    }
  } catch {
    return { available: false, present: false, value: null }
  }
}

function writeJson(storage: Storage, key: string, value: unknown) {
  try {
    storage.setItem(key, JSON.stringify(value))
    return true
  } catch {
    return false
  }
}

export function createLocalChatPersistence({
  storage,
  legacyStorage,
  appId,
  accountScope,
  conversationsKey,
  draftsKey,
}: {
  storage: Storage
  legacyStorage: LegacyChatStorage
  appId: string
  accountScope: string
  conversationsKey: string
  draftsKey: string
}) {
  const prefix = `proxy-app:${appId}:local:${encodeURIComponent(accountScope)}`
  const conversationLocalKey = `${prefix}:${conversationsKey}`
  const draftsLocalKey = `${prefix}:${draftsKey}`
  const migrationLocalKey = `${prefix}:chat:migrated-to-local-v1`

  const save = (key: string, value: unknown) => writeJson(storage, key, value)

  return {
    saveConversations: (value: unknown) => save(conversationLocalKey, value),
    saveDrafts: (value: unknown) => save(draftsLocalKey, value),
    async load(): Promise<LocalChatState> {
      const migrationMarker = readJson(storage, migrationLocalKey)
      const localConversations = readJson(storage, conversationLocalKey)
      const localDrafts = readJson(storage, draftsLocalKey)

      if (migrationMarker.available && migrationMarker.value !== 'done' && localConversations.available && localDrafts.available) {
        await singleFlight(`chat-history-migration:${prefix}`, async () => {
          let migrationComplete = true
          try {
            const legacyEntries = await Promise.all([
              legacyStorage.getEntry(conversationsKey),
              legacyStorage.getEntry(draftsKey),
            ])
            const keys = [conversationLocalKey, draftsLocalKey]
            const legacyKeys = [conversationsKey, draftsKey]
            for (const [index, entry] of legacyEntries.entries()) {
              if (!entry || entry.value === null) continue
              const existingLocal = readJson(storage, keys[index])
              if (!existingLocal.available) {
                migrationComplete = false
                continue
              }
              if ((!existingLocal.present || existingLocal.value === null) && !writeJson(storage, keys[index], entry.value)) {
                migrationComplete = false
                continue
              }
              try {
                const result = await legacyStorage.delete(legacyKeys[index], { expectedRevision: entry.revision })
                if (result && typeof result === 'object' && 'success' in result && result.success === false) migrationComplete = false
              } catch {
                migrationComplete = false
              }
            }
          } catch {
            migrationComplete = false
          }
          if (migrationComplete) {
            try { storage.setItem(migrationLocalKey, JSON.stringify('done')) } catch { /* Keep local state usable if the migration marker cannot be written. */ }
          }
        })
      }

      return {
        conversations: readJson(storage, conversationLocalKey).value,
        drafts: readJson(storage, draftsLocalKey).value,
      }
    },
  }
}
