import assert from 'node:assert/strict'
import test from 'node:test'
import { workPlanDisplay } from '../src/workPlanDisplay.ts'

const direction = '整组以金属感深蓝与冷银蓝为主色，突出耳机的亮面外观。'
const requirementsSeparator =
  '\n\n以下原始要求及类型限制优先于上面的统一视觉方向和具体策划，不得被替换、放宽或忽略：\n\n'

function wrapped(composition: string) {
  return [
    `整套统一视觉方向（仅在不冲突时使用）：${direction}`,
    `本张的具体策划：${composition}`,
    '以下原始要求及类型限制优先于上面的统一视觉方向和具体策划，不得被替换、放宽或忽略：',
    '保持商品结构一致，不要添加未确认参数或配件。',
    '只输出当前一张成图，不输出策划 JSON、位置编号、参考板或整套拼图。',
  ].join('\n\n')
}

test('separates shared style from the individual composition without changing the stored plan', () => {
  const composition = '单只耳机采用四分之三侧面特写，打开的充电盒位于后方。\n\n保留原始标识，不增加文案。'
  const plan = Object.freeze({ direction, brief: wrapped(composition) })
  const original = { ...plan }
  assert.deepEqual(workPlanDisplay(plan), {
    direction,
    brief: composition,
    originalBrief: original.brief,
    simplified: true,
  })
  assert.deepEqual(plan, original)
})

test('keeps English and mixed language composition intact and retains every original requirement', () => {
  const composition = 'Create a square macro image featuring one blue earbud.\n\nUse a three-quarter view. 保留原有标识。'
  const brief = wrapped(composition)
  const display = workPlanDisplay({ direction, brief })
  assert.equal(display.brief, composition)
  assert.equal(display.originalBrief, brief)
  assert.ok(display.originalBrief.includes('保持商品结构一致'))
  assert.equal(display.simplified, true)
})

test('preserves unwrapped content even when it repeats or mentions the shared direction', () => {
  for (const brief of [
    '拍摄白底商品主图，商品完整入镜。',
    `${direction}\n\n以同样方向拍摄耳机侧面。`,
    `用户参考说明：\n${wrapped('保留此引用，不要拆分。')}`,
  ]) {
    assert.deepEqual(workPlanDisplay({ direction, brief }), {
      direction,
      brief,
      originalBrief: brief,
      simplified: false,
    })
  }
})

test('does not extract a composition when the known wrapper is incomplete or ambiguous', () => {
  for (const brief of [
    wrapped('耳机侧面特写。').replace('只输出当前一张成图', '其他输出说明'),
    wrapped('耳机侧面特写。').replace(direction, '不同的统一视觉方向'),
    wrapped(`引用规则：${requirementsSeparator}保留原文。`),
    wrapped('   '),
  ]) {
    const display = workPlanDisplay({ direction, brief })
    assert.equal(display.brief, brief.trim())
    assert.equal(display.originalBrief, brief)
    assert.equal(display.simplified, false)
  }
})

test('handles absent or blank plans while preserving original whitespace for copying', () => {
  assert.deepEqual(workPlanDisplay(), {
    direction: '', brief: '', originalBrief: '', simplified: false,
  })
  assert.deepEqual(workPlanDisplay({ direction: ' ', brief: '\n ' }), {
    direction: '', brief: '', originalBrief: '\n ', simplified: false,
  })
  assert.equal(workPlanDisplay({ direction: '', brief: 'Product shot' }).brief, 'Product shot')
})
