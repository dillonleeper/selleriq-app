'use client'

import { useEffect, useState, useRef } from 'react'
import { supabase } from '@/lib/supabase'
import MarketplaceFilter from '@/components/MarketplaceFilter'
import DateRangeFilter, { DateRange, DatePreset } from '@/components/DateRangeFilter'
import {
  Area, XAxis, YAxis, CartesianGrid,
  Tooltip, ResponsiveContainer,
  ComposedChart, AreaChart, Line
} from 'recharts'
import {
  TrendingUp, TrendingDown, DollarSign, ShoppingCart,
  Eye, Minus, MousePointer, BarChart2, Percent, Search, X
} from 'lucide-react'

const CAD_TO_USD = 0.74

const PRESET_LABELS: Record<DatePreset, string> = {
  today: 'Today', yesterday: 'Yesterday', wtd: 'WTD', mtd: 'MTD', ytd: 'YTD', custom: 'Custom',
}

type WeeklyRow = {
  raw_date: string
  start_date: string
  total_revenue: number
  total_units: number
  total_sessions: number
  total_page_views: number
}

// Chart-only bucketing (independent of the date-preset granularity logic below).
type ChartBucket = 'day' | 'week' | 'month'
type ChartPoint = {
  raw_date: string
  label: string
  total_revenue: number
  total_units: number
  total_sessions: number
  total_page_views: number
  conv_rate: number
}

