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

export async function runCommerceJobs(options: {
  api: Api
  works: Work[]
  signal: AbortSignal
  prepare: (index: number) => Promise<FormData>
  onUpdate: (id: string, patch: Partial<Work>) => void
  onProgress?: (index: number) => void
  onCompleted?: (work: Work, images: ImageResult[], index: number) => Promise<void>
}): Promise<void> {
  const { works, signal, onUpdate } = options
  for (let index = 0; index < works.length; index++) {
    if (signal.aborted) break
    const work = works[index]
    let remoteId: string | undefined
    let images: ImageResult[]
    onUpdate(work.id, { status: 'running' })
    options.onProgress?.(index)
    try {
      const body = await options.prepare(index)
      images = await submitImage(options.api, '/images/edits', body, {
        signal,
        idempotencyKey: work.id,
        onTask: id => { remoteId = id; onUpdate(work.id, { taskId: id }) },
      })
    } catch (error) {
      const paused = !(error instanceof TerminalTaskError) && (!!remoteId || error instanceof PendingTaskError)
      onUpdate(work.id, {
        status: paused ? 'paused' : signal.aborted && !remoteId ? 'skipped' : 'failed',
        error: signal.aborted ? '已停止等待，已提交任务仍可能完成。' : error instanceof Error ? error.message : '生成失败',
      })
      // The owner finalizes remaining queued rows from its latest state.
      throw error
    }
    onUpdate(work.id, { status: 'completed', images })
    if (!signal.aborted && options.onCompleted) {
      try {
        await options.onCompleted(work, images, index)
      } catch (error) {
        // Reviewing an image is independent of its successful generation.
        // Keep the result downloadable and continue unless the user stopped.
        onUpdate(work.id, {
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
    }
  }
}
