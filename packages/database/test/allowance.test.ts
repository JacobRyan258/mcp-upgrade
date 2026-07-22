/**
 * Allowance enforcement, queue mechanics and idempotency.
 *
 * The properties under test here are all properties of Postgres row locking and
 * unique indexes, so they are exercised against a real database with genuinely
 * concurrent connections. A sequential test would pass against an
 * implementation that has a race.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type pg from 'pg';
import {
  CREATE_JOB_SQL,
  PERIOD,
  closeTestPool,
  createUser,
  jobArgs,
  minimalReport,
  testPool,
  truncateAll,
  type TestUser,
} from './helpers.js';
import { completeScanJob, claimScanJob, failScanJob, reapStaleJobs } from '../src/jobs.js';
import { applySubscription, claimStripeEvent, findUserByStripeCustomer, linkStripeCustomer } from '../src/billing.js';
import { getUsage, releaseAllowance } from '../src/usage.js';

let pool: pg.Pool;
let user: TestUser;
let other: TestUser;

beforeAll(async () => {
  pool = await testPool();
});

afterAll(async () => {
  await closeTestPool();
});

beforeEach(async () => {
  await truncateAll(pool);
  user = await createUser(pool, 'owner');
  other = await createUser(pool, 'other');
});

async function submit(overrides: Parameters<typeof jobArgs>[1] = {}, who = user.id) {
  const result = await pool.query<{ outcome: string; job_id: string | null; used: number | null }>(
    CREATE_JOB_SQL,
    jobArgs(who, overrides),
  );
  return result.rows[0]!;
}

async function usedCount(who = user.id): Promise<number> {
  const result = await pool.query<{ used: number }>(
    'select used from public.usage_counters where user_id = $1 and billing_period = $2',
    [who, PERIOD],
  );
  return result.rows[0]?.used ?? 0;
}

describe('allowance is consumed exactly once per accepted job', () => {
  it('accepts up to the limit and then refuses', async () => {
    expect((await submit({ scanLimit: 2 })).outcome).toBe('created');
    expect((await submit({ scanLimit: 2 })).outcome).toBe('created');

    const third = await submit({ scanLimit: 2 });
    expect(third.outcome).toBe('limit_reached');
    expect(third.job_id).toBeNull();
    expect(third.used).toBe(2);
    expect(await usedCount()).toBe(2);
  });

  it('writes no job row at all when the limit is reached', async () => {
    await submit({ scanLimit: 1 });
    await submit({ scanLimit: 1 });
    const jobs = await pool.query('select id from public.scan_jobs where user_id = $1', [user.id]);
    expect(jobs.rows).toHaveLength(1);
  });

  it('keeps each user’s allowance separate', async () => {
    await submit({ scanLimit: 1 });
    expect((await submit({ scanLimit: 1 })).outcome).toBe('limit_reached');
    expect((await submit({ scanLimit: 1 }, other.id)).outcome).toBe('created');
  });

  it('keeps each billing period separate', async () => {
    await submit({ scanLimit: 1, billingPeriod: '2026-07' });
    expect((await submit({ scanLimit: 1, billingPeriod: '2026-07' })).outcome).toBe('limit_reached');
    expect((await submit({ scanLimit: 1, billingPeriod: '2026-08' })).outcome).toBe('created');
  });

  it('records a reservation audit row for every accepted job', async () => {
    const created = await submit({ scanLimit: 2 });
    const events = await pool.query<{ event_type: string; quantity: number }>(
      'select event_type, quantity from public.usage_events where scan_job_id = $1',
      [created.job_id],
    );
    expect(events.rows).toEqual([{ event_type: 'reserved', quantity: 1 }]);
  });
});

describe('concurrent submissions cannot exceed the limit', () => {
  it('admits exactly `limit` of many simultaneous requests', async () => {
    const limit = 2;
    const attempts = 25;
    const results = await Promise.all(
      Array.from({ length: attempts }, () => submit({ scanLimit: limit })),
    );
    const created = results.filter((row) => row.outcome === 'created');
    const refused = results.filter((row) => row.outcome === 'limit_reached');

    expect(created).toHaveLength(limit);
    expect(refused).toHaveLength(attempts - limit);
    expect(await usedCount()).toBe(limit);

    const jobs = await pool.query('select id from public.scan_jobs where user_id = $1', [user.id]);
    expect(jobs.rows).toHaveLength(limit);
  });

  it('holds under a higher limit and heavier concurrency', async () => {
    const limit = 10;
    const results = await Promise.all(
      Array.from({ length: 60 }, () => submit({ scanLimit: limit, throttleLimit: 1000 })),
    );
    expect(results.filter((r) => r.outcome === 'created')).toHaveLength(limit);
    expect(await usedCount()).toBe(limit);
  });

  it('does not let two users interfere with each other under concurrency', async () => {
    const both = await Promise.all([
      ...Array.from({ length: 10 }, () => submit({ scanLimit: 3 }, user.id)),
      ...Array.from({ length: 10 }, () => submit({ scanLimit: 3 }, other.id)),
    ]);
    expect(both.filter((r) => r.outcome === 'created')).toHaveLength(6);
    expect(await usedCount(user.id)).toBe(3);
    expect(await usedCount(other.id)).toBe(3);
  });
});

describe('the submission throttle bounds abuse that allowance cannot', () => {
  it('refuses submissions beyond the window limit even when allowance remains', async () => {
    const outcomes: string[] = [];
    for (let i = 0; i < 6; i += 1) {
      outcomes.push((await submit({ scanLimit: 100, throttleLimit: 3 })).outcome);
    }
    expect(outcomes.filter((o) => o === 'created')).toHaveLength(3);
    expect(outcomes.filter((o) => o === 'throttled')).toHaveLength(3);
  });

  it('consumes no allowance when throttled', async () => {
    for (let i = 0; i < 5; i += 1) await submit({ scanLimit: 100, throttleLimit: 2 });
    expect(await usedCount()).toBe(2);
  });

  it('is race-safe', async () => {
    const results = await Promise.all(
      Array.from({ length: 30 }, () => submit({ scanLimit: 1000, throttleLimit: 4 })),
    );
    expect(results.filter((r) => r.outcome === 'created')).toHaveLength(4);
  });
});

describe('releasing a reservation is idempotent', () => {
  it('refunds once and only once', async () => {
    const created = await submit({ scanLimit: 2 });
    expect(await usedCount()).toBe(1);

    expect(await releaseAllowance(created.job_id!, pool)).toBe(true);
    expect(await usedCount()).toBe(0);

    expect(await releaseAllowance(created.job_id!, pool)).toBe(false);
    expect(await releaseAllowance(created.job_id!, pool)).toBe(false);
    expect(await usedCount()).toBe(0);
  });

  it('is safe under concurrent release attempts', async () => {
    const created = await submit({ scanLimit: 5 });
    const results = await Promise.all(
      Array.from({ length: 12 }, () => releaseAllowance(created.job_id!, pool)),
    );
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await usedCount()).toBe(0);
  });

  it('does nothing for a job that never reserved anything', async () => {
    expect(await releaseAllowance('00000000-0000-4000-8000-000000000000', pool)).toBe(false);
  });

  it('frees the slot for a genuine retry', async () => {
    const first = await submit({ scanLimit: 1 });
    expect((await submit({ scanLimit: 1 })).outcome).toBe('limit_reached');
    await releaseAllowance(first.job_id!, pool);
    expect((await submit({ scanLimit: 1 })).outcome).toBe('created');
  });
});

describe('the queue hands each job to exactly one worker', () => {
  it('never gives the same job to two workers', async () => {
    for (let i = 0; i < 8; i += 1) await submit({ scanLimit: 100, throttleLimit: 100 });

    const claims = await Promise.all(
      Array.from({ length: 20 }, (_, i) => claimScanJob(`worker-${i}`, pool)),
    );
    const ids = claims.filter((c) => c !== null).map((c) => c!.id);
    expect(ids).toHaveLength(8);
    expect(new Set(ids).size).toBe(8);
  });

  it('returns null when the queue is empty', async () => {
    expect(await claimScanJob('idle-worker', pool)).toBeNull();
  });

  it('dequeues higher priority first', async () => {
    const low = await submit({ scanLimit: 10, throttleLimit: 10, priority: 100, sourceLabel: 'low.zip' });
    const high = await submit({ scanLimit: 10, throttleLimit: 10, priority: 10, sourceLabel: 'high.zip' });
    const first = await claimScanJob('w1', pool);
    expect(first?.id).toBe(high.job_id);
    const second = await claimScanJob('w2', pool);
    expect(second?.id).toBe(low.job_id);
  });

  it('marks the claimed job running and records the attempt', async () => {
    const created = await submit({ scanLimit: 10 });
    const claimed = await claimScanJob('w1', pool);
    expect(claimed?.attempts).toBe(1);
    const row = await pool.query<{ status: string; started_at: Date | null; locked_by: string }>(
      'select status, started_at, locked_by from public.scan_jobs where id = $1',
      [created.job_id],
    );
    expect(row.rows[0]?.status).toBe('running');
    expect(row.rows[0]?.started_at).not.toBeNull();
    expect(row.rows[0]?.locked_by).toBe('w1');
  });
});

describe('terminal transitions are guarded and idempotent', () => {
  it('completes a running job once, and refuses a duplicate completion', async () => {
    const created = await submit({ scanLimit: 10 });
    await claimScanJob('w1', pool);

    const report = minimalReport('owner/repo') as never;
    expect(
      await completeScanJob(
        { jobId: created.job_id!, scannerVersion: '0.1.0', commitSha: null, report },
        pool,
      ),
    ).toBe(true);
    expect(
      await completeScanJob(
        { jobId: created.job_id!, scannerVersion: '0.1.0', commitSha: null, report },
        pool,
      ),
    ).toBe(false);

    const reports = await pool.query('select scan_job_id from public.scan_reports where scan_job_id = $1', [
      created.job_id,
    ]);
    expect(reports.rows).toHaveLength(1);
  });

  it('charges usage for a completed scan', async () => {
    const created = await submit({ scanLimit: 10 });
    await claimScanJob('w1', pool);
    await completeScanJob(
      { jobId: created.job_id!, scannerVersion: '0.1.0', commitSha: null, report: minimalReport() as never },
      pool,
    );
    expect(await usedCount()).toBe(1);
  });

  it('clears the storage key when a job finishes, either way', async () => {
    const ok = await submit({ scanLimit: 10 });
    await claimScanJob('w1', pool);
    await completeScanJob(
      { jobId: ok.job_id!, scannerVersion: '0.1.0', commitSha: null, report: minimalReport() as never },
      pool,
    );

    const bad = await submit({ scanLimit: 10 });
    await claimScanJob('w2', pool);
    await failScanJob(bad.job_id!, 'archive_invalid', pool);

    const rows = await pool.query<{ storage_key: string | null }>(
      'select storage_key from public.scan_jobs where id = any($1::uuid[])',
      [[ok.job_id, bad.job_id]],
    );
    expect(rows.rows.every((row) => row.storage_key === null)).toBe(true);
  });

  it('fails a running job once, refunds it, and refuses a duplicate failure', async () => {
    const created = await submit({ scanLimit: 10 });
    await claimScanJob('w1', pool);
    expect(await failScanJob(created.job_id!, 'archive_invalid', pool)).toBe(true);
    expect(await usedCount()).toBe(0);
    expect(await failScanJob(created.job_id!, 'archive_invalid', pool)).toBe(false);
    expect(await usedCount()).toBe(0);
  });

  it('refuses to complete a job that was never claimed', async () => {
    const created = await submit({ scanLimit: 10 });
    expect(
      await completeScanJob(
        { jobId: created.job_id!, scannerVersion: '0.1.0', commitSha: null, report: minimalReport() as never },
        pool,
      ),
    ).toBe(false);
  });

  it('refuses to complete a job that already failed', async () => {
    const created = await submit({ scanLimit: 10 });
    await claimScanJob('w1', pool);
    await failScanJob(created.job_id!, 'scan_timeout', pool);
    expect(
      await completeScanJob(
        { jobId: created.job_id!, scannerVersion: '0.1.0', commitSha: null, report: minimalReport() as never },
        pool,
      ),
    ).toBe(false);
  });

  it('survives concurrent completion attempts from a duplicated worker', async () => {
    const created = await submit({ scanLimit: 10 });
    await claimScanJob('w1', pool);
    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        completeScanJob(
          { jobId: created.job_id!, scannerVersion: '0.1.0', commitSha: null, report: minimalReport() as never },
          pool,
        ),
      ),
    );
    expect(results.filter(Boolean)).toHaveLength(1);
  });
});

describe('a dead worker does not strand a job', () => {
  it('requeues a stale running job when retries remain', async () => {
    const created = await submit({ scanLimit: 10 });
    await claimScanJob('doomed', pool);
    await pool.query('update public.scan_jobs set max_attempts = 2, locked_at = now() - interval \'1 hour\' where id = $1', [
      created.job_id,
    ]);

    expect(await reapStaleJobs('5 minutes', pool)).toBe(1);
    const row = await pool.query<{ status: string }>('select status from public.scan_jobs where id = $1', [
      created.job_id,
    ]);
    expect(row.rows[0]?.status).toBe('queued');
    expect(await claimScanJob('replacement', pool)).not.toBeNull();
  });

  it('fails and refunds a stale job that is out of retries', async () => {
    const created = await submit({ scanLimit: 10 });
    await claimScanJob('doomed', pool);
    await pool.query('update public.scan_jobs set locked_at = now() - interval \'1 hour\' where id = $1', [
      created.job_id,
    ]);

    expect(await reapStaleJobs('5 minutes', pool)).toBe(1);
    const row = await pool.query<{ status: string; error_category: string }>(
      'select status, error_category from public.scan_jobs where id = $1',
      [created.job_id],
    );
    expect(row.rows[0]?.status).toBe('failed');
    expect(row.rows[0]?.error_category).toBe('internal_error');
    expect(await usedCount()).toBe(0);
  });

  it('leaves healthy running jobs alone', async () => {
    await submit({ scanLimit: 10 });
    await claimScanJob('healthy', pool);
    expect(await reapStaleJobs('5 minutes', pool)).toBe(0);
  });
});

describe('usage reporting reflects the counter', () => {
  it('reports used, remaining and the reset instant', async () => {
    await submit({ scanLimit: 2 });
    const snapshot = await getUsage(user.id, PERIOD, 2, new Date('2026-08-01T00:00:00Z'), pool);
    expect(snapshot).toMatchObject({ used: 1, limit: 2, remaining: 1, billingPeriod: PERIOD });
    expect(snapshot.resetsAt).toBe('2026-08-01T00:00:00.000Z');
  });

  it('reports zero for a user who has never scanned', async () => {
    const snapshot = await getUsage(other.id, PERIOD, 2, new Date('2026-08-01T00:00:00Z'), pool);
    expect(snapshot.used).toBe(0);
    expect(snapshot.remaining).toBe(2);
  });
});

describe('stripe event claiming is exactly-once', () => {
  it('claims a new event and rejects every replay', async () => {
    const at = new Date('2026-07-22T00:00:00Z');
    expect(await claimStripeEvent('evt_1', 'invoice.paid', at, pool)).toBe('claimed');
    expect(await claimStripeEvent('evt_1', 'invoice.paid', at, pool)).toBe('duplicate');
    expect(await claimStripeEvent('evt_1', 'invoice.paid', at, pool)).toBe('duplicate');
  });

  it('is race-safe against simultaneous deliveries of the same event', async () => {
    const at = new Date('2026-07-22T00:00:00Z');
    const results = await Promise.all(
      Array.from({ length: 10 }, () => claimStripeEvent('evt_race', 'invoice.paid', at, pool)),
    );
    expect(results.filter((r) => r === 'claimed')).toHaveLength(1);
    expect(results.filter((r) => r === 'duplicate')).toHaveLength(9);
  });

  it('treats distinct events independently', async () => {
    const at = new Date('2026-07-22T00:00:00Z');
    expect(await claimStripeEvent('evt_a', 'invoice.paid', at, pool)).toBe('claimed');
    expect(await claimStripeEvent('evt_b', 'invoice.paid', at, pool)).toBe('claimed');
  });
});

describe('subscription synchronisation tolerates out-of-order delivery', () => {
  const base = {
    customerId: 'cus_1',
    subscriptionId: 'sub_1',
    priceId: 'price_pro',
    currentPeriodStart: new Date('2026-07-01T00:00:00Z'),
    currentPeriodEnd: new Date('2026-08-01T00:00:00Z'),
    cancelAtPeriodEnd: false,
  };

  it('applies a newer event and discards an older one', async () => {
    expect(
      await applySubscription(
        { ...base, userId: user.id, status: 'active', eventAt: new Date('2026-07-10T00:00:00Z') },
        pool,
      ),
    ).toBe('applied');

    // A late-arriving *older* event must not resurrect the previous state.
    expect(
      await applySubscription(
        { ...base, userId: user.id, status: 'canceled', eventAt: new Date('2026-07-05T00:00:00Z') },
        pool,
      ),
    ).toBe('stale');

    const row = await pool.query<{ status: string }>(
      'select status from public.subscriptions where user_id = $1',
      [user.id],
    );
    expect(row.rows[0]?.status).toBe('active');
  });

  it('applies a strictly newer event', async () => {
    await applySubscription(
      { ...base, userId: user.id, status: 'active', eventAt: new Date('2026-07-10T00:00:00Z') },
      pool,
    );
    expect(
      await applySubscription(
        { ...base, userId: user.id, status: 'canceled', eventAt: new Date('2026-07-20T00:00:00Z') },
        pool,
      ),
    ).toBe('applied');
    const row = await pool.query<{ status: string }>(
      'select status from public.subscriptions where user_id = $1',
      [user.id],
    );
    expect(row.rows[0]?.status).toBe('canceled');
  });

  it('is idempotent for a repeated identical event', async () => {
    const at = new Date('2026-07-10T00:00:00Z');
    await applySubscription({ ...base, userId: user.id, status: 'active', eventAt: at }, pool);
    await applySubscription({ ...base, userId: user.id, status: 'active', eventAt: at }, pool);
    const rows = await pool.query('select user_id from public.subscriptions where user_id = $1', [
      user.id,
    ]);
    expect(rows.rows).toHaveLength(1);
  });

  it('walks the full lifecycle', async () => {
    const steps: Array<[string, string]> = [
      ['2026-07-01T00:00:00Z', 'incomplete'],
      ['2026-07-02T00:00:00Z', 'active'],
      ['2026-07-03T00:00:00Z', 'past_due'],
      ['2026-07-04T00:00:00Z', 'active'],
      ['2026-07-05T00:00:00Z', 'canceled'],
    ];
    for (const [at, status] of steps) {
      expect(
        await applySubscription({ ...base, userId: user.id, status, eventAt: new Date(at) }, pool),
      ).toBe('applied');
    }
    const row = await pool.query<{ status: string }>(
      'select status from public.subscriptions where user_id = $1',
      [user.id],
    );
    expect(row.rows[0]?.status).toBe('canceled');
  });

  it('rejects a status Stripe would never send', async () => {
    await expect(
      applySubscription(
        { ...base, userId: user.id, status: 'totally_made_up', eventAt: new Date() },
        pool,
      ),
    ).rejects.toThrow(/subscriptions_status_known/);
  });
});

describe('customer-to-user mapping', () => {
  it('links a customer and resolves it back to the user', async () => {
    expect(await linkStripeCustomer(user.id, 'cus_link', pool)).toEqual({
      linked: true,
      existingCustomerId: 'cus_link',
    });
    expect(await findUserByStripeCustomer('cus_link', pool)).toBe(user.id);
  });

  it('is idempotent and never overwrites an existing customer', async () => {
    await linkStripeCustomer(user.id, 'cus_first', pool);
    const second = await linkStripeCustomer(user.id, 'cus_second', pool);
    expect(second).toEqual({ linked: false, existingCustomerId: 'cus_first' });
    expect(await findUserByStripeCustomer('cus_second', pool)).toBeNull();
  });

  it('returns null for a customer we have never seen', async () => {
    expect(await findUserByStripeCustomer('cus_unknown', pool)).toBeNull();
  });

  it('refuses to give one Stripe customer to two users', async () => {
    await linkStripeCustomer(user.id, 'cus_shared', pool);
    await expect(linkStripeCustomer(other.id, 'cus_shared', pool)).rejects.toThrow(
      /subscriptions_stripe_customer_id_key|duplicate key/i,
    );
  });
});

describe('the schema refuses to store an unsafe report root', () => {
  it('rejects an absolute path, a home path, a drive letter and a UNC path', async () => {
    const created = await submit({ scanLimit: 10 });
    for (const root of ['/tmp/scan-1234/repo', '~/scans/repo', 'C:\\scans\\repo', '\\\\host\\share']) {
      await expect(
        pool.query(
          `insert into public.scan_reports (scan_job_id, user_id, schema_version, readiness_score, report)
           values ($1, $2, '1.0', 50, $3::jsonb)`,
          [created.job_id, user.id, JSON.stringify(minimalReport(root))],
        ),
      ).rejects.toThrow(/scan_reports_root_is_not_a_path/);
    }
  });

  it('accepts a plain source label', async () => {
    const created = await submit({ scanLimit: 10 });
    await expect(
      pool.query(
        `insert into public.scan_reports (scan_job_id, user_id, schema_version, readiness_score, report)
         values ($1, $2, '1.0', 50, $3::jsonb)`,
        [created.job_id, user.id, JSON.stringify(minimalReport('owner/repo'))],
      ),
    ).resolves.toBeDefined();
  });
});

describe('job row constraints hold the line', () => {
  it('requires a repository url for a github job and forbids one for a zip job', async () => {
    await expect(
      pool.query(CREATE_JOB_SQL, jobArgs(user.id, { sourceType: 'github', repositoryUrl: null })),
    ).rejects.toThrow(/scan_jobs_source_consistency/);
    await expect(
      pool.query(
        CREATE_JOB_SQL,
        jobArgs(user.id, { sourceType: 'zip', repositoryUrl: 'https://github.com/o/r' }),
      ),
    ).rejects.toThrow(/scan_jobs_source_consistency/);
  });

  it('rejects a repository url that is not a canonical github repository', async () => {
    for (const url of [
      'https://gitlab.com/o/r',
      'https://github.com/o/r/tree/main',
      'http://github.com/o/r',
      'https://github.com/o',
    ]) {
      await expect(
        pool.query(CREATE_JOB_SQL, jobArgs(user.id, { sourceType: 'github', repositoryUrl: url })),
      ).rejects.toThrow(/scan_jobs_repo_url_shape/);
    }
  });

  it('accepts a canonical github url', async () => {
    const row = await submit({
      sourceType: 'github',
      repositoryUrl: 'https://github.com/JacobRyan258/mcp-upgrade',
      sourceLabel: 'JacobRyan258/mcp-upgrade',
      storageKey: null,
    });
    expect(row.outcome).toBe('created');
  });
});
