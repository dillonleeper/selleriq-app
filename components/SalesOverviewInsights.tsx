'use client'

import { AlertTriangle, ArrowDownRight, ArrowUpRight, Boxes, EyeOff } from 'lucide-react'

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
  metrics: {
    sessions: number
    priorSessions: number
    conversion: number
    priorConversion: number
    asp: number
    priorAsp: number
  }
}

const n = (value: number | string | null | undefined) => Number(value) || 0
const money = (value: number) => `${value < 0 ? '-' : ''}$${Math.abs(value).toLocaleString('en-US', { maximumFractionDigits: 0 })}`
const percent = (value: number) => `${value >= 0 ? '+' : ''}${value.toFixed(1)}%`

export default function SalesOverviewInsights({ comparisonAvailable, comparisonLabel, skuDrivers, marketDrivers, inventoryRisks, metrics }: Props) {
  const positives = skuDrivers.filter(row => n(row.revenue_delta) > 0).slice(0, 5)
  const negatives = skuDrivers.filter(row => n(row.revenue_delta) < 0).slice(0, 5)
  const currentRevenue = marketDrivers.reduce((sum, row) => sum + n(row.revenue), 0)
  const priorRevenue = marketDrivers.reduce((sum, row) => sum + n(row.prior_revenue), 0)
  const revenueChange = priorRevenue > 0 ? ((currentRevenue - priorRevenue) / priorRevenue) * 100 : null

  const actionRows = comparisonAvailable
    ? skuDrivers.flatMap(row => {
        const actions: Array<{ key: string; severity: number; icon: React.ReactNode; title: string; detail: string }> = []
        const revenue = n(row.revenue)
        const priorRevenueForSku = n(row.prior_revenue)
        const sessions = n(row.sessions)
        const priorSessions = n(row.prior_sessions)
        const conversion = n(row.conversion_rate)
        const priorConversion = priorSessions > 0 ? (n(row.prior_units) / priorSessions) * 100 : 0
        const revenuePerSession = sessions > 0 ? revenue / sessions : 0
        const asp = n(row.units) > 0 ? revenue / n(row.units) : 0
        if (priorRevenueForSku > 0 && revenue < priorRevenueForSku * 0.8) {
          const sessionChange = priorSessions > 0 ? ((sessions - priorSessions) / priorSessions) * 100 : 0
          const conversionChange = conversion - priorConversion
          const likelyDriver = sessionChange < -10
            ? `sessions ${percent(sessionChange)}`
            : conversionChange < -1
              ? `conversion ${conversionChange.toFixed(1)} points`
              : n(row.buy_box_pct) > 0 && n(row.buy_box_pct) < 90
                ? `Buy Box ${n(row.buy_box_pct).toFixed(1)}%`
                : 'review pricing and demand mix'
          actions.push({ key: `${row.sku}-revenue`, severity: priorRevenueForSku - revenue, icon: <ArrowDownRight size={14} />, title: `Investigate ${row.sku} revenue decline`, detail: `${money(priorRevenueForSku - revenue)} decline · likely driver: ${likelyDriver}` })
        }
        if (priorSessions > 0 && sessions < priorSessions * 0.8) {
          actions.push({ key: `${row.sku}-traffic`, severity: (priorSessions - sessions) * revenuePerSession, icon: <EyeOff size={14} />, title: `Recover traffic for ${row.sku}`, detail: `${percent(((sessions - priorSessions) / priorSessions) * 100)} sessions · about ${money((priorSessions - sessions) * revenuePerSession)} revenue exposure` })
        }
        if (priorConversion > 0 && conversion < priorConversion - 1) {
          const exposure = sessions * ((priorConversion - conversion) / 100) * asp
          actions.push({ key: `${row.sku}-conversion`, severity: exposure, icon: <AlertTriangle size={14} />, title: `Fix conversion for ${row.sku}`, detail: `${(conversion - priorConversion).toFixed(1)} points · about ${money(exposure)} revenue exposure` })
        }
        if (n(row.buy_box_pct) > 0 && n(row.buy_box_pct) < 90) {
          const exposure = revenue * ((90 - n(row.buy_box_pct)) / 100)
          actions.push({ key: `${row.sku}-buybox`, severity: exposure, icon: <AlertTriangle size={14} />, title: `Recover Buy Box for ${row.sku}`, detail: `${n(row.buy_box_pct).toFixed(1)}% ownership · about ${money(exposure)} revenue exposure` })
        }
        return actions.sort((a, b) => b.severity - a.severity).slice(0, 1)
      })
    : []

  const inventoryActions = inventoryRisks.slice(0, 5).map(row => ({
    key: `${row.marketplace}-${row.sku}-stock`,
    severity: n(row.estimated_monthly_revenue) * Math.max(0, (28 - n(row.days_of_cover)) / 28),
    icon: <Boxes size={14} />,
    title: `Reorder or expedite ${row.sku} (${row.marketplace})`,
    detail: `${n(row.days_of_cover).toFixed(1)} projected days cover including inbound · ${money(n(row.estimated_monthly_revenue))}/mo revenue exposed`,
  }))
  const actions = [...actionRows, ...inventoryActions].sort((a, b) => b.severity - a.severity).slice(0, 8)

  const sessionsChange = metrics.priorSessions > 0 ? ((metrics.sessions - metrics.priorSessions) / metrics.priorSessions) * 100 : null
  const conversionChange = metrics.conversion - metrics.priorConversion
  const aspChange = metrics.priorAsp > 0 ? ((metrics.asp - metrics.priorAsp) / metrics.priorAsp) * 100 : null
  const explanation = comparisonAvailable && revenueChange !== null
    ? `Revenue is ${Math.abs(revenueChange).toFixed(1)}% ${revenueChange >= 0 ? 'higher' : 'lower'} than ${comparisonLabel}. ${sessionsChange === null ? '' : `Sessions ${sessionsChange >= 0 ? 'rose' : 'fell'} ${Math.abs(sessionsChange).toFixed(1)}%; conversion ${Math.abs(conversionChange) < 0.25 ? 'remained stable' : `${conversionChange >= 0 ? 'improved' : 'declined'} ${Math.abs(conversionChange).toFixed(1)} points`}; ASP ${aspChange === null || Math.abs(aspChange) < 0.5 ? 'was stable' : `${aspChange >= 0 ? 'rose' : 'fell'} ${Math.abs(aspChange).toFixed(1)}%`}.`} ${negatives[0] ? `${negatives[0].sku} is the largest negative SKU driver at ${money(n(negatives[0].revenue_delta))}.` : positives[0] ? `${positives[0].sku} is the largest positive SKU driver at ${money(n(positives[0].revenue_delta))}.` : 'No single SKU materially drove the change.'}`
    : `A complete ${comparisonLabel} is not available for this selection, so change attribution is intentionally withheld.`

  return (
    <div style={{ display: 'grid', gap: 14, marginBottom: 20 }}>
      <div className="card" style={{ padding: 20, borderLeft: '3px solid var(--accent)' }}>
        <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 6 }}>What changed?</div>
        <div style={{ fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.6 }}>{explanation}</div>
        {comparisonAvailable && marketDrivers.length > 1 && (
          <div style={{ display: 'flex', gap: 16, marginTop: 12, flexWrap: 'wrap' }}>
            {marketDrivers.map(row => {
              const current = n(row.revenue)
              const prior = n(row.prior_revenue)
              return (
                <div key={row.marketplace} style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                  <strong style={{ color: 'var(--text-primary)' }}>{row.marketplace}</strong>{' '}
                  {money(current)}{prior > 0 ? ` (${percent(((current - prior) / prior) * 100)})` : ''}
                </div>
              )
            })}
          </div>
        )}
      </div>

      {comparisonAvailable && (positives.length > 0 || negatives.length > 0) && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 14 }}>
          {[
            { title: 'Top revenue gains', rows: positives, color: 'var(--green)', Icon: ArrowUpRight },
            { title: 'Top revenue declines', rows: negatives, color: 'var(--red)', Icon: ArrowDownRight },
          ].map(group => (
            <div key={group.title} className="card" style={{ padding: 20 }}>
              <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 12 }}>{group.title}</div>
              {group.rows.length === 0 ? (
                <div style={{ fontSize: 11, color: 'var(--text-dim)' }}>No material SKU drivers.</div>
              ) : group.rows.map(row => (
                <div key={row.sku} style={{ display: 'flex', justifyContent: 'space-between', gap: 12, padding: '8px 0', borderBottom: '1px solid var(--border)' }}>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontSize: 11, fontWeight: 600, fontFamily: 'JetBrains Mono, monospace' }}>{row.sku}</div>
                    <div style={{ fontSize: 10, color: 'var(--text-dim)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{row.title}</div>
                  </div>
                  <div style={{ color: group.color, fontSize: 12, fontWeight: 600, whiteSpace: 'nowrap', display: 'flex', alignItems: 'center', gap: 3 }}>
                    <group.Icon size={12} /> {money(n(row.revenue_delta))}
                  </div>
                </div>
              ))}
            </div>
          ))}
        </div>
      )}

      <div className="card" style={{ padding: 20 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, marginBottom: 10 }}>
          <div>
            <div style={{ fontSize: 13, fontWeight: 600 }}>Recommended actions</div>
            <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>Active, selling listings only · ranked by estimated revenue impact.</div>
          </div>
          <div style={{ fontSize: 10, color: 'var(--text-dim)' }}>Ads and profitability remain gated until source data is verified.</div>
        </div>
        {actions.length === 0 ? (
          <div style={{ fontSize: 12, color: 'var(--text-muted)', padding: '8px 0' }}>No supported high-priority actions for this selection.</div>
        ) : actions.map((action, index) => (
          <div key={action.key} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '9px 0', borderTop: index ? '1px solid var(--border)' : 'none' }}>
            <span style={{ color: index < 3 ? 'var(--red)' : 'var(--yellow)' }}>{action.icon}</span>
            <div style={{ flex: 1 }}>
              <span style={{ fontSize: 12, fontWeight: 600 }}>{action.title}</span>
              <span style={{ fontSize: 11, color: 'var(--text-muted)', marginLeft: 8 }}>{action.detail}</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
