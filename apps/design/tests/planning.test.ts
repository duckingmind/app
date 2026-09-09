import assert from 'node:assert/strict'
import test from 'node:test'
import type { CommerceRequest } from '../src/commerce.ts'
import { buildPlanningPrompt, parseCommercePlan } from '../src/planning.ts'
import {
  DEFAULT_PRODUCT_COUNTS,
  prepareProductRequest,
} from '../src/productCore.ts'

function product(smart = true): CommerceRequest {
  const request = prepareProductRequest({
    photos: [{ id: 'product', name: '耳机', url: 'blob:product' }],
    platform: '亚马逊',
    market: '美国',
    language: '英文',
    ratio: '1:1',
    requirements: '橙色耳机，没有提供续航、尺寸或配件信息',
    smart,
    counts: { ...DEFAULT_PRODUCT_COUNTS },
    trend: false,
    listing: false,
  })
  return {
    kind: 'product',
    ratio: request.ratio,
    products: request.photos,
    jobs: request.outputs,
    planningMode: request.planningMode,
    planningPrompt: request.planningPrompt,
  }
}

function answer(request: CommerceRequest) {
  return {
    direction:
      '统一暖橙色点缀、柔和自然光与清晰留白，主图严格使用白底且没有文案。',
    jobs: request.jobs.map((job, index) => ({
      id: job.id || `slot-${String(index + 1).padStart(2, '0')}`,
      type:
        request.planningMode === 'smart'
          ? [
              'main',
              'scene',
              'scene',
              'scene',
              'details',
              'details',
              'benefits',
            ][index]
          : job.type || request.kind,
      title:
        request.planningMode === 'smart' ? `耳机画面 ${index + 1}` : job.title,
      prompt: `第${index + 1}张以橙色耳机可见结构为主体，安排独立的局部取景与柔光层次，保留商品真实颜色，不添加未知参数或未提供配件。`,
    })),
  }
}

test('smart planning dynamically selects seven product purposes and injects shared style below hard constraints', () => {
  const request = product()
  const planned = parseCommercePlan(JSON.stringify(answer(request)), request)
  assert.equal(planned.jobs.length, 7)
  assert.deepEqual(
    planned.jobs.map((job) => job.type),
    ['main', 'scene', 'scene', 'scene', 'details', 'details', 'benefits'],
  )
  assert.equal(planned.jobs[0].id, 'product-01')
  assert.match(planned.jobs[0].prompt, /禁止文字、促销标签/)
  assert.match(planned.jobs[0].prompt, /原始要求及类型限制优先/)
  for (const job of planned.jobs) {
    assert.ok(job.prompt.includes(planned.direction))
    assert.match(job.prompt, /没有提供续航、尺寸或配件信息/)
  }
  assert.equal(
    request.jobs[0].type,
    'auto',
    'parsing must not mutate the submitted request',
  )
})

test('fixed product and detail planning cannot change the chosen module types, titles or order', () => {
  const request = product(false)
  const result = parseCommercePlan(JSON.stringify(answer(request)), request)
  assert.deepEqual(
    result.jobs.map((job) => [job.id, job.type, job.title]),
    request.jobs.map((job) => [job.id, job.type, job.title]),
  )
  const invalidType = answer(request)
  invalidType.jobs[0].type = 'scene'
  assert.throws(
    () => parseCommercePlan(JSON.stringify(invalidType), request),
    /修改了受限图片类型/,
  )
  const invalidTitle = answer(request)
  invalidTitle.jobs[0].title = '另一个模块'
  assert.throws(
    () => parseCommercePlan(JSON.stringify(invalidTitle), request),
    /修改了原始模块标题/,
  )
  const detail: CommerceRequest = {
    kind: 'detail',
    ratio: '16:9',
    products: request.products,
    jobs: [
      {
        id: 'hero-1',
        type: 'hero',
        title: '首屏主视觉',
        prompt: '首屏只展示真实商品与用户提供的核心主张。',
      },
      {
        id: 'size-1',
        type: 'size',
        title: '尺寸说明',
        prompt: '仅显示已提供尺寸，没有数值时不得标注尺寸。',
      },
    ],
  }
  const reordered = answer(detail)
  reordered.jobs.reverse()
  assert.throws(
    () => parseCommercePlan(JSON.stringify(reordered), detail),
    /顺序错误/,
  )
})

