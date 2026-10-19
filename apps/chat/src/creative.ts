export type CreativeMode = 'chat' | 'image' | 'video' | 'music'
export type CreativeMediaType = 'image' | 'video' | 'audio'

export type CreativeModel = {
  id?: string
  model?: string
  slug?: string
  name?: string
  type?: string
  model_type?: string
  modality?: string
  available?: boolean
  is_default?: boolean
  default_parameters?: Record<string, unknown>
  supported_sizes?: string[]
  supported_aspect_ratios?: string[]
  supported_resolutions?: string[]
  resolution_tiers?: string[]
  resolution_sizes?: Record<string, string[]>
  quality_modes?: string[]
  output_formats?: string[]
  audio_modes?: string[]
  supported_durations?: Array<string | number>
  duration_constraints?: { min_seconds?: number; max_seconds?: number; step_seconds?: number }
  max_output_count?: number
  max_input_images?: number
  max_reference_images?: number
  supported_input_modes?: string[]
  supported_operations?: string[]
  platform_capabilities?: Record<string, unknown>
  parameter_options?: {
    image_sizes?: Array<{ value?: string; ratio?: string; label?: string }>
    image_qualities?: Array<{ value?: string; label?: string; image_sizes?: string[] }>
  }
  [key: string]: unknown
}

export type ImageSettings = {
  quality?: string
  resolution?: string
  aspectRatio?: string
  size?: string
  count?: number
  outputFormat?: string
}

export type ImageModelOptions = {
  qualities: string[]
  qualityLabels: Record<string, string>
  resolutions: string[]
  ratios: string[]
  sizes: string[]
  resolutionSizes: Record<string, string[]>
  outputFormats: string[]
  maxCount: number
  countOptions: number[]
  defaults: Record<string, unknown>
}

export type CreativeAsset = {
  id: string
  type: CreativeMediaType
  url: string
  assetId?: string
  contentType?: string
  name?: string
}

export function catalogItems(payload: unknown): CreativeModel[] {
  if (Array.isArray(payload)) return payload.filter(isRecord) as CreativeModel[]
  if (!isRecord(payload)) return []
  if (Array.isArray(payload.data)) return payload.data.filter(isRecord) as CreativeModel[]
  if (Array.isArray(payload.items)) return payload.items.filter(isRecord) as CreativeModel[]
  const data = payload.data
  if (isRecord(data)) {
    if (Array.isArray(data.data)) return data.data.filter(isRecord) as CreativeModel[]
    if (Array.isArray(data.items)) return data.items.filter(isRecord) as CreativeModel[]
  }
  return []
}

export function creativeModelId(model: CreativeModel) {
  return String(model.id || model.model || model.slug || '').trim()
}

export function modelsForMode(payload: unknown, mode: CreativeMode): CreativeModel[] {
  const seen = new Set<string>()
  return catalogItems(payload).filter((model) => {
    const id = creativeModelId(model)
    const type = String(model.type || model.model_type || model.modality || '').trim().toLowerCase()
    const matches = mode === 'chat'
      ? isTextModel(model)
      : mode === 'image'
        ? type === 'image'
        : mode === 'video'
          ? type === 'video'
          : (type === 'audio' || type === 'music') && !/^minimax-voice-design$/i.test(id)
    if (!id || !matches || model.available === false || seen.has(id)) return false
    seen.add(id)
    return true
  })
}

export function isTextModel(model: CreativeModel) {
  const type = String(model.type || model.model_type || model.modality || '').trim().toLowerCase()
  if (['text', 'llm', 'language', 'chat'].includes(type)) return true
  if (['image', 'video', 'audio', 'music'].includes(type)) return false
  const id = creativeModelId(model).toLowerCase()
  return Boolean(id) && !/(image|video|audio|music|embedding|tts|whisper|vision)/.test(id)
}

export function modelLabel(model: CreativeModel) {
  const id = creativeModelId(model)
  return model.name && model.name !== id ? model.name : id
}

export function preferredModel(models: CreativeModel[], current = '') {
  return models.find((model) => creativeModelId(model) === current)
    ? current
    : creativeModelId(models.find((model) => model.is_default) || models[0] || {})
}

export function modelDefaults(model?: CreativeModel): Record<string, unknown> {
  if (!model) return {}
  return model.default_parameters || model.platform_capabilities?.default_parameters as Record<string, unknown> || {}
}

