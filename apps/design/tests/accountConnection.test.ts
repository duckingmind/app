import assert from 'node:assert/strict'
import test from 'node:test'
import { accountConnectionFailure, assertCanStartAccountLogin, connectAccount, isAccountScopeUnavailableError, isLoginRequiredError, loadWorkspaceResources, requiresAccountRecovery } from '../src/accountConnection.ts'

const scope = 'acs_' + 'a'.repeat(64)

function account(authenticated: boolean, loginMode: 'app' | 'host' = 'app') {
  const calls: string[] = []
  let current = authenticated
  const client = {
    auth: {
      loginMode,
      async status(): Promise<{ authenticated: boolean; accountScope?: string }> {
        calls.push('status')
        return { authenticated: current, ...(current ? { accountScope: scope } : {}) }
      },
      async login(options?: { forceLogin?: boolean }) { calls.push(options?.forceLogin ? 'login:force' : 'login'); current = true },
    },
    platform: { async createSession() { calls.push('session') } },
  }
  return { calls, client }
}

test('startup and rechecking recover the host session and verify the cached account without login', async () => {
  const { calls, client } = account(true)
  assert.equal(await connectAccount(client, 'check'), true)
  assert.equal(await connectAccount(client, 'check'), true)
  assert.deepEqual(calls, ['session', 'status', 'session', 'status'])
})

test('a first visit stays signed out and explicit login starts before any async status check', async () => {
  const { calls, client } = account(false)
  assert.equal(await connectAccount(client, 'check'), false)
  assert.deepEqual(calls, ['session', 'status'])
  calls.length = 0
  const connected = connectAccount(client, 'login')
  assert.deepEqual(calls, ['login'], 'popup opens synchronously in the user gesture')
  assert.equal(await connected, true)
  assert.deepEqual(calls, ['login', 'status'], 'OAuth already creates the App Session; verify its account afterward')
})

test('login completion does not admit an account until the host confirms it is authenticated', async () => {
  const { calls, client } = account(false)
  client.auth.login = async () => { calls.push('login') }
  assert.equal(await connectAccount(client, 'login'), false)
  assert.deepEqual(calls, ['login', 'status'])
})

test('an authenticated account without valid scope is an account failure, not a missing login', async () => {
  for (const accountScope of [undefined, '', 'invalid-scope']) {
    const { calls, client } = account(true)
    client.auth.status = async () => { calls.push('status'); return { authenticated: true, accountScope } }
    for (const action of ['check', 'login'] as const) {
      calls.length = 0
      await assert.rejects(connectAccount(client, action), error => {
        assert.equal(isAccountScopeUnavailableError(error), true)
        assert.equal(isLoginRequiredError(error), false)
        const failure = accountConnectionFailure(error, 'app')
        assert.equal(failure.kind, 'account')
        assert.equal(failure.action, 'relogin')
        assert.doesNotMatch(failure.message, /未登录|尚未.*登录/)
        return true
      })
      assert.deepEqual(calls, action === 'check' ? ['session', 'status'] : ['login', 'status'])
    }
  }
})

test('explicit account recovery starts one forced login and verifies the new account', async () => {
  const { calls, client } = account(true)
  const result = connectAccount(client, 'relogin')
  assert.deepEqual(calls, ['login:force'])
  assert.equal(await result, true)
  assert.deepEqual(calls, ['login:force', 'status'])
})

test('cancelled login and persistent scope failures never trigger another popup automatically', async () => {
  const { calls, client } = account(true)
  const cancelled = Object.assign(new Error('cancelled'), { code: 'APP_LOGIN_CANCELLED' })
  client.auth.login = async () => { calls.push('login'); throw cancelled }
  await assert.rejects(connectAccount(client, 'login'), error => error === cancelled)
  assert.deepEqual(calls, ['login'])
  calls.length = 0
  const scopeFailure = Object.assign(new Error('scope unavailable'), { code: 'APP_ACCOUNT_SCOPE_UNAVAILABLE' })
  client.auth.login = async () => { calls.push('login:force') }
  client.auth.status = async () => { calls.push('status'); throw scopeFailure }
  await assert.rejects(connectAccount(client, 'relogin'), error => error === scopeFailure)
  assert.deepEqual(calls, ['login:force', 'status'])
})

test('session and status outages allow a connection retry without starting login', async () => {
  for (const failedStep of ['session', 'status']) {
    const { calls, client } = account(true)
    const failure = new Error('Failed to fetch')
    if (failedStep === 'session') client.platform.createSession = async () => { calls.push('session'); throw failure }
    else client.auth.status = async () => { calls.push('status'); throw failure }
    await assert.rejects(connectAccount(client, 'check'), error => error === failure)
    assert.deepEqual(calls, failedStep === 'session' ? ['session'] : ['session', 'status'])
    assert.equal(accountConnectionFailure(failure, 'app').action, 'check')
  }
})

test('host-managed sessions always use the host even when the caller requests login', async () => {
  for (const action of ['check', 'login', 'relogin'] as const) {
    const { calls, client } = account(true, 'host')
    assert.equal(await connectAccount(client, action), true)
    assert.deepEqual(calls, ['session', 'status'])
  }
  const { client } = account(false, 'host')
  assert.equal(await connectAccount(client, 'check'), false)
  const failure = accountConnectionFailure({ code: 'APP_LOGIN_UNAVAILABLE' }, 'app')
  assert.equal(failure.hostedLogin, true)
  assert.equal(failure.action, 'check')
})

