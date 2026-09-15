export type IssueState = 'persistent' | 'recent_deterioration' | 'recovering' | 'outlier_driven'
export type AssociatedSignal = 'traffic_dilution' | 'inventory' | 'buy_box' | 'unexplained'
export type EvidenceStrength = 'strong' | 'moderate' | 'limited'

export type DiagnosticPoint = {
  d: string
  sessions: number | null
  units: number | null
  revenue: number | null
  conv_rate: number | null
  buy_box_pct: number | null
  selected_market_count: number
  sales_market_count: number
  inventory_market_count: number
  available_quantity: number | null
}

export type DiagnosticResult = {
  state: IssueState
  association: AssociatedSignal
  strength: EvidenceStrength
  headline: string
  interpretation: string
  nextStep: string
  evidence: string[]
  observedDays: number
  coverage: { sales: number; inventory: number; buyBox: number }
}

type WindowSummary = { points: DiagnosticPoint[]; sessions: number; units: number; revenue: number; conversion: number | null }

const pp = (value: number) => `${Math.abs(value).toFixed(1)} points`

function median(values: number[]) {
  if (!values.length) return null
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}

function mad(values: number[], center = median(values)) {
  return center == null ? null : median(values.map(value => Math.abs(value - center)))
}

function summarize(points: DiagnosticPoint[]): WindowSummary {
  const valid = points.filter(point => point.sessions != null && point.units != null)
  const sessions = valid.reduce((sum, point) => sum + (point.sessions || 0), 0)
  const units = valid.reduce((sum, point) => sum + (point.units || 0), 0)
  return {
    points: valid,
    sessions,
    units,
    revenue: valid.reduce((sum, point) => sum + (point.revenue || 0), 0),
    conversion: sessions > 0 ? (units / sessions) * 100 : null,
  }
}

// Statistical significance is a guardrail for a measured change, never evidence of cause.
function conversionDifferenceIsReliable(a: WindowSummary, b: WindowSummary) {
  if (a.sessions < 250 || b.sessions < 250 || a.conversion == null || b.conversion == null) return false
  const pa = Math.min(1, Math.max(0, a.units / a.sessions))
  const pb = Math.min(1, Math.max(0, b.units / b.sessions))
  const pooled = (a.units + b.units) / (a.sessions + b.sessions)
  const standardError = Math.sqrt(Math.max(0, pooled * (1 - pooled) * (1 / a.sessions + 1 / b.sessions)))
  return standardError > 0 && Math.abs(pa - pb) / standardError >= 1.96
}

function spearman(xs: number[], ys: number[]) {
  if (xs.length !== ys.length || xs.length < 8) return null
  const ranks = (values: number[]) => values.map(value => {
    const lower = values.filter(other => other < value).length
    const equal = values.filter(other => other === value).length
    return lower + (equal + 1) / 2
  })
  const rx = ranks(xs), ry = ranks(ys)
  const mx = rx.reduce((sum, value) => sum + value, 0) / rx.length
  const my = ry.reduce((sum, value) => sum + value, 0) / ry.length
  const numerator = rx.reduce((sum, value, index) => sum + (value - mx) * (ry[index] - my), 0)
  const dx = Math.sqrt(rx.reduce((sum, value) => sum + (value - mx) ** 2, 0))
  const dy = Math.sqrt(ry.reduce((sum, value) => sum + (value - my) ** 2, 0))
  return dx && dy ? numerator / (dx * dy) : null
}

function isMaterialConversionDrop(current: WindowSummary, baseline: WindowSummary) {
  if (current.conversion == null || baseline.conversion == null || baseline.conversion === 0) return false
  const points = current.conversion - baseline.conversion
  const relative = ((current.conversion - baseline.conversion) / baseline.conversion) * 100
  return points <= -1 && relative <= -15 && conversionDifferenceIsReliable(current, baseline)
}

function removeConversionOutliers(points: DiagnosticPoint[]) {
  const rates = points.map(point => point.conv_rate).filter((value): value is number => value != null && Number.isFinite(value))
  const center = median(rates)
  const dispersion = mad(rates, center)
  if (center == null || dispersion == null) return points
  const limit = dispersion === 0 ? Math.max(1, Math.abs(center) * 0.5) : 3 * 1.4826 * dispersion
  return points.filter(point => point.conv_rate == null || Math.abs(point.conv_rate - center) <= limit)
}

