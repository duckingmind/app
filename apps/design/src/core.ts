import type { QualityReport } from './quality.ts'

export type ImageModel = {
  id: string
  name?: string
  available?: boolean
  supported_operations?: string[]
  max_input_images?: number
  supported_aspect_ratios?: string[]
  supported_sizes?: string[]
  size_mode?: string
  size_constraints?: {
    min_width?: number
    max_width?: number
    min_height?: number
    max_height?: number
    min_pixels?: number
    max_pixels?: number
    multiple_of?: number
    max_aspect_ratio?: number
  }
}

export type ImageResult = { url: string; assetId?: string }
export type ImageResponse = {
  id?: string
  task_id?: string
  status?: string
  data?: { url?: string; b64_json?: string; asset_id?: string }[]
  error?: { message?: string }
  error_message?: string
}
export type Api = {
  request<T = unknown>(
    path: string,
    init?: {
      method?: string
      body?: BodyInit
      signal?: AbortSignal
      headers?: HeadersInit
    },
  ): Promise<T>
}

/**
 * Convert transport and gateway failures into concise, actionable UI copy.
 * The SDK keeps HTTP status/code/details on AppSdkError; callers must not
 * blindly surface the raw upstream message because it often only says
 * "Bad Gateway" and gives the user no way to recover. This helper never
 * retries a request or includes provider credentials.
 */
export function friendlyErrorMessage(error: unknown, fallback = '操作失败，请稍后重试'): string {
  if (error instanceof DOMException && error.name === 'AbortError') return '已停止当前操作。'
  const value = error && typeof error === 'object' ? error as Record<string, unknown> : {}
  const details = value.details && typeof value.details === 'object' ? value.details as Record<string, unknown> : {}
  const nested = details.error && typeof details.error === 'object' ? details.error as Record<string, unknown> : {}
  const status = [value.status, value.statusCode, details.status, nested.status]
    .find((v): v is number => typeof v === 'number')
  // A generic SDK code must not hide a more specific gateway classification.
  const code = [value, details, nested].flatMap(item =>
    [item.code, item.error_code, item.type, item.error_type, item.error_class],
  ).filter((v): v is string => typeof v === 'string' && !!v.trim()).join(' ').toLowerCase()
  const raw = [nested.message, details.message, value.message]
    .find((v): v is string => typeof v === 'string' && !!v.trim())?.trim() || ''

  if (code.includes('media_task_timeout') && (details.task_id || nested.task_id || value.task_id))
    return '图片任务仍在处理中，可在作品中继续查询，无需重新生成。'
  if (/provider_dispatch_blocked|account_pool_unavailable|route_unavailable|no_alternative_provider/.test(code))
    return '当前模型暂无可用服务通道，请稍后重试，或在“模型设置”刷新并切换模型。'
  if (/upstream_(quota|auth|account)_unavailable|upstream_challenge|upstream_overloaded/.test(code))
    return '上游模型资源暂时不可用，请稍后重试，或在“模型设置”切换模型。'
  if (status === 504 || /upstream.*timeout|timeout_error/.test(code))
    return '模型响应超时，请稍后重试或切换模型。已提交的图片任务可在作品中继续查询，不会自动重复提交。'
  if (code.includes('model_not_found') || code.includes('model_unavailable') || /model.?not.?found|模型.*不存在|模型.*不可用/i.test(raw))
    return '当前模型暂不可用，请打开“模型设置”刷新模型列表并切换可用模型后重试。'
  if (code.includes('quota') || code.includes('insufficient_balance') || status === 402)
    return '当前模型额度或并发已达到限制，请稍后重试，或在“模型设置”切换其他可用模型。'
  if (status === 429 || /rate_limit/.test(code))
    return '当前模型请求受限，请稍后重试，或在“模型设置”切换其他可用模型。'
  if (status === 401 || code.includes('session_expired') || code.includes('unauthorized'))
    return '账户连接已过期，请重新加载应用恢复连接后重试。'
  if (status === 403 || code.includes('forbidden'))
    return '当前账户没有调用该模型的权限，请切换可用模型或联系管理员开通权限。'
  if (status === 404 && (code.includes('model') || /model/i.test(raw)))
    return '当前模型未配置供应通道，请打开“模型设置”刷新列表并选择其他模型。'
  if (status === 502 || status === 503 || /bad gateway|upstream|供应通道|上游.*不可用|暂时不可用|temporarily unavailable/i.test(raw))
    return '上游模型服务暂时不可用。请稍后重试，或打开“模型设置”刷新并切换其他可用模型。已提交的任务不会自动重复提交。'
  if (/failed to fetch|networkerror|网络|连接/i.test(raw))
    return '网络连接暂时不可用，请检查网络后重试。已提交的任务不会自动重复提交。'
  return raw || fallback
}

