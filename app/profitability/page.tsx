'use client'

import React, { useEffect, useMemo, useState } from 'react'
import {
  AlertCircle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Info,
  LoaderCircle,
  Search,
} from 'lucide-react'
import DateRangeFilter, { computeRange, type DateRange } from '@/components/DateRangeFilter'
import MarketplaceFilter from '@/components/MarketplaceFilter'
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
}

type CoverageRow = {
  pnl_category: string
  account_amount: number | string
  sku_allocated_amount: number | string
  unallocated_amount: number | string
  account_transaction_count: number | string
  sku_transaction_count: number | string
}

type RowFilter = 'all' | 'activity' | 'no_activity' | 'negative'

const PAGE_SIZE = 50
const INITIAL_RANGE = computeRange('last_90d', '', '')
const INCLUDED_CATEGORIES = ['gross_sales', 'promotions', 'refunds', 'amazon_fees', 'shipping', 'reimbursements']

const money = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 0,
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

function SummaryCard({ label, value, note, tone = 'default' }: {
  label: string
  value: string
  note: string
  tone?: 'default' | 'warning'
}) {
  return <div className="card" style={{ padding: '14px 16px' }}>
    <div style={{ fontSize: 9, color: 'var(--text-dim)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.07em' }}>{label}</div>
    <div style={{ marginTop: 7, fontSize: 22, lineHeight: 1, fontWeight: 700, fontFamily: 'JetBrains Mono, monospace', color: tone === 'warning' ? 'var(--amber)' : 'var(--text-primary)' }}>{value}</div>
    <div style={{ marginTop: 7, fontSize: 10, color: 'var(--text-muted)' }}>{note}</div>
  </div>
}

