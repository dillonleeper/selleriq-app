'use client'

import { useMemo, useState } from 'react'
import { Area, AreaChart, CartesianGrid, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import type { TrafficDiagnosticPoint } from '@/components/TrafficProductDiagnostic'
import styles from './ProductPerformanceTimeline.module.css'

type RevenuePoint = { period_key: string; label: string; revenue: number; units: number }
type Metric = 'revenue' | 'sessions' | 'conversion' | 'buybox' | 'inventory'
type Props = { revenuePoints: RevenuePoint[]; diagnosticPoints: TrafficDiagnosticPoint[]; loading: boolean }

const metrics: Record<Metric, { label: string; color: string; format: (value: number) => string }> = {
  revenue: { label: 'Revenue', color: '#1473e6', format: value => `$${Math.round(value).toLocaleString()}` },
  sessions: { label: 'Sessions', color: '#1473e6', format: value => Math.round(value).toLocaleString() },
  conversion: { label: 'Conversion', color: '#2f7d32', format: value => `${value.toFixed(1)}%` },
  buybox: { label: 'Buy Box', color: '#d97706', format: value => `${value.toFixed(1)}%` },
  inventory: { label: 'Available inventory', color: '#7c3aed', format: value => Math.round(value).toLocaleString() },
}

export default function ProductPerformanceTimeline({ revenuePoints, diagnosticPoints, loading }: Props) {
  const [metric, setMetric] = useState<Metric>('revenue')
  const chartData = useMemo(() => {
    const byDate = new Map<string, Record<string, string | number | null>>()
    for (const point of revenuePoints) byDate.set(point.period_key, { date: point.period_key, label: point.label, revenue: point.revenue })
    for (const point of diagnosticPoints) {
      const row = byDate.get(point.raw_date) || { date: point.raw_date, label: point.start_date, revenue: null }
      Object.assign(row, {
        sessions: point.sessions,
        conversion: point.conv_rate,
        buybox: point.buy_box_pct,
        inventory: point.available_quantity,
      })
      byDate.set(point.raw_date, row)
    }
    return [...byDate.values()].sort((left, right) => String(left.date).localeCompare(String(right.date)))
  }, [revenuePoints, diagnosticPoints])

  const config = metrics[metric]
  const observed = chartData.map(row => row[metric]).filter((value): value is number => typeof value === 'number')
  const average = observed.length ? observed.reduce((sum, value) => sum + value, 0) / observed.length : null

  return (
    <section className={styles.card} aria-label="Product performance timeline">
      <div className={styles.header}>
        <div>
          <h4>{config.label} over time</h4>
          <p>Switch metrics to investigate the same product without leaving this page.</p>
        </div>
        <div className={styles.tabs} role="tablist" aria-label="Timeline metric">
          {(Object.keys(metrics) as Metric[]).map(key => (
            <button key={key} type="button" role="tab" aria-selected={metric === key} className={metric === key ? styles.active : ''} onClick={() => setMetric(key)}>
              {metrics[key].label}
            </button>
          ))}
        </div>
      </div>
      {loading && chartData.length === 0 ? <div className={styles.empty}>Loading product history…</div> : observed.length === 0 ? <div className={styles.empty}>No {config.label.toLowerCase()} observations are available for this range.</div> : (
        <div className={styles.chart}>
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={chartData} margin={{ top: 12, right: 14, bottom: 0, left: 0 }}>
              <defs><linearGradient id={`product-${metric}`} x1="0" y1="0" x2="0" y2="1"><stop offset="5%" stopColor={config.color} stopOpacity={0.3} /><stop offset="95%" stopColor={config.color} stopOpacity={0.02} /></linearGradient></defs>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
              <XAxis dataKey="label" tick={{ fontSize: 10, fill: 'var(--text-dim)' }} tickLine={false} axisLine={false} interval="preserveStartEnd" />
              <YAxis tick={{ fontSize: 10, fill: 'var(--text-dim)' }} tickLine={false} axisLine={false} tickFormatter={config.format} width={62} domain={['auto', 'auto']} />
              <Tooltip formatter={(value) => config.format(Number(value))} contentStyle={{ border: '1px solid var(--border)', borderRadius: 10, fontSize: 12 }} />
              {average !== null && <ReferenceLine y={average} stroke="var(--text-dim)" strokeDasharray="5 5" label={{ value: `Avg ${config.format(average)}`, fill: 'var(--text-dim)', fontSize: 10, position: 'insideTopRight' }} />}
              <Area type="monotone" dataKey={metric} name={config.label} connectNulls={false} stroke={config.color} strokeWidth={2} fill={`url(#product-${metric})`} dot={{ r: 2, fill: config.color }} activeDot={{ r: 4 }} />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      )}
      <p className={styles.note}>Blank dates remain gaps and are excluded from totals and averages—not treated as zero.</p>
    </section>
  )
}
