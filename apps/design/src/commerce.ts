import { PendingTaskError, TerminalTaskError, submitImage, type Api, type ImageResult, type Work } from './core.ts'
import type { Photo } from './images.ts'

export type CommerceJob = { id?: string; type?: string; title: string; prompt: string; references?: Photo[] }
export type CommerceRequest = {
  kind: 'product' | 'detail' | 'clone'
  ratio: string
  products: Photo[]
  jobs: CommerceJob[]
  planningMode?: 'smart' | 'fixed'
  planningPrompt?: string
  listingPrompt?: string
}

// Reserve a separate image for layout references when replacing a product.
export function referenceLayout(products: number, references: number, maximum: number) {
  if (!Number.isInteger(maximum) || maximum < 1) throw new Error('所选模型未声明可用的参考图数量')
  if (references && products && maximum < 2) throw new Error('替换商品需要至少支持两张参考图的图片模型')
  return {
    productSheet: products > maximum - (references ? 1 : 0),
    referenceSheet: references > 1,
  }
}

export function referenceInstructions(products: number, references: number, sheet: boolean) {
  return [
    references ? '图1为排版与视觉风格参考；只参考它的构图、色彩、文字层级及光影。' : '',
    references > 1 ? `图1已将${references}张视觉参考合并为带 STYLE 编号的参考板。提取共同的视觉方向，不把参考板的拼贴布局、分隔或编号输出到成图中。` : '',
    products ? `${references ? '图2起' : '全部输入图片'}为同一商品的${products}张原始外观参考${sheet ? '，已合并为带 PRODUCT 编号的参考板' : ''}。保持商品形状、颜色、品牌、结构与材质一致，禁止将参考板拼贴或编号输出到成图中。` : '',
    '商品参数、规格、认证与宣传主张只能采用用户明确提供的信息，不从视觉猜测，不编造销量、奖项或性能数值。',
  ].filter(Boolean).join('\n')
}

export type ImageJobActivity = {
  total: number
  queued: number
  running: number
  completed: number
  failed: number
  paused: number
  skipped: number
  // Reviews use their own pool and do not occupy image slots.
  reviewing: number
  reviewQueued: number
}

export async function runCommerceJobs(options: {
  api: Api
  works: Work[]
  signal: AbortSignal
  path?: '/images/edits' | '/images/generations'
  concurrency?: number
  reviewConcurrency?: number
  prepare: (index: number) => Promise<BodyInit>
  onUpdate: (id: string, patch: Partial<Work>) => void
  persistTask?: () => Promise<void>
  onProgress?: (index: number) => void
  onActivity?: (activity: ImageJobActivity) => void
  onCompleted?: (work: Work, images: ImageResult[], index: number) => Promise<void>
}): Promise<void> {
  const { works, signal, onUpdate } = options
  const concurrency = options.concurrency ?? 3
  const reviewConcurrency = options.reviewConcurrency ?? 2
  for (const limit of [concurrency, reviewConcurrency]) {
    if (!Number.isInteger(limit) || limit < 1) throw new Error('并发数量必须是正整数')
  }
  const states = works.map((): Work['status'] => 'queued')
  const pendingReviews: { index: number; images: ImageResult[] }[] = []
  const activeReviews = new Set<Promise<void>>()
  let nextIndex = 0
  let stopped = false
  let firstError: unknown

  function activity() {
    const snapshot: ImageJobActivity = {
      total: works.length, queued: 0, running: 0, completed: 0,
      failed: 0, paused: 0, skipped: 0,
      reviewing: activeReviews.size, reviewQueued: pendingReviews.length,
    }
    for (const state of states) snapshot[state]++
    options.onActivity?.(snapshot)
  }

  function update(index: number, patch: Partial<Work>) {
    if (patch.status) states[index] = patch.status
    onUpdate(works[index].id, patch)
  }

  function skipQueued() {
    for (let index = 0; index < works.length; index++) {
      if (states[index] === 'queued')
        update(index, { status: 'skipped', error: '已停止后续生成，本张尚未提交。' })
    }
  }

  function reviewUnavailable(index: number, error?: unknown) {
    update(index, {
      quality: {
        status: 'unavailable',
        summary: signal.aborted
          ? '已停止质量检查，生成图片已保留。'
          : error instanceof Error && error.message
            ? error.message.slice(0, 600)
            : '质量检查暂不可用，生成图片已保留。',
        issues: [],
        checkedAt: new Date().toISOString(),
      },
    })
  }

  function startReviews() {
    if (signal.aborted) {
      for (const review of pendingReviews.splice(0)) reviewUnavailable(review.index)
      activity()
      return
    }
    while (pendingReviews.length && activeReviews.size < reviewConcurrency) {
      const { index, images } = pendingReviews.shift()!
      // Defer the hook until the promise is registered, including synchronous hooks.
      const review = Promise.resolve().then(async () => {
        if (signal.aborted) { reviewUnavailable(index); return }
        try {
          await options.onCompleted!(works[index], images, index)
        } catch (error) {
          // Review failures must never turn successfully generated images into failures.
          reviewUnavailable(index, error)
        }
      }).finally(() => {
        activeReviews.delete(review)
        startReviews()
      })
      activeReviews.add(review)
    }
    activity()
  }

  async function generate() {
    while (!stopped && !signal.aborted && nextIndex < works.length) {
      const index = nextIndex++
      const work = works[index]
      let remoteId: string | undefined
      update(index, { status: 'running' })
      options.onProgress?.(index)
      activity()
      let images: ImageResult[]
      try {
        const body = await options.prepare(index)
        if (stopped && !signal.aborted) {
          update(index, { status: 'skipped', error: '已停止后续生成，本张尚未提交。' })
          activity()
          return
        }
        images = await submitImage(options.api, options.path ?? '/images/edits', body, {
          signal,
          idempotencyKey: work.id,
          onTask: async id => { remoteId = id; update(index, { taskId: id }); await options.persistTask?.() },
        })
      } catch (error) {
        const paused = !(error instanceof TerminalTaskError) && (!!remoteId || error instanceof PendingTaskError)
        update(index, {
          status: paused ? 'paused' : signal.aborted && !remoteId ? 'skipped' : 'failed',
          error: signal.aborted ? '已停止等待，已提交任务仍可能完成。' : error instanceof Error ? error.message : '生成失败',
        })
        if (!stopped) firstError = error
        stopped = true
        skipQueued()
        activity()
        return
      }
      update(index, { status: 'completed', images })
      if (!signal.aborted && options.onCompleted) pendingReviews.push({ index, images })
      // Starting a review releases this generation slot immediately.
      startReviews()
    }
  }

  const onAbort = () => {
    skipQueued()
    startReviews()
  }
  signal.addEventListener('abort', onAbort, { once: true })
  try {
    if (signal.aborted) onAbort()
    activity()
    // Each worker catches generation errors; all already submitted requests settle
    // before the owner can finalize the batch or offer a new generation action.
    await Promise.all(Array.from({ length: Math.min(concurrency, works.length) }, generate))
    startReviews()
    while (activeReviews.size) await Promise.all([...activeReviews])
    activity()
    if (stopped) throw firstError
  } finally {
    signal.removeEventListener('abort', onAbort)
  }
}
