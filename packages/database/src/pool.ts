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

/**
 * The statement timeout the active pool was built with. `withTransaction` reads
 * it so a transaction gets the same server-side cap the pool promised, without
 * every call site having to thread the number through. Defaults to the same
 * 20s used by `getPool` so a bare `withTransaction(fn, somePool)` still applies
 * a bound.
 */
let configuredStatementTimeoutMs = 20_000;

export interface PoolOptions {
  connectionString?: string;
  /** Maximum pooled connections. Keep low on serverless platforms. */
  max?: number;
  /**
   * Milliseconds a query may run before it is stopped. Enforced two ways that
   * are both safe on Supabase's transaction pooler: a client-side
   * `query_timeout` on the pool, and a transaction-scoped `SET LOCAL
   * statement_timeout` inside `withTransaction`. It is deliberately NOT passed
   * to `pg` as `statement_timeout`, which pg would put in the startup packet —
   * the transaction pooler rejects that with
   * `unsupported startup parameter: statement_timeout`.
   */
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
 * Three inputs, in priority order, so an operator can always be explicit and
 * the default is never surprising:
 *
 *   1. `sslmode=` in the connection string wins outright — `pg` parses it and
 *      this function stays out of the way. This is the documented way to be
 *      unambiguous.
 *   2. `DATABASE_SSL` overrides the default: `disable`, `require` (verify the
 *      chain) or `no-verify`.
 *   3. Otherwise it is inferred from the host. A loopback or private address is
 *      a database on a network we already control — a Compose service, a
 *      private VPC, a CI service container — and those almost never terminate
 *      TLS, so SSL is off. Anything reachable over the public internet gets TLS.
 *
 * The earlier version inferred only from loopback, which meant a worker talking
 * to Postgres over a Docker bridge or a private VPC address tried to negotiate
 * TLS against a server that does not speak it, and every connection failed.
 *
 * The public default is `rejectUnauthorized: false` because managed providers
 * commonly present a chain Node does not trust out of the box. It is scoped to
 * this pool rather than set globally, so no other outbound TLS in the process is
 * weakened, and `DATABASE_SSL=require` opts into full verification.
 */
export function resolveSslConfig(
  connectionString: string,
  mode: string | undefined = process.env.DATABASE_SSL,
): pg.PoolConfig['ssl'] {
  if (/[?&]sslmode=/.test(connectionString)) return undefined;

  const explicit = mode?.trim().toLowerCase();
  if (explicit === 'disable' || explicit === 'false' || explicit === 'off') return false;
  if (explicit === 'require' || explicit === 'verify-full') return { rejectUnauthorized: true };
  if (explicit === 'no-verify') return { rejectUnauthorized: false };

  return isPrivateHost(hostOf(connectionString)) ? false : { rejectUnauthorized: false };
}

/** Extracts the host from a connection string, tolerating a malformed one. */
export function hostOf(connectionString: string): string {
  try {
    return new URL(connectionString).hostname.replace(/^\[|\]$/g, '');
  } catch {
    return '';
  }
}

/**
 * True for addresses that are, by construction, on a network we control:
 * loopback, RFC1918, carrier-grade NAT, link-local, IPv6 unique-local, and
 * bare hostnames with no dot (a Compose or Kubernetes service name).
 */
export function isPrivateHost(host: string): boolean {
  if (host === '') return false;
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (host === '::1' || host.toLowerCase().startsWith('fe80') || /^f[cd]/i.test(host)) return true;

  const parts = host.split('.');
  const numeric = parts.length === 4 && parts.every((part) => /^\d{1,3}$/.test(part));
  if (numeric) {
    const [a = 0, b = 0] = parts.map(Number);
    if (a === 127 || a === 10 || a === 0) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 169 && b === 254) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    return false;
  }

  // A single-label host resolves only inside a container network or a search
  // domain, so it is not something reachable from the public internet.
  return !host.includes('.');
}

export function getPool(options: PoolOptions = {}): pg.Pool {
  if (pool) return pool;
  const connectionString = readConnectionString(options.connectionString);
  const statementTimeout = options.statementTimeoutMs ?? 20_000;
  configuredStatementTimeoutMs = statementTimeout;
  pool = new Pool({
    connectionString,
    ssl: resolveSslConfig(connectionString),
    max: options.max ?? 8,
    connectionTimeoutMillis: options.connectionTimeoutMs ?? 10_000,
    idleTimeoutMillis: 30_000,
    // Client-side read timeout. pg enforces this itself and tears the socket
    // down if a query outruns it, so a runaway query cannot pin a pooled
    // connection forever. Crucially it is NOT a Postgres startup parameter, so
    // it is accepted by every pooler mode — including Supabase's transaction
    // pooler, which rejects a `statement_timeout` startup parameter outright.
    // The matching server-side cap is applied per transaction in
    // `withTransaction` via `SET LOCAL`, which the pooler also accepts.
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
  options: { statementTimeoutMs?: number } = {},
): Promise<T> {
  const client = await (poolOverride ?? getPool()).connect();
  const timeoutMs = options.statementTimeoutMs ?? configuredStatementTimeoutMs;
  try {
    await client.query('begin');
    // Server-side cancellation, scoped to THIS transaction. `SET LOCAL` reverts
    // at commit/rollback, so on the transaction pooler it never leaks onto the
    // next borrower of a multiplexed connection — the reason a bare `SET` (or a
    // startup-level `statement_timeout`) is unsafe there. The value is an
    // integer we control; `SET` cannot be parameterised, so it is floored to an
    // integer before interpolation to keep it injection-proof.
    if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
      await client.query(`set local statement_timeout = ${Math.floor(timeoutMs)}`);
    }
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
