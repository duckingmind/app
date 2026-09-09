import React, { useEffect, useRef, useState } from "react";
import {
  ArrowRight,
  Check,
  ChevronDown,
  ImagePlus,
  Info,
  LoaderCircle,
  Minus,
  Plus,
  SlidersHorizontal,
  Sparkles,
  Square,
  WandSparkles,
  X,
} from "lucide-react";
import { sizeForRatio, supports, type ImageModel } from "./core.ts";
import { readPhoto, type Photo } from "./images.ts";
import {
  DEFAULT_PRODUCT_COUNTS,
  PRODUCT_LANGUAGES,
  PRODUCT_MARKETS,
  PRODUCT_PLATFORMS,
  PRODUCT_RATIOS,
  PRODUCT_TYPES,
  prepareProductRequest,
  productCopyPrompt,
  productPlan,
  validateProductRequest,
  type ProductCounts,
  type ProductOptions,
  type ProductRequest,
} from "./productCore.ts";
import "./productModule.css";

export type { ProductRequest } from "./productCore.ts";

const referenceAssets = import.meta.glob<string>("./assets/product-*.webp", {
  eager: true,
  query: "?inline",
  import: "default",
});
const referenceAsset = (name: string) =>
  referenceAssets[`./assets/product-${name}.webp`];

export type ProductModuleProps = {
  model?: ImageModel;
  models: ImageModel[];
  modelId: string;
  onModelChange: (id: string) => void;
  connected: boolean;
  connecting: boolean;
  busy: boolean;
  phase: string;
  onConnect: () => void;
  onGenerate: (request: ProductRequest) => void | Promise<void>;
  onAssist: (prompt: string, photos: Photo[]) => Promise<string>;
  onError: (message: string) => void;
  onStop: () => void;
  results?: React.ReactNode;
  hasResults?: boolean;
  resetKey?: number;
  assets?: { product?: string; examples?: string[]; overview?: string };
};

