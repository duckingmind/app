import assert from 'node:assert/strict'
import test from 'node:test'
import {
  parseReviewContext,
  prepareReviewContext,
  reviewContextKey,
} from '../src/reviewContext.ts'

const PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jqS8AAAAASUVORK5CYII='
const JPEG = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2Q=='
const WEBP =
  'data:image/webp;base64,UklGRhYAAABXRUJQVlA4TAkAAAAvAAAAEAcQERGIiP4HAA=='
const image = { label: '商品原图 PRODUCT', url: PNG }

test('review keys normalize UUID case and reject unsafe or ambiguous identifiers', () => {
  assert.equal(
    reviewContextKey('07AEEA20-02EC-4F76-9F9C-D7B5681F3437'),
    'design:review:07aeea20-02ec-4f76-9f9c-d7b5681f3437',
  )
  for (const id of [
    '',
    '../work',
    'user:work',
    '07aeea2002ec4f769f9cd7b5681f3437',
    ' 07aeea20-02ec-4f76-9f9c-d7b5681f3437',
    '07aeea20-02ec-4f76-9f9c-d7b5681f343g',
  ])
    assert.throws(() => reviewContextKey(id), /作品编号无效/)
})

test('one or two inline previews are restored with separate product and style labels', () => {
  const original = {
    images: [
      { ...image, label: ' 商品原图 PRODUCT ' },
      { label: '风格参考 STYLE', url: JPEG },
    ],
  }
  const restored = parseReviewContext(original)
  assert.equal(restored.images.length, 2)
  assert.equal(restored.images[0].label, '商品原图 PRODUCT')
  assert.equal(restored.images[0].url, PNG)
  assert.equal(restored.images[1].label, '风格参考 STYLE')
  assert.equal(restored.images[1].url, JPEG)
  assert.notEqual(restored.images, original.images)
  assert.equal(
    parseReviewContext({ images: [{ label: '预览', url: WEBP }] }).images[0]
      .url,
    WEBP,
  )
})

test('context parsing rejects absent previews, extra fields and invalid labels', () => {
  for (const context of [
    null,
    [],
    {},
    { images: [] },
    { images: [image, image, image] },
    { images: [image], account: 'another' },
    { images: [{ ...image, generated: true }] },
    { images: [{ ...image, label: '' }] },
    { images: [{ ...image, label: '过长'.repeat(41) }] },
    { images: [{ ...image, label: '多\n行' }] },
    { images: [null] },
  ])
    assert.throws(() => parseReviewContext(context))
})

test('context parsing rejects remote, executable, wrong MIME and corrupt base64 payloads', () => {
  for (const url of [
    'https://example.test/photo.png',
    'blob:example',
    'javascript:alert(1)',
    'data:image/svg+xml;base64,PHN2Zy8+',
    'data:image/gif;base64,R0lGODlh',
    'data:image/png;base64,',
    'data:image/png;base64,AAAA',
    'data:image/jpeg;base64,not an image',
    PNG.replace('image/png', 'image/jpeg'),
    PNG + '\n',
  ])
    assert.throws(
      () => parseReviewContext({ images: [{ ...image, url }] }),
      /内联|大小/,
    )
})

test('each preview is capped before it can exceed the Bridge storage budget', () => {
  const maximum = 'data:image/jpeg;base64,' + '/9j/' + 'A'.repeat(79972)
  const context = parseReviewContext({
    images: [
      { ...image, url: maximum },
      { label: '风格参考 STYLE', url: maximum },
    ],
  })
  assert.ok(
    new TextEncoder().encode(JSON.stringify(context)).byteLength <= 180000,
  )
  assert.throws(
    () => parseReviewContext({ images: [{ ...image, url: maximum + 'AAAA' }] }),
    /大小超过/,
  )
})

test('preparing a review rejects absent or excessive source groups before using browser canvas', async () => {
  await assert.rejects(prepareReviewContext([], []), /缺少可用于复检/)
  const photo = { id: 'product', name: '商品', url: PNG }
  await assert.rejects(
    prepareReviewContext(
      Array.from({ length: 7 }, () => photo),
      [],
    ),
    /最多支持/,
  )
  await assert.rejects(
    prepareReviewContext(
      [],
      Array.from({ length: 21 }, () => photo),
    ),
    /最多支持/,
  )
})
