import { access } from 'node:fs/promises'

// These modules are deliberately maintained as public, dependency-free copies.
// They contain the application capability contract and package validation only;
// the proprietary desktop host and its build scripts are never copied into an
// npm package.
for (const file of ['./agent-runtime/protocol.mjs', './agent-runtime/package-guide.mjs']) {
  await access(new URL(file, import.meta.url))
}
await import(new URL('./agent-contract.mjs', import.meta.url))
