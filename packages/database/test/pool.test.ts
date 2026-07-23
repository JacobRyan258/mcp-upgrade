/**
 * Pool construction and per-transaction timeout policy.
 *
 * These are unit tests: constructing a `pg.Pool` does not open a socket, so no
 * database is required. They exist because a real deployment defect shipped —
 * the pool sent `statement_timeout` as a *startup parameter*, and Supabase's
 * transaction pooler (port 6543) rejects it with
 *   `unsupported startup parameter: statement_timeout`
 * which took down every database-backed request on the serverless web app.
 *
 * The policy the tests pin down:
 *   - never pass `statement_timeout` to the `pg.Pool` constructor (pg would put
 *     it in the startup packet, which the transaction pooler refuses);
 *   - keep the client-side `query_timeout` (pg enforces it in the client, so it
 *     is never sent to the server and works on every pooler mode);
 *   - apply a server-side statement timeout per transaction with `SET LOCAL`,
 *     which is scoped to the transaction and therefore safe on a multiplexed
 *     transaction-pooler connection.
 */
import { describe, expect, it, afterEach } from 'vitest';
import type pg from 'pg';
import { closePool, getPool, setPool, withTransaction } from '../src/pool.js';

const DIRECT = 'postgresql://postgres:pw@db.zzlbenmmsjumysqptnhi.supabase.co:5432/postgres';
const SESSION_POOLER =
  'postgresql://postgres.zzlbenmmsjumysqptnhi:pw@aws-0-us-east-1.pooler.supabase.com:5432/postgres';
const TXN_POOLER =
  'postgresql://postgres.zzlbenmmsjumysqptnhi:pw@aws-0-us-east-1.pooler.supabase.com:6543/postgres';

afterEach(async () => {
  await closePool();
});

describe('getPool startup parameters', () => {
  for (const [label, url] of [
    ['direct', DIRECT],
    ['session pooler', SESSION_POOLER],
    ['transaction pooler', TXN_POOLER],
  ] as const) {
    it(`never sends statement_timeout as a startup parameter (${label})`, () => {
      const pool = getPool({ connectionString: url });
      // pg copies constructor config onto pool.options and, when
      // statement_timeout is present, puts it in the StartupMessage. Its absence
      // here is what keeps the transaction pooler from rejecting the connection.
      expect(pool.options.statement_timeout).toBeUndefined();
      expect(pool.options.idle_in_transaction_session_timeout).toBeUndefined();
    });

    it(`keeps a client-side query_timeout (${label})`, () => {
      const pool = getPool({ connectionString: url, statementTimeoutMs: 12_345 });
      expect(pool.options.query_timeout).toBe(12_345);
      expect(pool.options.statement_timeout).toBeUndefined();
    });

    it(`enables TLS for the public Supabase host (${label})`, () => {
      const pool = getPool({ connectionString: url });
      expect(pool.options.ssl).toEqual({ rejectUnauthorized: false });
    });
  }

  it('defaults the client-side query_timeout to 20s', () => {
    const pool = getPool({ connectionString: TXN_POOLER });
    expect(pool.options.query_timeout).toBe(20_000);
  });
});

/** A pool stub that records the SQL a transaction runs, no socket involved. */
function recordingPool(): { pool: pg.Pool; queries: string[] } {
  const queries: string[] = [];
  const client = {
    query: async (text: string) => {
      queries.push(text);
      return { rows: [], rowCount: 0 };
    },
    release: () => undefined,
  };
  const pool = { connect: async () => client } as unknown as pg.Pool;
  return { pool, queries };
}

describe('withTransaction statement timeout', () => {
  it('sets a transaction-scoped statement_timeout right after BEGIN', async () => {
    const { pool, queries } = recordingPool();
    await withTransaction(async (tx) => {
      await tx.query('select 1');
    }, pool);
    expect(queries[0]).toBe('begin');
    expect(queries[1]).toBe('set local statement_timeout = 20000');
    expect(queries).toContain('select 1');
    expect(queries[queries.length - 1]).toBe('commit');
  });

  it('honours an explicit per-transaction timeout', async () => {
    const { pool, queries } = recordingPool();
    await withTransaction(
      async (tx) => {
        await tx.query('select 1');
      },
      pool,
      { statementTimeoutMs: 45_000 },
    );
    expect(queries[1]).toBe('set local statement_timeout = 45000');
  });

  it('omits the SET when the timeout is disabled with 0', async () => {
    const { pool, queries } = recordingPool();
    await withTransaction(
      async (tx) => {
        await tx.query('select 1');
      },
      pool,
      { statementTimeoutMs: 0 },
    );
    expect(queries).not.toContain('set local statement_timeout = 0');
    expect(queries[0]).toBe('begin');
    expect(queries[1]).toBe('select 1');
  });

  it('rolls back without leaking a session-level timeout on error', async () => {
    const { pool, queries } = recordingPool();
    await expect(
      withTransaction(async () => {
        throw new Error('boom');
      }, pool),
    ).rejects.toThrow('boom');
    expect(queries).toEqual(['begin', 'set local statement_timeout = 20000', 'rollback']);
  });

  afterEach(() => {
    setPool(null);
  });
});
