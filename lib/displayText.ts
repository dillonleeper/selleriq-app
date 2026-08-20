// Typographic characters live here as escape sequences rather than literal glyphs.
//
// app/profitability/page.tsx has been corrupted into CP1252 mojibake twice --
// introduced in 9e58003, fixed in 08d6381/59bcc00, then reintroduced in b4fc831 --
// which rendered the SKU/ASIN separator as a stray two-character sequence.
// Something in that file's save path re-encodes it, so retyping the glyph only
// buys time until the next regression. Escape sequences are plain ASCII bytes and
// survive that round-trip unchanged, which is why every separator below is written
// as \uXXXX and why this file intentionally contains no non-ASCII characters.
//
// Keep it that way. `npm run lint:encoding` fails the build if any tracked source
// file grows a mojibake sequence again.

/** Middle dot, U+00B7. The canonical inline separator across SellerIQ. */
export const MIDDOT = '\u00B7'
/** Em dash, U+2014. Used as the "no value to show" placeholder. */
export const EM_DASH = '\u2014'
/** True minus sign, U+2212. For arithmetic written out in prose. */
export const MINUS = '\u2212'
/** Horizontal ellipsis, U+2026. */
export const ELLIPSIS = '\u2026'

/** Joins parts with the middle-dot separator, dropping blank ones. */
export function joinWithDot(...parts: Array<string | number | null | undefined>) {
  return parts
    .map(part => (typeof part === 'number' ? String(part) : part?.trim()))
    .filter(Boolean)
    .join(` ${MIDDOT} `)
}

/**
 * Canonical SKU/ASIN label, e.g. "GN-CW230-199 <MIDDOT> B0G8J5G3TH".
 * Falls back to the SKU alone when the product has no ASIN.
 */
export function skuAsinLabel(sku: string, asin?: string | null) {
  return joinWithDot(sku, asin)
}
