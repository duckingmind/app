import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { agent } from '@ducking-mind/proxy-app-sdk'
import { projectAgentConversation, registerChatAgent } from '../src/chatAgent.ts'
import { agentMetadata, getAgentCapabilities, capability } from '../src/agent-tools.mjs'
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
    const capabilities = getAgentCapabilities()
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

test('Agent message projection excludes request payloads and transient media URLs', () => {
  const conversation = projectAgentConversation({
    id: 'conversation-1', title: '安全检查', createdAt: '2026-10-01', updatedAt: '2026-10-02',
    messages: [{
      id: 'message-1', role: 'assistant' as const, content: 'done', createdAt: '2026-10-02', state: 'complete', mode: 'voice',
      requestContent: { text: 'private request context' },
      media: [{ id: 'asset-1', type: 'audio', assetId: 'stable-asset', url: 'https://cdn.example/signed?token=secret', contentType: 'audio/mpeg' }],
    }],
  })
  assert.deepEqual(conversation.messages[0], {
    id: 'message-1', role: 'assistant', content: 'done', createdAt: '2026-10-02', state: 'complete', mode: 'voice',
    media: [{ id: 'asset-1', type: 'audio', assetId: 'stable-asset', contentType: 'audio/mpeg' }],
  })
})
