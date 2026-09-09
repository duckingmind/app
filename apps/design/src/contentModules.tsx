import React, { useEffect, useRef, useState } from "react";
import {
  ArrowRight,
  Check,
  ChevronDown,
  CircleAlert,
  Copy,
  ImagePlus,
  Layers3,
  LoaderCircle,
  Plus,
  SlidersHorizontal,
  Sparkles,
  Square,
  WandSparkles,
  X,
} from "lucide-react";
import { sizeForRatio, type ImageModel } from "./core.ts";
import { readPhoto, type Photo } from "./images.ts";
import {
  CLONE_TYPES,
  cloneRequest,
  DETAIL_BLOCKS,
  detailRequest,
  type ContentModuleRequest,
} from "./contentCore.ts";
import "./contentModules.css";

export type { ContentModuleRequest } from "./contentCore.ts";
export type ContentModuleProps = {
  busy: boolean;
  connected: boolean;
  connecting?: boolean;
  phase?: string;
  models?: ImageModel[];
  modelId?: string;
  onModelChange?: (id: string) => void;
  onConnect?: () => void;
  onGenerate: (request: ContentModuleRequest) => Promise<void> | void;
  onAssist?: (prompt: string, photos: Photo[]) => Promise<string>;
  onPreview: (url: string, title: string) => void;
  onError: (message: string) => void;
  onStop: () => void;
  resetKey?: number;
  results?: React.ReactNode;
  exampleImage?: string;
  exampleProducts?: Photo[];
  exampleReferences?: Photo[];
};

const RATIOS = ["1:1", "3:4", "2:3", "4:3", "16:9", "9:16"];
const PLATFORMS = [
  "亚马逊",
  "淘宝 / 天猫",
  "京东",
  "拼多多",
  "抖音电商",
  "TikTok Shop",
  "Shopify",
  "独立站",
  "其他",
];
const MARKETS = [
  "美国",
  "中国",
  "英国",
  "德国",
  "法国",
  "日本",
  "韩国",
  "东南亚",
  "全球",
];
const LANGUAGES = [
  "英文",
  "简体中文",
  "繁体中文",
  "日文",
  "韩文",
  "德文",
  "法文",
  "西班牙文",
];
const describeError = (error: unknown) =>
  error instanceof Error ? error.message : "操作失败，请稍后重试";
const exampleAssets = import.meta.glob<string>(
  ["./assets/detail-*.webp", "./assets/clone-*.webp"],
  { eager: true, query: "?inline", import: "default" },
);
const sampleAsset = (name: string) => exampleAssets[`./assets/${name}.webp`];
const samplePhoto = (name: string, title: string): Photo => ({
  id: `example-${name}`,
  name: title,
  url: sampleAsset(name),
});
const DETAIL_PRODUCTS = [1, 2, 3].map((index) =>
  samplePhoto(`detail-original-0${index}`, `耳机原图 ${index}`),
);
const CLONE_EXAMPLES = [
  {
    name: "电商商品图",
    refs: [1, 2, 3, 4].map((index) => `clone-product-reference-0${index}`),
    products: ["clone-product-original"],
    results: [1, 2, 3, 4].map((index) => `clone-product-result-0${index}`),
    note: "将产品换为我的水杯，保留整套版式关系。",
  },
  {
    name: "服饰电商图",
    refs: ["clone-apparel-reference"],
    products: ["clone-apparel-original"],
    results: ["clone-apparel-result-01", "clone-apparel-result-02"],
    note: "保留服饰广告的构图和气质，替换为上传的服装。",
  },
  {
    name: "营销海报",
    refs: ["clone-poster-reference"],
    products: [],
    results: ["clone-poster-result-01", "clone-poster-result-02"],
    note: "参考画面风格，为新的营销主题重新设计。",
  },
  {
    name: "社媒图文",
    refs: ["clone-reference"],
    products: [],
    results: ["clone-result-01", "clone-result-02"],
    note: "参考社媒卡片的内容结构，替换为新的主题与文案。",
  },
];

