# Merkury Dashboard v2

Stable V2 is a frozen application release built from the daily-grain SellerIQ
codebase. It reads the same daily warehouse as Daily Dev, so data refreshes and
pipeline recovery benefit both products without issuing duplicate Amazon API
requests.

## Release boundary

The `stable-v2` branch is the company release. New product work belongs on
`daily-dev`. Merge into `stable-v2` only for critical defects, security fixes,
or data-correctness fixes. Apply Stable V2 fixes back to Daily Dev when relevant.

Stable V2 disables these features:

- Profitability
- Traffic & Conversion
- Marketplace Compare
- Supplier Reorder on the Inventory page
- Recommended actions
- Marketplace contribution
- Profitability metrics pending
- Financial reconciliation
- Sales diagnostic row (Buy Box, refund rate, fee rate, ASP, and selling SKUs)

The three disabled routes are blocked by the Next.js proxy, so a direct URL
redirects to Sales Overview. Supplier Reorder is excluded from the Inventory
tab list and cannot be selected through the `?tab=supplier` query parameter.

## Deployment configuration

Create a separate Vercel project for Stable V2, connected to the `stable-v2`
branch. Copy the existing Daily Dev data and authentication environment values
into that project using Vercel's encrypted environment settings. Do not commit
their values.

Set this additional production and preview environment variable:

```
NEXT_PUBLIC_SELLERIQ_RELEASE=stable-v2
```

Stable V2 defaults to the restricted profile if this variable is absent. That
fail-closed default prevents an environment configuration mistake from exposing
unfinished features. Daily Dev should set the value to `daily-dev` if these
release controls are later shared back into that branch.

Use the same `NEXT_PUBLIC_SUPABASE_URL` and applicable Supabase keys as Daily
Dev. Stable V2 does not need a separate ingestion schedule. The existing daily
pipeline is the single writer and both applications are readers.

## Release checks

Before launch:

1. Run `npm run lint` and `npm run build`.
2. Confirm the sidebar only lists Sales Overview, Product Performance, and
   Inventory.
3. Confirm `/profitability`, `/traffic`, and `/compare` redirect to `/`.
4. Confirm `/inventory?tab=supplier` opens Inventory Snapshot.
5. Verify US, CA, and combined filters against the shared daily warehouse.
6. Verify search, date presets, charts, inventory, login, and logout.
7. Validate a preview deployment, then promote that exact artifact.

The data pipeline and its completeness monitor remain in the `selleriq-dev`
backend repository. Application releases must not create another Amazon
ingestion task.
