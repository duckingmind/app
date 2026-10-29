import test from 'node:test'
import assert from 'node:assert/strict'
import {
  assetsFromResponse,
  creativeReferenceTransport,
  imageAspectRatios,
  imageGenerationParameters,
  imageOptions,
  imageSettingsSummary,
  resolveImageSettings,
  updateImageSettings,
  modelDurationOptions,
  modelValues,
  modelsForMode,
  submissionLookupPath,
  taskIdFrom,
  taskPath,
  taskStatus,
  taskCancelPath,
  voiceIdFrom,
} from '../src/creative.ts'

test('model catalogs stay separated by the selected creation mode', () => {
  const catalog = { data: [
    { id: 'chat-model', type: 'text' },
    { id: 'image-model', type: 'image' },
    { id: 'video-model', type: 'video' },
    { id: 'music-model', type: 'audio' },
    { id: 'minimax-voice-design', type: 'audio' },
    { id: 'unavailable-image', type: 'image', available: false },
  ] }
  assert.deepEqual(modelsForMode(catalog, 'chat').map((item) => item.id), ['chat-model'])
  assert.deepEqual(modelsForMode(catalog, 'image').map((item) => item.id), ['image-model'])
  assert.deepEqual(modelsForMode(catalog, 'video').map((item) => item.id), ['video-model'])
  assert.deepEqual(modelsForMode(catalog, 'music').map((item) => item.id), ['music-model'])
  assert.deepEqual(modelsForMode(catalog, 'voice').map((item) => item.id), ['minimax-voice-design'])
})

test('reference transport follows the operation lifetime rather than file size', () => {
  assert.equal(creativeReferenceTransport('image'), 'operation')
  assert.equal(creativeReferenceTransport('chat'), 'cos')
  assert.equal(creativeReferenceTransport('video'), 'cos')
})

test('model options read declared parameters and safe duration ranges', () => {
  const model = {
    supported_sizes: ['1024x1024', '1024x1536'],
    default_parameters: { size: '1024x1024' },
    duration_constraints: { min_seconds: 4, max_seconds: 8, step_seconds: 2 },
  }
  assert.deepEqual(modelValues(model, 'supported_sizes', 'size'), ['1024x1024', '1024x1536'])
  assert.deepEqual(modelDurationOptions(model), ['4', '6', '8'])
  assert.deepEqual(modelDurationOptions({ duration_constraints: { min_seconds: 0, max_seconds: 10000, step_seconds: 0 } }), [])
})

test('image settings follow the Canvas quality, resolution, ratio and count contract', () => {
  const model = {
    type: 'image',
    quality_modes: ['auto', 'high'],
    resolution_tiers: ['1k', '2k'],
    supported_aspect_ratios: ['1:1', '3:2', '9:16'],
    supported_sizes: ['1024x1024', '1536x1024', '900x1600'],
    resolution_sizes: {
      '1k': ['1024x1024', '1536x1024'],
      '2k': ['900x1600'],
    },
    max_output_count: 4,
    default_parameters: { quality_mode: 'auto', resolution_tier: '1k', aspect_ratio: '1:1', n: 2 },
  }
  assert.deepEqual(imageOptions(model).countOptions, [1, 2, 3, 4])
  assert.deepEqual(imageAspectRatios(model, '2k'), ['9:16'])
  assert.deepEqual(imageAspectRatios({ ...model, supported_aspect_ratios: ['18:32'] }, '2k'), ['18:32'])
  assert.equal(resolveImageSettings(model).count, 2)
  const settings = resolveImageSettings(model, { quality: 'high', resolution: '2k', aspectRatio: '1:1', count: 99 })
  assert.deepEqual(settings, { quality: 'high', resolution: '2k', aspectRatio: '9:16', count: 4 })
  assert.equal(imageSettingsSummary(settings, model), '9:16 · high · 2K · 4 张')
  assert.deepEqual(imageGenerationParameters({ ...model, id: 'image-model' }, 'draw a scene', settings), {
    model: 'image-model',
    prompt: 'draw a scene',
    n: 4,
    resolution_tier: '2k',
    quality_mode: 'high',
    aspect_ratio: '9:16',
    response_format: 'url',
  })
})

test('image controls use nested capabilities and discard stale values for another model', () => {
  const model = {
    id: 'new-image-model',
    platform_capabilities: {
      quality_modes: ['auto', 'detail'],
      resolution_tiers: ['1k', '4k'],
      supported_aspect_ratios: ['1:1', '3:2'],
      max_output_count: 30,
      output_formats: ['PNG', 'jpeg'],
      default_parameters: { quality_mode: 'detail', resolution_tier: '4k', aspect_ratio: '3:2', n: 3, output_format: 'PNG' },
    },
  }
  assert.equal(imageOptions(model).countOptions.length, 30)
  assert.deepEqual(resolveImageSettings(model), {
    quality: 'detail', resolution: '4k', aspectRatio: '3:2', count: 3, outputFormat: 'png',
  })
  assert.deepEqual(resolveImageSettings(model, { quality: 'retired', resolution: '2k', aspectRatio: '9:16', count: 99 }), {
    quality: 'detail', resolution: '4k', aspectRatio: '3:2', count: 30, outputFormat: 'png',
  })
  const options = imageOptions({ ...model, quality_modes: [], resolution_tiers: [], supported_aspect_ratios: [], supported_sizes: [] })
  assert.deepEqual([options.qualities, options.resolutions, options.ratios, options.sizes], [[], [], [], []])
})

