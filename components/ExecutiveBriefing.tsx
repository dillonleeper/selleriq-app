'use client'

import type { InventoryRisk, MarketDriver } from '@/components/SalesOverviewInsights'

type Props = {
  comparisonAvailable: boolean
  comparisonLabel: string
  marketDrivers: MarketDriver[]
  inventoryRisks: InventoryRisk[]
  metrics: {
    revenue: number
    priorRevenue: number
    units: number
    conversion: number
    asp: number
  }
}

const n = (value: number | string | null | undefined) => Number(value) || 0
const money = (value: number, digits = 0) =>
  `${value < 0 ? '-' : ''}$${Math.abs(value).toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })}`

export default function ExecutiveBriefing({ comparisonAvailable, comparisonLabel, marketDrivers, inventoryRisks, metrics }: Props) {
  const marketRevenue = marketDrivers.reduce((sum, row) => sum + n(row.revenue), 0)
  const leadingMarket = [...marketDrivers].sort((a, b) => n(b.revenue) - n(a.revenue))[0]
  const leadingMix = leadingMarket && marketRevenue > 0 ? (n(leadingMarket.revenue) / marketRevenue) * 100 : 0
  const revenueDelta = metrics.revenue - metrics.priorRevenue
  const revenueChange = metrics.priorRevenue > 0 ? (revenueDelta / metrics.priorRevenue) * 100 : null

  const story = comparisonAvailable && revenueChange !== null
    ? `Revenue ${revenueDelta >= 0 ? 'increased' : 'decreased'} ${money(Math.abs(revenueDelta))} (${revenueChange >= 0 ? '+' : ''}${revenueChange.toFixed(1)}%) versus ${comparisonLabel}. ${leadingMarket ? `${leadingMarket.marketplace} accounts for ${leadingMix.toFixed(0)}% of current marketplace revenue.` : ''}`
    : `Current performance is shown without a forced comparison. ${leadingMarket ? `${leadingMarket.marketplace} represents ${leadingMix.toFixed(0)}% of marketplace revenue.` : 'Marketplace mix is still loading.'}`

  return (
    <section className="overview-briefing" aria-labelledby="briefing-heading">
      <div className="overview-eyebrow">Executive briefing</div>
      <h2 id="briefing-heading">{money(metrics.revenue)} in ordered revenue across {metrics.units.toLocaleString('en-US')} units.</h2>
      <p>{story}</p>
      <div className="overview-briefing-chips">
        <span><strong>{metrics.conversion.toFixed(2)}%</strong> conversion</span>
        <span><strong>{money(metrics.asp, 2)}</strong> average selling price</span>
        <span><strong>{inventoryRisks.length}</strong> inventory risks detected</span>
      </div>
    </section>
  )
}
