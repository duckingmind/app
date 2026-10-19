#!/usr/bin/env node

import { spawn } from 'node:child_process'
import { lstat, mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'

const runtimeDirectory = './agent-runtime/'
const { normalizeCapabilityDeclaration, normalizeManifestAgent } = await import(new URL(`${runtimeDirectory}protocol.mjs`, import.meta.url))
const { copyAgentPackage } = await import(new URL(`${runtimeDirectory}package-guide.mjs`, import.meta.url))

const AGENT_ENTRY_RE = /^[^/\\][^/\\]*\.(?:mjs|js|cjs)$/

const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value)

async function assertSafeEntry(root, entry) {
  if (typeof entry !== 'string' || !entry || entry.length > 256 || entry.includes('\\') || entry.split('/').some(part => !part || part === '.' || part === '..' || part.startsWith('.'))) {
    throw new Error('agent contract source must be a visible relative source path')
  }
  if (!AGENT_ENTRY_RE.test(entry.split('/').at(-1))) throw new Error('agent contract source must point to a JavaScript module')
  const projectRoot = resolve(root)
  const target = resolve(projectRoot, entry)
  const prefix = `${projectRoot}${sep}`
  if (!target.startsWith(prefix)) throw new Error('agent contract source escapes the application project')
  let current = projectRoot
  for (const part of entry.split('/')) {
    current = resolve(current, part)
    const info = await lstat(current).catch(error => { throw new Error(`agent contract source is missing or unreadable: ${entry} (${error.code})`) })
    if (info.isSymbolicLink()) throw new Error(`agent contract source cannot use a symbolic link: ${entry}`)
  }
  const info = await lstat(target)
  if (!info.isFile()) throw new Error('agent contract source must be a regular file')
  return target
}

// Use a fresh process so editing a shared contract dependency cannot leave
// the build validating Node's cached version. The child receives a path only
// after it has passed the project-local source checks above.
async function loadContract(target) {
  const worker = `import { writeFileSync } from 'node:fs';\nconst module = await import(process.argv[1]);\nwriteFileSync(3, JSON.stringify({ agentMetadata: module.agentMetadata, capabilities: module.capabilities }));\nprocess.exit(0);`
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', worker, pathToFileURL(target).href], { stdio: ['ignore', 'ignore', 'pipe', 'pipe'] })
    const output = [], errors = []
    let outputBytes = 0, errorBytes = 0, failure
    const timer = setTimeout(() => { failure = new Error('agent contract source exceeded the 15 second contract loading limit'); child.kill('SIGKILL') }, 15000)
    child.stdio[3].on('data', chunk => {
      outputBytes += chunk.length
      if (outputBytes > 8 * 1024 * 1024) { failure = new Error('agent contract source exported an oversized capability contract'); child.kill('SIGKILL'); return }
      output.push(chunk)
    })
    child.stderr.on('data', chunk => { if (errorBytes < 2048) errors.push(chunk); errorBytes += chunk.length })
    child.on('error', error => { clearTimeout(timer); reject(error) })
    child.on('close', code => {
      clearTimeout(timer)
      if (failure) return reject(failure)
      if (code !== 0) return reject(new Error(`cannot load agent contract source: ${Buffer.concat(errors).toString().slice(0, 2048).trim() || `process exited with ${code}`}`))
      try { resolvePromise(JSON.parse(Buffer.concat(output).toString())) }
      catch { reject(new Error('src/agent-tools.mjs must export JSON-serializable agentMetadata and capabilities')) }
    })
  })
}

/**
 * Resolve the code-owned Agent contract for a local source project.
 * `src/agent-tools.mjs` is discovered by convention; source manifests never
 * opt into or enumerate Agent capabilities. Installed packages carry the
 * generated contract so MCP can discover tools before launching the app.
 */
export async function resolveAgentContract(root, manifest) {
  if (!isRecord(manifest)) throw new TypeError('manifest must be an object')
  const rawAgent = manifest.agent
  if (rawAgent !== undefined && !isRecord(rawAgent)) throw new TypeError('manifest.agent must be an object')
  if (rawAgent !== undefined) throw new Error('source manifest must not contain manifest.agent; MCP is discovered from src/agent-tools.mjs')
  const entry = 'src/agent-tools.mjs'
  let target
  try { target = await assertSafeEntry(root, entry) }
  catch (error) {
    if (error.message.includes('(ENOENT)')) return manifest
    throw error
  }
  const { agentMetadata, capabilities } = await loadContract(target)
  if (!Array.isArray(capabilities) || capabilities.length > 64) throw new Error('src/agent-tools.mjs must export capabilities as an array with at most 64 entries')
  if (!isRecord(agentMetadata)) throw new Error('src/agent-tools.mjs must export agentMetadata as an object')
  const allowedMetadata = new Set(['namespace', 'targets', 'contract_version', 'summary', 'keywords', 'guide', 'examples'])
  for (const key of Object.keys(agentMetadata)) if (!allowedMetadata.has(key)) throw new Error(`unsupported agentMetadata field: ${key}`)
  const normalized = capabilities.map(capability => {
    if (!isRecord(capability)) throw new TypeError('agent capability must be an object')
    for (const field of ['access', 'input_schema', 'output_schema']) {
      if (!Object.hasOwn(capability, field)) throw new Error(`code capability ${capability.name || '(unnamed)'} must explicitly declare ${field}`)
    }
    return normalizeCapabilityDeclaration(capability, { defaultTargets: agentMetadata.targets || ['desktop'] })
  })
  const names = new Set()
  for (const capability of normalized) {
    if (names.has(capability.name)) throw new Error(`duplicate agent capability: ${capability.name}`)
    names.add(capability.name)
  }
  const effective = structuredClone(manifest)
  effective.agent = { enabled: true, ...agentMetadata, contract_source: 'code', capabilities: normalized }
  normalizeManifestAgent(effective)
  return effective
}

/** Build helper for projects whose bundler is invoked directly. */
export async function writeAgentContract(root, destination) {
  const projectRoot = resolve(root)
  const source = JSON.parse(await readFile(resolve(projectRoot, 'manifest.json'), 'utf8'))
  const manifest = await resolveAgentContract(projectRoot, source)
  const output = resolve(projectRoot, destination)
  await mkdir(output, { recursive: true })
  await copyAgentPackage(projectRoot, output, manifest)
  await writeFile(resolve(output, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  return manifest
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const [, , root = '.', destination = 'dist'] = process.argv
    await writeAgentContract(root, destination)
  } catch (error) {
    console.error(`proxy agent contract: ${error.message}`)
    process.exitCode = 1
  }
}

