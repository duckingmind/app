import assert from 'node:assert/strict'
import test from 'node:test'
import { createLocalChatPersistence } from '../src/chatPersistence.ts'

function memoryStorage(): Storage & { values: Map<string, string> } {
  const values = new Map<string, string>()
  return {
    values,
    get length() { return values.size },
    clear() { values.clear() },
    getItem(key) { return values.get(key) ?? null },
    key(index) { return [...values.keys()][index] ?? null },
    removeItem(key) { values.delete(key) },
    setItem(key, value) { values.set(key, String(value)) },
  }
}

function persistence(storage: Storage, accountScope: string, legacyStorage = {
  getEntry: async () => null,
  delete: async () => ({ success: true }),
}) {
  return createLocalChatPersistence({
    storage,
    legacyStorage,
    appId: 'chat',
    accountScope,
    conversationsKey: 'chat:conversations',
    draftsKey: 'chat:drafts',
  })
}

test('chat history and drafts are stored locally and isolated by platform account', async () => {
  const storage = memoryStorage()
  const firstAccount = persistence(storage, 'account-one')
  const secondAccount = persistence(storage, 'account-two')
  const conversations = [{ id: 'conversation-1', messages: [{ role: 'user', content: '本地记录' }] }]
  const drafts = { 'conversation-1:chat': { input: '草稿', references: [] } }

  assert.equal(firstAccount.saveConversations(conversations), true)
  assert.equal(firstAccount.saveDrafts(drafts), true)
  assert.deepEqual(await firstAccount.load(), { conversations, drafts })
  assert.deepEqual(await secondAccount.load(), { conversations: null, drafts: null })
  assert.ok([...storage.values.keys()].some((key) => key.includes('account-one')))
  assert.ok(![...storage.values.keys()].some((key) => key.includes('account-two:chat:conversations')))
})

test('legacy item records migrate locally and are deleted with their expected revision', async () => {
  const storage = memoryStorage()
  const legacyConversations = [{ id: 'old-conversation', messages: [{ role: 'user', content: '迁移内容' }] }]
  const legacyDrafts = { 'old-conversation:chat': { input: '旧草稿', references: [] } }
  const deleted: Array<{ key: string; expectedRevision?: number }> = []
  const legacyStorage = {
    getEntry: async (key: string) => key === 'chat:conversations'
      ? { value: legacyConversations, revision: 3 }
      : { value: legacyDrafts, revision: 7 },
    delete: async (key: string, options?: { expectedRevision?: number }) => {
      deleted.push({ key, expectedRevision: options?.expectedRevision })
      return { success: true }
    },
  }
  const local = persistence(storage, 'account-one', legacyStorage)

  assert.deepEqual(await local.load(), { conversations: legacyConversations, drafts: legacyDrafts })
  assert.deepEqual(deleted, [
    { key: 'chat:conversations', expectedRevision: 3 },
    { key: 'chat:drafts', expectedRevision: 7 },
  ])
  assert.deepEqual(await local.load(), { conversations: legacyConversations, drafts: legacyDrafts })
  assert.equal(deleted.length, 2)
})

test('local chat records win over legacy item data during migration', async () => {
  const storage = memoryStorage()
  const local = persistence(storage, 'account-one')
  const currentConversations = [{ id: 'current', messages: [] }]
  local.saveConversations(currentConversations)
  const deleted: string[] = []
  const migration = persistence(storage, 'account-one', {
    getEntry: async (key: string) => ({ value: [{ id: `legacy-${key}`, messages: [] }], revision: 1 }),
    delete: async (key: string) => { deleted.push(key); return { success: true } },
  })

  const result = await migration.load()
  assert.deepEqual(result.conversations, currentConversations)
  assert.deepEqual(deleted, ['chat:conversations', 'chat:drafts'])
})

test('simultaneous startup effects share the same legacy migration reads', async () => {
  const storage = memoryStorage()
  const readKeys: string[] = []
  const deletedKeys: string[] = []
  const legacyStorage = {
    getEntry: async (key: string) => {
      readKeys.push(key)
      await new Promise((resolve) => setTimeout(resolve, 5))
      return { value: null, revision: 1 }
    },
    delete: async (key: string) => {
      deletedKeys.push(key)
      return { success: true }
    },
  }
  const firstMount = persistence(storage, 'account-one', legacyStorage)
  const strictModeMount = persistence(storage, 'account-one', legacyStorage)

  await Promise.all([firstMount.load(), strictModeMount.load()])
  assert.deepEqual(readKeys.sort(), ['chat:conversations', 'chat:drafts'])
  assert.deepEqual(deletedKeys, [])
})
