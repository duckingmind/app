import assert from 'node:assert/strict'
import test from 'node:test'
import { DEFAULT_PLATFORM_URL, platformAPIBaseURL, platformPortalURL } from './platform-settings.mjs'

test('platform defaults target the production site', () => {
  assert.equal(platformAPIBaseURL({}), `${DEFAULT_PLATFORM_URL}/api`)
  assert.equal(platformPortalURL({}), DEFAULT_PLATFORM_URL)
})

test('single-origin and explicit platform overrides are preserved', () => {
  const env = { PROXY_PLATFORM_URL: 'http://localhost:9004' }
  assert.equal(platformAPIBaseURL(env), 'http://localhost:9004/api')
  assert.equal(platformPortalURL(env), 'http://localhost:9004')

  const split = {
    PROXY_PLATFORM_URL: DEFAULT_PLATFORM_URL,
    PROXY_API_BASE_URL: 'http://localhost:9003/api/',
    PROXY_PORTAL_URL: 'http://localhost:9004',
  }
  assert.equal(platformAPIBaseURL(split), 'http://localhost:9003/api')
  assert.equal(platformPortalURL(split), 'http://localhost:9004')
})
