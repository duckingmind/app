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

export type ImageResult = { url: string }
export type ImageResponse = {
  id?: string
  task_id?: string
  status?: string
  data?: { url?: string; b64_json?: string }[]
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
    if (item.url && /^https?:\/\//i.test(item.url)) return [{ url: item.url }]
    if (item.b64_json && /^[A-Za-z0-9+/=\s]+$/.test(item.b64_json))
      return [{ url: `data:image/png;base64,${item.b64_json}` }]
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
    onTask?: (id: string) => void
    interval?: number
    attempts?: number
    idempotencyKey?: string
  } = {},
): Promise<ImageResult[]> {
  let response: ImageResponse
  if (options.signal?.aborted)
    throw new DOMException('已停止等待', 'AbortError')
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
    options.onTask?.(id)
    return pollImage(api, id, options)
  }
  const id = taskId(response)
  if (id) options.onTask?.(id)
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
        : v.status === 'completed' && !images.length && savedTaskId
          ? 'paused'
          : v.status
      return { ...v, images, taskId: savedTaskId, status }
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