function DetailExample({
  onPreview,
}: {
  onPreview: ContentModuleProps["onPreview"];
}) {
  return (
    <div className="cm-detail-example">
      <div className="cm-detail-sources">
        {DETAIL_PRODUCTS.map((photo, index) => (
          <button
            key={photo.id}
            onClick={() => onPreview(photo.url, photo.name)}
          >
            <img src={photo.url} alt={photo.name} />
            {index === 2 && <span>商品原图</span>}
          </button>
        ))}
      </div>
      <ArrowRight className="cm-detail-arrow" size={25} />
      <button
        className="cm-detail-long"
        onClick={() => onPreview(sampleAsset("detail-long"), "详情页长图示例")}
      >
        <img
          src={sampleAsset("detail-long")}
          alt="统一风格的完整详情页长图示例"
        />
        <span>完整长图</span>
      </button>
      <div className="cm-detail-sections">
        {[1, 2, 3, 4, 5, 6].map((index) => (
          <button
            key={index}
            onClick={() =>
              onPreview(
                sampleAsset(`detail-section-0${index}`),
                `详情页模块示例 ${index}`,
              )
            }
          >
            <img
              src={sampleAsset(`detail-section-0${index}`)}
              alt={`详情页模块示例 ${index}`}
            />
          </button>
        ))}
      </div>
      <span className="cm-source-note">来源页面示例</span>
    </div>
  );
}

function CloneExample({
  index,
  setIndex,
  onPreview,
}: {
  index: number;
  setIndex: (value: number) => void;
  onPreview: ContentModuleProps["onPreview"];
}) {
  const current = CLONE_EXAMPLES[index];
  return (
    <div className="cm-clone-example">
      <div className="cm-example-tabs" role="group" aria-label="复刻示例分类">
        {CLONE_EXAMPLES.map((example, number) => (
          <button
            key={example.name}
            className={number === index ? "selected" : ""}
            aria-pressed={number === index}
            onClick={() => setIndex(number)}
          >
            {example.name}
          </button>
        ))}
      </div>
      <div className="cm-clone-images">
        <div
          className={`cm-clone-inputs ${current.refs.length > 1 ? "multiple" : ""}`}
        >
          {current.refs.map((name, number) => (
            <button
              key={name}
              onClick={() =>
                onPreview(sampleAsset(name), `参考图示例 ${number + 1}`)
              }
            >
              <img src={sampleAsset(name)} alt={`参考图示例 ${number + 1}`} />
              <span>参考图</span>
            </button>
          ))}
        </div>
        <ArrowRight size={28} className="cm-detail-arrow" />
        <div className="cm-clone-outputs">
          {current.results.map((name, number) => (
            <button
              key={name}
              onClick={() =>
                onPreview(sampleAsset(name), `复刻效果示例 ${number + 1}`)
              }
            >
              <img src={sampleAsset(name)} alt={`复刻效果示例 ${number + 1}`} />
              <span>示例效果</span>
            </button>
          ))}
        </div>
      </div>
      <div className="cm-clone-example-footer">
        <span>{current.note}</span>
        <small>来源页面示例</small>
      </div>
    </div>
  );
}

function usePhotos(limit: number, onError: (message: string) => void) {
  const [photos, setPhotos] = useState<Photo[]>([]);
  const [loading, setLoading] = useState(false);
  const urls = useRef(new Set<string>());
  const loadingRef = useRef(false);
  const mounted = useRef(true);
  useEffect(
    () => () => {
      mounted.current = false;
      for (const url of urls.current) URL.revokeObjectURL(url);
    },
    [],
  );
  async function add(files: File[]) {
    if (!files.length || loadingRef.current) return;
    if (photos.length + files.length > limit) {
      onError(`最多上传 ${limit} 张图片，请减少所选图片数量`);
      return;
    }
    loadingRef.current = true;
    setLoading(true);
    const added: Photo[] = [];
    try {
      for (const file of files) added.push(await readPhoto(file));
      if (mounted.current) {
        for (const photo of added) urls.current.add(photo.url);
        setPhotos((current) => [...current, ...added]);
      } else for (const photo of added) URL.revokeObjectURL(photo.url);
    } catch (error) {
      for (const photo of added) URL.revokeObjectURL(photo.url);
      onError(describeError(error));
    } finally {
      loadingRef.current = false;
      if (mounted.current) setLoading(false);
    }
  }
  return { photos, setPhotos, loading, add };
}

