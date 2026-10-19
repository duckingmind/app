type AccountClient = {
  auth: {
    status(): Promise<{ authenticated: boolean; accountScope?: string }>
    login(options?: { forceLogin?: boolean }): Promise<unknown>
    loginMode: 'app' | 'host'
  }
  platform: { createSession(): Promise<unknown> }
}

const LOGIN_REQUIRED_CODES = new Set([
  'APP_LOGIN_CANCELLED',
  'APP_LOGIN_FAILED',
  'APP_LOGIN_NOT_ALLOWED',
  'APP_LOGIN_POPUP_BLOCKED',
  'APP_LOGIN_REQUIRED',
  'APP_LOGIN_SESSION_EXPIRED',
  'APP_LOGIN_STATE_INVALID',
  'APP_LOGIN_TIMEOUT',
  'APP_LOGIN_TOKEN_INVALID',
  'APP_SESSION_EXPIRED',
  'APP_SESSION_INVALID',
  'APP_SESSION_REVOKED',
  'APP_SESSION_REFRESH_FAILED',
  'APP_SESSION_REFRESH_UNAVAILABLE',
  'APP_SESSION_UNAVAILABLE',
])

function errorCodes(error: unknown): string[] {
  if (!error || typeof error !== 'object') return []
  const value = error as Record<string, unknown>
  const details = value.details && typeof value.details === 'object' ? value.details as Record<string, unknown> : {}
  const nested = details.error && typeof details.error === 'object' ? details.error as Record<string, unknown> : {}
  const wrapped = value.error && typeof value.error === 'object' ? value.error as Record<string, unknown> : {}
  return [value, wrapped, details, nested]
    .flatMap(item => [item.code, item.error_code])
    .filter((code): code is string => typeof code === 'string')
    .map(code => code.trim().toUpperCase())
}

/** Whether the next account action should start an interactive login. */
export function isLoginRequiredError(error: unknown): boolean {
  return errorCodes(error).some(code => LOGIN_REQUIRED_CODES.has(code))
}

export function isAccountScopeUnavailableError(error: unknown): boolean {
  return errorCodes(error).includes('APP_ACCOUNT_SCOPE_UNAVAILABLE')
}

export type AccountConnectionAction = 'check' | 'login' | 'relogin'

export type AccountConnectionFailure = {
  kind: 'account' | 'login' | 'connection'
  message: string
  action: AccountConnectionAction
  hostedLogin: boolean
}

/** Keep account metadata failures distinct from a missing OAuth login, as in Canvas. */
export function accountConnectionFailure(error: unknown, loginMode: AccountClient['auth']['loginMode']): AccountConnectionFailure {
  const codes = errorCodes(error)
  const hostedLogin = loginMode === 'host' || codes.includes('APP_LOGIN_UNAVAILABLE')
  if (isAccountScopeUnavailableError(error)) return {
    kind: 'account', hostedLogin, action: hostedLogin ? 'check' : 'relogin',
    message: hostedLogin
      ? '暂时无法确认账户信息，请返回平台确认账户后重新检查。'
      : '暂时无法确认账户信息，请重新检查；仍未恢复可重新登录。',
  }
  if (hostedLogin && (isLoginRequiredError(error) || codes.includes('APP_LOGIN_UNAVAILABLE'))) return {
    kind: 'login', hostedLogin, action: 'check',
    message: '请在平台完成登录，然后重新检查登录状态。',
  }
  const loginMessages: Record<string, string> = {
    APP_LOGIN_REQUIRED: '请先登录平台账户。',
    APP_LOGIN_CANCELLED: '登录已取消，可以再次登录。',
    APP_LOGIN_POPUP_BLOCKED: '浏览器阻止了登录窗口，请允许弹窗后重试。',
    APP_LOGIN_TIMEOUT: '登录超时，请重新登录。',
    APP_LOGIN_NOT_ALLOWED: '当前账户无权使用此应用，请使用有权限的账户登录。',
    APP_LOGIN_FAILED: '登录未完成，请重新登录。',
    APP_LOGIN_STATE_INVALID: '本次登录请求已失效，请重新登录。',
  }
  if (isLoginRequiredError(error)) {
    const code = codes.find(code => LOGIN_REQUIRED_CODES.has(code))!
    return {
      kind: 'login', hostedLogin, action: loginMessages[code] ? 'login' : 'relogin',
      message: loginMessages[code] || '平台授权已失效，请重新登录。',
    }
  }
  return {
    kind: 'connection', hostedLogin, action: 'check',
    message: codes.includes('LOCAL_DEV_RUNTIME_NOT_CONFIGURED')
      ? '本地运行时未就绪，请在设计应用目录使用 npm run dev 启动应用。'
      : codes.includes('APP_APP_REGISTRATION_FAILED')
        ? '开发应用绑定未通过，请检查开发授权与应用配置。'
        : '暂时无法连接平台，请检查网络和平台服务后重试。',
  }
}

/** Separate a silent status check from a user-initiated OAuth login, matching Canvas. */
export async function connectAccount(
  client: AccountClient,
  action: AccountConnectionAction,
): Promise<boolean> {
  if (action !== 'check' && client.auth.loginMode === 'app') {
    // This must be the first await: the SDK opens its popup within the click's
    // user gesture. OAuth already creates the App Session in the owning host.
    await client.auth.login(action === 'relogin' ? { forceLogin: true } : undefined)
  } else {
    await client.platform.createSession()
  }
  const status = await client.auth.status()
  if (!status.authenticated) return false
  if (!status.accountScope || !/^acs_[a-f0-9]{64}$/.test(status.accountScope)) {
    throw Object.assign(new Error('暂时无法确认账户信息'), { code: 'APP_ACCOUNT_SCOPE_UNAVAILABLE' })
  }
  return true
}

export type WorkspaceResource = 'models' | 'history' | 'preferences'

/** A new login may resolve to a different user; old workspace writes must never replay. */
export function assertCanStartAccountLogin(hasAccountContext: boolean): void {
  if (hasAccountContext) {
    throw Object.assign(new Error('账户授权需要重新确认，请重新加载应用恢复连接'), { code: 'APP_AUTH_CHANGED' })
  }
}

/** Only platform authentication errors invalidate the account, not provider permissions. */
export function requiresAccountRecovery(error: unknown, hasAccountContext: boolean): boolean {
  // A failed first login has no previous user's data to isolate. Retrying the
  // button must be possible after a cancelled, blocked or timed-out popup.
  return hasAccountContext && errorCodes(error).some(code =>
    code === 'APP_ACCOUNT_SCOPE_UNAVAILABLE' || code === 'APP_AUTH_CHANGED'
    || code.startsWith('APP_LOGIN_') || LOGIN_REQUIRED_CODES.has(code),
  )
}

/** Resource failures must not invalidate a successfully restored account. */
export async function loadWorkspaceResources<Models, History, Preferences>(loaders: {
  models?: () => Promise<Models>
  history?: () => Promise<History>
  preferences?: () => Promise<Preferences>
}) {
  const [models, history, preferences] = await Promise.allSettled([
    Promise.resolve().then(() => loaders.models?.()),
    Promise.resolve().then(() => loaders.history?.()),
    Promise.resolve().then(() => loaders.preferences?.()),
  ])
  return { models, history, preferences }
}
