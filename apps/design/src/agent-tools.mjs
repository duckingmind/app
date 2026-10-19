export const agentMetadata = Object.freeze({
  "namespace": "design",
  "targets": [
    "web",
    "desktop"
  ],
  "contract_version": "1.0.0",
  "summary": "通过结构化配置创建商品套图、A+详情、服饰试穿和风格复刻，并查询和读取作品。",
  "keywords": [
    "商品套图",
    "A+详情",
    "虚拟试穿",
    "爆款复刻"
  ],
  "guide": {
    "entry": "agent/guide.md",
    "topics": [
      {
        "id": "workflow",
        "title": "创作工作流",
        "entry": "agent/workflow.md"
      },
      {
        "id": "recovery",
        "title": "恢复与结果读取",
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
    "name": "read_configuration",
    "description": "读取当前设计应用的登录状态、模型、素材、配置和版本。",
    "access": "read",
    "idempotent": true,
    "input_schema": {
      "type": "object",
      "additionalProperties": false
    },
    "output_schema": {
      "type": "object",
      "additionalProperties": true
    }
  },
  {
    "name": "list_models",
    "description": "读取当前账号可用的图片和文案模型及支持的操作。",
    "access": "read",
    "idempotent": true,
    "input_schema": {
      "type": "object",
      "additionalProperties": false
    },
    "output_schema": {
      "type": "object",
      "additionalProperties": true
    }
  },
  {
    "name": "configure",
    "description": "修改创作模式、模型、比例、文案和生成参数",
    "access": "write",
    "destructive": false,
    "idempotent": true,
    "input_schema": {
      "type": "object",
      "additionalProperties": false,
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
        "configuration": {
          "type": "object",
          "additionalProperties": true
        }
      },
      "required": [
        "idempotency_key",
        "expected_revision",
        "configuration"
      ]
    },
    "output_schema": {
      "type": "object",
      "additionalProperties": true
    }
  },
  {
    "name": "begin_asset",
    "description": "开始分块上传图片",
    "access": "write",
    "destructive": false,
    "idempotent": true,
    "input_schema": {
      "type": "object",
      "additionalProperties": false,
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
        "name": {
          "type": "string",
          "minLength": 1,
          "maxLength": 160
        },
        "mime": {
          "type": "string",
          "enum": [
            "image/png",
            "image/jpeg",
            "image/webp"
          ]
        },
        "total_bytes": {
          "type": "integer",
          "minimum": 1,
          "maximum": 10485760
        }
      },
      "required": [
        "idempotency_key",
        "expected_revision",
        "name",
        "mime",
        "total_bytes"
      ]
    },
    "output_schema": {
      "type": "object",
      "additionalProperties": true
    }
  },
  {
    "name": "append_asset",
    "description": "追加一块 base64 图片数据",
    "access": "write",
    "destructive": false,
    "idempotent": true,
    "input_schema": {
      "type": "object",
      "additionalProperties": false,
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
        "upload_id": {
          "type": "string"
        },
        "offset": {
          "type": "integer",
          "minimum": 0
        },
        "base64": {
          "type": "string",
          "minLength": 4,
          "maxLength": 262144
        }
      },
      "required": [
        "idempotency_key",
        "expected_revision",
        "upload_id",
        "offset",
        "base64"
      ]
    },
    "output_schema": {
      "type": "object",
      "additionalProperties": true
    }
  },
  {
    "name": "finish_asset",
    "description": "完成上传并导入素材",
    "access": "write",
    "destructive": false,
    "idempotent": true,
    "input_schema": {
      "type": "object",
      "additionalProperties": false,
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
        "upload_id": {
          "type": "string"
        }
      },
      "required": [
        "idempotency_key",
        "expected_revision",
        "upload_id"
      ]
    },
    "output_schema": {
      "type": "object",
      "additionalProperties": true
    }
  },
  {
    "name": "remove_asset",
    "description": "移除当前设计会话中的素材",
    "access": "write",
    "destructive": true,
    "idempotent": true,
    "input_schema": {
      "type": "object",
      "additionalProperties": false,
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
        "asset_id": {
          "type": "string"
        }
      },
      "required": [
        "idempotency_key",
        "expected_revision",
        "asset_id"
      ]
    },
    "output_schema": {
      "type": "object",
      "additionalProperties": true
    }
  },
  {
    "name": "submit_generation",
    "description": "提交一批创作任务，返回 accepted",
    "access": "write",
    "destructive": false,
    "idempotent": true,
    "input_schema": {
      "type": "object",
      "additionalProperties": false,
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
      ]
    },
    "output_schema": {
      "type": "object",
      "additionalProperties": true
    },
    "billable": true,
    "completion": "accepted"
  },
  {
    "name": "list_works",
    "description": "分页读取设计作品和批次状态",
    "access": "read",
    "idempotent": true,
    "input_schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "offset": {
          "type": "integer",
          "minimum": 0
        },
        "limit": {
          "type": "integer",
          "minimum": 1,
          "maximum": 20
        },
        "batch_id": {
          "type": "string"
        },
        "mode": {
          "type": "string",
          "enum": [
            "product",
            "detail",
            "tryon",
            "clone"
          ]
        }
      }
    },
    "output_schema": {
      "type": "object",
      "additionalProperties": true
    }
  },
  {
    "name": "refresh_work",
    "description": "使用已有任务句柄刷新作品",
    "access": "write",
    "destructive": false,
    "idempotent": true,
    "input_schema": {
      "type": "object",
      "additionalProperties": false,
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
        "work_id": {
          "type": "string"
        }
      },
      "required": [
        "idempotency_key",
        "expected_revision",
        "work_id"
      ]
    },
    "output_schema": {
      "type": "object",
      "additionalProperties": true
    }
  },
  {
    "name": "stop_batch",
    "description": "停止当前页面后续提交和轮询",
    "access": "write",
    "destructive": true,
    "idempotent": true,
    "input_schema": {
      "type": "object",
      "additionalProperties": false,
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
        "batch_id": {
          "type": "string"
        }
      },
      "required": [
        "idempotency_key",
        "expected_revision",
        "batch_id"
      ]
    },
    "output_schema": {
      "type": "object",
      "additionalProperties": true
    }
  },
  {
    "name": "read_result",
    "description": "读取已完成设计结果的分块 base64，不返回签名地址",
    "access": "read",
    "idempotent": true,
    "input_schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "work_id": {
          "type": "string"
        },
        "image_index": {
          "type": "integer",
          "minimum": 0,
          "maximum": 23
        },
        "offset": {
          "type": "integer",
          "minimum": 0
        },
        "length": {
          "type": "integer",
          "minimum": 1,
          "maximum": 196608
        },
        "export_id": {
          "type": "string"
        }
      },
      "required": [
        "work_id"
      ]
    },
    "output_schema": {
      "type": "object",
      "additionalProperties": true
    }
  }
])

export function capability(name) {
  const declaration = capabilities.find((item) => item.name === name)
  if (!declaration) throw new Error(`Unknown design agent capability: ${name}`)
  return declaration
}