function capability(model: CreativeModel | undefined, key: string): unknown {
  if (!model) return undefined
  if (Object.prototype.hasOwnProperty.call(model, key)) return model[key]
  const capabilities = model.platform_capabilities
  if (isRecord(capabilities) && Object.prototype.hasOwnProperty.call(capabilities, key)) return capabilities[key]
  return undefined
}

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? [...new Set(value.filter((item): item is string => typeof item === 'string').map((item) => item.trim()).filter(Boolean))]
    : []
}

export function imageRatioFromSize(value: string): string {
  const match = value.trim().toLowerCase().match(/^(\d+)\s*x\s*(\d+)$/)
  if (!match) return ''
  let width = Number(match[1])
  let height = Number(match[2])
  if (!width || !height) return ''
  let a = width
  let b = height
  while (b) [a, b] = [b, a % b]
  width /= a
  height /= a
  return `${width}:${height}`
}

function imageSizeMatchesRatio(size: string, ratio: string): boolean {
  const [width, height] = imageRatioFromSize(size).split(':').map(Number)
  const [numerator, denominator] = ratio.split(':').map(Number)
  return width > 0 && height > 0 && numerator > 0 && denominator > 0
    && width * denominator === height * numerator
}

/** Read image capabilities from the selected model, with its platform snapshot as fallback. */
export function imageOptions(model?: CreativeModel): ImageModelOptions {
  const defaults = modelDefaults(model)
  const declaredQualities = capability(model, 'quality_modes')
  const legacyQualities = model?.parameter_options?.image_qualities?.map((option) => option.value).filter((value): value is string => typeof value === 'string') || []
  const qualities = declaredQualities === undefined ? stringList(legacyQualities) : stringList(declaredQualities)
  const resolutions = stringList(capability(model, 'resolution_tiers') ?? capability(model, 'supported_resolutions'))
  const ratios = stringList(capability(model, 'supported_aspect_ratios'))
  const rawDeclaredSizes = capability(model, 'supported_sizes')
  const legacySizes = model?.parameter_options?.image_sizes?.map((option) => option.value).filter((value): value is string => typeof value === 'string') || []
  const sizes = rawDeclaredSizes !== undefined ? stringList(rawDeclaredSizes) : stringList(legacySizes)
  const mappingValue = capability(model, 'resolution_sizes')
  const resolutionSizes = isRecord(mappingValue)
    ? Object.fromEntries(Object.entries(mappingValue).map(([tier, values]) => [tier, stringList(values)]))
    : {}
  const outputFormats = [...new Set(stringList(capability(model, 'output_formats')).map((value) => value.toLowerCase()))]
  const qualityLabels = Object.fromEntries((model?.parameter_options?.image_qualities || [])
    .filter((option) => typeof option.value === 'string' && typeof option.label === 'string' && option.label.trim())
    .map((option) => [option.value!.trim(), option.label!.trim()]))
  const maxValue = Number(capability(model, 'max_output_count'))
  const maxCount = Number.isInteger(maxValue) && maxValue > 0 ? maxValue : 1
  return {
    qualities,
    qualityLabels,
    resolutions,
    ratios,
    sizes,
    resolutionSizes,
    outputFormats,
    maxCount,
    countOptions: Array.from({ length: maxCount }, (_, index) => index + 1),
    defaults,
  }
}

export function imageAspectRatios(model?: CreativeModel, resolution?: string): string[] {
  const options = imageOptions(model)
  const mappedSizes = options.resolutionSizes[resolution || '']
  if (!mappedSizes?.length) return options.ratios
  return options.ratios.filter((ratio) => mappedSizes.some((size) => imageSizeMatchesRatio(size, ratio)))
}

function chooseImageOption(options: string[], requested: unknown, fallback: unknown) {
  const requestedValue = requested == null ? '' : String(requested)
  const fallbackValue = fallback == null ? '' : String(fallback)
  return options.find((value) => value === requestedValue)
    || options.find((value) => value === fallbackValue)
    || options[0]
    || ''
}

