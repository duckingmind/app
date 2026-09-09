import type { Photo } from './images.ts'

export const PRODUCT_PLATFORMS = [
  '亚马逊',
  '淘宝 / 天猫',
  '京东',
  '拼多多',
  '抖音电商',
  '小红书',
  'Shopee',
  'TikTok Shop',
  '独立站',
] as const
export const PRODUCT_MARKETS = [
  '美国',
  '中国',
  '英国',
  '德国',
  '法国',
  '日本',
  '东南亚',
] as const
export const PRODUCT_LANGUAGES = [
  '英文',
  '中文',
  '德文',
  '法文',
  '日文',
  '西班牙文',
] as const
export const PRODUCT_RATIOS = ['1:1', '3:4', '2:3', '9:16', '16:9'] as const
export const PRODUCT_TYPES = [
  {
    id: 'main',
    name: '主图（白底 / 合规）',
    short: '商品主图',
    hint: '干净展示产品全貌',
    prompt:
      '纯白背景的商品主图，商品完整居中并占画面约85%，保留真实产品形状，清晰自然阴影；画面禁止文字、促销标签、拼贴、边框和额外道具。',
  },
  {
    id: 'scene',
    name: '场景展示',
    short: '场景展示',
    hint: '构建真实使用情境',
    prompt:
      '选择符合目标买家的真实使用场景，以商品为视觉中心，背景适当虚化，光线自然，帮助买家理解商品在生活中的用途。',
  },
  {
    id: 'model',
    name: '模特场景图',
    short: '模特场景',
    hint: '人物互动与生活方式',
    prompt:
      '虚构成年人物自然使用商品，展现合理的产品与人物比例、真实互动和生活方式，保持商品细节准确。',
  },
  {
    id: 'details',
    name: '细节说明',
    short: '细节说明',
    hint: '放大材质、工艺与结构',
    prompt:
      '商品细节特写与简洁信息图排版，重点呈现参考图可见的真实材质、结构或工艺；仅用已知卖点作简短说明，不虚构参数。',
  },
  {
    id: 'benefits',
    name: '卖点详解',
    short: '卖点详解',
    hint: '让核心价值一目了然',
    prompt:
      '以最重要的已知商品卖点为主题，设计简洁清晰的商业信息图，商品占主要视觉位置，搭配精炼标题、细节图和充足留白，不添加未提供的性能承诺。',
  },
  {
    id: 'dimensions',
    name: '尺寸 / 规格图',
    short: '尺寸规格',
    hint: '直观说明已知规格',
    prompt:
      '商品规格说明图，清楚展现商品尺寸、容量或规格，仅标注用户明确提供的数据；未提供数值时仅展示结构和尺度感，不编造测量数值。',
  },
  {
    id: 'package',
    name: '配件 / 包装图',
    short: '配件包装',
    hint: '展示实际包含的物品',
    prompt:
      '展示商品与用户明确提供的配件或包装，整洁平铺构图，不添加参考图和用户资料中没有的配件或赠品。',
  },
] as const

export type ProductTypeId = (typeof PRODUCT_TYPES)[number]['id']
export type ProductCounts = Record<ProductTypeId, number>
export type ProductOptions = {
  photos: Photo[]
  platform: string
  market: string
  language: string
  ratio: string
  requirements: string
  smart: boolean
  counts: ProductCounts
  trend: boolean
  listing: boolean
}
export type ProductRequest = ProductOptions & {
  kind: 'product'
  outputs: {
    id: string
    type: ProductTypeId | 'auto'
    title: string
    prompt: string
  }[]
  planningMode: 'smart' | 'fixed'
  planningPrompt?: string
  listingPrompt?: string
}

export const DEFAULT_PRODUCT_COUNTS: ProductCounts = {
  main: 1,
  scene: 1,
  model: 1,
  details: 2,
  benefits: 2,
  dimensions: 0,
  package: 0,
}

export function productPlan(request: Pick<ProductOptions, 'smart' | 'counts'>) {
  if (request.smart)
    return Array.from({ length: 7 }, (_, index) => ({
      id: `product-${String(index + 1).padStart(2, '0')}`,
      type: 'auto' as const,
      title: `智能套图 ${String(index + 1).padStart(2, '0')}`,
      prompt:
        '这是同一商品整套图片中的一张。图片内容围绕当前逐图策划指定的真实商品特点，独立完整成图，与整组其他图片互补，不拼贴整组画面。',
      variant: 1,
    }))
  const counts = request.counts
  return PRODUCT_TYPES.flatMap((type) =>
    Array.from(
      { length: Math.max(0, Math.min(5, Math.floor(counts[type.id] || 0))) },
      (_, index) => ({
        id: `${type.id}-${index + 1}`,
        type: type.id,
        title: `${type.short}${counts[type.id] > 1 ? ` ${index + 1}` : ''}`,
        prompt: type.prompt,
        variant: index + 1,
      }),
    ),
  )
}

