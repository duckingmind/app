export type AgentAccess = 'read' | 'write'
export type AgentTarget = 'web' | 'desktop'
export type AgentEnvironment = { target: AgentTarget; agentAvailable: boolean }
export type AgentNextAction = {
  type: 'wait' | 'user_login' | 'open_document' | 'retry' | 'inspect_state'
  capability?: string
}
export type AgentRuntimeStatus = {
  state: 'ready' | 'auth_required' | 'loading' | 'no_document' | 'busy' | 'error'
  reason?: string
  retryable?: boolean
  nextAction?: AgentNextAction
  context?: { activeDocumentId?: string }
}
export type AgentCapabilityDeclaration = {
  name: string
  title?: string
  description?: string
  access?: AgentAccess
  idempotent?: boolean
  destructive?: boolean
  open_world?: boolean
  billable?: boolean
  completion?: 'completed' | 'accepted'
  targets?: AgentTarget[]
  input_schema?: Record<string, unknown>
  output_schema?: Record<string, unknown>
}

/** Build-time Agent discovery metadata owned by the application's code module. */
export type AgentContractMetadata = {
  namespace: string
  targets: AgentTarget[]
  contract_version: string
  summary?: string
  keywords?: string[]
  guide?: { entry: string; topics?: Array<{ id: string; title: string; entry: string }> }
  examples?: string
}