/** Normalize image controls against the active model to avoid stale parameters on model changes. */
export function resolveImageSettings(model?: CreativeModel, settings: ImageSettings = {}): ImageSettings {
  const options = imageOptions(model)
  const quality = chooseImageOption(options.qualities, settings.quality, options.defaults.quality_mode)
  const resolution = chooseImageOption(options.resolutions, settings.resolution, options.defaults.resolution_tier)
  const availableRatios = imageAspectRatios(model, resolution)
  const defaultRatio = options.defaults.aspect_ratio
    || availableRatios.find((ratio) => imageSizeMatchesRatio(String(options.defaults.size || ''), ratio))
  const aspectRatio = chooseImageOption(availableRatios, settings.aspectRatio, defaultRatio)
  const tierSizes = options.resolutionSizes[resolution] || options.sizes
  const ratioSizes = aspectRatio
    ? tierSizes.filter((size) => size === 'auto' || imageSizeMatchesRatio(size, aspectRatio))
    : tierSizes
  const requestedSize = settings.size || options.defaults.size
  // Resolution and ratio are the model-independent abstraction used in Canvas.
  const size = resolution && aspectRatio
    ? ''
    : chooseImageOption(ratioSizes, requestedSize, options.defaults.size)
  const requestedCount = Number(settings.count ?? options.defaults.n ?? 1)
  const count = Number.isFinite(requestedCount)
    ? Math.max(1, Math.min(options.maxCount, Math.floor(requestedCount)))
    : 1
  const outputFormat = chooseImageOption(options.outputFormats, settings.outputFormat?.toLowerCase(), String(options.defaults.output_format || '').toLowerCase())
  return {
    ...(quality ? { quality } : {}),
    ...(resolution ? { resolution } : {}),
    ...(aspectRatio ? { aspectRatio } : {}),
    ...(size ? { size } : {}),
    ...(outputFormat ? { outputFormat } : {}),
    count,
  }
}

export function updateImageSettings(model: CreativeModel, current: ImageSettings, patch: Partial<ImageSettings>): ImageSettings {
  const next = { ...resolveImageSettings(model, current), ...patch }
  if (patch.resolution !== undefined || patch.aspectRatio !== undefined) next.size = undefined
  if (patch.size !== undefined) {
    next.aspectRatio = imageAspectRatios(model, next.resolution)
      .find((ratio) => imageSizeMatchesRatio(patch.size!, ratio))
  }
  return resolveImageSettings(model, next)
}

export function imageSettingsSummary(settings: ImageSettings, model?: CreativeModel) {
  const qualityLabels = imageOptions(model).qualityLabels
  return [
    settings.aspectRatio || settings.size,
    settings.quality && (qualityLabels[settings.quality] || settings.quality),
    settings.resolution?.toUpperCase(),
    `${settings.count || 1} 张`,
  ].filter(Boolean).join(' · ')
}

export function imageGenerationParameters(model: CreativeModel, prompt: string, settings: ImageSettings = {}) {
  const resolved = resolveImageSettings(model, settings)
  return {
    model: creativeModelId(model),
    prompt,
    n: resolved.count || 1,
    ...(resolved.size ? { size: resolved.size } : {}),
    ...(resolved.resolution ? { resolution_tier: resolved.resolution } : {}),
    ...(resolved.quality ? { quality_mode: resolved.quality } : {}),
    ...(resolved.aspectRatio ? { aspect_ratio: resolved.aspectRatio } : {}),
    ...(resolved.outputFormat ? { output_format: resolved.outputFormat } : {}),
    response_format: 'url',
  }
}

export function modelValues(model: CreativeModel | undefined, key: string, fallbackKey = key): string[] {
  const value = model?.[key] ?? model?.platform_capabilities?.[key]
  if (Array.isArray(value)) return [...new Set(value.map(String).map((item) => item.trim()).filter(Boolean))]
  const fallback = modelDefaults(model)[fallbackKey]
  return typeof fallback === 'string' && fallback.trim() ? [fallback.trim()] : []
}

export function modelDurationOptions(model?: CreativeModel) {
  const declared = model?.supported_durations
  if (Array.isArray(declared) && declared.length) return [...new Set(declared.map((value) => String(value).trim()).filter(Boolean))]
  const constraints = model?.duration_constraints || model?.platform_capabilities?.duration_constraints as CreativeModel['duration_constraints']
  if (!constraints) return []
  const min = Number(constraints.min_seconds)
  const max = Number(constraints.max_seconds)
  const step = Number(constraints.step_seconds || 1)
  if (!Number.isFinite(min) || !Number.isFinite(max) || !Number.isFinite(step) || min <= 0 || max < min || step <= 0) return []
  const options: string[] = []
  for (let value = min; value <= max && options.length < 60; value += step) options.push(String(value))
  return options
}

