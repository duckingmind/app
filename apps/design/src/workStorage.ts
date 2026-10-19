import { restoreHistory, type Work } from './core.ts'

type Entry<T> = { value: T | null; revision: number }
type Operation = { op: 'put'; key: string; value: unknown; expectedRevision?: number } | { op: 'delete'; key: string; expectedRevision?: number }
type Storage = {
  get<T>(key: string): Promise<T | null>
  getEntry<T>(key: string): Promise<Entry<T> | null>
  getMany?<T>(keys: string[]): Promise<Record<string, T | null>>
  batch(operations: Operation[], options?: { idempotencyKey?: string }): Promise<unknown>
}
type IndexEntry = { id: string; detailKey?: string; reviewKey?: string; legacy?: Work }
const HISTORY_KEY = 'design:works:v1'
const MAX_WORKS = 40
const MAX_BYTES = 180000
const MAX_BATCH_BYTES = 1 << 20
const SAFE_ID = /^[A-Za-z0-9_-]{1,160}$/
const SAFE_REVIEW_KEY = /^design:(?:review:[A-Za-z0-9_-]{1,160}|review-context:v1:[a-f0-9]{64})$/
const failure = (message: string) => new Error(`作品存储未完成：${message}`)

function validId(id: unknown): id is string { return typeof id === 'string' && SAFE_ID.test(id) }
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw failure('作品记录格式无效')
  return value as Record<string, unknown>
}
function normalizedWork(value: unknown, expectedId?: string): Work {
  const work = record(value)
  if (!validId(work.id)) throw failure('作品编号无效')
  if (expectedId && work.id !== expectedId) throw failure('作品详情与索引编号不一致，请重试加载作品记录')
  if (!['batch', 'title', 'scene', 'pose', 'ratio', 'model', 'createdAt'].every(key => typeof work[key] === 'string') ||
      !['tryon', 'model', 'product', 'detail', 'clone'].includes(String(work.kind)) ||
      !['queued', 'running', 'completed', 'failed', 'paused', 'skipped'].includes(String(work.status)) || !Array.isArray(work.images))
    throw failure('作品详情不完整，请重试加载作品记录')
  return { ...work, images: work.images.filter(image => image && typeof image === 'object' && typeof image.url === 'string') } as Work
}
/** KV stores stable media handles only; URLs and reference image bytes are transient. */
export function workForStorage(value: Work): Work {
  const work = normalizedWork(value)
  const assetIds = [...new Set([...(work.assetIds || []), ...work.images.map(image => image.assetId)].filter(validId))]
  const { reviewKey: _legacyReviewKey, ...metadata } = work
  return { ...metadata, images: [], ...(assetIds.length ? { assetIds } : {}),
    ...(work.status === 'completed' && !work.taskId && !assetIds.length
      ? { error: '图片缺少可恢复的素材编号，刷新后无法恢复；请在原生成页面及时下载。' } : {}) }
}
function boundedJSON(value: unknown, label: string): string {
  const json = JSON.stringify(value)
  if (new TextEncoder().encode(json).byteLength > MAX_BYTES) throw failure(`${label}超过 180 KB，请缩短作品内容后重试`)
  return json
}
function bytes(operations: Operation[]) { return new TextEncoder().encode(JSON.stringify({ operations })).byteLength }
function chunks(operations: Operation[]): Operation[][] {
  const result: Operation[][] = []
  let chunk: Operation[] = []
  for (const operation of operations) {
    if (chunk.length === 100 || bytes([...chunk, operation]) > MAX_BATCH_BYTES) { result.push(chunk); chunk = [] }
    chunk.push(operation)
    if (bytes(chunk) > MAX_BATCH_BYTES) throw failure('批量存储请求超过 1 MB')
  }
  if (chunk.length) result.push(chunk)
  return result
}
function parseIndex(value: unknown): IndexEntry[] {
  if (value === null) return []
  if (!Array.isArray(value)) throw failure('历史索引格式无效，请重试加载作品记录')
  const seen = new Set<string>()
  return value.slice(0, MAX_WORKS).map(item => {
    const entry = record(item)
    if (!validId(entry.id)) throw failure('作品编号无效')
    if (seen.has(entry.id)) throw failure('历史索引包含重复作品')
    seen.add(entry.id)
    if (entry.detailKey !== undefined) {
      const prefix = `design:work:${entry.id}`
      if (typeof entry.detailKey !== 'string' || !(entry.detailKey === prefix || /^design:work:v2:[a-f0-9-]{36}$/.test(entry.detailKey)))
        throw failure('作品详情地址无效')
      return { id: entry.id, detailKey: entry.detailKey, reviewKey: typeof entry.reviewKey === 'string' ? entry.reviewKey : undefined }
    }
    const legacy = normalizedWork(entry)
    return { id: entry.id, reviewKey: legacy.reviewKey, legacy }
  })
}
function isConflict(error: unknown) {
  return !!error && typeof error === 'object' && (error as { code?: string }).code === 'APP_STORAGE_CONFLICT'
}