export default function ProfitabilityPage() {
  const [range, setRange] = useState<DateRange>(INITIAL_RANGE)
  const [markets, setMarkets] = useState<string[]>(['US'])
  const [rows, setRows] = useState<ProfitabilityRow[]>([])
  const [coverage, setCoverage] = useState<CoverageRow[]>([])
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<RowFilter>('all')
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE)
  const [expandedKey, setExpandedKey] = useState<string | null>(null)
  const [showCoverage, setShowCoverage] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

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
      const [skuResult, coverageResult] = await Promise.all([
        supabase.rpc('get_native_sku_profitability', params),
        supabase.rpc('get_native_profitability_coverage', params),
      ])

      if (cancelled) return
      if (skuResult.error || coverageResult.error) {
        setError(skuResult.error?.message || coverageResult.error?.message || 'Could not load native finance data.')
        setRows([])
        setCoverage([])
      } else {
        setRows((skuResult.data || []) as ProfitabilityRow[])
        setCoverage((coverageResult.data || []) as CoverageRow[])
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

  const filteredRows = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase()
    return rows.filter(row => {
      const hasActivity = n(row.transaction_count) > 0
      const matchesQuery = !normalizedQuery || [row.sku, row.asin || '', row.title]
        .some(value => value.toLowerCase().includes(normalizedQuery))
      const matchesFilter = filter === 'all'
        || (filter === 'activity' && hasActivity)
        || (filter === 'no_activity' && !hasActivity)
        || (filter === 'negative' && hasActivity && n(row.net_proceeds_before_ads_ldp) < 0)
      return matchesQuery && matchesFilter
    })
  }, [rows, query, filter])

  const visibleRows = filteredRows.slice(0, visibleCount)
  const filters: Array<{ value: RowFilter; label: string }> = [
    { value: 'all', label: 'All SKUs' },
    { value: 'activity', label: 'With activity' },
    { value: 'no_activity', label: 'No activity' },
    { value: 'negative', label: 'Negative proceeds' },
  ]

  return <div style={{ maxWidth: 1280 }}>
    <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 20, marginBottom: 18, flexWrap: 'wrap' }}>
      <div>
        <h1 style={{ fontSize: 20, fontWeight: 600, margin: 0, color: 'var(--text-primary)' }}>Profitability</h1>
        <p style={{ margin: '4px 0 0', color: 'var(--text-muted)', fontSize: 12 }}>Traceable Amazon proceeds by SKU Â· all amounts normalized to USD</p>
      </div>
      <div style={{ display: 'flex', gap: 14, alignItems: 'center', flexWrap: 'wrap' }}>
        <DateRangeFilter defaultPreset="last_90d" onChange={setRange} />
        <MarketplaceFilter selected={markets} onChange={setMarkets} />
      </div>
    </div>

    <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10, padding: '11px 13px', marginBottom: 14, borderRadius: 8, border: '1px solid var(--accent-border)', background: 'var(--accent-light)' }}>
      <Info size={16} style={{ color: 'var(--accent)', flex: '0 0 auto', marginTop: 1 }} />
      <div>
        <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-primary)' }}>This is not net profit yet</div>
        <div style={{ marginTop: 3, fontSize: 10, lineHeight: 1.5, color: 'var(--text-muted)' }}>Net proceeds include sales, promotions, refunds, Amazon fees, shipping, and reimbursements. Product advertising and LDP are intentionally excluded until those sources are connected.</div>
      </div>
    </div>

    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', gap: 10, marginBottom: 14 }}>
      <SummaryCard label="Gross sales" value={formatMoney(accountGrossSales)} note="Amazon finance ledger" />
      <SummaryCard label="Net proceeds" value={formatMoney(accountNetProceeds)} note="Before product ads and LDP" />
      <SummaryCard label="Advertising" value={formatMoney(accountAds)} note="Account total; SKU allocation pending" tone="warning" />
      <SummaryCard label="Unallocated fees" value={formatMoney(unallocatedFees)} note="Account-level Amazon fees" tone="warning" />
    </div>

    <button
      onClick={() => setShowCoverage(value => !value)}
      style={{ width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, padding: '10px 13px', marginBottom: showCoverage ? 0 : 14, border: '1px solid var(--border)', borderRadius: showCoverage ? '8px 8px 0 0' : 8, background: 'var(--bg-card)', color: 'var(--text-primary)', cursor: 'pointer' }}
    >
      <span style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 11, fontWeight: 600 }}><CheckCircle2 size={14} style={{ color: 'var(--green)' }} />Data reconciliation</span>
      <span style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 10, color: 'var(--text-muted)' }}>See account totals and SKU coverage {showCoverage ? <ChevronDown size={13} /> : <ChevronRight size={13} />}</span>
    </button>

    {showCoverage && <div className="card" style={{ borderTopLeftRadius: 0, borderTopRightRadius: 0, marginBottom: 14, overflow: 'hidden' }}>
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead><tr><th style={{ textAlign: 'left' }}>Source category</th><th style={{ textAlign: 'right' }}>Account total</th><th style={{ textAlign: 'right' }}>Assigned to SKUs</th><th style={{ textAlign: 'right' }}>Unallocated</th><th style={{ textAlign: 'right' }}>Coverage</th></tr></thead>
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
    </div>}

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
      {loading ? <div style={{ minHeight: 320, display: 'grid', placeItems: 'center' }}><div style={{ textAlign: 'center' }}><LoaderCircle className="cadence-loading-spinner" size={28} style={{ color: 'var(--accent)', margin: '0 auto 10px' }} /><div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-primary)' }}>Reconciling Amazon finance data</div><div style={{ marginTop: 4, fontSize: 10, color: 'var(--text-muted)' }}>Assigning signed ledger components to SKUsâ€¦</div></div></div>
      : error ? <div style={{ minHeight: 260, display: 'grid', placeItems: 'center', textAlign: 'center', padding: 24 }}><div><AlertCircle size={24} style={{ color: 'var(--red)', marginBottom: 8 }} /><div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-primary)' }}>Could not load profitability data</div><div style={{ marginTop: 5, fontSize: 10, color: 'var(--text-muted)' }}>{error}</div></div></div>
      : <div style={{ overflowX: 'auto', maxHeight: '68vh', overflowY: 'auto' }}>
        <table style={{ width: '100%', minWidth: 1060, borderCollapse: 'collapse' }}>
          <thead><tr><th style={{ textAlign: 'left', minWidth: 300 }}>Product</th><th style={{ textAlign: 'center' }}>Market</th><th style={{ textAlign: 'right' }}>Gross sales</th><th style={{ textAlign: 'right' }}>Promotions</th><th style={{ textAlign: 'right' }}>Refunds</th><th style={{ textAlign: 'right' }}>Amazon fees</th><th style={{ textAlign: 'right' }}>Shipping</th><th style={{ textAlign: 'right' }}>Reimbursements</th><th style={{ textAlign: 'right' }}>Net proceeds</th><th style={{ width: 28 }} /></tr></thead>
          <tbody>{visibleRows.map(row => {
            const key = `${row.marketplace}:${row.sku}`
            const expanded = expandedKey === key
            const hasActivity = n(row.transaction_count) > 0
            return <React.Fragment key={key}>
              <tr onClick={() => setExpandedKey(expanded ? null : key)} style={{ cursor: 'pointer', background: expanded ? 'var(--accent-light)' : undefined }}>
                <td><div style={{ maxWidth: 360, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 11, fontWeight: 600, color: 'var(--text-primary)' }}>{row.title}</div><div style={{ marginTop: 3, fontSize: 9, color: 'var(--text-dim)', fontFamily: 'JetBrains Mono, monospace' }}>{row.sku}{row.asin ? ` Â· ${row.asin}` : ''}</div></td>
                <td style={{ textAlign: 'center', fontSize: 10, color: 'var(--text-muted)' }}>{row.marketplace}</td>
                <td style={{ textAlign: 'right', fontFamily: 'JetBrains Mono, monospace' }}>{hasActivity ? formatMoney(row.gross_sales) : 'â€”'}</td>
                <td style={{ textAlign: 'right', fontFamily: 'JetBrains Mono, monospace', color: n(row.promotions) < 0 ? 'var(--red)' : 'var(--text-muted)' }}>{hasActivity ? formatMoney(row.promotions) : 'â€”'}</td>
                <td style={{ textAlign: 'right', fontFamily: 'JetBrains Mono, monospace', color: n(row.refunds) < 0 ? 'var(--red)' : 'var(--text-muted)' }}>{hasActivity ? formatMoney(row.refunds) : 'â€”'}</td>
                <td style={{ textAlign: 'right', fontFamily: 'JetBrains Mono, monospace', color: n(row.amazon_fees) < 0 ? 'var(--red)' : 'var(--text-muted)' }}>{hasActivity ? formatMoney(row.amazon_fees) : 'â€”'}</td>
                <td style={{ textAlign: 'right', fontFamily: 'JetBrains Mono, monospace' }}>{hasActivity ? formatMoney(row.shipping) : 'â€”'}</td>
                <td style={{ textAlign: 'right', fontFamily: 'JetBrains Mono, monospace' }}>{hasActivity ? formatMoney(row.reimbursements) : 'â€”'}</td>
                <td style={{ textAlign: 'right', fontFamily: 'JetBrains Mono, monospace', fontWeight: 700, color: n(row.net_proceeds_before_ads_ldp) < 0 ? 'var(--red)' : 'var(--text-primary)' }}>{hasActivity ? formatMoney(row.net_proceeds_before_ads_ldp) : 'No activity'}</td>
                <td style={{ textAlign: 'center', color: 'var(--text-dim)' }}>{expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}</td>
              </tr>
              {expanded && <tr><td colSpan={10} style={{ padding: 0 }}><div style={{ padding: '13px 16px', background: 'var(--bg-elevated)', display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 16 }}>
                <div><div style={{ fontSize: 9, color: 'var(--text-dim)', textTransform: 'uppercase', fontWeight: 700 }}>Calculation</div><div style={{ marginTop: 5, fontSize: 10, color: 'var(--text-muted)', lineHeight: 1.6 }}>Sales + promotions + refunds + Amazon fees + shipping + reimbursements = <strong style={{ color: 'var(--text-primary)' }}>{formatMoney(row.net_proceeds_before_ads_ldp)}</strong></div></div>
                <div><div style={{ fontSize: 9, color: 'var(--text-dim)', textTransform: 'uppercase', fontWeight: 700 }}>Source coverage</div><div style={{ marginTop: 5, fontSize: 10, color: 'var(--text-muted)', lineHeight: 1.6 }}>{n(row.transaction_count).toLocaleString()} Amazon finance transactions{row.last_transaction_date ? ` Â· latest ${row.last_transaction_date}` : ''}</div></div>
                <div><div style={{ fontSize: 9, color: 'var(--text-dim)', textTransform: 'uppercase', fontWeight: 700 }}>Still missing</div><div style={{ marginTop: 5, fontSize: 10, color: 'var(--amber)', lineHeight: 1.6 }}>Product advertising and LDP. SellerIQ will not label this SKU profitable or unprofitable yet.</div></div>
              </div></td></tr>}
            </React.Fragment>
          })}</tbody>
        </table>
        {filteredRows.length === 0 && <div style={{ padding: 48, textAlign: 'center', color: 'var(--text-muted)', fontSize: 12 }}>No SKUs match this search and filter.</div>}
      </div>}
    </div>

    {!loading && visibleRows.length < filteredRows.length && <div style={{ textAlign: 'center', marginTop: 14 }}><button onClick={() => setVisibleCount(count => count + PAGE_SIZE)} style={{ padding: '8px 20px', borderRadius: 7, border: '1px solid var(--border)', background: 'var(--bg-card)', color: 'var(--text-muted)', fontSize: 11, cursor: 'pointer' }}>Load more Â· showing {visibleRows.length} of {filteredRows.length}</button></div>}
  </div>
}

