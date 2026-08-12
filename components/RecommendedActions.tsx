'use client'

import Link from 'next/link'
import { Fragment, useEffect, useMemo, useState } from 'react'
import { AlertTriangle, ArrowDownRight, Boxes, CheckCircle2, ChevronDown, Clock3, ExternalLink, Eye, EyeOff, LockKeyhole, RotateCcw, X } from 'lucide-react'
import type { InventoryRisk, SkuDriver } from '@/components/SalesOverviewInsights'

type Props = {
  comparisonAvailable: boolean
  skuDrivers: SkuDriver[]
  inventoryRisks: InventoryRisk[]
  inventoryError: boolean
}

type ActionKind = 'revenue' | 'traffic' | 'conversion' | 'buybox' | 'stock'
type Confidence = 'High' | 'Medium'
type ActionPreference = { status: 'reviewed' | 'dismissed' | 'snoozed'; until?: number; updatedAt: number }
type PreferenceStore = { version: 1; items: Record<string, ActionPreference> }
type ActionItem = {
  id: string
  kind: ActionKind
  sku: string
  marketplace?: string
  title: string
  reason: string
  evidence: string[]
  impact: number
  score: number
  confidence: Confidence
  href: string
}

const STORAGE_KEY = 'selleriq-action-state-v1'
const SNOOZE_DAYS = 7
const EMPTY_PREFERENCES: Record<string, ActionPreference> = {}

const n = (value: number | string | null | undefined) => Number(value) || 0
const money = (value: number) => `$${Math.abs(value).toLocaleString('en-US', { maximumFractionDigits: 0 })}`
const signedPercent = (value: number) => `${value >= 0 ? '+' : ''}${value.toFixed(1)}%`
const productHref = (sku: string) => `/products?sku=${encodeURIComponent(sku)}`
const inventoryHref = (sku: string, marketplace: string) => `/inventory?sku=${encodeURIComponent(sku)}&market=${encodeURIComponent(marketplace)}&tab=fba`

function confidenceFor(sample: number, highThreshold: number): Confidence {
  return sample >= highThreshold ? 'High' : 'Medium'
}

function confidenceWeight(confidence: Confidence) {
  return confidence === 'High' ? 1 : 0.8
}

function actionIcon(kind: ActionKind) {
  if (kind === 'stock') return <Boxes size={16} />
  if (kind === 'traffic') return <EyeOff size={16} />
  if (kind === 'revenue') return <ArrowDownRight size={16} />
  return <AlertTriangle size={16} />
}

function readPreferences(): Record<string, ActionPreference> {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null') as PreferenceStore | null
    return parsed?.version === 1 && parsed.items && typeof parsed.items === 'object' ? parsed.items : EMPTY_PREFERENCES
  } catch {
    return EMPTY_PREFERENCES
  }
}

function writePreferences(items: Record<string, ActionPreference>) {
  const store: PreferenceStore = { version: 1, items }
  localStorage.setItem(STORAGE_KEY, JSON.stringify(store))
}

function isHidden(preference: ActionPreference | undefined, now: number) {
  if (!preference) return false
  if (preference.status === 'reviewed') return false
  if (preference.status === 'dismissed') return true
  return Boolean(preference.until && preference.until > now)
}

