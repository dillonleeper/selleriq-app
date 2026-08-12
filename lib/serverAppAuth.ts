import { createHmac, timingSafeEqual } from 'crypto'
import { cookies } from 'next/headers'

export async function hasValidAppSession(): Promise<boolean> {
  const secret = process.env.AUTH_COOKIE_SECRET
  const value = (await cookies()).get('merkury_auth')?.value
  if (!secret || !value) return false

  const lastDot = value.lastIndexOf('.')
  if (lastDot < 0) return false
  const payload = value.slice(0, lastDot)
  const signature = value.slice(lastDot + 1)
  const expected = createHmac('sha256', secret).update(payload).digest('hex')
  const actualBuffer = Buffer.from(signature, 'hex')
  const expectedBuffer = Buffer.from(expected, 'hex')
  return actualBuffer.length === expectedBuffer.length
    && timingSafeEqual(actualBuffer, expectedBuffer)
}

export function isSameOrigin(request: Request): boolean {
  const origin = request.headers.get('origin')
  if (!origin) return true
  try {
    return new URL(origin).host === new URL(request.url).host
  } catch {
    return false
  }
}
