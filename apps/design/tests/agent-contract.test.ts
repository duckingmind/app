import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { createDesignAgent, type DesignAgentHost } from '../src/designAgent.ts'
import { agentMetadata, capabilities, capability } from '../src/agent-tools.mjs'
import { normalizeManifestAgent, validateValue } from '../../../cli/agent-runtime/protocol.mjs'

const manifest = JSON.parse(await readFile(new URL('../manifest.json', import.meta.url), 'utf8'))

test('Design code declares exactly its implemented handlers', () => {
  const bridge = createDesignAgent({} as DesignAgentHost)
  try {
    assert.deepEqual(Object.keys(bridge.handlers).sort(), capabilities.map(entry => entry.name).sort())
    assert.equal(Object.hasOwn(manifest, 'agent'), false)
    normalizeManifestAgent({ ...manifest, agent: { enabled: true, ...agentMetadata, contract_source: 'code', capabilities } })
  } finally { bridge.dispose() }
})

test('Design guide examples remain valid against code-owned capability declarations', async () => {
  const examples = JSON.parse(await readFile(new URL(`../${agentMetadata.examples}`, import.meta.url), 'utf8'))
  for (const example of examples) {
    const declaration = capability(example.capability)
    validateValue(declaration.input_schema, example.input)
    if (example.output) validateValue(declaration.output_schema, example.output)
  }
})
