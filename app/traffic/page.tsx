'use client'

import React, { useEffect, useState } from 'react'
import { supabase } from '@/lib/supabase'
import MarketplaceFilter from '@/components/MarketplaceFilter'
import {
  AreaChart, Area, XAxis, YAxis, CartesianGrid,
  Tooltip, ResponsiveContainer, LineChart, Line,
} from 'recharts'
import {
  ChevronDown, ChevronRight, TrendingUp, TrendingDown, Minus,
  ArrowUpDown, ArrowUp, ArrowDown, Search, Download,
  AlertTriangle, AlertCircle, CheckCircle2,
} from 'lucide-react'

// ─────────────────────────────────────────────────────────────
// Constants & helpers
// ─────────────────────────────────────────────────────────────

const CAD_TO_USD = 0.74

const DATE_RANGES = [
  { label: '4W',  days: 28  },
  { label: '8W',  days: 56  },
  { label: '13W', days: 91  },
  { label: 'YTD', days: null, ytd: true },
  { label: 'ALL', days: null },
]

// Health classification thresholds. Tweak these once you have a feel
// for what "good" looks like for your specific catalog.
const MIN_TRAFFIC_FOR_FLAGS = 100   // ignore noise from low-traffic SKUs
const LOW_CONV_THRESHOLD = 5        // % — below this is suspect
const HEALTHY_CONV_THRESHOLD = 12   // % — above this is healthy
const BUY_BOX_WARN = 80             // % — below this is "weak"
const BUY_BOX_OK = 90               // % — above this is healthy

type HealthStatus = 'healthy' | 'low_conv' | 'weak_bb' | 'critical' | 'low_traffic'

type ProductRow = {
  sku: string
  title: string
  sessions: number
  page_views: number
  views_per_session: number
  conv_rate: number
  buy_box_pct: number | null
  units: number
  prev_conv_rate: number | null
  conv_change: number | null  // pp change vs prior period
  health: HealthStatus
}

type WeeklyPoint = {
  start_date: string
  raw_date: string
  sessions: number
  conv_rate: number
  buy_box_pct: number
}

type SortKey = 'sessions' | 'page_views' | 'views_per_session' | 'conv_rate' | 'buy_box_pct' | 'units' | 'conv_change'
type SortDir = 'asc' | 'desc'

function fmt(n: number) {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + 'M'
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K'
  return n.toLocaleString()
}
function toUSD(amount: number, marketplace: string) {
  return marketplace === 'CA' ? amount * CAD_TO_USD : amount
}
function getDateCutoff(range: typeof DATE_RANGES[0]): string | null {
  if (!range.days && !range.ytd) return null
  const now = new Date()
  if (range.ytd) return new Date(now.getFullYear(), 0, 1).toISOString().split('T')[0]
  const d = new Date(now)
  d.setDate(d.getDate() - range.days! - 7)
  return d.toISOString().split('T')[0]
}
function truncate(s: string, n: number) {
  return s && s.length > n ? s.slice(0, n) + '…' : s
}
function sanitizeId(s: string) {
  return s.replace(/[^a-zA-Z0-9]/g, '_')
}

// Determine health status from sessions, conv, buy box.
function classifyHealth(sessions: number, conv: number, bb: number | null): HealthStatus {
  if (sessions < MIN_TRAFFIC_FOR_FLAGS) return 'low_traffic'
  const lowConv = conv < LOW_CONV_THRESHOLD
  const weakBB = bb !== null && bb < BUY_BOX_WARN
  if (lowConv && weakBB) return 'critical'
  if (lowConv) return 'low_conv'
  if (weakBB) return 'weak_bb'
  return 'healthy'
}

