const PROMPT = '创建一个HTML，内容是SVG绘制一个鹈鹕骑自行车的2D动画，你不需要任何测试创建一个HTML，内容是SVG绘制一个鹈鹕骑自行车的2D动画，你不需要任何测试'
const GALLERY_PREFIX = 'pelican/results/'
const MAX_RAW_STORAGE = 105_000
const MAX_HTML_STORAGE = 125_000

function record(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null
}

function responseText(value) {
  const root = record(value)
  if (!root) return ''
  for (const key of ['output_text', 'text', 'content']) {
    if (typeof root[key] === 'string') return root[key]
  }
  const output = Array.isArray(root.output) ? root.output : []
  const parts = []
  for (const item of output) {
    const row = record(item)
    if (!row) continue
    const content = Array.isArray(row.content)
      ? row.content.map(record).filter(part => part && typeof part.text === 'string').map(part => part.text)
      : []
    if (content.length) parts.push(...content)
    else if (typeof row.text === 'string') parts.push(row.text)
  }
  return parts.join('\n')
}

function nestedResponse(value) {
  const root = record(value)
  return record(root?.response) || record(root?.data) || root
}

function extractHtml(value) {
  const candidates = [...value.matchAll(/```(?:html|xml|svg)?\s*([\s\S]*?)```/gi)].map(match => match[1].trim())
  candidates.push(value.trim())
  for (const source of candidates) {
    if (!source) continue
    const document = source.match(/(?:<!doctype\s+html\b[^>]*>\s*)?<html\b[\s\S]*?<\/html\s*>/i)
    if (document) return document[0]
    const svg = source.match(/<svg\b[\s\S]*?<\/svg\s*>/i)
    if (svg) return `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>html,body{width:100%;height:100%;margin:0}body{display:grid;place-items:center}svg{display:block;max-width:100%;max-height:100%}</style></head><body>${svg[0]}</body></html>`
    if (/^(?:<!--[\s\S]*?-->\s*)*</.test(source) && /<(?:main|body|div|section|article|header|footer|button|canvas|table|form|p|h[1-6])\b/i.test(source)) {
      return `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body>${source}</body></html>`
    }
  }
  return ''
}

async function gatewayJson(response, operation) {
  const text = await response.text()
  let value
  try { value = text ? JSON.parse(text) : null } catch {
    throw Object.assign(new Error(`${operation} 返回了无法解析的响应。`), { code: 'INVALID_GATEWAY_RESPONSE' })
  }
  if (!response.ok) {
    const error = record(record(value)?.error)
    throw Object.assign(new Error(typeof error?.message === 'string' ? error.message : `${operation} 失败（HTTP ${response.status}）。`), {
      code: typeof error?.code === 'string' ? error.code : 'GATEWAY_REQUEST_FAILED',
    })
  }
  return value
}

async function readGalleryItem(context, key) {
  const response = await context.platform.request(`/storage/shared/items?key=${encodeURIComponent(key)}&include_metadata=true`)
  const value = await gatewayJson(response, '读取共享画廊')
  const entry = record(record(value)?.data)
  const item = record(entry?.value)
  if (!item) return null
  return {
    ...item,
    userId: typeof entry.author_user_id === 'string' ? entry.author_user_id : undefined,
    userName: typeof entry.author_user_name === 'string' ? entry.author_user_name : '未知用户',
  }
}

async function saveGalleryItem(context, task, key, item) {
  const { userId: _userId, userName: _userName, ...storedValue } = item
  const response = await context.platform.request(`/storage/shared/items?key=${encodeURIComponent(key)}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', 'idempotency-key': `gallery:${task.id}` },
    body: JSON.stringify({ value: storedValue, expected_revision: 0 }),
  })
  const value = await gatewayJson(response, '保存共享画廊')
  const result = record(record(value)?.data)
  if (result?.success !== true) {
    const existing = await readGalleryItem(context, key)
    if (existing) return existing
    throw Object.assign(new Error('平台未确认共享画廊写入。'), { code: 'GALLERY_SAVE_FAILED' })
  }
  return item
}

export default {
  async handle(task, context) {
    const payload = record(task.payload) || {}
    const model = typeof payload.model === 'string' ? payload.model.trim() : ''
    const effort = typeof payload.reasoning_effort === 'string' ? payload.reasoning_effort.trim() : ''
    const galleryKey = `${GALLERY_PREFIX}${task.id}`
    if (!model) throw Object.assign(new Error('请选择一个文本模型。'), { code: 'INVALID_MODEL' })

    const existing = await readGalleryItem(context, galleryKey)
    if (existing) {
      await context.reportProgress({ percent: 100, message: '结果已保存到共享画廊。' })
      return { saved: true, item_id: task.id, model: existing.modelId || existing.model, request_id: existing.requestId || task.id }
    }

    await context.reportProgress({ percent: 5, message: '任务已开始，正在请求模型。' })
    const requestId = `pelican_${task.id}`.slice(0, 128)
    const response = await context.platform.request('/responses', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-request-id': requestId,
        'idempotency-key': task.idempotencyKey,
      },
      body: JSON.stringify({
        model,
        input: PROMPT,
        stream: false,
        store: false,
        ...(effort ? { reasoning: { effort } } : {}),
      }),
    })
    const body = await response.text()
    let value
    try { value = body ? JSON.parse(body) : null } catch {
      throw Object.assign(new Error('Gateway 返回了无法解析的模型响应。'), { code: 'INVALID_MODEL_RESPONSE' })
    }
    if (!response.ok) {
      const root = record(value)
      const error = record(root?.error)
      throw Object.assign(new Error(typeof error?.message === 'string' ? error.message : `模型请求失败（HTTP ${response.status}）。`), {
        code: typeof error?.code === 'string' ? error.code : 'MODEL_REQUEST_FAILED',
      })
    }

    const finalResponse = nestedResponse(value)
    const text = responseText(finalResponse).trim()
    if (!text) throw Object.assign(new Error('模型返回内容为空。'), { code: 'EMPTY_MODEL_RESPONSE' })

    const reasoning = record(finalResponse.reasoning)
    const actualModel = typeof finalResponse.model === 'string' ? finalResponse.model : model
    const item = {
      id: task.id,
      userId: context.user?.id,
      userName: context.user?.name || context.user?.id || '未知用户',
      model: typeof payload.model_name === 'string' && payload.model_name.trim() ? payload.model_name.trim().slice(0, 128) : actualModel,
      modelId: actualModel,
      reasoningEffort: typeof reasoning?.effort === 'string' ? reasoning.effort : effort,
      generatedAt: task.createdAt || new Date().toISOString(),
      requestId: response.headers.get('x-request-id') || requestId,
      raw: text.slice(0, MAX_RAW_STORAGE),
      html: extractHtml(text).slice(0, MAX_HTML_STORAGE),
    }
    await context.reportProgress({ percent: 95, message: '模型输出已完成，正在保存共享画廊。' })
    let saved
    try {
      saved = await saveGalleryItem(context, task, galleryKey, item)
    } catch (error) {
      // A write response can be lost after the Gateway committed it. Confirm
      // the deterministic task key before reporting failure or retrying work.
      saved = await readGalleryItem(context, galleryKey).catch(() => null)
      if (!saved) throw error
    }
    await context.reportProgress({ percent: 100, message: '结果已保存到共享画廊。' })
    return {
      saved: true,
      item_id: task.id,
      model: actualModel,
      reasoning_effort: typeof reasoning?.effort === 'string' ? reasoning.effort : effort,
      request_id: saved.requestId || item.requestId,
    }
  },
}
