import assert from 'node:assert/strict'
import test from 'node:test'
import {
  imageModelAvailabilityMessage,
  imageModels,
  selectImageEditModel,
  type ImageModel,
} from '../src/core.ts'

const editor: ImageModel = {
  id: 'image-editor',
  available: true,
  supported_operations: ['generation', 'edit'],
  max_input_images: 2,
}

test('empty image catalogs and catalogs without editing give different configuration guidance', () => {
  assert.match(imageModelAvailabilityMessage([]), /图片模型列表为空/)
  for (const model of [
    { id: 'text-to-image', supported_operations: ['generation'] },
    { id: 'undeclared-capabilities' },
  ]) {
    assert.match(imageModelAvailabilityMessage([model]), /尚未开放图片编辑能力/)
  }
})

test('unavailable gateway editors report image service availability without blaming the account', () => {
  const catalog = imageModels({
    object: 'list',
    data: [
      { ...editor, id: 'gpt-image-2', available: false, supply_status: 'unavailable', max_input_images: 16 },
      { ...editor, id: 'gpt-image-2.5', available: false, supply_status: 'unavailable', max_input_images: 9 },
      { id: 'generation-only', available: true, supported_operations: ['generation'] },
    ],
  })
  const message = imageModelAvailabilityMessage(catalog)
  assert.match(message, /图片编辑服务暂不可用/)
  assert.match(message, /供应通道/)
  assert.match(message, /管理员/)
  assert.doesNotMatch(message, /账户|权限|余额|未开放图片编辑/)
  assert.equal(selectImageEditModel(catalog), undefined)
})

test('editors without usable image input report capability configuration even if another editor is unavailable', () => {
  for (const max_input_images of [undefined, 0, -1]) {
    const catalog = [
      { ...editor, max_input_images },
      { ...editor, id: 'unavailable-editor', available: false },
    ]
    assert.match(imageModelAvailabilityMessage(catalog), /参考图数量/)
    assert.equal(selectImageEditModel(catalog), undefined)
  }
})

test('a usable editor clears the warning and is selected among unavailable and unsupported models', () => {
  const catalog = [
    { ...editor, id: 'offline', available: false },
    { ...editor, id: 'generation-only', supported_operations: ['generation'] },
    { ...editor, id: 'no-reference-input', max_input_images: 0 },
    editor,
  ]
  assert.equal(imageModelAvailabilityMessage(catalog), '')
  assert.equal(selectImageEditModel(catalog)?.id, editor.id)
})

test('refresh replaces a selected model that is now unavailable or no longer supports image editing', () => {
  for (const changed of [
    { ...editor, available: false },
    { ...editor, supported_operations: ['generation'] },
    { ...editor, max_input_images: 0 },
    { ...editor, max_input_images: undefined },
  ]) {
    const replacement = { ...editor, id: 'replacement' }
    assert.equal(selectImageEditModel([changed, replacement], editor.id)?.id, replacement.id)
    assert.equal(selectImageEditModel([changed], editor.id), undefined)
  }
  assert.equal(selectImageEditModel([], editor.id), undefined)
})

test('saved and current selections use the same eligibility checks and preserve preference order', () => {
  const current = { ...editor, id: 'current' }
  const saved = { ...editor, id: 'saved' }
  const catalog = [editor, current, saved]
  assert.equal(selectImageEditModel(catalog, saved.id, current.id)?.id, saved.id)
  assert.equal(selectImageEditModel(catalog, 'removed-model', current.id)?.id, current.id)
  for (const invalid of [
    { ...saved, available: false },
    { ...saved, supported_operations: ['generation'] },
    { ...saved, max_input_images: 0 },
  ]) {
    assert.equal(selectImageEditModel([editor, current, invalid], saved.id, current.id)?.id, current.id)
  }
})

test('legacy catalogs without an availability flag still accept explicitly declared editors', () => {
  const legacy = { ...editor, available: undefined }
  assert.equal(selectImageEditModel([legacy], legacy.id)?.id, legacy.id)
  assert.equal(imageModelAvailabilityMessage([legacy]), '')
})
