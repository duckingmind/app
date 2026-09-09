import type { Photo } from "./images.ts";

export const DETAIL_BLOCKS = [
  {
    id: "hero",
    name: "首屏主视觉",
    description: "传递核心价值",
    instruction:
      "首屏主视觉：以产品为视觉中心，品牌级摄影，醒目的简短主标题和一句核心价值文案，构图大气。",
  },
  {
    id: "benefits",
    name: "核心卖点图",
    description: "突出差异优势",
    instruction:
      "核心卖点：结合已提供的真实产品卖点，通过清晰的产品特写和少量信息层级展示差异化优势。",
  },
  {
    id: "usage",
    name: "使用场景图",
    description: "呈现真实使用场景",
    instruction:
      "使用场景：展示目标用户真实使用产品的自然场景，使用方式符合产品功能和人体结构。",
  },
  {
    id: "angles",
    name: "多角度图",
    description: "多角度呈现外观",
    instruction:
      "多角度展示：将同一个产品的不同视角整洁排版，确保外观、材质、颜色与结构一致。",
  },
  {
    id: "lifestyle",
    name: "场景氛围图",
    description: "展现产品生活方式",
    instruction:
      "场景氛围：以产品为主角打造生活方式场景，用光线和材质传递品牌情绪，场景符合目标人群。",
  },
  {
    id: "detail",
    name: "商品细节图",
    description: "放大材质与工艺",
    instruction:
      "商品细节：通过真实产品细节的微距摄影与整齐局部排版，展现材质、接口和工艺。",
  },
  {
    id: "story",
    name: "品牌故事图",
    description: "传达品牌理念",
    instruction:
      "品牌故事：以用户已提供的品牌背景或理念进行叙事设计。没有品牌资料时只传递产品设计理念，不虚构历史、奖项或认证。",
  },
  {
    id: "size",
    name: "尺寸 / 容量 / 尺码图",
    description: "展示规格信息",
    instruction:
      "尺寸容量：围绕产品做清晰的尺寸或容量示意，只使用用户明确提供的数值，未提供的数值不要猜测和标注。",
  },
  {
    id: "comparison",
    name: "效果对比图",
    description: "使用前后效果对比",
    instruction:
      "效果对比：仅依据已提供的真实效果信息设计前后或功能对比，避免未经验证的性能数据和夸大承诺。",
  },
  {
    id: "specs",
    name: "详细规格 / 参数表",
    description: "展示详细商品数据",
    instruction:
      "规格参数：制作易读的产品参数信息版式，仅排版用户已明确提供的真实规格，不编造参数。",
  },
  {
    id: "craft",
    name: "工艺制作图",
    description: "展示工艺制作过程",
    instruction:
      "工艺制作：突出可见的结构、材料和精细做工，仅使用已有信息展示工艺，不虚构生产设备或制作流程。",
  },
  {
    id: "accessories",
    name: "配件 / 赠品图",
    description: "明确收货的所有物品",
    instruction:
      "配件清单：整洁平铺展示原始参考图或用户说明中实际包含的配件与主体，不额外增加赠品。",
  },
  {
    id: "series",
    name: "系列展示图",
    description: "多色或多 SKU 展示",
    instruction:
      "系列展示：只展示用户原图和说明中提供的真实颜色及款式，使用统一角度进行有序陈列。",
  },
  {
    id: "ingredients",
    name: "商品成分图",
    description: "展示配方 / 材质 / 成分",
    instruction:
      "商品成分：以用户提供的配方或材质信息制作清晰的信息可视化，不添加未知成分、比例或功效。",
  },
  {
    id: "guide",
    name: "使用步骤图",
    description: "清晰说明使用方式",
    instruction:
      "使用步骤：以少量连续步骤说明产品使用方式，步骤依据用户说明或参考图可确定的功能。",
  },
  {
    id: "service",
    name: "售后服务图",
    description: "说明服务与支持",
    instruction:
      "服务支持：仅排版用户明确提供的服务、保修和售后说明，不自行承诺时长或赔付。",
  },
] as const;

export type DetailBlockId = (typeof DETAIL_BLOCKS)[number]["id"];
export type ContentModuleRequest = {
  kind: "detail" | "clone";
  ratio: string;
  products: Photo[];
  jobs: { title: string; prompt: string; references?: Photo[] }[];
};

export function detailRequest(options: {
  products: Photo[];
  blocks: string[];
  platform: string;
  market: string;
  language: string;
  ratio: string;
  description: string;
  visualStyle: string;
}): ContentModuleRequest {
  if (!options.products.length) throw new Error("请先上传商品图片");
  const selected = options.blocks
    .map((id) => DETAIL_BLOCKS.find((block) => block.id === id))
    .filter((block) => !!block);
  if (!selected.length) throw new Error("请至少选择一个详情页模块");
  const shared = `为${options.platform}面向${options.market}市场制作专业电商 A+ / 详情页中的一个独立图片模块。所有参考图为同一商品原图，必须保持产品形状、颜色、材质、Logo 和比例一致，不能改变产品本身。图片中文字使用${options.language}，文案简练、拼写正确、层级清楚。统一视觉方向：${options.visualStyle}。商品卖点与要求：${options.description.trim() || "根据商品可见信息设计，不推测未知参数和功能"}。整套图使用统一配色、字体气质、摄影光线和视觉语言。只生成本模块完整成图，不生成整套拼贴或网页截图，不添加平台界面、水印或多余品牌标记。`;
  return {
    kind: "detail",
    ratio: options.ratio,
    products: options.products,
    jobs: selected.map((block, index) => ({
      title: `${String(index + 1).padStart(2, "0")} ${block.name}`,
      prompt: `${shared}\n当前模块（整套第 ${index + 1} / ${selected.length} 张）：${block.instruction}`,
    })),
  };
}

export const CLONE_TYPES = [
  "电商商品图",
  "服饰电商图",
  "营销海报",
  "社媒图文",
  "创意海报",
  "其他",
] as const;

export function cloneRequest(options: {
  references: Photo[];
  products: Photo[];
  type: string;
  degree: "style" | "close";
  language: string;
  ratio: string;
  description: string;
  perReference: Record<string, string>;
}): ContentModuleRequest {
  if (!options.references.length) throw new Error("请先上传参考图片");
  if (options.references.length > 20) throw new Error("参考图片最多为 20 张");
  const degree =
    options.degree === "close"
      ? "高度参考第一张图片的构图结构、版式层级、主体位置、光线和场景关系，按新的产品与文案重新设计。"
      : "提取第一张参考图片的整体视觉风格、配色方向和内容层级，重新设计构图、色彩细节和场景，不逐像素照搬。";
  return {
    kind: "clone",
    ratio: options.ratio,
    products: options.products,
    jobs: options.references.map((reference, index) => ({
      title: `复刻 ${String(index + 1).padStart(2, "0")}`,
      references: [reference],
      prompt: `创作一张专业${options.type}。第一张输入图是视觉参考图。${degree}${options.products.length ? "其余输入图是要替换到设计中的真实商品，必须保持这些商品的外观、颜色、材质、标识和结构，将原设计主体替换为提供的商品，不把两种商品混合。" : "未提供替换商品，保留参考图中的主体类型，根据要求重新创作。"}图片文字使用${options.language}。统一要求：${options.description.trim() || "保持清晰的视觉焦点、自然光影与专业排版"}。本张要求：${options.perReference[reference.id]?.trim() || "遵循统一要求"}。保持产品真实性，不编造参数、促销承诺和认证，不添加不相关的品牌标记、水印或平台界面。仅生成一张最终成图。`,
    })),
  };
}