/**
 * Map failures from the workspace bootstrap to copy that matches the resource
 * being loaded. Storage and model catalog requests share the Gateway data
 * plane, but a 429 from storage does not mean that the selected model is unavailable.
 */
export type WorkspaceResource = 'models' | 'history' | 'preferences'

export type ResourceDiagnostic = {
  code?: string
  status?: number
  requestId?: string
}

type ErrorRecord = Record<string, unknown>

function errorRecords(error: unknown): ErrorRecord[] {
  if (!error || typeof error !== 'object') return []
  const root = error as ErrorRecord
  const details = root.details && typeof root.details === 'object' ? root.details as ErrorRecord : undefined
  const nested = details?.error && typeof details.error === 'object' ? details.error as ErrorRecord : undefined
  return [root, details, nested].filter((value): value is ErrorRecord => Boolean(value))
}

function errorStrings(error: unknown, keys: string[]): string[] {
  return errorRecords(error)
    .flatMap(record => keys.map(key => record[key]))
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    .map(value => value.trim())
}

function safeDiagnosticValue(value: string): string | undefined {
  return /^[A-Za-z0-9._:-]{1,100}$/.test(value) ? value : undefined
}

/** Extract only non-sensitive request metadata for an expandable UI diagnostic. */
export function resourceDiagnostic(error: unknown): ResourceDiagnostic {
  const status = errorRecords(error)
    .flatMap(record => [record.status, record.statusCode])
    .find((value): value is number => typeof value === 'number' && Number.isInteger(value))
  const codes = errorStrings(error, ['code', 'error_code', 'type', 'error_type', 'error_class'])
  const code = safeDiagnosticValue(
    codes.find(value => !/^app_(?:api_error|request_failed|unknown)$/i.test(value)) || codes[0] || '',
  )
  const requestId = safeDiagnosticValue(errorStrings(error, ['requestId', 'request_id'])[0] || '')
  return {
    ...(code ? { code } : {}),
    ...(status !== undefined ? { status } : {}),
    ...(requestId ? { requestId } : {}),
  }
}

export function resourceDiagnosticList(error: unknown): ResourceDiagnostic[] {
  const values: unknown[] = [error]
  if (error && typeof error === 'object') {
    const nested = (error as { errors?: unknown }).errors
    if (nested && typeof nested === 'object' && !Array.isArray(nested)) values.push(...Object.values(nested))
  }
  const seen = new Set<string>()
  return values.map(resourceDiagnostic).filter(value => {
    const key = JSON.stringify(value)
    if (seen.has(key)) return false
    seen.add(key)
    return Boolean(value.code || value.status !== undefined || value.requestId)
  })
}

function resourceErrorCode(error: unknown): string {
  return errorStrings(error, ['code', 'error_code', 'type', 'error_type', 'error_class']).join(' ').toLowerCase()
}

function resourceErrorText(error: unknown): string {
  return errorStrings(error, ['message']).join(' ').toLowerCase()
}

function resourceIsRuntimeUnavailable(error: unknown): boolean {
  const haystack = `${resourceErrorCode(error)} ${resourceErrorText(error)}`
  return /local[_-]?dev.*runtime|runtime.*not.*configured|app_runtime_not_configured|app_session_(unavailable|create_failed|refresh_unavailable)|bridge.*unavailable/.test(haystack)
}

function resourceIsSessionError(error: unknown): boolean {
  const code = resourceErrorCode(error)
  const status = resourceDiagnostic(error).status
  return status === 401 || /session_expired|session_invalid|unauthorized|auth_changed/.test(code)
}

function resourceIsPermissionError(error: unknown): boolean {
  const code = resourceErrorCode(error)
  const status = resourceDiagnostic(error).status
  return status === 403 || /forbidden|permission|scope/.test(code)
}

