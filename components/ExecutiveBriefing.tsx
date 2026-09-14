'use client'

import type { SkuDriver } from '@/components/SalesOverviewInsights'

type Metrics = {
  revenue: number
  priorRevenue: number
  units: number
  sessions: number
  priorSessions: number
  conversion: number
  priorConversion: number
  asp: number
  priorAsp: number
}

type Props = {
  comparisonAvailable: boolean
  comparisonLabel: string
  skuDrivers: SkuDriver[]
  metrics: Metrics
}

type Factor = { label: string; effect: number }
type FactorKey = 'traffic' | 'conversion' | 'price'

const FACTOR_ORDERS: FactorKey[][] = [
  ['traffic', 'conversion', 'price'], ['traffic', 'price', 'conversion'],
  ['conversion', 'traffic', 'price'], ['conversion', 'price', 'traffic'],
  ['price', 'traffic', 'conversion'], ['price', 'conversion', 'traffic'],
]

const n = (value: number | string | null | undefined) => Number(value) || 0
const money = (value: number) => `$${Math.abs(value).toLocaleString('en-US', { notation: 'compact', maximumFractionDigits: 1 })}`
const fullMoney = (value: number) => `$${Math.abs(value).toLocaleString('en-US', { maximumFractionDigits: 0 })}`
const relative = (current: number, prior: number) => prior > 0 ? ((current - prior) / prior) * 100 : null

function decompose(metrics: Metrics): Factor[] {
  const prior: Record<FactorKey, number> = { traffic: metrics.priorSessions, conversion: metrics.priorConversion / 100, price: metrics.priorAsp }
  const current: Record<FactorKey, number> = { traffic: metrics.sessions, conversion: metrics.conversion / 100, price: metrics.asp }
  const effects: Record<FactorKey, number> = { traffic: 0, conversion: 0, price: 0 }
  const revenue = (values: Record<FactorKey, number>) => values.traffic * values.conversion * values.price

  for (const order of FACTOR_ORDERS) {
    const state = { ...prior }
    let previous = revenue(state)
    for (const key of order) {
      state[key] = current[key]
      const next = revenue(state)
      effects[key] += (next - previous) / FACTOR_ORDERS.length
      previous = next
    }
  }

  return [
    { label: 'Traffic', effect: effects.traffic },
    { label: 'Conversion', effect: effects.conversion },
    { label: 'Selling price', effect: effects.price },
  ].sort((a, b) => Math.abs(b.effect) - Math.abs(a.effect))
}

export default function ExecutiveBriefing({ comparisonAvailable, comparisonLabel, skuDrivers, metrics }: Props) {
  const revenueChange = relative(metrics.revenue, metrics.priorRevenue)
  const primary = decompose(metrics)[0]
  const direction = (revenueChange || 0) >= 0 ? 'increased' : 'decreased'
  const changeKind = direction === 'increased' ? 'gains' : 'declines'
  const leaders = skuDrivers
    .map(row => ({ sku: row.sku, amount: Math.max(0, direction === 'increased' ? n(row.revenue_delta) : -n(row.revenue_delta)) }))
    .filter(row => row.amount > 0)
    .sort((a, b) => b.amount - a.amount)
  const topTwoAmount = leaders.slice(0, 2).reduce((sum, row) => sum + row.amount, 0)
  const allAmounts = leaders.reduce((sum, row) => sum + row.amount, 0)
  const concentration = allAmounts > 0 ? (topTwoAmount / allAmounts) * 100 : null
  const primaryVerb = primary.effect >= 0 ? 'added' : 'reduced revenue by'

  return (
    <section className="overview-briefing" aria-labelledby="briefing-heading" style={{ minHeight: 0, marginBottom: 12, padding: '22px 26px', borderRadius: 20 }}>
      <div className="overview-eyebrow">What changed?</div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(210px, 1fr))', gap: 22, alignItems: 'start', marginTop: 12 }}>
        <div>
          <div style={{ color: 'var(--text-dim)', fontSize: 9, fontWeight: 700, letterSpacing: '.08em', textTransform: 'uppercase' }}>Outcome</div>
          <h2 id="briefing-heading" style={{ width: 'auto', marginTop: 6, fontSize: 'clamp(22px, 2.3vw, 32px)', lineHeight: 1.08, letterSpacing: '-.04em' }}>
            {comparisonAvailable && revenueChange !== null
              ? `Revenue ${direction} ${Math.abs(revenueChange).toFixed(1)}% to ${money(metrics.revenue)}`
              : `${money(metrics.revenue)} in revenue`}
          </h2>
        </div>
        <div>
          <div style={{ color: 'var(--text-dim)', fontSize: 9, fontWeight: 700, letterSpacing: '.08em', textTransform: 'uppercase' }}>Primary cause</div>
          <p style={{ width: 'auto', marginTop: 6, fontSize: 12, lineHeight: 1.5 }}>
            {comparisonAvailable
              ? `${primary.label} ${primaryVerb} an estimated ${fullMoney(Math.abs(primary.effect))}.`
              : `A complete ${comparisonLabel} is unavailable, so cause estimates are withheld.`}
          </p>
        </div>
        <div>
          <div style={{ color: 'var(--text-dim)', fontSize: 9, fontWeight: 700, letterSpacing: '.08em', textTransform: 'uppercase' }}>Concentration</div>
          <p style={{ width: 'auto', marginTop: 6, fontSize: 12, lineHeight: 1.5 }}>
            {comparisonAvailable && concentration !== null && leaders[0]
              ? `The top two products generated ${concentration.toFixed(0)}% of product-level ${changeKind}, led by ${leaders[0].sku}.`
              : 'Product concentration requires a complete comparison period.'}
          </p>
          {comparisonAvailable && leaders.length > 0 && <a href="#product-drivers" style={{ display: 'inline-block', marginTop: 8, color: 'var(--accent)', fontSize: 10, fontWeight: 650 }}>View contributing products</a>}
        </div>
      </div>
    </section>
  )
}
