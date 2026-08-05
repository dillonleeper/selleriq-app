'use client'

import React, { useEffect, useState, useRef } from 'react'
import { supabase } from '@/lib/supabase'
import { searchProducts } from '@/lib/productSearch'
import MarketplaceFilter from '@/components/MarketplaceFilter'
import {
  AlertTriangle, Package, TrendingDown, ArrowDown,
  ArrowUp, ArrowUpDown, Search, Truck, Box, Send, ShoppingCart, Download, Upload,
  ChevronDown, ChevronRight, X,
} from 'lucide-react'
import {
  ComposedChart, Bar, Line, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, ReferenceLine, ReferenceArea, Cell,
} from 'recharts'

// â”€â”€â”€ Constants â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const CAD_TO_USD = 0.74
const LOW_STOCK_THRESHOLD   = 30
const CRITICAL_THRESHOLD    = 14
const FBA_TARGET_DEFAULT      = 60
const SUPPLIER_PROD_DEFAULT   = 42
const SUPPLIER_SHIP_DEFAULT   = 28
const SUPPLIER_BUFFER_DEFAULT = 60
const MAX_FORECAST_DAYS       = 365
const FORECAST_HISTORY_DAYS   = 14

type TabType = 'inventory' | 'fba' | 'supplier'

// â”€â”€â”€ Types â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
type InventoryRow = {
  sku: string
  title: string
  asin: string
  marketplace: string
  fulfillable: number
  available: number
  reserved: number
  inbound: number
  total_fba: number
  unsellable: number
  avg_daily_units: number
  days_of_cover: number | null
  status: 'out_of_stock' | 'critical' | 'low' | 'healthy'
  snapshot_date: string
}

type FbaReplenRow = {
  sku: string
  title: string
  asin: string
  marketplace: string
  total_inventory: number
  available: number
  fulfillable: number
  inbound: number
  reserved: number
  avg_daily_units: number
  days_of_cover: number | null
  units_to_send: number
  urgency: 'critical' | 'reorder' | 'healthy'
}

// â”€â”€ Multi-warehouse (frontend/localStorage only) â”€â”€
const WAREHOUSE_IDS = ['wh1', 'wh2', 'wh3', 'wh4'] as const
type WarehouseId = typeof WAREHOUSE_IDS[number]

type WarehouseConfig = {
  id: WarehouseId
  label: string          // user-provided name, e.g. "Dallas 3PL"
  active: boolean        // derived: true if any SKU has qty > 0 for this warehouse
}

// per-SKU, per-warehouse qty
type WarehouseQtyMap = Record<string, Partial<Record<WarehouseId, number>>>

type InventoryVelocityRpcRow = {
  sku: string
  marketplace: string
  total_units: number | string
  series: Array<{ d: string; units: number | string }> | null
}

type SupplierReplenRow = {
  sku: string
  title: string
  asin: string
  total_fba: number
  warehouse_qtys: Partial<Record<WarehouseId, number>>  // only populated for active whs
  warehouse_total: number                                // sum across active whs
  total_inventory: number                                // total_fba + warehouse_total
  avg_daily_units: number
  days_of_cover_total: number | null
  units_to_order: number
  reorder_by: string | null
  urgency: 'critical' | 'reorder' | 'healthy'
}

type SalesHistoryPoint = {
  dateKey: string
  units: number
}

type ForecastPoint = {
  dateKey: string
  label: string
  tickLabel: string
  inventory: number | null
  demand: number
  demandPhase: 'actual' | 'forecast'
}

type SortKey = 'sku' | 'fulfillable' | 'available' | 'reserved' | 'inbound' | 'total_fba' | 'days_of_cover' | 'avg_daily_units'
type FbaSortKey = 'sku' | 'total_inventory' | 'inbound' | 'avg_daily_units' | 'days_of_cover' | 'units_to_send'
type SupplierSortKey = 'sku' | 'total_fba' | 'avg_daily_units' | 'days_of_cover_total' | 'units_to_order'
type SortDir = 'asc' | 'desc'

