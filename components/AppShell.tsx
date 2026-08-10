'use client'

import { useEffect, useState } from 'react'
import { Menu } from 'lucide-react'
import Sidebar from '@/components/Sidebar'

const STORAGE_KEY = 'selleriq-sidebar-collapsed'

export default function AppShell({ children }: { children: React.ReactNode }) {
  const [collapsed, setCollapsed] = useState(false)
  const [mobileOpen, setMobileOpen] = useState(false)

  useEffect(() => {
    setCollapsed(localStorage.getItem(STORAGE_KEY) === 'true')
  }, [])

  const toggleCollapsed = () => {
    setCollapsed(value => {
      const next = !value
      localStorage.setItem(STORAGE_KEY, String(next))
      return next
    })
  }

  return (
    <div className={`app-shell ${collapsed ? 'sidebar-is-collapsed' : ''}`}>
      <button
        type="button"
        className="mobile-menu-button"
        aria-label="Open analytics navigation"
        aria-expanded={mobileOpen}
        onClick={() => setMobileOpen(true)}
      >
        <Menu size={19} />
      </button>
      <Sidebar
        collapsed={collapsed}
        mobileOpen={mobileOpen}
        onToggleCollapsed={toggleCollapsed}
        onCloseMobile={() => setMobileOpen(false)}
      />
      {mobileOpen && (
        <button
          type="button"
          aria-label="Close analytics navigation"
          className="sidebar-scrim"
          onClick={() => setMobileOpen(false)}
        />
      )}
      <main className="app-main">
        <div className="app-content">{children}</div>
      </main>
    </div>
  )
}
