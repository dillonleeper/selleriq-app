'use client'

import React, { useEffect, useMemo, useRef, useState } from 'react'
import { Calendar, ChevronDown } from 'lucide-react'
import {
  type DatePreset, type DateRange,
  PRESET_LABELS, PRESET_GROUPS, computeRange,
} from './dateRange'

// Re-export so existing consumers keep importing from '@/components/DateRangeFilter'.
export type { DatePreset, DateRange } from './dateRange'
export { PRESET_LABELS, computeRange } from './dateRange'

type Props = {
  onChange: (range: DateRange) => void
  defaultPreset?: DatePreset
}

// ─────────────────────────────────────────────────────────────
// Styles
// ─────────────────────────────────────────────────────────────
const inputStyle: React.CSSProperties = {
  padding: '4px 8px', borderRadius: '6px', fontSize: '11px',
  border: '1px solid var(--border)', background: 'var(--bg-elevated)',
  color: 'var(--text-primary)', cursor: 'pointer', outline: 'none',
  fontFamily: 'JetBrains Mono, monospace',
}

const itemStyle = (active: boolean): React.CSSProperties => ({
  display: 'flex', alignItems: 'center', gap: '6px', width: '100%',
  padding: '6px 10px', borderRadius: '6px', border: 'none',
  background: active ? 'var(--accent-light)' : 'transparent',
  color: active ? 'var(--accent)' : 'var(--text-muted)',
  fontSize: '12px', fontWeight: active ? 600 : 500, cursor: 'pointer',
  textAlign: 'left', transition: 'background 0.12s ease',
})

// ─────────────────────────────────────────────────────────────
// Component — Shopify-style grouped popover
// ─────────────────────────────────────────────────────────────
export default function DateRangeFilter({ onChange, defaultPreset = 'mtd' }: Props) {
  const [preset, setPreset] = useState<DatePreset>(defaultPreset)
  const [customStart, setCustomStart] = useState('')
  const [customEnd, setCustomEnd] = useState('')
  const [open, setOpen] = useState(false)
  const wrapRef = useRef<HTMLDivElement>(null)

  const range = useMemo(
    () => computeRange(preset, customStart, customEnd),
    [preset, customStart, customEnd]
  )

  // Emit upward whenever the computed window changes. Depends on the
  // primitive fields (not object identity) to avoid spurious fires.
  useEffect(() => {
    onChange(range)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [range.preset, range.startDate, range.endDate, range.priorStart, range.priorEnd])

  // Close on outside-click / Escape.
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const today = useMemo(() => {
    const d = new Date(); d.setHours(12, 0, 0, 0)
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  }, [])

  const pick = (key: DatePreset) => {
    setPreset(key)
    if (key !== 'custom') setOpen(false) // keep open for custom so pickers show
  }

  const triggerLabel =
    preset === 'custom' && range.startDate
      ? `${range.startDate} → ${range.endDate}`
      : PRESET_LABELS[preset]

  return (
    <div ref={wrapRef} style={{ position: 'relative', display: 'flex', alignItems: 'center', gap: '8px' }}>
      <span style={{ fontSize: '10px', color: 'var(--text-dim)', fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase' }}>
        Range
      </span>

      <button
        onClick={() => setOpen(o => !o)}
        style={{
          display: 'flex', alignItems: 'center', gap: '6px',
          padding: '5px 10px', borderRadius: '6px',
          border: '1px solid var(--border)', background: 'var(--bg-elevated)',
          color: 'var(--text-primary)', fontSize: '11px', fontWeight: 500,
          cursor: 'pointer', fontFamily: 'JetBrains Mono, monospace',
        }}
      >
        <Calendar size={11} />
        {triggerLabel}
        <ChevronDown size={12} style={{ opacity: 0.6, transform: open ? 'rotate(180deg)' : 'none', transition: 'transform 0.12s ease' }} />
      </button>

      {open && (
        <div
          style={{
            position: 'absolute', top: 'calc(100% + 6px)', left: 0, zIndex: 200,
            minWidth: '200px', padding: '8px',
            background: 'var(--bg-card)', border: '1px solid var(--border)',
            borderRadius: '10px', boxShadow: '0 8px 28px rgba(0,0,0,0.18)',
            display: 'flex', flexDirection: 'column', gap: '4px',
          }}
        >
          {PRESET_GROUPS.map(group => (
            <div key={group.heading} style={{ display: 'flex', flexDirection: 'column' }}>
              <div style={{
                fontSize: '9px', color: 'var(--text-dim)', fontWeight: 700,
                letterSpacing: '0.07em', textTransform: 'uppercase',
                padding: '6px 10px 3px',
              }}>
                {group.heading}
              </div>
              {group.keys.map(key => (
                <button key={key} onClick={() => pick(key)} style={itemStyle(preset === key)}>
                  {PRESET_LABELS[key]}
                </button>
              ))}
            </div>
          ))}

          {/* Custom range */}
          <div style={{ borderTop: '1px solid var(--border)', marginTop: '4px', paddingTop: '4px' }}>
            <button onClick={() => pick('custom')} style={itemStyle(preset === 'custom')}>
              <Calendar size={11} />
              Custom range
            </button>
            {preset === 'custom' && (
              <div style={{ display: 'flex', alignItems: 'center', gap: '6px', padding: '6px 10px 2px' }}>
                <input
                  type="date"
                  value={customStart}
                  max={customEnd || today}
                  onChange={e => setCustomStart(e.target.value)}
                  style={inputStyle}
                />
                <span style={{ fontSize: '11px', color: 'var(--text-dim)' }}>to</span>
                <input
                  type="date"
                  value={customEnd}
                  min={customStart || undefined}
                  max={today}
                  onChange={e => setCustomEnd(e.target.value)}
                  style={inputStyle}
                />
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
