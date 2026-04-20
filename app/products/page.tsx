'use client'

import React, { useEffect, useState, useCallback } from 'react'
import { supabase } from '@/lib/supabase'
import MarketplaceFilter from '@/components/MarketplaceFilter'
import {
  AreaChart, Area, XAxis, YAxis, CartesianGrid,
  Tooltip, ResponsiveContainer, LineChart, Line
} from 'recharts'
import {
  ChevronDown, ChevronRight, TrendingUp, TrendingDown,
  Minus, ArrowUpDown, ArrowUp, ArrowDown, Search, Download, Calendar
} from 'lucide-react'

const CAD_TO_USD = 0.74

// ─── Date range presets ───────────────────────────────────────
const PRESET_RANGES = [
  { label: '7D',  days: 7   },
  { label: '4W',  days: 28  },
  { label: '8W',  days: 56  },
  { label: '13W', days: 91  },
  { label: 'YTD', days: null, ytd: true },
  { label: 'ALL', days: null },
  { label: 'Custom', days: null, custom: true },
]

type CadenceGrouping = 'day' | 'week' | 'month'

// ─── Types ───────────────────────────────────────────────────
type ProductRow = {
  sku: string
  title: string
  revenue: number
  units: number
  sessions: number
  conv_rate: number
  asp: number
  buy_box_pct: number | null
  wow_change: number | null
  prev_revenue: number
}

type DataPoint = {
  period_key: string   // raw sortable key (date string or YYYY-WNN or YYYY-MM)
  label: string        // display label
  revenue: number
  units: number
}

type SortKey = 'revenue' | 'units' | 'sessions' | 'conv_rate' | 'asp' | 'buy_box_pct' | 'wow_change'
type SortDir = 'asc' | 'desc'
type TabType = 'summary' | 'cadence'
type CadenceMetric = 'units' | 'revenue'

// ─── Helpers ─────────────────────────────────────────────────
function fmt(n: number) {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + 'M'
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K'
  return n.toLocaleString()
}
function fmtCurrency(n: number) {
  return '$' + n.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 })
}
function toUSD(amount: number, marketplace: string) {
  return marketplace === 'CA' ? amount * CAD_TO_USD : amount
}
function truncate(s: string, n: number) {
  return s && s.length > n ? s.slice(0, n) + '…' : s
}
function sanitizeId(s: string) {
  return s.replace(/[^a-zA-Z0-9]/g, '_')
}
function toISODate(d: Date) {
  return d.toISOString().split('T')[0]
}

// Get cutoff date for preset ranges
function getPresetCutoff(range: typeof PRESET_RANGES[0]): string | null {
  if (!range.days && !range.ytd) return null
  const now = new Date()
  if (range.ytd) return new Date(now.getFullYear(), 0, 1).toISOString().split('T')[0]
  const d = new Date(now)
  d.setDate(d.getDate() - range.days!)
  return toISODate(d)
}

// ISO week number helper → "2025-W03"
function toWeekKey(dateStr: string): string {
  const d = new Date(dateStr + 'T12:00:00')
  const jan4 = new Date(d.getFullYear(), 0, 4)
  const startOfWeek1 = new Date(jan4)
  startOfWeek1.setDate(jan4.getDate() - ((jan4.getDay() + 6) % 7))
  const diff = d.getTime() - startOfWeek1.getTime()
  const week = Math.floor(diff / (7 * 24 * 60 * 60 * 1000)) + 1
  const year = week <= 0 ? d.getFullYear() - 1 : d.getFullYear()
  const paddedWeek = String(week <= 0 ? 52 : week).padStart(2, '0')
  return `${year}-W${paddedWeek}`
}