// â”€â”€â”€ Helpers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function fmt(n: number) {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M'
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K'
  return n.toLocaleString()
}
function truncate(s: string, n: number) {
  return s && s.length > n ? s.slice(0, n) + 'â€¦' : s
}
function getStatus(fulfillable: number, doc: number | null): InventoryRow['status'] {
  if (fulfillable === 0) return 'out_of_stock'
  if (doc !== null && doc < CRITICAL_THRESHOLD) return 'critical'
  if (doc !== null && doc < LOW_STOCK_THRESHOLD) return 'low'
  return 'healthy'
}
function addDays(days: number): string {
  const d = new Date()
  d.setDate(d.getDate() + days)
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}
function relativeTime(dateStr: string): string {
  if (!dateStr) return ''
  // Parse as local date (YYYY-MM-DD), comparing to today at midnight local time
  const snap = new Date(`${dateStr}T00:00:00`)
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const diffMs = today.getTime() - snap.getTime()
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24))
  if (diffDays === 0) return 'today'
  if (diffDays === 1) return 'yesterday'
  if (diffDays < 7) return `${diffDays} days ago`
  if (diffDays < 14) return '1 week ago'
  if (diffDays < 30) return `${Math.floor(diffDays / 7)} weeks ago`
  if (diffDays < 60) return '1 month ago'
  return `${Math.floor(diffDays / 30)} months ago`
}
function dateKeyFromDate(date: Date) {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}
function exportCSV(headers: string[], rows: (string | number)[][], filename: string) {
  const escapeField = (val: string | number) => {
    const str = String(val)
    if (str.includes(',') || str.includes('"') || str.includes('\n')) {
      return '"' + str.replace(/"/g, '""') + '"'
    }
    return str
  }
  const csv = [headers, ...rows].map(r => r.map(escapeField).join(',')).join('\n')
  const blob = new Blob([csv], { type: 'text/csv' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url; a.download = filename; a.click()
  URL.revokeObjectURL(url)
}

// â”€â”€â”€ Forecast generator â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Combines recent actual daily history with a weekday-based forecast that is
// nudged by the most recent sales trend.
function buildForecast(
  startInventory: number,
  avgDailyUnits: number,
  horizonDays: number,
  salesHistory: SalesHistoryPoint[],
): ForecastPoint[] {
  const points: ForecastPoint[] = []
  const today = new Date()
  today.setHours(12, 0, 0, 0)
  const totalDays = Math.ceil(horizonDays)
  const history = [...salesHistory].sort((a, b) => a.dateKey.localeCompare(b.dateKey))
  const recentHistory = history.slice(-FORECAST_HISTORY_DAYS)
  const recentWindow = history.slice(-14)
  const baselineWindow = history.slice(-28, -14)

  const weekdayTotals = Array.from({ length: 7 }, () => 0)
  const weekdayCounts = Array.from({ length: 7 }, () => 0)
  let historyTotal = 0
  for (const point of history) {
    const date = new Date(`${point.dateKey}T12:00:00`)
    const weekday = date.getDay()
    weekdayTotals[weekday] += point.units
    weekdayCounts[weekday] += 1
    historyTotal += point.units
  }
  const historyAvg = history.length > 0 ? historyTotal / history.length : 0
  const fallbackAvg = avgDailyUnits > 0 ? avgDailyUnits : historyAvg
  const recentAvg = recentWindow.length > 0
    ? recentWindow.reduce((sum, point) => sum + point.units, 0) / recentWindow.length
    : fallbackAvg
  const baselineAvg = baselineWindow.length > 0
    ? baselineWindow.reduce((sum, point) => sum + point.units, 0) / baselineWindow.length
    : historyAvg || fallbackAvg
  const rawTrendFactor = baselineAvg > 0 ? recentAvg / baselineAvg : 1
  const trendFactor = Math.min(1.35, Math.max(0.65, rawTrendFactor))
  const getForecastUnitsForWeekday = (weekday: number) => {
    if (weekdayCounts[weekday] > 0) {
      const weekdayAvg = weekdayTotals[weekday] / weekdayCounts[weekday]
      return weekdayAvg * trendFactor
    }
    return fallbackAvg
  }

  let pointIndex = 0
  for (const point of recentHistory) {
    const date = new Date(`${point.dateKey}T12:00:00`)
    const label = date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
    points.push({
      dateKey: point.dateKey,
      label,
      tickLabel: pointIndex % 7 === 0 ? label : '',
      inventory: null,
      demand: Math.round(point.units * 10) / 10,
      demandPhase: 'actual',
    })
    pointIndex += 1
  }

  let remainingInventory = startInventory
  for (let dayOffset = 0; dayOffset <= totalDays; dayOffset++) {
    const d = new Date(today)
    d.setDate(today.getDate() + dayOffset)
    const dateKey = dateKeyFromDate(d)
    const label = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
    const tickLabel = pointIndex % 7 === 0 ? label : ''
    const forecastUnits = dayOffset === 0 ? 0 : getForecastUnitsForWeekday(d.getDay())
    if (dayOffset > 0) {
      remainingInventory = Math.max(0, remainingInventory - forecastUnits)
    }
    points.push({
      dateKey,
      label,
      tickLabel,
      inventory: Math.round(remainingInventory),
      demand: Math.round(forecastUnits * 10) / 10,
      demandPhase: 'forecast',
    })
    pointIndex += 1
  }

  return points
}

const STATUS_CONFIG = {
  out_of_stock: { label: 'Out of Stock', color: 'var(--red)',    bg: 'var(--red-light)' },
  critical:     { label: 'Critical',     color: '#F97316',       bg: 'rgba(249,115,22,0.1)' },
  low:          { label: 'Low Stock',    color: 'var(--yellow)', bg: 'rgba(217,119,6,0.1)' },
  healthy:      { label: 'Healthy',      color: 'var(--green)',  bg: 'var(--green-light)' },
}
const URGENCY_CONFIG = {
  critical: { label: 'Critical', color: 'var(--red)',    bg: 'var(--red-light)' },
  reorder:  { label: 'Reorder',  color: '#F97316',       bg: 'rgba(249,115,22,0.1)' },
  healthy:  { label: 'Healthy',  color: 'var(--green)',  bg: 'var(--green-light)' },
}

// â”€â”€â”€ Urgency Filter â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function UrgencyFilter({ counts, current, onChange }: {
  counts: Record<string, number>
  current: string
  onChange: (v: string) => void
}) {
  const options = [
    { value: 'all',      label: 'All' },
    { value: 'critical', label: 'Critical' },
    { value: 'reorder',  label: 'Reorder' },
    { value: 'healthy',  label: 'Healthy' },
  ]
  return (
    <div style={{ display: 'flex', gap: '4px' }}>
      {options.map(o => (
        <button key={o.value} onClick={() => onChange(o.value)} style={{
          padding: '5px 10px', borderRadius: '6px', fontSize: '11px', fontWeight: 500,
          cursor: 'pointer', border: current === o.value ? '1px solid var(--accent-border)' : '1px solid var(--border)',
          background: current === o.value ? 'var(--accent-light)' : 'transparent',
          color: current === o.value ? 'var(--accent)' : 'var(--text-muted)',
        }}>
          {o.label}{counts[o.value] !== undefined && o.value !== 'all' ? ` (${counts[o.value]})` : ''}
        </button>
      ))}
    </div>
  )
}

// â”€â”€â”€ Sort Icon â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function SortIcon({ col, cur, dir }: { col: string, cur: string, dir: SortDir }) {
  if (cur !== col) return <ArrowUpDown size={10} style={{ opacity: 0.3 }} />
  return dir === 'desc' ? <ArrowDown size={10} /> : <ArrowUp size={10} />
}

