'use client'

import React, { useEffect, useState, useRef } from 'react'
import { supabase } from '@/lib/supabase'
import { searchProducts } from '@/lib/productSearch'
import MarketplaceFilter from '@/components/MarketplaceFilter'
import DateRangeFilter, { DateRange, PRESET_LABELS } from '@/components/DateRangeFilter'
import {
  AreaChart, Area, XAxis, YAxis, CartesianGrid,
  Tooltip, ResponsiveContainer, LineChart, Line,
} from 'recharts'
import {
  ChevronDown, ChevronRight, TrendingUp, TrendingDown, Minus,
  ArrowUpDown, ArrowUp, ArrowDown, Search, Download, X,
  AlertTriangle, AlertCircle, CheckCircle2,
} from 'lucide-react'

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Constants & helpers
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

// Health classification thresholds. Tweak these once you have a feel
// for what "good" looks like for your specific catalog.
const MIN_TRAFFIC_FOR_FLAGS = 100   // ignore noise from low-traffic SKUs
const LOW_CONV_THRESHOLD = 5        // % â€” below this is suspect
const HEALTHY_CONV_THRESHOLD = 12   // % â€” above this is healthy
const BUY_BOX_WARN = 80             // % â€” below this is "weak"
const BUY_BOX_OK = 90               // % â€” above this is healthy

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
// Exact integer with comma separators â€” for unit counts (e.g. 11,807).
function fmtUnits(n: number) {
  return Math.round(n).toLocaleString('en-US')
}
function fmtDateLabel(iso: string) {
  return new Date(iso + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}
function truncate(s: string, n: number) {
  return s && s.length > n ? s.slice(0, n) + 'â€¦' : s
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
      return `Both conversion (${p.conv_rate.toFixed(1)}%) and buy box (${p.buy_box_pct?.toFixed(1)}%) are weak. Likely a pricing or listing issue â€” investigate competitor pricing first.`
    case 'low_conv':
      return `Traffic is healthy (${fmtUnits(p.sessions)} sessions) but conversion is only ${p.conv_rate.toFixed(1)}%. Listing content, images, reviews, or price are likely culprits.`
    case 'weak_bb':
      return `Buy box at ${p.buy_box_pct?.toFixed(1)}% means you're losing sales to competitors. Check pricing and seller competition.`
    case 'low_traffic':
      return `Only ${p.sessions} sessions in this window â€” too little data for a reliable diagnosis. Consider advertising to drive traffic.`
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
  if (!data || data.length < 2) return <span style={{ color: 'var(--text-dim)', fontSize: '10px' }}>â€”</span>
  const color = positive === null ? 'var(--text-dim)' : positive ? 'var(--green)' : 'var(--red)'
  return (
    <LineChart width={80} height={32} data={data}>
      <Line type="monotone" dataKey={dataKey} stroke={color} strokeWidth={1.5} dot={false} />
    </LineChart>
  )
}

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Page
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

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

  useEffect(() => {
    if (!dateRange || !dateRange.startDate) return
    let cancelled = false
    async function load() {
      const { startDate, endDate, priorStart, priorEnd } = dateRange!
      setLoading(true)
      setExpandedSku(null)
      setPage(0)

      // Server-side per-SKU aggregation â€” one row per SKU, so this never
      // truncates at a daily-grain row cap the way the old raw fetch did.
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

      }

      setProducts(rows)
      setAllWeeklyData({})
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
      const points: WeeklyPoint[] = ((data || []) as any[]).map(point => ({
        raw_date: point.d,
        start_date: new Date(point.d + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
        sessions: Number(point.sessions) || 0,
        conv_rate: Number(point.conv_rate) || 0,
        buy_box_pct: point.buy_box_pct != null ? Number(point.buy_box_pct) : 0,
      }))
      setAllWeeklyData(previous => ({ ...previous, [expandedSku]: points }))
    })
    return () => { cancelled = true }
  }, [expandedSku, dateRange, markets])

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
    const rowsã4¶‰žËkºwµçh€ 4(€€€€€€€€ðø4(€€€€€€€€€€ñ‘¥Ø±…ÍÍ9…µ”ô‰…ÉˆÍÑå±”õíì½Ù•É™±½Üè€¡¥‘‘•¸œõôø4(€€€€€€€€€€€€ñ‘¥ØÍÑå±”õíì½Ù•É™±½Ý`è€…ÕÑ¼œõôø4(€€€€€€€€€€€€€€ñÑ…‰±”ÍÑå±”õíìÝ¥‘Ñ è€œÄÀÀ”œ°‰½É‘•É½±±…ÁÍ”è€½±±…ÁÍ”œõôø4(€€€€€€€€€€€€€€€€ñÑ¡•…ø4(€€€€€€€€€€€€€€€€€€ñÑÈø4(€€€€€€€€€€€€€€€€€€€€ñÑ ÍÑå±”õíì€¸¸¹Ñ¡	…Í”°Ý¥‘Ñ è€œÌÙÁàœ°Ñ•áÑ±¥¸è€•¹Ñ•Èœ°½±½Èè€Ù…È ´µÑ•áÐµµÕÑ•¤œõôøŒð½Ñ ø4(€€€€€€€€€€€€€€€€€€€€ñÑ ÍÑå±”õíì€¸¸¹Ñ¡	…Í”°Ñ•áÑ±¥¸è€±•™Ðœ°½±½Èè€Ù…È ´µÑ•áÐµµÕÑ•¤œõôùAÉ½‘ÕÐð½Ñ ø4(€€€€€€€€€€€€€€€€€€€€ñÑ ÍÑå±”õíì€¸¸¹Ñ¡	…Í”°Ý¥‘Ñ è€œäÁÁàœ°Ñ•áÑ±¥¸è€•¹Ñ•Èœ°½±½Èè€Ù…È ´µÑ•áÐµµÕÑ•¤œõôù!•…±Ñ ð½Ñ ø4(€€€€€€€€€€€€€€€€€€€€ñÑ ÍÑå±”õíì€¸¸¹Ñ¡M½ÉÑ…‰±” Í•ÍÍ¥½¹Ìœ¤°Ñ•áÑ±¥¸è€É¥¡Ðœõô½¹±¥¬õì ¤€ôø¡…¹‘±•M½ÉÐ Í•ÍÍ¥½¹Ìœ¥ôø4(€€€€€€€€€€€€€€€€€€€€€€ñÍÁ…¸ÍÑå±”õíì‘¥ÍÁ±…äè€™±•àœ°…±¥¹%Ñ•µÌè€•¹Ñ•Èœ°©ÕÍÑ¥™å½¹Ñ•¹Ðè€™±•àµ•¹œ°…Àè€œÑÁàœõôùM•ÍÍ¥½¹Ì€ñM½ÉÑ%½¸½°ô‰Í•ÍÍ¥½¹Ìˆ€¼øð½ÍÁ…¸ø4(€€€€€€€€€€€€€€€€€€€€ð½Ñ ø4(€€€€€€€€€€€€€€€€€€€€ñÑ ÍÑå±”õíì€¸¸¹Ñ¡M½ÉÑ…‰±” Á…•}Ù¥•ÝÌœ¤°Ñ•áÑ±¥¸è€É¥¡Ðœõô½¹±¥¬õì ¤€ôø¡…¹‘±•M½ÉÐ Á…•}Ù¥•ÝÌœ¥ôø4(€€€€€€€€€€€€€€€€€€€€€€ñÍÁ…¸ÍÑå±”õíì‘¥ÍÁ±…äè€™±•àœ°…±¥¹%Ñ•µÌè€•¹Ñ•Èœ°©ÕÍÑ¥™å½¹Ñ•¹Ðè€™±•àµ•¹œ°…Àè€œÑÁàœõôùY¥•ÝÌ€ñM½ÉÑ%½¸½°ô‰Á…•}Ù¥•ÝÌˆ€¼øð½ÍÁ…¸ø4(€€€€€€€€€€€€€€€€€€€€ð½Ñ ø4(€€€€€€€€€€€€€€€€€€€€ñÑ ÍÑå±”õíì€¸¸¹Ñ¡M½ÉÑ…‰±” Ù¥•ÝÍ}Á•É}Í•ÍÍ¥½¸œ¤°Ñ•áÑ±¥¸è€É¥¡Ðœõô½¹±¥¬õì ¤€ôø¡…¹‘±•M½ÉÐ Ù¥•ÝÍ}Á•É}Í•ÍÍ¥½¸œ¥ôø4(€€€€€€€€€€€€€€€€€€€€€€ñÍÁ…¸ÍÑå±”õíì‘¥ÍÁ±…äè€™±•àœ°…±¥¹%Ñ•µÌè€•¹Ñ•Èœ°©ÕÍÑ¥™å½¹Ñ•¹Ðè€™±•àµ•¹œ°…Àè€œÑÁàœõôùX½L€ñM½ÉÑ%½¸½°ô‰Ù¥•ÝÍ}Á•É}Í•ÍÍ¥½¸ˆ€¼øð½ÍÁ…¸ø4(€€€€€€€€€€€€€€€€€€€€ð½Ñ ø4(€€€€€€€€€€€€€€€€€€€€ñÑ ÍÑå±”õíì€¸¸¹Ñ¡M½ÉÑ…‰±” ‰Õå}‰½á}ÁÐœ¤°Ñ•áÑ±¥¸è€É¥¡Ðœõô½¹±¥¬õì ¤€ôø¡…¹‘±•M½ÉÐ ‰Õå}‰½á}ÁÐœ¥ôø4(€€€€€€€€€€€€€€€€€€€€€€ñÍÁ…¸ÍÑå±”õíì‘¥ÍÁ±…äè€™±•àœ°…±¥¹%Ñ•µÌè€•¹Ñ•Èœ°©ÕÍÑ¥™å½¹Ñ•¹Ðè€™±•àµ•¹œ°…Àè€œÑÁàœõôù	Õä	½à€ñM½ÉÑ%½¸½°ô‰‰Õå}‰½á}ÁÐˆ€¼øð½ÍÁ…¸ø4(€€€€€€€€€€€€€€€€€€€€ð½Ñ ø4(€€€€€€€€€€€€€€€€€€€€ñÑ ÍÑå±”õíì€¸¸¹Ñ¡M½ÉÑ…‰±” ½¹Ù}É…Ñ”œ¤°Ñ•áÑ±¥¸è€É¥¡Ðœõô½¹±¥¬õì ¤€ôø¡…¹‘±•M½ÉÐ ½¹Ù}É…Ñ”œ¥ôø4(€€€€€€€€€€€€€€€€€€€€€€ñÍÁ…¸ÍÑå±”õíì‘¥ÍÁ±…äè€™±•àœ°…±¥¹%Ñ•µÌè€•¹Ñ•Èœ°©ÕÍÑ¥™å½¹Ñ•¹Ðè€™±•àµ•¹œ°…Àè€œÑÁàœõôù½¹Ø€”€ñM½ÉÑ%½¸½°ô‰½¹Ù}É…Ñ”ˆ€¼øð½ÍÁ…¸ø4(€€€€€€€€€€€€€€€€€€€€ð½Ñ ø4(€€€€€€€€€€€€€€€€€€€€ñÑ ÍÑå±”õíì€¸¸¹Ñ¡M½ÉÑ…‰±” Õ¹¥ÑÌœ¤°Ñ•áÑ±¥¸è€É¥¡Ðœõô½¹±¥¬õì ¤€ôø¡…¹‘±•M½ÉÐ Õ¹¥ÑÌœ¥ôø4(€€€€€€€€€€€€€€€€€€€€€€ñÍÁ…¸ÍÑå±”õíì‘¥ÍÁ±…äè€™±•àœ°…±¥¹%Ñ•µÌè€•¹Ñ•Èœ°©ÕÍÑ¥™å½¹Ñ•¹Ðè€™±•àµ•¹œ°…Àè€œÑÁàœõôùU¹¥ÑÌ€ñM½ÉÑ%½¸½°ô‰Õ¹¥ÑÌˆ€¼øð½ÍÁ…¸ø4(€€€€€€€€€€€€€€€€€€€€ð½Ñ ø4(€€€€€€€€€€€€€€€€€€€€ñÑ ÍÑå±”õíì€¸¸¹Ñ¡M½ÉÑ…‰±” ½¹Ù}¡…¹”œ¤°Ñ•áÑ±¥¸è€É¥¡Ðœõô½¹±¥¬õì ¤€ôø¡…¹‘±•M½ÉÐ ½¹Ù}¡…¹”œ¥ôø4(€€€€€€€€€€€€€€€€€€€€€€ñÍÁ…¸ÍÑå±”õíì‘¥ÍÁ±…äè€™±•àœ°…±¥¹%Ñ•µÌè€•¹Ñ•Èœ°©ÕÍÑ¥™å½¹Ñ•¹Ðè€™±•àµ•¹œ°…Àè€œÑÁàœõôû:P½¹Ø€ñM½ÉÑ%½¸½°ô‰½¹Ù}¡…¹”ˆ€¼øð½ÍÁ…¸ø4(€€€€€€€€€€€€€€€€€€€€ð½Ñ ø4(€€€€€€€€€€€€€€€€€€€€ñÑ ÍÑå±”õíì€¸¸¹Ñ¡	…Í”°Ý¥‘Ñ è€œÌÉÁàœõôøð½Ñ ø4(€€€€€€€€€€€€€€€€€€ð½ÑÈø4(€€€€€€€€€€€€€€€€ð½Ñ¡•…ø4(€€€€€€€€€€€€€€€€ñÑ‰½‘äø4(€€€€€€€€€€€€€€€€€íÁ…¥¹…Ñ•¹µ…À ¡À°¤¤€ôøì4(€€€€€€€€€€€€€€€€€€€½¹ÍÐ¥ÍáÁ…¹‘•€ô•áÁ…¹‘•‘M­Ô€ôôôÀ¹Í­Ô4(€€€€€€€€€€€€€€€€€€€½¹ÍÐÝ••­±å…Ñ„€ô…±±]••­±å…Ñ…mÀ¹Í­Õtñðmt4(€€€€€€€€€€€€€€€€€€€½¹ÍÐµ•Ñ„€ô!1Q!}5QmÀ¹¡•…±Ñ¡t4(€€€€€€€€€€€€€€€€€€€½¹ÍÐ!•…±Ñ¡%½¸€ôµ•Ñ„¹¥½¸4(€€€€€€€€€€€€€€€€€€€É•ÑÕÉ¸€ 4(€€€€€€€€€€€€€€€€€€€€€€ñI•…Ð¹É…µ•¹Ð­•äõíÀ¹Í­Õôø4(€€€€€€€€€€€€€€€€€€€€€€€€ñÑÈ4(€€€€€€€€€€€€€€€€€€€€€€€€€½¹±¥¬õì ¤€ôøÍ•ÑáÁ…¹‘•‘M­Ô¡¥ÍáÁ…¹‘•€ü¹Õ±°€èÀ¹Í­Ô¥ô4(€€€€€€€€€€€€€€€€€€€€€€€€€ÍÑå±”õíì4(€€€€€€€€€€€€€€€€€€€€€€€€€€€ÕÉÍ½Èè€Á½¥¹Ñ•Èœ°4(€€€€€€€€€€€€€€€€€€€€€€€€€€€‰…­É½Õ¹è¥ÍáÁ…¹‘•€ü€Ù…È ´µ…•¹Ðµ±¥¡Ð¤œ€è€ÑÉ…¹ÍÁ…É•¹Ðœ°4(€€€€€€€€€€€€€€€€€€€€€€€€€€€ÑÉ…¹Í¥Ñ¥½¸è€‰…­É½Õ¹€À¸ÅÌ•…Í”œ°4(€€€€€€€€€€€€€€€€€€€€€€€€€€€‰½É‘•É	½ÑÑ½´è¥ÍáÁ…¹‘•€ü€¹½¹”œ€è€œÅÁàÍ½±¥Ù…È ´µ‰½É‘•È¤œ°4(€€€€€€€€€€€€€€€€€€€€€€€€€õô4(€€€€€€€€€€€€€€€€€€€€€€€€€½¹5½ÕÍ•¹Ñ•Èõí”€ôøì¥˜€ …¥ÍáÁ…¹‘•¤€¡”¹ÕÉÉ•¹ÑQ…É•Ð…Ì!Q51Q…‰±•I½Ý±•µ•¹Ð¤¹ÍÑå±”¹‰…­É½Õ¹€ô€Ù…È ´µ‰œµ¡½Ù•È¤œõô4(€€€€€€€€€€€€€€€€€€€€€€€€€½¹5½ÕÍ•1•…Ù”õí”€ôøì¥˜€ …¥ÍáÁ…¹‘•¤€¡”¹ÕÉÉ•¹ÑQ…É•Ð…Ì!Q51Q…‰±•I½Ý±•µ•¹Ð¤¹ÍÑå±”¹‰…­É½Õ¹€ô€ÑÉ…¹ÍÁ…É•¹Ðœõô4(€€€€€€€€€€€€€€€€€€€€€€€€ø4(€€€€€€€€€€€€€€€€€€€€€€€€€€ñÑÍÑå±”õíìÁ…‘‘¥¹œè€œÄÅÁà€ÄÉÁàœ°Ñ•áÑ±¥¸è€•¹Ñ•Èœ°™½¹ÑM¥é”è€œÄÅÁàœ°½±½Èè€Ù…È ´µÑ•áÐµ‘¥´¤œ°™½¹Ñ…µ¥±äè€)•Ñ	É…¥¹Ì5½¹¼°µ½¹½ÍÁ…”œõôùí¤€¬€Åôð½Ñø4(€€€€€€€€€€€€€€€€€€€€€€€€€€ñÑÍÑå±”õíìÁ…‘‘¥¹œè€œÄÅÁà€ÄÉÁàœõôø4(€€€€€€€€€€€€€€€€€€€€€€€€€€€€ñ‘¥ØÍÑå±”õíì™½¹ÑM¥é”è€œÄÉÁàœ°™½¹Ñ]•¥¡Ðè€ÔÀÀ°½±½Èè€Ù…È ´µÑ•áÐµÁÉ¥µ…Éä¤œ°µ…É¥¹	½ÑÑ½´è€œÉÁàœõôùíÑÉÕ¹…Ñ”¡À¹Ñ¥Ñ±”°€ÔÈ¥ôð½‘¥Øø4(€€€€€€€€€€€€€€€€€€€€€€€€€€€€ñ‘¥ØÍÑå±”õíì™½¹ÑM¥é”è€œÄÁÁàœ°½±½Èè€Ù…È ´µÑ•áÐµ‘¥´¤œ°™½¹Ñ…µ¥±äè€)•Ñ	É…¥¹Ì5½¹¼°µ½¹½ÍÁ…”œõôùíÀ¹Í­Õôð½‘¥Øø4(€€€€€€€€€€€€€€€€€€€€€€€€€€ð½Ñø4(€€€€€€€€€€€€€€€€€€€€€€€€€€ñÑÍÑå±”õíìÁ…‘‘¥¹œè€œÄÅÁà€ÄÉÁàœ°Ñ•áÑ±¥¸è€•¹Ñ•Èœõôø4(€€€€€€€€€€€€€€€€€€€€€€€€€€€€ñÍÁ…¸ÍÑå±”õíì4(€€€€€€€€€€€€€€€€€€€€€€€€€€€€€‘¥ÍÁ±…äè€¥¹±¥¹”µ™±•àœ°…±¥¹%Ñ•µÌè€•¹Ñ•Èœ°…Àè€œÑÁàœ°4(€€€€€€€€€€€€€€€€€€€€€€€€€€€€€Á…‘‘¥¹œè€œÍÁà€áÁàœ°‰½É‘•ÉI…‘¥ÕÌè€œÄÉÁàœ°4(€€€€€€€€€€€€€€€€€€€€€€€€€€€€€‰…­É½Õ¹èµ•Ñ„¹‰œ°½±½Èèµ•Ñ„¹½±½È°4(€€€€€€€€€€€€€€€€€€€€€€€€€€€€€™½¹ÑM¥é”è€œÄÁÁàœ°™½¹Ñ]•¥¡Ðè€ØÀÀ°4(€€€€€€€€€€€€€€€€€€€€€€€€€€€õôø4(€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€ñ!•…±Ñ¡%½¸Í¥é”õìÄÅô€¼øíµ•Ñ„¹±…‰•±ô4(€€€€€€€€€€€€€€€€€€€€€€€€€€€€ð½ÍÁ…¸ø4(€€€€€€€€€€€€€€€€€€€€€€€€€€ð½Ñø4(€€€€€€€€€€€€€€€€€€€€€€€€€€ñÑÍÑå±”õíìÁ…‘‘¥¹œè€œÄÅÁà€ÄÉÁàœ°Ñ•áÑ±¥¸è€É¥¡Ðœ°™½¹ÑM¥é”è€œÄÉÁàœ°™½¹Ñ]•¥¡Ðè€ØÀÀ°™½¹Ñ…µ¥±äè€)•Ñ	É…¥¹Ì5½¹¼°µ½¹½ÍÁ…”œ°½±½Èè€Ù…È ´µÑ•áÐµÁÉ¥µ…Éä¤œõôùí™µÑU¹¥ÑÌ¡À¹Í•ÍÍ¥½¹Ì¥ôð½Ñø4(€€€€€€€€€€€€€€€€€€€€€€€€€€ñÑÍÑå±”õíìÁ…‘‘¥¹œè€œÄÅÁà€ÄÉÁàœ°Ñ•áÑ±¥¸è€É¥¡Ðœ°™½¹ÑM¥é”è€œÄÉÁàœ°™½¹Ñ…µ¥±äè€)•Ñ	É…¥¹Ì5½¹¼°µ½¹½ÍÁ…”œ°½±½Èè€Ù…È ´µÑ•áÐµÁÉ¥µ…Éä¤œõôùí™µÑU¹¥ÑÌ¡À¹Á…•}Ù¥•ÝÌ¥ôð½Ñø4(€€€€€€€€€€€€€€€€€€€€€€€€€€ñÑÍÑå±”õíìÁ…‘‘¥¹œè€œÄÅÁà€ÄÉÁàœ°Ñ•áÑ±¥¸è€É¥¡Ðœ°™½¹ÑM¥é”è€œÄÉÁàœ°™½¹Ñ…µ¥±äè€)•Ñ	É…¥¹Ì5½¹¼°µ½¹½ÍÁ…”œ°½±½Èè€Ù…È ´µÑ•áÐµÁÉ¥µ…Éä¤œõôùíÀ¹Ù¥•ÝÍ}Á•É}Í•ÍÍ¥½¸¹Ñ½¥á• È¥ôð½Ñø4(€€€€€€€€€€€€€€€€€€€€€€€€€€ñÑÍÑå±”õíìÁ…‘‘¥¹œè€œÄÅÁà€ÄÉÁàœ°Ñ•áÑ±¥¸è€É¥¡Ðœ°™½¹ÑM¥é”è€œÄÉÁàœ°™½¹Ñ…µ¥±äè€)•Ñ	É…¥¹Ì5½¹¼°µ½¹½ÍÁ…”œ°½±½ÈèÀ¹‰Õå}‰½á}ÁÐ€„ôô¹Õ±°€˜˜À¹‰Õå}‰½á}ÁÐ€ð	Ue}	=a}]I8€ü€Ù…È ´µÉ•¤œ€èÀ¹‰Õå}‰½á}ÁÐ€„ôô¹Õ±°€˜˜À¹‰Õå}‰½á}ÁÐ€øô	Ue}	=a}=,€ü€Ù…È ´µÉ••¸¤œ€è€Ù…È ´µÑ•áÐµÁÉ¥µ…Éä¤œõôùíÀ¹‰Õå}‰½á}ÁÐ€„ôô¹Õ±°€üÀ¹‰Õå}‰½á}ÁÐ¹Ñ½¥á• Ä¤€¬€œ”œ€è€ŸŠPôð½Ñø4(€€€€€€€€€€€€€€€€€€€€€€€€€€ñÑÍÑå±”õíìÁ…‘‘¥¹œè€œÄÅÁà€ÄÉÁàœ°Ñ•áÑ±¥¸è€É¥¡Ðœ°™½¹ÑM¥é”è€œÄÉÁàœ°™½¹Ñ…µ¥±äè€)•Ñ	É…¥¹Ì5½¹¼°µ½¹½ÍÁ…”œ°½±½ÈèÀ¹½¹Ù}É…Ñ”€ð1=]}=9Y}Q!IM!=1€ü€Ù…È ´µÉ•¤œ€èÀ¹½¹Ù}É…Ñ”€øô!1Q!e}=9Y}Q!IM!=1€ü€Ù…È ´µÉ••¸¤œ€è€Ù…È ´µÑ•áÐµÁÉ¥µ…Éä¤œõôùíÀ¹½¹Ù}É…Ñ”¹Ñ½¥á• Ä¥ô”ð½Ñø4(€€€€€€€€€€€€€€€€€€€€€€€€€€ñÑÍÑå±”õíìÁ…‘‘¥¹œè€œÄÅÁà€ÄÉÁàœ°Ñ•áÑ±¥¸è€É¥¡Ðœ°™½¹ÑM¥é”è€œÄÉÁàœ°™½¹Ñ…µ¥±äè€)•Ñ	É…¥¹Ì5½¹¼°µ½¹½ÍÁ…”œ°½±½Èè€Ù…È ´µÑ•áÐµÁÉ¥µ…Éä¤œõôùí™µÑU¹¥ÑÌ¡À¹Õ¹¥ÑÌ¥ôð½Ñø4(€€€€€€€€€€€€€€€€€€€€€€€€€€ñÑÍÑå±”õíìÁ…‘‘¥¹œè€œÄÅÁà€ÄÉÁàœ°Ñ•áÑ±¥¸è€É¥¡Ðœõôø4(€€€€€€€€€€€€€€€€€€€€€€€€€€€íÀ¹½¹Ù}¡…¹”€„ôô¹Õ±°€ü€ 4(€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€ñÍÁ…¸ÍÑå±”õíì™½¹ÑM¥é”è€œÄÅÁàœ°™½¹Ñ]•¥¡Ðè€ØÀÀ°½±½ÈèÀ¹½¹Ù}¡…¹”€ø€À€ü€Ù…È ´µÉ••¸¤œ€èÀ¹½¹Ù}¡…¹”€ð€À€ü€Ù…È ´µÉ•¤œ€è€Ù…È ´µÑ•áÐµµÕÑ•¤œ°‘¥ÍÁ±…äè€¥¹±¥¹”µ™±•àœ°…±¥¹%Ñ•µÌè€•¹Ñ•Èœ°…Àè€œÉÁàœ°™½¹Ñ…µ¥±äè€)•Ñ	É…¥¹Ì5½¹¼°µ½¹½ÍÁ…”œõôø4(€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€íÀ¹½¹Ù}¡…¹”€ø€À€ü€ñQÉ•¹‘¥¹UÀÍ¥é”õìÄÁô€¼ø€èÀ¹½¹Ù}¡…¹”€ð€À€ü€ñQÉ•¹‘¥¹½Ý¸Í¥é”õìÄÁô€¼ø€è€ñ5¥¹ÕÌÍ¥é”õìÄÁô€¼ùô4(€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€íÀ¹½¹Ù}¡…¹”€ø€À€ü€œ¬œ€è€œõíÀ¹½¹Ù}¡…¹”¹Ñ½¥á• Ä¥õÁÀ4(€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€ð½ÍÁ…¸ø4(€€€€€€€€€€€€€€€€€€€€€€€€€€€€¤€è€ 4(€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€ñÍÁ…¸ÍÑå±”õíì™½¹ÑM¥é”è€œÄÅÁàœ°½±½Èè€Ù…È ´µÑ•áÐµ‘¥´¤œõôûŠPð½ÍÁ…¸ø4(€€€€€€€€€€€€€€€€€€€€€€€€€€€€¥ô4(€€€€€€€€€€€€€€€€€€€€€€€€€€ð½Ñø4(€€€€€€€€€€€€€€€€€€€€€€€€€€ñÑÍÑå±”õíìÁ…‘‘¥¹œè€œÄÅÁà€ÄÉÁàœ°Ñ•áÑ±¥¸è€•¹Ñ•Èœ°½±½Èè€Ù…È ´µÑ•áÐµ‘¥´¤œõôø4(€€€€€€€€€€€€€€€€€€€€€€€€€€€í¥ÍáÁ…¹‘•€ü€ñ¡•ÙÉ½¹½Ý¸Í¥é”õìÄÍô€¼ø€è€ñ¡•ÙÉ½¹I¥¡ÐÍ¥é”õìÄÍô€¼ùô4(€€€€€€€€€€€€€€€€€€€€€€€€€€ð½Ñø4(€€€€€€€€€€€€€€€€€€€€€€€€ð½ÑÈø4(€€€€€€€€€€€€€€€€€€€€€€€í¥ÍáÁ…¹‘•€˜˜€ 4(€€€€€€€€€€€€€€€€€€€€€€€€€€ñÑÈ­•äõíÀ¹Í­Ô€¬€œµ•áÀôÍÑå±”õíì‰½É‘•É	½ÑÑ½´è€œÅÁàÍ½±¥Ù…È ´µ‰½É‘•È¤œõôø4(€€€€€€€€€€€€€€€€€€€€€€€€€€€€ñÑ½±MÁ…¸õìÄÅôÍÑå±”õíìÁ…‘‘¥¹œè€œÀ€ÈÁÁà€ÈÁÁà€ÈÁÁàœ°‰…­É½Õ¹è€Ù…È ´µ…•¹Ðµ±¥¡Ð¤œõôø4(€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€ñ‘¥ØÍÑå±”õíìÁ…‘‘¥¹Q½Àè€œÄÙÁàœõôø4(€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€ì¼¨¥…¹½ÍÑ¥Œ±¥¹”€¨½ô4(€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€ñ‘¥ØÍÑå±”õíì4(€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€Á…‘‘¥¹œè€œÄÉÁà€ÄÑÁàœ°µ…É¥¹	½ÑÑ½´è€œÄÙÁàœ°4(€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€‰…­É½Õ¹è€Ù…È ´µ‰œµ…É¤œ°‰½É‘•Èè€ÅÁàÍ½±¥€‘íµ•Ñ„¹½±½Éõ€°4(€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€‰½É‘•ÉI…‘¥ÕÌè€œáÁàœ°™½¹ÑM¥é”è€œÄÉÁàœ°4(€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€½±½Èè€Ù…È ´µÑ•áÐµÁÉ¥µ…Éä¤œ°‘¥ÍÁ±…äè€™±•àœ°…Àè€œÄÁÁàœ°…±¥¹%Ñ•µÌè€™±•àµÍÑ…ÉÐœ°4(€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€õôø4(€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€ñ!•…±Ñ¡%½¸Í¥é”õìÄÑô½±½Èõíµ•Ñ„¹½±½ÉôÍÑå±”õíìµ…É¥¹Q½Àè€œÅÁàœ°™±•áM¡É¥¹¬è€Àõô€¼ø4(€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€ñÍÁ…¸ùí‘¥…¹½ÍÑ¥5•ÍÍ…”¡À¥ôð½ÍÁ…¸ø4(€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€ð½‘¥Øø4(4(€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€ì¼¨Õ¹¹•°ÍÑ…ÑÌ€¨½ô4(€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€ñ‘¥ØÍÑå±”õíì‘¥ÍÁ±…äè€™±•àœ°…Àè€œÈáÁàœ°µ…É¥¹	½ÑÑ½´è€œÈÁÁàœ°™±•á]É…Àè€ÝÉ…Àœõôø4(€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€íl4(€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€ì±…‰•°è€M•ÍÍ¥½¹Ìœ°Ù…±Õ”è™µÑU¹¥ÑÌ¡À¹Í•ÍÍ¥½¹Ì¤ô°4(€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€ì±…‰•°è€A…”Y¥•ÝÌœ°Ù…±Õ”è™µÑU¹¥ÑÌ¡À¹Á…•}Ù¥•ÝÌ¤ô°4(€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€ì±…‰•°è€Y¥•ÝÌ½M•ÍÍ¥½¸œ°Ù…±Õ”èÀ¹Ù¥•ÝÍ}Á•É}Í•ÍÍ¥½¸¹Ñ½¥á• È¤ô°4(€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€ì±…‰•°è€	Õä	½àœ°Ù…±Õ”èÀ¹‰Õå}‰½á}ÁÐ€„ôô¹Õ±°€üÀ¹‰Õå}‰½á}ÁÐ¹Ñ½¥á• Ä¤€¬€œ”œ€è€ŸŠPœô°4(€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€ì±…‰•°è€½¹ØI…Ñ”œ°Ù…±Õ”èÀ¹½¹Ù}É…Ñ”¹Ñ½¥á• Ä¤€¬€œ”œô°4(€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€ì±…‰•°è€U¹¥ÑÌœ°Ù…±Õ”è™µÑU¹¥ÑÌ¡À¹Õ¹¥ÑÌ¤ô°4(€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€¸¸¸¡À¹½¹Ù}¡…¹”€„ôô¹Õ±°€ümì±…‰•°è€Ÿ:P½¹Øœ°Ù…±Õ”è€¡À¹½¹Ù}¡…¹”€ø€À€ü€œ¬œ€è€œœ¤€¬À¹½¹Ù}¡…¹”¹Ñ½¥á• È¤€¬€ÁÀœ°½±½ÈèÀ¹½¹Ù}¡…¹”€ø€À€ü€Ù…È ´µÉ••¸¤œ€è€Ù…È ´µÉ•¤œõt€èmt¤°4(€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€t¹µ…À ¡ÍÑ…Ð°¥‘à¤€ôø€ 4(€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€ñ‘¥Ø­•äõí¥‘áôø4(€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€ñ‘¥ØÍÑå±”õíì™½¹ÑM¥é”è€œÄÁÁàœ°½±½Èè€Ù…È ´µÑ•áÐµµÕÑ•¤œ°Ñ•áÑQÉ…¹Í™½É´è€ÕÁÁ•É…Í”œ°±•ÑÑ•ÉMÁ…¥¹œè€œÀ¸ÀÙ•´œ°µ…É¥¹	½ÑÑ½´è€œÍÁàœõôùíÍÑ…Ð¹±…‰•±ôð½‘¥Øø4(€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€ñ‘¥ØÍÑå±”õíì™½¹ÑM¥é”è€œÄÝÁàœ°™½¹Ñ]•¥¡Ðè€ØÀÀ°™½¹Ñ…µ¥±äè€)•Ñ	É…¥¹Ì5½¹¼°µ½¹½ÍÁ…”œ°½±½Èè€¡ÍÑ…Ð…Ì…¹ä¤¹½±½Èñð€Ù…È ´µÑ•áÐµÁÉ¥µ…Éä¤œõôùíÍÑ…Ð¹Ù…±Õ•ôð½‘¥Øø4(€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€ð½‘¥Øø4(€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€¤¥ô4(€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€ð½‘¥Øø4(4(€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€ì¼¨Q¡É•”ÍÁ…É­±¥¹•ÌÍ¥‘”‰äÍ¥‘”€¨½ô4(€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€ñ‘¥ØÍÑå±”õíì‘¥ÍÁ±…äè€É¥œ°É¥‘Q•µÁ±…Ñ•½±Õµ¹Ìè€É•Á•…Ð Ì°€Å™È¤œ°…Àè€œÄÙÁàœõôø4(€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€íl4(€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€ìÑ¥Ñ±”è€M•ÍÍ¥½¹Ìœ°‘…Ñ…-•äè€Í•ÍÍ¥½¹Ìœ…Ì½¹ÍÐ°½±½Èè€Ù…È ´µ…•¹Ð¤œô°4(€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€ìÑ¥Ñ±”è€½¹Ù•ÉÍ¥½¸€”œ°‘…Ñ…-•äè€½¹Ù}É…Ñ”œ…Ì½¹ÍÐ°½±½Èè€Ù…È ´µÉ••¸¤œô°4(€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€ìÑ¥Ñ±”è€	Õä	½à€”œ°‘…Ñ…-•äè€‰Õå}‰½á}ÁÐœ…Ì½¹ÍÐ°½±½Èè€œäÜÜÀØœô°4(€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€t¹µ…À¡¡…ÉÐ€ôø€ 4(€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€ñ‘¥Ø­•äõí¡…ÉÐ¹‘…Ñ…-•åôÍÑå±”õíì‰…­É½Õ¹è€Ù…È ´µ‰œµ…É¤œ°‰½É‘•ÉI…‘¥ÕÌè€œáÁàœ°Á…‘‘¥¹œè€œÄÉÁàœ°‰½É‘•Èè€œÅÁàÍ½±¥Ù…È ´µ‰½É‘•È¤œõôø4(€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€ñ‘¥ØÍÑå±”õíì™½¹ÑM¥é”è€œÄÁÁàœ°½±½Èè€Ù…È ´µÑ•áÐµµÕÑ•¤œ°Ñ•áÑQÉ…¹Í™½É´è€ÕÁÁ•É…Í”œ°±•ÑÑ•ÉMÁ…¥¹œè€œÀ¸ÀÙ•´œ°µ…É¥¹	½ÑÑ½´è€œáÁàœõôùí¡…ÉÐ¹Ñ¥Ñ±•ôð½‘¥Øø4(€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€ñI•ÍÁ½¹Í¥Ù•½¹Ñ…¥¹•ÈÝ¥‘Ñ ôˆÄÀÀ”ˆ¡•¥¡ÐõìÄÀÁôø4(€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€ñÉ•…¡…ÉÐ‘…Ñ„õí…±±]••­±å…Ñ…mÀ¹Í­Õtñðmuôø4(€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€ñ‘•™Ìø4(€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€ñ±¥¹•…ÉÉ…‘¥•¹Ð¥õíÉ…´‘í¡…ÉÐ¹‘…Ñ…-•åô´‘íÍ…¹¥Ñ¥é•%¡À¹Í­Ô¥õôàÄôˆÀˆäÄôˆÀˆàÈôˆÀˆäÈôˆÄˆø4(€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€ñÍÑ½À½™™Í•ÐôˆÔ”ˆÍÑ½Á½±½Èõí¡…ÉÐ¹½±½ÉôÍÑ½Á=Á…¥ÑäõìÀ¸Éô€¼ø4(€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€ñÍÑ½À½™™Í•ÐôˆäÔ”ˆÍÑ½Á½±½Èõí¡…ÉÐ¹½±½ÉôÍÑ½Á=Á…¥ÑäõìÁô€¼ø4(€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€ð½±¥¹•…ÉÉ…‘¥•¹Ðø4(€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€ð½‘•™Ìø4(€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€ñ…ÉÑ•Í¥…¹É¥ÍÑÉ½­•…Í¡…ÉÉ…äôˆÌ€ÌˆÍÑÉ½­”ô‰Ù…È ´µ‰½É‘•È¤ˆÙ•ÉÑ¥…°õí™…±Í•ô€¼ø4(€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€ñaá¥Ì‘…Ñ…-•äô‰ÍÑ…ÉÑ}‘…Ñ”ˆÑ¥¬õíì™½¹ÑM¥é”è€ä°™¥±°è€Ù…È ´µÑ•áÐµ‘¥´¤œõôÑ¥­1¥¹”õí™…±Í•ô…á¥Í1¥¹”õí™…±Í•ô¥¹Ñ•ÉÙ…°ô‰ÁÉ•Í•ÉÙ•MÑ…ÉÑ¹ˆ€¼ø4(€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€ñeá¥ÌÑ¥¬õíì™½¹ÑM¥é”è€ä°™¥±°è€Ù…È ´µÑ•áÐµ‘¥´¤œõôÑ¥­1¥¹”õí™…±Í•ô…á¥Í1¥¹”õí™…±Í•ôÝ¥‘Ñ õìÐÁô€¼ø4(€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€ñQ½½±Ñ¥À½¹Ñ•¹ÐõìñÕÍÑ½µQ½½±Ñ¥À€¼ùô€¼ø4(€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€ñÉ•„ÑåÁ”ô‰µ½¹½Ñ½¹”ˆ‘…Ñ…-•äõí¡…ÉÐ¹‘…Ñ…-•åô¹…µ”õí¡…ÉÐ¹Ñ¥Ñ±•ôÍÑÉ½­”õí¡…ÉÐ¹½±½ÉôÍÑÉ½­•]¥‘Ñ õìÄ¸Õô™¥±°õíÕÉ° É…´‘í¡…ÉÐ¹‘…Ñ…-•åô´‘íÍ…¹¥Ñ¥é•%¡À¹Í­Ô¥ô¥ô‘½Ðõí™…±Í•ô€¼ø4(€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€ð½É•…¡…ÉÐø4(€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€ð½I•ÍÁ½¹Í¥Ù•½¹Ñ…¥¹•Èø4(€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€ð½‘¥Øø4(€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€¤¥ô4(€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€ð½‘¥Øø4(€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€ð½‘¥Øø4(€€€€€€€€€€€€€€€€€€€€€€€€€€€€ð½Ñø4(€€€€€€€€€€€€€€€€€€€€€€€€€€ð½ÑÈø4(€€€€€€€€€€€€€€€€€€€€€€€€¥ô4(€€€€€€€€€€€€€€€€€€€€€€ð½I•…Ð¹É…µ•¹Ðø4(€€€€€€€€€€€€€€€€€€€€¤4(€€€€€€€€€€€€€€€€€ô¥ô4(€€€€€€€€€€€€€€€€ð½Ñ‰½‘äø4(€€€€€€€€€€€€€€ð½Ñ…‰±”ø4(€€€€€€€€€€€€ð½‘¥Øø4(€€€€€€€€€€€í™¥±Ñ•É•¹±•¹Ñ €ôôô€À€˜˜€ 4(€€€€€€€€€€€€€€ñ‘¥ØÍÑå±”õíìÁ…‘‘¥¹œè€œÐÁÁàœ°Ñ•áÑ±¥¸è€•¹Ñ•Èœ°½±½Èè€Ù…È ´µÑ•áÐµ‘¥´¤œ°™½¹ÑM¥é”è€œÄÍÁàœõôù9¼ÁÉ½‘ÕÑÌ™½Õ¹ð½‘¥Øø4(€€€€€€€€€€€€¥ô4(€€€€€€€€€€ð½‘¥Øø4(€€€€€€€€€í¡…Í5½É”€˜˜€ 4(€€€€€€€€€€€€ñ‘¥ØÍÑå±”õíìÑ•áÑ±¥¸è€•¹Ñ•Èœ°µ…É¥¹Q½Àè€œÄÙÁàœõôø4(€€€€€€€€€€€€€€ñ‰ÕÑÑ½¸½¹±¥¬õì ¤€ôøÍ•ÑA…”¡À€ôøÀ€¬€Ä¥ôÍÑå±”õíì4(€€€€€€€€€€€€€€€Á…‘‘¥¹œè€œáÁà€ÈÑÁàœ°‰½É‘•ÉI…‘¥ÕÌè€œáÁàœ°4(€€€€€€€€€€€€€€€‰½É‘•Èè€œÅÁàÍ½±¥Ù…È ´µ‰½É‘•È¤œ°‰…­É½Õ¹è€Ù…È ´µ‰œµ…É¤œ°4(€€€€€€€€€€€€€€€½±½Èè€Ù…È ´µÑ•áÐµµÕÑ•¤œ°™½¹ÑM¥é”è€œÄÉÁàœ°ÕÉÍ½Èè€Á½¥¹Ñ•Èœ°4(€€€€€€€€€€€€€€€ÑÉ…¹Í¥Ñ¥½¸è€…±°€À¸ÄÉÌ•…Í”œ°4(€€€€€€€€€€€€€õô4(€€€€€€€€€€€€€½¹5½ÕÍ•¹Ñ•Èõí”€ôøì€¡”¹ÕÉÉ•¹ÑQ…É•Ð…Ì!Q51	ÕÑÑ½¹±•µ•¹Ð¤¹ÍÑå±”¹‰½É‘•É½±½È€ô€Ù…È ´µ…•¹Ð¤œì€¡”¹ÕÉÉ•¹ÑQ…É•Ð…Ì!Q51	ÕÑÑ½¹±•µ•¹Ð¤¹ÍÑå±”¹½±½È€ô€Ù…È ´µ…•¹Ð¤œõô4(€€€€€€€€€€€€€½¹5½ÕÍ•1•…Ù”õí”€ôøì€¡”¹ÕÉÉ•¹ÑQ…É•Ð…Ì!Q51	ÕÑÑ½¹±•µ•¹Ð¤¹ÍÑå±”¹‰½É‘•É½±½È€ô€Ù…È ´µ‰½É‘•È¤œì€¡”¹ÕÉÉ•¹ÑQ…É•Ð…Ì!Q51	ÕÑÑ½¹±•µ•¹Ð¤¹ÍÑå±”¹½±½È€ô€Ù…È ´µÑ•áÐµµÕÑ•¤œõô4(€€€€€€€€€€€€€€ø4(€€€€€€€€€€€€€€€1½…µ½É”ƒŠPÍ¡½Ý¥¹œíÁ…¥¹…Ñ•¹±•¹Ñ¡ô½˜í™¥±Ñ•É•¹±•¹Ñ¡ô4(€€€€€€€€€€€€€€ð½‰ÕÑÑ½¸ø4(€€€€€€€€€€€€ð½‘¥Øø4(€€€€€€€€€€¥ô4(€€€€€€€€ð¼ø4(€€€€€€¥ô4(€€€€ð½‘¥Øø4(€€¤4)ô4(