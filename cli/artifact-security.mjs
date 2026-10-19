import { basename, extname, join } from 'node:path'
import { readdir, readFile } from 'node:fs/promises'

// Keep these release rules aligned with appmarket/artifact_security.go. This is
// a last-line leak check, not a guarantee that arbitrary secrets can be found.
const credentialRules = [
  ['embedded-api-key', /(?:^|[^A-Za-z0-9_-])(sk-(?:(?:proj|svcacct|ant-api\d+)-)?[A-Za-z0-9_-]{32,})/g],
  ['embedded-github-token', /(?:^|[^A-Za-z0-9_])((?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{60,}))/g],
  ['embedded-slack-token', /(?:^|[^A-Za-z0-9_-])(xox[baprs]-[A-Za-z0-9-]{32,})/g],
  ['embedded-session-jwt', /(?:^|[^A-Za-z0-9_-])((?:ast_)?eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{32,})/g],
]

function isPlaceholder(token) {
  const body = token.replace(/^(?:sk-(?:(?:proj|svcacct|ant-api\d+)-)?|gh[pousr]_|github_pat_|xox[baprs]-)/, '')
  return /^(?:x+|X+|0+|your[-_].*|replace[-_].*|example[-_].*|placeholder[-_].*)$/.test(body)
}

export function assertSafeArtifactFile(filePath, data, { allowSourceMaps = false } = {}) {
  const name = basename(filePath.replaceAll('\\', '/')).toLowerCase()
  const reject = rule => { throw new Error(`unsafe app artifact [${rule}]: ${filePath}`) }
  if (name === '.npmrc' || name === '.proxy-app.json' || name === '.env' || name.startsWith('.env.')) {
    throw new Error(`sensitive file cannot be included in app bundle: ${filePath}`)
  }
  if (!allowSourceMaps && name.endsWith('.map')) reject('source-map-file')
  if (['.key', '.p12', '.pfx', '.jks', '.keystore', '.ppk'].includes(extname(name)) || /^(?:id_rsa|id_dsa|id_ecdsa|id_ed25519)$/.test(name)) reject('private-key-file')
  const text = typeof data === 'string' ? data : new TextDecoder().decode(data)
  if (/-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----/.test(text) || /PuTTY-User-Key-File-[23]:/.test(text)) reject('private-key-content')
  if (!allowSourceMaps && /(?:\/\/[@#]|\/\*[@#])\s*sourceMappingURL\s*=\s*\S/.test(text)) reject('source-map-reference')
  for (const [rule, pattern] of credentialRules) {
    pattern.lastIndex = 0
    for (const match of text.matchAll(pattern)) {
      if (!isPlaceholder(match[1])) reject(rule)
    }
  }
}

export async function assertSafeArtifactDirectory(directory, prefix = '') {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const filePath = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.isSymbolicLink()) throw new Error(`symbolic links are not allowed in app bundles: ${filePath}`)
    const absolute = join(directory, entry.name)
    if (entry.isDirectory()) await assertSafeArtifactDirectory(absolute, filePath)
    else assertSafeArtifactFile(filePath, await readFile(absolute))
  }
}
