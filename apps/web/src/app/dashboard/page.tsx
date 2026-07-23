import Link from 'next/link';
import { countScanJobs, listScanJobs } from '@mcp-upgrade/database';
import { describeScanError, ingestionLimitsFor } from '@mcp-upgrade/shared';
import { requireUser, getCurrentUser } from '../../lib/auth';
import { getPlanState, historyLimitFor } from '../../lib/plan';
import { NewScanForm } from '../../components/new-scan';

export const metadata = { title: 'Your scans' };
export const dynamic = 'force-dynamic';

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export default async function DashboardPage() {
  const user = await requireUser();
  if (!user) {
    const current = await getCurrentUser();
    return (
      <div className="rounded-xl border border-line bg-white p-8">
        <h1 className="text-xl font-semibold">Confirm your email address</h1>
        <p className="mt-3 leading-relaxed text-muted">
          We sent a confirmation link to {current?.email ?? 'your address'}. Click it and
          come back — scanning is available once your address is confirmed.
        </p>
      </div>
    );
  }

  const plan = await getPlanState(user.id);
  const limits = ingestionLimitsFor(plan.limits);
  const total = await countScanJobs(user.id);
  const scans = await listScanJobs(user.id, historyLimitFor(plan.limits));

  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Your scans</h1>
          <p className="mt-1.5 text-sm text-muted">
            {plan.limits.name} plan · {plan.usage.used} of {plan.usage.limit} scans used this
            month · resets {formatDate(plan.usage.resetsAt)}
          </p>
        </div>
        {plan.planId === 'free' ? (
          <Link
            href="/dashboard/billing"
            className="rounded-lg border border-line px-4 py-2.5 text-sm font-medium hover:border-ink"
          >
            Upgrade for more scans
          </Link>
        ) : null}
      </div>

      <NewScanForm maxArchiveBytes={limits.maxArchiveBytes} remaining={plan.usage.remaining} />

      <section>
        <h2 className="text-lg font-semibold">Recent scans</h2>
        {scans.length === 0 ? (
          <div className="mt-4 rounded-xl border border-dashed border-line p-10 text-center">
            <p className="font-medium">No scans yet</p>
            <p className="mx-auto mt-2 max-w-md text-sm leading-relaxed text-muted">
              Paste a public GitHub repository address above, or upload a ZIP of your project.
              You will get a plain-English report on what breaks when you upgrade.
            </p>
          </div>
        ) : (
          <ul className="mt-4 divide-y divide-line overflow-hidden rounded-xl border border-line bg-white">
            {scans.map((scan) => {
              const failure = scan.status === 'failed' ? describeScanError(scan.errorCategory) : null;
              return (
                <li key={scan.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 p-4">
                  <div className="min-w-0 flex-1">
                    <Link
                      href={`/dashboard/scans/${scan.id}`}
                      className="block truncate font-medium hover:underline"
                      title={scan.sourceLabel}
                    >
                      {scan.sourceLabel}
                    </Link>
                    <p className="mt-0.5 text-xs text-muted">
                      {scan.sourceType === 'github' ? 'GitHub' : 'Upload'} ·{' '}
                      {formatDate(scan.createdAt)}
                      {failure ? ` · ${failure.title}` : ''}
                    </p>
                  </div>
                  {scan.status === 'succeeded' && scan.readinessScore !== null ? (
                    <div className="flex items-center gap-3 text-sm">
                      <span className="font-semibold tabular-nums">{scan.readinessScore}/100</span>
                      {scan.counts ? (
                        <span className="text-muted">
                          {scan.counts.error} breaking · {scan.counts.warning} deprecated
                        </span>
                      ) : null}
                    </div>
                  ) : (
                    <span
                      className={`rounded-full px-2.5 py-1 text-xs font-medium ${
                        scan.status === 'failed'
                          ? 'bg-danger-soft text-danger'
                          : 'bg-accent-soft text-accent'
                      }`}
                    >
                      {scan.status === 'failed'
                        ? 'Failed'
                        : scan.status === 'running'
                          ? 'Scanning'
                          : 'Queued'}
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
        )}
        {total > scans.length ? (
          <p className="mt-3 text-sm text-muted">
            Showing your {scans.length} most recent scans of {total}.{' '}
            <Link href="/dashboard/billing" className="underline">
              Pro keeps your full history.
            </Link>
          </p>
        ) : null}
      </section>
    </div>
  );
}
