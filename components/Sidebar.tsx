'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import {
  BarChart2, Package, Boxes, GitCompare, TrendingUp,
  LogOut, CircleDollarSign, PanelLeftClose, PanelLeftOpen, X
} from 'lucide-react'

const nav = [
  { href: '/', label: 'Sales Overview', icon: BarChart2 },
  { href: '/products', label: 'Product Performance', icon: Package },
  { href: '/profitability', label: 'Profitability', icon: CircleDollarSign },
  { href: '/inventory', label: 'Inventory', icon: Boxes },
  { href: '/compare', label: 'Marketplace Compare', icon: GitCompare },
  { href: '/traffic', label: 'Traffic & Conversion', icon: TrendingUp },
]

function OrbitLogo() {
  return (
    <svg width="24" height="24" viewBox="0 0 22 22" fill="none" aria-hidden="true">
      <path d="M4 16 Q11 2 18 8" stroke="var(--accent)" strokeWidth="1.5" strokeLinecap="round" opacity="0.5" />
      <circle cx="4" cy="16" r="2.5" fill="var(--accent)" />
      <circle cx="11" cy="7" r="1.8" fill="var(--accent)" opacity="0.7" />
      <circle cx="18" cy="8" r="1.2" fill="var(--accent)" opacity="0.45" />
    </svg>
  )
}

type Props = {
  collapsed: boolean
  mobileOpen: boolean
  onToggleCollapsed: () => void
  onCloseMobile: () => void
}

export default function Sidebar({ collapsed, mobileOpen, onToggleCollapsed, onCloseMobile }: Props) {
  const pathname = usePathname()
  async function handleLogout() {
    try {
      await fetch('/api/logout', { method: 'POST' })
    } catch {}
    window.location.href = '/login'
  }

  return (
    <aside className={`app-sidebar ${collapsed ? 'is-collapsed' : ''} ${mobileOpen ? 'is-mobile-open' : ''}`}>
      <div className="sidebar-brand">
        <div className="sidebar-brand-lockup">
          <OrbitLogo />
          <span className="sidebar-label sidebar-brand-name">Merkury</span>
        </div>
        <button type="button" className="sidebar-mobile-close" aria-label="Close navigation" onClick={onCloseMobile}>
          <X size={18} />
        </button>
      </div>

      <nav className="sidebar-nav" aria-label="Analytics navigation">
        <div className="sidebar-section-label sidebar-label">Analytics</div>
        {nav.map(({ href, label, icon: Icon }) => {
          const active = pathname === href
          return (
            <Link
              key={href}
              href={href}
              title={collapsed ? label : undefined}
              className={`sidebar-link ${active ? 'is-active' : ''}`}
              onClick={onCloseMobile}
            >
              <Icon size={17} />
              <span className="sidebar-label">{label}</span>
            </Link>
          )
        })}
      </nav>

      <div className="sidebar-footer">
        <div className="sidebar-account sidebar-label">
          <strong>Amazon · Walmart</strong>
          <span>US · CA</span>
        </div>
        <div className="sidebar-actions">
          <button type="button" className="sidebar-icon-button desktop-collapse-button" onClick={onToggleCollapsed} title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}>
            {collapsed ? <PanelLeftOpen size={16} /> : <PanelLeftClose size={16} />}
          </button>
          <button type="button" className="sidebar-icon-button sidebar-logout" onClick={handleLogout} title="Sign out">
            <LogOut size={15} />
          </button>
        </div>
      </div>
    </aside>
  )
}
