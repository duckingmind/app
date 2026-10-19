import { useLayoutEffect, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import './FeedbackLayer.css'

/** Keep transient feedback out of layout and interactive above native dialogs. */
export function FeedbackLayer({ children }: { children: ReactNode }) {
  const [host] = useState(() => {
    const element = document.createElement('div')
    element.className = 'feedback-layer'
    element.setAttribute('role', 'region')
    element.setAttribute('aria-label', '通知与任务')
    return element
  })

  useLayoutEffect(() => {
    const position = () => {
      // Native modal dialogs make siblings inert. Move the stable portal host
      // into the active dialog instead of duplicating/remounting its contents.
      const dialogs = Array.from(document.querySelectorAll<HTMLDialogElement>('dialog[open]'))
      const parent = dialogs.at(-1) || document.body
      if (host.parentElement !== parent) parent.appendChild(host)
    }
    position()
    const observer = new MutationObserver(position)
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['open'] })
    return () => { observer.disconnect(); host.remove() }
  }, [host])

  return createPortal(children, host)
}
