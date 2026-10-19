import assert from 'node:assert/strict'
import test from 'node:test'
import { unzipSync } from 'fflate'
import type { Work } from '../src/core.ts'
import { archiveName, createWorksArchive } from '../src/workDownload.ts'

function work(patch: Partial<Work> = {}): Work {
  return {
    id: 'work-1', batch: 'batch', title: '商品主图', kind: 'product',
    scene: '', pose: '', model: 'editor', ratio: '1:1',
    createdAt: '2026-09-18T00:00:00Z', status: 'completed',
    images: [{ url: 'https://example.test/image' }], ...patch,
  }
}

test('ZIP names stay flat and portable even for hostile model titles and identifiers', async () => {
  const input = work({
    title: '../../\\../C:\\temp/恶意\u0000\u202e图片.png',
    id: '../listing/../../escape', text: '商品说明',
  })
  const blob = await createWorksArchive([input, input], {
    fetchImage: async () => new Blob(['image contents'], { type: 'image/png' }),
  })
  const files = unzipSync(new Uint8Array(await blob.arrayBuffer()))
  assert.equal(blob.type, 'application/zip')
  assert.equal(Object.keys(files).length, 4, 'identical input names must not overwrite entries')
  for (const name of Object.keys(files)) {
    assert.doesNotMatch(name, /[\\/:\u0000-\u001f\u007f\u202e]|\.\./)
    assert.ok(new TextEncoder().encode(name).length < 255)
  }
  assert.equal(new TextDecoder().decode(files[Object.keys(files).find(name => name.endsWith('.txt'))!]), '商品说明')
  assert.equal(new TextDecoder().decode(files[Object.keys(files).find(name => name.endsWith('.png'))!]), 'image contents')
})

test('filename normalization retains readable multilingual text and bounds UTF-8 length', () => {
  assert.equal(archiveName('商品 主图 (正面)'), '商品 主图 (正面)')
  assert.equal(archiveName('.../\\'), 'work')
  assert.equal(archiveName('ＣＯＮ'), '_CON')
  assert.ok(new TextEncoder().encode(archiveName('图'.repeat(200))).length <= 120)
})

test('archive budget stops before downloading remaining works', async () => {
  let requests = 0
  await assert.rejects(createWorksArchive([work(), work(), work()], {
    maxBytes: 5,
    fetchImage: async () => { requests++; return new Blob(['1234'], { type: 'image/webp' }) },
  }), /分批下载/)
  assert.equal(requests, 2)
})

test('listing-only archives work, empty exports and failed downloads are explicit errors', async () => {
  const blob = await createWorksArchive([work({ images: [], text: 'Product listing' })])
  const files = unzipSync(new Uint8Array(await blob.arrayBuffer()))
  assert.deepEqual(Object.keys(files), ['listing-01-work-1.txt'])
  await assert.rejects(createWorksArchive([work({ images: [] })]), /暂无可下载/)
  await assert.rejects(createWorksArchive([work()], { fetchImage: async () => { throw new Error('expired') } }), /expired/)
})
