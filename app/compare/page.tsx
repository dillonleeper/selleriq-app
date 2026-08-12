import { GitCompare } from 'lucide-react'
import AnalyticsPageHeader from '@/components/AnalyticsPageHeader'
import DashboardState from '@/components/DashboardState'

export default function MarketplaceComparePage() {
  return (
    <div className="analytics-page">
      <AnalyticsPageHeader
        title="Marketplace Compare"
        description="Compare demand, conversion, inventory, and economics across connected marketplaces."
      />
      <DashboardState
        kind="empty"
        title="Marketplace comparison is being prepared"
        detail="The navigation now resolves correctly. The comparison view will be connected to the shared metric definitions before figures are published."
        action={<GitCompare size={18} aria-hidden="true" />}
      />
    </div>
  )
}
