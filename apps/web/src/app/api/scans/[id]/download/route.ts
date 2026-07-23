/**
 * Report downloads.
 *
 * Three formats, all rendered from the stored report by the shared renderers,
 * so a downloaded file and the web page can never disagree.
 *
 * The stored report is re-validated against the published schema before it is
 * rendered. It was validated on the way in too; validating again on the way out
 * is what protects against a row written by an older or compromised writer.
 */
import { NextResponse } from 'next/server';
import { getScanReport } from '@mcp-upgrade/database';
import {
  downloadFileName,
  renderMarkdownChecklist,
  renderPrintableHtml,
  validatePublishedReport,
} from '@mcp-upgrade/shared';
import { requireUser } from '../../../../../lib/auth';
import { getPlanState } from '../../../../../lib/plan';
import { readPublicEnv } from '../../../../../lib/env';
import { logEvent } from '../../../../../lib/log';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FORMATS = new Set(['json', 'markdown', 'html']);

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const user = await requireUser();
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const { id } = await context.params;
  if (!UUID.test(id)) return NextResponse.json({ error: 'not_found' }, { status: 404 });

  const format = new URL(request.url).searchParams.get('format') ?? 'json';
  if (!FORMATS.has(format)) {
    return NextResponse.json({ error: 'unsupported_format' }, { status: 400 });
  }

  const plan = await getPlanState(user.id);
  if (!plan.limits.downloads) {
    return NextResponse.json(
      { error: 'upgrade_required', message: 'Report downloads are part of the Pro plan.' },
      { status: 402 },
    );
  }

  const stored = await getScanReport(user.id, id);
  if (!stored) return NextResponse.json({ error: 'not_found' }, { status: 404 });

  const validation = validatePublishedReport(stored.report);
  if (!validation.ok) {
    logEvent('error', 'report.stored_invalid', { jobId: id, reason: validation.reason });
    return NextResponse.json({ error: 'report_invalid' }, { status: 500 });
  }
  const report = validation.report;
  const job = stored.job;

  const meta = {
    sourceLabel: job.sourceLabel,
    sourceType: job.sourceType,
    repositoryUrl: job.repositoryUrl,
    commitSha: job.commitSha,
    scannedAt: job.completedAt ?? job.createdAt,
    reportUrl: `${readPublicEnv().NEXT_PUBLIC_APP_URL}/dashboard/scans/${job.id}`,
  };

  // `attachment` on every format, including HTML: rendering attacker-influenced
  // HTML inline on our own origin would be a stored-XSS vector even though the
  // renderer escapes, and there is no reason to take the risk.
  const headers = (type: string, extension: string): HeadersInit => ({
    'content-type': type,
    'content-disposition': `attachment; filename="${downloadFileName(job.sourceLabel, extension)}"`,
    'cache-control': 'no-store, private',
    'x-content-type-options': 'nosniff',
    'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'",
  });

  if (format === 'markdown') {
    return new NextResponse(renderMarkdownChecklist(report, meta), {
      headers: headers('text/markdown; charset=utf-8', 'md'),
    });
  }
  if (format === 'html') {
    return new NextResponse(renderPrintableHtml(report, meta), {
      headers: headers('text/html; charset=utf-8', 'html'),
    });
  }
  return new NextResponse(JSON.stringify(report, null, 2), {
    headers: headers('application/json; charset=utf-8', 'json'),
  });
}
