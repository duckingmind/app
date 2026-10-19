import assert from 'node:assert/strict'
import test from 'node:test'
import { DESIGN_NETWORK_BOUNDARY_ERROR, designNetworkURL, setDesignGatewayURL } from '../src/network-boundary.ts'

const origin = 'https://design.example.test'

function withLocation<T>(fn: () => T): T {
  const previous = globalThis.location
  Object.defineProperty(globalThis, 'location', { configurable: true, value: { origin } })
  try { return fn() } finally {
    if (previous === undefined) delete (globalThis as { location?: Location }).location
    else Object.defineProperty(globalThis, 'location', { configurable: true, value: previous })
  }
}

test('Design native resources stay on the Gateway and cannot reach Admin surfaces', () => withLocation(() => {
  setDesignGatewayURL('https://api.duckingmind.com/v1')
  assert.equal(designNetworkURL('https://api.duckingmind.com/v1/images/tasks/task-1'), 'https://api.duckingmind.com/v1/images/tasks/task-1')
  assert.equal(designNetworkURL('/src/assets/model.webp'), '/src/assets/model.webp')
  assert.equal(designNetworkURL('https://cdn.example.test/result.webp?X-Amz-Signature=abc'), 'https://cdn.example.test/result.webp?X-Amz-Signature=abc')
  for (const value of [
    'https://admin-go.example.test/v1/models',
    'https://api.duckingmind.com/api/app-runtime/v1/storage/items',
    'https://api.duckingmind.com/bridge',
    'https://other.example.test/v1/models',
  ]) {
    assert.throws(() => designNetworkURL(value), (error: unknown) => (error as { code?: string }).code === DESIGN_NETWORK_BOUNDARY_ERROR)
  }
  setDesignGatewayURL(undefined)
}))

test('Design allows public references before an App Session is established but still blocks Admin', () => withLocation(() => {
  setDesignGatewayURL(undefined)
  assert.equal(designNetworkURL('https://images.example.test/reference.webp'), 'https://images.example.test/reference.webp')
  assert.throws(() => designNetworkURL('https://admin-go.example.test/reference.webp'), { code: DESIGN_NETWORK_BOUNDARY_ERROR })
}))
