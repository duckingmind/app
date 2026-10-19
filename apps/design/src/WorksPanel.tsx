import { useEffect, useRef, useState } from 'react'
import {
  ArrowDownToLine,
  ChevronRight,
  Download,
  Images,
  LoaderCircle,
  MoreHorizontal,
  Plus,
  RefreshCw,
  Rows3,
  Trash2,
} from 'lucide-react'
import { type Work } from './core.ts'
import { DropdownSelect } from './DropdownSelect.tsx'
import { WorkDetails } from './WorkDetails.tsx'
import { WorkImagePreview } from './WorkImagePreview.tsx'
import { downloadableImageCount, workRecovery } from './workRecovery.ts'
import './ResultsPanel.css'

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
  completed: '已生成',
  failed: '生成失败',
  paused: '待查询',
  skipped: '未提交',
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
  onRefresh,
  resolveImageURL,
  onRemove,
  onStart,
  onStitch,
  onConfigure,
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
  onRefresh?: (work: Work) => Promise<Work>
  resolveImageURL?: (url: string) => Promise<string>
  onRemove: (id: string) => void
  onStart: () => void
  onStitch: (batch: string) => void
  onConfigure?: (work: Work) => void
  onReview?: (work: Work) => void | Promise<void>
  canReview?: (work: Work) => boolean
}) {
  const [detailId, setDetailId] = useState<string | null>(null)
  const detailWork = works.find(work => work.id === detailId)
  const visible = works.filter(
    (work) => filter === 'all' || work.status === filter,
  )
  const readyCount = works.filter((work) => work.images.length > 0).length
  const pendingCount = works.filter(
    (work) => !work.images.length && ['queued', 'running', 'paused'].includes(work.status),
  ).length
  const unfinishedCount = works.length - readyCount - pendingCount
  const renderable = visible.filter((work) => work.images.length > 0)
  const incomplete = visible.filter((work) => !work.images.length)
  const downloadableCount = downloadableImageCount(visible)
  const statusOptions = Object.entries(STATUS)
    .map(([value, label]) => ({
      value,
      label: `${label} · ${works.filter((work) => work.status === value).length}`,
      count: works.filter((work) => work.status === value).length,
    }))
    .filter((option) => option.count > 0 || option.value === filter)
    .map(({ count: _count, ...option }) => option)
  const detailBatches = [
    ...new Set(
      visible.filter((work) => work.kind === 'detail').map((work) => work.batch),
    ),
  ]
  const listings = visible.filter((work) => work.text)
  return (
    <div className="results-workspace">
      <div className="results-toolbar">
        <div className="result-count">
          <h2>{title}</h2>
          <div className="result-summary" aria-label="作品概况">
            <span>共 {works.length} 项</span>
            <span className="result-ready">已生成 <b>{readyCount} / {works.length}</b> 项</span>
            {pendingCount > 0 && <span>待处理 <b>{pendingCount}</b></span>}
            {unfinishedCount > 0 && <span>未完成 <b>{unfinishedCount}</b></span>}
            {filter !== 'all' && <span className="result-filter-count">当前 {visible.length} 项</span>}
          </div>
          <span className="sr-only" role="status" aria-live="polite" aria-atomic="true">
            已生成 {readyCount} / {works.length} 项{pendingCount ? `，待处理 ${pendingCount} 项` : ''}{unfinishedCount ? `，未完成 ${unfinishedCount} 项` : ''}
          </span>
        </div>
        <div className="results-controls">
          <DropdownSelect
            label="作品状态"
            value={filter}
            onChange={onFilter}
            options={[
              { value: 'all', label: `全部状态 · ${works.length}` },
              ...statusOptions,
            ]}
          />
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
            {downloading ? '正在打包…' : downloadableCount > 0 ? `下载 ${downloadableCount} 张图片` : listings.length > 0 ? '下载文案' : '下载图片'}
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
        const completedCount = parts.filter(
          (work) => work.status === 'completed' && work.images.length,
        ).length
        return (
          <div className="detail-export" key={batch}>
            <div>
              <strong>
                详情页{detailBatches.length > 1 ? ` ${index + 1}` : ''}
              </strong>
              <span>
                {completedCount} /{' '}
                {total} 个模块已完成
              </span>
            </div>
            <button
              className="secondary"
              disabled={!complete || downloading}
              onClick={() => onStitch(batch)}
            >
              <Rows3 size={15} />
              下载详情长图
            </button>
          </div>
        )
      })}
      {renderable.length || incomplete.length ? (
        <div className="works-grid">
          {incomplete.map((work) => {
            const recovery = workRecovery(work)
            return (
              <article className="work" key={work.id}>
                <div
                  className="work-image"
                  style={{ aspectRatio: work.ratio?.replace(':', '/') || '1 / 1' }}
                >
                  <div className={`work-placeholder work-pending ${work.status}`}>
                    {work.status === 'queued' || work.status === 'running'
                      ? <LoaderCircle size={24} className={work.status === 'running' ? 'spin' : undefined} aria-hidden="true" />
                      : <Images size={24} aria-hidden="true" />}
                    <strong>{STATUS[work.status]}</strong>
                  </div>
                  <span className={`work-status ${work.status}`}>{STATUS[work.status]}</span>
                </div>
                <div className="work-meta">
                  <div>
                    <strong>{work.title}</strong>
                    <span>{KIND_LABELS[work.kind] || '创作'}</span>
                  </div>
                  <WorkMoreMenu work={work} busy={busy} onRemove={onRemove} />
                </div>
                <div className="work-footer">
                  <div className="work-date">
                    {new Date(work.createdAt).toLocaleString('zh-CN', {
                      month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
                    })} · {work.ratio}
                  </div>
                  <div className="work-detail-link-group">
                    <button
                      type="button"
                      className="work-detail-trigger"
                      onClick={() => setDetailId(work.id)}
                    >
                      查看详情<ChevronRight size={13} aria-hidden="true" />
                    </button>
                    {recovery.action === 'query' && (
                      <button type="button" className="work-detail-trigger" onClick={() => onResume(work)} disabled={busy}>
                        <RefreshCw size={13} aria-hidden="true" />继续查询
                      </button>
                    )}
                    {recovery.action === 'configure' && onConfigure && (
                      <button type="button" className="work-detail-trigger" onClick={() => onConfigure(work)} disabled={busy}>
                        <Plus size={13} aria-hidden="true" />准备新任务
                      </button>
                    )}
                  </div>
                </div>
              </article>
            )
          })}
          {renderable.map((work) => (
            <article className="work" key={work.id}>
              <div
                className="work-image"
                style={{
                  aspectRatio: work.ratio?.replace(':', '/') || '1 / 1',
                }}
              >
                <WorkImagePreview key={work.images[0].url} url={work.images[0].url} title={work.title} onPreview={onPreview} onReload={onRefresh ? () => onRefresh(work).then(() => undefined) : undefined} />
                <span className={`work-status ${work.status}`}>
                  {STATUS[work.status]}
                </span>
                {typeof work.position === 'number' && (
                  <span className="work-position" aria-label={`第 ${work.position + 1} 张${work.batchSize ? `，共 ${work.batchSize} 张` : ''}`}>
                    {String(work.position + 1).padStart(2, '0')}
                    {work.batchSize ? ` / ${String(work.batchSize).padStart(2, '0')}` : ''}
                  </span>
                )}
              </div>
              <div className="work-meta">
                <div>
                  <strong>{work.title}</strong>
                  <span>
                    {KIND_LABELS[work.kind] || '创作'}
                    {work.scene && work.scene !== KIND_LABELS[work.kind] && ` · ${work.scene.split('：')[0].slice(0, 22)}`}
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
                {!['running', 'queued'].includes(work.status) && <WorkMoreMenu work={work} busy={busy} onRemove={onRemove} />}
              </div>
              <div className="work-footer">
                <div className="work-date">
                  {new Date(work.createdAt).toLocaleString('zh-CN', {
                    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
                    })} · {work.ratio}
                  </div>
                  {work.error && work.images.length > 0 && (
                    <span className="work-warning" role="status" title={work.error}>
                      结果链接可能过期
                    </span>
                  )}
                  {(work.plan || work.images.length > 0 || work.error) && <div className="work-detail-link-group">
                  {work.images.length > 0 && work.quality?.status === 'checking' && <span className="work-review-note" title="正在检查图片，可直接预览和下载">
                    <LoaderCircle size={11} className="spin" aria-hidden="true" />检查中
                  </span>}
                  <button
                    type="button"
                    className="work-detail-trigger"
                    aria-label={`查看${work.title}详情${work.quality?.status === 'needs_review' ? `，${work.quality.issues.length} 项检查建议` : ''}`}
                    aria-haspopup="dialog"
                    title={work.quality?.status === 'needs_review' ? '检查建议供选图参考，不影响使用和下载' : undefined}
                    onClick={() => setDetailId(work.id)}
                  >
                    {work.quality?.status === 'needs_review' ? `查看 ${work.quality.issues.length} 项检查建议` : '查看详情'}<ChevronRight size={13} aria-hidden="true" />
                  </button>
                </div>}
              </div>
            </article>
          ))}
        </div>
      ) : (
        <div className="empty-works" role="status" aria-live="polite">
          <Images size={38} aria-hidden="true" />
          <div className="empty-works-copy">
            <h2>
              {filter === 'all'
                ? works.length
                  ? '当前暂无可展示的作品'
                  : '开始你的第一张作品'
                : `没有匹配“${STATUS[filter as keyof typeof STATUS] || filter}”的作品`}
            </h2>
            <p>
              {filter === 'all'
                ? works.length
                  ? '可以切换作品状态，或继续创建新的方案。'
                  : '上传商品图片并完成设置，生成结果会显示在这里。'
                : '切换作品状态，或查看全部作品。'}
            </p>
          </div>
          {filter !== 'all' && works.length ? (
            <button className="secondary" onClick={() => onFilter('all')}>
              <Images size={15} />
              查看全部作品
            </button>
          ) : works.length === 0 ? (
            <button className="secondary" onClick={onStart}>
              <Plus size={15} />
              开始创作
            </button>
          ) : null}
        </div>
      )}
      {detailWork && <WorkDetails
        key={detailWork.id}
        work={detailWork}
        busy={busy}
        onClose={() => setDetailId(null)}
        onReview={onReview}
        canReview={canReview}
        resolveImageURL={resolveImageURL}
      />}
    </div>
  )
}


