'use client'

import React, { useEffect, useMemo, useState } from 'react'
import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Info,
  LoaderCircle,
  Search,
} from 'lucide-react'
import {
  Bar, BarChart, CartesianGrid, Cell, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts'
import DateRangeFilter, { computeRange, type DateRange } from '@/components/DateRangeFilter'
import MarketplaceFilter from '@/components/MarketplaceFilter'
import DashboardState from '@/components/DashboardState'
import LdpCostManager from '@/components/LdpCostManager'
import { useProductSelection } from '@/components/ProductSelectionContext'
import { ELLIPSIS, EM_DASH, MIDDOT, MINUS, skuAsinLabel } from '@/lib/displayText'
import { supabase } from '@/lib/supabase'

type ProfitabilityRow = {
  sku: string
  asin: string | null
  title: string
  marketplace: string
  gross_sales: number | string
  promotions: number | string
  refunds: number | string
  amazon_fees: number | string
  shipping: number | string
  reimbursements: number | string
  net_proceeds_before_ads_ldp: number | string
  transaction_count: number | string
  last_transaction_date: string | null
  shipped_units: number | string
  refunded_units: number | string
  net_units_for_cogs: number | string
  ldp_cost: number | string
  proceeds_after_ldp_before_ads: number | string
  ldp_coverage_pct: number | string
  missing_ldp_units: number | string}

type CoverageRow = {
  pnl_category: string
  account_amount: number | string
  sku_allocated_amount: number | string
  unallocated_amount: number | string
  account_transaction_count: number | string
  sku_transaction_count: number | string
}

type FeeBreakdownRow = {
  fee_type: string
  amount_usd: number | string
  transaction_count: number | string
}

type FinanceTransaction = {
  sale_date: string
  transaction_id: string
  order_id: string | null
  transaction_type: string
  transaction_status: string
  description: string | null
  gross_sales: number | string
  promotions: number | string
  refunds: number | string
  amazon_fees: number | string
  shipping: number | string
  reimbursements: number | string
  net_proceeds: number | string
  has_unmapped_component: boolean
}

type RowFilter = 'all' | 'activity' | 'no_activity' | 'negative'

// One column of the revenue waterfall. `span` is a Recharts range bar ([low, high]),
// which floats the column between two levels. A stacked invisible-base bar would be
// the other way to do this, but it renders wrong once a level goes negative, because
// Recharts stacks negative and positive values on opposite sides of the axis.
// `change` is the signed movement for the step (0 for levels) and `value` the level
// it lands on; both feed the tooltip. `kind` drives the color. A step is only a cost
// if it actually moves down -- reimbursements can exceed fees, and calling that a
// negative would misreport a gain.
type WaterfallStep = {
  label: string
  span: [number, number]
  change: number
  value: number
  kind: 'total' | 'cost' | 'gain'
}

const PAGE_SIZE = 50
const INITIAL_RANGE = computeRange('last_90d', '', '')
const INCLUDED_CATEGORIES = ['gross_sales', 'promotions', 'refunds', 'amazon_fees', 'shipping', 'reimbursements']

// LDP coverage thresholds for the warning banner, expressed as a percentage of SHIPPED
// UNITS that have an effective-dated cost -- not a percentage of SKUs. A handful of
// high-volume SKUs without a cost understates COGS far more than a long tail of
// low-volume ones, so units are what matter.
//
// Below WARN, "Proceeds after COGS" and "Margin %" are overstated by enough to change a
// decision, so say so. Below CRITICAL, COGS is not merely incomplete but effectively
// absent, and the banner escalates from amber to red.
//
// Tuning note: at the time of writing US sits at 95.3% and CA at 0.6%, so 95 puts US
// just barely in the clear. If you would rather be told about US's 3,467 uncosted units,
// raise WARN to 98 -- that is a judgement call about noise, not correctness.
const LDP_COVERAGE_WARN_PCT = 95
const LDP_COVERAGE_CRITICAL_PCT = 50

const money = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 0,
})

// Axis ticks only. Full precision stays in the cards, table, and tooltips.
const compactMoney = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  notation: 'compact',
  maximumFractionDigits: 1,
})

function n(value: number | string | null | undefined) {
  return Number(value || 0)
}

function formatMoney(value: number | string) {
  return money.format(n(value))
}

function coverageLabel(category: string) {
  const labels: Record<string, string> = {
    gross_sales: 'Gross sales',
    promotions: 'Promotions',
    refunds: 'Refunds',
    amazon_fees: 'Amazon fees',
    shipping: 'Shipping',
    reimbursements: 'Reimbursements',
    advertising_cost: 'Advertising',
  }
  return labels[category] || category.replaceAll('_', ' ')
}

function feeTypeLabel(value: string) {
  if (value === 'Other / correction') return value
  return value.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/F B A/g, 'FBA')
}

function feeTreatment(value: string) {
  if (value === 'SubscriptionFee') return 'Keep account-level'
  if (value === 'Other / correction') return 'SellerIQ review'
  return 'Potentially allocatable'
}

function SummaryCard({ label, value, note, tone = 'default' }: {
  label: string
  value: string
  note: string
  tone?: 'default' | 'warning'
}) {
  return <div className="card" style={{ padding: '14px 16px' }}>
    <div style={{ fontSize: 9, color: 'var(--text-dim)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.07em' }}>{label}</div>
    <div style={{ marginTop: 7, fontSize: 22, lineHeight: 1, fontWeight: 700, fontFamily: 'JetBrains Mono, monospace', color: tone === 'warning' ? 'var(--chart-warning)' : 'var(--text-primary)' }}>{value}</div>
    <div style={{ marginTop: 7, fontSize: 10, color: 'var(--text-muted)' }}>{note}</div>
  </div>
}

