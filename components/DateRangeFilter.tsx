'use client'

import React, { useEffect, useMemo, useState } from 'react'

// ─────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────
export type DatePreset = '4w' | '8w' | '13w' | 'ytd' | 'all'

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
  { key: '4w',  label: '4W' },
  { key: '8w',  label: '8W' },
  { key: '13w', label: '13W' },
  { key: 'ytd', label: 'YTD' },
  { key: 'all', label: 'ALL' },
]

// ─────────────────────────────────────────────────────────────
// Date helpers
// ─────────────────────────────────────────────────────────────
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

// Most recently completed Saturday (end of week).
// If today is Sunday, the most recently completed week ended yesterday.
function mostRecentCompletedSaturday(): Date {
  const today = new Date()
  today.setHours(12, 0, 0, 0)
  // getDay: Sun=0, Mon=1, ..., Sat=6
  // Days since last Saturday: if today is Sun(0) → 1, Mon(1) → 2, ..., Sat(6) → 0
  const daysSinceSat = today.getDay() === 0 ? 1 : 7 - today.getDay()
  // Actually: we want the last COMPLETED week, so Saturday of last week
  // Sun=0 → last Sat = yesterday (-1)
  // Mon=1 → last Sat = -2
  // ...
  // Sat=6 → last Sat = -7 (the previous Saturday, since this week isn't done)
  const offset = today.getDay() === 6 ? -7 : -(today.getDay() + 1)
  return addDays(today, offset)
}

// Sunday that starts the week containing the given Saturday.
function sundayOf(saturday: Date): Date {
  return addDays(saturday, -6)
}

// ─────────────────────────────────────────────────────────────
// Range computation — always anchored to completed weeks
// ─────────────────────────────────────────────────────────────
export function computeRange(preset: DatePreset): DateRange {
  const lastSat = mostRecentCompletedSaturday()
  const lastSun = sundayOf(lastSat)

  const make = (startDate: string, endDate: string, priorStart: string, priorEnd: string): DateRange => ({
    preset, startDate, endDate, priorStart, priorEnd,
  })

  switch (preset) {
    case '4w': {
      // Current: last 4 completed weeks (28 days ending on lastSat)
      const start = addDays(lastSun, -21) // 4 weeks back from lastSun
      const priorEnd = addDays(start, -1)
      const priorStart = addDays(priorEnd, -27)
      return make(toISO(start), toISO(lastSat), toISO(priorStart), toISO(priorEnd))
    }
    case '8w': {
      const start = addDays(lastSun, -49) // 8 weeks back
      const priorEnd = addDays(start, -1)
      const priorStart = addDays(priorEnd, -55)
      return make(toISO(start), toISO(lastSat), toISO(priorStart), toISO(priorEnd))
    }
    case '13w': {
      const start = addDays(lastSun, -84) // 13 weeks back
      const priorEnd = addDays(start, -1)
      const priorStart = addDays(priorEnd, -90)
      return make(toISO(start), toISO(lastSat), toISO(priorStart), toISO(priorEnd))
    }
    case 'ytd': {
      const today = new Date()
      const yearStart = new Date(today.getFullYear(), 0, 1, 12)
      // Prior: same period last year
      const priorYearStart = new Date(today.getFullYear() - 1, 0, 1, 12)
      const priorYearEnd = new Date(today.getFullYear() - 1, lastSat.getMonth(), lastSat.getDate(), 12)
      return make(toISO(yearStart), toISO(lastSat), toISO(priorYearStart), toISO(priorYearEnd))
    }
    case 'all': {
      // All available data — use a far-back start date
      return make('2020-01-01', toISO(lastSat), '2020-01-01', toISO(lastSat))
    }
  }
}

// ─────────────────────────────────────────────────────────────
// Component
// ─────────────────────────────────────────────────────────────
export default function DateRangeFilter({ onChange, defaultPreset = 'ytd' }: Props) {
  const [preset, setPreset] = useState<DatePreset>(defaultPreset)

  const range = useMemo(() => computeRange(preset), [preset])

  useEffect(() => {
    onChange(range)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [range.preset, range.startDate, range.endDate])

  return (
    <div style={{ display: 'flex', gap: '4px', alignItems: 'center' }}>
      <span style={{
        fontSize: '10px', color: 'var(--text-dim)', marginRight: '4px',
        fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase',
      }}>
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
              fontFamily: 'JetBrains Mono, monospace',
            }}
          >
            {p.label}
          </button>
        )
      })}
    </div>
  )
}
