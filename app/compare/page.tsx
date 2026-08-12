'use client'

import { useEffect, useMemo, useState } from 'react'
import { ArrowRight, CheckCircle2, GitCompare, LoaderCircle, TrendingDown, TrendingUp } from 'lucide-react'
import AnalyticsPageHeader from '@/components/AnalyticsPageHeader'
import DashboardState from '@/components/DashboardState'
import DateRangeFilter, { type DateRange, PRESET_LABELS } from '@/components/DateRangeFilter'
import { useProductSelection } from '@/components/ProductSelectionContext'
import { supabase } from '@/lib/supabase'

type ConnectedMarket = {
  id: string
  channel: 'amazon'
  market: 'US' | 'CA'
  label: string
  shortLabel: string
}

type RawRow = {
  sku: string
  title?: string | null
  revenue?: number | string | null
  units?: number | string | null
  sessions?: number | string | null
  buy_box_pct?: number | string | null
  prev_revenue?: number | string | null
  prev_units?: number | string | null
  prev_sessions?: number | string | null
}

type ProductMetric = {
  sku: string
  title: string
  revenue: number
  units: number
  sessions: number
  buyBox: number | null
  priorRevenue: number
  growth: number | null
}

type MarketMetric = {
  source: ConnectedMarket
  revenue: number
  priorRevenue: number
  growth: number | null
  units: number
  sessions: number
  conversion: number | null
  asp: number | null
  buyBox: number | null
  products: ProductMetric[]
}

const CONNECTED_MARKETS: ConnectedMarket[] = [
  { id: 'amazon-us', channel: 'amazon', market: 'US', label: 'Amazon US', shortLabel: 'US' },
  { id: 'amazon-ca', channel: 'amazon', market: 'CA', label: 'Amazon Canada', shortLabel: 'CA' },
]

const money = (value: number) => value.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 })
const integer = (value: number) => Math.round(value).toLocaleString('en-US')
const percent = (value: number | null, digits = 1) => value == null ? 'Not available' : `${value.toFixed(digits)}%`
const signedPercent = (value: number | null) => value == null ? 'No prior comparison' : `${value >= 0 ? '+' : ''}${value.toFixed(1)}%`

function asNumber(value: unknown) {
  const number = Number(value)
  return Number.isFinite(number) ? number : 0
}

function aggregate(source: ConnectedMarket, rows: RawRow[]): MarketMetric {
  const products = rows.map(row => {
    const revenue = asNumber(row.revenue)
    const priorRevenue = asNumber(row.prev_revenue)
    return {
      sku: row.sku,
      title: row.title || row.sku,
      revenue,
      units: asNumber(row.units),
      sessions: asNumber(row.sessions),
      buyBox: row.buy_box_pct == null ? null : asNumber(row.buy_box_pct),
      priorRevenue,
      growth: priorRevenue > 0 ? (revenue - priorRevenue) / priorRevenue * 100 : null,
    }
  })
  const revenue = products.reduce((sum, row) => sum + row.revenue, 0)
  const priorRevenue = products.reduce((sum, row) => sum + row.priorRevenue, 0)
  const units = products.reduce((sum, row) => sum + row.units, 0)
  const sessions = products.reduce((sum, row) => sum + row.sessions, 0)
  const buyBoxRows = products.filter(row => row.buyBox != null && row.sessions > 0)
  const buyBoxWeight = buyBoxRows.reduce((sum, row) => sum + row.sessions, 0)
  const buyBox = buyBoxWeight > 0
    ? buyBoxRows.reduce((sum, row) => sum + (row.buyBox || 0) * row.sessions, 0) / buyBoxWeight
    : null
  return {
    source,
    revenue,
    priorRevenue,
    growth: priorRevenue > 0 ? (revenue - priorRevenue) / priorRevenue * 100 : null,
    units,
    sessions,
    conversion: sessions > 0 ? units / sessions * 100 : null,
    asp: units > 0 ? revenue / units : null,
    buyBox,
    products,
  }
}

function Delta({ value, suffix = '%' }: { value: number | null; suffix?: string }) {
  if (value == null) return <span className="compare-delta is-neutral">Not comparable</span>
  const positive = value >= 0
  return (
    <span className={`compare-delta ${positive ? 'is-positive' : 'is-negative'}`}>
      {positive ? <TrendingUp size={12} /> : <TrendingDown size={12} />}
      {positive ? '+' : ''}{value.toFixed(1)}{suffix}
    </span>
  )
}

