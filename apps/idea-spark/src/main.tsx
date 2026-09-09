import React from 'react'
import { createRoot } from 'react-dom/client'
import { createAppClient, type AppSdkError } from '@codex/proxy-app-sdk'
import appManifest from '../manifest.json'
import './styles.css'

type ModelItem = {
  id?: string
  model?: string
  name?: string
  type?: string
  model_type?: string
}

const MODES = [
  { id: 'campaign', label: '营销方案', hint: '卖点、受众和传播角度' },
  { id: 'script', label: '短视频脚本', hint: '开场、镜头和行动' },
  { id: 'product', label: '产品点子', hint: '痛点、功能和差异化' },
] as const

type IdeaMode = (typeof MODES)[number]['id']

type StoredIdea = {
  id: string
  brief: string
  mode: IdeaMode
  result: string
  savedAt: string
}

type ErrorDetail = {
  message: string
  code?: string
  requestId?: string
}

type StatusKind = 'loading' | 'ready' | 'working' | 'success' | 'error'

const app = createAppClient(appManifest.id, { localDevelopment: import.meta.env.DEV, localAppVersion: appManifest.version })
const HISTORY_KEY = 'idea-spark:history'
const LAST_RESULT_KEY = 'idea-spark:last-result'
const MAX_HISTORY = 6
const MAX_STORED_RESULT_LENGTH = 12000

const EXAMPLES = [
  { label: '春季茶饮', value: '为一款帮助上班族放松的茶饮，设计一个有记忆点的春季营销方案' },
  { label: '城市美食', value: '为一张台州城市美食地图，写一条适合社交媒体发布的短视频脚本' },
  { label: '效率工具', value: '为经常被会议打断的远程团队，想一个轻量、真正能落地的产品功能' },
] as const

function getModels(payload: unknown): ModelItem[] {
  if (Array.isArray(payload)) return payload as ModelItem[]
  if (!payload || typeof payload !== 'object') return []
  const record = payload as Record<string, unknown>
  if (Array.isArray(record.data)) return record.data as ModelItem[]
  if (record.data && typeof record.data === 'object') {
    const data = record.data as Record<string, unknown>
    if (Array.isArray(data.data)) return data.data as ModelItem[]
    if (Array.isArray(data.items)) return data.items as ModelItem[]
  }
  if (Array.isArray(record.items)) return record.items as ModelItem[]
  return []
}

function modelId(item: ModelItem) {
  return String(item.id || item.model || '').trim()
}

function pickTextModel(payload: unknown): ModelItem | null {
  const models = getModels(payload)
  const textModel = models.find((item) => {
    const type = String(item.type || item.model_type || '').toLowerCase()
    return type === 'text' || type === 'llm'
  })
  const selected = textModel || models.find((item) => Boolean(modelId(item)))
  return selected && modelId(selected) ? selected : null
}

function isIdeaMode(value: unknown): value is IdeaMode {
  return MODES.some((item) => item.id === value)
}