function PhotoUpload({
  title,
  hint,
  collection,
  limit,
  disabled,
  onPreview,
}: {
  title: string;
  hint: string;
  collection: ReturnType<typeof usePhotos>;
  limit: number;
  disabled: boolean;
  onPreview: ContentModuleProps["onPreview"];
}) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <section className="cm-upload-section">
      <div className="section-title">
        <h2>{title}</h2>
        <span>
          {collection.photos.length} / {limit}
        </span>
      </div>
      <input
        ref={input}
        className="sr-only"
        type="file"
        accept="image/png,image/jpeg,image/webp"
        multiple
        aria-label={`上传${title}`}
        disabled={disabled || collection.loading}
        onChange={(event) => {
          void collection.add(Array.from(event.target.files || []));
          event.target.value = "";
        }}
      />
      <div
        className={`upload-zone ${collection.photos.length ? "has-photos" : ""}`}
        onDragOver={(event) => event.preventDefault()}
        onDrop={(event) => {
          event.preventDefault();
          if (!disabled)
            void collection.add(Array.from(event.dataTransfer.files));
        }}
      >
        {collection.photos.length ? (
          <div className="cm-photo-grid">
            {collection.photos.map((photo, index) => (
              <div className="cm-photo" key={photo.id}>
                <button
                  type="button"
                  onClick={() => onPreview(photo.url, `${title} ${index + 1}`)}
                  aria-label={`预览${title} ${index + 1}`}
                >
                  <img src={photo.url} alt={`${title} ${index + 1}`} />
                </button>
                <span>{String(index + 1).padStart(2, "0")}</span>
                <button
                  type="button"
                  className="cm-remove"
                  aria-label={`移除${title} ${index + 1}`}
                  disabled={disabled}
                  onClick={() =>
                    collection.setPhotos((current) =>
                      current.filter((item) => item.id !== photo.id),
                    )
                  }
                >
                  <X size={12} />
                </button>
              </div>
            ))}
            {collection.photos.length < limit && (
              <button
                type="button"
                className="cm-photo cm-add"
                onClick={() => input.current?.click()}
                disabled={disabled || collection.loading}
                aria-label={`添加${title}`}
              >
                <Plus size={21} />
              </button>
            )}
          </div>
        ) : (
          <button
            type="button"
            className="upload-empty cm-upload-empty"
            onClick={() => input.current?.click()}
            disabled={disabled || collection.loading}
          >
            <span className="upload-symbol">
              {collection.loading ? (
                <LoaderCircle size={23} className="spin" />
              ) : (
                <ImagePlus size={23} />
              )}
            </span>
            <strong>
              {collection.loading ? "正在读取图片" : `上传${title}`}
            </strong>
            <span>{hint}</span>
          </button>
        )}
      </div>
    </section>
  );
}

function OptionsSelect({
  label,
  value,
  choices,
  onChange,
  disabled = false,
}: {
  label: string;
  value: string;
  choices: readonly string[];
  onChange: (value: string) => void;
  disabled?: boolean;
}) {
  return (
    <label className="cm-select-label">
      <span>{label}</span>
      <select
        aria-label={label}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        disabled={disabled}
      >
        {choices.map((choice) => (
          <option key={choice}>{choice}</option>
        ))}
      </select>
    </label>
  );
}

