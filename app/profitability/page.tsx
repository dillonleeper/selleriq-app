'use client'

import { useEffect, useMemo, useState } from 'react'
import { AlertTriangle, CircleDollarSign, LoaderCircle, TrendingDown } from 'lucide-react'
import { supabase } from '@/lib/supabase'
import DateRangeFilter, { DateRange, PRESET_LABELS } from '@/components/DateRangeFilter'
import MarketplaceFilter from '@/components/MarketplaceFilter'

type ProfitRow = {
  sku: string; asin: string | null; title: string; marketplace: string
  units: number | string; refund_units: number | string; sales: number | string
  promotional_discounts: number | string; advertising_cost: number | string
  refund_cost: number | string; amazon_fees: number | string; ldp_cost: number | string
  shipping_cost: number | string; contribution_profit: number | string
  margin_pct: number | string | null; roi_pct: number | string | null
  sessions: number | string; cost_status: 'complete' | 'missing_ldp'
  recommendation_type: 'add_ldp' | 'unprofitable_product' | null
}

const money = (value: number) => value.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 })
const numeric = (value: number | string | null) => Number(value || 0)

export default function ProfitabilityPage() {
  const [markets, setMarkets] = useState(['US'])
  const [dateRange, setDateRange] = useState<DateRange | null>(null)
  const [rows, setRows] = useState<ProfitRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!dateRange?.startDate) return
    let cancelled = false
    supabase.rpc('get_contribution_profit', {
      p_start: dateRange.startDate, p_end: dateRange.endDate,
      p_markets: markets, p_skus: null,
    }).then(({ data, error: queryError }) => {
      if (cancelled) return
      if (queryError) { setError(queryError.message); setRows([]) }
      else setRows((data || []) as ProfitRow[])
      setLoading(false)
    })
    return () => { cancelled = true }
  }, [dateRange, markets])

  const summary = useMemo(() => rows.reduce((result, row) => {
    result.sales += numeric(row.sales); result.profit += numeric(row.contribution_profit)
    result.ads += numeric(row.advertising_cost); result.ldp += numeric(row.ldp_cost)
    if (row.cost_status === 'missing_ldp') result.missingCost += 1
    return result
  }, { sales: 0, profit: 0, ads: 0, ldp: 0, missingCost: 0 }), [rows])
  const margin = summary.sales ? summary.profit / summary.sales * 100 : 0
  const flaggedRows = rows.filter(row => row.recommendation_type)

  const changeDateRange = (nextRange: DateRange) => {
    setLoading(true)
    setError(null)
    setDateRange(nextRange)
  }

  const changeMarkets = (nextMarkets: string[]) => {
    setLoading(true)
    setError(null)
    setMarkets(nextMarkets)
  }

  return <div>
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 20, marginBottom: 24 }}>
      <div><h1 style={{ fontSize: 20, fontWeight: 600, margin: 0, color: 'var(--text-primary)' }}>Profitability</h1>
        <p style={{ margin: '4px 0 0', color: 'var(--text-muted)', fontSize: 12 }}>Contribution profit after advertising, Amazon fees, refunds, and full landed product cost{dateRange ? ` · ${PRESET_LABELS[dateRange.preset]}` : ''}</p>
      </div>
      <div style={{ display: 'flex', gap: 14, alignItems: 'center', flexWrap: 'wrap', justifyContent: 'flex-end' }}>
        <DateRangeFilter onChange={changeDateRange} defaultPreset="last_90d" />
        <MarketplaceFilter selected={markets} onChange={changeMarkets} />
      </div>
    </div>

    {loading ? <div className="card" role="status" style={{ minHeight: 360, display: 'grid', placeItems: 'center' }}>
      <div style={{ textAlign: 'center' }}><LoaderCircle className="cadence-loading-spinner" size={30} style={{ color: 'var(--accent)', marginBottom: 12 }} />
        <div style={{ color: 'var(--text-primary)', fontWeight: 600 }}>Calculating contribution profit</div>
        <div style={{ color: 'var(--text-muted)', fontSize: 12, marginTop: 4 }}>Matching revenue and costs for the selected period</div>
      </div></div>
    : error ? <div className="card" style={{ padding: 24, color: 'var(--red)' }}>Couldn&apos;t load profitability: {error}</div>
    : rows.length === 0 ? <div className="card" style={{ padding: 44, textAlign: 'center' }}><CircleDollarSign size={28} style={{ color: 'var(--text-dim)', marginBottom: 10 }} />
        <div style={{ color: 'var(--text-primary)', fontWeight: 600 }}>No profitability benchmark for this period</div>
        <div style={{ color: 'var(--text-muted)', fontSize: 12, marginTop: 5 }}>Choose a period containing an imported profitability month.</div></div>
    : <>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', gap: 12, marginBottom: 16 }}>
        {([['Sales', money(summary.sales)], ['Contribution profit', money(summary.profit)], ['Margin', `${margin.toFixed(1)}%`], ['Needs attention', `${flaggedRows.length} SKUs`]] as [string,string][]).map(([label,value]) =>
          <div className="card" key={label} style={{ padding: 16 }}><div style={{ fontSize: 10, color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: '.06em' }}>{label}</div>
            <div style={{ fontSize: 22, fontWeight: 650, color: label === 'Needs attention' && flaggedRows.length ? 'var(--red)' : 'var(--text-primary)', marginTop: 5, fontFamily: 'JetBrains Mono, monospace' }}>{value}</div></div>)}
      </div>
      <div className="card" style={{ overflow: 'hidden' }}>
        <div style={{ padding: '15px 16px', borderBottom: '1px solid var(--border)', display: 'flex', justifyContent: 'space-between' }}><div>
          <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' }}>Recommended actions</div>
          <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>Review missing costs first; profit is not verified until every selling SKU has LDP.</div></div>
          {summary.missingCost > 0 && <span style={{ color: 'var(--amber)', fontSize: 11 }}>{summary.missingCost} missing LDP</span>}
        </div>
        <div style={{ overflowX: 'auto' }}><table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 980 }}>
          <thead><tr>{['Product','Sales','Ads','Amazon fees','LDP','Profit','Margin','Recommendation'].map(header => <th key={header} style={{ padding: '10px 12px', textAlign: header === 'Product' || header === 'Recommendation' ? 'left' : 'right', fontSize: 10, color: 'var(--text-dim)', borderBottom: '1px solid var(--border)', textTransform: 'uppercase' }}>{header}</th>)}</tr></thead>
          <tbody>{flaggedRows.map(row => { const missing = row.cost_status === 'missing_ldp'; return <tr key={`${row.marketplace}-${row.sku}`} style={{ borderBottom: '1px solid var(--border)' }}>
            <td style={{ padding: '11px 12px' }}><div style={{ fontSize: 12, color: 'var(--text-primary)', fontWeight: 500 }}>{row.title}</div><div style={{ fontSize: 10, color: 'var(--text-dim)', fontFamily: 'JetBrains Mono, monospace' }}>{row.sku}</div></td>
            {[row.sales,row.advertising_cost,row.amazon_fees,row.ldp_cost,row.contribution_profit].map((value,index) => <td key={index} style={{ padding: '11px 12px', textAlign: 'right', fontSize: 11, fontFamily: 'JetBrains Mono, monospace', color: index === 4 && numeric(value) < 0 ? 'var(--red)' : 'var(--text-primary)' }}>{money(numeric(value))}</td>)}
            <td style={{ padding: '11px 12px', textAlign: 'right', fontSize: 11, color: numeric(row.margin_pct) < 0 ? 'var(--red)' : 'var(--text-primary)' }}>{numeric(row.margin_pct).toFixed(1)}%</td>
            <td style={{ padding: '11px 12px', minWidth: 240 }}><div style={{ display: 'flex', gap: 7, alignItems: 'flex-start', color: missing ? 'var(--amber)' : 'var(--red)', fontSize: 11, fontWeight: 600 }}>
              {missing ? <AlertTriangle size={14} /> : <TrendingDown size={14} />}<span>{missing ? 'Add landed cost before trusting this profit.' : 'Losing money after advertising, Amazon fees, refunds, and LDP.'}</span></div></td>
          </tr>})}</tbody>
        </table></div>
      </div>
    </>}
  </div>
}
