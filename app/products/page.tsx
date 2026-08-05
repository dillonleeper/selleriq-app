'use client'

import React, { useEffect, useState, useCallback, useRef } from 'react'
import { supabase } from '@/lib/supabase'
import { searchProducts } from '@/lib/productSearch'
import MarketplaceFilter from '@/components/MarketplaceFilter'
import DateRangeFilter, { DateRange, PRESET_LABELS } from '@/components/DateRangeFilter'
import {
  AreaChart, Area, XAxis, YAxis, CartesianGrid,
  Tooltip, ResponsiveContainer, LineChart, Line
} from 'recharts'
import {
  ChevronDown, ChevronRight, TrendingUp, TrendingDown,
  Minus, ArrowUpDown, ArrowUp, ArrowDown, Search, Download, X
} from 'lucide-react'

type CadenceGrouping = 'day' | 'week' | 'month'

// â”€â”€â”€ Types â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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

// â”€â”€â”€ Helpers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function fmt(n: number) {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + 'M'
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K'
  return n.toLocaleString()
}
// Exact integer with comma separators â€” for unit counts (e.g. 11,807).
function fmtUnits(n: number) {
  return Math.round(n).toLocaleString('en-US')
}
function fmtCurrency(n: number) {
  return '$' + n.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 })
}
function truncate(s: string, n: number) {
  return s && s.length > n ? s.slice(0, n) + 'â€¦' : s
}
function sanitizeId(s: string) {
  return s.replace(/[^a-zA-Z0-9]/g, '_')
}
function toISODate(d: Date) {
  return d.toISOString().split('T')[0]
}

// Sunday-start week key helper â†’ "YYYY-MM-DD" (week start date)
function toWeekKey(dateStr: string): string {
  const d = new Date(dateStr + 'T12:00:00')
  d.setDate(d.getDate() - d.getDay())
  return toISODate(d)
}

// Week key (YYYY-MM-DD) â†’ display label e.g. "Apr 12"
function weekKeyToLabel(weekKey: string): string {
  const weekStart = new Date(weekKey + 'T12:00:00')
  return weekStart.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

// Month key â†’ "Jan 25"
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

// â”€â”€â”€ Custom Tooltip â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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

// â”€â”€â”€ Sparkline â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function Sparkline({ data, positive }: { data: DataPoint[], positive: boolean | null }) {
  if (!data || data.length < 2) return <span style={{ color: 'var(--text-dim)', fontSize: '10px' }}>â€”</span>
  const color = positive === null ? 'var(--text-dim)' : positive ? 'var(--chart-success)' : 'var(--red)'
  return (
    <LineChart width={80} height={32} data={data}>
      <Line type="monotone" dataKey="revenue" stroke={color} strokeWidth={1.5} dot={false} />
    </LineChart>
  )
}

