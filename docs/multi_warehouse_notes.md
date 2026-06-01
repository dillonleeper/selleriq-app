# Inventory Page — Multi-Warehouse Support (Supplier Reorder tab)

**Status:** Backlog — weekly stable version
**Scope:** Frontend only (no schema or pipeline changes)
**File:** `app/inventory/page.tsx`

---

## Goal

Let users upload inventory for up to **4 warehouses** instead of one. Warehouses with no data are hidden everywhere. Warehouses with data appear as their own columns on the Supplier Reorder table and are summed into `total_inventory`, which feeds the existing Units to Reorder formula.

---

## How it works today (anchors for the change)

- **State:** `warehouseQty: Record<string, number>` — one qty per SKU.
- **Template:** `downloadTemplate()` writes `sku,warehouse_qty` (line 552–561).
- **Upload:** `handleWarehouseUpload()` parses those two columns, stores in `warehouseQty` and `localStorage` under `selleriq_warehouse_qty` (line 563–597).
- **Consumption:** In the supplier rows builder (line 824–846), `const wh = warehouseQty[r.sku] || 0` and `total_inventory = total_fba + wh`.
- **Formula:** `unitsToOrder = max(0, round(supplierOrderTarget * avg_daily_units) - total_inventory)` — already uses `total_inventory`, so once we sum across warehouses correctly, the formula needs no change.
- **Render:** Single "Warehouse" column header at line 1306, body cell at line 1345, expanded panel stat at line 1384.

---

## Target design

### Data model (frontend state)

Replace the flat `warehouseQty` shape with a per-warehouse shape:

```ts
type WarehouseId = 'wh1' | 'wh2' | 'wh3' | 'wh4'

type WarehouseConfig = {
  id: WarehouseId
  label: string          // user-provided name, e.g. "Dallas 3PL"
  active: boolean        // derived: true if any SKU has qty > 0 for this warehouse
}

// per-SKU, per-warehouse qty
type WarehouseQtyMap = Record<string, Partial<Record<WarehouseId, number>>>
//        ^ sku                    ^ warehouse id -> qty
```

Two pieces of state:

```ts
const [warehouseQty, setWarehouseQty] = useState<WarehouseQtyMap>(...)
const [warehouseLabels, setWarehouseLabels] = useState<Record<WarehouseId, string>>(...)
```

Both persisted to `localStorage`:
- `selleriq_warehouse_qty_v2` (bumped key — old single-warehouse data is incompatible; on first load with no v2 key, migrate the old `selleriq_warehouse_qty` map to `wh1`)
- `selleriq_warehouse_labels`
- Keep `selleriq_warehouse_upload_date` as-is

### Template CSV

The CSV header row is the label source. Users rename column headers to whatever their warehouses are called, and the upload picks up those names automatically. No separate "rename warehouse" UI.

`downloadTemplate()` should emit:

```
sku,Warehouse 1,Warehouse 2,Warehouse 3,Warehouse 4
SKU-001,0,0,0,0
SKU-002,0,0,0,0
...
```

After download, the user edits the header row to their actual warehouse names (e.g. `sku,Dallas 3PL,Toronto,LA Overflow,Warehouse 4`) and fills in quantities for whichever warehouses they use. A warehouse column they don't need can be left at 0 (it won't display) or the column can be deleted entirely (parser tolerates 1–4 warehouse columns).

Parser behavior:
- Col 0 must be `sku` (case-insensitive); reject upload if not.
- Cols 1 through N (up to 4): each header becomes the label for `wh1`–`whN`. Header text is taken verbatim — trim whitespace but preserve case.
- If a header is blank but the column has data, fall back to label `"Warehouse {n}"` so the data isn't silently lost.
- More than 4 warehouse columns: ignore beyond col 4 and show a one-time warning in the unmatched-SKU-style dialog ("Only the first 4 warehouse columns were imported").

### Upload parsing

`handleWarehouseUpload` changes:

1. Read header row, split on comma.
2. Validate col 0 is `sku` (case-insensitive); reject upload with a clear error if not.
3. Cols 1 through min(N, 4): trim each header. If non-empty, use it as the label for `wh1`...`whN`. If empty but the column has data, fall back to label `"Warehouse {n}"`.
4. For each data row, parse qty for each warehouse col into `warehouseQty[sku][whN]`. Empty cells become 0 (not undefined) so a re-upload that drops a SKU's qty actually clears it.
5. **Activation rule:** a warehouse is "active" if at least one SKU has qty > 0 for it. Computed at render time, not stored.
6. Store the qty map (`selleriq_warehouse_qty_v2`) and the labels (`selleriq_warehouse_labels`) in localStorage.
7. Keep the existing unmatched-SKU dialog logic.
8. If the CSV has more than 4 warehouse columns, ignore cols beyond 4 and surface a warning in the same dialog used for unmatched SKUs.

### Active warehouse derivation

Compute once per render, before building supplier rows:

