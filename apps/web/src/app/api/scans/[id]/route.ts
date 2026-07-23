/**
 * Scan status.
 *
 * Polled by the dashboard while a job runs. Returns only the summary shape,
 * which contains no queue internals, no worker identity and no storage key.
 *
 * A job belonging to somebody else and a job that does not exist produce the
 * identical 404, so this endpoint cannot be used to discover valid job ids.
 */
import { NextResponse } from 'next/server';
import { getScanJob } from '@mcp-upgrade/database';
import { requireUser } from '../../../../lib/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const user = await requireUser();
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const { id } = await context.params;
  if (!UUID.test(id)) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }

  // Ownership is part of the query, not a check afterwards.
  const job = await getScanJob(user.id, id);
  if (!job) return NextResponse.json({ error: 'not_found' }, { status: 404 });

  return NextResponse.json(
    { scan: job },
    { headers: { 'cache-control': 'no-store, private' } },
  );
}
