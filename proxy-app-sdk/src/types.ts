export type BridgeProtocol = 'proxy-app/v1'

export type BridgeRequest = {
  protocol: BridgeProtocol
  requestId: string
  appId: string
  runtimeId: string
  /** Per-mount host challenge; never persisted or sent to the data plane. */
  challenge: string
  method: string
  payload?: unknown
}

export type BridgeResponse = {
  protocol: BridgeProtocol
  requestId: string
  /** Echo of the per-mount challenge so stale/navigated documents are ignored. */
  challenge: string
  ok: boolean
  value?: unknown
  error?: {
    code?: string
    message?: string
  }
}

export type HostReadyMessage = {
  protocol: BridgeProtocol
  type: 'host-ready'
  appId: string
  challenge: string
  session?: AppSession
}

export type HostChallengeMessage = {
  protocol: BridgeProtocol
  type: 'host-challenge'
  appId: string
  challenge: string
}

export type HostReadyRequest = {
  protocol: BridgeProtocol
  type: 'host-ready-request'
  appId: string
  challenge: string
}

export type SessionRefreshRequest = {
  protocol: BridgeProtocol
  type: 'session-refresh-request'
  appId: string
  requestId: string
  challenge: string
}

export type SessionRefreshResponse = {
  protocol: BridgeProtocol
  type: 'session-refresh-response'
  appId: string
  requestId: string
  challenge: string
  ok: boolean
  session?: AppSession
  error?: {
    code?: string
    message?: string
  }
}

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
  login_url?: string
  auth_state?: string
  relay_url?: string
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

export type AppClientOptions = {
  /** Runtime front door. `direct` calls platform HTTP APIs with appSession. */
  runtime?: 'embedded' | 'direct' | 'local'
  /** Short-lived user session returned by the platform OAuth flow. */
  appSession?: AppSession
  /** Refreshes the user session after Gateway returns 401 in direct runtime. */
  refreshAppSession?: () => Promise<AppSession>
  /** App HTTP service base path for direct runtime. Defaults to the current origin. */
  runtimeBasePath?: string
  targetWindow?: Window
  targetOrigin?: string
  timeoutMs?: number
  onHostReady?: () => void
  /** Use the local development runtime started by `proxy-app dev`; never enable in a release build. */
  localDevelopment?: boolean
  localAppVersion?: string
  localGatewayPath?: string
  /** Same-origin app runtime path used by local page-runtime development. */
  localRuntimePath?: string
  /** @deprecated Bridge path retained for v1 iframe applications. */
  localBridgePath?: string
  localAuthPath?: string
  /** Optional local relay status endpoint used when popup postMessage is unavailable. */
  localAuthStatusPath?: string
  localLogoutPath?: string
  /** Called when the local relay has opened the platform login flow. */
  onLoginRequired?: (details?: LocalLoginDetails) => void
}

export type AppApiStreamEvent<T = unknown> = {
  event?: string
  data: T
}

export type AppProfile = {
  id: string
  email?: string
  username?: string
  avatar_url?: string
}

export type AppSession = {
  access_token: string
  token_type: string
  expires_in: number
  gateway_url: string
  app_id: string
  app_slug: string
  app_version: string
  scopes: string[]
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
