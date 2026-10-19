/**
 * Public compatibility primitives for an app Agent contract (for example,
 * the `proxy.desktop.agent/v1` data format). This module validates application
 * declarations and schemas; runtime registration, transport, authorization,
 * and host lifecycle remain in the private desktop implementation.
 */

export const AGENT_PROTOCOL = 'proxy.desktop.agent/v1'
export const AGENT_PROTOCOL_VERSION = 1

export const ACCESS = Object.freeze({ READ: 'read', WRITE: 'write' })

const LEGACY_APP_ID_RE = /^app-[a-z0-9][a-z0-9._-]{0,119}$/
const PLATFORM_APP_ID_RE = /^app_[a-z0-9][a-z0-9._-]{2,119}$/
const VERSION_RE = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/
const NAMESPACE_RE = /^[a-z][a-z0-9]*(?:[-_.][a-z0-9]+)*$/
const CAPABILITY_RE = /^[a-z][a-z0-9]*(?:[_-][a-z0-9]+)*$/
const TOOL_RE = /^proxy_[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/
const AGENT_TARGETS = Object.freeze(['web', 'desktop'])
const MAX_SCHEMA_BYTES = 64 * 1024
const RESERVED_NAMESPACES = new Set(['app', 'codex', 'desktop', 'proxy', 'system'])

export function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

export function assert(condition, message) {
  if (!condition) throw new TypeError(message)
}

export function isPublicAppSlug(value) {
  return typeof value === 'string' && value === value.trim() && value.length <= 120 && /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/.test(value)
}

export function isAppManifestID(value) {
  return isPublicAppSlug(value) || (typeof value === 'string' && value === value.trim() && PLATFORM_APP_ID_RE.test(value))
}

export function assertAppId(value) {
  assert(isAppManifestID(value) || (typeof value === 'string' && value === value.trim() && LEGACY_APP_ID_RE.test(value)), `invalid app id: ${value}`)
  return value
}

export function assertVersion(value) {
  assert(typeof value === 'string' && VERSION_RE.test(value), `invalid app version: ${value}`)
  return value
}

export function assertNamespace(value) {
  assert(typeof value === 'string' && NAMESPACE_RE.test(value) && value.length <= 48,
    `invalid agent namespace: ${value}`)
  return value
}

export function assertCapabilityName(value) {
  assert(typeof value === 'string' && CAPABILITY_RE.test(value) && value.length <= 64,
    `invalid capability name: ${value}`)
  return value
}

export function normalizeAgentTargets(value, field = 'targets', fallback = ['desktop']) {
  const targets = value === undefined ? fallback : value
  assert(Array.isArray(targets) && targets.length > 0 && targets.length <= AGENT_TARGETS.length, `${field} must list one or more targets`)
  assert(new Set(targets).size === targets.length && targets.every(target => AGENT_TARGETS.includes(target)), `${field} must contain only web or desktop`)
  return Object.freeze(AGENT_TARGETS.filter(target => targets.includes(target)))
}

export function normalizeSchema(value, field = 'schema') {
  const schema = value === undefined ? { type: 'object' } : value
  assert(isRecord(schema), `${field} must be a JSON schema object`)
  let bytes
  try { bytes = Buffer.byteLength(JSON.stringify(schema)) } catch { bytes = Infinity }
  assert(bytes <= MAX_SCHEMA_BYTES, `${field} exceeds ${MAX_SCHEMA_BYTES} bytes`)
  validateSchema(schema, field)
  return schema
}

export function normalizeCapabilityDeclaration(input, { defaultTargets = ['desktop'] } = {}) {
  assert(isRecord(input), 'agent capability must be an object')
  const name = assertCapabilityName(input.name)
  const description = input.description === undefined ? '' : input.description
  assert(typeof description === 'string' && description.length <= 2048, `invalid description for ${name}`)
  const access = input.access === undefined ? ACCESS.READ : input.access
  assert(access === ACCESS.READ || access === ACCESS.WRITE, `invalid access for ${name}`)
  const idempotent = input.idempotent === undefined ? access === ACCESS.READ : input.idempotent
  assert(typeof idempotent === 'boolean', `invalid idempotent value for ${name}`)
  const title = input.title === undefined ? name : input.title
  assert(typeof title === 'string' && title.length <= 200, `invalid title for ${name}`)
  for (const field of ['destructive', 'open_world', 'billable']) if (input[field] !== undefined) assert(typeof input[field] === 'boolean', `invalid ${field} for ${name}`)
  const completion = input.completion || 'completed'
  assert(['completed', 'accepted'].includes(completion), `invalid completion for ${name}`)
  const targets = normalizeAgentTargets(input.targets, `${name}.targets`, defaultTargets)
  const inputSchema = normalizeSchema(input.input_schema ?? input.inputSchema, `${name}.input_schema`)
  const outputSchema = normalizeSchema(input.output_schema ?? input.outputSchema, `${name}.output_schema`)
  assert(inputSchema.type === 'object' && outputSchema.type === 'object', 'tool schemas must have object roots')
  if (access === ACCESS.WRITE) assert(inputSchema.properties?.idempotency_key?.type === 'string' && inputSchema.required?.includes('idempotency_key'), 'write capabilities must require a string idempotency_key')
  return Object.freeze({
    name,
    title,
    description,
    destructive: input.destructive ?? access === ACCESS.WRITE,
    open_world: input.open_world ?? false,
    billable: input.billable ?? false,
    completion,
    targets,
    access,
    idempotent,
    input_schema: inputSchema,
    output_schema: outputSchema,
  })
}

export function normalizeManifestAgent(manifest) {
  assert(isRecord(manifest), 'manifest must be an object')
  const agent = manifest.agent
  if (agent === undefined) return null
  assert(isRecord(agent), 'manifest.agent must be an object')
  if (agent.enabled === false) return null
  assert(agent.enabled === true, 'manifest.agent.enabled must be true or false')
  if (agent.contract_source !== undefined) assert(agent.contract_source === 'code', 'invalid agent contract_source')
  assert(!(agent.contract_source === 'code' && agent.entry), 'generated code contract must not retain agent.entry')
  assert(!(agent.entry && agent.capabilities !== undefined), 'agent.entry and agent.capabilities cannot both be present')
  assertAppId(manifest.id)
  assertVersion(manifest.version)
  const namespace = assertNamespace(agent.namespace || manifest.id.replace(/^app\./, '').replace(/[^a-zA-Z0-9]+/g, '_').toLowerCase())
  assert(!RESERVED_NAMESPACES.has(namespace), `reserved agent namespace: ${namespace}`)
  const targets = normalizeAgentTargets(agent.targets, 'manifest.agent.targets')
  // Source projects reference their capability module. Packaged code-first
  // apps carry its generated declarations for discovery before launch.
  const raw = agent.capabilities === undefined ? [] : agent.capabilities
  assert(Array.isArray(raw) && raw.length <= 64, 'manifest.agent.capabilities must be an array with at most 64 entries')
  const capabilities = raw.map(capability => normalizeCapabilityDeclaration(capability, { defaultTargets: targets }))
  const seen = new Set()
  for (const capability of capabilities) {
    assert(capability.targets.every(target => targets.includes(target)), `${capability.name}.targets must be a subset of manifest.agent.targets`)
    assert(!seen.has(capability.name), `duplicate agent capability: ${capability.name}`)
    seen.add(capability.name)
  }
  const tools = capabilities.map(capability => toolNameFor(namespace, capability.name))
  assert(new Set(tools).size === tools.length, 'duplicate generated tool name')
  const contractVersion = assertVersion(agent.contract_version || manifest.version)
  const summary = agent.summary || manifest.description || ''
  assert(typeof summary === 'string' && summary.length <= 2048, 'invalid agent summary')
  const keywords = agent.keywords || []
  assert(Array.isArray(keywords) && keywords.length <= 24 && keywords.every(item => typeof item === 'string' && item.length > 0 && item.length <= 80), 'invalid agent keywords')
  if (agent.guide !== undefined) {
    assert(isRecord(agent.guide) && typeof agent.guide.entry === 'string', 'invalid agent guide')
    assert(Array.isArray(agent.guide.topics || []) && (agent.guide.topics || []).length <= 16, 'invalid agent guide topics')
  }
  if (agent.examples !== undefined) assert(typeof agent.examples === 'string', 'invalid agent examples')
  return Object.freeze({ enabled: true, namespace, targets, contractVersion, summary, keywords, guide: agent.guide, examples: agent.examples, capabilities })
}

export function toolNameFor(namespace, capability) {
  assertNamespace(namespace)
  assertCapabilityName(capability)
  const name = `proxy_${namespace.replaceAll('-', '_').replaceAll('.', '_')}_${capability.replaceAll('-', '_')}`
  assert(name.length <= 128 && TOOL_RE.test(name), `invalid generated tool name: ${name}`)
  return name
}

// Deliberately bounded JSON Schema subset. Reject unsupported keywords instead
// of advertising validation that the host cannot actually enforce.
const keywords = new Set(['type', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'minLength', 'maxLength', 'minimum', 'maximum', 'minItems', 'maxItems', 'description', 'title', 'default'])
export function validateSchema(schema, path = '$', depth = 0) {
  assert(depth <= 16 && isRecord(schema), `${path}: invalid or too deeply nested schema`)
  for (const key of Object.keys(schema)) assert(keywords.has(key), `${path}: unsupported schema keyword ${key}`)
  const allowed = ['object', 'array', 'string', 'number', 'integer', 'boolean', 'null']
  const types = Array.isArray(schema.type) ? schema.type : [schema.type]
  assert(types.every(type => allowed.includes(type)) && (types.length === 1 || types.length === 2 && new Set(types).size === 2 && types.includes('null')), `${path}: explicit type or a nullable type pair is required`)
  const type = types.find(type => type !== 'null') || 'null'
  if (schema.properties !== undefined) {
    assert(type === 'object' && isRecord(schema.properties), `${path}: invalid properties`)
    for (const [key, value] of Object.entries(schema.properties)) validateSchema(value, `${path}.${key}`, depth + 1)
  }
  if (schema.required !== undefined) assert(Array.isArray(schema.required) && schema.required.every(key => typeof key === 'string' && Object.hasOwn(schema.properties || {}, key)), `${path}: invalid required fields`)
  if (schema.additionalProperties !== undefined) assert(typeof schema.additionalProperties === 'boolean', `${path}: additionalProperties must be boolean`)
  if (type === 'array') validateSchema(schema.items, `${path}[]`, depth + 1)
  if (schema.enum !== undefined) assert(Array.isArray(schema.enum) && schema.enum.length > 0, `${path}: invalid enum`)
  for (const key of ['minimum', 'maximum', 'minLength', 'maxLength', 'minItems', 'maxItems']) if (schema[key] !== undefined) {
    assert(Number.isFinite(schema[key]), `${path}: invalid ${key}`)
    if (!['minimum', 'maximum'].includes(key)) assert(Number.isInteger(schema[key]) && schema[key] >= 0, `${path}: invalid ${key}`)
  }
}
export function validateValue(schema, value, path = '$') {
  const fail = (message) => { throw Object.assign(new Error(`${path}: ${message}`), { code: 'AGENT_INVALID_ARGUMENT' }) }
  const types = Array.isArray(schema.type) ? schema.type : [schema.type]
  const type = value === null && types.includes('null') ? 'null' : types.find(type => type !== 'null') || 'null'
  const valid = type === 'object' ? isRecord(value) : type === 'array' ? Array.isArray(value) : type === 'null' ? value === null : type === 'integer' ? Number.isInteger(value) : typeof value === type
  if (!valid || (typeof value === 'number' && !Number.isFinite(value))) fail(`expected ${type}`)
  if (schema.enum && !schema.enum.some(item => JSON.stringify(item) === JSON.stringify(value))) fail('value is not in enum')
  if (type === 'object') {
    for (const key of schema.required || []) if (!Object.hasOwn(value, key)) fail(`missing ${key}`)
    for (const [key, item] of Object.entries(value)) {
      if (Object.hasOwn(schema.properties || {}, key)) validateValue(schema.properties[key], item, `${path}.${key}`)
      else if (schema.additionalProperties === false) fail(`unknown field ${key}`)
    }
  }
  if (type === 'array') {
    if (schema.minItems !== undefined && value.length < schema.minItems || schema.maxItems !== undefined && value.length > schema.maxItems) fail('array length out of range')
    value.forEach((item, i) => validateValue(schema.items, item, `${path}[${i}]`))
  }
  if (type === 'string' && (schema.minLength !== undefined && value.length < schema.minLength || schema.maxLength !== undefined && value.length > schema.maxLength)) fail('string length out of range')
  if (typeof value === 'number' && (schema.minimum !== undefined && value < schema.minimum || schema.maximum !== undefined && value > schema.maximum)) fail('number out of range')
}