// â”€â”€â”€ Main Component â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
export default function ProductPerformance() {
  const [markets, setMarkets]           = useState(['US', 'CA'])
  const [dateRange, setDateRange]       = useState<DateRange | null>(null)
  const [products, setProducts]         = useState<ProductRow[]>([])
  const [allPeriodData, setAllPeriodData] = useState<Record<string, DataPoint[]>>({})
  const [loading, setLoading]           = useState(true)
  const [expandedSku, setExpandedSku]   = useState<string | null>(null)
  const [sortKey, setSortKey]           = useState<SortKey>('revenue')
  const [sortDir, setSortDir]           = useState<SortDir>('desc')
  const [page, setPage]                 = useState(0)

  // Search state â€” checkbox multi-select (same pattern as Sales Overview)
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
    let cancelled = false
    const timer = setTimeout(async () => {
      try {
        const data = await searchProducts(searchQuery)
        if (!cancelled) { setSearchResults(data); setShowDropdown(true) }
      } catch (error) { if (!cancelled) console.error(error) }
    }, 200)
    return () => { cancelled = true; clearTimeout(timer) }
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
      try {
        const data = await searchProducts(searchQuery, 500)
        const toAdd = data.filter(p => !selectedProducts.find(s => s.sku === p.sku))
        setSelectedProducts(prev => [...prev, ...toAdd])
      } catch (error) { console.error(error) }
      setSearchQuery(''); setShowDropdown(false)
    }
    if (e.key === 'Escape') setShowDropdown(false)
  }

  const removeProduct = (sku: string) => setSelectedProducts(prev => prev.filter(p => p.sku !== sku))
  const clearAll = () => setSelectedProducts([])
  const [tab, setTab]                   = useState<TabType>('summary')
  const [cadenceMetric, setCadenceMetric] = useState<CadenceMetric>('units')
  const [cadenceGrouping, setCadenceGrouping] = useState<CadenceGrouping>('week')

  const PAGE_SIZE = 50

  // â”€â”€â”€ Data loading â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  useEffect(() => {
    if (!dateRange || !dateRange.startDate) return
    let cancelled = false
    async function load() {
      const { startDate, endDate, priorStart, priorEnd } = dateRange!
      setLoading(true)
      setExpandedSku(null)
      setPage(0)

      // Server-side per-SKU aggregation â€” one row per SKU (revenue already in
      // USD), so this never truncates at a daily-grain row cap. The `series`
      // field carries day-level buckets, which getBucketedData re-buckets.
      const { data, error } = await supabase.rpc('get_sku_sales_summary', {
        p_start: startDate,
        p_end: endDate,
        p_prior_start: priorStart,
        p_prior_end: priorEnd,
        p_markets: markets,
        p_skus: selectedProducts.length ? selectedProducts.map(product => product.sku) : null,
      })
      if (cancelled) return
      if (error) { console.error(error); setLoading(false); return }

      const rows: ProductRow[] = []

      for (const r of (data || []) as any[]) {
        const revenue = Number(r.revenue) || 0
        const units = Number(r.units) || 0
        const sessions = Number(r.sessions) || 0
        const conv = Number(r.conv_rate) || 0
        const bb = r.buy_box_pct != null ? Number(r.buy_box_pct) : null
        const prev = Number(r.prev_revenue) || 0
        const wow = prev > 0 ? ((revenue - prev) / prev) * 100 : null
        const asp = units > 0 ? revenue / units : 0

        rows.push({
          sku: r.sku, title: r.title || r.sku,
          revenue: Math.round(revenue), units, sessions,
          conv_rate: conv, asp, buy_box_pct: bb,
          wow_change: wow, prev_revenue: Math.round(prev),
        })

      }

      setProducts(rows)
      setAllPeriodData({})
      setLoading(false)
    }
    load()
    return () => { cancelled = true }
  }, [markets, dateRange, selectedProducts])

  useEffect(() => {
    if (!expandedSku || !dateRange) return
    let cancelled = false
    supabase.rpc('get_sku_sales_series', {
      p_start: dateRange.startDate,
      p_end: dateRange.endDate,
      p_markets: markets,
      p_sku: expandedSku,
    }).then(({ data, error }) => {
      if (cancelled) return
      if (error) { console.error(error); return }
      const points: DataPoint[] = ((data || []) as any[]).map(point => ({
        period_key: point.d,
        label: new Date(point.d + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
        revenue: Math.round(Number(point.revenue) || 0),
        units: Number(point.units) || 0,
      }))
      setAllPeriodData(previous => ({ ...previous, [expandedSku]: points }))
    })
    return () => { cancelled = true }
  }, [expandedSku, dateRange, markets])

  // â”€â”€â”€ Re-bucket daily data into chosen grouping â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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

  // â”€â”€â”€ Sort / filter â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  const handleSort = (key: SortKey) => {
    if (sortKey === key) setSortDir(d => d === 'asc' ? 'desc' : 'asc')
    else { setSortKey(key); setSortDir('desc') }
    setPage(0)
  }

  const filtered = products
    .filter(p => {
      if (selectedProducts.length === 0) return true
      return selectedProducts.some(s => s.sku === p.sku)
    })
    .sort((a, b) => {
      const av = a[sortKey] ?? -Infinity
      const bv = b[sortKey] ?? -Infinity
      return sortDir === 'desc' ? (bv as number) - (av as number) : (av as number) - (bv as number)
    })

  const paginated = filtered.slice(0, (page + 1) * PAGE_SIZE)
  const hasMore   = filtered.length > paginated.length

  // â”€â”€â”€ Cadence table â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // All unique period keys across all SKUs â€” sorted chronologically.
  const allPeriods = Array.from(
    new Set(Object.keys(allPeriodData).flatMap(sku => getBucketedData(sku).map(d => d.period_key)))
  )
    .sort()

  const cadenceRows = filtered
    .map(p => {
      const bucketed = getBucketedData(p.sku)
      const byPeriod: Record<string, DataPoint> = {}
      for (const d of bucketed) byPeriod[d.period_key] = d
      const total = cadenceMetric === 'units' ? p.units : p.revenue
      return { sku: p.sku, title: p.title, byPeriod, total }
    })
    .sort((a, b) => b.total - a.total)

  // â”€â”€â”€ Display date range label â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  const fmtDateLabel = (iso: string) =>
    new Date(iso + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
  const hasRange = !!(dateRange && dateRange.startDate)
  const activeLabel = hasRange
    ? `${fmtDateLabel(dateRange!.startDate)} â€” ${fmtDateLabel(dateRange!.endDate)}`
    : 'Select a date range'

  // â”€â”€â”€ CSV exports â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”çÞx¶‰žËkºwµç@€€€€€€€€€€€€€€€€€€€€€€€€€ð½Ñø4(€€€€€€€€€€€€€€€€€€€€€€€€€€ñÑÍÑå±”õíìÁ…‘‘¥¹œè€œÑÁà€áÁàœ°Ñ•áÑ±¥¸è€•¹Ñ•Èœõôø4(€€€€€€€€€€€€€€€€€€€€€€€€€€€€ñMÁ…É­±¥¹”‘…Ñ„õíÍÁ…É­…Ñ…ôÁ½Í¥Ñ¥Ù”õíÑÉ•¹‘ô€¼ø4(€€€€€€€€€€€€€€€€€€€€€€€€€€ð½Ñø4(€€€€€€€€€€€€€€€€€€€€€€€€€€ñÑÍÑå±”õíìÁ…‘‘¥¹œè€œÄÅÁà€ÄÉÁàœ°Ñ•áÑ±¥¸è€É¥¡Ðœ°™½¹ÑM¥é”è€œÄÉÁàœ°™½¹Ñ]•¥¡Ðè€ØÀÀ°™½¹Ñ…µ¥±äè€)•Ñ	É…¥¹Ì5½¹¼°µ½¹½ÍÁ…”œ°½±½Èè€Ù…È ´µÑ•áÐµÁÉ¥µ…Éä¤œõôùí™µÑÕÉÉ•¹ä¡À¹É•Ù•¹Õ”¥ôð½Ñø4(€€€€€€€€€€€€€€€€€€€€€€€€€€ñÑÍÑå±”õíìÁ…‘‘¥¹œè€œÄÅÁà€ÄÉÁàœ°Ñ•áÑ±¥¸è€É¥¡Ðœ°™½¹ÑM¥é”è€œÄÉÁàœ°™½¹Ñ…µ¥±äè€)•Ñ	É…¥¹Ì5½¹¼°µ½¹½ÍÁ…”œ°½±½Èè€Ù…È ´µÑ•áÐµÁÉ¥µ…Éä¤œõôùí™µÑU¹¥ÑÌ¡À¹Õ¹¥ÑÌ¥ôð½Ñø4(€€€€€€€€€€€€€€€€€€€€€€€€€€ñÑÍÑå±”õíìÁ…‘‘¥¹œè€œÄÅÁà€ÄÉÁàœ°Ñ•áÑ±¥¸è€É¥¡Ðœ°™½¹ÑM¥é”è€œÄÉÁàœ°™½¹Ñ…µ¥±äè€)•Ñ	É…¥¹Ì5½¹¼°µ½¹½ÍÁ…”œ°½±½Èè€Ù…È ´µÑ•áÐµÁÉ¥µ…Éä¤œõôø‘íÀ¹…ÍÀ¹Ñ½¥á• È¥ôð½Ñø4(€€€€€€€€€€€€€€€€€€€€€€€€€€ñÑÍÑå±”õíìÁ…‘‘¥¹œè€œÄÅÁà€ÄÉÁàœ°Ñ•áÑ±¥¸è€É¥¡Ðœ°™½¹ÑM¥é”è€œÄÉÁàœ°™½¹Ñ…µ¥±äè€)•Ñ	É…¥¹Ì5½¹¼°µ½¹½ÍÁ…”œ°½±½Èè€Ù…È ´µÑ•áÐµÁÉ¥µ…Éä¤œõôùí™µÑU¹¥ÑÌ¡À¹Í•ÍÍ¥½¹Ì¥ôð½Ñø4(€€€€€€€€€€€€€€€€€€€€€€€€€€ñÑÍÑå±”õíìÁ…‘‘¥¹œè€œÄÅÁà€ÄÉÁàœ°Ñ•áÑ±¥¸è€É¥¡Ðœ°™½¹ÑM¥é”è€œÄÉÁàœ°™½¹Ñ…µ¥±äè€)•Ñ	É…¥¹Ì5½¹¼°µ½¹½ÍÁ…”œ°½±½Èè€Ù…È ´µÑ•áÐµÁÉ¥µ…Éä¤œõôùíÀ¹½¹Ù}É…Ñ”¹Ñ½¥á• Ä¥ô”ð½Ñø4(€€€€€€€€€€€€€€€€€€€€€€€€€€ñÑÍÑå±”õíìÁ…‘‘¥¹œè€œÄÅÁà€ÄÉÁàœ°Ñ•áÑ±¥¸è€É¥¡Ðœ°™½¹ÑM¥é”è€œÄÉÁàœ°™½¹Ñ…µ¥±äè€)•Ñ	É…¥¹Ì5½¹¼°µ½¹½ÍÁ…”œ°½±½Èè€Ù…È ´µÑ•áÐµÁÉ¥µ…Éä¤œõôùíÀ¹‰Õå}‰½á}ÁÐ€„ôô¹Õ±°€üÀ¹‰Õå}‰½á}ÁÐ¹Ñ½¥á• Ä¤€¬€œ”œ€è€ŸŠPôð½Ñø4(€€€€€€€€€€€€€€€€€€€€€€€€€€ñÑÍÑå±”õíìÁ…‘‘¥¹œè€œÄÅÁà€ÄÉÁàœ°Ñ•áÑ±¥¸è€É¥¡Ðœõôø4(€€€€€€€€€€€€€€€€€€€€€€€€€€€íÀ¹Ý½Ý}¡…¹”€„ôô¹Õ±°€ü€ 4(€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€ñÍÁ…¸ÍÑå±”õíì™½¹ÑM¥é”è€œÄÅÁàœ°™½¹Ñ]•¥¡Ðè€ØÀÀ°½±½ÈèÀ¹Ý½Ý}¡…¹”€ø€À€ü€Ù…È ´µÉ••¸¤œ€èÀ¹Ý½Ý}¡…¹”€ð€À€ü€Ù…È ´µÉ•¤œ€è€Ù…È ´µÑ•áÐµµÕÑ•¤œ°‘¥ÍÁ±…äè€¥¹±¥¹”µ™±•àœ°…±¥¹%Ñ•µÌè€•¹Ñ•Èœ°…Àè€œÉÁàœ°™½¹Ñ…µ¥±äè€)•Ñ	É…¥¹Ì5½¹¼°µ½¹½ÍÁ…”œõôø4(€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€íÀ¹Ý½Ý}¡…¹”€ø€À€ü€ñQÉ•¹‘¥¹UÀÍ¥é”õìÄÁô€¼ø€èÀ¹Ý½Ý}¡…¹”€ð€À€ü€ñQÉ•¹‘¥¹½Ý¸Í¥é”õìÄÁô€¼ø€è€ñ5¥¹ÕÌÍ¥é”õìÄÁô€¼ùô4(€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€íÀ¹Ý½Ý}¡…¹”€ø€À€ü€œ¬œ€è€œõíÀ¹Ý½Ý}¡…¹”¹Ñ½¥á• Ä¥ô”4(€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€ð½ÍÁ…¸ø4(€€€€€€€€€€€€€€€€€€€€€€€€€€€€¤€è€ 4(€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€ñÍÁ…¸ÍÑå±”õíì™½¹ÑM¥é”è€œÄÅÁàœ°½±½Èè€Ù…È ´µÑ•áÐµ‘¥´¤œõôûŠPð½ÍÁ…¸ø4(€€€€€€€€€€€€€€€€€€€€€€€€€€€€¥ô4(€€€€€€€€€€€€€€€€€€€€€€€€€€ð½Ñø4(€€€€€€€€€€€€€€€€€€€€€€€€€€ñÑÍÑå±”õíìÁ…‘‘¥¹œè€œÄÅÁà€ÄÉÁàœ°Ñ•áÑ±¥¸è€•¹Ñ•Èœ°½±½Èè€Ù…È ´µÑ•áÐµ‘¥´¤œõôø4(€€€€€€€€€€€€€€€€€€€€€€€€€€€í¥ÍáÁ…¹‘•€ü€ñ¡•ÙÉ½¹½Ý¸Í¥é”õìÄÍô€¼ø€è€ñ¡•ÙÉ½¹I¥¡ÐÍ¥é”õìÄÍô€¼ùô4(€€€€€€€€€€€€€€€€€€€€€€€€€€ð½Ñø4(€€€€€€€€€€€€€€€€€€€€€€€€ð½ÑÈø4(€€€€€€€€€€€€€€€€€€€€€€€í¥ÍáÁ…¹‘•€˜˜€ 4(€€€€€€€€€€€€€€€€€€€€€€€€€€ñÑÈ­•äõíÀ¹Í­Ô€¬€œµ•áÀôÍÑå±”õíì‰½É‘•É	½ÑÑ½´è€œÅÁàÍ½±¥Ù…È ´µ‰½É‘•È¤œõôø4(€€€€€€€€€€€€€€€€€€€€€€€€€€€€ñÑ½±MÁ…¸õìÄÅôÍÑå±”õíìÁ…‘‘¥¹œè€œÀ€ÈÁÁà€ÈÁÁà€ÈÁÁàœ°‰…­É½Õ¹è€Ù…È ´µ…•¹Ðµ±¥¡Ð¤œõôø4(€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€ñ‘¥ØÍÑå±”õíìÁ…‘‘¥¹Q½Àè€œÄÙÁàœõôø4(€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€ñ‘¥ØÍÑå±”õíì‘¥ÍÁ±…äè€™±•àœ°…Àè€œÈáÁàœ°µ…É¥¹	½ÑÑ½´è€œÄÙÁàœ°™±•á]É…Àè€ÝÉ…Àœõôø4(€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€íl4(€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€ì±…‰•°è€I•Ù•¹Õ”œ°€€Ù…±Õ”è™µÑÕÉÉ•¹ä¡À¹É•Ù•¹Õ”¤ô°4(€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€ì±…‰•°è€U¹¥ÑÌœ°€€€€Ù…±Õ”è™µÑU¹¥ÑÌ¡À¹Õ¹¥ÑÌ¤ô°4(€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€ì±…‰•°è€M@œ°€€€€€€Ù…±Õ”è€œœ€¬À¹…ÍÀ¹Ñ½¥á• È¤ô°4(€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€ì±…‰•°è€M•ÍÍ¥½¹Ìœ°€Ù…±Õ”è™µÑU¹¥ÑÌ¡À¹Í•ÍÍ¥½¹Ì¤ô°4(€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€ì±…‰•°è€½¹ØI…Ñ”œ°Ù…±Õ”èÀ¹½¹Ù}É…Ñ”¹Ñ½¥á• Ä¤€¬€œ”œô°4(€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€ì±…‰•°è€	Õä	½àœ°€€Ù…±Õ”èÀ¹‰Õå}‰½á}ÁÐ€„ôô¹Õ±°€üÀ¹‰Õå}‰½á}ÁÐ¹Ñ½¥á• Ä¤€¬€œ”œ€è€ŸŠPœô°4(€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€¸¸¸¡À¹Ý½Ý}¡…¹”€„ôô¹Õ±°€ümì±…‰•°è€ÙÌAÉ¥½Èœ°Ù…±Õ”è€¡À¹Ý½Ý}¡…¹”€ø€À€ü€œ¬œ€è€œœ¤€¬À¹Ý½Ý}¡…¹”¹Ñ½¥á• Ä¤€¬€œ”œ°½±½ÈèÀ¹Ý½Ý}¡…¹”€ø€À€ü€Ù…È ´µÉ••¸¤œ€è€Ù…È ´µÉ•¤œõt€èmt¤°4(€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€t¹µ…À ¡ÍÑ…Ð°¥‘à¤€ôø€ 4(€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€ñ‘¥Ø­•äõí¥‘áôø4(€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€ñ‘¥ØÍÑå±”õíì™½¹ÑM¥é”è€œÄÁÁàœ°½±½Èè€Ù…È ´µÑ•áÐµµÕÑ•¤œ°Ñ•áÑQÉ…¹Í™½É´è€ÕÁÁ•É…Í”œ°±•ÑÑ•ÉMÁ…¥¹œè€œÀ¸ÀÙ•´œ°µ…É¥¹	½ÑÑ½´è€œÍÁàœõôùíÍÑ…Ð¹±…‰•±ôð½‘¥Øø4(€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€ñ‘¥ØÍÑå±”õíì™½¹ÑM¥é”è€œÄÝÁàœ°™½¹Ñ]•¥¡Ðè€ØÀÀ°™½¹Ñ…µ¥±äè€)•Ñ	É…¥¹Ì5½¹¼°µ½¹½ÍÁ…”œ°½±½Èè€¡ÍÑ…Ð…Ì…¹ä¤¹½±½Èñð€Ù…È ´µÑ•áÐµÁÉ¥µ…Éä¤œõôùíÍÑ…Ð¹Ù…±Õ•ôð½‘¥Øø4(€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€ð½‘¥Øø4(€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€¤¥ô4(€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€ð½‘¥Øø4(€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€ñI•ÍÁ½¹Í¥Ù•½¹Ñ…¥¹•ÈÝ¥‘Ñ ôˆÄÀÀ”ˆ¡•¥¡ÐõìÄØÁôø4(€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€ñÉ•…¡…ÉÐ‘…Ñ„õí…±±A•É¥½‘…Ñ…mÀ¹Í­Õtñðmuôø4(€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€ñ‘•™Ìø4(€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€ñ±¥¹•…ÉÉ…‘¥•¹Ð¥õíÉ…´‘íÍ…¹¥Ñ¥é•%¡À¹Í­Ô¥õôàÄôˆÀˆäÄôˆÀˆàÈôˆÀˆäÈôˆÄˆø4(€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€ñÍÑ½À½™™Í•ÐôˆÔ”ˆ€ÍÑ½Á½±½Èô‰Ù…È ´µ¡…ÉÐµÁÉ¥µ…Éä¤ˆÍÑ½Á=Á…¥ÑäõìÅô€¼ø4(€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€ñÍÑ½À½™™Í•ÐôˆäÔ”ˆÍÑ½Á½±½Èô‰Ù…È ´µ¡…ÉÐµÁÉ¥µ…Éä¤ˆÍÑ½Á=Á…¥ÑäõìÁô€¼ø4(€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€ð½±¥¹•…ÉÉ…‘¥•¹Ðø4(€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€ð½‘•™Ìø4(€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€ñ…ÉÑ•Í¥…¹É¥ÍÑÉ½­•…Í¡…ÉÉ…äôˆÌ€ÌˆÍÑÉ½­”ô‰Ù…È ´µ‰½É‘•È¤ˆÙ•ÉÑ¥…°õí™…±Í•ô€¼ø4(€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€ñaá¥Ì‘…Ñ…-•äô‰±…‰•°ˆÑ¥¬õíì™½¹ÑM¥é”è€ä°™¥±°è€Ù…È ´µÑ•áÐµ‘¥´¤œõôÑ¥­1¥¹”õí™…±Í•ô…á¥Í1¥¹”õí™…±Í•ô¥¹Ñ•ÉÙ…°ô‰ÁÉ•Í•ÉÙ•MÑ…ÉÑ¹ˆ€¼ø4(€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€ñeá¥ÌÑ¥¬õíì™½¹ÑM¥é”è€ä°™¥±°è€Ù…È ´µÑ•áÐµ‘¥´¤œõôÑ¥­1¥¹”õí™…±Í•ô…á¥Í1¥¹”õí™…±Í•ôÑ¥­½Éµ…ÑÑ•ÈõíØ€ôø€œœ€¬™µÐ¡Ø¥ôÝ¥‘Ñ õìÔÕô€¼ø4(€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€ñQ½½±Ñ¥À½¹Ñ•¹ÐõìñÕÍÑ½µQ½½±Ñ¥À€¼ùô€¼ø4(€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€ñÉ•„ÑåÁ”ô‰µ½¹½Ñ½¹”ˆ‘…Ñ…-•äô‰É•Ù•¹Õ”ˆ¹…µ”ô‰I•Ù•¹Õ”ˆÍÑÉ½­”ô‰Ù…È ´µ¡…ÉÐµÁÉ¥µ…Éä¤ˆÍÑÉ½­•]¥‘Ñ õìÄ¸Õô™¥±°õíÕÉ° É…´‘íÍ…¹¥Ñ¥é•%¡À¹Í­Ô¥ô¥ô‘½Ðõí™…±Í•ô€¼ø4(€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€ð½É•…¡…ÉÐø4(€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€ð½I•ÍÁ½¹Í¥Ù•½¹Ñ…¥¹•Èø4(€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€ð½‘¥Øø4(€€€€€€€€€€€€€€€€€€€€€€€€€€€€ð½Ñø4(€€€€€€€€€€€€€€€€€€€€€€€€€€ð½ÑÈø4(€€€€€€€€€€€€€€€€€€€€€€€€¥ô4(€€€€€€€€€€€€€€€€€€€€€€ð½I•…Ð¹É…µ•¹Ðø4(€€€€€€€€€€€€€€€€€€€€¤4(€€€€€€€€€€€€€€€€€ô¥ô4(€€€€€€€€€€€€€€€€ð½Ñ‰½‘äø4(€€€€€€€€€€€€€€ð½Ñ…‰±”ø4(€€€€€€€€€€€€ð½‘¥Øø4(€€€€€€€€€€€í™¥±Ñ•É•¹±•¹Ñ €ôôô€À€˜˜€ 4(€€€€€€€€€€€€€€ñ‘¥ØÍÑå±”õíìÁ…‘‘¥¹œè€œÐÁÁàœ°Ñ•áÑ±¥¸è€•¹Ñ•Èœ°½±½Èè€Ù…È ´µÑ•áÐµ‘¥´¤œ°™½¹ÑM¥é”è€œÄÍÁàœõôù9¼ÁÉ½‘ÕÑÌ™½Õ¹ð½‘¥Øø4(€€€€€€€€€€€€¥ô4(€€€€€€€€€€ð½‘¥Øø4(€€€€€€€€€í¡…Í5½É”€˜˜€ 4(€€€€€€€€€€€€ñ‘¥ØÍÑå±”õíìÑ•áÑ±¥¸è€•¹Ñ•Èœ°µ…É¥¹Q½Àè€œÄÙÁàœõôø4(€€€€€€€€€€€€€€ñ‰ÕÑÑ½¸½¹±¥¬õì ¤€ôøÍ•ÑA…”¡À€ôøÀ€¬€Ä¥ôÍÑå±”õíì4(€€€€€€€€€€€€€€€Á…‘‘¥¹œè€œáÁà€ÈÑÁàœ°‰½É‘•ÉI…‘¥ÕÌè€œáÁàœ°4(€€€€€€€€€€€€€€€‰½É‘•Èè€œÅÁàÍ½±¥Ù…È ´µ‰½É‘•È¤œ°‰…­É½Õ¹è€Ù…È ´µ‰œµ…É¤œ°4(€€€€€€€€€€€€€€€½±½Èè€Ù…È ´µÑ•áÐµµÕÑ•¤œ°™½¹ÑM¥é”è€œÄÉÁàœ°ÕÉÍ½Èè€Á½¥¹Ñ•Èœ°4(€€€€€€€€€€€€€õô4(€€€€€€€€€€€€€½¹5½ÕÍ•¹Ñ•Èõí”€ôøì€¡”¹ÕÉÉ•¹ÑQ…É•Ð…Ì!Q51	ÕÑÑ½¹±•µ•¹Ð¤¹ÍÑå±”¹‰½É‘•É½±½È€ô€Ù…È ´µ…•¹Ð¤œì€¡”¹ÕÉÉ•¹ÑQ…É•Ð…Ì!Q51	ÕÑÑ½¹±•µ•¹Ð¤¹ÍÑå±”¹½±½È€ô€Ù…È ´µ…•¹Ð¤œõô4(€€€€€€€€€€€€€½¹5½ÕÍ•1•…Ù”õí”€ôøì€¡”¹ÕÉÉ•¹ÑQ…É•Ð…Ì!Q51	ÕÑÑ½¹±•µ•¹Ð¤¹ÍÑå±”¹‰½É‘•É½±½È€ô€Ù…È ´µ‰½É‘•È¤œì€¡”¹ÕÉÉ•¹ÑQ…É•Ð…Ì!Q51	ÕÑÑ½¹±•µ•¹Ð¤¹ÍÑå±”¹½±½È€ô€Ù…È ´µÑ•áÐµµÕÑ•¤œõô4(€€€€€€€€€€€€€€ø4(€€€€€€€€€€€€€€€1½…µ½É”ƒŠPÍ¡½Ý¥¹œíÁ…¥¹…Ñ•¹±•¹Ñ¡ô½˜í™¥±Ñ•É•¹±•¹Ñ¡ô4(€€€€€€€€€€€€€€ð½‰ÕÑÑ½¸ø4(€€€€€€€€€€€€ð½‘¥Øø4(€€€€€€€€€€¥ô4(€€€€€€€€ð¼ø4(4(€€€€€€¤€è€ 4(4(€€€€€€€€¼¨ƒŠRŠR 9QƒŠRŠR €¨¼4(€€€€€€€€ðø4(€€€€€€€€€€ñ‘¥ØÍÑå±”õíì‘¥ÍÁ±…äè€™±•àœ°…±¥¹%Ñ•µÌè€•¹Ñ•Èœ°…Àè€œÄÙÁàœ°µ…É¥¹	½ÑÑ½´è€œÄÑÁàœ°™±•á]É…Àè€ÝÉ…Àœõôø4(4(€€€€€€€€€€€ì¼¨U¹¥ÑÌ€¼I•Ù•¹Õ”Ñ½±”€¨½ô4(€€€€€€€€€€€€ñ‘¥ØÍÑå±”õíì‘¥ÍÁ±…äè€™±•àœ°…±¥¹%Ñ•µÌè€•¹Ñ•Èœ°…Àè€œÙÁàœõôø4(€€€€€€€€€€€€€€ñÍÁ…¸ÍÑå±”õíì™½¹ÑM¥é”è€œÄÅÁàœ°½±½Èè€Ù…È ´µÑ•áÐµ‘¥´¤œ°™½¹Ñ]•¥¡Ðè€ØÀÀ°Ñ•áÑQÉ…¹Í™½É´è€ÕÁÁ•É…Í”œ°±•ÑÑ•ÉMÁ…¥¹œè€œÀ¸ÀÙ•´œ°µ…É¥¹I¥¡Ðè€œÑÁàœõôùY¥•Üð½ÍÁ…¸ø4(€€€€€€€€€€€€€ì¡lÕ¹¥ÑÌœ°€É•Ù•¹Õ”t…Ì…‘•¹•5•ÑÉ¥mt¤¹µ…À¡´€ôø€ 4(€€€€€€€€€€€€€€€€ñ‰ÕÑÑ½¸­•äõíµô½¹±¥¬õì ¤€ôøÍ•Ñ…‘•¹•5•ÑÉ¥Œ¡´¥ôÍÑå±”õíì4(€€€€€€€€€€€€€€€€€Á…‘‘¥¹œè€œÑÁà€ÄÉÁàœ°‰½É‘•ÉI…‘¥ÕÌè€œÙÁàœ°™½¹ÑM¥é”è€œÄÅÁàœ°™½¹Ñ]•¥¡Ðè€ÔÀÀ°4(€€€€€€€€€€€€€€€€€ÕÉÍ½Èè€Á½¥¹Ñ•Èœ°ÑÉ…¹Í¥Ñ¥½¸è€…±°€À¸ÄÉÌ•…Í”œ°Ñ•áÑQÉ…¹Í™½É´è€…Á¥Ñ…±¥é”œ°4(€€€€€€€€€€€€€€€€€‰½É‘•Èè…‘•¹•5•ÑÉ¥Œ€ôôô´€ü€œÅÁàÍ½±¥Ù…È ´µ…•¹Ðµ‰½É‘•È¤œ€è€œÅÁàÍ½±¥Ù…È ´µ‰½É‘•È¤œ°4(€€€€€€€€€€€€€€€€€‰…­É½Õ¹è…‘•¹•5•ÑÉ¥Œ€ôôô´€ü€Ù…È ´µ…•¹Ðµ±¥¡Ð¤œ€è€ÑÉ…¹ÍÁ…É•¹Ðœ°4(€€€€€€€€€€€€€€€€€½±½Èè…‘•¹•5•ÑÉ¥Œ€ôôô´€ü€Ù…È ´µ…•¹Ð¤œ€è€Ù…È ´µÑ•áÐµµÕÑ•¤œ°4(€€€€€€€€€€€€€€€õôùí´€ôôô€Õ¹¥ÑÌœ€ü€U¹¥ÑÌœ€è€I•Ù•¹Õ”ôð½‰ÕÑÑ½¸ø4(€€€€€€€€€€€€€€¤¥ô4(€€€€€€€€€€€€ð½‘¥Øø4(4(€€€€€€€€€€€ì¼¨…ä€¼]••¬€¼5½¹Ñ É½ÕÁ¥¹œÑ½±”€¨½ô4(€€€€€€€€€€€€ñ‘¥ØÍÑå±”õíì‘¥ÍÁ±…äè€™±•àœ°…±¥¹%Ñ•µÌè€•¹Ñ•Èœ°…Àè€œÙÁàœõôø4(€€€€€€€€€€€€€€ñÍÁ…¸ÍÑå±”õíì™½¹ÑM¥é”è€œÄÅÁàœ°½±½Èè€Ù…È ´µÑ•áÐµ‘¥´¤œ°™½¹Ñ]•¥¡Ðè€ØÀÀ°Ñ•áÑQÉ…¹Í™½É´è€ÕÁÁ•É…Í”œ°±•ÑÑ•ÉMÁ…¥¹œè€œÀ¸ÀÙ•´œ°µ…É¥¹I¥¡Ðè€œÑÁàœõôùÉ½ÕÀ‰äð½ÍÁ…¸ø4(€€€€€€€€€€€€€ì¡l‘…äœ°€Ý••¬œ°€µ½¹Ñ t…Ì…‘•¹•É½ÕÁ¥¹mt¤¹µ…À¡œ€ôø€ 4(€€€€€€€€€€€€€€€€ñ‰ÕÑÑ½¸­•äõíô½¹±¥¬õì ¤€ôøÍ•Ñ…‘•¹•É½ÕÁ¥¹œ¡œ¥ôÍÑå±”õíì4(€€€€€€€€€€€€€€€€€Á…‘‘¥¹œè€œÑÁà€ÄÉÁàœ°‰½É‘•ÉI…‘¥ÕÌè€œÙÁàœ°™½¹ÑM¥é”è€œÄÅÁàœ°™½¹Ñ]•¥¡Ðè€ÔÀÀ°4(€€€€€€€€€€€€€€€€€ÕÉÍ½Èè€Á½¥¹Ñ•Èœ°ÑÉ…¹Í¥Ñ¥½¸è€…±°€À¸ÄÉÌ•…Í”œ°Ñ•áÑQÉ…¹Í™½É´è€…Á¥Ñ…±¥é”œ°4(€€€€€€€€€€€€€€€€€‰½É‘•Èè…‘•¹•É½ÕÁ¥¹œ€ôôôœ€ü€œÅÁàÍ½±¥Ù…È ´µ…•¹Ðµ‰½É‘•È¤œ€è€œÅÁàÍ½±¥Ù…È ´µ‰½É‘•È¤œ°4(€€€€€€€€€€€€€€€€€‰…­É½Õ¹è…‘•¹•É½ÕÁ¥¹œ€ôôôœ€ü€Ù…È ´µ…•¹Ðµ±¥¡Ð¤œ€è€ÑÉ…¹ÍÁ…É•¹Ðœ°4(€€€€€€€€€€€€€€€€€½±½Èè…‘•¹•É½ÕÁ¥¹œ€ôôôœ€ü€Ù…È ´µ…•¹Ð¤œ€è€Ù…È ´µÑ•áÐµµÕÑ•¤œ°4(€€€€€€€€€€€€€€€õôùíôð½‰ÕÑÑ½¸ø4(€€€€€€€€€€€€€€¤¥ô4(€€€€€€€€€€€€ð½‘¥Øø4(4(€€€€€€€€€€€€ñÍÁ…¸ÍÑå±”õíì™½¹ÑM¥é”è€œÄÅÁàœ°½±½Èè€Ù…È ´µÑ•áÐµ‘¥´¤œ°™½¹Ñ…µ¥±äè€)•Ñ	É…¥¹Ì5½¹¼°µ½¹½ÍÁ…”œ°µ…É¥¹1•™Ðè€…ÕÑ¼œõôø4(€€€€€€€€€€€€€í…±±A•É¥½‘Ì¹±•¹Ñ¡ôí…‘•¹•É½ÕÁ¥¹õÌƒ
Üí…‘•¹•I½ÝÌ¹±•¹Ñ¡ôM-UÌ4(€€€€€€€€€€€€ð½ÍÁ…¸ø4(€€€€€€€€€€ð½‘¥Øø4(4(€€€€€€€€€€ñ‘¥Ø±…ÍÍ9…µ”ô‰…ÉˆÍÑå±”õíì½Ù•É™±½Üè€¡¥‘‘•¸œõôø4(€€€€€€€€€€€€ñ‘¥Ø4(€€€€€€€€€€€€€±…ÍÍ9…µ”ô‰…‘•¹”µÍÉ½±°ˆ4(€€€€€€€€€€€€€ÍÑå±”õíì4(€€€€€€€€€€€€€€€½Ù•É™±½Ý`è€…ÕÑ¼œ°½Ù•É™±½Ýdè€…ÕÑ¼œ°µ…á!•¥¡Ðè€œÜÁÙ œ°4(€€€€€€€€€€€€€€€ÍÉ½±±‰…É]¥‘Ñ è€…ÕÑ¼œ°ÍÉ½±±‰…É½±½Èè€Ù…È ´µ…•¹Ð¤Ù…È ´µ‰œµ¡½Ù•È¤œ°4(€€€€€€€€€€€€€õô4(€€€€€€€€€€€€ø4(€€€€€€€€€€€€€€ñÑ…‰±”ÍÑå±”õíìÝ¥‘Ñ è€œÄÀÀ”œ°‰½É‘•É½±±…ÁÍ”è€½±±…ÁÍ”œ°µ¥¹]¥‘Ñ è€‘ìÌÀÀ€¬…±±A•É¥½‘Ì¹±•¹Ñ €¨€àÁõÁá€õôø4(€€€€€€€€€€€€€€€€ñÑ¡•…ø4(€€€€€€€€€€€€€€€€€€ñÑÈø4(€€€€€€€€€€€€€€€€€€€€ñÑ ÍÑå±”õíì€¸¸¹Ñ¡	…Í”°Ñ•áÑ±¥¸è€±•™Ðœ°½±½Èè€Ù…È ´µÑ•áÐµµÕÑ•¤œ°µ¥¹]¥‘Ñ è€œÈÈÁÁàœ°Á½Í¥Ñ¥½¸è€ÍÑ¥­äœ°±•™Ðè€À°é%¹‘•àè€ÈÀõôø4(€€€€€€€€€€€€€€€€€€€€€AÉ½‘ÕÐ4(€€€€€€€€€€€€€€€€€€€€ð½Ñ ø4(€€€€€€€€€€€€€€€€€€€í…±±A•É¥½‘Ì¹µ…À ¡¬°¤¤€ôø€ 4(€€€€€€€€€€€€€€€€€€€€€€ñÑ ­•äõí­ôÍÑå±”õíì€¸¸¹Ñ¡	…Í”°Ñ•áÑ±¥¸è€É¥¡Ðœ°½±½Èè€Ù…È ´µÑ•áÐµµÕÑ•¤œ°µ¥¹]¥‘Ñ è€œÜÉÁàœõôø4(€€€€€€€€€€€€€€€€€€€€€€€€ñ‘¥ØÍÑå±”õíì™½¹Ñ]•¥¡Ðè€ÜÀÀ°½±½Èè€Ù…È ´µÑ•áÐµÁÉ¥µ…Éä¤œõôø4(€€€€€€€€€€€€€€€€€€€€€€€€€í…‘•¹•É½ÕÁ¥¹œ€ôôô€‘…äœ€ü‘í¤€¬€Åõ€€è…‘•¹•É½ÕÁ¥¹œ€ôôô€Ý••¬œ€ü\‘í¤€¬€Åõ€€è4‘í¤€¬€Åõô4(€€€€€€€€€€€€€€€€€€€€€€€€ð½‘¥Øø4(€€€€€€€€€€€€€€€€€€€€€€€€ñ‘¥ØÍÑå±”õíì™½¹ÑM¥é”è€œåÁàœ°™½¹Ñ]•¥¡Ðè€ÐÀÀ°½±½Èè€Ù…È ´µÑ•áÐµ‘¥´¤œ°µ…É¥¹Q½Àè€œÅÁàœ°™½¹Ñ…µ¥±äè€)•Ñ	É…¥¹Ì5½¹¼°µ½¹½ÍÁ…”œõôø4(€€€€€€€€€€€€€€€€€€€€€€€€€í•ÑA•É¥½‘1…‰•°¡¬°…‘•¹•É½ÕÁ¥¹œ¥ô4(€€€€€€€€€€€€€€€€€€€€€€€€ð½‘¥Øø4(€€€€€€€€€€€€€€€€€€€€€€ð½Ñ ø4(€€€€€€€€€€€€€€€€€€€€¤¥ô4(€€€€€€€€€€€€€€€€€€€€ñÑ ÍÑå±”õíì€¸¸¹Ñ¡	…Í”°Ñ•áÑ±¥¸è€É¥¡Ðœ°½±½Èè€Ù…È ´µ…•¹Ð¤œ°µ¥¹]¥‘Ñ è€œàÁÁàœ°‰½É‘•É1•™Ðè€œÅÁàÍ½±¥Ù…È ´µ‰½É‘•È¤œõôø4(€€€€€€€€€€€€€€€€€€€€€Q½Ñ…°4(€€€€€€€€€€€€€€€€€€€€ð½Ñ ø4(€€€€€€€€€€€€€€€€€€ð½ÑÈø4(€€€€€€€€€€€€€€€€ð½Ñ¡•…ø4(€€€€€€€€€€€€€€€€ñÑ‰½‘äø4(€€€€€€€€€€€€€€€€€í…‘•¹•I½ÝÌ¹µ…À¡À€ôøì4(€€€€€€€€€€€€€€€€€€€½¹ÍÐÍ­ÕY…±Ì€ô…±±A•É¥½‘Ì¹µ…À¡¬€ôøì4(€€€€€€€€€€€€€€€€€€€€€½¹ÍÐÁÐ€ôÀ¹‰åA•É¥½‘m­t4(€€€€€€€€€€€€€€€€€€€€€É•ÑÕÉ¸ÁÐ€ü€¡…‘•¹•5•ÑÉ¥Œ€ôôô€Õ¹¥ÑÌœ€üÁÐ¹Õ¹¥ÑÌ€èÁÐ¹É•Ù•¹Õ”¤€è€À4(€€€€€€€€€€€€€€€€€€€ô¤4(€€€€€€€€€€€€€€€€€€€½¹ÍÐÍ­Õ5…à€ô5…Ñ ¹µ…à ¸¸¹Í­ÕY…±Ì°€Ä¤4(4(€€€€€€€€€€€€€€€€€€€É•ÑÕÉ¸€ 4(€€€€€€€€€€€€€€€€€€€€€€ñÑÈ­•äõíÀ¹Í­ÕôÍÑå±”õíì‰½É‘•É	½ÑÑ½´è€œÅÁàÍ½±¥Ù…È ´µ‰½É‘•È¤œõôø4(€€€€€€€€€€€€€€€€€€€€€€€€ñÑÍÑå±”õíì4(€€€€€€€€€€€€€€€€€€€€€€€€€Á…‘‘¥¹œè€œåÁà€ÄÉÁàœ°Á½Í¥Ñ¥½¸è€ÍÑ¥­äœ°±•™Ðè€À°é%¹‘•àè€Ô°4(€€€€€€€€€€€€€€€€€€€€€€€€€‰…­É½Õ¹è€Ù…È ´µ‰œµ…É¤œ°‰½É‘•ÉI¥¡Ðè€œÅÁàÍ½±¥Ù…È ´µ‰½É‘•È¤œ°4(€€€€€€€€€€€€€€€€€€€€€€€õôø4(€€€€€€€€€€€€€€€€€€€€€€€€€€ñ‘¥ØÍÑå±”õíì™½¹ÑM¥é”è€œÄÅÁàœ°™½¹Ñ]•¥¡Ðè€ÔÀÀ°½±½Èè€Ù…È ´µÑ•áÐµÁÉ¥µ…Éä¤œ°µ…É¥¹	½ÑÑ½´è€œÅÁàœõôùíÑÉÕ¹…Ñ”¡À¹Ñ¥Ñ±”°€ÌÀ¥ôð½‘¥Øø4(€€€€€€€€€€€€€€€€€€€€€€€€€€ñ‘¥ØÍÑå±”õíì™½¹ÑM¥é”è€œÄÁÁàœ°½±½Èè€Ù…È ´µÑ•áÐµ‘¥´¤œ°™½¹Ñ…µ¥±äè€)•Ñ	É…¥¹Ì5½¹¼°µ½¹½ÍÁ…”œõôùíÀ¹Í­Õôð½‘¥Øø4(€€€€€€€€€€€€€€€€€€€€€€€€ð½Ñø4(€€€€€€€€€€€€€€€€€€€€€€€í…±±A•É¥½‘Ì¹µ…À¡¬€ôøì4(€€€€€€€€€€€€€€€€€€€€€€€€€½¹ÍÐÁÐ€€€€ôÀ¹‰åA•É¥½‘m­t4(€€€€€€€€€€€€€€€€€€€€€€€€€½¹ÍÐÙ…°€€€ôÁÐ€ü€¡…‘•¹•5•ÑÉ¥Œ€ôôô€Õ¹¥ÑÌœ€üÁÐ¹Õ¹¥ÑÌ€èÁÐ¹É•Ù•¹Õ”¤€è€À4(€€€€€€€€€€€€€€€€€€€€€€€€€½¹ÍÐ¥ÍµÁÑä€ôÙ…°€ôôô€À4(€€€€€€€€€€€€€€€€€€€€€€€€€½¹ÍÐÉ…Ñ¥¼€ô¥ÍµÁÑä€ü€À€èÙ…°€¼Í­Õ5…à4(€€€€€€€€€€€€€€€€€€€€€€€€€½¹ÍÐ‰œ€ô¥ÍµÁÑä€ü€É‰„ ÈÈÀ°Ìà°Ìà°À¸Àà¤œ4(€€€€€€€€€€€€€€€€€€€€€€€€€€€€èÉ…Ñ¥¼€ø€À¸ÜÔ€ü€É‰„ Ô°ÄÔÀ°ÄÀÔ°À¸ÄÈ¤œ4(€€€€€€€€€€€€€€€€€€€€€€€€€€€€èÉ…Ñ¥¼€ø€À¸Ð€€ü€É‰„ Ô°ÄÔÀ°ÄÀÔ°À¸ÀÔ¤œ4(€€€€€€€€€€€€€€€€€€€€€€€€€€€€è€ÑÉ…¹ÍÁ…É•¹Ðœ4(€€€€€€€€€€€€€€€€€€€€€€€€€É•ÑÕÉ¸€ 4(€€€€€€€€€€€€€€€€€€€€€€€€€€€€ñÑ­•äõí­ôÍÑå±”õíì4(€€€€€€€€€€€€€€€€€€€€€€€€€€€€€Á…‘‘¥¹œè€œåÁà€ÄÁÁàœ°Ñ•áÑ±¥¸è€É¥¡Ðœ°4(€€€€€€€€€€€€€€€€€€€€€€€€€€€€€™½¹ÑM¥é”è€œÄÅÁàœ°™½¹Ñ…µ¥±äè€)•Ñ	É…¥¹Ì5½¹¼°µ½¹½ÍÁ…”œ°4(€€€€€€€€€€€€€€€€€€€€€€€€€€€€€½±½Èè¥ÍµÁÑä€ü€Ù…È ´µÑ•áÐµ‘¥´¤œ€è€Ù…È ´µÑ•áÐµÁÉ¥µ…Éä¤œ°4(€€€€€€€€€€€€€€€€€€€€€€€€€€€€€‰…­É½Õ¹è‰œ°™½¹Ñ]•¥¡Ðè¥ÍµÁÑä€ü€ÐÀÀ€è€ÔÀÀ°4(€€€€€€€€€€€€€€€€€€€€€€€€€€€õôø4(€€€€€€€€€€€€€€€€€€€€€€€€€€€€€í¥ÍµÁÑä€ü€ŸŠPœ€è…‘•¹•5•ÑÉ¥Œ€ôôô€Õ¹¥ÑÌœ€üÙ…°¹Ñ½1½…±•MÑÉ¥¹œ ¤€è™µÑÕÉÉ•¹ä¡Ù…°¥ô4(€€€€€€€€€€€€€€€€€€€€€€€€€€€€ð½Ñø4(€€€€€€€€€€€€€€€€€€€€€€€€€€¤4(€€€€€€€€€€€€€€€€€€€€€€€ô¥ô4(€€€€€€€€€€€€€€€€€€€€€€€€ñÑÍÑå±”õíì4(€€€€€€€€€€€€€€€€€€€€€€€€€Á…‘‘¥¹œè€œåÁà€ÄÉÁàœ°Ñ•áÑ±¥¸è€É¥¡Ðœ°4(€€€€€€€€€€€€€€€€€€€€€€€€€™½¹ÑM¥é”è€œÄÅÁàœ°™½¹Ñ]•¥¡Ðè€ÜÀÀ°4(€€€€€€€€€€€€€€€€€€€€€€€€€™½¹Ñ…µ¥±äè€)•Ñ	É…¥¹Ì5½¹¼°µ½¹½ÍÁ…”œ°½±½Èè€Ù…È ´µÑ•áÐµÁÉ¥µ…Éä¤œ°4(€€€€€€€€€€€€€€€€€€€€€€€€€‰½É‘•É1•™Ðè€œÅÁàÍ½±¥Ù…È ´µ‰½É‘•È¤œ°4(€€€€€€€€€€€€€€€€€€€€€€€õôø4(€€€€€€€€€€€€€€€€€€€€€€€€€í…‘•¹•5•ÑÉ¥Œ€ôôô€Õ¹¥ÑÌœ€üÀ¹Ñ½Ñ…°¹Ñ½1½…±•MÑÉ¥¹œ ¤€è™µÑÕÉÉ•¹ä¡À¹Ñ½Ñ…°¥ô4(€€€€€€€€€€€€€€€€€€€€€€€€ð½Ñø4(€€€€€€€€€€€€€€€€€€€€€€ð½ÑÈø4(€€€€€€€€€€€€€€€€€€€€¤4(€€€€€€€€€€€€€€€€€ô¥ô4(€€€€€€€€€€€€€€€€ð½Ñ‰½‘äø4(€€€€€€€€€€€€€€ð½Ñ…‰±”ø4(€€€€€€€€€€€€ð½‘¥Øø4(€€€€€€€€€€€í…‘•¹•I½ÝÌ¹±•¹Ñ €ôôô€À€˜˜€ 4(€€€€€€€€€€€€€€ñ‘¥ØÍÑå±”õíìÁ…‘‘¥¹œè€œÐÁÁàœ°Ñ•áÑ±¥¸è€•¹Ñ•Èœ°½±½Èè€Ù…È ´µÑ•áÐµ‘¥´¤œ°™½¹ÑM¥é”è€œÄÍÁàœõôù9¼ÁÉ½‘ÕÑÌ™½Õ¹ð½‘¥Øø4(€€€€€€€€€€€€¥ô4(€€€€€€€€€€ð½‘¥Øø4(€€€€€€€€ð¼ø4(€€€€€€¥ô4(€€€€ð½‘¥Øø4(€€¤4)ô(