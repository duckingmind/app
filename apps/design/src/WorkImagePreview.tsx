import { useState } from 'react'
import { Expand, ImageOff, LoaderCircle, RefreshCw } from 'lucide-react'

/** Preview loading is independent of the generation task's persisted state. */
export function WorkImagePreview({ url, title, onPreview, onReload }: {
  url: string
  title: string
  onPreview: (url: string, title: string) => void
  onReload?: () => Promise<void>
}) {
  const [status, setStatus] = useState<'loading' | 'ready' | 'failed'>('loading')
  const [attempt, setAttempt] = useState(0)

  async function reload() {
    setStatus('loading')
    try { await onReload?.(); setAttempt(value => value + 1) }
    catch { setStatus('failed') }
  }

  return <>
    <button
      type="button"
      className={`work-preview preview-${status}`}
      onClick={() => onPreview(url, title)}
      aria-label={`预览${title}`}
      disabled={status !== 'ready'}
    >
      <img
        key={attempt}
        src={url}
        alt={title}
        decoding="async"
        onLoad={(event) => setStatus(event.currentTarget.naturalWidth > 0 ? 'ready' : 'failed')}
        onError={() => setStatus('failed')}
      />
      {status === 'ready' && <span className="image-expand"><Expand size={18} /></span>}
    </button>
    {status === 'loading' && <div className="work-preview-state" role="status">
      <LoaderCircle size={22} className="spin" aria-hidden="true" />
      <strong>正在加载预览</strong>
    </div>}
    {status === 'failed' && <div className="work-preview-state" role="status">
      <ImageOff size={24} aria-hidden="true" />
      <strong>预览加载失败</strong>
      <span>重新加载仅刷新预览，不会发起生成。</span>
      <button type="button" className="secondary" onClick={() => void reload()}>
        <RefreshCw size={14} aria-hidden="true" />重新加载预览
      </button>
    </div>}
  </>
}
