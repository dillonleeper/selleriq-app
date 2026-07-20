// ─────────────────────────────────────────────────────────────
// Date-range presets + window computation (pure, no React).
// Kept separate from DateRangeFilter.tsx so it can be unit-tested in
// isolation (no JSX/React import) and shared by all pages.
//
// OUTPUT CONTRACT (unchanged): computeRange emits a DateRange with
// { preset, startDate, endDate, priorStart, priorEnd } as YYYY-MM-DD
// strings, ready for Supabase .gte/.lte('start_date', ...). A 'custom'
// preset with no start chosen yet emits all-'' so the parent skips its query.
//
// DAY-BOUNDARY BASIS: all boundaries are computed in the viewer's LOCAL
// timezone, noon-anchored (avoids DST edge cases), then serialized to
// YYYY-MM-DD and compared against sale_date. Same basis the component has
// always used — this module only changed the preset set.
//
// CONVENTIONS:
//   • "Last N days"        → rolling window ending YESTERDAY: [today-N, today-1]
//   • "Last week/month/…"  → the previous COMPLETE calendar period
//   • "X to date"          → period start … TODAY (today included)
//   • prior period         → the equivalent window immediately before; the
//                            to-date priors use "same offset into the prior
//                            period, clamped to its last day".
// ─────────────────────────────────────────────────────────────

export type DatePreset =
  // "Last" submenu
  | 'last_7d' | 'last_30d' | 'last_90d' | 'last_365d'
  | 'last_week' | 'last_month' | 'last_quarter' | 'last_12m' | 'last_year'
  // "Period to date" submenu
  | 'wtd' | 'mtd' | 'qtd' | 'ytd'
  // Custom range
  | 'custom'

export type DateRange = {
  preset: DatePreset
  startDate: string
  endDate: string
  priorStart: string
  priorEnd: string
}

// Human labels — single source of truth (pages import this; no local copies).
export const PRESET_LABELS: Record<DatePreset, string> = {
  last_7d: 'Last 7 days',
  last_30d: 'Last 30 days',
  last_90d: 'Last 90 days',
  last_365d: 'Last 365 days',
  last_week: 'Last week',
  last_month: 'Last month',
  last_quarter: 'Last quarter',
  last_12m: 'Last 12 months',
  last_year: 'Last year',
  wtd: 'Week to date',
  mtd: 'Month to date',
  qtd: 'Quarter to date',
  ytd: 'Year to date',
  custom: 'Custom',
}

// Menu grouping for the UI (order matters).
export const PRESET_GROUPS: { heading: string; keys: DatePreset[] }[] = [
  { heading: 'Last', keys: ['last_7d', 'last_30d', 'last_90d', 'last_365d', 'last_week', 'last_month', 'last_quarter', 'last_12m', 'last_year'] },
  { heading: 'Period to date', keys: ['wtd', 'mtd', 'qtd', 'ytd'] },
]

// ─────────────────────────────────────────────────────────────
// Date helpers — all local-time based, noon-anchored.
// ─────────────────────────────────────────────────────────────

