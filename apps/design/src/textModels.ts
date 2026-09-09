import { records, responseText, type Api } from './core.ts'

type Capability = 'supported' | 'unknown'

export type TextModelChoice = {
  id: string
  name: string
  vision: Capability
  responses: Capability
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
      .map(item => item.trim().toLowerCase()).filter(Boolean)
    : []
}

function nonemptyString(...values: unknown[]): string {
  return values.find((value): value is string => typeof value === 'string' && !!value.trim())?.trim() || ''
}

function isResponsesEndpoint(value: string) {
  return ['responses', '/responses', 'v1/responses', '/v1/responses'].includes(value.replace(/\/$/, ''))
}

/**
 * The current public Gateway /models response contains id, name,
 * display_name, context_window and max_output, with no modality or endpoint
 * guarantees. Missing metadata stays unknown until a live image challenge.
 * Native provider protocols are deliberately not used here: the Gateway can
 * adapt a chat-completions provider to its public Responses endpoint.
 */
export function textModelCatalog(payload: unknown, imageIds: Iterable<string>): TextModelChoice[] {
  const images = new Set(imageIds)
  const seen = new Set<string>()
  const choices: TextModelChoice[] = []
  for (const item of records(payload)) {
    const id = nonemptyString(item.id)
    if (!id || images.has(id) || seen.has(id) || item.available === false || item.supported_in_api === false) continue
    const kind = nonemptyString(item.model_type).toLowerCase()
    if (['image', 'video', 'audio', 'embedding', 'embeddings', 'rerank', 'reranker'].includes(kind)) continue

    const architecture = object(item.architecture)
    const capabilities = object(item.capabilities)
    const inputLists = [strings(item.input_modalities), strings(architecture.input_modalities)]
    const outputLists = [strings(item.output_modalities), strings(architecture.output_modalities)]
    const endpointLists = [strings(item.supported_endpoints), strings(capabilities.supported_endpoints)]
    const visionFlags = [item.supports_vision, item.supports_image_input, capabilities.vision, capabilities.supports_vision]
    const responseFlags = [item.supports_responses, capabilities.responses, capabilities.supports_responses]
    const textFlags = [item.supports_text_output, capabilities.supports_text_output]

    if (visionFlags.includes(false) || inputLists.some(list => list.length && !list.includes('image'))) continue
    if (textFlags.includes(false) || outputLists.some(list => list.length && !list.includes('text'))) continue
    if (responseFlags.includes(false) || endpointLists.some(list => list.length && !list.some(isResponsesEndpoint))) continue

    seen.add(id)
    choices.push({
      id,
      name: nonemptyString(item.display_name, item.name, id),
      vision: visionFlags.includes(true) || inputLists.some(list => list.includes('image')) ? 'supported' : 'unknown',
      responses: responseFlags.includes(true) || endpointLists.some(list => list.some(isResponsesEndpoint)) ? 'supported' : 'unknown',
    })
  }
  return choices
}

/**
 * Check the actual Responses + image path with a fresh visual challenge.
 * The caller draws a random code into the image and keeps the answer local;
 * neither the prompt nor image metadata supplied here contains that answer.
 * This is one API request, with no retry or cache shared between accounts.
 */
export async function verifyVisionModel(
  api: Api,
  modelId: string,
  challenge: { image: string; answer: string },
  signal?: AbortSignal,
): Promise<void> {
  if (signal?.aborted) throw new DOMException('已停止验证', 'AbortError')
  if (!modelId.trim()) throw new Error('请先选择文案与图片理解模型')
  if (!/^\d{4,12}$/.test(challenge.answer) || !/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=\s]+$/.test(challenge.image))
    throw new Error('图片理解验证素材无效，请重新连接账户后再试')

  const result = await api.request('/responses', {
    method: 'POST',
    signal,
    body: JSON.stringify({
      model: modelId,
      stream: false,
      store: false,
      instructions: '准确识别用户提供的图片，严格按照用户要求的格式作答。',
      input: [{
        role: 'user',
        content: [
          { type: 'input_text', text: '请读取附图中从左到右排列的数字码。只输出完整的阿拉伯数字码，保留前导零，不要解释、标点、空格或 Markdown。答案只存在于图片中；无法看清时回答“无法识别”，不要猜测。' },
          { type: 'input_image', image_url: challenge.image },
        ],
      }],
    }),
  })
  if (signal?.aborted) throw new DOMException('已停止验证', 'AbortError')
  const response = object(result)
  if (response.error || (response.status !== undefined && response.status !== 'completed'))
    throw new Error('图片理解验证未完成，请更换模型或稍后再试')
  const answer = responseText(result)
  if (!/^\d+$/.test(answer) || answer !== challenge.answer)
    throw new Error('所选模型未通过图片理解验证，请选择能通过 Responses 读取图片并输出文字的模型')
}
