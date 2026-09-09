import { useState } from 'react'
import {
  ArrowDownToLine,
  Check,
  ChevronDown,
  CircleAlert,
  Copy,
  Download,
  Expand,
  Images,
  LoaderCircle,
  Plus,
  RefreshCw,
  Rows3,
  Trash2,
} from 'lucide-react'
import type { Work } from './core.ts'
import './quality.css'

export const KIND_LABELS = {
  tryon: '服饰穿戴',
  model: 'AI 模特',
  product: '商品套图',
  detail: 'A+ 详情页',
  clone: '爆款图复刻',
}
const STATUS = {
  queued: '等待提交',
  running: '正在生成',
  completed: '已完成',
  failed: '生成失败',
  paused: '待查询',
  skipped: '未提交',
}

function WorkNotes({
  work,
  busy,
  onReview,
  canReview,
}: {
  work: Work
  busy: boolean
  onReview?: (work: Work) => void | Promise<void>
  canReview?: (work: Work) => boolean
}) {
  const [reviewing, setReviewing] = useState(false)
  const [reviewError, setReviewError] = useState('')
  const report = work.quality
  const reviewAllowed = !!onReview && !!canReview?.(work)
  const statusText = !report
    ? '待检查'
    : report.status === 'passed'
      ? '未发现明显问题'
      : report.status === 'needs_review'
        ? `需人工确认 · ${report.issues.length} 项`
        : '检查未完成'

  async function review() {
    if (!reviewAllowed || busy || reviewing) return
    setReviewing(true)
    setReviewError('')
    try {
      await onReview!(work)
    } catch (error) {
      setReviewError(
        error instanceof Error ? error.message : '检查未完成，请稍后重试。',
      )
    } finally {
      setReviewing(false)
    }
  }

  return (
    <div className="work-notes">
      {work.plan && (
        <details className="work-plan">
          <summary>
            <span>逐图规划</span>
            <ChevronDown size={13} />
          </summary>
          <div className="work-plan-content">
            <strong>{work.plan.direction}</strong>
            <p>{work.plan.brief}</p>
          </div>
        </details>
      )}
      {work.images.length > 0 && (
        <details
          className={`work-quality ${report?.status || 'pending'}`}
          open={
            report?.status === 'needs_review' ||
            report?.status === 'unavailable'
          }
        >
          <summary>
            {reviewing ? (
              <LoaderCircle size={13} className="spin" />
            ) : report?.status === 'passed' ? (
              <Check size={13} />
            ) : (
              <CircleAlert size={13} />
            )}
            <span>图片检查</span>
            <small>{reviewing ? '正在检查' : statusText}</small>
            <ChevronDown size={13} />
          </summary>
          <div className="work-quality-content">
            <p>{report?.summary || '这张图片尚未完成质量检查。'}</p>
            {!!report?.issues.length && (
              <ul>
                {report.issues.map((issue, index) => (
                  <li key={`${index}-${issue}`}>{issue}</li>
                ))}
              </ul>
            )}
            {report?.checkedAt &&
              Number.isFinite(Date.parse(report.checkedAt)) && (
                <time dateTime={report.checkedAt}>
                  检查于{' '}
                  {new Date(report.checkedAt).toLocaleString('zh-CN', {
                    month: '2-digit',
                    day: '2-digit',
                    hour: '2-digit',
                    minute: '2-digit',
                  })}
                </time>
              )}
            {report?.status !== 'passed' && (
              <div className="work-review-action">
                {reviewAllowed ? (
                  <button
                    type="button"
                    className="secondary"
                    disabled={busy || reviewing}
                    onClick={() => void review()}
                  >
                    {reviewing ? (
                      <LoaderCircle size={13} className="spin" />
                    ) : (
                      <RefreshCw size={13} />
                    )}
                    {reviewing ? '正在检查' : report ? '再次检查' : '检查图片'}
                  </button>
                ) : (
                  <span>重新检查需要本次会话的原始素材。</span>
                )}
                <small>成图可继续预览和下载。</small>
              </div>
            )}
            {reviewError && (
              <p className="work-review-error" role="alert">
                {reviewError}
              </p>
            )}
          </div>
        </details>
      )}
    </div>
  )
}

