import { useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Check, ChevronDown, Download, Info, LoaderCircle, RefreshCw, X } from 'lucide-react'
import { friendlyErrorMessage, type Work } from './core.ts'
import { fetchImage, imageExtension, saveBlob } from './images.ts'
import { workPlanDisplay } from './workPlanDisplay.ts'
import './WorkDetails.css'

export function WorkDetails({ work, busy, onClose, onReview, canReview, resolveImageURL }: {
  work: Work
  busy: boolean
  onClose: () => void
  onReview?: (work: Work) => void | Promise<void>
  canReview?: (work: Work) => boolean
  resolveImageURL?: (url: string) => Promise<string>
}) {
  const ref = useRef<HTMLDialogElement>(null)
  const titleId = useId()
  const [reviewing, setReviewing] = useState(false)
  const [error, setError] = useState('')
  const [downloading, setDownloading] = useState(false)
  const report = work.quality
  const checking = reviewing || report?.status === 'checking'
  const plan = workPlanDisplay(work.plan)
  const reviewAllowed = !!onReview && !!canReview?.(work)
  const image = work.images[0]?.url

  useEffect(() => {
    const dialog = ref.current!
    const previous = document.activeElement
    dialog.showModal()
    return () => {
      dialog.close()
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus({ preventScroll: true })
    }
  }, [])

  async function review() {
    if (!reviewAllowed || busy || checking) return
    setReviewing(true)
    setError('')
    try { await onReview!(work) }
    catch (error) { setError(friendlyErrorMessage(error, '检查未完成，请稍后重试。')) }
    finally { setReviewing(false) }
  }

  async function download() {
    if (!image || downloading) return
    setDownloading(true)
    setError('')
    try {
      const blob = await fetchImage(resolveImageURL ? await resolveImageURL(image) : image)
      saveBlob(blob, `design-${Date.now()}.${imageExtension(blob)}`)
    } catch (error) { setError(friendlyErrorMessage(error, '下载失败，请稍后重试。')) }
    finally { setDownloading(false) }
  }

  return createPortal(
    <dialog
      ref={ref}
      className="work-detail-dialog"
      aria-labelledby={titleId}
      onCancel={(event) => { event.preventDefault(); onClose() }}
      onClick={(event) => { if (event.target === ref.current) onClose() }}
    >
      {error && <div className="toast error-toast work-detail-toast" role="alert">
        <Info size={16} aria-hidden="true" /><span className="error-toast-message">{error}</span>
        <button type="button" className="icon-button" aria-label="关闭提示" onClick={() => setError('')}><X size={15} /></button>
      </div>}
      <header className="work-detail-header">
        <div><span>{image ? '图片详情' : '任务详情'}</span><h2 id={titleId}>{work.title}</h2></div>
        <button type="button" className="icon-button" aria-label="关闭图片详情" onClick={onClose} autoFocus><X size={19} /></button>
      </header>
      <div className={`work-detail-body ${image ? '' : 'without-image'}`}>
        {image && <div className="work-detail-preview"><img src={image} alt={work.title} /></div>}
        <div className="work-detail-content">
          <div className="work-detail-meta">
            {work.ratio && <span>{work.ratio}</span>}
            {Number.isFinite(Date.parse(work.createdAt)) && <time dateTime={work.createdAt}>{new Date(work.createdAt).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}</time>}
          </div>
          {image && work.error && <p className="work-detail-hint">{work.error}</p>}
          {!image && work.error && <section className="work-detail-error" aria-label="任务状态">
            <h3>{work.status === 'paused' ? '尚未取得结果' : work.status === 'skipped' ? '尚未提交生成' : '本张未能生成'}</h3>
            <p>{work.error}</p>
          </section>}
          {image && <section className="work-detail-review" aria-label="检查建议">
            <div className="work-detail-section-title">
              <h3>检查建议</h3>
              {checking ? <span className="work-detail-checking"><LoaderCircle size={13} className="spin" aria-hidden="true" />检查中</span>
                : report?.status === 'passed' ? <span className="work-detail-passed"><Check size={13} />未发现明显问题</span>
                  : report?.status === 'needs_review' ? <span className="work-detail-count">{report.issues.length} 项建议</span>
                    : <span className="work-detail-review-state">{report ? '未完成' : '未检查'}</span>}
            </div>
            <p className="work-detail-hint">供选图时参考，不影响使用和下载。</p>
            {checking ? <p className="work-detail-empty" role="status">检查完成后会自动更新，可关闭详情继续浏览。</p> : report ? <>
              <p className="work-detail-summary">{report.summary}</p>
              {report.issues.length > 0 && <ul className="work-detail-issues">
                {report.issues.map((issue, index) => {
                  const marked = issue.match(/^【(可见差异|无法判断)】\s*(.+)$/s)
                  return <li key={`${index}-${issue}`}>
                    <span className="work-detail-issue-number">{index + 1}</span>
                    <div>{marked && <span className={`work-detail-issue-kind ${marked[1] === '无法判断' ? 'uncertain' : ''}`}>{marked[1]}</span>}<p>{marked ? marked[2] : issue}</p></div>
                  </li>
                })}
              </ul>}
            </> : <p className="work-detail-empty"><Info size={15} />暂未检查，图片已可预览和下载。</p>}
            {!checking && report?.status !== 'passed' && <div className="work-detail-review-action">
              {reviewAllowed ? <>
                <button type="button" className="secondary" disabled={busy} onClick={() => void review()}>
                  <RefreshCw size={13} />
                  {report ? '重新检查' : '检查图片'}
                </button>
                <small>使用账户模型额度</small>
              </> : <small>缺少原始素材，暂无法重新检查。</small>}
            </div>}
          </section>}
          {(plan.direction || plan.brief) && <details className="work-detail-plan">
            <summary><span>创作说明</span><span className="work-detail-plan-summary-hint">生成依据与构图描述</span><ChevronDown size={15} /></summary>
            {plan.brief && <div><h4>本图构图</h4><p>{plan.brief}</p></div>}
            {plan.direction && plan.direction !== plan.brief && <div><h4>整套风格</h4><p>{plan.direction}</p></div>}
          </details>}
          {!image && !work.error && !plan.direction && !plan.brief && <p className="work-detail-empty">图片尚未生成，暂无更多说明。</p>}
        </div>
      </div>
      <footer className="work-detail-footer">
        <button type="button" className="secondary" onClick={onClose}>返回浏览</button>
        {image && <button type="button" className="primary" disabled={downloading} onClick={() => void download()}>{downloading ? <LoaderCircle size={15} className="spin" /> : <Download size={15} />}{downloading ? '准备下载…' : '下载图片'}</button>}
      </footer>
    </dialog>, document.body,
  )
}
