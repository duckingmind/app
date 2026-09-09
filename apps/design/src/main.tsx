import React, { useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { createAppClient } from '@codex/proxy-app-sdk'
import { zipSync } from 'fflate'
import {
  ArrowLeft,
  Package,
  PanelsTopLeft,
  Copy,
  ArrowRight,
  Check,
  ChevronDown,
  CircleAlert,
  Columns2,
  Download,
  Expand,
  ImagePlus,
  Images,
  LoaderCircle,
  Plus,
  Scissors,
  RefreshCw,
  Shirt,
  SlidersHorizontal,
  Sparkles,
  Square,
  SquarePlus,
  Trash2,
  UserRound,
  WandSparkles,
  X,
} from 'lucide-react'
import manifest from '../manifest.json'
import {
  buildTryOnPrompt,
  imageModels,
  PendingTaskError,
  TerminalTaskError,
  pollImage,
  POSES,
  responseText,
  SCENES,
  sizeForRatio,
  submitImage,
  supports,
  type ImageModel,
  type Work,
} from './core.ts'
import {
  dataURL,
  fetchImage,
  garmentSheet,
  imageExtension,
  normalizedFile,
  readPhoto,
  saveBlob,
  stitchImages,
  visionChallenge,
  reviewImage,
  type Photo,
} from './images.ts'
import { ProductModule } from './productModule.tsx'
import type { ProductRequest } from './productCore.ts'
import {
  DetailModule,
  CloneModule,
  type ContentModuleRequest,
} from './contentModules.tsx'
import { WorksPanel, KIND_LABELS } from './WorksPanel.tsx'
import {
  referenceInstructions,
  referenceLayout,
  runCommerceJobs,
  type CommerceRequest,
} from './commerce.ts'
import { textModelCatalog, verifyVisionModel, type TextModelChoice } from './textModels.ts'
import { buildPlanningPrompt, parseCommercePlan } from './planning.ts'
import { buildQualityPrompt, parseQualityReport } from './quality.ts'
import { prepareReviewContext, parseReviewContext, reviewContextKey, type ReviewContext } from './reviewContext.ts'
import { createWorkStorage } from './workStorage.ts'
import './styles.css'

let showLoginLink: ((url: string) => void) | undefined
const client = createAppClient(manifest.id, {
  localDevelopment: import.meta.env.DEV,
  localAppVersion: manifest.version,
  onLoginRequired: details => {
    if (details?.login_url) showLoginLink?.(details.login_url)
  },
})
const assets = import.meta.glob<string>('./assets/*.webp', {
  eager: true,
  query: '?inline',
  import: 'default',
})
const asset = (name: string) => assets[`./assets/${name}.webp`]
const PEOPLE: Photo[] = Array.from({ length: 25 }, (_, i) => ({
  id: `model-${i + 1}`,
  name: `模特 ${String(i + 1).padStart(2, '0')}`,
  url: asset(`model-${String(i + 1).padStart(2, '0')}`),
}))
const EXAMPLES = [
  {
    title: '轻盈运动',
    subtitle: '自然草坪 / 运动休闲',
    clothes: [0],
    outputs: [1, 2, 3],
    person: 0,
    scene: 'grass',
  },
  {
    title: '夏日假期',
    subtitle: '度假海滩 / 轻熟穿搭',
    clothes: [10],
    outputs: [12, 13, 15],
    person: 2,
    scene: 'beach',
  },
  {
    title: '整套搭配',
    subtitle: '纯色棚拍 / 多件服饰',
    clothes: [4, 6, 8],
    outputs: [7, 9, 11],
    person: 3,
    scene: 'studio',
  },
]
const RATIOS = ['3:4', '1:1', '9:16', '2:3', '16:9']
const messageOf = (e: unknown) =>
  e instanceof Error ? e.message : '操作失败，请稍后重试'

function IconButton({
  label,
  children,
  className = '',
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { label: string }) {
  return (
    <button
      type="button"
      className={`icon-button ${className}`}
      aria-label={label}
      title={label}
      {...props}
    >
      {children}
    </button>
  )
}

function Dialog({
  title,
  onClose,
  children,
  wide = false,
}: {
  title: string
  onClose: () => void
  children: React.ReactNode
  wide?: boolean
}) {
  const ref = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    ref.current?.showModal()
  }, [])
  return (
    <dialog
      ref={ref}
      className={wide ? 'dialog wide' : 'dialog'}
      onCancel={onClose}
      onClick={(e) => {
        if (e.target === ref.current) onClose()
      }}
    >
      <div className="dialog-heading">
        <h2>{title}</h2>
        <IconButton label="关闭" onClick={onClose}>
          <X size={20} />
        </IconButton>
      </div>
      {children}
    </dialog>
  )
}

