'use client'

import { ChevronDown, ChevronRight, Coins, Download, LoaderCircle, Upload } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import styles from './LdpCostManager.module.css'

type Cost = {
  id: number; marketplace: string; sku: string; asin: string | null; title: string
  effective_from: string; effective_to: string | null; ldp_per_unit: number | string
  currency_code: string; source_system: string; source_reference: string | null; created_at: string
}
type Preview = { workbookRows: number; acceptedCount: number; rejectedCount: number }
type Missing = { marketplace: string; sku: string; title: string }

export default function LdpCostManager() {
  const [open, setOpen] = useState(false)
  const [costs, setCosts] = useState<Cost[]>([])
  const [missing, setMissing] = useState<Missing[]>([])
  const [file, setFile] = useState<File | null>(null)
  const [effectiveFrom, setEffectiveFrom] = useState('2026-01-01')
  const [preview, setPreview] = useState<Preview | null>(null)
  const [query, setQuery] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const [view, setView] = useState<'all' | 'missing'>('all')
  const [editing, setEditing] = useState<{ sku: string; marketplace: string; ldp: string; effectiveFrom: string } | null>(null)

  async function load() {
    setError('')
    const response = await fetch('/api/ldp', { cache: 'no-store' })
    const body = await response.json()
    if (!response.ok) throw new Error(body.error || 'Could not load LDP records.')
    setCosts(body.costs || [])
    setMissing(body.missing || [])
  }

  useEffect(() => { load().catch(cause => setError(cause instanceof Error ? cause.message : 'Could not load LDP records.')) }, [])

  async function submit(action: 'preview' | 'import') {
    if (!file) { setError('Choose an .xlsx workbook first.'); return }
    setBusy(true); setError(''); setMessage('')
    try {
      const form = new FormData()
      form.set('file', file); form.set('action', action); form.set('effectiveFrom', effectiveFrom)
      const response = await fetch('/api/ldp', { method: 'POST', body: form })
      const body = await response.json()
      if (!response.ok) throw new Error(body.error || 'The request failed.')
      if (action === 'preview') {
        setPreview(body)
        setMessage('Preview complete. Nothing has been written yet.')
      } else {
        setCosts(body.costs || [])
        setMissing(body.missing || [])
        setPreview(null)
        setMessage(`Imported ${body.imported} validated LDP records. ${body.rejectedCount} rows remained rejected.`)
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The request failed.')
    } finally { setBusy(false) }
  }

  async function saveManual() {
    if (!editing) return
    setBusy(true); setError(''); setMessage('')
    try {
      const response = await fetch('/api/ldp', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(editing) })
      const body = await response.json()
      if (!response.ok) throw new Error(body.error || 'Could not save LDP.')
      setCosts(body.costs || []); setMissing(body.missing || []); setEditing(null)
      setMessage('LDP saved. The effective-dated cost history has been preserved.')
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not save LDP.') }
    finally { setBusy(false) }
  }

  const latest = useMemo(() => {
    const seen = new Set<string>()
    return costs.filter(item => { const key = `${item.marketplace}:${item.sku}`; if (seen.has(key)) return false; seen.add(key); return true })
  }, [costs])
  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase()
    const source = view === 'all' ? latest : missing
    return source.filter(item => !needle || `${item.sku} ${'asin' in item ? item.asin || '' : ''} ${item.title} ${item.marketplace}`.toLowerCase().includes(needle))
  }, [latest, missing, query, view])
  const us = latest.filter(item => item.marketplace === 'US').length
  const ca = latest.filter(item => item.marketplace === 'CA').length

  return <section className={`card ${styles.shell}`}>
    <button className={styles.summary} type="button" onClick={() => setOpen(value => !value)}>
      <span className={styles.summaryLeft}>
        <span className={styles.icon}><Coins size={17} /></span>
        <span><span className={styles.title}>Costs &amp; LDP</span><span className={styles.subtitle}>{latest.length ? `${latest.length} SKU-market costs available · all displayed in USD` : 'Upload and manage effective-dated landed product costs'}</span></span>
      </span>
      <span className={styles.metrics}>
        <span className={styles.metric}><span className={styles.metricValue}>{us}</span><span className={styles.metricLabel}>US costs</span></span>
        <span className={styles.metric}><span className={styles.metricValue}>{ca}</span><span className={styles.metricLabel}>CA costs</span></span>
        {open ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
      </span>
    </button>
    {open && <div className={styles.panel}>
      <div className={styles.instructions}><span><strong style={{ color: 'var(--text-primary)' }}>Not sure what to upload?</strong> Download your SellerIQ catalog, fill in the <strong>Cost</strong> column in USD, then upload the completed file below. Existing costs are included and may be updated.</span><a className={styles.download} href="/api/ldp?template=1"><Download size={13} style={{ verticalAlign: -2, marginRight: 5 }} />Download cost template</a></div>
      <div className={styles.upload}>
        <div className={styles.field}><label>Completed cost file</label><input type="file" accept=".xlsx,.csv" onChange={event => { setFile(event.target.files?.[0] || null); setPreview(null); setMessage('') }} /></div>
        <div className={styles.field}><label>Effective from</label><input type="date" value={effectiveFrom} onChange={event => setEffectiveFrom(event.target.value)} /></div>
        <div className={styles.buttons}>
          <button className={styles.button} type="button" disabled={busy || !file} onClick={() => submit('preview')}>{busy ? <LoaderCircle size={13} /> : 'Preview'}</button>
          <button className={`${styles.button} ${styles.primary}`} type="button" disabled={busy || !preview?.acceptedCount} onClick={() => submit('import')}><Upload size={13} /> Import validated</button>
        </div>
      </div>
      {preview && <div className={styles.preview}>
        <div className={styles.previewCard}><div className={styles.previewValue}>{preview.workbookRows}</div><div className={styles.previewLabel}>Workbook rows reviewed</div></div>
        <div className={styles.previewCard}><div className={styles.previewValue} style={{ color: 'var(--green)' }}>{preview.acceptedCount}</div><div className={styles.previewLabel}>Exact matches ready</div></div>
        <div className={styles.previewCard}><div className={styles.previewValue} style={{ color: 'var(--amber)' }}>{preview.rejectedCount}</div><div className={styles.previewLabel}>Rejected and left untouched</div></div>
      </div>}
      {(message || error) && <div className={`${styles.message} ${error ? styles.error : ''}`}>{error || message}</div>}
      <div className={styles.toolbar}><div><div className={styles.title}>Current LDP records</div><div className={styles.subtitle}>Latest effective record per SKU and marketplace</div></div><div className={styles.tabs}><button className={`${styles.tab} ${view === 'all' ? styles.activeTab : ''}`} onClick={() => setView('all')}>All costs ({latest.length})</button><button className={`${styles.tab} ${view === 'missing' ? styles.activeTab : ''}`} onClick={() => setView('missing')}>Missing costs ({missing.length})</button></div><input className={styles.search} value={query} onChange={event => setQuery(event.target.value)} placeholder="Search SKU, ASIN, product, or market" /></div>
      <div className={styles.tableWrap}>{filtered.length ? <table className={styles.table}><thead><tr><th>Product</th><th>Market</th><th>LDP / unit</th><th>Effective</th><th>Source</th><th /></tr></thead><tbody>{filtered.map(item => {
        const key = `${item.marketplace}:${item.sku}`
        const isEditing = editing?.sku === item.sku && editing.marketplace === item.marketplace
        const cost = 'ldp_per_unit' in item ? item as Cost : null
        return <tr key={key}><td><strong>{item.title}</strong><div className={styles.subtitle}><span className={styles.mono}>{item.sku}</span>{cost?.asin ? ` · ${cost.asin}` : ''}</div></td><td>{item.marketplace}</td><td>{isEditing ? <input className={styles.editInput} value={editing.ldp} onChange={event => setEditing({ ...editing, ldp: event.target.value })} placeholder="0.00" /> : cost ? <span className={styles.mono}>${Number(cost.ldp_per_unit).toFixed(2)} USD</span> : <span style={{ color: 'var(--amber)' }}>Missing</span>}</td><td>{isEditing ? <input className={styles.editInput} type="date" value={editing.effectiveFrom} onChange={event => setEditing({ ...editing, effectiveFrom: event.target.value })} /> : <span className={styles.mono}>{cost?.effective_from || '—'}</span>}</td><td>{cost ? <>{cost.source_reference || cost.source_system}<div className={styles.subtitle}>{cost.source_system}</div></> : 'No effective-dated cost'}</td><td><div className={styles.rowActions}>{isEditing ? <><button className={styles.button} disabled={busy} onClick={saveManual}>Save</button><button className={styles.tab} onClick={() => setEditing(null)}>Cancel</button></> : <button className={styles.tab} onClick={() => setEditing({ sku: item.sku, marketplace: item.marketplace, ldp: cost ? String(cost.ldp_per_unit) : '', effectiveFrom: cost?.effective_from || effectiveFrom })}>{cost ? 'Update' : 'Add cost'}</button>}</div></td></tr>
      })}</tbody></table> : <div className={styles.empty}>{view === 'missing' ? 'Every catalog SKU-market record has an LDP.' : 'No LDP records match this search.'}</div>}</div>
    </div>}
  </section>
}
