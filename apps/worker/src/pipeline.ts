/**
 * One job, start to finish.
 *
 * The shape of this module is driven by one requirement: whatever happens, the
 * extracted repository is deleted and the job reaches a terminal state. Every
 * exit path runs through the same `finally`, and the terminal transition is
 * idempotent in the database, so a crash between "scan finished" and "job
 * marked complete" is recovered by the reaper rather than leaving a job stuck.
 *
 * The scanner is called in-process through its programmatic API. It never
 * executes, imports or evaluates the code it reads — that is a property of the
 * scanner, verified by its own suite — so there is no separate sandbox process
 * for evaluation, because nothing is evaluated. Isolation here is about
 * resources and the filesystem: a private directory per job, hard byte and file
 * budgets, a wall-clock deadline, and a container that owns nothing else.
 */
import { mkdtemp, mkdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { scanPath } from 'mcp-upgrade';
import type { ScanReport } from 'mcp-upgrade';
import {
  ingestionLimitsFor,
  parseGitHubRepoUrl,
  planLimits,
  isPlanId,
} from '@mcp-upgrade/shared';
import type { IngestionLimits, PublishedReport } from '@mcp-upgrade/shared';
import type { ClaimedJob } from '@mcp-upgrade/database';
import { IngestionError, categorise, detailOf } from './errors.js';
import { downloadRepositoryArchive, resolveRepository } from './github.js';
import { log } from './logger.js';
import { sanitizeReport } from './sanitize.js';
import type { UploadStore } from './storage.js';
import { extractZip, removeJobDirectory } from './zip.js';

export interface PipelineDeps {
  uploads: UploadStore;
  scanTempRoot: string;
  scanTimeoutMs: number;
  githubTimeoutMs: number;
  githubToken?: string | undefined;
  limitOverrides?: Partial<IngestionLimits>;
}

export interface PipelineSuccess {
  outcome: 'succeeded';
  report: PublishedReport;
  commitSha: string | null;
  scannerVersion: string;
  durationMs: number;
}

export interface PipelineFailure {
  outcome: 'failed';
  category: string;
  durationMs: number;
}

export type PipelineResult = PipelineSuccess | PipelineFailure;

/**
 * Runs a claimed job.
 *
 * Never throws: a failure is a result, because the caller has to record a
 * terminal state either way and an exception escaping here would leave the job
 * running until the reaper noticed.
 */
export async function runJob(job: ClaimedJob, deps: PipelineDeps): Promise<PipelineResult> {
  const startedAt = Date.now();
  const deadline = startedAt + deps.scanTimeoutMs;
  const limits = resolveLimits(job.planId, deps.limitOverrides);

  let jobDirectory: string | null = null;

  try {
    await mkdir(deps.scanTempRoot, { recursive: true, mode: 0o700 });
    // A random directory name per job. Nothing about the job id or the user is
    // encoded in it, so a path that does leak somewhere reveals nothing.
    jobDirectory = await mkdtemp(path.join(deps.scanTempRoot, 'scan-'));
    const sourceDirectory = path.join(jobDirectory, 'src');
    const archivePath = path.join(jobDirectory, 'archive.zip');
    await mkdir(sourceDirectory, { recursive: true, mode: 0o700 });

    let commitSha: string | null = null;

    if (job.sourceType === 'zip') {
      if (!job.storageKey) {
        throw new IngestionError('storage_unavailable', 'zip job has no staged upload');
      }
      const bytes = await deps.uploads.download(job.storageKey, archivePath, limits.maxArchiveBytes);
      log.info('job.upload_staged', { jobId: job.id, bytes });
    } else {
      const parsed = parseGitHubRepoUrl(job.repositoryUrl);
      if (!parsed.ok) {
        throw new IngestionError('source_url_invalid', `stored url rejected: ${parsed.reason}`);
      }
      const githubOptions = {
        limits,
        timeoutMs: deps.githubTimeoutMs,
        token: deps.githubToken,
      };
      const resolved = await resolveRepository(parsed.value, githubOptions);
      commitSha = resolved.commitSha;
      log.info('job.repository_resolved', {
        jobId: job.id,
        branch: resolved.defaultBranch,
        sizeKb: resolved.sizeKb,
      });
      const bytes = await downloadRepositoryArchive(
        parsed.value,
        resolved.commitSha,
        archivePath,
        githubOptions,
      );
      log.info('job.archive_downloaded', { jobId: job.id, bytes });
    }

    const archiveStat = await stat(archivePath);
    if (archiveStat.size > limits.maxArchiveBytes) {
      throw new IngestionError('archive_too_large', 'archive exceeds the plan limit');
    }
    if (archiveStat.size === 0) {
      throw new IngestionError('archive_invalid', 'archive is empty');
    }

    const extraction = await extractZip(archivePath, sourceDirectory, {
      limits,
      deadline,
      // GitHub archives wrap everything in a single `{repo}-{sha}/` directory.
      stripLeadingComponent: job.sourceType === 'github',
    });
    log.info('job.extracted', {
      jobId: job.id,
      files: extraction.filesWritten,
      bytes: extraction.bytesWritten,
      skippedUnsupported: extraction.skippedUnsupported,
      skippedIgnored: extraction.skippedIgnored,
      skippedNested: extraction.skippedNestedArchives,
    });

    if (Date.now() > deadline) {
      throw new IngestionError('scan_timeout', 'deadline passed before scanning began');
    }

    const report = await runScanWithDeadline(sourceDirectory, job.targetVersion, deadline);

    const published = sanitizeReport(report, { sourceLabel: job.sourceLabel });

    return {
      outcome: 'succeeded',
      report: published,
      commitSha,
      scannerVersion: report.scannerVersion,
      durationMs: Date.now() - startedAt,
    };
  } catch (error) {
    const category = categorise(error);
    log.warn('job.failed', {
      jobId: job.id,
      category,
      // Operator-facing only. Sanitised by the logger before it is written.
      detail: detailOf(error),
    });
    return { outcome: 'failed', category, durationMs: Date.now() - startedAt };
  } finally {
    // Cleanup runs for success, failure, rejection and timeout alike. It is the
    // only place the extracted repository is removed, so there is exactly one
    // thing to get right.
    if (jobDirectory) {
      try {
        await removeJobDirectory(deps.scanTempRoot, jobDirectory);
        log.info('job.cleaned', { jobId: job.id });
      } catch (cleanupError) {
        log.error('job.cleanup_failed', { jobId: job.id, detail: detailOf(cleanupError) });
      }
    }
    if (job.storageKey) {
      // Deleting the staged upload is part of the retention promise, so it
      // happens whether or not the scan worked.
      await deps.uploads.remove(job.storageKey).catch(() => undefined);
    }
  }
}

/**
 * Runs the scan against a wall-clock deadline.
 *
 * The scanner has its own internal budgets, so this is a backstop rather than
 * the primary control. It does not attempt to kill the scan — there is nothing
 * to kill, the work is CPU-bound in this process — it just refuses to wait past
 * the deadline so the job cannot occupy a worker slot indefinitely.
 */
async function runScanWithDeadline(
  directory: string,
  targetVersion: string,
  deadline: number,
): Promise<ScanReport> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) {
    throw new IngestionError('scan_timeout', 'no time remained for the scan');
  }

  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new IngestionError('scan_timeout', 'the scan exceeded its deadline')),
      remaining,
    );
  });

  try {
    return await Promise.race([
      scanPath({
        path: directory,
        // Explicit, so the scan never depends on the process working directory.
        cwd: directory,
        target: targetVersion,
      }).catch((error: unknown) => {
        throw new IngestionError('scan_failed', 'the scanner raised', { cause: error });
      }),
      timeout,
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function resolveLimits(
  planId: string,
  overrides: Partial<IngestionLimits> = {},
): IngestionLimits {
  // An unrecognised stored plan degrades to Free rather than to "unlimited".
  const plan = planLimits(isPlanId(planId) ? planId : 'free');
  return ingestionLimitsFor(plan, overrides);
}
