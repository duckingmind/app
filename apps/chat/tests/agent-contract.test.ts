import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { agent } from '@ducking-mind/proxy-app-sdk'
import { registerChatAgent } from '../src/chatAgent.ts'
import { agentMetadata, capabilities, capability } from '../src/agent-tools.mjs'
import { normalizeManifestAgent, validateValue } from '../../../cli/agent-runtime/protocol.mjs'

const manifest = JSON.parse(await readFile(new URL('../manifest.json', import.meta.url), 'utf8'))

test('Chat registers the complete code-owned contract for every implemented handler', async () => {
  const cleanup = registerChatAgent({
    snapshot: () => ({ ready: true, revision: 'current', models: [], conversations: [], activeConversationId: '', selectedModel: '', generating: false }),
    createConversation: () => { throw new Error('Unexpected write') },
    sendMessage: async () => { throw new Error('Unexpected write') },
    stopGeneration: () => ({ stopped: false }),
  })
  try {
    await agent.ready()
    assert.deepEqual(agent.registered(), capabilities)
    assert.equal(Object.hasOwn(manifest, 'agent'), false)
    normalizeManifestAgent({ ...manifest, agent: { enabled: true, ...agentMetadata, contract_source: 'code', capabilities } })
  } finally { cleanup() }
  assert.deepEqual(agent.registered(), [])
})

test('Chat guide examples remain valid against the same declarations registered by code', async () => {
  const examples = JSON.parse(await readFile(new URL(`../${agentMetadata.examples}`, import.meta.url), 'utf8'))
  for (const example of examples) {
    const declaration = capability(example.capability)
    validateValue(declaration.input_schema, example.input)
    if (example.output) validateValue(declaration.output_schema, example.output)
  }
})
