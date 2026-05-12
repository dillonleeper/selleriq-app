import { NextResponse } from 'next/server'
import { cookies } from 'next/headers'
import { createHmac, timingSafeEqual } from 'crypto'

// 1 day in seconds — matches the cookie Max-Age.
const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24

/**
 * Build a signed cookie value: "<payload>.<hmac>"
 *
 * Payload is just a fixed string ("ok") plus the issue timestamp, so the
 * cookie is single-purpose: prove you logged in. We sign it with
 * AUTH_COOKIE_SECRET so users can't forge the cookie themselves.
 */
function signSession(secret: string): string {
  const payload = `ok.${Date.now()}`
  const hmac = createHmac('sha256', secret).update(payload).digest('hex')
  return `${payload}.${hmac}`
}

export async function POST(request: Request) {
  const expectedPassword = process.env.AUTH_PASSWORD
  const cookieSecret = process.env.AUTH_COOKIE_SECRET

  if (!expectedPassword || !cookieSecret) {
    // Config error, not a user error — fail loudly so this gets fixed.
    console.error('AUTH_PASSWORD or AUTH_COOKIE_SECRET is not set')
    return NextResponse.json(
      { error: 'Server is not configured for authentication.' },
      { status: 500 },
    )
  }

  let submittedPassword: string
  try {
    const body = await request.json()
    submittedPassword = String(body?.password ?? '')
  } catch {
    return NextResponse.json({ error: 'Invalid request.' }, { status: 400 })
  }

  // Constant-time comparison so an attacker can't measure response time
  // to learn the password byte-by-byte. The lengths still leak, so we
  // pad to the same length first.
  const submittedBuf = Buffer.from(submittedPassword)
  const expectedBuf = Buffer.from(expectedPassword)
  const lengthsMatch = submittedBuf.length === expectedBuf.length
  // Use a fixed-length buffer for the comparison even if lengths differ,
  // so timingSafeEqual doesn't throw.
  const compareLen = Math.max(submittedBuf.length, expectedBuf.length, 1)
  const submittedPadded = Buffer.alloc(compareLen)
  const expectedPadded = Buffer.alloc(compareLen)
  submittedBuf.copy(submittedPadded)
  expectedBuf.copy(expectedPadded)
  const contentsMatch = timingSafeEqual(submittedPadded, expectedPadded)

  if (!lengthsMatch || !contentsMatch) {
    return NextResponse.json({ error: 'Incorrect password.' }, { status: 401 })
  }

  // Set the signed cookie. Next.js 16: cookies() is async.
  const cookieStore = await cookies()
  cookieStore.set('merkury_auth', signSession(cookieSecret), {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: SESSION_MAX_AGE_SECONDS,
  })

  return NextResponse.json({ ok: true })
}
