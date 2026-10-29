import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { fitGalleryItem, MAX_GALLERY_ITEMS, mergeGalleryItems } from '../src/gallery-storage.ts'
import {
  generationTaskStorageKeys,
  generationTaskSubmission,
  readPendingGenerationSubmission,
  readStoredGenerationTask,
  writePendingGenerationSubmission,
  writeStoredGenerationTask,
  GENERATION_TASK_NAME,
} from '../src/gateway.ts'

function item(id: string, generatedAt: string) {
  return {
    id,
    userName: 'Tester',
    model: 'text-model',
    generatedAt,
    raw: '<svg/>',
    html: '<html><body><svg/></body></html>',
  }
}

test('gallery merge keeps the newest bounded set and de-duplicates ids', () => {
  const older = item('duplicate', '2026-03-01T00:00:00.000Z')
  const newer = item('duplicate', '2026-03-02T00:00:00.000Z')
  const values = Array.from({ length: MAX_GALLERY_ITEMS + 5 }, (_, index) => item('result-' + index, new Date(Date.UTC(2026, 0, index + 1)).toISOString()))
  const merged = mergeGalleryItems([older, ...values], [newer])

  assert.equal(merged.length, MAX_GALLERY_ITEMS)
  assert.equal(merged.filter(entry => entry.id === 'duplicate').length, 1)
  assert.equal(merged.find(entry => entry.id === 'duplicate')?.generatedAt, older.generatedAt)
  assert.equal(merged[0].id, 'result-64')
})

test('gallery payload is bounded before a shared KV write', () => {
  const value = item('result-1', '2026-01-01T00:00:00.000Z')
  const fitted = fitGalleryItem({ ...value, raw: 'r'.repeat(200_000), html: 'h'.repeat(200_000) })
  assert.equal(fitted.raw.length, 105_000)
  assert.equal(fitted.html.length, 125_000)
})

test('generation is submitted as a replay-safe Gateway task', () => {
  assert.deepEqual(generationTaskSubmission('text-model', 'Text Model', 'high', 'request-123'), {
    name: GENERATION_TASK_NAME,
    payload: { model: 'text-model', model_name: 'Text Model', reasoning_effort: 'high' },
    idempotency_key: 'request-123',
  })
})

test('task manifest allows one bounded recovery attempt', () => {
  const manifest = JSON.parse(readFileSync(new URL('../manifest.json', import.meta.url), 'utf8'))
  assert.equal(manifest.functions.task.max_attempts, 2)
})

test('task tracking survives reload without storing credentials', () => {
  const entries = new Map<string, string>()
  const storage = {
    getItem: (key: string) => entries.get(key) ?? null,
    setItem: (key: string, value: string) => { entries.set(key, value) },
    removeItem: (key: string) => { entries.delete(key) },
  }
  const keys = generationTaskStorageKeys('pelican', '0.3.7')
  const submission = {
    requestId: 'request-123',
    userId: 'user-1',
    submission: generationTaskSubmission('text-model', 'Text Model', 'high', 'request-123'),
  }

  writePendingGenerationSubmission(storage, keys.pendingSubmission, submission)
  assert.deepEqual(readPendingGenerationSubmission(storage, keys.pendingSubmission), submission)
  writeStoredGenerationTask(storage, keys.activeTask, { taskId: 'task-123', requestId: 'request-123', userId: 'user-1' })
  assert.deepEqual(readStoredGenerationTask(storage, keys.activeTask), { taskId: 'task-123', requestId: 'request-123', userId: 'user-1' })
  assert.equal([...entries.values()].some(value => /access_token|authorization/i.test(value)), false)

  writePendingGenerationSubmission(storage, keys.pendingSubmission, null)
  assert.equal(readPendingGenerationSubmission(storage, keys.pendingSubmission), null)
})

test('pending task recovery rejects malformed or mismatched idempotency data', () => {
  const storage = {
    getItem: () => JSON.stringify({
      requestId: 'request-1',
      userId: 'user-1',
      submission: generationTaskSubmission('text-model', 'Text Model', 'high', 'different-key'),
    }),
    setItem: () => {},
    removeItem: () => {},
  }
  assert.equal(readPendingGenerationSubmission(storage, 'pending'), null)
})
