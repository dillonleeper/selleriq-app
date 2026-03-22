'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useTheme } from '@/context/ThemeContext'
import {
  BarChart2, Package, Boxes, GitCompare, TrendingUp, Sun, Moon
} from 'lucide-react'

const nav = [
  { href: '/',          label: 'Sales Overview',       icon: BarChart2  },
  { href: '/products',  label: 'Product Performance',  icon: Package    },
  { href: '/inventory', label: 'Inventory',            icon: Boxes      },
  { href: '/compare',   label: 'Marketplace Compare',  icon: GitCompare },
  { href: '/traffic',   label: 'Traffic & Conversion', icon: TrendingUp },
]

// Orbital data mark — 3 circles in an arc
function OrbitLogo() {
  return (
    <svg width="22" height="22" viewBox="0 0 22 22" fill="none" xmlns="http://www.w3.org/2000/svg">
      {/* Orbit arc */}
      <path
        d="M4 16 Q11 2 18 8"
        stroke="var(--accent)"
        strokeWidth="1.5"
        strokeLinecap="round"
        fill="none"
        opacity="0.5"
      />
      {/* Data point 1 — large, anchor */}
      <circle cx="4" cy="16" r="2.5" fill="var(--accent)" />
      {/* Data point 2 — medium */}
      <circle cx="11" cy="7" r="1.8" fill="var(--accent)" opacity="0.7" />
      {/* Data point 3 — small */}
      <circle cx="18" cy="8" r="1.2" fill="var(--accent)" opacity="0.45" />
    </svg>
  )
}

export default function Sidebar() {
  const pathname = usePathname()
  const { theme, toggle } = useTheme()

  return (
    <aside style={{
      position: 'fixed', top: 0, left: 0,
      width: '220px', height: '100vh',
      background: 'var(--bg-card)',
      borderRight: '1px solid var(--border)',
      display: 'flex', flexDirection: 'column',
      zIndex: 100,
      transition: 'background 0.2s ease, border-color 0.2s ease',
    }}>
      {/* Logo */}
      <div style={{
        padding: '20px 18px',
        borderBottom: '1px solid var(--border)',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '9px' }}>
          <OrbitLogo />
          <span style={{
            fontSize: '15px', fontWeight: 600,
            color: 'var(--text-primary)',
            letterSpacing: '-0.4px',
          }}>
            SellerIQ
          </span>
        </div>
      </div>

      {/* Nav */}
      <nav style={{ padding: '10px 8px', flex: 1 }}>
        <div style={{
          fontSize: '10px', fontWeight: 600,
          color: 'var(--text-dim)',
          letterSpacing: '0.08em', textTransform: 'uppercase',
          padding: '0 10px', marginBottom: '6px',
        }}>
          Analytics
        </div>
        {nav.map(({ href, label, icon: Icon }) => {
          const active = pathname === href
          return (
            <Link key={href} href={href} style={{ textDecoration: 'none' }}>
              <div style={{
                display: 'flex', alignItems: 'center', gap: '9px',
                padding: '8px 10px', borderRadius: '7px', marginBottom: '1px',
                background: active ? 'var(--accent-light)' : 'transparent',
                color: active ? 'var(--accent)' : 'var(--text-muted)',
                fontSize: '13px', fontWeight: active ? 500 : 400,
                cursor: 'pointer', transition: 'all 0.12s ease',
                border: active ? '1px solid var(--accent-border)' : '1px solid transparent',
              }}
              onMouseEnter={e => {
                if (!active) {
                  const el = e.currentTarget as HTMLDivElement
                  el.style.background = 'var(--bg-hover)'
                  el.style.color = 'var(--text-primary)'
                }
              }}
              onMouseLeave={e => {
                if (!active) {
                  const el = e.currentTarget as HTMLDivElement
                  el.style.background = 'transparent'
                  el.style.color = 'var(--text-muted)'
                }
              }}
              >
                <Icon size={14} />
                <span>{label}</span>
              </div>
            </Link>
          )
        })}
      </nav>

      {/* Footer — theme toggle + account */}
      <div style={{
        padding: '14px 16px',
        borderTop: '1px solid var(--border)',
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      }}>
        <div>
          <div style={{ fontSize: '11px', color: 'var(--text-muted)', fontWeight: 500 }}>
            Amazon · Walmart
          </div>
          <div style={{ fontSize: '10px', color: 'var(--text-dim)', marginTop: '1px' }}>
            US · CA
          </div>
        </div>
        <button
          onClick={toggle}
          title={theme === 'light' ? 'Switch to dark mode' : 'Switch to light mode'}
          style={{
            background: 'var(--bg-hover)', border: '1px solid var(--border)',
            borderRadius: '6px', padding: '6px', cursor: 'pointer',
            color: 'var(--text-muted)', display: 'flex', alignItems: 'center',
            transition: 'all 0.15s ease',
          }}
          onMouseEnter={e => {
            const el = e.currentTarget as HTMLButtonElement
            el.style.color = 'var(--text-primary)'
            el.style.borderColor = 'var(--accent)'
          }}
          onMouseLeave={e => {
            const el = e.currentTarget as HTMLButtonElement
            el.style.color = 'var(--text-muted)'
            el.style.borderColor = 'var(--border)'
          }}
        >
          {theme === 'light' ? <Moon size={13} /> : <Sun size={13} />}
        </button>
      </div>
    </aside>
  )
}
