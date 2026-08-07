'use client'

import { BarChart2, Boxes, DollarSign, Eye, LockKeyhole, MousePointer, Percent, ShoppingCart } from 'lucide-react'

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
  }
}

const money = (value: number, decimals = 0) => '$' + value.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals })
const integer = (value: number) => Math.round(value).toLocaleString('en-US')
const relativeDelta = (current: number, prior: number) => prior > 0 ? ((current - prior) / prior) * 100 : null

type MetricCardProps = {
  label: string
  value?: string
  prior?: string
  delta?: number | null
  deltaSuffix?: string
  icon: React.ReactNode
  color: string
  locked?: boolean
}

function MetricCard({ label, value, prior, delta, deltaSuffix = '%', icon, color, locked = false }: MetricCardProps) {
  return (
    <div className="card" style={{ padding: 17, minHeight: 112, borderStyle: locked ? 'dashed' : 'solid', opacity: locked ? 0.72 : 1 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, marginBottom: 10 }}>
        <span style={{ fontSize: 9, color: 'var(--text-muted)', fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase' }}>{label}</span>
        <span style={{ color, opacity: 0.7 }}>{icon}</span>
      </div>
      {locked ? (
        <>
          <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 8 }}>Awaiting verification</div>
          <div style={{ fontSize: 10, color: 'var(--text-dim)', lineHeight: 1.4 }}>Sellerboard import must reconcile before this KPI is trusted.</div>
        </>
      ) : (
        <>
          <div style={{ fontSize: 21, fontWeight: 650, fontFamily: 'JetBrains Mono, monospace', marginBottom: 8 }}>{value}</div>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'center' }}>
            <span style={{ fontSize: 10, color: 'var(--text-dim)' }}>{prior}</span>
            {delta !== null && delta !== undefined && (
              <span style={{ fontSize: 10, fontWeight: 600, color: delta > 0 ? 'var(--green)' : delta < 0 ? 'var(--red)' : 'var(--text-muted)' }}>
                {delta > 0 ? '+' : ''}{delta.toFixed(1)}{deltaSuffix}
              </span>
            )}
          </div>
        </>
      )}
    </div>
  )
}

export default function SalesKpiHierarchy({ rangeLabel, comparisonLabel, comparisonComplete, metrics }: Props) {
  const noComparison = `No complete ${comparisonLabel}`
  const prior = (value: string) => comparisonComplete ? `${value} ${comparisonLabel}` : noComparison

  return (
    <div style={{ marginBottom: 20 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12, marginBottom: 9 }}>
        <div>
          <div style={{ fontSize: 12, fontWeight: 650 }}>Business outcomes</div>
          <div style={{ fontSize: 10, color: 'var(--text-dim)', marginTop: 2 }}>Primary KPIs · {rangeLabel}</div>
        </div>
        <div style={{ fontSize: 10, color: 'var(--text-dim)' }}>Unverified economics are locked—not treated as zero.</div>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(165px, 1fr))', gap: 10, marginBottom: 16 }}>
        <MetricCard label="Ordered revenue" value={money(metrics.revenue)} prior={prior(money(metrics.priorRevenue))} delta={comparisonComplete ? relativeDelta(metrics.revenue, metrics.priorRevenue) : null} icon={<DollarSign size={14} />} color="var(--accent)" />
        <MetricCard label="Contribution profit" locked icon={<LockKeyhole size={13} />} color="var(--text-dim)" />
        <MetricCard label="Contribution margin" locked icon={<LockKeyhole size={13} />} color="var(--text-dim)" />
        <MetricCard label="Units ordered" value={integer(metrics.units)} prior={prior(integer(metrics.priorUnits))} delta={comparisonComplete ? relativeDelta(metrics.units, metrics.priorUnits) : null} icon={<ShoppingCart size={14} />} color="var(--green)" />
        <MetricCard label="TACOS" locked icon={<LockKeyhole size={13} />} color="var(--text-dim)" />
        <MetricCard label="Refund rate" locked icon={<LockKeyhole size={13} />} color="var(--text-dim)" />
      </div>

      <div style={{ fontSize: 12, fontWeight: 650, marginBottom: 9 }}>Demand diagnostics</div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(165px, 1fr))', gap: 10 }}>
        <MetricCard label="Sessions" value={integer(metrics.sessions)} prior={prior(integer(metrics.priorSessions))} delta={comparisonComplete ? relativeDelta(metrics.sessions, metrics.priorSessions) : null} icon={<Eye size={14} />} color="var(--yellow)" />
        <MetricCard label="Conversion rate" value={`${metrics.conversion.toFixed(2)}%`} prior={prior(`${metrics.priorConversion.toFixed(2)}%`)} delta={comparisonComplete ? metrics.conversion - metrics.priorConversion : null} deltaSuffix=" pp" icon={<Percent size={14} />} color="#EC4899" />
        <MetricCard label="Average selling price" value={money(metrics.asp, 2)} prior={prior(money(metrics.priorAsp, 2))} delta={comparisonComplete ? relativeDelta(metrics.asp, metrics.priorAsp) : null} icon={<BarChart2 size={14} />} color="#6366F1" />
        <MetricCard label="Page views" value={integer(metrics.pageViews)} prior={prior(integer(metrics.priorPageViews))} delta={comparisonComplete ? relativeDelta(metrics.pageViews, metrics.priorPageViews) : null} icon={<MousePointer size={14} />} color="#10B981" />
        <MetricCard label="Buy Box" value={metrics.buyBox > 0 ? `${metrics.buyBox.toFixed(1)}%` : '—'} prior={prior(metrics.priorBuyBox > 0 ? `${metrics.priorBuyBox.toFixed(1)}%` : '—')} delta={comparisonComplete && metrics.priorBuyBox > 0 ? metrics.buyBox - metrics.priorBuyBox : null} deltaSuffix=" pp" icon={<Boxes size={14} />} color="var(--accent)" />
      </div>
      <div style={{ marginTop: 8, fontSize: 10, color: 'var(--text-dim)' }}>{integer(metrics.sellingSkus)} SKUs recorded at least one unit in this period.</div>
    </div>
  )
}
