/**
 * Allowance reads.
 *
 * The write path lives entirely in `create_scan_job` and
 * `release_scan_allowance`; nothing here can move a counter. That separation is
 * intentional — there is exactly one place in the system that increments usage,
 * and it does so atomically.
 */
import type pg from 'pg';
import { query } from './pool.js';

export interface UsageSnapshot {
  billingPeriod: string;
  used: number;
  limit: number;
  remaining: number;
  /** ISO timestamp when the allowance resets. */
  resetsAt: string;
}

export async function getUsage(
  userId: string,
  billingPeriod: string,
  limit: number,
  resetsAt: Date,
  pool?: pg.Pool,
): Promise<UsageSnapshot> {
  const result = await query<{ used: number }>(
    'select used from public.usage_counters where user_id = $1 and billing_period = $2',
    [userId, billingPeriod],
    pool,
  );
  const used = result.rows[0]?.used ?? 0;
  return {
    billingPeriod,
    used,
    limit,
    remaining: Math.max(0, limit - used),
    resetsAt: resetsAt.toISOString(),
  };
}

/** Refunds a reservation. Idempotent; returns true only for the first call. */
export async function releaseAllowance(jobId: string, pool?: pg.Pool): Promise<boolean> {
  const result = await query<{ release_scan_allowance: boolean }>(
    'select public.release_scan_allowance($1::uuid)',
    [jobId],
    pool,
  );
  return result.rows[0]?.release_scan_allowance ?? false;
}

export interface ProfileRecord {
  id: string;
  email: string;
  displayName: string | null;
  createdAt: Date;
}

export async function getProfile(userId: string, pool?: pg.Pool): Promise<ProfileRecord | null> {
  const result = await query<{
    id: string;
    email: string;
    display_name: string | null;
    created_at: Date;
  }>(
    'select id, email, display_name, created_at from public.profiles where id = $1',
    [userId],
    pool,
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    id: row.id,
    email: row.email,
    displayName: row.display_name,
    createdAt: row.created_at,
  };
}

/**
 * Creates the profile row if the auth trigger has not run yet.
 *
 * Supabase's trigger fires on user creation, but a project restored from a
 * backup or a user created before this schema existed would have no row. The
 * web app calls this once per authenticated session so a missing profile can
 * never block a signed-in user.
 */
export async function ensureProfile(
  userId: string,
  email: string,
  displayName: string | null,
  pool?: pg.Pool,
): Promise<void> {
  await query(
    `insert into public.profiles (id, email, display_name)
     values ($1, $2, $3)
     on conflict (id) do update
        set email = excluded.email
      where public.profiles.email is distinct from excluded.email`,
    [userId, email, displayName],
    pool,
  );
}

export async function updateDisplayName(
  userId: string,
  displayName: string | null,
  pool?: pg.Pool,
): Promise<void> {
  await query('update public.profiles set display_name = $2 where id = $1', [
    userId,
    displayName,
  ], pool);
}
