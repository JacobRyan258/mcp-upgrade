/**
 * Scan job data access.
 *
 * Every function that returns user-visible data takes the user id as a
 * mandatory parameter and includes it in the WHERE clause. There is no
 * "fetch by id" that omits the owner — that shape is how cross-tenant reads
 * happen, so it does not exist here.
 */
import type pg from 'pg';
import type { PublishedReport, ScanJobStatus, ScanJobSummary, ScanSourceType } from '@mcp-upgrade/shared';
import { getPool, query } from './pool.js';

export interface CreateScanJobInput {
  userId: string;
  sourceType: ScanSourceType;
  sourceLabel: string;
  repositoryUrl: string | null;
  targetVersion: string;
  planId: string;
  priority: number;
  storageKey: string | null;
  billingPeriod: string;
  scanLimit: number;
  throttleLimit: number;
  /** Postgres interval literal, e.g. `'1 hour'`. */
  throttleWindow: string;
}

export type CreateScanJobResult =
  | { outcome: 'created'; jobId: string; used: number }
  | { outcome: 'limit_reached'; used: number }
  | { outcome: 'throttled' };

/**
 * Submits a job. Throttle check, allowance reservation and job insert happen
 * inside one SQL function so they share a transaction and a row lock.
 */
export async function createScanJob(
  input: CreateScanJobInput,
  pool?: pg.Pool,
): Promise<CreateScanJobResult> {
  const result = await query<{ outcome: string; job_id: string | null; used: number | null }>(
    `select * from public.create_scan_job(
       $1::uuid, $2::text, $3::text, $4::text, $5::text, $6::text,
       $7::integer, $8::text, $9::text, $10::integer, $11::integer, $12::interval
     )`,
    [
      input.userId,
      input.sourceType,
      input.sourceLabel,
      input.repositoryUrl,
      input.targetVersion,
      input.planId,
      input.priority,
      input.storageKey,
      input.billingPeriod,
      input.scanLimit,
      input.throttleLimit,
      input.throttleWindow,
    ],
    pool,
  );
  const row = result.rows[0];
  if (!row) throw new Error('create_scan_job returned no row');
  if (row.outcome === 'created' && row.job_id) {
    return { outcome: 'created', jobId: row.job_id, used: row.used ?? 0 };
  }
  if (row.outcome === 'limit_reached') {
    return { outcome: 'limit_reached', used: row.used ?? 0 };
  }
  return { outcome: 'throttled' };
}

interface JobRow {
  id: string;
  status: string;
  source_type: string;
  source_label: string;
  repository_url: string | null;
  commit_sha: string | null;
  target_version: string;
  scanner_version: string | null;
  error_category: string | null;
  created_at: Date;
  started_at: Date | null;
  completed_at: Date | null;
  readiness_score: number | null;
  count_error: number | null;
  count_warning: number | null;
  count_review: number | null;
  count_info: number | null;
  partial: boolean | null;
}

function toSummary(row: JobRow): ScanJobSummary {
  const hasReport = row.readiness_score !== null;
  return {
    id: row.id,
    status: row.status as ScanJobStatus,
    sourceType: row.source_type as ScanSourceType,
    sourceLabel: row.source_label,
    repositoryUrl: row.repository_url,
    commitSha: row.commit_sha,
    targetVersion: row.target_version,
    scannerVersion: row.scanner_version,
    errorCategory: row.error_category,
    createdAt: row.created_at.toISOString(),
    startedAt: row.started_at ? row.started_at.toISOString() : null,
    completedAt: row.completed_at ? row.completed_at.toISOString() : null,
    readinessScore: hasReport ? row.readiness_score : null,
    counts: hasReport
      ? {
          error: row.count_error ?? 0,
          warning: row.count_warning ?? 0,
          review: row.count_review ?? 0,
          info: row.count_info ?? 0,
        }
      : null,
    partial: hasReport ? (row.partial ?? false) : null,
  };
}

const SUMMARY_SELECT = `
  select j.id, j.status, j.source_type, j.source_label, j.repository_url,
         j.commit_sha, j.target_version, j.scanner_version, j.error_category,
         j.created_at, j.started_at, j.completed_at,
         r.readiness_score, r.count_error, r.count_warning, r.count_review,
         r.count_info, r.partial
    from public.scan_jobs j
    left join public.scan_reports r on r.scan_job_id = j.id
`;

/** Lists a user's scans, newest first. `limit` is clamped by the caller's plan. */
export async function listScanJobs(
  userId: string,
  limit: number,
  pool?: pg.Pool,
): Promise<ScanJobSummary[]> {
  const bounded = Math.max(1, Math.min(Math.floor(limit), 200));
  const result = await query<JobRow>(
    `${SUMMARY_SELECT} where j.user_id = $1 order by j.created_at desc limit $2`,
    [userId, bounded],
    pool,
  );
  return result.rows.map(toSummary);
}

/**
 * Loads one job *for a specific owner*.
 *
 * Returns null both when the job does not exist and when it belongs to someone
 * else, so a caller cannot distinguish the two and probe for valid job ids.
 */
