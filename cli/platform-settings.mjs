export const DEFAULT_PLATFORM_URL = 'https://www.duckingmind.com'

export function platformAPIBaseURL(env = process.env) {
  const explicit = env.PROXY_API_BASE_URL?.trim()
  if (explicit) return explicit.replace(/\/$/, '')
  const platform = env.PROXY_PLATFORM_URL?.trim() || DEFAULT_PLATFORM_URL
  let url
  try { url = new URL(platform) } catch { throw new Error('PROXY_PLATFORM_URL must be a valid platform origin, such as https://platform.example') }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error('PROXY_PLATFORM_URL must be a platform origin without a path, credentials, query, or hash')
  }
  return `${url.origin}/api`
}

export function platformPortalURL(env = process.env) {
  const explicit = env.PROXY_PORTAL_URL?.trim() || env.PROXY_PUBLIC_URL?.trim()
  if (explicit) return explicit
  return env.PROXY_PLATFORM_URL?.trim() || DEFAULT_PLATFORM_URL
}