function resourceIsRateLimited(error: unknown): boolean {
  const code = resourceErrorCode(error)
  const status = resourceDiagnostic(error).status
  return status === 429 || /(?:^|[^a-z])(?:app_)?rate[_-]?limited?(?:$|[^a-z])|rate_limit/.test(code)
}

function resourceIsNetworkError(error: unknown): boolean {
  const code = resourceErrorCode(error)
  const text = resourceErrorText(error)
  return /network|failed_to_fetch|connection_refused|timeout/.test(code)
    || /failed to fetch|networkerror|network error|网络|连接失败|connection refused|timeout/.test(text)
}

function resourceIsUpstreamError(error: unknown): boolean {
  const code = resourceErrorCode(error)
  const text = resourceErrorText(error)
  const status = resourceDiagnostic(error).status
  return status === 502 || status === 503 || /bad_gateway|upstream|gateway/.test(`${code} ${text}`)
}

export function friendlyResourceErrorMessage(
  error: unknown,
  resource: WorkspaceResource,
  fallback?: string,
): string {
  const label = resource === 'models' ? '模型列表' : resource === 'history' ? '作品记录' : '偏好设置'
  const catalogErrors = resource === 'models' && error && typeof error === 'object'
    ? (error as { errors?: unknown }).errors
    : undefined
  if (catalogErrors && typeof catalogErrors === 'object' && !Array.isArray(catalogErrors)) {
    const entries = Object.entries(catalogErrors)
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) => `${key === 'images' ? '图片模型' : key === 'text' ? '文本模型' : key}：${friendlyResourceErrorMessage(value, 'models')}`)
    if (entries.length) return `模型目录未加载：${entries.join('；')}`
  }
  if (resourceIsRuntimeUnavailable(error))
    return `${label}依赖平台运行时，当前连接未恢复。请通过平台开发环境重新打开应用。`
  if (resourceIsSessionError(error))
    return `${label}未加载，账户连接已过期。请重新连接后重试。`
  if (resourceIsPermissionError(error))
    return `${label}暂无访问权限，请检查应用权限或联系管理员。`
  if (resourceIsRateLimited(error))
    return resource === 'models'
      ? '模型目录请求过于频繁，请稍后再刷新。'
      : resource === 'history'
        ? '作品记录同步请求过于频繁，请稍后重试。'
        : '偏好设置同步请求过于频繁，请稍后重试。'
  if (resourceIsNetworkError(error))
    return `${label}连接失败，请检查网络或平台运行时后重试。`
  if (resourceIsUpstreamError(error))
    return `${label}服务暂时不可用，请稍后重试。`
  if (fallback) return fallback
  return resource === 'models'
    ? `模型列表未加载，请稍后刷新模型目录。`
    : resource === 'history'
      ? '作品记录未加载，当前无法保证显示已有作品。'
      : '偏好设置未同步，当前选择不会保证保存到下次打开。'
}
export type Work = {
  id: string
  batch: string
  title: string
  scene: string
  pose: string
  ratio: string
  model: string
  createdAt: string
  kind: 'tryon' | 'model' | 'product' | 'detail' | 'clone'
  text?: string
  batchSize?: number
  position?: number
  plan?: { direction: string; brief: string }
  quality?: QualityReport
  reviewKey?: string
  status: 'queued' | 'running' | 'completed' | 'failed' | 'paused' | 'skipped'
  images: ImageResult[]
  taskId?: string
  assetIds?: string[]
  error?: string
}

export const SCENES = [
  {
    id: 'studio',
    name: '纯色棚拍',
    prompt: '浅灰色无缝影棚背景，柔和均匀的专业柔光箱照明，干净的地面阴影',
    color: '#e7e8e5',
  },
  {
    id: 'city',
    name: '都市街头',
    prompt: '现代城市街道，浅色建筑立面，清晨自然光，干净的街拍构图',
    color: '#cbd5d7',
  },
  {
    id: 'cafe',
    name: '街角咖啡',
    prompt: '街角咖啡馆外，法式门窗与户外座椅，午后柔和日光',
    color: '#d6b4aa',
  },
  {
    id: 'grass',
    name: '自然草坪',
    prompt: '宽阔绿色草坪与远景树木，明亮柔和自然光，清新户外氛围',
    color: '#a6bea4',
  },
  {
    id: 'beach',
    name: '度假海滩',
    prompt: '清澈海水旁的安静海滩，柔和日光，海风轻拂服装',
    color: '#a8cfd4',
  },
  {
    id: 'home',
    name: '温馨居家',
    prompt: '简洁的现代客厅，窗边柔光，浅色沙发与少量植物',
    color: '#d2bfad',
  },
  {
    id: 'gallery',
    name: '艺术展馆',
    prompt: '极简白色艺术展馆，现代雕塑，散射天光与留白',
    color: '#c6bcd0',
  },
] as const

