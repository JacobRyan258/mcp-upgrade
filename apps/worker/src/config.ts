/**
 * Worker configuration.
 *
 * Validated once at startup. A missing or malformed required variable is a
 * startup failure, never a silent default — a worker that runs with no shared
 * secret or no database is worse than one that refuses to start.
 */
import { z } from 'zod';
import { ABSOLUTE_LIMITS } from '@mcp-upgrade/shared';

const positiveInt = (fallback: number, ceiling: number) =>
  z.coerce
    .number()
    .int()
    .positive()
    .max(ceiling)
    .default(fallback);

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),

  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),

  /**
   * Shared secret for the worker's own HTTP surface. Long enough that guessing
   * is not a strategy; compared in constant time at the edge.
   */
  WORKER_SHARED_SECRET: z
    .string()
    .min(32, 'WORKER_SHARED_SECRET must be at least 32 characters'),

  WORKER_ID: z.string().min(1).max(64).default('worker-1'),
  WORKER_PORT: positiveInt(8080, 65535),
  WORKER_POLL_INTERVAL_MS: positiveInt(2_000, 60_000),
  WORKER_CONCURRENCY: positiveInt(1, 8),
  /** How long a claimed job may stay `running` before the reaper takes it. */
  WORKER_JOB_LEASE_SECONDS: positiveInt(900, 7200),

  /** Where per-job directories are created. Must be writable. */
  SCAN_TEMP_ROOT: z.string().min(1).default('/tmp/mcp-upgrade-scans'),
  SCAN_TIMEOUT_MS: positiveInt(300_000, ABSOLUTE_LIMITS.timeoutMs),
  SCAN_MAX_ARCHIVE_BYTES: positiveInt(
    ABSOLUTE_LIMITS.maxArchiveBytes,
    ABSOLUTE_LIMITS.maxArchiveBytes,
  ),
  SCAN_MAX_EXPANDED_BYTES: positiveInt(
    ABSOLUTE_LIMITS.maxExpandedBytes,
    ABSOLUTE_LIMITS.maxExpandedBytes,
  ),
  SCAN_MAX_FILES: positiveInt(ABSOLUTE_LIMITS.maxFiles, ABSOLUTE_LIMITS.maxFiles),
  SCAN_MAX_FILE_BYTES: positiveInt(ABSOLUTE_LIMITS.maxFileBytes, ABSOLUTE_LIMITS.maxFileBytes),

  GITHUB_DOWNLOAD_TIMEOUT_MS: positiveInt(60_000, 600_000),
  /** Optional. Only raises the anonymous rate limit; grants no private access. */
  GITHUB_TOKEN: z.string().min(1).optional(),

  /** Supabase Storage, used only to stage uploaded archives. */
  SUPABASE_URL: z.string().url(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
  SUPABASE_UPLOAD_BUCKET: z.string().min(1).default('scan-uploads'),
});

export type WorkerConfig = Readonly<z.infer<typeof schema>>;

let cached: WorkerConfig | null = null;

/**
 * Parses and caches configuration.
 *
 * The error message lists every problem at once and never echoes a value, so a
 * misconfigured deployment gets a complete, secret-free diagnostic.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): WorkerConfig {
  if (cached) return cached;
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const problems = parsed.error.issues
      .map((issue) => `  ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    throw new Error(`Worker configuration is invalid:\n${problems}`);
  }
  cached = Object.freeze(parsed.data);
  return cached;
}

/** Clears the cache. Tests only. */
export function resetConfig(): void {
  cached = null;
}
