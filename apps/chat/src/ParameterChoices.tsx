import React from 'react'

export function ParameterChoices({ label, values, value, onChange, render, columns = 3, ratios = false }: {
  label: string
  values: string[]
  value?: string
  onChange: (value: string) => void
  render?: (value: string) => React.ReactNode
  columns?: number
  ratios?: boolean
}) {
  if (!values.length) return null
  return <section className={`settings-field${ratios ? ' settings-ratio-field' : ''}`}>
    <h4>{label}</h4>
    <div
      className={ratios ? 'settings-ratio-grid' : 'settings-choice-grid'}
      role="radiogroup"
      aria-label={label}
      style={ratios ? undefined : { gridTemplateColumns: `repeat(${Math.min(columns, values.length)}, minmax(0, 1fr))` }}
      onKeyDown={(event) => {
        if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return
        event.preventDefault()
        const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="radio"]'))
        const current = buttons.indexOf(document.activeElement as HTMLButtonElement)
        const direction = event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 1
        const index = event.key === 'Home' ? 0 : event.key === 'End' ? values.length - 1
          : (Math.max(0, current) + direction + values.length) % values.length
        onChange(values[index])
        buttons[index]?.focus()
      }}
    >
      {values.map((option, index) => <button
        key={option}
        type="button"
        role="radio"
        aria-checked={option === value}
        tabIndex={option === value || (!values.includes(value || '') && index === 0) ? 0 : -1}
        className={option === value ? 'selected' : ''}
        onClick={() => onChange(option)}
      >
        {option === value && <span className="settings-choice-check" aria-hidden="true">✓</span>}
        {ratios && <span className="settings-ratio-icon"><RatioMark value={option} /></span>}
        <span>{render ? render(option) : option}</span>
      </button>)}
    </div>
  </section>
}

export function RatioMark({ value, size = 20 }: { value?: string; size?: number }) {
  if (/^(adaptive|auto|fit)$/i.test(value || '')) {
    return <span className="settings-ratio-mark settings-ratio-mark-adaptive" aria-hidden="true" style={{ width: size, height: size * .75 }} />
  }
  const [width, height] = (value || '1:1').split(/[:x]/).map(Number)
  const ratio = width > 0 && height > 0 ? width / height : 1
  return <span className="settings-ratio-mark" aria-hidden="true" style={{
    width: ratio >= 1 ? size : size * ratio,
    height: ratio >= 1 ? size / ratio : size,
  }} />
}
