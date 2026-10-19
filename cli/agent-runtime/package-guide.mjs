/** Public Agent guide and example package validation helpers. The private host
 * owns lifecycle, transport, authorization, and release behavior. */

import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, mkdir, open, realpath } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { normalizeManifestAgent, validateValue } from './protocol.mjs'

const MAX_TEXT_BYTES = 64 * 1024
const MAX_PACKAGE_BYTES = 256 * 1024
const hash = value => createHash('sha256').update(value).digest('hex')
const record = value => value && typeof value === 'object' && !Array.isArray(value)
const check = (condition, message) => { if (!condition) throw new Error(`Invalid agent package: ${message}`) }

function packagePath(value, extension) {
  check(typeof value === 'string' && value.length > 0 && value.length <= 256, 'entry must be a relative path')
  check(!value.includes('\\') && !value.includes(':') && !/[\x00-\x1f]/.test(value), `invalid entry: ${value}`)
  const parts = value.split('/')
  check(parts.every(part => part && part !== '.' && part !== '..' && !part.startsWith('.')), `entry escapes package or uses a hidden path: ${value}`)
  check(value.endsWith(extension), `entry must end in ${extension}: ${value}`)
  check(value !== 'manifest.json' && value !== 'package.json', `reserved entry: ${value}`)
  return value
}

function declarations(manifest) {
  const agent = normalizeManifestAgent(manifest)
  if (!agent) return { agent: null, topics: [], examples: null }
  const raw = manifest.agent
  const topics = []
  if (raw.guide !== undefined) {
    check(record(raw.guide), 'guide must be an object')
    topics.push({ id: 'overview', title: 'Overview', entry: packagePath(raw.guide.entry, '.md') })
    check(raw.guide.topics === undefined || Array.isArray(raw.guide.topics), 'guide.topics must be an array')
    check((raw.guide.topics?.length || 0) <= 16, 'guide contains too many topics')
    for (const topic of raw.guide.topics || []) {
      check(record(topic) && typeof topic.id === 'string' && /^[a-z][a-z0-9]*(?:[-_][a-z0-9]+)*$/.test(topic.id) && topic.id.length <= 64, 'invalid guide topic id')
      check(!['api', 'examples'].includes(topic.id) && !topics.some(item => item.id === topic.id), `reserved or duplicate guide topic: ${topic.id}`)
      check(typeof topic.title === 'string' && topic.title.trim() && topic.title.length <= 160, `invalid title for ${topic.id}`)
      topics.push({ id: topic.id, title: topic.title, entry: packagePath(topic.entry, '.md') })
    }
  }
  const examples = raw.examples === undefined ? null : packagePath(raw.examples, '.json')
  const entries = [...topics.map(topic => topic.entry), ...(examples ? [examples] : [])]
  check(new Set(entries).size === entries.length, 'duplicate guide or examples entry')
  for (const entry of entries) check(entry !== 'index.html', `guide cannot replace an application entry: ${entry}`)
  return { agent, topics, examples }
}

async function readPackageFile(root, entry) {
  let path = root
  for (const part of entry.split('/')) {
    path = join(path, part)
    const info = await lstat(path).catch(error => { throw new Error(`Agent package entry is missing or unreadable: ${entry} (${error.code})`) })
    check(!info.isSymbolicLink(), `symbolic links are not allowed: ${entry}`)
  }
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const info = await file.stat()
    check(info.isFile(), `entry is not a regular file: ${entry}`)
    check(info.size <= MAX_TEXT_BYTES, `entry exceeds 64 KiB: ${entry}`)
    const buffer = Buffer.alloc(MAX_TEXT_BYTES + 1)
    let length = 0
    while (length < buffer.length) {
      const { bytesRead } = await file.read(buffer, length, buffer.length - length)
      if (!bytesRead) break
      length += bytesRead
    }
    check(length <= MAX_TEXT_BYTES, `entry exceeds 64 KiB: ${entry}`)
    const bytes = buffer.subarray(0, length)
    let content
    try { content = new TextDecoder('utf-8', { fatal: true }).decode(bytes) } catch { throw new Error(`Invalid UTF-8 agent package entry: ${entry}`) }
    return { bytes, content }
  } finally { await file.close() }
}

async function readAgentPackageWithReader(manifest, readFile) {
  const declared = declarations(manifest)
  if (!declared.agent) return { guide: null, files: [] }
  let total = 0
  const files = []
  const read = async entry => {
    const file = await readFile(entry)
    total += file.bytes.length
    check(total <= MAX_PACKAGE_BYTES, 'guide and examples exceed 256 KiB in total')
    files.push({ entry, ...file })
    return file.content
  }
  const topics = []
  for (const topic of declared.topics) {
    const content = await read(topic.entry)
    topics.push({ id: topic.id, title: topic.title, content, hash: hash(content) })
  }
  const guide = topics.length ? { topics, hash: hash(JSON.stringify(topics.map(({ id, title, hash }) => ({ id, title, hash })))) } : null
  let examples
  if (declared.examples) {
    try { examples = JSON.parse(await read(declared.examples)) } catch (error) { throw new Error(`Invalid agent examples: ${error.message}`) }
    check(Array.isArray(examples) && examples.length <= 128, 'examples must be an array with at most 128 entries')
    for (const [index, example] of examples.entries()) {
      check(record(example) && typeof example.capability === 'string', `examples[${index}] must name a capability`)
      check(Object.keys(example).every(key => ['capability', 'input', 'output'].includes(key)), `examples[${index}] contains an unknown field`)
      const capability = declared.agent.capabilities.find(item => item.name === example.capability)
      check(capability, `examples[${index}] references unknown capability ${example.capability}`)
      try {
        validateValue(capability.input_schema, example.input)
        if (Object.hasOwn(example, 'output')) validateValue(capability.output_schema, example.output)
      } catch (error) { throw new Error(`Invalid agent examples[${index}] (${example.capability}): ${error.message}`) }
    }
  }
  return { guide, ...(examples === undefined ? {} : { examples }), files }
}

async function readAgentPackage(root, manifest) {
  const packageRoot = await realpath(resolve(root))
  return readAgentPackageWithReader(manifest, entry => readPackageFile(packageRoot, entry))
}

/** Read only declared, bounded files from the selected application version. */
export async function loadAgentPackage(root, manifest) {
  const { files, ...data } = await readAgentPackage(root, manifest)
  return data
}

/** Copy a validated snapshot after the bundler has produced a fresh dist. */
export async function copyAgentPackage(source, destination, manifest) {
  const { files, ...data } = await readAgentPackage(source, manifest)
  const root = await realpath(resolve(destination))
  for (const file of files) {
    let directory = root
    for (const part of file.entry.split('/').slice(0, -1)) {
      directory = join(directory, part)
      await mkdir(directory).catch(error => { if (error.code !== 'EEXIST') throw error })
      const info = await lstat(directory)
      check(info.isDirectory() && !info.isSymbolicLink(), `invalid output directory: ${file.entry}`)
    }
    const target = join(root, file.entry)
    const existing = await lstat(target).catch(error => { if (error.code !== 'ENOENT') throw error; return null })
    check(!existing || existing.isFile() && !existing.isSymbolicLink(), `invalid output entry: ${file.entry}`)
    // O_NOFOLLOW also protects the final component if a build process swaps it.
    const handle = await open(target, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW, 0o644)
    try { await handle.writeFile(file.bytes) } finally { await handle.close() }
  }
  return data
}