/** Immutable details + a conditional index commit keep concurrent tabs isolated.
 * Lost replies retain the exact original batches and idempotency keys. */
export function createWorkStorage(storage: Storage) {
  let revision: number | undefined
  let previous: IndexEntry[] = []
  type Saved = { json: string; key?: string; original?: Work }
  let saved = new Map<string, Saved>()
  let conflict = false
  let pending: { json: string; batches: { operations: Operation[]; idempotencyKey: string }[]; cursor: number;
    entries: IndexEntry[]; saved: Map<string, Saved>; keys: string[] } | undefined

  async function load(): Promise<Work[]> {
    // A concurrent commit can remove details while this reader is loading them.
    for (let attempt = 0; attempt < 3; attempt++) {
      const head = await storage.getEntry<unknown>(HISTORY_KEY)
      const entries = parseIndex(head?.value ?? null)
      const keys = entries.flatMap(entry => entry.detailKey ? [entry.detailKey] : [])
      const values = storage.getMany && keys.length > 1 ? await storage.getMany<unknown>(keys)
        : Object.fromEntries(await Promise.all(keys.map(async key => [key, await storage.get(key)])))
      const current = await storage.getEntry<unknown>(HISTORY_KEY)
      if ((current?.revision ?? 0) !== (head?.revision ?? 0)) continue
      const documents = entries.map(entry => {
        if (entry.legacy) return entry.legacy
        const value = values[entry.detailKey!]
        if (value == null) throw failure(`作品 ${entry.id} 的详情缺失，请重试加载作品记录`)
        return normalizedWork(value, entry.id)
      })
      revision = head?.revision ?? 0
      previous = entries
      saved = new Map(documents.map((work, i) => [work.id, { json: JSON.stringify(work), key: entries[i].detailKey, original: work }]))
      pending = undefined
      conflict = false
      // Read old addresses for immediate download; a legacy record without handles
      // remains protected from automatic rewrites until explicitly removed.
      return restoreHistory(documents.map(work => ({ ...work,
        ...(!work.taskId && !work.assetIds?.length && work.images.some(image => /^https?:\/\//i.test(image.url))
          ? { error: '旧作品尚无可恢复的素材编号；当前链接到期后可能无法读取，请及时下载。' } : {}) })))
    }
    throw failure('作品正在其他窗口更新，请重试加载')
  }

  async function finishPending() {
    if (!pending) return
    while (pending.cursor < pending.batches.length) {
      const batch = pending.batches[pending.cursor]
      let result: unknown
      try { result = await storage.batch(batch.operations, { idempotencyKey: batch.idempotencyKey }) }
      catch (error) {
        if (isConflict(error)) {
          conflict = true
          // Only staged, unique keys can be removed. Never mutate the winning index.
          if (pending.cursor > 0) {
            for (const part of chunks(pending.keys.map(key => ({ op: 'delete', key })))) {
              try { await storage.batch(part, { idempotencyKey: crypto.randomUUID() }) } catch { /* Orphans are safe; preserve the original conflict. */ }
            }
          }
          throw Object.assign(failure('作品已在其他窗口更新，请重新加载后合并修改；当前内容尚未覆盖云端。'), { code: 'APP_STORAGE_CONFLICT' })
        }
        throw error
      }
      const results = Array.isArray(result) ? result : (result as { results?: unknown[] })?.results
      if (!Array.isArray(results) || results.length !== batch.operations.length || results.some(item => !item || item.success !== true))
        throw failure('批量存储响应不完整，请重试')
      const head = batch.operations.findIndex(operation => operation.key === HISTORY_KEY)
      if (head >= 0) {
        const nextRevision = results[head].revision
        if (!Number.isSafeInteger(nextRevision) || nextRevision <= 0) throw failure('存储服务未返回作品版本号')
        revision = nextRevision
      }
      pending.cursor++
    }
    previous = pending.entries
    saved = pending.saved
    pending = undefined
  }

  async function save(works: Work[]) {
    if (conflict) throw Object.assign(failure('作品已在其他窗口更新，请重新加载后合并修改'), { code: 'APP_STORAGE_CONFLICT' })
    const seen = new Set<string>()
    const staged = works.slice(0, MAX_WORKS).map(value => {
      const work = workForStorage(value)
      if (seen.has(work.id)) throw failure('作品编号重复')
      seen.add(work.id)
      return { work, json: boundedJSON(work, `作品「${work.title}」`) }
    })
    const snapshotJSON = JSON.stringify(staged.map(item => item.json))
    // Resolve an uncertain previous commit with the original operation identity first.
    if (pending) await finishPending()
    if (revision === undefined) await load()
    const nextSaved = new Map<string, Saved>()
    const entries: IndexEntry[] = []
    const puts: Operation[] = []
    for (const { work, json } of staged) {
      const old = saved.get(work.id)
      const original = old?.original
      if (original && !work.taskId && !work.assetIds?.length && !original.taskId && !original.assetIds?.length &&
          original.images.some(image => /^https?:\/\//i.test(image.url))) {
        nextSaved.set(work.id, old!)
        entries.push(previous.find(entry => entry.id === work.id)!)
        continue
      }
      const key = old?.key && old.json === json ? old.key : `design:work:v2:${crypto.randomUUID()}`
      nextSaved.set(work.id, { json, key })
      entries.push({ id: work.id, detailKey: key })
      if (key !== old?.key) puts.push({ op: 'put', key, value: JSON.parse(json), expectedRevision: 0 })
    }
    const indexValue = entries.map(entry => entry.legacy ?? entry)
    boundedJSON(indexValue, '历史索引')
    const retained = new Set(entries.map(entry => entry.detailKey))
    const retainedReviews = new Set(entries.map(entry => entry.reviewKey))
    const removals = [...new Set(previous.flatMap(entry => [
      ...(entry.detailKey && !retained.has(entry.detailKey) ? [entry.detailKey] : []),
      ...(entry.reviewKey && SAFE_REVIEW_KEY.test(entry.reviewKey) && !retainedReviews.has(entry.reviewKey) ? [entry.reviewKey] : []),
    ]))].map(key => ({ op: 'delete' as const, key }))
    if (!puts.length && !removals.length && JSON.stringify(entries) === JSON.stringify(previous)) return
    const commit: Operation[] = [{ op: 'put', key: HISTORY_KEY, value: indexValue, expectedRevision: revision }, ...removals]
    const all = [...puts, ...commit]
    const operations = all.length <= 100 && bytes(all) <= MAX_BATCH_BYTES ? [all] : [...chunks(puts), commit]
    pending = { json: snapshotJSON, batches: operations.map(operations => ({ operations, idempotencyKey: crypto.randomUUID() })),
      cursor: 0, entries, saved: nextSaved, keys: puts.map(operation => operation.key) }
    await finishPending()
  }
  return { load, save }
}
