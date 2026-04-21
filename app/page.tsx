'use client'

import { useEffect, useState, useRef } from 'react'
import { supabase } from '@/lib/supabase'
import MarketplaceFilter from '@/components/MarketplaceFilter'
import {
  AreaChart, Area, XAxis, YAxis, CartesianGrid,
  Tooltip, ResponsiveContainer, BarChart, Bar
} from 'recharts'
import {
  TrendingUp, TrendingDown, DollarSign, ShoppingCart,
  Eye, Minus, MousePointer, BarChart2, Percent, Search, X
} from 'lucide-react'

const CAD_TO_USD = 0.74

const DATE_RANGES = [
  { label: '4W',  days: 28  },
  { label: '8W',  days: 56  },
  { label: '13W', days: 91  },
  { label: 'YTD', days: null, ytd: true },
  { label: 'ALL', days: null },
]

type WeeklyRow = {
  raw_date: string
  start_date: string
  total_revenue: number
  total_units: number
  total_sessions: number
  total_page_views: number
}

type ProductStat = {
  sku: string
  title: string
  revenue: number
  units: number
  prev_revenue: number
  change_pct: number | null
}

function fmt(n: number) {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + 'M'
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K'
  return n.toLocaleString()
}
function fmtCurrency(n: number) {
  return '$' + n.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 })
}
function fmtASP(n: number) { return '$' + n.toFixed(2) }
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

