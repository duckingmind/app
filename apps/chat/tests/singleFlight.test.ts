import assert from 'node:assert/strict'
import test from 'node:test'
import { singleFlight } from '../src/singleFlight.ts'

test('concurrent reads with the same key share one request', async () => {
  let starts = 0
  let resolveRequest!: (value: string) => void
  const request = () => singleFlight('catalog:/models', () => {
    starts += 1
    return new Promise<string>((resolve) => { resolveRequest = resolve })
  })

  const first = request()
  const second = request()
  assert.equal(starts, 1)
  resolveRequest('models')
  assert.deepEqual(await Promise.all([first, second]), ['models', 'models'])

  assert.equal(await singleFlight('catalog:/models', async () => {
    starts += 1
    return 'models'
  }), 'models')
  assert.equal(starts, 2)
})

test('failed reads leave the key clear for a retry', async () => {
  let starts = 0
  const request = () => singleFlight('asset:failed-read', async () => {
    starts += 1
    if (starts === 1) throw new Error('temporary failure')
    return 'recovered'
  })

  await assert.rejects(request(), /temporary failure/)
  assert.equal(await request(), 'recovered')
  assert.equal(starts, 2)
})
