'use client';

/**
 * Browser Supabase client.
 *
 * Uses the anon key, which is designed to be public: every query it can make is
 * constrained by row level security. The service-role key must never appear in
 * this file or anything it imports.
 */
import { createBrowserClient } from '@supabase/ssr';
import type { SupabaseClient } from '@supabase/supabase-js';

let cached: SupabaseClient | null = null;

export function getBrowserClient(): SupabaseClient {
  if (cached) return cached;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) {
    throw new Error('Supabase public configuration is missing.');
  }
  cached = createBrowserClient(url, key);
  return cached;
}
