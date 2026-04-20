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
  const isDark = theme === 'dark'
  const isLight = theme === 'light'

  return (
    <aside style={{
      position: 'fixed', top: 0, left: 0,
      width: '220px', height: '100vh',
      background: 'var(--bg-card)',
      borderRight: '1px solid var(--border)',
      display: 'flex', flexDirection: 'column',
      zIndex: 100,
      boxShadow: isDark ? 'inset -1px 0 0 #2A2A2C' : isLight ? 'inset -1px 0 0 #F8F8F8' : 'none',
      borderColor: isLight ? '#E5E5E5' : 'var(--border)',
      transition: 'background 0.2s ease, border-color 0.2s ease',
    }}>
      {/* Logo */}
      <div style={{
        padding: '20px 18px',
        borderBottom: '1px solid var(--border)',
        background: isDark ? 'linear-gradient(180deg, #2D2D30 0%, #252526 100%)' : isLight ? 'linear-gradient(180deg, #FAFAFA 0%, #F3F3F3 100%)' : 'transparent',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '9px' }}>
          <OrbitLogo />
          <span style={{
            fontSize: '15px', fontWeight: 600,
            color: 'var(--text-primary)',
            letterSpacing: '-0.4px',
          }}>
            Merkury
          </span>
        </div>
      </div>

      {/* Nav */}
      <nav style={{ padding: '10px 8px', flex: 1 }}>
        <div style={{
          fontSize: '9px', fontWeight: 600,
          color: 'var(--text-dim)',
          letterSpacing: '0.12em', textTransform: 'uppercase',
          padding: '0 10px', marginBottom: '10px',
        }}>
          Analytics
        </div>
        {nav.map(({ href, label, icon: Icon }) => {
          const active = pathname === href
          return (
            <Link key={href} href={href} style={{ textDecoration: 'none' }}>
              <div style={{
                display: 'flex', alignItems: 'center', gap: '9px',
                padding: isLight ? '7px 10px' : '8px 10px', borderRadius: isDark ? '3px' : isLight ? '2px' : '7px', marginBottom: isLight ? '2px' : '1px',
                background: active ? (isDark ? 'rgba(14,99,156,0.18)' : isLight ? 'rgba(0,95,184,0.08)' : 'var(--accent-light)') : 'transparent',
                color: active ? 'var(--accent)' : 'var(--text-muted)',
                fontSize: '13px', fontWeight: active ? 500 : 400,
                cursor: 'pointer', transition: 'all 0.12s ease',
                border: active ? `1px solid ${isDark ? '#094771' : isLight ? '#C7E0F4' : 'var(--accent-border)'}` : '1px solid transparent',
                boxShadow: active ? `inset 2px 0 0 ${isLight ? '#005FB8' : '#007ACC'}` : 'none',
              }}
              onMouseEnter={e => {
                if (!active) {
                  const el = e.currentTarget as HTMLDivElement
                  el.style.background = isDark ? '#2A2D2E' : isLight ? '#F3F9FD' : 'var(--bg-hover)'
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
        background: isDark ? '#252526' : isLight ? '#FAFAFA' : 'transparent',
        boxShadow: isLight ? 'inset 0 1px 0 #FFFFFF' : 'none',
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
            background: isDark ? '#2D2D30' : isLight ? '#F3F3F3' : 'var(--bg-hover)', border: '1px solid var(--border)',
            borderRadius: isDark ? '3px' : isLight ? '2px' : '6px', padding: '6px', cursor: 'pointer',
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
