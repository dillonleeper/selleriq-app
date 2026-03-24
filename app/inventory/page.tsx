'use client'

import React, { useEffect, useState } from 'react'
import { supabase } from '@/lib/supabase'
import MarketplaceFilter from '@/components/MarketplaceFilter'
import {
  AlertTriangle, Package, TrendingDown, ArrowDown,
  ArrowUp, ArrowUpDown, Search, Truck, Box, Send, ShoppingCart, Download
} from 'lucide-react'

// ─── Constants ───────────────────────────────────────────────
const CAD_TO_USD = 0.74
const LOW_STOCK_THRESHOLD   = 30   // days of cover below this = low stock
const CRITICAL_THRESHOLD    = 14   // days of cover below this = critical
const FBA_TARGET_DAYS       = 60   // target days of cover at FBA
const FBA_REORDER_THRESHOLD = 60   // flag for FBA replenishment below this
const SUPPLIER_LEAD_DAYS    = 70   // 42 days production + 28 days shipping
const SUPPLIER_BUFFER_DAYS  = 60   // extra buffer on top of lead time
const SUPPLIER_ORDER_TARGET = SUPPLIER_LEAD_DAYS + SUPPLIER_BUFFER_DAYS // 130 days total

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
  total_fba: number   // fulfillable + inbound + reserved
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
  avg_daily_units: number
  days_of_cover_total: number | null
  units_to_order: number
  reorder_by: string | null
  urgency: 'critical' | 'reorder' | 'healthy'
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
function getStatus(available: number, doc: number | null): InventoryRow['status'] {
  if (available === 0) return 'out_of_stock'
  if (doc !== null && doc < CRITICAL_THRESHOLD) return 'critical'
  if (doc !== null && doc < LOW_STOCK_THRESHOLD) return 'low'
  return 'healthy'
}
function getFbaUrgency(doc: number | null): FbaReplenRow['urgency'] {
  if (doc === null || doc < CRITICAL_THRESHOLD) return 'critical'
  if (doc < FBA_REORDER_THRESHOLD) return 'reorder'
  return 'healthy'
}
function getSupplierUrgency(doc: number | null): SupplierReplenRow['urgency'] {
  if (doc === null || doc < SUPPLIER_LEAD_DAYS) return 'critical'
  if (doc < SUPPLIER_ORDER_TARGET) return 'reorder'
  return 'healthy'
}
function addDays(days: number): string {
  const d = new Date()
  d.setDate(d.getDate() + days)
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}
function exportCSV(headers: string[], rows: (string | number)[][], filename: string) {
  const escapeField = (val: string | number) => {
    const str = String(val)
    // Wrap in quotes if contains comma, quote, or newline
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

// ─── Main Component ───────────────────────────────────────────
export default function Inventory() {
  const [markets, setMarkets]         = useState(['US', 'CA'])
  const [tab, setTab]                 = useState<TabType>('inventory')
  const [inventory, setInventory]     = useState<InventoryRow[]>([])
  const [loading, setLoading]         = useState(true)
  const [search, setSearch]           = useState('')
  const [sortKey, setSortKey]         = useState<SortKey>('avg_daily_units')
  const [sortDir, setSortDir]         = useState<SortDir>('desc')
  const [fbaSortKey, setFbaSortKey]   = useState<FbaSortKey>('days_of_cover')
  const [fbaSortDir, setFbaSortDir]   = useState<SortDir>('asc')
  const [supSortKey, setSupSortKey]   = useState<SupplierSortKey>('days_of_cover_total')
  const [supSortDir, setSupSortDir]   = useState<SortDir>('asc')
  const [statusFilter, setStatusFilter] = useState<string>('all')
  const [fbaFilter, setFbaFilter]     = useState<string>('all')
  const [supFilter, setSupFilter]     = useState<string>('all')
  const [snapshotDate, setSnapshotDate] = useState<string>('')

  // ─── Data loading ─────────────────────────────────────────
  useEffect(() => {
    async function load() {
      setLoading(true)

      // Latest snapshot date
      const { data: snapDates } = await supabase
        .from('fct_inventory_snapshot_daily')
        .select('snapshot_date, marketplace')
        .in('marketplace', markets)
        .order('snapshot_date', { ascending: false })
        .limit(10)

      if (!snapDates?.length) { setLoading(false); return }
      const latestDate = snapDates[0].snapshot_date
      setSnapshotDate(latestDate)

      // Inventory snapshot
      const { data: invData, error: invError } = await supabase
        .from('fct_inventory_snapshot_daily')
        .select('sku, asin, fnsku, marketplace, snapshot_date, fulfillable_quantity, available_quantity, reserved_quantity, total_inbound_quantity, unsellable_quantity')
        .in('marketplace', markets)
        .eq('snapshot_date', latestDate)
        .limit(5000)

      if (invError) { console.error(invError); setLoading(false); return }

      // 30-day average daily units from fct_sales_daily
      const thirtyDaysAgo = new Date()
      thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 37)
      const cutoff = thirtyDaysAgo.toISOString().split('T')[0]

      const { data: salesData } = await supabase
        .from('fct_sales_daily')
        .select('sku, marketplace, units_ordered, start_date')
        .in('marketplace', markets)
        .gte('start_date', cutoff)
        .limit(20000)

      // Avg daily units per SKU+marketplace
      const salesBySku: Record<string, { total: number, weeks: Set<string> }> = {}
      for (const row of salesData || []) {
        if (!row.sku) continue
        const key = `${row.sku}__${row.marketplace}`
        if (!salesBySku[key]) salesBySku[key] = { total: 0, weeks: new Set() }
        salesBySku[key].total += row.units_ordered || 0
        salesBySku[key].weeks.add(row.start_date)
      }

      // Also build a US-only avg for supplier report (combine US+CA into one row per SKU)
      const salesBySkuOnly: Record<string, { total: number, weeks: Set<string> }> = {}
      for (const row of salesData || []) {
        if (!row.sku) continue
        if (!salesBySkuOnly[row.sku]) salesBySkuOnly[row.sku] = { total: 0, weeks: new Set() }
        salesBySkuOnly[row.sku].total += row.units_ordered || 0
        salesBySkuOnly[row.sku].weeks.add(`${row.marketplace}__${row.start_date}`)
      }

      // Dim product for titles
      const skus = [...new Set((invData || []).map(r => r.sku).filter(Boolean))]
      const { data: productData } = await supabase
        .from('dim_product')
        .select('sku, title, marketplace')
        .in('sku', skus.slice(0, 500))

      const titleBySku: Record<string, string> = {}
      for (const p of productData || []) {
        if (p.sku) titleBySku[p.sku] = p.title || p.sku
      }

      // Build inventory rows
      const rows: InventoryRow[] = (invData || []).map(row => {
        const key = `${row.sku}__${row.marketplace}`
        const salesInfo = salesBySku[key]
        const totalUnits = salesInfo?.total || 0
        const weekCount  = salesInfo?.weeks.size || 0
        const avgDailyUnits = weekCount > 0 ? (totalUnits / (weekCount * 7)) : 0
        const available  = row.available_quantity || 0
        const fulfillable = row.fulfillable_quantity || 0
        const inbound    = row.total_inbound_quantity || 0
        const reserved   = row.reserved_quantity || 0
        const totalFba   = fulfillable + inbound + reserved
        // Days of cover uses total inventory: fulfillable + inbound + reserved
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
          status:        getStatus(available, doc),
          snapshot_date: row.snapshot_date,
        }
      })

      setInventory(rows)
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

  // ─── Filtered / sorted inventory ─────────────────────────
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

  // ─── FBA Replenishment rows ───────────────────────────────
  // One row per SKU+marketplace, only show SKUs that need attention
  const fbaRows: FbaReplenRow[] = inventory
    .map(r => {
      // Total inventory = fulfillable + inbound + reserved (all units at or coming to FBA)
      const totalInv = r.total_fba
      // Days cover = total inventory / avg daily
      const fbaDoc = r.avg_daily_units > 0 ? Math.round(totalInv / r.avg_daily_units) : null
      // Units to send = units needed to reach 60d target minus total inventory already at FBA
      const unitsToSend = r.avg_daily_units > 0
        ? Math.max(0, Math.round(FBA_TARGET_DAYS * r.avg_daily_units) - totalInv)
        : 0
      return {
        sku:            r.sku,
        title:          r.title,
        asin:           r.asin,
        marketplace:    r.marketplace,
        total_inventory: totalInv,
        available:      r.available,
        fulfillable:    r.fulfillable,
        inbound:        r.inbound,
        reserved:       r.reserved,
        avg_daily_units: r.avg_daily_units,
        days_of_cover:  fbaDoc,
        units_to_send:  unitsToSend,
        urgency:        getFbaUrgency(fbaDoc),
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
      const av = a[fbaSortKey] ?? (fbaSortDir === 'asc' ? Infinity : -Infinity)
      const bv = b[fbaSortKey] ?? (fbaSortDir === 'asc' ? Infinity : -Infinity)
      if (typeof av === 'string') return fbaSortDir === 'asc' ? av.localeCompare(bv as string) : (bv as string).localeCompare(av)
      return fbaSortDir === 'asc' ? (av as number) - (bv as number) : (bv as number) - (av as number)
    })

  // ─── Supplier Replenishment rows ──────────────────────────
  // Deduplicate by SKU (combine US+CA FBA inventory)
  const skuMap: Record<string, { title: string, asin: string, total_fba: number, avg_daily: number }> = {}
  for (const r of inventory) {
    if (!skuMap[r.sku]) skuMap[r.sku] = { title: r.title, asin: r.asin, total_fba: 0, avg_daily: 0 }
    skuMap[r.sku].total_fba   += r.total_fba
    skuMap[r.sku].avg_daily   += r.avg_daily_units
  }

  const supplierRows: SupplierReplenRow[] = Object.entries(skuMap)
    .map(([sku, data]) => {
      const doc = data.avg_daily > 0 ? Math.round(data.total_fba / data.avg_daily) : null
      const unitsToOrder = data.avg_daily > 0
        ? Math.max(0, Math.round(SUPPLIER_ORDER_TARGET * data.avg_daily) - data.total_fba)
        : 0
      const urgency = getSupplierUrgency(doc)
      // Reorder by = today + (days_of_cover - lead_time), so you order before stockout
      const reorderBy = doc !== null && doc > SUPPLIER_LEAD_DAYS
        ? addDays(doc - SUPPLIER_LEAD_DAYS)
        : urgency === 'critical' ? 'Order Now' : null

      return {
        sku,
        title:              data.title,
        asin:               data.asin,
        total_fba:          data.total_fba,
        avg_daily_units:    Math.round(data.avg_daily * 10) / 10,
        days_of_cover_total: doc,
        units_to_order:     unitsToOrder,
        reorder_by:         reorderBy,
        urgency,
      }
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
      const av = a[supSortKey] ?? (supSortDir === 'asc' ? Infinity : -Infinity)
      const bv = b[supSortKey] ?? (supSortDir === 'asc' ? Infinity : -Infinity)
      if (typeof av === 'string') return supSortDir === 'asc' ? av.localeCompare(bv as string) : (bv as string).localeCompare(av)
      return supSortDir === 'asc' ? (av as number) - (bv as number) : (bv as number) - (av as number)
    })

  // ─── Summary totals ───────────────────────────────────────
  const totalFulfillable = inventory.reduce((s, r) => s + r.fulfillable, 0)
  const totalAvailable   = inventory.reduce((s, r) => s + r.available, 0)
  const totalReserved    = inventory.reduce((s, r) => s + r.reserved, 0)
  const totalInbound     = inventory.reduce((s, r) => s + r.inbound, 0)
  const outOfStock       = inventory.filter(r => r.status === 'out_of_stock').length
  const critical         = inventory.filter(r => r.status === 'critical').length
  const low              = inventory.filter(r => r.status === 'low').length

  const statusCounts = {
    all: inventory.length,
    out_of_stock: outOfStock,
    critical,
    low,
    healthy: inventory.filter(r => r.status === 'healthy').length,
  }

  const fbaUrgencyCounts = {
    all:      fbaRows.length,
    critical: fbaRows.filter(r => r.urgency === 'critical').length,
    reorder:  fbaRows.filter(r => r.urgency === 'reorder').length,
    healthy:  fbaRows.filter(r => r.urgency === 'healthy').length,
  }

  const supUrgencyCounts = {
    all:      supplierRows.length,
    critical: supplierRows.filter(r => r.urgency === 'critical').length,
    reorder:  supplierRows.filter(r => r.urgency === 'reorder').length,
    healthy:  supplierRows.filter(r => r.urgency === 'healthy').length,
  }

  // ─── Style helpers ────────────────────────────────────────
  const SortIcon = ({ col, cur, dir }: { col: string, cur: string, dir: SortDir }) => {
    if (cur !== col) return <ArrowUpDown size={10} style={{ opacity: 0.3 }} />
    return dir === 'asc' ? <ArrowUp size={10} /> : <ArrowDown size={10} />
  }

  const thBase: React.CSSProperties = {
    padding: '10px 12px', fontSize: '10px', fontWeight: 600,
    textTransform: 'uppercase', letterSpacing: '0.06em',
    background: 'var(--bg-hover)', borderBottom: '1px solid var(--border)',
    position: 'sticky', top: 0, zIndex: 10, whiteSpace: 'nowrap',
    color: 'var(--text-muted)',
  }
  const thSortable = (active: boolean): React.CSSProperties => ({
    ...thBase,
    color: active ? 'var(--accent)' : 'var(--text-muted)',
    cursor: 'pointer', userSelect: 'none',
  })

  const UrgencyFilter = ({
    counts, current, onChange
  }: { counts: Record<string, number>, current: string, onChange: (v: string) => void }) => (
    <div style={{ display: 'flex', gap: '4px' }}>
      {Object.entries(counts).map(([key, count]) => {
        const cfg = key === 'all' ? null : URGENCY_CONFIG[key as keyof typeof URGENCY_CONFIG]
        const isActive = current === key
        return (
          <button key={key} onClick={() => onChange(key)} style={{
            padding: '6px 12px', borderRadius: '7px', fontSize: '11px', fontWeight: 500,
            cursor: 'pointer', transition: 'all 0.12s ease', whiteSpace: 'nowrap',
            border: isActive
              ? `1px solid ${cfg?.color || 'var(--accent-border)'}`
              : '1px solid var(--border)',
            background: isActive ? (cfg?.bg || 'var(--accent-light)') : 'transparent',
            color: isActive ? (cfg?.color || 'var(--accent)') : 'var(--text-muted)',
          }}>
            {key === 'all' ? 'All' : URGENCY_CONFIG[key as keyof typeof URGENCY_CONFIG]?.label} ({count})
          </button>
        )
      })}
    </div>
  )

  // ─── Render ───────────────────────────────────────────────
  return (
    <div>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '20px' }}>
        <div>
          <h1 style={{ fontSize: '20px', fontWeight: 600, letterSpacing: '-0.4px', marginBottom: '4px' }}>Inventory</h1>
          <p style={{ fontSize: '13px', color: 'var(--text-muted)' }}>
            {inventory.length} SKUs
            {snapshotDate && (
              <> · <span style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: '12px' }}>
                Snapshot: {new Date(snapshotDate + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
              </span></>
            )}
          </p>
        </div>
        <MarketplaceFilter selected={markets} onChange={setMarkets} />
      </div>

      {/* Tabs */}
      <div style={{ display: 'flex', gap: '4px', marginBottom: '20px', borderBottom: '1px solid var(--border)', paddingBottom: '0' }}>
        {([
          { key: 'inventory', label: 'Inventory Snapshot', icon: <Package size={13} /> },
          { key: 'fba',       label: 'FBA Replenishment',  icon: <Send size={13} /> },
          { key: 'supplier',  label: 'Supplier Reorder',   icon: <ShoppingCart size={13} /> },
        ] as { key: TabType, label: string, icon: React.ReactNode }[]).map(t => (
          <button key={t.key} onClick={() => setTab(t.key)} style={{
            display: 'flex', alignItems: 'center', gap: '6px',
            padding: '8px 16px', fontSize: '13px', fontWeight: 500,
            cursor: 'pointer', border: 'none', background: 'transparent',
            borderBottom: tab === t.key ? '2px solid var(--accent)' : '2px solid transparent',
            color: tab === t.key ? 'var(--accent)' : 'var(--text-muted)',
            marginBottom: '-1px', transition: 'all 0.12s ease',
          }}>
            {t.icon} {t.label}
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
              {/* Summary Cards */}
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '12px', marginBottom: '20px' }}>
                {[
                  { label: 'Fulfillable', value: fmt(totalFulfillable), icon: <Package size={14} />, color: 'var(--accent)' },
                  { label: 'Available',   value: fmt(totalAvailable),   icon: <Box size={14} />,           color: 'var(--green)' },
                  { label: 'Reserved',    value: fmt(totalReserved),    icon: <AlertTriangle size={14} />, color: 'var(--yellow)' },
                  { label: 'Inbound',     value: fmt(totalInbound),     icon: <Truck size={14} />,         color: '#A78BFA' },
                ].map((card, i) => (
                  <div key={i} className="card" style={{ padding: '16px' }}>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '8px' }}>
                      <span style={{ fontSize: '10px', color: 'var(--text-muted)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em' }}>{card.label}</span>
                      <div style={{ color: card.color, opacity: 0.6 }}>{card.icon}</div>
                    </div>
                    <div style={{ fontSize: '22px', fontWeight: 600, fontFamily: 'JetBrains Mono, monospace', letterSpacing: '-0.4px' }}>{card.value}</div>
                  </div>
                ))}
              </div>

              {/* Search + Status filter */}
              <div style={{ display: 'flex', gap: '10px', marginBottom: '14px', alignItems: 'center' }}>
                <div style={{
                  display: 'flex', alignItems: 'center', gap: '10px', flex: 1,
                  background: 'var(--bg-card)', border: '1px solid var(--border)',
                  borderRadius: '10px', padding: '9px 14px', boxShadow: 'var(--shadow-sm)',
                }}>
                  <Search size={13} color="var(--text-muted)" />
                  <input type="text" placeholder="Filter by SKU, ASIN, or product name..." value={search}
                    onChange={e => setSearch(e.target.value)}
                    style={{ flex: 1, background: 'transparent', border: 'none', outline: 'none', color: 'var(--text-primary)', fontSize: '13px' }} />
                </div>
                <div style={{ display: 'flex', gap: '4px' }}>
                  {Object.entries(statusCounts).map(([status, count]) => (
                    <button key={status} onClick={() => setStatusFilter(status)} style={{
                      padding: '6px 12px', borderRadius: '7px', fontSize: '11px', fontWeight: 500,
                      cursor: 'pointer', transition: 'all 0.12s ease', whiteSpace: 'nowrap',
                      border: statusFilter === status ? `1px solid ${status === 'all' ? 'var(--accent-border)' : STATUS_CONFIG[status as keyof typeof STATUS_CONFIG]?.color || 'var(--accent-border)'}` : '1px solid var(--border)',
                      background: statusFilter === status ? (status === 'all' ? 'var(--accent-light)' : STATUS_CONFIG[status as keyof typeof STATUS_CONFIG]?.bg || 'var(--accent-light)') : 'transparent',
                      color: statusFilter === status ? (status === 'all' ? 'var(--accent)' : STATUS_CONFIG[status as keyof typeof STATUS_CONFIG]?.color || 'var(--accent)') : 'var(--text-muted)',
                    }}>
                      {status === 'all' ? 'All' : STATUS_CONFIG[status as keyof typeof STATUS_CONFIG]?.label} ({count})
                    </button>
                  ))}
                </div>
              </div>

              {/* Inventory Table */}
              <div className="card" style={{ overflow: 'hidden' }}>
                <div style={{ overflowX: 'auto', maxHeight: '70vh', overflowY: 'auto' }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                    <thead>
                      <tr>
                        <th style={{ ...thBase, textAlign: 'left', minWidth: '240px' }}>Product</th>
                        <th style={{ ...thBase, textAlign: 'center', width: '100px' }}>Status</th>
                        <th style={{ ...thSortable(sortKey === 'available'), textAlign: 'right' }} onClick={() => handleSort('available')}>
                          <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: '4px' }}>Available <SortIcon col="available" cur={sortKey} dir={sortDir} /></span>
                        </th>
                        <th style={{ ...thSortable(sortKey === 'fulfillable'), textAlign: 'right' }} onClick={() => handleSort('fulfillable')}>
                          <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: '4px' }}>Fulfillable <SortIcon col="fulfillable" cur={sortKey} dir={sortDir} /></span>
                        </th>
                        <th style={{ ...thSortable(sortKey === 'reserved'), textAlign: 'right' }} onClick={() => handleSort('reserved')}>
                          <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: '4px' }}>Reserved <SortIcon col="reserved" cur={sortKey} dir={sortDir} /></span>
                        </th>
                        <th style={{ ...thSortable(sortKey === 'inbound'), textAlign: 'right' }} onClick={() => handleSort('inbound')}>
                          <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: '4px' }}>Inbound <SortIcon col="inbound" cur={sortKey} dir={sortDir} /></span>
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
                          <tr key={`${row.sku}-${row.marketplace}`} style={{ borderBottom: '1px solid var(--border)', background: row.status === 'out_of_stock' ? 'rgba(220,38,38,0.02)' : 'transparent' }}
                            onMouseEnter={e => (e.currentTarget as HTMLTableRowElement).style.background = 'var(--bg-hover)'}
                            onMouseLeave={e => (e.currentTarget as HTMLTableRowElement).style.background = row.status === 'out_of_stock' ? 'rgba(220,38,38,0.02)' : 'transparent'}>
                            <td style={{ padding: '11px 12px' }}>
                              <div style={{ fontSize: '12px', fontWeight: 500, color: 'var(--text-primary)', marginBottom: '2px' }}>{truncate(row.title, 45)}</div>
                              <div style={{ fontSize: '10px', color: 'var(--text-dim)', fontFamily: 'JetBrains Mono, monospace' }}>{row.sku} · {row.marketplace}</div>
                            </td>
                            <td style={{ padding: '11px 12px', textAlign: 'center' }}>
                              <span style={{ fontSize: '10px', fontWeight: 600, padding: '2px 8px', borderRadius: '4px', background: sc.bg, color: sc.color, whiteSpace: 'nowrap' }}>{sc.label}</span>
                            </td>
                            <td style={{ padding: '11px 12px', textAlign: 'right', fontSize: '12px', fontFamily: 'JetBrains Mono, monospace', fontWeight: 600, color: row.available === 0 ? 'var(--red)' : 'var(--text-primary)' }}>{fmt(row.available)}</td>
                            <td style={{ padding: '11px 12px', textAlign: 'right', fontSize: '12px', fontFamily: 'JetBrains Mono, monospace', color: 'var(--text-muted)' }}>{fmt(row.fulfillable)}</td>
                            <td style={{ padding: '11px 12px', textAlign: 'right', fontSize: '12px', fontFamily: 'JetBrains Mono, monospace', color: 'var(--text-muted)' }}>{fmt(row.reserved)}</td>
                            <td style={{ padding: '11px 12px', textAlign: 'right', fontSize: '12px', fontFamily: 'JetBrains Mono, monospace', color: row.inbound > 0 ? '#A78BFA' : 'var(--text-dim)' }}>{row.inbound > 0 ? fmt(row.inbound) : '—'}</td>
                            <td style={{ padding: '11px 12px', textAlign: 'right', fontSize: '12px', fontFamily: 'JetBrains Mono, monospace', color: 'var(--text-muted)' }}>{row.avg_daily_units > 0 ? row.avg_daily_units.toFixed(1) : '—'}</td>
                            <td style={{ padding: '11px 12px', textAlign: 'right', fontSize: '12px', fontFamily: 'JetBrains Mono, monospace' }}>
                              {row.days_of_cover === null ? <span style={{ color: 'var(--text-dim)' }}>—</span> : (
                                <span style={{ fontWeight: 600, color: row.days_of_cover < CRITICAL_THRESHOLD ? 'var(--red)' : row.days_of_cover < LOW_STOCK_THRESHOLD ? 'var(--yellow)' : 'var(--green)' }}>
                                  {row.days_of_cover}d
                                </span>
                              )}
                            </td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                  {filtered.length === 0 && <div style={{ padding: '40px', textAlign: 'center', color: 'var(--text-dim)', fontSize: '13px' }}>No inventory rows found</div>}
                </div>
              </div>
            </>
          )}

          {/* ── FBA REPLENISHMENT TAB ── */}
          {tab === 'fba' && (
            <>
              {/* Summary Cards */}
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '12px', marginBottom: '20px' }}>
                {[
                  { label: 'SKUs Need Attention', value: fbaRows.filter(r => r.urgency !== 'healthy').length, color: 'var(--red)' },
                  { label: 'Total Units to Send', value: fmt(fbaRows.reduce((s, r) => s + r.units_to_send, 0)), color: 'var(--accent)' },
                  { label: 'Target Days Cover',   value: `${FBA_TARGET_DAYS} days`, color: 'var(--green)' },
                ].map((card, i) => (
                  <div key={i} className="card" style={{ padding: '16px' }}>
                    <div style={{ fontSize: '10px', color: 'var(--text-muted)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: '8px' }}>{card.label}</div>
                    <div style={{ fontSize: '22px', fontWeight: 600, fontFamily: 'JetBrains Mono, monospace', letterSpacing: '-0.4px', color: card.color }}>{card.value}</div>
                  </div>
                ))}
              </div>

              {/* Description */}
              <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginBottom: '14px', padding: '10px 14px', background: 'var(--bg-card)', borderRadius: '8px', border: '1px solid var(--border)' }}>
                Shows SKUs where total FBA inventory (available + reserved + inbound) is below <strong>{FBA_TARGET_DAYS} days</strong> of cover.
                Units to send = units needed to reach {FBA_TARGET_DAYS} days at current sales velocity.
              </div>

              {/* Search + Filter + Export */}
              <div style={{ display: 'flex', gap: '10px', marginBottom: '14px', alignItems: 'center' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flex: 1, background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: '10px', padding: '9px 14px' }}>
                  <Search size={13} color="var(--text-muted)" />
                  <input type="text" placeholder="Filter by SKU or product name..." value={search} onChange={e => setSearch(e.target.value)}
                    style={{ flex: 1, background: 'transparent', border: 'none', outline: 'none', color: 'var(--text-primary)', fontSize: '13px' }} />
                </div>
                <UrgencyFilter counts={fbaUrgencyCounts} current={fbaFilter} onChange={setFbaFilter} />
                <button onClick={() => exportCSV(
                  ['SKU', 'Title', 'Marketplace', 'Total Inventory', 'Inbound', 'Avg Daily Units', 'Days Cover', 'Units to Send', 'Urgency'],
                  fbaRows.map(r => [r.sku, r.title, r.marketplace, r.total_inventory, r.inbound, r.avg_daily_units, r.days_of_cover ?? '', r.units_to_send, r.urgency]),
                  'selleriq-fba-replenishment.csv'
                )} style={{ display: 'flex', alignItems: 'center', gap: '6px', padding: '6px 12px', borderRadius: '7px', border: '1px solid var(--border)', background: 'transparent', color: 'var(--text-muted)', fontSize: '12px', cursor: 'pointer' }}>
                  <Download size={12} /> Export
                </button>
              </div>

              {/* FBA Table */}
              <div className="card" style={{ overflow: 'hidden' }}>
                <div style={{ overflowX: 'auto', maxHeight: '70vh', overflowY: 'auto' }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                    <thead>
                      <tr>
                        <th style={{ ...thBase, textAlign: 'left', minWidth: '240px' }}>Product</th>
                        <th style={{ ...thBase, textAlign: 'center' }}>Urgency</th>
                        <th style={{ ...thBase, textAlign: 'right' }}>Available</th>
                        <th style={{ ...thBase, textAlign: 'right' }}>Fulfillable</th>
                        <th style={{ ...thBase, textAlign: 'right' }}>Reserved</th>
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
                      </tr>
                    </thead>
                    <tbody>
                      {fbaRows.map(row => {
                        const uc = URGENCY_CONFIG[row.urgency]
                        return (
                          <tr key={`${row.sku}-${row.marketplace}`} style={{ borderBottom: '1px solid var(--border)' }}
                            onMouseEnter={e => (e.currentTarget as HTMLTableRowElement).style.background = 'var(--bg-hover)'}
                            onMouseLeave={e => (e.currentTarget as HTMLTableRowElement).style.background = 'transparent'}>
                            <td style={{ padding: '11px 12px' }}>
                              <div style={{ fontSize: '12px', fontWeight: 500, color: 'var(--text-primary)', marginBottom: '2px' }}>{truncate(row.title, 45)}</div>
                              <div style={{ fontSize: '10px', color: 'var(--text-dim)', fontFamily: 'JetBrains Mono, monospace' }}>{row.sku} · {row.marketplace}</div>
                            </td>
                            <td style={{ padding: '11px 12px', textAlign: 'center' }}>
                              <span style={{ fontSize: '10px', fontWeight: 600, padding: '2px 8px', borderRadius: '4px', background: uc.bg, color: uc.color }}>{uc.label}</span>
                            </td>
                            <td style={{ padding: '11px 12px', textAlign: 'right', fontSize: '12px', fontFamily: 'JetBrains Mono, monospace', fontWeight: 600, color: row.available === 0 ? 'var(--red)' : 'var(--text-primary)' }}>{fmt(row.available)}</td>
                            <td style={{ padding: '11px 12px', textAlign: 'right', fontSize: '12px', fontFamily: 'JetBrains Mono, monospace', color: 'var(--text-muted)' }}>{fmt(row.fulfillable)}</td>
                            <td style={{ padding: '11px 12px', textAlign: 'right', fontSize: '12px', fontFamily: 'JetBrains Mono, monospace', color: 'var(--text-muted)' }}>{fmt(row.reserved)}</td>
                            <td style={{ padding: '11px 12px', textAlign: 'right', fontSize: '12px', fontFamily: 'JetBrains Mono, monospace', color: row.inbound > 0 ? '#A78BFA' : 'var(--text-dim)' }}>{row.inbound > 0 ? fmt(row.inbound) : '—'}</td>
                            <td style={{ padding: '11px 12px', textAlign: 'right', fontSize: '12px', fontFamily: 'JetBrains Mono, monospace', color: 'var(--text-muted)' }}>{row.avg_daily_units > 0 ? row.avg_daily_units.toFixed(1) : '—'}</td>
                            <td style={{ padding: '11px 12px', textAlign: 'right', fontSize: '12px', fontFamily: 'JetBrains Mono, monospace' }}>
                              {row.days_of_cover === null ? <span style={{ color: 'var(--text-dim)' }}>—</span> : (
                                <span style={{ fontWeight: 600, color: row.urgency === 'critical' ? 'var(--red)' : row.urgency === 'reorder' ? '#F97316' : 'var(--green)' }}>{row.days_of_cover}d</span>
                              )}
                            </td>
                            <td style={{ padding: '11px 12px', textAlign: 'right', fontSize: '13px', fontFamily: 'JetBrains Mono, monospace', fontWeight: 700, color: row.units_to_send > 0 ? 'var(--accent)' : 'var(--text-dim)' }}>
                              {row.units_to_send > 0 ? fmt(row.units_to_send) : '—'}
                            </td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                  {fbaRows.length === 0 && <div style={{ padding: '40px', textAlign: 'center', color: 'var(--text-dim)', fontSize: '13px' }}>All SKUs are above the {FBA_TARGET_DAYS}-day cover target 🎉</div>}
                </div>
              </div>
            </>
          )}

          {/* ── SUPPLIER REORDER TAB ── */}
          {tab === 'supplier' && (
            <>
              {/* Summary Cards */}
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '12px', marginBottom: '20px' }}>
                {[
                  { label: 'SKUs Need Reorder',   value: supplierRows.filter(r => r.urgency !== 'healthy').length, color: 'var(--red)' },
                  { label: 'Total Units to Order', value: fmt(supplierRows.reduce((s, r) => s + r.units_to_order, 0)), color: 'var(--accent)' },
                  { label: 'Total Lead Time',      value: `${SUPPLIER_LEAD_DAYS} days`, color: 'var(--text-muted)' },
                ].map((card, i) => (
                  <div key={i} className="card" style={{ padding: '16px' }}>
                    <div style={{ fontSize: '10px', color: 'var(--text-muted)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: '8px' }}>{card.label}</div>
                    <div style={{ fontSize: '22px', fontWeight: 600, fontFamily: 'JetBrains Mono, monospace', letterSpacing: '-0.4px', color: card.color }}>{card.value}</div>
                  </div>
                ))}
              </div>

              {/* Description */}
              <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginBottom: '14px', padding: '10px 14px', background: 'var(--bg-card)', borderRadius: '8px', border: '1px solid var(--border)' }}>
                Based on <strong>42 days production + 28 days shipping = {SUPPLIER_LEAD_DAYS} days total lead time</strong>.
                Units to order = units needed to cover lead time + {FBA_TARGET_DAYS}-day FBA buffer ({SUPPLIER_ORDER_TARGET} days total).
                FBA inventory combines US + CA.
              </div>

              {/* Search + Filter + Export */}
              <div style={{ display: 'flex', gap: '10px', marginBottom: '14px', alignItems: 'center' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flex: 1, background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: '10px', padding: '9px 14px' }}>
                  <Search size={13} color="var(--text-muted)" />
                  <input type="text" placeholder="Filter by SKU or product name..." value={search} onChange={e => setSearch(e.target.value)}
                    style={{ flex: 1, background: 'transparent', border: 'none', outline: 'none', color: 'var(--text-primary)', fontSize: '13px' }} />
                </div>
                <UrgencyFilter counts={supUrgencyCounts} current={supFilter} onChange={setSupFilter} />
                <button onClick={() => exportCSV(
                  ['SKU', 'Title', 'Total FBA (US+CA)', 'Avg Daily Units', 'Days Cover', 'Units to Order', 'Reorder By', 'Urgency'],
                  supplierRows.map(r => [r.sku, r.title, r.total_fba, r.avg_daily_units, r.days_of_cover_total ?? '', r.units_to_order, r.reorder_by ?? '', r.urgency]),
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
                          <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: '4px' }}>Total FBA <SortIcon col="total_fba" cur={supSortKey} dir={supSortDir} /></span>
                        </th>
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
                      </tr>
                    </thead>
                    <tbody>
                      {supplierRows.map(row => {
                        const uc = URGENCY_CONFIG[row.urgency]
                        return (
                          <tr key={row.sku} style={{ borderBottom: '1px solid var(--border)' }}
                            onMouseEnter={e => (e.currentTarget as HTMLTableRowElement).style.background = 'var(--bg-hover)'}
                            onMouseLeave={e => (e.currentTarget as HTMLTableRowElement).style.background = 'transparent'}>
                            <td style={{ padding: '11px 12px' }}>
                              <div style={{ fontSize: '12px', fontWeight: 500, color: 'var(--text-primary)', marginBottom: '2px' }}>{truncate(row.title, 45)}</div>
                              <div style={{ fontSize: '10px', color: 'var(--text-dim)', fontFamily: 'JetBrains Mono, monospace' }}>{row.sku}</div>
                            </td>
                            <td style={{ padding: '11px 12px', textAlign: 'center' }}>
                              <span style={{ fontSize: '10px', fontWeight: 600, padding: '2px 8px', borderRadius: '4px', background: uc.bg, color: uc.color }}>{uc.label}</span>
                            </td>
                            <td style={{ padding: '11px 12px', textAlign: 'right', fontSize: '12px', fontFamily: 'JetBrains Mono, monospace' }}>{fmt(row.total_fba)}</td>
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
                          </tr>
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