test('structured OAuth failures have actionable messages and never expose raw callback details', () => {
  for (const [code, action, message] of [
    ['APP_LOGIN_POPUP_BLOCKED', 'login', '允许弹窗'],
    ['APP_LOGIN_CANCELLED', 'login', '取消'],
    ['APP_SESSION_EXPIRED', 'relogin', '授权已失效'],
    ['APP_ACCOUNT_SCOPE_UNAVAILABLE', 'relogin', '账户信息'],
    ['LOCAL_DEV_RUNTIME_NOT_CONFIGURED', 'check', 'npm run dev'],
  ]) {
    const failure = accountConnectionFailure({ code: 'APP_API_ERROR', details: { error: { code, message: 'https://private.test/?token=secret' } } }, 'app')
    assert.equal(failure.action, action)
    assert.ok(failure.message.includes(message))
    assert.doesNotMatch(failure.message, /secret|https:/)
  }
  const hostScope = accountConnectionFailure({ error: { code: 'APP_ACCOUNT_SCOPE_UNAVAILABLE' } }, 'host')
  assert.equal(hostScope.action, 'check')
  assert.equal(hostScope.kind, 'account')
})

test('only explicit platform auth failures require account recovery', () => {
  for (const code of ['APP_ACCOUNT_SCOPE_UNAVAILABLE', 'APP_LOGIN_REQUIRED', 'APP_LOGIN_CANCELLED', 'APP_LOGIN_TIMEOUT', 'APP_AUTH_CHANGED', 'APP_SESSION_EXPIRED', 'APP_SESSION_REVOKED', 'APP_SESSION_REFRESH_UNAVAILABLE']) {
    assert.equal(requiresAccountRecovery({ code }, true), true)
    assert.equal(requiresAccountRecovery({ code: 'APP_API_ERROR', details: { error: { code } } }, true), true)
  }
  for (const error of [
    { status: 403, code: 'forbidden' },
    { status: 401, code: 'UPSTREAM_AUTH_UNAVAILABLE' },
    { status: 502, code: 'APP_AUTH_STATUS_UNAVAILABLE' },
    { status: 503, code: 'APP_API_ERROR' },
    new Error('Failed to fetch'),
  ]) assert.equal(requiresAccountRecovery(error, true), false)
})

test('first login failures can retry without forcing a reload or isolating an unused account', () => {
  for (const code of ['APP_LOGIN_POPUP_BLOCKED', 'APP_LOGIN_CANCELLED', 'APP_LOGIN_TIMEOUT', 'APP_LOGIN_FAILED', 'APP_LOGIN_REQUIRED']) {
    assert.equal(requiresAccountRecovery({ code }, false), false)
  }
})

test('a login callback blocks automatic request replay after a workspace account was established', async () => {
  const calls: string[] = []
  const loginThenReplay = async (hasAccountContext: boolean) => {
    assertCanStartAccountLogin(hasAccountContext)
    calls.push('login')
    calls.push('replay-original-write')
  }
  await assert.rejects(loginThenReplay(true), error => requiresAccountRecovery(error, true))
  assert.deepEqual(calls, [])
  assert.doesNotThrow(() => assertCanStartAccountLogin(false))
  await loginThenReplay(false)
  assert.deepEqual(calls, ['login', 'replay-original-write'])
})

test('model failures preserve the authenticated account and do not stop history or preferences loading', async () => {
  const { client, calls } = account(true)
  const authenticated = await connectAccount(client, 'check')
  const history = [{ id: 'saved-work' }]
  const preferences = { modelId: 'preferred-image-model' }
  const failure = new Error('image catalog unavailable')
  const result = await loadWorkspaceResources({
    models: async () => { throw failure },
    history: async () => history,
    preferences: async () => preferences,
  })
  assert.equal(authenticated, true)
  assert.deepEqual(calls, ['session', 'status'])
  assert.deepEqual(result.models, { status: 'rejected', reason: failure })
  assert.deepEqual(result.history, { status: 'fulfilled', value: history })
  assert.deepEqual(result.preferences, { status: 'fulfilled', value: preferences })
})

test('storage errors remain independent of models and only failed resources need retrying', async () => {
  let modelRequests = 0
  let preferenceRequests = 0
  let historyRequests = 0
  const failure = new Error('storage temporarily unavailable')
  const models = { images: [{ id: 'selected-model' }], text: [] }
  const preferences = { modelId: 'selected-model' }
  const first = await loadWorkspaceResources({
    models: async () => { modelRequests += 1; return models },
    history: async () => { historyRequests += 1; throw failure },
    preferences: async () => { preferenceRequests += 1; return preferences },
  })
  assert.deepEqual(first.models, { status: 'fulfilled', value: models })
  assert.deepEqual(first.history, { status: 'rejected', reason: failure })
  assert.deepEqual(first.preferences, { status: 'fulfilled', value: preferences })
  const retry = await loadWorkspaceResources({ history: async () => { historyRequests += 1; return [{ id: 'restored-work' }] } })
  assert.deepEqual(retry.history, { status: 'fulfilled', value: [{ id: 'restored-work' }] })
  assert.deepEqual(retry.models, { status: 'fulfilled', value: undefined })
  assert.deepEqual(retry.preferences, { status: 'fulfilled', value: undefined })
  assert.deepEqual([modelRequests, historyRequests, preferenceRequests], [1, 2, 1])
})

test('a preference failure does not reject the loaded model list or works', async () => {
  const failure = new Error('preference unavailable')
  const result = await loadWorkspaceResources({
    models: async () => ['image-model'],
    history: async () => [{ id: 'existing-work' }],
    preferences: async () => { throw failure },
  })
  assert.equal(result.models.status, 'fulfilled')
  assert.equal(result.history.status, 'fulfilled')
  assert.deepEqual(result.preferences, { status: 'rejected', reason: failure })
})
