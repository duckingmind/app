import assert from 'node:assert/strict'
import test from 'node:test'
import { createPhotoCollection } from '../src/photoCollection.ts'
import type { Photo } from '../src/images.ts'

function file(name: string) {
  return new File([name], name, { type: 'image/png', lastModified: 1 })
}

function photo(input: File): Photo {
  return { id: input.name, name: input.name, url: `blob:${input.name}`, file: input }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

function setup(readPhoto: (input: File) => Promise<Photo> = async (input) => photo(input), limit = 6) {
  const revoked: string[] = []
  const errors: string[] = []
  const collection = createPhotoCollection({
    limit,
    readPhoto,
    revokeObjectURL: (url) => revoked.push(url),
    onError: (message) => errors.push(message),
  })
  const unmount = collection.mount()
  return { collection, revoked, errors, unmount }
}

test('remove, replace and reset release only uploaded object URLs once', async () => {
  const { collection, revoked } = setup()
  await collection.add([file('a'), file('b')])
  collection.remove('a')
  assert.deepEqual(revoked, ['blob:a'])
  const remote = { id: 'remote', name: 'remote', url: 'https://example.test/photo.png' }
  const borrowed = { id: 'borrowed', name: 'borrowed', url: 'blob:caller-owned' }
  collection.setPhotos((current) => [...current, remote, borrowed])
  assert.deepEqual(revoked, ['blob:a'])
  collection.setPhotos([remote, borrowed])
  assert.deepEqual(revoked, ['blob:a', 'blob:b'])
  collection.clear()
  collection.remove('b')
  assert.deepEqual(collection.getSnapshot(), { photos: [], loading: false })
  assert.deepEqual(revoked, ['blob:a', 'blob:b'])
})

test('replacing with an example cancels upload results and preserves the example', async () => {
  const pending = deferred<Photo>()
  const { collection, revoked, errors } = setup(() => pending.promise)
  const upload = collection.add([file('upload')])
  const example = { id: 'example', name: 'example', url: '/example.webp' }
  collection.setPhotos([example])
  pending.resolve(photo(file('upload')))
  assert.deepEqual(await upload, [])
  assert.deepEqual(collection.getSnapshot(), { photos: [example], loading: false })
  assert.deepEqual(revoked, ['blob:upload'])
  assert.deepEqual(errors, [])
})

test('reset releases partially decoded batches immediately and ignores the late result', async () => {
  const second = deferred<Photo>()
  const secondStarted = deferred<void>()
  const read: string[] = []
  const { collection, revoked } = setup(async (input) => {
    read.push(input.name)
    if (input.name === 'b') {
      secondStarted.resolve()
      return second.promise
    }
    return photo(input)
  })
  const upload = collection.add([file('a'), file('b'), file('c')])
  await secondStarted.promise
  collection.clear()
  assert.deepEqual(revoked, ['blob:a'])
  second.resolve(photo(file('b')))
  assert.deepEqual(await upload, [])
  assert.deepEqual(revoked, ['blob:a', 'blob:b'])
  assert.deepEqual(read, ['a', 'b'])
  assert.deepEqual(collection.getSnapshot(), { photos: [], loading: false })
})

test('a cancelled upload cannot clear a newer upload loading state or report stale errors', async () => {
  const old = deferred<Photo>()
  const next = deferred<Photo>()
  const { collection, revoked, errors } = setup((input) => input.name === 'old' ? old.promise : next.promise)
  const previousUpload = collection.add([file('old')])
  collection.clear()
  const nextUpload = collection.add([file('new')])
  old.reject(new Error('obsolete read failed'))
  await previousUpload
  assert.equal(collection.getSnapshot().loading, true)
  assert.deepEqual(errors, [])
  next.resolve(photo(file('new')))
  assert.deepEqual((await nextUpload).map((item) => item.id), ['new'])
  assert.equal(collection.getSnapshot().loading, false)
  assert.deepEqual(revoked, [])
})

test('a failed batch leaves existing photos intact and releases partial results', async () => {
  const { collection, revoked, errors } = setup(async (input) => {
    if (input.name === 'bad') throw new Error('invalid image')
    return photo(input)
  })
  await collection.add([file('kept')])
  assert.deepEqual(await collection.add([file('partial'), file('bad')]), [])
  assert.deepEqual(collection.getSnapshot().photos.map((item) => item.id), ['kept'])
  assert.equal(collection.getSnapshot().loading, false)
  assert.deepEqual(revoked, ['blob:partial'])
  assert.deepEqual(errors, ['invalid image'])
})

test('deduplicates files before checking capacity and guards concurrent and replacement writes', async () => {
  const first = deferred<Photo>()
  const reads: string[] = []
  const { collection, errors } = setup((input) => {
    reads.push(input.name)
    return input.name === 'a' ? first.promise : Promise.resolve(photo(input))
  }, 2)
  const initial = collection.add([file('a'), file('a')])
  assert.deepEqual(await collection.add([file('b')]), [])
  first.resolve(photo(file('a')))
  await initial
  assert.deepEqual(reads, ['a'])
  await collection.add([file('a'), file('b')])
  assert.deepEqual(reads, ['a', 'b'])
  assert.deepEqual(await collection.add([file('c')]), [])
  collection.setPhotos([photo(file('x')), photo(file('y')), photo(file('z'))])
  assert.deepEqual(collection.getSnapshot().photos.map((item) => item.id), ['a', 'b'])
  assert.equal(errors.length, 2)
  assert.ok(errors.every((message) => message.includes('最多上传 2 张图片')))
})

test('completion deduplicates colliding decoded photo IDs and releases discarded URLs', async () => {
  const { collection, revoked } = setup(async (input) => ({ ...photo(input), id: 'same-id' }))
  const accepted = await collection.add([file('a'), file('b')])
  assert.equal(accepted.length, 1)
  assert.equal(collection.getSnapshot().photos[0].url, 'blob:a')
  assert.deepEqual(revoked, ['blob:b'])
})

test('StrictMode effect replay preserves live URLs and the remounted collection accepts uploads', async () => {
  const { collection, revoked, unmount } = setup()
  await collection.add([file('kept')])
  unmount()
  const finalUnmount = collection.mount()
  await Promise.resolve()
  assert.deepEqual(revoked, [])
  await collection.add([file('next')])
  assert.deepEqual(collection.getSnapshot().photos.map((item) => item.id), ['kept', 'next'])
  finalUnmount()
  await Promise.resolve()
  assert.deepEqual(revoked, ['blob:kept', 'blob:next'])
})

test('unmount frees displayed and late upload URLs without publishing a late error', async () => {
  const late = deferred<Photo>()
  const { collection, revoked, errors, unmount } = setup((input) => input.name === 'late' ? late.promise : Promise.resolve(photo(input)))
  await collection.add([file('kept')])
  const upload = collection.add([file('late')])
  unmount()
  await Promise.resolve()
  assert.deepEqual(revoked, ['blob:kept'])
  late.resolve(photo(file('late')))
  assert.deepEqual(await upload, [])
  assert.deepEqual(revoked, ['blob:kept', 'blob:late'])
  assert.deepEqual(collection.getSnapshot(), { photos: [], loading: false })
  assert.deepEqual(await collection.add([file('ignored')]), [])
  assert.deepEqual(errors, [])
})
