'use client'

import type { SkuDriver } from '@/components/SalesOverviewInsights'

type Metrics = { revenue: number; priorRevenue: number; sessions: number; priorSessions: number; conversion: number; priorConversion: number; asp: number; priorAsp: number }
type Props = { comparisonAvailable: boolean; comparisonLabel: string; skuDrivers: SkuDriver[]; metrics: Metrics }

const n = (value: number | string | null | undefined) => Number(value) || 0
const relative = (current: number, prior: number) => prior > 0 ? ((current - prior) / prior) * 100 : null
const signed = (value: number | null) => value === null ? 'unavailable' : `${value >= 0 ? '+' : ''}${value.toFixed(1)}%`

export default function ExecutiveBriefing({ comparisonAvailable, comparisonLabel, skuDrivers, metrics }: Props) {
  const revenueChange = relative(metrics.revenue, metrics.priorRevenue)
  const direction = (revenueChange || 0) >= 0 ? 'increased' : 'decreased'
  const changeKind = direction === 'increased' ? 'gains' : 'declines'
  const leaders = skuDrivers
    .map(row => ({ sku: row.sku, amount: Math.max(0, direction === 'increased' ? n(row.revenue_delta) : -n(row.revenue_delta)) }))
    .filter(row => row.amount > 0)
    .sort((a, b) => b.amount - a.amount)
  const topTwoAmount = leaders.slice(0, 2).reduce((sum, row) => sum + row.amount, 0)
  const allAmounts = leaders.reduce((sum, row) => sum + row.amount, 0)
  const concentration = allAmounts > 0 ? (topTwoAmount / allAmounts) * 100 : null
  const movement = comparisonAvailable && revenueChange !== null
    ? `Revenue ${direction} ${Math.abs(revenueChange).toFixed(1)}% alongside sessions ${signed(relative(metrics.sessions, metrics.priorSessions))}, conversion ${signed(relative(metrics.conversion, metrics.priorConversion))}, and selling price ${signed(relative(metrics.asp, metrics.priorAsp))}.`
    : `A complete ${comparisonLabel} is unavailable, so movement comparisons are withheld.`

  return (
    <section className="overview-briefing" aria-labelledby="briefing-heading" style={{ minHeight: 0, marginBottom: 12, padding: '18px 26px', borderRadius: 20 }}>
      <div id="briefing-heading" className="overview-eyebrow">What drove the change?</div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 28, alignItems: 'start', marginTop: 10 }}>
        <div>
          <div style={{ color: 'var(--text-dim)', fontSize: 9, fontWeight: 700, letterSpacing: '.08em', textTransform: 'uppercase' }}>Metric movement</div>
          <p style={{ width: 'auto', marginTop: 6, fontSize: 12, lineHeight: 1.5 }}>{movement}</p>
        </div>
        <div>
          <div style={{ color: 'var(--text-dim)', fontSize: 9, fontWeight: 700, letterSpacing: '.08em', textTransform: 'uppercase' }}>Product concentration</div>
          <p style={{ width: 'auto', marginTop: 6, fontSize: 12, lineHeight: 1.5 }}>
            {comparisonAvailable && concentration !== null && leaders[0]
              ? `${leaders[0].sku}${leaders[1] ? ` and ${leaders[1].sku}` : ''} accounted for ${concentration.toFixed(0)}% of ${changeKind} among products moving in that direction.`
              : 'Product concentration requires a complete comparison period.'}
          </p>
          {comparisonAvailable && leaders.length > 0 && <a href="#product-drivers" style={{ display: 'inline-block', marginTop: 7, color: 'var(--accent)', fontSize: 10, fontWeight: 650 }}>View contributing products</a>}
        </div>
      </div>
    </section>
  )
}
