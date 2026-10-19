import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { createStudioHandlers, readMetadata, type StudioState } from '../src/agent-contract.ts'
import { deleteLocalGalleryItem, readDeletedGalleryIds, readLocalGallery, writeLocalGallery } from '../src/gallery-storage.ts'
import { agentMetadata, capabilities, capability } from '../src/agent-tools.mjs'
import { normalizeManifestAgent, validateValue } from '../../../cli/agent-runtime/protocol.mjs'

const manifest = JSON.parse(await readFile(new URL('../manifest.json', import.meta.url), 'utf8'))

test('code-owned declarations cover the studio handlers and validate the guide examples', async () => {
  assert.equal(Object.hasOwn(manifest, 'agent'), false)
  const contract = normalizeManifestAgent({ ...manifest, agent: { enabled: true, ...agentMetadata, contract_source: 'code', capabilities } })
  assert.deepEqual(contract.capabilities.map(entry => entry.name).sort(), ['read_metadata', 'read_studio', 'save_artwork', 'update_studio'])
  const examples = JSON.parse(await readFile(new URL(`../${agentMetadata.examples}`, import.meta.url), 'utf8'))
  for (const example of examples) {
    const declaration = capability(example.capability)
    validateValue(declaration.input_schema, example.input)
    if (example.output) validateValue(declaration.output_schema, example.output)
  }
})

function fixture() {
  let revision = 1
  let updates = 0
  let saves = 0
  const state: StudioState = {
    revision: 'studio-1',
    title: '海风与鹈鹕',
    settings: { scene: 'coast', palette: 'teal', wing: 'light', lineWeight: 2.5, decorations: true, variant: 0 },
    savedCount: 0,
  }
  const advance = () => { state.revision = `studio-${++revision}` }
  const handlers = createStudioHandlers({
    readStudio: () => state,
    updateStudio: input => {
      updates += 1
      if (input.title !== undefined) state.title = input.title
      if (input.settings) Object.assign(state.settings, input.settings)
      advance()
      return state
    },
    saveArtwork: () => {
      saves += 1
      state.savedCount += 1
      advance()
      return { id: `artwork-${saves}`, title: state.title }
    },
  })
  return { handlers, state, advance, counts: () => ({ updates, saves }) }
}

function code(expected: string) {
  return (error: unknown) => error instanceof Error && 'code' in error && error.code === expected
}

function validateOutput(name: string, output: unknown) {
  const declaration = capability(name)
  validateValue(declaration.output_schema, output)
}

test('metadata uses the manifest identity and satisfies its strict output schema', () => {
  const metadata = readMetadata({}, manifest)
  assert.deepEqual(metadata, { appId: manifest.id, version: manifest.version, name: manifest.name })
  assert.deepEqual(Object.keys(metadata).sort(), ['appId', 'name', 'version'])
  validateOutput('read_metadata', metadata)
  assert.throws(() => readMetadata({ description: true }, manifest), code('INVALID_ARGUMENT'))
})

test('reads and mutation results satisfy declared schemas and remain detached from live state', () => {
  const { handlers, state } = fixture()
  const read = handlers.readStudio({})
  validateOutput('read_studio', read)
  read.settings.palette = 'coral'
  read.title = 'changed externally'
  assert.equal(state.settings.palette, 'teal')
  assert.equal(state.title, '海风与鹈鹕')

  const input = { idempotency_key: 'update-clone-001', expected_revision: 'studio-1', title: '晚霞骑行', settings: { palette: 'coral', lineWeight: 3 } }
  const result = handlers.updateStudio(input)
  validateOutput('update_studio', result)
  assert.equal(result.revision, 'studio-2')
  result.settings.palette = 'lavender'
  result.title = 'another external change'
  state.settings.lineWeight = 4
  const retry = handlers.updateStudio(input)
  assert.equal(state.settings.palette, 'coral')
  assert.equal(state.title, '晚霞骑行')
  assert.equal(retry.settings.palette, 'coral')
  assert.equal(retry.settings.lineWeight, 3)
  assert.equal(retry.title, '晚霞骑行')
})