export function WorksPanel({
  works,
  title = '本次作品',
  busy,
  downloading,
  filter,
  onFilter,
  onDownload,
  onDownloadAll,
  onPreview,
  onResume,
  onRemove,
  onStart,
  onStitch,
  onCopy,
  onReview,
  canReview,
}: {
  works: Work[]
  title?: string
  busy: boolean
  downloading: boolean
  filter: string
  onFilter: (value: string) => void
  onDownload: (url: string) => void
  onDownloadAll: () => void
  onPreview: (url: string, title: string) => void
  onResume: (work: Work) => void
  onRemove: (id: string) => void
  onStart: () => void
  onStitch: (batch: string) => void
  onCopy: (text: string) => void
  onReview?: (work: Work) => void | Promise<void>
  canReview?: (work: Work) => boolean
}) {
  const visible = works.filter(
    (work) => filter === 'all' || work.status === filter,
  )
  const detailBatches = [
    ...new Set(
      works.filter((work) => work.kind === 'detail').map((work) => work.batch),
    ),
  ]
  const listings = works.filter((work) => work.text)
  return (
    <div className="results-workspace">
      <div className="results-toolbar">
        <div className="result-count">
          <h2>{title}</h2>
          <span>{visible.length} 张作品</span>
        </div>
        <div className="results-controls">
          <select
            aria-label="作品状态"
            value={filter}
            onChange={(e) => onFilter(e.target.value)}
          >
            <option value="all">全部状态</option>
            <option value="completed">已完成</option>
            <option value="paused">待查询</option>
            <option value="failed">生成失败</option>
            <option value="skipped">未提交</option>
          </select>
          <button
            className="secondary"
            disabled={
              downloading ||
              !visible.some((work) => work.images.length || work.text)
            }
            onClick={onDownloadAll}
          >
            {downloading ? (
              <LoaderCircle className="spin" size={15} />
            ) : (
              <Download size={15} />
            )}
            打包下载
          </button>
        </div>
      </div>
      {detailBatches.map((batch, index) => {
        const parts = works.filter((work) => work.batch === batch)
        const total = parts[0].batchSize || parts.length
        const complete =
          parts.length === parts[0].batchSize &&
          parts.every(
            (work) => work.status === 'completed' && work.images.length,
          )
        return (
          <div className="detail-export" key={batch}>
            <div>
              <strong>
                详情页{detailBatches.length > 1 ? ` ${index + 1}` : ''}
              </strong>
              <span>
                {parts.filter((work) => work.status === 'completed').length} /{' '}
                {total} 个模块已完成
              </span>
            </div>
            <button
              className="secondary"
              disabled={!complete || downloading || busy}
              onClick={() => onStitch(batch)}
            >
              <Rows3 size={15} />
              下载详情长图
            </button>
          </div>
        )
      })}
      {listings.map((work) => (
        <details className="listing-copy" key={work.id} open>
          <summary>商品上架文案</summary>
          <div className="listing-actions">
            <button className="secondary" onClick={() => onCopy(work.text!)}>
              <Copy size={14} />
              复制文案
            </button>
          </div>
          <pre>{work.text}</pre>
        </details>
      ))}
      {visible.length ? (
        <div className="works-grid">
          {visible.map((work) => (
            <article className="work" key={work.id}>
              <div
                className="work-image"
                style={{
                  aspectRatio: work.ratio?.replace(':', '/') || '1 / 1',
                }}
              >
                {work.images.length ? (
                  <button
                    className="work-preview"
                    onClick={() => onPreview(work.images[0].url, work.title)}
                    aria-label={`预览${work.title}`}
                  >
                    <img src={work.images[0].url} alt={work.title} />
                    <span className="image-expand">
                      <Expand size={18} />
                    </span>
                  </button>
                ) : (
                  <div className="work-placeholder">
                    {work.status === 'running' ? (
                      <LoaderCircle size={28} className="spin" />
                    ) : work.status === 'failed' ? (
                      <CircleAlert size={28} />
                    ) : (
                      <Images size={28} />
                    )}
                    <strong>{STATUS[work.status] || '待查询'}</strong>
                    {work.error && <p>{work.error}</p>}
                    {work.taskId && work.status === 'paused' && (
                      <button
                        className="secondary"
                        onClick={() => onResume(work)}
                        disabled={busy}
                      >
                        <RefreshCw size={14} />
                        继续查询
                      </button>
                    )}
                  </div>
                )}
                <span className={`work-status ${work.status}`}>
                  {STATUS[work.status]}
                </span>
              </div>
              <div className="work-meta">
                <div>
                  <strong>{work.title}</strong>
                  <span>
                    {KIND_LABELS[work.kind] || '创作'} ·{' '}
                    {work.scene.split('：')[0].slice(0, 22)}
                  </span>
                </div>
                {work.images.length > 0 && (
                  <button
                    className="icon-button"
                    aria-label={`下载${work.title}`}
                    title="下载图片"
                    onClick={() => onDownload(work.images[0].url)}
                  >
                    <ArrowDownToLine size={17} />
                  </button>
                )}
                {!['running', 'queued'].includes(work.status) && (
                  <button
                    className="icon-button"
                    aria-label={`移除${work.title}记录`}
                    title="移除记录"
                    disabled={busy}
                    onClick={() => onRemove(work.id)}
                  >
                    <Trash2 size={15} />
                  </button>
                )}
              </div>
              <div className="work-date">
                {new Date(work.createdAt).toLocaleString('zh-CN', {
                  month: '2-digit',
                  day: '2-digit',
                  hour: '2-digit',
                  minute: '2-digit',
                })}{' '}
                · {work.ratio}
              </div>
              <WorkNotes
                work={work}
                busy={busy}
                onReview={onReview}
                canReview={canReview}
              />
            </article>
          ))}
        </div>
      ) : (
        <div className="empty-works">
          <Images size={38} />
          <h2>{filter === 'all' ? '还没有作品' : '没有匹配的作品'}</h2>
          <button className="secondary" onClick={onStart}>
            <Plus size={15} />
            开始创作
          </button>
        </div>
      )}
    </div>
  )
}