export const POSES = [
  {
    id: 'front',
    name: '正面全身',
    prompt: '正面全身站姿，自然垂手，头顶与鞋子完整入镜',
  },
  {
    id: 'walking',
    name: '自然行走',
    prompt: '四分之三侧面的自然行走姿势，完整全身，展现服装垂坠感',
  },
  {
    id: 'side',
    name: '侧身回眸',
    prompt: '侧身回眸的自然站姿，完整全身，展示服装侧面剪裁',
  },
  {
    id: 'detail',
    name: '半身细节',
    prompt: '正面或微侧的半身构图，清晰呈现领口、面料与上身细节',
  },
] as const

export function records(payload: unknown): Record<string, unknown>[] {
  if (Array.isArray(payload))
    return payload.filter(
      (v): v is Record<string, unknown> => !!v && typeof v === 'object',
    )
  if (payload && typeof payload === 'object') {
    const value = payload as Record<string, unknown>
    return records(value.data ?? value.items)
  }
  return []
}

export function imageModels(payload: unknown): ImageModel[] {
  return records(payload)
    .filter((v) => typeof v.id === 'string')
    .map((v) => v as ImageModel)
}

export function supports(model: ImageModel, operation: 'edit' | 'generation') {
  return (
    model.available !== false &&
    !!model.supported_operations?.includes(operation)
  )
}

export function selectImageEditModel(
  catalog: ImageModel[],
  ...preferredIds: (string | undefined)[]
): ImageModel | undefined {
  const usable = catalog.filter(
    (model) => supports(model, 'edit') && Number.isInteger(model.max_input_images) && (model.max_input_images || 0) >= 1,
  )
  for (const id of preferredIds) {
    const preferred = usable.find((model) => model.id === id)
    if (preferred) return preferred
  }
  return usable[0]
}

export function imageModelAvailabilityMessage(catalog: ImageModel[]): string {
  if (!catalog.length)
    return '图片模型列表为空，请刷新重试；若持续为空，请联系管理员检查图片模型配置。'
  const editors = catalog.filter((model) => model.supported_operations?.includes('edit'))
  if (!editors.length)
    return '当前图片模型尚未开放图片编辑能力，商品创作和服饰穿戴需要支持图片编辑的模型。'
  if (editors.every((model) => model.available === false))
    return '图片编辑服务暂不可用：当前没有可用的供应通道。可刷新重试；若持续出现，请联系管理员检查供应通道。'
  if (!selectImageEditModel(catalog))
    return '可用图片编辑模型未声明有效的参考图数量，暂无法使用上传图片。请联系管理员检查模型能力配置。'
  return ''
}

// Use exact, advertised dimensions or a validated variable size. Never send an
// unsupported ratio and silently crop the returned clothing photograph.
export function sizeForRatio(model: ImageModel, ratio: string): string | null {
  const [rw, rh] = ratio.split(':').map(Number)
  if (!rw || !rh || !Number.isFinite(rw / rh)) return null
  if (
    model.supported_aspect_ratios?.length &&
    !model.supported_aspect_ratios.includes(ratio)
  )
    return null
  const fixed = model.supported_sizes?.find((size) => {
    const [w, h] = size.split('x').map(Number)
    return w > 0 && h > 0 && Math.abs(w / h - rw / rh) < 0.001
  })
  if (fixed) return fixed
  if (!['auto', 'both'].includes(model.size_mode || '')) return null
  const c = model.size_constraints
  if (!c) return null
  const step = Math.max(1, c.multiple_of || 16)
  for (
    let h = Math.ceil((c.min_height || 768) / step) * step;
    h <= Math.min(c.max_height || 2048, 4096);
    h += step
  ) {
    const w = (h * rw) / rh
    if (
      !Number.isInteger(w) ||
      w % step ||
      w < (c.min_width || 1) ||
      w > (c.max_width || 4096)
    )
      continue
    if (w * h < (c.min_pixels || 786432) || w * h > (c.max_pixels || 16777216))
      continue
    if (c.max_aspect_ratio && Math.max(w / h, h / w) > c.max_aspect_ratio)
      continue
    return `${w}x${h}`
  }
  return null
}

