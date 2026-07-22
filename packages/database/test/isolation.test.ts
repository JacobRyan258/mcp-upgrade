/**
 * Row level security.
 *
 * Supabase publishes this database through an internet-facing PostgREST
 * endpoint. Anyone who has the anon key — which ships in the browser bundle by
 * design — can issue arbitrary reads against it. These tests are the proof that
 * doing so returns nothing that does not belong to the caller.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type pg from 'pg';
import {
  CREATE_JOB_SQL,
  asAnon,
  asUser,
  closeTestPool,
  createUser,
  jobArgs,
  minimalReport,
  testPool,
  truncateAll,
  type TestUser,
} from './helpers.js';

let pool: pg.Pool;
let alice: TestUser;
let mallory: TestUser;
let aliceJobId: string;

beforeAll(async () => {
  pool = await testPool();
});

afterAll(async () => {
  await closeTestPool();
});

beforeEach(async () => {
  await truncateAll(pool);
  alice = await createUser(pool, 'alice');
  mallory = await createUser(pool, 'mallory');

  const created = await pool.query<{ outcome: string; job_id: string }>(
    CREATE_JOB_SQL,
    jobArgs(alice.id, { sourceLabel: 'alice-secret-project.zip' }),
  );
  expect(created.rows[0]?.outcome).toBe('created');
  aliceJobId = created.rows[0]!.job_id;

  await pool.query(
    `insert into public.scan_reports
       (scan_job_id, user_id, schema_version, readiness_score, report)
     values ($1, $2, '1.0', 90, $3::jsonb)`,
    [aliceJobId, alice.id, JSON.stringify(minimalReport())],
  );
  await pool.query(
    `insert into public.subscriptions (user_id, stripe_customer_id, stripe_subscription_id, status)
     values ($1, 'cus_alice', 'sub_alice', 'active')`,
    [alice.id],
  );
});

describe('the profile trigger provisions every auth user', () => {
  it('creates exactly one profile per auth user', async () => {
    const result = await pool.query<{ count: string }>(
      'select count(*)::text as count from public.profiles where id = $1',
      [alice.id],
    );
    expect(result.rows[0]?.count).toBe('1');
  });

  it('carries the display name through from user metadata', async () => {
    const result = await pool.query<{ display_name: string | null; email: string }>(
      'select display_name, email from public.profiles where id = $1',
      [alice.id],
    );
    expect(result.rows[0]?.display_name).toBe('alice');
    expect(result.rows[0]?.email).toBe(alice.email);
  });
});

describe('an authenticated user sees only their own rows', () => {
  it('reads their own profile and no one else’s', async () => {
    const rows = await asUser(pool, alice.id, 'select id from public.profiles');
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]).toMatchObject({ id: alice.id });
  });

  it('cannot read another user’s scan jobs, even by explicit id', async () => {
    const all = await asUser(pool, mallory.id, 'select id from public.scan_jobs');
    expect(all.rows).toHaveLength(0);

    const targeted = await asUser(pool, mallory.id, 'select id from public.scan_jobs where id = $1', [
      aliceJobId,
    ]);
    expect(targeted.rows).toHaveLength(0);
  });

  it('cannot read another user’s report contents', async () => {
    const rows = await asUser(
      pool,
      mallory.id,
      'select report from public.scan_reports where scan_job_id = $1',
      [aliceJobId],
    );
    expect(rows.rows).toHaveLength(0);
  });

  it('cannot read another user’s subscription or billing identifiers', async () => {
    const rows = await asUser(pool, mallory.id, 'select stripe_customer_id from public.subscriptions');
    expect(rows.rows).toHaveLength(0);
  });

  it('cannot read another user’s usage', async () => {
    const counters = await asUser(pool, mallory.id, 'select used from public.usage_counters');
    expect(counters.rows).toHaveLength(0);
    const events = await asUser(pool, mallory.id, 'select quantity from public.usage_events');
    expect(events.rows).toHaveLength(0);
  });

  it('sees its own rows through the same policies', async () => {
    const jobs = await asUser(pool, alice.id, 'select id from public.scan_jobs');
    expect(jobs.rows).toHaveLength(1);
    const reports = await asUser(pool, alice.id, 'select scan_job_id from public.scan_reports');
    expect(reports.rows).toHaveLength(1);
    const subs = await asUser(pool, alice.id, 'select status from public.subscriptions');
    expect(subs.rows).toHaveLength(1);
  });
});

describe('no client role may write anything', () => {
  const writes: Array<{ label: string; sql: string; params: () => unknown[] }> = [
    {
      label: 'insert a job',
      sql: `insert into public.scan_jobs (user_id, source_type, source_label, target_version, plan_id)
            values ($1,'zip','x','2026-07-28','free')`,
      params: () => [mallory.id],
    },
    {
      label: 'insert a job attributed to someone else',
      sql: `insert into public.scan_jobs (user_id, source_type, source_label, target_version, plan_id)
            values ($1,'zip','x','2026-07-28','free')`,
      params: () => [alice.id],
    },
    { label: 'raise their own allowance', sql: 'update public.usage_counters set used = 0', params: () => [] },
    { label: 'delete their usage history', sql: 'delete from public.usage_events', params: () => [] },
    {
      label: 'grant themselves a subscription',
      sql: `update public.subscriptions set status = 'active', stripe_price_id = 'price_pro'`,
      params: () => [],
    },
    {
      label: 'insert themselves a subscription',
      sql: `insert into public.subscriptions (user_id, status, stripe_price_id)
            values ($1, 'active', 'price_pro')`,
      params: () => [mallory.id],
    },
    { label: 'tamper with a stored report', sql: 'update public.scan_reports set readiness_score = 100', params: () => [] },
    { label: 'delete a job to hide it', sql: 'delete from public.scan_jobs', params: () => [] },
    { label: 'change their own profile email', sql: `update public.profiles set email = 'x@example.test'`, params: () => [] },
  ];

  for (const { label, sql, params } of writes) {
    it(`refuses to let an authenticated user ${label}`, async () => {
      await expect(asUser(pool, mallory.id, sql, params())).rejects.toThrow(
        /permission denied|violates row-level security/i,
      );
    });
  }
});

describe('the anonymous role is blind', () => {
  for (const table of [
    'profiles',
    'subscriptions',
    'scan_jobs',
    'scan_reports',
    'usage_counters',
    'usage_events',
    'stripe_events',
    'submission_throttle',
    'schema_migrations',
  ]) {
    it(`cannot read public.${table}`, async () => {
      await expect(asAnon(pool, `select * from public.${table}`)).rejects.toThrow(
        /permission denied/i,
      );
    });
  }
});

describe('internal tables are invisible to signed-in users too', () => {
  it('hides stripe_events, submission_throttle and the migration ledger', async () => {
    for (const table of ['stripe_events', 'submission_throttle', 'schema_migrations']) {
      await expect(asUser(pool, alice.id, `select * from public.${table}`)).rejects.toThrow(
        /permission denied/i,
      );
    }
  });
});

describe('the API roles hold exactly one privilege, and only where intended', () => {
  /**
   * Grants are checked directly rather than inferred from behaviour because
   * two of the dangerous ones are invisible to a behavioural test: TRUNCATE
   * is not filtered by row level security at all, and TRIGGER only matters
   * once a caller uses it. Supabase grants both by default on every new table
   * in `public`, so this assertion is what proves the migration took them back.
   */
  it('gives authenticated only SELECT on the user-facing tables', async () => {
    const result = await pool.query<{ table_name: string; privs: string }>(
      `select table_name, string_agg(privilege_type, ',' order by privilege_type) as privs
         from information_schema.role_table_grants
        where table_schema = 'public' and grantee = 'authenticated'
        group by table_name order by table_name`,
    );
    expect(result.rows).toEqual([
      { table_name: 'profiles', privs: 'SELECT' },
      { table_name: 'scan_jobs', privs: 'SELECT' },
      { table_name: 'scan_reports', privs: 'SELECT' },
      { table_name: 'subscriptions', privs: 'SELECT' },
      { table_name: 'usage_counters', privs: 'SELECT' },
      { table_name: 'usage_events', privs: 'SELECT' },
    ]);
  });

  it('gives anon no privileges on anything in public', async () => {
    const result = await pool.query<{ count: string }>(
      `select count(*)::text as count from information_schema.role_table_grants
        where table_schema = 'public' and grantee = 'anon'`,
    );
    expect(result.rows[0]?.count).toBe('0');
  });

  it('never grants TRUNCATE, TRIGGER or REFERENCES to an API role', async () => {
    const result = await pool.query<{ grantee: string; table_name: string; privilege_type: string }>(
      `select grantee, table_name, privilege_type from information_schema.role_table_grants
        where table_schema = 'public'
          and grantee in ('anon', 'authenticated')
          and privilege_type in ('TRUNCATE', 'TRIGGER', 'REFERENCES')`,
    );
    expect(result.rows).toEqual([]);
  });
});

