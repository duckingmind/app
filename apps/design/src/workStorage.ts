import { restoreHistory, type Work } from './core.ts'

type Storage = {
  get<T>(key: string): Promise<T | null>
  set(key: string, value: unknown): Promise<unknown>
  delete(key: string): Promise<unknown>
}

type IndexEntry = Pick<Work, 'id' | 'batch' | 'status' | 'taskId' | 'position' | 'batchSize' | 'reviewKey'> & {
  detailKey: string
}
type StoredEntry = { id: string; detailKey?: string; reviewKey?: string; legacy?: Work }

const HISTORY_KEY = 'design:works:v1'
const MAX_WORKS = 40
const MAX_BYTES = 180000
const SAFE_ID = /^[A-Za-z0-9_-]{1,160}$/
const SAFE_REVIEW_KEY = /^design:review:[A-Za-z0-9_-]{1,160}$/
const MISSING_IMAGE = '图片未保存在作品记录中，刷新后无法恢复；请在原生成页面及时下载图片。'

function failure(message: string): Error {
  return new Error(`作品存储未完成：${message}`)
}

function detailKey(id: unknown): string {
  if (typeof id !== 'string' || !SAFE_ID.test(id)) throw failure('作品编号无效')
  return `design:work:${id}`
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw failure('作品记录格式无效')
  return value as Record<string, unknown>
}

function normalizedWork(value: unknown, expectedId?: string): Work {
  const work = record(value)
  detailKey(work.id)
  if (expectedId && work.id !== expectedId) throw failure('作品详情与索引编号不一致，请重新连接账户')
  if (
    !['batch', 'title', 'scene', 'pose', 'ratio', 'model', 'createdAt'].every(key => typeof work[key] === 'string') ||
    !['tryon', 'model', 'product', 'detail', 'clone'].includes(String(work.kind)) ||
    !['queued', 'running', 'completed', 'failed', 'paused', 'skipped'].includes(String(work.status)) ||
    !Array.isArray(work.images)
  ) throw failure('作品详情不完整，请重新连接账户')
  const images = work.images.filter((image): image is { url: string } =>
    !!image && typeof image === 'object' && typeof image.url === 'string' && /^https?:\/\//i.test(image.url),
  ).map(image => ({ url: image.url }))
  const sanitized = { ...work, images } as Work
  if (work.status === 'completed' && !images.length && !work.taskId) sanitized.error = MISSING_IMAGE
  return sanitized
}

function jsonWithinLimit(value: unknown, label: string): string {
  let json: string
  try { json = JSON.stringify(value) } catch { throw failure(`${label}无法序列化`) }
  if (new TextEncoder().encode(json).byteLength > MAX_BYTES)
    throw failure(`${label}超过 180 KB，请缩短商品要求或文案后重试`)
  return json
}

function parseIndex(value: unknown): StoredEntry[] {
  if (value === null) return []
  if (!Array.isArray(value)) throw failure('历史索引格式无效，请重新连接账户')
  const seen = new Set<string>()
  return value.slice(0, MAX_WORKS).map(item => {
    const entry = record(item)
    const key = detailKey(entry.id)
    const id = entry.id as string
    if (seen.has(id)) throw failure('历史索引包含重复作品，请重新连接账户')
    seen.add(id)
    if (entry.detailKey !== undefined) {
      if (entry.detailKey !== key) throw failure('作品详情地址无效，请重新连接账户')
      return { id, detailKey: key, reviewKey: typeof entry.reviewKey === 'string' ? entry.reviewKey : undefined }
    }
    const legacy = normalizedWork(entry)
    return { id, reviewKey: legacy.reviewKey, legacy }
  })
}

/**
 * A small history index points to independent work documents. Large plans,
 * quality reports and image URLs cannot evict later jobs from an active batch.
 * Callers serialize save() operations; each account gets a separate instance.
 */
export function createWorkStorage(storage: Storage): {
  load(): Promise<Work[]>
  save(works: Work[]): Promise<void>
} {
  const savedJSON = new Map<string, string>()
  const pendingCleanup = new Set<string>()
  let previous: StoredEntry[] | undefined

  async function cleanup(retained: Set<string>) {
    for (const key of retained) pendingCleanup.delete(key)
    const keys = [...pendingCleanup]
    const results = await Promise.allSettled(keys.map(key => storage.delete(key)))
    results.forEach((result, index) => {
      if (result.status === 'fulfilled') pendingCleanup.delete(keys[index])
    })
  }

  return {
    async load() {
      const entries = parseIndex(await storage.get<unknown>(HISTORY_KEY))
      const documents = await Promise.all(entries.map(async entry => {
        if (entry.legacy) return entry.legacy
        const value = await storage.get<unknown>(entry.detailKey!)
        if (value === null) throw failure(`作品 ${entry.id} 的详情缺失，请重新连接账户`)
        return normalizedWork(value, entry.id)
      }))
      // Only replace instance state after every referenced document was read.
      savedJSON.clear()
      documents.forEach((work, index) => {
        if (entries[index].detailKey) savedJSON.set(work.id, JSON.stringify(work))
      })
      previous = entries
      return restoreHistory(documents)
    },

    async save(works) {
      const retainedWorks = works.slice(0, MAX_WORKS).map(work => normalizedWork(work))
      const seen = new Set<string>()
      // Validate the entire retained batch before mutating any storage key.
      const staged = retainedWorks.map(work => {
        if (seen.has(work.id)) throw failure('作品编号重复')
        seen.add(work.id)
        return { work, key: detailKey(work.id), json: jsonWithinLimit(work, `作品「${work.title}」`) }
      })
      const index: IndexEntry[] = staged.map(({ work, key }) => ({
        id: work.id, batch: work.batch, status: work.status,
        ...(work.taskId ? { taskId: work.taskId } : {}),
        ...(work.position !== undefined ? { position: work.position } : {}),
        ...(work.batchSize !== undefined ? { batchSize: work.batchSize } : {}),
        ...(work.reviewKey ? { reviewKey: work.reviewKey } : {}),
        detailKey: key,
      }))
      jsonWithinLimit(index, '历史索引')
      if (!previous) previous = parseIndex(await storage.get<unknown>(HISTORY_KEY))
      for (const { work, key, json } of staged) {
        if (savedJSON.get(work.id) === json) continue
        await storage.set(key, JSON.parse(json))
        savedJSON.set(work.id, json)
      }
      // An index is committed only once every document it names exists.
      await storage.set(HISTORY_KEY, index)

      const retainedKeys = new Set(index.flatMap(entry => [entry.detailKey, ...(entry.reviewKey ? [entry.reviewKey] : [])]))
      for (const entry of previous) {
        if (!seen.has(entry.id)) savedJSON.delete(entry.id)
        if (entry.detailKey && !retainedKeys.has(entry.detailKey)) pendingCleanup.add(entry.detailKey)
        if (entry.reviewKey && SAFE_REVIEW_KEY.test(entry.reviewKey) && !retainedKeys.has(entry.reviewKey)) pendingCleanup.add(entry.reviewKey)
      }
      previous = index
      // Cleanup failure must not downgrade an already committed generation.
      // Retry unsuccessful removals on the next save from this account.
      await cleanup(retainedKeys)
    },
  }
}
