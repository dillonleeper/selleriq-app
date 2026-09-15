import { NextResponse } from 'next/server'
import path from 'path'
import fs from 'fs/promises'
import ExcelJS from 'exceljs'
import { hasValidAppSession, isSameOrigin } from '@/lib/serverAppAuth'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// The blank workbook Amazon generates from Seller Central's "Send to Amazon"
// upload flow (Manifest File Upload, US, case-pack columns included). We only
// ever touch the "Create workflow" sheet — every other tab (Instructions,
// Data definitions, the worked example) ships back to the seller untouched,
// so the file matches what Amazon's importer expects byte-for-byte outside
// of the rows we write.
const TEMPLATE_PATH = path.join(process.cwd(), 'lib', 'templates', 'fba-send-to-amazon-template.xlsx')
const SHEET_NAME = 'Create workflow – template' // en dash — must match the workbook's tab name exactly
const FIRST_DATA_ROW = 9 // row 8 is the header (Merchant SKU / Quantity / ...); data starts row 9
const MAX_ITEMS = 500 // sanity cap; a real single shipment plan won't approach this

type ExportItem = { sku: string; quantity: number }

function validateItems(raw: unknown): { items: ExportItem[] } | { error: string } {
  if (!Array.isArray(raw) || raw.length === 0) return { error: 'No items provided.' }
  if (raw.length > MAX_ITEMS) return { error: `Too many items (${raw.length}). Split into smaller shipments.` }

  const items: ExportItem[] = []
  for (const entry of raw) {
    const sku = typeof entry?.sku === 'string' ? entry.sku.trim() : ''
    // A blank/"-" quantity on the page (no computed recommendation, or a
    // slow-mover that rounds to 0) comes through as NaN or 0 here. Rather
    // than block the whole export on it, we let it through with quantity 0
    // and leave the cell blank below — the seller can hand-fill it in the
    // downloaded file. Only a genuinely invalid or negative value is rejected.
    const rawQuantity = entry?.quantity
    const quantity = rawQuantity === '' || rawQuantity === null || rawQuantity === undefined
      ? 0
      : Number(rawQuantity)
    if (!sku) return { error: 'Every row needs a SKU.' }
    if (sku.length > 80) return { error: `SKU "${sku}" is longer than Amazon's 80-character limit.` }
    if (!Number.isFinite(quantity) || quantity < 0) return { error: `"${sku}" has an invalid quantity.` }
    items.push({ sku, quantity: Math.round(quantity) })
  }
  return { items }
}

export async function POST(request: Request) {
  if (!await hasValidAppSession()) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  if (!isSameOrigin(request)) return NextResponse.json({ error: 'Invalid request origin.' }, { status: 403 })

  let body: { items?: unknown }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body.' }, { status: 400 })
  }

  const validated = validateItems(body.items)
  if ('error' in validated) return NextResponse.json({ error: validated.error }, { status: 400 })

  let templateBytes: Buffer
  try {
    templateBytes = await fs.readFile(TEMPLATE_PATH)
  } catch {
    return NextResponse.json({ error: 'The Amazon send-to-Amazon template is missing on the server.' }, { status: 500 })
  }

  // exceljs's bundled types pin an older @types/node Buffer shape than this
  // project's; the value is a real Buffer at runtime either way.
  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.load(templateBytes as any)

  const sheet = workbook.getWorksheet(SHEET_NAME)
  if (!sheet) {
    return NextResponse.json({ error: `Template is missing the "${SHEET_NAME}" sheet.` }, { status: 500 })
  }

  validated.items.forEach((item, i) => {
    const row = sheet.getRow(FIRST_DATA_ROW + i)
    row.getCell(1).value = item.sku // Merchant SKU
    // Amazon's own template instructions say to leave a field blank rather
    // than enter a placeholder when there's no data for it — so a 0/unknown
    // quantity (no computed recommendation yet, e.g. a SKU just back in
    // stock after a long OOS stretch, or a brand-new launch with no sales
    // history) is written as a blank cell, not a literal 0, for the seller
    // to fill in by hand before uploading.
    row.getCell(2).value = item.quantity > 0 ? item.quantity : null // Quantity
    // Columns C–H (expiration date, lot code, case-pack box info) are left
    // blank on purpose for now — Amazon treats them as optional.
    row.commit()
  })

  const buffer = await workbook.xlsx.writeBuffer()
  const filename = `send-to-amazon-${new Date().toISOString().slice(0, 10)}.xlsx`

  return new NextResponse(buffer as unknown as BodyInit, {
    status: 200,
    headers: {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Cache-Control': 'no-store',
    },
  })
}
