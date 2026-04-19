'use client'

import React, { useEffect, useState } from 'react'
import { supabase } from '@/lib/supabase'
import MarketplaceFilter from '@/components/MarketplaceFilter'
import {
  AlertTriangle, Package, TrendingDown, ArrowDown,
  ArrowUp, ArrowUpDown, Search, Truck, Box
} from 'lucide-react'

const CAD_TO_USD = 0.74
const LOW_STOCK_THRESHOLD = 30 // days of cover below this = low stock
const CRITICAL_THRESHOLD = 14  // days of cover below this = critical

type InventoryRow = {
  sku: string
  title: string
  asin: string
  marketplace: string
  fulfillable: number
  available: number
  reserved: number
  inbound: number
  unsellable: number
  avg_daily_units: number
  days_of_cover: number | null
  status: 'out_of_stock' | 'critical' | 'low' | 'healthy'
  snapshot_date: string
}

type SortKey = 'sku' | 'fulfillable' | 'available' | 'reserved' | 'inbound' | 'days_of_cover' | 'avg_daily_units'
type SortDir = 'asc' | 'desc'

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

const STATUS_CONFIG = {
  out_of_stock: { label: 'Out of Stock', color: 'var(--red)', bg: 'var(--red-light)' },
  critical:     { label: 'Critical',     color: '#F97316', bg: 'rgba(249,115,22,0.1)' },
  low:          { label: 'Low Stock',    color: 'var(--yellow)', bg: 'rgba(217,119,6,0.1)' },
  healthy:      { label: 'Healthy',      color: 'var(--green)', bg: 'var(--green-light)' },
}