```ts
const activeWarehouses: WarehouseConfig[] = (['wh1','wh2','wh3','wh4'] as WarehouseId[])
  .map(id => {
    const hasAnyQty = Object.values(warehouseQty).some(perSku => (perSku[id] ?? 0) > 0)
    return { id, label: warehouseLabels[id] || `Warehouse ${id.slice(2)}`, active: hasAnyQty }
  })
  .filter(w => w.active)
```

This drives both the supplier row build and the table render — single source of truth.

### Supplier row build (lines 823–846)

Replace `warehouse_qty: number` on `SupplierReplenRow` with a per-warehouse breakdown plus a total:

```ts
type SupplierReplenRow = {
  // ... existing fields
  warehouse_qtys: Partial<Record<WarehouseId, number>>  // only populated for active whs
  warehouse_total: number                                // sum across active whs
  total_inventory: number                                // total_fba + warehouse_total
  // ... rest
}
```

Build loop becomes:

```ts
for (const r of inventory) {
  if (!r.sku) continue
  const perWh = warehouseQty[r.sku] || {}
  const warehouseTotal = activeWarehouses.reduce((sum, w) => sum + (perWh[w.id] ?? 0), 0)
  // ...
}
```

`unitsToOrder` formula stays exactly the same — it reads `total_inventory`, which now correctly sums across all active warehouses. **Verify** the existing aggregation loop at line 841–845 (when a SKU appears in multiple marketplaces) still does the right thing: warehouse_total should only be added **once per SKU**, not once per marketplace. Today's code handles this implicitly by setting `warehouse_qty` on the first marketplace pass and not re-adding on subsequent passes. Preserve that — when `existing` is found, only sum `total_fba` and `avg_daily_units`, then recompute `total_inventory = total_fba + warehouse_total`.

### Table render (line 1296+)

- Replace the single `<th>Warehouse</th>` with `activeWarehouses.map(w => <th>{w.label}</th>)`.
- If `activeWarehouses.length === 0`, render zero warehouse columns and the table looks just like a no-upload state.
- Body row: replace the single warehouse `<td>` with `activeWarehouses.map(w => <td>{row.warehouse_qtys[w.id] || '—'}</td>)`.
- `colSpan` on the expanded forecast row (currently `10`) must become `9 + activeWarehouses.length` (or compute from a column count constant).
- Expanded panel `statsLeft`: replace the single "Warehouse" stat with one entry per active warehouse, OR show a single "Warehouse Total" stat and list the per-warehouse breakdown below. Probably cleanest: keep one "Warehouse Total" stat in `statsLeft`, and add a small breakdown line inside the forecast panel content. Defer to UX call when implementing.

### Export CSV (line 1286–1292)

Headers and rows need to expand to include each active warehouse column. Headers go from:

```
['SKU', 'Title', 'Total FBA (US+CA)', 'Warehouse', 'Total Inv', ...]
```

to:

```
['SKU', 'Title', 'Total FBA (US+CA)', ...activeWarehouses.map(w => w.label), 'Warehouse Total', 'Total Inv', ...]
```

Row builder matches.

---

## What does NOT change

- Warehouse data stays frontend-only / localStorage. Not ingested, not in Postgres. This is consistent with the current architecture — warehouse inventory is operator-supplied context, not an Amazon report.
- The `fct_inventory_snapshot_daily` table stays focused on FBA. Warehouse inventory is intentionally a separate concept on the frontend.
- The Units to Reorder formula. It already reads `total_inventory` — no math changes.

---

## Future enhancement (out of scope for this ticket)

Eventually warehouse inventory should be a real concept in the warehouse, not localStorage:
- `stg_warehouse_inventory` table fed by uploads (CSV → S3 → staging → `fct_warehouse_snapshot_daily`)
- Multi-warehouse modeled properly with a `dim_warehouse` table
- Joined into supplier reorder logic at the SQL layer instead of in React

That's a Phase 5+ concern. For now, localStorage + per-user UI state is the right level of investment — it keeps warehouse data out of the canonical warehouse until the use case justifies it.

---

## Implementation checklist

- [ ] Bump localStorage key to `selleriq_warehouse_qty_v2`; one-time migration from old single-warehouse map → `wh1`
- [ ] Add `warehouseLabels` state + `selleriq_warehouse_labels` localStorage key
- [ ] Rewrite `downloadTemplate()` to emit `sku,Warehouse 1,Warehouse 2,Warehouse 3,Warehouse 4` header
- [ ] Rewrite `handleWarehouseUpload()` to extract labels from header row (cols 1–4) and parse qty per warehouse
- [ ] Compute `activeWarehouses` (filter to whs with at least one non-zero qty)
- [ ] Update `SupplierReplenRow` type: `warehouse_qtys` map + `warehouse_total`
- [ ] Update supplier row builder to sum across active warehouses (and verify the multi-marketplace aggregation case)
- [ ] Update Supplier Reorder table: dynamic columns, correct `colSpan` on expanded row
- [ ] Update expanded forecast panel stats (Warehouse Total + optional per-wh breakdown)
- [ ] Update Export CSV headers + rows
- [ ] Test: 0 warehouses (template state), 1 warehouse (today's behavior), 4 warehouses, partial fills (2 of 4 active)
- [ ] Test: re-upload with fewer warehouses correctly hides the empty ones
