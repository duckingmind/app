import React from 'react'
import { createPortal } from 'react-dom'

export default function ParameterPopover({ anchor, id, label, onClose, children, image = false, video = false }: {
  anchor: React.RefObject<HTMLButtonElement>
  id: string
  label: string
  onClose: () => void
  children: React.ReactNode
  image?: boolean
  video?: boolean
}) {
  const panel = React.useRef<HTMLDivElement>(null)
  const close = React.useRef(onClose)
  close.current = onClose

  React.useLayoutEffect(() => {
    const element = panel.current
    const button = anchor.current
    if (!element || !button) return
    const place = () => {
      const viewport = window.visualViewport
      const left = (viewport?.offsetLeft || 0) + 12
      const top = (viewport?.offsetTop || 0) + 12
      const width = (viewport?.width || window.innerWidth) - 24
      const height = (viewport?.height || window.innerHeight) - 24
      element.style.width = `${Math.min(360, width)}px`
      element.style.maxHeight = `${height}px`
      const rect = button.getBoundingClientRect()
      const x = Math.max(left, Math.min(rect.left, left + width - element.offsetWidth))
      const above = rect.top - element.offsetHeight - 8
      const below = rect.bottom + 8
      const y = above >= top ? above : below + element.offsetHeight <= top + height
        ? below : Math.max(top, top + height - element.offsetHeight)
      element.style.left = `${x}px`
      element.style.top = `${y}px`
      element.style.visibility = 'visible'
    }
    place()
    const observer = new ResizeObserver(place)
    observer.observe(element)
    observer.observe(button)
    window.addEventListener('resize', place)
    window.addEventListener('scroll', place, true)
    window.visualViewport?.addEventListener('resize', place)
    window.visualViewport?.addEventListener('scroll', place)
    const initialFocus = element.querySelector<HTMLElement>('[aria-checked="true"]')
      || element.querySelector<HTMLElement>('button:not(:disabled), select:not(:disabled), input:not(:disabled)')
    initialFocus?.focus({ preventScroll: true })
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', place)
      window.removeEventListener('scroll', place, true)
      window.visualViewport?.removeEventListener('resize', place)
      window.visualViewport?.removeEventListener('scroll', place)
    }
  }, [anchor])

  React.useEffect(() => {
    const dismissOutside = (event: PointerEvent | FocusEvent) => {
      if (event.target instanceof Node && !panel.current?.contains(event.target) && !anchor.current?.contains(event.target)) close.current()
    }
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.isComposing || event.keyCode === 229) return
      event.preventDefault()
      event.stopImmediatePropagation()
      close.current()
      anchor.current?.focus({ preventScroll: true })
    }
    document.addEventListener('pointerdown', dismissOutside, true)
    document.addEventListener('focusin', dismissOutside)
    window.addEventListener('keydown', escape, true)
    return () => {
      document.removeEventListener('pointerdown', dismissOutside, true)
      document.removeEventListener('focusin', dismissOutside)
      window.removeEventListener('keydown', escape, true)
    }
  }, [anchor])

  return createPortal(<div
    ref={panel}
    id={id}
    className={`settings-popover${image ? ' image-settings-popover' : ''}${video ? ' video-settings-popover' : ''}`}
    role="dialog"
    aria-label={label}
    style={{ visibility: 'hidden' }}
  >{children}</div>, document.body)
}
