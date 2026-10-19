export const agentMetadata = Object.freeze({
  "namespace": "pelican",
  "targets": [
    "web"
  ],
  "contract_version": "1.0.0",
  "summary": "读取鹈鹕画室状态、自定义 SVG 插画并将当前作品保存到本机收藏。",
  "keywords": [
    "pelican",
    "鹈鹕",
    "插画",
    "SVG",
    "自行车"
  ],
  "guide": {
    "entry": "agent/guide.md",
    "topics": [
      {
        "id": "workflow",
        "title": "创作流程",
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

// This application code owns the capability contract.
// The build writes its catalog into the packaged manifest.
export const capabilities = Object.freeze([
  {
    "name": "read_metadata",
    "title": "读取应用元数据",
    "description": "读取应用的标识、名称和版本。",
    "access": "read",
    "idempotent": true,
    "targets": [
      "web"
    ],
    "input_schema": {
      "type": "object",
      "properties": {},
      "required": [],
      "additionalProperties": false
    },
    "output_schema": {
      "type": "object",
      "properties": {
        "appId": {
          "type": "string"
        },
        "version": {
          "type": "string"
        },
        "name": {
          "type": "string"
        }
      },
      "required": [
        "appId",
        "version",
        "name"
      ],
      "additionalProperties": false
    },
    "destructive": false,
    "completion": "completed"
  },
  {
    "name": "read_studio",
    "title": "读取画室状态",
    "description": "读取当前插画标题、完整设置、收藏数量和 revision。每次写入之前重新读取。",
    "access": "read",
    "idempotent": true,
    "targets": [
      "web"
    ],
    "input_schema": {
      "type": "object",
      "properties": {},
      "required": [],
      "additionalProperties": false
    },
    "output_schema": {
      "type": "object",
      "properties": {
        "revision": {
          "type": "string",
          "minLength": 1,
          "maxLength": 128
        },
        "title": {
          "type": "string",
          "maxLength": 40
        },
        "settings": {
          "type": "object",
          "properties": {
            "scene": {
              "type": "string",
              "enum": [
                "coast",
                "meadow",
                "sunset"
              ]
            },
            "palette": {
              "type": "string",
              "enum": [
                "teal",
                "coral",
                "mustard",
                "lavender"
              ]
            },
            "wing": {
              "type": "string",
              "enum": [
                "light",
                "dark"
              ]
            },
            "lineWeight": {
              "type": "number",
              "minimum": 1.5,
              "maximum": 4
            },
            "decorations": {
              "type": "boolean"
            },
            "variant": {
              "type": "integer",
              "minimum": 0,
              "maximum": 99
            }
          },
          "additionalProperties": false,
          "required": [
            "scene",
            "palette",
            "wing",
            "lineWeight",
            "decorations",
            "variant"
          ]
        },
        "savedCount": {
          "type": "integer",
          "minimum": 0
        }
      },
      "required": [
        "revision",
        "title",
        "settings",
        "savedCount"
      ],
      "additionalProperties": false
    },
    "destructive": false,
    "completion": "completed"
  },
  {
    "name": "update_studio",
    "title": "修改插画",
    "description": "局部修改标题和插画设置，立即更新画室。至少提供标题或一项设置。",
    "access": "write",
    "idempotent": true,
    "targets": [
      "web"
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
        "title": {
          "type": "string",
          "maxLength": 40
        },
        "settings": {
          "type": "object",
          "properties": {
            "scene": {
              "type": "string",
              "enum": [
                "coast",
                "meadow",
                "sunset"
              ]
            },
            "palette": {
              "type": "string",
              "enum": [
                "teal",
                "coral",
                "mustard",
                "lavender"
              ]
            },
            "wing": {
              "type": "string",
              "enum": [
                "light",
                "dark"
              ]
            },
            "lineWeight": {
              "type": "number",
              "minimum": 1.5,
              "maximum": 4
            },
            "decorations": {
              "type": "boolean"
            },
            "variant": {
              "type": "integer",
              "minimum": 0,
              "maximum": 99
            }
          },
          "additionalProperties": false
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
      "properties": {
        "revision": {
          "type": "string",
          "minLength": 1,
          "maxLength": 128
        },
        "title": {
          "type": "string",
          "maxLength": 40
        },
        "settings": {
          "type": "object",
          "properties": {
            "scene": {
              "type": "string",
              "enum": [
                "coast",
                "meadow",
                "sunset"
              ]
            },
            "palette": {
              "type": "string",
              "enum": [
                "teal",
                "coral",
                "mustard",
                "lavender"
              ]
            },
            "wing": {
              "type": "string",
              "enum": [
                "light",
                "dark"
              ]
            },
            "lineWeight": {
              "type": "number",
              "minimum": 1.5,
              "maximum": 4
            },
            "decorations": {
              "type": "boolean"
            },
            "variant": {
              "type": "integer",
              "minimum": 0,
              "maximum": 99
            }
          },
          "additionalProperties": false,
          "required": [
            "scene",
            "palette",
            "wing",
            "lineWeight",
            "decorations",
            "variant"
          ]
        },
        "savedCount": {
          "type": "integer",
          "minimum": 0
        }
      },
      "required": [
        "revision",
        "title",
        "settings",
        "savedCount"
      ],
      "additionalProperties": false
    },
    "destructive": true,
    "completion": "completed"
  },
  {
    "name": "save_artwork",
    "title": "收藏当前作品",
    "description": "将当前插画保存到本机收藏。",
    "access": "write",
    "idempotent": true,
    "targets": [
      "web"
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
      "properties": {
        "id": {
          "type": "string"
        },
        "title": {
          "type": "string",
          "maxLength": 40
        },
        "revision": {
          "type": "string",
          "minLength": 1,
          "maxLength": 128
        }
      },
      "required": [
        "id",
        "title",
        "revision"
      ],
      "additionalProperties": false
    },
    "destructive": true,
    "completion": "completed"
  }
])

export function capability(name) {
  const declaration = capabilities.find((item) => item.name === name)
  if (!declaration) throw new Error(`Unknown pelican agent capability: ${name}`)
  return declaration
}