export async function getScanJob(
  userId: string,
  jobId: string,
  pool?: pg.Pool,
): Promise<ScanJobSummary | null> {
  const result = await query<JobRow>(
    `${SUMMARY_SELECT} where j.id = $1 and j.user_id = $2`,
    [jobId, userId],
    pool,
  );
  const row = result.rows[0];
  return row ? toSummary(row) : null;
}

/** Loads a stored report, scoped to its owner. */
export async function getScanReport(
  userId: string,
  jobId: string,
  pool?: pg.Pool,
): Promise<{ report: unknown; job: ScanJobSummary } | null> {
  const job = await getScanJob(userId, jobId, pool);
  if (!job) return null;
  const result = await query<{ report: unknown }>(
    'select report from public.scan_reports where scan_job_id = $1 and user_id = $2',
    [jobId, userId],
    pool,
  );
  const row = result.rows[0];
  return row ? { report: row.report, job } : null;
}

/** Number of scans a user has ever submitted. Used for the empty state. */
export async function countScanJobs(userId: string, pool?: pg.Pool): Promise<number> {
  const result = await query<{ count: string }>(
    'select count(*)::text as count from public.scan_jobs where user_id = $1',
    [userId],
    pool,
  );
  return Number(result.rows[0]?.count ?? '0');
}

/* -------------------------------------------------------------------------- */
/* Worker-side operations                                                      */
/* -------------------------------------------------------------------------- */

export interface ClaimedJob {
  id: string;
  userId: string;
  sourceType: ScanSourceType;
  sourceLabel: string;
  repositoryUrl: string | null;
  targetVersion: string;
  planId: string;
  storageKey: string | null;
  attempts: number;
  maxAttempts: number;
}

export async function claimScanJob(worker: string, pool?: pg.Pool): Promise<ClaimedJob | null> {
  const result = await query<{
    id: string;
    user_id: string;
    source_type: string;
    source_label: string;
    repository_url: string | null;
    target_version: string;
    plan_id: string;
    storage_key: string | null;
    attempts: number;
    max_attempts: number;
  }>('select * from public.claim_scan_job($1::text)', [worker], pool);
  const row = result.rows[0];
  if (!row) return null;
  return {
    id: row.id,
    userId: row.user_id,
    sourceType: row.source_type as ScanSourceType,
    sourceLabel: row.source_label,
    repositoryUrl: row.repository_url,
    targetVersion: row.target_version,
    planId: row.plan_id,
    storageKey: row.storage_key,
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
  };
}

export async function reapStaleJobs(lease: string, pool?: pg.Pool): Promise<number> {
  const result = await query<{ reap_stale_scan_jobs: number }>(
    'select public.reap_stale_scan_jobs($1::interval)',
    [lease],
    pool,
  );
  return result.rows[0]?.reap_stale_scan_jobs ?? 0;
}

/** Marks a job failed and refunds its reservation. Idempotent. */
export async function failScanJob(
  jobId: string,
  category: string,
  pool?: pg.Pool,
): Promise<boolean> {
  const result = await query<{ fail_scan_job: boolean }>(
    'select public.fail_scan_job($1::uuid, $2::text)',
    [jobId, category],
    pool,
  );
  return result.rows[0]?.fail_scan_job ?? false;
}

export interface CompleteScanJobInput {
  jobId: string;
  scannerVersion: string;
  commitSha: string | null;
  report: PublishedReport;
}

/** Stores a sanitized report and marks the job succeeded. Idempotent. */
export async function completeScanJob(
  input: CompleteScanJobInput,
  pool?: pg.Pool,
): Promise<boolean> {
  const { report } = input;
  const counts = report.summary.counts;
  const result = await query<{ complete_scan_job: boolean }>(
    `select public.complete_scan_job(
       $1::uuid, $2::text, $3::text, $4::text, $5::integer, $6::jsonb,
       $7::integer, $8::integer, $9::integer, $10::integer,
       $11::integer, $12::integer, $13::boolean
     )`,
    [
      input.jobId,
      input.scannerVersion,
      input.commitSha,
      report.schemaVersion,
      Math.round(report.summary.readiness.score),
      JSON.stringify(report),
      counts.error,
      counts.warning,
      counts.review,
      counts.info,
      report.summary.filesScanned,
      report.summary.filesSkipped,
      report.scanStatus === 'partial',
    ],
    pool,
  );
  return result.rows[0]?.complete_scan_job ?? false;
}

/** Number of jobs waiting. Used for the worker health endpoint only. */
export async function queueDepth(pool?: pg.Pool): Promise<{ queued: number; running: number }> {
  const result = await query<{ status: string; count: string }>(
    `select status, count(*)::text as count
       from public.scan_jobs
      where status in ('queued', 'running')
      group by status`,
    [],
    pool,
  );
  let queued = 0;
  let running = 0;
  for (const row of result.rows) {
    if (row.status === 'queued') queued = Number(row.count);
    if (row.status === 'running') running = Number(row.count);
  }
  return { queued, running };
}

/** Ensures the pool exists so a caller can fail fast at startup. */
export function ensureDatabase(): pg.Pool {
  return getPool();
}
