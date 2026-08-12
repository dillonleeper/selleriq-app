'use client'

import { ChevronDown, ChevronRight, Coins, LoaderCircle, Upload } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import styles from './LdpCostManager.module.css'

type Cost = {
  id: number; marketplace: string; sku: string; asin: string | null; title: string
  effective_from: string; effective_to: string | null; ldp_per_unit: number | string
  currency_code: string; source_system: string; source_reference: string | null; created_at: string
}
type Preview = { workbookRows: number; acceptedCount: number; rejectedCount: number }

export default function LdpCostManager() {
  const [open, setOpen] = useState(false)
  const [costs, setCosts] = useState<Cost[]>([])
  const [file, setFile] = useState<File | null>(null)
  const [effectiveFrom, setEffectiveFrom] = useState('2026-01-01')
  const [preview, setPreview] = useState<Preview | null>(null)
  const [query, setQuery] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')

  async function load() {
    setError('')
    const response = await fetch('/api/ldp', { cache: 'no-store' })
    const body = await response.json()
    if (!response.ok) throw new Error(body.error || 'Could not load LDP records.')
    setCosts(body.costs || [])
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
        setPreview(null)
        setMessage(`Imported ${body.imported} validated LDP records. ${body.rejectedCount} rows remained rejected.`)
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The request failed.')
    } finally { setBusy(false) }
  }

  const latest = useMemo(() => {
    const seen = new Set<string>()
    return costs.filter(item => { const key = `${item.marketplace}:${item.sku}`; if (seen.has(key)) return false; seen.add(key); return true })
  }, [costs])
  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return latest.filter(item => !needle || `${item.sku} ${item.asin || ''} ${item.title} ${item.marketplace}`.toLowerCase().includes(needle))
  }, [latest, query])
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
      <div className={styles.upload}>
        <div className={styles.field}><label>Excel cost workbook</label><input type="file" accept=".xlsx" onChange={event => { setFile(event.target.files?.[0] || null); setPreview(null); setMessage('') }} /></div>
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
      <div className={styles.toolbar}><div><div className={styles.title}>Current LDP records</div><div className={styles.subtitle}>Latest effective record per SKU and marketplace</div></div><input className={styles.search} value={query} onChange={event => setQuery(event.target.value)} placeholder="Search SKU, ASIN, product, or market" /></div>
      <div className={styles.tableWrap}>{filtered.length ? <table className={styles.table}><thead><tr><th>Product</th><th>Market</th><th>LDP / unit</th><th>Effective</th><th>Source</th></tr></thead><tbody>{filtered.map(item => <tr key={item.id}><td><strong>{item.title}</strong><div className={styles.subtitle}><span className={styles.mono}>{item.sku}</span>{item.asin ? ` · ${item.asin}` : ''}</div></td><td>{item.marketplace}</td><td className={styles.mono}>${Number(item.ldp_per_unit).toFixed(2)} USD</td><td className={styles.mono}>{item.effective_from}</td><td>{item.source_reference || item.source_system}<div className={styles.subtitle}>{item.source_system}</div></td></tr>)}</tbody></table> : <div className={styles.empty}>No LDP records match this search.</div>}</div>
    </div>}
  </section>
}