// Week key → display label e.g. "Jan 6"
function weekKeyToLabel(weekKey: string): string {
  const [year, w] = weekKey.split('-W')
  const jan4 = new Date(Number(year), 0, 4)
  const startOfWeek1 = new Date(jan4)
  startOfWeek1.setDate(jan4.getDate() - ((jan4.getDay() + 6) % 7))
  const weekStart = new Date(startOfWeek1)
  weekStart.setDate(startOfWeek1.getDate() + (Number(w) - 1) * 7)
  return weekStart.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

// Month key → "Jan 25"
function monthKeyToLabel(monthKey: string): string {
  const [year, month] = monthKey.split('-')
  return new Date(Number(year), Number(month) - 1, 1)
    .toLocaleDateString('en-US', { month: 'short', year: '2-digit' })
}

// Group daily rows into period buckets
function getPeriodKey(dateStr: string, grouping: CadenceGrouping): string {
  if (grouping === 'day') return dateStr
  if (grouping === 'week') return toWeekKey(dateStr)
  return dateStr.slice(0, 7) // YYYY-MM
}

function getPeriodLabel(key: string, grouping: CadenceGrouping): string {
  if (grouping === 'day') {
    return new Date(key + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
  }
  if (grouping === 'week') return weekKeyToLabel(key)
  return monthKeyToLabel(key)
}

// ─── Custom Tooltip ───────────────────────────────────────────
const CustomTooltip = ({ active, payload, label }: any) => {
  if (!active || !payload?.length) return null
  return (
    <div style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border)', borderRadius: '8px', padding: '10px 14px', fontSize: '12px', boxShadow: 'var(--shadow-md)' }}>
      <div style={{ color: 'var(--text-muted)', marginBottom: '6px' }}>{label}</div>
      {payload.map((p: any, i: number) => (
        <div key={i} style={{ color: p.color, marginBottom: '2px' }}>
          {p.name}: <span style={{ color: 'var(--text-primary)', fontWeight: 500 }}>
            {p.name === 'Revenue' ? fmtCurrency(p.value) : fmt(p.value)}
          </span>
        </div>
      ))}
    </div>
  )
}

// ─── Sparkline ────────────────────────────────────────────────
function Sparkline({ data, positive }: { data: DataPoint[], positive: boolean | null }) {
  if (!data || data.length < 2) return <span style={{ color: 'var(--text-dim)', fontSize: '10px' }}>—</span>
  const color = positive === null ? 'var(--text-dim)' : positive ? 'var(--chart-success)' : 'var(--red)'
  return (
    <LineChart width={80} height={32} data={data}>
      <Line type="monotone" dataKey="revenue" stroke={color} strokeWidth={1.5} dot={false} />
    </LineChart>
  )
}

// ─── Main Component ───────────────────────────────────────────
export default function ProductPerformance() {
  const [markets, setMarkets]           = useState(['US', 'CA'])
  const [rangeIdx, setRangeIdx]         = useState(3)           // default 8W
  const [customStart, setCustomStart]   = useState<string>('')
  const [customEnd, setCustomEnd]       = useState<string>('')
  const [products, setProducts]         = useState<ProductRow[]>([])
  const [allPeriodData, setAllPeriodData] = useState<Record<string, DataPoint[]>>({})
  const [loading, setLoading]           = useState(true)
  const [expandedSku, setExpandedSku]   = useState<string | null>(null)
  const [sortKey, setSortKey]           = useState<SortKey>('revenue')
  const [sortDir, setSortDir]           = useState<SortDir>('desc')
  const [search, setSearch]             = useState('')
  const [page, setPage]                 = useState(0)
  const [tab, setTab]                   = useState<TabType>('summary')
  const [cadenceMetric, setCadenceMetric] = useState<CadenceMetric>('units')
  const [cadenceGrouping, setCadenceGrouping] = useState<CadenceGrouping>('week')

  const PAGE_SIZE = 50
  const isCustom = PRESET_RANGES[rangeIdx]?.custom === true

  // ─── Compute active date range ──────────────────────────────
  const getActiveDateRange = useCallback((): { start: string | null, end: string } => {
    const today = toISODate(new Date())
    if (isCustom) {
      return { start: customStart || null, end: customEnd || today }
    }
    const range = PRESET_RANGES[rangeIdx]
    return { start: getPresetCutoff(range), end: today }
  }, [rangeIdx, isCustom, customStart, customEnd])

  // ─── Data loading ────────────────────────────────────────────
  useEffect(() => {
    async function load() {
      setLoading(true)
      setExpandedSku(null)
      setPage(0)

      const { start, end } = getActiveDateRange()

      // Skip if custom range is incomplete
      if (isCustom && !customStart) {
        setLoading(false)
        return
      }

      let query = supabase
        .from('fct_sales_daily')
        .select('start_date, marketplace, units_ordered, ordered_product_sales_amount, sessions, buy_box_percentage, sku, title')
        .in('marketplace', markets)
        .lte('start_date', end)
        .order('start_date', { ascending: true })
        .limit(50000)

      if (start) query = query.gte('start_date', start)

      const { data, error } = await query
      if (error) { console.error(error); setLoading(false); return }

      // Fetch prior period for comparison (only for presets with defined days)
      let prevRows: any[] = []
      const range = PRESET_RANGES[rangeIdx]
      if (!isCustom && start && range.days) {
        const prevEnd = new Date(start)
        prevEnd.setDate(prevEnd.getDate() - 1)
        const prevStart = new Date(prevEnd)
        prevStart.setDate(prevStart.getDate() - range.days)
        const { data: pd } = await supabase
          .from('fct_sales_daily')
          .select('start_date, marketplace, units_ordered, ordered_product_sales_amount, sku')
          .in('marketplace', markets)
          .gte('start_date', toISODate(prevStart))
          .lte('start_date', toISODate(prevEnd))
          .limit(50000)
        prevRows = pd || []
      }

      // Aggregate by SKU
      const bySku: Record<string, {
        sku: string, title: string,
        revenue: number, units: number,
        sessions: number, conv_num: number, conv_den: number,
        bb_sum: number, bb_count: number
      }> = {}

      // Period data for cadence — keyed by SKU then period_key
      const periodBySku: Record<string, Record<string, DataPoint>> = {}

      for (const row of data || []) {
        if (!row.sku) continue
        if (!bySku[row.sku]) {
          bySku[row.sku] = { sku: row.sku, title: row.title || row.sku, revenue: 0, units: 0, sessions: 0, conv_num: 0, conv_den: 0, bb_sum: 0, bb_count: 0 }
        }
        const rev = toUSD(row.ordered_product_sales_amount || 0, row.marketplace)
        bySku[row.sku].revenue += rev
        bySku[row.sku].units   += row.units_ordered || 0
        bySku[row.sku].sessions += row.sessions || 0
        if (row.sessions > 0) {
          bySku[row.sku].conv_num += row.units_ordered || 0
          bySku[row.sku].conv_den += row.sessions || 0
        }
        if (row.buy_box_percentage != null) {
          bySku[row.sku].bb_sum   += row.buy_box_percentage
          bySku[row.sku].bb_count += 1
        }

        // Period bucketing (always store at day level — re-bucket on render)
        if (!periodBySku[row.sku]) periodBySku[row.sku] = {}
        const dk = row.start_date
        if (!periodBySku[row.sku][dk]) {
          periodBySku[row.sku][dk] = {
            period_key: dk,
            label: new Date(dk + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
            revenue: 0, units: 0,
          }
        }
        periodBySku[row.sku][dk].revenue += Math.round(rev)
        periodBySku[row.sku][dk].units   += row.units_ordered || 0
      }

      // Prior period revenue by SKU
      const prevBySku: Record<string, number> = {}
      for (const row of prevRows) {
        if (!row.sku) continue
        prevBySku[row.sku] = (prevBySku[row.sku] || 0) + toUSD(row.ordered_product_sales_amount || 0, row.marketplace)
      }

      // Build product rows
      const rows: ProductRow[] = Object.values(bySku).map(p => {
        const prev  = prevBySku[p.sku] || 0
        const wow   = prev > 0 ? ((p.revenue - prev) / prev) * 100 : null
        const conv  = p.conv_den > 0 ? (p.conv_num / p.conv_den) * 100 : 0
        const asp   = p.units > 0 ? p.revenue / p.units : 0
        const bb    = p.bb_count > 0 ? p.bb_sum / p.bb_count : null
        return { sku: p.sku, title: p.title, revenue: Math.round(p.revenue), units: p.units, sessions: p.sessions, conv_rate: conv, asp, buy_box_pct: bb, wow_change: wow, prev_revenue: Math.round(prev) }
      })

      // Sort daily period data — store as flat day-level array
      const sortedPeriods: Record<string, DataPoint[]> = {}
      for (const sku of Object.keys(periodBySku)) {
        sortedPeriods[sku] = Object.values(periodBySku[sku]).sort((a, b) => a.period_key.localeCompare(b.period_key))
      }

      setProducts(rows)
      setAllPeriodData(sortedPeriods)
      setLoading(false)
    }
    load()
  }, [markets, rangeIdx, customStart, customEnd])

  // ─── Re-bucket daily data into chosen grouping ───────────────
  const getBucketedData = useCallback((sku: string): DataPoint[] => {
    const daily = allPeriodData[sku] || []
    if (cadenceGrouping === 'day') return daily

    const buckets: Record<string, DataPoint> = {}
    for (const d of daily) {
      const key = getPeriodKey(d.period_key, cadenceGrouping)
      if (!buckets[key]) {
        buckets[key] = {
          period_key: key,
          label: getPeriodLabel(key, cadenceGrouping),
          revenue: 0, units: 0,
        }
      }
      buckets[key].revenue += d.revenue
      buckets[key].units   += d.units
    }
    return Object.values(buckets).sort((a, b) => a.period_key.localeCompare(b.period_key))
  }, [allPeriodData, cadenceGrouping])

  // ─── Sort / filter ────────────────────────────────────────────
  const handleSort = (key: SortKey) => {
    if (sortKey === key) setSortDir(d => d === 'asc' ? 'desc' : 'asc')
    else { setSortKey(key); setSortDir('desc') }
    setPage(0)
  }

  const filtered = products
    .filter(p => {
      if (!search) return true
      const q = search.toLowerCase()
      return p.sku.toLowerCase().includes(q) || p.title.toLowerCase().includes(q)
    })
    .sort((a, b) => {
      const av = a[sortKey] ?? -Infinity
      const bv = b[sortKey] ?? -Infinity
      return sortDir === 'desc' ? (bv as number) - (av as number) : (av as number) - (bv as number)
    })

  const paginated = filtered.slice(0, (page + 1) * PAGE_SIZE)
  const hasMore   = filtered.length > paginated.length

  // ─── Cadence table ────────────────────────────────────────────
  // All unique period keys across all SKUs — sorted
  const allPeriods = Array.from(
    new Set(Object.keys(allPeriodData).flatMap(sku => getBucketedData(sku).map(d => d.period_key)))
  ).sort()

  const cadenceRows = filtered
    .map(p => {
      const bucketed = getBucketedData(p.sku)
      const byPeriod: Record<string, DataPoint> = {}
      for (const d of bucketed) byPeriod[d.period_key] = d
      const total = cadenceMetric === 'units' ? p.units : p.revenue
      return { sku: p.sku, title: p.title, byPeriod, total }
    })
    .sort((a, b) => b.total - a.total)

  // ─── Display date range label ─────────────────────────────────
  const { start, end } = getActiveDateRange()
  const displayStart = start
    ? new Date(start + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
    : 'Jan 1, 2025'
  const displayEnd = new Date(end + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
  const activeLabel = isCustom && customStart ? `${displayStart} — ${displayEnd}` : `${displayStart} — ${displayEnd}`

  // ─── CSV exports ──────────────────────────────────────────────
  const exportCSV = () => {
    const headers = ['Rank', 'SKU', 'Title', 'Revenue', 'Units', 'Sessions', 'Conv %', 'ASP', 'Buy Box %', 'vs Prior %']
    const rows = filtered.map((p, i) => [
      i + 1, p.sku, `"${p.title.replace(/"/g, '""')}"`,
      p.revenue, p.units, p.sessions,
      p.conv_rate.toFixed(2), p.asp.toFixed(2),
      p.buy_box_pct !== null ? p.buy_box_pct.toFixed(1) : '',
      p.wow_change !== null ? p.wow_change.toFixed(1) : '',
    ])
    const csv = [headers, ...rows].map(r => r.join(',')).join('\n')
    const blob = new Blob([csv], { type: 'text/csv' })
    const url  = URL.createObjectURL(blob)
    const a    = document.createElement('a')
    a.href = url; a.download = `selleriq-products.csv`; a.click()
    URL.revokeObjectURL(url)
  }

  const exportCadenceCSV = () => {
    const periodLabels = allPeriods.map(k => getPeriodLabel(k, cadenceGrouping))
    const headers = ['SKU', 'Title', ...periodLabels, 'Total']
    const rows = cadenceRows.map(p => [
      p.sku,
      `"${p.title.replace(/"/g, '""')}"`,
      ...allPeriods.map(k => {
        const pt = p.byPeriod[k]
        return pt ? (cadenceMetric === 'units' ? pt.units : pt.revenue) : 0
      }),
      p.total,
    ])
    const csv = [headers, ...rows].map(r => r.join(',')).join('\n')
    const blob = new Blob([csv], { type: 'text/csv' })
    const url  = URL.createObjectURL(blob)
    const a    = document.createElement('a')
    a.href = url; a.download = `selleriq-cadence-${cadenceMetric}.csv`; a.click()
    URL.revokeObjectURL(url)
  }

  // ─── Table header styles ──────────────────────────────────────
  const thBase: React.CSSProperties = {
    padding: '10px 12px', fontSize: '10px', fontWeight: 600,
    textTransform: 'uppercase', letterSpacing: '0.06em',
    background: 'var(--bg-hover)', borderBottom: '1px solid var(--border)',
    position: 'sticky', top: 0, zIndex: 10,
    whiteSpace: 'nowrap',
  }
  const thSortable = (col: SortKey): React.CSSProperties => ({
    ...thBase,
    color: sortKey === col ? 'var(--accent)' : 'var(--text-muted)',
    cursor: 'pointer', userSelect: 'none',
  })

  const SortIcon = ({ col }: { col: SortKey }) => {
    if (sortKey !== col) return <ArrowUpDown size={10} style={{ opacity: 0.3 }} />
    return sortDir === 'desc' ? <ArrowDown size={10} /> : <ArrowUp size={10} />
  }

  // ─── Render ───────────────────────────────────────────────────
  return (
    <div>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: '20px', gap: '16px', flexWrap: 'wrap' }}>
        <div>
          <h1 style={{ fontSize: '20px', fontWeight: 600, letterSpacing: '-0.4px', marginBottom: '4px' }}>Product Performance</h1>
          <p style={{ fontSize: '13px', color: 'var(--text-muted)' }}>
            All revenue in USD · {filtered.length} SKUs
            {' · '}
            <span style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: '12px' }}>
              {activeLabel}
            </span>
          </p>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap' }}>
          {/* Export */}
          <button onClick={tab === 'summary' ? exportCSV : exportCadenceCSV} style={{
            display: 'flex', alignItems: 'center', gap: '6px',
            padding: '6px 12px', borderRadius: '7px',
            border: '1px solid var(--border)', background: 'transparent',
            color: 'var(--text-muted)', fontSize: '12px', cursor: 'pointer',
          }}
          onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.borderColor = 'var(--accent)'; (e.currentTarget as HTMLButtonElement).style.color = 'var(--accent)' }}
          onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.borderColor = 'var(--border)'; (e.currentTarget as HTMLButtonElement).style.color = 'var(--text-muted)' }}
          >
            <Download size={12} /> Export CSV
          </button>

          {/* Range presets */}
          <div style={{ display: 'flex', gap: '4px', alignItems: 'center' }}>
            <span style={{ fontSize: '10px', color: 'var(--text-dim)', marginRight: '4px', fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase' }}>Range</span>
            {PRESET_RANGES.map((r, i) => (
              <button key={r.label} onClick={() => { setRangeIdx(i); setPage(0) }} style={{
                padding: '4px 10px', borderRadius: '6px',
                border: rangeIdx === i ? '1px solid var(--accent-border)' : '1px solid var(--border)',
                background: rangeIdx === i ? 'var(--accent-light)' : 'transparent',
                color: rangeIdx === i ? 'var(--accent)' : 'var(--text-muted)',
                fontSize: '11px', fontWeight: 500, cursor: 'pointer',
                display: 'flex', alignItems: 'center', gap: '4px',
                fontFamily: r.custom ? 'inherit' : 'JetBrains Mono, monospace',
              }}>
                {r.custom && <Calendar size={10} />}
                {r.label}
              </button>
            ))}
          </div>

          <MarketplaceFilter selected={markets} onChange={setMarkets} />
        </div>
      </div>

      {/* Custom date range inputs */}
      {isCustom && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: '10px',
          padding: '12px 16px', marginBottom: '16px',
          background: 'var(--bg-card)', border: '1px solid var(--accent-border)',
          borderRadius: '10px', flexWrap: 'wrap',
        }}>
          <Calendar size={13} color="var(--accent)" />
          <span style={{ fontSize: '12px', color: 'var(--text-muted)', fontWeight: 500 }}>Custom range:</span>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <input
              type="date"
              value={customStart}
              onChange={e => setCustomStart(e.target.value)}
              style={{
                padding: '5px 10px', borderRadius: '6px', fontSize: '12px',
                border: '1px solid var(--border)', background: 'var(--bg-elevated)',
                color: 'var(--text-primary)', cursor: 'pointer', outline: 'none',
                fontFamily: 'JetBrains Mono, monospace',
              }}
            />
            <span style={{ fontSize: '12px', color: 'var(--text-dim)' }}>to</span>
            <input
              type="date"
              value={customEnd}
              max={toISODate(new Date())}
              onChange={e => setCustomEnd(e.target.value)}
              style={{
                padding: '5px 10px', borderRadius: '6px', fontSize: '12px',
                border: '1px solid var(--border)', background: 'var(--bg-elevated)',
                color: 'var(--text-primary)', cursor: 'pointer', outline: 'none',
                fontFamily: 'JetBrains Mono, monospace',
              }}
            />
          </div>
          {customStart && customEnd && (
            <span style={{ fontSize: '11px', color: 'var(--accent)', fontFamily: 'JetBrains Mono, monospace' }}>
              {Math.round((new Date(customEnd).getTime() - new Date(customStart).getTime()) / (1000 * 60 * 60 * 24))} days selected
            </span>
          )}
          {customStart && !customEnd && (
            <span style={{ fontSize: '11px', color: 'var(--text-dim)' }}>Select an end date</span>
          )}
          {!customStart && (
            <span style={{ fontSize: '11px', color: 'var(--text-dim)' }}>Select a start date</span>
          )}
        </div>
      )}

      {/* Tabs */}
      <div style={{ display: 'flex', gap: '0', marginBottom: '16px', borderBottom: '1px solid var(--border)' }}>
        {(['summary', 'cadence'] as TabType[]).map(t => (
          <button key={t} onClick={() => setTab(t)} style={{
            padding: '8px 20px', fontSize: '13px', fontWeight: 500,
            background: 'transparent', border: 'none', cursor: 'pointer',
            borderBottom: tab === t ? '2px solid var(--accent)' : '2px solid transparent',
            color: tab === t ? 'var(--accent)' : 'var(--text-muted)',
            marginBottom: '-1px', transition: 'all 0.12s ease',
            textTransform: 'capitalize',
          }}>
            {t === 'summary' ? 'Summary' : 'Cadence'}
          </button>
        ))}
      </div>

      {/* Search */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: '10px',
        background: 'var(--bg-card)', border: '1px solid var(--border)',
        borderRadius: '10px', padding: '10px 14px',
        boxShadow: 'var(--shadow-sm)', marginBottom: '16px',
      }}>
        <Search size={14} color="var(--text-muted)" />
        <input
          type="text"
          placeholder="Filter by SKU or product name..."
          value={search}
          onChange={e => { setSearch(e.target.value); setPage(0) }}
          style={{
            flex: 1, background: 'transparent', border: 'none', outline: 'none',
            color: 'var(--text-primary)', fontSize: '13px', fontFamily: 'Inter, sans-serif',
          }}
        />
        {search && (
          <button onClick={() => setSearch('')} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-dim)', display: 'flex' }}>✕</button>
        )}
      </div>

      {loading ? (
        <div style={{ color: 'var(--text-muted)', fontSize: '13px' }}>Loading...</div>
      ) : isCustom && !customStart ? (
        <div style={{ padding: '60px', textAlign: 'center', color: 'var(--text-dim)', fontSize: '13px' }}>
          Select a start date above to load data
        </div>
      ) : tab === 'summary' ? (

        /* ── SUMMARY TAB ── */
        <>
          <div className="card" style={{ overflow: 'hidden' }}>
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead>
                  <tr>
                    <th style={{ ...thBase, width: '36px', textAlign: 'center', color: 'var(--text-muted)' }}>#</th>
                    <th style={{ ...thBase, textAlign: 'left', color: 'var(--text-muted)' }}>Product</th>
                    <th style={{ ...thBase, width: '80px', textAlign: 'center', color: 'var(--text-muted)' }}>Trend</th>
                    <th style={{ ...thSortable('revenue'), textAlign: 'right' }} onClick={() => handleSort('revenue')}>
                      <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: '4px' }}>Revenue <SortIcon col="revenue" /></span>
                    </th>
                    <th style={{ ...thSortable('units'), textAlign: 'right' }} onClick={() => handleSort('units')}>
                      <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: '4px' }}>Units <SortIcon col="units" /></span>
                    </th>
                    <th style={{ ...thSortable('asp'), textAlign: 'right' }} onClick={() => handleSort('asp')}>
                      <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: '4px' }}>ASP <SortIcon col="asp" /></span>
                    </th>
                    <th style={{ ...thSortable('sessions'), textAlign: 'right' }} onClick={() => handleSort('sessions')}>
                      <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: '4px' }}>Sessions <SortIcon col="sessions" /></span>
                    </th>
                    <th style={{ ...thSortable('conv_rate'), textAlign: 'right' }} onClick={() => handleSort('conv_rate')}>
                      <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: '4px' }}>Conv % <SortIcon col="conv_rate" /></span>
                    </th>
                    <th style={{ ...thSortable('buy_box_pct'), textAlign: 'right' }} onClick={() => handleSort('buy_box_pct')}>
                      <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: '4px' }}>Buy Box <SortIcon col="buy_box_pct" /></span>
                    </th>
                    <th style={{ ...thSortable('wow_change'), textAlign: 'right' }} onClick={() => handleSort('wow_change')}>
                      <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: '4px' }}>vs Prior <SortIcon col="wow_change" /></span>
                    </th>
                    <th style={{ ...thBase, width: '32px' }}></th>
                  </tr>
                </thead>
                <tbody>
                  {paginated.map((p, i) => {
                    const isExpanded  = expandedSku === p.sku
                    const sparkData   = getBucketedData(p.sku)
                    const trend = sparkData.length >= 2
                      ? sparkData[sparkData.length - 1].revenue > sparkData[0].revenue
                      : null
                    return (
                      <React.Fragment key={p.sku}>
                        <tr
                          onClick={() => setExpandedSku(isExpanded ? null : p.sku)}
                          style={{
                            cursor: 'pointer',
                            background: isExpanded ? 'var(--accent-light)' : 'transparent',
                            transition: 'background 0.1s ease',
                            borderBottom: isExpanded ? 'none' : '1px solid var(--border)',
                          }}
                          onMouseEnter={e => { if (!isExpanded) (e.currentTarget as HTMLTableRowElement).style.background = 'var(--bg-hover)' }}
                          onMouseLeave={e => { if (!isExpanded) (e.currentTarget as HTMLTableRowElement).style.background = 'transparent' }}
                        >
                          <td style={{ padding: '11px 12px', textAlign: 'center', fontSize: '11px', color: 'var(--text-dim)', fontFamily: 'JetBrains Mono, monospace' }}>{i + 1}</td>
                          <td style={{ padding: '11px 12px' }}>
                            <div style={{ fontSize: '12px', fontWeight: 500, color: 'var(--text-primary)', marginBottom: '2px' }}>{truncate(p.title, 52)}</div>
                            <div style={{ fontSize: '10px', color: 'var(--text-dim)', fontFamily: 'JetBrains Mono, monospace' }}>{p.sku}</div>
                          </td>
                          <td style={{ padding: '4px 8px', textAlign: 'center' }}>
                            <Sparkline data={sparkData} positive={trend} />
                          </td>
                          <td style={{ padding: '11px 12px', textAlign: 'right', fontSize: '12px', fontWeight: 600, fontFamily: 'JetBrains Mono, monospace', color: 'var(--text-primary)' }}>{fmtCurrency(p.revenue)}</td>
                          <td style={{ padding: '11px 12px', textAlign: 'right', fontSize: '12px', fontFamily: 'JetBrains Mono, monospace', color: 'var(--text-primary)' }}>{fmt(p.units)}</td>
                          <td style={{ padding: '11px 12px', textAlign: 'right', fontSize: '12px', fontFamily: 'JetBrains Mono, monospace', color: 'var(--text-primary)' }}>${p.asp.toFixed(2)}</td>
                          <td style={{ padding: '11px 12px', textAlign: 'right', fontSize: '12px', fontFamily: 'JetBrains Mono, monospace', color: 'var(--text-primary)' }}>{fmt(p.sessions)}</td>
                          <td style={{ padding: '11px 12px', textAlign: 'right', fontSize: '12px', fontFamily: 'JetBrains Mono, monospace', color: 'var(--text-primary)' }}>{p.conv_rate.toFixed(1)}%</td>
                          <td style={{ padding: '11px 12px', textAlign: 'right', fontSize: '12px', fontFamily: 'JetBrains Mono, monospace', color: 'var(--text-primary)' }}>{p.buy_box_pct !== null ? p.buy_box_pct.toFixed(1) + '%' : '—'}</td>
                          <td style={{ padding: '11px 12px', textAlign: 'right' }}>
                            {p.wow_change !== null ? (
                              <span style={{ fontSize: '11px', fontWeight: 600, color: p.wow_change > 0 ? 'var(--green)' : p.wow_change < 0 ? 'var(--red)' : 'var(--text-muted)', display: 'inline-flex', alignItems: 'center', gap: '2px', fontFamily: 'JetBrains Mono, monospace' }}>
                                {p.wow_change > 0 ? <TrendingUp size={10} /> : p.wow_change < 0 ? <TrendingDown size={10} /> : <Minus size={10} />}
                                {p.wow_change > 0 ? '+' : ''}{p.wow_change.toFixed(1)}%
                              </span>
                            ) : (
                              <span style={{ fontSize: '11px', color: 'var(--text-dim)' }}>—</span>
                            )}
                          </td>
                          <td style={{ padding: '11px 12px', textAlign: 'center', color: 'var(--text-dim)' }}>
                            {isExpanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                          </td>
                        </tr>
                        {isExpanded && (
                          <tr key={p.sku + '-exp'} style={{ borderBottom: '1px solid var(--border)' }}>
                            <td colSpan={11} style={{ padding: '0 20px 20px 20px', background: 'var(--accent-light)' }}>
                              <div style={{ paddingTop: '16px' }}>
                                <div style={{ display: 'flex', gap: '28px', marginBottom: '16px', flexWrap: 'wrap' }}>
                                  {[
                                    { label: 'Revenue',   value: fmtCurrency(p.revenue) },
                                    { label: 'Units',     value: fmt(p.units) },
                                    { label: 'ASP',       value: '$' + p.asp.toFixed(2) },
                                    { label: 'Sessions',  value: fmt(p.sessions) },
                                    { label: 'Conv Rate', value: p.conv_rate.toFixed(1) + '%' },
                                    { label: 'Buy Box',   value: p.buy_box_pct !== null ? p.buy_box_pct.toFixed(1) + '%' : '—' },
                                    ...(p.wow_change !== null ? [{ label: 'vs Prior', value: (p.wow_change > 0 ? '+' : '') + p.wow_change.toFixed(1) + '%', color: p.wow_change > 0 ? 'var(--green)' : 'var(--red)' }] : []),
                                  ].map((stat, idx) => (
                                    <div key={idx}>
                                      <div style={{ fontSize: '10px', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: '3px' }}>{stat.label}</div>
                                      <div style={{ fontSize: '17px', fontWeight: 600, fontFamily: 'JetBrains Mono, monospace', color: (stat as any).color || 'var(--text-primary)' }}>{stat.value}</div>
                                    </div>
                                  ))}
                                </div>
                                <ResponsiveContainer width="100%" height={160}>
                                  <AreaChart data={allPeriodData[p.sku] || []}>
                                    <defs>
                                      <linearGradient id={`grad-${sanitizeId(p.sku)}`} x1="0" y1="0" x2="0" y2="1">
                                        <stop offset="5%"  stopColor="var(--chart-primary)" stopOpacity={1} />
                                        <stop offset="95%" stopColor="var(--chart-primary)" stopOpacity={0} />
                                      </linearGradient>
                                    </defs>
                                    <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
                                    <XAxis dataKey="label" tick={{ fontSize: 9, fill: 'var(--text-dim)' }} tickLine={false} axisLine={false} interval="preserveStartEnd" />
                                    <YAxis tick={{ fontSize: 9, fill: 'var(--text-dim)' }} tickLine={false} axisLine={false} tickFormatter={v => '$' + fmt(v)} width={55} />
                                    <Tooltip content={<CustomTooltip />} />
                                    <Area type="monotone" dataKey="revenue" name="Revenue" stroke="var(--chart-primary)" strokeWidth={1.5} fill={`url(#grad-${sanitizeId(p.sku)})`} dot={false} />
                                  </AreaChart>
                                </ResponsiveContainer>
                              </div>
                            </td>
                          </tr>
                        )}
                      </React.Fragment>
                    )
                  })}
                </tbody>
              </table>
            </div>
            {filtered.length === 0 && (
              <div style={{ padding: '40px', textAlign: 'center', color: 'var(--text-dim)', fontSize: '13px' }}>No products found</div>
            )}
          </div>
          {hasMore && (
            <div style={{ textAlign: 'center', marginTop: '16px' }}>
              <button onClick={() => setPage(p => p + 1)} style={{
                padding: '8px 24px', borderRadius: '8px',
                border: '1px solid var(--border)', background: 'var(--bg-card)',
                color: 'var(--text-muted)', fontSize: '12px', cursor: 'pointer',
              }}
              onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.borderColor = 'var(--accent)'; (e.currentTarget as HTMLButtonElement).style.color = 'var(--accent)' }}
              onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.borderColor = 'var(--border)'; (e.currentTarget as HTMLButtonElement).style.color = 'var(--text-muted)' }}
              >
                Load more — showing {paginated.length} of {filtered.length}
              </button>
            </div>
          )}
        </>

      ) : (

        /* ── CADENCE TAB ── */
        <>
          <div style={{ display: 'flex', alignItems: 'center', gap: '16px', marginBottom: '14px', flexWrap: 'wrap' }}>

            {/* Units / Revenue toggle */}
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
              <span style={{ fontSize: '11px', color: 'var(--text-dim)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em', marginRight: '4px' }}>View</span>
              {(['units', 'revenue'] as CadenceMetric[]).map(m => (
                <button key={m} onClick={() => setCadenceMetric(m)} style={{
                  padding: '4px 12px', borderRadius: '6px', fontSize: '11px', fontWeight: 500,
                  cursor: 'pointer', transition: 'all 0.12s ease', textTransform: 'capitalize',
                  border: cadenceMetric === m ? '1px solid var(--accent-border)' : '1px solid var(--border)',
                  background: cadenceMetric === m ? 'var(--accent-light)' : 'transparent',
                  color: cadenceMetric === m ? 'var(--accent)' : 'var(--text-muted)',
                }}>{m === 'units' ? 'Units' : 'Revenue'}</button>
              ))}
            </div>

            {/* Day / Week / Month grouping toggle */}
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
              <span style={{ fontSize: '11px', color: 'var(--text-dim)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em', marginRight: '4px' }}>Group by</span>
              {(['day', 'week', 'month'] as CadenceGrouping[]).map(g => (
                <button key={g} onClick={() => setCadenceGrouping(g)} style={{
                  padding: '4px 12px', borderRadius: '6px', fontSize: '11px', fontWeight: 500,
                  cursor: 'pointer', transition: 'all 0.12s ease', textTransform: 'capitalize',
                  border: cadenceGrouping === g ? '1px solid var(--accent-border)' : '1px solid var(--border)',
                  background: cadenceGrouping === g ? 'var(--accent-light)' : 'transparent',
                  color: cadenceGrouping === g ? 'var(--accent)' : 'var(--text-muted)',
                }}>{g}</button>
              ))}
            </div>

            <span style={{ fontSize: '11px', color: 'var(--text-dim)', fontFamily: 'JetBrains Mono, monospace', marginLeft: 'auto' }}>
              {allPeriods.length} {cadenceGrouping}s · {cadenceRows.length} SKUs
            </span>
          </div>

          <div className="card" style={{ overflow: 'hidden' }}>
            <div
              className="cadence-scroll"
              style={{
                overflowX: 'auto', overflowY: 'auto', maxHeight: '70vh',
                scrollbarWidth: 'auto', scrollbarColor: 'var(--accent) var(--bg-hover)',
              }}
            >
              <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: `${300 + allPeriods.length * 80}px` }}>
                <thead>
                  <tr>
                    <th style={{ ...thBase, textAlign: 'left', color: 'var(--text-muted)', minWidth: '220px', position: 'sticky', left: 0, zIndex: 20 }}>
                      Product
                    </th>
                    {allPeriods.map((k, i) => (
                      <th key={k} style={{ ...thBase, textAlign: 'right', color: 'var(--text-muted)', minWidth: '72px' }}>
                        <div style={{ fontWeight: 700, color: 'var(--text-primary)' }}>
                          {cadenceGrouping === 'day' ? `D${i + 1}` : cadenceGrouping === 'week' ? `W${i + 1}` : `M${i + 1}`}
                        </div>
                        <div style={{ fontSize: '9px', fontWeight: 400, color: 'var(--text-dim)', marginTop: '1px', fontFamily: 'JetBrains Mono, monospace' }}>
                          {getPeriodLabel(k, cadenceGrouping)}
                        </div>
                      </th>
                    ))}
                    <th style={{ ...thBase, textAlign: 'right', color: 'var(--accent)', minWidth: '80px', borderLeft: '1px solid var(--border)' }}>
                      Total
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {cadenceRows.map(p => {
                    const skuVals = allPeriods.map(k => {
                      const pt = p.byPeriod[k]
                      return pt ? (cadenceMetric === 'units' ? pt.units : pt.revenue) : 0
                    })
                    const skuMax = Math.max(...skuVals, 1)

                    return (
                      <tr key={p.sku} style={{ borderBottom: '1px solid var(--border)' }}>
                        <td style={{
                          padding: '9px 12px', position: 'sticky', left: 0, zIndex: 5,
                          background: 'var(--bg-card)', borderRight: '1px solid var(--border)',
                        }}>
                          <div style={{ fontSize: '11px', fontWeight: 500, color: 'var(--text-primary)', marginBottom: '1px' }}>{truncate(p.title, 30)}</div>
                          <div style={{ fontSize: '10px', color: 'var(--text-dim)', fontFamily: 'JetBrains Mono, monospace' }}>{p.sku}</div>
                        </td>
                        {allPeriods.map(k => {
                          const pt    = p.byPeriod[k]
                          const val   = pt ? (cadenceMetric === 'units' ? pt.units : pt.revenue) : 0
                          const isEmpty = val === 0
                          const ratio = isEmpty ? 0 : val / skuMax
                          const bg = isEmpty ? 'rgba(220,38,38,0.08)'
                            : ratio > 0.75 ? 'rgba(5,150,105,0.12)'
                            : ratio > 0.4  ? 'rgba(5,150,105,0.05)'
                            : 'transparent'
                          return (
                            <td key={k} style={{
                              padding: '9px 10px', textAlign: 'right',
                              fontSize: '11px', fontFamily: 'JetBrains Mono, monospace',
                              color: isEmpty ? 'var(--text-dim)' : 'var(--text-primary)',
                              background: bg, fontWeight: isEmpty ? 400 : 500,
                            }}>
                              {isEmpty ? '—' : cadenceMetric === 'units' ? val.toLocaleString() : fmtCurrency(val)}
                            </td>
                          )
                        })}
                        <td style={{
                          padding: '9px 12px', textAlign: 'right',
                          fontSize: '11px', fontWeight: 700,
                          fontFamily: 'JetBrains Mono, monospace', color: 'var(--text-primary)',
                          borderLeft: '1px solid var(--border)',
                        }}>
                          {cadenceMetric === 'units' ? p.total.toLocaleString() : fmtCurrency(p.total)}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
            {cadenceRows.length === 0 && (
              <div style={{ padding: '40px', textAlign: 'center', color: 'var(--text-dim)', fontSize: '13px' }}>No products found</div>
            )}
          </div>
        </>
      )}
    </div>
  )
}