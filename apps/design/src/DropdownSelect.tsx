import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import { Check, ChevronDown } from 'lucide-react'
import './DropdownSelect.css'

export type DropdownOption = {
  value: string
  label: string
  disabled?: boolean
}

type DropdownSelectProps = {
  id?: string
  label: string
  value: string
  options: readonly DropdownOption[]
  onChange: (value: string) => void
  disabled?: boolean
  className?: string
}

const MENU_GAP = 6
const VIEWPORT_PADDING = 8
const MAX_MENU_HEIGHT = 280

export function DropdownSelect({
  id,
  label,
  value,
  options,
  onChange,
  disabled = false,
  className = '',
}: DropdownSelectProps) {
  const generatedId = useId()
  const triggerId = id || generatedId
  const listboxId = `${triggerId}-listbox`
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const search = useRef({ text: '', time: 0 })
  const [open, setOpen] = useState(false)
  const [activeValue, setActiveValue] = useState<string>()
  const [menuStyle, setMenuStyle] = useState<CSSProperties>({ visibility: 'hidden' })
  const selected = options.find((option) => option.value === value)
  const enabledOptions = options.filter((option) => !option.disabled)
  const isDisabled = disabled || !options.length
  const expanded = open && !isDisabled
  const active = enabledOptions.find((option) => option.value === activeValue) ?? enabledOptions[0]
  const activeIndex = options.findIndex((option) => option === active)

  function closeMenu() {
    setOpen(false)
    search.current.text = ''
  }

  function openMenu(edge?: 'first' | 'last') {
    if (isDisabled) return
    const initial = edge === 'last'
      ? enabledOptions.at(-1)
      : edge === 'first'
        ? enabledOptions[0]
        : enabledOptions.find((option) => option.value === value) ?? enabledOptions[0]
    setActiveValue(initial?.value)
    setMenuStyle({ visibility: 'hidden' })
    setOpen(true)
  }

  function selectOption(option?: DropdownOption) {
    if (isDisabled || !option || option.disabled) return
    if (option.value !== value) onChange(option.value)
    closeMenu()
    triggerRef.current?.focus({ preventScroll: true })
  }

  useEffect(() => {
    if (isDisabled) closeMenu()
  }, [isDisabled])

  useLayoutEffect(() => {
    if (!expanded) return
    const trigger = triggerRef.current
    const menu = menuRef.current
    if (!trigger || !menu) return
    let frame = 0
    const viewport = window.visualViewport
    const clippingParents: HTMLElement[] = []
    for (let parent = trigger.parentElement; parent; parent = parent.parentElement) {
      if (/(auto|scroll|hidden|clip)/.test(getComputedStyle(parent).overflowY)) {
        clippingParents.push(parent)
      }
    }

    const updatePosition = () => {
      const rect = trigger.getBoundingClientRect()
      const viewportTop = (viewport?.offsetTop ?? 0) + VIEWPORT_PADDING
      const viewportLeft = (viewport?.offsetLeft ?? 0) + VIEWPORT_PADDING
      const viewportBottom = viewportTop + (viewport?.height ?? window.innerHeight) - VIEWPORT_PADDING * 2
      const viewportRight = viewportLeft + (viewport?.width ?? window.innerWidth) - VIEWPORT_PADDING * 2
      if (rect.bottom <= viewportTop || rect.top >= viewportBottom || clippingParents.some((parent) => {
        const bounds = parent.getBoundingClientRect()
        return rect.bottom <= bounds.top || rect.top >= bounds.bottom
      })) {
        closeMenu()
        return
      }
      const width = Math.max(0, Math.min(Math.max(rect.width, 160), viewportRight - viewportLeft))
      menu.style.width = `${width}px`
      const desiredHeight = Math.min(MAX_MENU_HEIGHT, menu.scrollHeight + 2)
      const below = Math.max(0, viewportBottom - rect.bottom - MENU_GAP)
      const above = Math.max(0, rect.top - viewportTop - MENU_GAP)
      const openUp = below < desiredHeight && above > below
      const maxHeight = Math.min(MAX_MENU_HEIGHT, openUp ? above : below)
      setMenuStyle({
        left: Math.max(viewportLeft, Math.min(rect.left, viewportRight - width)),
        top: openUp ? rect.top - MENU_GAP - Math.min(desiredHeight, maxHeight) : rect.bottom + MENU_GAP,
        width,
        maxHeight,
      })
    }
    const schedulePosition = (event?: Event) => {
      // Scrolling the list must not move the surrounding settings panel.
      if (event?.target instanceof Node && menu.contains(event.target)) return
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(updatePosition)
    }
    const dismissOutside = (event: PointerEvent) => {
      if (event.target instanceof Node && !trigger.contains(event.target) && !menu.contains(event.target)) {
        closeMenu()
      }
    }
    updatePosition()
    const observer = new ResizeObserver(() => schedulePosition())
    observer.observe(trigger)
    document.addEventListener('pointerdown', dismissOutside)
    window.addEventListener('resize', schedulePosition)
    window.addEventListener('scroll', schedulePosition, true)
    viewport?.addEventListener('resize', schedulePosition)
    viewport?.addEventListener('scroll', schedulePosition)
    return () => {
      cancelAnimationFrame(frame)
      observer.disconnect()
      document.removeEventListener('pointerdown', dismissOutside)
      window.removeEventListener('resize', schedulePosition)
      window.removeEventListener('scroll', schedulePosition, true)
      viewport?.removeEventListener('resize', schedulePosition)
      viewport?.removeEventListener('scroll', schedulePosition)
    }
  }, [expanded, options])

  useLayoutEffect(() => {
    if (!expanded || activeIndex < 0) return
    const menu = menuRef.current
    const option = menu?.children[activeIndex] as HTMLElement | undefined
    if (!menu || !option) return
    const top = option.offsetTop
    const bottom = top + option.offsetHeight
    if (top < menu.scrollTop) menu.scrollTop = top
    else if (bottom > menu.scrollTop + menu.clientHeight) menu.scrollTop = bottom - menu.clientHeight
  }, [expanded, activeIndex, menuStyle.maxHeight])

  function handleKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    if (isDisabled) return
    if (event.key === 'Escape' && expanded) {
      event.preventDefault()
      event.stopPropagation()
      closeMenu()
    } else if (event.key === 'Tab') {
      closeMenu()
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      if (!expanded) openMenu()
      else {
        const direction = event.key === 'ArrowDown' ? 1 : -1
        const index = enabledOptions.findIndex((option) => option.value === active?.value)
        setActiveValue(enabledOptions[(index + direction + enabledOptions.length) % enabledOptions.length]?.value)
      }
    } else if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault()
      const edge = event.key === 'Home' ? 'first' : 'last'
      if (!expanded) openMenu(edge)
      else setActiveValue((edge === 'first' ? enabledOptions[0] : enabledOptions.at(-1))?.value)
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      if (expanded) selectOption(active)
      else openMenu()
    } else if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey && !event.nativeEvent.isComposing) {
      event.preventDefault()
      const now = Date.now()
      const typed = (now - search.current.time > 600 ? '' : search.current.text) + event.key.toLocaleLowerCase()
      search.current = { text: typed, time: now }
      const query = [...typed].every((char) => char === typed[0]) ? typed[0] : typed
      const index = enabledOptions.findIndex((option) => option.value === (expanded ? active?.value : value))
      const start = Math.max(0, index + (query.length === 1 ? 1 : 0))
      const ordered = [...enabledOptions.slice(start), ...enabledOptions.slice(0, start)]
      const match = ordered.find((option) => option.label.toLocaleLowerCase().startsWith(query))
      if (!expanded) openMenu()
      if (match) setActiveValue(match.value)
    }
  }

  // Native modal dialogs make body portals inert; keep their menus in the dialog's top layer.
  const portalTarget = triggerRef.current?.closest('dialog') ?? document.body
  return (
    <div className={`app-select ${className}`.trim()}>
      <button
        id={triggerId}
        ref={triggerRef}
        type="button"
        className="app-select-trigger"
        role="combobox"
        aria-label={label}
        title={selected?.label ?? value}
        aria-controls={expanded ? listboxId : undefined}
        aria-expanded={expanded}
        aria-haspopup="listbox"
        aria-activedescendant={expanded && activeIndex >= 0 ? `${listboxId}-${activeIndex}` : undefined}
        disabled={isDisabled}
        onClick={() => {
          triggerRef.current?.focus({ preventScroll: true })
          if (expanded) closeMenu()
          else openMenu()
        }}
        onKeyDown={handleKeyDown}
        onBlur={closeMenu}
      >
        <span className="app-select-value">{selected?.label ?? (value || '暂无可选项')}</span>
        <ChevronDown className="app-select-chevron" size={15} aria-hidden="true" />
      </button>
      {expanded && createPortal(
        <div
          ref={menuRef}
          id={listboxId}
          className="app-select-menu"
          role="listbox"
          aria-label={label}
          style={menuStyle}
          onMouseDown={(event) => event.preventDefault()}
        >
          {options.map((option, index) => (
            <div
              id={`${listboxId}-${index}`}
              key={option.value}
              role="option"
              aria-selected={option.value === value}
              aria-disabled={option.disabled || undefined}
              className={`app-select-option${index === activeIndex ? ' active' : ''}`}
              onClick={() => selectOption(option)}
              onPointerMove={(event) => {
                if (event.pointerType === 'mouse' && !option.disabled) setActiveValue(option.value)
              }}
            >
              <span>{option.label}</span>
              {option.value === value && <Check size={14} aria-hidden="true" />}
            </div>
          ))}
        </div>,
        portalTarget,
      )}
    </div>
  )
}