function buildActions(comparisonAvailable: boolean, skuDrivers: SkuDriver[], inventoryRisks: InventoryRisk[]): ActionItem[] {
  const candidates: ActionItem[] = []

  if (comparisonAvailable) {
    for (const row of skuDrivers) {
      const revenue = n(row.revenue)
      const priorRevenue = n(row.prior_revenue)
      const revenueDecline = priorRevenue - revenue
      const revenueChange = priorRevenue > 0 ? ((revenue - priorRevenue) / priorRevenue) * 100 : 0
      const sessions = n(row.sessions)
      const priorSessions = n(row.prior_sessions)
      const sessionChange = priorSessions > 0 ? ((sessions - priorSessions) / priorSessions) * 100 : 0
      const units = n(row.units)
      const priorUnits = n(row.prior_units)
      const conversion = n(row.conversion_rate)
      const priorConversion = priorSessions > 0 ? (priorUnits / priorSessions) * 100 : 0
      const conversionChange = conversion - priorConversion
      const asp = units > 0 ? revenue / units : 0
      const revenuePerSession = sessions > 0 ? revenue / sessions : priorSessions > 0 ? priorRevenue / priorSessions : 0
      const buyBox = n(row.buy_box_pct)

      if (priorRevenue >= 100 && revenueDecline >= 50 && revenueChange <= -20) {
        const confidence = confidenceFor(priorRevenue, 1000)
        candidates.push({
          id: `revenue:${row.sku}`,
          kind: 'revenue', sku: row.sku,
          title: `Investigate revenue decline for ${row.sku}`,
          reason: `Triggered because revenue fell ${Math.abs(revenueChange).toFixed(1)}% (${money(revenueDecline)}) versus the comparison period.`,
          evidence: [`Revenue ${money(revenue)} now`, `${money(priorRevenue)} previously`, `${signedPercent(sessionChange)} sessions`],
          impact: revenueDecline,
          score: revenueDecline * confidenceWeight(confidence),
          confidence,
          href: productHref(row.sku),
        })
      }

      if (priorSessions >= 25 && sessionChange <= -20) {
        const impact = Math.max(0, (priorSessions - sessions) * revenuePerSession)
        const confidence = confidenceFor(priorSessions, 250)
        candidates.push({
          id: `traffic:${row.sku}`,
          kind: 'traffic', sku: row.sku,
          title: `Recover traffic for ${row.sku}`,
          reason: `Triggered because sessions fell ${Math.abs(sessionChange).toFixed(1)}%, crossing the 20% decline threshold.`,
          evidence: [`${sessions.toLocaleString()} sessions now`, `${priorSessions.toLocaleString()} previously`, `${money(revenuePerSession)} revenue/session`],
          impact,
          score: impact * confidenceWeight(confidence),
          confidence,
          href: productHref(row.sku),
        })
      }

      if (priorConversion > 0 && sessions >= 25 && conversionChange <= -1) {
        const impact = Math.max(0, sessions * ((priorConversion - conversion) / 100) * asp)
        const confidence = confidenceFor(Math.min(sessions, priorSessions), 250)
        candidates.push({
          id: `conversion:${row.sku}`,
          kind: 'conversion', sku: row.sku,
          title: `Fix conversion for ${row.sku}`,
          reason: `Triggered because conversion declined ${Math.abs(conversionChange).toFixed(2)} percentage points, beyond the 1-point threshold.`,
          evidence: [`${conversion.toFixed(2)}% now`, `${priorConversion.toFixed(2)}% previously`, `${sessions.toLocaleString()} sessions`],
          impact,
          score: impact * confidenceWeight(confidence),
          confidence,
          href: productHref(row.sku),
        })
      }

      if (buyBox > 0 && buyBox < 90 && revenue >= 100 && sessions >= 25) {
        const impact = revenue * ((90 - buyBox) / 100)
        const confidence = confidenceFor(sessions, 250)
        candidates.push({
          id: `buybox:${row.sku}`,
          kind: 'buybox', sku: row.sku,
          title: `Recover Buy Box for ${row.sku}`,
          reason: `Triggered because Buy Box ownership is ${buyBox.toFixed(1)}%, below the 90% operating threshold.`,
          evidence: [`${buyBox.toFixed(1)}% ownership`, `${money(revenue)} current revenue`, `${sessions.toLocaleString()} sessions`],
          impact,
          score: impact * confidenceWeight(confidence),
          confidence,
          href: productHref(row.sku),
        })
      }
    }
  }

  for (const row of inventoryRisks) {
    const daysOfCover = n(row.days_of_cover)
    const monthlyRevenue = n(row.estimated_monthly_revenue)
    const recentUnits = n(row.recent_units)
    const impact = monthlyRevenue * Math.max(0, (28 - daysOfCover) / 28)
    const confidence = confidenceFor(recentUnits, 10)
    candidates.push({
      id: `stock:${row.marketplace}:${row.sku}`,
      kind: 'stock', sku: row.sku, marketplace: row.marketplace,
      title: `Reorder or expedite ${row.sku} (${row.marketplace})`,
      reason: `Triggered because projected cover is ${daysOfCover.toFixed(1)} days including inbound and usable reserved inventory, below the 28-day threshold.`,
      evidence: [
        `${n(row.available_quantity).toLocaleString()} available`,
        `${n(row.inbound_quantity).toLocaleString()} inbound`,
        `${n(row.fc_transfer_quantity).toLocaleString()} FC transfer`,
        `${n(row.fc_processing_quantity).toLocaleString()} FC processing`,
        `${recentUnits.toLocaleString()} units sold in 30 days`,
      ],
      impact,
      score: impact * confidenceWeight(confidence),
      confidence,
      href: inventoryHref(row.sku, row.marketplace),
    })
  }

  const strongestBySku = new Map<string, ActionItem>()
  for (const candidate of candidates) {
    const existing = strongestBySku.get(candidate.sku)
    if (!existing || candidate.score > existing.score) strongestBySku.set(candidate.sku, candidate)
  }
  return [...strongestBySku.values()].sort((left, right) => right.score - left.score).slice(0, 10)
}

