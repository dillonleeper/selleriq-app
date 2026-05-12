'use client'

import { useState, Suspense } from 'react'
import { useSearchParams, useRouter } from 'next/navigation'

// Reject absolute URLs ("https://evil.com/x") and protocol-relative URLs
// ("//evil.com/x") so the post-login redirect can't be hijacked.
function safeNext(raw: string | null): string {
  if (!raw) return '/'
  if (!raw.startsWith('/') || raw.startsWith('//')) return '/'
  return raw
}

function LoginForm() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const nextPath = safeNext(searchParams.get('next'))

  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    setLoading(true)

    try {
      const res = await fetch('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
      })

      if (res.ok) {
        // Hard navigation so the proxy re-evaluates the new cookie.
        // router.push() would cause a soft client-side nav and miss it.
        window.location.href = nextPath
      } else {
        const body = await res.json().catch(() => ({}))
        setError(body.error || 'Incorrect password')
        setLoading(false)
      }
    } catch (err) {
      setError('Something went wrong. Please try again.')
      setLoading(false)
    }
  }

  return (
    <div style={{
      minHeight: '100vh',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      background: 'var(--bg)',
      padding: '20px',
    }}>
      <div style={{
        width: '100%',
        maxWidth: '360px',
        background: 'var(--bg-card)',
        border: '1px solid var(--border)',
        borderRadius: '12px',
        padding: '32px 28px',
        boxShadow: 'var(--shadow-md)',
      }}>
        {/* Logo + title */}
        <div style={{ textAlign: 'center', marginBottom: '24px' }}>
          <svg width="32" height="32" viewBox="0 0 22 22" fill="none" xmlns="http://www.w3.org/2000/svg" style={{ marginBottom: '12px' }}>
            <path d="M4 16 Q11 2 18 8" stroke="var(--accent)" strokeWidth="1.5" strokeLinecap="round" fill="none" opacity="0.5" />
            <circle cx="4" cy="16" r="2.5" fill="var(--accent)" />
            <circle cx="11" cy="7" r="1.8" fill="var(--accent)" opacity="0.7" />
            <circle cx="18" cy="8" r="1.2" fill="var(--accent)" opacity="0.45" />
          </svg>
          <h1 style={{
            fontSize: '20px',
            fontWeight: 600,
            letterSpacing: '-0.4px',
            color: 'var(--text-primary)',
            marginBottom: '4px',
          }}>
            Merkury
          </h1>
          <p style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
            Enter password to continue
          </p>
        </div>

        <form onSubmit={handleSubmit}>
          <input
            type="password"
            value={password}
            onChange={e => setPassword(e.target.value)}
            placeholder="Password"
            autoFocus
            autoComplete="current-password"
            style={{
              width: '100%',
              padding: '10px 14px',
              borderRadius: '8px',
              border: `1px solid ${error ? 'var(--red)' : 'var(--border)'}`,
              background: 'var(--bg-elevated)',
              color: 'var(--text-primary)',
              fontSize: '14px',
              outline: 'none',
              marginBottom: '12px',
              boxSizing: 'border-box',
            }}
          />

          {error && (
            <div style={{
              fontSize: '12px',
              color: 'var(--red)',
              marginBottom: '12px',
              textAlign: 'center',
            }}>
              {error}
            </div>
          )}

          <button
            type="submit"
            disabled={loading || !password}
            style={{
              width: '100%',
              padding: '10px',
              borderRadius: '8px',
              border: 'none',
              background: 'var(--accent)',
              color: '#fff',
              fontSize: '13px',
              fontWeight: 600,
              cursor: loading || !password ? 'not-allowed' : 'pointer',
              opacity: loading || !password ? 0.6 : 1,
              transition: 'opacity 0.15s ease',
            }}
          >
            {loading ? 'Signing in...' : 'Sign in'}
          </button>
        </form>
      </div>
    </div>
  )
}

export default function LoginPage() {
  // useSearchParams must be wrapped in a Suspense boundary in Next 16.
  return (
    <Suspense fallback={null}>
      <LoginForm />
    </Suspense>
  )
}