function App() {
  const [module, setModule] = useState<
    'product' | 'detail' | 'tryon' | 'clone'
  >('product')
  const [resetKey, setResetKey] = useState(0)
  const [moduleBatches, setModuleBatches] = useState<Record<string, string>>({})
  const [modelDialog, setModelDialog] = useState(false)
  const [garments, setGarments] = useState<Photo[]>([])
  const [person, setPerson] = useState<Photo>(PEOPLE[0])
  const [customPeople, setCustomPeople] = useState<Photo[]>([])
  const [peopleTab, setPeopleTab] = useState<'library' | 'ai'>('library')
  const [scenes, setScenes] = useState<string[]>(['studio'])
  const [customScene, setCustomScene] = useState('')
  const [extra, setExtra] = useState('')
  const [autoScene, setAutoScene] = useState(false)
  const [ratio, setRatio] = useState('3:4')
  const [poseIds, setPoseIds] = useState<string[]>(['front', 'walking', 'side'])
  const [modelDescription, setModelDescription] = useState(
    '成年女性，自然黑色长发，淡妆，舒展自然的站姿，白色简约上衣与牛仔裤。',
  )
  const [models, setModels] = useState<ImageModel[]>([])
  const [modelId, setModelId] = useState('')
  const [textModel, setTextModel] = useState('')
  const [textModels, setTextModels] = useState<TextModelChoice[]>([])
  const [verifiedModels, setVerifiedModels] = useState<string[]>([])
  const verifiedModelsRef = useRef(new Set<string>())
  const reviewContexts = useRef(new Map<string, ReviewContext>())
  const [connected, setConnected] = useState(false)
  const [connecting, setConnecting] = useState(false)
  const [loginURL, setLoginURL] = useState('')
  const [busy, setBusy] = useState(false)
  const [phase, setPhase] = useState('')
  const [notice, setNotice] = useState('')
  const [error, setError] = useState('')
  const [works, setWorks] = useState<Work[]>([])
  const [view, setView] = useState<'studio' | 'works'>('studio')
  const [exampleIndex, setExampleIndex] = useState(0)
  const [tab, setTab] = useState<'examples' | 'results'>('examples')
  const [batchId, setBatchId] = useState('')
  const [lightbox, setLightbox] = useState<{
    url: string
    title: string
  } | null>(null)
  const [compare, setCompare] = useState(false)
  const [split, setSplit] = useState(50)
  const [peopleDialog, setPeopleDialog] = useState(false)
  const [downloading, setDownloading] = useState(false)
  const [processingPhotos, setProcessingPhotos] = useState(false)
  const [filter, setFilter] = useState('all')
  const settingsRef = useRef<HTMLElement>(null)
  const garmentInput = useRef<HTMLInputElement>(null)
  const personInput = useRef<HTMLInputElement>(null)
  const abortRef = useRef<AbortController | null>(null)
  const busyRef = useRef(false)
  const worksRef = useRef<Work[]>([])
  const urlsRef = useRef(new Set<string>())
  const writeQueue = useRef(Promise.resolve())
  const workStorageRef = useRef(createWorkStorage(client.storage))
  const preferencesReadyRef = useRef(false)
  const storageReadyRef = useRef(false)
  const connectionRef = useRef<Promise<void> | null>(null)
  const mounted = useRef(true)

  const model = models.find((m) => m.id === modelId)
  const example = EXAMPLES[exampleIndex]
  const visibleWorks = works.filter(
    (w) =>
      (view === 'works' || w.batch === batchId) &&
      (filter === 'all' || w.status === filter),
  )
  const outputCount =
    (autoScene || customScene.trim() ? 1 : Math.max(1, scenes.length)) *
    poseIds.length

  useEffect(() => { showLoginLink = setLoginURL; return () => { showLoginLink = undefined } }, [])

  useEffect(
    () => () => {
      mounted.current = false
      abortRef.current?.abort()
      for (const url of urlsRef.current) URL.revokeObjectURL(url)
    },
    [],
  )
  useEffect(() => {
    if (!notice) return
    const timer = setTimeout(() => setNotice(''), 5000)
    return () => clearTimeout(timer)
  }, [notice])
  useEffect(() => {
    if (!model || sizeForRatio(model, ratio)) return
    const supported = RATIOS.find((r) => sizeForRatio(model, r))
    if (supported) setRatio(supported)
  }, [model, ratio])
  useEffect(() => {
    if (!connected || !preferencesReadyRef.current) return
    writeQueue.current = writeQueue.current
      .then(() => client.storage.set('design:settings:v1', { modelId, textModel }))
      .then(() => undefined)
      .catch(() => setNotice('模型选择暂未保存，当前页面仍可继续使用。'))
  }, [connected, modelId, textModel])

  function storeWorks(next: Work[]) {
    worksRef.current = next
    setWorks(next)
    if (!storageReadyRef.current) return
    const storage = workStorageRef.current
    writeQueue.current = writeQueue.current
      .then(() => storage.save(next))
      .catch(() => {
        if (mounted.current)
          setNotice('作品记录暂未同步，当前页面仍可查看和下载。')
      })
  }
  function updateWork(id: string, patch: Partial<Work>) {
    storeWorks(
      worksRef.current.map((w) => (w.id === id ? { ...w, ...patch } : w)),
    )
  }

  async function connect() {
    if (connectionRef.current) return connectionRef.current
    setConnecting(true)
    setError('')
    setConnected(false)
    storageReadyRef.current = false
    preferencesReadyRef.current = false
    worksRef.current = []
    setWorks([])
    setTextModels([])
    setTextModel('')
    verifiedModelsRef.current.clear()
    setVerifiedModels([])
    reviewContexts.current.clear()
    setModels([])
    connectionRef.current = (async () => {
      await writeQueue.current
      workStorageRef.current = createWorkStorage(client.storage)
      await client.platform.createSession()
      const catalog = imageModels(await client.api.request('/images/models'))
      setModels(catalog)
      const selected = catalog.find(
        (m) => supports(m, 'edit') && (m.max_input_images || 0) >= 1,
      )
      setModelId((previous) =>
        catalog.some((m) => m.id === previous) ? previous : selected?.id || '',
      )
      const [textResult, historyResult, preferencesResult] = await Promise.allSettled([
        client.api.request('/models'),
        workStorageRef.current.load(),
        client.storage.get<{ modelId?: string; textModel?: string }>('design:settings:v1'),
      ])
      const preferences = preferencesResult.status === 'fulfilled' ? preferencesResult.value : null
      if (preferences?.modelId && catalog.some(m => m.id === preferences.modelId && supports(m, 'edit')))
        setModelId(preferences.modelId)
      if (textResult.status === 'fulfilled') {
        const choices = textModelCatalog(textResult.value, catalog.map(m => m.id))
        setTextModels(choices)
        setTextModel((previous) =>
          choices.some(v => v.id === preferences?.textModel)
            ? preferences!.textModel!
            : choices.some((v) => v.id === previous)
            ? previous
            : choices[0]?.id || '',
        )
      }
      if (historyResult.status === 'fulfilled') {
        const restored = historyResult.value
        worksRef.current = restored
        setWorks(restored)
        setModuleBatches(
          Object.fromEntries(
            ['product', 'detail', 'clone'].map((kind) => [
              kind,
              restored.find((work) => work.kind === kind)?.batch || '',
            ]),
          ),
        )
        storageReadyRef.current = true
      } else if (historyResult.status === 'rejected')
        setNotice('作品记录暂未同步，当前会话可继续创作。')
      setConnected(true)
      preferencesReadyRef.current = true
      setLoginURL('')
      if (!selected)
        setError('当前账户暂无可用的图片编辑模型，请稍后刷新模型列表。')
    })()
      .catch((e) => {
        setError(messageOf(e))
        throw e
      })
      .finally(() => {
        setConnecting(false)
        setLoginURL('')
        connectionRef.current = null
      })
    return connectionRef.current
  }

  async function addFiles(files: File[], kind: 'garment' | 'person') {
    if (!files.length || busyRef.current || processingPhotos) return
    if (kind === 'garment' && garments.length + files.length > 6) {
      setError('最多上传 6 张服装图片')
      return
    }
    setProcessingPhotos(true)
    setError('')
    const accepted: Photo[] = []
    try {
      for (const file of kind === 'person' ? files.slice(0, 1) : files) {
        const photo = await readPhoto(file)
        accepted.push(photo)
        urlsRef.current.add(photo.url)
      }
      if (kind === 'garment')
        setGarments((previous) => [...previous, ...accepted].slice(0, 6))
      else {
        setPerson(accepted[0])
        setCustomPeople((previous) => [accepted[0], ...previous])
        setPeopleTab('library')
      }
    } catch (e) {
      for (const photo of accepted) {
        URL.revokeObjectURL(photo.url)
        urlsRef.current.delete(photo.url)
      }
      setError(messageOf(e))
    } finally {
      setProcessingPhotos(false)
    }
  }

  function applyExample() {
    setGarments(
      example.clothes.map((i) => ({
        id: `sample-${i}`,
        name: '服装参考',
        url: asset(`sample-${String(i).padStart(2, '0')}`),
      })),
    )
    setPerson(PEOPLE[example.person])
    setScenes([example.scene])
    setCustomScene('')
    setAutoScene(false)
    setView('studio')
    setNotice('示例素材已选用')
  }

  async function recommendScene(signal: AbortSignal) {
    const scene = await requestCopy(
      `观察这组服装，推荐一个适合电商服装摄影的具体场景。只返回一段不超过100字的中文场景描述，明确地点、背景、时间、照明和色调，不包含姿势或额外文字。用户偏好：${customScene || '自动选择'}。`,
      garments, signal,
    )
    setCustomScene(scene.slice(0, 500))
    return scene.slice(0, 500)
  }

  async function generate(kind: 'tryon' | 'model') {
    if (busyRef.current || processingPhotos || connecting) return
    setError('')
    if (!connected) {
      await connect().catch(() => undefined)
      return
    }
    if (!model || !supports(model, kind === 'model' ? 'generation' : 'edit')) {
      setError('请选择支持当前操作的可用图片模型')
      return
    }
    if (kind === 'tryon' && (!garments.length || !poseIds.length)) {
      setError('请选择服装图片和至少一个拍摄姿势')
      return
    }
    if (kind === 'model' && !modelDescription.trim()) {
      setError('请填写模特形象描述')
      return
    }
    const size = sizeForRatio(model, ratio)
    if (!size) {
      setError(`所选模型不支持 ${ratio}，请更换图片比例或模型`)
      return
    }
    if (kind === 'tryon' && (model.max_input_images || 0) < 2) {
      setError('试穿需要支持至少两张参考图的模型')
      return
    }
    if (!textModel || !storageReadyRef.current) {
      setError('请连接作品存储并选择文案与图片理解模型后生成')
      return
    }
    busyRef.current = true
    setBusy(true)
    setPhase('正在准备素材')
    const controller = new AbortController()
    abortRef.current = controller
    const batch = crypto.randomUUID()
    setBatchId(batch)
    setTab('results')
    setView('studio')
    setFilter('all')
    let jobs: Work[] = []
    try {
      setPhase('正在确认模型的图片理解能力')
      await ensureTextModel(controller.signal)
      let sceneList = ['浅灰色专业影棚，均匀柔和照明']
      if (kind === 'tryon') {
        if (autoScene) {
          setPhase('正在推荐拍摄场景')
          sceneList = [await recommendScene(controller.signal)]
        } else if (customScene.trim()) sceneList = [customScene.trim()]
        else
          sceneList = SCENES.filter((s) => scenes.includes(s.id)).map(
            (s) => `${s.name}：${s.prompt}`,
          )
        if (!sceneList.length) throw new Error('请选择拍摄场景或填写场景描述')
      }
      const poses =
        kind === 'model'
          ? [{ name: '模特形象', prompt: '正面全身站姿' }]
          : POSES.filter((p) => poseIds.includes(p.id))
      jobs = sceneList.flatMap((scene) =>
        poses.map(
          (p) =>
            ({
              id: crypto.randomUUID(),
              batch,
              title: kind === 'model' ? 'AI 模特' : p.name,
              scene,
              pose: p.prompt,
              ratio,
              model: model.id,
              createdAt: new Date().toISOString(),
              kind,
              status: 'queued',
              images: [],
            }) satisfies Work,
        ),
      )
      storeWorks([...jobs, ...worksRef.current].slice(0, 80))
      const sheet = garments.length + 1 > (model.max_input_images || 2)
      const context = kind === 'tryon' ? await prepareReviewContext(garments, [person]) : undefined
      if (context) context.images = context.images.map(input => ({
        ...input,
        label: input.label.includes('PRODUCT') ? '服装原图压缩预览，核对服装外观。' : '模特身份压缩预览，核对人物身份与体型。',
      }))
      for (const job of jobs) {
        job.plan = { direction: job.scene, brief: kind === 'model'
          ? `生成一位虚构成年服装模特的真实专业摄影照片。${modelDescription}。正面全身，头部和双脚完整入镜，白色背景，均匀影棚光，单人，穿着完整，不要文字或水印。`
          : buildTryOnPrompt(job.scene, job.pose, extra, garments.length, sheet) }
        if (context) {
          job.reviewKey = reviewContextKey(job.id)
          await client.storage.set(job.reviewKey, context)
          reviewContexts.current.set(job.id, context)
        }
        updateWork(job.id, { plan: job.plan, reviewKey: job.reviewKey })
      }
      await writeQueue.current
      await workStorageRef.current.save(worksRef.current)
      let files: File[] = []
      if (kind === 'tryon')
        files = [
          await normalizedFile(person),
          ...(sheet
            ? [await garmentSheet(garments)]
            : await Promise.all(garments.map(normalizedFile))),
        ]
      for (let i = 0; i < jobs.length; i++) {
        if (controller.signal.aborted) break
        const job = jobs[i]
        updateWork(job.id, { status: 'running' })
        setPhase(`正在生成 ${i + 1} / ${jobs.length}`)
        let remoteId: string | undefined
        try {
          let body: BodyInit
          if (kind === 'model')
            body = JSON.stringify({
              model: model.id,
              prompt: `生成一位虚构成年服装模特的真实专业摄影照片。${modelDescription}。正面全身，头部和双脚完整入镜，白色背景，均匀影棚光，单人，穿着完整，不要文字或水印。`,
              n: 1,
              size,
            })
          else {
            const form = new FormData()
            form.append('model', model.id)
            form.append('size', size)
            form.append('n', '1')
            form.append(
              'prompt',
              buildTryOnPrompt(
                job.scene,
                job.pose,
                extra,
                garments.length,
                sheet,
              ),
            )
            for (const file of files) form.append('image[]', file)
            body = form
          }
          const images = await submitImage(
            client.api,
            kind === 'model' ? '/images/generations' : '/images/edits',
            body,
            {
              signal: controller.signal,
              idempotencyKey: job.id,
              onTask: (id) => {
                remoteId = id
                updateWork(job.id, { taskId: id })
              },
            },
          )
          updateWork(job.id, { status: 'completed', images })
          await reviewGenerated({ ...job, images }, controller.signal)
          if (kind === 'model') {
            const generated = {
              id: job.id,
              name: 'AI 模特',
              url: images[0].url,
            }
            setPerson(generated)
            setCustomPeople((previous) => [generated, ...previous])
            setPeopleTab('library')
          }
        } catch (e) {
          const pending =
            !(e instanceof TerminalTaskError) &&
            (!!remoteId || e instanceof PendingTaskError)
          updateWork(job.id, {
            status: pending ? 'paused' : 'failed',
            error: controller.signal.aborted
              ? '已停止等待；已提交的任务可能仍在执行。'
              : messageOf(e),
          })
          // A failed/uncertain request stops the batch so automatic continuation
          // cannot consume additional credits after a quota or network failure.
          throw e
        }
      }
    } catch (e) {
      setError(
        controller.signal.aborted
          ? '已停止后续生成；已提交的任务仍可能完成并计费。'
          : messageOf(e),
      )
    } finally {
      storeWorks(
        worksRef.current.map((w) =>
          w.batch === batch && w.status === 'queued'
            ? { ...w, status: 'skipped' }
            : w,
        ),
      )
      setBusy(false)
      busyRef.current = false
      abortRef.current = null
      setPhase('')
    }
  }

  async function resume(work: Work) {
    if (!work.taskId || busyRef.current) return
    if (!connected) {
      await connect().catch(() => undefined)
      return
    }
    busyRef.current = true
    setBusy(true)
    setError('')
    setPhase('正在查询已有任务')
    const controller = new AbortController()
    abortRef.current = controller
    updateWork(work.id, { status: 'running', error: undefined })
    try {
      const images = await pollImage(client.api, work.taskId, {
        signal: controller.signal,
      })
      updateWork(work.id, { images, status: 'completed' })
      if (work.reviewKey || work.kind === 'model')
        await reviewGenerated({ ...work, images, status: 'completed' }, controller.signal)
      if (work.kind === 'model') {
        const p = { id: work.id, name: 'AI 模特', url: images[0].url }
        setPerson(p)
        setCustomPeople((previous) => [
          p,
          ...previous.filter((v) => v.id !== p.id),
        ])
      }
    } catch (e) {
      updateWork(work.id, {
        status: e instanceof TerminalTaskError ? 'failed' : 'paused',
        error: messageOf(e),
      })
      setError(messageOf(e))
    } finally {
      busyRef.current = false
      setBusy(false)
      abortRef.current = null
      setPhase('')
    }
  }

  async function ensureTextModel(signal: AbortSignal) {
    if (!textModel || !textModels.some(choice => choice.id === textModel))
      throw new Error('请选择可用的文案与图片理解模型')
    if (verifiedModelsRef.current.has(textModel)) return
    await verifyVisionModel(client.api, textModel, visionChallenge(), signal)
    if (signal.aborted) throw new DOMException('已停止', 'AbortError')
    verifiedModelsRef.current.add(textModel)
    setVerifiedModels([...verifiedModelsRef.current])
  }

  async function requestVision(
    prompt: string,
    inputs: { label: string; url: string }[],
    signal: AbortSignal,
  ) {
    await ensureTextModel(signal)
    if (signal.aborted) throw new DOMException('已停止', 'AbortError')
    const result = await client.api.request('/responses', {
      method: 'POST', signal,
      body: JSON.stringify({
        model: textModel, stream: false, store: false,
        instructions: '你是电商图片创作与视觉核对助手。准确观察用户图片，以已提供的商品事实为准，严格遵守当前请求的输出格式。',
        input: [{ role: 'user', content: [
          { type: 'input_text', text: prompt },
          ...inputs.flatMap(input => [
            { type: 'input_text', text: input.label },
            { type: 'input_image', image_url: input.url },
          ]),
        ] }],
      }),
    })
    const response = result as { status?: string; error?: { message?: string } }
    if (response.status === 'incomplete' || response.status === 'failed' || response.error)
      throw new Error(response.error?.message || '模型输出未完成，请调整要求后重新尝试')
    const text = responseText(result)
    if (!text || text.length > 100000)
      throw new Error('模型返回内容为空或过长，请调整要求或更换模型')
    return text
  }

  async function requestCopy(prompt: string, photos: Photo[], signal: AbortSignal) {
    const inputs = photos.length ? [{
      label: '同一商品的原始参考图，仅作为商品资料。',
      url: await dataURL(await garmentSheet(photos, 'PRODUCT')),
    }] : []
    return requestVision(prompt + '\n只使用用户提供或图片中明确可见的信息，未知参数不要猜测。', inputs, signal)
  }

  async function reviewGenerated(work: Work, signal: AbortSignal) {
    try {
      if (signal.aborted) throw new DOMException('检查已停止', 'AbortError')
      if (!work.images.length) throw new Error('请先等待图片生成完成')
      let context = reviewContexts.current.get(work.id)
      if (!context && work.reviewKey) {
        context = parseReviewContext(await client.storage.get(work.reviewKey))
        reviewContexts.current.set(work.id, context)
      }
      if (!context && work.kind === 'model') context = { images: [] }
      if (!context) throw new Error('当前作品没有保存原始素材，无法核对商品一致性')
      setPhase(`正在检查 · ${work.title}`)
      const output = await reviewImage(work.images[0].url)
      const text = await requestVision(buildQualityPrompt(work), [
        ...context.images,
        { label: '最后一张：本次生成的待检成图。', url: output },
      ], signal)
      updateWork(work.id, { quality: parseQualityReport(text) })
    } catch (error) {
      updateWork(work.id, { quality: {
        status: 'unavailable',
        summary: signal.aborted ? '检查已停止，图片已保留，可稍后继续检查。' : `检查未完成：${messageOf(error)}`,
        issues: [], checkedAt: new Date().toISOString(),
      } })
    }
  }

  async function reviewWork(work: Work) {
    if (busyRef.current || !connected) return
    busyRef.current = true
    setBusy(true)
    const controller = new AbortController()
    abortRef.current = controller
    try { await reviewGenerated(work, controller.signal) }
    finally {
      busyRef.current = false
      setBusy(false)
      setPhase('')
      abortRef.current = null
    }
  }

  async function verifySelectedModel() {
    if (busyRef.current || !connected) return
    busyRef.current = true
    setBusy(true)
    setPhase('正在确认模型的图片理解能力')
    setError('')
    const controller = new AbortController()
    abortRef.current = controller
    try {
      await ensureTextModel(controller.signal)
      setNotice('当前模型已通过图片理解校验')
    } catch (error) { setError(messageOf(error)) }
    finally {
      busyRef.current = false
      setBusy(false)
      setPhase('')
      abortRef.current = null
    }
  }

  async function assist(prompt: string, photos: Photo[]) {
    if (busyRef.current || connecting) throw new Error('请等待当前任务完成')
    if (!connected) {
      await connect()
      throw new Error('账户已连接，请再次点击 AI 帮写')
    }
    const controller = new AbortController()
    abortRef.current = controller
    busyRef.current = true
    setBusy(true)
    setPhase('正在分析素材与撰写文案')
    setError('')
    try {
      return await requestCopy(prompt, photos, controller.signal)
    } finally {
      busyRef.current = false
      setBusy(false)
      setPhase('')
      abortRef.current = null
    }
  }

  async function generateCommerce(request: CommerceRequest) {
    if (busyRef.current || connecting) throw new Error('请等待当前任务完成')
    if (!connected) {
      await connect()
      throw new Error('账户已连接，请确认模型后再次点击生成')
    }
    if (!model || !supports(model, 'edit'))
      throw new Error('请选择支持图片编辑的可用模型')
    const size = sizeForRatio(model, request.ratio)
    if (!size)
      throw new Error(`所选模型不支持 ${request.ratio}，请更换图片比例或模型`)
    if (!request.jobs.length || request.jobs.length > 24)
      throw new Error('每批需要 1 至 24 张图片')
    if (request.products.length > 6) throw new Error('商品原图最多 6 张')
    for (const job of request.jobs) {
      if (!request.products.length && !job.references?.length)
        throw new Error('请先上传商品或参考图片')
      referenceLayout(
        request.products.length,
        job.references?.length || 0,
        model.max_input_images || 0,
      )
    }
    if (!textModel)
      throw new Error('请先选择文案与图片理解模型，逐图策划和成图检查需要该模型')
    if (!storageReadyRef.current)
      throw new Error('作品存储尚未连接，请重新连接账户后生成')
    const batch = crypto.randomUUID()
    const controller = new AbortController()
    abortRef.current = controller
    busyRef.current = true
    setBusy(true)
    setError('')
    setFilter('all')
    setModuleBatches((previous) => ({ ...previous, [request.kind]: batch }))
    let jobs: Work[] = []
    try {
      setPhase('正在确认模型的图片理解能力')
      await ensureTextModel(controller.signal)
      setPhase('正在制定逐图创作计划')
      const planningInputs: ReviewContext['images'] = []
      if (request.products.length)
        planningInputs.push(...(await prepareReviewContext(request.products, [])).images)
      const references = [...new Map(request.jobs.flatMap(job => job.references || []).map(photo => [photo.id, photo])).values()]
      for (const photo of references) {
        if (controller.signal.aborted) throw new DOMException('已停止', 'AbortError')
        const context = await prepareReviewContext([], [photo])
        planningInputs.push({ ...context.images[0], label: `风格参考，绑定图片 ID：${photo.id}；名称：${photo.name}。` })
      }
      const plan = parseCommercePlan(await requestVision(
        buildPlanningPrompt(request), planningInputs, controller.signal,
      ), request)
      jobs = plan.jobs.map((job, position) => ({
        id: crypto.randomUUID(), batch, title: job.title,
        scene: KIND_LABELS[request.kind], pose: job.prompt,
        ratio: request.ratio, model: model.id,
        createdAt: new Date().toISOString(), kind: request.kind,
        status: 'queued', images: [], batchSize: plan.jobs.length, position,
        plan: { direction: plan.direction, brief: job.prompt },
      }))
      storeWorks([...jobs, ...worksRef.current].slice(0, 80))
      setPhase('正在保存创作计划与核对素材')
      const contexts = new Map<string, Promise<ReviewContext>>()
      for (let index = 0; index < jobs.length; index++) {
        if (controller.signal.aborted) throw new DOMException('已停止', 'AbortError')
        const refs = plan.jobs[index].references || []
        const cacheKey = refs.map(photo => photo.id).join('|')
        if (!contexts.has(cacheKey)) contexts.set(cacheKey, prepareReviewContext(request.products, refs))
        const context = await contexts.get(cacheKey)!
        const key = reviewContextKey(jobs[index].id)
        await client.storage.set(key, context)
        reviewContexts.current.set(jobs[index].id, context)
        jobs[index].reviewKey = key
        updateWork(jobs[index].id, { reviewKey: key })
      }
      // Verify durable metadata before submitting any image generation.
      await writeQueue.current
      await workStorageRef.current.save(worksRef.current)
      if (request.listingPrompt) {
        setPhase('正在撰写商品上架文案')
        const text = await requestCopy(request.listingPrompt, request.products, controller.signal)
        updateWork(jobs[0].id, { text })
      }
      const cache = new Map<string, Promise<File>>()
      const normalized = (photo: Photo) => {
        const key = photo.url
        if (!cache.has(key)) cache.set(key, normalizedFile(photo))
        return cache.get(key)!
      }
      let productSheet: Promise<File> | undefined
      await runCommerceJobs({
        api: client.api,
        works: jobs,
        signal: controller.signal,
        onUpdate: updateWork,
        onCompleted: async (work, images) => {
          const latest = worksRef.current.find(item => item.id === work.id) || work
          await reviewGenerated({ ...latest, images }, controller.signal)
        },
        onProgress: (index) =>
          setPhase(
            `正在生成 ${index + 1} / ${jobs.length} · ${jobs[index].title}`,
          ),
        prepare: async (index) => {
          const job = plan.jobs[index]
          const references = job.references || []
          const layout = referenceLayout(
            request.products.length,
            references.length,
            model.max_input_images || 0,
          )
          const files: File[] = []
          if (references.length)
            files.push(
              layout.referenceSheet
                ? await garmentSheet(references, 'STYLE')
                : await normalized(references[0]),
            )
          if (request.products.length) {
            if (layout.productSheet) {
              productSheet ||= garmentSheet(request.products, 'PRODUCT')
              files.push(await productSheet)
            } else
              files.push(
                ...(await Promise.all(request.products.map(normalized))),
              )
          }
          const body = new FormData()
          body.append('model', model.id)
          body.append('size', size)
          body.append('n', '1')
          body.append(
            'prompt',
            [
              referenceInstructions(
                request.products.length,
                references.length,
                layout.productSheet,
              ),
              job.prompt,
              '只生成当前要求的一张成品图片。',
            ]
              .filter(Boolean)
              .join('\n\n'),
          )
          for (const file of files) body.append('image[]', file)
          return body
        },
      })
      if (controller.signal.aborted)
        setNotice('后续生成已停止，已完成作品可下载。')
    } catch (error) {
      setError(
        controller.signal.aborted
          ? '已停止后续生成；已提交任务仍可能完成并计费，可在作品中继续查询。'
          : messageOf(error),
      )
    } finally {
      storeWorks(
        worksRef.current.map((work) =>
          work.batch === batch && work.status === 'queued'
            ? { ...work, status: 'skipped' }
            : work,
        ),
      )
      busyRef.current = false
      setBusy(false)
      setPhase('')
      abortRef.current = null
    }
  }

  async function downloadDetail(batch: string) {
    setDownloading(true)
    try {
      const parts = worksRef.current
        .filter((work) => work.batch === batch)
        .sort((a, b) => (a.position || 0) - (b.position || 0))
      if (
        !parts.length ||
        parts.length !== parts[0].batchSize ||
        parts.some((work) => work.status !== 'completed' || !work.images.length)
      )
        throw new Error('请保留并完成全部详情模块后导出长图')
      saveBlob(
        await stitchImages(parts.map((work) => work.images[0].url)),
        `detail-${Date.now()}.jpg`,
      )
    } catch (error) {
      setError(messageOf(error))
    } finally {
      setDownloading(false)
    }
  }

  function renderWorks(selected: Work[], title: string) {
    return (
      <WorksPanel
        works={selected}
        title={title}
        busy={busy}
        downloading={downloading}
        filter={filter}
        onFilter={setFilter}
        onDownload={(url) => void downloadOne(url)}
        onDownloadAll={() =>
          void downloadAll(
            selected.filter(
              (work) => filter === 'all' || work.status === filter,
            ),
          )
        }
        onPreview={showImage}
        onResume={(work) => void resume(work)}
        onReview={reviewWork}
        canReview={(work) => connected && Boolean(work.kind === 'model' || work.reviewKey || reviewContexts.current.has(work.id))}
        onRemove={(id) =>
          storeWorks(worksRef.current.filter((work) => work.id !== id))
        }
        onStart={() => {
          setView('studio')
          setTab('examples')
          setFilter('all')
        }}
        onStitch={(batch) => void downloadDetail(batch)}
        onCopy={(text) =>
          void navigator.clipboard
            .writeText(text)
            .then(() => setNotice('文案已复制'))
            .catch(() => setError('复制失败，可选中文案复制或打包下载'))
        }
      />
    )
  }

  function renderModules() {
    const shared = {
      busy,
      connected,
      connecting,
      models,
      modelId,
      onModelChange: setModelId,
      onError: setError,
      onPreview: showImage,
      onStop: () => abortRef.current?.abort(),
      onAssist: assist,
      onConnect: () => void connect().catch(() => undefined),
      phase,
    }
    return (
      <>
        <div
          className="module-host"
          hidden={view !== 'studio' || module !== 'product'}
        >
          <ProductModule
            key={`product-${resetKey}`}
            {...shared}
            model={model}
            results={renderWorks(
              works.filter((work) => work.batch === moduleBatches.product),
              '商品套图',
            )}
            onGenerate={(request: ProductRequest) =>
              generateCommerce({
                kind: 'product',
                ratio: request.ratio,
                products: request.photos,
                jobs: request.outputs,
                planningMode: request.planningMode,
                planningPrompt: request.planningPrompt,
                listingPrompt: request.listingPrompt,
              })
            }
          />
        </div>
        <div
          className="module-host"
          hidden={view !== 'studio' || module !== 'detail'}
        >
          <DetailModule
            key={`detail-${resetKey}`}
            {...shared}
            results={renderWorks(
              works.filter((work) => work.batch === moduleBatches.detail),
              '详情模块',
            )}
            onGenerate={(request: ContentModuleRequest) =>
              generateCommerce(request)
            }
          />
        </div>
        <div
          className="module-host"
          hidden={view !== 'studio' || module !== 'clone'}
        >
          <CloneModule
            key={`clone-${resetKey}`}
            {...shared}
            results={renderWorks(
              works.filter((work) => work.batch === moduleBatches.clone),
              '复刻作品',
            )}
            onGenerate={(request: ContentModuleRequest) =>
              generateCommerce(request)
            }
          />
        </div>
      </>
    )
  }

  async function downloadOne(url: string) {
    try {
      const blob = await fetchImage(url)
      saveBlob(blob, `design-${Date.now()}.${imageExtension(blob)}`)
    } catch (e) {
      setError(messageOf(e))
    }
  }

  async function downloadAll(selectedWorks: Work[] = visibleWorks) {
    setDownloading(true)
    setError('')
    try {
      const files: Record<string, Uint8Array> = {}
      let index = 0
      for (const work of selectedWorks)
        for (const image of work.images) {
          const blob = await fetchImage(image.url)
          files[
            `${String(++index).padStart(2, '0')}-${work.title}.${imageExtension(blob)}`
          ] = new Uint8Array(await blob.arrayBuffer())
        }
      for (const work of selectedWorks)
        if (work.text)
          files[`listing-${work.id}.txt`] = new TextEncoder().encode(work.text)
      if (!Object.keys(files).length) throw new Error('暂无可下载的作品')
      saveBlob(
        new Blob([zipSync(files, { level: 0 })]),
        `design-${Date.now()}.zip`,
      )
    } catch (e) {
      setError(messageOf(e))
    } finally {
      setDownloading(false)
    }
  }

  function newProject() {
    if (busyRef.current) return
    setResetKey((key) => key + 1)
    setModuleBatches({})
    setGarments([])
    setExtra('')
    setCustomScene('')
    setScenes(['studio'])
    setAutoScene(false)
    setView('studio')
    setTab('examples')
    setError('')
    setBatchId('')
    setFilter('all')
  }

  const showImage = (url: string, title: string) => {
    setCompare(false)
    setSplit(50)
    setLightbox({ url, title })
  }
  const peopleButtons = (all: boolean) =>
    (all
      ? [...customPeople, ...PEOPLE]
      : [...customPeople, ...PEOPLE].slice(0, 7)
    ).map((p) => (
      <button
        type="button"
        key={p.id}
        className={`person ${person.id === p.id ? 'selected' : ''}`}
        onClick={() => {
          setPerson(p)
          setPeopleDialog(false)
        }}
        aria-label={`选择${p.name}`}
        aria-pressed={person.id === p.id}
        title={p.name}
        disabled={busy}
      >
        <img src={p.url} alt={p.name} loading="lazy" />
        {person.id === p.id && (
          <span className="selection-check">
            <Check size={12} />
          </span>
        )}
      </button>
    ))

  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="brand">
          <span className="brand-mark">
            <Scissors size={20} />
          </span>
          <strong>
            衣境<span>设计室</span>
          </strong>
          <span className="brand-divider" />
          <span className="workspace-name">商品创作</span>
        </div>
        <div className="header-actions">
          <button
            className="secondary"
            onClick={() => setModelDialog(true)}
            disabled={busy}
            aria-label="生成模型设置"
          >
            <SlidersHorizontal size={16} />
            <span className="model-settings-label">生成设置</span>
          </button>
          <button
            className="secondary new-project"
            onClick={newProject}
            disabled={busy}
          >
            <Plus size={16} />
            新建任务
          </button>
          <button
            className={`account ${connected ? 'connected' : ''}`}
            onClick={() => void connect().catch(() => undefined)}
            disabled={connecting || busy}
          >
            {connecting ? (
              <LoaderCircle size={16} className="spin" />
            ) : (
              <UserRound size={16} />
            )}
            <span>
              {connecting ? '连接中' : connected ? '账户已连接' : '连接账户'}
            </span>
          </button>
        </div>
      </header>
      {loginURL && connecting && <div className="global-progress" role="status"><span>请在平台登录窗口完成账户连接。</span><a href={loginURL} target="_blank" rel="noreferrer">打开登录页面</a></div>}
      {error && (
        <div className="error-banner global-error" role="alert">
          <CircleAlert size={17} />
          <span>{error}</span>
          <IconButton label="关闭错误提示" onClick={() => setError('')}>
            <X size={16} />
          </IconButton>
        </div>
      )}
      {busy && (
        <div className="global-progress" role="status">
          <LoaderCircle size={15} className="spin" />
          <span>{phase}</span>
          <button onClick={() => abortRef.current?.abort()}>
            停止后续生成
          </button>
        </div>
      )}
      <div className="app-body">
        <nav className="rail" aria-label="工作区导航">
          {(
            [
              { id: 'product', name: '商品套图', icon: Package },
              { id: 'detail', name: 'A+ 详情', icon: PanelsTopLeft },
              { id: 'tryon', name: '服饰穿戴', icon: Shirt },
              { id: 'clone', name: '爆款复刻', icon: Copy },
            ] as const
          ).map((item) => (
            <button
              key={item.id}
              className={
                view === 'studio' && module === item.id ? 'active' : ''
              }
              aria-current={
                view === 'studio' && module === item.id ? 'page' : undefined
              }
              disabled={busy}
              onClick={() => {
                setModule(item.id)
                setView('studio')
                setError('')
                setFilter('all')
              }}
            >
              <item.icon size={22} />
              <span>{item.name}</span>
            </button>
          ))}
          <button
            className={view === 'works' ? 'active' : ''}
            onClick={() => {
              setView('works')
              setFilter('all')
            }}
            aria-current={view === 'works' ? 'page' : undefined}
          >
            <Images size={22} />
            <span>我的作品</span>
            {works.length > 0 && <small>{works.length}</small>}
          </button>
          <div className="rail-bottom">
            <span>DESIGN</span>
            <span>STUDIO</span>
          </div>
        </nav>
        {view === 'studio' && module === 'tryon' && (
          <aside ref={settingsRef} className="settings" aria-label="拍摄设置">
            <div className="settings-scroll">
              <div className="section-title">
                <h2>服装图片</h2>
                <span>{garments.length} / 6</span>
              </div>
              <input
                ref={garmentInput}
                type="file"
                accept="image/png,image/jpeg,image/webp"
                multiple
                className="sr-only"
                aria-label="上传服装图片"
                onChange={(e) => {
                  void addFiles(Array.from(e.target.files || []), 'garment')
                  e.target.value = ''
                }}
                disabled={busy || processingPhotos}
              />
              <div
                className={`upload-zone ${garments.length ? 'has-photos' : ''}`}
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => {
                  e.preventDefault()
                  void addFiles(Array.from(e.dataTransfer.files), 'garment')
                }}
              >
                {garments.length ? (
                  <div className="garment-grid">
                    {garments.map((photo, i) => (
                      <div className="garment" key={photo.id}>
                        <button
                          onClick={() => showImage(photo.url, `服装 ${i + 1}`)}
                          aria-label={`预览服装 ${i + 1}`}
                        >
                          <img src={photo.url} alt={`服装 ${i + 1}`} />
                        </button>
                        <IconButton
                          label={`移除服装 ${i + 1}`}
                          className="remove-photo"
                          disabled={busy}
                          onClick={() =>
                            setGarments((previous) =>
                              previous.filter((p) => p.id !== photo.id),
                            )
                          }
                        >
                          <X size={12} />
                        </IconButton>
                      </div>
                    ))}
                    {garments.length < 6 && (
                      <button
                        className="add-garment"
                        disabled={busy || processingPhotos}
                        onClick={() => garmentInput.current?.click()}
                        aria-label="添加服装图片"
                      >
                        <Plus size={22} />
                      </button>
                    )}
                  </div>
                ) : (
                  <button
                    className="upload-empty"
                    disabled={busy || processingPhotos}
                    onClick={() => garmentInput.current?.click()}
                  >
                    <span className="upload-symbol">
                      <ImagePlus size={23} />
                    </span>
                    <strong>
                      {processingPhotos ? '正在读取图片' : '上传服装图片'}
                    </strong>
                    <span>JPG / PNG / WebP · 每张不超过 10 MB</span>
                  </button>
                )}
              </div>

              <section className="setting-section">
                <div className="section-title">
                  <h2>模特形象</h2>
                  <span>{person.name}</span>
                </div>
                <div className="segmented" role="group" aria-label="模特来源">
                  <button
                    aria-pressed={peopleTab === 'library'}
                    className={peopleTab === 'library' ? 'selected' : ''}
                    onClick={() => setPeopleTab('library')}
                  >
                    <UserRound size={14} />
                    模特库
                  </button>
                  <button
                    aria-pressed={peopleTab === 'ai'}
                    className={peopleTab === 'ai' ? 'selected' : ''}
                    onClick={() => setPeopleTab('ai')}
                  >
                    <Sparkles size={14} />
                    AI 生成
                  </button>
                </div>
                {peopleTab === 'library' ? (
                  <>
                    <div className="people-grid">
                      <button
                        className="person add-person"
                        onClick={() => personInput.current?.click()}
                        disabled={busy || processingPhotos}
                        aria-label="上传新模特"
                      >
                        <Plus size={22} />
                        <span>上传模特</span>
                      </button>
                      {peopleButtons(false)}
                    </div>
                    <button
                      className="text-button all-models"
                      onClick={() => setPeopleDialog(true)}
                    >
                      全部模特 <ArrowRight size={13} />
                    </button>
                  </>
                ) : (
                  <div className="model-generator">
                    <label htmlFor="model-description">模特描述</label>
                    <textarea
                      id="model-description"
                      value={modelDescription}
                      maxLength={600}
                      rows={4}
                      onChange={(e) => setModelDescription(e.target.value)}
                      disabled={busy}
                    />
                    <button
                      className="secondary full"
                      disabled={busy || connecting}
                      onClick={() => void generate('model')}
                    >
                      <Sparkles size={15} />
                      生成模特
                    </button>
                  </div>
                )}
                <input
                  ref={personInput}
                  type="file"
                  accept="image/png,image/jpeg,image/webp"
                  className="sr-only"
                  aria-label="上传模特图片"
                  onChange={(e) => {
                    void addFiles(Array.from(e.target.files || []), 'person')
                    e.target.value = ''
                  }}
                />
              </section>

              <section className="setting-section">
                <div className="section-title">
                  <h2>拍摄场景</h2>
                  <label className="toggle-label">
                    AI 推荐
                    <input
                      type="checkbox"
                      checked={autoScene}
                      onChange={(e) => setAutoScene(e.target.checked)}
                      disabled={busy}
                    />
                    <span className="toggle-track" />
                  </label>
                </div>
                <div
                  className={`scene-grid ${autoScene || customScene.trim() ? 'muted' : ''}`}
                >
                  {SCENES.map((s) => (
                    <label
                      key={s.id}
                      className={`scene-option ${scenes.includes(s.id) ? 'selected' : ''}`}
                    >
                      <input
                        type="checkbox"
                        checked={scenes.includes(s.id)}
                        disabled={busy || autoScene || !!customScene.trim()}
                        onChange={() =>
                          setScenes((previous) =>
                            previous.includes(s.id)
                              ? previous.filter((id) => id !== s.id)
                              : [...previous, s.id],
                          )
                        }
                      />
                      <span
                        className="scene-swatch"
                        style={{ background: s.color }}
                      />
                      <span>{s.name}</span>
                    </label>
                  ))}
                </div>
                <textarea
                  className="scene-description"
                  aria-label="自定义拍摄场景"
                  placeholder="自定义场景（可选）"
                  rows={2}
                  maxLength={600}
                  value={customScene}
                  onChange={(e) => setCustomScene(e.target.value)}
                  disabled={busy}
                />
              </section>

              <section className="setting-section">
                <div className="section-title">
                  <h2>图片比例</h2>
                  <span>
                    {model
                      ? sizeForRatio(model, ratio) || '当前不可用'
                      : '画幅'}
                  </span>
                </div>
                <div className="ratio-options">
                  {RATIOS.map((r) => (
                    <button
                      key={r}
                      className={ratio === r ? 'selected' : ''}
                      aria-pressed={ratio === r}
                      aria-label={`比例 ${r}`}
                      onClick={() => setRatio(r)}
                      disabled={busy || (!!model && !sizeForRatio(model, r))}
                    >
                      <span
                        className="ratio-shape"
                        style={{ aspectRatio: r.replace(':', '/') }}
                      />
                      <span>{r}</span>
                    </button>
                  ))}
                </div>
              </section>

              <section className="setting-section">
                <div className="section-title">
                  <h2>拍摄姿势</h2>
                  <span>{poseIds.length} 个镜头</span>
                </div>
                <div className="pose-options">
                  {POSES.map((p) => (
                    <label key={p.id}>
                      <input
                        type="checkbox"
                        checked={poseIds.includes(p.id)}
                        disabled={busy}
                        onChange={() =>
                          setPoseIds((previous) =>
                            previous.includes(p.id)
                              ? previous.filter((id) => id !== p.id)
                              : [...previous, p.id],
                          )
                        }
                      />
                      {p.name}
                    </label>
                  ))}
                </div>
              </section>

              <details className="advanced">
                <summary>
                  <SlidersHorizontal size={14} />
                  更多设置
                  <ChevronDown size={14} />
                </summary>
                <label htmlFor="image-model">生成模型</label>
                <div className="model-select">
                  <select
                    id="image-model"
                    value={modelId}
                    disabled={busy}
                    onChange={(e) => setModelId(e.target.value)}
                  >
                    <option value="">
                      {connected ? '请选择模型' : '账户尚未连接'}
                    </option>
                    {models.map((m) => (
                      <option
                        key={m.id}
                        value={m.id}
                        disabled={m.available === false}
                      >
                        {m.name || m.id}
                        {m.available === false ? '（暂不可用）' : ''}
                      </option>
                    ))}
                  </select>
                  <IconButton
                    label="刷新模型"
                    onClick={() => void connect().catch(() => undefined)}
                    disabled={connecting || busy}
                  >
                    <RefreshCw size={15} />
                  </IconButton>
                </div>
                <label htmlFor="text-model">场景推荐模型</label>
                <select
                  id="text-model"
                  value={textModel}
                  disabled={busy}
                  onChange={(e) => setTextModel(e.target.value)}
                >
                  <option value="">请选择模型</option>
                  {textModels.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name}
                    </option>
                  ))}
                </select>
                <label htmlFor="extra">补充要求</label>
                <textarea
                  id="extra"
                  placeholder="面料细节、构图、光线…"
                  value={extra}
                  maxLength={1000}
                  rows={3}
                  onChange={(e) => setExtra(e.target.value)}
                  disabled={busy}
                />
              </details>
            </div>
            <div className="generate-footer">
              {busy ? (
                <>
                  <div className="generation-summary">
                    <LoaderCircle className="spin" size={14} />
                    <span>{phase}</span>
                  </div>
                  <button
                    className="secondary full"
                    onClick={() => abortRef.current?.abort()}
                  >
                    <Square size={14} />
                    停止后续生成
                  </button>
                </>
              ) : (
                <>
                  <div className="generation-summary">
                    <span>
                      {garments.length} 张服装 · {poseIds.length} 个姿势
                    </span>
                    <span>共 {outputCount} 张</span>
                  </div>
                  <button
                    className="primary full"
                    disabled={
                      !garments.length ||
                      !poseIds.length ||
                      connecting ||
                      processingPhotos
                    }
                    onClick={() => void generate('tryon')}
                  >
                    <WandSparkles size={18} />
                    {!garments.length
                      ? '上传服装后开始'
                      : connected
                        ? `生成 ${outputCount} 张试穿图`
                        : '连接账户并创作'}
                    <ArrowRight size={16} />
                  </button>
                </>
              )}
            </div>
          </aside>
        )}

        {(view === 'works' || module === 'tryon') && (
          <main className="workspace">
            <div className="workspace-heading">
              <div>
                <div className="eyebrow">
                  {view === 'works' ? 'YOUR COLLECTION' : 'VIRTUAL TRY-ON'}
                </div>
                <h1>{view === 'works' ? '我的作品' : 'AI 服饰穿戴'}</h1>
              </div>
              <div className="workspace-actions">
                {view === 'studio' && (
                  <button
                    className="secondary mobile-settings-button"
                    onClick={() =>
                      settingsRef.current?.scrollIntoView({
                        behavior: 'smooth',
                        block: 'start',
                      })
                    }
                  >
                    <SlidersHorizontal size={15} />
                    拍摄设置
                  </button>
                )}
                <span className="workspace-label">
                  <span />
                  {busy ? '拍摄进行中' : '创作工作台'}
                </span>
              </div>
            </div>
            {view === 'studio' && (
              <div className="workspace-tabs">
                <div role="group" aria-label="工作台视图">
                  <button
                    className={tab === 'examples' ? 'active' : ''}
                    onClick={() => setTab('examples')}
                  >
                    灵感参考
                  </button>
                  <button
                    className={tab === 'results' ? 'active' : ''}
                    onClick={() => setTab('results')}
                  >
                    本次作品{' '}
                    {works.filter((w) => w.batch === batchId).length > 0 && (
                      <span>
                        {works.filter((w) => w.batch === batchId).length}
                      </span>
                    )}
                  </button>
                </div>
                {tab === 'examples' && (
                  <span>
                    LOOKBOOK / {String(exampleIndex + 1).padStart(2, '0')}
                  </span>
                )}
              </div>
            )}

            {view === 'studio' && tab === 'examples' ? (
              <div className="example-workspace">
                <div className="example-title">
                  <div>
                    <h2>{example.title}</h2>
                    <p>{example.subtitle}</p>
                  </div>
                  <button
                    className="secondary"
                    onClick={applyExample}
                    disabled={busy}
                  >
                    <SquarePlus size={15} />
                    使用这组素材
                  </button>
                </div>
                <div className="lookbook">
                  <div className="reference-column">
                    <div className="lookbook-label">
                      服装参考<span>{example.clothes.length} 件</span>
                    </div>
                    <div className="sample-garments">
                      {example.clothes.map((i) => (
                        <button
                          key={i}
                          onClick={() =>
                            showImage(
                              asset(`sample-${String(i).padStart(2, '0')}`),
                              '服装参考',
                            )
                          }
                          aria-label="查看示例服装"
                        >
                          <img
                            src={asset(`sample-${String(i).padStart(2, '0')}`)}
                            alt="示例服装"
                          />
                        </button>
                      ))}
                    </div>
                    <span className="reference-caption">GARMENT</span>
                  </div>
                  <div className="lookbook-arrow">
                    <ArrowRight size={19} />
                  </div>
                  <div className="sample-results">
                    {example.outputs.map((i, index) => (
                      <figure key={i}>
                        <button
                          onClick={() =>
                            showImage(
                              asset(`sample-${String(i).padStart(2, '0')}`),
                              `${example.title} · 示例 ${index + 1}`,
                            )
                          }
                          aria-label={`查看试穿示例 ${index + 1}`}
                        >
                          <img
                            src={asset(`sample-${String(i).padStart(2, '0')}`)}
                            alt={`${example.title}试穿示例 ${index + 1}`}
                          />
                          <span className="image-expand">
                            <Expand size={17} />
                          </span>
                        </button>
                        <figcaption>
                          <span>
                            {['全身造型', '细节镜头', '自然姿态'][index]}
                          </span>
                          <span>0{index + 1}</span>
                        </figcaption>
                      </figure>
                    ))}
                  </div>
                </div>
                <div className="example-footer">
                  <div className="example-dots">
                    {EXAMPLES.map((e, i) => (
                      <button
                        key={e.title}
                        className={i === exampleIndex ? 'active' : ''}
                        aria-label={`查看${e.title}参考`}
                        aria-pressed={i === exampleIndex}
                        onClick={() => setExampleIndex(i)}
                      />
                    ))}
                  </div>
                  <span>参考作品</span>
                  <div className="example-navigation">
                    <IconButton
                      label="上一组参考"
                      onClick={() =>
                        setExampleIndex(
                          (exampleIndex + EXAMPLES.length - 1) %
                            EXAMPLES.length,
                        )
                      }
                    >
                      <ArrowLeft size={17} />
                    </IconButton>
                    <IconButton
                      label="下一组参考"
                      onClick={() =>
                        setExampleIndex((exampleIndex + 1) % EXAMPLES.length)
                      }
                    >
                      <ArrowRight size={17} />
                    </IconButton>
                  </div>
                </div>
                <div className="example-strip">
                  {EXAMPLES.map((e, i) => (
                    <button
                      key={e.title}
                      className={exampleIndex === i ? 'active' : ''}
                      onClick={() => setExampleIndex(i)}
                    >
                      <img
                        src={asset(
                          `sample-${String(e.outputs[0]).padStart(2, '0')}`,
                        )}
                        alt=""
                      />
                      <span>
                        <strong>{e.title}</strong>
                        <small>{e.subtitle.split(' / ')[0]}</small>
                      </span>
                      <ArrowRight size={16} />
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              renderWorks(
                view === 'works'
                  ? works
                  : works.filter((work) => work.batch === batchId),
                view === 'works' ? '全部创作' : '拍摄结果',
              )
            )}
            <footer className="workspace-footer">
              <span>衣境设计室</span>
              <span>
                {view === 'studio' && tab === 'examples'
                  ? '服饰摄影灵感'
                  : connected
                    ? '作品按当前账户保存'
                    : '账户尚未连接'}
              </span>
            </footer>
          </main>
        )}
        {renderModules()}
      </div>
      {notice && (
        <div className="toast" role="status">
          <Check size={16} />
          {notice}
        </div>
      )}
      {modelDialog && (
        <Dialog title="生成模型设置" onClose={() => setModelDialog(false)}>
          <div className="model-dialog-fields">
            <label>
              图片模型
              <select
                aria-label="全局图片模型"
                disabled={busy}
                value={modelId}
                onChange={(e) => setModelId(e.target.value)}
              >
                <option value="">
                  {connected ? '选择图片模型' : '请先连接账户'}
                </option>
                {models
                  .filter((m) => supports(m, 'edit'))
                  .map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name || m.id}
                    </option>
                  ))}
              </select>
            </label>
            <label>
              文案与图片理解模型
              <select
                aria-label="文案与图片理解模型"
                disabled={busy}
                value={textModel}
                onChange={(e) => setTextModel(e.target.value)}
              >
                <option value="">
                  {connected ? '选择文本模型' : '请先连接账户'}
                </option>
                {textModels.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                  </option>
                ))}
              </select>
            </label>
            <p>逐图策划、AI 帮写和成图核对使用文本模型，图片由图片模型生成。核对报告会随作品保存。</p>
            <p role="status">{textModel && verifiedModels.includes(textModel) ? '当前文本模型已通过图片理解校验。' : '首次使用会进行一次图片理解校验。策划、核对和生图均使用账户模型额度。'}</p>
            <button className="secondary" disabled={!connected || !textModel || busy} onClick={() => void verifySelectedModel()}>
              校验图片理解能力
            </button>
            <button
              className="secondary"
              onClick={() => void connect().catch(() => undefined)}
              disabled={connecting}
            >
              {connecting ? '连接中…' : '连接账户并刷新模型'}
            </button>
          </div>
        </Dialog>
      )}
      {peopleDialog && (
        <Dialog title="模特库" onClose={() => setPeopleDialog(false)}>
          <div className="library-grid">{peopleButtons(true)}</div>
        </Dialog>
      )}
      {lightbox && (
        <Dialog title={lightbox.title} wide onClose={() => setLightbox(null)}>
          <div className="preview-tools">
            {module === 'tryon' && view === 'studio' && (
              <button
                className={`secondary ${compare ? 'pressed' : ''}`}
                onClick={() => setCompare(!compare)}
              >
                <Columns2 size={16} />
                模特对比
              </button>
            )}
            <button
              className="secondary"
              onClick={() => void downloadOne(lightbox.url)}
            >
              <Download size={16} />
              下载图片
            </button>
          </div>
          <div className="lightbox-image">
            <img src={lightbox.url} alt={lightbox.title} />
            {compare && (
              <div
                className="comparison-layer"
                style={{ clipPath: `inset(0 ${100 - split}% 0 0)` }}
              >
                <img src={person.url} alt="当前模特参考" />
              </div>
            )}
            {compare && (
              <div className="comparison-line" style={{ left: `${split}%` }} />
            )}
          </div>
          {compare && (
            <label className="compare-control">
              当前模特
              <input
                aria-label="模特对比位置"
                type="range"
                min="0"
                max="100"
                value={split}
                onChange={(e) => setSplit(Number(e.target.value))}
              />
              预览图片
            </label>
          )}
        </Dialog>
      )}
    </div>
  )
}

createRoot(document.getElementById('root')!).render(<App />)
