import { createClient } from '@supabase/supabase-js'

/** Server-side Supabase client (service-role). Only call from API routes / server actions. */
export function createServerSupabase() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) {
    throw new Error('Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY env vars')
  }
  return createClient(url, key, { auth: { persistSession: false } })
}