export function resultImages(value: ImageResponse): ImageResult[] {
  return (value.data || []).flatMap((item) => {
    if (item.url && /^https?:\/\//i.test(item.url)) return [{ url: item.url, ...(typeof item.asset_id === 'string' && /^[A-Za-z0-9_-]{1,160}$/.test(item.asset_id) ? { assetId: item.asset_id } : {}) }]
    if (item.b64_json && /^[A-Za-z0-9+/=\s]+$/.test(item.b64_json)) {
      const base64 = item.b64_json.replace(/\s/g, '')
      let mime = 'png'
      try {
        const header = atob(base64.slice(0, 16))
        if (header.startsWith('\xff\xd8\xff')) mime = 'jpeg'
        else if (header.startsWith('RIFF') && header.slice(8, 12) === 'WEBP') mime = 'webp'
      } catch { /* Invalid bytes will be rejected when the image is loaded. */ }
      return [{ url: `data:image/${mime};base64,${base64}` }]
    }
    return []
  })
}

export function taskId(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') return undefined
  const record = value as Record<string, unknown>
  const id = record.task_id || record.id
  return typeof id === 'string' && /^[A-Za-z0-9_-]{1,160}$/.test(id)
    ? id
    : undefined
}

export class PendingTaskError extends Error {
  taskId: string
  constructor(id: string) {
    super('任务仍在生成，可在作品中继续查询。')
    this.taskId = id
  }
}

export class TerminalTaskError extends Error {}

function delay(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('已停止等待', 'AbortError'))
      return
    }
    const abort = () => {
      clearTimeout(timer)
      reject(new DOMException('已停止等待', 'AbortError'))
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', abort)
      resolve()
    }, ms)
    signal?.addEventListener('abort', abort, { once: true })
  })
}

export async function pollImage(
  api: Api,
  id: string,
  options: { signal?: AbortSignal; interval?: number; attempts?: number } = {},
): Promise<ImageResult[]> {
  if (!taskId({ id })) throw new Error('图片任务编号无效')
  for (let attempt = 0; attempt < (options.attempts ?? 200); attempt++) {
    if (options.signal?.aborted)
      throw new DOMException('已停止等待', 'AbortError')
    const response = await api.request<ImageResponse>(
      `/images/tasks/${encodeURIComponent(id)}`,
      { signal: options.signal },
    )
    if (
      ['failed', 'cancelled', 'expired', 'refunded'].includes(
        response.status || '',
      )
    )
      throw new TerminalTaskError(
        response.error?.message ||
          response.error_message ||
          '图片任务未完成，请调整素材后重试',
      )
    const images = resultImages(response)
    if (images.length) return images
    if (response.status === 'completed')
      throw new TerminalTaskError('任务已完成，但没有返回图片')
    await delay(options.interval ?? 3000, options.signal)
  }
  throw new PendingTaskError(id)
}