export default function MarketplaceComparePage() {
  const [dateRange, setDateRange] = useState<DateRange | null>(null)
  const [markets, setMarkets] = useState<MarketMetric[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const { selectedProducts } = useProductSelection()

  useEffect(() => {
    if (!dateRange?.startDate) return
    let cancelled = false
    async function load() {
      setLoading(true)
      setError(null)
      const params = {
        p_start: dateRange!.startDate,
        p_end: dateRange!.endDate,
        p_prior_start: dateRange!.priorStart,
        p_prior_end: dateRange!.priorEnd,
        p_skus: selectedProducts.length ? selectedProducts.map(product => product.sku) : null,
      }
      const responses = await Promise.all(CONNECTED_MARKETS.map(source =>
        supabase.rpc('get_sku_sales_summary', { ...params, p_markets: [source.market] })
      ))
      if (cancelled) return
      const failed = responses.find(response => response.error)
      if (failed?.error) {
        setError(failed.error.message || 'Marketplace comparison could not be loaded.')
        setMarkets([])
      } else {
        setMarkets(responses.map((response, index) => aggregate(CONNECTED_MARKETS[index], (response.data || []) as RawRow[])))
      }
      setLoading(false)
    }
    load()
    return () => { cancelled = true }
  }, [dateRange, selectedProducts])

  const [left, right] = markets
  const comparison = useMemo(() => {
    if (!left || !right) return null
    const faster = left.growth != null && right.growth != null
      ? (left.growth >= right.growth ? left : right)
      : null
    const slower = faster?.source.id === left.source.id ? right : left
    const totalRevenue = left.revenue + right.revenue
    const share = totalRevenue > 0 ? left.revenue / totalRevenue * 100 : 0
    return { faster, slower, totalRevenue, share }
  }, [left, right])

  const productMoves = useMemo(() => {
    if (!left || !right) return []
    const rightBySku = new Map(right.products.map(product => [product.sku, product]))
    return left.products.flatMap(leftProduct => {
      const rightProduct = rightBySku.get(leftProduct.sku)
      if (!rightProduct) return []
      const leftChange = leftProduct.revenue - leftProduct.priorRevenue
      const rightChange = rightProduct.revenue - rightProduct.priorRevenue
      const leader = leftChange >= rightChange ? left.source : right.source
      return [{
        sku: leftProduct.sku,
        title: leftProduct.title,
        leftRevenue: leftProduct.revenue,
        rightRevenue: rightProduct.revenue,
        leftChange,
        rightChange,
        leader,
        spread: Math.abs(leftChange - rightChange),
      }]
    }).sort((a, b) => b.spread - a.spread).slice(0, 6)
  }, [left, right])

  const metricRows = left && right ? [
    { label: 'Revenue growth', left: signedPercent(left.growth), right: signedPercent(right.growth), leftRaw: left.growth, rightRaw: right.growth },
    { label: 'Sessions', left: integer(left.sessions), right: integer(right.sessions), leftRaw: left.sessions, rightRaw: right.sessions },
    { label: 'Conversion', left: percent(left.conversion), right: percent(right.conversion), leftRaw: left.conversion, rightRaw: right.conversion },
    { label: 'Average selling price', left: left.asp == null ? 'Not available' : money(left.asp), right: right.asp == null ? 'Not available' : money(right.asp), leftRaw: left.asp, rightRaw: right.asp },
    { label: 'Buy Box ownership', left: percent(left.buyBox), right: percent(right.buyBox), leftRaw: left.buyBox, rightRaw: right.buyBox },
  ] : []

  const headline = comparison?.faster && comparison.slower
    ? `${comparison.faster.source.label} is growing faster than ${comparison.slower.source.label}.`
    : 'Connected marketplaces are shown side by side.'
  const briefing = comparison?.faster && comparison.slower
    ? `${comparison.faster.source.shortLabel} revenue changed ${signedPercent(comparison.faster.growth)} versus ${signedPercent(comparison.slower.growth)} in ${comparison.slower.source.shortLabel}. ${left.source.shortLabel} represents ${comparison.share.toFixed(0)}% of combined revenue. This describes observed performance, not a proven cause.`
    : 'A prior-period comparison is not available for both marketplaces. Current performance remains visible without forcing a conclusion.'

  return (
    <div className="analytics-page marketplace-compare-page">
      <AnalyticsPageHeader
        title="Marketplace Compare"
        description={<>Cross-market performance canvas / {dateRange ? PRESET_LABELS[dateRange.preset] : 'Loading range'}{selectedProducts.length ? ` / ${selectedProducts.length} selected products` : ''}</>}
        actions={<DateRangeFilter defaultPreset="last_7d" onChange={setDateRange} />}
      />

      {loading ? (
        <DashboardState kind="loading" title="Comparing connected marketplaces" detail="Building a like-for-like view from the same date, product, and metric definitions." action={<LoaderCircle className="dashboard-state-spinner" size={20} />} />
      ) : error ? (
        <DashboardState kind="error" title="Marketplace comparison could not load" detail={error} />
      ) : !left || !right ? (
        <DashboardState kind="empty" title="Two connected marketplaces are required" detail="SellerIQ only compares marketplaces with verified data. Unconnected channels are not displayed." action={<GitCompare size={18} />} />
      ) : (
        <>
          <section className="compare-briefing">
            <div className="compare-eyebrow"><GitCompare size={14} /> Marketplace briefing</div>
            <h2>{headline}</h2>
            <p>{briefing}</p>
            <div className="compare-briefing-chips">
              <span>{money(comparison?.totalRevenue || 0)} combined revenue</span>
              <span>{integer(left.units + right.units)} units</span>
              <span>{integer(left.sessions + right.sessions)} sessions</span>
            </div>
          </section>

          <section className="compare-scoreboard" aria-label="Marketplace scorecard">
            {[left, right].map(market => (
              <article key={market.source.id} className={`compare-market-card is-${market.source.market.toLowerCase()}`}>
                <div className="compare-market-kicker"><span>{market.source.shortLabel}</span>{market.source.channel}</div>
                <strong>{market.source.label}</strong>
                <div className="compare-market-revenue">{money(market.revenue)}</div>
                <Delta value={market.growth} />
                <small>{integer(market.units)} units / {market.products.filter(product => product.revenue > 0).length} selling products</small>
              </article>
            ))}
            <div className="compare-center-mark" aria-hidden="true"><span>VS</span><ArrowRight size={16} /></div>
          </section>

          <section className="compare-driver-section">
            <div className="compare-section-heading">
              <div><span>Performance drivers</span><h3>Where the marketplaces differ</h3></div>
              <p>Identical definitions and date windows. The highlighted side has the higher observed value.</p>
            </div>
            <div className="compare-driver-list">
              {metricRows.map(metric => {
                const leftWins = metric.leftRaw != null && metric.rightRaw != null && metric.leftRaw >= metric.rightRaw
                const max = Math.max(Math.abs(metric.leftRaw || 0), Math.abs(metric.rightRaw || 0), 1)
                return (
                  <div className="compare-driver-row" key={metric.label}>
                    <div className={`compare-driver-value ${leftWins ? 'is-leading' : ''}`}><strong>{metric.left}</strong><span>{left.source.shortLabel}</span></div>
                    <div className="compare-driver-track">
                      <i className="is-left" style={{ width: `${Math.abs(metric.leftRaw || 0) / max * 50}%` }} />
                      <span>{metric.label}</span>
                      <i className="is-right" style={{ width: `${Math.abs(metric.rightRaw || 0) / max * 50}%` }} />
                    </div>
                    <div className={`compare-driver-value is-right ${!leftWins ? 'is-leading' : ''}`}><strong>{metric.right}</strong><span>{right.source.shortLabel}</span></div>
                  </div>
                )
              })}
            </div>
          </section>

          <section className="compare-opportunities">
            <div className="compare-section-heading">
              <div><span>Product divergence</span><h3>Products behaving differently by marketplace</h3></div>
              <p>Ranked by the difference in revenue movement. Use this to choose where to investigate, not as proof of causation.</p>
            </div>
            <div className="compare-opportunity-grid">
              {productMoves.map(product => (
                <article key={product.sku}>
                  <div className="compare-product-copy"><strong>{product.sku}</strong><span>{product.title}</span></div>
                  <div className="compare-product-values">
                    <span>{left.source.shortLabel} <b>{money(product.leftRevenue)}</b> <em className={product.leftChange >= 0 ? 'is-positive' : 'is-negative'}>{product.leftChange >= 0 ? '+' : ''}{money(product.leftChange)}</em></span>
                    <span>{right.source.shortLabel} <b>{money(product.rightRevenue)}</b> <em className={product.rightChange >= 0 ? 'is-positive' : 'is-negative'}>{product.rightChange >= 0 ? '+' : ''}{money(product.rightChange)}</em></span>
                  </div>
                  <div className="compare-product-leader"><CheckCircle2 size={13} /> Stronger movement in {product.leader.shortLabel}</div>
                </article>
              ))}
            </div>
          </section>
        </>
      )}
    </div>
  )
}
