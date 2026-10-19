import assert from 'node:assert/strict'
import test from 'node:test'
import type { Api } from '../src/core.ts'
import { selectImageEditModel } from '../src/core.ts'
import { loadModelCatalog, ModelCatalogLoadError } from '../src/modelCatalog.ts'
import { selectTextModel } from '../src/textModels.ts'

test('catalog refresh only reads both model endpoints and replaces removed selections', async () => {
  const calls: string[] = []
  const api: Api = { request: async <T>(path: string, init?: Parameters<Api['request']>[1]) => {
    calls.push(path)
    assert.equal(init?.method, 'GET')
    assert.equal(init?.body, undefined)
    if (path === '/images/models') return { data: [{
      id: 'new-editor', available: true, supported_operations: ['edit'], max_input_images: 6,
    }] } as T
    if (path === '/models') return { data: [{ id: 'new-editor' }, { id: 'gpt-5.5' }] } as T
    throw new Error(`unexpected request: ${path}`)
  } }
  const catalog = await loadModelCatalog(api)
  assert.deepEqual(calls, ['/images/models', '/models'])
  assert.deepEqual(catalog.text.map(model => model.id), ['gpt-5.5'])
  assert.equal(selectImageEditModel(catalog.images, 'removed-editor')?.id, 'new-editor')
  assert.equal(selectTextModel(catalog.text, undefined, 'gpt-5.4'), 'gpt-5.5')
})

test('a failed image endpoint still publishes text models and exposes a diagnostic', async () => {
  const failure = new Error('image catalog unavailable')
  const api: Api = { request: async <T>(path: string) => {
    if (path === '/images/models') throw failure
    return { data: [{ id: 'gpt-5.5' }] } as T
  } }
  const catalog = await loadModelCatalog(api)
  assert.deepEqual(catalog.images, [])
  assert.deepEqual(catalog.text.map(model => model.id), ['gpt-5.5'])
  assert.equal(catalog.errors?.images, failure)
  assert.equal(catalog.errors?.text, undefined)
})

test('a failed text endpoint still publishes image models and exposes a diagnostic', async () => {
  const failure = new Error('text catalog unavailable')
  const api: Api = { request: async <T>(path: string) => {
    if (path === '/models') throw failure
    return { data: [{ id: 'new-editor', supported_operations: ['edit'] }] } as T
  } }
  const catalog = await loadModelCatalog(api)
  assert.deepEqual(catalog.images.map(model => model.id), ['new-editor'])
  assert.deepEqual(catalog.text, [])
  assert.equal(catalog.errors?.images, undefined)
  assert.equal(catalog.errors?.text, failure)
})

test('an initial refresh rejects with both endpoint errors when neither side is available', async () => {
  const imageFailure = new Error('image catalog unavailable')
  const textFailure = new Error('text catalog unavailable')
  const api: Api = { request: async <T>(path: string) => {
    if (path === '/images/models') throw imageFailure
    if (path === '/models') throw textFailure
    return {} as T
  } }
  await assert.rejects(loadModelCatalog(api), error => {
    assert.ok(error instanceof ModelCatalogLoadError)
    assert.equal(error.errors.images, imageFailure)
    assert.equal(error.errors.text, textFailure)
    return true
  })
})

test('a later partial refresh retains the last successful side and filters stale text models', async () => {
  let failText = false
  let useNewImage = false
  const api: Api = { request: async <T>(path: string) => {
    if (path === '/models' && failText) throw new Error('text catalog unavailable')
    if (path === '/images/models') return { data: [
      { id: useNewImage ? 'new-editor' : 'old-editor', supported_operations: ['edit'] },
    ] } as T
    return { data: [{ id: 'old-editor' }, { id: 'new-editor' }, { id: 'gpt-5.5' }] } as T
  } }
  const first = await loadModelCatalog(api)
  assert.deepEqual(first.text.map(model => model.id), ['new-editor', 'gpt-5.5'])

  failText = true
  useNewImage = true
  const second = await loadModelCatalog(api)
  assert.deepEqual(second.images.map(model => model.id), ['new-editor'])
  assert.deepEqual(second.text.map(model => model.id), ['gpt-5.5'])
  assert.ok(second.errors?.text)
})

test('a refresh stays pending until both requests settle even after one fails', async () => {
  let finishText: ((value: unknown) => void) | undefined
  const textResult = new Promise(resolve => { finishText = resolve })
  const failure = new Error('image catalog unavailable')
  const api: Api = { request: async <T>(path: string) => {
    if (path === '/images/models') throw failure
    return await textResult as T
  } }
  let settled = false
  const pending = loadModelCatalog(api).then(
    (catalog) => {
      settled = true
      assert.equal(catalog.errors?.images, failure)
    },
  )
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(settled, false)
  finishText?.({ data: [] })
  await pending
  assert.equal(settled, true)
})
