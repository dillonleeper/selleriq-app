'use client'

import { useEffect, useState, useRef } from 'react'
import { supabase } from '@/lib/supabase'
import { searchProducts } from '@/lib/productSearch'
import MarketplaceFilter from '@/components/MarketplaceFilter'
import DateRangeFilter, { DateRange, PRESET_LABELS } from '@/components/DateRangeFilter'
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

type WeeklyRow = {
  raw_date: string
  start_date: string
  total_revenue: number
  total_units: number
  total_sessions: number
  total_page_views: number
}

type OverviewRpcRow = {
  period: 'current' | 'prior'
  start_date: string
  revenue: number | string
  units: number | string
  sessions: number | string
  page_views: number | string
}

// One P&L line from the get_finance_pnl RPC (dev). Amounts are already USD
// (server-side CAâ†’USD at the same 0.74 rate the KPI cards use â€” do NOT re-run
// through toUSD).
type FinanceRow = {
  pnl_category: string
  widget_line: string
  display_order: number
  include_in_operating_sum: boolean
  is_expandable: boolean
  amount_usd: number
  event_count: number
  deferred_count: number
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
// Exact integer with comma separators â€” for unit counts (e.g. 11,807).
function fmtUnits(n: number) {
  return Math.round(n).toLocaleString('en-US')
}
function fmtCurrency(n: number) {
  // Sign-aware: negatives render as -$X (fees/refunds). Non-negative is unchanged.
  const abs = Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 })
  return (n < 0 ? '-$' : '$') + abs
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
  // Finance P&L breakdown (null = not loaded yet; [] = loaded, no rows for range).
  const [finance, setFinance] = useState<FinanceRow[] | null>(null)
  // Whether the last get_finance_pnl call errored (e.g. timeout). Kept separate
  // from an empty result so a failed fetch isn't rendered as "no data exists".
  const [financeError, setFinanceError] = useState(false)

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

  const handleKeyDown = async (e: React.KeyboardEvent<HTMLInputElement>) => {
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

  // Main data fetch
  useEffect(() => {
    if (!dateRange || !dateRange.startDate) return
    let cancelled = false
    async function load() {
      const { startDate, endDate, priorStart, priorEnd } = dateRange!
      setLoading(true)

      const { data: overviewRows, error } = await supabase.rpc('get_sales_overview', {
        p_start: startDate,
        p_end: endDate,
        p_prior_start: priorStart,
        p_prior_end: priorEnd,
        p_markets: markets,
        p_skus: selectedProducts.length ? selectedProducts.map(p => p.sku) : null,
      })
      if (cancelled) return
      if (error) { console.error(error); setLoading(false); return }

      const typedOverviewRows = (overviewRows || []) as OverviewRpcRow[]
      const toLegacyRow = (row: OverviewRpcRow) => ({
        start_date: row.start_date,
        marketplace: 'US', // revenue is already normalized to USD by the RPC
        ordered_product_sales_amount: Number(row.revenue) || 0,
        units_ordered: Number(row.units) || 0,
        sessions: Number(row.sessions) || 0,
        page_views: Number(row.page_views) || 0,
      })
      const data = typedOverviewRows.filter(row => row.period === 'current').map(toLegacyRow)

      // Prior period
      const prevRows = typedOverviewRows.filter(row => row.period === 'prior').map(toLegacyRow)

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

      // Finance P&L breakdown â€” period totals in USD (no toUSD). The RPC has no
      // SKU param (period-grain); the widget hides when a SKU filter is active,
      // so we don't pass selectedProducts here. p_marketplace: single when one
      // market is selected, else null = all (US/CA are the only markets).
      const p_marketplace = markets.length === 1 ? markets[0] : null
      const { data: fin, error: finErr } = await supabase.rpc('get_finance_pnl', {
        p_start: startDate,
        p_end: endDate,
        p_marketplace,
      })
      if (finErr) { console.error(finErr); setFinanceError(true); setFinance([]) }
      else { setFinanceError(false); setFinance((fin || []) as FinanceRow[]) }

      setLoading(false)
    }
    load()
    return () => { cancelled = true }
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

  // â”€â”€â”€ Total Sales Breakdown (finance settlement P&L, from get_finance_pnl) â”€â”€â”€
  // Reshaped off the RPC by display_order. value: null â†’ "Not yet tracked".
  type BreakdownRow = { label: string; value: number | null; live?: boolean; strong?: boolean; hint?: string }

  const skuFilterActive = selectedProducts.length > 0
  const financeRows = finance ?? []
  const hasFinance = financeRows.length > 0

  // Operating lines (include_in_operating_sum), in the RPC's display order.
  // Payout (Transfer, !include_in_operating_sum) is deliberately NOT displayed
  // in this P&L widget â€” it's a cash-flow figure, not accrual. The RPC still
  // returns it; a future dedicated payouts/cash-flow view can surface it.
  const operatingRows = financeRows
    .filter(r => r.include_in_operating_sum)
    .sort((a, b) => a.display_order - b.display_order)
  const netProceeds = operatingRows.reduce((s, r) => s + Number(r.amount_usd || 0), 0)
  const totalDeferred = financeRows.reduce((s, r) => s + Number(r.deferred_count || 0), 0)

  const salesBreakdown: BreakdownRow[] = hasFinance ? [
    ...operatingRows.map(r => ({ label: r.widget_line, value: Number(r.amount_usd || 0) })),
    { label: 'Marketplace net proceeds (beforeß^½¶‰žËkºwµçeØÍÑå±”õíì4(€€€€€€€€€€€€€€€‘¥ÍÁ±…äè€™±•àœ°…±¥¹%Ñ•µÌè€•¹Ñ•Èœ°…Àè€œáÁàœ°4(€€€€€€€€€€€€€€€‰…­É½Õ¹è€Ù…È ´µ…•¹Ðµ±¥¡Ð¤œ°‰½É‘•Èè€œÅÁàÍ½±¥Ù…È ´µ…•¹Ðµ‰½É‘•È¤œ°4(€€€€€€€€€€€€€€€‰½É‘•ÉI…‘¥ÕÌè€œÙÁàœ°Á…‘‘¥¹œè€œÕÁà€ÄÉÁàœ°™½¹ÑM¥é”è€œÄÉÁàœ°½±½Èè€Ù…È ´µ…•¹Ð¤œ°4(€€€€€€€€€€€€€õôø4(€€€€€€€€€€€€€€€€ñÍÁ…¸ÍÑå±”õíì™½¹Ñ]•¥¡Ðè€ÔÀÀõôùíÍ•±•Ñ•‘AÉ½‘ÕÑÌ¹±•¹Ñ¡ôÁÉ½‘ÕÑÌÍ•±•Ñ•ð½ÍÁ…¸ø4(€€€€€€€€€€€€€€€€ñ‰ÕÑÑ½¸½¹±¥¬õí±•…É±±ôÍÑå±”õíì‰…­É½Õ¹è€¹½¹”œ°‰½É‘•Èè€¹½¹”œ°ÕÉÍ½Èè€Á½¥¹Ñ•Èœ°½±½Èè€Ù…È ´µÑ•áÐµµÕÑ•¤œ°™½¹ÑM¥é”è€œÄÅÁàœ°‘¥ÍÁ±…äè€™±•àœ°…±¥¹%Ñ•µÌè€•¹Ñ•Èœ°…Àè€œÍÁàœ°Á…‘‘¥¹œè€Àõôø4(€€€€€€€€€€€€€€€€€€ñ`Í¥é”õìÄÁô€¼ø±•…È…±°4(€€€€€€€€€€€€€€€€ð½‰ÕÑÑ½¸ø4(€€€€€€€€€€€€€€ð½‘¥Øø4(€€€€€€€€€€€€¥ô4(€€€€€€€€€€ð½‘¥Øø4(€€€€€€€€¥ô4(€€€€€€ð½‘¥Øø4(4(€€€€€í±½…‘¥¹œ€ü€ 4(€€€€€€€€ñ‘¥ØÍÑå±”õíì½±½Èè€Ù…È ´µÑ•áÐµµÕÑ•¤œ°™½¹ÑM¥é”è€œÄÍÁàœõôù1½…‘¥¹œ¸¸¸ð½‘¥Øø4(€€€€€€¤€è€ 4(€€€€€€€€ðø4(€€€€€€€€€ì¼¨€ØMÕµµ…Éä…É‘Ì€¨½ô4(€€€€€€€€€€ñ‘¥ØÍÑå±”õíì‘¥ÍÁ±…äè€É¥œ°É¥‘Q•µÁ±…Ñ•½±Õµ¹Ìè€É•Á•…Ð Ì°€Å™È¤œ°…Àè€œÄÉÁàœ°µ…É¥¹	½ÑÑ½´è€œÈÁÁàœõôø4(€€€€€€€€€€€í…É‘Ì¹µ…À ¡…É°¤¤€ôø€ 4(€€€€€€€€€€€€€€ñ‘¥Ø­•äõí¥ô±…ÍÍ9…µ”õí…É™…‘”µÕÀ™…‘”µÕÀµ‘•±…ä´‘í5…Ñ ¹µ¥¸¡¤€¬€Ä°€Ô¥õôÍÑå±”õíìÁ…‘‘¥¹œè€œÄáÁàœõôø4(€€€€€€€€€€€€€€€€ñ‘¥ØÍÑå±”õíì‘¥ÍÁ±…äè€™±•àœ°…±¥¹%Ñ•µÌè€•¹Ñ•Èœ°©ÕÍÑ¥™å½¹Ñ•¹Ðè€ÍÁ…”µ‰•ÑÝ••¸œ°µ…É¥¹	½ÑÑ½´è€œÄÁÁàœõôø4(€€€€€€€€€€€€€€€€€€ñÍÁ…¸ÍÑå±”õíì™½¹ÑM¥é”è€œÄÁÁàœ°½±½Èè€Ù…È ´µÑ•áÐµµÕÑ•¤œ°™½¹Ñ]•¥¡Ðè€ØÀÀ°Ñ•áÑQÉ…¹Í™½É´è€ÕÁÁ•É…Í”œ°±•ÑÑ•ÉMÁ…¥¹œè€œÀ¸ÀÙ•´œõôø4(€€€€€€€€€€€€€€€€€€€í…É¹±…‰•±ô4(€€€€€€€€€€€€€€€€€€ð½ÍÁ…¸ø4(€€€€€€€€€€€€€€€€€€ñ‘¥ØÍÑå±”õíì½±½Èè…É¹½±½È°½Á…¥Ñäè€À¸Øõôùí…É¹¥½¹ôð½‘¥Øø4(€€€€€€€€€€€€€€€€ð½‘¥Øø4(€€€€€€€€€€€€€€€€ñ‘¥ØÍÑå±”õíì™½¹ÑM¥é”è€œÈÉÁàœ°™½¹Ñ]•¥¡Ðè€ØÀÀ°±•ÑÑ•ÉMÁ…¥¹œè€œ´À¸ÑÁàœ°µ…É¥¹	½ÑÑ½´è€œáÁàœ°™½¹Ñ…µ¥±äè€)•Ñ	É…¥¹Ì5½¹¼°µ½¹½ÍÁ…”œõôø4(€€€€€€€€€€€€€€€€€í…É¹Ù…±Õ•ô4(€€€€€€€€€€€€€€€€ð½‘¥Øø4(€€€€€€€€€€€€€€€€ñ‘¥ØÍÑå±”õíì‘¥ÍÁ±…äè€™±•àœ°…±¥¹%Ñ•µÌè€•¹Ñ•Èœ°©ÕÍÑ¥™å½¹Ñ•¹Ðè€ÍÁ…”µ‰•ÑÝ••¸œõôø4(€€€€€€€€€€€€€€€€€€ñÍÁ…¸ÍÑå±”õíì™½¹ÑM¥é”è€œÄÅÁàœ°½±½Èè€Ù…È ´µÑ•áÐµ‘¥´¤œõôùí…É¹ÍÕ‰ôð½ÍÁ…¸ø4(€€€€€€€€€€€€€€€€€í…É¹ÑÉ•¹€„ôô¹Õ±°€˜˜€ 4(€€€€€€€€€€€€€€€€€€€€ñÍÁ…¸ÍÑå±”õíì4(€€€€€€€€€€€€€€€€€€€€€™½¹ÑM¥é”è€œÄÅÁàœ°™½¹Ñ]•¥¡Ðè€ÔÀÀ°4(€€€€€€€€€€€€€€€€€€€€€½±½Èè…É¹ÑÉ•¹€ø€À€ü€Ù…È ´µÉ••¸¤œ€è…É¹ÑÉ•¹€ð€À€ü€Ù…È ´µÉ•¤œ€è€Ù…È ´µÑ•áÐµµÕÑ•¤œ°4(€€€€€€€€€€€€€€€€€€€€€‘¥ÍÁ±…äè€™±•àœ°…±¥¹%Ñ•µÌè€•¹Ñ•Èœ°…Àè€œÉÁàœ°4(€€€€€€€€€€€€€€€€€€€õôø4(€€€€€€€€€€€€€€€€€€€€€í…É¹ÑÉ•¹€ø€À€ü€ñQÉ•¹‘¥¹UÀÍ¥é”õìÄÅô€¼ø€è…É¹ÑÉ•¹€ð€À€ü€ñQÉ•¹‘¥¹½Ý¸Í¥é”õìÄÅô€¼ø€è€ñ5¥¹ÕÌÍ¥é”õìÄÅô€¼ùô4(€€€€€€€€€€€€€€€€€€€€€í5…Ñ ¹…‰Ì¡…É¹ÑÉ•¹¤¹Ñ½¥á• Ä¥ô”4(€€€€€€€€€€€€€€€€€€€€ð½ÍÁ…¸ø4(€€€€€€€€€€€€€€€€€€¥ô4(€€€€€€€€€€€€€€€€ð½‘¥Øø4(€€€€€€€€€€€€€€ð½‘¥Øø4(€€€€€€€€€€€€¤¥ô4(€€€€€€€€€€ð½‘¥Øø4(4(€€€€€€€€€ì¼¨I•Ù•¹Õ”€¬U¹¥ÑÌ€¡‘Õ…°µ…á¥Ì¤Ý¥Ñ ‰Õ­•Ñ¥¹œÑ½±”€¨½ô4(€€€€€€€€€€ñ‘¥Ø±…ÍÍ9…µ”ô‰…ÉˆÍÑå±”õíìÁ…‘‘¥¹œè€œÈÑÁàœ°µ…É¥¹	½ÑÑ½´è€œÄÑÁàœõôø4(€€€€€€€€€€€€ñ‘¥ØÍÑå±”õíì‘¥ÍÁ±…äè€™±•àœ°…±¥¹%Ñ•µÌè€™±•àµÍÑ…ÉÐœ°©ÕÍÑ¥™å½¹Ñ•¹Ðè€ÍÁ…”µ‰•ÑÝ••¸œ°…Àè€œÄÉÁàœ°µ…É¥¹	½ÑÑ½´è€œÄáÁàœõôø4(€€€€€€€€€€€€€€ñ‘¥Øø4(€€€€€€€€€€€€€€€€ñ‘¥ØÍÑå±”õíì™½¹ÑM¥é”è€œÄÍÁàœ°™½¹Ñ]•¥¡Ðè€ÔÀÀ°µ…É¥¹	½ÑÑ½´è€œÉÁàœ°‘¥ÍÁ±…äè€™±•àœ°…±¥¹%Ñ•µÌè€•¹Ñ•Èœ°…Àè€œÄÉÁàœ°™±•á]É…Àè€ÝÉ…Àœõôø4(€€€€€€€€€€€€€€€€€€ñÍÁ…¸ùí‰Õ­•Ñ‘©ôI•Ù•¹Õ”€™…µÀìU¹¥ÑÌð½ÍÁ…¸ø4(€€€€€€€€€€€€€€€€€€ñÍÁ…¸ÍÑå±”õíì‘¥ÍÁ±…äè€™±•àœ°…±¥¹%Ñ•µÌè€•¹Ñ•Èœ°…Àè€œÕÁàœ°™½¹ÑM¥é”è€œÄÅÁàœ°½±½Èè€Ù…È ´µÑ•áÐµµÕÑ•¤œ°™½¹Ñ]•¥¡Ðè€ÐÀÀõôø4(€€€€€€€€€€€€€€€€€€€€ñÍÁ…¸ÍÑå±”õíìÝ¥‘Ñ è€œáÁàœ°¡•¥¡Ðè€œáÁàœ°‰½É‘•ÉI…‘¥ÕÌè€œÉÁàœ°‰…­É½Õ¹è€Ù…È ´µ¡…ÉÐµÁÉ¥µ…Éä¤œõô€¼øI•Ù•¹Õ”4(€€€€€€€€€€€€€€€€€€ð½ÍÁ…¸ø4(€€€€€€€€€€€€€€€€€€ñÍÁ…¸ÍÑå±”õíì‘¥ÍÁ±…äè€™±•àœ°…±¥¹%Ñ•µÌè€•¹Ñ•Èœ°…Àè€œÕÁàœ°™½¹ÑM¥é”è€œÄÅÁàœ°½±½Èè€Ù…È ´µÑ•áÐµµÕÑ•¤œ°™½¹Ñ]•¥¡Ðè€ÐÀÀõôø4(€€€€€€€€€€€€€€€€€€€€ñÍÁ…¸ÍÑå±”õíìÝ¥‘Ñ è€œáÁàœ°¡•¥¡Ðè€œáÁàœ°‰½É‘•ÉI…‘¥ÕÌè€œÉÁàœ°‰…­É½Õ¹è€Ù…È ´µ¡…ÉÐµÍÕ•ÍÌ¤œõô€¼øU¹¥ÑÌ4(€€€€€€€€€€€€€€€€€€ð½ÍÁ…¸ø4(€€€€€€€€€€€€€€€€€íÍ•±•Ñ•‘AÉ½‘ÕÑÌ¹±•¹Ñ €ø€À€˜˜€ 4(€€€€€€€€€€€€€€€€€€€€ñÍÁ…¸ÍÑå±”õíì™½¹ÑM¥é”è€œÄÅÁàœ°½±½Èè€Ù…È ´µ…•¹Ð¤œõôø4(€€€€€€€€€€€€€€€€€€€€€íÍ•±•Ñ•‘AÉ½‘ÕÑÌ¹±•¹Ñ¡ôÁÉ½‘ÕÑíÍ•±•Ñ•‘AÉ½‘ÕÑÌ¹±•¹Ñ €ø€Ä€ü€Ìœ€è€œôÍ•±•Ñ•4(€€€€€€€€€€€€€€€€€€€€ð½ÍÁ…¸ø4(€€€€€€€€€€€€€€€€€€¥ô4(€€€€€€€€€€€€€€€€ð½‘¥Øø4(€€€€€€€€€€€€€€€€ñ‘¥ØÍÑå±”õíì™½¹ÑM¥é”è€œÄÅÁàœ°½±½Èè€Ù…È ´µÑ•áÐµµÕÑ•¤œõôø4(€€€€€€€€€€€€€€€€€UMƒ
Üí‘…Ñ•I…¹”€˜˜‘…Ñ•I…¹”¹ÍÑ…ÉÑ…Ñ”€ü€‘í™µÑ…Ñ•1…‰•°¡‘…Ñ•I…¹”¹ÍÑ…ÉÑ…Ñ”¥ôƒŠP€‘í™µÑ…Ñ•1…‰•°¡‘…Ñ•I…¹”¹•¹‘…Ñ”¥õ€€èÉ…¹•1…‰•±ô4(€€€€€€€€€€€€€€€€ð½‘¥Øø4(€€€€€€€€€€€€€€ð½‘¥Øø4(€€€€€€€€€€€€€ì¼¨¡…ÉÐµ½¹±ä‰Õ­•Ñ¥¹œ½¹ÑÉ½°€¨½ô4(€€€€€€€€€€€€€€ñ‘¥ØÍÑå±”õíì‘¥ÍÁ±…äè€™±•àœ°…Àè€œÑÁàœ°™±•áM¡É¥¹¬è€Àõôø4(€€€€€€€€€€€€€€€ì¡l‘…äœ°€Ý••¬œ°€µ½¹Ñ t…Ì½¹ÍÐ¤¹µ…À¡ˆ€ôø€ 4(€€€€€€€€€€€€€€€€€€ñ‰ÕÑÑ½¸­•äõí‰ô½¹±¥¬õì ¤€ôøÍ•Ñ¡…ÉÑ	Õ­•Ð¡ˆ¥ôÍÑå±”õíì4(€€€€€€€€€€€€€€€€€€€Á…‘‘¥¹œè€œÍÁà€ÄÁÁàœ°‰½É‘•ÉI…‘¥ÕÌè€œÕÁàœ°™½¹ÑM¥é”è€œÄÁÁàœ°™½¹Ñ]•¥¡Ðè€ÔÀÀ°4(€€€€€€€€€€€€€€€€€€€ÕÉÍ½Èè€Á½¥¹Ñ•Èœ°ÑÉ…¹Í¥Ñ¥½¸è€…±°€À¸ÄÉÌ•…Í”œ°4(€€€€€€€€€€€€€€€€€€€‰½É‘•Èè¡…ÉÑ	Õ­•Ð€ôôôˆ€ü€œÅÁàÍ½±¥Ù…È ´µ…•¹Ðµ‰½É‘•È¤œ€è€œÅÁàÍ½±¥Ù…È ´µ‰½É‘•È¤œ°4(€€€€€€€€€€€€€€€€€€€‰…­É½Õ¹è¡…ÉÑ	Õ­•Ð€ôôôˆ€ü€Ù…È ´µ…•¹Ðµ±¥¡Ð¤œ€è€ÑÉ…¹ÍÁ…É•¹Ðœ°4(€€€€€€€€€€€€€€€€€€€½±½Èè¡…ÉÑ	Õ­•Ð€ôôôˆ€ü€Ù…È ´µ…•¹Ð¤œ€è€Ù…È ´µÑ•áÐµµÕÑ•¤œ°4(€€€€€€€€€€€€€€€€€õôùíˆ€ôôô€‘…äœ€ü€…¥±äœ€èˆ€ôôô€Ý••¬œ€ü€]••­±äœ€è€5½¹Ñ¡±äôð½‰ÕÑÑ½¸ø4(€€€€€€€€€€€€€€€€¤¥ô4(€€€€€€€€€€€€€€ð½‘¥Øø4(€€€€€€€€€€€€ð½‘¥Øø4(€€€€€€€€€€€€ñI•ÍÁ½¹Í¥Ù•½¹Ñ…¥¹•ÈÝ¥‘Ñ ôˆÄÀÀ”ˆ¡•¥¡ÐõìÈÐÁôø4(€€€€€€€€€€€€€€ñ½µÁ½Í•‘¡…ÉÐ‘…Ñ„õí¡…ÉÑ…Ñ…ôø4(€€€€€€€€€€€€€€€€ñ‘•™Ìø4(€€€€€€€€€€€€€€€€€€ñ±¥¹•…ÉÉ…‘¥•¹Ð¥ô‰É•ÙÉ…ˆàÄôˆÀˆäÄôˆÀˆàÈôˆÀˆäÈôˆÄˆø4(€€€€€€€€€€€€€€€€€€€€ñÍÑ½À½™™Í•ÐôˆÔ”ˆÍÑ½Á½±½Èô‰Ù…È ´µ¡…ÉÐµÁÉ¥µ…Éä¤ˆÍÑ½Á=Á…¥ÑäõìÅô€¼ø4(€€€€€€€€€€€€€€€€€€€€ñÍÑ½À½™™Í•ÐôˆäÔ”ˆÍÑ½Á½±½Èô‰Ù…È ´µ¡…ÉÐµÁÉ¥µ…Éä¤ˆÍÑ½Á=Á…¥ÑäõìÁô€¼ø4(€€€€€€€€€€€€€€€€€€ð½±¥¹•…ÉÉ…‘¥•¹Ðø4(€€€€€€€€€€€€€€€€ð½‘•™Ìø4(€€€€€€€€€€€€€€€€ñ…ÉÑ•Í¥…¹É¥ÍÑÉ½­•…Í¡…ÉÉ…äôˆÌ€ÌˆÍÑÉ½­”ô‰Ù…È ´µ‰½É‘•È¤ˆÙ•ÉÑ¥…°õí™…±Í•ô€¼ø4(€€€€€€€€€€€€€€€€ñaá¥Ì‘…Ñ…-•äô‰±…‰•°ˆÑ¥¬õíì™½¹ÑM¥é”è€ÄÀ°™¥±°è€Ù…È ´µÑ•áÐµ‘¥´¤œõôÑ¥­1¥¹”õí™…±Í•ô…á¥Í1¥¹”õí™…±Í•ô¥¹Ñ•ÉÙ…°ô‰ÁÉ•Í•ÉÙ•MÑ…ÉÑ¹ˆ€¼ø4(€€€€€€€€€€€€€€€€ñeá¥Ìåá¥Í%ô‰É•ØˆÑ¥¬õíì™½¹ÑM¥é”è€ÄÀ°™¥±°è€Ù…È ´µÑ•áÐµ‘¥´¤œõôÑ¥­1¥¹”õí™…±Í•ô…á¥Í1¥¹”õí™…±Í•ôÑ¥­½Éµ…ÑÑ•ÈõíØ€ôø€œœ€¬™µÐ¡Ø¥ôÝ¥‘Ñ õìØÁô€¼ø4(€€€€€€€€€€€€€€€€ñeá¥Ìåá¥Í%ô‰Õ¹¥ÑÌˆ½É¥•¹Ñ…Ñ¥½¸ô‰É¥¡ÐˆÑ¥¬õíì™½¹ÑM¥é”è€ÄÀ°™¥±°è€Ù…È ´µÑ•áÐµ‘¥´¤œõôÑ¥­1¥¹”õí™…±Í•ô…á¥Í1¥¹”õí™…±Í•ôÑ¥­½Éµ…ÑÑ•ÈõíØ€ôø™µÐ¡Ø¥ôÝ¥‘Ñ õìÔÁô€¼ø4(€€€€€€€€€€€€€€€€ñQ½½±Ñ¥À½¹Ñ•¹ÐõìñÕÍÑ½µQ½½±Ñ¥À€¼ùô€¼ø4(€€€€€€€€€€€€€€€€ñÉ•„åá¥Í%ô‰É•ØˆÑåÁ”ô‰µ½¹½Ñ½¹”ˆ‘…Ñ…-•äô‰Ñ½Ñ…±}É•Ù•¹Õ”ˆ¹…µ”ô‰I•Ù•¹Õ”ˆÍÑÉ½­”ô‰Ù…È ´µ¡…ÉÐµÁÉ¥µ…Éä¤ˆÍÑÉ½­•]¥‘Ñ õìÄ¸Õô™¥±°ô‰ÕÉ° É•ÙÉ…¤ˆ‘½Ðõí™…±Í•ô€¼ø4(€€€€€€€€€€€€€€€€ñ1¥¹”åá¥Í%ô‰Õ¹¥ÑÌˆÑåÁ”ô‰µ½¹½Ñ½¹”ˆ‘…Ñ…-•äô‰Ñ½Ñ…±}Õ¹¥ÑÌˆ¹…µ”ô‰U¹¥ÑÌˆÍÑÉ½­”ô‰Ù…È ´µ¡…ÉÐµÍÕ•ÍÌ¤ˆÍÑÉ½­•]¥‘Ñ õìÄ¸Õô‘½Ðõí™…±Í•ô€¼ø4(€€€€€€€€€€€€€€ð½½µÁ½Í•‘¡…ÉÐø4(€€€€€€€€€€€€ð½I•ÍÁ½¹Í¥Ù•½¹Ñ…¥¹•Èø4(€€€€€€€€€€ð½‘¥Øø4(4(€€€€€€€€€ì¼¨M•ÍÍ¥½¹Ì€¬½¹Ù•ÉÍ¥½¸É…Ñ”½Ù•ÈÑ¥µ”€¨½ô4(€€€€€€€€€€ñ‘¥ØÍÑå±”õíì‘¥ÍÁ±…äè€É¥œ°É¥‘Q•µÁ±…Ñ•½±Õµ¹Ìè€œÅ™È€Å™Èœ°…Àè€œÄÑÁàœ°µ…É¥¹	½ÑÑ½´è€œÈÁÁàœõôø4(€€€€€€€€€€€€ñ‘¥Ø±…ÍÍ9…µ”ô‰…ÉˆÍÑå±”õíìÁ…‘‘¥¹œè€œÈÑÁàœõôø4(€€€€€€€€€€€€€€ñ‘¥ØÍÑå±”õíìµ…É¥¹	½ÑÑ½´è€œÄáÁàœõôø4(€€€€€€€€€€€€€€€€ñ‘¥ØÍÑå±”õíì™½¹ÑM¥é”è€œÄÍÁàœ°™½¹Ñ]•¥¡Ðè€ÔÀÀ°µ…É¥¹	½ÑÑ½´è€œÉÁàœõôùM•ÍÍ¥½¹Ì½Ù•ÈÑ¥µ”ð½‘¥Øø4(€€€€€€€€€€€€€€€€ñ‘¥ØÍÑå±”õíì™½¹ÑM¥é”è€œÄÅÁàœ°½±½Èè€Ù…È ´µÑ•áÐµµÕÑ•¤œõôùí‰Õ­•Ñ‘©ôƒ
Ü…±°Í•±•Ñ•µ…É­•ÑÁ±…•Ì½µ‰¥¹•ð½‘¥Øø4(€€€€€€€€€€€€€€ð½‘¥Øø4(€€€€€€€€€€€€€€ñI•ÍÁ½¹Í¥Ù•½¹Ñ…¥¹•ÈÝ¥‘Ñ ôˆÄÀÀ”ˆ¡•¥¡ÐõìÈÀÁôø4(€€€€€€€€€€€€€€€€ñÉ•…¡…ÉÐ‘…Ñ„õí¡…ÉÑ…Ñ…ôø4(€€€€€€€€€€€€€€€€€€ñ‘•™Ìø4(€€€€€€€€€€€€€€€€€€€€ñ±¥¹•…ÉÉ…‘¥•¹Ð¥ô‰Í•ÍÍÉ…ˆàÄôˆÀˆäÄôˆÀˆàÈôˆÀˆäÈôˆÄˆø4(€€€€€€€€€€€€€€€€€€€€€€ñÍÑ½À½™™Í•ÐôˆÔ”ˆÍÑ½Á½±½Èô‰Ù…È ´µå•±±½Ü¤ˆÍÑ½Á=Á…¥ÑäõìÀ¸åô€¼ø4(€€€€€€€€€€€€€€€€€€€€€€ñÍÑ½À½™™Í•ÐôˆäÔ”ˆÍÑ½Á½±½Èô‰Ù…È ´µå•±±½Ü¤ˆÍÑ½Á=Á…¥ÑäõìÁô€¼ø4(€€€€€€€€€€€€€€€€€€€€ð½±¥¹•…ÉÉ…‘¥•¹Ðø4(€€€€€€€€€€€€€€€€€€ð½‘•™Ìø4(€€€€€€€€€€€€€€€€€€ñ…ÉÑ•Í¥…¹É¥ÍÑÉ½­•…Í¡…ÉÉ…äôˆÌ€ÌˆÍÑÉ½­”ô‰Ù…È ´µ‰½É‘•È¤ˆÙ•ÉÑ¥…°õí™…±Í•ô€¼ø4(€€€€€€€€€€€€€€€€€€ñaá¥Ì‘…Ñ…-•äô‰±…‰•°ˆÑ¥¬õíì™½¹ÑM¥é”è€ÄÀ°™¥±°è€Ù…È ´µÑ•áÐµ‘¥´¤œõôÑ¥­1¥¹”õí™…±Í•ô…á¥Í1¥¹”õí™…±Í•ô¥¹Ñ•ÉÙ…°ô‰ÁÉ•Í•ÉÙ•MÑ…ÉÑ¹ˆ€¼ø4(€€€€€€€€€€€€€€€€€€ñeá¥ÌÑ¥¬õíì™½¹ÑM¥é”è€ÄÀ°™¥±°è€Ù…È ´µÑ•áÐµ‘¥´¤œõôÑ¥­1¥¹”õí™…±Í•ô…á¥Í1¥¹”õí™…±Í•ôÑ¥­½Éµ…ÑÑ•ÈõíØ€ôø™µÐ¡Ø¥ôÝ¥‘Ñ õìÔÁô€¼ø4(€€€€€€€€€€€€€€€€€€ñQ½½±Ñ¥À½¹Ñ•¹ÐõìñÕÍÑ½µQ½½±Ñ¥À€¼ùô€¼ø4(€€€€€€€€€€€€€€€€€€ñÉ•„ÑåÁ”ô‰µ½¹½Ñ½¹”ˆ‘…Ñ…-•äô‰Ñ½Ñ…±}Í•ÍÍ¥½¹Ìˆ¹…µ”ô‰M•ÍÍ¥½¹ÌˆÍÑÉ½­”ô‰Ù…È ´µå•±±½Ü¤ˆÍÑÉ½­•]¥‘Ñ õìÄ¸Õô™¥±°ô‰ÕÉ° Í•ÍÍÉ…¤ˆ‘½Ðõí™…±Í•ô€¼ø4(€€€€€€€€€€€€€€€€ð½É•…¡…ÉÐø4(€€€€€€€€€€€€€€ð½I•ÍÁ½¹Í¥Ù•½¹Ñ…¥¹•Èø4(€€€€€€€€€€€€ð½‘¥Øø4(4(€€€€€€€€€€€€ñ‘¥Ø±…ÍÍ9…µ”ô‰…ÉˆÍÑå±”õíìÁ…‘‘¥¹œè€œÈÑÁàœõôø4(€€€€€€€€€€€€€€ñ‘¥ØÍÑå±”õíìµ…É¥¹	½ÑÑ½´è€œÄáÁàœõôø4(€€€€€€€€€€€€€€€€ñ‘¥ØÍÑå±”õíì™½¹ÑM¥é”è€œÄÍÁàœ°™½¹Ñ]•¥¡Ðè€ÔÀÀ°µ…É¥¹	½ÑÑ½´è€œÉÁàœõôù½¹Ù•ÉÍ¥½¸É…Ñ”½Ù•ÈÑ¥µ”ð½‘¥Øø4(€€€€€€€€€€€€€€€€ñ‘¥ØÍÑå±”õíì™½¹ÑM¥é”è€œÄÅÁàœ°½±½Èè€Ù…È ´µÑ•áÐµµÕÑ•¤œõôùí‰Õ­•Ñ‘©ôƒ
ÜÕ¹¥ÑÌƒÜÍ•ÍÍ¥½¹Ìð½‘¥Øø4(€€€€€€€€€€€€€€ð½‘¥Øø4(€€€€€€€€€€€€€€ñI•ÍÁ½¹Í¥Ù•½¹Ñ…¥¹•ÈÝ¥‘Ñ ôˆÄÀÀ”ˆ¡•¥¡ÐõìÈÀÁôø4(€€€€€€€€€€€€€€€€ñÉ•…¡…ÉÐ‘…Ñ„õí¡…ÉÑ…Ñ…ôø4(€€€€€€€€€€€€€€€€€€ñ‘•™Ìø4(€€€€€€€€€€€€€€€€€€€€ñ±¥¹•…ÉÉ…‘¥•¹Ð¥ô‰½¹ÙÉ…ˆàÄôˆÀˆäÄôˆÀˆàÈôˆÀˆäÈôˆÄˆø4(€€€€€€€€€€€€€€€€€€€€€€ñÍÑ½À½™™Í•ÐôˆÔ”ˆÍÑ½Á½±½ÈôˆÐàääˆÍÑ½Á=Á…¥ÑäõìÀ¸åô€¼ø4(€€€€€€€€€€€€€€€€€€€€€€ñÍÑ½À½™™Í•ÐôˆäÔ”ˆÍÑ½Á½±½ÈôˆÐàääˆÍÑ½Á=Á…¥ÑäõìÁô€¼ø4(€€€€€€€€€€€€€€€€€€€€ð½±¥¹•…ÉÉ…‘¥•¹Ðø4(€€€€€€€€€€€€€€€€€€ð½‘•™Ìø4(€€€€€€€€€€€€€€€€€€ñ…ÉÑ•Í¥…¹É¥ÍÑÉ½­•…Í¡…ÉÉ…äôˆÌ€ÌˆÍÑÉ½­”ô‰Ù…È ´µ‰½É‘•È¤ˆÙ•ÉÑ¥…°õí™…±Í•ô€¼ø4(€€€€€€€€€€€€€€€€€€ñaá¥Ì‘…Ñ…-•äô‰±…‰•°ˆÑ¥¬õíì™½¹ÑM¥é”è€ÄÀ°™¥±°è€Ù…È ´µÑ•áÐµ‘¥´¤œõôÑ¥­1¥¹”õí™…±Í•ô…á¥Í1¥¹”õí™…±Í•ô¥¹Ñ•ÉÙ…°ô‰ÁÉ•Í•ÉÙ•MÑ…ÉÑ¹ˆ€¼ø4(€€€€€€€€€€€€€€€€€€ñeá¥ÌÑ¥¬õíì™½¹ÑM¥é”è€ÄÀ°™¥±°è€Ù…È ´µÑ•áÐµ‘¥´¤œõôÑ¥­1¥¹”õí™…±Í•ô…á¥Í1¥¹”õí™…±Í•ôÑ¥­½Éµ…ÑÑ•ÈõíØ€ôøØ¹Ñ½¥á• Ä¤€¬€œ”ôÝ¥‘Ñ õìÔÁô€¼ø4(€€€€€€€€€€€€€€€€€€ñQ½½±Ñ¥À½¹Ñ•¹ÐõìñÕÍÑ½µQ½½±Ñ¥À€¼ùô€¼ø4(€€€€€€€€€€€€€€€€€€ñÉ•„ÑåÁ”ô‰µ½¹½Ñ½¹”ˆ‘…Ñ…-•äô‰½¹Ù}É…Ñ”ˆ¹…µ”ô‰½¹Ù•ÉÍ¥½¸I…Ñ”ˆÍÑÉ½­”ôˆÐàääˆÍÑÉ½­•]¥‘Ñ õìÄ¸Õô™¥±°ô‰ÕÉ° ½¹ÙÉ…¤ˆ‘½Ðõí™…±Í•ô€¼ø4(€€€€€€€€€€€€€€€€ð½É•…¡…ÉÐø4(€€€€€€€€€€€€€€ð½I•ÍÁ½¹Í¥Ù•½¹Ñ…¥¹•Èø4(€€€€€€€€€€€€ð½‘¥Øø4(€€€€€€€€€€ð½‘¥Øø4(4(€€€€€€€€€ì¼¨Q½Ñ…°M…±•Ì	É•…­‘½Ý¸€¨½ô4(€€€€€€€€€€ñ‘¥Ø±…ÍÍ9…µ”ô‰…ÉˆÍÑå±”õíìÁ…‘‘¥¹œè€œÈÑÁàœõôø4(€€€€€€€€€€€€ñ‘¥ØÍÑå±”õíìµ…É¥¹	½ÑÑ½´è€œÄÙÁàœõôø4(€€€€€€€€€€€€€€ñ‘¥ØÍÑå±”õíì™½¹ÑM¥é”è€œÄÍÁàœ°™½¹Ñ]•¥¡Ðè€ÔÀÀ°µ…É¥¹	½ÑÑ½´è€œÉÁàœõôùQ½Ñ…°M…±•Ì	É•…­‘½Ý¸ð½‘¥Øø4(€€€€€€€€€€€€€€ñ‘¥ØÍÑå±”õíì™½¹ÑM¥é”è€œÄÅÁàœ°½±½Èè€Ù…È ´µÑ•áÐµµÕÑ•¤œõôø4(€€€€€€€€€€€€€€€¥¹…¹”Í•ÑÑ±•µ•¹Ð@™…µÀí0€¡UM¤ƒ
Ü€™±‘ÅÕ¼íÉ½ÍÌÍ…±•Ì™É‘ÅÕ¼ì¡•É”¥ÌÍ•ÑÑ±•µ•¹ÐÁÉ½‘ÕÐ¡…É•Ì°4(€€€€€€€€€€€€€€€‘¥ÍÑ¥¹Ð™É½´Ñ¡”½É‘•É•µÉ•Ù•¹Õ”-A$…‰½Ù”4(€€€€€€€€€€€€€€ð½‘¥Øø4(€€€€€€€€€€€€ð½‘¥Øø4(4(€€€€€€€€€€€íÍ­Õ¥±Ñ•ÉÑ¥Ù”€ü€ 4(€€€€€€€€€€€€€€ñ‘¥ØÍÑå±”õíì™½¹ÑM¥é”è€œÄÉÁàœ°½±½Èè€Ù…È ´µÑ•áÐµµÕÑ•¤œ°±¥¹•!•¥¡Ðè€Ä¸Ø°Á…‘‘¥¹œè€œÄÁÁà€Àœõôø4(€€€€€€€€€€€€€€€Q½Ñ…°M…±•Ì	É•…­‘½Ý¸É•™±•ÑÌå½ÕÈÝ¡½±”…½Õ¹ÐìÁ•ÈµM-T@™…µÀí0¥Í¸™ÉÍÅÕ¼íÐ…Ù…¥±…‰±”å•Ð¸4(€€€€€€€€€€€€€€€±•…ÈÑ¡”ÁÉ½‘ÕÐ™¥±Ñ•ÈÑ¼Í•”Ñ¡”…½Õ¹Ðµ±•Ù•°‰É•…­‘½Ý¸¸4(€€€€€€€€€€€€€€ð½‘¥Øø4(€€€€€€€€€€€€¤€è™¥¹…¹•ÉÉ½È€ü€ 4(€€€€€€€€€€€€€€ñ‘¥ØÍÑå±”õíì™½¹ÑM¥é”è€œÄÉÁàœ°½±½Èè€Ù…È ´µÑ•áÐµµÕÑ•¤œ°±¥¹•!•¥¡Ðè€Ä¸Ø°Á…‘‘¥¹œè€œÄÁÁà€Àœõôø4(€€€€€€€€€€€€€€€½Õ±‘¸™ÉÍÅÕ¼íÐ±½…Ñ¡”™¥¹…¹”‰É•…­‘½Ý¸™½ÈÑ¡¥ÌÁ•É¥½™µ‘…Í íÑ¡”É•ÅÕ•ÍÐÑ¥µ•½ÕÐ½È™…¥±•¸4(€€€€€€€€€€€€€€€Q¡¥Ì‘½•Í¸™ÉÍÅÕ¼íÐµ•…¸Ñ¡”‘…Ñ„¥Ìµ¥ÍÍ¥¹œìÑÉä……¥¸°½È¹…ÉÉ½ÜÑ¡”‘…Ñ”É…¹”¸4(€€€€€€€€€€€€€€ð½‘¥Øø4(€€€€€€€€€€€€¤€è€…¡…Í¥¹…¹”€ü€ 4(€€€€€€€€€€€€€€ñ‘¥ØÍÑå±”õíì™½¹ÑM¥é”è€œÄÉÁàœ°½±½Èè€Ù…È ´µÑ•áÐµµÕÑ•¤œ°±¥¹•!•¥¡Ðè€Ä¸Ø°Á…‘‘¥¹œè€œÄÁÁà€Àœõôø4(€€€€€€€€€€€€€€€9¼™¥¹…¹”‘…Ñ„™½ÈÑ¡”Í•±•Ñ•Á•É¥½¸4(€€€€€€€€€€€€€€ð½‘¥Øø4(€€€€€€€€€€€€¤€è€ 4(€€€€€€€€€€€€€€ðø4(€€€€€€€€€€€€€€€€ñ‘¥Øø4(€€€€€€€€€€€€€€€€€íÍ…±•Í	É•…­‘½Ý¸¹µ…À ¡É½Ü°¤¤€ôøì4(€€€€€€€€€€€€€€€€€€€½¹ÍÐ¥ÍA±…•¡½±‘•È€ôÉ½Ü¹Ù…±Õ”€ôôô¹Õ±°4(€€€€€€€€€€€€€€€€€€€É•ÑÕÉ¸€ 4(€€€€€€€€€€€€€€€€€€€€€€ñ‘¥Ø­•äõíÉ½Ü¹±…‰•±ôÍÑå±”õíì4(€€€€€€€€€€€€€€€€€€€€€€€‘¥ÍÁ±…äè€™±•àœ°…±¥¹%Ñ•µÌè€•¹Ñ•Èœ°©ÕÍÑ¥™å½¹Ñ•¹Ðè€ÍÁ…”µ‰•ÑÝ••¸œ°…Àè€œÄÉÁàœ°4(€€€€€€€€€€€€€€€€€€€€€€€Á…‘‘¥¹œè€œåÁà€Àœ°4(€€€€€€€€€€€€€€€€€€€€€€€‰½É‘•É	½ÑÑ½´è¤€ðÍ…±•Í	É•…­‘½Ý¸¹±•¹Ñ €´€Ä€ü€œÅÁàÍ½±¥Ù…È ´µ‰½É‘•È¤œ€è€¹½¹”œ°4(€€€€€€€€€€€€€€€€€€€€€€€½Á…¥Ñäè¥ÍA±…•¡½±‘•È€ü€À¸ÔÔ€è€Ä°4(€€€€€€€€€€€€€€€€€€€€€õôø4(€€€€€€€€€€€€€€€€€€€€€€€€ñÍÁ…¸ÍÑå±”õíì4(€€€€€€€€€€€€€€€€€€€€€€€€€™½¹ÑM¥é”è€œÄÉÁàœ°‘¥ÍÁ±…äè€™±•àœ°…±¥¹%Ñ•µÌè€•¹Ñ•Èœ°…Àè€œáÁàœ°4(€€€€€€€€€€€€€€€€€€€€€€€€€™½¹Ñ]•¥¡ÐèÉ½Ü¹ÍÑÉ½¹œ€ü€ØÀÀ€è€ÐÀÀ°4(€€€€€€€€€€€€€€€€€€€€€€€€€½±½ÈèÉ½Ü¹ÍÑÉ½¹œ€ü€Ù…È ´µÑ•áÐµÁÉ¥µ…Éä¤œ€è€Ù…È ´µÑ•áÐµµÕÑ•¤œ°4(€€€€€€€€€€€€€€€€€€€€€€€õôø4(€€€€€€€€€€€€€€€€€€€€€€€€€íÉ½Ü¹±…‰•±ô4(€€€€€€€€€€€€€€€€€€€€€€€€€íÉ½Ü¹¡¥¹Ð€˜˜€ 4(€€€€€€€€€€€€€€€€€€€€€€€€€€€€ñÍÁ…¸ÍÑå±”õíì™½¹ÑM¥é”è€œÄÁÁàœ°½±½Èè€Ù…È ´µÑ•áÐµ‘¥´¤œ°™½¹ÑMÑå±”è€¥Ñ…±¥Œœõôø4(€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€¡íÉ½Ü¹¡¥¹Ñô¤4(€€€€€€€€€€€€€€€€€€€€€€€€€€€€ð½ÍÁ…¸ø4(€€€€€€€€€€€€€€€€€€€€€€€€€€¥ô4(€€€€€€€€€€€€€€€€€€€€€€€€€íÉ½Ü¹±¥Ù”€˜˜€ 4(€€€€€€€€€€€€€€€€€€€€€€€€€€€€ñÍÁ…¸ÍÑå±”õíì4(€€€€€€€€€€€€€€€€€€€€€€€€€€€€€™½¹ÑM¥é”è€œåÁàœ°™½¹Ñ]•¥¡Ðè€ØÀÀ°±•ÑÑ•ÉMÁ…¥¹œè€œÀ¸ÀÑ•´œ°4(€€€€€€€€€€€€€€€€€€€€€€€€€€€€€½±½Èè€Ù…È ´µÉ••¸¤œ°‰…­É½Õ¹è€Ù…È ´µÉ••¸µ±¥¡Ð¤œ°4(€€€€€€€€€€€€€€€€€€€€€€€€€€€€€‰½É‘•ÉI…‘¥ÕÌè€œÑÁàœ°Á…‘‘¥¹œè€œÅÁà€ÙÁàœ°Ñ•áÑQÉ…¹Í™½É´è€ÕÁÁ•É…Í”œ°4(€€€€€€€€€€€€€€€€€€€€€€€€€€€õôù1¥Ù”ð½ÍÁ…¸ø4(€€€€€€€€€€€€€€€€€€€€€€€€€€¥ô4(€€€€€€€€€€€€€€€€€€€€€€€€ð½ÍÁ…¸ø4(€€€€€€€€€€€€€€€€€€€€€€€í¥ÍA±…•¡½±‘•È€ü€ 4(€€€€€€€€€€€€€€€€€€€€€€€€€€ñÍÁ…¸ÍÑå±”õíì™½¹ÑM¥é”è€œÄÅÁàœ°½±½Èè€Ù…È ´µÑ•áÐµ‘¥´¤œ°™½¹ÑMÑå±”è€¥Ñ…±¥Œœõôø4(€€€€€€€€€€€€€€€€€€€€€€€€€€€9½Ðå•ÐÑÉ…­•4(€€€€€€€€€€€€€€€€€€€€€€€€€€ð½ÍÁ…¸ø4(€€€€€€€€€€€€€€€€€€€€€€€€¤€è€ 4(€€€€€€€€€€€€€€€€€€€€€€€€€€ñÍÁ…¸ÍÑå±”õíì4(€€€€€€€€€€€€€€€€€€€€€€€€€€€™½¹ÑM¥é”è€œÄÍÁàœ°™½¹Ñ]•¥¡ÐèÉ½Ü¹ÍÑÉ½¹œ€ü€ÜÀÀ€è€ØÀÀ°4(€€€€€€€€€€€€€€€€€€€€€€€€€€€½±½Èè€Ù…È ´µÑ•áÐµÁÉ¥µ…Éä¤œ°™½¹Ñ…µ¥±äè€)•Ñ	É…¥¹Ì5½¹¼°µ½¹½ÍÁ…”œ°4(€€€€€€€€€€€€€€€€€€€€€€€€€õôø4(€€€€€€€€€€€€€€€€€€€€€€€€€€€í™µÑÕÉÉ•¹ä¡É½Ü¹Ù…±Õ”…Ì¹Õµ‰•È¥ô4(€€€€€€€€€€€€€€€€€€€€€€€€€€ð½ÍÁ…¸ø4(€€€€€€€€€€€€€€€€€€€€€€€€¥ô4(€€€€€€€€€€€€€€€€€€€€€€ð½‘¥Øø4(€€€€€€€€€€€€€€€€€€€€¤4(€€€€€€€€€€€€€€€€€ô¥ô4(€€€€€€€€€€€€€€€€ð½‘¥Øø4(4(€€€€€€€€€€€€€€€íÑ½Ñ…±•™•ÉÉ•€ø€À€˜˜€ 4(€€€€€€€€€€€€€€€€€€ñ‘¥ØÍÑå±”õíìµ…É¥¹Q½Àè€œÄÉÁàœ°™½¹ÑM¥é”è€œÄÅÁàœ°½±½Èè€Ù…È ´µå•±±½Ü¤œ°±¥¹•!•¥¡Ðè€Ä¸Ôõôø4(€€€€€€€€€€€€€€€€€€€í™µÑU¹¥ÑÌ¡Ñ½Ñ…±•™•ÉÉ•¥ô•Ù•¹ÑíÑ½Ñ…±•™•ÉÉ•€ôôô€Ä€ü€œœ€è€Ìô¥¸Ñ¡¥ÌÉ…¹•ìœ€ô4(€€€€€€€€€€€€€€€€€€€íÑ½Ñ…±•™•ÉÉ•€ôôô€Ä€ü€¥Ìœ€è€…É”ô¹½Ðå•ÐÍ•ÑÑ±•€¡‘•™•ÉÉ•¤ìÑ¡•Í”™¥ÕÉ•Ìµ…ä¡…¹”…ÌÑ¡•ä™¥¹…±¥é”¸4(€€€€€€€€€€€€€€€€€€ð½‘¥Øø4(€€€€€€€€€€€€€€€€¥ô4(4(€€€€€€€€€€€€€€€€ñ‘¥ØÍÑå±”õíìµ…É¥¹Q½Àè€œÄÑÁàœ°™½¹ÑM¥é”è€œÄÅÁàœ°½±½Èè€Ù…È ´µÑ•áÐµ‘¥´¤œ°±¥¹•!•¥¡Ðè€Ä¸Ôõôø4(€€€€€€€€€€€€€€€€€=L…¹‰½ÑÑ½´µ±¥¹”ÁÉ½™¥Ð…É”¹½Ðå•ÐÑÉ…­•€¡=L¥Ì¹½Ð¥¸Ñ¡”™¥¹…¹”™••¤¸4(€€€€€€€€€€€€€€€€ð½‘¥Øø4(€€€€€€€€€€€€€€ð¼ø4(€€€€€€€€€€€€¥ô4(€€€€€€€€€€ð½‘¥Øø4(€€€€€€€€ð¼ø4(€€€€€€¥ô4(€€€€ð½‘¥Øø4(€€¤4)ô4(