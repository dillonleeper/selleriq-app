import { NextResponse } from 'next/server'
import { cookies } from 'next/headers'

/**
 * Clears the auth cookie. Called by the logout button in the sidebar.
 *
 * Accepts POST only — GET would let any link or image silently log
 * the user out (CSRF). Browsers don't send custom Content-Type on
 * cross-origin POSTs without a preflight, so this is enough for our
 * shared-password gate.
 */
export async function POST() {
  const cookieStore = await cookies()
  cookieStore.set('merkury_auth', '', {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: 0,
  })
  return NextResponse.json({ ok: true })
}