export function validateProductRequest(request: ProductOptions) {
  if (!request.photos.length) return '请先上传商品图片'
  if (request.photos.length > 6) return '同一商品最多上传 6 张图片'
  const plan = productPlan(request)
  if (plan.length < 7) return '商品套图至少需要 7 张，请调整自定义数量'
  if (plan.length > 20) return '单次套图最多生成 20 张，请减少自定义数量'
  return ''
}

export function productImagePrompt(
  request: ProductOptions,
  output: ReturnType<typeof productPlan>[number],
  referenceSheet: boolean,
  analysis = '',
) {
  return [
    '为同一商品创作一张专业电商商品图片。所有参考图片展示的是同一产品的外观和细节，必须保留商品的形状、颜色、材质、图案、标识和比例。',
    referenceSheet
      ? '输入图是多角度商品参考板，仅供理解商品，输出不得复制参考板或编号。'
      : '所有输入图片都是商品参考，不能当作不同商品组合。',
    `目标平台：${request.platform}；销售市场：${request.market}；画面文案语言：${request.language}。`,
    output.prompt,
    output.variant > 1
      ? `这是同类主题的第 ${output.variant} 张，使用不同取景、构图或真实细节，避免重复。`
      : '',
    request.requirements.trim()
      ? `用户提供的商品信息与要求：${request.requirements.trim()}`
      : '缺少明确参数时只展示可见事实，不虚构功能、规格、认证或效果。',
    analysis ? `视觉创作建议：${analysis}` : '',
    '整组图片采用一致的商品颜色、视觉色调、字体风格与品质。遵循目标平台的一般商品图片要求；不输出平台认证或销量排名，不添加水印。只输出一张独立完整图片。',
  ]
    .filter(Boolean)
    .join('\n')
}

export function productCopyPrompt(
  request: ProductOptions,
  purpose: 'requirements' | 'listing' | 'trend',
) {
  const context = `目标平台：${request.platform}；市场：${request.market}；语言：${request.language}。用户资料：${request.requirements || '尚未提供'}。所有图均为同一商品的不同角度。仅陈述图片能看出或用户明确提供的事实，不虚构品牌、性能、材质、尺寸、认证、销量或承诺；无法确认的参数不要写。`
  if (purpose === 'requirements')
    return `${context}\n请观察商品图片，用中文整理一份可直接编辑的商品信息：产品名称、可见特点、适用人群、建议场景、需要用户补充的参数。对不能确认的事项明确标注“待补充”，控制在350字以内。`
  if (purpose === 'trend')
    return `${context}\n请基于商品外观和平台常见视觉习惯，给出一段不超过250字的套图创作建议，包含背景、色调、构图、卖点展示顺序。你没有实时销量或竞品数据，不可宣称分析了实时热销趋势。`
  return `${context}\n根据图中商品和已知资料，用${request.language}撰写适合上架的商品文案，以 Markdown 格式输出：商品标题、5条卖点、简短商品描述、搜索关键词。资料不足时只写可确定的内容，不能把“待补充”当成真实商品属性。不要写促销、价格、评价或平台认证。`
}

export function prepareProductRequest(options: ProductOptions): ProductRequest {
  const error = validateProductRequest(options)
  if (error) throw new Error(error)
  return {
    ...options,
    kind: 'product',
    planningMode: options.smart ? 'smart' : 'fixed',
    outputs: productPlan(options).map((output) => ({
      id: output.id,
      type: output.type,
      title: output.title,
      prompt: productImagePrompt(options, output, false),
    })),
    planningPrompt: options.smart
      ? `${productCopyPrompt(options, 'trend')}\n请根据当前商品的真实特点和已知信息，逐图策划7张完整套图，至少包含1张纯白主图。其余类型与数量由你根据商品需要选择，可组合场景展示、人物使用场景、细节、卖点、已知尺寸规格及实际配件包装。每张有独立的具体内容和构图，避免重复；未知规格及配件不应成为假想内容。不要沿用一套固定类型比例。`
      : options.trend
        ? `${productCopyPrompt(options, 'trend')}\n本批次包含：${productPlan(
            options,
          )
            .map((o) => o.title)
            .join(
              '、',
            )}。根据商品可见信息，为这些画面推荐适合该商品的统一视觉方向和每类画面的具体内容。`
        : undefined,
    listingPrompt: options.listing
      ? productCopyPrompt(options, 'listing')
      : undefined,
  }
}
