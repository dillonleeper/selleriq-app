'use client'

import { useEffect, useState, useRef } from 'react'
import { supabase } from '@/lib/supabase'
import { searchProducts } from '@/lib/productSearch'
import MarketplaceFilter from '@/components/MarketplaceFilter'
import DateRangeFilter, { DateRange, PRESET_LABELS } from '@/components/DateRangeFilter'
import SalesOverviewInsights, { InventoryRisk, MarketDriver, SkuDriver } from '@/components/SalesOverviewInsights'
import SalesKpiHierarchy from '@/components/SalesKpiHierarchy'
import {
  Area, XAxis, YAxis, CartesianGrid,
  Tooltip, ResponsiveContainer,
  ComposedChart, AreaChart, Line
} from 'recharts'
import { LoaderCircle, RefreshCw, Search, X } from 'lucide-react'

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

type ComparisonMode = 'previous_period' | 'previous_year'
type MarketFreshness = { marketplace: string; first_date: string | null; data_through: string | null }
type OverviewMeta = {
  first_date: string | null
  data_through: string | null
  comparison_complete: boolean
  market_freshness: MarketFreshness[]
  currency: 'USD'
  fx_method: 'effective_dated'
}
type OverviewSummary = {
  buy_box_pct: number | string | null
  prior_buy_box_pct: number | string | null
  selling_skus: number | string | null
}
type SkuSummaryRpcRow = {
  sku: string
  title: string
  sessions: number | string | null
  units: number | string | null
  revenue: number | string | null
  conv_rate: number | string | null
  buy_box_pct: number | string | null
  prev_sessions: number | string | null
  prev_units: number | string | null
  prev_revenue: number | string | null
}

// One P&L line from the get_finance_pnl RPC (dev). Amounts are already USD
// (server-side effective-dated conversion — do not convert again in the client).
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
// Exact integer with comma separators — for unit counts (e.g. 11,807).
function fmtUnits(n: number) {
  return Math.round(n).toLocaleString('en-US')
}
function fmtCurrency(n: number) {
  // Sign-aware: negatives render as -$X (fees/refunds). Non-negative is unchanged.
  const abs = Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 })
  return (n < 0 ? '-$' : '$') + abs
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