// Diagnostic message shown in expanded row.
function diagnosticMessage(p: ProductRow): string {
  switch (p.health) {
    case 'critical':
      return `Both conversion (${p.conv_rate.toFixed(1)}%) and buy box (${p.buy_box_pct?.toFixed(1)}%) are weak. Likely a pricing or listing issue — investigate competitor pricing first.`
    case 'low_conv':
      return `Traffic is healthy (${fmt(p.sessions)} sessions) but conversion is only ${p.conv_rate.toFixed(1)}%. Listing content, images, reviews, or price are likely culprits.`
    case 'weak_bb':
      return `Buy box at ${p.buy_box_pct?.toFixed(1)}% means you're losing sales to competitors. Check pricing and seller competition.`
    case 'low_traffic':
      return `Only ${p.sessions} sessions in this window — too little data for a reliable diagnosis. Consider advertising to drive traffic.`
    case 'healthy':
      return `Conversion (${p.conv_rate.toFixed(1)}%) and buy box (${p.buy_box_pct !== null ? p.buy_box_pct.toFixed(1) + '%' : 'n/a'}) are both in healthy ranges.`
  }
}

const HEALTH_META: Record<HealthStatus, { label: string, color: string, bg: string, icon: React.ComponentType<any> }> = {
  healthy:     { label: 'Healthy',     color: 'var(--green)',     bg: 'rgba(5,150,105,0.1)',  icon: CheckCircle2 },
  low_conv:    { label: 'Low conv',    color: '#d97706',          bg: 'rgba(217,119,6,0.1)',  icon: AlertCircle },
  weak_bb:     { label: 'Weak BB',     color: '#d97706',          bg: 'rgba(217,119,6,0.1)',  icon: AlertCircle },
  critical:    { label: 'Critical',    color: 'var(--red)',       bg: 'rgba(220,38,38,0.1)',  icon: AlertTriangle },
  low_traffic: { label: 'Low traffic', color: 'var(--text-dim)',  bg: 'transparent',          icon: Minus },
}

const CustomTooltip = ({ active, payload, label }: any) => {
  if (!active || !payload?.length) return null
  return (
    <div style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border)', borderRadius: '8px', padding: '10px 14px', fontSize: '12px', boxShadow: 'var(--shadow-md)' }}>
      <div style={{ color: 'var(--text-muted)', marginBottom: '6px' }}>{label}</div>
      {payload.map((p: any, i: number) => (
        <div key={i} style={{ color: p.color, marginBottom: '2px' }}>
          {p.name}: <span style={{ color: 'var(--text-primary)', fontWeight: 500 }}>
            {typeof p.value === 'number' ? p.value.toFixed(1) + (p.name === 'Sessions' ? '' : '%') : p.value}
          </span>
        </div>
      ))}
    </div>
  )
}

function Sparkline({ data, dataKey, positive }: { data: WeeklyPoint[], dataKey: 'sessions' | 'conv_rate' | 'buy_box_pct', positive: boolean | null }) {
  if (!data || data.length < 2) return <span style={{ color: 'var(--text-dim)', fontSize: '10px' }}>—</span>
  const color = positive === null ? 'var(--text-dim)' : positive ? 'var(--green)' : 'var(--red)'
  return (
    <LineChart width={80} height={32} data={data}>
      <Line type="monotone" dataKey={dataKey} stroke={color} strokeWidth={1.5} dot={false} />
    </LineChart>
  )
}

// ─────────────────────────────────────────────────────────────
// Page
// ─────────────────────────────────────────────────────────────