function WorkMoreMenu({ work, busy, onRemove }: { work: Work; busy: boolean; onRemove: (id: string) => void }) {
  const ref = useRef<HTMLDetailsElement>(null)
  const [open, setOpen] = useState(false)
  useEffect(() => {
    if (!open) return
    function closeOutside(event: PointerEvent) {
      if (ref.current && !ref.current.contains(event.target as Node)) ref.current.open = false
    }
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key !== 'Escape' || !ref.current) return
      ref.current.open = false
      ref.current.querySelector('summary')?.focus()
    }
    document.addEventListener('pointerdown', closeOutside)
    document.addEventListener('keydown', closeOnEscape)
    return () => {
      document.removeEventListener('pointerdown', closeOutside)
      document.removeEventListener('keydown', closeOnEscape)
    }
  }, [open])
  return <details ref={ref} className="work-more" onToggle={(event) => setOpen(event.currentTarget.open)} onBlur={(event) => {
    if (event.relatedTarget instanceof Node && !event.currentTarget.contains(event.relatedTarget)) event.currentTarget.open = false
  }}>
    <summary className="icon-button" aria-label={`${work.title}更多操作`} title="更多操作"><MoreHorizontal size={19} /></summary>
    <div className="work-more-actions">
      <button type="button" disabled={busy} onClick={() => { if (ref.current) ref.current.open = false; onRemove(work.id) }}><Trash2 size={15} aria-hidden="true" />移除作品记录</button>
    </div>
  </details>
}
