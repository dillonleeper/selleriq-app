// Exercises every data call the app makes from the BROWSER, using the anon key from
// .env.local -- the same key and same privileges a real page load has.
//
// This is the automatable half of "click through the app". It cannot catch a rendering
// bug, but it does catch exactly what a privilege change breaks: an RPC or table read
// that used to work and now returns permission denied or an empty result.
//
// Run it BEFORE and AFTER applying 20260813_lock_down_finance_tables.sql and diff the
// output. Every line that is OK before must still be OK after. Anything that flips to
// FAIL is a page the lockdown broke.
//
//   node scripts/verify-anon-access.mjs
//
// Exit code is 1 if any expected-OK check failed.

import { readFileSync } from 'node:fs'

const env = {}
for (const line of readFileSync('.env.local', 'utf8').split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/)
  if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '')
}
const U = env.NEXT_PUBLIC_SUPABASE_URL.replace(/\/$/, '')
const K = env.NEXT_PUBLIC_SUPABASE_ANON_KEY
// The key goes in `apikey` only. With the new sb_publishable_/sb_secret_ formats the key
// is not a JWT, and `Authorization: Bearer` is the slot a real user's access token would
// occupy -- Supabase still tolerates the key there, but it is the wrong header for it.
const H = { apikey: K, 'Content-Type': 'application/json' }

// The page's last_90d preset: current_date - 90 through yesterday.
const day = ms => new Date(Date.now() + ms * 86400000).toISOString().slice(0, 10)
const START = day(-90), END = day(-1)
const PRIOR_START = day(-180), PRIOR_END = day(-91)
const MARKETS = ['US']

const shared = { p_start: START, p_end: END, p_prior_start: PRIOR_START, p_prior_end: PRIOR_END, p_markets: MARKETS, p_skus: null }

// page -> checks. Each check is [label, kind, name, params].
const CHECKS = [
  ['Profitability', 'rpc', 'get_native_sku_economics', { p_start: START, p_end: END, p_markets: MARKETS }],
  ['Profitability', 'rpc', 'get_native_profitability_coverage', { p_start: START, p_end: END, p_markets: MARKETS }],
  ['Profitability', 'rpc', 'get_native_account_fee_breakdown', { p_start: START, p_end: END, p_markets: MARKETS }],
  ['Profitability', 'rpc', 'get_native_finance_daily_series', { p_start: START, p_end: END, p_markets: MARKETS }],

  ['Sales Overview', 'rpc', 'get_sales_overview', shared],
  // Signature is (p_prior_start, p_prior_end, p_markets) -- not the usual p_start/p_end.
  ['Sales Overview', 'rpc', 'get_sales_overview_meta', { p_prior_start: PRIOR_START, p_prior_end: PRIOR_END, p_markets: MARKETS }],
  ['Sales Overview', 'rpc', 'get_sales_overview_summary', shared],
  ['Sales Overview', 'rpc', 'get_sales_overview_market_drivers', shared],
  ['Sales Overview', 'rpc', 'get_sales_overview_inventory_actions', { p_end: END, p_markets: MARKETS, p_skus: null }],
  ['Sales Overview', 'rpc', 'get_sku_sales_summary', shared],
  ['Sales Overview', 'rpc', 'get_finance_pnl', { p_start: START, p_end: END, p_marketplace: 'US' }],

  ['Inventory', 'table', 'fct_inventory_snapshot_daily', 'select=sku,marketplace,available_quantity&limit=1'],
  ['Inventory', 'table', 'dim_product', 'select=sku,title,marketplace&limit=1'],

  ['Products/Traffic', 'rpc', 'get_sku_sales_cadence', { p_start: START, p_end: END, p_markets: MARKETS, p_skus: null }],
  ['Products/Traffic', 'rpc', 'search_products', { p_query: 'GN', p_limit: 3 }],

  // Must be CLOSED after the lockdown. Listed so the script proves the fix landed.
  ['LOCKED?', 'table', 'stg_amz_finance_transactions', 'select=id&limit=1'],
  ['LOCKED?', 'table', 'fct_sku_finance_daily', 'select=sku&limit=1'],
  ['LOCKED?', 'table', 'int_finance_pnl_components', 'select=transaction_id&limit=1'],
  ['LOCKED?', 'table', 'fct_sku_finance_transaction', 'select=transaction_id&limit=1'],
  ['LOCKED?', 'table', 'fct_account_fee_daily', 'select=marketplace&limit=1'],
  ['LOCKED?', 'table', 'sku_ldp_history', 'select=sku&limit=1'],
  ['LOCKED?', 'table', 'fct_sku_profit_period', 'select=sku&limit=1'],
  ['LOCKED?', 'table', 'account_profit_adjustment', 'select=category&limit=1'],
  ['LOCKED?', 'table', 'profit_reconciliation_target', 'select=metric&limit=1'],
  ['LOCKED? (step 3)', 'table', 'fct_finance_pnl_daily', 'select=sale_date&limit=1'],
  ['LOCKED? (step 3)', 'table', 'agg_finance_pnl_counts_daily', 'select=sale_date&limit=1'],
  ['LOCKED? (step 3)', 'table', 'int_fee_type_standardization', 'select=pnl_category&limit=1'],
]

async function run(kind, name, params) {
  try {
    if (kind === 'rpc') {
      const r = await fetch(`${U}/rest/v1/rpc/${name}`, { method: 'POST', headers: H, body: JSON.stringify(params) })
      const body = await r.text()
      if (!r.ok) return { ok: false, note: `HTTP ${r.status} ${body.slice(0, 100).replace(/\s+/g, ' ')}` }
      let d = null
      try { d = JSON.parse(body) } catch { /* scalar */ }
      const count = Array.isArray(d) ? d.length : (d === null ? 0 : 1)
      return { ok: true, note: `rows=${count}` }
    }
    const r = await fetch(`${U}/rest/v1/${name}?${params}`, { headers: H })
    const body = await r.text()
    if (!r.ok) return { ok: false, note: `HTTP ${r.status} ${body.slice(0, 100).replace(/\s+/g, ' ')}` }
    let d = []
    try { d = JSON.parse(body) } catch { /* ignore */ }
    return { ok: true, note: `rows=${d.length}` }
  } catch (e) {
    return { ok: false, note: 'threw: ' + e.message }
  }
}

console.log(`window ${START} -> ${END}   markets ${JSON.stringify(MARKETS)}`)
console.log(`project ${U}\n`)

let brokenApp = 0, stillOpen = 0
let group = ''
for (const [page, kind, name, params] of CHECKS) {
  if (page !== group) { console.log(`--- ${page} ---`); group = page }
  const { ok, note } = await run(kind, name, params)
  const expectClosed = page.startsWith('LOCKED')
  let verdict
  if (expectClosed) {
    verdict = ok ? 'STILL OPEN' : 'closed'
    if (ok) stillOpen++
  } else {
    verdict = ok ? 'OK' : 'FAIL'
    if (!ok) brokenApp++
  }
  console.log(`  ${name.padEnd(38)} ${verdict.padEnd(11)} ${note}`)
}

console.log(`\napp checks failing: ${brokenApp}`)
console.log(`tables still readable by anon: ${stillOpen}`)
process.exit(brokenApp > 0 ? 1 : 0)
