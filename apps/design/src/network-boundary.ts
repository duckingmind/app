/**
 * Browser-side resource policy for the Gateway-only Design application.
 *
 * The SDK protects `app.api` and storage calls, but Design also downloads
 * generated images and bundled examples through native `fetch`. Keep those
 * requests from becoming a second route to Admin Runtime or the old bridge.
 */

const ADMIN_HOST_PATTERN = /(?:^|[.-])(?:admin|admin-api|admin-go|codex-admin-api|portal|www)(?:[.-]|$)/i
const ADMIN_PATH_PATTERN = /(?:^|\/)api\/(?:app-runtime|portal|market|admin)(?:\/|$)|(?:^|\/)bridge(?:\/|$)/i
const SIGNATURE_PARAMETER_PATTERN = /^(?:q-signature|q-sign-time|x-cos-security-token|x-amz-signature|x-amz-credential|x-amz-date|x-goog-signature|signature|signkey)$/i

export const DESIGN_NETWORK_BOUNDARY_ERROR = 'DESIGN_NETWORK_BOUNDARY'

let configuredGatewayURL: string | undefined

export function setDesignGatewayURL(value: string | undefined): void {
  configuredGatewayURL = typeof value === 'string' && value.trim() ? value : undefined
}

function boundaryError(message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code: DESIGN_NETWORK_BOUNDARY_ERROR })
}

function absoluteURL(value: string): URL | undefined {
  try {
    const origin = typeof location !== 'undefined' ? location.origin : 'https://design.invalid'
    return new URL(value, `${origin.replace(/\/$/, '')}/`)
  } catch {
    return undefined
  }
}

function gatewayPrefix(value: string | undefined): { origin: string; path: string } | undefined {
  if (!value) return undefined
  const parsed = absoluteURL(value)
  if (!parsed || !/^https?:$/i.test(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) return undefined
  const path = parsed.pathname
  if (path !== '/v1') return undefined
  return { origin: parsed.origin, path }
}

function isPathWithin(pathname: string, prefix: string): boolean {
  return pathname === prefix || pathname.startsWith(`${prefix}/`)
}

function hasMediaSignature(url: URL): boolean {
  for (const key of url.searchParams.keys()) {
    if (SIGNATURE_PARAMETER_PATTERN.test(key)) return true
  }
  return false
}

function isBlockedAdminURL(url: URL): boolean {
  return ADMIN_HOST_PATTERN.test(url.hostname) || ADMIN_PATH_PATTERN.test(url.pathname)
}

/**
 * Validate a URL before a Design-owned browser request.
 *
 * Local `data:`/`blob:` and same-origin application assets stay usable. Once
 * an App Session Gateway is known, remote unsigned URLs are rejected; signed
 * object URLs returned by the Gateway remain valid for media downloads.
 */
export function designNetworkURL(value: string): string {
  if (typeof value !== 'string' || !value.trim()) throw boundaryError('Design resource URL is empty')
  const raw = value.trim()
  if (/^(?:data|blob):/i.test(raw)) return raw
  const relative = !/^[a-z][a-z\d+.-]*:/i.test(raw) && !raw.startsWith('//')
  const parsed = absoluteURL(raw)
  if (!parsed || !/^https?:$/i.test(parsed.protocol) || parsed.username || parsed.password || parsed.hash) {
    throw boundaryError('Design resource URL is not allowed')
  }
  if (isBlockedAdminURL(parsed)) throw boundaryError('Design cannot access the Admin API')

  // Preserve relative paths for callers and tests. They are same-origin by
  // construction; the parsed URL above still applies the Admin path guard.
  if (relative) return raw

  const currentOrigin = typeof location !== 'undefined' ? location.origin : ''
  if (currentOrigin && parsed.origin === currentOrigin) return parsed.href

  const gateway = gatewayPrefix(configuredGatewayURL)
  if (configuredGatewayURL && !gateway) throw boundaryError('Design Gateway URL must use /v1')
  if (gateway && parsed.origin === gateway.origin && isPathWithin(parsed.pathname, gateway.path)) return parsed.href
  if (hasMediaSignature(parsed)) return parsed.href
  if (gateway) throw boundaryError('Design resource must come from the App Session Gateway')

  // Before the host delivers a session, preserve public reference URLs while
  // still rejecting known Admin surfaces above.
  return parsed.href
}

export function fetchDesignResource(value: string, init?: RequestInit): Promise<Response> {
  return fetch(designNetworkURL(value), init)
}
