'use client'

import Link from 'next/link'
import { useEffect, useState } from 'react'
import { CheckCircle2, ChevronDown, Clock3, ExternalLink, RotateCcw, X } from 'lucide-react'
import styles from './ContextualAction.module.css'

type ActionPreference = { status: 'reviewed' | 'dismissed' | 'snoozed'; until?: number; updatedAt: number }
type PreferenceStore = { version: 1; items: Record<string, ActionPreference> }
type Props = { id: string; title: string; reason: string; evidence: string[]; confidence: string; href?: string; hrefLabel?: string }
const STORAGE_KEY = 'selleriq-action-state-v1'

function readStore(): PreferenceStore {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null') as PreferenceStore | null
    return parsed?.version === 1 && parsed.items ? parsed : { version: 1, items: {} }
  } catch { return { version: 1, items: {} } }
}

export default function ContextualAction({ id, title, reason, evidence, confidence, href, hrefLabel = 'Open supporting page' }: Props) {
  const [preference, setPreference] = useState<ActionPreference | undefined>()
  const [expanded, setExpanded] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [now, setNow] = useState(0)

  useEffect(() => {
    const store = readStore()
    setPreference(store.items[id])
    setNow(Date.now())
    setLoaded(true)
  }, [id])

  const update = (next?: ActionPreference) => {
    const store = readStore()
    if (next) store.items[id] = next
    else delete store.items[id]
    localStorage.setItem(STORAGE_KEY, JSON.stringify(store))
    setPreference(next)
  }
  const hidden = preference?.status === 'dismissed' || (preference?.status === 'snoozed' && Boolean(preference.until && preference.until > now))

  if (loaded && hidden) return <div className={styles.hidden}><span>This investigation is {preference?.status === 'dismissed' ? 'dismissed' : 'snoozed for 7 days'}.</span><button type="button" onClick={() => update()}><RotateCcw size={10} /> Restore</button></div>

  return <section className={styles.card} aria-label="Recommended investigation">
    <div className={styles.row}>
      <div className={styles.copy}><span className={styles.eyebrow}>Recommended investigation</span><strong>{title}</strong><p>{reason}</p></div>
      <div className={styles.buttons}>
        <button type="button" className={styles.primary} onClick={() => { setExpanded(value => !value); if (preference?.status !== 'reviewed') update({ status: 'reviewed', updatedAt: Date.now() }) }} aria-expanded={expanded}>{expanded ? 'Close review' : 'Review'} <ChevronDown size={10} className={`${styles.chevron} ${expanded ? styles.chevronOpen : ''}`} /></button>
        <button type="button" onClick={() => update({ status: 'snoozed', until: Date.now() + 7 * 86_400_000, updatedAt: Date.now() })}><Clock3 size={10} /> Snooze 7d</button>
        <button type="button" onClick={() => update({ status: 'dismissed', updatedAt: Date.now() })}><X size={10} /> Dismiss</button>
      </div>
    </div>
    {expanded ? <div className={styles.details}>
      <ul className={styles.evidence}>{evidence.map(item => <li key={item}><CheckCircle2 size={10} /> {item}</li>)}</ul>
      <div className={styles.detailAside}><div className={styles.confidence}>{confidence} confidence · observed evidence</div>{href ? <Link href={href} className={styles.link}>{hrefLabel} <ExternalLink size={10} /></Link> : null}</div>
    </div> : null}
  </section>
}
