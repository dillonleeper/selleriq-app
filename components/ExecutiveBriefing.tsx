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

  const title = inventoryRisks.length > 0
    ? `${inventoryRisks.length} products need inventory attention${comparisonAvailable && revenueChange !== null ? ` while revenue is ${revenueChange >= 0 ? 'up' : 'down'} ${Math.abs(revenueChange).toFixed(1)}%` : ''}.`
    : comparisonAvailable && revenueChange !== null
      ? `Revenue is ${revenueChange >= 0 ? 'up' : 'down'} ${Math.abs(revenueChange).toFixed(1)}% with no high-priority inventory risks.`
      : 'No high-priority inventory risks are currently detected.'

  const story = comparisonAvailable && revenueChange !== null
    ? `${money(metrics.revenue)} in revenue across ${metrics.units.toLocaleString('en-US')} units. ${leadingMarket ? `${leadingMarket.marketplace} accounts for ${leadingMix.toFixed(0)}% of current marketplace revenue.` : ''}`
    : `${money(metrics.revenue)} in revenue across ${metrics.units.toLocaleString('en-US')} units. ${leadingMarket ? `${leadingMarket.marketplace} represents ${leadingMix.toFixed(0)}% of marketplace revenue.` : 'Marketplace mix is still loading.'}`

  return (
    <section className="overview-briefing" aria-labelledby="briefing-heading">
      <div className="overview-eyebrow">Executive briefing</div>
      <h2 id="briefing-heading">{title}</h2>
      <p>{story}</p>
    </section>
  )
}
