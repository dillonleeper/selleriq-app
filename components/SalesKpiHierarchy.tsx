'use client'

import {
  BarChart2, Boxes, DollarSign, Eye, LockKeyhole,
  Percent, ShoppingCart
} from 'lucide-react'

type Props = {
  rangeLabel: string
  comparisonLabel: string
  comparisonComplete: boolean
  metrics: {
    revenue: number
    priorRevenue: number
    units: number
    priorUnits: number
    sessions: number
    priorSessions: number
    pageViews: number
    priorPageViews: number
    asp: number
    priorAsp: number
    conversion: number
    priorConversion: number
    buyBox: number
    priorBuyBox: number
    sellingSkus: number
    revenueRefundRate: number | null
    amazonFeeRate: number | null
    financeKpisAvailable: boolean
    financeKpiUnavailableReason: string
  }
}

const money = (value: number, decimals = 0) => '$' + value.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals })
const integer = (value: number) => Math.round(value).toLocaleString('en-US')
const relativeDelta = (current: number, prior: number) => prior > 0 ? ((current - prior) / prior) * 100 : null

type SummaryMetricProps = {
  label: string
  value: string
  detail: string
  icon: React.ReactNode
  color: string
  hero?: boolean
  delta?: number | null
}

function SummaryMetric({ label, value, detail, icon, color, hero, delta }: SummaryMetricProps) {
  return (
    <div className={`overview-summary-metric ${hero ? 'is-hero' : ''}`}>
      <div className="overview-metric-heading">
        <span>{label}</span>
        <span style={{ color }}>{icon}</span>
      </div>
      <div className="overview-metric-value">{value}</div>
      <div className="overview-metric-detail">
        <span>{detail}</span>
        {delta !== null && delta !== undefined && (
          <strong className={delta >= 0 ? 'is-positive' : 'is-negative'}>
            {delta > 0 ? '+' : ''}{delta.toFixed(1)}%
          </strong>
        )}
      </div>
    </div>
  )
}

type DiagnosticProps = {
  label: string
  value: string
  detail: string
  icon: React.ReactNode
  color: string
}

function Diagnostic({ label, value, detail, icon, color }: DiagnosticProps) {
  return (
    <div className="overview-diagnostic">
      <div className="overview-metric-heading">
        <span>{label}</span><span style={{ color }}>{icon}</span>
      </div>
      <div className="overview-diagnostic-value">{value}</div>
      <div className="overview-diagnostic-detail">{detail}</div>
    </div>
  )
}

export default function SalesKpiHierarchy({ rangeLabel, comparisonLabel, comparisonComplete, metrics }: Props) {
  const comparisonDetail = (priorValue: string) => comparisonComplete ? `${priorValue} ${comparisonLabel}` : ''

  const lockedItems = [
    { label: 'Contribution profit', reason: 'Connect Amazon Ads and landed product cost' },
    { label: 'Contribution margin', reason: 'Connect Amazon Ads and landed product cost' },
    { label: 'TACOS', reason: 'Connect and reconcile Amazon Ads' },
  ]

  return (
    <section className="overview-kpis" aria-labelledby="business-outcomes-heading">
      <div className="overview-section-heading">
        <div>
          <h2 id="business-outcomes-heading">Business outcomes</h2>
          <p>Primary KPIs · {rangeLabel}</p>
        </div>
        <span>{comparisonComplete ? `Compared with ${comparisonLabel}` : 'Current period · comparison unavailable'}</span>
      </div>

      <div className="overview-summary-panel">
        <SummaryMetric
          hero
          label="Ordered revenue"
          value={money(metrics.revenue)}
          detail={comparisonDetail(money(metrics.priorRevenue))}
          delta={comparisonComplete ? relativeDelta(metrics.revenue, metrics.priorRevenue) : null}
          icon={<DollarSign size={16} />}
          color="var(--accent)"
        />
        <SummaryMetric
          label="Buy Box ownership"
          value={metrics.buyBox > 0 ? `${metrics.buyBox.toFixed(1)}%` : '—'}
          detail={comparisonDetail(metrics.priorBuyBox > 0 ? `${metrics.priorBuyBox.toFixed(1)}%` : '—')}
          icon={<Boxes size={16} />}
          color="var(--accent)"
        />
        <SummaryMetric
          label="Revenue refund rate"
          value={metrics.revenueRefundRate === null ? '—' : `${metrics.revenueRefundRate.toFixed(2)}%`}
          detail={metrics.financeKpisAvailable ? 'Refund dollars ÷ gross sales' : metrics.financeKpiUnavailableReason}
          icon={<Percent size={16} />}
          color="var(--red)"
        />
        <SummaryMetric
          label="Amazon fee rate"
          value={metrics.amazonFeeRate === null ? '—' : `${metrics.amazonFeeRate.toFixed(2)}%`}
          detail={metrics.financeKpisAvailable ? 'Amazon fees ÷ gross sales' : metrics.financeKpiUnavailableReason}
          icon={<Percent size={16} />}
          color="var(--yellow)"
        />
      </div>

      <div className="overview-unlock-strip" aria-label="Metrics awaiting connected data">
        <div className="overview-unlock-intro">
          <LockKeyhole size={15} />
          <div><strong>Profitability metrics pending</strong><span>Connect Amazon Ads and landed product costs</span></div>
        </div>
        {lockedItems.map(item => (
          <div key={item.label} className="overview-locked-kpi">
            <strong>{item.label}</strong>
            <span>{item.reason}</span>
          </div>
        ))}
      </div>

      <div className="overview-section-heading demand-heading">
        <div>
          <h2>Demand health</h2>
          <p>{integer(metrics.sellingSkus)} selling SKUs in this period</p>
        </div>
      </div>
      <div className="overview-diagnostic-strip">
        <Diagnostic label="Sessions" value={integer(metrics.sessions)} detail={comparisonDetail(integer(metrics.priorSessions))} icon={<Eye size={15} />} color="var(--yellow)" />
        <Diagnostic label="Conversion" value={`${metrics.conversion.toFixed(2)}%`} detail={comparisonDetail(`${metrics.priorConversion.toFixed(2)}%`)} icon={<Percent size={15} />} color="#EC4899" />
        <Diagnostic label="Avg. selling price" value={money(metrics.asp, 2)} detail={comparisonDetail(money(metrics.priorAsp, 2))} icon={<BarChart2 size={15} />} color="#6366F1" />
        <Diagnostic label="Units ordered" value={integer(metrics.units)} detail={comparisonDetail(integer(metrics.priorUnits))} icon={<ShoppingCart size={15} />} color="var(--green)" />
        <Diagnostic label="Selling SKUs" value={integer(metrics.sellingSkus)} detail="Products with at least one unit" icon={<Boxes size={15} />} color="var(--accent)" />
      </div>
    </section>
  )
}
