'use client'

import { useEffect } from 'react'

export default function ErrorBoundary({
  error,
  unstable_retry,
}: {
  error: Error & { digest?: string }
  unstable_retry: () => void
}) {
  useEffect(() => { console.error(error) }, [error])

  return (
    <section role="alert" style={{ padding: 32, borderRadius: 12, background: 'var(--card)' }}>
      <h2 style={{ margin: '0 0 8px' }}>SellerIQ couldn&apos;t load this dashboard.</h2>
      <p style={{ color: 'var(--text-muted)', margin: '0 0 20px' }}>
        The data service may be temporarily unavailable. Your settings were not changed.
      </p>
      <button type="button" onClick={unstable_retry} style={{ padding: '10px 16px', cursor: 'pointer' }}>
        Try again
      </button>
    </section>
  )
}
