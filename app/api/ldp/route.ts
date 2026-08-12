import { NextResponse } from 'next/server'
import { hasValidAppSession, isSameOrigin } from '@/lib/serverAppAuth'
import { readXlsxTable } from '@/lib/readXlsxTable'
import { createSupabaseAdmin } from '@/lib/supabaseAdmin'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

type ProductIdentity = { sku: string; marketplace: string; asin: string | null; title: string | null }
type Candidate = { row: number; sku: string; marketplace: 'US' | 'CA'; asin: string | null; ldp: number }
type Rejected = { row: number; sku: string; marketplace: string | null; reason: string }

const MAX_FILE_BYTES = 10 * 1024 * 1024

function clean(value: unknown) {
  return String(value ?? '').trim()
}

function market(value: unknown): 'US' | 'CA' | null {
  const normalized = clean(value).toLowerCase().replace(/^www\./, '')
  if (['amazon.com', 'us', 'usa', 'united states'].includes(normalized)) return 'US'
  if (['amazon.ca', 'ca', 'canada'].includes(normalized)) return 'CA'
  return null
}

function numberValue(value: unknown): number | null {
  const parsed = Number(clean(value).replace(/[$,]/g, ''))
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null
}

async function parseWorkbook(file: File) {
  if (!file.name.toLowerCase().endsWith('.xlsx')) throw new Error('Upload an .xlsx workbook.')
  if (file.size > MAX_FILE_BYTES) throw new Error('The workbook is larger than 10 MB.')
  const rows = readXlsxTable(Buffer.from(await file.arrayBuffer()))
  if (!rows.length) throw new Error('The workbook does not contain a worksheet.')
  const headers = new Map<string, number>()
  rows[0].forEach((value, column) => headers.set(clean(value).toLowerCase(), column))
  const skuColumn = headers.get('sku')
  const asinColumn = headers.get('asin')
  const costColumn = headers.get('cost')
  const marketplaceColumn = headers.get('marketplace')
  if (skuColumn === undefined || costColumn === undefined || marketplaceColumn === undefined) {
    throw new Error('Required columns: SKU, Cost, and Marketplace.')
  }

  const parsed: Array<{ row: number; sku: string; asin: string | null; marketplace: 'US' | 'CA' | null; ldp: number | null }> = []
  for (let index = 1; index < rows.length; index += 1) {
    const row = rows[index]
    const sku = clean(row[skuColumn])
    const asin = asinColumn === undefined ? null : clean(row[asinColumn]) || null
    const marketplace = market(row[marketplaceColumn])
    const ldp = numberValue(row[costColumn])
    if (!sku && !asin && ldp === null) continue
    parsed.push({ row: index + 1, sku, asin, marketplace, ldp })
  }
  return parsed
}

async function validate(file: File) {
  const input = await parseWorkbook(file)
  const admin = createSupabaseAdmin()
  const { data, error } = await admin.from('dim_product').select('sku,marketplace,asin,title')
  if (error) throw new Error(`Could not load product identities: ${error.message}`)
  const products = (data || []) as ProductIdentity[]
  const identities = new Map(products.map(item => [`${item.marketplace}:${item.sku.trim()}`, item]))
  const accepted = new Map<string, Candidate>()
  const rejected: Rejected[] = []

  for (const item of input) {
    if (!item.sku) { rejected.push({ row: item.row, sku: '', marketplace: item.marketplace, reason: 'Missing SKU' }); continue }
    if (!item.marketplace) { rejected.push({ row: item.row, sku: item.sku, marketplace: null, reason: 'Missing or unknown marketplace' }); continue }
    if (item.ldp === null) { rejected.push({ row: item.row, sku: item.sku, marketplace: item.marketplace, reason: 'Missing or invalid cost' }); continue }
    const key = `${item.marketplace}:${item.sku}`
    const product = identities.get(key)
    if (!product) { rejected.push({ row: item.row, sku: item.sku, marketplace: item.marketplace, reason: 'No exact SKU and marketplace match' }); continue }
    if (item.asin && product.asin && item.asin !== product.asin) { rejected.push({ row: item.row, sku: item.sku, marketplace: item.marketplace, reason: 'ASIN does not match SellerIQ' }); continue }
    const existing = accepted.get(key)
    if (existing && existing.ldp !== item.ldp) {
      accepted.delete(key)
      rejected.push({ row: item.row, sku: item.sku, marketplace: item.marketplace, reason: 'Conflicting duplicate cost' })
      continue
    }
    accepted.set(key, { row: item.row, sku: item.sku, marketplace: item.marketplace, asin: product.asin, ldp: item.ldp })
  }
  return { workbookRows: input.length, accepted: [...accepted.values()], rejected }
}