export function ProductModule(props: ProductModuleProps) {
  const assets = props.assets || {
    product: referenceAsset("original"),
    examples: ["scene", "model", "detail", "features"].map(referenceAsset),
  };
  const [photos, setPhotos] = useState<Photo[]>([]);
  const [platform, setPlatform] = useState("亚马逊");
  const [market, setMarket] = useState("美国");
  const [language, setLanguage] = useState("英文");
  const [ratio, setRatio] = useState("1:1");
  const [requirements, setRequirements] = useState("");
  const [smart, setSmart] = useState(true);
  const [counts, setCounts] = useState<ProductCounts>({
    ...DEFAULT_PRODUCT_COUNTS,
  });
  const [trend, setTrend] = useState(false);
  const [listing, setListing] = useState(true);
  const [reading, setReading] = useState(false);
  const [assisting, setAssisting] = useState(false);
  const [tab, setTab] = useState<"examples" | "results">("examples");
  const [preview, setPreview] = useState<Photo | null>(null);
  const upload = useRef<HTMLInputElement>(null);
  const settings = useRef<HTMLElement>(null);
  const ownedUrls = useRef(new Set<string>());
  const pendingUpload = useRef(false);
  const inputEpoch = useRef(0);
  const busy = props.busy || props.connecting || assisting || reading;
  const options: ProductOptions = {
    photos,
    platform,
    market,
    language,
    ratio,
    requirements,
    smart,
    counts,
    trend,
    listing,
  };
  const count = productPlan(options).length;

  useEffect(
    () => () => {
      inputEpoch.current++;
      for (const url of ownedUrls.current) URL.revokeObjectURL(url);
    },
    [],
  );

  useEffect(() => {
    inputEpoch.current++;
    setPhotos([]);
    setRequirements("");
    setCounts({ ...DEFAULT_PRODUCT_COUNTS });
    setSmart(true);
    setTrend(false);
    setListing(true);
    setTab("examples");
    setPreview(null);
    for (const url of ownedUrls.current) URL.revokeObjectURL(url);
    ownedUrls.current.clear();
  }, [props.resetKey]);

  useEffect(() => {
    if (!props.model || sizeForRatio(props.model, ratio)) return;
    const supported = PRODUCT_RATIOS.find((r) => sizeForRatio(props.model!, r));
    if (supported) setRatio(supported);
  }, [props.model, ratio]);

  async function addPhotos(files: File[]) {
    if (!files.length || busy || pendingUpload.current) return;
    if (files.length + photos.length > 6) {
      props.onError("同一商品最多上传 6 张图片");
      return;
    }
    pendingUpload.current = true;
    setReading(true);
    const epoch = inputEpoch.current;
    const added: Photo[] = [];
    try {
      for (const file of files) added.push(await readPhoto(file));
      if (epoch !== inputEpoch.current) {
        added.forEach((photo) => URL.revokeObjectURL(photo.url));
        return;
      }
      added.forEach((photo) => ownedUrls.current.add(photo.url));
      setPhotos((previous) => [...previous, ...added]);
    } catch (error) {
      added.forEach((photo) => URL.revokeObjectURL(photo.url));
      props.onError(error instanceof Error ? error.message : "图片读取失败");
    } finally {
      pendingUpload.current = false;
      setReading(false);
    }
  }

  async function assist() {
    if (!photos.length || busy) return;
    if (!props.connected) {
      props.onConnect();
      return;
    }
    setAssisting(true);
    try {
      const text = await props.onAssist(
        productCopyPrompt(options, "requirements"),
        photos,
      );
      if (text.trim()) setRequirements(text.slice(0, 3000));
      else props.onError("未获得商品信息，请重试或手动填写");
    } catch (error) {
      props.onError(error instanceof Error ? error.message : "商品分析失败");
    } finally {
      setAssisting(false);
    }
  }

  async function submit() {
    if (busy) return;
    if (!props.connected) {
      props.onConnect();
      return;
    }
    const error = validateProductRequest(options);
    if (error) {
      props.onError(error);
      return;
    }
    if (!props.model || !supports(props.model, "edit")) {
      props.onError("请选择支持图片编辑的模型");
      return;
    }
    if (!sizeForRatio(props.model, ratio)) {
      props.onError("当前模型不支持所选比例，请更换比例或模型");
      return;
    }
    setTab("results");
    try {
      await props.onGenerate(prepareProductRequest(options));
    } catch (error) {
      props.onError(error instanceof Error ? error.message : "商品套图生成失败");
    }
  }

  function useExample() {
    if (busy || !assets.product) return;
    setPhotos([
      { id: "product-example", name: "商品示例", url: assets.product },
    ]);
    setRequirements("请根据商品参考图提炼可见特点，保持原始外观、颜色与结构。");
    settings.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  return (
    <div className="pk-module">
      <aside ref={settings} className="pk-settings" aria-label="商品套图设置">
        <div className="pk-settings-scroll">
          <div className="pk-section-heading">
            <h2>
              商品原图 <Info size={13} aria-hidden="true" />
            </h2>
            <span>{photos.length} / 6</span>
          </div>
          <input
            ref={upload}
            className="sr-only"
            type="file"
            multiple
            accept="image/jpeg,image/png,image/webp"
            aria-label="上传商品原图"
            disabled={busy}
            onChange={(e) => {
              void addPhotos(Array.from(e.target.files || []));
              e.target.value = "";
            }}
          />
          <div
            className={`pk-upload ${photos.length ? "pk-upload-filled" : ""}`}
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault();
              void addPhotos(Array.from(e.dataTransfer.files));
            }}
          >
            {photos.length ? (
              <div className="pk-photo-grid">
                {photos.map((photo, index) => (
                  <div className="pk-photo" key={photo.id}>
                    <button
                      onClick={() => setPreview(photo)}
                      aria-label={`预览商品图 ${index + 1}`}
                    >
                      <img src={photo.url} alt={`商品原图 ${index + 1}`} />
                    </button>
                    <button
                      className="pk-remove-photo"
                      aria-label={`移除商品图 ${index + 1}`}
                      disabled={busy}
                      onClick={() =>
                        setPhotos((all) => all.filter((p) => p.id !== photo.id))
                      }
                    >
                      <X size={12} />
                    </button>
                  </div>
                ))}
                {photos.length < 6 && (
                  <button
                    className="pk-add-photo"
                    onClick={() => upload.current?.click()}
                    disabled={busy}
                    aria-label="继续添加商品图"
                  >
                    <Plus size={22} />
                  </button>
                )}
              </div>
            ) : (
              <button
                className="pk-upload-empty"
                onClick={() => upload.current?.click()}
                disabled={busy}
              >
                <span>
                  <ImagePlus size={16} />
                  {reading ? "正在读取图片" : "上传图片"}
                </span>
                <small>同一产品，最多 6 张</small>
                <small className="pk-file-hint">
                  JPG / PNG / WebP · 每张不超过 10 MB
                </small>
              </button>
            )}
          </div>

          <section className="pk-section">
            <div className="pk-section-heading">
              <h2>生成设置</h2>
            </div>
            <div className="pk-select-grid">
              <Select
                label="目标电商平台"
                value={platform}
                values={PRODUCT_PLATFORMS}
                onChange={setPlatform}
                disabled={busy}
              />
              <Select
                label="销售市场"
                value={market}
                values={PRODUCT_MARKETS}
                onChange={setMarket}
                disabled={busy}
              />
              <Select
                label="商品套图语言"
                value={language}
                values={PRODUCT_LANGUAGES}
                onChange={setLanguage}
                disabled={busy}
              />
              <label className="pk-select">
                <span className="sr-only">商品套图比例</span>
                <select
                  value={ratio}
                  onChange={(e) => setRatio(e.target.value)}
                  disabled={busy}
                >
                  {PRODUCT_RATIOS.map((value) => (
                    <option
                      key={value}
                      value={value}
                      disabled={
                        !!props.model && !sizeForRatio(props.model, value)
                      }
                    >
                      {value}
                      {props.model && !sizeForRatio(props.model, value)
                        ? " · 不支持"
                        : ""}
                    </option>
                  ))}
                </select>
                <ChevronDown size={15} />
              </label>
            </div>
          </section>

          <section className="pk-section">
            <div className="pk-section-heading">
              <h2>
                商品卖点与要求 <Info size={13} aria-hidden="true" />
              </h2>
              <button
                className="pk-assist"
                onClick={() => void assist()}
                disabled={busy || !photos.length}
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
              value={requirements}
              rows={6}
              maxLength={3000}
              disabled={busy}
              onChange={(e) => setRequirements(e.target.value)}
              placeholder={
                "建议包含以下信息，生成更精准：\n1. 产品名称\n2. 核心卖点\n3. 适用人群\n4. 期望场景\n5. 具体参数"
              }
            />
          </section>

          <section className="pk-section">
            <div className="pk-section-heading">
              <h2>套图结构配置</h2>
              <span>共 {count} 张</span>
            </div>
            <label className={`pk-config-option ${smart ? "selected" : ""}`}>
              <span>
                <input
                  type="radio"
                  name="product-structure"
                  checked={smart}
                  onChange={() => setSmart(true)}
                  disabled={busy}
                />
                <strong>智能匹配</strong>
                <span className="pk-recommended">推荐</span>
              </span>
              <small>分析商品特点，规划 7 张图片的内容与视觉方向。</small>
            </label>
            <label className={`pk-config-option ${!smart ? "selected" : ""}`}>
              <span>
                <input
                  type="radio"
                  name="product-structure"
                  checked={!smart}
                  onChange={() => setSmart(false)}
                  disabled={busy}
                />
                <strong>自定义配置</strong>
              </span>
              <small>自由调整各类图片数量，共选择 7–20 张。</small>
            </label>
            {!smart && (
              <div className="pk-counts">
                {PRODUCT_TYPES.map((type) => (
                  <div className="pk-count-row" key={type.id}>
                    <span>
                      <strong>{type.short}</strong>
                      <small>{type.hint}</small>
                    </span>
                    <div className="pk-stepper">
                      <button
                        disabled={busy || counts[type.id] === 0}
                        aria-label={`减少${type.short}`}
                        onClick={() =>
                          setCounts((all) => ({
                            ...all,
                            [type.id]: Math.max(0, all[type.id] - 1),
                          }))
                        }
                      >
                        <Minus size={13} />
                      </button>
                      <output aria-label={`${type.short}数量`}>
                        {counts[type.id]}
                      </output>
                      <button
                        disabled={busy || counts[type.id] === 5 || count >= 20}
                        aria-label={`增加${type.short}`}
                        onClick={() =>
                          setCounts((all) => ({
                            ...all,
                            [type.id]: Math.min(5, all[type.id] + 1),
                          }))
                        }
                      >
                        <Plus size={13} />
                      </button>
                    </div>
                  </div>
                ))}
                <p className={count < 7 ? "pk-count-warning" : "pk-subtle"}>
                  {count < 7
                    ? `还需选择 ${7 - count} 张图片`
                    : "每类最多 5 张，可按商品重点灵活组合。"}
                </p>
              </div>
            )}
          </section>

          <section className="pk-section">
            <div className="pk-section-heading">
              <h2>附加功能</h2>
            </div>
            <label className="pk-feature">
              <span>
                <strong>爆款风格分析</strong>
                <small>结合平台视觉习惯优化构图与卖点展示</small>
              </span>
              <input
                type="checkbox"
                checked={trend}
                onChange={(e) => setTrend(e.target.checked)}
                disabled={busy}
              />
              <i />
            </label>
            <label className="pk-feature">
              <span>
                <strong>商品上架文案</strong>
                <small>同时生成商品标题、卖点与商品描述</small>
              </span>
              <input
                type="checkbox"
                checked={listing}
                onChange={(e) => setListing(e.target.checked)}
                disabled={busy}
              />
              <i />
            </label>
          </section>

          <section className="pk-section pk-model-section">
            <div className="pk-section-heading">
              <h2>图片模型</h2>
              {props.connected && (
                <button
                  className="pk-text-button"
                  onClick={props.onConnect}
                  disabled={busy}
                >
                  刷新
                </button>
              )}
            </div>
            <select
              aria-label="商品套图图片模型"
              value={props.modelId}
              onChange={(e) => props.onModelChange(e.target.value)}
              disabled={busy || !props.connected}
            >
              <option value="">
                {props.connected ? "选择图片编辑模型" : "连接账户后选择模型"}
              </option>
              {props.models
                .filter((m) => supports(m, "edit"))
                .map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name || m.id}
                  </option>
                ))}
            </select>
            <p className="pk-subtle">图片与文案使用账户可用模型生成。</p>
          </section>
        </div>
        <div className="pk-submit-area">
          {props.busy ? (
            <button className="pk-submit pk-stop" onClick={props.onStop}>
              <Square size={14} />
              {props.phase || "正在生成"} · 停止后续
            </button>
          ) : (
            <button
              className="pk-submit"
              disabled={
                busy ||
                (props.connected && (!photos.length || count < 7 || count > 20))
              }
              onClick={submit}
            >
              {props.connecting ? (
                <LoaderCircle size={16} className="spin" />
              ) : (
                <WandSparkles size={17} />
              )}
              {props.connecting
                ? "正在连接账户"
                : !props.connected
                  ? "连接账户，开始创作"
                  : `一键生成套图${listing ? "与文案" : ""}（${count} 张）`}
            </button>
          )}
        </div>
      </aside>

      <main className="pk-workspace">
        <div className="pk-toolbar">
          <div className="pk-tabs" role="tablist" aria-label="商品套图工作区">
            <button
              role="tab"
              aria-selected={tab === "examples"}
              className={tab === "examples" ? "selected" : ""}
              onClick={() => setTab("examples")}
            >
              创作预览
            </button>
            <button
              role="tab"
              aria-selected={tab === "results"}
              className={tab === "results" ? "selected" : ""}
              onClick={() => setTab("results")}
            >
              生成结果{props.hasResults && <i />}
            </button>
          </div>
          <button
            className="pk-mobile-settings"
            onClick={() =>
              settings.current?.scrollIntoView({ behavior: "smooth" })
            }
          >
            <SlidersHorizontal size={15} />
            生成设置
          </button>
        </div>
        {tab === "results" ? (
          <div className="pk-results">
            {props.results || (
              <div className="pk-empty-results">
                <ImagePlus size={30} />
                <h2>商品套图会展示在这里</h2>
                <p>上传商品原图，选择结构后开始创作。</p>
                <button
                  className="pk-text-button"
                  onClick={() => setTab("examples")}
                >
                  查看创作示例 <ArrowRight size={14} />
                </button>
              </div>
            )}
          </div>
        ) : (
          <div className="pk-introduction">
            <span className="pk-eyebrow">
              <Sparkles size={13} />
              PRODUCT PHOTO STUDIO
            </span>
            <h1>AI 商品套图</h1>
            <p className="pk-intro-copy">
              一张商品图，延展一整套创意。
              <br className="pk-mobile-break" /> 为每个卖点，找到合适的表达。
            </p>
            {assets.overview ? (
              <div className="pk-overview">
                <img
                  src={assets.overview}
                  alt="商品原图转化为主图、使用场景和卖点展示的套图示例"
                />
              </div>
            ) : (
              <div className="pk-showcase">
                <div className="pk-showcase-source">
                  <span className="pk-image-label">01 主图（白底 / 合规）</span>
                  {assets.product ? (
                    <img src={assets.product} alt="商品主图示例" />
                  ) : (
                    <ProductIllustration />
                  )}
                  <div className="pk-source-caption">
                    <span>从一件好产品</span>
                    <strong>到一套好表达</strong>
                  </div>
                </div>
                <div className="pk-showcase-arrow">
                  <ArrowRight size={25} />
                </div>
                <div className="pk-showcase-grid">
                  {["场景展示", "模特场景图", "细节说明", "卖点详解"].map(
                    (name, index) => (
                      <div
                        className={`pk-example-tile pk-example-${index}`}
                        key={name}
                      >
                        <span className="pk-image-label">
                          0{index + 2} {name}
                        </span>
                        {assets.examples?.[index] ? (
                          <img
                            src={assets.examples[index]}
                            alt={`${name}示例`}
                          />
                        ) : (
                          <>
                            <ProductIllustration />
                            <div className="pk-example-caption">
                              <span>
                                {
                                  [
                                    "MAKE ROOM FOR SOUND",
                                    "YOUR EVERYDAY RHYTHM",
                                    "CRAFTED WITH CARE",
                                    "FEEL EVERY DETAIL",
                                  ][index]
                                }
                              </span>
                              <i />
                            </div>
                          </>
                        )}
                      </div>
                    ),
                  )}
                </div>
              </div>
            )}
            <div className="pk-intro-footer">
              <div>
                <span>
                  <Check size={14} />
                  多平台内容方向
                </span>
                <span>
                  <Check size={14} />
                  整套视觉统一
                </span>
                <span>
                  <Check size={14} />
                  同步上架文案
                </span>
              </div>
              {assets.product && (
                <button onClick={useExample} disabled={busy}>
                  使用这组素材 <ArrowRight size={14} />
                </button>
              )}
            </div>
            <div className="pk-flow">
              <span>
                <b>1</b>上传商品原图
              </span>
              <ArrowRight size={15} />
              <span>
                <b>2</b>配置图片与卖点
              </span>
              <ArrowRight size={15} />
              <span>
                <b>3</b>生成、预览与下载
              </span>
            </div>
            <p className="pk-reference-note">
              示例用于展示创作方向，生成结果以所选模型输出为准。
            </p>
          </div>
        )}
      </main>
      {preview && (
        <PhotoPreview photo={preview} onClose={() => setPreview(null)} />
      )}
    </div>
  );
}

