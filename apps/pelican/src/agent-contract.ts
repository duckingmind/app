import type { ArtworkSettings } from './artwork'

export type StudioState = {
  revision: string
  title: string
  settings: ArtworkSettings
  savedCount: number
}

export type StudioUpdate = {
  title?: string
  settings?: Partial<ArtworkSettings>
}

export type PelicanStudioAdapter = {
  readStudio(): StudioState
  updateStudio(input: StudioUpdate): StudioState
  saveArtwork(): { id: string; title: string }
}

type WriteGuard = { expected_revision: string; idempotency_key: string }
export type UpdateStudioInput = StudioUpdate & WriteGuard
export type SaveArtworkInput = WriteGuard
export type SavedArtworkResult = { id: string; title: string; revision: string }
type WriteResult = StudioState | SavedArtworkResult
type CacheEntry = { fingerprint: string; result: WriteResult }

const MAX_CACHED_WRITES = 256
const settingNames = ['scene', 'palette', 'wing', 'lineWeight', 'decorations', 'variant'] as const

function failure(code: string, message: string, retryable = false) {
  return Object.assign(new Error(message), {
    code,
    executionStarted: false,
    retryable,
    ...(retryable ? { nextAction: { type: 'inspect_state', capability: 'read_studio' } } : {}),
  })
}

function objectInput(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw failure('INVALID_ARGUMENT', '调用参数必须是对象。')
  }
  return value as Record<string, unknown>
}

function onlyKeys(value: Record<string, unknown>, allowed: readonly string[]) {
  const unknown = Object.keys(value).find(key => !allowed.includes(key))
  if (unknown) throw failure('INVALID_ARGUMENT', `未声明的参数：${unknown}`)
}

function writeGuard(value: Record<string, unknown>): WriteGuard {
  if (typeof value.idempotency_key !== 'string' || value.idempotency_key.length < 8 || value.idempotency_key.length > 128) {
    throw failure('INVALID_ARGUMENT', 'idempotency_key 必须是 8–128 字符的字符串。')
  }
  if (typeof value.expected_revision !== 'string' || value.expected_revision.length < 1 || value.expected_revision.length > 128) {
    throw failure('INVALID_ARGUMENT', 'expected_revision 必须是最近读取的版本。')
  }
  return { idempotency_key: value.idempotency_key, expected_revision: value.expected_revision }
}

function settingsInput(value: unknown): Partial<ArtworkSettings> {
  const input = objectInput(value)
  onlyKeys(input, settingNames)
  const validChoice = (name: string, values: readonly string[]) => {
    if (name in input && (typeof input[name] !== 'string' || !values.includes(input[name] as string))) {
      throw failure('INVALID_ARGUMENT', `${name} 不在可选范围内。`)
    }
  }
  validChoice('scene', ['coast', 'meadow', 'sunset'])
  validChoice('palette', ['teal', 'coral', 'mustard', 'lavender'])
  validChoice('wing', ['light', 'dark'])
  if ('lineWeight' in input && (typeof input.lineWeight !== 'number' || !Number.isFinite(input.lineWeight) || input.lineWeight < 1.5 || input.lineWeight > 4)) {
    throw failure('INVALID_ARGUMENT', 'lineWeight 必须介于 1.5 和 4 之间。')
  }
  if ('variant' in input && (typeof input.variant !== 'number' || !Number.isInteger(input.variant) || input.variant < 0 || input.variant > 99)) {
    throw failure('INVALID_ARGUMENT', 'variant 必须是 0–99 之间的整数。')
  }
  if ('decorations' in input && typeof input.decorations !== 'boolean') {
    throw failure('INVALID_ARGUMENT', 'decorations 必须是布尔值。')
  }
  return input as Partial<ArtworkSettings>
}

function clone<T>(value: T): T {
  return structuredClone(value)
}

function canonical(value: unknown): string {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const record = value as Record<string, unknown>
    return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${canonical(record[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

export function validateEmptyInput(value: unknown) {
  onlyKeys(objectInput(value), [])
}

export function readMetadata(input: unknown, source: { id: string; version: string; name: string }) {
  validateEmptyInput(input)
  return { appId: source.id, version: source.version, name: source.name }
}

/** All mutations are synchronous, so revision checks and commits are atomic. */
export function createStudioHandlers(adapter: PelicanStudioAdapter) {
  const completed = new Map<string, CacheEntry>()

  function write<T extends WriteResult>(name: string, input: WriteGuard & Record<string, unknown>, operation: () => T): T {
    const fingerprint = `${name}:${canonical(input)}`
    const prior = completed.get(input.idempotency_key)
    if (prior) {
      if (prior.fingerprint !== fingerprint) {
        throw failure('IDEMPOTENCY_CONFLICT', '该幂等键已经用于不同的操作；请为新操作生成新键。')
      }
      return clone(prior.result) as T
    }
    if (adapter.readStudio().revision !== input.expected_revision) {
      throw failure('REVISION_CONFLICT', '画室已发生变化；请先重新读取最新状态。', true)
    }
    const result = clone(operation())
    completed.set(input.idempotency_key, { fingerprint, result })
    if (completed.size > MAX_CACHED_WRITES) {
      const oldest = completed.keys().next().value
      if (oldest !== undefined) completed.delete(oldest)
    }
    return clone(result)
  }

  return {
    readStudio(input: unknown): StudioState {
      validateEmptyInput(input)
      return clone(adapter.readStudio())
    },
    updateStudio(value: unknown): StudioState {
      const input = objectInput(value)
      onlyKeys(input, ['expected_revision', 'idempotency_key', 'title', 'settings'])
      const guard = writeGuard(input)
      const update: StudioUpdate = {}
      if ('title' in input) {
        if (typeof input.title !== 'string' || input.title.length > 40) {
          throw failure('INVALID_ARGUMENT', '作品标题必须是最多 40 字符的字符串。')
        }
        update.title = input.title
      }
      if ('settings' in input) update.settings = settingsInput(input.settings)
      if (!('title' in update) && (!update.settings || Object.keys(update.settings).length === 0)) {
        throw failure('INVALID_ARGUMENT', '请提供标题或至少一项插画设置。')
      }
      return write('update_studio', { ...guard, ...update }, () => adapter.updateStudio(clone(update)))
    },
    saveArtwork(value: unknown): SavedArtworkResult {
      const input = objectInput(value)
      onlyKeys(input, ['expected_revision', 'idempotency_key'])
      const guard = writeGuard(input)
      return write('save_artwork', guard, () => ({ ...adapter.saveArtwork(), revision: adapter.readStudio().revision }))
    },
  }
}