// â”€â”€â”€ Forecast Tooltip â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const ForecastTooltip = ({ active, payload, label }: any) => {
  if (!active || !payload?.length) return null
  const pointLabel = payload[0]?.payload?.label || label
  const pointPhase = payload[0]?.payload?.demandPhase
  return (
    <div style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border)', borderRadius: '8px', padding: '8px 12px', fontSize: '12px', boxShadow: 'var(--shadow-md)' }}>
      <div style={{ color: 'var(--text-muted)', marginBottom: '4px' }}>{pointLabel}</div>
      {payload.filter((p: any) => Number(p.value) > 0).map((p: any, i: number) => (
        <div key={i} style={{ color: p.color, fontWeight: 500 }}>
          {pointPhase === 'forecast' ? 'Forecast demand' : 'Actual demand'}: <span style={{ color: 'var(--text-primary)' }}>{fmt(p.value)} units</span>
        </div>
      ))}
    </div>
  )
}

// â”€â”€â”€ Forecast Panel â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function ForecastPanel({
  startInventory,
  avgDailyUnits,
  horizonDays,
  thresholdUnits,
  thresholdLabel,
  thresholdColor,
  orderByDays,
  salesHistory,
  statsLeft,
  statsRight,
}: {
  startInventory: number
  avgDailyUnits: number
  horizonDays: number
  thresholdUnits?: number
  thresholdLabel?: string
  thresholdColor?: string
  orderByDays?: number | null
  salesHistory: SalesHistoryPoint[]
  statsLeft: { label: string; value: string; color?: string }[]
  statsRight: { label: string; value: string; color?: string }[]
}) {
  const cappedHorizon = Math.min(horizonDays, MAX_FORECAST_DAYS)
  const points = buildForecast(startInventory, avgDailyUnits, cappedHorizon, salesHistory)
  const xTickLabels = Object.fromEntries(points.map(point => [point.dateKey, point.tickLabel]))
  const forecastStartPoint = points.find(point => point.demandPhase === 'forecast' && point.demand > 0) || null

  // Find stockout day index
  const stockoutIndex = points.findIndex(p => p.inventory === 0)
  const stockoutLabel = stockoutIndex > 0 ? points[stockoutIndex].label : null

  // Order by label
  const orderByLabel = orderByDays != null && orderByDays >= 0
    ? addDays(orderByDays)
    : null

  const lineColor = avgDailyUnits === 0
    ? 'var(--chart-success)'
    : stockoutIndex > 0 && stockoutIndex < points.length - 1
      ? 'var(--red)'
      : 'var(--chart-warning)'

  const summaryText = (() => {
    if (avgDailyUnits === 0) return 'No sales velocity data - forecast unavailable.'
    if (stockoutLabel && orderByDays != null && orderByDays <= 0) {
      return `At ${avgDailyUnits.toFixed(1)} units/day, you'll run out ${stockoutLabel}. Your ${Math.round(horizonDays - (thresholdUnits ? thresholdUnits / avgDailyUnits : 0))}d lead time means you should have orderÛ¿6ÖÚ$z{-®éÜj×rÂv¢s‚rÂ&6¶w&÷VæC¢—56VÆV7FVBòwf"‚ÒÖ66VçBÖÆ–v‡B’r¢wG&ç7&VçBrÂG&ç6—F–öã¢v&6¶w&÷VæBã2V6Rr×ÐÐ¢öäÖ÷W6TVçFW#×¶RÓâ²–b‚—56VÆV7FVB’†Ræ7W'&VçEF&vWB2…DÔÄF—dVÆVÖVçB’ç7G–ÆRæ&6¶w&÷VæBÒwf"‚ÒÖ&rÖ†÷fW"’r×ÐÐ¢öäÖ÷W6TÆVfS×¶RÓâ²†Ræ7W'&VçEF&vWB2…DÔÄF—dVÆVÖVçB’ç7G–ÆRæ&6¶w&÷VæBÒ—56VÆV7FVBòwf"‚ÒÖ66VçBÖÆ–v‡B’r¢wG&ç7&VçBr×ÓàÐ¢ÆF—b7G–ÆS×·²v–GFƒ¢sG‚rÂ†V–v‡C¢sG‚rÂ&÷&FW%&F—W3¢sG‚rÂfÆW…6‡&–æ³¢Â&÷&FW#¢‚6öÆ–BG¶—56VÆV7FVBòwf"‚ÒÖ66VçB’r¢wf"‚ÒÖ&÷&FW"’wÖÂ&6¶w&÷VæC¢—56VÆV7FVBòwf"‚ÒÖ66VçB’r¢wG&ç7&VçBrÂF—7Æ“¢vfÆW‚rÂÆ–vä—FV×3¢v6VçFW"rÂ§W7F–g”6öçFVçC¢v6VçFW"rÂG&ç6—F–öã¢vÆÂã'2V6Rr×ÓàÐ¢¶—56VÆV7FVBbbÇ7frv–GFƒÒ#‚"†V–v‡CÒ#b"f–Wt&÷ƒÒ#‚b"f–ÆÃÒ&æöæR#ãÇF‚CÒ$Ó4Ã2TÃr"7G&ö¶SÒ'v†—FR"7G&ö¶Uv–GFƒÒ#ãR"7G&ö¶TÆ–æV6Ò'&÷VæB"7G&ö¶TÆ–æV¦ö–ãÒ'&÷VæB"óãÂ÷7fsçÐÐ¢ÂöF—càÐ¢ÆF—b7G–ÆS×·²fÆWƒ¢ÂÖ–åv–GFƒ¢×ÓàÐ¢ÆF—b7G–ÆS×·²föçE6—¦S¢s'‚rÂ6öÆ÷#¢wf"‚Ò×FW‡B×&–Ö'’’rÂÖ&v–ä&÷GFöÓ¢s'‚rÂföçEvV–v‡C¢SÂ÷fW&fÆ÷s¢v†–FFVârÂFW‡D÷fW&fÆ÷s¢vVÆÆ—6—2rÂv†—FU76S¢væ÷w&r×Óç·çF—FÆRòG'Væ6FR‡çF—FÆRÂc’¢ç6·WÓÂöF—càÐ¢ÆF—b7G–ÆS×·²föçE6—¦S¢s‚rÂ6öÆ÷#¢wf"‚Ò×FW‡BÖF–Ò’rÂföçDfÖ–Ç“¢t¦WD'&–ç2ÖöæòÂÖöæ÷76Rr×Óç·ç6·WÒ+r·æ6–çÓÂöF—càÐ¢ÂöF—càÐ¢ÂöF—càÐ¢Ð¢Ò—ÐÐ¢ÂöF—càÐ¢—ÐÐ¢·6VÆV7FVE&öGV7G2æÆVæwF‚âbb€Ð¢ÆF—b7G–ÆS×·²F—7Æ“¢vfÆW‚rÂv¢sg‚rÂfÆW…w&¢ww&rÂÖ&v–åF÷¢s‚rÂÆ–vä—FV×3¢v6VçFW"r×ÓàÐ¢·6VÆV7FVE&öGV7G2æÆVæwF‚ÃÒ2ò6VÆV7FVE&öGV7G2æÖ‡Óâ€Ð¢ÆF—b¶W“×·ç6·WÒ7G–ÆS×·²F—7Æ“¢vfÆW‚rÂÆ–vä—FV×3¢v6VçFW"rÂv¢sg‚rÂ&6¶w&÷VæC¢wf"‚ÒÖ66VçBÖÆ–v‡B’rÂ&÷&FW#¢s‚6öÆ–Bf"‚ÒÖ66VçBÖ&÷&FW"’rÂ&÷&FW%&F—W3¢sg‚rÂFF–æs¢sG‚‚rÂföçE6—¦S¢s‚rÂ6öÆ÷#¢wf"‚ÒÖ66VçB’r×ÓàÐ¢Ç7â7G–ÆS×·²föçDfÖ–Ç“¢t¦WD'&–ç2ÖöæòÂÖöæ÷76Rr×Óç·ç6·WÓÂ÷7ãàÐ¢Æ'WGFöâöä6Æ–6³×²‚’Óâ&VÖ÷fU&öGV7B‡ç6·R—Ò7G–ÆS×·²&6¶w&÷VæC¢væöæRrÂ&÷&FW#¢væöæRrÂ7W'6÷#¢wö–çFW"rÂ6öÆ÷#¢wf"‚ÒÖ66VçB’rÂF—7Æ“¢vfÆW‚rÂFF–æs¢×ÓãÅ‚6—¦S×³ÒóãÂö'WGFöãàÐ¢ÂöF—càÐ¢’’¢€Ð¢ÆF—b7G–ÆS×·²F—7Æ“¢vfÆW‚rÂÆ–vä—FV×3¢v6VçFW"rÂv¢s‡‚rÂ&6¶w&÷VæC¢wf"‚ÒÖ66VçBÖÆ–v‡B’rÂ&÷&FW#¢s‚6öÆ–Bf"‚ÒÖ66VçBÖ&÷&FW"’rÂ&÷&FW%&F—W3¢sg‚rÂFF–æs¢sW‚'‚rÂföçE6—¦S¢s'‚rÂ6öÆ÷#¢wf"‚ÒÖ66VçB’r×ÓàÐ¢Ç7â7G–ÆS×·²föçEvV–v‡C¢S×Óç·6VÆV7FVE&öGV7G2æÆVæwF‡Ò&öGV7G26VÆV7FVCÂ÷7ãàÐ¢Æ'WGFöâöä6Æ–6³×¶6ÆV$ÆÇÒ7G–ÆS×·²&6¶w&÷VæC¢væöæRrÂ&÷&FW#¢væöæRrÂ7W'6÷#¢wö–çFW"rÂ6öÆ÷#¢wf"‚Ò×FW‡BÖ×WFVB’rÂföçE6—¦S¢s‚rÂF—7Æ“¢vfÆW‚rÂÆ–vä—FV×3¢v6VçFW"rÂv¢s7‚rÂFF–æs¢×ÓãÅ‚6—¦S×³Òóâ6ÆV"ÆÃÂö'WGFöãàÐ¢ÂöF—càÐ¢—ÐÐ¢ÂöF—càÐ¢—ÐÐ¢ÂöF—càÐ¢ÅW&vVæ7”f–ÇFW"6÷VçG3×·7WW&vVæ7”6÷VçG7Ò7W'&VçC×·7Wf–ÇFW'Òöä6†ævS×·6WE7Wf–ÇFW'ÒóàÐ¢Æ'WGFöâöä6Æ–6³×²‚’ÓâW‡÷'D55b€Ð¢²u4µRrÂuF—FÆRrÂuF÷FÂd$…U2´4’rÂââæ7F—fUv&V†÷W6W2æÖ‡rÓâræÆ&VÂ’Âuv&V†÷W6RF÷FÂrÂuF÷FÂ–çbrÂtfrF–Ç’Væ—G2rÂtF—26÷fW"rÂuVæ—G2Fò÷&FW"rÂu&V÷&FW"'’rÂuW&vVæ7’uÒÀÐ¢ ’7WÆ–W%&÷w2æÖ‡"Óâ·"ç6·RÂ"çF—FÆRÂ"çF÷FÅöf&Âââæ7F—fUv&V†÷W6W2æÖ‡rÓâ"çv&V†÷W6U÷G—5·ræ–EÒóò’Â"çv&V†÷W6U÷F÷FÂÂ"çF÷FÅö–çfVçF÷'’Â"æfuöF–Ç•÷Væ—G2Â"æF—5ööeö6÷fW%÷F÷FÂóòrrÂ"çVæ—G5÷Fõö÷&FW"Â ’"ç&V÷&FW%ö'’óòrrÂ"çW&vVæ7•Ò’Âw6VÆÆW&—×7WÆ–W"×&V÷&FW"æ77bpÐ¢—Ò7G–ÆS×·²F—7Æ“¢vfÆW‚rÂÆ–vä—FV×3¢v6VçFW"rÂv¢sg‚rÂFF–æs¢sg‚'‚rÂ&÷&FW%&F—W3¢sw‚rÂ&÷&FW#¢s‚6öÆ–Bf"‚ÒÖ&÷&FW"’rÂ&6¶w&÷VæC¢wG&ç7&VçBrÂ6öÆ÷#¢wf"‚Ò×FW‡BÖ×WFVB’rÂföçE6—¦S¢s'‚rÂ7W'6÷#¢wö–çFW"r×ÓàÐ¢ÄF÷væÆöB6—¦S×³'ÒóâW‡÷'@Ð¢Âö'WGFöãàÐ¢ÂöF—càÐ Ð¢²ò¢7WÆ–W"F&ÆR¢÷ÐÐ¢ÆF—b6Æ74æÖSÒ&6&B"7G–ÆS×·²÷fW&fÆ÷s¢v†–FFVâr×ÓàÐ¢ÆF—b7G–ÆS×·²÷fW&fÆ÷uƒ¢vWFòrÂÖ„†V–v‡C¢ssf‚rÂ÷fW&fÆ÷u“¢vWFòr×ÓàÐ¢ÇF&ÆR7G–ÆS×·²v–GFƒ¢sRrÂ&÷&FW$6öÆÆ6S¢v6öÆÆ6Rr×ÓàÐ¢ÇF†VCàÐ¢ÇG#àÐ¢ÇF‚7G–ÆS×·²ââçF„&6RÂFW‡DÆ–vã¢vÆVgBrÂÖ–åv–GFƒ¢s#C‚r×Óå&öGV7CÂ÷FƒàÐ¢ÇF‚7G–ÆS×·²ââçF„&6RÂFW‡DÆ–vã¢v6VçFW"r×ÓåW&vVæ7“Â÷FƒàÐ¢ÇF‚7G–ÆS×·²ââçF…6÷'F&ÆR‡7W6÷'D¶W’ÓÓÒwF÷FÅöf&r’ÂFW‡DÆ–vã¢w&–v‡Br×Òöä6Æ–6³×²‚’Óâ†æFÆU7W6÷'B‚wF÷FÅöf&r—ÓàÐ¢Ç7â7G–ÆS×·²F—7Æ“¢vfÆW‚rÂÆ–vä—FV×3¢v6VçFW"rÂ§W7F–g”6öçFVçC¢vfÆW‚ÖVæBrÂv¢sG‚r×Óäd$–çbÅ6÷'D–6öâ6öÃÒ'F÷FÅöf&"7W#×·7W6÷'D¶W—ÒF—#×·7W6÷'DF—'ÒóãÂ÷7ãàÐ¢Â÷FƒàÐ¢¶7F—fUv&V†÷W6W2æÖ‡rÓâ€Ð¢ÇF‚¶W“×·ræ–GÒ7G–ÆS×·²ââçF„&6RÂFW‡DÆ–vã¢w&–v‡BrÂ6öÆ÷#¢r4s„$dr×Óç·ræÆ&VÇÓÂ÷FƒàÐ¢’—ÐÐ¢ÇF‚7G–ÆS×·²ââçF„&6RÂFW‡DÆ–vã¢w&–v‡BrÂföçEvV–v‡C¢s×ÓåF÷FÂ–çcÂ÷FƒàÐ¢ÇF‚7G–ÆS×·²ââçF…6÷'F&ÆR‡7W6÷'D¶W’ÓÓÒvfuöF–Ç•÷Væ—G2r’ÂFW‡DÆ–vã¢w&–v‡Br×Òöä6Æ–6³×²‚’Óâ†æFÆU7W6÷'B‚vfuöF–Ç•÷Væ—G2r—ÓàÐ¢Ç7â7G–ÆS×·²F—7Æ“¢vfÆW‚rÂÆ–vä—FV×3¢v6VçFW"rÂ§W7F–g”6öçFVçC¢vfÆW‚ÖVæBrÂv¢sG‚r×ÓäfrôF’Å6÷'D–6öâ6öÃÒ&fuöF–Ç•÷Væ—G2"7W#×·7W6÷'D¶W—ÒF—#×·7W6÷'DF—'ÒóãÂ÷7ãàÐ¢Â÷FƒàÐ¢ÇF‚7G–ÆS×·²ââçF…6÷'F&ÆR‡7W6÷'D¶W’ÓÓÒvF—5ööeö6÷fW%÷F÷FÂr’ÂFW‡DÆ–vã¢w&–v‡Br×Òöä6Æ–6³×²‚’Óâ†æFÆU7W6÷'B‚vF—5ööeö6÷fW%÷F÷FÂr—ÓàÐ¢Ç7â7G–ÆS×·²F—7Æ“¢vfÆW‚rÂÆ–vä—FV×3¢v6VçFW"rÂ§W7F–g”6öçFVçC¢vfÆW‚ÖVæBrÂv¢sG‚r×ÓäF—26÷fW"Å6÷'D–6öâ6öÃÒ&F—5ööeö6÷fW%÷F÷FÂ"7W#×·7W6÷'D¶W—ÒF—#×·7W6÷'DF—'ÒóãÂ÷7ãàÐ¢Â÷FƒàÐ¢ÇF‚7G–ÆS×·²ââçF…6÷'F&ÆR‡7W6÷'D¶W’ÓÓÒwVæ—G5÷Fõö÷&FW"r’ÂFW‡DÆ–vã¢w&–v‡BrÂ6öÆ÷#¢wf"‚ÒÖ66VçB’r×Òöä6Æ–6³×²‚’Óâ†æFÆU7W6÷'B‚wVæ—G5÷Fõö÷&FW"r—ÓàÐ¢Ç7â7G–ÆS×·²F—7Æ“¢vfÆW‚rÂÆ–vä—FV×3¢v6VçFW"rÂ§W7F–g”6öçFVçC¢vfÆW‚ÖVæBrÂv¢sG‚r×ÓåVæ—G2Fò÷&FW"Å6÷'D–6öâ6öÃÒ'Væ—G5÷Fõö÷&FW""7W#×·7W6÷'D¶W—ÒF—#×·7W6÷'DF—'ÒóãÂ÷7ãàÐ¢Â÷FƒàÐ¢ÇF‚7G–ÆS×·²ââçF„&6RÂFW‡DÆ–vã¢w&–v‡Br×Óå&V÷&FW"'“Â÷FƒàÐ¢ÇF‚7G–ÆS×·²ââçF„&6RÂv–GFƒ¢s3'‚r×ÓãÂ÷FƒàÐ¢Â÷G#àÐ¢Â÷F†VCàÐ¢ÇF&öG“àÐ¢·7WÆ–W%&÷w2æÖ‡&÷rÓâ°Ð¢6öç7BV2ÒU$tTä5•ô4ôäd”u·&÷rçW&vVæ7•ÐÐ¢6öç7B—4W‡æFVBÒW‡æFVE7W6·RÓÓÒ&÷rç6·PÐ¢6öç7BÆVEF‡&W6†öÆBÒ&÷ræfuöF–Ç•÷Væ—G2¢7WÆ–W$ÆVDF—0Ð¢6öç7BF—5VçF–ÄÆVBÒ&÷ræF—5ööeö6÷fW%÷F÷FÂÓÒçVÆÂbb&÷ræF—5ööeö6÷fW%÷F÷FÂâ7WÆ–W$ÆVDF—0Ð¢ò&÷ræF—5ööeö6÷fW%÷F÷FÂÒ7WÆ–W$ÆVDF—2¢çVÆÀÐ Ð¢&WGW&â€Ð¢Å&V7Bäg&vÖVçB¶W“×·&÷rç6·WÓàÐ¢ÇG Ð¢öä6Æ–6³×²‚’Óâ6WDW‡æFVE7W6·R†—4W‡æFVBòçVÆÂ¢&÷rç6·R—ÐÐ¢7G–ÆS×·²&÷&FW$&÷GFöÓ¢—4W‡æFVBòvæöæRr¢s‚6öÆ–Bf"‚ÒÖ&÷&FW"’rÂ7W'6÷#¢wö–çFW"rÂ&6¶w&÷VæC¢—4W‡æFVBòwf"‚ÒÖ66VçBÖÆ–v‡B’r¢wG&ç7&VçBr×ÐÐ¢öäÖ÷W6TVçFW#×¶RÓâ²–b‚—4W‡æFVB’†Ræ7W'&VçEF&vWB2…DÔÅF&ÆU&÷tVÆVÖVçB’ç7G–ÆRæ&6¶w&÷VæBÒwf"‚ÒÖ&rÖ†÷fW"’r×ÐÐ¢öäÖ÷W6TÆVfS×¶RÓâ²–b‚—4W‡æFVB’†Ræ7W'&VçEF&vWB2…DÔÅF&ÆU&÷tVÆVÖVçB’ç7G–ÆRæ&6¶w&÷VæBÒwG&ç7&VçBr×ÐÐ¢àÐ¢ÇFB7G–ÆS×·²FF–æs¢s‚'‚r×ÓàÐ¢ÆF—b7G–ÆS×·²föçE6—¦S¢s'‚rÂföçEvV–v‡C¢SÂ6öÆ÷#¢wf"‚Ò×FW‡B×&–Ö'’’rÂÖ&v–ä&÷GFöÓ¢s'‚r×Óç·G'Væ6FR‡&÷rçF—FÆRÂCR—ÓÂöF—càÐ¢ÆF—b7G–ÆS×·²föçE6—¦S¢s‚rÂ6öÆ÷#¢wf"‚Ò×FW‡BÖF–Ò’rÂföçDfÖ–Ç“¢t¦WD'&–ç2ÖöæòÂÖöæ÷76Rr×Óç·&÷rç6·WÓÂöF—càÐ¢Â÷FCàÐ¢ÇFB7G–ÆS×·²FF–æs¢s‚'‚rÂFW‡DÆ–vã¢v6VçFW"r×ÓàÐ¢Ç7â7G–ÆS×·²föçE6—¦S¢s‚rÂföçEvV–v‡C¢cÂFF–æs¢s'‚‡‚rÂ&÷&FW%&F—W3¢sG‚rÂ&6¶w&÷VæC¢V2æ&rÂ6öÆ÷#¢V2æ6öÆ÷"×Óç·V2æÆ&VÇÓÂ÷7ãàÐ¢Â÷FCàÐ¢ÇFB7G–ÆS×·²FF–æs¢s‚'‚rÂFW‡DÆ–vã¢w&–v‡BrÂföçE6—¦S¢s'‚rÂföçDfÖ–Ç“¢t¦WD'&–ç2ÖöæòÂÖöæ÷76Rr×Óç¶f×B‡&÷rçF÷FÅöf&—ÓÂ÷FCàÐ¢¶7F—fUv&V†÷W6W2æÖ‡rÓâ°Ð¢6öç7BÒ&÷rçv&V†÷W6U÷G—5·ræ–EÒóò Ð¢&WGW&âÇFB¶W“×·ræ–GÒ7G–ÆS×·²FF–æs¢s‚'‚rÂFW‡DÆ–vã¢w&–v‡BrÂföçE6—¦S¢s'‚rÂföçDfÖ–Ç“¢t¦WD'&–ç2ÖöæòÂÖöæ÷76RrÂ6öÆ÷#¢âòr4s„$dr¢wf"‚Ò×FW‡BÖF–Ò’r×Óç·âòf×B‡’¢~(	BwÓÂ÷FCàÐ¢Ò—ÐÐ¢ÇFB7G–ÆS×·²FF–æs¢s‚'‚rÂFW‡DÆ–vã¢w&–v‡BrÂföçE6—¦S¢s'‚rÂföçDfÖ–Ç“¢t¦WD'&–ç2ÖöæòÂÖöæ÷76RrÂföçEvV–v‡C¢c×Óç¶f×B‡&÷rçF÷FÅö–çfVçF÷'’—ÓÂ÷FCàÐ¢ÇFB7G–ÆS×·²FF–æs¢s‚'‚rÂFW‡DÆ–vã¢w&–v‡BrÂföçE6—¦S¢s'‚rÂföçDfÖ–Ç“¢t¦WD'&–ç2ÖöæòÂÖöæ÷76RrÂ6öÆ÷#¢wf"‚Ò×FW‡BÖ×WFVB’r×Óç·&÷ræfuöF–Ç•÷Væ—G2âò&÷ræfuöF–Ç•÷Væ—G2çFôf—†VBƒ’¢~(	BwÓÂ÷FCàÐ¢ÇFB7G–ÆS×·²FF–æs¢s‚'‚rÂFW‡DÆ–vã¢w&–v‡BrÂföçE6—¦S¢s'‚rÂföçDfÖ–Ç“¢t¦WD'&–ç2ÖöæòÂÖöæ÷76Rr×ÓàÐ¢·&÷ræF—5ööeö6÷fW%÷F÷FÂÓÓÒçVÆÂòÇ7â7G–ÆS×·²6öÆ÷#¢wf"‚Ò×FW‡BÖF–Ò’r×Óî(	CÂ÷7ãâ¢€Ð¢Ç7â7G–ÆS×·²föçEvV–v‡C¢cÂ6öÆ÷#¢&÷rçW&vVæ7’ÓÓÒv7&—F–6Âròwf"‚Ò×&VB’r¢&÷rçW&vVæ7’ÓÓÒw&V÷&FW"ròr4c“s3br¢wf"‚ÒÖw&VVâ’r×Óç·&÷ræF—5ööeö6÷fW%÷F÷FÇÖCÂ÷7ãàÐ¢—ÐÐ¢Â÷FCàÐ¢ÇFB7G–ÆS×·²FF–æs¢s‚'‚rÂFW‡DÆ–vã¢w&–v‡BrÂföçE6—¦S¢s7‚rÂföçDfÖ–Ç“¢t¦WD'&–ç2ÖöæòÂÖöæ÷76RrÂföçEvV–v‡C¢sÂ6öÆ÷#¢&÷rçVæ—G5÷Fõö÷&FW"âòwf"‚ÒÖ66VçB’r¢wf"‚Ò×FW‡BÖF–Ò’r×ÓàÐ¢·&÷rçVæ—G5÷Fõö÷&FW"âòf×B‡&÷rçVæ—G5÷Fõö÷&FW"’¢~(	BwÐÐ¢Â÷FCàÐ¢ÇFB7G–ÆS×·²FF–æs¢s‚'‚rÂFW‡DÆ–vã¢w&–v‡BrÂföçE6—¦S¢s‚rÂföçDfÖ–Ç“¢t¦WD'&–ç2ÖöæòÂÖöæ÷76Rr×ÓàÐ¢·&÷rç&V÷&FW%ö'’ÓÓÒt÷&FW"æ÷rrò€Ð¢Ç7â7G–ÆS×·²föçEvV–v‡C¢sÂ6öÆ÷#¢wf"‚Ò×&VB’r×Óä÷&FW"æ÷sÂ÷7ãàÐ¢’¢&÷rç&V÷&FW%ö'’ò€Ð¢Ç7â7G–ÆS×·²6öÆ÷#¢r4c“s3br×Óç·&÷rç&V÷&FW%ö'—ÓÂ÷7ãàÐ¢’¢€Ð¢Ç7â7G–ÆS×·²6öÆ÷#¢wf"‚ÒÖw&VVâ’r×ÓäöâG&6³Â÷7ãàÐ¢—ÐÐ¢Â÷FCàÐ¢ÇFB7G–ÆS×·²FF–æs¢s‚'‚rÂFW‡DÆ–vã¢v6VçFW"rÂ6öÆ÷#¢wf"‚Ò×FW‡BÖF–Ò’r×ÓàÐ¢¶—4W‡æFVBòÄ6†Wg&öäF÷vâ6—¦S×³7Òóâ¢Ä6†Wg&öå&–v‡B6—¦S×³7ÒóçÐÐ¢Â÷FCàÐ¢Â÷G#àÐ¢¶—4W‡æFVBbb€Ð¢ÇG"7G–ÆS×·²&÷&FW$&÷GFöÓ¢s‚6öÆ–Bf"‚ÒÖ&÷&FW"’r×ÓàÐ¢ÇFB6öÅ7ã×³’²7F—fUv&V†÷W6W2æÆVæwF‡Ò7G–ÆS×·²FF–æs¢Â&6¶w&÷VæC¢wf"‚ÒÖ66VçBÖÆ–v‡B’r×ÓàÐ¢Äf÷&V67EæVÀÐ¢7F'D–çfVçF÷'“×·&÷rçF÷FÅö–çfVçF÷'—ÐÐ¢ftF–Ç•Væ—G3×·&÷ræfuöF–Ç•÷Væ—G7ÐÐ¢†÷&—¦öäF—3×·7WÆ–W$÷&FW%F&vWGÐÐ¢F‡&W6†öÆEVæ—G3×¶ÆVEF‡&W6†öÆGÐÐ¢F‡&W6†öÆDÆ&VÃ×¶÷&FW"G&–vvW"‚G·7WÆ–W$ÆVDF—7ÖBÆVBF–ÖR–ÐÐ¢F‡&W6†öÆD6öÆ÷#Ò"4c“s3b Ð¢÷&FW$'”F—3×¶F—5VçF–ÄÆVGÐÐ¢6ÆW4†—7F÷'“×·6ÆW4†—7F÷'”'•6·TöæÇ•·&÷rç6·UÒÇÂµ×ÐÐ¢7FG4ÆVgC×µ°Ð¢²Æ&VÃ¢uF÷FÂ–çfVçF÷'’rÂfÇVS¢f×B‡&÷rçF÷FÅö–çfVçF÷'’’ÒÀÐ¢²Æ&VÃ¢td$rÂfÇVS¢f×B‡&÷rçF÷FÅöf&’ÒÀÐ¢âââ†7F—fUv&V†÷W6W2æÆVæwF‚â Ð¢ò·²Æ&VÃ¢uv&V†÷W6RF÷FÂrÂfÇVS¢f×B‡&÷rçv&V†÷W6U÷F÷FÂ’Â6öÆ÷#¢r4s„$drÕÐÐ¢¢µÒ’ÀÐ¢òòW"×v&V†÷W6R'&V¶F÷vâöæÇ’v†VâF†W&Rw2Ö÷&RF†âöæR†÷F†W'v—6R—B§W7B&WVG2F†RF÷FÂ’àÐ¢âââ†7F—fUv&V†÷W6W2æÆVæwF‚ãÒ Ð¢ò7F—fUv&V†÷W6W2æÖ‡rÓâ‡²Æ&VÃ¢ræÆ&VÂÂfÇVS¢f×B‡&÷rçv&V†÷W6U÷G—5·ræ–EÒóò’Â6öÆ÷#¢r4s„$drÒ’Ð¢¢µÒ’ÀÐ¢×ÐÐ¢7FG5&–v‡C×µ°Ð¢²Æ&VÃ¢tfrôF’rÂfÇVS¢&÷ræfuöF–Ç•÷Væ—G2çFôf—†VBƒ’ÒÀÐ¢²Æ&VÃ¢tF—26÷fW"rÂfÇVS¢&÷ræF—5ööeö6÷fW%÷F÷FÂÓÒçVÆÂòG·&÷ræF—5ööeö6÷fW%÷F÷FÇÖF¢~(	BrÂ6öÆ÷#¢&÷rçW&vVæ7’ÓÓÒv7&—F–6Âròwf"‚Ò×&VB’r¢&÷rçW&vVæ7’ÓÓÒw&V÷&FW"ròr4c“s3br¢wf"‚ÒÖw&VVâ’rÒÀÐ¢²Æ&VÃ¢uVæ—G2Fò÷&FW"rÂfÇVS¢&÷rçVæ—G5÷Fõö÷&FW"âòf×B‡&÷rçVæ—G5÷Fõö÷&FW"’¢~)É26÷fW&VBrÂ6öÆ÷#¢&÷rçVæ—G5÷Fõö÷&FW"âòwf"‚ÒÖ66VçB’r¢wf"‚ÒÖw&VVâ’rÒÀÐ¢×ÐÐ¢óàÐ¢Â÷FCàÐ¢Â÷G#àÐ¢—ÐÐ¢Âõ&V7Bäg&vÖVçCàÐ¢Ð¢Ò—ÐÐ¢Â÷F&öG“àÐ¢Â÷F&ÆSàÐ¢·7WÆ–W%&÷w2æÆVæwF‚ÓÓÒbbÆF—b7G–ÆS×·²FF–æs¢sC‚rÂFW‡DÆ–vã¢v6VçFW"rÂ6öÆ÷#¢wf"‚Ò×FW‡BÖF–Ò’rÂföçE6—¦S¢s7‚r×ÓäÆÂ4µW2†fR7Vff–6–VçB–çfVçF÷'’6÷fW&vR	øè“ÂöF—cçÐÐ¢ÂöF—càÐ¢ÂöF—càÐ¢ÂóàÐ¢—ÐÐ¢ÂóàÐ¢—ÐÐ¢ÂöF—càÐ¢Ð§Ð