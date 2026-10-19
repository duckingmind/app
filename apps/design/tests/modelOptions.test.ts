import assert from 'node:assert/strict'
import test from 'node:test'
import type { ImageModel } from '../src/core.ts'
import { imageModelIssue, imageModelOptions } from '../src/modelOptions.ts'

const editor: ImageModel = {
  id: 'editor', supported_operations: ['edit'], max_input_images: 2,
  supported_sizes: ['1024x1024'], supported_aspect_ratios: ['1:1'],
}
const request = { ratios: ['1:1', '3:4'], minimumInputs: 1 }

test('selection reports why unavailable, generation-only and undeclared editors cannot run', () => {
  const options = imageModelOptions([
    editor,
    { ...editor, id: 'offline', available: false },
    { ...editor, id: 'generate-only', supported_operations: ['generation'] },
    { ...editor, id: 'unknown-inputs', max_input_images: undefined },
    { ...editor, id: 'fractional-inputs', max_input_images: 1.5 },
    { ...editor, id: 'unsupported-shape', supported_aspect_ratios: ['4:3'] },
  ], request)
  assert.equal(options[0].disabled, false)
  for (const option of options.slice(1)) {
    assert.equal(option.disabled, true)
    assert.match(option.label, /（.+）/)
  }
  assert.match(options[2].label, /图片编辑/)
  assert.match(options[3].label, /参考图/)
  assert.match(options[5].label, /比例/)
})

test('try-on and product replacement require separate reference inputs; product boards need one', () => {
  const single = { ...editor, max_input_images: 1 }
  assert.equal(imageModelIssue(single, request), '')
  assert.match(imageModelIssue(single, { ...request, minimumInputs: 2 }), /至少 2 张/)
  assert.equal(imageModelIssue(editor, { ...request, minimumInputs: 2 }), '')
})

test('AI model generation does not require image editing or reference inputs', () => {
  const generation = { ...editor, supported_operations: ['generation'], max_input_images: undefined }
  assert.equal(imageModelIssue(generation, { ratios: ['1:1'], operation: 'generation' }), '')
  assert.match(imageModelIssue(editor, { ratios: ['1:1'], operation: 'generation' }), /文字生图/)
})

test('any available ratio enables selection so its settings can adapt to the model', () => {
  const portrait = { ...editor, supported_aspect_ratios: ['3:4'], supported_sizes: ['768x1024'] }
  assert.equal(imageModelIssue(portrait, request), '')
  assert.match(imageModelIssue(portrait, { ...request, ratios: ['1:1'] }), /比例/)
  assert.match(imageModelIssue(undefined, request), /请选择/)
})