function Select({
  label,
  value,
  values,
  onChange,
  disabled,
}: {
  label: string;
  value: string;
  values: readonly string[];
  onChange: (value: string) => void;
  disabled: boolean;
}) {
  return (
    <label className="pk-select">
      <span className="sr-only">{label}</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
      >
        {values.map((item) => (
          <option key={item} value={item}>
            {item}
          </option>
        ))}
      </select>
      <ChevronDown size={15} />
    </label>
  );
}

function PhotoPreview({
  photo,
  onClose,
}: {
  photo: Photo;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    ref.current?.showModal();
  }, []);
  return (
    <dialog
      className="pk-dialog"
      ref={ref}
      onCancel={onClose}
      onClick={(e) => {
        if (e.target === ref.current) onClose();
      }}
    >
      <div>
        <strong>{photo.name}</strong>
        <button onClick={onClose} aria-label="关闭商品预览">
          <X size={20} />
        </button>
      </div>
      <img src={photo.url} alt={photo.name} />
    </dialog>
  );
}

function ProductIllustration() {
  const id = React.useId().replaceAll(":", "");
  return (
    <svg
      className="pk-product-illustration"
      viewBox="0 0 320 360"
      role="img"
      aria-label="橙色耳机创意示意图"
    >
      <defs>
        <linearGradient id={`${id}-band`} x1="0" y1="0" x2="1" y2="1">
          <stop stopColor="#ffad37" />
          <stop offset=".55" stopColor="#ff7a1f" />
          <stop offset="1" stopColor="#c64e16" />
        </linearGradient>
        <linearGradient id={`${id}-ear`}>
          <stop stopColor="#f77821" />
          <stop offset=".5" stopColor="#ffb24a" />
          <stop offset="1" stopColor="#ea631b" />
        </linearGradient>
        <filter id={`${id}-shadow`}>
          <feGaussianBlur stdDeviation="8" />
        </filter>
      </defs>
      <ellipse
        cx="165"
        cy="319"
        rx="90"
        ry="10"
        fill="#282216"
        opacity=".12"
        filter={`url(#${id}-shadow)`}
      />
      <g transform="rotate(-17 160 180)">
        <path
          d="M66 223 V146 C66 30 254 30 254 146 V223"
          fill="none"
          stroke={`url(#${id}-band)`}
          strokeWidth="31"
        />
        <path
          d="M84 146 C84 55 236 55 236 146"
          fill="none"
          stroke="#fbb05c"
          strokeWidth="7"
          opacity=".8"
        />
        <rect x="48" y="189" width="39" height="84" rx="17" fill="#d55b18" />
        <rect x="232" y="189" width="39" height="84" rx="17" fill="#d55b18" />
        <ellipse cx="85" cy="244" rx="45" ry="67" fill={`url(#${id}-ear)`} />
        <ellipse cx="77" cy="244" rx="27" ry="51" fill="#bd531d" />
        <ellipse cx="77" cy="244" rx="17" ry="38" fill="#f78a2b" />
        <ellipse cx="234" cy="244" rx="45" ry="67" fill={`url(#${id}-ear)`} />
        <ellipse
          cx="241"
          cy="244"
          rx="31"
          ry="54"
          fill="#f39832"
          stroke="#fdb64c"
          strokeWidth="3"
        />
        <path
          d="M232 225 V255 H250"
          fill="none"
          stroke="#fff5d6"
          strokeWidth="8"
        />
      </g>
    </svg>
  );
}
