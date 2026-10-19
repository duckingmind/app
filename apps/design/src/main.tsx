import React, { useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { agent, createAppClient, readAppSessionFromStorage } from '@ducking-mind/proxy-app-sdk'
import {
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
  RefreshCw,
  Shirt,
  SlidersHorizontal,
  Sparkles,
  SquarePlus,
  UserRound,
  WandSparkles,
  X,
} from 'lucide-react'
import manifest from '../manifest.json'
import { capability } from './agent-tools.mjs'
import {
  buildTryOnPrompt,
  imageModelAvailabilityMessage,
  TerminalTaskError,
  POSES,
  responseText,
  friendlyErrorMessage,
  friendlyResourceErrorMessage,
  resourceDiagnosticList,
  SCENES,
  selectImageEditModel,
  sizeForRatio,
  type ImageModel,
  type ResourceDiagnostic,
  type Work,
} from './core.ts'
import {
  dataURL,
  readPhoto,
  fetchImage,
  garmentSheet,
  imageExtension,
  normalizedFile,
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
import { DropdownSelect } from './DropdownSelect.tsx'
import {
  referenceInstructions,
  referenceLayout,
  runCommerceJobs,
  type CommerceRequest,
  type ImageJobActivity,
} from './commerce.ts'
import { selectTextModel, verifyVisionModel, type TextModelChoice } from './textModels.ts'
import { buildPlanningPrompt, parseCommercePlan } from './planning.ts'
import { buildQualityPrompt, parseQualityReport } from './quality.ts'
import { prepareReviewContext, type ReviewContext } from './reviewContext.ts'
import { refreshWorkMedia } from './workMedia.ts'
import { createWorkStorage } from './workStorage.ts'
import { loadModelCatalog, type ModelCatalog } from './modelCatalog.ts'
import { accountConnectionFailure, assertCanStartAccountLogin, connectAccount, isAccountScopeUnavailableError, loadWorkspaceResources, requiresAccountRecovery, type AccountConnectionAction, type WorkspaceResource } from './accountConnection.ts'
import { TaskActivity } from './TaskActivity.tsx'
import { FeedbackLayer } from './FeedbackLayer.tsx'
import { createWorksArchive } from './workDownload.ts'
import { usePhotos } from './usePhotos.ts'
import { imageModelIssue, imageModelOptions } from './modelOptions.ts'
import { setDesignGatewayURL } from './network-boundary.ts'
import {
  commitDesignRoute,
  readDesignRoute,
  sameDesignRoute,
  type DesignModule,
  type DesignRoute,
  type DesignView,
} from './navigation.ts'
import { commerceForDesign, createDesignAgent, type DesignAgentConfig, type DesignAgentHost } from './designAgent.ts'
import './styles.css'
import './navigation.css'
import './studioTheme.css'

let handleLoginRequired: ((url?: string) => void) | undefined
const electronHost = typeof window !== 'undefined' && Boolean((window as Window & { proxyApp?: unknown }).proxyApp)
const appSession = !import.meta.env.DEV && !electronHost ? readAppSessionFromStorage(manifest.id) : undefined
const client = createAppClient(manifest.id, {
  runtime: import.meta.env.DEV ? 'local' : electronHost ? 'electron' : 'direct',
  ...(appSession ? { appSession } : {}),
  localDevelopment: import.meta.env.DEV,
  localAppVersion: manifest.version,
  onLoginRequired: details => {
    handleLoginRequired?.(details?.login_url)
  },
})
const assets = import.meta.glob<string>('./assets/*.webp', {
  eager: true,
  query: '?url',
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
const STUDIO_NAV_ITEMS = [
  { id: 'product', name: '商品套图', icon: Package },
  { id: 'detail', name: 'A+ 详情', icon: PanelsTopLeft },
  { id: 'tryon', name: '服饰穿戴', icon: Shirt },
  { id: 'clone', name: '爆款复刻', icon: Copy },
] as const
const RATIOS = ['3:4', '1:1', '9:16', '2:3', '16:9']
const canOpenModelSettings = (message: string) =>
  /模型|上游|供应通道|额度|并发|图片编辑服务暂不可用/i.test(message)
const RESOURCE_LABELS: Record<WorkspaceResource, string> = {
  models: '模型列表',
  history: '作品记录',
  preferences: '偏好设置',
}
const resourceErrorSummary = (errors: Partial<Record<WorkspaceResource, string>>) => {
  return (Object.keys(errors) as WorkspaceResource[]).filter(key => errors[key]).map(key => RESOURCE_LABELS[key]).join('、')
}
function resourceDiagnosticText(diagnostics: ResourceDiagnostic[] | undefined) {
  if (!diagnostics?.length) return ''
  return diagnostics.map(({ code, status, requestId }) => [
    code ? `代码 ${code}` : '',
    status !== undefined ? `状态 ${status}` : '',
    requestId ? `请求 ${requestId}` : '',
  ].filter(Boolean).join(' · ')).filter(Boolean).join('；')
}
function imageActivityMessage(activity: ImageJobActivity) {
  const parts = [
    activity.running ? `正在生成 ${activity.running} 张` : activity.queued && !activity.failed && !activity.paused ? '准备生成' : '',
    `已出图 ${activity.completed}/${activity.total}`,
    activity.reviewing ? `正在检查 ${activity.reviewing} 张` : '',
    activity.reviewQueued ? `待检查 ${activity.reviewQueued} 张` : '',
    activity.failed ? `失败 ${activity.failed} 张` : '',
    activity.paused ? `待查询 ${activity.paused} 张` : '',
  ]
  return parts.filter(Boolean).join(' · ')
}

function cancellationMessage(tasks: Work[]) {
  const submitted = tasks.some((task) =>
    Boolean(task.taskId) ||
    ['completed', 'paused'].includes(task.status) ||
    (task.status === 'failed' && /已提交|仍可能/.test(task.error || '')),
  )
  return submitted
    ? '已停止后续生成；已提交的图片任务仍可能完成并计费。'
    : '已取消当前任务，尚未提交生图请求。'
}

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
  const titleId = React.useId()
  useEffect(() => {
    const dialog = ref.current!
    const previous = document.activeElement
    dialog.showModal()
    return () => {
      dialog.close()
      if (previous instanceof HTMLElement && previous.isConnected)
        previous.focus({ preventScroll: true })
    }
  }, [])
  return (
    <dialog
      ref={ref}
      className={wide ? 'dialog wide' : 'dialog'}
      aria-labelledby={titleId}
      onCancel={(event) => { event.preventDefault(); onClose() }}
      onClick={(e) => {
        if (e.target === ref.current) onClose()
      }}
    >
      <div className="dialog-heading">
        <h2 id={titleId}>{title}</h2>
        <IconButton label="关闭" onClick={onClose}>
          <X size={20} />
        </IconButton>
      </div>
      {children}
    </dialog>
  )
}

type AgentExecution = { batchId: string; config: DesignAgentConfig; photos: Map<string, Photo>; controller: AbortController }

function App() {
  const [agentDraft, setAgentDraft] = useState<{ config: DesignAgentConfig; assets: Array<{ id: string; name: string }> } | null>(null)
  const agentHostRef = useRef<DesignAgentHost | null>(null)
  const [module, setModule] = useState<DesignModule>(() => readDesignRoute(window.location).module)
  const [resetKey, setResetKey] = useState(0)
  const [moduleBatches, setModuleBatches] = useState<Record<string, string>>({})
  const [modelDialog, setModelDialog] = useState(false)
  const garmentPhotos = usePhotos(6, message => setError(message))
  const { photos: garments, setPhotos: setGarments } = garmentPhotos
  const [person, setPerson] = useState<Photo>(PEOPLE[0])
  const peoplePhotos = usePhotos(25, message => setError(message))
  const { photos: customPeople, setPhotos: setCustomPeople } = peoplePhotos
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
  const [connecting, setConnecting] = useState(true)
  const [connectionError, setConnectionError] = useState('')
  const [connectionAction, setConnectionAction] = useState<AccountConnectionAction>('check')
  const [hostLoginRequired, setHostLoginRequired] = useState(false)
  const [accountRecovery, setAccountRecovery] = useState(false)
  const [restoringResources, setRestoringResources] = useState(false)
  const [resourceErrors, setResourceErrors] = useState<Partial<Record<WorkspaceResource, string>>>({})
  const [resourceDiagnostics, setResourceDiagnostics] = useState<Partial<Record<WorkspaceResource, ResourceDiagnostic[]>>>({})
  const [resourceToastDismissed, setResourceToastDismissed] = useState(false)
  const [refreshingModels, setRefreshingModels] = useState(false)
  const [loginURL, setLoginURL] = useState('')
  const [busy, setBusy] = useState(false)
  const [generationCount, setGenerationCount] = useState(0)
  const [phase, setPhase] = useState('')
  const [notice, setNotice] = useState('')
  const [error, setError] = useState('')
  const [works, setWorks] = useState<Work[]>([])
  const [view, setView] = useState<DesignView>(() => readDesignRoute(window.location).view)
  const [exampleIndex, setExampleIndex] = useState(0)
  const [lightbox, setLightbox] = useState<{
    url: string
    title: string
  } | null>(null)
  const [compare, setCompare] = useState(false)
  const [split, setSplit] = useState(50)
  const [peopleDialog, setPeopleDialog] = useState(false)
  const [downloading, setDownloading] = useState(false)
  const processingPhotos = garmentPhotos.loading || peoplePhotos.loading
  const [filter, setFilter] = useState('all')
  const [settingsRequest, setSettingsRequest] = useState(0)
  const [productSettingsRequest, setProductSettingsRequest] = useState(0)
  const handledSettingsRequest = useRef(0)
  const settingsRef = useRef<HTMLElement>(null)
  const garmentInput = useRef<HTMLInputElement>(null)
  const personInput = useRef<HTMLInputElement>(null)
  const abortRef = useRef<AbortController | null>(null)
  const busyRef = useRef(false)
  // Image batches have independent cancellation and lifecycle state. Keep the
  // legacy busy flag for non-generation operations so generation can remain
  // responsive while another batch is already running.
  const generationControllersRef = useRef(new Set<AbortController>())
  const generationMetaRef = useRef(new Map<string, {
    controller: AbortController
    label: string
    phase: string
  }>())
  function syncGenerationPhase() {
    const summary = [...generationMetaRef.current.values()]
      .map(({ label, phase: currentPhase }) => `${label}：${currentPhase}`)
      .join(' · ')
    setPhase(summary)
  }
  function registerGeneration(batch: string, label: string, controller: AbortController, initialPhase: string) {
    generationControllersRef.current.add(controller)
    generationMetaRef.current.set(batch, { controller, label, phase: initialPhase })
    setGenerationCount(generationMetaRef.current.size)
    syncGenerationPhase()
  }
  function updateGenerationPhase(batch: string, currentPhase: string) {
    const entry = generationMetaRef.current.get(batch)
    if (!entry) return
    entry.phase = currentPhase
    syncGenerationPhase()
  }
  function finishGeneration(batch: string, controller: AbortController) {
    generationControllersRef.current.delete(controller)
    generationMetaRef.current.delete(batch)
    setGenerationCount(generationMetaRef.current.size)
    if (generationMetaRef.current.size) syncGenerationPhase()
    else if (!busyRef.current) setPhase('')
  }
  const abortGenerations = () => {
    for (const controller of generationControllersRef.current) controller.abort()
  }
  const stopAllOperations = () => {
    abortRef.current?.abort()
    abortGenerations()
  }
  const worksRef = useRef<Work[]>([])
  const writeQueue = useRef(Promise.resolve())
  // Work updates can arrive many times while a batch is running. Keep the
  // latest snapshot and persist it after a short quiet window instead of
  // issuing one storage write for every status/image update.
  const workSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pendingWorkSaveRef = useRef<Work[] | null>(null)
  const workSavePromiseRef = useRef<Promise<void> | null>(null)
  const accountRecoveryRef = useRef(false)
  const accountEstablishedRef = useRef(false)
  const storageRef = useRef({
    get: <T,>(key: string) => withAccount(() => client.storage.get<T>(key)),
    getEntry: <T,>(key: string) => withAccount(() => client.storage.getEntry<T>(key)),
    getMany: <T,>(keys: string[]) => withAccount(() => client.storage.getMany<T>(keys)),
    batch: (operations: Parameters<typeof client.storage.batch>[0], options?: Parameters<typeof client.storage.batch>[1]) => withAccount(() => client.storage.batch(operations, options)),
    set: (key: string, value: unknown) => withAccount(() => client.storage.set(key, value)),
    delete: (key: string) => withAccount(() => client.storage.delete(key)),
  })
  const workStorageRef = useRef(createWorkStorage(storageRef.current))
  const preferencesReadyRef = useRef(false)
  const savedPreferencesRef = useRef<{ modelId?: string; textModel?: string } | null>(null)
  const storageReadyRef = useRef(false)
  const connectionRef = useRef<Promise<boolean> | null>(null)
  const modelRefreshRef = useRef<Promise<void> | null>(null)
  const resourceRestoreRef = useRef<Promise<void> | null>(null)
  const modelsReadyRef = useRef(false)
  const mounted = useRef(true)
  const resourceErrorKeyRef = useRef('')

  function navigate(route: DesignRoute, replace = false) {
    const current = { module, view }
    if (!sameDesignRoute(current, route)) {
      setModule(route.module)
      setView(route.view)
    }
    commitDesignRoute(route, replace)
    setError('')
    setFilter('all')
  }

  const model = models.find((m) => m.id === modelId)
  const tryonModelIssue = connected ? imageModelIssue(model, { ratios: RATIOS, minimumInputs: 2 }) : ''
  const modelGenerationIssue = connected ? imageModelIssue(model, { ratios: RATIOS, operation: 'generation' }) : ''
  const modelSettingsBusy = busy || generationCount > 0 || connecting || refreshingModels || restoringResources
  const hostedLogin = hostLoginRequired || client.auth.loginMode === 'host'
  const connectionLabel = accountRecovery ? '重新加载应用'
    : connecting ? connectionAction === 'check' ? '正在检查连接' : '等待登录完成'
      : hostedLogin ? '重新检查登录状态'
        : connectionAction === 'relogin' ? '重新登录'
          : connectionAction === 'login' ? '登录并连接' : '重试连接'
  const example = EXAMPLES[exampleIndex]
  const tryonHasResults = works.some((work) => work.batch === moduleBatches.tryon)
  const outputCount =
    (autoScene || customScene.trim() ? 1 : Math.max(1, scenes.length)) *
    poseIds.length

  useEffect(() => {
    if (settingsRequest === handledSettingsRequest.current || view !== 'studio') return
    handledSettingsRequest.current = settingsRequest
    const panel = module === 'tryon'
      ? settingsRef.current
      : document.querySelector<HTMLElement>('.module-host:not([hidden]) aside')
    panel?.scrollIntoView({ block: 'start', behavior: 'auto' })
    const target = module === 'tryon' && peopleTab === 'ai'
      ? panel?.querySelector<HTMLElement>('#model-description')
      : panel?.querySelector<HTMLElement>('button:not(:disabled), input:not([type="file"]):not(:disabled)')
    target?.focus({ preventScroll: true })
  }, [settingsRequest, module, view, peopleTab])

  function messageOf(e: unknown, resource?: WorkspaceResource) {
    if (requiresAccountRecovery(e, accountEstablishedRef.current)) {
      accountRecoveryRef.current = true
      storageReadyRef.current = false
      preferencesReadyRef.current = false
      abortRef.current?.abort()
      abortGenerations()
      setAccountRecovery(true)
      setConnectionAction('check')
      setConnected(false)
      setConnectionError(`${isAccountScopeUnavailableError(e) ? '账户信息暂时无法确认' : '账户授权已失效'}，请重新加载应用恢复连接。已同步作品会自动恢复；未提交素材和未同步作品不会保留，请先下载需要的结果。`)
    }
    return resource ? friendlyResourceErrorMessage(e, resource) : friendlyErrorMessage(e)
  }

  function modelCatalogIssue(catalog: Pick<ModelCatalog, 'errors'>) {
    const entries = Object.entries(catalog.errors || {})
    if (!entries.length) return ''
    const labels = { images: '图片模型', text: '文本模型' }
    const details = entries.map(([key, error]) =>
      `${labels[key as keyof typeof labels]}：${messageOf(error, 'models')}`,
    )
    return `部分模型资源未恢复（${details.join('；')}）。已保留可用模型，可稍后刷新目录。`
  }

  async function withAccount<T>(operation: () => Promise<T>): Promise<T> {
    if (accountRecoveryRef.current) throw new Error('请重新加载应用恢复账户连接')
    try { return await operation() }
    catch (e) { messageOf(e); throw e }
  }

  useEffect(() => {
    handleLoginRequired = url => {
      // The SDK can retry the original API/storage request after login. Once
      // workspace data belongs to a user, require a fresh page before another
      // login so those requests cannot be replayed under a different account.
      try { assertCanStartAccountLogin(accountEstablishedRef.current) }
      catch (e) { messageOf(e); throw e }
      if (url) setLoginURL(url)
    }
    return () => { handleLoginRequired = undefined }
  }, [])

  useEffect(
    () => () => {
      mounted.current = false
      abortRef.current?.abort()
      abortGenerations()
      // Give the latest snapshot one last chance to reach storage when the
      // page is being unloaded (the write itself is still serialized).
      void flushWorkSave().catch(() => undefined)
    },
    [],
  )
  useEffect(() => {
    if (!notice) return
    const timer = setTimeout(() => setNotice(''), 5000)
    return () => clearTimeout(timer)
  }, [notice])

  const resourceErrorKey = (Object.entries(resourceErrors) as [WorkspaceResource, string][])
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}:${value}:${JSON.stringify(resourceDiagnostics[key] || [])}`)
    .join('|')
  useEffect(() => {
    if (resourceErrorKey === resourceErrorKeyRef.current) return
    resourceErrorKeyRef.current = resourceErrorKey
    setResourceToastDismissed(false)
  }, [resourceErrorKey])

  useEffect(() => {
    const handlePopState = () => {
      const route = readDesignRoute(window.location)
      setModule(route.module)
      setView(route.view)
      setError('')
      setFilter('all')
    }
    window.addEventListener('popstate', handlePopState)
    return () => window.removeEventListener('popstate', handlePopState)
  }, [])

  useEffect(() => {
    if (!model || sizeForRatio(model, ratio)) return
    const supported = RATIOS.find((r) => sizeForRatio(model, r))
    if (supported) setRatio(supported)
  }, [model, ratio])
  useEffect(() => {
    if (!connected || restoringResources || !modelsReadyRef.current || !preferencesReadyRef.current) return
    writeQueue.current = writeQueue.current
      .then(() => accountRecoveryRef.current ? undefined : storageRef.current.set('design:settings:v1', { modelId, textModel }))
      .then(() => undefined)
      .catch(e => { setNotice(`${messageOf(e, 'preferences')} 当前页面仍可继续使用。`) })
  }, [connected, modelId, textModel, restoringResources])

  function storeWorks(next: Work[]) {
    worksRef.current = next
    setWorks(next)
    if (!storageReadyRef.current) return
    pendingWorkSaveRef.current = next
    if (workSaveTimerRef.current === null)
      workSaveTimerRef.current = setTimeout(() => {
        workSaveTimerRef.current = null
        void flushWorkSave().catch(() => undefined)
      }, 250)
  }

  function flushWorkSave(): Promise<void> {
    if (workSaveTimerRef.current !== null) {
      clearTimeout(workSaveTimerRef.current)
      workSaveTimerRef.current = null
    }
    const snapshot = pendingWorkSaveRef.current
    pendingWorkSaveRef.current = null
    if (accountRecoveryRef.current) return Promise.reject(new Error('请重新加载应用恢复账户连接'))
    if (!snapshot) return workSavePromiseRef.current || Promise.resolve()
    const storage = workStorageRef.current
    const run = writeQueue.current
      .then(() => {
        if (accountRecoveryRef.current) throw new Error('请重新加载应用恢复账户连接')
        return storage.save(snapshot)
      })
      .catch((e) => {
        pendingWorkSaveRef.current ||= snapshot
        if (mounted.current)
          setNotice(`${messageOf(e, 'history')} 当前页面仍可查看和下载；保存成功前不会提交新任务。`)
        throw e
      })
    writeQueue.current = run.catch(() => undefined)
    workSavePromiseRef.current = run
    const clear = () => { if (workSavePromiseRef.current === run) workSavePromiseRef.current = null }
    void run.then(clear, clear)
    return run
  }
  function updateWork(id: string, patch: Partial<Work>) {
    storeWorks(
      worksRef.current.map((w) => (w.id === id ? { ...w, ...patch } : w)),
    )
  }

  async function restoreResources() {
    if (resourceRestoreRef.current) return resourceRestoreRef.current
    if (busyRef.current || generationCount > 0 || modelRefreshRef.current) return
    setRestoringResources(true)
    resourceRestoreRef.current = (async () => {
      await flushWorkSave()
      await writeQueue.current
      const results = await loadWorkspaceResources({
        models: modelsReadyRef.current ? undefined : () => loadModelCatalog(client.api),
        history: storageReadyRef.current ? undefined : () => workStorageRef.current.load(),
        preferences: preferencesReadyRef.current ? undefined : () => storageRef.current.get<{ modelId?: string; textModel?: string }>('design:settings:v1'),
      })
      if (!mounted.current) return
      const issues: Partial<Record<WorkspaceResource, string>> = {}
      const diagnostics: Partial<Record<WorkspaceResource, ResourceDiagnostic[]>> = {}
      for (const key of ['models', 'history', 'preferences'] as const) {
        const result = results[key]
        if (result.status === 'rejected') {
          issues[key] = messageOf(result.reason, key)
          diagnostics[key] = resourceDiagnosticList(result.reason)
        }
      }
      if (accountRecoveryRef.current) return
      if (results.preferences.status === 'fulfilled') {
        preferencesReadyRef.current = true
        if (results.preferences.value !== undefined) savedPreferencesRef.current = results.preferences.value
      }
      const preferences = savedPreferencesRef.current
      const catalog = results.models.status === 'fulfilled' ? results.models.value : undefined
      if (catalog) {
        const catalogIssue = modelCatalogIssue(catalog)
        modelsReadyRef.current = !catalogIssue
        if (catalogIssue) {
          issues.models = catalogIssue
          diagnostics.models = resourceDiagnosticList({ errors: catalog.errors })
        }
        setModels(catalog.images)
        setTextModels(catalog.text)
        const availability = imageModelAvailabilityMessage(catalog.images)
          || (!catalog.text.length ? '当前没有可用的文案与图片理解模型，请稍后刷新模型列表。' : '')
        if (availability && !catalogIssue) setError(availability)
      }
      if (catalog || preferences) {
        setModelId(previous => selectImageEditModel(catalog?.images || models, previous, preferences?.modelId)?.id || '')
        setTextModel(previous => selectTextModel(catalog?.text || textModels, previous || preferences?.textModel))
      }
      if (results.history.status === 'fulfilled' && results.history.value !== undefined) {
        const restored = await Promise.all(results.history.value.map(async work => {
          if (!work.taskId && !work.assetIds?.length) return work
          try { return await refreshWorkMedia(client.api, work) }
          catch (error) { return { ...work, status: work.images.length ? work.status : 'paused' as const, error: messageOf(error) } }
        }))
        worksRef.current = restored
        setWorks(restored)
        setModuleBatches(Object.fromEntries(
          ['product', 'detail', 'clone', 'tryon'].map(kind => [kind, restored.find(work => kind === 'tryon' ? ['tryon', 'model'].includes(work.kind) : work.kind === kind)?.batch || '']),
        ))
        storageReadyRef.current = true
        storeWorks(restored)
      }
      setResourceErrors(issues)
      setResourceDiagnostics(diagnostics)
      if (Object.keys(issues).length) setResourceToastDismissed(false)
    })().finally(() => {
      if (mounted.current) setRestoringResources(false)
      resourceRestoreRef.current = null
    })
    return resourceRestoreRef.current
  }

  async function connect(action: AccountConnectionAction = connectionAction): Promise<boolean> {
    if (accountRecoveryRef.current) { window.location.reload(); return false }
    if (connectionRef.current) return connectionRef.current
    if (busyRef.current || generationCount > 0 || modelRefreshRef.current || resourceRestoreRef.current) return false
    if (connected) { await restoreResources(); return !accountRecoveryRef.current }
    if (hostedLogin) action = 'check'
    setConnecting(true)
    setConnectionError('')
    setConnectionAction(action)
    setLoginURL('')
    connectionRef.current = (async () => {
      const authenticated = await connectAccount(client, action)
      if (!mounted.current) return false
      if (!authenticated) {
        setConnectionAction(hostedLogin ? 'check' : 'login')
        if (hostedLogin || action !== 'check') setConnectionError(hostedLogin
          ? '请在平台完成登录，然后重新检查登录状态。'
          : '登录尚未完成，请在登录窗口完成授权后重新检查。')
        return false
      }
      setDesignGatewayURL(client.session()?.gateway_url)
      accountEstablishedRef.current = true
      setConnected(true)
      setConnectionError('')
      setConnectionAction('check')
      setConnecting(false)
      setLoginURL('')
      await restoreResources()
      return !accountRecoveryRef.current
    })()
      .catch((e) => {
        messageOf(e)
        if (mounted.current && !accountRecoveryRef.current) {
          const failure = accountConnectionFailure(e, hostedLogin ? 'host' : client.auth.loginMode)
          setHostLoginRequired(failure.hostedLogin)
          setConnectionAction(failure.action)
          setConnectionError(failure.message)
        }
        throw e
      })
      .finally(() => {
        if (mounted.current) setConnecting(false)
        connectionRef.current = null
      })
    return connectionRef.current
  }

  async function refreshModels() {
    if (modelRefreshRef.current) return modelRefreshRef.current
    if (busyRef.current || generationCount > 0 || connectionRef.current || resourceRestoreRef.current || connecting) return
    if (!connected) return connect()
    setRefreshingModels(true)
    setError('')
    setNotice('')
    modelRefreshRef.current = loadModelCatalog(client.api)
      .then((catalog) => {
        if (!mounted.current) return
        setModels(catalog.images)
        const catalogIssue = modelCatalogIssue(catalog)
        modelsReadyRef.current = !catalogIssue
        setResourceErrors(previous => {
          const next = { ...previous }
          if (catalogIssue) next.models = catalogIssue
          else delete next.models
          return next
        })
        setResourceDiagnostics(previous => {
          const next = { ...previous }
          if (catalogIssue) next.models = resourceDiagnosticList({ errors: catalog.errors })
          else delete next.models
          return next
        })
        if (catalogIssue) setResourceToastDismissed(false)
        setTextModels(catalog.text)
        setModelId(previous => selectImageEditModel(catalog.images, previous, savedPreferencesRef.current?.modelId)?.id || '')
        setTextModel(previous => selectTextModel(catalog.text, previous, savedPreferencesRef.current?.textModel))
        const visibleTextModels = new Set(catalog.text.map(choice => choice.id))
        verifiedModelsRef.current = new Set(
          [...verifiedModelsRef.current].filter(id => visibleTextModels.has(id)),
        )
        setVerifiedModels([...verifiedModelsRef.current])
        const availabilityMessage = imageModelAvailabilityMessage(catalog.images)
          || (!catalog.text.length ? '当前没有可用的文案与图片理解模型，请稍后刷新模型列表。' : '')
        if (availabilityMessage && !catalogIssue) setError(availabilityMessage)
        else if (!catalogIssue) setNotice('模型列表已刷新')
      })
      .catch((e) => {
        const message = messageOf(e, 'models')
        if (mounted.current) {
          modelsReadyRef.current = false
          setResourceErrors(previous => ({ ...previous, models: message }))
          setResourceDiagnostics(previous => ({ ...previous, models: resourceDiagnosticList(e) }))
          setResourceToastDismissed(false)
        }
      })
      .finally(() => {
        if (mounted.current) setRefreshingModels(false)
        modelRefreshRef.current = null
      })
    return modelRefreshRef.current
  }

  // Restore through the SDK without opening a login popup on first visit.
  useEffect(() => {
    void connect('check').catch(() => undefined)
  }, [])

  async function addFiles(files: File[], kind: 'garment' | 'person') {
    if (!files.length || (busyRef.current && !generationControllersRef.current.size) || processingPhotos) return
    setError('')
    if (kind === 'garment')
      await garmentPhotos.add(files)
    else {
      const accepted = await peoplePhotos.add(files.slice(0, 1))
      if (accepted[0]) {
        setPerson(accepted[0])
        setCustomPeople(previous => [accepted[0], ...previous.filter(photo => photo.id !== accepted[0].id)])
        setPeopleTab('library')
      }
    }
  }

  function applyExample() {
    if (generationCount > 0) return
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
    navigate({ module, view: 'studio' })
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

  async function generate(kind: 'tryon' | 'model', execution?: AgentExecution, settings = execution ? {
    model: models.find(item => item.id === execution.config.imageModel), textModel: execution.config.textModel,
    garments: execution.config.productIds.map(id => execution.photos.get(id)!), person: execution.photos.get(execution.config.personId)!,
    scenes: execution.config.sceneIds, customScene: execution.config.customScene, autoScene: false,
    poseIds: execution.config.poseIds, ratio: execution.config.ratio, extra: execution.config.requirements,
  } : { model, textModel, garments, person, scenes, customScene, autoScene, poseIds, ratio, extra }) {
    const { model, textModel, garments, person, scenes, customScene, autoScene, poseIds, ratio, extra } = settings
    if ((busyRef.current && !generationControllersRef.current.size) || modelRefreshRef.current || resourceRestoreRef.current || processingPhotos || connecting) { if (execution) throw new Error('工作区正在处理其他操作，请稍后重试'); return }
    setError('')
    if (execution && (!connected || !storageReadyRef.current)) throw new Error('工作区连接已变化，请重新检查状态')
    if (!connected) {
      await connect().catch(() => undefined)
      return
    }
    const modelIssue = imageModelIssue(model, {
      operation: kind === 'model' ? 'generation' : 'edit', minimumInputs: 2, ratios: [ratio],
    })
    if (!model || modelIssue) {
      setError(modelIssue || '请选择支持当前操作的可用图片模型')
      setModelDialog(true)
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
    if (!storageReadyRef.current) {
      setError('作品记录尚未加载，请点击「重试加载」后生成，以免覆盖已有作品。')
      return
    }
    if (!textModel) {
      setError('请选择文案与图片理解模型后生成')
      return
    }
    const controller = execution?.controller || new AbortController()
    const batch = execution?.batchId || crypto.randomUUID()
    registerGeneration(batch, kind === 'model' ? 'AI 模特' : '试穿', controller, '正在准备素材')
    navigate({ module, view: 'studio' })
    let jobs: Work[] = []
    try {
      updateGenerationPhase(batch, '正在校验图片理解能力')
      await ensureTextModel(controller.signal, textModel)
      let sceneList = ['浅灰色专业影棚，均匀柔和照明']
      if (kind === 'tryon') {
        if (autoScene) {
          updateGenerationPhase(batch, '正在推荐拍摄场景')
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
      setModuleBatches(previous => ({ ...previous, tryon: batch }))
      storeWorks([...jobs, ...worksRef.current.filter(work => work.id !== `${batch}-planning`)].slice(0, 80))
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
          reviewContexts.current.set(job.id, context)
        }
        updateWork(job.id, { plan: job.plan })
      }
      await flushWorkSave()
      await writeQueue.current
      const files: File[] = []
      if (kind === 'tryon') {
        files.push(await normalizedFile(person))
        if (sheet) files.push(await garmentSheet(garments))
        else for (const garment of garments) {
          if (controller.signal.aborted) throw new DOMException('已停止', 'AbortError')
          files.push(await normalizedFile(garment))
        }
      }
      await runCommerceJobs({
        api: client.api,
        path: kind === 'model' ? '/images/generations' : '/images/edits',
        works: jobs,
        signal: controller.signal,
        onUpdate: updateWork,
        persistTask: flushWorkSave,
        onActivity: activity => updateGenerationPhase(batch, imageActivityMessage(activity)),
        prepare: async index => {
          const job = jobs[index]
          if (kind === 'model') return JSON.stringify({
            model: model.id, prompt: job.plan!.brief, n: 1, size,
          })
          const form = new FormData()
          form.append('model', model.id)
          form.append('size', size)
          form.append('n', '1')
          form.append('prompt', job.plan!.brief)
          for (const file of files) form.append('image[]', file)
          return form
        },
        onCompleted: async (work, images) => {
          if (kind === 'model') {
            const generated = { id: work.id, name: 'AI 模特', url: images[0].url }
            setPerson(generated)
            setCustomPeople(previous => [generated, ...previous].slice(0, 25))
            setPeopleTab('library')
          }
          const latest = worksRef.current.find(item => item.id === work.id) || work
          await reviewGenerated({ ...latest, images }, controller.signal, textModel)
        },
      })
      if (controller.signal.aborted)
        setNotice(cancellationMessage(worksRef.current.filter(work => work.batch === batch)))
    } catch (e) {
      if (execution) throw e
      setError(
        controller.signal.aborted
          ? cancellationMessage(worksRef.current.filter((work) => work.batch === batch))
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
      finishGeneration(batch, controller)
    }
  }

  async function resume(work: Work) {
    if ((!work.taskId && !work.assetIds?.length) || busyRef.current || generationCount > 0 || modelRefreshRef.current || resourceRestoreRef.current) return
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
      const refreshed = await refreshWorkMedia(client.api, work)
      updateWork(work.id, refreshed)
      const images = refreshed.images
      if (work.kind === 'model' && images.length) {
        const p = { id: work.id, name: 'AI 模特', url: images[0].url }
        setPerson(p)
        setCustomPeople((previous) => [
          p,
          ...previous.filter((v) => v.id !== p.id),
        ].slice(0, 25))
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

  async function ensureTextModel(signal: AbortSignal, selectedTextModel = textModel) {
    if (!selectedTextModel || !textModels.some(choice => choice.id === selectedTextModel))
      throw new Error('请选择可用的文案与图片理解模型')
    if (verifiedModelsRef.current.has(selectedTextModel)) return
    await verifyVisionModel(client.api, selectedTextModel, visionChallenge(), signal)
    if (signal.aborted) throw new DOMException('已停止', 'AbortError')
    verifiedModelsRef.current.add(selectedTextModel)
    setVerifiedModels([...verifiedModelsRef.current])
  }

  async function requestVision(
    prompt: string,
    inputs: { label: string; url: string }[],
    signal: AbortSignal,
    selectedTextModel = textModel,
  ) {
    await ensureTextModel(signal, selectedTextModel)
    if (signal.aborted) throw new DOMException('已停止', 'AbortError')
    const result = await client.api.request('/responses', {
      method: 'POST', signal,
      body: JSON.stringify({
        model: selectedTextModel, stream: false, store: false,
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

  async function requestCopy(prompt: string, photos: Photo[], signal: AbortSignal, selectedTextModel = textModel) {
    const inputs = photos.length ? [{
      label: '同一商品的原始参考图，仅作为商品资料。',
      url: await dataURL(await garmentSheet(photos, 'PRODUCT')),
    }] : []
    return requestVision(prompt + '\n只使用用户提供或图片中明确可见的信息，未知参数不要猜测。', inputs, signal, selectedTextModel)
  }

  async function reviewGenerated(work: Work, signal: AbortSignal, selectedTextModel = textModel) {
    try {
      if (signal.aborted) throw new DOMException('检查已停止', 'AbortError')
      if (!work.images.length) throw new Error('请先等待图片生成完成')
      let context = reviewContexts.current.get(work.id)
      if (!context && work.kind === 'model') context = { images: [] }
      if (!context) throw new Error('参考素材仅保留在当前页面；请重新选择原始图片后检查。')
      updateWork(work.id, { quality: {
        status: 'checking', summary: '', issues: [], checkedAt: '',
      } })
      const output = await reviewImage(work.images[0].url, { signal })
      const text = await requestVision(buildQualityPrompt(work), [
        ...context.images,
        { label: '最后一张：本次生成的待检成图。', url: output },
      ], signal, selectedTextModel)
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
    if (busyRef.current || generationCount > 0 || modelRefreshRef.current || resourceRestoreRef.current || !connected) return
    busyRef.current = true
    setBusy(true)
    const controller = new AbortController()
    abortRef.current = controller
    setPhase(`正在检查 · ${work.title}`)
    try { await reviewGenerated(work, controller.signal) }
    finally {
      busyRef.current = false
      setBusy(false)
      setPhase('')
      abortRef.current = null
    }
  }

  async function verifySelectedModel() {
    if (busyRef.current || generationCount > 0 || modelRefreshRef.current || resourceRestoreRef.current || !connected) return
    busyRef.current = true
    setBusy(true)
    setPhase('正在校验图片理解能力')
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
    if (busyRef.current || generationCount > 0 || modelRefreshRef.current || resourceRestoreRef.current || connecting) throw new Error('请等待当前操作完成')
    if (!connected) {
      const ready = await connect()
      throw new Error(ready ? '服务已连接，请再次点击 AI 帮写' : '账户尚未连接，请完成连接后重试')
    }
    const controller = new AbortController()
    abortRef.current = controller
    busyRef.current = true
    setBusy(true)
    setPhase('正在分析素材与撰写文案')
    setError('')
    try {
      return await requestCopy(prompt, photos, controller.signal)
    } catch (e) {
      messageOf(e)
      throw e
    } finally {
      busyRef.current = false
      setBusy(false)
      setPhase('')
      abortRef.current = null
    }
  }

  async function generateCommerce(request: CommerceRequest, execution?: AgentExecution, settings = execution ? {
    model: models.find(item => item.id === execution.config.imageModel), textModel: execution.config.textModel,
  } : { model, textModel }) {
    const { model, textModel } = settings
    if ((busyRef.current && !generationControllersRef.current.size) || modelRefreshRef.current || resourceRestoreRef.current || connecting) throw new Error('请等待当前操作完成')
    if (!connected) {
      const ready = await connect()
      throw new Error(ready ? '服务已连接，请确认模型后再次点击生成' : '账户尚未连接，请完成连接后重试')
    }
    const modelIssue = imageModelIssue(model, {
      ratios: [request.ratio],
      minimumInputs: request.products.length && request.jobs.some(job => job.references?.length) ? 2 : 1,
    })
    if (!model || modelIssue)
      throw new Error(modelIssue || '请选择支持图片编辑的可用模型')
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
      throw new Error('作品记录尚未加载，请点击「重试加载」后生成，以免覆盖已有作品。')
    const batch = execution?.batchId || crypto.randomUUID()
    const controller = execution?.controller || new AbortController()
    registerGeneration(batch, KIND_LABELS[request.kind], controller, '正在准备任务')
    setError('')
    setFilter('all')
    setModuleBatches((previous) => ({ ...previous, [request.kind]: batch }))
    let jobs: Work[] = []
    try {
      updateGenerationPhase(batch, '正在校验图片理解能力')
      await ensureTextModel(controller.signal, textModel)
      updateGenerationPhase(batch, '正在制定逐图创作计划')
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
        buildPlanningPrompt(request), planningInputs, controller.signal, textModel,
      ), request)
      jobs = plan.jobs.map((job, position) => ({
        id: crypto.randomUUID(), batch, title: job.title,
        scene: KIND_LABELS[request.kind], pose: job.prompt,
        ratio: request.ratio, model: model.id,
        createdAt: new Date().toISOString(), kind: request.kind,
        status: 'queued', images: [], batchSize: plan.jobs.length, position,
        plan: { direction: plan.direction, brief: job.prompt },
      }))
      storeWorks([...jobs, ...worksRef.current.filter(work => work.id !== `${batch}-planning`)].slice(0, 80))
      updateGenerationPhase(batch, '正在保存创作计划与核对素材')
      const contexts = new Map<string, Promise<ReviewContext>>()
      for (let index = 0; index < jobs.length; index++) {
        if (controller.signal.aborted) throw new DOMException('已停止', 'AbortError')
        const refs = plan.jobs[index].references || []
        const cacheKey = refs.map(photo => photo.id).join('|')
        if (!contexts.has(cacheKey)) contexts.set(cacheKey, prepareReviewContext(request.products, refs))
        const context = await contexts.get(cacheKey)!
        reviewContexts.current.set(jobs[index].id, context)
      }
      // Verify durable metadata before submitting any image generation.
      await flushWorkSave()
      await writeQueue.current
      if (request.listingPrompt) {
        updateGenerationPhase(batch, '正在撰写商品上架文案')
        const text = await requestCopy(request.listingPrompt, request.products, controller.signal, textModel)
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
        persistTask: flushWorkSave,
        onCompleted: async (work, images) => {
          const latest = worksRef.current.find(item => item.id === work.id) || work
          await reviewGenerated({ ...latest, images }, controller.signal, textModel)
        },
        onActivity: activity => updateGenerationPhase(batch, imageActivityMessage(activity)),
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
            } else for (const product of request.products) {
              if (controller.signal.aborted) throw new DOMException('已停止', 'AbortError')
              files.push(await normalized(product))
            }
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
      if (execution) throw error
      setError(
        controller.signal.aborted
          ? cancellationMessage(worksRef.current.filter((work) => work.batch === batch))
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
      finishGeneration(batch, controller)
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
        await stitchImages((await Promise.all(parts.map(refreshWork))).map(work => work.images[0].url)),
        `detail-${Date.now()}.jpg`,
      )
    } catch (error) {
      setError(messageOf(error))
    } finally {
      setDownloading(false)
    }
  }

  function openTaskSettings(work?: Work) {
    if (busyRef.current) return
    const targetModule = work ? work.kind === 'model' ? 'tryon' : work.kind : module
    if (work?.kind === 'model') setPeopleTab('ai')
    navigate({ module: targetModule, view: 'studio' })
    if (targetModule === 'product') setProductSettingsRequest(value => value + 1)
    else setSettingsRequest(value => value + 1)
    if (work) setNotice('已打开新任务设置。请确认原图与参数后生成，原作品仍会保留。')
  }

  function renderWorks(selected: Work[], title: string) {
    return (
      <WorksPanel
        works={selected}
        title={title}
        busy={busy || restoringResources}
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
        onRefresh={refreshWork}
        resolveImageURL={resolveImageURL}
        onConfigure={openTaskSettings}
        onReview={reviewWork}
        canReview={(work) => connected && Boolean(work.kind === 'model' || reviewContexts.current.has(work.id))}
        onRemove={(id) =>
          storeWorks(worksRef.current.filter((work) => work.id !== id))
        }
        onStart={() => openTaskSettings()}
        onStitch={(batch) => void downloadDetail(batch)}
      />
    )
  }

  function renderModules() {
    const shared = {
      busy,
      connected,
      connecting: connecting || refreshingModels || restoringResources,
      models,
      modelId,
      onModelChange: setModelId,
      onError: setError,
      onPreview: showImage,
      onStop: stopAllOperations,
      onAssist: assist,
      onConnect: () => void refreshModels().catch(() => undefined),
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
            settingsRequest={productSettingsRequest}
            onOpenModelSettings={() => setModelDialog(true)}
            hasResults={works.some((work) => work.batch === moduleBatches.product)}
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
            hasResults={works.some(work => work.batch === moduleBatches.detail)}
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
            hasResults={works.some(work => work.batch === moduleBatches.clone)}
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

  async function refreshWork(work: Work): Promise<Work> {
    const refreshed = await withAccount(() => refreshWorkMedia(client.api, work))
    updateWork(work.id, refreshed)
    return refreshed
  }

  agentHostRef.current = {
    snapshot: () => ({ ready: connected && !connecting && !accountRecoveryRef.current && storageReadyRef.current && modelsReadyRef.current && !restoringResources,
      reason: accountRecoveryRef.current ? '账户已变化，请重新加载应用' : '请先登录并等待模型与作品加载完成',
      models, textModels, selectedImageModel: modelId, selectedTextModel: textModel, works: worksRef.current }),
    importPhoto: (bytes, mime, name) => readPhoto(new File([new Uint8Array(bytes)], name, { type: mime })),
    releasePhoto: photo => { if (photo.url.startsWith('blob:')) URL.revokeObjectURL(photo.url) },
    changed: (config, assets) => setAgentDraft({ config, assets }),
    prepare: async (batch, config) => {
      if (accountRecoveryRef.current || !connected || !storageReadyRef.current) throw new Error('工作区尚未就绪')
      storeWorks([{ id: `${batch}-planning`, batch, title: '助手创作 · 正在准备', scene: KIND_LABELS[config.mode], pose: '', ratio: config.ratio,
        model: config.imageModel, kind: config.mode, createdAt: new Date().toISOString(), status: 'queued' as const, images: [] }, ...worksRef.current].slice(0, 80))
      await flushWorkSave()
    },
    run: async (batchId, config, photos, controller) => {
      const execution = { batchId, config, photos, controller }
      navigate({ module: config.mode, view: 'studio' })
      try {
        controller.signal.throwIfAborted()
        if (config.mode === 'tryon') await generate('tryon', execution)
        else await generateCommerce(commerceForDesign(config, photos), execution)
      } catch (error) {
        const message = controller.signal.aborted ? cancellationMessage(worksRef.current.filter(work => work.batch === batchId)) : messageOf(error)
        updateWork(`${batchId}-planning`, { status: controller.signal.aborted ? 'skipped' : 'failed', error: message })
        setError(message)
        throw error
      } finally { await flushWorkSave() }
    },
    refresh: refreshWork,
    result: async (work, imageIndex) => {
      const latest = await refreshWork(work)
      const image = latest.images[imageIndex]
      if (!image) throw new Error('结果尚未就绪，请查询原任务')
      return fetchImage(image.url)
    },
  }
  useEffect(() => {
    const bridge = createDesignAgent(new Proxy({} as DesignAgentHost, { get: (_target, key) => (...args: unknown[]) =>
      (agentHostRef.current![key as keyof DesignAgentHost] as (...args: unknown[]) => unknown)(...args) }))
    const disposers: Array<() => void> = []
    try {
      for (const [name, handler] of Object.entries(bridge.handlers)) {
        disposers.push(agent.register(capability(name), handler as Parameters<typeof agent.register>[1]))
      }
    } catch (error) { disposers.forEach(dispose => dispose()); bridge.dispose(); throw error }
    return () => { disposers.forEach(dispose => dispose()); bridge.dispose() }
  }, [])
  useEffect(() => agent.setStatus(accountRecovery || !connected ? { state: 'auth_required', retryable: false, nextAction: { type: 'user_login' } }
    : connecting || restoringResources || !storageReadyRef.current || !modelsReadyRef.current ? { state: 'loading', retryable: true, nextAction: { type: 'wait' } }
      : { state: 'ready' }, { scope: 'design', priority: 10 }), [connected, connecting, restoringResources, accountRecovery, models, works])

  async function resolveImageURL(url: string): Promise<string> {
    const work = worksRef.current.find(item => item.images.some(image => image.url === url))
    if (!work || (!work.taskId && !work.assetIds?.length && !work.images.some(image => image.assetId))) return url
    const index = work.images.findIndex(image => image.url === url)
    const refreshed = await refreshWork(work)
    const image = refreshed.images[index]
    if (!image) throw new Error(refreshed.error || '素材暂不可访问，请继续查询原任务。')
    return image.url
  }

  async function downloadOne(url: string) {
    try {
      const blob = await fetchImage(await resolveImageURL(url))
      saveBlob(blob, `design-${Date.now()}.${imageExtension(blob)}`)
    } catch (e) {
      setError(messageOf(e))
    }
  }

  async function downloadAll(selectedWorks: Work[]) {
    setDownloading(true)
    setError('')
    try {
      saveBlob(
        await createWorksArchive(await Promise.all(selectedWorks.map(refreshWork))),
        `design-${Date.now()}.zip`,
      )
    } catch (e) {
      setError(messageOf(e))
    } finally {
      setDownloading(false)
    }
  }

  function newProject() {
    if (busyRef.current || generationCount > 0) return
    setResetKey((key) => key + 1)
    setModuleBatches({})
    garmentPhotos.clear()
    peoplePhotos.setPhotos(peoplePhotos.photos)
    setLightbox(null)
    setExtra('')
    setCustomScene('')
    setScenes(['studio'])
    setAutoScene(false)
    navigate({ module, view: 'studio' })
    setError('')
    setFilter('all')
  }

  const showImage = (url: string, title: string) => {
    setCompare(false)
    setSplit(50)
    void resolveImageURL(url).then(freshURL => setLightbox({ url: freshURL, title })).catch(error => setError(messageOf(error)))
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

  const agentConfigurationReview = agentDraft ? <details className="agent-draft-review">
    <summary><Sparkles size={15} /> 助手创作草稿 · {KIND_LABELS[agentDraft.config.mode]} · {agentDraft.config.ratio}</summary>
    <dl><dt>生成模型</dt><dd>{agentDraft.config.imageModel || '待选择'}</dd><dt>策划模型</dt><dd>{agentDraft.config.textModel || '待选择'}</dd>
      <dt>素材</dt><dd>{agentDraft.assets.map(asset => asset.name).join('、') || '尚未导入'}</dd>
      <dt>商品与画面要求</dt><dd>{agentDraft.config.requirements || '以商品可见事实为准'}</dd>
      <dt>画面设置</dt><dd>{agentDraft.config.mode === 'product' ? agentDraft.config.smart ? '智能策划 7 张' : Object.entries(agentDraft.config.counts).map(([key, count]) => `${key}: ${count}`).join(' · ')
        : agentDraft.config.mode === 'detail' ? agentDraft.config.blocks.join(' · ')
          : agentDraft.config.mode === 'tryon' ? `${agentDraft.config.customScene || agentDraft.config.sceneIds.join(' · ')} / ${agentDraft.config.poseIds.join(' · ')}`
            : `${agentDraft.config.cloneType} / ${agentDraft.config.cloneDegree}`}</dd></dl>
    <p>助手按此草稿提交，生成进度与成图会进入「我的作品」。</p>
  </details> : null

  const resourceEntries = (Object.entries(resourceErrors) as [WorkspaceResource, string][])
    .filter(([, message]) => Boolean(message))
  const resourceHeadline = resourceEntries.length > 1
    ? '部分工作区资源未恢复'
    : `${resourceErrorSummary(resourceErrors)}未恢复`
  const resourceImpact = [
    resourceErrors.models
      ? models.length
        ? '已保留当前可用图片模型，模型目录仍可刷新。'
        : textModels.length
          ? '已保留文案模型，但暂时无法生成图片。'
          : '模型列表尚未恢复，暂时无法生成新内容。'
      : '',
    resourceErrors.history
      ? works.length
        ? '已加载的作品仍可查看，更多历史记录可能缺失。'
        : '历史作品尚未加载，当前页面不会显示已有作品。'
      : '',
    resourceErrors.preferences
      ? '当前页面选择仍可使用，但偏好尚未同步，刷新后可能恢复默认值。'
      : '',
  ].filter(Boolean).join(' ')
  const resourceNotice = connected && !resourceToastDismissed && resourceEntries.length > 0 ? (
    <div className="toast error-toast resource-toast" role="alert" aria-live="polite" aria-label="资源加载状态">
      <CircleAlert size={17} aria-hidden="true" />
      <div className="resource-toast-body">
        <strong className="resource-toast-title">{resourceHeadline}</strong>
        <details className="resource-details">
          <summary>查看详情</summary>
          <p className="resource-toast-copy">{resourceImpact}</p>
          <ul>
            {resourceEntries.map(([key, message]) => {
              const diagnostic = resourceDiagnosticText(resourceDiagnostics[key])
              return (
                <li key={key}>
                  <strong>{RESOURCE_LABELS[key]}</strong>
                  <span>{message}</span>
                  {diagnostic && <code>{diagnostic}</code>}
                </li>
              )
            })}
          </ul>
        </details>
        <div className="resource-toast-actions">
          <button className="secondary" type="button" disabled={modelSettingsBusy} onClick={() => void restoreResources().catch(e => setError(messageOf(e)))}>
            <RefreshCw size={14} className={restoringResources ? 'spin' : undefined} aria-hidden="true" />
            {restoringResources ? '正在重试…' : '重试加载'}
          </button>
        </div>
      </div>
      <IconButton label="关闭资源加载提示" onClick={() => setResourceToastDismissed(true)}>
        <X size={16} />
      </IconButton>
    </div>
  ) : null

  // One floating layer owns all transient feedback, including inside dialogs.
  const feedback = <>
    {resourceNotice}
    {loginURL && connecting && <div className="toast error-toast" role="status">
      <LoaderCircle size={16} className="spin" aria-hidden="true" />
      <div className="connection-toast-body">
        <span>请在平台登录窗口完成授权。</span>
        <div className="connection-toast-actions"><a href={loginURL} target="_blank" rel="noreferrer">打开登录页面</a></div>
      </div>
    </div>}
    {connectionError && (
      <div className="toast error-toast" role="alert">
        <CircleAlert size={17} aria-hidden="true" />
        <div className="connection-toast-body">
          <span>{connectionError}</span>
          <div className="connection-toast-actions">
            <button className="error-action" type="button" disabled={modelSettingsBusy} onClick={() => void connect().catch(() => undefined)}>
              {connectionLabel}
            </button>
            {!accountRecovery && connectionAction !== 'check' && <button className="error-action" type="button" disabled={modelSettingsBusy} onClick={() => void connect('check').catch(() => undefined)}>重新检查</button>}
            {!accountRecovery && loginURL && !connecting && <a href={loginURL} target="_blank" rel="noreferrer">打开登录页面</a>}
          </div>
        </div>
        {!accountRecovery && <IconButton label="关闭连接提示" onClick={() => setConnectionError('')}><X size={16} /></IconButton>}
      </div>
    )}
    {error && (
      <div className="toast error-toast" role="alert" aria-live="assertive">
        <CircleAlert size={17} aria-hidden="true" />
        <div className="connection-toast-body">
          <span>{error}</span>
          {!modelDialog && canOpenModelSettings(error) && (
          <button
            className="error-action"
            type="button"
            onClick={() => setModelDialog(true)}
            disabled={modelSettingsBusy}
          >
            打开模型设置
          </button>
          )}
        </div>
        <IconButton label="关闭错误提示" onClick={() => setError('')}>
          <X size={16} />
        </IconButton>
      </div>
    )}
  </>
  const noticeToast = notice ? (
    <div className="toast notice-toast" role="status">
      <Check size={16} aria-hidden="true" />
      <span className="error-toast-message">{notice}</span>
      <IconButton label="关闭操作提示" onClick={() => setNotice('')}><X size={16} /></IconButton>
    </div>
  ) : null

  return (
    <div className="app-shell">
      <header className="app-header">
        <nav className="header-nav mode-nav" aria-label="模式导航">
          {STUDIO_NAV_ITEMS.map((item) => (
            <button
              key={item.id}
              type="button"
              className={`mode-tab ${view === 'studio' && module === item.id ? 'active' : ''}`}
              aria-current={view === 'studio' && module === item.id ? 'page' : undefined}
              disabled={busy}
              onClick={() => navigate({ module: item.id, view: 'studio' })}
            >
              <item.icon size={16} />
              <span>{item.name}</span>
            </button>
          ))}
          <button
            type="button"
            className={`mode-tab ${view === 'works' ? 'active' : ''}`}
            aria-current={view === 'works' ? 'page' : undefined}
            onClick={() => navigate({ module, view: 'works' })}
          >
            <Images size={16} />
            <span>我的作品</span>
            {works.length > 0 && <small>{works.length}</small>}
          </button>
        </nav>
        <div className="header-actions">
          <button
            className="secondary"
            onClick={() => setModelDialog(true)}
            disabled={busy || generationCount > 0}
            aria-label="模型设置"
            title="模型设置"
          >
            <SlidersHorizontal size={16} />
            <span className="model-settings-label">模型设置</span>
          </button>
          <button
            className="secondary new-project"
            onClick={newProject}
            disabled={busy || generationCount > 0}
            aria-label="新建任务"
            title="新建任务"
          >
            <Plus size={16} />
            新建任务
          </button>
          {!connected && <button
            className="account"
            onClick={() => void connect().catch(() => undefined)}
            disabled={modelSettingsBusy}
            aria-label={connectionLabel}
          >
            {connecting ? (
              <LoaderCircle size={16} className="spin" />
            ) : (
              <RefreshCw size={16} />
            )}
            <span>
              {connectionLabel}
            </span>
          </button>}
        </div>
      </header>
      <FeedbackLayer>
        {feedback}
        {restoringResources && <div className="toast resource-loading-toast" role="status" aria-label="正在加载工作区"><LoaderCircle size={16} className="spin" aria-hidden="true" /><span>正在加载模型与作品…</span></div>}
        {(busy || generationCount > 0) && <TaskActivity phase={phase} onStop={stopAllOperations} />}
        {noticeToast}
      </FeedbackLayer>
      <div className="app-body">
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
                          onClick={() => garmentPhotos.remove(photo.id)}
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
                      disabled={modelSettingsBusy}
                      onClick={() => void generate('model')}
                    >
                      <Sparkles size={15} />
                      {modelGenerationIssue ? '更换图片模型' : '生成模特'}
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
                        aria-hidden="true"
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
                  <DropdownSelect
                    id="image-model"
                    label="生成模型"
                    value={modelId}
                    disabled={modelSettingsBusy}
                    onChange={setModelId}
                    options={[
                      { value: '', label: connected ? '请选择模型' : '账户尚未连接' },
                      ...imageModelOptions(models, {
                        ratios: RATIOS, minimumInputs: 2,
                        operation: peopleTab === 'ai' ? 'generation' : 'edit',
                      }),
                    ]}
                  />
                  <IconButton
                    label={connected ? '刷新模型' : '连接服务'}
                    onClick={() => void refreshModels().catch(() => undefined)}
                    disabled={modelSettingsBusy}
                  >
                    <RefreshCw size={15} className={refreshingModels ? 'spin' : undefined} />
                  </IconButton>
                </div>
                <label htmlFor="text-model">场景推荐模型</label>
                <DropdownSelect
                  id="text-model"
                  label="场景推荐模型"
                  value={textModel}
                  disabled={modelSettingsBusy}
                  onChange={setTextModel}
                  options={[
                    { value: '', label: '请选择模型' },
                    ...textModels.map((m) => ({ value: m.id, label: m.name })),
                  ]}
                />
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
              {(
                <>
                  <button
                    className="primary full"
                    disabled={
                      busy ||
                      !garments.length ||
                      !poseIds.length ||
                      connecting ||
                      refreshingModels ||
                      processingPhotos
                    }
                    aria-busy={busy}
                    onClick={() => void generate('tryon')}
                  >
                    {busy ? <LoaderCircle size={18} className="spin" /> : <WandSparkles size={18} />}
                    {busy ? '正在生成…' : !garments.length
                      ? '上传服装后开始'
                      : tryonModelIssue ? '更换图片模型'
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
          <main className={`workspace ${view === 'studio' && !tryonHasResults ? 'tryon-canvas' : 'collection-canvas'}`}>
            {view === 'studio' && <div className="workspace-heading mobile-workspace-toolbar">
              <button className="secondary mobile-settings-button" onClick={() => settingsRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })}>
                <SlidersHorizontal size={15} />拍摄设置
              </button>
            </div>}
            {view === 'studio' && !tryonHasResults ? (
              <div className="example-workspace">
                <div className="canvas-heading">
                  <h1>AI 服饰穿戴</h1>
                  <p>上传服装，选择模特，让同一套穿搭拥有不同场景与姿态。</p>
                </div>
                <div className="tryon-showcase">
                <div className="example-title">
                  <div>
                    <h2>{example.title}</h2>

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
                      </figure>
                    ))}
                  </div>
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
                </div>
              </div>
            ) : (
              renderWorks(
                view === 'works'
                  ? works
                  : works.filter((work) => work.batch === moduleBatches.tryon),
                view === 'works' ? '全部创作' : '拍摄结果',
              )
            )}
          </main>
        )}
        {agentConfigurationReview}
      {renderModules()}
      </div>
      {modelDialog && (
        <Dialog title="模型设置" onClose={() => setModelDialog(false)}>
          <div className="model-dialog-fields">
            <div className="model-dialog-field">
              <label htmlFor="global-image-model">图片模型</label>
              <DropdownSelect
                id="global-image-model"
                label="全局图片模型"
                disabled={modelSettingsBusy}
                value={modelId}
                onChange={setModelId}
                options={[
                  { value: '', label: connected ? '选择图片模型' : '请先连接服务' },
                  ...imageModelOptions(models, {
                    ratios: module === 'detail' || module === 'clone' ? [...RATIOS, '4:3'] : RATIOS,
                    minimumInputs: module === 'tryon' ? 2 : 1,
                    operation: module === 'tryon' && peopleTab === 'ai' ? 'generation' : 'edit',
                  }),
                ]}
              />
            </div>
            <div className="model-dialog-field">
              <label htmlFor="global-text-model">文案与图片理解模型</label>
              <DropdownSelect
                id="global-text-model"
                label="文案与图片理解模型"
                disabled={modelSettingsBusy}
                value={textModel}
                onChange={setTextModel}
                options={[
                  { value: '', label: connected ? '选择文本模型' : '请先连接服务' },
                  ...textModels.map((m) => ({ value: m.id, label: m.name })),
                ]}
              />
            </div>
            <p>文本模型用于策划、文案与图片检查。模型校验和生成均使用账户额度。</p>
            <button className="secondary" disabled={!connected || !textModel || modelSettingsBusy} onClick={() => void verifySelectedModel()}>
              {textModel && verifiedModels.includes(textModel) ? '重新校验图片理解能力' : '校验图片理解能力'}
            </button>
            <button
              className="secondary"
              onClick={() => void refreshModels().catch(() => undefined)}
              disabled={modelSettingsBusy}
              aria-busy={connecting || refreshingModels || restoringResources}
            >
              {connecting ? '连接中…' : restoringResources ? '资源加载中…' : refreshingModels ? '刷新中…' : connected ? '刷新模型' : '连接服务'}
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
