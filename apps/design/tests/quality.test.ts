import assert from 'node:assert/strict'
import test from 'node:test'
import { buildQualityPrompt, parseQualityReport } from '../src/quality.ts'
import type { Work } from '../src/core.ts'

const work: Work = {
  id: 'work-1',
  batch: 'batch-1',
  title: '尺寸说明',
  kind: 'detail',
  scene: 'A+ 详情页',
  pose: '保留蓝色瓶身，文案使用英文，只标注已知容量 500 ml。',
  ratio: '16:9',
  model: 'image-model',
  createdAt: '2026-09-08T00:00:00Z',
  images: [{ url: 'https://example.test/result.png' }],
  status: 'completed',
  plan: { direction: '左图右文', brief: '以容量说明为核心，展示蓝色瓶身。' },
}

test('quality prompt includes original requirements and planning with evidence limits', () => {
  const prompt = buildQualityPrompt(work)
  assert.match(prompt, /只标注已知容量 500 ml/)
  assert.match(prompt, /左图右文/)
  assert.match(prompt, /当前用途：A\+ \/ 详情页模块/)
  assert.match(prompt, /最后一张图片是待检查的成图/)
  assert.match(prompt, /只有最后一张成图时，不得声称已核对原图一致性/)
  assert.match(prompt, /无法确认的项目必须列为需人工检查/)
  assert.match(prompt, /不得编造原图和要求未展示的尺寸/)
})

test('clone review distinguishes a visual reference from product identity', () => {
  const prompt = buildQualityPrompt({ ...work, kind: 'clone' })
  assert.match(prompt, /区分用于风格的参考图与需要保留真实外观的商品原图/)
  assert.match(prompt, /不要把风格参考中的商品当作必须保留的商品/)
})

test('valid reports receive a local timestamp without changing generated work state', () => {
  const before = Date.now()
  const report = parseQualityReport(
    ' {"status":"passed","summary":" 主体与可见要求一致。 ","issues":[]} ',
  )
  assert.equal(report.status, 'passed')
  assert.equal(report.summary, '主体与可见要求一致。')
  assert.deepEqual(report.issues, [])
  assert.ok(Date.parse(report.checkedAt) >= before)
  assert.ok(Date.parse(report.checkedAt) <= Date.now())
  assert.equal(work.status, 'completed')
  assert.equal(work.images.length, 1)
})

test('uncertain and unavailable reviews preserve their stated reasons', () => {
  const review = parseQualityReport(
    JSON.stringify({
      status: 'needs_review',
      summary: '文字需要人工核对',
      issues: [' 右下角小字无法辨认 '],
    }),
  )
  assert.deepEqual(review.issues, ['右下角小字无法辨认'])
  const unavailable = parseQualityReport(
    JSON.stringify({
      status: 'unavailable',
      summary: '无法读取成图',
      issues: [],
    }),
  )
  assert.equal(unavailable.status, 'unavailable')
  assert.equal(unavailable.summary, '无法读取成图')
})

test('strict parser rejects fenced output, commentary, malformed schema and wrong types', () => {
  const valid = JSON.stringify({
    status: 'passed',
    summary: '通过',
    issues: [],
  })
  for (const value of [
    `\`\`\`json\n${valid}\n\`\`\``,
    `${valid}\n检查完成`,
    'null',
    '[]',
    '{"status":"passed","summary":"通过"}',
    '{"status":"passed","summary":"通过","issues":[],"checkedAt":"2020-01-01"}',
    '{"status":"safe","summary":"通过","issues":[]}',
    '{"status":["passed"],"summary":"通过","issues":[]}',
    '{"status":"passed","summary":true,"issues":[]}',
    '{"status":"passed","summary":"  ","issues":[]}',
    '{"status":"needs_review","summary":"有问题","issues":[1]}',
    '{"status":"needs_review","summary":"有问题","issues":["  "]}',
  ])
    assert.throws(() => parseQualityReport(value))
})

test('strict parser rejects contradictory and oversized quality claims', () => {
  assert.throws(
    () =>
      parseQualityReport(
        JSON.stringify({
          status: 'passed',
          summary: '通过',
          issues: ['商品已变形'],
        }),
      ),
    /不一致/,
  )
  assert.throws(
    () =>
      parseQualityReport(
        JSON.stringify({
          status: 'needs_review',
          summary: '待确认',
          issues: [],
        }),
      ),
    /不一致/,
  )
  assert.throws(
    () =>
      parseQualityReport(
        JSON.stringify({
          status: 'passed',
          summary: '长'.repeat(601),
          issues: [],
        }),
      ),
    /有效结论/,
  )
  assert.throws(
    () =>
      parseQualityReport(
        JSON.stringify({
          status: 'needs_review',
          summary: '待确认',
          issues: Array.from({ length: 21 }, () => '待核对'),
        }),
      ),
    /问题列表/,
  )
})