function addDaysKey(dateStr: string, days: number): string {
  const d = new Date(dateStr + 'T12:00:00')
  d.setDate(d.getDate() + days)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function yearShiftKey(dateStr: string, years: number): string {
  const d = new Date(dateStr + 'T12:00:00')
  const month = d.getMonth()
  d.setFullYear(d.getFullYear() + years)
  if (d.getMonth() !== month) d.setDate(0)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function comparisonWindow(startDate: string, endDate: string, mode: ComparisonMode) {
  if (mode === 'previous_year') {
    return { priorStart: yearShiftKey(startDate, -1), priorEnd: yearShiftKey(endDate, -1) }
  }
  const days = Math.round((new Date(endDate + 'T12:00:00').getTime() - new Date(startDate + 'T12:00:00').getTime()) / 86_400_000) + 1
  const priorEnd = addDaysKey(startDate, -1)
  return { priorStart: addDaysKey(priorEnd, -(days - 1)), priorEnd }
}

function bucketEndKey(start: string, bucket: ChartBucket): string {
  if (bucket === 'week') return addDaysKey(start, 6)
  if (bucket === 'month') {
    const d = new Date(start + 'T12:00:00')
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate()).padStart(2, '0')}`
  }
  return start
}

// Re-bucket the per-day series into daily / weekly / monthly points for the charts.
// Totals are bucket-independent, so summary cards are unaffected by this control.
function bucketSeries(rows: WeeklyRow[], bucket: ChartBucket, rangeStart: string, effectiveEnd: string): { complete: ChartPoint[], partial: ChartPoint | null } {
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
  const points = Object.values(buckets)
    .sort((a, b) => a.raw_date.localeCompare(b.raw_date))
    .map(b => ({
      ...b,
      label: bucket === 'month' ? monthLabel(b.raw_date) : shortLabel(b.raw_date),
      conv_rate: b.total_sessions > 0 ? (b.total_units / b.total_sessions) * 100 : 0,
    }))
  if (bucket === 'day') return { complete: points, partial: null }

  const openingAligned = keyFn(rangeStart) === rangeStart
  const eligible = openingAligned ? points : points.filter(point => point.raw_date !== keyFn(rangeStart))
  const last = eligible.at(-1)
  const hasClosingPartial = !!last && bucketEndKey(last.raw_date, bucket) > effectiveEnd
  return {
    complete: hasClosingPartial ? eligible.slice(0, -1) : eligible,
    partial: hasClosingPartial ? last : null,
  }
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
  const [overviewError, setOverviewError] = useState<string | null>(null)
  const [retryToken, setRetryToken] = useState(0)
  const [dataThrough, setDataThrough] = useState<string | null>(null)
  const [salesFirstDate, setSalesFirstDate] = useState<string | null>(null)
  const [marketFreshness, setMarketFreshness] = useState<MarketFreshness[]>([])
  const [comparisonMode, setComparisonMode] = useState<ComparisonMode>('previous_period')
  const [comparisonComplete, setComparisonComplete] = useState(false)
  const [skuDrivers, setSkuDrivers] = useState<SkuDriver[]>([])
  const [marketDrivers, setMarketDrivers] = useState<MarketDriver[]>([])
  const [inventoryRisks, setInventoryRisks] = useState<InventoryRisk[]>([])
  const [overviewSummary, setOverviewSummary] = useState<OverviewSummary>({ buy_box_pct: null, prior_buy_box_pct: null, selling_skus: 0 })
  // Finance P&L breakdown (null = not loaded yet; [] = loaded, no rows for range).
  const [finance, setFinance] = useState<FinanceRow[] | null>(null)
  // Whether the last get_finance_pnl call errored (e.g. timeout). Kept separate
  // from an empty result so a failed fetch isn't rendered as "no data exists".
  const [financeError, setFinanceError] = useState(false)

  const priorYearAvailable = Boolean(dateRange?.startDate && salesFirstDate && yearShiftKey(dateRange.startDate, -1) >= salesFirstDate)

  useEffect(() => {
    if (comparisonMode === 'previous_year' && salesFirstDate && !priorYearAvailable) {
      setComparisonMode('previous_period')
    }
  }, [comparisonMode, priorYearAvailable, salesFirstDate])

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
    if (!dateRange?.startDate) return
    let cancelled = false
    async function load() {
      const { startDate, endDate } = dateRange!
      const currentEnd = dataThrough && dataThrough < endDate ? dataThrough : endDate
      const { priorStart, priorEnd } = comparisonWindow(startDate, currentEnd, comparisonMode)
      setLoading(true)
      setOverviewError(null)

      try {
        const p_marketplace = markets.length === 1 ? markets[0] : null
        const sharedParams = {
          p_start: startDate, p_end: currentEnd,
          p_prior_start: priorStart, p_prior_end: priorEnd,
          p_markets: markets,
          p_skus: selectedProducts.length ? selectedProducts.map(p => p.sku) : null,
        }
        const [overviewResult, metaResult, summaryResult, skuResult, marketResult, inventoryResult, financeResult] = await Promise.all([
          supabase.rpc('get_sales_overview', sharedParams),
          supabase.rpc('get_sales_overview_meta', {
            p_prior_start: priorStart, p_prior_end: priorEnd, p_markets: markets,
          }),
          supabase.rpc('get_sales_overview_summary', sharedParams),
          supabase.rpc('get_sku_sales_summary', sharedParams),
          supabase.rpc('get_sales_overview_market_drivers', sharedParams),
          supabase.rpc('get_sales_overview_inventory_actions', {
            p_end: currentEnd, p_markets: markets, p_skus: null,
          }),
          supabase.rpc('get_finance_pnl', { p_start: startDate, p_end: endDate, p_marketplace }),
        ])
        if (cancelled) return

        if (overviewResult.error || metaResult.error) {
          const essentialError = overviewResult.error || metaResult.error
          console.error(essentialError)
          setOverviewError(essentialError?.message || 'Required overview data could not load')
          setDailySeries([])
          setPrevData([])
          setDataThrough(null)
          setSalesFirstDate(null)
          setMarketFreshness([])
          setComparisonComplete(false)
          setSkuDrivers([])
          setMarketDrivers([])
          setInventoryRisks([])
          setOverviewSummary({ buy_box_pct: null, prior_buy_box_pct: null, selling_skus: 0 })
        } else {
          const rows = (overviewResult.data || []) as OverviewRpcRow[]
          const meta = metaResult.data as OverviewMeta | null
          const aggregate = (period: OverviewRpcRow['period']): WeeklyRow[] => rows
            .filter(row => row.period === period)
            .map(row => ({
              raw_date: row.start_date,
              start_date: shortLabel(row.start_date),
              total_revenue: Math.round(Number(row.revenue) || 0),
              total_units: Number(row.units) || 0,
              total_sessions: Number(row.sessions) || 0,
              total_page_views: Number(row.page_views) || 0,
            }))
          setDailySeries(aggregate('current'))
          setPrevData(aggregate('prior'))
          setDataThrough(meta?.data_through || null)
          setSalesFirstDate(meta?.first_date || null)
          setMarketFreshness(meta?.market_freshness || [])
          setComparisonComplete(Boolean(meta?.comparison_complete))

          if (summaryResult.error) console.error(summaryResult.error)
          const summary = (summaryResult.data?.[0] || null) as OverviewSummary | null
          setOverviewSummary(summary || { buy_box_pct: null, prior_buy_box_pct: null, selling_skus: 0 })

          if (skuResult.error) console.error(skuResult.error)
          const driverRows = ((skuResult.data || []) as SkuSummaryRpcRow[]).map(row => ({
            sku: row.sku, title: row.title,
            revenue: row.revenue, prior_revenue: row.prev_revenue,
            revenue_delta: Number(row.revenue) - Number(row.prev_revenue),
            units: row.units, sessions: row.sessions,
            prior_sessions: row.prev_sessions, prior_units: row.prev_units,
            conversion_rate: row.conv_rate, buy_box_pct: row.buy_box_pct,
          })).sort((a, b) => Math.abs(Number(b.revenue_delta)) - Math.abs(Number(a.revenue_delta)))
          setSkuDrivers(driverRows)

          if (marketResult.error) console.error(marketResult.error)
          setMarketDrivers((marketResult.data || []) as MarketDriver[])
          if (inventoryResult.error) console.error(inventoryResult.error)
          setInventoryRisks((inventoryResult.data || []) as InventoryRisk[])
        }

        if (financeResult.error) {
          console.error(financeResult.error)
          setFinanceError(true)
          setFinance([])
        } else {
          setFinanceError(false)
          setFinance((financeResult.data || []) as FinanceRow[])
        }
      } catch (error) {
        if (!cancelled) {
          console.error(error)
          setOverviewError(error instanceof Error ? error.message : 'Unexpected request failure')
          setDailySeries([])
          setPrevData([])
          setDataThrough(null)
          setSalesFirstDate(null)
          setMarketFreshness([])
          setComparisonComplete(false)
          setSkuDrivers([])
          setMarketDrivers([])
          setInventoryRisks([])
          setOverviewSummary({ buy_box_pct: null, prior_buy_box_pct: null, selling_skus: 0 })
          setFinanceError(true)
          setFinance([])
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    load()
    return () => { cancelled = true }
  }, [markets, dateRange, selectedProducts, comparisonMode, dataThrough, retryToken])

  const sum = (key: keyof WeeklyRow) => dailySeries.reduce((s, r) => s + (r[key] as number), 0)
  const prevSum = (key: keyof WeeklyRow) => prevData.reduce((s, r) => s + (r[key] as number), 0)

  const totalRevenue   = sum('total_revenue')
  const totalUnits     = sum('total_units')
  const totalSessions  = sum('total_sessions')
  const totalPageViews = sum('total_page_views')
  const prevRevenue    = prevSum('total_revenue')
  const prevUnits      = prevSum('total_units')
  const prevSessions   = prevSum('total_sessions')
  const prevPageViews  = prevSum('total_page_views')

  const asp          = totalUnits > 0 ? totalRevenue / totalUnits : 0
  const prevAsp      = prevUnits > 0 ? prevRevenue / prevUnits : 0
  const convRate     = totalSessions > 0 ? (totalUnits / totalSessions) * 100 : 0
  const prevConvRate = prevSessions > 0 ? (prevUnits / prevSessions) * 100 : 0
  const rangeLabel = dateRange ? PRESET_LABELS[dateRange.preset] : ''

  // Full calendar buckets drive the trend. A closing partial bucket is shown
  // separately so WTD/MTD activity cannot look like a sudden collapse.
  const effectiveEnd = dataThrough && dateRange ? (dataThrough < dateRange.endDate ? dataThrough : dateRange.endDate) : dateRange?.endDate || ''
  const bucketed = dateRange?.startDate && effectiveEnd
    ? bucketSeries(dailySeries, chartBucket, dateRange.startDate, effectiveEnd)
    : { complete: [] as ChartPoint[], partial: null as ChartPoint | null }
  const chartData = bucketed.complete
  const partialChartPoint = bucketed.partial
  const priorBucketed = dateRange?.startDate && effectiveEnd
    ? bucketSeries(prevData, chartBucket, comparisonWindow(dateRange.startDate, effectiveEnd, comparisonMode).priorStart, comparisonWindow(dateRange.startDate, effectiveEnd, comparisonMode).priorEnd)
    : { complete: [] as ChartPoint[], partial: null as ChartPoint | null }
  const priorByIndex = priorBucketed.complete
  const comparisonChartData = chartData.map((point, index) => ({
    ...point,
    prior_revenue: priorByIndex[index]?.total_revenue,
    prior_units: priorByIndex[index]?.total_units,
    prior_sessions: priorByIndex[index]?.total_sessions,
    prior_conv_rate: priorByIndex[index]?.conv_rate,
  }))
  const bucketAdj = chartBucket === 'day' ? 'Daily' : chartBucket === 'week' ? 'Weekly' : 'Monthly'

  // ─── Total Sales Breakdown (finance settlement P&L, from get_finance_pnl) ───
  // Reshaped off the RPC by display_order. value: null → "Not yet tracked".
  type BreakdownRow = { label: string; value: number | null; live?: boolean; strong?: boolean; hint?: string }

  const skuFilterActive = selectedProducts.length > 0
  const financeRows = finance ?? []
  const hasFinance = financeRows.length > 0

  // Operating lines (include_in_operating_sum), in the RPC's display order.
  // Payout (Transfer, !include_in_operating_sum) is deliberately NOT displayed
  // in this P&L widget — it's a cash-flow figure, not accrual. The RPC still
  // returns it; a future dedicated payouts/cash-flow view can surface it.
  const operatingRows = financeRows
    .filter(r => r.include_in_operating_sum)
    .sort((a, b) => a.display_order - b.display_order)
  const netProceeds = operatingRows.reduce((s, r) => s + Number(r.amount_usd || 0), 0)
  const totalDeferred = financeRows.reduce((s, r) => s + Number(r.deferred_count || 0), 0)

  const salesBreakdown: BreakdownRow[] = hasFinance ? [
    ...operatingRows.map(r => ({ label: r.widget_line, value: Number(r.amount_usd || 0) })),
    { label: 'Marketplace net proceeds (before COGS)', value: netProceeds, live: true, strong: true },
    { label: 'COGS', value: null },
    { label: 'Bottom-line profit', value: null, strong: true },
  ] : []

  const comparisonLabel = comparisonMode === 'previous_year' ? 'previous year' : 'previous period'

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
            {dataThrough && (
              <span style={{ marginLeft: 10, color: dataThrough < (dateRange?.endDate || dataThrough) ? 'var(--amber)' : 'var(--text-dim)' }}>
                Data through {fmtDateLabel(dataThrough)}
              </span>
            )}
            {marketFreshness.length > 1 && (
              <span title={marketFreshness.map(row => `${row.marketplace}: ${row.data_through ? fmtDateLabel(row.data_through) : 'unavailable'}`).join('\n')} style={{ marginLeft: 10, color: 'var(--text-dim)', cursor: 'help' }}>
                Marketplace freshness ⓘ
              </span>
            )}
          </p>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '16px', flexWrap: 'wrap' }}>
          <DateRangeFilter onChange={setDateRange} defaultPreset="ytd" />
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 10, color: 'var(--text-dim)', fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase' }}>
            Compare
            <select value={comparisonMode} onChange={event => setComparisonMode(event.target.value as ComparisonMode)} style={{ padding: '5px 8px', border: '1px solid var(--border)', borderRadius: 6, background: 'var(--bg-elevated)', color: 'var(--text-primary)', fontSize: 11 }}>
              <option value="previous_period">Previous period</option>
              <option value="previous_year" disabled={salesFirstDate !== null && !priorYearAvailable}>Previous year{salesFirstDate !== null && !priorYearAvailable ? ' (unavailable)' : ''}</option>
            </select>
          </label>
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
        <div className="card" style={{ minHeight: 300, display: 'grid', placeItems: 'center' }}>
          <div style={{ textAlign: 'center' }}>
            <LoaderCircle className="cadence-loading-spinner" size={28} style={{ color: 'var(--accent)', margin: '0 auto 10px' }} />
            <div style={{ color: 'var(--text-primary)', fontSize: 12, fontWeight: 600 }}>Loading Sales Overview</div>
            <div style={{ marginTop: 4, color: 'var(--text-muted)', fontSize: 10 }}>Calculating the selected period and comparison…</div>
          </div>
        </div>
      ) : overviewError ? (
        <div className="card" role="alert" style={{ padding: 24, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 18 }}>
          <div>
            <div style={{ color: 'var(--text-primary)', fontSize: 12, fontWeight: 700 }}>Sales Overview did not finish loading</div>
            <div style={{ marginTop: 5, color: 'var(--text-muted)', fontSize: 10 }}>The request took longer than expected. Your data is safe; try the request again.</div>
          </div>
          <button onClick={() => setRetryToken(value => value + 1)} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '8px 12px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--bg-card)', color: 'var(--text-primary)', fontSize: 10, fontWeight: 600, cursor: 'pointer', whiteSpace: 'nowrap' }}><RefreshCw size={13} />Retry</button>
        </div>
      ) : (
        <>
          <SalesKpiHierarchy
            rangeLabel={rangeLabel}
            comparisonLabel={comparisonLabel}
            comparisonComplete={comparisonComplete && prevData.length > 0}
            metrics={{
              revenue: totalRevenue, priorRevenue: prevRevenue,
              units: totalUnits, priorUnits: prevUnits,
              sessions: totalSessions, priorSessions: prevSessions,
              pageViews: totalPageViews, priorPageViews: prevPageViews,
              asp, priorAsp: prevAsp,
              conversion: convRate, priorConversion: prevConvRate,
              buyBox: Number(overviewSummary.buy_box_pct) || 0,
              priorBuyBox: Number(overviewSummary.prior_buy_box_pct) || 0,
              sellingSkus: Number(overviewSummary.selling_skus) || 0,
            }}
          />

          <SalesOverviewInsights
            comparisonAvailable={comparisonComplete && prevData.length > 0}
            comparisonLabel={comparisonLabel}
            skuDrivers={skuDrivers}
            marketDrivers={marketDrivers}
            inventoryRisks={inventoryRisks}
            metrics={{
              revenue: totalRevenue, priorRevenue: prevRevenue,
              units: totalUnits, priorUnits: prevUnits,
              sessions: totalSessions, priorSessions: prevSessions,
              conversion: convRate, priorConversion: prevConvRate,
              asp, priorAsp: prevAsp,
            }}
          />

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
                  {chartBucket !== 'day' && ' · trend uses complete calendar periods'}
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
            {partialChartPoint && (
              <div style={{ marginBottom: 12, padding: '8px 10px', border: '1px dashed var(--border)', borderRadius: 6, color: 'var(--text-muted)', fontSize: 11 }}>
                Current {chartBucket === 'week' ? 'week to date' : 'month to date'} ({shortLabel(partialChartPoint.raw_date)}–{shortLabel(effectiveEnd)}):{' '}
                <strong style={{ color: 'var(--text-primary)' }}>{fmtCurrency(partialChartPoint.total_revenue)}</strong> revenue ·{' '}
                <strong style={{ color: 'var(--text-primary)' }}>{fmtUnits(partialChartPoint.total_units)}</strong> units. Kept out of the full-period trend.
              </div>
            )}
            <ResponsiveContainer width="100%" height={240}>
              <ComposedChart data={comparisonChartData}>
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
                {comparisonComplete && <Line yAxisId="rev" type="monotone" dataKey="prior_revenue" name={`Revenue (${comparisonLabel})`} stroke="var(--text-dim)" strokeWidth={1.2} strokeDasharray="5 4" dot={false} />}
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
                <AreaChart data={comparisonChartData}>
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
                  {comparisonComplete && <Line type="monotone" dataKey="prior_sessions" name={`Sessions (${comparisonLabel})`} stroke="var(--text-dim)" strokeDasharray="5 4" dot={false} />}
                </AreaChart>
              </ResponsiveContainer>
            </div>

            <div className="card" style={{ padding: '24px' }}>
              <div style={{ marginBottom: '18px' }}>
                <div style={{ fontSize: '13px', fontWeight: 500, marginBottom: '2px' }}>Conversion rate over time</div>
                <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>{bucketAdj} · units ÷ sessions</div>
              </div>
              <ResponsiveContainer width="100%" height={200}>
                <AreaChart data={comparisonChartData}>
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
                  {comparisonComplete && <Line type="monotone" dataKey="prior_conv_rate" name={`Conversion Rate (${comparisonLabel})`} stroke="var(--text-dim)" strokeDasharray="5 4" dot={false} />}
                </AreaChart>
              </ResponsiveContainer>
            </div>
          </div>

          {/* Settlement accounting is intentionally separated from ordered demand. */}
          <div className="card" style={{ padding: '24px', borderLeft: '3px solid var(--yellow)' }}>
            <div style={{ marginBottom: '16px' }}>
              <div style={{ fontSize: '13px', fontWeight: 500, marginBottom: '2px' }}>Settlement activity (account-level)</div>
              <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
                Accounting feed in USD · different timing and scope from ordered revenue above. Use this to reconcile Amazon activity, not as a sales total.
              </div>
            </div>

            {skuFilterActive ? (
              <div style={{ fontSize: '12px', color: 'var(--text-muted)', lineHeight: 1.6, padding: '10px 0' }}>
                Settlement activity reflects your whole account; per-SKU accounting isn&rsquo;t available yet.
                Clear the product filter to see the account-level breakdown.
              </div>
            ) : financeError ? (
              <div style={{ fontSize: '12px', color: 'var(--text-muted)', lineHeight: 1.6, padding: '10px 0' }}>
                Couldn&rsquo;t load the finance breakdown for this period&mdash;the request timed out or failed.
                This doesn&rsquo;t mean the data is missing; try again, or narrow the date range.
              </div>
            ) : !hasFinance ? (
              <div style={{ fontSize: '12px', color: 'var(--text-muted)', lineHeight: 1.6, padding: '10px 0' }}>
                No finance data for the selected period.
              </div>
            ) : (
              <>
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
                          {row.hint && (
                            <span style={{ fontSize: '10px', color: 'var(--text-dim)', fontStyle: 'italic' }}>
                              ({row.hint})
                            </span>
                          )}
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

                {totalDeferred > 0 && (
                  <div style={{ marginTop: '12px', fontSize: '11px', color: 'var(--yellow)', lineHeight: 1.5 }}>
                    {fmtUnits(totalDeferred)} event{totalDeferred === 1 ? '' : 's'} in this range{' '}
                    {totalDeferred === 1 ? 'is' : 'are'} not yet settled (deferred); these figures may change as they finalize.
                  </div>
                )}

                <div style={{ marginTop: '14px', fontSize: '11px', color: 'var(--text-dim)', lineHeight: 1.5 }}>
                  COGS and bottom-line profit are not yet tracked (COGS is not in the finance feed).
                </div>
              </>
            )}
          </div>
        </>
      )}
    </div>
  )
}