test('legacy size-only models preserve the selected dimensions without inventing ratio parameters', () => {
  const model = {
    id: 'legacy-image',
    supported_sizes: ['1024x1024', '1536x1024'],
    default_parameters: { size: '1536x1024' },
  }
  assert.deepEqual(imageOptions(model).ratios, [])
  const settings = updateImageSettings(model, {}, { size: '1024x1024' })
  assert.equal(settings.size, '1024x1024')
  assert.deepEqual(imageGenerationParameters(model, 'draw a square', settings), {
    model: 'legacy-image', prompt: 'draw a square', n: 1, size: '1024x1024', response_format: 'url',
  })
})

test('resolution changes retain compatible ratios and reset incompatible dimensions', () => {
  const model = {
    id: 'mapped-image',
    resolution_tiers: ['1k', '4k'],
    supported_aspect_ratios: ['1:1', '3:2', '9:16'],
    supported_sizes: ['1024x1024', '1536x1024', '3072x2048', '2160x3840'],
    resolution_sizes: { '1k': ['1024x1024', '1536x1024'], '4k': ['3072x2048', '2160x3840'] },
    default_parameters: { resolution_tier: '1k', aspect_ratio: '1:1', size: '1024x1024' },
  }
  assert.equal(updateImageSettings(model, { aspectRatio: '3:2' }, { resolution: '4k' }).aspectRatio, '3:2')
  const next = updateImageSettings(model, { size: '1024x1024' }, { resolution: '4k' })
  assert.equal(next.aspectRatio, '3:2')
  assert.equal(next.size, undefined)
  assert.deepEqual(imageGenerationParameters(model, 'wide scene', next), {
    model: 'mapped-image', prompt: 'wide scene', n: 1, resolution_tier: '4k', aspect_ratio: '3:2', response_format: 'url',
  })
})

test('media tasks keep durable task identity and parse output assets', () => {
  const response = {
    id: 'task-1',
    object: 'image_task',
    status: 'completed',
    assets: [{ id: 'asset-1', url: 'https://cdn.example/image.webp', content_type: 'image/webp' }],
  }
  assert.equal(taskIdFrom(response), 'task-1')
  assert.equal(taskStatus(response), 'complete')
  assert.deepEqual(assetsFromResponse(response, 'image'), [{
    id: 'asset-1', type: 'image', assetId: 'asset-1', url: 'https://cdn.example/image.webp', contentType: 'image/webp',
  }])
  assert.equal(taskIdFrom({ details: { task_id: '../invalid' } }), '')
  assert.equal(taskStatus({ status: 'unknown' }), 'pending')
  assert.equal(taskStatus({ status: 'failed' }), 'failed')
  assert.equal(taskPath('music', 'safe-id'), '/music/tasks/safe-id')
  assert.equal(submissionLookupPath('image', 'key:1'), '/images/by-idempotency-key/key%3A1')
  assert.equal(submissionLookupPath('video', 'stable-key'), '/videos/by-idempotency-key/stable-key')
  assert.equal(submissionLookupPath('music', 'stable-key'), '/music/by-idempotency-key/stable-key')
  assert.equal(taskPath('voice', 'voice-task'), '/voice-design/tasks/voice-task')
  assert.equal(taskCancelPath('voice', 'voice-task'), '/voice-design/tasks/voice-task')
  assert.equal(submissionLookupPath('voice', 'stable-key'), '/voice-design/by-idempotency-key/stable-key')
  assert.equal(voiceIdFrom({ id: 'voice-task', voice_id: 'voice-1' }), 'voice-1')
})

test('inline image responses can be shown before durable storage removes their bytes', () => {
  const assets = assetsFromResponse({ data: [{ b64_json: 'YWJj', content_type: 'image/png' }] }, 'image')
  assert.equal(assets[0].url, 'data:image/png;base64,YWJj')
})

test('nested media task responses restore status, identity, and output assets', () => {
  const response = {
    task: {
      id: 'nested-task-1',
      status: 'completed',
      assets: [{ id: 'nested-asset-1', content_url: 'https://cdn.example/result.png', content_type: 'image/png' }],
    },
  }
  assert.equal(taskIdFrom(response), 'nested-task-1')
  assert.equal(taskStatus(response), 'complete')
  assert.deepEqual(assetsFromResponse(response, 'image'), [{
    id: 'nested-asset-1', type: 'image', assetId: 'nested-asset-1', url: 'https://cdn.example/result.png', contentType: 'image/png',
  }])
})

test('voice design completion restores its preview asset and durable voice identity', () => {
  const response = {
    id: 'voice-task-1', object: 'voice_design_task', status: 'completed', voice_id: 'voice-stable-1',
    trial_audio: { available: true, asset_id: 'voice-preview-asset', url: 'https://cdn.example/preview.mp3', content_type: 'audio/mpeg' },
  }
  assert.equal(taskIdFrom(response), 'voice-task-1')
  assert.equal(voiceIdFrom(response), 'voice-stable-1')
  assert.deepEqual(assetsFromResponse(response, 'audio'), [{
    id: 'voice-preview-asset', type: 'audio', assetId: 'voice-preview-asset',
    url: 'https://cdn.example/preview.mp3', contentType: 'audio/mpeg',
  }])
})
