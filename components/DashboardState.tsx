import type { ReactNode } from 'react'
import { AlertCircle, Inbox, LoaderCircle } from 'lucide-react'

type Props = {
  kind: 'loading' | 'empty' | 'error'
  title: string
  detail?: ReactNode
  action?: ReactNode
}

export default function DashboardState({ kind, title, detail, action }: Props) {
  const Icon = kind === 'loading' ? LoaderCircle : kind === 'error' ? AlertCircle : Inbox
  return (
    <section className={`dashboard-state is-${kind}`} role={kind === 'error' ? 'alert' : 'status'} aria-live="polite">
      <span className="dashboard-state-icon">
        <Icon className={kind === 'loading' ? 'cadence-loading-spinner' : undefined} size={22} />
      </span>
      <div className="dashboard-state-copy">
        <strong>{title}</strong>
        {detail ? <p>{detail}</p> : null}
      </div>
      {action ? <div className="dashboard-state-action">{action}</div> : null}
    </section>
  )
}
