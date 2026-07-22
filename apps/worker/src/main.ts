#!/usr/bin/env node
/**
 * Worker entrypoint.
 *
 * Polls the Postgres-backed queue, runs jobs, and exposes a small HTTP surface
 * for health checks. There is no endpoint that accepts work: the web app
 * enqueues by writing a row, so there is no request an attacker can forge to
 * make the worker scan something. The HTTP surface is read-only and its only
 * unauthenticated route is liveness.
 */
import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import {
  claimScanJob,
  closePool,
  completeScanJob,
  failScanJob,
  getPool,
  queueDepth,
  reapStaleJobs,
} from '@mcp-upgrade/database';
import { loadConfig } from './config.js';
import { log, setLogLevel } from './logger.js';
import { runJob } from './pipeline.js';
import { createUploadStore } from './storage.js';

const config = loadConfig();
if (config.NODE_ENV !== 'production') setLogLevel('debug');

const uploads = createUploadStore({
  url: config.SUPABASE_URL,
  serviceRoleKey: config.SUPABASE_SERVICE_ROLE_KEY,
  bucket: config.SUPABASE_UPLOAD_BUCKET,
});

const deps = {
  uploads,
  scanTempRoot: config.SCAN_TEMP_ROOT,
  scanTimeoutMs: config.SCAN_TIMEOUT_MS,
  githubTimeoutMs: config.GITHUB_DOWNLOAD_TIMEOUT_MS,
  githubToken: config.GITHUB_TOKEN,
  limitOverrides: {
    maxArchiveBytes: config.SCAN_MAX_ARCHIVE_BYTES,
    maxExpandedBytes: config.SCAN_MAX_EXPANDED_BYTES,
    maxFiles: config.SCAN_MAX_FILES,
    maxFileBytes: config.SCAN_MAX_FILE_BYTES,
    timeoutMs: config.SCAN_TIMEOUT_MS,
  },
};

let shuttingDown = false;
let activeJobs = 0;
let processed = 0;
let failed = 0;
const startedAt = Date.now();

/**
 * Processes one job if one is available.
 *
 * Returns whether work was found, so the loop can poll quickly while there is a
 * backlog and back off when there is not.
 */
async function processOne(): Promise<boolean> {
  const job = await claimScanJob(config.WORKER_ID);
  if (!job) return false;

  activeJobs += 1;
  log.info('job.claimed', {
    jobId: job.id,
    sourceType: job.sourceType,
    planId: job.planId,
    attempt: job.attempts,
  });

  try {
    const result = await runJob(job, deps);
    if (result.outcome === 'succeeded') {
      const stored = await completeScanJob({
        jobId: job.id,
        scannerVersion: result.scannerVersion,
        commitSha: result.commitSha,
        report: result.report,
      });
      processed += 1;
      log.info('job.completed', {
        jobId: job.id,
        durationMs: result.durationMs,
        score: result.report.summary.readiness.score,
        // `stored` is false when another attempt already finished this job.
        // That is expected under retry, not an error.
        firstWriter: stored,
      });
    } else {
      await failScanJob(job.id, result.category);
      failed += 1;
      log.info('job.recorded_failure', {
        jobId: job.id,
        category: result.category,
        durationMs: result.durationMs,
      });
    }
  } catch (error) {
    // Reaching here means the *database* write failed, not the scan. The job
    // stays `running` and the reaper will retry or fail it, which is the right
    // outcome: we must not lose the job because we could not record it.
    failed += 1;
    log.error('job.record_failed', {
      jobId: job.id,
      detail: error instanceof Error ? error.name : 'unknown',
    });
  } finally {
    activeJobs -= 1;
  }
  return true;
}

async function pollLoop(): Promise<void> {
  const lease = `${config.WORKER_JOB_LEASE_SECONDS} seconds`;
  let sinceReap = 0;

  while (!shuttingDown) {
    let didWork = false;
    try {
      // Recover jobs abandoned by a worker that died. Cheap, and only every
      // ~30 polls so it does not dominate the loop.
      sinceReap += 1;
      if (sinceReap >= 30) {
        sinceReap = 0;
        const reaped = await reapStaleJobs(lease);
        if (reaped > 0) log.warn('queue.reaped_stale_jobs', { count: reaped });
      }

      const slots = Math.max(1, config.WORKER_CONCURRENCY - activeJobs);
      const batch = await Promise.all(Array.from({ length: slots }, () => processOne()));
      didWork = batch.some(Boolean);
    } catch (error) {
      log.error('queue.poll_failed', {
        detail: error instanceof Error ? error.name : 'unknown',
      });
    }
    if (!shuttingDown && !didWork) {
      await sleep(config.WORKER_POLL_INTERVAL_MS);
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Constant-time comparison of the shared secret.
 *
 * Lengths are compared first because `timingSafeEqual` throws on a mismatch;
 * the length of a secret is not itself sensitive.
 */
function secretMatches(provided: string | undefined): boolean {
  if (!provided) return false;
  const expected = Buffer.from(config.WORKER_SHARED_SECRET, 'utf8');
  const actual = Buffer.from(provided, 'utf8');
  if (expected.length !== actual.length) return false;
  return timingSafeEqual(expected, actual);
}

const server = createServer((request, response) => {
  const url = request.url ?? '/';
  response.setHeader('cache-control', 'no-store');
  response.setHeader('x-content-type-options', 'nosniff');

  // Liveness is unauthenticated so a platform health check works without
  // holding a secret. It reveals nothing beyond "this process is up".
  if (request.method === 'GET' && (url === '/health' || url === '/')) {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ status: shuttingDown ? 'draining' : 'ok' }));
    return;
  }

  // Everything with real information requires the shared secret.
  if (request.method === 'GET' && url === '/status') {
    const header = request.headers.authorization;
    const provided = header?.startsWith('Bearer ') ? header.slice(7) : undefined;
    if (!secretMatches(provided)) {
      response.writeHead(401, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: 'unauthorized' }));
      return;
    }
    void queueDepth()
      .then((depth) => {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(
          JSON.stringify({
            worker: config.WORKER_ID,
            uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
            activeJobs,
            processed,
            failed,
            queue: depth,
          }),
        );
      })
      .catch(() => {
        response.writeHead(503, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: 'database_unavailable' }));
      });
    return;
  }

  response.writeHead(404, { 'content-type': 'application/json' });
  response.end(JSON.stringify({ error: 'not_found' }));
});

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info('worker.shutdown_started', { signal, activeJobs });

  server.close();

  // Let in-flight jobs finish so their allowance and cleanup are recorded
  // rather than left to the reaper.
  const deadline = Date.now() + 30_000;
  while (activeJobs > 0 && Date.now() < deadline) {
    await sleep(200);
  }
  if (activeJobs > 0) {
    log.warn('worker.shutdown_forced', { activeJobs });
  }

  await closePool().catch(() => undefined);
  log.info('worker.shutdown_complete', { processed, failed });
  process.exit(0);
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('unhandledRejection', (reason) => {
  log.error('worker.unhandled_rejection', {
    detail: reason instanceof Error ? reason.name : 'unknown',
  });
});

// Fail fast if the database is unreachable: a worker that cannot claim work is
// not healthy, and starting anyway would hide the problem behind a green check.
getPool();

server.listen(config.WORKER_PORT, () => {
  log.info('worker.started', {
    worker: config.WORKER_ID,
    port: config.WORKER_PORT,
    concurrency: config.WORKER_CONCURRENCY,
    scanTimeoutMs: config.SCAN_TIMEOUT_MS,
  });
});

void pollLoop();