export function taskIdFrom(value: unknown): string {
  if (!isRecord(value)) return ''
  const details = isRecord(value.details) ? value.details : {}
  const nested = isRecord(value.task) ? value.task : {}
  const objectType = String(value.object || '').toLowerCase()
  const publicTaskID = ['video', 'music_task', 'image_task', 'image_generation_task'].includes(objectType) ? value.id : ''
  const id = String(value.task_id || details.task_id || nested.id || publicTaskID || '')
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(id) ? id : ''
}

export function taskStatus(value: unknown): 'complete' | 'failed' | 'pending' {
  if (!isRecord(value)) return 'pending'
  const error = isRecord(value.error) ? value.error : {}
  const status = String(value.status || value.task_status || value.phase || '').trim().toLowerCase()
  if (['completed', 'complete', 'succeeded', 'success', 'done'].includes(status)) return 'complete'
  if (['failed', 'failure', 'expired', 'cancelled', 'canceled', 'refunded'].includes(status)) return 'failed'
  if ((error.code || value.error_message) && status !== 'unknown' && !['pending', 'in_progress', 'queued', 'running', 'dispatching'].includes(status)) return 'failed'
  return 'pending'
}

export function assetsFromResponse(value: unknown, type: CreativeMediaType): CreativeAsset[] {
  if (!isRecord(value)) return []
  const candidates: unknown[] = []
  if (Array.isArray(value.assets)) candidates.push(...value.assets)
  if (Array.isArray(value.data)) candidates.push(...value.data)
  if (Array.isArray(value.images)) candidates.push(...value.images)
  if (!candidates.length && (value.url || value.content_url || value.b64_json || value.image)) candidates.push(value)
  const taskId = taskIdFrom(value)
  const assets: CreativeAsset[] = []
  for (const candidate of candidates) {
    if (!isRecord(candidate)) continue
    const assetId = String(candidate.asset_id || candidate.assetId || (candidate.id !== taskId ? candidate.id : '') || '').trim()
    const encoded = String(candidate.b64_json || candidate.base64 || '').trim()
    const contentType = String(candidate.content_type || candidate.mime_type || (type === 'image' ? 'image/png' : type === 'video' ? 'video/mp4' : 'audio/mpeg'))
    const url = String(candidate.content_url || candidate.url || candidate.image || (encoded ? `data:${contentType};base64,${encoded}` : '')).trim()
    if (!url) continue
    assets.push({
      id: assetId || `${taskId || 'asset'}-${assets.length + 1}`,
      type,
      url,
      ...(assetId ? { assetId } : {}),
      contentType,
      ...(typeof candidate.name === 'string' ? { name: candidate.name } : {}),
    })
  }
  if (!assets.length && (value.content_url || (value.url && type !== 'image') || (value.data && type === 'image'))) {
    const encoded = typeof value.data === 'string' ? value.data : ''
    const contentType = type === 'video' ? 'video/mp4' : type === 'audio' ? 'audio/mpeg' : 'image/png'
    assets.push({
      id: String(value.asset_id || taskId || 'asset-1'), type,
      url: String(value.content_url || value.url || (encoded ? `data:${contentType};base64,${encoded}` : '')),
      ...(value.asset_id ? { assetId: String(value.asset_id) } : {}), contentType,
    })
  }
  return assets
}

export function taskPath(mode: Exclude<CreativeMode, 'chat'>, id: string) {
  const safeID = encodeURIComponent(id)
  if (mode === 'image') return `/images/tasks/${safeID}`
  if (mode === 'video') return `/videos/${safeID}`
  return `/music/tasks/${safeID}`
}

export function submissionLookupPath(mode: Exclude<CreativeMode, 'chat'>, key: string) {
  const safeKey = encodeURIComponent(key)
  if (mode === 'image') return `/images/by-idempotency-key/${safeKey}`
  if (mode === 'video') return `/videos/by-idempotency-key/${safeKey}`
  return `/music/by-idempotency-key/${safeKey}`
}

export function taskContentType(mode: Exclude<CreativeMode, 'chat'>): CreativeMediaType {
  return mode === 'image' ? 'image' : mode === 'video' ? 'video' : 'audio'
}

export function errorMessage(value: unknown, fallback: string) {
  if (!isRecord(value)) return fallback
  const details = isRecord(value.details) ? value.details : {}
  const nested = isRecord(value.error) ? value.error : {}
  return String(value.message || details.message || nested.message || fallback)
}

function isRecord(value: unknown): value is Record<string, any> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}
