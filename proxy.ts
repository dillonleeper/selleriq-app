import { NextRequest, NextResponse } from 'next/server'
import { createHmac, timingSafeEqual } from 'crypto'

/**
 * Authentication proxy (Next.js 16 — formerly middleware).
 *
 * Runs before every request matched by `config.matcher`.
 * If the user has a valid `merkury_auth` cookie (signed by /api/login with
 * AUTH_COOKIE_SECRET), the request passes through. Otherwise they're
 * redirected to /login.
 *
 * NOTE: This is a *shared password* gate, not real per-user auth. Anyone
 * with the password gets the same level of access. This is intended for
 * pre-launch / demo use only. When we move to per-customer accounts,
 * this proxy will be replaced with Supabase Auth.
 */

// Cookie format set by /api/login: "ok.<ts>.<hex-hmac>"
function verifySession(value: string, secret: string): boolean {
  const lastDot = value.lastIndexOf('.')
  if (lastDot < 0) return false
  const payload = value.slice(0, lastDot)
  const sig = value.slice(lastDot + 1)
  const expected = createHmac('sha256', secret).update(payload).digest('hex')
  const sigBuf = Buffer.from(sig, 'hex')
  const expectedBuf = Buffer.from(expected, 'hex')
  // Buffer.from(..., 'hex') silently drops invalid chars, so a length
  // mismatch here catches malformed signatures.
  if (sigBuf.length !== expectedBuf.length) return false
  return timingSafeEqual(sigBuf, expectedBuf)
}

export async function proxy(request: NextRequest) {
  const cookie = request.cookies.get('merkury_auth')
  const secret = process.env.AUTH_COOKIE_SECRET

  // Fail closed: if the secret is missing or the signature doesn't match,
  // bounce to /login. (Proxy runs on the Node.js runtime in Next 16, so
  // node:crypto is available here.)
  const isValid = !!(cookie?.value && secret && verifySession(cookie.value, secret))

  if (!isValid) {
    const loginUrl = new URL('/login', request.url)
    // Preserve where they were trying to go, so we can bounce them back
    // after a successful login.
    const target = request.nextUrl.pathname + request.nextUrl.search
    if (target && target !== '/') {
      loginUrl.searchParams.set('next', target)
    }
    return NextResponse.redirect(loginUrl)
  }

  return NextResponse.next()
}

// Match every page route EXCEPT:
//   - /login (the login page itself)
//   - /api/login and /api/logout (the auth endpoints)
//   - /_next/* (Next.js internals: static files, image optimization, HMR)
//   - Static asset extensions (favicon, images, fonts)
//
// If you add a new public route in the future, add it to the negative
// lookahead below.
export const config = {
  matcher: [
    '/((?!login|api/login|api/logout|_next/static|_next/image|favicon\\.ico|.*\\.(?:png|jpg|jpeg|svg|gif|webp|ico|woff|woff2|ttf|otf)$).*)',
  ],
}