// Tier 1 headline metric. Deliberately NOT labelled net profit or net margin:
// advertising spend is not in these numbers yet. Once Amazon Ads is connected and
// ad cost is subtracted, promote these to true Net / Contribution Profit labels.
function HeroCard({ label, value, note, tone = 'default' }: {
  label: string
  value: string
  note: string
  tone?: 'default' | 'warning'
}) {
  return <div className="card" style={{ padding: '18px 20px' }}>
    <div style={{ fontSize: 10, color: 'var(--text-dim)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.07em' }}>{label}</div>
    <div style={{ marginTop: 10, fontSize: 34, lineHeight: 1, fontWeight: 700, fontFamily: 'JetBrains Mono, monospace', color: tone === 'warning' ? 'var(--chart-warning)' : 'var(--text-primary)' }}>{value}</div>
    <div style={{ marginTop: 9, fontSize: 10, lineHeight: 1.45, color: 'var(--text-muted)' }}>{note}</div>
  </div>
}

// Gross revenue -> net proceeds -> proceeds after COGS, with each drop shown as a
// floating bar so the leak between levels is the visible quantity.
function buildWaterfall(gross: number, net: number, after: number): WaterfallStep[] {
  if (![gross, net, after].every(Number.isFinite) || gross <= 0) return []
  // A level: a column from the axis to the running total.
  const level = (label: string, to: number): WaterfallStep => ({
    label,
    span: [Math.min(0, to), Math.max(0, to)],
    change: 0,
    value: to,
    kind: 'total',
  })
  // A movement: a column floating between the previous level and the next one.
  const move = (label: string, from: number, to: number): WaterfallStep => ({
    label,
    span: [Math.min(from, to), Math.max(from, to)],
    change: to - from,
    value: to,
    kind: to < from ? 'cost' : 'gain',
  })
  return [
    level('Gross revenue', gross),
    move('Amazon fees and returns', gross, net),
    level('Net proceeds', net),
    move('Recognized COGS', net, after),
    level('After COGS', after),
  ]
}

function WaterfallTooltip({ active, payload }: {
  active?: boolean
  payload?: Array<{ payload: WaterfallStep }>
}) {
  const step = active ? payload?.[0]?.payload : undefined
  if (!step) return null
  const isLevel = step.kind === 'total'
  return <div style={{ padding: '8px 10px', border: '1px solid var(--border)', borderRadius: 10, background: 'var(--bg-card)', boxShadow: 'var(--shadow-md)', fontSize: 12 }}>
    <div style={{ fontWeight: 600, color: 'var(--text-primary)' }}>{step.label}</div>
    <div style={{ marginTop: 3, fontFamily: 'JetBrains Mono, monospace', color: step.kind === 'cost' ? 'var(--red)' : 'var(--text-primary)' }}>
      {formatMoney(isLevel ? step.value : step.change)}
    </div>
    {!isLevel && <div style={{ marginTop: 2, fontSize: 10, color: 'var(--text-muted)' }}>{`Leaves ${formatMoney(step.value)}`}</div>}
  </div>
}