function fmt(n: number) {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + 'M'
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K'
  return n.toLocaleString()
}
// Exact integer with comma separators — for unit counts (e.g. 11,807).
function fmtUnits(n: number) {
  return Math.round(n).toLocaleString('en-US')
}
function fmtCurrency(n: number) {
  return '$' + n.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 })
}
function fmtASP(n: number) { return '$' + n.toFixed(2) }
function toUSD(amount: number, marketplace: string) {
  return marketplace === 'CA' ? amount * CAD_TO_USD : amount
}
function fmtDateLabel(iso: string) {
  return new Date(iso + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}
// Short axis label, e.g. "Jun 1" / "Jan 8".
function shortLabel(iso: string) {
  return new Date(iso + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}
// Month axis label, e.g. "Jun 2025".
function monthLabel(iso: string) {
  return new Date(iso + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', year: 'numeric' })
}
// Sunday-start week key (YYYY-MM-DD) for the week containing dateStr.
function weekStartKey(dateStr: string): string {
  const d = new Date(dateStr + 'T12:00:00')
  d.setDate(d.getDate() - d.getDay()) // getDay: Sun=0
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}
// First-of-month key (YYYY-MM-01) for the month containing dateStr.
function monthStartKey(dateStr: string): string {
  return dateStr.slice(0, 7) + '-01'
}

// Re-bucket the per-day series into daily / weekly / monthly points for the charts.
// Totals are bucket-independent, so summary cards are unaffected by this control.
function bucketSeries(rows: WeeklyRow[], bucket: ChartBucket): ChartPoint[] {
  const keyFn =
    bucket === 'week' ? weekStartKey :
    bucket === 'month' ? monthStartKey :
    (d: string) => d
  const buckets: Record<string, ChartPoint> = {}
  for (const r of rows) {
    const key = keyFn(r.raw_date)
    if (!buckets[key]) {
      buckets[key] = {
        raw_date: key, label: '',
        total_revenue: 0, total_units: 0, total_sessions: 0, total_page_views: 0, conv_rate: 0,
      }
    }
    const b = buckets[key]
    b.total_revenue += r.total_revenue
    b.total_units += r.total_units
    b.total_sessions += r.total_sessions
    b.total_page_views += r.total_page_views
  }
  return Object.values(buckets)
    .sort((a, b) => a.raw_date.localeCompare(b.raw_date))
    .map(b => ({
      ...b,
      label: bucket === 'month' ? monthLabel(b.raw_date) : shortLabel(b.raw_date),
      conv_rate: b.total_sessions > 0 ? (b.total_units / b.total_sessions) * 100 : 0,
    }))
}

type Granularity = 'day' | 'week'

// Chart bucketing per the selected preset. Short ranges → daily points;
// long ranges (YTD, custom > 31 days) → weekly buckets.
function granularityFor(dr: DateRange): Granularity {
  if (dr.preset === 'ytd') return 'week'
  if (dr.preset === 'custom') {
    // Long custom windows (> 31 days) get weekly buckets; shorter ones stay daily.
    const start = new Date(dr.startDate + 'T12:00:00')
    const end = new Date(dr.endDate + 'T12:00:00')
    const days = Math.round((end.getTime() - start.getTime()) / 86400000) + 1
    return days > 31 ? 'week' : 'day'
  }
  return 'day' // today / yesterday / wtd / mtd → daily
}

const CustomTooltip = ({ active, payload, label }: any) => {
  if (!active || !payload?.length) return null
  return (
    <div style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border)', borderRadius: '8px', padding: '10px 14px', fontSize: '12px', boxShadow: 'var(--shadow-md)' }}>
      <div style={{ color: 'var(--text-muted)', marginBottom: '6px' }}>{label}</div>
      {payload.map((p: any, i: number) => (
        <div key={i} style={{ color: p.color, marginBottom: '2px' }}>
          {p.name}: <span style={{ color: 'var(--text-primary)', fontWeight: 500 }}>
            {p.name === 'Revenue' ? fmtCurrency(p.value)
              : p.name === 'Conversion Rate' ? p.value.toFixed(2) + '%'
              : fmt(p.value)}
          </span>
        </div>
      ))}
    </div>
  )
}

export default function SalesOverview() {
  const [markets, setMarkets] = useState(['US', 'CA'])
  const [dateRange, setDateRange] = useState<DateRange | null>(null)
  const [dailySeries, setDailySeries] = useState<WeeklyRow[]>([])
  const [prevData, setPrevData] = useState<WeeklyRow[]>([])
  const [chartBucket, setChartBucket] = useState<ChartBucket>('week')
  const [loading, setLoading] = useState(true)

  // Search state
  const [searchQuery, setSearchQuery] = useState('')
  const [searchResults, setSearchResults] = useState<any[]>([])
  const [selectedProducts, setSelectedProducts] = useState<any[]>([])
  const [showDropdown, setShowDropdown] = useState(false)
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

  const handleKeyDown = async (e: React.KeyboardEvent<HTMLInputElement>) => {
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

  // Main data fetch
  useEffect(() => {
    if (!dateRange || !dateRange.startDate) return
    async function load() {
      const { startDate, endDate, priorStart, priorEnd } = dateRange!
      setLoading(true)

      let query = supabase
        .from('fct_sales_daily')
        .select('start_date, marketplace, units_ordered, ordered_product_sales_amount, sessions, page_views, sku, title')
        .in('marketplace', markets)
        .gte('start_date', startDate)
        .lte('start_date', endDate)
        .order('start_date', { ascending: true })
        .limit(100000)

      if (selectedProducts.length > 0) query = query.in('sku', selectedProducts.map(p => p.sku))

      const { data, error } = await query
      if (error) { console.error(error); setLoading(false); return }

      // Prior period
      let prevQuery = supabase
        .from('fct_sales_daily')
        .select('start_date, marketplace, units_ordered, ordered_product_sales_amount, sessions, page_views, sku')
        .in('marketplace', markets)
        .gte('start_date', priorStart)
        .lte('start_date', priorEnd)
        .limit(100000)
      if (selectedProducts.length > 0) prevQuery = prevQuery.in('sku', selectedProducts.map(p => p.sku))
      const { data: pd } = await prevQuery
      const prevRows: any[] = pd || []

      // Aggregate to a per-day, marketplace-combined series. The chart-bucket
      // control re-buckets this client-side; summary totals sum it directly.
      const aggregate = (rows: any[], clipStart?: string): WeeklyRow[] => {
        const buckets: Record<string, WeeklyRow> = {}
        for (const row of rows) {
          const key = row.start_date
          if (!buckets[key]) {
            buckets[key] = {
              raw_date: key,
              start_date: shortLabel(key),
              total_revenue: 0, total_units: 0, total_sessions: 0, total_page_views: 0,
            }
          }
          buckets[key].total_revenue += toUSD(row.ordered_product_sales_amount || 0, row.marketplace)
          buckets[key].total_units += row.units_ordered || 0
          buckets[key].total_sessions += row.sessions || 0
          buckets[key].total_page_views += row.page_views || 0
        }
        return Object.values(buckets)
          .sort((a, b) => a.raw_date.localeCompare(b.raw_date))
          .filter(w => !clipStart || w.raw_date >= clipStart)
          .map(w => ({ ...w, total_revenue: Math.round(w.total_revenue) }))
      }

      setDailySeries(aggregate(data || [], startDate))
      setPrevData(aggregate(prevRows, priorStart))
      setLoading(false)
    }
    load()
  }, [markets, dateRange, selectedProducts])

  const sum = (key: keyof WeeklyRow) => dailySeries.reduce((s, r) => s + (r[key] as number), 0)
  const prevSum = (key: keyof WeeklyRow) => prevData.reduce((s, r) => s + (r[key] as number), 0)

  const totalRevenue   = sum('total_revenue')
  const totalUnits     = sum('total_units')
  const totalSessions  = sum('total_sessions')
  const totalPageViews = sum('total_page_views')
  const prevRevenue    = prevSum('total_revenue')
  const prevUnits      = prevSum('total_units')
  const prevSessions   = prevSum('total_sessions')

  const asp          = totalUnits > 0 ? totalRevenue / totalUnits : 0
  const prevAsp      = prevUnits > 0 ? prevRevenue / prevUnits : 0
  const convRate     = totalSessions > 0 ? (totalUnits / totalSessions) * 100 : 0
  const prevConvRate = prevSessions > 0 ? (prevUnits / prevSessions) * 100 : 0
  const trend = (curr: number, prev: number) => prev > 0 ? ((curr - prev) / prev) * 100 : null
  const rangeLabel = dateRange ? PRESET_LABELS[dateRange.preset] : ''

  // Chart series for the selected bucketing (shared by all three charts).
  const chartData = bucketSeries(dailySeries, chartBucket)
  const bucketAdj = chartBucket === 'day' ? 'Daily' : chartBucket === 'week' ? 'Weekly' : 'Monthly'

  // Total Sales Breakdown — LIVE rows carry real values; PLACEHOLDER rows
  // (value: null) are pending the Orders/Finance pipelines. Wiring a real
  // value in later is just swapping null → a number.
  type BreakdownRow = { label: string; value: number | null; live?: boolean; strong?: boolean }
  const salesBreakdown: BreakdownRow[] = [
    { label: 'Gross sales', value: totalRevenue, live: true },
    { label: 'Discounts', value: null },
    { label: 'Returns', value: null },
    { label: 'Net sales', value: null, strong: true },
    { label: 'Shipping charges', value: null },
    { label: 'Return fees', value: null },
    { label: 'Taxes', value: null },
    { label: 'Total sales', value: null, strong: true },
    { label: 'Payout', value: null },
    { label: 'COGS', value: null },
    { label: 'Bottom-line profit', value: null, strong: true },
  ]

  // Preset-aware empty-state label for the prior-period comparison line.
  const noPriorLabel =
    dateRange?.preset === 'ytd' ? 'No prior year data'
    : 'No prior period'

  const cards = [
    { label: `Revenue (${rangeLabel})`, value: fmtCurrency(totalRevenue), sub: prevRevenue > 0 ? `${fmtCurrency(prevRevenue)} prior period` : noPriorLabel, trend: trend(totalRevenue, prevRevenue), icon: <DollarSign size={14} />, color: 'var(--accent)' },
    { label: `Units Ordered (${rangeLabel})`, value: fmtUnits(totalUnits), sub: prevUnits > 0 ? `${fmtUnits(prevUnits)} prior period` : noPriorLabel, trend: trend(totalUnits, prevUnits), icon: <ShoppingCart size={14} />, color: 'var(--green)' },
    { label: `Sessions (${rangeLabel})`, value: fmtUnits(totalSessions), sub: prevSessions > 0 ? `${fmtUnits(prevSessions)} prior period` : noPriorLabel, trend: trend(totalSessions, prevSessions), icon: <Eye size={14} />, color: 'var(--yellow)' },
    { label: `Avg Selling Price (${rangeLabel})`, value: fmtASP(asp), sub: prevAsp > 0 ? `${fmtASP(prevAsp)} prior period` : noPriorLabel, trend: trend(asp, prevAsp), icon: <BarChart2 size={14} />, color: '#6366F1' },
    { label: `Conversion Rate (${rangeLabel})`, value: convRate.toFixed(2) + '%', sub: prevConvRate > 0 ? `${prevConvRate.toFixed(2)}% prior period` : noPriorLabel, trend: trend(convRate, prevConvRate), icon: <Percent size={14} />, color: '#EC4899' },
    { label: `Page Views (${rangeLabel})`, value: fmtUnits(totalPageViews), sub: 'total page views', trend: null, icon: <MousePointer size={14} />, color: '#10B981' },
  ]

  const truncate = (s: string, n: number) => s && s.length > n ? s.slice(0, n) + '…' : s

  return (
    <div>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '20px' }}>
        <div>
          <h1 style={{ fontSize: '20px', fontWeight: 600, letterSpacing: '-0.4px', marginBottom: '4px' }}>Sales Overview</h1>
          <p style={{ fontSize: '13px', color: 'var(--text-muted)' }}>
            All revenue in USD
            {' · '}
            <span style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: '12px' }}>
              {dateRange && dateRange.startDate
                ? `${fmtDateLabel(dateRange.startDate)} — ${fmtDateLabel(dateRange.endDate)}`
                : 'Select a date range'}
            </span>
          </p>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '16px', flexWrap: 'wrap' }}>
          <DateRangeFilter onChange={setDateRange} defaultPreset="ytd" />
          <MarketplaceFilter selected={markets} onChange={setMarkets} />
        </div>
      </div>

      {/* Search Bar */}
      <div ref={searchRef} style={{ position: 'relative', marginBottom: '20px' }}>
        <div style={{
          display: 'flex', alignItems: 'center', gap: '10px',
          background: 'var(--bg-card)', border: '1px solid var(--border)',
          borderRadius: '10px', padding: '10px 14px', boxShadow: 'var(--shadow-sm)',
        }}>
          <Search size={14} color="var(--text-muted)" />
          <input
            type="text"
            placeholder="Search by SKU, ASIN, or product name — press Enter to add all results"
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
            onFocus={() => searchQuery.length >= 2 && setShowDropdown(true)}
            onKeyDown={handleKeyDown}
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
          {/* 6 Summary Cards */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '12px', marginBottom: '20px' }}>
            {cards.map((card, i) => (
              <div key={i} className={`card fade-up fade-up-delay-${Math.min(i + 1, 5)}`} style={{ padding: '18px' }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '10px' }}>
                  <span style={{ fontSize: '10px', color: 'var(--text-muted)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                    {card.label}
                  </span>
                  <div style={{ color: card.color, opacity: 0.6 }}>{card.icon}</div>
                </div>
                <div style={{ fontSize: '22px', fontWeight: 600, letterSpacing: '-0.4px', marginBottom: '8px', fontFamily: 'JetBrains Mono, monospace' }}>
                  {card.value}
                </div>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                  <span style={{ fontSize: '11px', color: 'var(--text-dim)' }}>{card.sub}</span>
                  {card.trend !== null && (
                    <span style={{
                      fontSize: '11px', fontWeight: 500,
                      color: card.trend > 0 ? 'var(--green)' : card.trend < 0 ? 'var(--red)' : 'var(--text-muted)',
                      display: 'flex', alignItems: 'center', gap: '2px',
                    }}>
                      {card.trend > 0 ? <TrendingUp size={11} /> : card.trend < 0 ? <TrendingDown size={11} /> : <Minus size={11} />}
                      {Math.abs(card.trend).toFixed(1)}%
                    </span>
                  )}
                </div>
              </div>
            ))}
          </div>

          {/* Revenue + Units (dual-axis) with bucketing toggle */}
          <div className="card" style={{ padding: '24px', marginBottom: '14px' }}>
            <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '12px', marginBottom: '18px' }}>
              <div>
                <div style={{ fontSize: '13px', fontWeight: 500, marginBottom: '2px', display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap' }}>
                  <span>{bucketAdj} Revenue &amp; Units</span>
                  <span style={{ display: 'flex', alignItems: 'center', gap: '5px', fontSize: '11px', color: 'var(--text-muted)', fontWeight: 400 }}>
                    <span style={{ width: '8px', height: '8px', borderRadius: '2px', background: 'var(--chart-primary)' }} /> Revenue
                  </span>
                  <span style={{ display: 'flex', alignItems: 'center', gap: '5px', fontSize: '11px', color: 'var(--text-muted)', fontWeight: 400 }}>
                    <span style={{ width: '8px', height: '8px', borderRadius: '2px', background: 'var(--chart-success)' }} /> Units
                  </span>
                  {selectedProducts.length > 0 && (
                    <span style={{ fontSize: '11px', color: 'var(--accent)' }}>
                      {selectedProducts.length} product{selectedProducts.length > 1 ? 's' : ''} selected
                    </span>
                  )}
                </div>
                <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
                  USD · {dateRange && dateRange.startDate ? `${fmtDateLabel(dateRange.startDate)} — ${fmtDateLabel(dateRange.endDate)}` : rangeLabel}
                </div>
              </div>
              {/* Chart-only bucketing control */}
              <div style={{ display: 'flex', gap: '4px', flexShrink: 0 }}>
                {(['day', 'week', 'month'] as const).map(b => (
                  <button key={b} onClick={() => setChartBucket(b)} style={{
                    padding: '3px 10px', borderRadius: '5px', fontSize: '10px', fontWeight: 500,
                    cursor: 'pointer', transition: 'all 0.12s ease',
                    border: chartBucket === b ? '1px solid var(--accent-border)' : '1px solid var(--border)',
                    background: chartBucket === b ? 'var(--accent-light)' : 'transparent',
                    color: chartBucket === b ? 'var(--accent)' : 'var(--text-muted)',
                  }}>{b === 'day' ? 'Daily' : b === 'week' ? 'Weekly' : 'Monthly'}</button>
                ))}
              </div>
            </div>
            <ResponsiveContainer width="100%" height={240}>
              <ComposedChart data={chartData}>
                <defs>
                  <linearGradient id="revGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="var(--chart-primary)" stopOpacity={1} />
                    <stop offset="95%" stopColor="var(--chart-primary)" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
                <XAxis dataKey="label" tick={{ fontSize: 10, fill: 'var(--text-dim)' }} tickLine={false} axisLine={false} interval="preserveStartEnd" />
                <YAxis yAxisId="rev" tick={{ fontSize: 10, fill: 'var(--text-dim)' }} tickLine={false} axisLine={false} tickFormatter={v => '$' + fmt(v)} width={60} />
                <YAxis yAxisId="units" orientation="right" tick={{ fontSize: 10, fill: 'var(--text-dim)' }} tickLine={false} axisLine={false} tickFormatter={v => fmt(v)} width={50} />
                <Tooltip content={<CustomTooltip />} />
                <Area yAxisId="rev" type="monotone" dataKey="total_revenue" name="Revenue" stroke="var(--chart-primary)" strokeWidth={1.5} fill="url(#revGrad)" dot={false} />
                <Line yAxisId="units" type="monotone" dataKey="total_units" name="Units" stroke="var(--chart-success)" strokeWidth={1.5} dot={false} />
              </ComposedChart>
            </ResponsiveContainer>
          </div>

          {/* Sessions + Conversion rate over time */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '14px', marginBottom: '20px' }}>
            <div className="card" style={{ padding: '24px' }}>
              <div style={{ marginBottom: '18px' }}>
                <div style={{ fontSize: '13px', fontWeight: 500, marginBottom: '2px' }}>Sessions over time</div>
                <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>{bucketAdj} · all selected marketplaces combined</div>
              </div>
              <ResponsiveContainer width="100%" height={200}>
                <AreaChart data={chartData}>
                  <defs>
                    <linearGradient id="sessGrad" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="var(--yellow)" stopOpacity={0.9} />
                      <stop offset="95%" stopColor="var(--yellow)" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
                  <XAxis dataKey="label" tick={{ fontSize: 10, fill: 'var(--text-dim)' }} tickLine={false} axisLine={false} interval="preserveStartEnd" />
                  <YAxis tick={{ fontSize: 10, fill: 'var(--text-dim)' }} tickLine={false} axisLine={false} tickFormatter={v => fmt(v)} width={50} />
                  <Tooltip content={<CustomTooltip />} />
                  <Area type="monotone" dataKey="total_sessions" name="Sessions" stroke="var(--yellow)" strokeWidth={1.5} fill="url(#sessGrad)" dot={false} />
                </AreaChart>
              </ResponsiveContainer>
            </div>

            <div className="card" style={{ padding: '24px' }}>
              <div style={{ marginBottom: '18px' }}>
                <div style={{ fontSize: '13px', fontWeight: 500, marginBottom: '2px' }}>Conversion rate over time</div>
                <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>{bucketAdj} · units ÷ sessions</div>
              </div>
              <ResponsiveContainer width="100%" height={200}>
                <AreaChart data={chartData}>
                  <defs>
                    <linearGradient id="convGrad" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="#EC4899" stopOpacity={0.9} />
                      <stop offset="95%" stopColor="#EC4899" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
                  <XAxis dataKey="label" tick={{ fontSize: 10, fill: 'var(--text-dim)' }} tickLine={false} axisLine={false} interval="preserveStartEnd" />
                  <YAxis tick={{ fontSize: 10, fill: 'var(--text-dim)' }} tickLine={false} axisLine={false} tickFormatter={v => v.toFixed(1) + '%'} width={50} />
                  <Tooltip content={<CustomTooltip />} />
                  <Area type="monotone" dataKey="conv_rate" name="Conversion Rate" stroke="#EC4899" strokeWidth={1.5} fill="url(#convGrad)" dot={false} />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          </div>

          {/* Total Sales Breakdown */}
          <div className="card" style={{ padding: '24px' }}>
            <div style={{ marginBottom: '16px' }}>
              <div style={{ fontSize: '13px', fontWeight: 500, marginBottom: '2px' }}>Total Sales Breakdown</div>
              <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
                Gross sales is live · remaining rows pending the Orders &amp; Finance pipelines
              </div>
            </div>

            <div>
              {salesBreakdown.map((row, i) => {
                const isPlaceholder = row.value === null
                return (
                  <div key={row.label} style={{
                    display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px',
                    padding: '9px 0',
                    borderBottom: i < salesBreakdown.length - 1 ? '1px solid var(--border)' : 'none',
                    opacity: isPlaceholder ? 0.55 : 1,
                  }}>
                    <span style={{
                      fontSize: '12px', display: 'flex', alignItems: 'center', gap: '8px',
                      fontWeight: row.strong ? 600 : 400,
                      color: row.strong ? 'var(--text-primary)' : 'var(--text-muted)',
                    }}>
                      {row.label}
                      {row.live && (
                        <span style={{
                          fontSize: '9px', fontWeight: 600, letterSpacing: '0.04em',
                          color: 'var(--green)', background: 'var(--green-light)',
                          borderRadius: '4px', padding: '1px 6px', textTransform: 'uppercase',
                        }}>Live</span>
                      )}
                    </span>
                    {isPlaceholder ? (
                      <span style={{ fontSize: '11px', color: 'var(--text-dim)', fontStyle: 'italic' }}>
                        Not yet tracked
                      </span>
                    ) : (
                      <span style={{
                        fontSize: '13px', fontWeight: row.strong ? 700 : 600,
                        color: 'var(--text-primary)', fontFamily: 'JetBrains Mono, monospace',
                      }}>
                        {fmtCurrency(row.value as number)}
                      </span>
                    )}
                  </div>
                )
              })}
            </div>

            <div style={{ marginTop: '14px', fontSize: '11px', color: 'var(--text-dim)', lineHeight: 1.5 }}>
              Finance &amp; COGS figures (discounts, returns, fees, taxes, payout, COGS and derived
              net/total/profit lines) are not yet tracked. They will populate once the Orders and
              Finance pipelines land.
            </div>
          </div>
        </>
      )}
    </div>
  )
}
