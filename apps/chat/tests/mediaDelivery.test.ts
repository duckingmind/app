import test from 'node:test'
import assert from 'node:assert/strict'
import { deliverMediaAssets } from '../src/mediaDelivery.ts'

test('media delivery keeps signed object storage URLs and reads metadata only when needed', async () => {
  const calls: string[] = []
  const api = {
    async request<T>(path: string): Promise<T> {
      calls.push(path)
      return { content_url: 'https://bucket.cos.example/media/result.mp4?signature=short-lived' } as T
    },
  }
  const assets = await deliverMediaAssets(api, [
    { id: 'ready', type: 'video', url: 'https://bucket.cos.example/ready.mp4?signature=valid' },
    { id: 'refresh', assetId: 'asset-1', type: 'audio', url: '' },
  ])

  assert.equal(assets[0].url, 'https://bucket.cos.example/ready.mp4?signature=valid')
  assert.equal(assets[1].url, 'https://bucket.cos.example/media/result.mp4?signature=short-lived')
  assert.deepEqual(calls, ['/media/assets/asset-1'])
})

test('media delivery preserves asset identity without downloading bytes when metadata refresh fails', async () => {
  const calls: string[] = []
  const api = {
    async request<T>(path: string): Promise<T> {
      calls.push(path)
      throw new Error('asset metadata unavailable')
    },
  }
  const [asset] = await deliverMediaAssets(api, [
    { id: 'video-1', assetId: 'asset-1', type: 'video', url: '' },
  ])

  assert.equal(asset.assetId, 'asset-1')
  assert.equal(asset.url, '')
  assert.deepEqual(calls, ['/media/assets/asset-1'])
})
