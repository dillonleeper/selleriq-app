'use client'

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import { usePathname } from 'next/navigation'

export type SelectedProduct = {
  sku: string
  title?: string | null
  asin?: string | null
  [key: string]: unknown
}

type ProductSelectionValue = {
  selectedProducts: SelectedProduct[]
  setSelectedProducts: React.Dispatch<React.SetStateAction<SelectedProduct[]>>
  clearSelectedProducts: () => void
}

const STORAGE_KEY = 'selleriq-workspace-products-v1'
const ProductSelectionContext = createContext<ProductSelectionValue | null>(null)

function normalizeProducts(value: unknown): SelectedProduct[] {
  if (!Array.isArray(value)) return []
  const seen = new Set<string>()
  return value.flatMap(item => {
    if (!item || typeof item !== 'object') return []
    const product = item as SelectedProduct
    const sku = typeof product.sku === 'string' ? product.sku.trim() : ''
    if (!sku || seen.has(sku)) return []
    seen.add(sku)
    return [{ ...product, sku, title: product.title || sku }]
  }).slice(0, 500)
}

export function ProductSelectionProvider({ children }: { children: React.ReactNode }) {
  const pathname = usePathname()
  const [selectedProducts, setSelectedProducts] = useState<SelectedProduct[]>([])
  const [hydrated, setHydrated] = useState(false)

  useEffect(() => {
    let restored: SelectedProduct[] = []
    try {
      restored = normalizeProducts(JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]'))
    } catch {
      localStorage.removeItem(STORAGE_KEY)
    }

    const params = new URLSearchParams(window.location.search)
    const directSkus = [
      ...(params.get('sku') ? [params.get('sku')!] : []),
      ...(params.get('skus') || '').split(','),
    ].map(value => value.trim()).filter(Boolean)

    setSelectedProducts(directSkus.length
      ? normalizeProducts(directSkus.map(sku => ({ sku, title: sku })))
      : restored)
    setHydrated(true)
  }, [])

  useEffect(() => {
    if (!hydrated) return
    const params = new URLSearchParams(window.location.search)
    const directSku = params.get('sku')?.trim()
    const directSkus = (params.get('skus') || '').split(',').map(value => value.trim()).filter(Boolean)
    const requested = directSku ? [directSku] : directSkus
    if (requested.length > 0) {
      setSelectedProducts(current => {
        const currentSkus = current.map(product => product.sku)
        return requested.length === currentSkus.length && requested.every((sku, index) => sku === currentSkus[index])
          ? current
          : normalizeProducts(requested.map(sku => ({ sku, title: sku })))
      })
    }
  }, [hydrated, pathname])

  useEffect(() => {
    if (!hydrated) return
    const normalized = normalizeProducts(selectedProducts)
    localStorage.setItem(STORAGE_KEY, JSON.stringify(normalized))

    const url = new URL(window.location.href)
    url.searchParams.delete('sku')
    url.searchParams.delete('skus')
    if (normalized.length === 1) url.searchParams.set('sku', normalized[0].sku)
    if (normalized.length > 1 && normalized.length <= 20) {
      url.searchParams.set('skus', normalized.map(product => product.sku).join(','))
    }
    window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`)
  }, [hydrated, pathname, selectedProducts])

  const clearSelectedProducts = useCallback(() => setSelectedProducts([]), [])
  const value = useMemo(() => ({ selectedProducts, setSelectedProducts, clearSelectedProducts }), [selectedProducts, clearSelectedProducts])

  return <ProductSelectionContext.Provider value={value}>{children}</ProductSelectionContext.Provider>
}

export function useProductSelection() {
  const context = useContext(ProductSelectionContext)
  if (!context) throw new Error('useProductSelection must be used within ProductSelectionProvider')
  return context
}
