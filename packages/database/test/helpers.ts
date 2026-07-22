/**
 * Shared setup for the database suite.
 *
 * These tests run against a real Postgres — the schema's guarantees are row
 * locks, unique indexes and RLS policies, none of which a mock can reproduce.
 * `docker compose up db` (or the container described in docs/local-development.md)
 * provides one; `TEST_DATABASE_URL` points at it.
 */
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { migrate } from '../src/migrate.js';

const { Pool } = pg;

export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  'postgresql://postgres:postgres@127.0.0.1:55432/mcp_upgrade_test';

let sharedPool: pg.Pool | null = null;

export async function testPool(): Promise<pg.Pool> {
  if (sharedPool) return sharedPool;
  sharedPool = new Pool({ connectionString: TEST_DATABASE_URL, max: 16, ssl: false });
  await migrate({ pool: sharedPool });
  return sharedPool;
}

export async function closeTestPool(): Promise<void> {
  if (!sharedPool) return;
  const current = sharedPool;
  sharedPool = null;
  await current.end();
}

/** Removes every row this suite could have written, leaving the schema intact. */
export async function truncateAll(pool: pg.Pool): Promise<void> {
  await pool.query(`
    truncate
      public.usage_events,
      public.usage_counters,
      public.scan_reports,
      public.scan_jobs,
      public.submission_throttle,
      public.stripe_events,
      public.subscriptions,
      public.profiles
    restart identity cascade
  `);
  await pool.query('delete from auth.users');
}

export interface TestUser {
  id: string;
  email: string;
}

/**
 * Creates an auth user and lets the production trigger create the profile.
 *
 * Going through the trigger rather than inserting a profile directly means the
 * suite exercises the same provisioning path a real sign-up takes.
 */
export async function createUser(pool: pg.Pool, label = 'user'): Promise<TestUser> {
  const id = randomUUID();
  const email = `${label}-${id.slice(0, 8)}@example.test`;
  await pool.query(
    `insert into auth.users (id, email, raw_user_meta_data, email_confirmed_at)
     values ($1, $2, $3::jsonb, now())`,
    [id, email, JSON.stringify({ display_name: label })],
  );
  return { id, email };
}

/**
 * Runs a query as the `authenticated` PostgREST role, impersonating a user.
 *
 * This is how Supabase's API server executes a request: the role is
 * `authenticated` and `request.jwt.claims` carries the verified subject. Tests
 * that assert isolation must go through this path, because our own service
 * connection owns the tables and bypasses RLS entirely.
 */
export async function asUser<T extends pg.QueryResultRow = pg.QueryResultRow>(
  pool: pg.Pool,
  userId: string | null,
  sql: string,
  params: readonly unknown[] = [],
): Promise<pg.QueryResult<T>> {
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query("select set_config('role', 'authenticated', true)");
    await client.query("select set_config('request.jwt.claims', $1, true)", [
      JSON.stringify({ sub: userId, role: 'authenticated' }),
    ]);
    const result = await client.query<T>(sql, params as unknown[]);
    await client.query('commit');
    return result;
  } catch (error) {
    await client.query('rollback').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/** Runs a query as the anonymous PostgREST role. */
export async function asAnon<T extends pg.QueryResultRow = pg.QueryResultRow>(
  pool: pg.Pool,
  sql: string,
  params: readonly unknown[] = [],
): Promise<pg.QueryResult<T>> {
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query("select set_config('role', 'anon', true)");
    const result = await client.query<T>(sql, params as unknown[]);
    await client.query('commit');
    return result;
  } catch (error) {
    await client.query('rollback').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export const PERIOD = '2026-07';

/** Standard arguments for `create_scan_job`, overridable per test. */
export function jobArgs(
  userId: string,
  overrides: Partial<{
    sourceType: string;
    sourceLabel: string;
    repositoryUrl: string | null;
    targetVersion: string;
    planId: string;
    priority: number;
    storageKey: string | null;
    billingPeriod: string;
    scanLimit: number;
    throttleLimit: number;
    throttleWindow: string;
  }> = {},
): unknown[] {
  return [
    userId,
    overrides.sourceType ?? 'zip',
    overrides.sourceLabel ?? 'project.zip',
    overrides.repositoryUrl ?? null,
    overrides.targetVersion ?? '2026-07-28',
    overrides.planId ?? 'free',
    overrides.priority ?? 100,
    overrides.storageKey ?? 'uploads/test.zip',
    overrides.billingPeriod ?? PERIOD,
    overrides.scanLimit ?? 2,
    overrides.throttleLimit ?? 100,
    overrides.throttleWindow ?? '1 hour',
  ];
}

export const CREATE_JOB_SQL = `
  select * from public.create_scan_job(
    $1::uuid, $2::text, $3::text, $4::text, $5::text, $6::text,
    $7::integer, $8::text, $9::text, $10::integer, $11::integer, $12::interval
  )
`;

/** A minimal report that satisfies the scan_reports constraints. */
export function minimalReport(root = 'owner/repo'): Record<string, unknown> {
  return {
    schemaVersion: '1.0',
    scannerVersion: '0.1.0',
    generatedAt: new Date(0).toISOString(),
    target: { protocolVersion: '2026-07-28', status: 'release-candidate', baselineVersion: '2025-11-25' },
    scanStatus: 'complete',
    issues: [],
    repository: { root },
    summary: {
      filesDiscovered: 0,
      filesScanned: 0,
      filesSkipped: 0,
      filesRequiringChanges: 0,
      counts: { error: 0, warning: 0, review: 0, info: 0 },
      byRule: {},
      readiness: { score: 100, deductions: [], explanation: '100 = 100', disclaimer: 'x' },
      effort: { items: [], minHours: 0, maxHours: 0, excludes: [] },
      appsReadiness: 'NO_SIGNAL',
      commentOnlyMatches: 0,
    },
    findings: [],
    files: [],
  };
}
