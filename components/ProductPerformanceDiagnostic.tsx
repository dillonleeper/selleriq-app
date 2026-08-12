'use client'

import { AlertTriangle, CheckCircle2, LoaderCircle, PackageSearch, TrendingDown, TrendingUp } from 'lucide-react'
import type { TrafficDiagnosticPoint } from '@/components/TrafficProductDiagnostic'

type Product = {
  revenue: number
  units: number
  sessions: number
  conv_rate: number
  asp: number
  buy_box_pct: number | null
  prev_revenue: number
  prev_units: number
  prev_sessions: number
  prev_conv_rate: number | null
  prev_asp: number | null
}

type Props = {
  product: Product
  points: TrafficDiagnosticPoint[]
  loading: boolean
}

const money = (value: number) => `${value < 0 ? '−' : value > 0 ? '+' : ''}$${Math.abs(Math.round(value)).toLocaleString('en-US')}`
const pct = (value: number | null, digits = 1) => value == null ? '—' : `${value > 0 ? '+' : ''}${value.toFixed(digits)}%`
const plainMoney = (value: number) => `$${Math.abs(Math.round(value)).toLocaleString('en-US')}`

export default function ProductPerformanceDiagnostic({ product, points, loading }: Props) {
  if (loading) {
    return <div className="product-diagnostic-loading"><LoaderCircle className="cadence-loading-spinner" size={18} /> Cross-referencing performance and inventory evidence…</div>
  }

  const hasComparison = product.prev_revenue > 0 || product.prev_sessions > 0 || product.prev_units > 0
  const revenueDelta = product.revenue - product.prev_revenue
  const revenuePct = product.prev_revenue > 0 ? revenueDelta / product.prev_revenue * 100 : null
  const sessionDeltaPct = product.prev_sessions > 0 ? (product.sessions - product.prev_sessions) / product.prev_sessions * 100 : null
  const conversionDelta = product.prev_conv_rate == null ? null : product.conv_rate - product.prev_conv_rate
  const aspDeltaPct = product.prev_asp && product.prev_asp > 0 ? (product.asp - product.prev_asp) / product.prev_asp * 100 : null

  const priorConv = (product.prev_conv_rate || 0) / 100
  const currentConv = product.conv_rate / 100
  const priorAsp = product.prev_asp || 0
  const trafficEffect = (product.sessions - product.prev_sessions) * priorConv * priorAsp
  const conversionEffect = product.sessions * (currentConv - priorConv) * priorAsp
  const priceEffect = product.sessions * currentConv * (product.asp - priorAsp)
  const effects = [
    { key: 'traffic', label: 'Traffic', value: trafficEffect, change: sessionDeltaPct, unit: '%' },
    { key: 'conversion', label: 'Conversion', value: conversionEffect, change: conversionDelta, unit: 'pp' },
    { key: 'price', label: 'Selling price', value: priceEffect, change: aspDeltaPct, unit: '%' },
  ]
  const strongest = effects.toSorted((left, right) => Math.abs(right.value) - Math.abs(left.value))[0]
  const inventoryObserved = points.filter(point => point.inventory_market_count > 0 && point.available_quantity != null && point.inventory_age_days != null && point.inventory_age_days <= 2)
  const outOfStockDays = inventoryObserved.filter(point => Number(point.available_quantity) <= 0).length
  const inventoryCoverage = points.length > 0 ? inventoryObserved.length / points.length : 0
  const buyBoxWeak = product.buy_box_pct != null && product.buy_box_pct < 80

  let label = 'Mixed signals'
  let title = 'No single verified driver explains the change.'
  let summary = 'Review the driver estimates and source coverage before taking action.'
  let next = 'Continue monitoring or inspect the daily trend for a concentrated change.'
  let tone: 'positive' | 'warning' | 'critical' | 'neutral' = 'neutral'

  if (!hasComparison) {
    label = 'Comparison unavailable'
    title = 'Current performance is available, but the prior period is incomplete.'
    summary = 'SellerIQ is withholding change attribution because a reliable baseline is not available.'
    next = 'Choose a range with a complete previous period before diagnosing the movement.'
  } else if (revenueDelta < 0 && outOfStockDays > 0) {
    label = 'Likely inventory-driven'
    title = `${outOfStockDays} observed out-of-stock day${outOfStockDays === 1 ? '' : 's'} overlap the revenue decline.`
    summary = 'Availability is a stronger first explanation than listing quality on those dates. Other driver estimates may partly reflect the stockout rather than an independent cause.'
    next = 'Restore stable availability, then reassess sessions and conversion after inventory recovers.'
    tone = 'critical'
  } else if (revenueDelta < 0 && buyBoxWeak) {
    label = 'Likely offer-driven'
    title = `Buy Box ownership averaged ${product.buy_box_pct?.toFixed(1)}% while revenue declined.`
    summary = 'Offer ownership is weak enough to constrain sales even when demand and inventory are present.'
    next = 'Review price competitiveness, competing sellers, and suppressed-offer conditions.'
    tone = 'warning'
  } else if (strongest.key === 'traffic') {
    label = 'Likely traffic-driven'
    title = `Session movement is the largest modeled contributor to the ${revenueDelta >= 0 ? 'increase' : 'decline'}.`
    summary = `Sessions changed ${pct(sessionDeltaPct)} versus the previous period. This is attribution, not proof of an upstream cause.`
    next = revenueDelta < 0 ? 'Investigate discoverability, ad traffic, search rank, and demand changes.' : 'Identify which traffic source or marketplace produced the gain.'
    tone = revenueDelta >= 0 ? 'positive' : 'warning'
  } else if (strongest.key === 'conversion') {
    label = 'Likely conversion-driven'
    title = `Conversion movement is the largest modeled contributor to the ${revenueDelta >= 0 ? 'increase' : 'decline'}.`
    summary = `Conversion changed ${pct(conversionDelta)} percentage points while Buy Box averaged ${product.buy_box_pct == null ? 'unknown' : `${product.buy_box_pct.toFixed(1)}%`}.`
    next = revenueDelta < 0 ? 'Review price, reviews, content, traffic quality, and offer availability.' : 'Identify which listing or traffic improvement should be protected.'
    tone = revenueDelta >= 0 ? 'positive' : 'warning'
  } else if (strongest.key === 'price') {
    label = 'Likely price/mix-driven'
    title = `Average selling price is the largest modeled contributor to the ${revenueDelta >= 0 ? 'increase' : 'decline'}.`
    summary = `ASP changed ${pct(aspDeltaPct)}. This may reflect price, promotions, or unit mix; SellerIQ cannot separate those without additional offer-level evidence.`
    next = 'Review price history and promotion activity before changing the offer.'
    tone = revenueDelta >= 0 ? 'positive' : 'warning'
  }

  const Icon = tone === 'positive' ? CheckCircle2 : tone === 'critical' ? AlertTriangle : tone === 'warning' ? TrendingDown : PackageSearch
  const confidence = !hasComparison || points.length === 0 ? 'Low' : inventoryCoverage >= .7 ? 'High' : 'Medium'
  const revenueDirection = revenueDelta >= 0 ? 'increased' : 'fell'
  const trafficSentence = trafficEffect < 0
    ? `Fewer visits reduced modeled revenue by ${plainMoney(trafficEffect)}.`
    : `More visits added about ${plainMoney(trafficEffect)}.`
  const conversionSentence = conversionEffect < 0
    ? `Lower conversion reduced it by another ${plainMoney(conversionEffect)}.`
    : revenueDelta < 0
      ? `Better conversion recovered about ${plainMoney(conversionEffect)} of the loss.`
      : `Better conversion added about ${plainMoney(conversionEffect)}.`
  const priceSentence = priceEffect < 0
    ? `A lower average selling price reduced it by about ${plainMoney(priceEffect)}.`
    : `A higher average selling price added about ${plainMoney(priceEffect)}.`
  let plainLanguage = hasComparison
    ? `Revenue ${revenueDirection} ${plainMoney(revenueDelta)}. ${trafficSentence} ${conversionSentence} ${priceSentence}`
    : 'SellerIQ can show the current result, but there is not enough prior-period data to explain what changed.'

  if (revenueDelta < 0 && outOfStockDays > 0) {
    plainLanguage = `Revenue fell ${plainMoney(revenueDelta)}, and SellerIQ observed ${outOfStockDays} day${outOfStockDays === 1 ? '' : 's'} without sellable inventory. The traffic and conversion effects may be consequences of that availability problem, so inventory should be investigated first.`
  } else if (revenueDelta < 0 && buyBoxWeak) {
    plainLanguage = `Revenue fell ${plainMoney(revenueDelta)} while this product owned the Buy Box only ${product.buy_box_pct?.toFixed(1)}% of the time. Shoppers may have seen another seller's offer, so price and offer ownership should be reviewed before changing the listing.`
  } else if (hasComparison && revenueDelta < 0 && conversionEffect > 0 && priceEffect >= 0) {
    plainLanguage += ' Stronger conversion and pricing softened the decline, but they did not fully offset the traffic loss.'
  } else if (hasComparison && revenueDelta > 0 && (conversionEffect < 0 || priceEffect < 0 || trafficEffect < 0)) {
    plainLanguage += ' The positive drivers more than offset the weaker part of performance.'
  }

  return <section className={`product-diagnostic is-${tone}`}>
    <div className="product-diagnostic-summary">
      <span className="product-diagnostic-icon"><Icon size={18} /></span>
      <div>
        <div className="product-diagnostic-eyebrow">{label} · {confidence} confidence</div>
        <h3>{title}</h3>
        <p>{summary}</p>
      </div>
    </div>

    <div className="product-diagnostic-plain">
      <span>Plain language</span>
      <p>{plainLanguage}</p>
    </div>

    <div className="product-diagnostic-drivers">
      <div><span>Revenue change</span><strong className={revenueDelta >= 0 ? 'is-positive' : 'is-negative'}>{money(revenueDelta)} <small>{pct(revenuePct)}</small></strong></div>
      {effects.map(effect => <div key={effect.key}><span>{effect.label} effect</span><strong className={effect.value >= 0 ? 'is-positive' : 'is-negative'}>{money(effect.value)} <small>{pct(effect.change)}{effect.unit === 'pp' ? ' pp' : ''}</small></strong></div>)}
    </div>

    <div className="product-diagnostic-evidence">
      <span><strong>{outOfStockDays}</strong> observed OOS days</span>
      <span><strong>{product.buy_box_pct == null ? '—' : `${product.buy_box_pct.toFixed(1)}%`}</strong> Buy Box</span>
      <span><strong>{Math.round(inventoryCoverage * 100)}%</strong> inventory-date coverage</span>
    </div>

    <div className="product-diagnostic-next"><TrendingUp size={14} /><span><strong>Next investigation:</strong> {next}</span></div>
  </section>
}
