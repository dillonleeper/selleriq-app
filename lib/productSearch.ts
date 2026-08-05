import { supabase } from '@/lib/supabase'

export type ProductSearchResult = {
  sku: string
  asin: string | null
  title: string | null
}

const SEARCH_CACHE_TTL_MS = 5 * 60 * 1000
const searchCache = new Map<string, { expiresAt: number; results: ProductSearchResult[] }>()

export async function searchProducts(
  query: string,
  limit = 20,
): Promise<ProductSearchResult[]> {
  const normalized = query.trim()
  if (normalized.length < 2) return []

  const cacheKey = `${normalized.toLowerCase()}::${limit}`
  const cached = searchCache.get(cacheKey)
  if (cached && cached.expiresAt > Date.now()) return cached.results

  const { data, error } = await supabase.rpc('search_products', {
    p_query: normalized,
    p_limit: limit,
  })

  if (error) throw error
  const results = (data ?? []) as ProductSearchResult[]
  searchCache.set(cacheKey, { expiresAt: Date.now() + SEARCH_CACHE_TTL_MS, results })
  return results
}
