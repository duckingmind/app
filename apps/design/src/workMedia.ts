import { resultImages, type Api, type ImageResponse, type Work } from './core.ts'

function assetIds(work: Work) {
  return [...new Set([...(work.assetIds || []), ...work.images.flatMap(image => image.assetId ? [image.assetId] : [])])]
    .filter(id => /^[A-Za-z0-9_-]{1,160}$/.test(id))
}
function unavailableTask(error: unknown) {
  if (!error || typeof error !== 'object') return false
  const value = error as { status?: number; statusCode?: number; code?: string }
  return [value.status, value.statusCode].some(status => status === 404 || status === 410) || /task_(not_found|expired)/i.test(value.code || '')
}
async function refreshAssets(api: Api, work: Work, ids: string[]): Promise<Work> {
  const images: { url: string; assetId: string }[] = []
  // Resolve only this work's asset IDs, with at most three requests in flight.
  for (let index = 0; index < ids.length; index += 3) {
    const batch = await Promise.all(ids.slice(index, index + 3).map(async id => {
      const asset = await api.request<{ id: string; url: string }>(`/media/assets/${encodeURIComponent(id)}`)
      if (asset.id !== id || !/^https?:\/\//i.test(asset.url)) throw new Error('素材已删除或不可访问，请在素材库核对。')
      return { url: asset.url, assetId: id }
    }))
    images.push(...batch)
  }
  return { ...work, images, assetIds: ids, status: 'completed', error: undefined }
}

/** Refresh handles through the authenticated platform, never by replaying a POST. */
export async function refreshWorkMedia(api: Api, work: Work): Promise<Work> {
  const ids = assetIds(work)
  if (work.taskId) {
    let response: ImageResponse
    try { response = await api.request<ImageResponse>(`/images/tasks/${encodeURIComponent(work.taskId)}?response_format=url`) }
    catch (error) {
      if (ids.length && unavailableTask(error)) return refreshAssets(api, work, ids)
      throw error
    }
    const images = resultImages(response)
    if (images.length) return { ...work, images, status: 'completed', error: undefined,
      assetIds: [...new Set([...ids, ...images.flatMap(image => image.assetId ? [image.assetId] : [])])] }
    if (ids.length && ['expired', 'completed'].includes(response.status || '')) return refreshAssets(api, work, ids)
    if (['failed', 'cancelled', 'expired', 'refunded'].includes(response.status || ''))
      return { ...work, images: [], status: 'failed', error: response.error?.message || response.error_message || '任务未完成或素材已删除' }
    return { ...work, images: [], status: 'paused', error: '任务尚未返回图片，可稍后继续查询。' }
  }
  return ids.length ? refreshAssets(api, work, ids) : work
}
