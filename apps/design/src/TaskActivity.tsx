import { useLayoutEffect, useRef, useState } from 'react'
import { ChevronUp, LoaderCircle, Minus, Square } from 'lucide-react'
import './TaskActivity.css'

export function TaskActivity({ phase, onStop }: { phase: string; onStop: () => void }) {
  const [stopping, setStopping] = useState(false)
  const [collapsed, setCollapsed] = useState(false)
  const chipRef = useRef<HTMLButtonElement>(null)
  const collapseRef = useRef<HTMLButtonElement>(null)
  const previousCollapsed = useRef(collapsed)
  const status = stopping ? '正在停止任务…' : phase || '正在处理'

  useLayoutEffect(() => {
    if (previousCollapsed.current === collapsed) return
    previousCollapsed.current = collapsed
    ;(collapsed ? chipRef.current : collapseRef.current)?.focus()
  }, [collapsed])

  if (collapsed) {
    return (
      <button
        ref={chipRef}
        type="button"
        className="task-activity-chip"
        aria-label="查看任务进度"
        aria-expanded="false"
        title={status}
        onClick={() => setCollapsed(false)}
      >
        <LoaderCircle size={15} className="spin" aria-hidden="true" />
        <span role="status" aria-live="polite">{stopping ? '正在停止…' : '任务进行中'}</span>
        <ChevronUp size={14} aria-hidden="true" />
      </button>
    )
  }

  return (
    <section className="task-activity" aria-label="任务进度">
      <div className="task-activity-status" role="status" aria-live="polite" aria-atomic="true">
        <LoaderCircle size={18} className="spin" aria-hidden="true" />
        <strong title={status}>{status}</strong>
      </div>
      <button
        type="button"
        className="task-activity-stop"
        disabled={stopping}
        aria-label="停止后续生成"
        title="停止后续生成，保留已完成的图片"
        onClick={() => { setStopping(true); onStop() }}
      >
        <Square size={12} aria-hidden="true" />
        {stopping ? '正在停止' : '停止'}
      </button>
      <button
        ref={collapseRef}
        type="button"
        className="task-activity-collapse"
        aria-label="收起任务进度"
        aria-expanded="true"
        title="收起任务进度"
        onClick={() => setCollapsed(true)}
      >
        <Minus size={16} aria-hidden="true" />
      </button>
      {stopping && <p className="task-activity-hint">已完成的图片会保留</p>}
    </section>
  )
}
