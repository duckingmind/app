import assert from 'node:assert/strict'
import test from 'node:test'
import type { Api } from '../src/core.ts'
import { textModelCatalog, verifyVisionModel } from '../src/textModels.ts'

type RequestOptions = Parameters<Api['request']>[1]

function apiWith(respond: (path: string, init?: RequestOptions) => unknown): Api {
  return { request: async <T>(path: string, init?: RequestOptions) => await respond(path, init) as T }
}

const challenge = { image: 'data:image/png;base64,aGVsbG8=', answer: '047291' }

test('the current public model contract stays unknown without inferring capability from names', () => {
  const choices = textModelCatalog({ object: 'list', data: [
    { id: 'text-1', object: 'model', name: 'text-1', display_name: '文本模型', context_window: 128000, max_output: 8192 },
    { id: 'vision-responses-pro', name: '看起来像视觉模型的名字' },
    { id: 'known-image', name: '图片模型' },
  ] }, ['known-image'])
  assert.deepEqual(choices, [
    { id: 'text-1', name: '文本模型', vision: 'unknown', responses: 'unknown' },
    { id: 'vision-responses-pro', name: '看起来像视觉模型的名字', vision: 'unknown', responses: 'unknown' },
  ])
})

test('catalog excludes explicit incompatibility for vision, text output and the public Responses endpoint', () => {
  const choices = textModelCatalog({ data: [
    { id: 'no-vision', architecture: { input_modalities: ['text'], output_modalities: ['text'] } },
    { id: 'no-text', architecture: { input_modalities: ['text', 'image'], output_modalities: ['image'] } },
    { id: 'no-responses', supported_endpoints: ['/v1/chat/completions'] },
    { id: 'explicit-no-vision', supports_vision: false },
    { id: 'explicit-no-responses', capabilities: { responses: false } },
    { id: 'explicit-no-text', supports_text_output: false },
    { id: 'contradictory', supports_vision: true, architecture: { input_modalities: ['text'] } },
    { id: 'unavailable', available: false },
    { id: 'not-public', supported_in_api: false },
    { id: 'video', model_type: 'video' },
    { id: 'good', display_name: '可用模型', architecture: { input_modalities: ['text', 'image'], output_modalities: ['text'] }, supported_endpoints: ['/v1/responses'] },
  ] }, [])
  assert.deepEqual(choices, [{ id: 'good', name: '可用模型', vision: 'supported', responses: 'supported' }])
})

test('empty or malformed metadata remains unknown and native upstream API type is not treated as a public restriction', () => {
  const choices = textModelCatalog({ data: { items: [
    { id: 'empty', input_modalities: [], architecture: null, supported_endpoints: [] },
    { id: 'adapted', api_type: 'chat_completions', supports_vision: true },
    { id: 'adapted', name: 'duplicate' },
    { id: '', name: 'missing id' },
  ] } }, new Set())
  assert.deepEqual(choices, [
    { id: 'empty', name: 'empty', vision: 'unknown', responses: 'unknown' },
    { id: 'adapted', name: 'adapted', vision: 'supported', responses: 'unknown' },
  ])
})

test('vision check sends the image through one non-streaming Responses request without leaking the expected code', async () => {
  let calls = 0
  const controller = new AbortController()
  await verifyVisionModel(apiWith((path, init) => {
    calls++
    assert.equal(path, '/responses')
    assert.equal(init?.method, 'POST')
    assert.equal(init?.signal, controller.signal)
    const payload = JSON.parse(String(init?.body))
    assert.equal(payload.model, 'selected-model')
    assert.equal(payload.stream, false)
    assert.deepEqual(payload.input[0].content[1], { type: 'input_image', image_url: challenge.image })
    assert.doesNotMatch(JSON.stringify(payload), new RegExp(challenge.answer))
    assert.equal(payload.input[0].content[0].type, 'input_text')
    return { status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: challenge.answer }] }] }
  }), 'selected-model', challenge, controller.signal)
  assert.equal(calls, 1)
})

test('vision check accepts an exact code with only surrounding transport whitespace and preserves leading zeroes', async () => {
  await verifyVisionModel(apiWith(() => ({ output_text: ` \n${challenge.answer}\n` })), 'model', challenge)
  await assert.rejects(verifyVisionModel(apiWith(() => ({ output_text: String(Number(challenge.answer)) })), 'model', challenge), /未通过图片理解验证/)
})

test('wrong, guessed, decorated or absent code output never passes the visual challenge', async () => {
  for (const text of ['123456', `答案是${challenge.answer}`, `\`${challenge.answer}\``, '０４７２９１', '', '无法识别']) {
    let calls = 0
    await assert.rejects(verifyVisionModel(apiWith(() => { calls++; return { output_text: text } }), 'model', challenge), /未通过图片理解验证/)
    assert.equal(calls, 1)
  }
  await assert.rejects(verifyVisionModel(apiWith(() => ({ output: [{ content: [{ type: 'refusal', refusal: 'cannot read' }] }] })), 'model', challenge), /未通过图片理解验证/)
})

test('an incomplete or failed Responses result cannot verify a model even when partial text matches', async () => {
  for (const status of ['incomplete', 'failed', 'in_progress'])
    await assert.rejects(verifyVisionModel(apiWith(() => ({ status, output_text: challenge.answer })), 'model', challenge), /验证未完成/)
  await assert.rejects(verifyVisionModel(apiWith(() => ({ error: { message: 'upstream failure' }, output_text: challenge.answer })), 'model', challenge), /验证未完成/)
})

test('upstream quota and routing errors propagate unchanged without retry or a success cache', async () => {
  const failure = Object.assign(new Error('quota exhausted'), { status: 402, code: 'quota_exhausted' })
  let calls = 0
  await assert.rejects(verifyVisionModel(apiWith(() => { calls++; throw failure }), 'model', challenge), error => error === failure)
  assert.equal(calls, 1)
  await verifyVisionModel(apiWith(() => { calls++; return { output_text: challenge.answer } }), 'model', challenge)
  assert.equal(calls, 2)
})

test('stopped verification does not call the model or accept a result that arrives after stopping', async () => {
  const stopped = new AbortController(); stopped.abort()
  await assert.rejects(verifyVisionModel(apiWith(() => assert.fail('must not call')), 'model', challenge, stopped.signal), { name: 'AbortError' })
  const during = new AbortController()
  await assert.rejects(verifyVisionModel(apiWith(() => { during.abort(); return { output_text: challenge.answer } }), 'model', challenge, during.signal), { name: 'AbortError' })
})

test('invalid model or challenge is rejected before any billable request', async () => {
  const api = apiWith(() => assert.fail('must not call'))
  await assert.rejects(verifyVisionModel(api, '', challenge), /请先选择/)
  await assert.rejects(verifyVisionModel(api, 'model', { ...challenge, answer: 'not-numeric' }), /验证素材无效/)
  await assert.rejects(verifyVisionModel(api, 'model', { ...challenge, image: 'https://example.test/random.png' }), /验证素材无效/)
})
