import { buildTryOnPrompt, POSES, SCENES, sizeForRatio, type ImageModel, type Work } from './core.ts'
import { cloneRequest, detailRequest, DETAIL_BLOCKS, CLONE_TYPES } from './contentCore.ts'
import { DEFAULT_PRODUCT_COUNTS, prepareProductRequest, type ProductCounts } from './productCore.ts'
import type { CommerceRequest } from './commerce.ts'
import type { Photo } from './images.ts'
import type { TextModelChoice } from './textModels.ts'

export const DESIGN_MODES = ['product', 'detail', 'tryon', 'clone'] as const
export type DesignMode = typeof DESIGN_MODES[number]
export type DesignAgentConfig = {
  mode: DesignMode; imageModel: string; textModel: string; ratio: string
  productIds: string[]; referenceIds: string[]; personId: string
  platform: string; language: string; market: string; requirements: string; visualStyle: string
  smart: boolean; counts: ProductCounts; listing: boolean; blocks: string[]
  cloneType: string; cloneDegree: 'style' | 'close'; sceneIds: string[]; customScene: string; poseIds: string[]
}
export type DesignAgentSnapshot = {
  ready: boolean; reason?: string; models: ImageModel[]; textModels: TextModelChoice[]
  selectedImageModel: string; selectedTextModel: string; works: Work[]
}
export type DesignAgentHost = {
  snapshot(): DesignAgentSnapshot
  importPhoto(bytes: Uint8Array, mime: string, name: string): Promise<Photo>
  releasePhoto(photo: Photo): void
  changed(config: DesignAgentConfig, assets: Array<{ id: string; name: string }>): void
  prepare(batch: string, config: DesignAgentConfig): Promise<void>
  run(batch: string, config: DesignAgentConfig, photos: Map<string, Photo>, controller: AbortController): Promise<void>
  refresh(work: Work): Promise<Work>
  result(work: Work, imageIndex: number): Promise<Blob>
}
type Context = { signal: AbortSignal }
type Input = Record<string, any>
const MAX_ASSET_BYTES = 10 * 1024 * 1024
const MAX_ASSETS = 26
const CHUNK_BYTES = 192 * 1024
const clean = (text: unknown, length = 500) => String(text || '').replace(/(?:https?:\/\/|data:|blob:)[^\s<>"']+/gi, '[媒体地址已隐藏]').slice(0, length)
function failure(code: string, message: string): never {
  throw Object.assign(new Error(message), { code, executionStarted: false, retryable: false,
    nextAction: { type: 'inspect_state', capability: 'proxy_design_read_configuration' } })
}
function assert(condition: unknown, message: string): asserts condition { if (!condition) failure('DESIGN_INVALID_INPUT', message) }
function safeInt(value: unknown, min: number, max: number, fallback?: number) {
  const number = value === undefined ? fallback : value
  assert(Number.isInteger(number) && Number(number) >= min && Number(number) <= max, `整数必须在 ${min}–${max} 之间`)
  return Number(number)
}
export function designWorkSummary(work: Work) {
  return { id: work.id, batchId: work.batch, title: clean(work.title, 160), mode: work.kind, status: work.status,
    model: clean(work.model, 160), ratio: work.ratio, createdAt: work.createdAt, imageCount: work.images.length,
    recoverable: Boolean(work.taskId || work.assetIds?.length || work.images.some(image => image.assetId)),
    error: clean(work.error), text: clean(work.text, 12000),
    results: work.images.map((_image, imageIndex) => ({ workId: work.id, imageIndex })) }
}
export function defaultDesignConfig(): DesignAgentConfig {
  return { mode: 'product', imageModel: '', textModel: '', ratio: '1:1', productIds: [], referenceIds: [], personId: '',
    platform: '亚马逊', language: '英文', market: '全球', requirements: '', visualStyle: '简约高级，清晰留白与专业产品摄影',
    smart: true, counts: { ...DEFAULT_PRODUCT_COUNTS }, listing: false, blocks: ['hero', 'benefits', 'usage'],
    cloneType: CLONE_TYPES[0], cloneDegree: 'close', sceneIds: ['studio'], customScene: '', poseIds: ['front'] }
}
export function commerceForDesign(config: DesignAgentConfig, photos: Map<string, Photo>): CommerceRequest {
  const products = config.productIds.map(id => photos.get(id)!)
  if (config.mode === 'product') {
    const request = prepareProductRequest({ photos: products, platform: config.platform, language: config.language,
      ratio: config.ratio, requirements: config.requirements, smart: config.smart, counts: config.counts, listing: config.listing })
    return { ...request, products, jobs: request.outputs }
  }
  if (config.mode === 'detail') return detailRequest({ products, blocks: config.blocks, platform: config.platform,
    market: config.market, language: config.language, ratio: config.ratio, description: config.requirements, visualStyle: config.visualStyle })
  if (config.mode === 'clone') return cloneRequest({ products, references: config.referenceIds.map(id => photos.get(id)!),
    type: config.cloneType, degree: config.cloneDegree, language: config.language, ratio: config.ratio,
    description: config.requirements, perReference: {} })
  throw new Error('试穿使用现有试穿生成流程')
}
export function createDesignAgent(host: DesignAgentHost) {
  let revision = crypto.randomUUID()
  let config = defaultDesignConfig()
  let disposed = false
  let mutation = Promise.resolve<unknown>(undefined)
  const photos = new Map<string, Photo>()
  const uploads = new Map<string, { name: string; mime: string; bytes: number; chunks: Uint8Array[]; received: number }>()
  const operations = new Map<string, { fingerprint: string; promise: Promise<unknown> }>()
  const batches = new Map<string, { controller: AbortController; state: string; error?: string }>()
  const exports = new Map<string, { workId: string; imageIndex: number; blob: Blob }>()
  const ready = () => {
    if (disposed) failure('DESIGN_UNAVAILABLE', '应用已关闭')
    const snapshot = host.snapshot()
    if (!snapshot.ready) failure('DESIGN_NOT_READY', snapshot.reason || '请先登录并等待模型与作品加载完成')
    return snapshot
  }
  const touch = () => { revision = crypto.randomUUID(); host.changed(structuredClone(config), [...photos.values()].map(({ id, name }) => ({ id, name }))) }
  const state = () => {
    const snapshot = ready()
    return { revision, configuration: structuredClone(config), selectedModels: { imageModel: snapshot.selectedImageModel, textModel: snapshot.selectedTextModel },
      assets: [...photos.values()].map(({ id, name }) => ({ id, name })),
      uploads: [...uploads].map(([uploadId, upload]) => ({ uploadId, name: upload.name, receivedBytes: upload.received, totalBytes: upload.bytes })),
      options: { modes: DESIGN_MODES, detailBlocks: DETAIL_BLOCKS.map(({ id, name }) => ({ id, name })),
        scenes: SCENES.map(({ id, name }) => ({ id, name })), poses: POSES.map(({ id, name }) => ({ id, name })), cloneTypes: [...CLONE_TYPES] } }
  }
  function write(name: string, input: Input, context: Context, operation: () => Promise<unknown> | unknown) {
    ready(); context.signal.throwIfAborted()
    assert(typeof input.idempotency_key === 'string' && input.idempotency_key.length >= 8 && input.idempotency_key.length <= 128, '需要 8–128 字符的幂等键')
    const key = `${name}:${input.idempotency_key}`
    const fingerprint = JSON.stringify(input)
    const old = operations.get(key)
    if (old) {
      if (old.fingerprint !== fingerprint) failure('DESIGN_IDEMPOTENCY_CONFLICT', '同一幂等键不能用于不同参数')
      return old.promise
    }
    const promise = mutation.catch(() => undefined).then(async () => {
      ready(); context.signal.throwIfAborted()
      if (input.expected_revision !== revision) failure('DESIGN_REVISION_CONFLICT', '配置或素材已变化，请重新读取配置')
      return operation()
    })
    mutation = promise
    operations.set(key, { fingerprint, promise })
    if (operations.size > 256) operations.delete(operations.keys().next().value!)
    return promise
  }
  function validateConfiguration(next: DesignAgentConfig) {
    const snapshot = ready()
    assert(DESIGN_MODES.includes(next.mode), '请选择 product、detail、tryon 或 clone')
    assert(snapshot.models.some(model => model.id === next.imageModel), '图片模型不在当前目录中')
    assert(snapshot.textModels.some(model => model.id === next.textModel), '文案模型不在当前目录中')
    assert(typeof next.ratio === 'string' && Boolean(sizeForRatio(snapshot.models.find(model => model.id === next.imageModel)!, next.ratio)), '图片模型不支持所选比例')
    for (const [ids, max] of [[next.productIds, 6], [next.referenceIds, 20]] as const) {
      assert(Array.isArray(ids) && ids.length <= max && new Set(ids).size === ids.length && ids.every(id => photos.has(id)), '素材 ID 不存在、重复或数量超限')
    }
    assert(!next.personId || photos.has(next.personId), '模特素材不存在')
    for (const [ids, choices] of [[next.blocks, DETAIL_BLOCKS], [next.sceneIds, SCENES], [next.poseIds, POSES]] as const)
      assert(Array.isArray(ids) && ids.length <= 20 && new Set(ids).size === ids.length && ids.every(id => choices.some(choice => choice.id === id)), '模块、场景或姿势 ID 无效')
    for (const key of ['platform', 'language', 'market', 'requirements', 'visualStyle', 'customScene'] as const)
      assert(typeof next[key] === 'string' && next[key].length <= (['requirements', 'customScene'].includes(key) ? 4000 : 500), '配置文字过长或格式无效')
    assert(typeof next.smart === 'boolean' && typeof next.listing === 'boolean', '策划与文案选项必须为布尔值')
    assert(CLONE_TYPES.some(type => type === next.cloneType) && ['style', 'close'].includes(next.cloneDegree), '复刻类型或程度无效')
    assert(next.counts && typeof next.counts === 'object' && Object.keys(next.counts).length === Object.keys(DEFAULT_PRODUCT_COUNTS).length, '商品数量配置无效')
    for (const key of Object.keys(DEFAULT_PRODUCT_COUNTS) as Array<keyof ProductCounts>) safeInt(next.counts[key], 0, 5)
    return next
  }
  function validateSubmission() {
    validateConfiguration(config)
    const selected = ready().models.find(model => model.id === config.imageModel)!
    assert(selected.available !== false && selected.supported_operations?.includes('edit'), '请选择可用的图片编辑模型')
    if (config.mode === 'tryon') {
      assert(config.productIds.length && config.personId && config.poseIds.length && (config.sceneIds.length || config.customScene.trim()), '试穿需要服装、模特、场景和姿势')
      assert((selected.max_input_images || 0) >= 2, '试穿模型至少需要支持两张输入图片')
      assert(config.poseIds.length * (config.customScene.trim() ? 1 : config.sceneIds.length) <= 24, '试穿单批最多 24 张')
    } else commerceForDesign(config, photos)
  }
  const handlers = {
    read_configuration: async () => state(),
    list_models: async () => {
      const snapshot = ready()
      return { imageModels: snapshot.models.map(model => ({ id: model.id, name: clean(model.name, 160), available: model.available !== false,
        operations: model.supported_operations || [], maxInputImages: model.max_input_images || 0,
        ratios: model.supported_aspect_ratios || [], sizes: model.supported_sizes || [] })),
      textModels: snapshot.textModels.map(model => ({ id: model.id, name: clean(model.name, 160), vision: model.vision })) }
    },
    configure: (input: Input, context: Context) => write('configure', input, context, () => {
      assert(input.configuration && typeof input.configuration === 'object', '需要配置对象')
      const allowed = Object.keys(config)
      assert(Object.keys(input.configuration).every(key => allowed.includes(key)), '配置包含未知字段')
      config = validateConfiguration({ ...config, ...structuredClone(input.configuration) })
      touch(); return state()
    }),
    begin_asset: (input: Input, context: Context) => write('begin_asset', input, context, () => {
      assert(photos.size + uploads.size < MAX_ASSETS, '当前页面最多保留 26 个助手素材，请移除不需要的素材')
      assert(typeof input.name === 'string' && input.name.length >= 1 && input.name.length <= 160, '素材名称无效')
      assert(['image/png', 'image/jpeg', 'image/webp'].includes(input.mime), '仅支持 PNG、JPEG、WebP')
      const uploadId = crypto.randomUUID()
      uploads.set(uploadId, { name: input.name, mime: input.mime, bytes: safeInt(input.total_bytes, 1, MAX_ASSET_BYTES), received: 0, chunks: [] })
      touch(); return { revision, uploadId, maxChunkBytes: CHUNK_BYTES }
    }),
    append_asset: (input: Input, context: Context) => write('append_asset', input, context, () => {
      const upload = uploads.get(input.upload_id); assert(upload, '上传不存在，请重新开始')
      assert(input.offset === upload.received, '分块偏移不匹配，请读取当前上传进度')
      assert(typeof input.base64 === 'string' && input.base64.length <= CHUNK_BYTES / 3 * 4 && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(input.base64), '分块必须为标准 base64 且不超过 192 KiB')
      const bytes = Uint8Array.from(atob(input.base64), char => char.charCodeAt(0))
      assert(bytes.length && upload.received + bytes.length <= upload.bytes, '分块超过声明大小')
      upload.chunks.push(bytes); upload.received += bytes.length; touch()
      return { revision, uploadId: input.upload_id, receivedBytes: upload.received, complete: upload.received === upload.bytes }
    }),
    finish_asset: (input: Input, context: Context) => write('finish_asset', input, context, async () => {
      const upload = uploads.get(input.upload_id); assert(upload && upload.received === upload.bytes, '请先上传完整素材')
      const bytes = new Uint8Array(upload.bytes)
      let offset = 0; for (const chunk of upload.chunks) { bytes.set(chunk, offset); offset += chunk.length }
      const photo = await host.importPhoto(bytes, upload.mime, upload.name)
      try { ready(); context.signal.throwIfAborted() } catch (error) { host.releasePhoto(photo); throw error }
      photos.set(photo.id, photo); uploads.delete(input.upload_id); touch()
      return { revision, asset: { id: photo.id, name: photo.name } }
    }),
    remove_asset: (input: Input, context: Context) => write('remove_asset', input, context, () => {
      assert(![...batches.values()].some(batch => batch.state === 'running'), '生成期间不能移除素材')
      const photo = photos.get(input.asset_id)
      assert(photo || uploads.has(input.asset_id), '素材或上传不存在')
      if (photo) { photos.delete(input.asset_id); host.releasePhoto(photo) }
      uploads.delete(input.asset_id)
      config.productIds = config.productIds.filter(id => id !== input.asset_id)
      config.referenceIds = config.referenceIds.filter(id => id !== input.asset_id)
      if (config.personId === input.asset_id) config.personId = ''
      touch(); return { revision, removed: true }
    }),
    submit_generation: (input: Input, context: Context) => write('submit_generation', input, context, async () => {
      validateSubmission()
      const batchId = crypto.randomUUID(), controller = new AbortController()
      const chosen = structuredClone(config), assets = new Map(photos)
      // Persist an observable batch before any billable planning or image request.
      await host.prepare(batchId, chosen)
      ready(); context.signal.throwIfAborted()
      const batch = { controller, state: 'running', error: undefined as string | undefined }
      batches.set(batchId, batch)
      void host.run(batchId, chosen, assets, controller).catch(error => { batch.state = 'failed'; batch.error = clean(error instanceof Error ? error.message : error) })
        .finally(() => { if (batch.state === 'running') batch.state = controller.signal.aborted ? 'stopped' : 'settled' })
      touch()
      return { revision, batchId, status: 'accepted', message: '已加入应用生成队列；请查询批次获取实际任务与结果。' }
    }),
    list_works: async (input: Input) => {
      const snapshot = ready(), offset = safeInt(input.offset, 0, 10000, 0), limit = safeInt(input.limit, 1, 20, 10)
      const selected = snapshot.works.filter(work => (!input.batch_id || work.batch === input.batch_id) && (!input.mode || work.kind === input.mode))
      return { works: selected.slice(offset, offset + limit).map(designWorkSummary), total: selected.length,
        nextOffset: offset + limit < selected.length ? offset + limit : null,
        batches: [...batches].filter(([id]) => !input.batch_id || input.batch_id === id).slice(-20).map(([batchId, batch]) => ({ batchId, status: batch.state, error: batch.error || '' })) }
    },
    refresh_work: (input: Input, context: Context) => write('refresh_work', input, context, async () => {
      const work = ready().works.find(item => item.id === input.work_id); assert(work, '作品不存在')
      assert(![...batches].some(([id, batch]) => id === work.batch && batch.state === 'running'), '当前批次仍在处理，请直接查询作品')
      assert(work.taskId || work.assetIds?.length || work.images.some(image => image.assetId), '作品没有可恢复句柄；不能自动重新提交')
      const refreshed = await host.refresh(work); ready(); context.signal.throwIfAborted()
      return { revision, work: designWorkSummary(refreshed) }
    }),
    stop_batch: (input: Input, context: Context) => write('stop_batch', input, context, () => {
      const batch = batches.get(input.batch_id); assert(batch, '此批次未在当前页面运行；已有服务器任务请查询原任务')
      batch.controller.abort(); batch.state = 'stopped'; touch()
      return { revision, batchId: input.batch_id, status: 'stopped', message: '已停止后续提交与等待。已提交的服务器任务仍可能完成并计费；请用 refresh_work 查询，不能把停止视为服务器取消。' }
    }),
    read_result: async (input: Input, context: Context) => {
      const snapshot = ready(); context.signal.throwIfAborted()
      const work = snapshot.works.find(item => item.id === input.work_id); assert(work, '作品不存在')
      const imageIndex = safeInt(input.image_index, 0, 23, 0), offset = safeInt(input.offset, 0, 80 * 1024 * 1024, 0)
      const length = safeInt(input.length, 1, CHUNK_BYTES, CHUNK_BYTES)
      let entry = input.export_id ? exports.get(input.export_id) : undefined
      let exportId = input.export_id as string | undefined
      if (input.export_id) assert(entry && entry.workId === work.id && entry.imageIndex === imageIndex, '结果读取已过期或不属于此作品，请从偏移 0 重新读取')
      else {
        assert(offset === 0, '后续分块需要首块返回的 export_id')
        assert(work.status === 'completed' && work.images[imageIndex], '成图尚未完成或不存在')
        const blob = await host.result(work, imageIndex); ready(); context.signal.throwIfAborted()
        assert(blob.size <= 80 * 1024 * 1024 && ['image/png', 'image/jpeg', 'image/webp'].includes(blob.type), '结果超出支持格式或大小')
        entry = { workId: work.id, imageIndex, blob }; exportId = crypto.randomUUID()
        // At most two immutable result snapshots retain bytes in the renderer.
        if (exports.size >= 2) exports.delete(exports.keys().next().value!)
        exports.set(exportId, entry)
      }
      assert(entry && offset <= entry.blob.size, '结果偏移无效')
      const bytes = new Uint8Array(await entry.blob.slice(offset, offset + length).arrayBuffer())
      ready(); context.signal.throwIfAborted()
      let binary = ''; for (const byte of bytes) binary += String.fromCharCode(byte)
      return { exportId, workId: work.id, imageIndex, mime: entry.blob.type, totalBytes: entry.blob.size, offset,
        base64: btoa(binary), nextOffset: offset + bytes.length < entry.blob.size ? offset + bytes.length : null }
    },
  }
  return { handlers, dispose() { disposed = true; for (const batch of batches.values()) batch.controller.abort();
    for (const photo of photos.values()) host.releasePhoto(photo); photos.clear(); uploads.clear(); exports.clear(); operations.clear() } }
}