describe('privileged functions are not reachable as RPC', () => {
  const functions: Array<[string, string, unknown[]]> = [
    ['create_scan_job', CREATE_JOB_SQL, []],
    ['claim_scan_job', 'select * from public.claim_scan_job($1::text)', ['attacker']],
    ['release_scan_allowance', 'select public.release_scan_allowance($1::uuid)', []],
    ['fail_scan_job', 'select public.fail_scan_job($1::uuid, $2::text)', []],
    ['reap_stale_scan_jobs', 'select public.reap_stale_scan_jobs($1::interval)', ['1 minute']],
  ];

  for (const [name, sql, params] of functions) {
    it(`refuses ${name} to an authenticated caller`, async () => {
      const args =
        name === 'create_scan_job'
          ? jobArgs(alice.id)
          : name === 'fail_scan_job'
            ? [aliceJobId, 'scan_failed']
            : name === 'release_scan_allowance'
              ? [aliceJobId]
              : params;
      await expect(asUser(pool, alice.id, sql, args)).rejects.toThrow(/permission denied/i);
    });
  }
});

describe('a null or forged subject grants nothing', () => {
  it('returns no rows when the JWT carries no subject', async () => {
    const rows = await asUser(pool, null, 'select id from public.scan_jobs');
    expect(rows.rows).toHaveLength(0);
  });

  it('returns no rows for a subject that is not a real user', async () => {
    const rows = await asUser(
      pool,
      '00000000-0000-4000-8000-000000000000',
      'select id from public.scan_jobs',
    );
    expect(rows.rows).toHaveLength(0);
  });
});
