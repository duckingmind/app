/**
 * Stable contract for stateless application HTTP handlers.
 *
 * The SDK owns this contract. A production Runtime Host and the local Vite
 * adapter both invoke the same handler shape; neither the CLI nor this file
 * selects or embeds a JavaScript engine.
 */
export type AppRuntimeUser = {
  /** Platform-authenticated user identifier. Never read this from request JSON. */
  id: string
  email?: string
  name?: string
}

export type AppRuntimeContext = {
  appId: string
  appVersion: string
  requestId: string
  /** Missing in the local adapter; production hosts set this from verified claims. */
  user?: AppRuntimeUser
  signal: AbortSignal
  platform: {
    /** Calls a narrowly allowlisted Gateway endpoint with the verified App Session. */
    request(path: string, init?: RequestInit): Promise<Response>
  }
}

export type AppHandler = (
  request: Request,
  context: AppRuntimeContext,
) => Response | Promise<Response>

/**
 * The publish-time declaration for a request function. `entry` is the
 * compiled file inside the release archive; `source` is only a developer
 * convenience used by the CLI to check the local source entry.
 */
export type AppRequestFunctionManifest = {
  entry: string
  source?: string
  routes?: string[]
  timeout_ms?: number
}

/**
 * The publish-time declaration for a task function. Gateway persists the task
 * and dispatches each attempt to a fresh Runtime sandbox; retries can run in a
 * different sandbox after a lease expires or a host restarts. It is not an
 * always-on application service.
 */
export type AppTaskFunctionManifest = {
  entry: string
  source?: string
  concurrency?: number
  max_attempts?: number
  /** Hard wall-clock limit for one task attempt. */
  timeout_ms?: number
}

/** An app may expose either function independently or both together. */
export type AppFunctionsManifest = {
  request?: AppRequestFunctionManifest
  task?: AppTaskFunctionManifest
}

export type AppTask<TPayload = unknown> = {
  id: string
  name: string
  payload: TPayload
  attempt: number
  idempotencyKey: string
  createdAt: string
  createdBy?: AppRuntimeUser
}

export type AppTaskContext = {
  appId: string
  appVersion: string
  requestId: string
  signal: AbortSignal
  user?: AppRuntimeUser
  task: Pick<AppTask, 'id' | 'name' | 'attempt' | 'idempotencyKey' | 'createdAt' | 'createdBy'>
  platform: AppRuntimeContext['platform']
  reportProgress(update: { percent?: number; message?: string; data?: unknown }): Promise<void>
  /** Wait without busy polling. The Runtime Host cancels this wait with the task attempt. */
  sleep(milliseconds: number): Promise<void>
}

/** Contract for one Gateway-dispatched task attempt.
 * A resolved handle result is stored as the task result; thrown errors follow
 * the platform retry policy. Every attempt runs in an isolated Runtime Host
 * sandbox; correctness must live inside handle because retries may run in a
 * fresh sandbox after a lease expires or a host restarts.
 */
export type AppTaskFunction<TPayload = unknown, TResult = unknown> = {
  handle(task: AppTask<TPayload>, context: AppTaskContext): TResult | Promise<TResult>
}
