import DashboardState from '@/components/DashboardState'

export default function Loading() {
  return (
    <DashboardState
      kind="loading"
      title="Loading your workspace"
      detail="SellerIQ is assembling the latest verified metrics. This can take a moment for longer date ranges."
    />
  )
}