function ModelOptions({
  props,
  ratio,
  setRatio,
}: {
  props: ContentModuleProps;
  ratio: string;
  setRatio: (value: string) => void;
}) {
  const model = props.models?.find((item) => item.id === props.modelId);
  useEffect(() => {
    if (!model || sizeForRatio(model, ratio)) return;
    const supported = RATIOS.find((value) => sizeForRatio(model, value));
    if (supported) setRatio(supported);
  }, [model, ratio, setRatio]);
  return (
    <>
      <label className="cm-select-label">
        <span>图片比例</span>
        <select
          aria-label="图片比例"
          value={ratio}
          onChange={(event) => setRatio(event.target.value)}
          disabled={props.busy}
        >
          {RATIOS.map((value) => (
            <option
              key={value}
              disabled={!!model && !sizeForRatio(model, value)}
            >
              {value}
            </option>
          ))}
        </select>
      </label>
      <details className="advanced cm-model-options">
        <summary>
          <SlidersHorizontal size={14} />
          生成模型
          <ChevronDown size={14} />
        </summary>
        <select
          aria-label="生成模型"
          value={props.modelId || ""}
          onChange={(event) => props.onModelChange?.(event.target.value)}
          disabled={props.busy}
        >
          <option value="">
            {props.connected ? "请选择模型" : "账户尚未连接"}
          </option>
          {props.models?.map((item) => (
            <option
              key={item.id}
              value={item.id}
              disabled={item.available === false}
            >
              {item.name || item.id}
            </option>
          ))}
        </select>
        {!props.connected && props.onConnect && (
          <button
            type="button"
            className="secondary full"
            disabled={props.connecting}
            onClick={props.onConnect}
          >
            {props.connecting ? "连接中…" : "连接账户并加载模型"}
          </button>
        )}
      </details>
    </>
  );
}

function GenerateFooter({
  props,
  count,
  disabled,
  label,
  onGenerate,
}: {
  props: ContentModuleProps;
  count: number;
  disabled: boolean;
  label: string;
  onGenerate: () => void;
}) {
  return (
    <div className="generate-footer">
      <div className="generation-summary">
        <span>
          {props.busy ? props.phase || "正在生成" : `${count} 张独立成图`}
        </span>
        {props.busy ? (
          <LoaderCircle className="spin" size={14} />
        ) : (
          <span>按顺序生成</span>
        )}
      </div>
      {props.busy ? (
        <button type="button" className="secondary full" onClick={props.onStop}>
          <Square size={14} />
          停止后续生成
        </button>
      ) : (
        <button
          type="button"
          className="primary full"
          disabled={disabled || props.connecting}
          onClick={onGenerate}
        >
          <WandSparkles size={18} />
          {disabled
            ? "上传素材并完成设置"
            : props.connected
              ? label
              : "连接账户并创作"}
          <ArrowRight size={16} />
        </button>
      )}
    </div>
  );
}

function WorkspaceHeader({
  title,
  eyebrow,
  settingsRef,
  busy,
}: {
  title: string;
  eyebrow: string;
  settingsRef: React.RefObject<HTMLElement>;
  busy: boolean;
}) {
  return (
    <div className="workspace-heading">
      <div>
        <div className="eyebrow">{eyebrow}</div>
        <h1>{title}</h1>
      </div>
      <div className="workspace-actions">
        <button
          className="secondary mobile-settings-button"
          onClick={() =>
            settingsRef.current?.scrollIntoView({
              behavior: "smooth",
              block: "start",
            })
          }
        >
          <SlidersHorizontal size={15} />
          创作设置
        </button>
        <span className="workspace-label">
          <span />
          {busy ? "创作进行中" : "创作工作台"}
        </span>
      </div>
    </div>
  );
}

function ModuleTabs({
  tab,
  setTab,
}: {
  tab: "examples" | "results";
  setTab: (tab: "examples" | "results") => void;
}) {
  return (
    <div className="workspace-tabs">
      <div role="group" aria-label="工作台视图">
        <button
          className={tab === "examples" ? "active" : ""}
          onClick={() => setTab("examples")}
        >
          灵感参考
        </button>
        <button
          className={tab === "results" ? "active" : ""}
          onClick={() => setTab("results")}
        >
          本次作品
        </button>
      </div>
      <span>PRODUCT CONTENT STUDIO</span>
    </div>
  );
}

function EmptyResults() {
  return (
    <div className="cm-empty-results">
      <Layers3 size={36} />
      <h2>还没有生成作品</h2>
      <p>上传素材并完成设置后，生成结果会出现在这里。</p>
    </div>
  );
}

