type WorkPlan = { direction: string; brief: string }

export type WorkPlanDisplay = {
  direction: string
  brief: string
  originalBrief: string
  simplified: boolean
}

const PLAN_PREFIX = '整套统一视觉方向（仅在不冲突时使用）：'
const BRIEF_PREFIX = '\n\n本张的具体策划：'
const REQUIREMENTS_SEPARATOR =
  '\n\n以下原始要求及类型限制优先于上面的统一视觉方向和具体策划，不得被替换、放宽或忽略：\n\n'
const OUTPUT_SUFFIX =
  '\n\n只输出当前一张成图，不输出策划 JSON、位置编号、参考板或整套拼图。'

/**
 * Display only: recognize the exact wrapper produced by parseCommercePlan.
 * Keep the complete original prompt available; never use this view as model input.
 * Unknown, partial, or ambiguous formats are shown without removing content.
 */
export function workPlanDisplay(plan?: WorkPlan): WorkPlanDisplay {
  const direction = plan?.direction.trim() || ''
  const originalBrief = plan?.brief || ''
  const brief = originalBrief.trim()
  const unchanged = { direction, brief, originalBrief, simplified: false }
  if (!direction || !brief) return unchanged

  const prefix = `${PLAN_PREFIX}${direction}${BRIEF_PREFIX}`
  if (!brief.startsWith(prefix) || !brief.endsWith(OUTPUT_SUFFIX))
    return unchanged

  const body = brief.slice(prefix.length, -OUTPUT_SUFFIX.length)
  const separator = body.indexOf(REQUIREMENTS_SEPARATOR)
  if (
    separator < 1 ||
    body.indexOf(REQUIREMENTS_SEPARATOR, separator + 1) !== -1 ||
    !body.slice(separator + REQUIREMENTS_SEPARATOR.length).trim()
  )
    return unchanged

  const composition = body.slice(0, separator).trim()
  if (!composition) return unchanged
  return { direction, brief: composition, originalBrief, simplified: true }
}