test('clone planning preserves each exact reference binding and never accepts model-supplied references', () => {
  const references = [
    { id: 'ref-a', name: '布局 A', url: 'blob:a' },
    { id: 'ref-b', name: '布局 B', url: 'blob:b' },
  ]
  const request: CommerceRequest = {
    kind: 'clone',
    ratio: '1:1',
    products: [],
    jobs: references.map((reference, index) => ({
      title: `复刻 ${index + 1}`,
      prompt: `保持第${index + 1}张参考的构图关系与主体类型，按已给文案创作。`,
      references: [reference],
    })),
  }
  const result = parseCommercePlan(JSON.stringify(answer(request)), request)
  assert.equal(result.jobs[0].references, request.jobs[0].references)
  assert.equal(result.jobs[1].references?.[0], references[1])
  const extraReference = answer(request)
  Object.assign(extraReference.jobs[0], { references: [references[1]] })
  assert.throws(
    () => parseCommercePlan(JSON.stringify(extraReference), request),
    /未知字段/,
  )
})

test('malformed JSON and incomplete, duplicate, extra or unknown slots fail before any image plan is returned', () => {
  const request = product()
  const cases: [string, unknown][] = [
    [
      'missing slot',
      { ...answer(request), jobs: answer(request).jobs.slice(1) },
    ],
    [
      'extra slot',
      {
        ...answer(request),
        jobs: [...answer(request).jobs, answer(request).jobs[0]],
      },
    ],
    [
      'duplicate slot',
      {
        ...answer(request),
        jobs: answer(request).jobs.map((job, index) =>
          index === 1 ? { ...job, id: 'product-01' } : job,
        ),
      },
    ],
    [
      'unknown slot',
      {
        ...answer(request),
        jobs: answer(request).jobs.map((job, index) =>
          index === 0 ? { ...job, id: 'unknown' } : job,
        ),
      },
    ],
    [
      'unknown type',
      {
        ...answer(request),
        jobs: answer(request).jobs.map((job, index) =>
          index === 0 ? { ...job, type: 'invented' } : job,
        ),
      },
    ],
    [
      'no main image',
      {
        ...answer(request),
        jobs: answer(request).jobs.map((job) => ({ ...job, type: 'scene' })),
      },
    ],
    ['extra property', { ...answer(request), model: 'different-image-model' }],
    ['missing direction', { jobs: answer(request).jobs }],
    [
      'short instructions',
      {
        ...answer(request),
        jobs: answer(request).jobs.map((job, index) =>
          index === 0 ? { ...job, prompt: '好看' } : job,
        ),
      },
    ],
    [
      'oversized instructions',
      {
        ...answer(request),
        jobs: answer(request).jobs.map((job, index) =>
          index === 0 ? { ...job, prompt: '图'.repeat(5001) } : job,
        ),
      },
    ],
    [
      'duplicate instructions',
      {
        ...answer(request),
        jobs: answer(request).jobs.map((job) => ({
          ...job,
          prompt: answer(request).jobs[0].prompt,
        })),
      },
    ],
  ]
  for (const [label, value] of cases)
    assert.throws(
      () => parseCommercePlan(JSON.stringify(value), request),
      /尚未提交图片生成/,
      label,
    )
  for (const text of [
    '',
    'Here is the plan: {}',
    '```json\n{}\n```',
    '{"direction":',
    'null',
    '[]',
  ])
    assert.throws(() => parseCommercePlan(text, request), /尚未提交图片生成/)
})

test('planning prompt declares fixed slots, allowed types and independent instructions without response_format dependencies', () => {
  const request = product()
  const prompt = buildPlanningPrompt(request)
  assert.match(prompt, /product-01/)
  assert.match(prompt, /product-07/)
  assert.match(prompt, /至少 1 张 main/)
  assert.match(prompt, /每张 prompt 必须有具体/)
  assert.match(prompt, /所有图均为同一商品/)
  assert.doesNotMatch(prompt, /response_format|json_schema/)
  const invalid: CommerceRequest = { ...request, jobs: request.jobs.slice(1) }
  assert.throws(() => buildPlanningPrompt(invalid), /恰好规划 7 张/)
  assert.throws(
    () =>
      buildPlanningPrompt({
        ...request,
        planningMode: 'fixed',
        jobs: Array.from({ length: 25 }, () => request.jobs[0]),
      }),
    /1 至 24/,
  )
})