async function currentCosts() {
  const admin = createSupabaseAdmin()
  const [{ data: costs, error: costError }, { data: products, error: productError }] = await Promise.all([
    admin.from('sku_ldp_history').select('id,marketplace,sku,asin,effective_from,effective_to,ldp_per_unit,currency_code,source_system,source_reference,created_at').order('effective_from', { ascending: false }),
    admin.from('dim_product').select('marketplace,sku,title'),
  ])
  if (costError) throw new Error(costError.message)
  if (productError) throw new Error(productError.message)
  const titles = new Map((products || []).map(item => [`${item.marketplace}:${String(item.sku).trim()}`, item.title]))
  return (costs || []).map(item => ({ ...item, title: titles.get(`${item.marketplace}:${String(item.sku).trim()}`) || item.sku }))
}

export async function GET() {
  if (!await hasValidAppSession()) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  try {
    return NextResponse.json({ costs: await currentCosts() }, { headers: { 'Cache-Control': 'no-store' } })
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Could not load LDP records.' }, { status: 500 })
  }
}

export async function POST(request: Request) {
  if (!await hasValidAppSession()) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  if (!isSameOrigin(request)) return NextResponse.json({ error: 'Invalid request origin.' }, { status: 403 })
  try {
    const form = await request.formData()
    const file = form.get('file')
    const action = clean(form.get('action'))
    const effectiveFrom = clean(form.get('effectiveFrom'))
    if (!(file instanceof File)) return NextResponse.json({ error: 'Choose an Excel workbook.' }, { status: 400 })
    const result = await validate(file)
    if (action === 'preview') {
      return NextResponse.json({
        workbookRows: result.workbookRows,
        acceptedCount: result.accepted.length,
        rejectedCount: result.rejected.length,
        acceptedPreview: result.accepted.slice(0, 20),
        rejectedPreview: result.rejected.slice(0, 50),
      })
    }
    if (action !== 'import') return NextResponse.json({ error: 'Unknown import action.' }, { status: 400 })
    if (!/^\d{4}-\d{2}-\d{2}$/.test(effectiveFrom)) return NextResponse.json({ error: 'Choose a valid effective date.' }, { status: 400 })
    if (result.accepted.length === 0) return NextResponse.json({ error: 'There are no validated rows to import.' }, { status: 400 })

    const admin = createSupabaseAdmin()
    const payload = result.accepted.map(item => ({
      marketplace: item.marketplace,
      sku: item.sku,
      asin: item.asin,
      effective_from: effectiveFrom,
      effective_to: null,
      ldp_per_unit: item.ldp,
      currency_code: 'USD',
      source_system: 'selleriq_ldp_upload',
      source_reference: file.name.slice(0, 500),
    }))
    for (let index = 0; index < payload.length; index += 250) {
      const { error } = await admin.from('sku_ldp_history').upsert(payload.slice(index, index + 250), { onConflict: 'marketplace,sku,effective_from' })
      if (error) throw new Error(`Import failed: ${error.message}`)
    }
    return NextResponse.json({ imported: payload.length, rejectedCount: result.rejected.length, costs: await currentCosts() })
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'The LDP import failed.' }, { status: 500 })
  }
}