export default function Inventory() {
  const [markets, setMarkets] = useState(['US', 'CA'])
  const [inventory, setInventory] = useState<InventoryRow[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [sortKey, setSortKey] = useState<SortKey>('available')
  const [sortDir, setSortDir] = useState<SortDir>('asc')
  const [statusFilter, setStatusFilter] = useState<string>('all')
  const [snapshotDate, setSnapshotDate] = useState<string>('')

  useEffect(() => {
    async function load() {
      setLoading(true)

      // Get latest snapshot date per marketplace
      const { data: snapDates } = await supabase
        .from('fct_inventory_snapshot_daily')
        .select('snapshot_date, marketplace')
        .in('marketplace', markets)
        .order('snapshot_date', { ascending: false })
        .limit(10)

      if (!snapDates?.length) { setLoading(false); return }

      // Use the most recent snapshot date
      const latestDate = snapDates[0].snapshot_date
      setSnapshotDate(latestDate)

      // Fetch inventory snapshot
      const { data: invData, error: invError } = await supabase
        .from('fct_inventory_snapshot_daily')
        .select('sku, asin, fnsku, marketplace, snapshot_date, fulfillable_quantity, available_quantity, reserved_quantity, total_inbound_quantity, unsellable_quantity')
        .in('marketplace', markets)
        .eq('snapshot_date', latestDate)
        .limit(5000)

      if (invError) { console.error(invError); setLoading(false); return }

      // Fetch average daily units from fct_sales_daily (last 30 days)
      const thirtyDaysAgo = new Date()
      thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 37)
      const cutoff = thirtyDaysAgo.toISOString().split('T')[0]

      const { data: salesData } = await supabase
        .from('fct_sales_daily')
        .select('sku, marketplace, units_ordered, start_date')
        .in('marketplace', markets)
        .gte('start_date', cutoff)
        .limit(20000)

      // Calculate avg daily units per SKU
      const salesBySku: Record<string, { total: number, weeks: Set<string> }> = {}
      for (const row of salesData || []) {
        if (!row.sku) continue
        const key = `${row.sku}__${row.marketplace}`
        if (!salesBySku[key]) salesBySku[key] = { total: 0, weeks: new Set() }
        salesBySku[key].total += row.units_ordered || 0
        salesBySku[key].weeks.add(row.start_date)
      }

      // Fetch dim_product for titles
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
        const weekCount = salesInfo?.weeks.size || 0
        const avgDailyUnits = totalUnits > 0 ? (totalUnits / 30) : 0
        const available = row.available_quantity || 0
        const doc = avgDailyUnits > 0 ? Math.round((row.fulfillable_quantity || 0) / avgDailyUnits) : null

        return {
          sku: row.sku || '',
          title: titleBySku[row.sku] || row.sku || '',
          asin: row.asin || '',
          marketplace: row.marketplace,
          fulfillable: row.fulfillable_quantity || 0,
          available,
          reserved: row.reserved_quantity || 0,
          inbound: row.total_inbound_quantity || 0,
          unsellable: row.unsellable_quantity || 0,
          avg_daily_units: Math.round(avgDailyUnits * 10) / 10,
          days_of_cover: doc,
          status: getStatus(available, doc),
          snapshot_date: row.snapshot_date,
        }
      })

      setInventory(rows)
      setLoading(false)
    }
    load()
  }, [markets])

  const handleSort = (key: SortKey) => {
    if (sortKey === key) setSortDir(d => d === 'asc' ? 'desc' : 'asc')
    else { setSortKey(key); setSortDir('asc') }
  }

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

  // Summary totals
  const totalFulfillable = inventory.reduce((s, r) => s + r.fulfillable, 0)
  const totalAvailable   = inventory.reduce((s, r) => s + r.available, 0)
  const totalReserved    = inventory.reduce((s, r) => s + r.reserved, 0)
  const totalInbound     = inventory.reduce((s, r) => s + r.inbound, 0)
  const outOfStock       = inventory.filter(r => r.status === 'out_of_stock').length
  const critical         = inventory.filter(r => r.status === 'critical').length
  const low              = inventory.filter(r => r.status === 'low').length

  const SortIcon = ({ col }: { col: SortKey }) => {
    if (sortKey !== col) return <ArrowUpDown size={10} style={{ opacity: 0.3 }} />
    return sortDir === 'asc' ? <ArrowUp size={10} /> : <ArrowDown size={10} />
  }

  const thBase: React.CSSProperties = {
    padding: '10px 12px', fontSize: '10px', fontWeight: 600,
    textTransform: 'uppercase', letterSpacing: '0.06em',
    background: 'var(--bg-hover)', borderBottom: '1px solid var(--border)',
    position: 'sticky', top: 0, zIndex: 10, whiteSpace: 'nowrap',
  }
  const thSortable = (col: SortKey): React.CSSProperties => ({
    ...thBase,
    color: sortKey === col ? 'var(--accent)' : 'var(--text-muted)',
    cursor: 'pointer', userSelect: 'none',
  })

  const statusCounts = {
    all: inventory.length,
    out_of_stock: outOfStock,
    critical,
    low,
    healthy: inventory.filter(r => r.status === 'healthy').length,
  }

  return (
    <div>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '20px' }}>
        <div>
          <h1 style={{ fontSize: '20px', fontWeight: 600, letterSpacing: '-0.4px', marginBottom: '4px' }}>Inventory</h1>
          <p style={{ fontSize: '13px', color: 'var(--text-muted)' }}>
            {inventory.length} SKUs
            {snapshotDate && (
              <>
                {' · '}
                <span style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: '12px' }}>
                  Snapshot: {new Date(snapshotDate + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
                </span>
              </>
            )}
          </p>
        </div>
        <MarketplaceFilter selected={markets} onChange={setMarkets} />
      </div>

      {loading ? (
        <div style={{ color: 'var(--text-muted)', fontSize: '13px' }}>Loading...</div>
      ) : (
        <>
          {/* Summary Cards */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '12px', marginBottom: '20px' }}>
            {[
              { label: 'Fulfillable', value: fmt(totalFulfillable), icon: <Package size={14} />, color: 'var(--accent)' },
              { label: 'Available', value: fmt(totalAvailable), icon: <Box size={14} />, color: 'var(--green)' },
              { label: 'Reserved', value: fmt(totalReserved), icon: <AlertTriangle size={14} />, color: 'var(--yellow)' },
              { label: 'Inbound', value: fmt(totalInbound), icon: <Truck size={14} />, color: '#A78BFA' },
            ].map((card, i) => (
              <div key={i} className="card" style={{ padding: '16px' }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '8px' }}>
                  <span style={{ fontSize: '10px', color: 'var(--text-muted)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                    {card.label}
                  </span>
                  <div style={{ color: card.color, opacity: 0.6 }}>{card.icon}</div>
                </div>
                <div style={{ fontSize: '22px', fontWeight: 600, fontFamily: 'JetBrains Mono, monospace', letterSpacing: '-0.4px' }}>
                  {card.value}
                </div>
              </div>
            ))}
          </div>

          {/* Alert bar */}
          {(outOfStock > 0 || critical > 0) && (
            <div style={{
              display: 'flex', gap: '10px', marginBottom: '16px', flexWrap: 'wrap',
            }}>
              {outOfStock > 0 && (
                <div style={{
                  display: 'flex', alignItems: 'center', gap: '8px',
                  background: 'var(--red-light)', border: '1px solid rgba(220,38,38,0.2)',
                  borderRadius: '8px', padding: '10px 16px', cursor: 'pointer',
                }}
                onClick={() => setStatusFilter(statusFilter === 'out_of_stock' ? 'all' : 'out_of_stock')}
                >
                  <AlertTriangle size={13} color="var(--red)" />
                  <span style={{ fontSize: '12px', fontWeight: 600, color: 'var(--red)' }}>
                    {outOfStock} SKU{outOfStock !== 1 ? 's' : ''} out of stock
                  </span>
                </div>
              )}
              {critical > 0 && (
                <div style={{
                  display: 'flex', alignItems: 'center', gap: '8px',
                  background: 'rgba(249,115,22,0.08)', border: '1px solid rgba(249,115,22,0.2)',
                  borderRadius: '8px', padding: '10px 16px', cursor: 'pointer',
                }}
                onClick={() => setStatusFilter(statusFilter === 'critical' ? 'all' : 'critical')}
                >
                  <TrendingDown size={13} color="#F97316" />
                  <span style={{ fontSize: '12px', fontWeight: 600, color: '#F97316' }}>
                    {critical} SKU{critical !== 1 ? 's' : ''} critical (&lt;{CRITICAL_THRESHOLD} days)
                  </span>
                </div>
              )}
              {low > 0 && (
                <div style={{
                  display: 'flex', alignItems: 'center', gap: '8px',
                  background: 'rgba(217,119,6,0.08)', border: '1px solid rgba(217,119,6,0.2)',
                  borderRadius: '8px', padding: '10px 16px', cursor: 'pointer',
                }}
                onClick={() => setStatusFilter(statusFilter === 'low' ? 'all' : 'low')}
                >
                  <AlertTriangle size={13} color="var(--yellow)" />
                  <span style={{ fontSize: '12px', fontWeight: 600, color: 'var(--yellow)' }}>
                    {low} SKU{low !== 1 ? 's' : ''} low stock (&lt;{LOW_STOCK_THRESHOLD} days)
                  </span>
                </div>
              )}
            </div>
          )}

          {/* Search + Status filter */}
          <div style={{ display: 'flex', gap: '10px', marginBottom: '14px', alignItems: 'center' }}>
            <div style={{
              display: 'flex', alignItems: 'center', gap: '10px', flex: 1,
              background: 'var(--bg-card)', border: '1px solid var(--border)',
              borderRadius: '10px', padding: '9px 14px', boxShadow: 'var(--shadow-sm)',
            }}>
              <Search size={13} color="var(--text-muted)" />
              <input
                type="text"
                placeholder="Filter by SKU, ASIN, or product name..."
                value={search}
                onChange={e => setSearch(e.target.value)}
                style={{
                  flex: 1, background: 'transparent', border: 'none', outline: 'none',
                  color: 'var(--text-primary)', fontSize: '13px', fontFamily: 'Inter, sans-serif',
                }}
              />
            </div>
            {/* Status filter tabs */}
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

          {/* Table */}
          <div className="card" style={{ overflow: 'hidden' }}>
            <div style={{ overflowX: 'auto', maxHeight: '70vh', overflowY: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead>
                  <tr>
                    <th style={{ ...thBase, textAlign: 'left', color: 'var(--text-muted)', minWidth: '240px' }}>Product</th>
                    <th style={{ ...thBase, textAlign: 'center', color: 'var(--text-muted)', width: '100px' }}>Status</th>
                    <th style={{ ...thSortable('fulfillable'), textAlign: 'right' }} onClick={() => handleSort('fulfillable')}>
                      <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: '4px' }}>Fulfillable <SortIcon col="fulfillable" /></span>
                    </th>
                    <th style={{ ...thSortable('available'), textAlign: 'right' }} onClick={() => handleSort('available')}>
                      <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: '4px' }}>Available <SortIcon col="available" /></span>
                    </th>
                    <th style={{ ...thSortable('reserved'), textAlign: 'right' }} onClick={() => handleSort('reserved')}>
                      <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: '4px' }}>Reserved <SortIcon col="reserved" /></span>
                    </th>
                    <th style={{ ...thSortable('inbound'), textAlign: 'right' }} onClick={() => handleSort('inbound')}>
                      <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: '4px' }}>Inbound <SortIcon col="inbound" /></span>
                    </th>
                    <th style={{ ...thSortable('avg_daily_units'), textAlign: 'right' }} onClick={() => handleSort('avg_daily_units')}>
                      <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: '4px' }}>Avg/Day <SortIcon col="avg_daily_units" /></span>
                    </th>
                    <th style={{ ...thSortable('days_of_cover'), textAlign: 'right' }} onClick={() => handleSort('days_of_cover')}>
                      <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: '4px' }}>Days Cover <SortIcon col="days_of_cover" /></span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((row, i) => {
                    const sc = STATUS_CONFIG[row.status]
                    return (
                      <tr key={`${row.sku}-${row.marketplace}`} style={{
                        borderBottom: '1px solid var(--border)',
                        background: row.status === 'out_of_stock' ? 'rgba(220,38,38,0.02)' : 'transparent',
                      }}
                      onMouseEnter={e => (e.currentTarget as HTMLTableRowElement).style.background = 'var(--bg-hover)'}
                      onMouseLeave={e => (e.currentTarget as HTMLTableRowElement).style.background = row.status === 'out_of_stock' ? 'rgba(220,38,38,0.02)' : 'transparent'}
                      >
                        <td style={{ padding: '11px 12px' }}>
                          <div style={{ fontSize: '12px', fontWeight: 500, color: 'var(--text-primary)', marginBottom: '2px' }}>
                            {truncate(row.title, 45)}
                          </div>
                          <div style={{ fontSize: '10px', color: 'var(--text-dim)', fontFamily: 'JetBrains Mono, monospace' }}>
                            {row.sku} · {row.marketplace}
                          </div>
                        </td>
                        <td style={{ padding: '11px 12px', textAlign: 'center' }}>
                          <span style={{
                            fontSize: '10px', fontWeight: 600, padding: '2px 8px',
                            borderRadius: '4px', background: sc.bg, color: sc.color,
                            whiteSpace: 'nowrap',
                          }}>
                            {sc.label}
                          </span>
                        </td>
                        <td style={{ padding: '11px 12px', textAlign: 'right', fontSize: '12px', fontFamily: 'JetBrains Mono, monospace', color: 'var(--text-primary)' }}>
                          {fmt(row.fulfillable)}
                        </td>
                        <td style={{ padding: '11px 12px', textAlign: 'right', fontSize: '12px', fontFamily: 'JetBrains Mono, monospace', fontWeight: 600, color: row.available === 0 ? 'var(--red)' : 'var(--text-primary)' }}>
                          {fmt(row.available)}
                        </td>
                        <td style={{ padding: '11px 12px', textAlign: 'right', fontSize: '12px', fontFamily: 'JetBrains Mono, monospace', color: 'var(--text-muted)' }}>
                          {fmt(row.reserved)}
                        </td>
                        <td style={{ padding: '11px 12px', textAlign: 'right', fontSize: '12px', fontFamily: 'JetBrains Mono, monospace', color: row.inbound > 0 ? '#A78BFA' : 'var(--text-dim)' }}>
                          {row.inbound > 0 ? fmt(row.inbound) : '—'}
                        </td>
                        <td style={{ padding: '11px 12px', textAlign: 'right', fontSize: '12px', fontFamily: 'JetBrains Mono, monospace', color: 'var(--text-muted)' }}>
                          {row.avg_daily_units > 0 ? row.avg_daily_units.toFixed(1) : '—'}
                        </td>
                        <td style={{ padding: '11px 12px', textAlign: 'right', fontSize: '12px', fontFamily: 'JetBrains Mono, monospace' }}>
                          {row.days_of_cover === null ? (
                            <span style={{ color: 'var(--text-dim)' }}>—</span>
                          ) : (
                            <span style={{
                              fontWeight: 600,
                              color: row.days_of_cover < CRITICAL_THRESHOLD ? 'var(--red)'
                                : row.days_of_cover < LOW_STOCK_THRESHOLD ? 'var(--yellow)'
                                : 'var(--green)',
                            }}>
                              {row.days_of_cover}d
                            </span>
                          )}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
              {filtered.length === 0 && (
                <div style={{ padding: '40px', textAlign: 'center', color: 'var(--text-dim)', fontSize: '13px' }}>
                  No inventory rows found
                </div>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  )
}
