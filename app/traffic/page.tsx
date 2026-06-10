'use client'

import React, { useEffect, useState, useRef } from 'react'
import { supabase } from '@/lib/supabase'
import MarketplaceFilter from '@/components/MarketplaceFilter'
import DateRangeFilter, { DateRange, DatePreset } from '@/components/DateRangeFilter'
import {
  AreaChart, Area, XAxis, YAxis, CartesianGrid,
  Tooltip, ResponsiveContainer, LineChart, Line,
} from 'recharts'
import {
  ChevronDown, ChevronRight, TrendingUp, TrendingDown, Minus,
  ArrowUpDown, ArrowUp, ArrowDown, Search, Download, X,
  AlertTriangle, AlertCircle, CheckCircle2,
} from 'lucide-react'

// ─────────────────────────────────────────────────────────────
// Constants & helpers
// ─────────────────────────────────────────────────────────────

const PRESET_LABELS: Record<DatePreset, string> = {
  today: 'Today', yesterday: 'Yesterday', wtd: 'WTD', mtd: 'MTD', ytd: 'YTD', custom: 'Custom',
}

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
// Exact integer with comma separators — for unit counts (e.g. 11,807).
function fmtUnits(n: number) {
  return Math.round(n).toLocaleString('en-US')
}
function fmtDateLabel(iso: string) {
  return new Date(iso + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
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
      return `Traffic is healthy (${fmtUnits(p.sessions)} sessions) but conversion is only ${p.conv_rate.toFixed(1)}%. Listing content, images, reviews, or price are likely culprits.`
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
  const [dateRange, setDateRange] = useState<DateRange | null>(null)
  const [products, setProducts] = useState<ProductRow[]>([])
  const [allWeeklyData, setAllWeeklyData] = useState<Record<string, WeeklyPoint[]>>({})
  const [loading, setLoading] = useState(true)
  const [expandedSku, setExpandedSku] = useState<string | null>(null)
  const [sortKey, setSortKey] = useState<SortKey>('sessions')
  const [sortDir, setSortDir] = useState<SortDir>('desc')
  const [healthFilter, setHealthFilter] = useState<'all' | 'needs_attention' | 'healthy'>('all')
  const [page, setPage] = useState(0)
  const PAGE_SIZE = 50

  // Search state — checkbox multi-select (same pattern as Sales Overview)
  const [searchQuery, setSearchQuery]       = useState('')
  const [searchResults, setSearchResults]   = useState<any[]>([])
  const [selectedProducts, setSelectedProducts] = useState<any[]>([])
  const [showDropdown, setShowDropdown]     = useState(false)
  const searchRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (searchRef.current && !searchRef.current.contains(e.target as Node)) {
        setShowDropdown(false)
      }
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [])

  useEffect(() => {
    if (searchQuery.length < 2) { setSearchResults([]); setShowDropdown(false); return }
    const timer = setTimeout(async () => {
      const q = searchQuery.toLowerCase()
      const { data } = await supabase
        .from('dim_product').select('sku, asin, title')
        .or(`sku.ilike.%${q}%,asin.ilike.%${q}%,title.ilike.%${q}%`).limit(20)
      if (data) {
        const seen = new Set<string>()
        setSearchResults(data.filter(p => { if (!p.sku || seen.has(p.sku)) return false; seen.add(p.sku); return true }))
        setShowDropdown(true)
      }
    }, 200)
    return () => clearTimeout(timer)
  }, [searchQuery])

  const allChecked = searchResults.length > 0 && searchResults.every(p => selectedProducts.find(s => s.sku === p.sku))
  const someChecked = searchResults.some(p => selectedProducts.find(s => s.sku === p.sku))

  const toggleProduct = (p: any) => {
    if (selectedProducts.find(s => s.sku === p.sku)) {
      setSelectedProducts(prev => prev.filter(s => s.sku !== p.sku))
    } else {
      setSelectedProducts(prev => [...prev, p])
    }
  }

  const toggleAll = () => {
    if (allChecked) {
      const resultSkus = new Set(searchResults.map((p: any) => p.sku))
      setSelectedProducts(prev => prev.filter(p => !resultSkus.has(p.sku)))
    } else {
      const toAdd = searchResults.filter(p => !selectedProducts.find(s => s.sku === p.sku))
      setSelectedProducts(prev => [...prev, ...toAdd])
    }
  }

  const handleSearchKeyDown = async (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && searchQuery.length >= 2) {
      const q = searchQuery.toLowerCase()
      const { data } = await supabase
        .from('dim_product').select('sku, asin, title')
        .or(`sku.ilike.%${q}%,asin.ilike.%${q}%,title.ilike.%${q}%`).limit(500)
      if (data) {
        const seen = new Set<string>()
        const unique = data.filter(p => { if (!p.sku || seen.has(p.sku)) return false; seen.add(p.sku); return true })
        const toAdd = unique.filter(p => !selectedProducts.find(s => s.sku === p.sku))
        setSelectedProducts(prev => [...prev, ...toAdd])
      }
      setSearchQuery(''); setShowDropdown(false)
    }
    if (e.key === 'Escape') setShowDropdown(false)
  }

  const removeProduct = (sku: string) => setSelectedProducts(prev => prev.filter(p => p.sku !== sku))
  const clearAll = () => setSelectedProducts([])

  useEffect(() => {
    if (!dateRange || !dateRange.startDate) return
    async function load() {
      const { startDate, endDate, priorStart, priorEnd } = dateRange!
      setLoading(true)
      setExpandedSku(null)
      setPage(0)

      // Server-side per-SKU aggregation — one row per SKU, so this never
      // truncates at a daily-grain row cap the way the old raw fetch did.
      const { data, error } = await supabase.rpc('get_sku_sales', {
        p_start: startDate,
        p_end: endDate,
        p_prior_start: priorStart,
        p_prior_end: priorEnd,
        p_markets: markets,
        p_skus: null,
      })
      if (error) { console.error(error); setLoading(false); return }

      const rows: ProductRow[] = []
      const sortedWeekly: Record<string, WeeklyPoint[]> = {}

      for (const r of (data || []) as any[]) {
        const sessions = Number(r.sessions) || 0
        const pageViews = Number(r.page_views) || 0
        const units = Number(r.units) || 0
        const conv = Number(r.conv_rate) || 0
        const bb = r.buy_box_pct != null ? Number(r.buy_box_pct) : null
        const vps = sessions > 0 ? pageViews / sessions : 0
        const prevSessions = Number(r.prev_sessions) || 0
        const prevUnits = Number(r.prev_units) || 0
        const prevConv = prevSessions > 0 ? (prevUnits / prevSessions) * 100 : null
        const convChange = prevConv !== null ? conv - prevConv : null

        rows.push({
          sku: r.sku, title: r.title || r.sku,
          sessions, page_views: pageViews,
          views_per_session: vps,
          conv_rate: conv, buy_box_pct: bb,
          units,
          prev_conv_rate: prevConv,
          conv_change: convChange,
          health: classifyHealth(sessions, conv, bb),
        })

        // series arrives sorted by day ascending from the RPC
        sortedWeekly[r.sku] = ((r.series as any[]) || []).map(pt => ({
          raw_date: pt.d,
          start_date: new Date(pt.d + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
          sessions: Number(pt.sessions) || 0,
          conv_rate: Number(pt.conv_rate) || 0,
          buy_box_pct: pt.buy_box_pct != null ? Number(pt.buy_box_pct) : 0,
        }))
      }

      setProducts(rows)
      setAllWeeklyData(sortedWeekly)
      setLoading(false)
    }
    load()
  }, [markets, dateRange])

  const handleSort = (key: SortKey) => {
    if (sortKey === key) setSortDir(d => d === 'asc' ? 'desc' : 'asc')
    else { setSortKey(key); setSortDir('desc') }
    setPage(0)
  }

  const filtered = products
    .filter(p => {
      if (selectedProducts.length > 0 && !selectedProducts.some(s => s.sku === p.sku)) return false
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
    a.download = `selleriq-traffic-${dateRange ? dateRange.preset : 'range'}.csv`
    a.click()
    URL.revokeObjectURL(url)
  }

  const rangeLabel = dateRange ? PRESET_LABELS[dateRange.preset] : ''
  const startDate = dateRange && dateRange.startDate ? fmtDateLabel(dateRange.startDate) : '—'
  const endDate = dateRange && dateRange.endDate ? fmtDateLabel(dateRange.endDate) : '—'

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
          <DateRangeFilter onChange={setDateRange} />
          <MarketplaceFilter selected={markets} onChange={setMarkets} />
        </div>
      </div>

      {/* Summary tiles */}
      <div style={{
        display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '12px',
        marginBottom: '20px',
      }}>
        {[
          { label: 'Total Sessions', value: fmtUnits(totalSessions), sub: `${rangeLabel} window` },
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
      <div ref={searchRef} style={{ position: 'relative', marginBottom: '16px' }}>
        <div style={{
          display: 'flex', alignItems: 'center', gap: '10px',
          background: 'var(--bg-card)', border: '1px solid var(--border)',
          borderRadius: '10px', padding: '10px 14px',
          boxShadow: 'var(--shadow-sm)',
        }}>
          <Search size={14} color="var(--text-muted)" />
          <input
            type="text"
            placeholder="Search by SKU, ASIN, or product name — press Enter to add all results"
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
            onFocus={() => searchQuery.length >= 2 && setShowDropdown(true)}
            onKeyDown={handleSearchKeyDown}
            style={{
              flex: 1, background: 'transparent', border: 'none', outline: 'none',
              color: 'var(--text-primary)', fontSize: '13px', fontFamily: 'Inter, sans-serif',
            }}
          />
          {selectedProducts.length > 0 && (
            <button onClick={clearAll} style={{
              background: 'transparent', border: 'none', cursor: 'pointer',
              color: 'var(--text-dim)', fontSize: '11px', display: 'flex', alignItems: 'center', gap: '4px', whiteSpace: 'nowrap',
            }}>
              <X size={11} /> Clear all
            </button>
          )}
        </div>

        {/* Dropdown */}
        {showDropdown && searchResults.length > 0 && (
          <div style={{
            position: 'absolute', top: 'calc(100% + 6px)', left: 0, right: 0,
            background: 'var(--bg-elevated)', border: '1px solid var(--border)',
            borderRadius: '10px', zIndex: 200, overflow: 'hidden',
            boxShadow: 'var(--shadow-md)',
          }}>
            <div onClick={toggleAll} style={{
              padding: '9px 14px', borderBottom: '1px solid var(--border)',
              cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '10px',
              background: 'var(--bg-hover)',
            }}
            onMouseEnter={e => (e.currentTarget as HTMLDivElement).style.background = 'var(--border)'}
            onMouseLeave={e => (e.currentTarget as HTMLDivElement).style.background = 'var(--bg-hover)'}
            >
              <div style={{
                width: '14px', height: '14px', borderRadius: '4px', flexShrink: 0,
                border: `1px solid ${allChecked || someChecked ? 'var(--accent)' : 'var(--border)'}`,
                background: allChecked ? 'var(--accent)' : someChecked ? 'var(--accent-light)' : 'transparent',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
              }}>
                {(allChecked || someChecked) && (
                  <div style={{ width: '6px', height: '2px', background: allChecked ? 'white' : 'var(--accent)', borderRadius: '1px' }} />
                )}
              </div>
              <span style={{ fontSize: '11px', color: 'var(--text-muted)', fontWeight: 500 }}>
                {allChecked ? 'Deselect all' : `Select all ${searchResults.length} results`}
              </span>
            </div>
            {searchResults.map((p: any, i: number) => {
              const isSelected = !!selectedProducts.find(s => s.sku === p.sku)
              return (
                <div key={i} onClick={() => toggleProduct(p)} style={{
                  padding: '10px 14px',
                  borderBottom: i < searchResults.length - 1 ? '1px solid var(--border)' : 'none',
                  cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '10px',
                  background: isSelected ? 'var(--accent-light)' : 'transparent',
                  transition: 'background 0.1s ease',
                }}
                onMouseEnter={e => { if (!isSelected) (e.currentTarget as HTMLDivElement).style.background = 'var(--bg-hover)' }}
                onMouseLeave={e => { (e.currentTarget as HTMLDivElement).style.background = isSelected ? 'var(--accent-light)' : 'transparent' }}
                >
                  <div style={{
                    width: '14px', height: '14px', borderRadius: '4px', flexShrink: 0,
                    border: `1px solid ${isSelected ? 'var(--accent)' : 'var(--border)'}`,
                    background: isSelected ? 'var(--accent)' : 'transparent',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    transition: 'all 0.12s ease',
                  }}>
                    {isSelected && (
                      <svg width="8" height="6" viewBox="0 0 8 6" fill="none">
                        <path d="M1 3L3 5L7 1" stroke="white" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                      </svg>
                    )}
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: '12px', color: 'var(--text-primary)', marginBottom: '2px', fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {p.title ? truncate(p.title, 60) : p.sku}
                    </div>
                    <div style={{ fontSize: '11px', color: 'var(--text-dim)', fontFamily: 'JetBrains Mono, monospace' }}>
                      {p.sku} · {p.asin}
                    </div>
                  </div>
                </div>
              )
            })}
          </div>
        )}

        {/* Selected tags */}
        {selectedProducts.length > 0 && (
          <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', marginTop: '10px', alignItems: 'center' }}>
            {selectedProducts.length <= 3 ? (
              selectedProducts.map(p => (
                <div key={p.sku} style={{
                  display: 'flex', alignItems: 'center', gap: '6px',
                  background: 'var(--accent-light)', border: '1px solid var(--accent-border)',
                  borderRadius: '6px', padding: '4px 10px', fontSize: '11px', color: 'var(--accent)',
                }}>
                  <span style={{ fontFamily: 'JetBrains Mono, monospace' }}>{p.sku}</span>
                  <button onClick={() => removeProduct(p.sku)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--accent)', display: 'flex', padding: 0 }}>
                    <X size={10} />
                  </button>
                </div>
              ))
            ) : (
              <div style={{
                display: 'flex', alignItems: 'center', gap: '8px',
                background: 'var(--accent-light)', border: '1px solid var(--accent-border)',
                borderRadius: '6px', padding: '5px 12px', fontSize: '12px', color: 'var(--accent)',
              }}>
                <span style={{ fontWeight: 500 }}>{selectedProducts.length} products selected</span>
                <button onClick={clearAll} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', fontSize: '11px', display: 'flex', alignItems: 'center', gap: '3px', padding: 0 }}>
                  <X size={10} /> Clear all
                </button>
              </div>
            )}
          </div>
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
                          <td style={{ padding: '11px 12px', textAlign: 'right', fontSize: '12px', fontWeight: 600, fontFamily: 'JetBrains Mono, monospace', color: 'var(--text-primary)' }}>{fmtUnits(p.sessions)}</td>
                          <td style={{ padding: '11px 12px', textAlign: 'right', fontSize: '12px', fontFamily: 'JetBrains Mono, monospace', color: 'var(--text-primary)' }}>{fmtUnits(p.page_views)}</td>
                          <td style={{ padding: '11px 12px', textAlign: 'right', fontSize: '12px', fontFamily: 'JetBrains Mono, monospace', color: 'var(--text-primary)' }}>{p.views_per_session.toFixed(2)}</td>
                          <td style={{ padding: '11px 12px', textAlign: 'right', fontSize: '12px', fontFamily: 'JetBrains Mono, monospace', color: p.buy_box_pct !== null && p.buy_box_pct < BUY_BOX_WARN ? 'var(--red)' : p.buy_box_pct !== null && p.buy_box_pct >= BUY_BOX_OK ? 'var(--green)' : 'var(--text-primary)' }}>{p.buy_box_pct !== null ? p.buy_box_pct.toFixed(1) + '%' : '—'}</td>
                          <td style={{ padding: '11px 12px', textAlign: 'right', fontSize: '12px', fontFamily: 'JetBrains Mono, monospace', color: p.conv_rate < LOW_CONV_THRESHOLD ? 'var(--red)' : p.conv_rate >= HEALTHY_CONV_THRESHOLD ? 'var(--green)' : 'var(--text-primary)' }}>{p.conv_rate.toFixed(1)}%</td>
                          <td style={{ padding: '11px 12px', textAlign: 'right', fontSize: '12px', fontFamily: 'JetBrains Mono, monospace', color: 'var(--text-primary)' }}>{fmtUnits(p.units)}</td>
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
                                    { label: 'Sessions', value: fmtUnits(p.sessions) },
                                    { label: 'Page Views', value: fmtUnits(p.page_views) },
                                    { label: 'Views/Session', value: p.views_per_session.toFixed(2) },
                                    { label: 'Buy Box', value: p.buy_box_pct !== null ? p.buy_box_pct.toFixed(1) + '%' : '—' },
                                    { label: 'Conv Rate', value: p.conv_rate.toFixed(1) + '%' },
                                    { label: 'Units', value: fmtUnits(p.units) },
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
