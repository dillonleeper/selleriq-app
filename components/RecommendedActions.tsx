'use client'

import Link from 'next/link'
import { useEffect, useMemo, useState } from 'react'
import { AlertTriangle, ArrowDownRight, Boxes, CheckCircle2, ChevronDown, Clock3, ExternalLink, Eye, EyeOff, MoreHorizontal, RotateCcw, X } from 'lucide-react'
import type { InventoryRisk, SkuDriver } from '@/components/SalesOverviewInsights'
import { supabase } from '@/lib/supabase'
import { analyzeRecommendationSeries, type DiagnosticPoint, type DiagnosticResult } from '@/lib/recommendationDiagnostics'
import { calculateFbaShipment, FBA_LEAD_DEFAULT, FBA_LEAD_STORAGE_KEY, FBA_TARGET_DEFAULT, FBA_TARGET_STORAGE_KEY, readPositiveStoredNumber } from '@/lib/inventoryPolicy'
import styles from './RecommendedActions.module.css'

type Props = {
  comparisonAvailable: boolean
  skuDrivers: SkuDriver[]
  inventoryRisks: InventoryRisk[]
  inventoryError: boolean
  markets: string[]
  dataThrough: string | null
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
  nextStep?: string
  diagnosis?: DiagnosticResult
  evidenceLabel: string
  inventoryPlan?: {
    targetDays: number
    leadDays: number
    dailyRate: number
    available: number
    moving: number
    availableCover: number
    bestCaseCover: number
    targetUnits: number
    rawUnitsToSend: number
    unitsToSend: number
    recentUnits: number
    snapshotDate?: string
    riskConfidence: 'High' | 'Medium'
    quantityConfidence: 'Medium' | 'Low'
  }
}

const STORAGE_KEY = 'selleriq-action-state-v1'
const SNOOZE_DAYS = 7
const EMPTY_PREFERENCES: Record<string, ActionPreference> = {}
const n = (value: number | string | null | undefined) => Number(value) || 0
const money = (value: number) => `$${Math.abs(value).toLocaleString('en-US', { maximumFractionDigits: 0 })}`
const signedPercent = (value: number) => `${value >= 0 ? '+' : ''}${value.toFixed(1)}%`
const productHref = (sku: string) => `/products?sku=${encodeURIComponent(sku)}&expand=1`
const trafficHref = (sku: string) => `/traffic?sku=${encodeURIComponent(sku)}&expand=1&range=last_90d`
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

