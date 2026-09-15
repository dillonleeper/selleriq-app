'use client'

import {
  BarChart2, Boxes, DollarSign, Eye, LockKeyhole,
  CheckCircle2, Percent, ShoppingCart
} from 'lucide-react'

export type ChartSeries = 'revenue' | 'units' | 'sessions' | 'conversion'

type Props = {
  comparisonLabel: string
  comparisonComplete: boolean
  activeSeries: ChartSeries[]
  onSeriesToggle: (series: ChartSeries) => void
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
  onClick?: () => void
  active?: boolean
}

function SummaryMetric({ label, value, detail, icon, color, hero, delta, onClick, active }: SummaryMetricProps) {
  return (
    <div
      className={`overview-summary-metric ${hero ? 'is-hero' : ''} ${active ? 'is-charted' : ''}`}
      role={onClick ? 'button' : undefined}
      tabIndex={onClick ? 0 : undefined}
      aria-pressed={onClick ? active : undefined}
      title={active ? `Remove ${label} from chart` : `Add ${label} to chart`}
      onClick={onClick}
      onKeyDown={onClick ? event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onClick() } } : undefined}
      style={{ cursor: onClick ? 'pointer' : 'default', '--chart-selection-color': color } as React.CSSProperties}
    >
      <div className="overview-metric-heading">
        <span>{label}</span>
        <span style={{ color, display: 'flex', alignItems: 'center', gap: 5 }}>{active && <><CheckCircle2 size={12} /><small style={{ fontSize: 8, fontWeight: 700 }}>CHARTED</small></>}{icon}</span>
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

const SHOW_SECONDARY_KPIS = false
const SHOW_PROFITABILITY_PENDING = false

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

export default function SalesKpiHierarchy({ comparisonLabel, comparisonComplete, activeSeries, onSeriesToggle, metrics }: Props) {
  const comparisonDetail = (priorValue: string) => comparisonComplete ? `${priorValue} ${comparisonLabel}` : ''

  const lockedItems = [
    { label: 'Contribution profit', reason: 'Connect Amazon Ads and landed product cost' },
    { label: 'Contribution margin', reason: 'Connect Amazon Ads and landed product cost' },
    { label: 'TACOS', reason: 'Connect and reconcile Amazon Ads' },
  ]

  return (
    <section className="overview-kpis" aria-label="Sales KPIs" style={{ marginBottom: 12 }}>
      <div className="overview-summary-panel">
        <SummaryMetric
          hero
          label="Ordered revenue"
          value={money(metrics.revenue)}
          detail={comparisonDetail(money(metrics.priorRevenue))}
          delta={comparisonComplete ? relativeDelta(metrics.revenue, metrics.priorRevenue) : null}
          onClick={() => onSeriesToggle('revenue')}
          active={activeSeries.includes('revenue')}
          icon={<DollarSign size={16} />}
          color="var(--accent)"
        />
        <SummaryMetric
          label="Units ordered"
          value={integer(metrics.units)}
          detail={comparisonDetail(integer(metrics.priorUnits))}
          delta={comparisonComplete ? relativeDelta(metrics.units, metrics.priorUnits) : null}
          onClick={() => onSeriesToggle('units')}
          active={activeSeries.includes('units')}
          icon={<ShoppingCart size={16} />}
          color="var(--green)"
        />
        <SummaryMetric
          label="Sessions"
          value={integer(metrics.sessions)}
          detail={comparisonDetail(integer(metrics.priorSessions))}
          delta={comparisonComplete ? relativeDelta(metrics.sessions, metrics.priorSessions) : null}
          onClick={() => onSeriesToggle('sessions')}
          active={activeSeries.includes('sessions')}
          icon={<Eye size={16} />}
          color="var(--yellow)"
        />
        <SummaryMetric
          label="Conversion"
          value={`${metrics.conversion.toFixed(2)}%`}
          detail={comparisonDetail(`${metrics.priorConversion.toFixed(2)}%`)}
          delta={comparisonComplete && metrics.priorConversion > 0 ? relativeDelta(metrics.conversion, metrics.priorConversion) : null}
          onClick={() => onSeriesToggle('conversion')}
          active={activeSeries.includes('conversion')}
          icon={<Percent size={16} />}
          color="#EC4899"
        />
      </div>

      {SHOW_SECONDARY_KPIS && <div className="overview-diagnostic-strip">
        <Diagnostic label="Buy Box ownership" value={metrics.buyBox > 0 ? `${metrics.buyBox.toFixed(1)}%` : '—'} detail={comparisonDetail(metrics.priorBuyBox > 0 ? `${metrics.priorBuyBox.toFixed(1)}%` : '—')} icon={<Boxes size={15} />} color="var(--accent)" />
        <Diagnostic label="Revenue refund rate" value={metrics.revenueRefundRate === null ? '—' : `${metrics.revenueRefundRate.toFixed(2)}%`} detail={metrics.financeKpisAvailable ? 'Refund dollars ÷ gross sales' : metrics.financeKpiUnavailableReason} icon={<Percent size={15} />} color="var(--red)" />
        <Diagnostic label="Fee Rate" value={metrics.amazonFeeRate === null ? '—' : `${metrics.amazonFeeRate.toFixed(2)}%`} detail={metrics.financeKpisAvailable ? 'Amazon fees ÷ gross sales' : metrics.financeKpiUnavailableReason} icon={<Percent size={15} />} color="var(--yellow)" />
        <Diagnostic label="Avg. selling price" value={money(metrics.asp, 2)} detail={comparisonDetail(money(metrics.priorAsp, 2))} icon={<BarChart2 size={15} />} color="#6366F1" />
        <Diagnostic label="Selling SKUs" value={integer(metrics.sellingSkus)} detail="Products with at least one unit" icon={<Boxes size={15} />} color="var(--accent)" />
      </div>}

      {SHOW_PROFITABILITY_PENDING && <div className="overview-unlock-strip" aria-label="Metrics awaiting connected data">
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
      </div>}
    </section>
  )
}
