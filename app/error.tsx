'use client'

import { useEffect } from 'react'
import DashboardState from '@/components/DashboardState'

export default function ErrorBoundary({
  error,
  unstable_retry,
}: {
  error: Error & { digest?: string }
  unstable_retry: () => void
}) {
  useEffect(() => { console.error(error) }, [error])

  return (
    <DashboardState
      kind="error"
      title="SellerIQ couldn’t load this dashboard"
      detail="The data service may be temporarily unavailable. Your settings were not changed."
      action={<button type="button" className="dashboard-state-button" onClick={unstable_retry}>Try again</button>}
    />
  )
}