export default function ProfitabilityPage() {
  const { selectedProducts, setSelectedProducts } = useProductSelection()
  const [range, setRange] = useState<DateRange>(INITIAL_RANGE)
  const [markets, setMarkets] = useState<string[]>(['US'])
  const [rows, setRows] = useState<ProfitabilityRow[]>([])
  const [coverage, setCoverage] = useState<CoverageRow[]>([])
  const [feeBreakdown, setFeeBreakdown] = useState<FeeBreakdownRow[]>([])
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<RowFilter>('all')
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE)
  const [expandedKey, setExpandedKey] = useState<string | null>(null)
  const [showCoverage, setShowCoverage] = useState(false)
  // Set by the low-coverage banner to drive LdpCostManager straight to its Missing costs
  // view for one marketplace. The nonce is what makes a repeat click work: the view and
  // marketplace may be unchanged, so without it the effect on the other side would not
  // re-fire and the second click would appear to do nothing.
  const [ldpFocus, setLdpFocus] = useState<{ view: 'missing'; marketplace: string; nonce: number } | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [transactionsByKey, setTransactionsByKey] = useState<Record<string, FinanceTransaction[]>>({})
  const [transactionLoadingKey, setTransactionLoadingKey] = useState<string | null>(null)
  const [transactionErrors, setTransactionErrors] = useState<Record<string, string>>({})

  useEffect(() => {
    if (!range.startDate || !range.endDate) return
    let cancelled = false

    async function load() {
      setLoading(true)
      setError(null)

      const params = {
        p_start: range.startDate,
        p_end: range.endDate,
        p_markets: markets,
      }
      const [skuResult, coverageResult, feeBreakdownResult] = await Promise.all([
        supabase.rpc('get_native_sku_economics', params),
        supabase.rpc('get_native_profitability_coverage', params),
        supabase.rpc('get_native_account_fee_breakdown', params),
      ])

      if (cancelled) return
      if (skuResult.error || coverageResult.error || feeBreakdownResult.error) {
        setError(skuResult.error?.message || coverageResult.error?.message || feeBreakdownResult.error?.message || 'Could not load native finance data.')
        setRows([])
        setCoverage([])
        setFeeBreakdown([])
      } else {
        setRows((skuResult.data || []) as ProfitabilityRow[])
        setCoverage((coverageResult.data || []) as CoverageRow[])
        setFeeBreakdown((feeBreakdownResult.data || []) as FeeBreakdownRow[])
      }
      setVisibleCount(PAGE_SIZE)
      setExpandedKey(null)
      setLoading(false)
    }

    void load()
    return () => { cancelled = true }
  }, [range.startDate, range.endDate, markets])

  const coverageByCategory = useMemo(
    () => Object.fromEntries(coverage.map(item => [item.pnl_category, item])),
    [coverage],
  )

  const accountGrossSales = n(coverageByCategory.gross_sales?.account_amount)
  const accountAds = n(coverageByCategory.advertising_cost?.account_amount)
  const accountNetProceeds = INCLUDED_CATEGORIES.reduce(
    (sum, category) => sum + n(coverageByCategory[category]?.account_amount),
    0,
  )
  const unallocatedFees = n(coverageByCategory.amazon_fees?.unallocated_amount)
  const activeEconomics = rows.filter(row => n(row.transaction_count) > 0)
  const accountLdpCost = activeEconomics.reduce((sum, row) => sum + n(row.ldp_cost), 0)
  const accountAfterLdp = activeEconomics.reduce((sum, row) => sum + n(row.proceeds_after_ldp_before_ads), 0)
  const shippedUnits = activeEconomics.reduce((sum, row) => sum + n(row.shipped_units), 0)
  const coveredUnits = activeEconomics.reduce((sum, row) => sum + n(row.shipped_units) * n(row.ldp_coverage_pct) / 100, 0)
  const accountLdpCoverage = shippedUnits > 0 ? coveredUnits / shippedUnits * 100 : 100

  // Per-marketplace coverage, because the account-wide figure hides the problem whenever
  // one market is well covered and another is not: US 95.3% + CA 0.6% averages out to a
  // reassuring-looking 78.4%, and the banner would under-report a market with almost no
  // cost data at all.
  //
  // Weighted by shipped units, matching accountLdpCoverage above. Note this is NOT an
  // average of the per-SKU ldp_coverage_pct values -- that field defaults to 100 for a
  // SKU with no shipments, so averaging it across SKUs reports coverage that does not
  // exist (it reads 22.2% for CA, whose real unit coverage is 0.6%). activeEconomics
  // already excludes zero-activity SKUs, and the unit weighting makes the default
  // harmless regardless.
  const ldpCoverageByMarket = useMemo(() => {
    const totals = new Map<string, { shipped: number; covered: number; missingUnits: number; skusMissingCost: number; activeSkus: number }>()
    for (const row of activeEconomics) {
      const market = row.marketplace
      const entry = totals.get(market) || { shipped: 0, covered: 0, missingUnits: 0, skusMissingCost: 0, activeSkus: 0 }
      const rowShipped = n(row.shipped_units)
      const rowMissing = n(row.missing_ldp_units)
      entry.shipped += rowShipped
      entry.covered += rowShipped * n(row.ldp_coverage_pct) / 100
      entry.missingUnits += rowMissing
      entry.activeSkus += 1
      if (rowMissing > 0) entry.skusMissingCost += 1
      totals.set(market, entry)
    }
    return [...totals.entries()]
      .map(([marketplace, t]) => ({
        marketplace,
        coveragePct: t.shipped > 0 ? t.covered / t.shipped * 100 : 100,
        ...t,
      }))
      .sort((a, b) => a.coveragePct - b.coveragePct)
  }, [activeEconomics])

  const lowCoverageMarkets = ldpCoverageByMarket.filter(market => market.coveragePct < LDP_COVERAGE_WARN_PCT)
  const worstCoveragePct = lowCoverageMarkets.length
    ? Math.min(...lowCoverageMarkets.map(market => market.coveragePct))
    : 100
  const coverageAlertIsCritical = worstCoveragePct < LDP_COVERAGE_CRITICAL_PCT
  const coverageAlertColor = coverageAlertIsCritical ? 'var(--red)' : 'var(--yellow)'
  const coverageAlertBorder = coverageAlertIsCritical ? 'rgba(198,40,40,0.28)' : 'rgba(140,109,31,0.30)'
  const coverageAlertBackground = coverageAlertIsCritical ? 'var(--red-light)' : 'rgba(140,109,31,0.08)'
  // Share of gross revenue still held after COGS, before advertising. Null rather than
  // 0 when there is no revenue, so the card shows a dash instead of a misleading 0%.
  const afterCogsMargin = accountGrossSales > 0 ? accountAfterLdp / accountGrossSales * 100 : null
  const waterfall = useMemo(
    () => buildWaterfall(accountGrossSales, accountNetProceeds, accountAfterLdp),
    [accountGrossSales, accountNetProceeds, accountAfterLdp],
  )

  const filteredRows = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase()
    return rows.filter(row => {
      const hasActivity = n(row.transaction_count) > 0
      const matchesWorkspaceSelection = selectedProducts.length === 0 || selectedProducts.some(product => product.sku === row.sku)
      const matchesQuery = !normalizedQuery || [row.sku, row.asin || '', row.title]
        .some(value => value.toLowerCase().includes(normalizedQuery))
      const matchesFilter = filter === 'all'
        || (filter === 'activity' && hasActivity)
        || (filter === 'no_activity' && !hasActivity)
        || (filter === 'negative' && hasActivity && n(row.proceeds_after_ldp_before_ads) < 0)
      return matchesWorkspaceSelection && matchesQuery && matchesFilter
    })
  }, [rows, query, filter, selectedProducts])

  const visibleRows = filteredRows.slice(0, visibleCount)
  const filters: Array<{ value: RowFilter; label: string }> = [
    { value: 'all', label: 'All SKUs' },
    { value: 'activity', label: 'With activity' },
    { value: 'no_activity', label: 'No activity' },
    { value: 'negative', label: 'Negative before ads' },
  ]

  async function toggleRow(row: ProfitabilityRow, key: string) {
    if (expandedKey === key) {
      setExpandedKey(null)
      return
    }
    setExpandedKey(key)
    if (transactionsByKey[key] || transactionLoadingKey === key) return

    setTransactionLoadingKey(key)
    setTransactionErrors(current => ({ ...current, [key]: '' }))
    const result = await supabase.rpc('get_native_sku_finance_transactions', {
      p_start: range.startDate,
      p_end: range.endDate,
      p_marketplace: row.marketplace,
      p_sku: row.sku,
      p_limit: 100,
    })
    if (result.error) {
      setTransactionErrors(current => ({ ...current, [key]: result.error.message }))
    } else {
      setTransactionsByKey(current => ({ ...current, [key]: (result.data || []) as FinanceTransaction[] }))
    }
    setTransactionLoadingKey(current => current === key ? null : current)
  }

  return <div id="profitability-page" style={{ maxWidth: 1280 }}>
    <style jsx global>{`
      #profitability-page .profitability-table th,
      #profitability-page .profitability-table td {
        padding: 11px 18px !important;
      }
      #profitability-page .profitability-table th:first-child,
      #profitability-page .profitability-table td:first-child {
        padding-left: 22px !important;
      }
      #profitability-page .profitability-table th:last-child,
      #profitability-page .profitability-table td:last-child {
        padding-right: 22px !important;
      }
    `}</style>
    <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 20, marginBottom: 18, flexWrap: 'wrap' }}>
      <div>
        <h1 style={{ fontSize: 20, fontWeight: 600, margin: 0, color: 'var(--text-primary)' }}>Profitability</h1>
        <p style={{ margin: '4px 0 0', color: 'var(--text-muted)', fontSize: 12 }}>{`Traceable Amazon proceeds by SKU ${MIDDOT} all amounts normalized to USD`}</p>
      </div>
      <div style={{ display: 'flex', gap: 14, alignItems: 'center', flexWrap: 'wrap' }}>
        <DateRangeFilter defaultPreset="last_90d" onChange={setRange} />
        <MarketplaceFilter selected={markets} onChange={setMarkets} />
      </div>
    </div>

    {/* Data-integrity warning, deliberately above the "not net profit yet" note: that one
        is standing context, this one means the numbers below are wrong right now. */}
    {!loading && lowCoverageMarkets.length > 0 && (
      <div
        role="status"
        style={{ display: 'flex', alignItems: 'flex-start', gap: 10, padding: '12px 14px', marginBottom: 14, borderRadius: 8, border: `1px solid ${coverageAlertBorder}`, borderLeft: `3px solid ${coverageAlertColor}`, background: coverageAlertBackground }}
      >
        <AlertTriangle size={16} style={{ color: coverageAlertColor, flex: '0 0 auto', marginTop: 1 }} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-primary)' }}>
            {coverageAlertIsCritical ? 'COGS is missing for most units sold' : 'COGS is understated'}
          </div>
          <div style={{ marginTop: 3, fontSize: 10, lineHeight: 1.5, color: 'var(--text-muted)' }}>
            {`Proceeds after COGS and Margin % above are overstated, because some units sold have no effective-dated landed cost. Coverage is measured against shipped units, not SKU count ${MIDDOT} a single high-volume SKU without a cost moves this more than a long tail of small ones.`}
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 9 }}>
            {lowCoverageMarkets.map(market => (
              <div
                key={market.marketplace}
                style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', padding: '7px 9px', borderRadius: 7, border: '1px solid var(--border)', background: 'var(--bg-card)' }}
              >
                <div style={{ fontSize: 10.5, color: 'var(--text-muted)' }}>
                  <span style={{ fontWeight: 700, color: 'var(--text-primary)' }}>{market.marketplace}</span>
                  {` ${MIDDOT} `}
                  <strong style={{ color: market.coveragePct < LDP_COVERAGE_CRITICAL_PCT ? 'var(--red)' : 'var(--yellow)', fontVariantNumeric: 'tabular-nums' }}>
                    {`${market.coveragePct.toFixed(1)}% covered`}
                  </strong>
                  {` ${MIDDOT} ${market.skusMissingCost.toLocaleString()} of ${market.activeSkus.toLocaleString()} active SKUs have no cost`}
                  {` ${MIDDOT} ${market.missingUnits.toLocaleString()} uncosted units`}
                </div>
                <button
                  type="button"
                  onClick={() => setLdpFocus({ view: 'missing', marketplace: market.marketplace, nonce: Date.now() })}
                  style={{ display: 'inline-flex', alignItems: 'center', gap: 5, padding: '5px 9px', borderRadius: 6, border: `1px solid ${coverageAlertBorder}`, background: 'transparent', color: coverageAlertColor, font: 'inherit', fontSize: 10, fontWeight: 700, cursor: 'pointer', flex: '0 0 auto' }}
                >
                  {`Add ${market.marketplace} costs`}
                  <ArrowRight size={12} />
                </button>
              </div>
            ))}
          </div>
        </div>
      </div>
    )}

    <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10, padding: '11px 13px', marginBottom: 14, borderRadius: 8, border: '1px solid var(--accent-border)', background: 'var(--accent-light)' }}>
      <Info size={16} style={{ color: 'var(--accent)', flex: '0 0 auto', marginTop: 1 }} />
      <div>
        <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-primary)' }}>This is not net profit yet</div>
        <div style={{ marginTop: 3, fontSize: 10, lineHeight: 1.5, color: 'var(--text-muted)' }}>Amazon net proceeds remain the settlement figure. SellerIQ subtracts recognized LDP-based COGS separately to show proceeds after COGS, before advertising. Advertising remains unconnected, so this is not final contribution profit.</div>
      </div>
    </div>

    {/* Tier 1: headline numbers. Ad spend is not in these figures, so the labels stay
        conservative -- see the note on HeroCard before renaming them. */}
    <div className="analytics-kpi-grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 10, marginBottom: 12 }}>
      <HeroCard
        label="Gross revenue"
        value={formatMoney(accountGrossSales)}
        note="Amazon finance ledger, before fees and returns"
      />
      <HeroCard
        label="Proceeds after COGS"
        value={formatMoney(accountAfterLdp)}
        note="Amazon proceeds minus recognized COGS, before advertising"
        tone={accountAfterLdp < 0 ? 'warning' : 'default'}
      />
      <HeroCard
        label="Margin % (after COGS)"
        value={afterCogsMargin === null ? EM_DASH : `${afterCogsMargin.toFixed(1)}%`}
        note="Share of gross revenue retained after COGS, before advertising"
        tone={afterCogsMargin !== null && afterCogsMargin < 0 ? 'warning' : 'default'}
      />
    </div>

    {/* Tier 2: shape of the period. The waterfall runs off the period aggregates this
        page already loads. The dual-axis line and stacked bar trends need a daily
        finance series, which no client-callable RPC exposes yet. */}
    <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 2fr) minmax(0, 1fr)', gap: 10, marginBottom: 14 }}>
      <div className="card" style={{ padding: '15px 18px' }}>
        <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-primary)' }}>Where gross revenue goes</div>
        <div style={{ marginTop: 3, fontSize: 10, color: 'var(--text-muted)' }}>{`Each red column is a leak ${MIDDOT} blue and green are the levels that survive it`}</div>
        {waterfall.length === 0
          ? <div style={{ padding: '46px 0', textAlign: 'center', fontSize: 11, color: 'var(--text-muted)' }}>No gross revenue in this period to break down.</div>
          : <div style={{ height: 236, marginTop: 12 }}>
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={waterfall} margin={{ top: 6, right: 6, left: 0, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
                <XAxis dataKey="label" tick={{ fontSize: 9, fill: 'var(--text-dim)' }} tickLine={false} axisLine={false} interval={0} />
                <YAxis tick={{ fontSize: 10, fill: 'var(--text-dim)' }} tickLine={false} axisLine={false} width={62} tickFormatter={value => compactMoney.format(Number(value))} />
                <Tooltip content={<WaterfallTooltip />} cursor={{ fill: 'var(--bg-hover)' }} />
                <Bar dataKey="span" radius={[3, 3, 0, 0]} isAnimationActive={false}>
                  {waterfall.map((step, index) => <Cell
                    key={step.label}
                    fill={step.kind === 'cost'
                      ? 'var(--red)'
                      : step.kind === 'gain' || index === waterfall.length - 1
                        ? 'var(--chart-success)'
                        : 'var(--chart-primary)'}
                  />)}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>}
      </div>
      <div style={{ display: 'grid', gap: 10, alignContent: 'start' }}>
        <SummaryCard label="Net proceeds" value={formatMoney(accountNetProceeds)} note="Amazon settlement activity" />
        <SummaryCard label="Recognized COGS" value={formatMoney(-accountLdpCost)} note={`${accountLdpCoverage.toFixed(1)}% LDP coverage`} tone={accountLdpCoverage < 100 ? 'warning' : 'default'} />
      </div>
    </div>

    <LdpCostManager focusRequest={ldpFocus} />

    <button
      onClick={() => setShowCoverage(value => !value)}
      style={{ width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, padding: '10px 13px', marginBottom: showCoverage ? 0 : 14, border: '1px solid var(--border)', borderRadius: showCoverage ? '8px 8px 0 0' : 8, background: 'var(--bg-card)', color: 'var(--text-primary)', cursor: 'pointer' }}
    >
      <span style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 11, fontWeight: 600 }}><CheckCircle2 size={14} style={{ color: 'var(--green)' }} />Data reconciliation</span>
      <span style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 10, color: 'var(--text-muted)' }}>See account totals and SKU attribution {showCoverage ? <ChevronDown size={13} /> : <ChevronRight size={13} />}</span>
    </button>

    {showCoverage && <div className="card" style={{ borderTopLeftRadius: 0, borderTopRightRadius: 0, marginBottom: 14, overflow: 'hidden' }}>
      <div style={{ overflowX: 'auto' }}>
        <table className="profitability-table" style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead><tr><th style={{ textAlign: 'left' }}>Source category</th><th style={{ textAlign: 'right' }}>Account total</th><th style={{ textAlign: 'right' }}>Assigned to SKUs</th><th style={{ textAlign: 'right' }}>Account-level</th><th style={{ textAlign: 'right' }}>SKU attribution</th></tr></thead>
          <tbody>{coverage.filter(item => INCLUDED_CATEGORIES.includes(item.pnl_category) || item.pnl_category === 'advertising_cost').map(item => {
            const account = n(item.account_amount)
            const allocated = n(item.sku_allocated_amount)
            const ratio = account === 0 ? 100 : Math.min(100, Math.abs(allocated / account) * 100)
            return <tr key={item.pnl_category}>
              <td>{coverageLabel(item.pnl_category)}</td>
              <td style={{ textAlign: 'right', fontFamily: 'JetBrains Mono, monospace' }}>{formatMoney(account)}</td>
              <td style={{ textAlign: 'right', fontFamily: 'JetBrains Mono, monospace' }}>{formatMoney(allocated)}</td>
              <td style={{ textAlign: 'right', fontFamily: 'JetBrains Mono, monospace', color: Math.abs(n(item.unallocated_amount)) > 0.01 ? 'var(--amber)' : 'var(--text-muted)' }}>{formatMoney(item.unallocated_amount)}</td>
              <td style={{ textAlign: 'right', fontFamily: 'JetBrains Mono, monospace', color: ratio >= 99.99 ? 'var(--green)' : 'var(--amber)' }}>{ratio.toFixed(1)}%</td>
            </tr>
          })}</tbody>
        </table>
      </div>
      {feeBreakdown.length > 0 && <div style={{ borderTop: '1px solid var(--border)', padding: '14px 22px 18px' }}>
        <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-primary)' }}>Account-level Amazon fee breakdown</div>
        <div style={{ marginTop: 3, marginBottom: 10, fontSize: 10, color: 'var(--text-muted)' }}>These fees are present in SellerIQ but Amazon did not attach them directly to a SKU. No action is required from you.</div>
        <div style={{ marginBottom: 10, padding: '8px 10px', borderRadius: 5, background: 'var(--bg-elevated)', fontSize: 9, lineHeight: 1.5, color: 'var(--text-muted)' }}><strong style={{ color: 'var(--text-primary)' }}>Potentially allocatable</strong> means SellerIQ may attribute it using additional Amazon reports. <strong style={{ color: 'var(--text-primary)' }}>Keep account-level</strong> means it is not a product charge. <strong style={{ color: 'var(--text-primary)' }}>SellerIQ review</strong> means an unusual correction is awaiting automated classification.</div>
        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(180px, 1.6fr) minmax(110px, .7fr) minmax(90px, .6fr) minmax(190px, 1fr)', gap: 0, border: '1px solid var(--border)', borderRadius: 6, overflow: 'hidden' }}>
          <div style={{ padding: '9px 12px', background: 'var(--bg-elevated)', fontSize: 9, fontWeight: 700 }}>Fee category</div>
          <div style={{ padding: '9px 12px', background: 'var(--bg-elevated)', fontSize: 9, fontWeight: 700, textAlign: 'right' }}>Amount</div>
          <div style={{ padding: '9px 12px', background: 'var(--bg-elevated)', fontSize: 9, fontWeight: 700, textAlign: 'right' }}>Transactions</div>
          <div style={{ padding: '9px 12px', background: 'var(--bg-elevated)', fontSize: 9, fontWeight: 700 }}>Treatment</div>
          {feeBreakdown.map(item => <React.Fragment key={item.fee_type}>
            <div style={{ padding: '9px 12px', borderTop: '1px solid var(--border)', fontSize: 10 }}>{feeTypeLabel(item.fee_type)}</div>
            <div style={{ padding: '9px 12px', borderTop: '1px solid var(--border)', textAlign: 'right', fontFamily: 'JetBrains Mono, monospace', fontSize: 10, color: n(item.amount_usd) < 0 ? 'var(--red)' : 'var(--text-primary)' }}>{formatMoney(item.amount_usd)}</div>
            <div style={{ padding: '9px 12px', borderTop: '1px solid var(--border)', textAlign: 'right', fontFamily: 'JetBrains Mono, monospace', fontSize: 10 }}>{n(item.transaction_count).toLocaleString()}</div>
            <div style={{ padding: '9px 12px', borderTop: '1px solid var(--border)', fontSize: 9, color: item.fee_type === 'SubscriptionFee' ? 'var(--text-muted)' : item.fee_type === 'Other / correction' ? 'var(--red)' : 'var(--amber)' }}>{feeTreatment(item.fee_type)}</div>
          </React.Fragment>)}
        </div>
      </div>}
    </div>}

    {selectedProducts.length > 0 && <div className="workspace-filter-notice">
      <span><strong>{selectedProducts.length}</strong> product{selectedProducts.length === 1 ? '' : 's'} selected across SellerIQ</span>
      <button type="button" onClick={() => setSelectedProducts([])}>Clear selection</button>
    </div>}

    {/* Tier 3: profitability breakdown by product. */}
    <div style={{ display: 'flex', gap: 10, alignItems: 'center', justifyContent: 'space-between', marginBottom: 10, flexWrap: 'wrap' }}>
      <div style={{ position: 'relative', flex: '1 1 360px', maxWidth: 620 }}>
        <Search size={14} style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', color: 'var(--text-dim)' }} />
        <input
          value={query}
          onChange={event => { setQuery(event.target.value); setVisibleCount(PAGE_SIZE) }}
          placeholder="Search by SKU, ASIN, or product name"
          style={{ width: '100%', padding: '9px 12px 9px 34px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--bg-card)', color: 'var(--text-primary)', fontSize: 12, outline: 'none' }}
        />
      </div>
      <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
        {filters.map(option => <button key={option.value} onClick={() => { setFilter(option.value); setVisibleCount(PAGE_SIZE) }} style={{ padding: '6px 10px', borderRadius: 6, border: filter === option.value ? '1px solid var(--accent-border)' : '1px solid var(--border)', background: filter === option.value ? 'var(--accent-light)' : 'transparent', color: filter === option.value ? 'var(--accent)' : 'var(--text-muted)', fontSize: 10, fontWeight: 600, cursor: 'pointer' }}>{option.label}</button>)}
      </div>
    </div>

    <div className="card" style={{ overflow: 'hidden' }}>
      {loading ? <DashboardState kind="loading" title="Reconciling Amazon finance data" detail="Assigning signed ledger components to products and account-level activity." />
      : error ? <DashboardState kind="error" title="Could not load profitability data" detail={error} />
      : <div style={{ overflowX: 'hidden' }}>
        <table className="profitability-table" style={{ width: '100%', tableLayout: 'fixed', borderCollapse: 'collapse' }}>
          <colgroup>
            <col style={{ width: '34%' }} /><col style={{ width: '6%' }} /><col style={{ width: '13%' }} />
            <col style={{ width: '13%' }} /><col style={{ width: '12%' }} /><col style={{ width: '16%' }} />
            <col style={{ width: '6%' }} />
          </colgroup>
          <thead><tr><th style={{ textAlign: 'left' }}>Product</th><th style={{ textAlign: 'center' }}>Market</th><th style={{ textAlign: 'right' }}>Gross sales</th><th style={{ textAlign: 'right' }}>Net proceeds</th><th style={{ textAlign: 'right' }}>COGS</th><th style={{ textAlign: 'right' }}>After COGS</th><th style={{ width: 28 }} /></tr></thead>
          <tbody>{visibleRows.map(row => {
            const key = `${row.marketplace}:${row.sku}`
            const expanded = expandedKey === key
            const hasActivity = n(row.transaction_count) > 0
            return <React.Fragment key={key}>
              <tr onClick={() => void toggleRow(row, key)} style={{ cursor: 'pointer', background: expanded ? 'var(--accent-light)' : undefined }}>
                <td><div style={{ maxWidth: '100%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 11, fontWeight: 600, color: 'var(--text-primary)' }}>{row.title}</div><div style={{ marginTop: 3, fontSize: 9, color: 'var(--text-dim)', fontFamily: 'JetBrains Mono, monospace' }}>{skuAsinLabel(row.sku, row.asin)}</div></td>
                <td style={{ textAlign: 'center', fontSize: 10, color: 'var(--text-muted)' }}>{row.marketplace}</td>
                <td style={{ textAlign: 'right', fontFamily: 'JetBrains Mono, monospace' }}>{hasActivity ? formatMoney(row.gross_sales) : EM_DASH}</td>
                <td style={{ textAlign: 'right', fontFamily: 'JetBrains Mono, monospace' }}>{hasActivity ? formatMoney(row.net_proceeds_before_ads_ldp) : 'No activity'}</td>
                <td style={{ textAlign: 'right', fontFamily: 'JetBrains Mono, monospace', color: n(row.ldp_cost) > 0 ? 'var(--red)' : 'var(--text-muted)' }}>{hasActivity ? formatMoney(-n(row.ldp_cost)) : EM_DASH}<div style={{ marginTop: 2, fontSize: 8, color: n(row.ldp_coverage_pct) < 100 ? 'var(--amber)' : 'var(--text-dim)' }}>{n(row.ldp_coverage_pct).toFixed(0)}% covered</div></td>
                <td style={{ textAlign: 'right', fontFamily: 'JetBrains Mono, monospace', fontWeight: 700, color: n(row.proceeds_after_ldp_before_ads) < 0 ? 'var(--red)' : 'var(--text-primary)' }}>{hasActivity ? formatMoney(row.proceeds_after_ldp_before_ads) : 'No activity'}<div style={{ marginTop: 2, fontSize: 8, color: 'var(--text-dim)' }}>before ads</div></td>
                <td style={{ textAlign: 'center', color: 'var(--text-dim)' }}>{expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}</td>
              </tr>
              {expanded && <tr><td colSpan={7} style={{ padding: 0 }}>
                <div style={{ padding: '15px 18px', background: 'var(--bg-elevated)' }}>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 18 }}>
                    <div><div style={{ fontSize: 9, color: 'var(--text-dim)', textTransform: 'uppercase', fontWeight: 700 }}>Calculation</div><div style={{ marginTop: 5, fontSize: 10, color: 'var(--text-muted)', lineHeight: 1.6 }}>Amazon net proceeds <strong style={{ color: 'var(--text-primary)' }}>{formatMoney(row.net_proceeds_before_ads_ldp)}</strong>{` ${MINUS} recognized COGS `}<strong style={{ color: 'var(--red)' }}>{formatMoney(row.ldp_cost)}</strong> = <strong style={{ color: 'var(--text-primary)' }}>{formatMoney(row.proceeds_after_ldp_before_ads)}</strong> before ads</div></div>
                    <div><div style={{ fontSize: 9, color: 'var(--text-dim)', textTransform: 'uppercase', fontWeight: 700 }}>Source coverage</div><div style={{ marginTop: 5, fontSize: 10, color: 'var(--text-muted)', lineHeight: 1.6 }}>{n(row.transaction_count).toLocaleString()} Amazon finance transactions{row.last_transaction_date ? ` ${MIDDOT} latest ${row.last_transaction_date}` : ''}</div></div>
                    <div><div style={{ fontSize: 9, color: 'var(--text-dim)', textTransform: 'uppercase', fontWeight: 700 }}>Validation</div><div style={{ marginTop: 5, display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                      {!row.asin && <span style={{ padding: '3px 6px', borderRadius: 4, background: 'var(--amber-light)', color: 'var(--amber)', fontSize: 9 }}>Missing ASIN</span>}
                      {n(row.gross_sales) === 0 && hasActivity && <span style={{ padding: '3px 6px', borderRadius: 4, background: 'var(--amber-light)', color: 'var(--amber)', fontSize: 9 }}>Activity without sales</span>}
                      {Math.abs(n(row.amazon_fees)) > Math.abs(n(row.gross_sales)) && <span style={{ padding: '3px 6px', borderRadius: 4, background: 'var(--red-light)', color: 'var(--red)', fontSize: 9 }}>Fees exceed sales</span>}
                      {row.asin && !(n(row.gross_sales) === 0 && hasActivity) && Math.abs(n(row.amazon_fees)) <= Math.abs(n(row.gross_sales)) && <span style={{ padding: '3px 6px', borderRadius: 4, background: 'var(--green-light)', color: 'var(--green)', fontSize: 9 }}>No structural flags</span>}
                    </div></div>
                  </div>

                  <div style={{ marginTop: 15, paddingTop: 13, borderTop: '1px solid var(--border)' }}>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginBottom: 8 }}>
                      <div><div style={{ fontSize: 10, fontWeight: 700, color: 'var(--text-primary)' }}>Transaction trace</div><div style={{ marginTop: 2, fontSize: 9, color: 'var(--text-muted)' }}>Latest 100 Amazon finance transactions in the selected period</div></div>
                      {transactionLoadingKey === key && <LoaderCircle className="cadence-loading-spinner" size={16} style={{ color: 'var(--accent)' }} />}
                    </div>
                    {transactionErrors[key] ? <div style={{ padding: 10, color: 'var(--red)', fontSize: 10 }}>{transactionErrors[key]}</div>
                    : transactionLoadingKey === key ? <div style={{ padding: 18, textAlign: 'center', color: 'var(--text-muted)', fontSize: 10 }}>{`Loading transaction evidence${ELLIPSIS}`}</div>
                    : (transactionsByKey[key] || []).length === 0 ? <div style={{ padding: 18, textAlign: 'center', color: 'var(--text-muted)', fontSize: 10 }}>No source transactions found for this SKU and period.</div>
                    : <div style={{ overflowX: 'hidden', border: '1px solid var(--border)', borderRadius: 6 }}>
                      <table className="profitability-table" style={{ width: '100%', tableLayout: 'fixed', borderCollapse: 'collapse' }}>
                        <colgroup><col style={{ width: '12%' }} /><col style={{ width: '24%' }} /><col style={{ width: '22%' }} /><col style={{ width: '10%' }} /><col style={{ width: '10%' }} /><col style={{ width: '10%' }} /><col style={{ width: '12%' }} /></colgroup>
                        <thead><tr><th style={{ textAlign: 'left' }}>Date</th><th style={{ textAlign: 'left' }}>Order</th><th style={{ textAlign: 'left' }}>Type / status</th><th style={{ textAlign: 'right' }}>Sales</th><th style={{ textAlign: 'right' }}>Refunds</th><th style={{ textAlign: 'right' }}>Fees</th><th style={{ textAlign: 'right' }}>Net proceeds</th></tr></thead>
                        <tbody>{(transactionsByKey[key] || []).map(transaction => <tr key={transaction.transaction_id}>
                          <td style={{ whiteSpace: 'nowrap', fontFamily: 'JetBrains Mono, monospace', fontSize: 9 }}>{transaction.sale_date}</td>
                          <td><div style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 9 }}>{transaction.order_id || 'No order ID'}</div><div style={{ marginTop: 2, color: 'var(--text-dim)', fontSize: 8 }}>{transaction.description || transaction.transaction_id.slice(0, 16)}</div></td>
                          <td><div style={{ fontSize: 9 }}>{transaction.transaction_type}</div><div style={{ marginTop: 2, color: 'var(--text-dim)', fontSize: 8 }}>{transaction.transaction_status}{transaction.has_unmapped_component ? ` ${MIDDOT} unmapped component` : ''}</div></td>
                          <td style={{ textAlign: 'right', fontFamily: 'JetBrains Mono, monospace' }}>{formatMoney(transaction.gross_sales)}</td>
                          <td style={{ textAlign: 'right', fontFamily: 'JetBrains Mono, monospace', color: n(transaction.refunds) < 0 ? 'var(--red)' : undefined }}>{formatMoney(transaction.refunds)}</td>
                          <td style={{ textAlign: 'right', fontFamily: 'JetBrains Mono, monospace', color: n(transaction.amazon_fees) < 0 ? 'var(--red)' : undefined }}>{formatMoney(transaction.amazon_fees)}</td>
                          <td style={{ textAlign: 'right', fontFamily: 'JetBrains Mono, monospace', fontWeight: 700 }}>{formatMoney(transaction.net_proceeds)}</td>
                        </tr>)}</tbody>
                      </table>
                    </div>}
                  </div>
                </div>
              </td></tr>}
            </React.Fragment>
          })}</tbody>
        </table>
        {filteredRows.length === 0 && <div style={{ padding: 48, textAlign: 'center', color: 'var(--text-muted)', fontSize: 12 }}>No SKUs match this search and filter.</div>}
      </div>}
    </div>

    {!loading && visibleRows.length < filteredRows.length && <div style={{ textAlign: 'center', marginTop: 14 }}><button onClick={() => setVisibleCount(count => count + PAGE_SIZE)} style={{ padding: '8px 20px', borderRadius: 7, border: '1px solid var(--border)', background: 'var(--bg-card)', color: 'var(--text-muted)', fontSize: 11, cursor: 'pointer' }}>{`Load more ${MIDDOT} showing ${visibleRows.length} of ${filteredRows.length}`}</button></div>}
  </div>
}