function buildActions(comparisonAvailable: boolean, skuDrivers: SkuDriver[], inventoryRisks: InventoryRisk[], diagnostics: Record<string, DiagnosticResult>, targetDays: number, leadDays: number): ActionItem[] {
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
          title: `Revenue declined for ${row.sku}`,
          reason: `Revenue was ${Math.abs(revenueChange).toFixed(1)}% lower than the comparison period while sessions changed ${signedPercent(sessionChange)}. The available period totals do not establish the cause.`,
          evidence: [`Revenue ${money(revenue)} now`, `${money(priorRevenue)} previously`, `${signedPercent(sessionChange)} sessions`],
          impact: revenueDecline,
          score: revenueDecline * confidenceWeight(confidence),
          confidence,
          href: productHref(row.sku),
          nextStep: `Inspect which marketplace and demand signal changed before taking corrective action.`,
          evidenceLabel: 'period comparison',
        })
      }

      if (priorSessions >= 25 && sessionChange <= -20) {
        const impact = Math.max(0, (priorSessions - sessions) * revenuePerSession)
        const confidence = confidenceFor(priorSessions, 250)
        candidates.push({
          id: `traffic:${row.sku}`,
          kind: 'traffic', sku: row.sku,
          title: `Traffic declined for ${row.sku}`,
          reason: `Sessions were ${Math.abs(sessionChange).toFixed(1)}% lower than the comparison period. The available data confirms the change but does not identify the traffic source that changed.`,
          evidence: [`${sessions.toLocaleString()} sessions now`, `${priorSessions.toLocaleString()} previously`, `${money(revenuePerSession)} revenue/session`],
          impact,
          score: impact * confidenceWeight(confidence),
          confidence,
          href: trafficHref(row.sku),
          nextStep: 'Review the 90-day product timeline to identify when the change began, then compare paid and organic traffic sources.',
          evidenceLabel: 'period comparison',
        })
      }

      if (priorConversion > 0 && sessions >= 25 && conversionChange <= -1) {
        const impact = Math.max(0, sessions * ((priorConversion - conversion) / 100) * asp)
        const confidence = confidenceFor(Math.min(sessions, priorSessions), 250)
        const diagnosis = diagnostics[row.sku]
        candidates.push({
          id: `conversion:${row.sku}`,
          kind: 'conversion', sku: row.sku,
          title: diagnosis ? `${diagnosis.headline} for ${row.sku}` : `Investigate conversion change for ${row.sku}`,
          reason: diagnosis ? diagnosis.interpretation : `Conversion is lower than the comparison period, but daily diagnostic evidence is unavailable.`,
          evidence: diagnosis?.evidence || [`${conversion.toFixed(2)}% now`, `${priorConversion.toFixed(2)}% previously`, `${sessions.toLocaleString()} sessions`],
          impact,
          score: impact * confidenceWeight(confidence),
          confidence,
          href: trafficHref(row.sku),
          nextStep: diagnosis?.nextStep || 'Inspect the product timeline before changing the listing.',
          diagnosis,
          evidenceLabel: diagnosis ? `${diagnosis.strength} pattern evidence` : 'daily diagnosis unavailable',
        })
      }

      if (buyBox > 0 && buyBox < 90 && revenue >= 100 && sessions >= 25) {
        const impact = revenue * ((90 - buyBox) / 100)
        const confidence = confidenceFor(sessions, 250)
        candidates.push({
          id: `buybox:${row.sku}`,
          kind: 'buybox', sku: row.sku,
          title: `Low Buy Box ownership for ${row.sku}`,
          reason: `Buy Box ownership averaged ${buyBox.toFixed(1)}% during the selected period. This is an observed offer-ownership issue; price or competitor activity remains a hypothesis until reviewed.`,
          evidence: [`${buyBox.toFixed(1)}% ownership`, `${money(revenue)} current revenue`, `${sessions.toLocaleString()} sessions`],
          impact,
          score: impact * confidenceWeight(confidence),
          confidence,
          href: trafficHref(row.sku),
          nextStep: 'Review offer ownership and price history on the affected dates before changing the listing.',
          evidenceLabel: 'observed Buy Box signal',
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
    const available = n(row.available_quantity)
    const inbound = n(row.inbound_quantity)
    const transfer = n(row.fc_transfer_quantity)
    const processing = n(row.fc_processing_quantity)
    const unitsPerDay = n(row.units_per_day)
    const availableCover = unitsPerDay > 0 ? available / unitsPerDay : null
    const moving = inbound + transfer + processing
    const { targetUnits, rawUnitsToSend, unitsToSend } = calculateFbaShipment({ dailyRate: unitsPerDay, available, moving, targetDays })
    const riskConfidence: 'High' | 'Medium' = row.snapshot_date && recentUnits >= 30 ? 'High' : 'Medium'
    const quantityConfidence: 'Medium' | 'Low' = recentUnits >= 30 ? 'Medium' : 'Low'
    candidates.push({
      id: `stock:${row.marketplace}:${row.sku}`,
      kind: 'stock', sku: row.sku, marketplace: row.marketplace,
      title: `Stockout risk for ${row.sku} (${row.marketplace})`,
      reason: `${availableCover == null ? 'Current sellable coverage is unavailable' : `${availableCover.toFixed(1)} days are sellable now`}. Best-case coverage including ${moving.toLocaleString()} units moving through Amazon is ${daysOfCover.toFixed(1)} days.`,
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
      nextStep: unitsToSend > 0 ? `Send approximately ${unitsToSend.toLocaleString()} units to reach the saved ${targetDays}-day FBA target.` : `No additional shipment is suggested for the saved ${targetDays}-day target.`,
      evidenceLabel: `${riskConfidence} risk confidence`,
      inventoryPlan: {
        targetDays, leadDays, dailyRate: unitsPerDay, available, moving,
        availableCover: availableCover || 0, bestCaseCover: daysOfCover,
        targetUnits, rawUnitsToSend, unitsToSend, recentUnits, snapshotDate: row.snapshot_date,
        riskConfidence, quantityConfidence,
      },
    })
  }

  const strongestBySku = new Map<string, ActionItem>()
  // Period thresholds generate candidates only. A non-inventory item becomes a
  // recommendation only after the daily diagnostic independently confirms it.
  for (const candidate of candidates.filter(item => item.kind === 'stock' || diagnostics[item.sku])) {
    const existing = strongestBySku.get(candidate.sku)
    if (!existing || candidate.score > existing.score) strongestBySku.set(candidate.sku, candidate)
  }
  return [...strongestBySku.values()].map(action => {
    const diagnosis = diagnostics[action.sku]
    if (!diagnosis || action.kind === 'stock') return action
    const stateWeight = diagnosis.state === 'persistent' ? 1
      : diagnosis.state === 'recent_deterioration' ? 0.85
        : diagnosis.state === 'recovering' ? 0.45 : 0.35
    return {
      ...action,
      kind: diagnosis.association === 'inventory' ? 'stock'
        : diagnosis.association === 'buy_box' ? 'buybox'
          : diagnosis.association === 'traffic_dilution' ? 'traffic' : 'conversion',
      title: `${diagnosis.headline} for ${action.sku}`,
      reason: diagnosis.interpretation,
      evidence: diagnosis.evidence,
      nextStep: diagnosis.nextStep,
      diagnosis,
      score: action.score * stateWeight,
      href: trafficHref(action.sku),
      evidenceLabel: `${diagnosis.strength} pattern evidence`,
    }
  }).sort((left, right) => right.score - left.score).slice(0, 10)
}

export default function RecommendedActions({ comparisonAvailable, skuDrivers, inventoryRisks, inventoryError, markets, dataThrough }: Props) {
  const [diagnostics, setDiagnostics] = useState<Record<string, DiagnosticResult>>({})
  const [diagnosticsLoading, setDiagnosticsLoading] = useState(false)
  const [diagnosticsError, setDiagnosticsError] = useState(false)
  const [targetDays, setTargetDays] = useState(FBA_TARGET_DEFAULT)
  const [leadDays, setLeadDays] = useState(FBA_LEAD_DEFAULT)
  const actions = useMemo(() => buildActions(comparisonAvailable, skuDrivers, inventoryRisks, diagnostics, targetDays, leadDays), [comparisonAvailable, skuDrivers, inventoryRisks, diagnostics, targetDays, leadDays])
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

  useEffect(() => {
    const readPolicy = () => {
      setTargetDays(readPositiveStoredNumber(FBA_TARGET_STORAGE_KEY, FBA_TARGET_DEFAULT))
      setLeadDays(readPositiveStoredNumber(FBA_LEAD_STORAGE_KEY, FBA_LEAD_DEFAULT))
    }
    queueMicrotask(readPolicy)
    window.addEventListener('storage', readPolicy)
    window.addEventListener('focus', readPolicy)
    return () => {
      window.removeEventListener('storage', readPolicy)
      window.removeEventListener('focus', readPolicy)
    }
  }, [])

  useEffect(() => {
    if (!dataThrough || !markets.length || !skuDrivers.length) return
    const candidates = [...skuDrivers]
      .sort((left, right) => Math.abs(n(right.revenue_delta)) - Math.abs(n(left.revenue_delta)))
      .slice(0, 50)
      .map(row => row.sku)
    const start = new Date(`${dataThrough}T12:00:00`)
    start.setDate(start.getDate() - 89)
    const startKey = `${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, '0')}-${String(start.getDate()).padStart(2, '0')}`
    let cancelled = false
    queueMicrotask(() => {
      if (cancelled) return
      setDiagnosticsLoading(true)
      setDiagnosticsError(false)
    })
    void supabase.rpc('get_recommendation_diagnostic_series', {
      p_start: startKey, p_end: dataThrough, p_markets: markets, p_skus: candidates,
    }).then(({ data, error }) => {
      if (cancelled) return
      if (error) {
        console.error(error)
        setDiagnostics({})
        setDiagnosticsError(true)
      } else {
        const next: Record<string, DiagnosticResult> = {}
        for (const row of (data || []) as { sku: string; points: DiagnosticPoint[] }[]) {
          const result = analyzeRecommendationSeries(row.points)
          if (result) next[row.sku] = result
        }
        setDiagnostics(next)
      }
      setDiagnosticsLoading(false)
    })
    return () => { cancelled = true }
  }, [dataThrough, markets, skuDrivers])

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
  const visibleActions = showAll ? displayedActions : displayedActions.slice(0, 2)

  return (
    <section className="card overview-actions-card" aria-labelledby="actions-heading">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, marginBottom: 12, flexWrap: 'wrap' }}>
        <div>
          <div id="actions-heading" style={{ fontSize: 13, fontWeight: 600 }}>Recommended actions</div>
          <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>One item per SKU, ranked by business exposure and evidence quality.</div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          {hiddenCount > 0 && (
            <button type="button" onClick={() => setShowHidden(value => !value)} style={{ border: 'none', background: 'transparent', color: 'var(--accent)', cursor: 'pointer', fontSize: 10, padding: 0 }}>
              {showHidden ? 'Hide resolved' : `Review ${hiddenCount} hidden`}
            </button>
          )}
          <span style={{ fontSize: 10, color: diagnosticsError ? 'var(--yellow)' : 'var(--text-dim)' }}>{diagnosticsLoading ? 'Checking daily patterns…' : diagnosticsError ? 'Daily diagnostic evidence unavailable' : 'Saved on this browser'}</span>
        </div>
      </div>

      {displayedActions.length === 0 ? (
        <div style={{ fontSize: 12, color: 'var(--text-muted)', padding: '12px 0' }}>{inventoryError
          ? 'Inventory recommendations could not load. Refresh the page to try again.'
          : hiddenCount > 0
            ? 'All current actions are dismissed or snoozed.'
            : 'No supported high-priority actions for this selection.'}</div>
      ) : visibleActions.map(action => {
        const preference = preferences[action.id]
        const hidden = preferencesLoaded && isHidden(preference, now)
        const expanded = expandedActionId === action.id
        return (
          <article key={action.id} className={`${styles.recommendation} ${expanded ? styles.recommendationExpanded : ''}`} style={{ opacity: hidden ? 0.58 : 1 }}>
            <div className={styles.summaryRow}>
              <span className={styles.actionIcon}>{actionIcon(action.kind)}</span>
              <div className={styles.summaryContent}>
                {action.inventoryPlan ? <>
                  <div className={styles.identityRow}>
                    <strong>{action.sku} · {action.marketplace}</strong>
                    <span className={styles.riskBadge}>High risk</span>
                    <span className={styles.confidenceBadge}>{action.inventoryPlan.riskConfidence} confidence</span>
                    {hidden && <span className={styles.hiddenLabel}>{preference?.status === 'dismissed' ? 'Dismissed' : 'Snoozed'}</span>}
                  </div>
                  <div className={styles.riskTitle}>Stockout risk</div>
                  <div className={styles.primaryRecommendation}>Send {action.inventoryPlan.unitsToSend.toLocaleString()} units to FBA</div>
                  <div className={styles.recommendationSupport}>Restores inventory toward your {action.inventoryPlan.targetDays}-day target</div>
                  <div className={styles.compactEvidence}>
                    <span>{action.inventoryPlan.recentUnits.toLocaleString()} sold / 30d</span>
                    <span>{action.inventoryPlan.available.toLocaleString()} sellable</span>
                    <span>{action.inventoryPlan.moving.toLocaleString()} moving through Amazon</span>
                  </div>
                </> : <>
                  <div className={styles.identityRow}>
                    <strong>{action.sku}</strong>
                    <span className={styles.confidenceBadge}>{action.evidenceLabel}</span>
                    {hidden && <span className={styles.hiddenLabel}>{preference?.status === 'dismissed' ? 'Dismissed' : 'Snoozed'}</span>}
                  </div>
                  <div className={styles.riskTitle}>{action.title}</div>
                  <div className={styles.genericReason}>{action.reason}</div>
                  {action.nextStep && <div className={styles.genericAction}><strong>Next action:</strong> {action.nextStep}</div>}
                  <div className={styles.compactEvidence}>{action.evidence.map(item => <span key={item}>{item}</span>)}</div>
                </>}
              </div>
              <div className={styles.rowActions}>
                {hidden ? <button type="button" onClick={() => updatePreference(action.id)} className={styles.secondaryButton}><RotateCcw size={11} /> Restore</button> : <>
                  <button type="button" aria-expanded={expanded} onClick={() => setExpandedActionId(current => current === action.id ? null : action.id)} className={styles.reviewButton}>
                    <Eye size={11} /> {expanded ? 'Close calculation' : 'View calculation'} <ChevronDown size={10} className={`${styles.chevron} ${expanded ? styles.chevronOpen : ''}`} />
                  </button>
                  <details className={styles.overflowMenu}>
                    <summary aria-label="More recommendation actions"><MoreHorizontal size={15} /></summary>
                    <div>
                      <button type="button" onClick={() => updatePreference(action.id, { status: 'snoozed', until: Date.now() + SNOOZE_DAYS * 86_400_000, updatedAt: Date.now() })}><Clock3 size={11} /> Snooze 7 days</button>
                      <button type="button" onClick={() => updatePreference(action.id, { status: 'dismissed', updatedAt: Date.now() })}><X size={11} /> Dismiss</button>
                    </div>
                  </details>
                </>}
              </div>
            </div>
          {expanded && !hidden && (
            <section className={styles.panel} aria-label={`Review ${action.title}`}>
              {action.inventoryPlan ? (() => {
                const plan = action.inventoryPlan
                const availableWidth = Math.min(100, (plan.availableCover / plan.targetDays) * 100)
                const movingWidth = Math.min(100 - availableWidth, Math.max(0, ((plan.bestCaseCover - plan.availableCover) / plan.targetDays) * 100))
                const runsOutBeforeTransfer = plan.bestCaseCover <= plan.leadDays
                return <>
                  <div className={styles.inventoryHero}>
                    <div>
                      <span className={styles.label}>Projected coverage</span>
                      <strong>{plan.bestCaseCover.toFixed(1)} days</strong>
                      <p>{plan.availableCover.toFixed(1)} available + {Math.max(0, plan.bestCaseCover - plan.availableCover).toFixed(1)} moving through Amazon</p>
                    </div>
                    <div className={styles.confidencePair}>
                      <div><span>Stockout risk confidence</span><strong>{plan.riskConfidence}</strong></div>
                      <div><span>Quantity confidence</span><strong>{plan.quantityConfidence}</strong></div>
                    </div>
                  </div>
                  <div className={styles.coverageBlock}>
                    <div className={styles.coverageHeading}><span>Coverage against target</span><strong>{Math.max(0, plan.targetDays - plan.bestCaseCover).toFixed(1)}-day coverage shortfall</strong></div>
                    <div className={styles.coverageTrack} aria-label={`${plan.availableCover.toFixed(1)} days sellable now, ${Math.max(0, plan.bestCaseCover - plan.availableCover).toFixed(1)} additional days moving through Amazon, ${plan.targetDays}-day target`}>
                      <span className={styles.availableSegment} style={{ width: `${availableWidth}%` }} />
                      <span className={styles.movingSegment} style={{ left: `${availableWidth}%`, width: `${movingWidth}%` }} />
                    </div>
                    <div className={styles.coverageLegend}>
                      <span><i className={styles.availableDot} />{plan.availableCover.toFixed(1)}d sellable now</span>
                      <span><i className={styles.movingDot} />+{Math.max(0, plan.bestCaseCover - plan.availableCover).toFixed(1)}d moving</span>
                      <span>{plan.targetDays}d target</span>
                    </div>
                    {runsOutBeforeTransfer && <p className={styles.urgencyLine}>Even the best-case coverage is shorter than your saved {plan.leadDays}-day transfer and receiving window.</p>}
                  </div>
                  <div className={styles.calculation}>
                    <span className={styles.label}>Shipment calculation</span>
                    <div><span>Recent sales pace</span><strong>{plan.dailyRate.toFixed(1)} units/day</strong></div>
                    <div><span>{plan.targetDays}-day target</span><strong>{plan.targetUnits.toLocaleString()} units</strong></div>
                    <div><span>Counted inventory</span><strong>−{(plan.available + plan.moving).toLocaleString()} units</strong></div>
                    <div className={styles.calculatedNeed}><span>Calculated need</span><strong>{plan.rawUnitsToSend.toLocaleString()} units</strong></div>
                    <div className={styles.finalQuantity}><span>Recommended quantity</span><strong>{plan.unitsToSend.toLocaleString()} units</strong><em>Rounded to the nearest 10</em></div>
                  </div>
                  <div className={styles.inventoryFooter}>
                    <p><strong>Basis:</strong> Recent sales pace and the {plan.snapshotDate ? `${plan.snapshotDate} inventory snapshot` : 'current inventory snapshot'}. Quantity confidence is lower because future demand can change.</p>
                    <p>Target coverage <strong>{plan.targetDays} days</strong> · Transfer + receiving <strong>{plan.leadDays} days</strong></p>
                  </div>
                </>
              })() : <>
              <div className={styles.topGrid}>
                <div className={styles.evidence}>
                  <span className={styles.label}>Supporting evidence</span>
                  <ul>{action.evidence.map(item => <li key={item}><CheckCircle2 size={12} /> {item}</li>)}</ul>
                </div>
                <div className={styles.summary}>
                  <span className={styles.label}>Classification</span>
                  {action.diagnosis ? <>
                    <strong>{action.diagnosis.state.replaceAll('_', ' ')}</strong>
                    <p>{action.diagnosis.observedDays} observed days · {Math.round(action.diagnosis.coverage.sales * 100)}% sales coverage · {Math.round(action.diagnosis.coverage.inventory * 100)}% inventory coverage.</p>
                  </> : <>
                    <strong>{action.evidenceLabel}</strong>
                    <p>This item is based on the displayed period comparison or latest inventory snapshot.</p>
                  </>}
                </div>
              </div>
              <div className={styles.footer}>
                <div className={styles.method}>
                  <span className={styles.label}>How to interpret this</span>
                  <p><strong>{money(action.impact)}</strong> is modeled exposure, not guaranteed recovery. Pattern strength describes the observed evidence and does not establish cause.</p>
                </div>
                <div className={styles.controls}>
                  <Link href={action.href} className={styles.supportingLink}>Open 90-day timeline <ExternalLink size={11} /></Link>
                </div>
              </div>
              </>}
            </section>
          )}
          </article>
        )
      })}

      {displayedActions.length > 2 && (
        <button type="button" className="overview-view-actions" onClick={() => setShowAll(value => !value)}>
          {showAll ? 'Show top 2' : `View all ${displayedActions.length} actions`}
        </button>
      )}
      <div style={{ marginTop: 10, fontSize: 10, color: 'var(--text-dim)' }}>Impact is an estimate, not a forecast. Advertising, refunds, and product-cost actions remain gated until their source data is verified.</div>
    </section>
  )
}
