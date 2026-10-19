// Public repository CI gate. Proprietary desktop checks run only in an
// explicitly authorized internal checkout.
import { readFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const { workspaces } = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
function run(label, args, command = npm) {
  console.log(`\n${label}`)
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' && command === npm })
  if (result.error) throw result.error
  if (result.status !== 0) process.exit(result.status || 1)
}

run('CLI and SDK tests', ['--prefix', 'cli', 'test'])
if (process.env.PROXY_INTERNAL_DESKTOP === '1') {
  run('Internal desktop tests', ['--prefix', 'desktop', 'test'])
}
for (const workspace of workspaces.filter(path => path.startsWith('apps/'))) {
  // The CLI includes declared guides and manifest metadata after the app's build.
  run(`${workspace}: build`, ['cli/proxy-app.mjs', 'build', workspace], process.execPath)
  run(`${workspace}: validate`, ['--prefix', workspace, 'run', 'validate'])
  run(`${workspace}: tests`, ['--prefix', workspace, 'run', 'test', '--if-present'])
}
for (const workspace of ['cli', 'proxy-app-sdk']) {
  run(`${workspace}: package preview`, ['pack', '--dry-run', '--workspace', workspace])
}
