export const agentMetadata = Object.freeze({
  "namespace": "chat",
  "targets": [
    "web",
    "desktop"
  ],
  "guide": {
    "entry": "agent/guide.md",
    "topics": [
      {
        "id": "workflow",
        "title": "调用流程",
        "entry": "agent/workflow.md"
      },
      {
        "id": "recovery",
        "title": "恢复与重试",
        "entry": "agent/recovery.md"
      }
    ]
  },
  "examples": "agent/examples.json"
})

/**
 * The registration function is the only source of the MCP contract.
 * The collector path builds the offline catalog; the runtime path binds handlers.
 */
export function registerAgentTools(registry, handlers) {
  if (!registry || typeof registry.register !== 'function') throw new TypeError('agent registry must expose register()')
  const collectOnly = handlers === undefined
  if (!collectOnly && (!handlers || typeof handlers !== 'object' || Array.isArray(handlers))) throw new TypeError('agent handlers must be an object')
  const known = new Set()
  const disposers = []
  const cleanup = () => {
    for (const dispose of disposers.splice(0).reverse()) { try { dispose() } catch { /* Continue cleanup. */ } }
  }
  const register = declaration => {
    try {
      known.add(declaration.name)
      const handler = collectOnly ? undefined : handlers[declaration.name]
      if (!collectOnly && typeof handler !== 'function') throw new Error('Missing agent capability handler: ' + declaration.name)
      const dispose = collectOnly ? registry.register(declaration) : registry.register(declaration, handler)
      if (typeof dispose === 'function') disposers.push(dispose)
    } catch (error) { cleanup(); throw error }
  }
  register({
    "name": "read_conversations",
    "title": "读取会话列表",
    "description": "读取会话列表",
    "access": "read",
    "targets": [
      "web",
      "desktop"
    ],
    "input_schema": {
      "type": "object",
      "properties": {
        "offset": {
          "type": "integer",
          "minimum": 0,
          "maximum": 10000
        },
        "limit": {
          "type": "integer",
          "minimum": 1,
          "maximum": 50
        }
      },
      "additionalProperties": false
    },
    "output_schema": {
      "type": "object",
      "additionalProperties": true
    }
  })
  register({
    "name": "read_messages",
    "title": "读取会话消息",
    "description": "读取会话消息",
    "access": "read",
    "targets": [
      "web",
      "desktop"
    ],
    "input_schema": {
      "type": "object",
      "properties": {
        "conversation_id": {
          "type": "string",
          "minLength": 1,
          "maxLength": 128
        },
        "offset": {
          "type": "integer",
          "minimum": 0,
          "maximum": 10000
        },
        "limit": {
          "type": "integer",
          "minimum": 1,
          "maximum": 50
        }
      },
      "required": [
        "conversation_id"
      ],
      "additionalProperties": false
    },
    "output_schema": {
      "type": "object",
      "additionalProperties": true
    }
  })
  register({
    "name": "list_models",
    "title": "读取可用文本模型",
    "description": "读取可用文本模型",
    "access": "read",
    "targets": [
      "web",
      "desktop"
    ],
    "input_schema": {
      "type": "object",
      "additionalProperties": false
    },
    "output_schema": {
      "type": "object",
      "additionalProperties": true
    }
  })
  register({
    "name": "create_conversation",
    "title": "创建会话",
    "description": "创建会话",
    "access": "write",
    "targets": [
      "web",
      "desktop"
    ],
    "input_schema": {
      "type": "object",
      "properties": {
        "idempotency_key": {
          "type": "string",
          "minLength": 8,
          "maxLength": 128
        },
        "expected_revision": {
          "type": "string",
          "minLength": 1,
          "maxLength": 128
        },
        "model": {
          "type": "string",
          "maxLength": 200
        }
      },
      "required": [
        "idempotency_key",
        "expected_revision"
      ],
      "additionalProperties": false
    },
    "output_schema": {
      "type": "object",
      "additionalProperties": true
    },
    "idempotent": true
  })
  register({
    "name": "send_message",
    "title": "发送消息并等待回复",
    "description": "发送消息并等待回复",
    "access": "write",
    "targets": [
      "web",
      "desktop"
    ],
    "input_schema": {
      "type": "object",
      "properties": {
        "idempotency_key": {
          "type": "string",
          "minLength": 8,
          "maxLength": 128
        },
        "expected_revision": {
          "type": "string",
          "minLength": 1,
          "maxLength": 128
        },
        "conversation_id": {
          "type": "string",
          "minLength": 1,
          "maxLength": 128
        },
        "content": {
          "type": "string",
          "minLength": 1,
          "maxLength": 24000
        },
        "model": {
          "type": "string",
          "maxLength": 200
        }
      },
      "required": [
        "idempotency_key",
        "expected_revision",
        "conversation_id",
        "content"
      ],
      "additionalProperties": false
    },
    "output_schema": {
      "type": "object",
      "additionalProperties": true
    },
    "idempotent": true,
    "completion": "completed"
  })
  register({
    "name": "stop_generation",
    "title": "停止当前回复生成",
    "description": "停止当前回复生成",
    "access": "write",
    "targets": [
      "web",
      "desktop"
    ],
    "input_schema": {
      "type": "object",
      "properties": {
        "idempotency_key": {
          "type": "string",
          "minLength": 8,
          "maxLength": 128
        },
        "expected_revision": {
          "type": "string",
          "minLength": 1,
          "maxLength": 128
        }
      },
      "required": [
        "idempotency_key",
        "expected_revision"
      ],
      "additionalProperties": false
    },
    "output_schema": {
      "type": "object",
      "additionalProperties": true
    },
    "idempotent": true
  })
  for (const name of Object.keys(handlers || {})) if (!known.has(name)) { cleanup(); throw new Error('Unknown agent capability handler: ' + name) }
  return disposers
}

/** Collect declarations through the same registration path used at runtime. */
export function getAgentCapabilities() {
  const collected = []
  registerAgentTools({ register(declaration) { collected.push(structuredClone(declaration)); return () => {} } })
  return collected
}

export function capability(name) {
  const declaration = getAgentCapabilities().find(item => item.name === name)
  if (!declaration) throw new Error('Unknown agent capability: ' + name)
  return declaration
}