export function DetailModule(props: ContentModuleProps) {
  const products = usePhotos(6, props.onError);
  const [platform, setPlatform] = useState("亚马逊");
  const [market, setMarket] = useState("美国");
  const [language, setLanguage] = useState("英文");
  const [ratio, setRatio] = useState("16:9");
  const [description, setDescription] = useState("");
  const [visualStyle, setVisualStyle] =
    useState("简约高级，清晰的留白与专业产品摄影");
  const [blocks, setBlocks] = useState<string[]>(
    DETAIL_BLOCKS.slice(0, 6).map((block) => block.id),
  );
  const [tab, setTab] = useState<"examples" | "results">("examples");
  const [assisting, setAssisting] = useState(false);
  const [localError, setLocalError] = useState("");
  const settings = useRef<HTMLElement>(null);
  const selected = blocks
    .map((id) => DETAIL_BLOCKS.find((block) => block.id === id)!)
    .filter(Boolean);
  useEffect(() => {
    products.setPhotos([]);
    setDescription("");
    setBlocks(DETAIL_BLOCKS.slice(0, 6).map((block) => block.id));
    setTab("examples");
    setLocalError("");
  }, [props.resetKey]);
  async function assist() {
    if (!props.onAssist || !products.photos.length || assisting) return;
    setAssisting(true);
    setLocalError("");
    try {
      setDescription(
        await props.onAssist(
          `观察商品图片，为${platform}面向${market}的 A+ 详情页整理简洁的中文商品信息，包括产品名称、可见卖点、适用人群、使用场景和已知参数。不要编造性能、认证或不可见参数。已有要求：${description || "无"}。直接输出可编辑的内容，不要开场白。`,
          products.photos,
        ),
      );
    } catch (error) {
      setLocalError(describeError(error));
    } finally {
      setAssisting(false);
    }
  }
  async function generate() {
    setLocalError("");
    try {
      const request = detailRequest({
        products: products.photos,
        blocks,
        platform,
        market,
        language,
        ratio,
        description,
        visualStyle,
      });
      setTab("results");
      await props.onGenerate(request);
    } catch (error) {
      setLocalError(describeError(error));
    }
  }
  return (
    <>
      <aside
        className="settings cm-settings"
        ref={settings}
        aria-label="详情页设置"
      >
        <div className="settings-scroll">
          <PhotoUpload
            title="商品原图"
            hint="同一商品，最多 6 张 · JPG / PNG / WebP"
            collection={products}
            limit={6}
            disabled={props.busy}
            onPreview={props.onPreview}
          />
          <section className="setting-section">
            <div className="section-title">
              <h2>生成设置</h2>
            </div>
            <div className="cm-select-grid">
              <OptionsSelect
                label="电商平台"
                value={platform}
                choices={PLATFORMS}
                onChange={setPlatform}
                disabled={props.busy}
              />
              <OptionsSelect
                label="目标市场"
                value={market}
                choices={MARKETS}
                onChange={setMarket}
                disabled={props.busy}
              />
              <OptionsSelect
                label="文案语言"
                value={language}
                choices={LANGUAGES}
                onChange={setLanguage}
                disabled={props.busy}
              />
              <ModelOptions props={props} ratio={ratio} setRatio={setRatio} />
            </div>
          </section>
          <section className="setting-section">
            <div className="section-title">
              <h2>商品卖点与要求</h2>
              <button
                className="cm-assist"
                type="button"
                onClick={() => void assist()}
                disabled={
                  !products.photos.length ||
                  props.busy ||
                  assisting ||
                  !props.onAssist
                }
              >
                {assisting ? (
                  <LoaderCircle size={13} className="spin" />
                ) : (
                  <Sparkles size={13} />
                )}
                AI 帮写
              </button>
            </div>
            <textarea
              aria-label="商品卖点与要求"
              placeholder={
                "建议包含以下信息：\n1. 产品名称\n2. 核心卖点\n3. 适用人群与使用场景\n4. 具体参数与品牌信息"
              }
              rows={6}
              maxLength={5000}
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              disabled={props.busy || assisting}
            />
          </section>
          <section className="setting-section">
            <div className="section-title">
              <h2>包含模块（多选）</h2>
              <span>已选 {blocks.length} 项</span>
            </div>
            <div className="cm-block-grid">
              {DETAIL_BLOCKS.map((block) => (
                <label
                  className={`cm-block-option ${blocks.includes(block.id) ? "selected" : ""}`}
                  key={block.id}
                >
                  <span>
                    <input
                      type="checkbox"
                      checked={blocks.includes(block.id)}
                      disabled={props.busy}
                      onChange={() =>
                        setBlocks((current) =>
                          current.includes(block.id)
                            ? current.filter((id) => id !== block.id)
                            : [...current, block.id],
                        )
                      }
                    />
                    <strong>{block.name}</strong>
                  </span>
                  <small>{block.description}</small>
                </label>
              ))}
            </div>
          </section>
          <section className="setting-section">
            <div className="section-title">
              <h2>统一视觉风格</h2>
            </div>
            <textarea
              aria-label="统一视觉风格"
              value={visualStyle}
              onChange={(event) => setVisualStyle(event.target.value)}
              maxLength={600}
              rows={3}
              disabled={props.busy}
            />
          </section>
        </div>
        <GenerateFooter
          props={props}
          count={blocks.length}
          disabled={
            !products.photos.length ||
            !blocks.length ||
            products.loading ||
            assisting
          }
          label={`生成 ${blocks.length} 张详情模块`}
          onGenerate={() => void generate()}
        />
      </aside>
      <main className="workspace cm-workspace">
        <WorkspaceHeader
          title="A+ / 详情页"
          eyebrow="PRODUCT STORY"
          settingsRef={settings}
          busy={props.busy}
        />
        {localError && (
          <div className="error-banner" role="alert">
            <CircleAlert size={17} />
            <span>{localError}</span>
            <button
              className="icon-button"
              aria-label="关闭提示"
              onClick={() => setLocalError("")}
            >
              <X size={16} />
            </button>
          </div>
        )}
        <ModuleTabs tab={tab} setTab={setTab} />
        {tab === "results" ? (
          props.results || <EmptyResults />
        ) : (
          <div className="cm-inspiration">
            <div className="cm-hero-heading">
              <span className="cm-kicker">FROM PRODUCT TO STORY</span>
              <h2>让每个卖点，都有好画面。</h2>
              <p>一组商品原图，构建风格统一、信息清晰的完整详情内容。</p>
            </div>
            {props.exampleImage ? (
              <button
                className="cm-reference-image"
                onClick={() =>
                  props.onPreview(props.exampleImage!, "A+ 详情页参考")
                }
              >
                <img
                  src={props.exampleImage}
                  alt="商品原图生成 A+ 详情页的效果参考"
                />
              </button>
            ) : (
              <DetailExample onPreview={props.onPreview} />
            )}
            <div className="cm-section-heading">
              <div>
                <h3>本次内容结构</h3>
                <p>按选择顺序生成，可在左侧调整模块。</p>
              </div>
              <button
                className="secondary"
                disabled={props.busy}
                onClick={() => {
                  products.setPhotos(props.exampleProducts || DETAIL_PRODUCTS);
                  setDescription(
                    "蓝色真无线耳机与充电盒，根据原图展示产品外观、细节及日常使用场景。未知技术参数请勿推测。",
                  );
                  setLocalError("");
                }}
              >
                <Plus size={14} />
                使用示例商品
              </button>
            </div>
            <div className="cm-outline">
              {selected.length ? (
                selected.map((block, index) => (
                  <div className="cm-outline-item" key={block.id}>
                    <span>{String(index + 1).padStart(2, "0")}</span>
                    <div>
                      <strong>{block.name}</strong>
                      <small>{block.description}</small>
                    </div>
                    <Check size={15} />
                  </div>
                ))
              ) : (
                <p className="cm-muted">选择至少一个模块，即可预览内容结构。</p>
              )}
            </div>
          </div>
        )}
        <footer className="workspace-footer">
          <span>统一视觉 · 模块化内容 · 自由组合</span>
          <span>A+ / DETAIL PAGE</span>
        </footer>
      </main>
    </>
  );
}

