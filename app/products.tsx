'use client'

import { useEffect, useState } from 'react'
import { supabase } from '@/lib/supabase'
import MarketplaceFilter from '@/components/MarketplaceFilter'
import {
  AreaChart, Area, XAxis, YAxis, CartesianGrid,
  Tooltip, ResponsiveContainer
} from 'recharts'
import {
  ChevronDown, ChevronRight, TrendingUp, TrendingDown,
  Minus, ArrowUpDown, ArrowUp, ArrowDown, Search
} from 'lucide-react'

const CAD_TO_USD = 0.74

const DATE_RANGES = [
  { label: '4W',  days: 28  },
  { label: '8W',  days: 56  },
  { label: '13W', days: 91  },
  { label: 'YTD', days: null, ytd: true },
  { label: 'ALL', days: null },
]

type ProductRow = {
  sku: string
  title: string
  revenue: number
  units: number
  sessions: number
  conv_rate: number
  wow_change: number | null
  prev_revenue: number
}

type WeeklyPoint = {
  start_date: string
  raw_date: string
  revenue: number
  units: number
}

type SortKey = 'revenue' | 'units' | 'sessions' | 'conv_rate' | 'wow_change'
type SortDir = 'asc' | 'desc'

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

export default function ProductPerformance() {
  const [markets, setMarkets] = useState(['US', 'CA'])
  const [rangeIdx, setRangeIdx] = useState(4)
  const [products, setProducts] = useState<ProductRow[]>([])
  const [allWeeklyData, setAllWeeklyData] = useState<Record<string, WeeklyPoint[]>>({})
  const [loading, setLoading] = useState(true)
  const [expandedSku, setExpandedSku] = useState<string | null>(null)
  const [sortKey, setSortKey] = useState<SortKey>('revenue')
  const [sortDir, setSortDir] = useState<SortDir>('desc')
  const [search, setSearch] = useState('')

  useEffect(() => {
    async function load() {
      setLoading(true)
      const range = DATE_RANGES[rangeIdx]
      const cutoff = getDateCutoff(range)

      let query = supabase
        .from('fct_sales_daily')
        .select('start_date, marketplace, units_ordered, ordered_product_sales_amount, sessions, unit_session_percentage, sku, title')
        .in('marketplace', markets)
        .order('start_date', { ascending: true })
        .limit(20000)

      if (cutoff) query = query.gte('start_date', cutoff)

      const { data, error } = await query
      if (error) { console.error(error); setLoading(false); return }

      // Previous period for WoW / period change
      let prevRows: any[] = []
      if (cutoff && range.days) {
        const prevEnd = new Date(cutoff)
        prevEnd.setDate(prevEnd.getDate() - 1)
        const prevStart = new Date(prevEnd)
        prevStart.setDate(prevStart.getDate() - range.days)
        const { data: pd } = await supabase
          .from('fct_sales_daily')
          .select('start_date, marketplace, units_ordered, ordered_product_sales_amount, sku')
          .in('marketplace', markets)
          .gte('start_date', prevStart.toISOString().split('T')[0])
          .lte('start_date', prevEnd.toISOString().split('T')[0])
          .limit(20000)
        prevRows = pd || []
      }

      // Aggregate by SKU
      const bySku: Record<string, {
        sku: string, title: string,
        revenue: number, units: number,
        sessions: number, conv_numerator: number, conv_denominator: number
      }> = {}

      // Weekly data per SKU for charts
      const weeklyBySku: Record<string, Record<string, WeeklyPoint>> = {}

      for (const row of data || []) {
        if (!row.sku) continue
        if (!bySku[row.sku]) {
          bySku[row.sku] = { sku: row.sku, title: row.title || row.sku, revenue: 0, units: 0, sessions: 0, conv_numerator: 0, conv_denominator: 0 }
        }
        const rev = toUSD(row.ordered_product_sales_amount || 0, row.marketplace)
        bySku[row.sku].revenue += rev
        bySku[row.sku].units += row.units_ordered || 0
        bySku[row.sku].sessions += row.sessions || 0
        if (row.sessions > 0) {
          bySku[row.sku].conv_numerator += row.units_ordered || 0
          bySku[row.sku].conv_denominator += row.sessions || 0
        }

        // Weekly chart data
        if (!weeklyBySku[row.sku]) weeklyBySku[row.sku] = {}
        const key = row.start_date
        if (!weeklyBySku[row.sku][key]) {
          weeklyBySku[row.sku][key] = {
            raw_date: key,
            start_date: new Date(key + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
            revenue: 0, units: 0,
          }
        }
        weeklyBySku[row.sku][key].revenue += Math.round(rev)
        weeklyBySku[row.sku][key].units += row.units_ordered || 0
      }

      // Previous period totals
      const prevBySku: Record<string, number> = {}
      for (const row of prevRows) {
        if (!row.sku) continue
        prevBySku[row.sku] = (prevBySku[row.sku] || 0) + toUSD(row.ordered_product_sales_amount || 0, row.marketplace)
      }

      const rows: ProductRow[] = Object.values(bySku).map(p => {
        const prev = prevBySku[p.sku] || 0
        const wow = prev > 0 ? ((p.revenue - prev) / prev) * 100 : null
        const conv = p.conv_denominator > 0 ? (p.conv_numerator / p.conv_denominator) * 100 : 0
        return {
          sku: p.sku,
          title: p.title,
          revenue: Math.round(p.revenue),
          units: p.units,
          sessions: p.sessions,
          conv_rate: conv,
          wow_change: wow,
          prev_revenue: Math.round(prev),
        }
      })

      // Sort weekly data
      const sortedWeekly: Record<string, WeeklyPoint[]> = {}
      for (const sku of Object.keys(weeklyBySku)) {
        sortedWeekly[sku] = Object.values(weeklyBySku[sku])
          .sort((a, b) => a.raw_date.localeCompare(b.raw_date))
      }

      setProducts(rows)
      setAllWeeklyData(sortedWeekly)
      setLoading(false)
    }
    load()
  }, [markets, rangeIdx])

  const handleSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortDir(d => d === 'asc' ? 'desc' : 'asc')
    } else {
      setSortKey(key)
      setSortDir('desc')
    }
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

  const SortIcon = ({ col }: { col: SortKey }) => {
    if (sortKey !== col) return <ArrowUpDown size={11} style={{ opacity: 0.3 }} />
    return sortDir === 'desc' ? <ArrowDown size={11} /> : <ArrowUp size={11} />
  }

  const thStyle = (col: SortKey): React.CSSProperties => ({
    padding: '10px 12px',
    fontSize: '10px', fontWeight: 600,
    color: sortKey === col ? 'var(--accent)' : 'var(--text-muted)',
    textTransform: 'uppercase', letterSpacing: '0.06em',
    cursor: 'pointer', userSelect: 'none',
    whiteSpace: 'nowrap',
    background: 'var(--bg-hover)',
    borderBottom: '1px solid var(--border)',
  })

  const rangeLabel = DATE_RANGES[rangeIdx].label

  return (
    <div>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '20px' }}>
        <div>
          <h1 style={{ fontSize: '20px', fontWeight: 600, letterSpacing: '-0.4px', marginBottom: '4px' }}>Product Performance</h1>
          <p style={{ fontSize: '13px', color: 'var(--text-muted)' }}>
            All revenue in USD · {filtered.length} SKUs
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
          onChange={e => setSearch(e.target.value)}
          style={{
            flex: 1, background: 'transparent', border: 'none', outline: 'none',
            color: 'var(--text-primary)', fontSize: '13px', fontFamily: 'Inter, sans-serif',
          }}
        />
        {search && (
          <button onClick={() => setSearch('')} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-dim)', display: 'flex' }}>
            ✕
          </button>
        )}
      </div>

      {/* Table */}
      {loading ? (
        <div style={{ color: 'var(--text-muted)', fontSize: '13px' }}>Loading...</div>
      ) : (
        <div className="card" style={{ overflow: 'hidden' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                <th style={{ ...thStyle('revenue'), width: '32px', textAlign: 'center' }}>#</th>
                <th style={{ padding: '10px 12px', fontSize: '10px', fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em', background: 'var(--bg-hover)', borderBottom: '1px solid var(--border)', textAlign: 'left' }}>
                  Product
                </th>
                <th style={{ ...thStyle('revenue'), textAlign: 'right' }} onClick={() => handleSort('revenue')}>
                  <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: '4px' }}>
                    Revenue <SortIcon col="revenue" />
                  </span>
                </th>
                <th style={{ ...thStyle('units'), textAlign: 'right' }} onClick={() => handleSort('units')}>
                  <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: '4px' }}>
                    Units <SortIcon col="units" />
                  </span>
                </th>
                <th style={{ ...thStyle('sessions'), textAlign: 'right' }} onClick={() => handleSort('sessions')}>
                  <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: '4px' }}>
                    Sessions <SortIcon col="sessions" />
                  </span>
                </th>
                <th style={{ ...thStyle('conv_rate'), textAlign: 'right' }} onClick={() => handleSort('conv_rate')}>
                  <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: '4px' }}>
                    Conv % <SortIcon col="conv_rate" />
                  </span>
                </th>
                <th style={{ ...thStyle('wow_change'), textAlign: 'right' }} onClick={() => handleSort('wow_change')}>
                  <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: '4px' }}>
                    vs Prior <SortIcon col="wow_change" />
                  </span>
                </th>
                <th style={{ ...thStyle('revenue'), width: '32px' }}></th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((p, i) => {
                const isExpanded = expandedSku === p.sku
                const weeklyData = allWeeklyData[p.sku] || []
                return (
                  <>
                    <tr
                      key={p.sku}
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
                      {/* Rank */}
                      <td style={{ padding: '12px', textAlign: 'center', fontSize: '11px', color: 'var(--text-dim)', fontFamily: 'JetBrains Mono, monospace' }}>
                        {i + 1}
                      </td>
                      {/* Product */}
                      <td style={{ padding: '12px' }}>
                        <div style={{ fontSize: '12px', fontWeight: 500, color: 'var(--text-primary)', marginBottom: '2px' }}>
                          {truncate(p.title, 50)}
                        </div>
                        <div style={{ fontSize: '10px', color: 'var(--text-dim)', fontFamily: 'JetBrains Mono, monospace' }}>
                          {p.sku}
                        </div>
                      </td>
                      {/* Revenue */}
                      <td style={{ padding: '12px', textAlign: 'right', fontSize: '12px', fontWeight: 600, fontFamily: 'JetBrains Mono, monospace', color: 'var(--text-primary)' }}>
                        {fmtCurrency(p.revenue)}
                      </td>
                      {/* Units */}
                      <td style={{ padding: '12px', textAlign: 'right', fontSize: '12px', fontFamily: 'JetBrains Mono, monospace', color: 'var(--text-primary)' }}>
                        {fmt(p.units)}
                      </td>
                      {/* Sessions */}
                      <td style={{ padding: '12px', textAlign: 'right', fontSize: '12px', fontFamily: 'JetBrains Mono, monospace', color: 'var(--text-primary)' }}>
                        {fmt(p.sessions)}
                      </td>
                      {/* Conv rate */}
                      <td style={{ padding: '12px', textAlign: 'right', fontSize: '12px', fontFamily: 'JetBrains Mono, monospace', color: 'var(--text-primary)' }}>
                        {p.conv_rate.toFixed(1)}%
                      </td>
                      {/* vs Prior */}
                      <td style={{ padding: '12px', textAlign: 'right' }}>
                        {p.wow_change !== null ? (
                          <span style={{
                            fontSize: '11px', fontWeight: 600,
                            color: p.wow_change > 0 ? 'var(--green)' : p.wow_change < 0 ? 'var(--red)' : 'var(--text-muted)',
                            display: 'inline-flex', alignItems: 'center', gap: '2px',
                            fontFamily: 'JetBrains Mono, monospace',
                          }}>
                            {p.wow_change > 0 ? <TrendingUp size={10} /> : p.wow_change < 0 ? <TrendingDown size={10} /> : <Minus size={10} />}
                            {p.wow_change > 0 ? '+' : ''}{p.wow_change.toFixed(1)}%
                          </span>
                        ) : (
                          <span style={{ fontSize: '11px', color: 'var(--text-dim)' }}>—</span>
                        )}
                      </td>
                      {/* Expand icon */}
                      <td style={{ padding: '12px', textAlign: 'center', color: 'var(--text-dim)' }}>
                        {isExpanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                      </td>
                    </tr>

                    {/* Expanded chart row */}
                    {isExpanded && (
                      <tr key={p.sku + '-expanded'} style={{ borderBottom: '1px solid var(--border)' }}>
                        <td colSpan={8} style={{ padding: '0 20px 20px 20px', background: 'var(--accent-light)' }}>
                          <div style={{ paddingTop: '16px' }}>
                            <div style={{ display: 'flex', gap: '32px', marginBottom: '16px' }}>
                              <div>
                                <div style={{ fontSize: '10px', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: '3px' }}>Revenue</div>
                                <div style={{ fontSize: '18px', fontWeight: 600, fontFamily: 'JetBrains Mono, monospace', color: 'var(--text-primary)' }}>{fmtCurrency(p.revenue)}</div>
                              </div>
                              <div>
                                <div style={{ fontSize: '10px', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: '3px' }}>Units</div>
                                <div style={{ fontSize: '18px', fontWeight: 600, fontFamily: 'JetBrains Mono, monospace', color: 'var(--text-primary)' }}>{fmt(p.units)}</div>
                              </div>
                              <div>
                                <div style={{ fontSize: '10px', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: '3px' }}>Sessions</div>
                                <div style={{ fontSize: '18px', fontWeight: 600, fontFamily: 'JetBrains Mono, monospace', color: 'var(--text-primary)' }}>{fmt(p.sessions)}</div>
                              </div>
                              <div>
                                <div style={{ fontSize: '10px', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: '3px' }}>Conv Rate</div>
                                <div style={{ fontSize: '18px', fontWeight: 600, fontFamily: 'JetBrains Mono, monospace', color: 'var(--text-primary)' }}>{p.conv_rate.toFixed(1)}%</div>
                              </div>
                              {p.wow_change !== null && (
                                <div>
                                  <div style={{ fontSize: '10px', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: '3px' }}>vs Prior Period</div>
                                  <div style={{ fontSize: '18px', fontWeight: 600, fontFamily: 'JetBrains Mono, monospace', color: p.wow_change > 0 ? 'var(--green)' : 'var(--red)' }}>
                                    {p.wow_change > 0 ? '+' : ''}{p.wow_change.toFixed(1)}%
                                  </div>
                                </div>
                              )}
                            </div>
                            <ResponsiveContainer width="100%" height={160}>
                              <AreaChart data={weeklyData}>
                                <defs>
                                  <linearGradient id={`grad-${p.sku}`} x1="0" y1="0" x2="0" y2="1">
                                    <stop offset="5%" stopColor="var(--accent)" stopOpacity={0.2} />
                                    <stop offset="95%" stopColor="var(--accent)" stopOpacity={0} />
                                  </linearGradient>
                                </defs>
                                <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
                                <XAxis dataKey="start_date" tick={{ fontSize: 9, fill: 'var(--text-dim)' }} tickLine={false} axisLine={false} interval="preserveStartEnd" />
                                <YAxis tick={{ fontSize: 9, fill: 'var(--text-dim)' }} tickLine={false} axisLine={false} tickFormatter={v => '$' + fmt(v)} width={55} />
                                <Tooltip content={<CustomTooltip />} />
                                <Area type="monotone" dataKey="revenue" name="Revenue" stroke="var(--accent)" strokeWidth={1.5} fill={`url(#grad-${p.sku})`} dot={false} />
                              </AreaChart>
                            </ResponsiveContainer>
                          </div>
                        </td>
                      </tr>
                    )}
                  </>
                )
              })}
            </tbody>
          </table>
          {filtered.length === 0 && (
            <div style={{ padding: '40px', textAlign: 'center', color: 'var(--text-dim)', fontSize: '13px' }}>
              No products found
            </div>
          )}
        </div>
      )}
    </div>
  )
}
