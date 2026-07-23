/**
 * Scan submission.
 *
 * The only way work enters the system. Everything that matters happens
 * server-side and in this order:
 *
 *   1. Authenticate. The user id comes from a verified token, never the body.
 *   2. Read the plan from the database. Never from the request.
 *   3. Validate the input against that plan's limits.
 *   4. Stage the upload, if any.
 *   5. Reserve allowance and create the job in one atomic database call.
 *
 * Step 5 being atomic is what makes concurrent submissions safe: N simultaneous
 * requests serialise on one row and exactly `limit` of them are admitted. There
 * is no check-then-act window in this handler because the check and the act are
 * the same statement.
 *
 * Staging before reserving means a rejected submission can leave an orphaned
 * object, which the cleanup path below removes; the reverse order would risk
 * consuming allowance for a job whose input never arrived.
 */
import { NextResponse } from 'next/server';
import { randomUUID } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { createScanJob } from '@mcp-upgrade/database';
import {
  DEFAULT_TARGET_VERSION,
  ingestionLimitsFor,
  formatBytes,
  parseGitHubRepoUrl,
  toSourceLabel,
  billingPeriodKey,
} from '@mcp-upgrade/shared';
import { requireUser } from '../../../lib/auth';
import { readServerEnv } from '../../../lib/env';
import { getPlanState } from '../../../lib/plan';
import { logEvent } from '../../../lib/log';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Submissions per user per rolling window, enforced in the database. */
const THROTTLE_LIMIT = 20;
const THROTTLE_WINDOW = '1 hour';

function fail(code: string, message: string, status: number): NextResponse {
  return NextResponse.json({ error: code, message }, { status });
}

export async function POST(request: Request): Promise<NextResponse> {
  const user = await requireUser();
  if (!user) return fail('unauthorized', 'Sign in to start a scan.', 401);

  const plan = await getPlanState(user.id);
  const limits = ingestionLimitsFor(plan.limits);

  // A cheap pre-check purely for a better message. It is *not* the enforcement
  // point — the database call below is — so a race here changes nothing.
  if (plan.usage.remaining <= 0) {
    return fail(
      'limit_reached',
      `You have used all ${plan.usage.limit} scans for this period.`,
      402,
    );
  }

  const contentType = request.headers.get('content-type') ?? '';
  let sourceType: 'zip' | 'github';
  let sourceLabel: string;
  let repositoryUrl: string | null = null;
  let upload: File | null = null;

  if (contentType.includes('multipart/form-data')) {
    let form: FormData;
    try {
      form = await request.formData();
    } catch {
      return fail('invalid_request', 'The upload could not be read.', 400);
    }
    const file = form.get('file');
    if (!(file instanceof File)) {
      return fail('invalid_request', 'No file was uploaded.', 400);
    }
    if (file.size === 0) {
      return fail('invalid_request', 'The uploaded file is empty.', 400);
    }
    if (file.size > limits.maxArchiveBytes) {
      return fail(
        'too_large',
        `Your plan allows uploads up to ${formatBytes(limits.maxArchiveBytes)}.`,
        413,
      );
    }
    sourceType = 'zip';
    upload = file;
    sourceLabel = toSourceLabel(file.name);
  } else {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return fail('invalid_request', 'The request body could not be read.', 400);
    }
    const url = (body as { repositoryUrl?: unknown } | null)?.repositoryUrl;
    const parsed = parseGitHubRepoUrl(url);
    if (!parsed.ok) {
      return fail(
        'invalid_repository',
        'Enter a public GitHub repository address, such as https://github.com/owner/repository.',
        400,
      );
    }
    sourceType = 'github';
    repositoryUrl = parsed.value.normalizedUrl;
    sourceLabel = parsed.value.slug;
  }

  // The job id is generated here so the storage key can embed it before the row
  // exists. It is not the job's primary key — the database generates that — so
  // a collision is impossible rather than merely unlikely.
  const env = readServerEnv();
  const storageKey = upload ? `${user.id}/${randomUUID()}.zip` : null;

  if (upload && storageKey) {
    const staged = await stageUpload(storageKey, upload, env);
    if (!staged) {
      return fail('upload_failed', 'The upload could not be stored. Please try again.', 503);
    }
  }

  const created = await createScanJob({
    userId: user.id,
    sourceType,
    sourceLabel,
    repositoryUrl,
    targetVersion: DEFAULT_TARGET_VERSION,
    planId: plan.planId,
    priority: plan.limits.queuePriority,
    storageKey,
    billingPeriod: billingPeriodKey(),
    scanLimit: plan.limits.scansPerPeriod,
    throttleLimit: THROTTLE_LIMIT,
    throttleWindow: THROTTLE_WINDOW,
  });

  if (created.outcome !== 'created') {
    // Allowance was not consumed, so the staged object is now orphaned.
    if (storageKey) await removeUpload(storageKey, env);

    if (created.outcome === 'throttled') {
      logEvent('warn', 'scan.throttled', { userId: user.id });
      return fail(
        'throttled',
        'Too many scans submitted recently. Please wait a few minutes and try again.',
        429,
      );
    }
    logEvent('info', 'scan.limit_reached', { userId: user.id, used: created.used });
    return fail(
      'limit_reached',
      `You have used all ${plan.usage.limit} scans for this period.`,
      402,
    );
  }

  logEvent('info', 'scan.accepted', {
    jobId: created.jobId,
    userId: user.id,
    sourceType,
    planId: plan.planId,
    used: created.used,
  });

  return NextResponse.json(
    {
      id: created.jobId,
      status: 'queued',
      usage: { used: created.used, limit: plan.limits.scansPerPeriod },
    },
    { status: 202 },
  );
}

/**
 * A service-role Supabase client, used only for object storage.
 *
 * Constructed per request rather than module-scope so the service-role key is
 * never captured into a long-lived object that a future refactor could
 * accidentally export.
 */
function storageClient(env: ReturnType<typeof readServerEnv>) {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL ?? '',
    env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { persistSession: false, autoRefreshToken: false } },
  );
}

async function stageUpload(
  key: string,
  file: File,
  env: ReturnType<typeof readServerEnv>,
): Promise<boolean> {
  try {
    const client = storageClient(env);
    const { error } = await client.storage.from(env.SUPABASE_UPLOAD_BUCKET).upload(key, file, {
      // Always a fresh key, so an existing object would mean something is wrong.
      upsert: false,
      contentType: 'application/zip',
    });
    if (error) {
      logEvent('error', 'scan.stage_failed', { reason: error.message });
      return false;
    }
    return true;
  } catch (error) {
    logEvent('error', 'scan.stage_threw', {
      detail: error instanceof Error ? error.name : 'unknown',
    });
    return false;
  }
}

async function removeUpload(key: string, env: ReturnType<typeof readServerEnv>): Promise<void> {
  try {
    await storageClient(env).storage.from(env.SUPABASE_UPLOAD_BUCKET).remove([key]);
  } catch {
    // Best effort. An orphaned object is a retention concern, not a
    // correctness one, and it is logged by the caller's failure path.
  }
}
