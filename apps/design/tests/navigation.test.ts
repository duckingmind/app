import assert from 'node:assert/strict'
import test from 'node:test'
import { designRouteURL, readDesignRoute, sameDesignRoute } from '../src/navigation.ts'

test('navigation reads supported module and works routes and falls back safely', () => {
  assert.deepEqual(readDesignRoute({ search: '?module=clone&view=works' }), { module: 'clone', view: 'works' })
  assert.deepEqual(readDesignRoute({ search: '?module=unknown&view=bad' }), { module: 'product', view: 'studio' })
})

test('navigation URL keeps unrelated host parameters while removing default route values', () => {
  const current = new URL('http://127.0.0.1:5175/?app=design&module=detail&view=works')
  assert.equal(
    designRouteURL({ module: 'product', view: 'studio' }, current).search,
    '?app=design',
  )
  assert.equal(
    designRouteURL({ module: 'detail', view: 'works' }, current).search,
    '?app=design&module=detail&view=works',
  )
})

test('navigation compares only the app route fields', () => {
  assert.equal(sameDesignRoute({ module: 'product', view: 'studio' }, { module: 'product', view: 'studio' }), true)
  assert.equal(sameDesignRoute({ module: 'product', view: 'studio' }, { module: 'product', view: 'works' }), false)
})