// Local date → 'YYYY-MM-DD'. Built from local components (not toISOString)
// so the day never shifts under a negative UTC offset.
export function toISO(d: Date): string {
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

// First day (noon) of the month n months from d. Day is pinned to 1, so the
// JS Date month-overflow rules give the correct month with no day rollover.
function monthStart(d: Date, offset = 0): Date {
  return new Date(d.getFullYear(), d.getMonth() + offset, 1, 12)
}

// Last calendar day of a month. monthIndex is 0-11; day 0 of the next month
// resolves to the last day of this one.
function daysInMonth(year: number, monthIndex: number): number {
  return new Date(year, monthIndex + 1, 0).getDate()
}

// Most recent Sunday (the day itself if it IS Sunday). getDay: Sun=0.
function weekStartSunday(d: Date): Date {
  return addDays(d, -d.getDay())
}

// First day (noon) of the calendar quarter containing d.
function quarterStart(d: Date): Date {
  const q = Math.floor(d.getMonth() / 3) // 0..3
  return new Date(d.getFullYear(), q * 3, 1, 12)
}

// Inclusive day count between two YYYY-MM-DD strings (both endpoints count).
export function spanDays(startISO: string, endISO: string): number {
  const s = new Date(startISO + 'T12:00:00')
  const e = new Date(endISO + 'T12:00:00')
  return Math.round((e.getTime() - s.getTime()) / 86400000) + 1
}

// Whole days from a→b (0 if same day). Used for "offset into period".
function dayOffset(a: Date, b: Date): number {
  return Math.round((b.getTime() - a.getTime()) / 86400000)
}

function minDate(a: Date, b: Date): Date {
  return a.getTime() <= b.getTime() ? a : b
}

// ─────────────────────────────────────────────────────────────
// Window computation — current + prior period for each preset.
// `now` defaults to the real clock; injectable for deterministic tests.
// ─────────────────────────────────────────────────────────────
export function computeRange(
  preset: DatePreset,
  customStart: string,
  customEnd: string,
  now: Date = new Date(),
): DateRange {
  const today = new Date(now)
  today.setHours(12, 0, 0, 0) // noon anchor avoids DST edge cases

  const make = (start: Date, end: Date, pStart: Date, pEnd: Date): DateRange => ({
    preset,
    startDate: toISO(start), endDate: toISO(end),
    priorStart: toISO(pStart), priorEnd: toISO(pEnd),
  })

  // Rolling window of N days ending yesterday, prior = the N days before it.
  const lastNDays = (n: number): DateRange => {
    const start = addDays(today, -n)      // today-N
    const end = addDays(today, -1)        // yesterday
    const pStart = addDays(today, -2 * n) // today-2N
    const pEnd = addDays(start, -1)       // today-N-1
    return make(start, end, pStart, pEnd)
  }

  switch (preset) {
    case 'last_7d':   return lastNDays(7)
    case 'last_30d':  return lastNDays(30)
    case 'last_90d':  return lastNDays(90)
    case 'last_365d': return lastNDays(365)

    case 'last_week': {
      const thisSun = weekStartSunday(today)
      const start = addDays(thisSun, -7) // last week's Sunday
      const end = addDays(thisSun, -1)   // last Saturday
      return make(start, end, addDays(start, -7), addDays(end, -7))
    }

    case 'last_month': {
      const firstThis = monthStart(today, 0)
      const start = monthStart(today, -1)      // first of last month
      const end = addDays(firstThis, -1)        // last day of last month
      const pStart = monthStart(today, -2)
      const pEnd = addDays(start, -1)           // last day of two months ago
      return make(start, end, pStart, pEnd)
    }

    case 'last_quarter': {
      const qThis = quarterStart(today)
      const start = monthStart(qThis, -3)       // first day of last quarter
      const end = addDays(qThis, -1)            // last day of last quarter
      const pStart = monthStart(qThis, -6)
      const pEnd = addDays(start, -1)
      return make(start, end, pStart, pEnd)
    }

    case 'last_12m': {
      const firstThis = monthStart(today, 0)
      const start = monthStart(today, -12)      // first day of the month 12mo ago
      const end = addDays(firstThis, -1)        // last day of last month
      const pStart = monthStart(today, -24)
      const pEnd = addDays(start, -1)
      return make(start, end, pStart, pEnd)
    }

    case 'last_year': {
      const y = today.getFullYear()
      const start = new Date(y - 1, 0, 1, 12)
      const end = new Date(y - 1, 11, 31, 12)
      const pStart = new Date(y - 2, 0, 1, 12)
      const pEnd = new Date(y - 2, 11, 31, 12)
      return make(start, end, pStart, pEnd)
    }

    case 'wtd': {
      const start = weekStartSunday(today)
      // prior = same span one week earlier
      return make(start, today, addDays(start, -7), addDays(today, -7))
    }

    case 'mtd': {
      const start = monthStart(today, 0)
      // prior = 1st of last month → same day-of-month last month (clamped)
      const pm = monthStart(today, -1)
      const clampDay = Math.min(today.getDate(), daysInMonth(pm.getFullYear(), pm.getMonth()))
      const pEnd = new Date(pm.getFullYear(), pm.getMonth(), clampDay, 12)
      return make(start, today, pm, pEnd)
    }

    case 'qtd': {
      const start = quarterStart(today)
      // prior = start of last quarter → same offset into it, clamped to its end
      const pStart = monthStart(start, -3)
      const prevQEnd = addDays(start, -1)
      const offset = dayOffset(start, today)
      const pEnd = minDate(addDays(pStart, offset), prevQEnd)
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