export default function RecommendedActions({ comparisonAvailable, skuDrivers, inventoryRisks, inventoryError }: Props) {
  const actions = useMemo(() => buildActions(comparisonAvailable, skuDrivers, inventoryRisks), [comparisonAvailable, skuDrivers, inventoryRisks])
  const [preferences, setPreferences] = useState<Record<string, ActionPreference>>(EMPTY_PREFERENCES)
  const [preferencesLoaded, setPreferencesLoaded] = useState(false)
  const [showHidden, setShowHidden] = useState(false)
  const [showAll, setShowAll] = useState(false)
  const [expandedActionId, setExpandedActionId] = useState<string | null>(null)
  const [now, setNow] = useState(0)

  useEffect(() => {
    let active = true
    queueMicrotask(() => {
      if (!active) return
      setPreferences(readPreferences())
      setNow(Date.now())
      setPreferencesLoaded(true)
    })
    return () => { active = false }
  }, [])

  const updatePreference = (id: string, preference?: ActionPreference) => {
    setPreferences(previous => {
      const next = { ...previous }
      if (preference) next[id] = preference
      else delete next[id]
      writePreferences(next)
      return next
    })
  }

  const hiddenCount = preferencesLoaded ? actions.filter(action => isHidden(preferences[action.id], now)).length : 0
  const displayedActions = showHidden ? actions : actions.filter(action => !preferencesLoaded || !isHidden(preferences[action.id], now))
  const visibleActions = showAll ? displayedActions : displayedActions.slice(0, 3)

  return (
    <section className="card overview-actions-card" aria-labelledby="actions-heading">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, marginBottom: 12, flexWrap: 'wrap' }}>
        <div>
          <div id="actions-heading" style={{ fontSize: 13, fontWeight: 600 }}>Recommended actions</div>
          <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>One action per SKU &middot; ranked by estimated revenue impact and evidence confidence.</div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          {hiddenCount > 0 && (
            <button type="button" onClick={() => setShowHidden(value => !value)} style={{ border: 'none', background: 'transparent', color: 'var(--accent)', cursor: 'pointer', fontSize: 10, padding: 0 }}>
              {showHidden ? 'Hide resolved' : `Review ${hiddenCount} hidden`}
            </button>
          )}
          <span style={{ fontSize: 10, color: 'var(--text-dim)' }}>Saved on this browser</span>
        </div>
      </div>

      {displayedActions.length === 0 ? (
        <div style={{ fontSize: 12, color: 'var(--text-muted)', padding: '12px 0' }}>{inventoryError
          ? 'Inventory recommendations could not load. Refresh the page to try again.'
          : hiddenCount > 0
            ? 'All current actions are dismissed or snoozed.'
            : 'No supported high-priority actions for this selection.'}</div>
      ) : visibleActions.map((action, index) => {
        const preference = preferences[action.id]
        const hidden = preferencesLoaded && isHidden(preference, now)
        const reviewed = preference?.status === 'reviewed'
        const expanded = expandedActionId === action.id
        return (
          <Fragment key={action.id}>
          <article className="overview-action-row" style={{ borderTop: index ? '1px solid var(--border)' : 'none', opacity: hidden ? 0.58 : 1 }}>
            <span style={{ width: 28, height: 28, borderRadius: 7, display: 'grid', placeItems: 'center', color: index < 3 ? 'var(--red)' : 'var(--yellow)', background: index < 3 ? 'var(--red-light)' : 'var(--yellow-light)' }}>{actionIcon(action.kind)}</span>
            <div style={{ minWidth: 0 }}>
              <div style={{ display: 'flex', gap: 7, alignItems: 'center', flexWrap: 'wrap' }}>
                <span style={{ fontSize: 12, fontWeight: 650 }}>{action.title}</span>
                <span title="Modeled revenue currently exposed if the issue persists" style={{ fontSize: 9, fontWeight: 650, color: 'var(--red)', background: 'var(--red-light)', borderRadius: 999, padding: '2px 6px' }}>{money(action.impact)} impact</span>
                <span title={action.confidence === 'High' ? 'Large supporting sample and directly observed signal' : 'Supported signal with a smaller sample or modeled assumption'} style={{ fontSize: 9, fontWeight: 650, color: action.confidence === 'High' ? 'var(--green)' : 'var(--yellow)', background: action.confidence === 'High' ? 'var(--green-light)' : 'var(--yellow-light)', borderRadius: 999, padding: '2px 6px' }}>{action.confidence} confidence</span>
                {hidden && <span style={{ fontSize: 9, color: 'var(--text-dim)' }}>{preference?.status === 'dismissed' ? 'Dismissed' : 'Snoozed'}</span>}
                {reviewed && !hidden && <span className="action-reviewed-badge"><CheckCircle2 size={10} /> Reviewed</span>}
              </div>
              <div style={{ marginTop: 4, fontSize: 11, color: 'var(--text-muted)', lineHeight: 1.45 }}>{action.reason}</div>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 6 }}>
                {action.evidence.map(item => <span key={item} style={{ fontSize: 9, color: 'var(--text-dim)', border: '1px solid var(--border)', borderRadius: 999, padding: '2px 6px' }}>{item}</span>)}
              </div>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 6, flexWrap: 'wrap', maxWidth: 260 }}>
              {hidden ? (
                <button type="button" onClick={() => updatePreference(action.id)} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, border: '1px solid var(--border)', background: 'transparent', color: 'var(--text-muted)', borderRadius: 6, padding: '5px 7px', cursor: 'pointer', fontSize: 10 }}><RotateCcw size={11} /> Restore</button>
              ) : (
                <>
                  <button type="button" aria-expanded={expanded} onClick={() => {
                    setExpandedActionId(current => current === action.id ? null : action.id)
                    if (!reviewed) updatePreference(action.id, { status: 'reviewed', updatedAt: Date.now() })
                  }} className="action-review-button"><Eye size={11} /> {expanded ? 'Close review' : 'Review'} <ChevronDown size={10} className={expanded ? 'is-open' : ''} /></button>
                  <button type="button" title={`Hide this action for ${SNOOZE_DAYS} days`} onClick={() => updatePreference(action.id, { status: 'snoozed', until: Date.now() + SNOOZE_DAYS * 86_400_000, updatedAt: Date.now() })} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, border: '1px solid var(--border)', background: 'transparent', color: 'var(--text-muted)', borderRadius: 6, padding: '5px 7px', cursor: 'pointer', fontSize: 10 }}><Clock3 size={11} /> Snooze 7d</button>
                  <button type="button" title="Hide this action until restored" onClick={() => updatePreference(action.id, { status: 'dismissed', updatedAt: Date.now() })} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, border: '1px solid var(--border)', background: 'transparent', color: 'var(--text-muted)', borderRadius: 6, padding: '5px 7px', cursor: 'pointer', fontSize: 10 }}><X size={11} /> Dismiss</button>
                </>
              )}
            </div>
          </article>
          {expanded && !hidden && (
            <section className="action-review-panel" aria-label={`Review ${action.title}`}>
              <div className="action-review-summary">
                <span>SellerIQ conclusion</span>
                <strong>{action.title}</strong>
                <p>{action.reason}</p>
              </div>
              <div className="action-review-evidence">
                <span>Supporting evidence</span>
                <ul>{action.evidence.map(item => <li key={item}><CheckCircle2 size={12} /> {item}</li>)}</ul>
              </div>
              <div className="action-review-method">
                <span>How to interpret this</span>
                <p><strong>{money(action.impact)}</strong> is modeled revenue exposure, not guaranteed recovery. {action.confidence} confidence reflects the size and directness of the observed sample.</p>
              </div>
              <div className="action-review-controls">
                <Link href={action.href} className="action-supporting-link">Open supporting page <ExternalLink size={11} /></Link>
                <button type="button" disabled title="Approval becomes available only when SellerIQ has a verified write-capable integration for this action."><LockKeyhole size={11} /> Approval unavailable</button>
              </div>
            </section>
          )}
          </Fragment>
        )
      })}

      {displayedActions.length > 3 && (
        <button type="button" className="overview-view-actions" onClick={() => setShowAll(value => !value)}>
          {showAll ? 'Show top 3' : `View all ${displayedActions.length} actions`}
        </button>
      )}
      <div style={{ marginTop: 10, fontSize: 10, color: 'var(--text-dim)' }}>Impact is an estimate, not a forecast. Advertising, refunds, and product-cost actions remain gated until their source data is verified.</div>
    </section>
  )
}
