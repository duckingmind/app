export type LocalLoginFailureMessage = {
  protocol: 'proxy-app/auth/v1'
  type: 'login-failed'
  state: string
  error?: {
    code?: string
    message?: string
    stage?: string
    status?: number
    request_id?: string
    upstream_code?: string
  }
}

export type LocalLoginDetails = {
  /** Non-secret account partition returned by a browser-owned session exchange. */
  account_scope?: string
  login_url?: string
  auth_state?: string
  relay_url?: string
  authenticated?: boolean
  app_session?: AppSession
  /** True when a fresh Portal login is required before retrying the exchange. */
  force_login?: boolean
}

export type LocalLoginOptions = {
  /** Ask for fresh credentials, for example when explicitly switching accounts. */
  forceLogin?: boolean
  /** Credentials used by a standalone desktop host when no OAuth flow is configured. */
  email?: string
  password?: string
}

/**
 * Controls how a data-plane response is decoded by the SDK.
 *
 * `auto` (the default) uses the response Content-Type: JSON and text media
 * types are decoded as their corresponding values, while other media types
 * are returned as a Blob. `response` returns the native Response object so an
 * application can inspect headers or consume the body itself.
 */
export type AppApiResponseType = 'auto' | 'json' | 'text' | 'blob' | 'arrayBuffer' | 'response'

export type AppApiRequestInit = RequestInit & {
  responseType?: AppApiResponseType
}

/** Metadata returned by the generic application KV store. */
export type StorageEntryAuthor = {
  id: string
  name?: string | null
}

export type StorageEntry<T = unknown> = {
  key: string
  value: T | null
  revision: number
  updatedAt?: string | null
  /** Server-resolved author of the last shared-space write. */
  author?: StorageEntryAuthor | null
}

export type StorageOperationOptions = {
  /** Reuse for retries of the same immutable mutation, never for different content. */
  idempotencyKey?: string
}

export type StorageWriteOptions = StorageOperationOptions & {
  /** Safe integer matching the server revision. Use 0 for create-only puts; deletes require a positive revision. */
  expectedRevision?: number
}

export type StorageBatchOperation =
  | ({ op: 'put'; key: string; value: unknown } & Pick<StorageWriteOptions, 'expectedRevision'>)
  | ({ op: 'delete'; key: string } & Pick<StorageWriteOptions, 'expectedRevision'>)

/**
 * KV methods exposed for a server-selected workspace namespace. This type
 * deliberately has no workspace id, namespace, or scope parameter: the
 * platform binds the active workspace to the App Session and authorizes each
 * request against current membership.
 */
export type WorkspaceStorage = {
  get<T = unknown>(key: string): Promise<T | null>
  getEntry<T = unknown>(key: string): Promise<StorageEntry<T> | null>
  getMany<T = unknown>(keys: string[]): Promise<Record<string, T | null>>
  getEntries<T = unknown>(keys: string[]): Promise<Record<string, StorageEntry<T> | null>>
  set(key: string, value: unknown, options?: StorageWriteOptions): Promise<{ success: boolean; revision?: number }>
  delete(key: string, options?: StorageWriteOptions): Promise<{ success: boolean }>
  list(options?: StorageListOptions): Promise<StorageListResult>
  batch(operations: StorageBatchOperation[], options?: StorageOperationOptions): Promise<Array<{ key: string; success: boolean; revision?: number }>>
}

export type StorageListOptions = {
  prefix?: string
  cursor?: string
  limit?: number
}

export type StorageListResult = {
  keys: string[]
  nextCursor?: string
}

export type AppClientOptions = {
  /** Runtime front door. Legacy `server` values use the same direct Gateway transport. */
  runtime?: 'direct' | 'server' | 'local' | 'electron'
  /** Optional Electron preload bridge. Usually auto-detected from window.proxyApp. */
  electronHost?: ElectronHostBridge
  /** Short-lived user App Session returned by the Portal login flow. */
  appSession?: AppSession
  /** Exact bundle version used when the browser app requests an interactive Portal login. */
  appVersion?: string
  /** Obtains or refreshes the browser's user App Session, including initial local cookie exchange. */
  refreshAppSession?: () => Promise<AppSession>
  timeoutMs?: number
  /** Use the local development server started by `proxy-app dev`; it still calls Gateway `/v1`. */
  localDevelopment?: boolean
  localAppVersion?: string
  localGatewayPath?: string
  /** Portal origin used by the browser-only local development login flow. */
  portalURL?: string
}

export type AppApiStreamEvent<T = unknown> = {
  event?: string
  data: T
}

/** Same-origin app handler request. Authorization and app version are always SDK-owned. */
export type AppRuntimeRequestInit = Omit<RequestInit, 'credentials' | 'redirect'>
export type AppRuntimeStreamEvent<T = unknown> = AppApiStreamEvent<T>

export type AppProfile = {
  id: string
  email?: string
  username?: string
  name?: string
  avatar_url?: string
}

export type AppSession = {
  /** Optional local host services; never a grant of backend permissions. */
  host_capabilities?: string[]
  access_token: string
  token_type: string
  expires_in: number
  gateway_url: string
  app_id: string
  app_slug: string
  /** Public aliases confirmed by the platform; never a substitute for app_id. */
  app_aliases?: string[]
  app_version: string
  /** Opaque, non-secret platform/application/account partition; not a credential. */
  account_scope?: string
  scopes: string[]
}

export type AppAuthStatus = {
  authenticated: boolean
  /** Stable across token refresh and app upgrades; present when authenticated. */
  accountScope?: string
  profile?: AppProfile
}

/** Safe host bridge exposed by the Electron preload script. */
export type ElectronHostBridge = {
  /** Opens the platform app library for a standalone app that is not installed. */
  openAppMarket?(): Promise<{ opened?: boolean }>
  auth: {
    status(): Promise<AppAuthStatus>
    login(options?: LocalLoginOptions): Promise<void>
    logout(): Promise<void>
  }
  /** Optional allowlist of local, non-HTTP host capabilities. */
  capabilities?: string[]
  call(method: string, payload?: unknown): Promise<unknown>
  request(path: string, init?: AppApiRequestInit): Promise<unknown>
  stream?: (path: string, init?: RequestInit) => AsyncIterable<AppApiStreamEvent>
  /** Cancels a preload stream without waiting for its pending iterator.next(). */
  cancelStream?: (streamId: string) => void | Promise<void>
  /** Optional host bridge for registering capabilities for an external Agent. */
  agent?: import('./agent.js').AgentBridge
}

export class AppSdkError extends Error {
  code: string
  requestId?: string
  /** HTTP status returned by the data-plane request, when available. */
  status?: number
  /** Alias for callers that use the conventional `statusCode` name. */
  statusCode?: number
  /** Structured error payload returned by the platform, when available. */
  details?: unknown
  executionStarted?: boolean
  authReason?: string

  constructor(code: string, message: string, requestId?: string, status?: number, details?: unknown) {
    super(message)
    this.name = 'AppSdkError'
    this.code = code
    this.requestId = requestId
    this.status = status
    this.statusCode = status
    this.details = details
  }
}
