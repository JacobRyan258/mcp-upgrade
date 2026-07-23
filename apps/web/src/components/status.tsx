'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { ScanJobStatus } from '@mcp-upgrade/shared';

/**
 * Polls a running scan until it reaches a terminal state, then refreshes the
 * page so the server component renders the finished report.
 *
 * Polling rather than a socket: it is one endpoint, it survives a sleeping
 * laptop, and it exposes nothing about the queue. The interval backs off so a
 * forgotten open tab is not a load source.
 */
export function ScanStatusPoller({ id, status }: { id: string; status: ScanJobStatus }) {
  const router = useRouter();
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    if (status === 'succeeded' || status === 'failed') return;

    let cancelled = false;
    let attempt = 0;

    async function poll() {
      if (cancelled) return;
      attempt += 1;
      try {
        const response = await fetch(`/api/scans/${id}`, { cache: 'no-store' });
        if (response.ok) {
          const payload = (await response.json()) as { scan?: { status?: ScanJobStatus } };
          const next = payload.scan?.status;
          if (next === 'succeeded' || next === 'failed') {
            router.refresh();
            return;
          }
        }
      } catch {
        // A transient failure just means we try again on the next tick.
      }
      if (cancelled) return;
      setElapsed((value) => value + 1);
      // 2s for the first half-minute, then 5s, then 10s.
      const delay = attempt < 15 ? 2000 : attempt < 40 ? 5000 : 10_000;
      timer = setTimeout(poll, delay);
    }

    let timer = setTimeout(poll, 1500);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [id, status, router]);

  if (status === 'succeeded' || status === 'failed') return null;

  return (
    <div
      role="status"
      aria-live="polite"
      className="rounded-xl border border-line bg-white p-6 text-sm"
    >
      <p className="font-medium">
        {status === 'queued' ? 'Waiting for a scanner…' : 'Scanning your project…'}
      </p>
      <p className="mt-1.5 text-muted">
        This usually takes under a minute. You can leave this page and come back — the scan
        keeps running.
      </p>
      {elapsed > 30 ? (
        <p className="mt-1.5 text-muted">Still going. Larger projects take longer.</p>
      ) : null}
    </div>
  );
}