/** Share this declaration with the build-generated capability catalog. */
export type AgentCapabilityRegistration = AgentCapabilityDeclaration & { name: string }
export type AgentRuntimeRegistration = {
  appId: string
  version: string
  capabilities: Array<{ name: string; handlerVersion?: number; available?: boolean }>
}
export type AgentInvocationContext = {
  requestId: string
  appId: string
  appVersion: string
  capability: string
  signal: AbortSignal
}
export type AgentHandler<TInput = unknown, TResult = unknown> = (input: TInput, context: AgentInvocationContext) => TResult | Promise<TResult>
type WireRequest = Omit<AgentInvocationContext, 'signal'> & { args?: unknown; epoch: string; deadlineAt: number }
export type AgentBridge = {
  target?: AgentTarget
  /** False when the renderer has no connection to the main application's MCP host. */
  available?: boolean
  register(capabilities: AgentCapabilityRegistration[]): Promise<unknown>
  setStatus?(status: AgentRuntimeStatus, epoch: string): Promise<unknown>
  onInvoke(listener: (request: WireRequest) => void): () => void
  onCancel(listener: (request: { requestId: string }) => void): () => void
  respond(response: unknown): void
}
const handlers = new Map<string, { declaration: AgentCapabilityDeclaration; handler: AgentHandler }>()
const active = new Map<string, { controller: AbortController; capability: string }>()
let subscribed: AgentBridge | undefined
let unsubscribe: Array<() => void> = []
let scheduled = false
let registration: Promise<unknown> = Promise.resolve()
const statuses = new Map<string, { status: AgentRuntimeStatus; priority: number; sequence: number }>()
let statusSequence = 0
function nextAction(value: unknown): AgentNextAction {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Invalid agent nextAction')
  const action = value as AgentNextAction
  if (Object.keys(action).some(key => !['type', 'capability'].includes(key)) || !['wait', 'user_login', 'open_document', 'retry', 'inspect_state'].includes(action.type)) throw new TypeError('Invalid agent nextAction')
  if (action.capability !== undefined && (typeof action.capability !== 'string' || !/^[a-z][a-z0-9_-]{0,127}$/.test(action.capability))) throw new TypeError('Invalid agent nextAction capability')
  return { type: action.type, ...(action.capability === undefined ? {} : { capability: action.capability }) }
}
function normalizeStatus(value: AgentRuntimeStatus): AgentRuntimeStatus {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !['state', 'reason', 'retryable', 'nextAction', 'context'].includes(key))) throw new TypeError('Invalid agent runtime status')
  if (!['ready', 'auth_required', 'loading', 'no_document', 'busy', 'error'].includes(value.state)) throw new TypeError('Invalid agent runtime state')
  if (value.reason !== undefined && (typeof value.reason !== 'string' || value.reason.length > 512)) throw new TypeError('Invalid agent runtime reason')
  if (value.retryable !== undefined && typeof value.retryable !== 'boolean') throw new TypeError('Invalid agent runtime retryable value')
  if (value.context !== undefined && (!value.context || typeof value.context !== 'object' || Array.isArray(value.context) || Object.keys(value.context).some(key => key !== 'activeDocumentId') || (value.context.activeDocumentId !== undefined && (typeof value.context.activeDocumentId !== 'string' || value.context.activeDocumentId.length > 128)))) throw new TypeError('Invalid agent runtime context')
  return { state: value.state,
    ...(value.reason === undefined ? {} : { reason: value.reason }),
    ...(value.retryable === undefined ? {} : { retryable: value.retryable }),
    ...(value.nextAction === undefined ? {} : { nextAction: nextAction(value.nextAction) }),
    ...(value.context === undefined ? {} : { context: { ...value.context } }),
  }
}
function currentStatus(): AgentRuntimeStatus {
  const selected = [...statuses.values()].sort((a, b) => b.priority - a.priority || b.sequence - a.sequence)[0]
  return selected?.status || { state: 'loading', reason: 'Application state has not been reported', retryable: true, nextAction: { type: 'wait' } }
}
function unwrapBridgeResult(value: unknown) {
  const result = value as { __proxyIPCResult?: boolean; ok?: boolean; error?: { message: string }; value?: unknown }
  if (result?.__proxyIPCResult) {
    if (!result.ok) throw new Error(result.error?.message || 'Agent registration failed')
    return result.value
  }
  return value
}
function getBridge(): AgentBridge | undefined {
  return typeof window === 'undefined' ? undefined : (window as unknown as { proxyApp?: { agent?: AgentBridge } }).proxyApp?.agent
}
function scheduleRegistration() {
  scheduled = true
  if (synchronizing) return
  synchronizing = true
  registration = Promise.resolve().then(async () => {
    while (scheduled) {
      scheduled = false
      const bridge = getBridge()
      if (!bridge || bridge.available === false) continue // Standalone apps retain normal behavior without an MCP host.
      if (subscribed !== bridge) {
        unsubscribe.forEach(off => off())
        for (const invocation of active.values()) invocation.controller.abort(new Error('Agent bridge changed'))
        subscribed = bridge
        unsubscribe = [bridge.onInvoke(request => { void respond(bridge, request) }), bridge.onCancel(request => active.get(request.requestId)?.controller.abort(new Error('Agent call cancelled')))]
      }
      // Registration and status share one queue. A late status from a previous
      // render can never overtake the next registration or its current status.
      const declarations = [...handlers.values()]
        .filter(({ declaration }) => !declaration.targets || declaration.targets.includes(bridge.target || 'desktop'))
        .map(({ declaration }) => structuredClone(declaration))
      const result = unwrapBridgeResult(await bridge.register(declarations)) as { epoch?: string } | undefined
      if (bridge.setStatus && typeof result?.epoch === 'string') unwrapBridgeResult(await bridge.setStatus(currentStatus(), result.epoch))
    }
  }).finally(() => {
    synchronizing = false
    if (scheduled) scheduleRegistration()
  })
  // Keep errors observable through ready(), without unhandled rejections during
  // React mounting. Availability remains controlled by the desktop host.
  void registration.catch(error => console.error('Agent registration failed:', error))
}
let synchronizing = false
async function respond(bridge: AgentBridge, request: WireRequest) {
  if (active.has(request.requestId)) return
  const controller = new AbortController()
  active.set(request.requestId, { controller, capability: request.capability })
  const timer = setTimeout(() => controller.abort(new Error('Agent deadline expired')), Math.max(0, request.deadlineAt - Date.now()))
  try {
    if (request.deadlineAt <= Date.now()) throw new Error('Agent deadline expired')
    const result = await dispatchAgentInvocation({ ...request, signal: controller.signal })
    bridge.respond({ requestId: request.requestId, epoch: request.epoch, ok: true, result })
  } catch (error) {
    const failure = error as { code?: string; message?: string; status?: number; requestId?: string; authReason?: string; executionStarted?: boolean; reason?: string; retryable?: boolean; nextAction?: AgentNextAction } | null | undefined
    let action: AgentNextAction | undefined
    try { if (failure?.nextAction !== undefined) action = nextAction(failure.nextAction) } catch { /* Recovery hints are optional. */ }
    bridge.respond({ requestId: request.requestId, epoch: request.epoch, ok: false, error: {
      code: typeof failure?.code === 'string' ? failure.code.slice(0, 128) : 'AGENT_HANDLER_ERROR',
      message: String(failure?.message || error).slice(0, 2048),
      ...(typeof failure?.status === 'number' && Number.isInteger(failure.status) && failure.status >= 100 && failure.status <= 599 ? { status: failure.status } : {}),
      ...(typeof failure?.requestId === 'string' ? { requestId: failure.requestId.slice(0, 256) } : {}),
      ...(typeof failure?.authReason === 'string' ? { authReason: failure.authReason.slice(0, 128) } : {}),
      ...(typeof failure?.executionStarted === 'boolean' ? { executionStarted: failure.executionStarted } : {}),
      ...(typeof failure?.reason === 'string' ? { reason: failure.reason.slice(0, 512) } : {}),
      ...(typeof failure?.retryable === 'boolean' ? { retryable: failure.retryable } : {}),
      ...(action === undefined ? {} : { nextAction: action }),
    } })
  } finally { clearTimeout(timer); active.delete(request.requestId) }
}
export const agent = {
  /** Describe where this SDK instance is running without exposing credentials. */
  environment(): AgentEnvironment {
    const bridge = getBridge()
    const available = Boolean(bridge) && bridge?.available !== false
    return { target: bridge?.target || (bridge ? 'desktop' : 'web'), agentAvailable: available }
  },
  /** Report descriptive state. Higher-priority scopes temporarily override lower ones. */
  setStatus(status: AgentRuntimeStatus, options: { scope?: string; priority?: number } = {}) {
    const scope = options.scope || 'default'
    const priority = options.priority ?? 0
    if (typeof scope !== 'string' || scope.length > 64 || !Number.isFinite(priority)) throw new TypeError('Invalid agent status scope')
    const entry = { status: normalizeStatus(status), priority, sequence: ++statusSequence }
    statuses.set(scope, entry)
    scheduleRegistration()
    return () => {
      if (statuses.get(scope) !== entry) return
      statuses.delete(scope)
      scheduleRegistration()
    }
  },
  register<TInput = unknown, TResult = unknown>(declaration: AgentCapabilityDeclaration, handler: AgentHandler<TInput, TResult>) {
    if (!declaration || !/^[a-z][a-z0-9]*(?:[_-][a-z0-9]+)*$/.test(declaration.name) || declaration.name.length > 64) throw new TypeError('Invalid agent capability name')
    if (typeof handler !== 'function') throw new TypeError('Agent handler must be a function')
    const name = declaration.name
    if (handlers.has(name)) throw new Error(`Agent capability already registered: ${name}`)
    // Keep schemas and disposal ownership stable even if callers later reuse
    // or mutate their definition objects.
    const item = { declaration: structuredClone(declaration), handler: handler as AgentHandler }
    handlers.set(name, item)
    scheduleRegistration()
    return () => {
      if (handlers.get(name) !== item) return
      handlers.delete(name)
      for (const invocation of active.values()) if (invocation.capability === name) invocation.controller.abort(new Error('Agent capability unregistered'))
      scheduleRegistration()
    }
  },
  /** Register a handler using the same contract shape that the host catalogs. */
  registerCapability<TInput = unknown, TResult = unknown>(declaration: AgentCapabilityRegistration, handler: AgentHandler<TInput, TResult>) {
    if (!declaration || !['read', 'write'].includes(declaration.access || '') || !declaration.input_schema || !declaration.output_schema) throw new TypeError('Agent capability requires access, input_schema and output_schema')
    return this.register(declaration, handler)
  },
  ready: () => registration,
  registered: () => [...handlers.values()].map(item => structuredClone(item.declaration)),
}
export function createAgentBridge(): AgentBridge {
  const bridge = getBridge()
  if (!bridge || bridge.available === false) throw new Error('Desktop agent bridge is unavailable')
  return bridge
}
export async function dispatchAgentInvocation(request: AgentInvocationContext & { args?: unknown }) {
  request.signal.throwIfAborted()
  const item = handlers.get(request.capability)
  if (!item) throw Object.assign(new Error(`Agent capability unavailable: ${request.capability}`), { code: 'AGENT_CAPABILITY_NOT_FOUND', executionStarted: false, reason: 'handler_unregistered', retryable: true, nextAction: { type: 'wait' } })
  return item.handler(request.args, request)
}
