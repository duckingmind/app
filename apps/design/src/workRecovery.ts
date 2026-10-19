import type { Work } from './core.ts'

export type WorkRecovery = { action: 'wait' | 'query' | 'retry' | 'configure' | 'details'; label?: string; hint: string }

/** Only a known task may be polled and only a retained request may be retried. */
export function workRecovery(work: Work, canRetry = false): WorkRecovery {
  if (work.images.length > 0) return { action: 'details', hint: '图片已经生成，可查看详情。' }
  if (work.status === 'queued' || work.status === 'running') {
    return { action: 'wait', hint: work.status === 'queued' ? '等待提交，开始后会自动更新。' : '正在处理，取得结果后会自动更新。' }
  }
  if (work.status === 'paused') {
    return (work.taskId || work.assetIds?.length)
      ? { action: 'query', label: '继续查询', hint: '任务已提交，继续查询会获取原任务的结果。' }
      : { action: 'details', hint: '尚未确认生成结果，缺少可查询的任务信息。请先查看详情，避免重复提交。' }
  }
  if (work.status === 'failed' || work.status === 'skipped') {
    return canRetry
      ? { action: 'retry', label: work.status === 'failed' ? '重试这一项' : '生成这一项', hint: '将使用本次保存的素材与参数提交这一项，并消耗模型额度。' }
      : { action: 'configure', label: '准备新任务', hint: '此项目暂不能直接重试，请在新任务设置中重新提供素材并确认参数。' }
  }
  return { action: 'details', hint: '记录中尚无可展示的图片，请查看任务详情。' }
}

export function downloadableImageCount(works: Work[]): number {
  return works.reduce((total, work) => total + work.images.length, 0)
}
