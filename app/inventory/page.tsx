'use client'

import React, { useEffect, useState } from 'react'
import { supabase } from '@/lib/supabase'
import MarketplaceFilter from '@/components/MarketplaceFilter'
import {
  AlertTriangle, Package, TrendingDown, ArrowDown,
  ArrowUp, ArrowUpDown, Search, Truck, Box, Send, ShoppingCart, Download, Upload,
  ChevronDown, ChevronRight,
} from 'lucide-react'
import {
  ComposedChart, Bar, Line, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, ReferenceLine, ReferenceArea, Cell,
} from 'recharts'

// ─── Constants ───────────────────────────────────────────────
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

// ─── Types ───────────────────────────────────────────────────
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

type SupplierReplenRow = {
  sku: string
  title: string
  asin: string
  total_fba: number
  warehouse_qty: number
  total_inventory: number
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

type SortKey = 'sku' | 'fulfillable' | 'available' | 'reserved' | 'inbound' | 'days_of_cover' | 'avg_daily_units'
type FbaSortKey = 'sku' | 'total_inventory' | 'inbound' | 'avg_daily_units' | 'days_of_cover' | 'units_to_send'
type SupplierSortKey = 'sku' | 'total_fba' | 'avg_daily_units' | 'days_of_cover_total' | 'units_to_order'
type SortDir = 'asc' | 'desc'

// ─── Helpers ─────────────────────────────────────────────────
function fmt(n: number) {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M'
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K'
  return n.toLocaleString()
}
function truncate(s: string, n: number) {
  return s && s.length > n ? s.slice(0, n) + '…' : s
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

// ─── Forecast generator ───────────────────────────────────────
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

// ─── Urgency Filter ───────────────────────────────────────────
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

// ─── Sort Icon ────────────────────────────────────────────────
function SortIcon({ col, cur, dir }: { col: string, cur: string, dir: SortDir }) {
  if (cur !== col) return <ArrowUpDown size={10} style={{ opacity: 0.3 }} />
  return dir === 'desc' ? <ArrowDown size={10} /> : <ArrowUp size={10} />
}

// ─── Forecast Tooltip ─────────────────────────────────────────
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

// ─── Forecast Panel ───────────────────────────────────────────
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
    ? 'var(--green)'
    : stockoutIndex > 0 && stockoutIndex < points.length - 1
      ? 'var(--red)'
      : '#F97316'

  const summaryText = (() => {
    if (avgDailyUnits === 0) return 'No sales velocity data - forecast unavailable.'
    if (stockoutLabel && orderByDays != null && orderByDays <= 0) {
      return `At ${avgDailyUnits.toFixed(1)} units/day, you'll run out ${stockoutLabel}. Your ${Math.round(horizonDays - (thresholdUnits ? thresholdUnits / avgDailyUnits : 0))}d lead time means you should have ordered already - order now.`
    }
    if (stockoutLabel && orderByLabel) {
      return `At ${avgDailyUnits.toFixed(1)} units/day, you'll run out ${stockoutLabel}. Your lead time means you must place the order by ${orderByLabel} to avoid a stockout.`
    }
    if (stockoutLabel) {
      return `At ${avgDailyUnits.toFixed(1)} units/day, you'll run out ${stockoutLabel}. Order soon to avoid a stockout.`
    }
    if (orderByLabel) {
      return `At ${avgDailyUnits.toFixed(1)} units/day, inventory will last through the forecast window. Place your next order by ${orderByLabel} to stay on track.`
    }
    return `At ${avgDailyUnits.toFixed(1)} units/day, inventory is healthy through the forecast window.`
  })()

  const orderByPinLabel = (() => {
    if (orderByDays == null || orderByDays < 0) return null
    const orderDate = new Date()
    orderDate.setDate(orderDate.getDate() + Math.round(orderByDays))
    const orderDateKey = dateKeyFromDate(orderDate)
    const matchingPoint = points.find(point => point.dateKey === orderDateKey)
    return matchingPoint ? { dateKey: matchingPoint.dateKey, label: matchingPoint.label } : null
  })()

  const summaryColor = stockoutLabel
    ? (orderByDays != null && orderByDays <= 0 ? 'var(--red)' : '#F97316')
    : 'var(--text-muted)'

  return (
    <div style={{ padding: '16px 20px 20px', background: 'var(--bg-elevated)', borderTop: '1px solid var(--border)' }}>

      <div style={{
        fontSize: '13px', lineHeight: '1.5', marginBottom: '16px',
        padding: '10px 14px', borderRadius: '8px',
        background: stockoutLabel ? 'rgba(220,38,38,0.06)' : 'var(--bg-hover)',
        border: `1px solid ${stockoutLabel ? 'rgba(220,38,38,0.15)' : 'var(--border)'}`,
        color: summaryColor, fontWeight: 500,
      }}>
        {summaryText}
      </div>

      {/* Stats row */}
      <div style={{ display: 'flex', gap: '32px', marginBottom: '16px', flexWrap: 'wrap' }}>
        {[...statsLeft, ...statsRight].map((s, i) => (
          <div key={i}>
            <div style={{ fontSize: '10px', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: '3px' }}>{s.label}</div>
            <div style={{ fontSize: '16px', fontWeight: 700, fontFamily: 'JetBrains Mono, monospace', color: s.color || 'var(--text-primary)' }}>{s.value}</div>
          </div>
        ))}
      </div>

      {/* Chart - inventory line plus daily demand bars */}
      {avgDailyUnits > 0 ? (
        <ResponsiveContainer width="100%" height={220}>
          <ComposedChart data={points} margin={{ top: 8, right: 16, bottom: 0, left: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
            <XAxis
              dataKey="dateKey"
              tick={{ fontSize: 9, fill: 'var(--text-dim)' }}
              tickLine={false}
              axisLine={false}
              interval={0}
              minTickGap={18}
              tickFormatter={value => xTickLabels[value] || ''}
            />
            <YAxis
              tick={{ fontSize: 9, fill: 'var(--text-dim)' }}
              tickLine={false}
              axisLine={false}
              tickFormatter={v => fmt(v)}
              width={50}
              domain={[0, Math.round(startInventory * 1.1)]}
            />
            <Tooltip content={<ForecastTooltip />} />

            <Bar
              dataKey="demand"
              name="Demand"
              radius={[2, 2, 0, 0]}
              barSize={4}
            >
              {points.map(point => (
                <Cell
                  key={`demand-${point.dateKey}`}
                  fill={point.demandPhase === 'forecast' ? 'rgba(168,85,247,0.28)' : 'rgba(59,130,246,0.32)'}
                  stroke={point.demandPhase === 'forecast' ? 'rgba(168,85,247,0.6)' : 'rgba(59,130,246,0.68)'}
                />
              ))}
            </Bar>

            {forecastStartPoint && (
              <ReferenceLine
                x={forecastStartPoint.dateKey}
                stroke="#A855F7"
                strokeWidth={1.5}
                strokeDasharray="5 3"
                label={{ value: 'Forecast starts', position: 'insideTopRight', fontSize: 9, fill: '#A855F7', fontWeight: 700 }}
              />
            )}

            {/* Threshold line - reorder trigger */}
            {thresholdUnits != null && thresholdUnits > 0 && (
              <ReferenceLine
                y={thresholdUnits}
                stroke={thresholdColor || '#F97316'}
                strokeWidth={1}
                strokeDasharray="4 2"
                label={{ value: thresholdLabel || 'Reorder', position: 'insideTopRight', fontSize: 9, fill: thresholdColor || '#F97316' }}
              />
            )}

            {/* Danger zone below threshold */}
            {thresholdUnits != null && thresholdUnits > 0 && (
              <ReferenceArea y1={0} y2={thresholdUnits} fill="rgba(220,38,38,0.04)" />
            )}

            {/* Vertical order-by pin - matched to nearest data point */}
            {orderByPinLabel && (
              <ReferenceLine
                x={orderByPinLabel.dateKey}
                stroke="#F97316"
                strokeWidth={2}
                label={{ value: `Order by ${orderByPinLabel.label}`, position: 'insideTopLeft', fontSize: 9, fill: '#F97316', fontWeight: 700 }}
              />
            )}

            {/* Inventory depletion line */}
            <Line
              type="monotone"
              dataKey="inventory"
              name="Inventory"
              stroke={lineColor}
              strokeWidth={2.5}
              dot={false}
              activeDot={{ r: 5 }}
            />
          </ComposedChart>
        </ResponsiveContainer>
      ) : (
        <div style={{ padding: '20px', textAlign: 'center', fontSize: '12px', color: 'var(--text-dim)' }}>
          No sales velocity data — forecast unavailable
        </div>
      )}

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: '8px', gap: '12px' }}>
        <div style={{ fontSize: '11px', color: 'var(--text-dim)' }}>
          Blue bars show the last 14 days of actual sales. Violet bars begin immediately after that and show the forecast demand.
        </div>
        <div style={{ fontSize: '11px', color: 'var(--text-dim)' }}>
          Forecast horizon: {cappedHorizon} days · Based on {avgDailyUnits.toFixed(1)} units/day avg
        </div>
      </div>
    </div>
  )
}

// ─── Main Component ───────────────────────────────────────────
export default function Inventory() {
  const [markets, setMarkets]         = useState(['US', 'CA'])
  const [tab, setTab]                 = useState<TabType>('inventory')
  const [inventory, setInventory]     = useState<InventoryRow[]>([])
  const [loading, setLoading]         = useState(true)
  const [search, setSearch]           = useState('')
  const [sortKey, setSortKey]         = useState<SortKey>('avg_daily_units')
  const [sortDir, setSortDir]         = useState<SortDir>('desc')
  const [fbaSortKey, setFbaSortKey]   = useState<FbaSortKey>('units_to_send')
  const [fbaSortDir, setFbaSortDir]   = useState<SortDir>('desc')
  const [supSortKey, setSupSortKey]   = useState<SupplierSortKey>('units_to_order')
  const [supSortDir, setSupSortDir]   = useState<SortDir>('desc')
  const [statusFilter, setStatusFilter] = useState<string>('all')
  const [fbaFilter, setFbaFilter]     = useState<string>('all')
  const [supFilter, setSupFilter]     = useState<string>('all')
  const [snapshotDate, setSnapshotDate] = useState<string>('')
  const [salesHistoryBySkuMarket, setSalesHistoryBySkuMarket] = useState<Record<string, SalesHistoryPoint[]>>({})
  const [salesHistoryBySkuOnly, setSalesHistoryBySkuOnly] = useState<Record<string, SalesHistoryPoint[]>>({})
  const [expandedFbaSku, setExpandedFbaSku]   = useState<string | null>(null)
  const [expandedSupSku, setExpandedSupSku]   = useState<string | null>(null)

  // ── Replenishment settings ──
  const [fbaTarget, setFbaTarget]     = useState<number>(() => typeof window !== 'undefined' ? Number(localStorage.getItem('selleriq_fba_target') || FBA_TARGET_DEFAULT) : FBA_TARGET_DEFAULT)
  const [prodDays, setProdDays]       = useState<number>(() => typeof window !== 'undefined' ? Number(localStorage.getItem('selleriq_prod_days') || SUPPLIER_PROD_DEFAULT) : SUPPLIER_PROD_DEFAULT)
  const [shipDays, setShipDays]       = useState<number>(() => typeof window !== 'undefined' ? Number(localStorage.getItem('selleriq_ship_days') || SUPPLIER_SHIP_DEFAULT) : SUPPLIER_SHIP_DEFAULT)
  const [bufferDays, setBufferDays]   = useState<number>(() => typeof window !== 'undefined' ? Number(localStorage.getItem('selleriq_buffer_days') || SUPPLIER_BUFFER_DEFAULT) : SUPPLIER_BUFFER_DEFAULT)
  const [pendingFba, setPendingFba]   = useState<number>(fbaTarget)
  const [pendingProd, setPendingProd] = useState<number>(prodDays)
  const [pendingShip, setPendingShip] = useState<number>(shipDays)
  const [pendingBuffer, setPendingBuffer] = useState<number>(bufferDays)
  const [showFbaConfirm, setShowFbaConfirm] = useState(false)
  const [showSupConfirm, setShowSupConfirm] = useState(false)

  // ── Warehouse inventory ──
  const [warehouseQty, setWarehouseQty] = useState<Record<string, number>>(() => {
    if (typeof window === 'undefined') return {}
    try { return JSON.parse(localStorage.getItem('selleriq_warehouse_qty') || '{}') } catch { return {} }
  })
  const [warehouseUploadDate, setWarehouseUploadDate] = useState<string>(() =>
    typeof window !== 'undefined' ? localStorage.getItem('selleriq_warehouse_upload_date') || '' : ''
  )
  const [unmatchedSkus, setUnmatchedSkus] = useState<string[]>([])
  const [showUnmatched, setShowUnmatched] = useState(false)

  const supplierLeadDays    = prodDays + shipDays
  const supplierOrderTarget = prodDays + shipDays + bufferDays

  const downloadTemplate = () => {
    const allSkus = [...new Set(inventory.map(r => r.sku).filter(Boolean))]
    const rows = allSkus.map(sku => `${sku},0`)
    const csv = 'sku,warehouse_qty\n' + rows.join('\n')
    const blob = new Blob([csv], { type: 'text/csv' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url; a.download = 'selleriq-warehouse-template.csv'; a.click()
    URL.revokeObjectURL(url)
  }

  const handleWarehouseUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = (evt) => {
      const text = evt.target?.result as string
      const lines = text.trim().split('\n')
      const header = lines[0].toLowerCase().replace(/\s/g, '')
      if (!header.includes('sku') || !header.includes('warehouse_qty')) {
        alert('Invalid CSV format. Please use the template with columns: sku, warehouse_qty')
        return
      }
      const newQty: Record<string, number> = {}
      const unmatched: string[] = []
      const knownSkus = new Set(inventory.map(r => r.sku))
      for (let i = 1; i < lines.length; i++) {
        const parts = lines[i].split(',')
        if (parts.length < 2) continue
        const sku = parts[0].trim()
        const qty = parseInt(parts[1].trim(), 10)
        if (!sku) continue
        newQty[sku] = isNaN(qty) ? 0 : qty
        if (!knownSkus.has(sku)) unmatched.push(sku)
      }
      setWarehouseQty(newQty)
      setUnmatchedSkus(unmatched)
      if (unmatched.length > 0) setShowUnmatched(true)
      const uploadDate = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
      setWarehouseUploadDate(uploadDate)
      localStorage.setItem('selleriq_warehouse_qty', JSON.stringify(newQty))
      localStorage.setItem('selleriq_warehouse_upload_date', uploadDate)
    }
    reader.readAsText(file)
    e.target.value = ''
  }

  const applyFbaTarget = () => {
    setFbaTarget(pendingFba)
    localStorage.setItem('selleriq_fba_target', String(pendingFba))
    setShowFbaConfirm(false)
  }

  const applySupplierSettings = () => {
    setProdDays(pendingProd)
    setShipDays(pendingShip)
    setBufferDays(pendingBuffer)
    localStorage.setItem('selleriq_prod_days',   String(pendingProd))
    localStorage.setItem('selleriq_ship_days',   String(pendingShip))
    localStorage.setItem('selleriq_buffer_days', String(pendingBuffer))
    setShowSupConfirm(false)
  }

  // ─── Data loading ─────────────────────────────────────────
  useEffect(() => {
    async function load() {
      setLoading(true)

      const { data: snapDates } = await supabase
        .from('fct_inventory_snapshot_daily')
        .select('snapshot_date, marketplace')
        .in('marketplace', markets)
        .order('snapshot_date', { ascending: false })
        .limit(10)

      if (!snapDates?.length) { setLoading(false); return }
      const latestDate = snapDates[0].snapshot_date
      setSnapshotDate(latestDate)

      const { data: invData, error: invError } = await supabase
        .from('fct_inventory_snapshot_daily')
        .select('sku, asin, fnsku, marketplace, snapshot_date, fulfillable_quantity, available_quantity, reserved_quantity, total_inbound_quantity, unsellable_quantity')
        .in('marketplace', markets)
        .eq('snapshot_date', latestDate)
        .limit(5000)

      if (invError) { console.error(invError); setLoading(false); return }

      const thirtyDaysAgo = new Date()
      thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 37)
      const cutoff = thirtyDaysAgo.toISOString().split('T')[0]

      const { data: salesData } = await supabase
        .from('fct_sales_daily')
        .select('sku, marketplace, units_ordered, start_date')
        .in('marketplace', markets)
        .gte('start_date', cutoff)
        .limit(20000)

      const LOOKBACK_DAYS = 30
      const salesBySku: Record<string, { total: number }> = {}
      const dailySalesBySku: Record<string, Record<string, number>> = {}
      for (const row of salesData || []) {
        if (!row.sku) continue
        const key = `${row.sku}__${row.marketplace}`
        if (!salesBySku[key]) salesBySku[key] = { total: 0 }
        salesBySku[key].total += row.units_ordered || 0
        if (!dailySalesBySku[key]) dailySalesBySku[key] = {}
        dailySalesBySku[key][row.start_date] = (dailySalesBySku[key][row.start_date] || 0) + (row.units_ordered || 0)
      }

      const salesBySkuOnly: Record<string, { total: number }> = {}
      const dailySalesBySkuOnly: Record<string, Record<string, number>> = {}
      for (const row of salesData || []) {
        if (!row.sku) continue
        if (!salesBySkuOnly[row.sku]) salesBySkuOnly[row.sku] = { total: 0 }
        salesBySkuOnly[row.sku].total += row.units_ordered || 0
        if (!dailySalesBySkuOnly[row.sku]) dailySalesBySkuOnly[row.sku] = {}
        dailySalesBySkuOnly[row.sku][row.start_date] = (dailySalesBySkuOnly[row.sku][row.start_date] || 0) + (row.units_ordered || 0)
      }

      const mapHistory = (dailyTotals: Record<string, Record<string, number>>) => {
        const mapped: Record<string, SalesHistoryPoint[]> = {}
        for (const [key, byDate] of Object.entries(dailyTotals)) {
          mapped[key] = Object.entries(byDate)
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([dateKey, units]) => ({ dateKey, units }))
        }
        return mapped
      }

      const skus = [...new Set((invData || []).map(r => r.sku).filter(Boolean))]
      const { data: productData } = await supabase
        .from('dim_product')
        .select('sku, title, marketplace')
        .in('sku', skus.slice(0, 500))

      const titleBySku: Record<string, string> = {}
      for (const p of productData || []) {
        if (p.sku) titleBySku[p.sku] = p.title || p.sku
      }

      const rows: InventoryRow[] = (invData || []).map(row => {
        const key = `${row.sku}__${row.marketplace}`
        const salesInfo = salesBySku[key]
        const totalUnits = salesInfo?.total || 0
        const avgDailyUnits = totalUnits / LOOKBACK_DAYS
        const available  = row.available_quantity || 0
        const fulfillable = row.fulfillable_quantity || 0
        const inbound    = row.total_inbound_quantity || 0
        const reserved   = row.reserved_quantity || 0
        const totalFba   = fulfillable + inbound + reserved
        const doc = avgDailyUnits > 0 ? Math.round(totalFba / avgDailyUnits) : null

        return {
          sku:           row.sku || '',
          title:         titleBySku[row.sku] || row.sku || '',
          asin:          row.asin || '',
          marketplace:   row.marketplace,
          fulfillable,
          available,
          reserved,
          inbound,
          total_fba:     totalFba,
          unsellable:    row.unsellable_quantity || 0,
          avg_daily_units: Math.round(avgDailyUnits * 10) / 10,
          days_of_cover: doc,
          status:        getStatus(fulfillable, doc),
          snapshot_date: row.snapshot_date,
        }
      })

      setInventory(rows)
      setSalesHistoryBySkuMarket(mapHistory(dailySalesBySku))
      setSalesHistoryBySkuOnly(mapHistory(dailySalesBySkuOnly))
      setLoading(false)
    }
    load()
  }, [markets])

  // ─── Sort helpers ─────────────────────────────────────────
  const handleSort = (key: SortKey) => {
    if (sortKey === key) setSortDir(d => d === 'asc' ? 'desc' : 'asc')
    else { setSortKey(key); setSortDir('asc') }
  }
  const handleFbaSort = (key: FbaSortKey) => {
    if (fbaSortKey === key) setFbaSortDir(d => d === 'asc' ? 'desc' : 'asc')
    else { setFbaSortKey(key); setFbaSortDir('asc') }
  }
  const handleSupSort = (key: SupplierSortKey) => {
    if (supSortKey === key) setSupSortDir(d => d === 'asc' ? 'desc' : 'asc')
    else { setSupSortKey(key); setSupSortDir('asc') }
  }

  // ─── Filtered inventory ───────────────────────────────────
  const filtered = inventory
    .filter(r => {
      if (statusFilter !== 'all' && r.status !== statusFilter) return false
      if (search) {
        const q = search.toLowerCase()
        return r.sku.toLowerCase().includes(q) || r.title.toLowerCase().includes(q) || r.asin.toLowerCase().includes(q)
      }
      return true
    })
    .sort((a, b) => {
      const av = a[sortKey] ?? (sortDir === 'asc' ? Infinity : -Infinity)
      const bv = b[sortKey] ?? (sortDir === 'asc' ? Infinity : -Infinity)
      if (typeof av === 'string') return sortDir === 'asc' ? av.localeCompare(bv as string) : (bv as string).localeCompare(av)
      return sortDir === 'asc' ? (av as number) - (bv as number) : (bv as number) - (av as number)
    })

  // ─── FBA rows ─────────────────────────────────────────────
  const fbaRows: FbaReplenRow[] = inventory
    .map(r => {
      const totalInv = r.total_fba
      const fbaDoc = r.avg_daily_units > 0 ? Math.round(totalInv / r.avg_daily_units) : null
      const unitsToSend = r.avg_daily_units > 0
        ? Math.max(0, Math.round(fbaTarget * r.avg_daily_units) - totalInv)
        : 0
      const urgency: FbaReplenRow['urgency'] =
        fbaDoc === null ? 'healthy' :
        fbaDoc < supplierLeadDays ? 'critical' :
        fbaDoc < fbaTarget ? 'reorder' : 'healthy'
      return {
        sku: r.sku, title: r.title, asin: r.asin, marketplace: r.marketplace,
        total_inventory: totalInv, available: r.available, fulfillable: r.fulfillable,
        inbound: r.inbound, reserved: r.reserved,
        avg_daily_units: r.avg_daily_units,
        days_of_cover: fbaDoc,
        units_to_send: unitsToSend,
        urgency,
      }
    })
    .filter(r => r.urgency !== 'healthy' || r.units_to_send > 0)
    .filter(r => {
      if (fbaFilter !== 'all' && r.urgency !== fbaFilter) return false
      if (search) {
        const q = search.toLowerCase()
        return r.sku.toLowerCase().includes(q) || r.title.toLowerCase().includes(q)
      }
      return true
    })
    .sort((a, b) => {
      const av = (a as any)[fbaSortKey] ?? (fbaSortDir === 'asc' ? Infinity : -Infinity)
      const bv = (b as any)[fbaSortKey] ?? (fbaSortDir === 'asc' ? Infinity : -Infinity)
      if (typeof av === 'string') return fbaSortDir === 'asc' ? av.localeCompare(bv) : bv.localeCompare(av)
      return fbaSortDir === 'asc' ? av - bv : bv - av
    })

  // ─── Supplier rows ────────────────────────────────────────
  const supplierRowsBySku: Record<string, SupplierReplenRow> = {}
  for (const r of inventory) {
    if (!r.sku) continue
    const wh = warehouseQty[r.sku] || 0
    const existing = supplierRowsBySku[r.sku]
    if (!existing) {
      supplierRowsBySku[r.sku] = {
        sku: r.sku, title: r.title, asin: r.asin,
        total_fba: r.total_fba,
        warehouse_qty: wh,
        total_inventory: r.total_fba + wh,
        avg_daily_units: r.avg_daily_units,
        days_of_cover_total: null,
        units_to_order: 0,
        reorder_by: null,
        urgency: 'healthy',
      }
    } else {
      existing.total_fba       += r.total_fba
      existing.total_inventory  = existing.total_fba + existing.warehouse_qty
      existing.avg_daily_units += r.avg_daily_units
    }
  }

  const supplierRows: SupplierReplenRow[] = Object.values(supplierRowsBySku)
    .map(r => {
      const doc = r.avg_daily_units > 0 ? Math.round(r.total_inventory / r.avg_daily_units) : null
      const unitsToOrder = r.avg_daily_units > 0
        ? Math.max(0, Math.round(supplierOrderTarget * r.avg_daily_units) - r.total_inventory)
        : 0
      const urgency: SupplierReplenRow['urgency'] =
        doc === null ? 'healthy' :
        doc < supplierLeadDays ? 'critical' :
        doc < supplierOrderTarget ? 'reorder' : 'healthy'
      const reorderBy = urgency === 'critical' ? 'Order Now'
        : urgency === 'reorder' && doc !== null
          ? addDays(doc - supplierLeadDays)
          : null
      return { ...r, days_of_cover_total: doc, units_to_order: unitsToOrder, urgency, reorder_by: reorderBy }
    })
    .filter(r => {
      if (supFilter !== 'all' && r.urgency !== supFilter) return false
      if (search) {
        const q = search.toLowerCase()
        return r.sku.toLowerCase().includes(q) || r.title.toLowerCase().includes(q)
      }
      return true
    })
    .sort((a, b) => {
      const av = (a as any)[supSortKey] ?? (supSortDir === 'asc' ? Infinity : -Infinity)
      const bv = (b as any)[supSortKey] ?? (supSortDir === 'asc' ? Infinity : -Infinity)
      if (typeof av === 'string') return supSortDir === 'asc' ? av.localeCompare(bv) : bv.localeCompare(av)
      return supSortDir === 'asc' ? av - bv : bv - av
    })

  // ─── Urgency counts ───────────────────────────────────────
  const fbaUrgencyCounts = fbaRows.reduce((acc, r) => { acc[r.urgency] = (acc[r.urgency] || 0) + 1; return acc }, {} as Record<string, number>)
  const supUrgencyCounts = supplierRows.reduce((acc, r) => { acc[r.urgency] = (acc[r.urgency] || 0) + 1; return acc }, {} as Record<string, number>)
  const statusCounts = filtered.reduce((acc, r) => { acc[r.status] = (acc[r.status] || 0) + 1; return acc }, {} as Record<string, number>)

  // ─── Table styles ─────────────────────────────────────────
  const thBase: React.CSSProperties = {
    padding: '10px 12px', fontSize: '10px', fontWeight: 600,
    textTransform: 'uppercase', letterSpacing: '0.06em',
    color: 'var(--text-muted)', background: 'var(--bg-hover)',
    borderBottom: '1px solid var(--border)',
    position: 'sticky', top: 0, zIndex: 10, whiteSpace: 'nowrap',
  }
  const thSortable = (active: boolean): React.CSSProperties => ({
    ...thBase,
    color: active ? 'var(--accent)' : 'var(--text-muted)',
    cursor: 'pointer', userSelect: 'none',
  })

  return (
    <div>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '20px' }}>
        <div>
          <h1 style={{ fontSize: '20px', fontWeight: 600, letterSpacing: '-0.4px', marginBottom: '4px' }}>Inventory</h1>
          <p style={{ fontSize: '13px', color: 'var(--text-muted)' }}>
            Snapshot date: <span style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: '12px' }}>{snapshotDate || '—'}</span>
            {' · '}{inventory.length} SKUs across {markets.join(', ')}
          </p>
        </div>
        <MarketplaceFilter selected={markets} onChange={setMarkets} />
      </div>

      {/* Tabs */}
      <div style={{ display: 'flex', gap: '0', marginBottom: '20px', borderBottom: '1px solid var(--border)' }}>
        {([
          { key: 'inventory', label: 'Inventory Snapshot', icon: <Package size={13} /> },
          { key: 'fba',       label: 'FBA Replenishment',  icon: <Truck size={13} /> },
          { key: 'supplier',  label: 'Supplier Reorder',   icon: <ShoppingCart size={13} /> },
        ] as { key: TabType, label: string, icon: React.ReactNode }[]).map(t => (
          <button key={t.key} onClick={() => setTab(t.key)} style={{
            display: 'flex', alignItems: 'center', gap: '6px',
            padding: '8px 20px', fontSize: '13px', fontWeight: 500,
            background: 'transparent', border: 'none', cursor: 'pointer',
            borderBottom: tab === t.key ? '2px solid var(--accent)' : '2px solid transparent',
            color: tab === t.key ? 'var(--accent)' : 'var(--text-muted)',
            marginBottom: '-1px', transition: 'all 0.12s ease',
          }}>
            {t.icon}{t.label}
          </button>
        ))}
      </div>

      {loading ? (
        <div style={{ color: 'var(--text-muted)', fontSize: '13px' }}>Loading...</div>
      ) : (
        <>
          {/* ── INVENTORY SNAPSHOT TAB ── */}
          {tab === 'inventory' && (
            <>
              <div style={{ display: 'flex', gap: '10px', marginBottom: '14px', alignItems: 'center' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flex: 1, background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: '10px', padding: '9px 14px' }}>
                  <Search size={13} color="var(--text-muted)" />
                  <input type="text" placeholder="Filter by SKU, ASIN, or product name..." value={search} onChange={e => setSearch(e.target.value)}
                    style={{ flex: 1, background: 'transparent', border: 'none', outline: 'none', color: 'var(--text-primary)', fontSize: '13px' }} />
                </div>
                <div style={{ display: 'flex', gap: '4px' }}>
                  {(['all', 'out_of_stock', 'critical', 'low', 'healthy'] as const).map(s => (
                    <button key={s} onClick={() => setStatusFilter(s)} style={{
                      padding: '5px 10px', borderRadius: '6px', fontSize: '11px', fontWeight: 500, cursor: 'pointer',
                      border: statusFilter === s ? '1px solid var(--accent-border)' : '1px solid var(--border)',
                      background: statusFilter === s ? 'var(--accent-light)' : 'transparent',
                      color: statusFilter === s ? 'var(--accent)' : 'var(--text-muted)',
                    }}>
                      {s === 'all' ? 'All' : STATUS_CONFIG[s].label}
                      {s !== 'all' && statusCounts[s] ? ` (${statusCounts[s]})` : ''}
                    </button>
                  ))}
                </div>
                <button onClick={() => exportCSV(
                  ['SKU', 'ASIN', 'Marketplace', 'Status', 'Fulfillable', 'Available', 'Reserved', 'Inbound', 'Total FBA', 'Unsellable', 'Avg Daily Units', 'Days Cover', 'Snapshot Date'],
                  filtered.map(r => [r.sku, r.asin, r.marketplace, r.status, r.fulfillable, r.available, r.reserved, r.inbound, r.total_fba, r.unsellable, r.avg_daily_units, r.days_of_cover ?? '', r.snapshot_date]),
                  'selleriq-inventory.csv'
                )} style={{ display: 'flex', alignItems: 'center', gap: '6px', padding: '6px 12px', borderRadius: '7px', border: '1px solid var(--border)', background: 'transparent', color: 'var(--text-muted)', fontSize: '12px', cursor: 'pointer' }}>
                  <Download size={12} /> Export
                </button>
              </div>

              <div className="card" style={{ overflow: 'hidden' }}>
                <div style={{ overflowX: 'auto', maxHeight: '70vh', overflowY: 'auto' }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                    <thead>
                      <tr>
                        <th style={{ ...thBase, textAlign: 'left', minWidth: '240px' }}>Product</th>
                        <th style={{ ...thBase, textAlign: 'center' }}>Status</th>
                        <th style={{ ...thBase, textAlign: 'center' }}>Mkt</th>
                        <th style={{ ...thSortable(sortKey === 'fulfillable'), textAlign: 'right' }} onClick={() => handleSort('fulfillable')}>
                          <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: '4px' }}>Fulfillable <SortIcon col="fulfillable" cur={sortKey} dir={sortDir} /></span>
                        </th>
                        <th style={{ ...thSortable(sortKey === 'inbound'), textAlign: 'right' }} onClick={() => handleSort('inbound')}>
                          <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: '4px' }}>Inbound <SortIcon col="inbound" cur={sortKey} dir={sortDir} /></span>
                        </th>
                        <th style={{ ...thSortable(sortKey === 'reserved'), textAlign: 'right' }} onClick={() => handleSort('reserved')}>
                          <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: '4px' }}>Reserved <SortIcon col="reserved" cur={sortKey} dir={sortDir} /></span>
                        </th>
                        <th style={{ ...thSortable(sortKey === 'avg_daily_units'), textAlign: 'right' }} onClick={() => handleSort('avg_daily_units')}>
                          <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: '4px' }}>Avg/Day <SortIcon col="avg_daily_units" cur={sortKey} dir={sortDir} /></span>
                        </th>
                        <th style={{ ...thSortable(sortKey === 'days_of_cover'), textAlign: 'right' }} onClick={() => handleSort('days_of_cover')}>
                          <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: '4px' }}>Days Cover <SortIcon col="days_of_cover" cur={sortKey} dir={sortDir} /></span>
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {filtered.map(row => {
                        const sc = STATUS_CONFIG[row.status]
                        return (
                          <tr key={`${row.sku}-${row.marketplace}`} style={{ borderBottom: '1px solid var(--border)' }}
                            onMouseEnter={e => (e.currentTarget as HTMLTableRowElement).style.background = 'var(--bg-hover)'}
                            onMouseLeave={e => (e.currentTarget as HTMLTableRowElement).style.background = 'transparent'}>
                            <td style={{ padding: '11px 12px' }}>
                              <div style={{ fontSize: '12px', fontWeight: 500, color: 'var(--text-primary)', marginBottom: '2px' }}>{truncate(row.title, 45)}</div>
                              <div style={{ fontSize: '10px', color: 'var(--text-dim)', fontFamily: 'JetBrains Mono, monospace' }}>{row.sku}</div>
                            </td>
                            <td style={{ padding: '11px 12px', textAlign: 'center' }}>
                              <span style={{ fontSize: '10px', fontWeight: 600, padding: '2px 8px', borderRadius: '4px', background: sc.bg, color: sc.color }}>{sc.label}</span>
                            </td>
                            <td style={{ padding: '11px 12px', textAlign: 'center', fontSize: '11px', fontFamily: 'JetBrains Mono, monospace', color: 'var(--text-muted)' }}>{row.marketplace}</td>
                            <td style={{ padding: '11px 12px', textAlign: 'right', fontSize: '12px', fontFamily: 'JetBrains Mono, monospace', fontWeight: 600 }}>{fmt(row.fulfillable)}</td>
                            <td style={{ padding: '11px 12px', textAlign: 'right', fontSize: '12px', fontFamily: 'JetBrains Mono, monospace', color: row.inbound > 0 ? 'var(--accent)' : 'var(--text-dim)' }}>{row.inbound > 0 ? fmt(row.inbound) : '—'}</td>
                            <td style={{ padding: '11px 12px', textAlign: 'right', fontSize: '12px', fontFamily: 'JetBrains Mono, monospace', color: 'var(--text-muted)' }}>{row.reserved > 0 ? fmt(row.reserved) : '—'}</td>
                            <td style={{ padding: '11px 12px', textAlign: 'right', fontSize: '12px', fontFamily: 'JetBrains Mono, monospace', color: 'var(--text-muted)' }}>{row.avg_daily_units > 0 ? row.avg_daily_units.toFixed(1) : '—'}</td>
                            <td style={{ padding: '11px 12px', textAlign: 'right', fontSize: '12px', fontFamily: 'JetBrains Mono, monospace' }}>
                              {row.days_of_cover === null ? <span style={{ color: 'var(--text-dim)' }}>—</span> : (
                                <span style={{ fontWeight: 600, color: row.status === 'out_of_stock' ? 'var(--red)' : row.status === 'critical' ? '#F97316' : row.status === 'low' ? 'var(--yellow)' : 'var(--green)' }}>
                                  {row.days_of_cover}d
                                </span>
                              )}
                            </td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                  {filtered.length === 0 && <div style={{ padding: '40px', textAlign: 'center', color: 'var(--text-dim)', fontSize: '13px' }}>No inventory data found</div>}
                </div>
              </div>
            </>
          )}

          {/* ── FBA REPLENISHMENT TAB ── */}
          {tab === 'fba' && (
            <>
              {/* FBA Settings */}
              <div style={{ display: 'flex', alignItems: 'center', gap: '16px', marginBottom: '16px', padding: '12px 16px', background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: '10px', flexWrap: 'wrap' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                  <span style={{ fontSize: '12px', color: 'var(--text-muted)', fontWeight: 500 }}>FBA Target Coverage:</span>
                  <input type="number" value={pendingFba} onChange={e => setPendingFba(Number(e.target.value))} min={1} max={365}
                    style={{ width: '64px', padding: '4px 8px', borderRadius: '6px', border: '1px solid var(--border)', background: 'var(--bg-elevated)', color: 'var(--text-primary)', fontSize: '13px', fontFamily: 'JetBrains Mono, monospace', outline: 'none', textAlign: 'center' }} />
                  <span style={{ fontSize: '12px', color: 'var(--text-muted)' }}>days</span>
                  {pendingFba !== fbaTarget && (
                    <button onClick={() => setShowFbaConfirm(true)} style={{ padding: '4px 12px', borderRadius: '6px', border: 'none', background: 'var(--accent)', color: '#fff', fontSize: '12px', fontWeight: 600, cursor: 'pointer' }}>Apply</button>
                  )}
                </div>
                <div style={{ fontSize: '11px', color: 'var(--text-dim)', marginLeft: 'auto' }}>
                  Current target: <span style={{ color: 'var(--accent)', fontFamily: 'JetBrains Mono, monospace', fontWeight: 600 }}>{fbaTarget}d</span>
                  {' · '}Lead time: <span style={{ fontFamily: 'JetBrains Mono, monospace' }}>{supplierLeadDays}d</span>
                </div>
              </div>

              {showFbaConfirm && (
                <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 100, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  <div style={{ background: 'var(--bg-card)', borderRadius: '12px', padding: '24px', width: '360px', border: '1px solid var(--border)' }}>
                    <div style={{ fontSize: '15px', fontWeight: 600, marginBottom: '8px' }}>Update FBA Target?</div>
                    <div style={{ fontSize: '13px', color: 'var(--text-muted)', marginBottom: '20px' }}>Set FBA target coverage to <strong>{pendingFba} days</strong> for all SKUs?</div>
                    <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
                      <button onClick={() => setShowFbaConfirm(false)} style={{ padding: '7px 16px', borderRadius: '7px', border: '1px solid var(--border)', background: 'transparent', color: 'var(--text-muted)', fontSize: '13px', cursor: 'pointer' }}>Cancel</button>
                      <button onClick={applyFbaTarget} style={{ padding: '7px 16px', borderRadius: '7px', border: 'none', background: 'var(--accent)', color: '#fff', fontSize: '13px', fontWeight: 600, cursor: 'pointer' }}>Confirm</button>
                    </div>
                  </div>
                </div>
              )}

              <div style={{ display: 'flex', gap: '10px', marginBottom: '14px', alignItems: 'center' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flex: 1, background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: '10px', padding: '9px 14px' }}>
                  <Search size={13} color="var(--text-muted)" />
                  <input type="text" placeholder="Filter by SKU or product name..." value={search} onChange={e => setSearch(e.target.value)}
                    style={{ flex: 1, background: 'transparent', border: 'none', outline: 'none', color: 'var(--text-primary)', fontSize: '13px' }} />
                </div>
                <UrgencyFilter counts={fbaUrgencyCounts} current={fbaFilter} onChange={setFbaFilter} />
                <button onClick={() => exportCSV(
                  ['SKU', 'Title', 'Marketplace', 'Fulfillable', 'Inbound', 'Reserved', 'Total FBA', 'Avg Daily Units', 'Days Cover', 'Units to Send', 'Urgency'],
                  fbaRows.map(r => [r.sku, r.title, r.marketplace, r.fulfillable, r.inbound, r.reserved, r.total_inventory, r.avg_daily_units, r.days_of_cover ?? '', r.units_to_send, r.urgency]),
                  'selleriq-fba-replenishment.csv'
                )} style={{ display: 'flex', alignItems: 'center', gap: '6px', padding: '6px 12px', borderRadius: '7px', border: '1px solid var(--border)', background: 'transparent', color: 'var(--text-muted)', fontSize: '12px', cursor: 'pointer' }}>
                  <Download size={12} /> Export
                </button>
              </div>

              <div className="card" style={{ overflow: 'hidden' }}>
                <div style={{ overflowX: 'auto', maxHeight: '70vh', overflowY: 'auto' }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                    <thead>
                      <tr>
                        <th style={{ ...thBase, textAlign: 'left', minWidth: '240px' }}>Product</th>
                        <th style={{ ...thBase, textAlign: 'center' }}>Urgency</th>
                        <th style={{ ...thBase, textAlign: 'center' }}>Mkt</th>
                        <th style={{ ...thSortable(fbaSortKey === 'total_inventory'), textAlign: 'right' }} onClick={() => handleFbaSort('total_inventory')}>
                          <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: '4px' }}>Total FBA <SortIcon col="total_inventory" cur={fbaSortKey} dir={fbaSortDir} /></span>
                        </th>
                        <th style={{ ...thSortable(fbaSortKey === 'inbound'), textAlign: 'right' }} onClick={() => handleFbaSort('inbound')}>
                          <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: '4px' }}>Inbound <SortIcon col="inbound" cur={fbaSortKey} dir={fbaSortDir} /></span>
                        </th>
                        <th style={{ ...thSortable(fbaSortKey === 'avg_daily_units'), textAlign: 'right' }} onClick={() => handleFbaSort('avg_daily_units')}>
                          <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: '4px' }}>Avg/Day <SortIcon col="avg_daily_units" cur={fbaSortKey} dir={fbaSortDir} /></span>
                        </th>
                        <th style={{ ...thSortable(fbaSortKey === 'days_of_cover'), textAlign: 'right' }} onClick={() => handleFbaSort('days_of_cover')}>
                          <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: '4px' }}>Days Cover <SortIcon col="days_of_cover" cur={fbaSortKey} dir={fbaSortDir} /></span>
                        </th>
                        <th style={{ ...thSortable(fbaSortKey === 'units_to_send'), textAlign: 'right', color: 'var(--accent)' }} onClick={() => handleFbaSort('units_to_send')}>
                          <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: '4px' }}>Units to Send <SortIcon col="units_to_send" cur={fbaSortKey} dir={fbaSortDir} /></span>
                        </th>
                        <th style={{ ...thBase, width: '32px' }}></th>
                      </tr>
                    </thead>
                    <tbody>
                      {fbaRows.map(row => {
                        const uc = URGENCY_CONFIG[row.urgency]
                        const isExpanded = expandedFbaSku === `${row.sku}-${row.marketplace}`
                        const reorderThreshold = row.avg_daily_units * supplierLeadDays
                        const daysUntilThreshold = row.days_of_cover !== null && row.days_of_cover > supplierLeadDays
                          ? row.days_of_cover - supplierLeadDays : null

                        return (
                          <React.Fragment key={`${row.sku}-${row.marketplace}`}>
                            <tr
                              onClick={() => setExpandedFbaSku(isExpanded ? null : `${row.sku}-${row.marketplace}`)}
                              style={{ borderBottom: isExpanded ? 'none' : '1px solid var(--border)', cursor: 'pointer', background: isExpanded ? 'var(--accent-light)' : 'transparent' }}
                              onMouseEnter={e => { if (!isExpanded) (e.currentTarget as HTMLTableRowElement).style.background = 'var(--bg-hover)' }}
                              onMouseLeave={e => { if (!isExpanded) (e.currentTarget as HTMLTableRowElement).style.background = 'transparent' }}
                            >
                              <td style={{ padding: '11px 12px' }}>
                                <div style={{ fontSize: '12px', fontWeight: 500, color: 'var(--text-primary)', marginBottom: '2px' }}>{truncate(row.title, 45)}</div>
                                <div style={{ fontSize: '10px', color: 'var(--text-dim)', fontFamily: 'JetBrains Mono, monospace' }}>{row.sku}</div>
                              </td>
                              <td style={{ padding: '11px 12px', textAlign: 'center' }}>
                                <span style={{ fontSize: '10px', fontWeight: 600, padding: '2px 8px', borderRadius: '4px', background: uc.bg, color: uc.color }}>{uc.label}</span>
                              </td>
                              <td style={{ padding: '11px 12px', textAlign: 'center', fontSize: '11px', fontFamily: 'JetBrains Mono, monospace', color: 'var(--text-muted)' }}>{row.marketplace}</td>
                              <td style={{ padding: '11px 12px', textAlign: 'right', fontSize: '12px', fontFamily: 'JetBrains Mono, monospace', fontWeight: 600 }}>{fmt(row.total_inventory)}</td>
                              <td style={{ padding: '11px 12px', textAlign: 'right', fontSize: '12px', fontFamily: 'JetBrains Mono, monospace', color: row.inbound > 0 ? 'var(--accent)' : 'var(--text-dim)' }}>{row.inbound > 0 ? fmt(row.inbound) : '—'}</td>
                              <td style={{ padding: '11px 12px', textAlign: 'right', fontSize: '12px', fontFamily: 'JetBrains Mono, monospace', color: 'var(--text-muted)' }}>{row.avg_daily_units > 0 ? row.avg_daily_units.toFixed(1) : '—'}</td>
                              <td style={{ padding: '11px 12px', textAlign: 'right', fontSize: '12px', fontFamily: 'JetBrains Mono, monospace' }}>
                                {row.days_of_cover === null ? <span style={{ color: 'var(--text-dim)' }}>—</span> : (
                                  <span style={{ fontWeight: 600, color: row.urgency === 'critical' ? 'var(--red)' : row.urgency === 'reorder' ? '#F97316' : 'var(--green)' }}>{row.days_of_cover}d</span>
                                )}
                              </td>
                              <td style={{ padding: '11px 12px', textAlign: 'right', fontSize: '13px', fontFamily: 'JetBrains Mono, monospace', fontWeight: 700, color: row.units_to_send > 0 ? 'var(--accent)' : 'var(--text-dim)' }}>
                                {row.units_to_send > 0 ? fmt(row.units_to_send) : '—'}
                              </td>
                              <td style={{ padding: '11px 12px', textAlign: 'center', color: 'var(--text-dim)' }}>
                                {isExpanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                              </td>
                            </tr>
                            {isExpanded && (
                              <tr style={{ borderBottom: '1px solid var(--border)' }}>
                                <td colSpan={9} style={{ padding: 0, background: 'var(--accent-light)' }}>
                                  <ForecastPanel
                                    startInventory={row.total_inventory}
                                    avgDailyUnits={row.avg_daily_units}
                                    horizonDays={fbaTarget}
                                    thresholdUnits={reorderThreshold}
                                    thresholdLabel={`Reorder point (${supplierLeadDays}d lead)`}
                                    thresholdColor="#F97316"
                                    orderByDays={daysUntilThreshold}
                                    salesHistory={salesHistoryBySkuMarket[`${row.sku}__${row.marketplace}`] || []}
                                    statsLeft={[
                                      { label: 'Current FBA', value: fmt(row.total_inventory) },
                                      { label: 'Avg/Day', value: row.avg_daily_units.toFixed(1) },
                                      { label: 'Days Cover', value: row.days_of_cover !== null ? `${row.days_of_cover}d` : '—', color: row.urgency === 'critical' ? 'var(--red)' : row.urgency === 'reorder' ? '#F97316' : 'var(--green)' },
                                    ]}
                                    statsRight={[
                                      { label: 'FBA Target', value: `${fbaTarget}d` },
                                      { label: 'Units to Send', value: row.units_to_send > 0 ? fmt(row.units_to_send) : '✓ Covered', color: row.units_to_send > 0 ? 'var(--accent)' : 'var(--green)' },
                                      { label: 'Send By', value: daysUntilThreshold !== null ? addDays(daysUntilThreshold) : row.urgency === 'critical' ? 'Now' : 'On Track', color: row.urgency === 'critical' ? 'var(--red)' : '#F97316' },
                                    ]}
                                  />
                                </td>
                              </tr>
                            )}
                          </React.Fragment>
                        )
                      })}
                    </tbody>
                  </table>
                  {fbaRows.length === 0 && <div style={{ padding: '40px', textAlign: 'center', color: 'var(--text-dim)', fontSize: '13px' }}>All SKUs have sufficient FBA coverage 🎉</div>}
                </div>
              </div>
            </>
          )}

          {/* ── SUPPLIER REORDER TAB ── */}
          {tab === 'supplier' && (
            <>
              {/* Supplier Settings */}
              <div style={{ display: 'flex', alignItems: 'center', gap: '16px', marginBottom: '16px', padding: '12px 16px', background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: '10px', flexWrap: 'wrap' }}>
                {[
                  { label: 'Production', key: 'prod', value: pendingProd, setter: setPendingProd },
                  { label: 'Shipping',   key: 'ship', value: pendingShip, setter: setPendingShip },
                  { label: 'Buffer',     key: 'buf',  value: pendingBuffer, setter: setPendingBuffer },
                ].map(({ label, key, value, setter }) => (
                  <div key={key} style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <span style={{ fontSize: '12px', color: 'var(--text-muted)', fontWeight: 500 }}>{label}:</span>
                    <input type="number" value={value} onChange={e => setter(Number(e.target.value))} min={1} max={365}
                      style={{ width: '56px', padding: '4px 8px', borderRadius: '6px', border: '1px solid var(--border)', background: 'var(--bg-elevated)', color: 'var(--text-primary)', fontSize: '13px', fontFamily: 'JetBrains Mono, monospace', outline: 'none', textAlign: 'center' }} />
                    <span style={{ fontSize: '12px', color: 'var(--text-muted)' }}>d</span>
                  </div>
                ))}
                {(pendingProd !== prodDays || pendingShip !== shipDays || pendingBuffer !== bufferDays) && (
                  <button onClick={() => setShowSupConfirm(true)} style={{ padding: '4px 12px', borderRadius: '6px', border: 'none', background: 'var(--accent)', color: '#fff', fontSize: '12px', fontWeight: 600, cursor: 'pointer' }}>Apply</button>
                )}
                <div style={{ fontSize: '11px', color: 'var(--text-dim)', marginLeft: 'auto' }}>
                  Order target: <span style={{ color: 'var(--accent)', fontFamily: 'JetBrains Mono, monospace', fontWeight: 600 }}>{supplierOrderTarget}d</span>
                  {' · '}Lead time: <span style={{ fontFamily: 'JetBrains Mono, monospace' }}>{supplierLeadDays}d</span>
                </div>
              </div>

              {/* Warehouse Upload */}
              <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '14px', padding: '10px 14px', background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: '10px', flexWrap: 'wrap' }}>
                <Box size={13} color="var(--text-muted)" />
                <span style={{ fontSize: '12px', color: 'var(--text-muted)', fontWeight: 500 }}>Warehouse inventory:</span>
                {warehouseUploadDate ? (
                  <span style={{ fontSize: '11px', color: 'var(--text-dim)', fontFamily: 'JetBrains Mono, monospace' }}>Last updated {warehouseUploadDate}</span>
                ) : (
                  <span style={{ fontSize: '11px', color: 'var(--text-dim)' }}>No data uploaded yet</span>
                )}
                <div style={{ marginLeft: 'auto', display: 'flex', gap: '8px' }}>
                  <button onClick={downloadTemplate} style={{ display: 'flex', alignItems: 'center', gap: '5px', padding: '5px 10px', borderRadius: '6px', border: '1px solid var(--border)', background: 'transparent', color: 'var(--text-muted)', fontSize: '11px', cursor: 'pointer' }}>
                    <Download size={11} /> Template
                  </button>
                  <label style={{ display: 'flex', alignItems: 'center', gap: '5px', padding: '5px 10px', borderRadius: '6px', border: '1px solid var(--accent-border)', background: 'var(--accent-light)', color: 'var(--accent)', fontSize: '11px', cursor: 'pointer', fontWeight: 600 }}>
                    <Upload size={11} /> Upload CSV
                    <input type="file" accept=".csv" onChange={handleWarehouseUpload} style={{ display: 'none' }} />
                  </label>
                </div>
              </div>

              {/* Dialogs */}
              {showUnmatched && unmatchedSkus.length > 0 && (
                <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 100, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  <div style={{ background: 'var(--bg-card)', borderRadius: '12px', padding: '24px', width: '400px', border: '1px solid var(--border)' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px' }}>
                      <AlertTriangle size={15} color="#F97316" />
                      <div style={{ fontSize: '15px', fontWeight: 600 }}>{unmatchedSkus.length} Unmatched SKU{unmatchedSkus.length > 1 ? 's' : ''}</div>
                    </div>
                    <div style={{ fontSize: '13px', color: 'var(--text-muted)', marginBottom: '12px' }}>These SKUs were in your CSV but not found in SellerIQ.</div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', marginBottom: '20px' }}>
                      {unmatchedSkus.map(sku => (
                        <div key={sku} style={{ fontSize: '12px', fontFamily: 'JetBrains Mono, monospace', padding: '4px 8px', background: 'var(--bg-hover)', borderRadius: '4px', color: '#F97316' }}>{sku}</div>
                      ))}
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                      <button onClick={() => setShowUnmatched(false)} style={{ padding: '7px 16px', borderRadius: '7px', border: 'none', background: 'var(--accent)', color: '#fff', fontSize: '13px', fontWeight: 600, cursor: 'pointer' }}>Got it</button>
                    </div>
                  </div>
                </div>
              )}

              {showSupConfirm && (
                <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 100, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  <div style={{ background: 'var(--bg-card)', borderRadius: '12px', padding: '24px', width: '380px', border: '1px solid var(--border)' }}>
                    <div style={{ fontSize: '15px', fontWeight: 600, marginBottom: '8px' }}>Update Supplier Settings?</div>
                    <div style={{ fontSize: '13px', color: 'var(--text-muted)', marginBottom: '16px' }}>Apply these settings for all SKUs?</div>
                    <div style={{ fontSize: '13px', marginBottom: '20px', display: 'flex', flexDirection: 'column', gap: '6px' }}>
                      <div>Production: <strong>{pendingProd} days</strong></div>
                      <div>Shipping: <strong>{pendingShip} days</strong></div>
                      <div>Buffer: <strong>{pendingBuffer} days</strong></div>
                      <div style={{ borderTop: '1px solid var(--border)', paddingTop: '6px', marginTop: '2px' }}>Total order target: <strong>{pendingProd + pendingShip + pendingBuffer} days</strong></div>
                    </div>
                    <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
                      <button onClick={() => setShowSupConfirm(false)} style={{ padding: '7px 16px', borderRadius: '7px', border: '1px solid var(--border)', background: 'transparent', color: 'var(--text-muted)', fontSize: '13px', cursor: 'pointer' }}>Cancel</button>
                      <button onClick={applySupplierSettings} style={{ padding: '7px 16px', borderRadius: '7px', border: 'none', background: 'var(--accent)', color: '#fff', fontSize: '13px', fontWeight: 600, cursor: 'pointer' }}>Confirm for All SKUs</button>
                    </div>
                  </div>
                </div>
              )}

              {/* Search + Filter + Export */}
              <div style={{ display: 'flex', gap: '10px', marginBottom: '14px', alignItems: 'center' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flex: 1, background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: '10px', padding: '9px 14px' }}>
                  <Search size={13} color="var(--text-muted)" />
                  <input type="text" placeholder="Filter by SKU or product name..." value={search} onChange={e => setSearch(e.target.value)}
                    style={{ flex: 1, background: 'transparent', border: 'none', outline: 'none', color: 'var(--text-primary)', fontSize: '13px' }} />
                </div>
                <UrgencyFilter counts={supUrgencyCounts} current={supFilter} onChange={setSupFilter} />
                <button onClick={() => exportCSV(
                  ['SKU', 'Title', 'Total FBA (US+CA)', 'Warehouse', 'Total Inv', 'Avg Daily Units', 'Days Cover', 'Units to Order', 'Reorder By', 'Urgency'],
                  supplierRows.map(r => [r.sku, r.title, r.total_fba, r.warehouse_qty, r.total_inventory, r.avg_daily_units, r.days_of_cover_total ?? '', r.units_to_order, r.reorder_by ?? '', r.urgency]),
                  'selleriq-supplier-reorder.csv'
                )} style={{ display: 'flex', alignItems: 'center', gap: '6px', padding: '6px 12px', borderRadius: '7px', border: '1px solid var(--border)', background: 'transparent', color: 'var(--text-muted)', fontSize: '12px', cursor: 'pointer' }}>
                  <Download size={12} /> Export
                </button>
              </div>

              {/* Supplier Table */}
              <div className="card" style={{ overflow: 'hidden' }}>
                <div style={{ overflowX: 'auto', maxHeight: '70vh', overflowY: 'auto' }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                    <thead>
                      <tr>
                        <th style={{ ...thBase, textAlign: 'left', minWidth: '240px' }}>Product</th>
                        <th style={{ ...thBase, textAlign: 'center' }}>Urgency</th>
                        <th style={{ ...thSortable(supSortKey === 'total_fba'), textAlign: 'right' }} onClick={() => handleSupSort('total_fba')}>
                          <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: '4px' }}>FBA Inv <SortIcon col="total_fba" cur={supSortKey} dir={supSortDir} /></span>
                        </th>
                        <th style={{ ...thBase, textAlign: 'right', color: '#A78BFA' }}>Warehouse</th>
                        <th style={{ ...thBase, textAlign: 'right', fontWeight: 700 }}>Total Inv</th>
                        <th style={{ ...thSortable(supSortKey === 'avg_daily_units'), textAlign: 'right' }} onClick={() => handleSupSort('avg_daily_units')}>
                          <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: '4px' }}>Avg/Day <SortIcon col="avg_daily_units" cur={supSortKey} dir={supSortDir} /></span>
                        </th>
                        <th style={{ ...thSortable(supSortKey === 'days_of_cover_total'), textAlign: 'right' }} onClick={() => handleSupSort('days_of_cover_total')}>
                          <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: '4px' }}>Days Cover <SortIcon col="days_of_cover_total" cur={supSortKey} dir={supSortDir} /></span>
                        </th>
                        <th style={{ ...thSortable(supSortKey === 'units_to_order'), textAlign: 'right', color: 'var(--accent)' }} onClick={() => handleSupSort('units_to_order')}>
                          <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: '4px' }}>Units to Order <SortIcon col="units_to_order" cur={supSortKey} dir={supSortDir} /></span>
                        </th>
                        <th style={{ ...thBase, textAlign: 'right' }}>Reorder By</th>
                        <th style={{ ...thBase, width: '32px' }}></th>
                      </tr>
                    </thead>
                    <tbody>
                      {supplierRows.map(row => {
                        const uc = URGENCY_CONFIG[row.urgency]
                        const isExpanded = expandedSupSku === row.sku
                        const leadThreshold = row.avg_daily_units * supplierLeadDays
                        const daysUntilLead = row.days_of_cover_total !== null && row.days_of_cover_total > supplierLeadDays
                          ? row.days_of_cover_total - supplierLeadDays : null

                        return (
                          <React.Fragment key={row.sku}>
                            <tr
                              onClick={() => setExpandedSupSku(isExpanded ? null : row.sku)}
                              style={{ borderBottom: isExpanded ? 'none' : '1px solid var(--border)', cursor: 'pointer', background: isExpanded ? 'var(--accent-light)' : 'transparent' }}
                              onMouseEnter={e => { if (!isExpanded) (e.currentTarget as HTMLTableRowElement).style.background = 'var(--bg-hover)' }}
                              onMouseLeave={e => { if (!isExpanded) (e.currentTarget as HTMLTableRowElement).style.background = 'transparent' }}
                            >
                              <td style={{ padding: '11px 12px' }}>
                                <div style={{ fontSize: '12px', fontWeight: 500, color: 'var(--text-primary)', marginBottom: '2px' }}>{truncate(row.title, 45)}</div>
                                <div style={{ fontSize: '10px', color: 'var(--text-dim)', fontFamily: 'JetBrains Mono, monospace' }}>{row.sku}</div>
                              </td>
                              <td style={{ padding: '11px 12px', textAlign: 'center' }}>
                                <span style={{ fontSize: '10px', fontWeight: 600, padding: '2px 8px', borderRadius: '4px', background: uc.bg, color: uc.color }}>{uc.label}</span>
                              </td>
                              <td style={{ padding: '11px 12px', textAlign: 'right', fontSize: '12px', fontFamily: 'JetBrains Mono, monospace' }}>{fmt(row.total_fba)}</td>
                              <td style={{ padding: '11px 12px', textAlign: 'right', fontSize: '12px', fontFamily: 'JetBrains Mono, monospace', color: row.warehouse_qty > 0 ? '#A78BFA' : 'var(--text-dim)' }}>{row.warehouse_qty > 0 ? fmt(row.warehouse_qty) : '—'}</td>
                              <td style={{ padding: '11px 12px', textAlign: 'right', fontSize: '12px', fontFamily: 'JetBrains Mono, monospace', fontWeight: 600 }}>{fmt(row.total_inventory)}</td>
                              <td style={{ padding: '11px 12px', textAlign: 'right', fontSize: '12px', fontFamily: 'JetBrains Mono, monospace', color: 'var(--text-muted)' }}>{row.avg_daily_units > 0 ? row.avg_daily_units.toFixed(1) : '—'}</td>
                              <td style={{ padding: '11px 12px', textAlign: 'right', fontSize: '12px', fontFamily: 'JetBrains Mono, monospace' }}>
                                {row.days_of_cover_total === null ? <span style={{ color: 'var(--text-dim)' }}>—</span> : (
                                  <span style={{ fontWeight: 600, color: row.urgency === 'critical' ? 'var(--red)' : row.urgency === 'reorder' ? '#F97316' : 'var(--green)' }}>{row.days_of_cover_total}d</span>
                                )}
                              </td>
                              <td style={{ padding: '11px 12px', textAlign: 'right', fontSize: '13px', fontFamily: 'JetBrains Mono, monospace', fontWeight: 700, color: row.units_to_order > 0 ? 'var(--accent)' : 'var(--text-dim)' }}>
                                {row.units_to_order > 0 ? fmt(row.units_to_order) : '—'}
                              </td>
                              <td style={{ padding: '11px 12px', textAlign: 'right', fontSize: '11px', fontFamily: 'JetBrains Mono, monospace' }}>
                                {row.reorder_by === 'Order Now' ? (
                                  <span style={{ fontWeight: 700, color: 'var(--red)' }}>Order Now</span>
                                ) : row.reorder_by ? (
                                  <span style={{ color: '#F97316' }}>{row.reorder_by}</span>
                                ) : (
                                  <span style={{ color: 'var(--green)' }}>On Track</span>
                                )}
                              </td>
                              <td style={{ padding: '11px 12px', textAlign: 'center', color: 'var(--text-dim)' }}>
                                {isExpanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                              </td>
                            </tr>
                            {isExpanded && (
                              <tr style={{ borderBottom: '1px solid var(--border)' }}>
                                <td colSpan={10} style={{ padding: 0, background: 'var(--accent-light)' }}>
                                  <ForecastPanel
                                    startInventory={row.total_inventory}
                                    avgDailyUnits={row.avg_daily_units}
                                    horizonDays={supplierOrderTarget}
                                    thresholdUnits={leadThreshold}
                                    thresholdLabel={`Order trigger (${supplierLeadDays}d lead time)`}
                                    thresholdColor="#F97316"
                                    orderByDays={daysUntilLead}
                                    salesHistory={salesHistoryBySkuOnly[row.sku] || []}
                                    statsLeft={[
                                      { label: 'Total Inventory', value: fmt(row.total_inventory) },
                                      { label: 'FBA', value: fmt(row.total_fba) },
                                      { label: 'Warehouse', value: row.warehouse_qty > 0 ? fmt(row.warehouse_qty) : '—', color: '#A78BFA' },
                                    ]}
                                    statsRight={[
                                      { label: 'Avg/Day', value: row.avg_daily_units.toFixed(1) },
                                      { label: 'Days Cover', value: row.days_of_cover_total !== null ? `${row.days_of_cover_total}d` : '—', color: row.urgency === 'critical' ? 'var(--red)' : row.urgency === 'reorder' ? '#F97316' : 'var(--green)' },
                                      { label: 'Units to Order', value: row.units_to_order > 0 ? fmt(row.units_to_order) : '✓ Covered', color: row.units_to_order > 0 ? 'var(--accent)' : 'var(--green)' },
                                    ]}
                                  />
                                </td>
                              </tr>
                            )}
                          </React.Fragment>
                        )
                      })}
                    </tbody>
                  </table>
                  {supplierRows.length === 0 && <div style={{ padding: '40px', textAlign: 'center', color: 'var(--text-dim)', fontSize: '13px' }}>All SKUs have sufficient inventory coverage 🎉</div>}
                </div>
              </div>
            </>
          )}
        </>
      )}
    </div>
  )
}