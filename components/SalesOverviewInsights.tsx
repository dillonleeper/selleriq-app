'use client'

import { useState } from 'react'
import { ArrowDownRight, ArrowUpRight } from 'lucide-react'
import RecommendedActions from '@/components/RecommendedActions'

export type SkuDriver = {
  sku: string
  title: string
  revenue: number | string | null
  prior_revenue: number | string | null
  revenue_delta: number | string | null
  units: number | string | null
  sessions: number | string | null
  prior_sessions: number | string | null
  prior_units: number | string | null
  conversion_rate: number | string | null
  buy_box_pct: number | string | null
}

export type MarketDriver = {
  marketplace: string
  revenue: number | string | null
  prior_revenue: number | string | null
  units: number | string | null
  sessions: number | string | null
}

export type InventoryRisk = {
  sku: string
  marketplace: string
  snapshot_date: string
  available_quantity: number | string
  inbound_quantity: number | string
  fc_transfer_quantity: number | string
  fc_processing_quantity: number | string
  recent_units: number | string
  units_per_day: number | string
  available_days_of_cover: number | string
  days_of_cover: number | string
  estimated_monthly_revenue: number | string
}

type Props = {
  comparisonAvailable: boolean
  comparisonLabel: string
  skuDrivers: SkuDriver[]
  marketDrivers: MarketDriver[]
  inventoryRisks: InventoryRisk[]
  inventoryError: boolean
  metrics: {
    revenue: number
    priorRevenue: number
    units: number
    priorUnits: number
    sessions: number
    priorSessions: number
    conversion: number
    priorConversion: number
    asp: number
    priorAsp: number
  }
}

type FactorKey = 'traffic' | 'conversion' | 'asp'
type Factor = { key: FactorKey; label: string; effect: number; change: string; current: string }

const FACTOR_ORDER: FactorKey[][] = [
  ['traffic', 'conversion', 'asp'], ['traffic', 'asp', 'conversion'],
  ['conversion', 'traffic', 'asp'], ['conversion', 'asp', 'traffic'],
  ['asp', 'traffic', 'conversion'], ['asp', 'conversion', 'traffic'],
]

const n = (value: number | string | null | undefined) => Number(value) || 0
const money = (value: number, digits = 0) => `${value < 0 ? '-' : ''}$${Math.abs(value).toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })}`
const signedMoney = (value: number) => `${value >= 0 ? '+' : '-'}$${Math.abs(value).toLocaleString('en-US', { maximumFractionDigits: 0 })}`
const percent = (value: number) => `${value >= 0 ? '+' : ''}${value.toFixed(1)}%`
const relativeChange = (current: number, prior: number) => prior > 0 ? ((current - prior) / prior) * 100 : null
const factorRevenue = (values: Record<FactorKey, number>) => values.traffic * values.conversion * values.asp

function decomposeRevenue(metrics: Props['metrics']): Factor[] {
  const prior: Record<FactorKey, number> = {
    traffic: metrics.priorSessions,
    conversion: metrics.priorConversion / 100,
    asp: metrics.priorAsp,
  }
  const current: Record<FactorKey, number> = {
    traffic: metrics.sessions,
    conversion: metrics.conversion / 100,
    asp: metrics.asp,
  }
  const effects: Record<FactorKey, number> = { traffic: 0, conversion: 0, asp: 0 }

  for (const order of FACTOR_ORDER) {
    const state = { ...prior }
    let previousRevenue = factorRevenue(state)
    for (const key of order) {
      state[key] = current[key]
      const nextRevenue = factorRevenue(state)
      effects[key] += (nextRevenue - previousRevenue) / FACTOR_ORDER.length
      previousRevenue = nextRevenue
    }
  }

  const sessionChange = relativeChange(metrics.sessions, metrics.priorSessions)
  const aspChange = relativeChange(metrics.asp, metrics.priorAsp)
  return [
    { key: 'traffic', label: 'Traffic', effect: effects.traffic, change: sessionChange === null ? 'No prior sessions' : `${percent(sessionChange)} sessions`, current: metrics.sessions.toLocaleString('en-US') },
    { key: 'conversion', label: 'Conversion', effect: effects.conversion, change: `${metrics.conversion - metrics.priorConversion >= 0 ? '+' : ''}${(metrics.conversion - metrics.priorConversion).toFixed(2)} pp`, current: `${metrics.conversion.toFixed(2)}%` },
    { key: 'asp', label: 'Selling price', effect: effects.asp, change: aspChange === null ? 'No prior ASP' : `${percent(aspChange)} ASP`, current: money(metrics.asp, 2) },
  ]
}

function effectClause(factor: Factor) {
  if (Math.abs(factor.effect) < 1) return 'was neutral'
  return factor.effect >= 0 ? `added ${money(factor.effect)}` : `reduced revenue by ${money(Math.abs(factor.effect))}`
}

