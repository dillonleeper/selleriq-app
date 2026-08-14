import { createClient } from '@supabase/supabase-js'

export function createSupabaseAdmin() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  // sb_secret_... key. Named for the key itself, not the `service_role` Postgres role it
  // resolves to -- the legacy SUPABASE_SERVICE_ROLE_KEY name belonged to the old JWT keys.
  const secretKey = process.env.SUPABASE_SECRET_KEY
  if (!url || !secretKey) {
    throw new Error('SUPABASE_SECRET_KEY is not configured on the server.')
  }
  return createClient(url, secretKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  })
}
