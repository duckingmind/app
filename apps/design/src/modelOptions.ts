import { sizeForRatio, supports, type ImageModel } from './core.ts'

type ModelRequirements = {
  operation?: 'edit' | 'generation'
  minimumInputs?: number
  ratios: readonly string[]
}

export function imageModelIssue(model: ImageModel | undefined, requirements: ModelRequirements): string {
  if (!model) return '请选择可用图片模型'
  if (model.available === false) return '暂不可用'
  const operation = requirements.operation ?? 'edit'
  if (!supports(model, operation))
    return operation === 'edit' ? '不支持图片编辑' : '不支持文字生图'
  if (operation === 'edit') {
    const minimum = requirements.minimumInputs ?? 1
    if (!Number.isInteger(model.max_input_images) || (model.max_input_images ?? 0) < minimum)
      return `需支持至少 ${minimum} 张参考图`
  }
  if (!requirements.ratios.some(ratio => sizeForRatio(model, ratio)))
    return '不支持当前模块的图片比例'
  return ''
}

export function imageModelOptions(models: ImageModel[], requirements: ModelRequirements) {
  return models.map(model => {
    const issue = imageModelIssue(model, requirements)
    return {
      value: model.id,
      label: `${model.name || model.id}${issue ? `（${issue}）` : ''}`,
      disabled: Boolean(issue),
    }
  })
}