export async function submitImage(
  api: Api,
  path: '/images/edits' | '/images/generations',
  body: BodyInit,
  options: {
    signal?: AbortSignal
    onTask?: (id: string) => void | Promise<void>
    interval?: number
    attempts?: number
    idempotencyKey?: string
  } = {},
): Promise<ImageResult[]> {
  let response: ImageResponse
  if (options.signal?.aborted)
    throw new DOMException('已停止等待', 'AbortError')
  // This application's works library needs durable images. Declare that at
  // the application boundary; the generic gateway/SDK defaults to base64.
  if (typeof body === 'string') {
    const payload = JSON.parse(body)
    if (!payload.response_format) body = JSON.stringify({ ...payload, response_format: 'url' })
  } else if (body instanceof FormData && !body.get('response_format')) {
    const form = new FormData()
    body.forEach((value, key) => form.append(key, value))
    form.set('response_format', 'url')
    body = form
  }
  try {
    // Receive the task handle before stopping; aborting a submitted POST can
    // otherwise orphan a task that the platform has already begun charging.
    response = await api.request<ImageResponse>(path, {
      method: 'POST',
      body,
      headers: {
        'Idempotency-Key': options.idempotencyKey || crypto.randomUUID(),
      },
    })
  } catch (error) {
    const e = error as { details?: unknown }
    const id = taskId(e.details)
    if (!id) throw error
    await options.onTask?.(id)
    return pollImage(api, id, options)
  }
  const id = taskId(response)
  if (id) await options.onTask?.(id)
  if (
    ['failed', 'cancelled', 'expired', 'refunded'].includes(
      response.status || '',
    )
  )
    throw new TerminalTaskError(
      response.error?.message || response.error_message || '图片生成失败',
    )
  const images = resultImages(response)
  if (images.length) return images
  if (response.status === 'completed')
    throw new TerminalTaskError('任务已完成，但没有返回图片')
  if (id) return pollImage(api, id, options)
  throw new Error('平台未返回图片或任务编号，请查询用量后再试')
}

export function buildTryOnPrompt(
  scene: string,
  pose: string,
  extra: string,
  garmentCount: number,
  sheet: boolean,
) {
  return [
    '生成一张真实的电商服装模特摄影作品。图1是模特身份参考，保留同一个人的五官、发型、肤色和自然身体比例。',
    sheet
      ? `图2是包含${garmentCount}张服饰参考图的带编号参考板。将参考板中不同品类组合成一套穿搭，同款不同角度仅作为细节参考。`
      : `图2起是${garmentCount}张服饰参考图，将不同品类组合成一套穿搭，同款不同角度仅作为细节参考。`,
    '以服饰参考为准替换模特原有穿搭，准确保留颜色、纹理、图案、标志、款式和剪裁，真实贴合人体，避免额外肢体。',
    `拍摄场景：${scene}。镜头与姿势：${pose}。`,
    extra.trim() ? `补充要求：${extra.trim()}` : '',
    '只输出一张完整照片，不输出拼贴、参考板、分屏、文字、编号、水印或对比图。',
  ]
    .filter(Boolean)
    .join('\n')
}

export function responseText(payload: unknown): string {
  if (!payload || typeof payload !== 'object') return ''
  const value = payload as Record<string, unknown>
  if (typeof value.output_text === 'string') return value.output_text.trim()
  return records(value.output)
    .flatMap((item) => records(item.content))
    .map((part) => (typeof part.text === 'string' ? part.text : ''))
    .join('\n')
    .trim()
}

export function restoreHistory(value: unknown): Work[] {
  if (!Array.isArray(value)) return []
  return value
    .filter(
      (v): v is Work =>
        !!v &&
        typeof v === 'object' &&
        typeof v.id === 'string' &&
        typeof v.title === 'string' &&
        typeof v.createdAt === 'string' &&
        Array.isArray(v.images),
    )
    .slice(0, 40)
    .map((v) => {
      const images = v.images.filter(
        (i) => typeof i?.url === 'string' && /^https?:\/\//i.test(i.url),
      )
      const savedTaskId = taskId({ id: v.taskId })
      const status: Work['status'] = ['queued', 'running'].includes(v.status)
        ? savedTaskId
          ? 'paused'
          : 'skipped'
        : v.status === 'completed' && !images.length && (savedTaskId || v.assetIds?.length)
          ? 'paused'
          : v.status
      const quality = v.quality?.status === 'checking'
        ? { ...v.quality, status: 'unavailable' as const, summary: '上次检查未完成，图片已保留，可在详情中重新检查。', issues: [], checkedAt: '' }
        : v.quality
      return { ...v, images, taskId: savedTaskId, status, ...(quality ? { quality } : {}) }
    })
}

export function historyForStorage(works: Work[]) {
  const saved: Work[] = []
  for (const work of works.slice(0, 40)) {
    const item = {
      ...work,
      images: work.images.filter((image) => /^https?:\/\//i.test(image.url)),
    }
    if (work.status === 'completed' && !item.images.length && !item.taskId && !work.text)
      continue
    if (
      new TextEncoder().encode(JSON.stringify([...saved, item])).length > 180000
    )
      break
    saved.push(item)
  }
  return saved
}