export default function TrafficConversion() {
  const [markets, setMarkets] = useState(['US', 'CA'])
  const [rangeIdx, setRangeIdx] = useState(2) // default 13W for traffic — more meaningful trends
  const [products, setProducts] = useState<ProductRow[]>([])
  const [allWeeklyData, setAllWeeklyData] = useState<Record<string, WeeklyPoint[]>>({})
  const [loading, setLoading] = useState(true)
  const [expandedSku, setExpandedSku] = useState<string | null>(null)
  const [sortKey, setSortKey] = useState<SortKey>('sessions')
  const [sortDir, setSortDir] = useState<SortDir>('desc')
  const [search, setSearch] = useState('')
  const [healthFilter, setHealthFilter] = useState<'all' | 'needs_attention' | 'healthy'>('all')
  const [page, setPage] = useState(0)
  const PAGE_SIZE = 50

  useEffect(() => {
    async function load() {
      setLoading(true)
      setExpandedSku(null)
      setPage(0)
      const range = DATE_RANGES[rangeIdx]
      const cutoff = getDateCutoff(range)

      let query = supabase
        .from('fct_sales_daily')
        .select('start_date, marketplace, units_ordered, sessions, page_views, buy_box_percentage, unit_session_percentage, sku, title')
        .in('marketplace', markets)
        .order('start_date', { ascending: true })
        .limit(20000)

      if (cutoff) query = query.gte('start_date', cutoff)

      const { data, error } = await query
      if (error) { console.error(error); setLoading(false); return }

      // Fetch prior period for conversion delta
      let prevRows: any[] = []
      if (cutoff && range.days) {
        const prevEnd = new Date(cutoff)
        prevEnd.setDate(prevEnd.getDate() - 1)
        const prevStart = new Date(prevEnd)
        prevStart.setDate(prevStart.getDate() - range.days)
        const { data: pd } = await supabase
          .from('fct_sales_daily')
          .select('marketplace, units_ordered, sessions, sku')
          .in('marketplace', markets)
          .gte('start_date', prevStart.toISOString().split('T')[0])
          .lte('start_date', prevEnd.toISOString().split('T')[0])
          .limit(20000)
        prevRows = pd || []
      }

      // Aggregate current period by SKU
      const bySku: Record<string, {
        sku: string, title: string,
        sessions: number, page_views: number, units: number,
        conv_num: number, conv_den: number,
        bb_sum: number, bb_count: number,
      }> = {}
      const weeklyBySku: Record<string, Record<string, WeeklyPoint>> = {}

      for (const row of data || []) {
        if (!row.sku) continue
        if (!bySku[row.sku]) {
          bySku[row.sku] = {
            sku: row.sku, title: row.title || row.sku,
            sessions: 0, page_views: 0, units: 0,
            conv_num: 0, conv_den: 0, bb_sum: 0, bb_count: 0,
          }
        }
        bySku[row.sku].sessions += row.sessions || 0
        bySku[row.sku].page_views += row.page_views || 0
        bySku[row.sku].units += row.units_ordered || 0
        if (row.sessions > 0) {
          bySku[row.sku].conv_num += row.units_ordered || 0
          bySku[row.sku].conv_den += row.sessions || 0
        }
        if (row.buy_box_percentage != null) {
          bySku[row.sku].bb_sum += row.buy_box_percentage
          bySku[row.sku].bb_count += 1
        }

        // Weekly trend points
        if (!weeklyBySku[row.sku]) weeklyBySku[row.sku] = {}
        const key = row.start_date
        if (!weeklyBySku[row.sku][key]) {
          weeklyBySku[row.sku][key] = {
            raw_date: key,
            start_date: new Date(key + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
            sessions: 0, conv_rate: 0, buy_box_pct: 0,
          }
        }
        const point = weeklyBySku[row.sku][key]
        // Sum across marketplaces for the same week
        point.sessions += row.sessions || 0
        // For weekly conv/BB, take simple session-weighted avg via the row
        if (row.sessions > 0 && row.unit_session_percentage != null) {
          const prevWeighted = point.conv_rate * (point.sessions - (row.sessions || 0))
          point.conv_rate = (prevWeighted + (row.unit_session_percentage * row.sessions)) / point.sessions
        }
        if (row.buy_box_percentage != null) {
          point.buy_box_pct = (point.buy_box_pct + row.buy_box_percentage) / (point.buy_box_pct === 0 ? 1 : 2)
        }
      }

      // Aggregate prior period by SKU for conversion delta
      const prevBySku: Record<string, { sessions: number, units: number }> = {}
      for (const row of prevRows) {
        if (!row.sku) continue
        if (!prevBySku[row.sku]) prevBySku[row.sku] = { sessions: 0, units: 0 }
        prevBySku[row.sku].sessions += row.sessions || 0
        prevBySku[row.sku].units += row.units_ordered || 0
      }

      const rows: ProductRow[] = Object.values(bySku).map(p => {
        const conv = p.conv_den > 0 ? (p.conv_num / p.conv_den) * 100 : 0
        const vps = p.sessions > 0 ? p.page_views / p.sessions : 0
        const bb = p.bb_count > 0 ? p.bb_sum / p.bb_count : null
        const prev = prevBySku[p.sku]
        const prevConv = prev && prev.sessions > 0 ? (prev.units / prev.sessions) * 100 : null
        const convChange = prevConv !== null ? conv - prevConv : null
        const health = classifyHealth(p.sessions, conv, bb)
        return {
          sku: p.sku, title: p.title,
          sessions: p.sessions, page_views: p.page_views,
          views_per_session: vps,
          conv_rate: conv, buy_box_pct: bb,
          units: p.units,
          prev_conv_rate: prevConv,
          conv_change: convChange,
          health,
        }
      })

      const sortedWeekly: Record<string, WeeklyPoint[]> = {}
      for (const sku of Object.keys(weeklyBySku)) {
        sortedWeekly[sku] = Object.values(weeklyBySku[sku]).sort((a, b) => a.raw_date.localeCompare(b.raw_date))
      }

      setProducts(rows)
      setAllWeeklyData(sortedWeekly)
      setLoading(false)
    }
    load()
  }, [markets, rangeIdx])

  const handleSort = (key: SortKey) => {
    if (sortKey === key) setSortDir(d => d === 'asc' ? 'desc' : 'asc')
    else { setSortKey(key); setSortDir('desc') }
    setPage(0)
  }

  const filtered = products
    .filter(p => {
      if (search) {
        const q = search.toLowerCase()
        if (!p.sku.toLowerCase().includes(q) && !p.title.toLowerCase().includes(q)) return false
      }
      if (healthFilter === 'needs_attention' && (p.health === 'healthy' || p.health === 'low_traffic')) return false
      if (healthFilter === 'healthy' && p.health !== 'healthy') return false
      return true
    })
    .sort((a, b) => {
      const av = a[sortKey] ?? -Infinity
      const bv = b[sortKey] ?? -Infinity
      return sortDir === 'desc' ? (bv as number) - (av as number) : (av as number) - (bv as number)
    })

  const paginated = filtered.slice(0, (page + 1) * PAGE_SIZE)
  const hasMore = filtered.length > paginated.length

  // Summary tiles
  const totalSessions = products.reduce((s, p) => s + p.sessions, 0)
  const totalConvNum = products.reduce((s, p) => s + p.units, 0)
  const totalConvDen = products.reduce((s, p) => s + p.sessions, 0)
  const overallConv = totalConvDen > 0 ? (totalConvNum / totalConvDen) * 100 : 0
  const bbProducts = products.filter(p => p.buy_box_pct !== null)
  const overallBB = bbProducts.length > 0 ? bbProducts.reduce((s, p) => s + (p.buy_box_pct || 0), 0) / bbProducts.length : null
  const needsAttentionCount = products.filter(p => p.health === 'low_conv' || p.health === 'weak_bb' || p.health === 'critical').length

  const exportCSV = () => {
    const headers = ['Rank', 'SKU', 'Title', 'Sessions', 'Page Views', 'Views/Session', 'Buy Box %', 'Conv %', 'Units', 'Conv Change (pp)', 'Health']
    const rows = filtered.map((p, i) => [
      i + 1, p.sku, `"${p.title.replace(/"/g, '""')}"`,
      p.sessions, p.page_views, p.views_per_session.toFixed(2),
      p.buy_box_pct !== null ? p.buy_box_pct.toFixed(1) : '',
      p.conv_rate.toFixed(2),
      p.units,
      p.conv_change !== null ? p.conv_change.toFixed(2) : '',
      HEALTH_META[p.health].label,
    ])
    const csv = [headers, ...rows].map(r => r.join(',')).join('\n')
    const blob = new Blob([csv], { type: 'text/csv' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `selleriq-traffic-${DATE_RANGES[rangeIdx].label}.csv`
    a.click()
    URL.revokeObjectURL(url)
  }

  const range = DATE_RANGES[rangeIdx]
  const cutoff = getDateCutoff(range)
  const endDate = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
  const startDate = cutoff
    ? new Date(cutoff + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
    : 'Jan 5, 2025'

  const SortIcon = ({ col }: { col: SortKey }) => {
    if (sortKey !== col) return <ArrowUpDown size={10} style={{ opacity: 0.3 }} />
    return sortDir === 'desc' ? <ArrowDown size={10} /> : <ArrowUp size={10} />
  }

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

  return (
    <div>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '20px' }}>
        <div>
          <h1 style={{ fontSize: '20px', fontWeight: 600, letterSpacing: '-0.4px', marginBottom: '4px' }}>Traffic & Conversion</h1>
          <p style={{ fontSize: '13px', color: 'var(--text-muted)' }}>
            Funnel diagnostics · {filtered.length} SKUs
            {' · '}
            <span style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: '12px' }}>
              {startDate} — {endDate}
            </span>
          </p>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          <button onClick={exportCSV} style={{
            display: 'flex', alignItems: 'center', gap: '6px',
            padding: '6px 12px', borderRadius: '7px',
            border: '1px solid var(--border)', background: 'transparent',
            color: 'var(--text-muted)', fontSize: '12px', cursor: 'pointer',
            transition: 'all 0.12s ease',
          }}
          onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.borderColor = 'var(--accent)'; (e.currentTarget as HTMLButtonElement).style.color = 'var(--accent)' }}
          onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.borderColor = 'var(--border)'; (e.currentTarget as HTMLButtonElement).style.color = 'var(--text-muted)' }}
          >
            <Download size={12} /> Export CSV
          </button>
          <div style={{ display: 'flex', gap: '4px', alignItems: 'center' }}>
            <span style={{ fontSize: '10px', color: 'var(--text-dim)', marginRight: '4px', fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase' }}>Range</span>
            {DATE_RANGES.map((r, i) => (
              <button key={r.label} onClick={() => setRangeIdx(i)} style={{
                padding: '4px 10px', borderRadius: '6px',
                border: rangeIdx === i ? '1px solid var(--accent-border)' : '1px solid var(--border)',
                background: rangeIdx === i ? 'var(--accent-light)' : 'transparent',
                color: rangeIdx === i ? 'var(--accent)' : 'var(--text-muted)',
                fontSize: '11px', fontWeight: 500, cursor: 'pointer',
                transition: 'all 0.12s ease', fontFamily: 'JetBrains Mono, monospace',
              }}>{r.label}</button>
            ))}
          </div>
          <MarketplaceFilter selected={markets} onChange={setMarkets} />
        </div>
      </div>

      {/* Summary tiles */}
      <div style={{
        display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '12px',
        marginBottom: '20px',
      }}>
        {[
          { label: 'Total Sessions', value: fmt(totalSessions), sub: `${range.label} window` },
          { label: 'Avg Conversion', value: overallConv.toFixed(2) + '%', sub: 'session-weighted' },
          { label: 'Avg Buy Box', value: overallBB !== null ? overallBB.toFixed(1) + '%' : '—', sub: `${bbProducts.length} SKUs` },
          { label: 'Needs Attention', value: needsAttentionCount.toString(), sub: 'flagged SKUs',
            color: needsAttentionCount > 0 ? 'var(--red)' : 'var(--green)' },
        ].map((tile, i) => (
          <div key={i} className="card" style={{ padding: '16px' }}>
            <div style={{ fontSize: '10px', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: '6px' }}>
              {tile.label}
            </div>
            <div style={{
              fontSize: '22px', fontWeight: 600,
              fontFamily: 'JetBrains Mono, monospace',
              color: (tile as any).color || 'var(--text-primary)',
              marginBottom: '2px',
            }}>
              {tile.value}
            </div>
            <div style={{ fontSize: '10px', color: 'var(--text-dim)' }}>{tile.sub}</div>
          </div>
        ))}
      </div>

      {/* Health filter chips */}
      <div style={{ display: 'flex', gap: '8px', marginBottom: '14px', alignItems: 'center' }}>
        <span style={{ fontSize: '10px', color: 'var(--text-dim)', fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase', marginRight: '4px' }}>
          Filter
        </span>
        {([
          { key: 'all', label: 'All' },
          { key: 'needs_attention', label: 'Needs attention' },
          { key: 'healthy', label: 'Healthy' },
        ] as const).map(f => (
          <button key={f.key} onClick={() => { setHealthFilter(f.key); setPage(0) }} style={{
            padding: '4px 12px', borderRadius: '6px', fontSize: '11px', fontWeight: 500,
            cursor: 'pointer', transition: 'all 0.12s ease',
            border: healthFilter === f.key ? '1px solid var(--accent-border)' : '1px solid var(--border)',
            background: healthFilter === f.key ? 'var(--accent-light)' : 'transparent',
            color: healthFilter === f.key ? 'var(--accent)' : 'var(--text-muted)',
          }}>{f.label}</button>
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
      ) : (
        <>
          <div className="card" style={{ overflow: 'hidden' }}>
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead>
                  <tr>
                    <th style={{ ...thBase, width: '36px', textAlign: 'center', color: 'var(--text-muted)' }}>#</th>
                    <th style={{ ...thBase, textAlign: 'left', color: 'var(--text-muted)' }}>Product</th>
                    <th style={{ ...thBase, width: '90px', textAlign: 'center', color: 'var(--text-muted)' }}>Health</th>
                    <th style={{ ...thSortable('sessions'), textAlign: 'right' }} onClick={() => handleSort('sessions')}>
                      <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: '4px' }}>Sessions <SortIcon col="sessions" /></span>
                    </th>
                    <th style={{ ...thSortable('page_views'), textAlign: 'right' }} onClick={() => handleSort('page_views')}>
                      <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: '4px' }}>Views <SortIcon col="page_views" /></span>
                    </th>
                    <th style={{ ...thSortable('views_per_session'), textAlign: 'right' }} onClick={() => handleSort('views_per_session')}>
                      <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: '4px' }}>V/S <SortIcon col="views_per_session" /></span>
                    </th>
                    <th style={{ ...thSortable('buy_box_pct'), textAlign: 'right' }} onClick={() => handleSort('buy_box_pct')}>
                      <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: '4px' }}>Buy Box <SortIcon col="buy_box_pct" /></span>
                    </th>
                    <th style={{ ...thSortable('conv_rate'), textAlign: 'right' }} onClick={() => handleSort('conv_rate')}>
                      <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: '4px' }}>Conv % <SortIcon col="conv_rate" /></span>
                    </th>
                    <th style={{ ...thSortable('units'), textAlign: 'right' }} onClick={() => handleSort('units')}>
                      <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: '4px' }}>Units <SortIcon col="units" /></span>
                    </th>
                    <th style={{ ...thSortable('conv_change'), textAlign: 'right' }} onClick={() => handleSort('conv_change')}>
                      <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: '4px' }}>Δ Conv <SortIcon col="conv_change" /></span>
                    </th>
                    <th style={{ ...thBase, width: '32px' }}></th>
                  </tr>
                </thead>
                <tbody>
                  {paginated.map((p, i) => {
                    const isExpanded = expandedSku === p.sku
                    const weeklyData = allWeeklyData[p.sku] || []
                    const meta = HEALTH_META[p.health]
                    const HealthIcon = meta.icon
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
                          <td style={{ padding: '11px 12px', textAlign: 'center' }}>
                            <span style={{
                              display: 'inline-flex', alignItems: 'center', gap: '4px',
                              padding: '3px 8px', borderRadius: '12px',
                              background: meta.bg, color: meta.color,
                              fontSize: '10px', fontWeight: 600,
                            }}>
                              <HealthIcon size={11} /> {meta.label}
                            </span>
                          </td>
                          <td style={{ padding: '11px 12px', textAlign: 'right', fontSize: '12px', fontWeight: 600, fontFamily: 'JetBrains Mono, monospace', color: 'var(--text-primary)' }}>{fmt(p.sessions)}</td>
                          <td style={{ padding: '11px 12px', textAlign: 'right', fontSize: '12px', fontFamily: 'JetBrains Mono, monospace', color: 'var(--text-primary)' }}>{fmt(p.page_views)}</td>
                          <td style={{ padding: '11px 12px', textAlign: 'right', fontSize: '12px', fontFamily: 'JetBrains Mono, monospace', color: 'var(--text-primary)' }}>{p.views_per_session.toFixed(2)}</td>
                          <td style={{ padding: '11px 12px', textAlign: 'right', fontSize: '12px', fontFamily: 'JetBrains Mono, monospace', color: p.buy_box_pct !== null && p.buy_box_pct < BUY_BOX_WARN ? 'var(--red)' : p.buy_box_pct !== null && p.buy_box_pct >= BUY_BOX_OK ? 'var(--green)' : 'var(--text-primary)' }}>{p.buy_box_pct !== null ? p.buy_box_pct.toFixed(1) + '%' : '—'}</td>
                          <td style={{ padding: '11px 12px', textAlign: 'right', fontSize: '12px', fontFamily: 'JetBrains Mono, monospace', color: p.conv_rate < LOW_CONV_THRESHOLD ? 'var(--red)' : p.conv_rate >= HEALTHY_CONV_THRESHOLD ? 'var(--green)' : 'var(--text-primary)' }}>{p.conv_rate.toFixed(1)}%</td>
                          <td style={{ padding: '11px 12px', textAlign: 'right', fontSize: '12px', fontFamily: 'JetBrains Mono, monospace', color: 'var(--text-primary)' }}>{fmt(p.units)}</td>
                          <td style={{ padding: '11px 12px', textAlign: 'right' }}>
                            {p.conv_change !== null ? (
                              <span style={{ fontSize: '11px', fontWeight: 600, color: p.conv_change > 0 ? 'var(--green)' : p.conv_change < 0 ? 'var(--red)' : 'var(--text-muted)', display: 'inline-flex', alignItems: 'center', gap: '2px', fontFamily: 'JetBrains Mono, monospace' }}>
                                {p.conv_change > 0 ? <TrendingUp size={10} /> : p.conv_change < 0 ? <TrendingDown size={10} /> : <Minus size={10} />}
                                {p.conv_change > 0 ? '+' : ''}{p.conv_change.toFixed(1)}pp
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
                                {/* Diagnostic line */}
                                <div style={{
                                  padding: '12px 14px', marginBottom: '16px',
                                  background: 'var(--bg-card)', border: `1px solid ${meta.color}`,
                                  borderRadius: '8px', fontSize: '12px',
                                  color: 'var(--text-primary)', display: 'flex', gap: '10px', alignItems: 'flex-start',
                                }}>
                                  <HealthIcon size={14} color={meta.color} style={{ marginTop: '1px', flexShrink: 0 }} />
                                  <span>{diagnosticMessage(p)}</span>
                                </div>

                                {/* Funnel stats */}
                                <div style={{ display: 'flex', gap: '28px', marginBottom: '20px', flexWrap: 'wrap' }}>
                                  {[
                                    { label: 'Sessions', value: fmt(p.sessions) },
                                    { label: 'Page Views', value: fmt(p.page_views) },
                                    { label: 'Views/Session', value: p.views_per_session.toFixed(2) },
                                    { label: 'Buy Box', value: p.buy_box_pct !== null ? p.buy_box_pct.toFixed(1) + '%' : '—' },
                                    { label: 'Conv Rate', value: p.conv_rate.toFixed(1) + '%' },
                                    { label: 'Units', value: fmt(p.units) },
                                    ...(p.conv_change !== null ? [{ label: 'Δ Conv', value: (p.conv_change > 0 ? '+' : '') + p.conv_change.toFixed(2) + 'pp', color: p.conv_change > 0 ? 'var(--green)' : 'var(--red)' }] : []),
                                  ].map((stat, idx) => (
                                    <div key={idx}>
                                      <div style={{ fontSize: '10px', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: '3px' }}>{stat.label}</div>
                                      <div style={{ fontSize: '17px', fontWeight: 600, fontFamily: 'JetBrains Mono, monospace', color: (stat as any).color || 'var(--text-primary)' }}>{stat.value}</div>
                                    </div>
                                  ))}
                                </div>

                                {/* Three sparklines side by side */}
                                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '16px' }}>
                                  {[
                                    { title: 'Sessions', dataKey: 'sessions' as const, color: 'var(--accent)' },
                                    { title: 'Conversion %', dataKey: 'conv_rate' as const, color: 'var(--green)' },
                                    { title: 'Buy Box %', dataKey: 'buy_box_pct' as const, color: '#d97706' },
                                  ].map(chart => (
                                    <div key={chart.dataKey} style={{ background: 'var(--bg-card)', borderRadius: '8px', padding: '12px', border: '1px solid var(--border)' }}>
                                      <div style={{ fontSize: '10px', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: '8px' }}>{chart.title}</div>
                                      <ResponsiveContainer width="100%" height={100}>
                                        <AreaChart data={allWeeklyData[p.sku] || []}>
                                          <defs>
                                            <linearGradient id={`grad-${chart.dataKey}-${sanitizeId(p.sku)}`} x1="0" y1="0" x2="0" y2="1">
                                              <stop offset="5%" stopColor={chart.color} stopOpacity={0.2} />
                                              <stop offset="95%" stopColor={chart.color} stopOpacity={0} />
                                            </linearGradient>
                                          </defs>
                                          <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
                                          <XAxis dataKey="start_date" tick={{ fontSize: 9, fill: 'var(--text-dim)' }} tickLine={false} axisLine={false} interval="preserveStartEnd" />
                                          <YAxis tick={{ fontSize: 9, fill: 'var(--text-dim)' }} tickLine={false} axisLine={false} width={40} />
                                          <Tooltip content={<CustomTooltip />} />
                                          <Area type="monotone" dataKey={chart.dataKey} name={chart.title} stroke={chart.color} strokeWidth={1.5} fill={`url(#grad-${chart.dataKey}-${sanitizeId(p.sku)})`} dot={false} />
                                        </AreaChart>
                                      </ResponsiveContainer>
                                    </div>
                                  ))}
                                </div>
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
                transition: 'all 0.12s ease',
              }}
              onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.borderColor = 'var(--accent)'; (e.currentTarget as HTMLButtonElement).style.color = 'var(--accent)' }}
              onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.borderColor = 'var(--border)'; (e.currentTarget as HTMLButtonElement).style.color = 'var(--text-muted)' }}
              >
                Load more — showing {paginated.length} of {filtered.length}
              </button>
            </div>
          )}
        </>
      )}
    </div>
  )
}
