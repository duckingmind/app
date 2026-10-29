import assert from 'node:assert/strict'
import test from 'node:test'
import { conversationForMode, conversationKind, conversationMatchesFilter, conversationMatchesMode, creativeTaskSummaries, messageMatchesMode, sortConversations, type ConversationLike } from '../src/conversations.ts'

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

test('switching creation type restores the newest matching conversation', () => {
  const chat = { ...conversation({ mode: 'chat', messages: [{ role: 'user', content: '聊天', mode: 'chat' }] }), id: 'chat-1', title: '聊天' }
  const olderImage = { ...conversation({ mode: 'image', updatedAt: '2026-10-02T00:00:00.000Z', messages: [{ role: 'user', content: '旧图片', mode: 'image' }] }), id: 'image-old', title: '旧图片' }
  const latestImage = { ...conversation({ mode: 'image', updatedAt: '2026-10-03T00:00:00.000Z', messages: [{ role: 'user', content: '新图片', mode: 'image' }] }), id: 'image-new', title: '新图片' }

  assert.equal(conversationForMode([chat, olderImage, latestImage], 'image')?.id, 'image-new')
  assert.equal(conversationForMode([chat], 'video'), undefined)
  assert.equal(conversationMatchesMode(chat, 'chat'), true)
  assert.equal(conversationMatchesMode(chat, 'image'), false)
})

test('music and voice conversations stay isolated despite sharing the audio workspace', () => {
  const music = conversation({ mode: 'music', messages: [{ role: 'user', content: '音乐', mode: 'music' }] })
  const voice = conversation({ mode: 'voice', messages: [{ role: 'user', content: '音色', mode: 'voice' }] })

  assert.equal(conversationForMode([music, voice], 'music'), music)
  assert.equal(conversationForMode([music, voice], 'voice'), voice)
})

test('legacy mixed histories show only the messages for the selected creation type', () => {
  const mixed = conversation({ mode: 'image', messages: [
    { role: 'user', content: '你好', mode: 'chat' },
    { role: 'assistant', content: '你好！', mode: 'chat' },
    { role: 'user', content: '生成一只猫', mode: 'image' },
  ] })

  assert.equal(conversationMatchesMode(mixed, 'chat'), true)
  assert.equal(conversationMatchesMode(mixed, 'image'), true)
  assert.deepEqual(mixed.messages.filter((message) => messageMatchesMode(message, 'image', mixed.mode)).map((message) => message.content), ['生成一只猫'])
  assert.deepEqual(mixed.messages.filter((message) => messageMatchesMode(message, 'chat', mixed.mode)).map((message) => message.content), ['你好', '你好！'])
})

test('creative task tray derives recoverable tasks across conversations', () => {
  const result = creativeTaskSummaries([
    { ...conversation({ mode: 'voice', messages: [
      { id: 'u', role: 'user', content: '温暖的声音', mode: 'voice' },
      { id: 'a', role: 'assistant', content: '', mode: 'voice', taskId: 'voice-1', state: 'stopped', createdAt: '2026-10-02T00:00:00.000Z' },
    ] }), id: 'conversation-1', title: '音色草稿' },
    { ...conversation({ messages: [
      { id: 'u2', role: 'user', content: '做一段音乐', mode: 'music' },
      { id: 'a2', role: 'assistant', content: '', mode: 'music', idempotencyKey: 'music-key', state: 'error', createdAt: '2026-10-03T00:00:00.000Z' },
    ] }), id: 'conversation-2', title: '音乐草稿' },
  ])
  assert.deepEqual(result.map((task) => [task.mode, task.status, task.prompt]), [
    ['music', 'failed', '做一段音乐'],
    ['voice', 'pending', '温暖的声音'],
  ])
})