test('equivalent retries with reordered object keys return the original result exactly once', () => {
  const { handlers, advance, counts } = fixture()
  const first = handlers.updateStudio({
    idempotency_key: 'update-order-001', expected_revision: 'studio-1', title: '晚霞骑行',
    settings: { scene: 'sunset', palette: 'coral', decorations: false },
  })
  advance()
  const retry = handlers.updateStudio({
    settings: { decorations: false, palette: 'coral', scene: 'sunset' }, title: '晚霞骑行',
    expected_revision: 'studio-1', idempotency_key: 'update-order-001',
  })
  assert.deepEqual(retry, first)
  assert.notEqual(retry, first)
  assert.deepEqual(counts(), { updates: 1, saves: 0 })
})

test('a key cannot be reused with changed parameters or for another capability', () => {
  const { handlers, counts } = fixture()
  const input = { idempotency_key: 'shared-key-001', expected_revision: 'studio-1', title: '晚霞骑行' }
  handlers.updateStudio(input)
  assert.throws(() => handlers.updateStudio({ ...input, title: '另一个标题' }), code('IDEMPOTENCY_CONFLICT'))
  assert.throws(() => handlers.updateStudio({ ...input, expected_revision: 'studio-2' }), code('IDEMPOTENCY_CONFLICT'))
  assert.throws(() => handlers.saveArtwork({ idempotency_key: input.idempotency_key, expected_revision: 'studio-2' }), code('IDEMPOTENCY_CONFLICT'))
  assert.deepEqual(counts(), { updates: 1, saves: 0 })
})

test('stale revisions fail before any mutation and include a read-state recovery hint', () => {
  const { handlers, advance, counts } = fixture()
  advance()
  assert.throws(
    () => handlers.updateStudio({ idempotency_key: 'stale-update-001', expected_revision: 'studio-1', title: '晚霞骑行' }),
    error => code('REVISION_CONFLICT')(error) && Object.hasOwn(error as object, 'executionStarted') && (error as { executionStarted: boolean }).executionStarted === false,
  )
  assert.throws(
    () => handlers.saveArtwork({ idempotency_key: 'stale-save-001', expected_revision: 'studio-1' }),
    error => code('REVISION_CONFLICT')(error) && (error as { nextAction: { capability: string } }).nextAction.capability === 'read_studio',
  )
  assert.deepEqual(counts(), { updates: 0, saves: 0 })
})

test('saving the same operation twice does not create duplicate artwork', () => {
  const { handlers, state, advance, counts } = fixture()
  const input = { idempotency_key: 'save-retry-001', expected_revision: 'studio-1' }
  const first = handlers.saveArtwork(input)
  validateOutput('save_artwork', first)
  assert.deepEqual(first, { id: 'artwork-1', title: '海风与鹈鹕', revision: 'studio-2' })
  first.title = 'changed response'
  advance()
  const retry = handlers.saveArtwork(input)
  assert.equal(retry.title, '海风与鹈鹕')
  assert.equal(retry.revision, 'studio-2')
  assert.equal(state.savedCount, 1)
  assert.deepEqual(counts(), { updates: 0, saves: 1 })
})

test('setting enums, numeric bounds, integers, booleans and unknown fields are enforced before writes', () => {
  const { handlers, counts } = fixture()
  const invalidSettings = [
    { scene: 'mountain' }, { palette: 'blue' }, { wing: 'black' },
    { lineWeight: 1.49 }, { lineWeight: 4.01 }, { lineWeight: Number.NaN }, { lineWeight: Infinity },
    { variant: -1 }, { variant: 100 }, { variant: 1.5 }, { variant: '1' },
    { decorations: 1 }, { decorations: 'false' }, { background: '#fff' }, null, [],
  ]
  for (const settings of invalidSettings) {
    assert.throws(() => handlers.updateStudio({ idempotency_key: 'range-validation-001', expected_revision: 'studio-1', settings }), code('INVALID_ARGUMENT'))
  }
  const lower = handlers.updateStudio({ idempotency_key: 'range-min-001', expected_revision: 'studio-1', settings: { lineWeight: 1.5, variant: 0, decorations: false } })
  const upper = handlers.updateStudio({ idempotency_key: 'range-max-001', expected_revision: lower.revision, settings: { lineWeight: 4, variant: 99 } })
  assert.equal(upper.settings.lineWeight, 4)
  assert.equal(upper.settings.variant, 99)
  assert.deepEqual(counts(), { updates: 2, saves: 0 })
})

