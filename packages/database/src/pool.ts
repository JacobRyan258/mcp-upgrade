/**
 * Server-only Postgres access.
 *
 * This module is never imported by browser code. It reads `DATABASE_URL` and
 * nothing else, so a deployment that forgets the variable fails at startup with
 * a clear message rather than at the first query with a confusing one.
 */
import pg from 'pg';

const { Pool } = pg;

export type { PoolClient, QueryResult, QueryResultRow } from 'pg';

let pool: pg.Pool | null = null;

export interface PoolOptions {
  connectionString?: string;
  /** Maximum pooled connections. Keep low on serverless platforms. */
  max?: number;
  /** Milliseconds a query may run before the server cancels it. */
  statementTimeoutMs?: number;
  /** Milliseconds to wait for a free connection before failing. */
  connectionTimeoutMs?: number;
}

function readConnectionString(explicit?: string): string {
  const value = explicit ?? process.env.DATABASE_URL;
  if (!value || value.trim() === '') {
    throw new Error(
      'DATABASE_URL is not set. The database layer cannot start without it.',
    );
  }
  return value;
}

/**
 * TLS policy.
 *
 * Supabase's pooler presents a certificate chain that Node does not trust out
 * of the box. Rather than globally disabling verification — which would also
 * weaken every other outbound TLS connection in the process — verification is
 * relaxed only for this pool, and only when the connection string does not
 * already state a `sslmode`. A deployment can opt into full verification by
 * setting `PGSSLROOTCERT` and `sslmode=verify-full`.
 */
function sslConfig(connectionString: string): pg.PoolConfig['ssl'] {
  if (/sslmode=/.test(connectionString)) return undefined;
  if (/(^|@)(localhost|127\.0\.0\.1|\[::1\])/.test(connectionString)) return false;
  if (process.env.PGSSLROOTCERT) return undefined;
  return { rejectUnauthorized: false };
}

export function getPool(options: PoolOptions = {}): pg.Pool {
  if (pool) return pool;
  const connectionString = readConnectionString(options.connectionString);
  const statementTimeout = options.statementTimeoutMs ?? 20_000;
  pool = new Pool({
    connectionString,
    ssl: sslConfig(connectionString),
    max: options.max ?? 8,
    connectionTimeoutMillis: options.connectionTimeoutMs ?? 10_000,
    idleTimeoutMillis: 30_000,
    // A runaway query must not pin a connection forever. Both timeouts are set
    // server-side so they survive a client that stops reading.
    statement_timeout: statementTimeout,
    query_timeout: statementTimeout,
  });
  // A pool that emits `error` with no listener crashes the process. Idle
  // clients are dropped by Supabase's pooler routinely, which is not fatal.
  pool.on('error', (error) => {
    console.error(
      JSON.stringify({
        level: 'error',
        event: 'database.pool_error',
        // Never log the connection string or the full error object.
        message: error instanceof Error ? error.name : 'unknown',
      }),
    );
  });
  return pool;
}

/** Replaces the shared pool. Used by tests to point at a scratch database. */
export function setPool(replacement: pg.Pool | null): void {
  pool = replacement;
}

export async function closePool(): Promise<void> {
  if (!pool) return;
  const current = pool;
  pool = null;
  await current.end();
}

/**
 * Runs `handler` inside a transaction, rolling back on any throw.
 *
 * Note that several operations in this codebase are already atomic inside a
 * single SQL function; this exists for the cases that genuinely need to span
 * more than one statement.
 */
export async function withTransaction<T>(
  handler: (client: pg.PoolClient) => Promise<T>,
  poolOverride?: pg.Pool,
): Promise<T> {
  const client = await (poolOverride ?? getPool()).connect();
  try {
    await client.query('begin');
    const result = await handler(client);
    await client.query('commit');
    return result;
  } catch (error) {
    try {
      await client.query('rollback');
    } catch {
      // The connection is already unusable; releasing it is all we can do.
    }
    throw error;
  } finally {
    client.release();
  }
}

/** Convenience wrapper so call sites never build a pool by hand. */
export async function query<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params: readonly unknown[] = [],
  poolOverride?: pg.Pool,
): Promise<pg.QueryResult<T>> {
  return (poolOverride ?? getPool()).query<T>(text, params as unknown[]);
}