export function analyzeRecommendationSeries(rawPoints: DiagnosticPoint[]): DiagnosticResult | null {
  const ordered = [...rawPoints].sort((a, b) => a.d.localeCompare(b.d))
  const observed = ordered.filter(point => point.sessions != null && point.units != null)
  if (observed.length < 21) return null

  const recent = summarize(observed.slice(-14))
  const previous = summarize(observed.slice(-28, -14))
  const historical = summarize(observed.slice(0, -28))
  const baseline = historical.points.length >= 21 ? historical : summarize(observed.slice(0, -14))
  if (recent.sessions < 250 || baseline.sessions < 250 || recent.conversion == null || baseline.conversion == null) return null

  const recentDrop = isMaterialConversionDrop(recent, baseline)
  const previousDrop = isMaterialConversionDrop(previous, baseline)
  const recentVsPrevious = recent.conversion - (previous.conversion ?? recent.conversion)
  const recoveryDenominator = baseline.conversion - (previous.conversion ?? baseline.conversion)
  const recoveredFraction = recoveryDenominator > 0 ? recentVsPrevious / recoveryDenominator : 0
  const cleaned = summarize(removeConversionOutliers(observed))
  const full = summarize(observed)
  const fullDelta = (full.conversion ?? 0) - baseline.conversion
  const cleanedDelta = (cleaned.conversion ?? 0) - baseline.conversion
  const outlierDriven = fullDelta < -1 && Math.abs(cleanedDelta) < Math.abs(fullDelta) * 0.6
  if (!recentDrop && !previousDrop && !outlierDriven) return null

  let state: IssueState
  if (outlierDriven) state = 'outlier_driven'
  else if (previousDrop && recentVsPrevious >= 1 && (recoveredFraction >= 0.5 || !recentDrop)) state = 'recovering'
  else if (previousDrop && recentDrop) state = 'persistent'
  else state = 'recent_deterioration'

  const paired = observed.filter(point => point.sessions != null && point.conv_rate != null && point.sessions > 0)
  const trafficCorrelation = spearman(paired.map(point => point.sessions || 0), paired.map(point => point.conv_rate || 0))
  const sessionMedian = median(paired.map(point => point.sessions || 0)) || 0
  const sessionMad = mad(paired.map(point => point.sessions || 0), sessionMedian) || 0
  const spikeThreshold = sessionMedian + Math.max(sessionMedian * 0.5, 3 * 1.4826 * sessionMad)
  const spikeDays = paired.filter(point => (point.sessions || 0) >= spikeThreshold)
  const ordinaryDays = paired.filter(point => (point.sessions || 0) < spikeThreshold)
  const spikeConversion = summarize(spikeDays).conversion
  const ordinaryConversion = summarize(ordinaryDays).conversion
  const trafficDilution = paired.length >= 21 && spikeDays.length >= 3 && trafficCorrelation != null && trafficCorrelation <= -0.4
    && spikeConversion != null && ordinaryConversion != null && spikeConversion <= ordinaryConversion - 1

  const inventoryObserved = observed.filter(point => point.inventory_market_count >= point.selected_market_count && point.available_quantity != null)
  const unavailable = summarize(inventoryObserved.filter(point => (point.available_quantity || 0) <= 0))
  const available = summarize(inventoryObserved.filter(point => (point.available_quantity || 0) > 0))
  const inventoryCoverage = inventoryObserved.length / observed.length
  const inventoryAssociation = inventoryCoverage >= 0.6 && unavailable.points.length >= 3 && available.points.length >= 7
    && unavailable.revenue / Math.max(1, unavailable.points.length) < available.revenue / available.points.length * 0.6

  const buyBoxObserved = observed.filter(point => point.buy_box_pct != null)
  const weakBuyBox = summarize(buyBoxObserved.filter(point => (point.buy_box_pct || 0) < 80))
  const healthyBuyBox = summarize(buyBoxObserved.filter(point => (point.buy_box_pct || 0) >= 90))
  const buyBoxCoverage = buyBoxObserved.length / observed.length
  const buyBoxAssociation = buyBoxCoverage >= 0.6 && weakBuyBox.points.length >= 3 && healthyBuyBox.points.length >= 7
    && weakBuyBox.revenue / Math.max(1, weakBuyBox.points.length) < healthyBuyBox.revenue / healthyBuyBox.points.length * 0.7

  const association: AssociatedSignal = inventoryAssociation ? 'inventory'
    : buyBoxAssociation ? 'buy_box'
      : trafficDilution ? 'traffic_dilution'
        : 'unexplained'

  const stateText: Record<IssueState, string> = {
    persistent: 'has remained below its longer-term baseline',
    recent_deterioration: 'has deteriorated recently',
    recovering: 'is recovering after a weaker period',
    outlier_driven: 'is being distorted by a small number of unusual days',
  }
  const associationText: Record<AssociatedSignal, string> = {
    traffic_dilution: 'The weakest conversion days coincided with unusually high traffic.',
    inventory: 'The decline overlaps days when available inventory was exhausted.',
    buy_box: 'The decline overlaps days with weak Buy Box ownership.',
    unexplained: 'The available traffic, inventory, and Buy Box signals do not isolate an explanation.',
  }
  const nextStep: Record<AssociatedSignal, string> = {
    traffic_dilution: 'Compare paid and organic traffic, campaigns, and search terms during the session spikes.',
    inventory: 'Review replenishment timing and confirm that unavailable days were not caused by stale inventory snapshots.',
    buy_box: 'Review offer ownership, price changes, and competing sellers on the affected dates.',
    unexplained: 'Inspect the product timeline and check price, promotion, advertising, and listing changes.',
  }

  const delta = recent.conversion - baseline.conversion
  const evidence = [`Recent conversion ${recent.conversion.toFixed(1)}% vs. ${baseline.conversion.toFixed(1)}% baseline (${delta >= 0 ? '+' : '-'}${pp(delta)})`]
  if (state === 'recovering' && previous.conversion != null) evidence.push(`Improved ${pp(recent.conversion - previous.conversion)} vs. the preceding 14 days`)
  if (trafficDilution && trafficCorrelation != null) evidence.push(`${spikeDays.length} traffic-spike days; session/conversion association ${trafficCorrelation.toFixed(2)}`)
  if (inventoryAssociation) evidence.push(`${unavailable.points.length} observed days without available inventory`)
  if (buyBoxAssociation) evidence.push(`${weakBuyBox.points.length} observed days below 80% Buy Box`)

  const strength: EvidenceStrength = observed.length >= 56 && recent.sessions >= 1000 && baseline.sessions >= 1000
    && (association !== 'unexplained' || state === 'outlier_driven') ? 'strong'
    : observed.length >= 28 && recent.sessions >= 500 ? 'moderate' : 'limited'

  return {
    state, association, strength,
    headline: `Conversion ${stateText[state]}`,
    interpretation: associationText[association],
    nextStep: nextStep[association],
    evidence, observedDays: observed.length,
    coverage: { sales: observed.length / Math.max(1, ordered.length), inventory: inventoryCoverage, buyBox: buyBoxCoverage },
  }
}