test('guards, title limits, empty updates and undeclared arguments fail before writes', () => {
  const { handlers, counts } = fixture()
  const valid = { idempotency_key: 'argument-validation-001', expected_revision: 'studio-1', title: '鹈鹕' }
  const invalid = [
    null, [], {}, { ...valid, idempotency_key: 'short' }, { ...valid, idempotency_key: 'x'.repeat(129) },
    { ...valid, expected_revision: '' }, { ...valid, expected_revision: 'x'.repeat(129) },
    { ...valid, title: 'x'.repeat(41) }, { ...valid, title: 123 }, { ...valid, projectName: 'not declared' },
    { idempotency_key: valid.idempotency_key, expected_revision: valid.expected_revision },
    { idempotency_key: valid.idempotency_key, expected_revision: valid.expected_revision, settings: {} },
  ]
  for (const input of invalid) assert.throws(() => handlers.updateStudio(input), code('INVALID_ARGUMENT'))
  assert.throws(() => handlers.readStudio({ title: 'not declared' }), code('INVALID_ARGUMENT'))
  assert.throws(() => handlers.saveArtwork({ idempotency_key: valid.idempotency_key, expected_revision: valid.expected_revision, name: 'not declared' }), code('INVALID_ARGUMENT'))
  assert.deepEqual(counts(), { updates: 0, saves: 0 })
})

test('adapter mutations cannot alter the caller-provided update', () => {
  const { state } = fixture()
  const handlers = createStudioHandlers({
    readStudio: () => state,
    updateStudio: input => {
      if (input.settings) input.settings.palette = 'lavender'
      state.revision = 'studio-2'
      return state
    },
    saveArtwork: () => ({ id: 'unused', title: state.title }),
  })
  const settings = { palette: 'coral' as const }
  handlers.updateStudio({ idempotency_key: 'input-clone-001', expected_revision: 'studio-1', settings })
  assert.deepEqual(settings, { palette: 'coral' })
})

test('gallery results survive reload and local deletion suppresses stale cloud copies', () => {
  const values = new Map<string, string>()
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value) },
  }
  const first = { id: 'result-1', userName: 'Ada', model: 'model-a', generatedAt: '2026-10-13T10:00:00.000Z', raw: '<svg/>', html: '<html><body><svg/></body></html>' }
  writeLocalGallery(first, storage)
  assert.deepEqual(readLocalGallery(storage), [first])

  deleteLocalGalleryItem(first.id, storage)
  assert.deepEqual(readLocalGallery(storage), [])
  assert.deepEqual(readDeletedGalleryIds(storage), [first.id])
})

test('local gallery keeps a new result when quota requires dropping older entries', () => {
  const values = new Map<string, string>()
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      if (value.length > 300) throw Object.assign(new Error('quota'), { name: 'QuotaExceededError' })
      values.set(key, value)
    },
  }
  const item = (id: string, generatedAt: string) => ({ id, userName: 'Ada', model: 'model-a', generatedAt, raw: 'x'.repeat(40), html: '<svg/>' })
  writeLocalGallery(item('old', '2026-10-12T10:00:00.000Z'), storage)
  writeLocalGallery(item('new', '2026-10-13T10:00:00.000Z'), storage)
  assert.deepEqual(readLocalGallery(storage).map(entry => entry.id), ['new'])
})
