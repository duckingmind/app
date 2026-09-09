import assert from 'node:assert/strict'
import test from 'node:test'
import {
  DEFAULT_PRODUCT_COUNTS,
  prepareProductRequest,
  productCopyPrompt,
  productPlan,
  validateProductRequest,
  type ProductOptions,
} from '../src/productCore.ts'

const options = (): ProductOptions => ({
  photos: [
    {
      id: 'test-product',
      name: 'Test product',
      url: 'data:image/png;base64,AA==',
    },
  ],
  platform: '亚马逊',
  market: '美国',
  language: '英文',
  ratio: '1:1',
  requirements: '橙色耳机，保持外观',
  smart: true,
  counts: { ...DEFAULT_PRODUCT_COUNTS },
  trend: false,
  listing: true,
})

test('custom product output counts respect the minimum and total batch limit', () => {
  const request = options()
  request.smart = false
  request.counts = {
    main: 1,
    scene: 1,
    model: 0,
    details: 1,
    benefits: 1,
    dimensions: 0,
    package: 0,
  }
  assert.match(validateProductRequest(request), /至少需要 7/)
  assert.throws(() => prepareProductRequest(request), /至少需要 7/)
  request.counts = {
    main: 5,
    scene: 5,
    model: 5,
    details: 5,
    benefits: 5,
    dimensions: 0,
    package: 0,
  }
  assert.match(validateProductRequest(request), /最多生成 20/)
})

test('an empty or oversized product reference set cannot create a billable plan', () => {
  const request = options()
  request.photos = []
  assert.throws(() => prepareProductRequest(request), /上传商品图片/)
  request.photos = Array.from({ length: 7 }, (_, index) => ({
    id: String(index),
    name: String(index),
    url: 'blob:sample',
  }))
  assert.throws(() => prepareProductRequest(request), /最多上传 6/)
})

test('smart mode ignores leftover custom counts and generates one consistent product set', () => {
  const request = options()
  request.counts = {
    main: 0,
    scene: 0,
    model: 0,
    details: 0,
    benefits: 0,
    dimensions: 0,
    package: 0,
  }
  const prepared = prepareProductRequest(request)
  assert.equal(prepared.outputs.length, 7)
  assert.equal(new Set(productPlan(request).map((output) => output.id)).size, 7)
  assert.ok(prepared.planningPrompt)
  assert.equal(prepared.planningMode, 'smart')
  assert.ok(prepared.outputs.every((output) => output.type === 'auto'))
  assert.deepEqual(
    prepared.outputs.map((output) => output.id),
    [
      'product-01',
      'product-02',
      'product-03',
      'product-04',
      'product-05',
      'product-06',
      'product-07',
    ],
  )
  assert.match(prepared.planningPrompt, /至少包含1张纯白主图/)
  assert.ok(
    prepared.outputs.every(
      (output) =>
        output.prompt.includes('同一商品') &&
        output.prompt.includes('亚马逊') &&
        output.prompt.includes('英文'),
    ),
  )
})

test('optional text operations are omitted when disabled', () => {
  const request = options()
  request.smart = false
  request.trend = false
  request.listing = false
  const prepared = prepareProductRequest(request)
  assert.equal(prepared.planningPrompt, undefined)
  assert.equal(prepared.listingPrompt, undefined)
  assert.equal(prepared.planningMode, 'fixed')
  assert.deepEqual(
    prepared.outputs.map((job) => job.type),
    ['main', 'scene', 'model', 'details', 'details', 'benefits', 'benefits'],
  )
  request.trend = true
  assert.match(
    prepareProductRequest(request).planningPrompt || '',
    /没有实时销量/,
  )
})

test('writing assistance uses supplied facts and keeps missing specifications explicit', () => {
  const request = options()
  const assistance = productCopyPrompt(request, 'requirements')
  assert.match(assistance, /橙色耳机/)
  assert.match(assistance, /待补充/)
  const listing = productCopyPrompt(request, 'listing')
  assert.match(listing, /用英文/)
  assert.match(listing, /不能把“待补充”当成真实商品属性/)
})
