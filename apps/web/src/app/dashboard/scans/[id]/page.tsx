import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getScanJob, getScanReport } from '@mcp-upgrade/database';
import {
  CLEAN_REPORT_DISCLAIMER,
  LEVEL_DESCRIPTIONS,
  LEVEL_LABELS,
  actionPlan,
  describeScanError,
  effortRange,
  groupFindings,
  shortSha,
  summarise,
  validatePublishedReport,
} from '@mcp-upgrade/shared';
import { requireUser } from '../../../../lib/auth';
import { getPlanState } from '../../../../lib/plan';
import { ScanStatusPoller } from '../../../../components/status';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Scan report' };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const BAND_STYLES: Record<string, string> = {
  ready: 'bg-ok-soft text-ok',
  'needs-attention': 'bg-warn-soft text-warn',
  'high-risk': 'bg-danger-soft text-danger',
};

const LEVEL_STYLES: Record<string, string> = {
  error: 'bg-danger-soft text-danger',
  warning: 'bg-warn-soft text-warn',
  review: 'bg-review-soft text-review',
  info: 'bg-accent-soft text-accent',
};

export default async function ScanReportPage(props: { params: Promise<{ id: string }> }) {
  const { id } = await props.params;
  const user = await requireUser();
  if (!user || !UUID.test(id)) notFound();

  // Ownership is enforced by the query, so a scan belonging to someone else is
  // indistinguishable from one that does not exist.
  const job = await getScanJob(user.id, id);
  if (!job) notFound();

  const plan = await getPlanState(user.id);

  if (job.status !== 'succeeded') {
    const failure = job.status === 'failed' ? describeScanError(job.errorCategory) : null;
    return (
      <div className="space-y-6">
        <Header job={job} />
        {failure ? (
          <div className="rounded-xl border border-line bg-white p-6">
            <h2 className="text-lg font-semibold">{failure.title}</h2>
            <p className="mt-2 leading-relaxed text-muted">{failure.message}</p>
            <p className="mt-3 leading-relaxed">{failure.action}</p>
            {!failure.userFault ? (
              <p className="mt-4 rounded-lg bg-accent-soft px-3.5 py-2.5 text-sm">
                This scan was not counted against your allowance.
              </p>
            ) : null}
            <Link href="/dashboard" className="mt-5 inline-block text-sm underline">
              Back to your scans
            </Link>
          </div>
        ) : (
          <ScanStatusPoller id={job.id} status={job.status} />
        )}
      </div>
    );
  }

  const stored = await getScanReport(user.id, id);
  const validation = stored ? validatePublishedReport(stored.report) : { ok: false as const, reason: 'missing' };
  if (!validation.ok) {
    return (
      <div className="space-y-6">
        <Header job={job} />
        <div className="rounded-xl border border-line bg-white p-6">
          <h2 className="text-lg font-semibold">This report could not be displayed</h2>
          <p className="mt-2 leading-relaxed text-muted">
            The stored report did not pass validation, so we will not render it. Please run
            the scan again.
          </p>
        </div>
      </div>
    );
  }

  const report = validation.report;
  const summary = summarise(report);
  const plan_items = actionPlan(report);
  const groups = groupFindings(report.findings);
  const effort = effortRange(report);

  return (
    <div className="space-y-8">
      <Header job={job} />

      {/* Top summary */}
      <section className="rounded-xl border border-line bg-white p-6">
        <div className="flex flex-wrap items-end gap-x-6 gap-y-3">
          <div className="flex items-baseline gap-2">
            <span className="text-5xl font-semibold tabular-nums tracking-tight">
              {summary.score}
            </span>
            <span className="text-muted">/100</span>
          </div>
          <span
            className={`rounded-full px-3 py-1.5 text-sm font-semibold ${
              BAND_STYLES[summary.verdict.band] ?? ''
            }`}
          >
            {summary.verdict.label}
          </span>
          {effort ? (
            <span className="text-sm text-muted">Estimated effort: {effort}</span>
          ) : null}
        </div>
        <p className="mt-4 max-w-2xl leading-relaxed">{summary.verdict.summary}</p>

        <dl className="mt-6 grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-6">
          {[
            ['Will break', summary.errors, 'error'],
            ['Deprecated', summary.warnings, 'warning'],
            ['Needs review', summary.reviews, 'review'],
            ['Informational', summary.infos, 'info'],
            ['Files scanned', summary.filesScanned, null],
            ['Files skipped', summary.filesSkipped, null],
          ].map(([label, value, level]) => (
            <div key={String(label)}>
              <dt className="text-xs uppercase tracking-wide text-muted">{label}</dt>
              <dd
                className={`mt-1 text-2xl font-semibold tabular-nums ${
                  level && Number(value) > 0 ? LEVEL_STYLES[String(level)]?.split(' ')[1] : ''
                }`}
              >
                {String(value)}
              </dd>
            </div>
          ))}
        </dl>

        {summary.partial ? (
          <div className="mt-6 rounded-lg bg-warn-soft p-4 text-sm text-warn">
            <p className="font-semibold">This scan was partial.</p>
            <p className="mt-1">Some files were not read, so findings may be incomplete.</p>
            <ul className="mt-2 space-y-1">
              {summary.partialReasons.map((reason) => (
                <li key={reason}>· {reason}</li>
              ))}
            </ul>
          </div>
        ) : null}

        {!summary.isLikelyMcpServer ? (
          <p className="mt-6 rounded-lg bg-accent-soft p-4 text-sm">
            We did not find clear signs that this project is an MCP server. If it is, the scan
            may have missed the relevant files.
          </p>
        ) : null}

        {summary.targetIsReleaseCandidate ? (
          <p className="mt-4 text-xs leading-relaxed text-muted">
            Target protocol version {summary.targetVersion} is a release candidate; the final
            specification is not yet published. Upgrading from {summary.baselineVersion}.
          </p>
        ) : null}
      </section>

      {/* Downloads */}
      <section className="rounded-xl border border-line bg-white p-6">
        <h2 className="text-lg font-semibold">Download this report</h2>
        {plan.limits.downloads ? (
          <>
            <p className="mt-2 text-sm text-muted">
              Send the checklist to whoever maintains the code.
            </p>
            <div className="mt-4 flex flex-wrap gap-3">
              {[
                ['markdown', 'Markdown checklist'],
                ['html', 'Printable report'],
                ['json', 'JSON report'],
              ].map(([format, label]) => (
                <a
                  key={format}
                  href={`/api/scans/${job.id}/download?format=${format}`}
                  className="rounded-lg border border-line px-4 py-2.5 text-sm font-medium hover:border-ink"
                >
                  {label}
                </a>
              ))}
            </div>
          </>
        ) : (
          <p className="mt-2 text-sm text-muted">
            Report downloads are part of the Pro plan.{' '}
            <Link href="/dashboard/billing" className="underline">
              See plans
            </Link>
            .
          </p>
        )}
      </section>

      {/* Plain-English action plan */}
      <section>
        <h2 className="text-xl font-semibold tracking-tight">What to do, in order</h2>
        {plan_items.length === 0 ? (
          <p className="mt-3 rounded-xl border border-line bg-white p-6 leading-relaxed">
            Nothing to do. {CLEAN_REPORT_DISCLAIMER}
          </p>
        ) : (
          <ol className="mt-4 space-y-4">
            {plan_items.map((item, index) => (
              <li key={item.ruleId} className="rounded-xl border border-line bg-white p-6">
                <div className="flex flex-wrap items-center gap-2">
                  <span
                    className={`rounded px-2 py-0.5 text-xs font-bold uppercase tracking-wide ${
                      LEVEL_STYLES[item.level] ?? ''
                    }`}
                  >
                    {LEVEL_LABELS[item.level]}
                  </span>
                  <span className="text-xs text-muted">
                    {item.occurrences} occurrence{item.occurrences === 1 ? '' : 's'} in{' '}
                    {item.files.length} file{item.files.length === 1 ? '' : 's'}
                  </span>
                </div>
                <h3 className="mt-2.5 text-lg font-semibold">
                  {index + 1}. {item.guide.headline}
                </h3>
                <dl className="mt-3 space-y-2.5 leading-relaxed">
                  <div>
                    <dt className="inline font-semibold">What we found: </dt>
                    <dd className="inline text-muted">{item.guide.whatWasFound}</dd>
                  </div>
                  <div>
                    <dt className="inline font-semibold">Why it matters: </dt>
                    <dd className="inline text-muted">{item.guide.whyItMatters}</dd>
                  </div>
                  <div>
                    <dt className="inline font-semibold">What may stop working: </dt>
                    <dd className="inline text-muted">{item.guide.whatMayStopWorking}</dd>
                  </div>
                </dl>
                <p className="mt-4 rounded-lg bg-accent-soft px-4 py-3 leading-relaxed">
                  <strong className="font-semibold">Ask your developer: </strong>
                  {item.guide.askYourDeveloper}
                </p>
                <details className="mt-4">
                  <summary className="cursor-pointer text-sm font-medium">
                    Technical detail
                  </summary>
                  <div className="mt-3 space-y-3 text-sm">
                    <p className="leading-relaxed text-muted">{item.remediation}</p>
                    <p className="font-mono text-xs text-muted">{item.ruleId}</p>
                    <ul className="space-y-1">
                      {item.files.map((file) => (
                        <li key={file} className="break-all font-mono text-xs text-muted">
                          {file}
                        </li>
                      ))}
                    </ul>
                    <a
                      href={item.sourceUrl}
                      rel="noreferrer noopener"
                      className="inline-block underline"
                    >
                      {item.sourceTitle}
                    </a>
                  </div>
                </details>
              </li>
            ))}
          </ol>
        )}
      </section>

      {/* All findings */}
      {groups.length > 0 ? (
        <section>
          <h2 className="text-xl font-semibold tracking-tight">Every finding</h2>
          <p className="mt-2 text-sm text-muted">
            {Object.entries(LEVEL_DESCRIPTIONS)
              .map(([level, text]) => `${LEVEL_LABELS[level as keyof typeof LEVEL_LABELS]}: ${text}`)
              .join(' ')}
          </p>
          <div className="mt-4 space-y-6">
            {groups.map((group) => (
              <div key={group.theme}>
                <h3 className="font-semibold">{group.title}</h3>
                <ul className="mt-3 space-y-2">
                  {group.findings.map(({ finding, levelLabel }, index) => (
                    <li
                      key={`${finding.ruleId}-${finding.file}-${finding.line}-${index}`}
                      className="rounded-lg border border-line bg-white p-4"
                    >
                      <div className="flex flex-wrap items-center gap-2 text-xs">
                        <span
                          className={`rounded px-2 py-0.5 font-bold uppercase tracking-wide ${
                            LEVEL_STYLES[finding.level] ?? ''
                          }`}
                        >
                          {levelLabel}
                        </span>
                        <code className="font-mono text-muted">{finding.ruleId}</code>
                        <code className="break-all font-mono text-muted">
                          {finding.file}:{finding.line}
                        </code>
                        <span className="text-muted">confidence: {finding.confidence}</span>
                      </div>
                      <p className="mt-2 font-medium">{finding.title}</p>
                      <pre className="mt-2 overflow-x-auto rounded bg-surface p-2.5 font-mono text-xs">
                        <code>{finding.evidence}</code>
                      </pre>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </section>
      ) : null}

      <p className="rounded-xl border border-line bg-white p-6 text-sm leading-relaxed text-muted">
        {CLEAN_REPORT_DISCLAIMER} {report.summary.readiness.disclaimer}
      </p>
    </div>
  );
}

function Header({ job }: { job: { sourceLabel: string; sourceType: string; repositoryUrl: string | null; commitSha: string | null; createdAt: string } }) {
  return (
    <div>
      <Link href="/dashboard" className="text-sm text-muted hover:text-ink">
        ← Your scans
      </Link>
      <h1 className="mt-2 break-words text-2xl font-semibold tracking-tight">
        {job.sourceLabel}
      </h1>
      <p className="mt-1.5 text-sm text-muted">
        {job.sourceType === 'github' && job.repositoryUrl ? (
          <>
            <a href={job.repositoryUrl} rel="noreferrer noopener" className="underline">
              {job.repositoryUrl}
            </a>
            {job.commitSha ? ` · commit ${shortSha(job.commitSha)}` : ''}
          </>
        ) : (
          'Uploaded archive'
        )}
      </p>
    </div>
  );
}
