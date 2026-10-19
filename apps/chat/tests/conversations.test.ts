import assert from 'node:assert/strict'
import test from 'node:test'
import { conversationKind, conversationMatchesFilter, sortConversations, type ConversationLike } from '../src/conversations.ts'

function conversation(overrides: Partial<ConversationLike> = {}): ConversationLike {
  return {
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
    mode: 'chat',
    messages: [],
    ...overrides,
  }
}

test('conversations are ordered by most recent activity with a stable creation-time tie break', () => {
  const earlier = { ...conversation(), id: 'earlier', createdAt: '2026-10-01T00:00:00.000Z' }
  const latest = { ...conversation(), id: 'latest', updatedAt: '2026-10-03T00:00:00.000Z' }
  const tieBreak = { ...conversation(), id: 'tie-break', createdAt: '2026-10-02T00:00:00.000Z' }
  const result = sortConversations([earlier, latest, tieBreak])
  assert.deepEqual(result.map((item) => item.id), ['latest', 'tie-break', 'earlier'])
})

test('mixed conversations appear in both creative mode filters', () => {
  const mixed = conversation({
    messages: [
      { role: 'user', content: 'Explain this idea', mode: 'chat' },
      { role: 'assistant', content: 'Here is an explanation', mode: 'chat' },
      { role: 'user', content: 'Create a picture', mode: 'image' },
    ],
  })
  assert.equal(conversationKind(mixed), 'mixed')
  assert.equal(conversationMatchesFilter('mixed', 'chat'), true)
  assert.equal(conversationMatchesFilter('mixed', 'image'), true)
  assert.equal(conversationMatchesFilter('image', 'chat'), false)
})

test('generated media types map to their conversation filters', () => {
  const video = conversation({ messages: [{ role: 'assistant', content: '', media: [{ type: 'video' }] }] })
  const music = conversation({ messages: [{ role: 'assistant', content: '', media: [{ type: 'audio' }] }] })
  assert.equal(conversationKind(video), 'video')
  assert.equal(conversationKind(music), 'music')
})