export function CloneModule(props: ContentModuleProps) {
  const references = usePhotos(20, props.onError);
  const products = usePhotos(6, props.onError);
  const [type, setType] = useState<string>(CLONE_TYPES[0]);
  const [degree, setDegree] = useState<"style" | "close">("close");
  const [description, setDescription] = useState("");
  const [language, setLanguage] = useState("英文");
  const [ratio, setRatio] = useState("1:1");
  const [requirements, setRequirements] = useState<Record<string, string>>({});
  const [tab, setTab] = useState<"examples" | "results">("examples");
  const [localError, setLocalError] = useState("");
  const [exampleIndex, setExampleIndex] = useState(0);
  const settings = useRef<HTMLElement>(null);
  useEffect(() => {
    references.setPhotos([]);
    products.setPhotos([]);
    setDescription("");
    setRequirements({});
    setTab("examples");
    setLocalError("");
  }, [props.resetKey]);
  async function generate() {
    setLocalError("");
    try {
      const request = cloneRequest({
        references: references.photos,
        products: products.photos,
        type,
        degree,
        language,
        ratio,
        description,
        perReference: requirements,
      });
      setTab("results");
      await props.onGenerate(request);
    } catch (error) {
      setLocalError(describeError(error));
    }
  }
  return (
    <>
      <aside
        className="settings cm-settings"
        ref={settings}
        aria-label="复刻设置"
      >
        <div className="settings-scroll">
          <PhotoUpload
            title="参考图片"
            hint="最多 20 张 · 每张参考图生成一张作品"
            collection={references}
            limit={20}
            disabled={props.busy}
            onPreview={props.onPreview}
          />
          <div className="setting-section">
            <PhotoUpload
              title="产品原图（可选）"
              hint="需要替换商品时上传，无商品可跳过"
              collection={products}
              limit={6}
              disabled={props.busy}
              onPreview={props.onPreview}
            />
          </div>
          <section className="setting-section">
            <div className="section-title">
              <h2>复刻类型</h2>
            </div>
            <div
              className="cm-type-grid"
              role="radiogroup"
              aria-label="复刻类型"
            >
              {CLONE_TYPES.map((choice) => (
                <label
                  key={choice}
                  className={type === choice ? "selected" : ""}
                >
                  <input
                    type="radio"
                    name="clone-type"
                    value={choice}
                    checked={type === choice}
                    onChange={() => setType(choice)}
                    disabled={props.busy}
                  />
                  <span>{choice}</span>
                </label>
              ))}
            </div>
          </section>
          <section className="setting-section">
            <div className="section-title">
              <h2>复刻程度</h2>
            </div>
            <div
              className="cm-degree-grid"
              role="radiogroup"
              aria-label="复刻程度"
            >
              <label className={degree === "style" ? "selected" : ""}>
                <span>
                  <input
                    type="radio"
                    name="clone-degree"
                    checked={degree === "style"}
                    onChange={() => setDegree("style")}
                    disabled={props.busy}
                  />
                  <strong>参考风格</strong>
                </span>
                <small>提取整体风格和结构，重新设计色彩与场景。</small>
              </label>
              <label className={degree === "close" ? "selected" : ""}>
                <span>
                  <input
                    type="radio"
                    name="clone-degree"
                    checked={degree === "close"}
                    onChange={() => setDegree("close")}
                    disabled={props.busy}
                  />
                  <strong>高度复刻</strong>
                </span>
                <small>参考视觉结构，替换产品与文案，保留构图关系。</small>
              </label>
            </div>
          </section>
          <section className="setting-section">
            <div className="section-title">
              <h2>统一复刻要求</h2>
              <span>可选</span>
            </div>
            <textarea
              aria-label="统一复刻要求"
              placeholder="例如：统一使用英文文案，保留人物姿势，仅替换商品；主色调改为奶油白。"
              rows={4}
              maxLength={3000}
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              disabled={props.busy}
            />
          </section>
          <section className="setting-section">
            <div className="section-title">
              <h2>生成设置</h2>
            </div>
            <div className="cm-select-grid">
              <OptionsSelect
                label="文案语言"
                value={language}
                choices={LANGUAGES}
                onChange={setLanguage}
                disabled={props.busy}
              />
              <ModelOptions props={props} ratio={ratio} setRatio={setRatio} />
            </div>
          </section>
        </div>
        <GenerateFooter
          props={props}
          count={references.photos.length}
          disabled={
            !references.photos.length || references.loading || products.loading
          }
          label={`复刻 ${references.photos.length} 张图片`}
          onGenerate={() => void generate()}
        />
      </aside>
      <main className="workspace cm-workspace">
        <WorkspaceHeader
          title="爆款图复刻"
          eyebrow="CREATIVE REMIX"
          settingsRef={settings}
          busy={props.busy}
        />
        {localError && (
          <div className="error-banner" role="alert">
            <CircleAlert size={17} />
            <span>{localError}</span>
            <button
              className="icon-button"
              aria-label="关闭提示"
              onClick={() => setLocalError("")}
            >
              <X size={16} />
            </button>
          </div>
        )}
        <ModuleTabs tab={tab} setTab={setTab} />
        {tab === "results" ? (
          props.results || <EmptyResults />
        ) : (
          <div className="cm-inspiration">
            <div className="cm-hero-heading">
              <span className="cm-kicker">INSPIRED BY WHAT WORKS</span>
              <h2>好灵感，成为你的下一张作品。</h2>
              <p>参考构图与设计语言，为自己的商品重新创作。</p>
            </div>
            {props.exampleImage ? (
              <button
                className="cm-reference-image"
                onClick={() =>
                  props.onPreview(props.exampleImage!, "爆款图复刻参考")
                }
              >
                <img
                  src={props.exampleImage}
                  alt="参考图片与重新创作的效果参考"
                />
              </button>
            ) : (
              <CloneExample
                index={exampleIndex}
                setIndex={setExampleIndex}
                onPreview={props.onPreview}
              />
            )}
            <div className="cm-section-heading">
              <div>
                <h3>
                  {references.photos.length
                    ? "每张图，都可以有自己的要求"
                    : "从一张参考图开始"}
                </h3>
                <p>
                  {references.photos.length
                    ? "单张要求会与左侧统一要求一起用于生成。"
                    : "将喜欢的设计拖入左侧，选择复刻方向。"}
                </p>
              </div>
              <button
                className="secondary"
                disabled={props.busy}
                onClick={() => {
                  const current = CLONE_EXAMPLES[exampleIndex];
                  references.setPhotos(
                    props.exampleReferences ||
                      current.refs.map((name, index) =>
                        samplePhoto(name, `参考图 ${index + 1}`),
                      ),
                  );
                  products.setPhotos(
                    props.exampleProducts ||
                      current.products.map((name, index) =>
                        samplePhoto(name, `商品原图 ${index + 1}`),
                      ),
                  );
                  setType(current.name);
                  setRequirements({});
                  setLocalError("");
                }}
              >
                <Plus size={14} />
                使用示例素材
              </button>
            </div>
            {references.photos.length ? (
              <div className="cm-reference-grid">
                {references.photos.map((photo, index) => (
                  <article className="cm-reference-card" key={photo.id}>
                    <button
                      className="cm-reference-preview"
                      onClick={() =>
                        props.onPreview(photo.url, `参考图 ${index + 1}`)
                      }
                    >
                      <img src={photo.url} alt={`参考图 ${index + 1}`} />
                      <span>参考 {String(index + 1).padStart(2, "0")}</span>
                    </button>
                    <label>
                      <span>本张复刻要求</span>
                      <textarea
                        rows={3}
                        maxLength={1000}
                        placeholder="补充仅适用于这张图的要求（可选）"
                        value={requirements[photo.id] || ""}
                        onChange={(event) =>
                          setRequirements((current) => ({
                            ...current,
                            [photo.id]: event.target.value,
                          }))
                        }
                        disabled={props.busy}
                      />
                    </label>
                  </article>
                ))}
              </div>
            ) : (
              <div className="cm-clone-tips">
                <span>
                  <Copy size={16} />
                  批量支持 20 张参考图
                </span>
                <span>
                  <Layers3 size={16} />
                  可上传 6 张商品原图
                </span>
                <span>
                  <WandSparkles size={16} />
                  按图设置复刻要求
                </span>
              </div>
            )}
          </div>
        )}
        <footer className="workspace-footer">
          <span>参考风格 · 替换商品 · 重新创作</span>
          <span>CREATIVE REMIX</span>
        </footer>
      </main>
    </>
  );
}