export default function SalesOverviewInsights({ comparisonAvailable, comparisonLabel, skuDrivers, marketDrivers, inventoryRisks, inventoryError, metrics }: Props) {
  const [driverView, setDriverView] = useState<'gains' | 'declines'>('gains')
  const positives = skuDrivers.filter(row => n(row.revenue_delta) > 0).sort((a, b) => n(b.revenue_delta) - n(a.revenue_delta)).slice(0, 5)
  const negatives = skuDrivers.filter(row => n(row.revenue_delta) < 0).sort((a, b) => n(a.revenue_delta) - n(b.revenue_delta)).slice(0, 5)
  const revenueDelta = metrics.revenue - metrics.priorRevenue
  const revenueChange = relativeChange(metrics.revenue, metrics.priorRevenue)
  const marketCurrentRevenue = marketDrivers.reduce((sum, row) => sum + n(row.revenue), 0)
  const factors = decomposeRevenue(metrics)
  const rankedFactors = [...factors].sort((a, b) => Math.abs(b.effect) - Math.abs(a.effect))
  const strongestSku = revenueDelta < 0 ? negatives[0] : positives[0]
  const explanation = comparisonAvailable && revenueChange !== null
    ? `Revenue ${revenueDelta >= 0 ? 'increased' : 'decreased'} ${money(Math.abs(revenueDelta))} (${percent(revenueChange)}) versus ${comparisonLabel}. The largest modeled effect came from ${rankedFactors[0].label.toLowerCase()}, which ${effectClause(rankedFactors[0])}. ${rankedFactors[1].label} ${effectClause(rankedFactors[1])}. ${strongestSku ? `${strongestSku.sku} was the largest SKU ${revenueDelta >= 0 ? 'gain' : 'decline'} at ${signedMoney(n(strongestSku.revenue_delta))}.` : 'No single SKU materially drove the change.'}`
    : `A complete ${comparisonLabel} is not available for this selection, so change attribution is intentionally withheld.`

  return (
    <div className="overview-story">
      <RecommendedActions comparisonAvailable={comparisonAvailable} skuDrivers={skuDrivers} inventoryRisks={inventoryRisks} inventoryError={inventoryError} />

      {marketDrivers.length > 0 && (
        <section className="card overview-market-card" aria-labelledby="market-heading">
          <div id="market-heading" style={{ fontSize: 13, fontWeight: 600, marginBottom: 3 }}>Marketplace contribution</div>
          <div style={{ fontSize: 10, color: 'var(--text-dim)', marginBottom: 10 }}>{comparisonAvailable ? `Current revenue mix and change versus ${comparisonLabel}.` : 'Current revenue mix. Comparison change is unavailable for this range.'}</div>
          {marketDrivers.map((row, index) => {
            const current = n(row.revenue)
            const prior = n(row.prior_revenue)
            const delta = current - prior
            const mix = marketCurrentRevenue > 0 ? (current / marketCurrentRevenue) * 100 : 0
            return (
              <div key={row.marketplace} style={{ display: 'grid', gridTemplateColumns: '70px minmax(130px, 1fr) auto auto', alignItems: 'center', gap: 12, padding: '9px 0', borderTop: index ? '1px solid var(--border)' : 'none', fontSize: 11 }}>
                <strong>{row.marketplace}</strong>
                <div style={{ height: 6, borderRadius: 999, background: 'var(--border)', overflow: 'hidden' }}><div style={{ width: `${Math.min(100, Math.max(0, mix))}%`, height: '100%', background: 'var(--accent)' }} /></div>
                <span style={{ color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>{mix.toFixed(1)}% · {money(current)}</span>
                <span style={{ color: comparisonAvailable ? (delta >= 0 ? 'var(--green)' : 'var(--red)') : 'var(--text-dim)', fontWeight: 600, whiteSpace: 'nowrap' }}>{comparisonAvailable ? signedMoney(delta) : 'Current mix'}</span>
              </div>
            )
          })}
        </section>
      )}

      {comparisonAvailable && (positives.length > 0 || negatives.length > 0) && (() => {
        const rows = driverView === 'gains' ? positives : negatives
        const color = driverView === 'gains' ? 'var(--green)' : 'var(--red)'
        const Icon = driverView === 'gains' ? ArrowUpRight : ArrowDownRight
        return (
          <section className="card overview-driver-panel" aria-labelledby="product-drivers-heading">
            <div className="overview-driver-header">
              <div>
                <div id="product-drivers-heading" style={{ fontSize: 13, fontWeight: 600 }}>Product drivers</div>
                <div style={{ fontSize: 10, color: 'var(--text-dim)', marginTop: 3 }}>Products contributing most to the selected comparison.</div>
              </div>
              <div className="overview-driver-tabs" role="group" aria-label="Product driver direction">
                <button type="button" className={driverView === 'gains' ? 'is-active' : ''} onClick={() => setDriverView('gains')}>Gaining</button>
                <button type="button" className={driverView === 'declines' ? 'is-active' : ''} onClick={() => setDriverView('declines')}>Declining</button>
              </div>
            </div>
            {rows.length === 0 ? (
              <div style={{ fontSize: 11, color: 'var(--text-dim)', paddingTop: 12 }}>No material SKU drivers.</div>
            ) : rows.map(row => (
              <div key={row.sku} className="overview-driver-row">
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 11, fontWeight: 600, fontFamily: 'JetBrains Mono, monospace' }}>{row.sku}</div>
                  <div title={row.title} style={{ fontSize: 10, color: 'var(--text-dim)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{row.title}</div>
                </div>
                <span style={{ color: 'var(--text-muted)', fontSize: 10 }}>{money(n(row.revenue))} revenue</span>
                <strong style={{ color, whiteSpace: 'nowrap', display: 'flex', alignItems: 'center', gap: 3 }}><Icon size={12} /> {signedMoney(n(row.revenue_delta))}</strong>
              </div>
            ))}
          </section>
        )
      })()}

    </div>
  )
}
