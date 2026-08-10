'use client'

import { useMemo, useState } from 'react'
import { AlertTriangle, CheckCircle2, Database, PackageCheck, Search, ShieldCheck } from 'lucide-react'
import {
  Area,
  AreaChart,
  CartesianGrid,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'

export type TrafficDiagnosticPoint = {
  raw_date: string
  start_date: string
  sessions: number | null
  page_views: number | null
  units: number | null
  conv_rate: number | null
  buy_box_pct: number | null
  sales_market_count: number
  selected_market_count: number
  inventory_snapshot_date: string | null
  inventory_age_days: number | null
  inventory_market_count: number
  available_quantity: number | null
  fulfillable_quantity: number | null
  reserved_customerorders: number | null
  reserved_fc_transfers: number | null
  reserved_fc_processing: number | null
  inbound_quantity: number | null
}

type Product = {
  sku: string
  sessions: number
  page_views: number
  views_per_session: number
  conv_rate: number
  buy_box_pct: number | null
  units: number
  conv_change: number | null
}

type Metric = 'conversion' | 'sessions' | 'buybox' | 'inventory'

type Props = {
  product: Product
  points: TrafficDiagnosticPoint[]
  loading: boolean
}

const number = (value: number | null | undefined) => Number(value) || 0
const integer = (value: number | null | undefined) => number(value).toLocaleString('en-US', { maximumFractionDigits: 0 })
const percent = (value: number | null | undefined, digits = 1) => value == null ? '—' : `${Number(value).toFixed(digits)}%`

function diagnosticFor(product: Product, points: TrafficDiagnosticPoint[]) {
  const inventoryPoints = points.filter(point => point.inventory_market_count > 0 && point.available_quantity != null)
  const exactInventoryPoints = inventoryPoints.filter(point => point.inventory_age_days === 0)
  const outOfStockPoints = inventoryPoints.filter(point => number(point.available_quantity) <= 0)
  const observedSales = points.filter(point => point.sessions != null)
  const buyBoxHealthy = product.buy_box_pct != null && product.buy_box_pct >= 90
  const enoughTraffic = product.sessions >= 100
  const lowConversion = product.conv_rate < 5
  const inventoryHealthy = inventoryPoints.length > 0 && outOfStockPoints.length === 0
  const inventoryCoverage = points.length > 0 ? exactInventoryPoints.length / points.length : 0
  const missingSalesDays = points.filter(point => point.sessions == null).length

  if (outOfStockPoints.length > 0) {
    return {
      tone: 'critical' as const,
      label: 'Likely inventory-driven',
      title: 'Availability interruptions overlap the performance window.',
      summary: `${outOfStockPoints.length} observed day${outOfStockPoints.length === 1 ? '' : 's'} had no sellable inventory. Treat traffic, Buy Box, and conversion declines on those dates as inventory-related before investigating the listing.`,
      next: 'Restore sellable availability, then reassess traffic and conversion after inventory stabilizes.',
      inventoryCoverage,
      missingSalesDays,
    }
  }

  if (lowConversion && inventoryHealthy && buyBoxHealthy && enoughTraffic) {
    return {
      tone: 'warning' as const,
      label: 'Likely conversion-driven',
      title: 'Traffic is reaching the product, but too few sessions become orders.',
      summary: `Observed inventory remained available and Buy Box averaged ${percent(product.buy_box_pct)}. Those signals do not support inventory or offer ownership as the primary explanation for the ${percent(product.conv_rate)} conversion rate.`,
      next: 'Investigate traffic quality, price competitiveness, ratings, and detail-page effectiveness. SellerIQ will narrow this further as those sources are connected.',
      inventoryCoverage,
      missingSalesDays,
    }
  }

  if (product.buy_box_pct != null && product.buy_box_pct < 80 && inventoryHealthy) {
    return {
      tone: 'warning' as const,
      label: 'Likely Buy Box-driven',
      title: 'Offer ownership is constraining otherwise available inventory.',
      summary: `Sellable inventory was observed, but Buy Box ownership averaged only ${percent(product.buy_box_pct)}. Pricing or competing offers should be investigated before changing the listing.`,
      next: 'Review price competitiveness and competing sellers on the offer.',
      inventoryCoverage,
      missingSalesDays,
    }
  }

  return {
    tone: 'neutral' as const,
    label: inventoryPoints.length === 0 ? 'Insufficient inventory evidence' : 'Mixed signals',
    title: inventoryPoints.length === 0 ? 'SellerIQ cannot yet rule inventory in or out.' : 'No single source explains the result.',
    summary: inventoryPoints.length === 0
      ? 'Traffic data is available, but no sufficiently recent inventory snapshot overlaps this selection.'
      : 'Inventory, Buy Box, traffic, and conversion do not currently form one strong causal pattern.',
    next: 'Review the evidence below and collect more daily observations before taking action.',
    inventoryCoverage,
    missingSalesDays,
  }
}

const metricMeta: Record<Metric, { label: string; key: keyof TrafficDiagnosticPoint; color: string; suffix: string }> = {
  conversion: { label: 'Conversion', key: 'conv_rate', color: 'var(--chart-success)', suffix: '%' },
  sessions: { label: 'Sessions', key: 'sessions', color: 'var(--chart-primary)', suffix: '' },
  buybox: { label: 'Buy Box', key: 'buy_box_pct', color: 'var(--chart-warning)', suffix: '%' },
  inventory: { label: 'Available inventory', key: 'available_quantity', color: 'var(--chart-secondary)', suffix: '' },
}

function ChartTooltip({ active, payload, label, suffix }: any) {
  if (!active || !payload?.length) return null
  const point = payload[0]?.payload as TrafficDiagnosticPoint | undefined
  const value = payload[0]?.value
  return (
    <div className="traffic-diagnostic-tooltip">
      <strong>{label}</strong>
      <span>{Number(value).toLocaleString('en-US', { maximumFractionDigits: suffix ? 2 : 0 })}{suffix}</span>
      {point?.inventory_snapshot_date && (
        <small>Inventory snapshot {point.inventory_age_days === 0 ? 'same day' : `${point.inventory_age_days}d old`}</small>
      )}
    </div>
  )
}

export default function TrafficProductDiagnostic({ product, points, loading }: Props) {
  const [metric, setMetric] = useState<Metric>('conversion')
  const diagnosis = useMemo(() => diagnosticFor(product, points), [product, points])
  const meta = metricMeta[metric]
  const inventoryPoints = points.filter(point => point.inventory_market_count > 0 && point.available_quantity != null)
  const latestInventory = inventoryPoints.at(-1)
  const missingInventoryDays = Math.max(0, points.length - points.filter(point => point.inventory_age_days === 0).length)
  const referenceValue = metric === 'conversion'
    ? product.conv_rate
    : metric === 'buybox'
      ? product.buy_box_pct
      : null

  if (loading && points.length === 0) {
    return <div className="traffic-diagnostic-loading"><span className="cadence-loading-spinner" />Cross-referencing traffic and inventory…</div>
  }

  return (
    <section className="traffic-diagnostic" aria-label={`Diagnostic for ${product.sku}`}>
      <header className={`traffic-diagnostic-hero is-${diagnosis.tone}`}>
        <div className="traffic-diagnostic-icon">
          {diagnosis.tone === 'critical' ? <AlertTriangle size={18} /> : diagnosis.tone === 'warning' ? <Search size={18} /> : <Database size={18} />}
        </div>
        <div>
          <span className="traffic-diagnostic-label">{diagnosis.label}</span>
          <h3>{diagnosis.title}</h3>
          <p>{diagnosis.summary}</p>
        </div>
      </header>

      <div className="traffic-funnel" aria-label="Traffic to order funnel">
        <div><span>Sessions</span><strong>{integer(product.sessions)}</strong><small>Product visits</small></div>
        <i aria-hidden="true">→</i>
        <div><span>Page views</span><strong>{integer(product.page_views)}</strong><small>{product.views_per_session.toFixed(2)} per session</small></div>
        <i aria-hidden="true">→</i>
        <div className="is-outcome"><span>Units ordered</span><strong>{integer(product.units)}</strong><small>{percent(product.conv_rate)} of sessions</small></div>
      </div>

      <div className="traffic-evidence-grid">
        <section>
          <div className="traffic-subheading"><ShieldCheck size={14} /> What SellerIQ found</div>
          <ul className="traffic-evidence-list">
            <li><CheckCircle2 size={13} /><span><strong>{percent(product.buy_box_pct)}</strong> average Buy Box ownership</span></li>
            <li><PackageCheck size={13} /><span>{latestInventory
              ? <><strong>{integer(latestInventory.available_quantity)}</strong> available in the latest attributable snapshot</>
              : <>No attributable inventory snapshot</>}</span></li>
            <li><Database size={13} /><span><strong>{points.length - diagnosis.missingSalesDays}</strong> sales days and <strong>{points.length - missingInventoryDays}</strong> exact inventory days observed</span></li>
          </ul>
        </section>
        <section>
          <div className="traffic-subheading"><AlertTriangle size={14} /> Evidence limits</div>
          <p className="traffic-evidence-copy">
            {missingInventoryDays > 0 ? `${missingInventoryDays} day${missingInventoryDays === 1 ? '' : 's'} lack a same-day inventory snapshot. ` : ''}
            {diagnosis.missingSalesDays > 0 ? `${diagnosis.missingSalesDays} day${diagnosis.missingSalesDays === 1 ? '' : 's'} lack sales and traffic data. ` : ''}
            SellerIQ does not fill those gaps with assumed values.
          </p>
        </section>
      </div>

      <section className="traffic-diagnostic-chart">
        <div className="traffic-chart-header">
          <div>
            <h4>{meta.label} over time</h4>
            <p>{metric === 'conversion' ? 'Daily units ÷ daily sessions. The dashed line is the weighted period average.' : 'Daily source observations for the selected window.'}</p>
          </div>
          <div className="traffic-metric-tabs" role="tablist" aria-label="Diagnostic chart metric">
            {(Object.keys(metricMeta) as Metric[]).map(key => (
              <button key={key} type="button" role="tab" aria-selected={metric === key} className={metric === key ? 'is-active' : ''} onClick={() => setMetric(key)}>
                {metricMeta[key].label}
              </button>
            ))}
          </div>
        </div>
        <ResponsiveContainer width="100%" height={230}>
          <AreaChart data={points}>
            <defs>
              <linearGradient id={`traffic-diagnostic-${metric}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor={meta.color} stopOpacity={0.22} />
                <stop offset="95%" stopColor={meta.color} stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" vertical={false} />
            <XAxis dataKey="start_date" tickLine={false} axisLine={false} />
            <YAxis tickLine={false} axisLine={false} width={48} tickFormatter={value => `${Number(value).toLocaleString('en-US', { maximumFractionDigits: 1 })}${meta.suffix}`} />
            <Tooltip content={<ChartTooltip suffix={meta.suffix} />} />
            {referenceValue != null && <ReferenceLine y={referenceValue} stroke="var(--text-dim)" strokeDasharray="5 5" label={{ value: `Avg ${percent(referenceValue)}`, position: 'insideTopRight', fill: 'var(--text-dim)', fontSize: 10 }} />}
            <Area connectNulls={false} type="monotone" dataKey={meta.key} name={meta.label} stroke={meta.color} strokeWidth={2} fill={`url(#traffic-diagnostic-${metric})`} dot={{ r: 2.5, fill: meta.color }} activeDot={{ r: 4 }} />
          </AreaChart>
        </ResponsiveContainer>
        <div className="traffic-timeline-note">
          Missing dates remain gaps. Inventory values may use the most recent snapshot up to two days old and always disclose its age.
        </div>
      </section>

      <footer className="traffic-next-step">
        <span>Recommended next investigation</span>
        <strong>{diagnosis.next}</strong>
      </footer>
    </section>
  )
}
