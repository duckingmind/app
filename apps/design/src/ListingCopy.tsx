import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Copy, FileText, X } from 'lucide-react'

function inlineText(text: string): ReactNode {
  return text.split(/(\*\*[^*]+\*\*|__[^_]+__)/g).map((part, index) =>
    /^(\*\*[^*]+\*\*|__[^_]+__)$/.test(part)
      ? <strong key={index}>{part.slice(2, -2)}</strong>
      : part,
  )
}

// Only format text blocks. Model output is never interpreted as HTML or links.
function ListingContent({ text }: { text: string }) {
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  const blocks: ReactNode[] = []
  const heading = /^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/
  const bullet = /^\s*[-*+]\s+(.+)$/
  const ordered = /^\s*\d+[.)]\s+(.+)$/
  let index = 0
  while (index < lines.length) {
    const line = lines[index]
    if (!line.trim()) { index++; continue }
    const title = line.match(heading)
    if (title) {
      blocks.push(<h3 key={index}>{inlineText(title[1])}</h3>)
      index++
      continue
    }
    const listPattern = bullet.test(line) ? bullet : ordered.test(line) ? ordered : null
    if (listPattern) {
      const start = index
      const items: ReactNode[] = []
      while (index < lines.length) {
        const item = lines[index].match(listPattern)
        if (!item) break
        items.push(<li key={index}>{inlineText(item[1])}</li>)
        index++
      }
      blocks.push(listPattern === ordered
        ? <ol key={start} start={Number.parseInt(line.trim(), 10)}>{items}</ol>
        : <ul key={start}>{items}</ul>)
      continue
    }
    const start = index
    const paragraph: string[] = []
    while (index < lines.length && lines[index].trim()) {
      if (heading.test(lines[index]) || bullet.test(lines[index]) || ordered.test(lines[index])) break
      paragraph.push(lines[index++])
    }
    blocks.push(<p key={start}>{inlineText(paragraph.join('\n'))}</p>)
  }
  return <div className="listing-prose">{blocks}</div>
}

export function ListingCopy({ title, text, onCopy }: {
  title: string
  text: string
  onCopy: (text: string) => void
}) {
  const [open, setOpen] = useState(false)
  const dialogRef = useRef<HTMLDialogElement>(null)
  const titleId = useId()
  const cleanText = text.replace(/\r\n?/g, '\n').trim()
  const summary = cleanText
    .replace(/^\s{0,3}#{1,6}\s+/, '')
    .replace(/[*_`]/g, '')
    .replace(/\s+/g, ' ')
    .slice(0, 120)
  const hasMore = cleanText.length > 120

  useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) return
    if (open) dialog.showModal()
    else if (dialog.open) dialog.close()
    return () => { if (dialog.open) dialog.close() }
  }, [open])

  return (
    <>
      <section className="listing-summary" aria-label={`${title}的上架文案`}>
        <div className="listing-summary-main">
          <FileText size={16} aria-hidden="true" />
          <div className="listing-summary-copy">
            <strong>上架文案</strong>
            <span className="listing-work-title" title={title}>{title}</span>
            <p>{summary || '暂无文案'}{hasMore ? '…' : ''}</p>
          </div>
        </div>
        <button
          type="button"
          className="listing-view-button"
          onClick={() => setOpen(true)}
          aria-haspopup="dialog"
        >
          查看文案
        </button>
        <button
          type="button"
          className="listing-copy-button"
          aria-label={`复制${title}的上架文案`}
          onClick={() => onCopy(text)}
        >
          <Copy size={14} aria-hidden="true" />
          复制
        </button>
      </section>
      {open && createPortal(
        <dialog
          ref={dialogRef}
          className="listing-copy-dialog"
          aria-labelledby={titleId}
          onCancel={(event) => { event.preventDefault(); setOpen(false) }}
          onClick={(event) => { if (event.target === dialogRef.current) setOpen(false) }}
        >
          <header className="listing-copy-dialog-header">
            <div><span>上架文案</span><h2 id={titleId}>{title}</h2></div>
            <button type="button" className="icon-button" aria-label="关闭文案" onClick={() => setOpen(false)} autoFocus><X size={18} /></button>
          </header>
          <div className="listing-copy-dialog-body"><ListingContent text={text} /></div>
          <footer className="listing-copy-dialog-footer">
            <button type="button" className="secondary" onClick={() => setOpen(false)}>关闭</button>
            <button type="button" className="primary" onClick={() => onCopy(text)}><Copy size={14} />复制文案</button>
          </footer>
        </dialog>, document.body,
      )}
    </>
  )
}
