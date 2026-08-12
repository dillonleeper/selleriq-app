import type { ReactNode } from 'react'

type Props = {
  title: string
  description: ReactNode
  actions?: ReactNode
  notice?: ReactNode
}

export default function AnalyticsPageHeader({ title, description, actions, notice }: Props) {
  return (
    <header className="analytics-page-header">
      <div className="analytics-page-heading">
        <h1>{title}</h1>
        <div className="analytics-page-description">{description}</div>
        {notice ? <div className="analytics-page-notice">{notice}</div> : null}
      </div>
      {actions ? <div className="analytics-page-actions">{actions}</div> : null}
    </header>
  )
}
