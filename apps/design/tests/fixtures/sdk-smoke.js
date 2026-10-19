// This SDK is substituted only by ui-smoke.mjs's isolated Vite server.
// Keep every provider/auth/storage operation local to the disposable browser.
const storageKey = 'design-ui-smoke-storage'
const imageURL = (name) => new URL(`/src/assets/${name}.webp`, location.origin).href
const initialHistory = [{
  id: 'restored-tryon', batch: 'restored-batch', kind: 'tryon',
  title: '已恢复的试穿作品', scene: '影棚', pose: '正面', ratio: '3:4',
  model: 'smoke-edit', createdAt: '2026-01-01T00:00:00.000Z',
  status: 'completed', taskId: 'task_smoke_restored', images: [{ url: imageURL('model-01'), assetId: 'asset_restored' }],
}]
const stored = JSON.parse(localStorage.getItem(storageKey) || 'null') || {
  'design:works:v1': initialHistory,
  'design:settings:v1': { modelId: 'smoke-edit', textModel: 'smoke-vision' },
}
const revisions = JSON.parse(localStorage.getItem(storageKey + '-revisions') || 'null') || Object.fromEntries(Object.keys(stored).map(key => [key, 1]))
let revision = Math.max(0, ...Object.values(revisions))
const receipts = new Map()
const save = () => { localStorage.setItem(storageKey, JSON.stringify(stored)); localStorage.setItem(storageKey + '-revisions', JSON.stringify(revisions)) }
const copy = (value) => value === undefined ? null : structuredClone(value)
// Deterministic, abort-aware pause points let the browser inspect feedback
// while work is pending. These controls exist only in this isolated SDK.
const smoke = window.__designSmoke
smoke.controls = { holds: [], failures: [], ...JSON.parse(sessionStorage.getItem('design-smoke-controls') || '{}') }
smoke.pending = []
smoke.aborted = []

// The isolated browser fixture does not expose a host agent bridge, but the
// application still imports the SDK's agent facade. Keep registration a safe
// no-op so UI tests exercise the real page without a desktop host.
export const agent = {
  register: () => () => {},
  setStatus: () => {},
  ready: async () => {},
}
const releases = new Map()
smoke.release = (name) => {
  smoke.controls.holds = smoke.controls.holds.filter(value => value !== name)
  for (const release of releases.get(name) || []) release()
}
async function checkpoint(name, signal) {
  if (signal?.aborted) throw new DOMException('Local smoke operation stopped', 'AbortError')
  if (smoke.controls.holds.includes(name)) await new Promise((resolve, reject) => {
    smoke.pending.push(name)
    const finish = error => {
      signal?.removeEventListener('abort', abort)
      releases.get(name)?.delete(release)
      const index = smoke.pending.indexOf(name)
      if (index !== -1) smoke.pending.splice(index, 1)
      if (error) reject(error)
      else resolve()
    }
    const release = () => finish()
    const abort = () => {
      smoke.aborted.push(name)
      finish(new DOMException('Local smoke operation stopped', 'AbortError'))
    }
    const waiting = releases.get(name) || new Set()
    waiting.add(release)
    releases.set(name, waiting)
    signal?.addEventListener('abort', abort, { once: true })
  })
  if (smoke.controls.failures.includes(name)) throw Object.assign(new Error(`Local ${name} unavailable`), { code: 'SMOKE_RESOURCE_UNAVAILABLE' })
}

export function createAppClient() {
  return {
    auth: {
      loginMode: 'app',
      status: async () => ({ authenticated: true, accountScope: 'acs_' + 'a'.repeat(64) }),
      login: async () => { throw new Error('Unexpected login in isolated smoke test') },
    },
    platform: { createSession: async () => ({}) },
    storage: {
      get: async (key) => { await checkpoint(key === 'design:settings:v1' ? 'preferences' : 'history'); return copy(stored[key]) },
      getEntry: async (key) => { await checkpoint('history'); return Object.hasOwn(stored, key) ? { value: copy(stored[key]), revision: revisions[key] } : null },
      getMany: async (keys) => Object.fromEntries(keys.map(key => [key, copy(stored[key])])),
      set: async (key, value) => { stored[key] = copy(value); revisions[key] = ++revision; save() },
      delete: async (key) => { delete stored[key]; save() },
      batch: async (operations, options = {}) => {
        if (receipts.has(options.idempotencyKey)) return copy(receipts.get(options.idempotencyKey))
        for (const operation of operations) if (operation.expectedRevision !== undefined && operation.expectedRevision !== (revisions[operation.key] || 0))
          throw Object.assign(new Error('revision conflict'), { code: 'APP_STORAGE_CONFLICT' })
        const result = operations.map(operation => {
          if (operation.op === 'put') { stored[operation.key] = copy(operation.value); revisions[operation.key] = ++revision }
          else { delete stored[operation.key]; delete revisions[operation.key] }
          return { success: true, revision: revisions[operation.key] }
        })
        save()
        receipts.set(options.idempotencyKey, copy(result))
        return result
      },
    },
    api: {
      request: async (path, init) => {
        window.__designSmoke.requests.push(path)
        if (path === '/images/models' || path === '/models') await checkpoint('models', init?.signal)
        if (path === '/responses') await checkpoint('responses', init?.signal)
        if (path === '/images/models') return { data: [
          { id: 'smoke-edit', name: 'Smoke 编辑模型', available: true,
            supported_operations: ['edit', 'generation'], max_input_images: 6,
            supported_sizes: ['768x1024', '1024x1024', '1024x768'] },
          { id: 'missing-inputs', name: '缺少参考图能力', available: true,
            supported_operations: ['edit'], supported_sizes: ['1024x1024'] },
          { id: 'generation-only', name: '仅文字生图', available: true,
            supported_operations: ['generation'], supported_sizes: ['1024x1024'] },
          { id: 'unsupported-ratio', name: '不支持当前比例', available: true,
            supported_operations: ['edit'], max_input_images: 6,
            supported_sizes: ['1280x1024'] },
          { id: 'single-input', name: '仅单张参考图', available: true,
            supported_operations: ['edit'], max_input_images: 1,
            supported_sizes: ['768x1024', '1024x1024'] },
        ] }
        if (path === '/models') return { data: [{
          id: 'smoke-vision', name: 'Smoke 图片理解',
          supports_vision: true, supports_responses: true,
        }] }
        if (path === '/images/edits' || path === '/images/generations') {
          return { task_id: 'task_' + crypto.randomUUID(), status: 'completed', data: [{ url: imageURL('model-02'), asset_id: 'asset_smoke_generated' }] }
        }
        if (path.startsWith('/images/tasks/')) return { status: 'completed', data: [{ url: imageURL(path.includes('task_smoke_restored') ? 'model-01' : 'model-02'), asset_id: 'asset_smoke_generated' }] }
        if (path === '/responses') {
          const body = JSON.parse(init.body)
          const content = body.input.flatMap(message => message.content)
          if (content.some(part => part.text?.includes('从左到右排列的数字码'))) {
            const image = content.find(part => part.type === 'input_image')?.image_url
            const answer = window.__designSmoke.challenges[image]
            if (!answer) throw new Error('Visual challenge was not rendered on the instrumented canvas')
            return { status: 'completed', output_text: answer }
          }
          if (content.some(part => part.text?.includes('电商图片质量核对员'))) {
            return { status: 'completed', output_text: JSON.stringify({
              status: 'passed', summary: '本地烟测检查完成。', issues: [],
            }) }
          }
        }
        throw new Error(`Unexpected SDK request in isolated smoke test: ${path}`)
      },
    },
  }
}
