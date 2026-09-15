'use client'

import type { MarketDriver } from '@/components/SalesOverviewInsights'

type Props = {
  comparisonAvailable: boolean
  comparisonLabel: string
  marketDrivers: MarketDriver[]
  metrics: {
    revenue: number
    priorRevenue: number
    units: number
    sessions: number
    priorSessions: number
    conversion: number
    priorConversion: number
    asp: number
    priorAsp: number
    buyBox: number
    priorBuyBox: number
  }
}

const n = (value: number | string | null | undefined) => Number(value) || 0
const money = (value: number) => `$${Math.abs(value).toLocaleString('en-US', { maximumFractionDigits: 0 })}`
const relative = (current: number, prior: number) => prior > 0 ? ((current - prior) / prior) * 100 : null
const direction = (value: number) => value >= 0 ? 'up' : 'down'

function marketSentence(markets: MarketDriver[]) {
  const comparable = markets
    .map(row => ({ market: row.marketplace, change: relative(n(row.revenue), n(row.prior_revenue)) }))
    .filter((row): row is { market: string; change: number } => row.change !== null)
  if (comparable.length < 2) return ''
  const ranked = [...comparable].sort((a, b) => b.change - a.change)
  const leader = ranked[0]
  const trailer = ranked[ranked.length - 1]
  if (leader.change >= 0 && trailer.change < 0) {
    return `${leader.market} grew ${Math.abs(leader.change).toFixed(1)}% while ${trailer.market} declined ${Math.abs(trailer.change).toFixed(1)}%.`
  }
  if (leader.change >= 0) {
    return `${leader.market} grew faster than ${trailer.market} (${leader.change.toFixed(1)}% vs. ${trailer.change.toFixed(1)}%).`
  }
  return `${leader.market} held up better than ${trailer.market} (${Math.abs(leader.change).toFixed(1)}% vs. ${Math.abs(trailer.change).toFixed(1)}% decline).`
}

export default function ExecutiveBriefing({ comparisonAvailable, comparisonLabel, marketDrivers, metrics }: Props) {
  const revenueChange = relative(metrics.revenue, metrics.priorRevenue)
  const sessionChange = relative(metrics.sessions, metrics.priorSessions)
  const aspChange = relative(metrics.asp, metrics.priorAsp)
  const conversionChange = metrics.conversion - metrics.priorConversion
  const buyBoxChange = metrics.buyBox - metrics.priorBuyBox
  const marketContext = marketSentence(marketDrivers)

  if (!comparisonAvailable || revenueChange === null) {
    return (
      <section className="overview-briefing" aria-labelledby="briefing-heading">
        <div className="overview-eyebrow">Executive briefing</div>
        <h2 id="briefing-heading">{money(metrics.revenue)} in revenue across {metrics.units.toLocaleString('en-US')} units.</h2>
        <p>A complete {comparisonLabel} is not available, so SellerIQ is showing current account performance without labeling movement as good or bad.</p>
      </section>
    )
  }

  const signals = [
    sessionChange === null ? null : { magnitude: Math.abs(sessionChange), text: `sessions are ${direction(sessionChange)} ${Math.abs(sessionChange).toFixed(1)}%` },
    { magnitude: Math.abs(conversionChange) * 4, text: `conversion is ${direction(conversionChange)} ${Math.abs(conversionChange).toFixed(2)} points` },
    aspChange === null ? null : { magnitude: Math.abs(aspChange), text: `average selling price is ${direction(aspChange)} ${Math.abs(aspChange).toFixed(1)}%` },
    metrics.buyBox > 0 && metrics.priorBuyBox > 0 ? { magnitude: Math.abs(buyBoxChange) * 3, text: `Buy Box ownership is ${direction(buyBoxChange)} ${Math.abs(buyBoxChange).toFixed(1)} points` } : null,
  ].filter((signal): signal is { magnitude: number; text: string } => signal !== null)
    .sort((a, b) => b.magnitude - a.magnitude)

  const supporting = signals.slice(0, 2).map(signal => signal.text)
  const title = `Revenue is ${direction(revenueChange)} ${Math.abs(revenueChange).toFixed(1)}% versus ${comparisonLabel}.`
  const story = [supporting.length ? `${supporting.join('; ')}.` : '', marketContext].filter(Boolean).join(' ')

  return (
    <section className="overview-briefing" aria-labelledby="briefing-heading">
      <div className="overview-eyebrow">Executive briefing</div>
      <h2 id="briefing-heading">{title}</h2>
      <p>{story || `${money(metrics.revenue)} in revenue across ${metrics.units.toLocaleString('en-US')} units.`}</p>
    </section>
  )
}