export default function SalesOverview() {
  const [markets, setMarkets] = useState(['US', 'CA'])
  const [rangeIdx, setRangeIdx] = useState(4)
  const [weeklyData, setWeeklyData] = useState<WeeklyRow[]>([])
  const [prevData, setPrevData] = useState<WeeklyRow[]>([])
  const [productStats, setProductStats] = useState<ProductStat[]>([])
  const [loading, setLoading] = useState(true)
  const [topSortBy, setTopSortBy] = useState<'revenue' | 'units'>('revenue')

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
    async function load() {
      setLoading(true)
      const range = DATE_RANGES[rangeIdx]
      const cutoff = getDateCutoff(range)

      let query = supabase
        .from('fct_sales_daily')
        .select('start_date, marketplace, units_ordered, ordered_product_sales_amount, sessions, page_views, sku, title')
        .in('marketplace', markets)
        .order('start_date', { ascending: true })
        .limit(100000)

      if (cutoff) query = query.gte('start_date', cutoff)
      if (selectedProducts.length > 0) query = query.in('sku', selectedProducts.map(p => p.sku))

      const { data, error } = await query
      if (error) { console.error(error); setLoading(false); return }

      // Previous period
      let prevRows: any[] = []
      if (cutoff && range.days) {
        const prevEnd = new Date(cutoff)
        prevEnd.setDate(prevEnd.getDate() - 1)
        const prevStart = new Date(prevEnd)
        prevStart.setDate(prevStart.getDate() - range.days)
        let prevQuery = supabase
          .from('fct_sales_daily')
          .select('start_date, marketplace, units_ordered, ordered_product_sales_amount, sessions, page_views, sku')
          .in('marketplace', markets)
          .gte('start_date', prevStart.toISOString().split('T')[0])
          .lte('start_date', prevEnd.toISOString().split('T')[0])
          .limit(100000)
        if (selectedProducts.length > 0) prevQuery = prevQuery.in('sku', selectedProducts.map(p => p.sku))
        const { data: pd } = await prevQuery
        prevRows = pd || []
      }

      const aggregate = (rows: any[]): WeeklyRow[] => {
        const byWeek: Record<string, WeeklyRow> = {}
        for (const row of rows) {
          const key = row.start_date
          if (!byWeek[key]) {
            byWeek[key] = {
              raw_date: key,
              start_date: new Date(key + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
              total_revenue: 0, total_units: 0, total_sessions: 0, total_page_views: 0,
            }
          }
          byWeek[key].total_revenue += toUSD(row.ordered_product_sales_amount || 0, row.marketplace)
          byWeek[key].total_units += row.units_ordered || 0
          byWeek[key].total_sessions += row.sessions || 0
          byWeek[key].total_page_views += row.page_views || 0
        }
        return Object.values(byWeek)
          .sort((a, b) => a.raw_date.localeCompare(b.raw_date))
          .map(w => ({ ...w, total_revenue: Math.round(w.total_revenue) }))
      }

      setWeeklyData(aggregate(data || []))
      setPrevData(aggregate(prevRows))

      // Build product stats for top sellers + gainers/losers
      const bySku: Record<string, { sku: string, title: string, revenue: number, units: number }> = {}
      for (const row of data || []) {
        if (!row.sku) continue
        if (!bySku[row.sku]) bySku[row.sku] = { sku: row.sku, title: row.title || row.sku, revenue: 0, units: 0 }
        bySku[row.sku].revenue += toUSD(row.ordered_product_sales_amount || 0, row.marketplace)
        bySku[row.sku].units += row.units_ordered || 0
      }

      const prevBySku: Record<string, number> = {}
      for (const row of prevRows) {
        if (!row.sku) continue
        prevBySku[row.sku] = (prevBySku[row.sku] || 0) + toUSD(row.ordered_product_sales_amount || 0, row.marketplace)
      }

      const stats: ProductStat[] = Object.values(bySku).map(p => {
        const prev = prevBySku[p.sku] || 0
        const change_pct = prev > 0 ? ((p.revenue - prev) / prev) * 100 : null
        return { ...p, revenue: Math.round(p.revenue), prev_revenue: Math.round(prev), change_pct }
      })

      setProductStats(stats)
      setLoading(false)
    }
    load()
  }, [markets, rangeIdx, selectedProducts])

  const sum = (key: keyof WeeklyRow) => weeklyData.reduce((s, r) => s + (r[key] as number), 0)
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
  const rangeLabel = DATE_RANGES[rangeIdx].label

  // Top sellers
  const topSellers = [...productStats]
    .sort((a, b) => topSortBy === 'revenue' ? b.revenue - a.revenue : b.units - a.units)
    .slice(0, 10)

  // Gainers and losers — only include products with prior period data
  const withChange = productStats.filter(p => p.change_pct !== null)
  const topGainers = [...withChange].sort((a, b) => (b.change_pct || 0) - (a.change_pct || 0)).slice(0, 10)
  const topLosers = [...withChange]
  .filter(p => p.revenue > 0).sort((a, b) => (a.change_pct || 0) - (b.change_pct || 0)).slice(0, 10)

  const hasPriorPeriod = prevData.length > 0

  const cards = [
    { label: `Revenue (${rangeLabel})`, value: fmtCurrency(totalRevenue), sub: prevRevenue > 0 ? `${fmtCurrency(prevRevenue)} prior period` : 'No prior period', trend: trend(totalRevenue, prevRevenue), icon: <DollarSign size={14} />, color: 'var(--accent)' },
    { label: `Units Ordered (${rangeLabel})`, value: fmt(totalUnits), sub: prevUnits > 0 ? `${fmt(prevUnits)} prior period` : 'No prior period', trend: trend(totalUnits, prevUnits), icon: <ShoppingCart size={14} />, color: 'var(--green)' },
    { label: `Sessions (${rangeLabel})`, value: fmt(totalSessions), sub: prevSessions > 0 ? `${fmt(prevSessions)} prior period` : 'No prior period', trend: trend(totalSessions, prevSessions), icon: <Eye size={14} />, color: 'var(--yellow)' },
    { label: `Avg Selling Price (${rangeLabel})`, value: fmtASP(asp), sub: prevAsp > 0 ? `${fmtASP(prevAsp)} prior period` : 'No prior period', trend: trend(asp, prevAsp), icon: <BarChart2 size={14} />, color: '#6366F1' },
    { label: `Conversion Rate (${rangeLabel})`, value: convRate.toFixed(2) + '%', sub: prevConvRate > 0 ? `${prevConvRate.toFixed(2)}% prior period` : 'No prior period', trend: trend(convRate, prevConvRate), icon: <Percent size={14} />, color: '#EC4899' },
    { label: `Page Views (${rangeLabel})`, value: fmt(totalPageViews), sub: 'total page views', trend: null, icon: <MousePointer size={14} />, color: '#10B981' },
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
              {(() => {
                const cutoff = getDateCutoff(DATE_RANGES[rangeIdx])
                const end = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
                if (!cutoff) return `Jan 5, 2025 — ${end}`
                const start = new Date(cutoff + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
                return `${start} — ${end}`
              })()}
            </span>
          </p>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
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

          {/* Revenue Chart */}
          <div className="card" style={{ padding: '24px', marginBottom: '14px' }}>
            <div style={{ marginBottom: '18px' }}>
              <div style={{ fontSize: '13px', fontWeight: 500, marginBottom: '2px' }}>
                Weekly Revenue
                {selectedProducts.length > 0 && (
                  <span style={{ fontSize: '11px', color: 'var(--accent)', marginLeft: '8px' }}>
                    {selectedProducts.length} product{selectedProducts.length > 1 ? 's' : ''} selected
                  </span>
                )}
              </div>
              <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
                USD · {DATE_RANGES[rangeIdx].label === 'ALL' ? 'Jan 2025 — present' : `Last ${DATE_RANGES[rangeIdx].label}`}
              </div>
            </div>
            <ResponsiveContainer width="100%" height={220}>
              <AreaChart data={weeklyData}>
                <defs>
                  <linearGradient id="revGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="var(--chart-primary)" stopOpacity={1} />
                    <stop offset="95%" stopColor="var(--chart-primary)" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
                <XAxis dataKey="start_date" tick={{ fontSize: 10, fill: 'var(--text-dim)' }} tickLine={false} axisLine={false} interval="preserveStartEnd" />
                <YAxis tick={{ fontSize: 10, fill: 'var(--text-dim)' }} tickLine={false} axisLine={false} tickFormatter={v => '$' + fmt(v)} width={60} />
                <Tooltip content={<CustomTooltip />} />
                <Area type="monotone" dataKey="total_revenue" name="Revenue" stroke="var(--chart-primary)" strokeWidth={1.5} fill="url(#revGrad)" dot={false} />
              </AreaChart>
            </ResponsiveContainer>
          </div>

          {/* Units Chart */}
          <div className="card" style={{ padding: '24px', marginBottom: '20px' }}>
            <div style={{ marginBottom: '18px' }}>
              <div style={{ fontSize: '13px', fontWeight: 500, marginBottom: '2px' }}>Weekly Units Ordered</div>
              <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>All selected marketplaces combined</div>
            </div>
            <ResponsiveContainer width="100%" height={180}>
              <BarChart data={weeklyData} barSize={8}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
                <XAxis dataKey="start_date" tick={{ fontSize: 10, fill: 'var(--text-dim)' }} tickLine={false} axisLine={false} interval="preserveStartEnd" />
                <YAxis tick={{ fontSize: 10, fill: 'var(--text-dim)' }} tickLine={false} axisLine={false} tickFormatter={v => fmt(v)} width={50} />
                <Tooltip content={<CustomTooltip />} />
                <Bar dataKey="total_units" name="Units" fill="var(--chart-success)" radius={[2, 2, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>

          {/* Bottom row — Top Sellers + Gainers/Losers */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '14px' }}>

            {/* Top Sellers */}
            <div className="card" style={{ padding: '20px' }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '16px' }}>
                <div style={{ fontSize: '13px', fontWeight: 500 }}>Top Sellers</div>
                <div style={{ display: 'flex', gap: '4px' }}>
                  {(['revenue', 'units'] as const).map(s => (
                    <button key={s} onClick={() => setTopSortBy(s)} style={{
                      padding: '3px 8px', borderRadius: '5px', fontSize: '10px', fontWeight: 500,
                      cursor: 'pointer', transition: 'all 0.12s ease',
                      border: topSortBy === s ? '1px solid var(--accent-border)' : '1px solid var(--border)',
                      background: topSortBy === s ? 'var(--accent-light)' : 'transparent',
                      color: topSortBy === s ? 'var(--accent)' : 'var(--text-muted)',
                      textTransform: 'capitalize',
                    }}>{s}</button>
                  ))}
                </div>
              </div>
              <div>
                {topSellers.map((p, i) => (
                  <div key={p.sku} style={{
                    display: 'flex', alignItems: 'center', gap: '10px',
                    padding: '8px 0',
                    borderBottom: i < topSellers.length - 1 ? '1px solid var(--border)' : 'none',
                  }}>
                    <span style={{ fontSize: '11px', color: 'var(--text-dim)', fontFamily: 'JetBrains Mono, monospace', width: '16px', flexShrink: 0 }}>
                      {i + 1}
                    </span>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: '12px', color: 'var(--text-primary)', fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {truncate(p.title, 40)}
                      </div>
                      <div style={{ fontSize: '10px', color: 'var(--text-dim)', fontFamily: 'JetBrains Mono, monospace', marginTop: '1px' }}>
                        {p.sku}
                      </div>
                    </div>
                    <div style={{ textAlign: 'right', flexShrink: 0 }}>
                      <div style={{ fontSize: '12px', fontWeight: 600, color: 'var(--text-primary)', fontFamily: 'JetBrains Mono, monospace' }}>
                        {topSortBy === 'revenue' ? fmtCurrency(p.revenue) : fmt(p.units) + ' units'}
                      </div>
                      {topSortBy === 'revenue' && (
                        <div style={{ fontSize: '10px', color: 'var(--text-dim)', marginTop: '1px' }}>
                          {fmt(p.units)} units
                        </div>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* Gainers / Losers */}
            <div className="card" style={{ padding: '20px' }}>
              <div style={{ marginBottom: '16px' }}>
                <div style={{ fontSize: '13px', fontWeight: 500, marginBottom: '2px' }}>
                  Top Gainers & Losers
                </div>
                <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
                  {hasPriorPeriod ? `Revenue change vs prior ${rangeLabel} period` : 'Select a date range with a prior period to see changes'}
                </div>
              </div>

              {!hasPriorPeriod ? (
                <div style={{ color: 'var(--text-dim)', fontSize: '12px', paddingTop: '8px' }}>
                  Switch to 7D, 30D, or 90D to compare against the prior period.
                </div>
              ) : (
                <div style={{ display: 'grid', gridTemplateColumns: '1fr', gap: '0' }}>
                  {/* Gainers */}
                  <div>
                    <div style={{ fontSize: '10px', fontWeight: 600, color: 'var(--green)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: '8px' }}>
                      ↑ Gainers
                    </div>
                    {topGainers.filter(p => (p.change_pct || 0) > 0).slice(0, 4).map((p, i, arr) => (
                      <div key={p.sku} style={{
                        padding: '7px 0',
                        borderBottom: i < arr.length - 1 ? '1px solid var(--border)' : 'none',
                      }}>
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px' }}>
                          <div style={{ fontSize: '11px', color: 'var(--text-primary)', fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>
                            {truncate(p.sku, 16)}
                          </div>
                          <span style={{
                            fontSize: '11px', fontWeight: 600, color: 'var(--green)',
                            background: 'var(--green-light)', borderRadius: '4px',
                            padding: '1px 6px', flexShrink: 0, fontFamily: 'JetBrains Mono, monospace',
                          }}>
                            +{p.change_pct!.toFixed(1)}%
                          </span>
                        </div>
                        <div style={{ fontSize: '10px', color: 'var(--text-dim)', marginTop: '2px', fontFamily: 'JetBrains Mono, monospace' }}>
                          {fmtCurrency(p.revenue)}
                        </div>
                      </div>
                    ))}
                  </div>

                  {/* Losers */}
                  <div style={{ marginTop: '16px', paddingTop: '16px', borderTop: '1px solid var(--border)' }}>
                    <div style={{ fontSize: '10px', fontWeight: 600, color: 'var(--red)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: '8px' }}>
                      ↓ Losers
                    </div>
                    {topLosers.filter(p => (p.change_pct || 0) < 0).slice(0, 4).map((p, i, arr) => (
                      <div key={p.sku} style={{
                        padding: '7px 0',
                        borderBottom: i < arr.length - 1 ? '1px solid var(--border)' : 'none',
                      }}>
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px' }}>
                          <div style={{ fontSize: '11px', color: 'var(--text-primary)', fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>
                            {truncate(p.sku, 16)}
                          </div>
                          <span style={{
                            fontSize: '11px', fontWeight: 600, color: 'var(--red)',
                            background: 'var(--red-light)', borderRadius: '4px',
                            padding: '1px 6px', flexShrink: 0, fontFamily: 'JetBrains Mono, monospace',
                          }}>
                            {p.change_pct!.toFixed(1)}%
                          </span>
                        </div>
                        <div style={{ fontSize: '10px', color: 'var(--text-dim)', marginTop: '2px', fontFamily: 'JetBrains Mono, monospace' }}>
                          {fmtCurrency(p.revenue)}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  )
}