function makeId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  return `idea-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
}

function normalizeStoredIdea(value: unknown): StoredIdea | null {
  if (!value || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  const brief = typeof record.brief === 'string' ? record.brief.trim() : ''
  const result = typeof record.result === 'string' ? record.result : ''
  if (!brief || !result) return null
  return {
    id: typeof record.id === 'string' && record.id ? record.id : makeId(),
    brief,
    mode: isIdeaMode(record.mode) ? record.mode : 'campaign',
    result,
    savedAt: typeof record.savedAt === 'string' && record.savedAt ? record.savedAt : '此前',
  }
}

function readResponseText(payload: unknown): string {
  if (!payload || typeof payload !== 'object') return typeof payload === 'string' ? payload : ''
  const record = payload as Record<string, unknown>
  if (typeof record.output_text === 'string') return record.output_text.trim()
  if (typeof record.text === 'string') return record.text.trim()
  if (typeof record.content === 'string') return record.content.trim()

  const output = Array.isArray(record.output) ? record.output : []
  const parts: string[] = []
  for (const item of output) {
    if (!item || typeof item !== 'object') continue
    const value = item as Record<string, unknown>
    if (typeof value.text === 'string') parts.push(value.text)
    if (Array.isArray(value.content)) {
      for (const content of value.content) {
        if (!content || typeof content !== 'object') continue
        const contentValue = content as Record<string, unknown>
        if (typeof contentValue.text === 'string') parts.push(contentValue.text)
        if (contentValue.type === 'output_text' && typeof contentValue.value === 'string') parts.push(contentValue.value)
      }
    }
  }
  return parts.join('\n').trim()
}

function readStreamDelta(payload: unknown): string {
  if (!payload || typeof payload !== 'object') return typeof payload === 'string' ? payload : ''
  const record = payload as Record<string, unknown>
  if (typeof record.delta === 'string') return record.delta
  if (typeof record.text_delta === 'string') return record.text_delta

  const choices = Array.isArray(record.choices) ? record.choices : []
  const firstChoice = choices[0]
  if (firstChoice && typeof firstChoice === 'object') {
    const choice = firstChoice as Record<string, unknown>
    const delta = choice.delta
    if (typeof delta === 'string') return delta
    if (delta && typeof delta === 'object' && typeof (delta as Record<string, unknown>).content === 'string') {
      return String((delta as Record<string, unknown>).content)
    }
  }
  return ''
}

function readStreamFailure(payload: unknown): string {
  if (!payload || typeof payload !== 'object') return ''
  const record = payload as Record<string, unknown>
  const response = record.response && typeof record.response === 'object'
    ? record.response as Record<string, unknown>
    : record
  const responseError = response.error && typeof response.error === 'object'
    ? response.error as Record<string, unknown>
    : null
  const message = responseError?.message || record.message
  return (record.type === 'response.failed' || record.type === 'error') && typeof message === 'string'
    ? message
    : ''
}

function errorDetail(error: unknown): ErrorDetail {
  const sdkError = error as Partial<AppSdkError>
  const message = typeof sdkError?.message === 'string' && sdkError.message.trim()
    ? sdkError.message.trim()
    : '暂时无法连接平台，请稍后重试。'
  return {
    message,
    code: typeof sdkError?.code === 'string' ? sdkError.code : undefined,
    requestId: typeof sdkError?.requestId === 'string' ? sdkError.requestId : undefined,
  }
}

function truncateText(value: string, length: number) {
  const normalized = value.replace(/\s+/g, ' ').trim()
  return normalized.length > length ? `${normalized.slice(0, length)}...` : normalized
}

function App() {
  const [brief, setBrief] = React.useState('')
  const [mode, setMode] = React.useState<IdeaMode>('campaign')
  const [modelInfo, setModelInfo] = React.useState<ModelItem | null>(null)
  const [result, setResult] = React.useState('')
  const [savedAt, setSavedAt] = React.useState('')
  const [history, setHistory] = React.useState<StoredIdea[]>([])
  const [loading, setLoading] = React.useState(true)
  const [generating, setGenerating] = React.useState(false)
  const [status, setStatus] = React.useState('正在连接创作平台...')
  const [statusKind, setStatusKind] = React.useState<StatusKind>('loading')
  const [error, setError] = React.useState<ErrorDetail | null>(null)
  const textareaRef = React.useRef<HTMLTextAreaElement>(null)
  const abortRef = React.useRef<AbortController | null>(null)

  React.useEffect(() => {
    let active = true
    const load = async () => {
      try {
        await app.platform.createSession()
        const [modelsPayload, previousPayload, historyPayload] = await Promise.all([
          app.api.request('/models'),
          app.storage.get<unknown>(LAST_RESULT_KEY),
          app.storage.get<unknown>(HISTORY_KEY),
        ])
        if (!active) return

        const selectedModel = pickTextModel(modelsPayload)
        const loadedHistory = Array.isArray(historyPayload)
          ? historyPayload.map(normalizeStoredIdea).filter((item): item is StoredIdea => Boolean(item))
          : []
        const legacyIdea = normalizeStoredIdea(previousPayload)
        const recoveredHistory = legacyIdea && !loadedHistory.some((item) => item.id === legacyIdea.id)
          ? [legacyIdea, ...loadedHistory].slice(0, MAX_HISTORY)
          : loadedHistory.slice(0, MAX_HISTORY)
        const recovered = recoveredHistory[0] || legacyIdea

        setModelInfo(selectedModel)
        setHistory(recoveredHistory)
        if (recovered) {
          setBrief(recovered.brief)
          setMode(recovered.mode)
          setResult(recovered.result)
          setSavedAt(recovered.savedAt)
        }
        if (legacyIdea && !loadedHistory.length) {
          void app.storage.set(HISTORY_KEY, recoveredHistory).catch(() => undefined)
        }
        setStatus(selectedModel ? '平台已就绪' : '暂无可用文本模型')
        setStatusKind(selectedModel ? 'ready' : 'error')
      } catch (loadError) {
        if (active) {
          const detail = errorDetail(loadError)
          setStatus(detail.message)
          setStatusKind('error')
        }
      } finally {
        if (active) setLoading(false)
      }
    }
    void load()
    return () => {
      active = false
      abortRef.current?.abort()
    }
  }, [])

  const currentMode = MODES.find((item) => item.id === mode) || MODES[0]
  const model = modelId(modelInfo || {})
  const modelDisplay = modelInfo?.name && modelInfo.name !== model ? `${modelInfo.name} · ${model}` : model

  const persistIdea = async (idea: StoredIdea) => {
    const storedIdea: StoredIdea = {
      ...idea,
      result: idea.result.slice(0, MAX_STORED_RESULT_LENGTH),
    }
    const nextHistory = [storedIdea, ...history.filter((item) => item.id !== storedIdea.id)].slice(0, MAX_HISTORY)
    setHistory(nextHistory)
    try {
      await Promise.all([
        app.storage.set(HISTORY_KEY, nextHistory),
        app.storage.set(LAST_RESULT_KEY, storedIdea),
      ])
    } catch {
      // The generated result remains usable when optional persistence is unavailable.
    }
  }

  const generate = async () => {
    if (!brief.trim() || !model || generating) return
    const prompt = `你是一个清晰、务实的创意顾问。请围绕“${brief.trim()}”生成${currentMode.label}。${currentMode.hint}。输出结构清晰、可直接执行的中文方案，不要解释你的身份。`
    const controller = new AbortController()
    abortRef.current?.abort()
    abortRef.current = controller
    setGenerating(true)
    setResult('')
    setSavedAt('')
    setError(null)
    setStatus('正在生成你的方案...')
    setStatusKind('working')

    let output = ''
    let lastEventData: unknown = null
    try {
      for await (const event of app.api.stream<Record<string, unknown>>('/responses/stream', {
        method: 'POST',
        signal: controller.signal,
        body: JSON.stringify({ model, input: prompt }),
      })) {
        lastEventData = event.data
        const streamFailure = readStreamFailure(event.data)
        if (streamFailure) throw new Error(streamFailure)
        const delta = readStreamDelta(event.data)
        if (delta) {
          output += delta
          setResult(output)
        }
      }

      if (!output.trim()) {
        const finalPayload = lastEventData && typeof lastEventData === 'object' && 'response' in lastEventData
          ? (lastEventData as Record<string, unknown>).response
          : lastEventData
        output = readResponseText(finalPayload)
      }
      if (!output.trim()) throw new Error('平台没有返回可展示的文本。')

      const now = new Date().toLocaleString('zh-CN', { hour12: false })
      const idea: StoredIdea = { id: makeId(), brief: brief.trim(), mode, result: output.trim(), savedAt: now }
      setResult(idea.result)
      setSavedAt(now)
      await persistIdea(idea)
      setStatus('已生成，草稿已保存')
      setStatusKind('success')
    } catch (generationError) {
      if (controller.signal.aborted) return
      const detail = errorDetail(generationError)
      setError(detail)
      setStatus(detail.message)
      setStatusKind('error')
      if (output) setResult(output)
    } finally {
      if (abortRef.current === controller) abortRef.current = null
      setGenerating(false)
    }
  }

  const copyResult = async () => {
    if (!result) return
    try {
      if (!navigator.clipboard) throw new Error('clipboard unavailable')
      await navigator.clipboard.writeText(result)
      setStatus('已复制到剪贴板')
      setStatusKind('success')
    } catch {
      setStatus('复制失败，请手动选择文本')
      setStatusKind('error')
    }
  }

  const useResultAsBrief = () => {
    if (!result) return
    setBrief(result)
    setStatus('已将结果放入输入区，可以继续修改')
    setStatusKind('ready')
    window.requestAnimationFrame(() => textareaRef.current?.focus())
  }

  const clearResult = async () => {
    setResult('')
    setSavedAt('')
    setError(null)
    setStatus('结果已清除，历史记录仍保留')
    setStatusKind('ready')
    try {
      await app.storage.delete(LAST_RESULT_KEY)
    } catch {
      // Clearing the local view is still valid when persistence is unavailable.
    }
  }

  const clearBrief = () => {
    setBrief('')
    textareaRef.current?.focus()
  }

  const restoreIdea = (idea: StoredIdea) => {
    setBrief(idea.brief)
    setMode(idea.mode)
    setResult(idea.result)
    setSavedAt(idea.savedAt)
    setError(null)
    setStatus('已恢复历史草稿')
    setStatusKind('ready')
  }

  const removeIdea = async (id: string) => {
    const nextHistory = history.filter((item) => item.id !== id)
    setHistory(nextHistory)
    try {
      await app.storage.set(HISTORY_KEY, nextHistory)
    } catch {
      // History removal is best effort; the current workspace is unaffected.
    }
  }

  const chooseExample = (value: string) => {
    setBrief(value)
    setError(null)
    setStatus('示例已放入输入区')
    setStatusKind(model ? 'ready' : 'error')
    window.requestAnimationFrame(() => textareaRef.current?.focus())
  }

  const handlePromptKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
      event.preventDefault()
      void generate()
    }
  }

  return (
    <main className="shell">
      <header className="topbar">
        <div className="brand-mark" aria-hidden="true"><span>✦</span></div>
        <div className="brand-copy">
          <p className="eyebrow">CREATIVE DESK</p>
          <h1>灵感闪现</h1>
        </div>
        <div className="topbar-right">
          <div className="model-pill" title={modelDisplay || '当前没有可用文本模型'}>
            <i className={model ? 'online' : ''} />
            <span>平台模型</span>
            <strong>{loading ? '读取中' : modelDisplay || '暂无'}</strong>
          </div>
          <div className={`status ${statusKind}`}><i />{status}</div>
        </div>
      </header>

      <section className="intro">
        <div className="intro-copy">
          <p className="kicker">FROM THOUGHT TO NEXT STEP</p>
          <h2>把想法写下来，<em>让它开始成形。</em></h2>
          <p className="subcopy">选择一个方向，写下你正在思考的事。先得到一版能继续修改的方案，再把它做得更好。</p>
        </div>
        <div className="idea-note" aria-hidden="true">
          <span>01</span>
          <strong>MAKE<br />IT CLEAR</strong>
          <b>↗</b>
        </div>
      </section>

      <section className="workspace">
        <div className="composer panel">
          <div className="panel-heading">
            <span className="step">01</span>
            <div><h3>选择创作方向</h3><p>先确定你想要的结果</p></div>
          </div>
          <div className="mode-list" role="radiogroup" aria-label="创作方向">
            {MODES.map((item) => (
              <button
                aria-checked={mode === item.id}
                className={`mode ${mode === item.id ? 'active' : ''}`}
                key={item.id}
                onClick={() => setMode(item.id)}
                role="radio"
                type="button"
              >
                <span className="mode-index">0{MODES.indexOf(item) + 1}</span>
                <span className="mode-copy"><strong>{item.label}</strong><small>{item.hint}</small></span>
                <b aria-hidden="true">{mode === item.id ? '✓' : '＋'}</b>
              </button>
            ))}
          </div>

          <div className="prompt-heading panel-heading">
            <span className="step">02</span>
            <div><h3>说说你的想法</h3><p>越具体，结果越贴近你的需要</p></div>
          </div>
          <div className="textarea-wrap">
            <textarea
              ref={textareaRef}
              value={brief}
              onChange={(event) => setBrief(event.target.value)}
              onKeyDown={handlePromptKeyDown}
              placeholder="例如：为一款帮助上班族放松的茶饮，设计一个有记忆点的春季营销方案"
              maxLength={1000}
              aria-label="创作想法"
            />
            {brief && <button className="clear-input" type="button" onClick={clearBrief} title="清空输入" aria-label="清空输入">×</button>}
          </div>
          <div className="examples" aria-label="示例想法">
            <span>试试：</span>
            {EXAMPLES.map((example) => <button key={example.label} type="button" onClick={() => chooseExample(example.value)}>{example.label}</button>)}
          </div>
          <div className="composer-footer">
            <span>{brief.length}/1000</span>
            <button className="primary" disabled={loading || generating || !brief.trim() || !model} onClick={() => void generate()} type="button">
              {generating ? '生成中...' : '开始生成'}<b>↗</b>
            </button>
          </div>
        </div>

        <div className="result panel">
          <div className="result-heading">
            <div className="panel-heading"><span className="step">03</span><div><h3>你的创意方案</h3><p>{savedAt ? `最近保存于 ${savedAt}` : '生成结果会保存在这里'}</p></div></div>
            <div className="result-tools">
              <button className="icon-button" type="button" onClick={() => void copyResult()} disabled={!result || generating} title="复制结果" aria-label="复制结果">⧉</button>
              <button className="icon-button" type="button" onClick={() => void clearResult()} disabled={!result || generating} title="清除当前结果" aria-label="清除当前结果">×</button>
            </div>
          </div>
          <div className={`result-body ${result ? 'has-result' : ''} ${generating ? 'is-generating' : ''}`}>
            {generating && <div className="generating-state"><div className="spinner" /><strong>正在把想法整理成方案</strong><span>平台正在生成内容，结果会实时出现在这里</span>{result && <div className="stream-preview">{result}</div>}<div className="skeleton-lines"><i /><i /><i /><i /></div></div>}
            {!generating && error && <div className="error-state"><div className="error-icon">!</div><strong>这次没有生成成功</strong><span>{error.message}</span>{error.requestId && <small>请求编号 {error.requestId}</small>}<button className="secondary" type="button" onClick={() => void generate()} disabled={!model || !brief.trim()}>↻ 重试</button></div>}
            {!generating && !error && result && <div className="result-text">{result}</div>}
            {!generating && !error && !result && <div className="empty-state"><div className="empty-icon">✦</div><strong>准备好让想法生长了吗？</strong><span>从左侧写下一句话，方案会在这里展开</span></div>}
          </div>
          {result && !generating && <div className="result-actions"><span><i>✦</i> 第一版草稿，可以继续打磨</span><div><button className="secondary" type="button" onClick={useResultAsBrief}>↗ 继续创作</button><button className="secondary" type="button" onClick={() => void generate()} disabled={!model || !brief.trim()}>↻ 重新生成</button></div></div>}
        </div>
      </section>

      <section className="history-section" aria-labelledby="history-title">
        <div className="history-heading">
          <div><p className="kicker">YOUR WORKSPACE</p><h3 id="history-title">最近草稿</h3></div>
          <span>{history.length ? `${history.length} / ${MAX_HISTORY}` : '还没有草稿'}</span>
        </div>
        {history.length ? <div className="history-list">{history.map((idea) => <div className="history-row" key={idea.id}><button className="history-open" type="button" onClick={() => restoreIdea(idea)}><span className="history-mode">{MODES.find((item) => item.id === idea.mode)?.label || '创作'}</span><strong>{truncateText(idea.brief, 46)}</strong><small>{idea.savedAt}</small></button><button className="history-delete" type="button" onClick={() => void removeIdea(idea.id)} title="删除草稿" aria-label={`删除草稿：${truncateText(idea.brief, 20)}`}>×</button></div>)}</div> : <div className="history-empty"><span>生成后的方案会按时间保存在这里，方便继续修改。</span></div>}
      </section>

      <footer><span>Powered by Proxy Platform</span><span>模型由平台统一提供 · 结果仅供创作参考</span></footer>
    </main>
  )
}

createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>)
