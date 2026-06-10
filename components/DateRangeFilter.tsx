'use client'

import React, { useEffect, useMemo, useState } from 'react'
import { Calendar } from 'lucide-react'

// ─────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────
export type DatePreset = 'today' | 'yesterday' | 'wtd' | 'mtd' | 'ytd' | 'custom'

// All dates are YYYY-MM-DD strings, ready for Supabase
// .gte('start_date', startDate).lte('start_date', endDate).
// For a 'custom' preset with no start date chosen yet, every field is ''
// so the parent can skip its query until the user finishes picking.
export type DateRange = {
  preset: DatePreset
  startDate: string
  endDate: string
  priorStart: string
  priorEnd: string
}

type Props = {
  onChange: (range: DateRange) => void
  defaultPreset?: DatePreset
}

const PRESETS: { key: DatePreset; label: string }[] = [
  { key: 'today',     label: 'Today' },
  { key: 'yesterday', label: 'Yesterday' },
  { key: 'wtd',       label: 'WTD' },
  { key: 'mtd',       label: 'MTD' },
  { key: 'ytd',       label: 'YTD' },
  { key: 'custom',    label: 'Custom' },
]

// ─────────────────────────────────────────────────────────────
// Date helpers — all local-time based
// ─────────────────────────────────────────────────────────────

// Local date → 'YYYY-MM-DD'. Built from local components rather than
// toISOString() so the day never shifts under a negative UTC offset.
function toISO(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

function addDays(d: Date, n: number): Date {
  const r = new Date(d)
  r.setDate(r.getDate() + n)
  return r
}

// Last calendar day of a month. monthIndex is 0-11; day 0 of the next
// month resolves to the last day of this one.
function daysInMonth(year: number, monthIndex: number): number {
  return new Date(year, monthIndex + 1, 0).getDate()
}

// Inclusive day count between two YYYY-MM-DD strings (start & end both count).
function spanDays(startISO: string, endISO: string): number {
  const s = new Date(startISO + 'T12:00:00')
  const e = new Date(endISO + 'T12:00:00')
  return Math.round((e.getTime() - s.getTime()) / 86400000) + 1
}

// ─────────────────────────────────────────────────────────────
// Window computation — current + prior period for each preset
// ─────────────────────────────────────────────────────────────
export function computeRange(preset: DatePreset, customStart: string, customEnd: string): DateRange {
  const today = new Date()
  today.setHours(12, 0, 0, 0) // noon anchor avoids DST edge cases

  const make = (start: Date, end: Date, pStart: Date, pEnd: Date): DateRange => ({
    preset,
    startDate: toISO(start), endDate: toISO(end),
    priorStart: toISO(pStart), priorEnd: toISO(pEnd),
  })

  switch (preset) {
    case 'today': {
      // prior = yesterday
      const y = addDays(today, -1)
      return make(today, today, y, y)
    }

    case 'yesterday': {
      // prior = day before yesterday
      const y = addDays(today, -1)
      const dby = addDays(today, -2)
      return make(y, y, dby, dby)
    }

    case 'wtd': {
      // start = most recent Sunday (today if today is Sunday). getDay: Sun=0.
      const start = addDays(today, -today.getDay())
      // prior = same span one week earlier (prior Sunday → same weekday)
      return make(start, today, addDays(start, -7), addDays(today, -7))
    }

    case 'mtd': {
      const start = new Date(today.getFullYear(), today.getMonth(), 1, 12)
      // prior = 1st of last month → same day-of-month last month (clamped)
      const pm = new Date(today.getFullYear(), today.getMonth() - 1, 1, 12)
      const pStart = new Date(pm.getFullYear(), pm.getMonth(), 1, 12)
      const clampDay = Math.min(today.getDate(), daysInMonth(pm.getFullYear(), pm.getMonth()))
      const pEnd = new Date(pm.getFullYear(), pm.getMonth(), clampDay, 12)
      return make(start, today, pStart, pEnd)
    }

    case 'ytd': {
      const start = new Date(today.getFullYear(), 0, 1, 12)
      // prior = Jan 1 last year → same month/day last year (clamped for Feb 29)
      const pYear = today.getFullYear() - 1
      const pStart = new Date(pYear, 0, 1, 12)
      const clampDay = Math.min(today.getDate(), daysInMonth(pYear, today.getMonth()))
      const pEnd = new Date(pYear, today.getMonth(), clampDay, 12)
      return make(start, today, pStart, pEnd)
    }

    case 'custom': {
      const startISO = customStart
      const endISO = customEnd || toISO(today) // default end to today if blank
      if (!startISO) {
        // incomplete — signal "not ready" with empty strings
        return { preset, startDate: '', endDate: '', priorStart: '', priorEnd: '' }
      }
      // prior = same-length window immediately before the selected start
      const len = spanDays(startISO, endISO)
      const start = new Date(startISO + 'T12:00:00')
      const pEnd = addDays(start, -1)
      const pStart = addDays(pEnd, -(len - 1))
      return {
        preset, startDate: startISO, endDate: endISO,
        priorStart: toISO(pStart), priorEnd: toISO(pEnd),
      }
    }
  }
}

// ─────────────────────────────────────────────────────────────
// Component
// ─────────────────────────────────────────────────────────────
const inputStyle: React.CSSProperties = {
  padding: '4px 8px', borderRadius: '6px', fontSize: '11px',
  border: '1px solid var(--border)', background: 'var(--bg-elevated)',
  color: 'var(--text-primary)', cursor: 'pointer', outline: 'none',
  fontFamily: 'JetBrains Mono, monospace',
}

export default function DateRangeFilter({ onChange, defaultPreset = 'mtd' }: Props) {
  const [preset, setPreset] = useState<DatePreset>(defaultPreset)
  const [customStart, setCustomStart] = useState('')
  const [customEnd, setCustomEnd] = useState('')

  const range = useMemo(
    () => computeRange(preset, customStart, customEnd),
    [preset, customStart, customEnd]
  )

  // Emit upward whenever the computed window changes. Depends on the
  // primitive fields (not the object identity) to avoid spurious fires.
  useEffect(() => {
    onChange(range)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [range.preset, range.startDate, range.endDate, range.priorStart, range.priorEnd])

  const today = toISO(new Date())

  return (
    <div style={{ display: 'flex', gap: '4px', alignItems: 'center', flexWrap: 'wrap' }}>
      <span style={{ fontSize: '10px', color: 'var(--text-dim)', marginRight: '4px', fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase' }}>
        Range
      </span>
      {PRESETS.map(p => {
        const active = preset === p.key
        return (
          <button
            key={p.key}
            onClick={() => setPreset(p.key)}
            style={{
              padding: '4px 10px', borderRadius: '6px',
              border: active ? '1px solid var(--accent-border)' : '1px solid var(--border)',
              background: active ? 'var(--accent-light)' : 'transparent',
              color: active ? 'var(--accent)' : 'var(--text-muted)',
              fontSize: '11px', fontWeight: 500, cursor: 'pointer',
              transition: 'all 0.12s ease',
              display: 'flex', alignItems: 'center', gap: '4px',
              fontFamily: p.key === 'custom' ? 'inherit' : 'JetBrains Mono, monospace',
            }}
          >
            {p.key === 'custom' && <Calendar size={10} />}
            {p.label}
          </button>
        )
      })}

      {preset === 'custom' && (
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginLeft: '4px' }}>
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
  )
}
