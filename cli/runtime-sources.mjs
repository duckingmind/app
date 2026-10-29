import { lstat, readdir, readFile } from 'node:fs/promises'
import { extname, join, resolve } from 'node:path'
import { assertSafeArtifactFile } from './artifact-security.mjs'

const MAX_FUNCTION_SOURCE_BYTES = 4 * 1024 * 1024
const MAX_FUNCTION_SOURCE_FILES = 2000

function functionEntries(manifest) {
  const functions = manifest?.functions
  if (!functions || typeof functions !== 'object' || Array.isArray(functions)) return []
  return ['request', 'task']
    .map(kind => functions[kind]?.entry)
    .filter(entry => typeof entry === 'string' && entry.length > 0)
}

// Read the same runtime module files that proxy-app pack uploads. Development
// sends these sources to Admin so Gateway can execute the versioned draft; the
// browser continues to call Gateway and never receives function source.
export async function readLocalFunctionSources(appDir, manifest) {
  const requiredEntries = functionEntries(manifest)
  if (requiredEntries.length === 0) return []

  const root = resolve(appDir)
  const runtimeRoot = join(root, 'runtime')
  const files = []
  let totalBytes = 0

  try {
    const runtimeMetadata = await lstat(runtimeRoot)
    if (runtimeMetadata.isSymbolicLink() || !runtimeMetadata.isDirectory()) {
      throw new Error('runtime function sources must be inside a real runtime/ directory')
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }

  const visit = async (directory, prefix) => {
    let entries
    try {
      entries = await readdir(directory, { withFileTypes: true })
    } catch (error) {
      if (error?.code === 'ENOENT' && directory === runtimeRoot) return
      throw error
    }
    entries.sort((left, right) => left.name.localeCompare(right.name))
    for (const entry of entries) {
      if (entry.name.includes('\\') || entry.name === '.' || entry.name === '..') {
        throw new Error(`invalid runtime source path: ${entry.name}`)
      }
      const relativePath = `${prefix}/${entry.name}`
      const absolutePath = join(directory, entry.name)
      if (entry.isSymbolicLink()) throw new Error(`runtime function sources cannot be symbolic links: ${relativePath}`)
      if (entry.isDirectory()) {
        await visit(absolutePath, relativePath)
        continue
      }
      if (!entry.isFile() || !['.js', '.mjs'].includes(extname(entry.name).toLowerCase())) continue
      if (Buffer.byteLength(relativePath, 'utf8') > 255) throw new Error(`runtime function path is too long: ${relativePath}`)
      if (files.length >= MAX_FUNCTION_SOURCE_FILES) throw new Error('runtime function source contains too many files')
      const metadata = await lstat(absolutePath)
      if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error(`runtime function sources cannot be symbolic links: ${relativePath}`)
      if (metadata.size === 0) throw new Error(`runtime function source is empty: ${relativePath}`)
      totalBytes += metadata.size
      if (totalBytes > MAX_FUNCTION_SOURCE_BYTES) throw new Error('runtime function source exceeds 4 MiB')
      const sourceBytes = await readFile(absolutePath)
      let source
      try {
        source = new TextDecoder('utf-8', { fatal: true }).decode(sourceBytes)
      } catch {
        throw new Error(`runtime function source is not valid UTF-8: ${relativePath}`)
      }
      assertSafeArtifactFile(relativePath, source)
      files.push({ path: relativePath, source })
    }
  }

  await visit(runtimeRoot, 'runtime')
  const available = new Set(files.map(file => file.path))
  for (const entry of requiredEntries) {
    if (!available.has(entry)) throw new Error(`manifest function entry is missing from runtime/: ${entry}`)
  }
  return files
}
