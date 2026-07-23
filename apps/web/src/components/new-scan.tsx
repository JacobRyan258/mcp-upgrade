'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { formatBytes } from '@mcp-upgrade/shared';

/**
 * Scan submission.
 *
 * The client-side checks here exist purely to give immediate feedback. None of
 * them is a control: the API route independently validates the URL, the file
 * size and the allowance against the plan it reads from the database, so
 * disabling JavaScript or editing this component achieves nothing.
 */
export function NewScanForm({
  maxArchiveBytes,
  remaining,
}: {
  maxArchiveBytes: number;
  remaining: number;
}) {
  const router = useRouter();
  const [tab, setTab] = useState<'github' | 'zip'>('github');
  const [repositoryUrl, setRepositoryUrl] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const exhausted = remaining <= 0;

  async function submit(submitEvent: React.FormEvent) {
    submitEvent.preventDefault();
    if (exhausted) return;
    setBusy(true);
    setError(null);

    try {
      let response: Response;
      if (tab === 'zip') {
        if (!file) {
          setError('Choose a ZIP file first.');
          return;
        }
        if (file.size > maxArchiveBytes) {
          setError(`That file is larger than the ${formatBytes(maxArchiveBytes)} limit for your plan.`);
          return;
        }
        const form = new FormData();
        form.append('file', file);
        response = await fetch('/api/scans', { method: 'POST', body: form });
      } else {
        response = await fetch('/api/scans', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ repositoryUrl }),
        });
      }

      const payload = (await response.json()) as { id?: string; message?: string };
      if (!response.ok) {
        setError(payload.message ?? 'The scan could not be started.');
        return;
      }
      if (payload.id) {
        router.push(`/dashboard/scans/${payload.id}`);
        router.refresh();
      }
    } catch {
      setError('The scan could not be started. Please try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="rounded-xl border border-line bg-white p-6">
      <h2 className="text-lg font-semibold">Start a new scan</h2>

      <div role="tablist" aria-label="Scan source" className="mt-4 flex gap-2">
        {(['github', 'zip'] as const).map((value) => (
          <button
            key={value}
            type="button"
            role="tab"
            aria-selected={tab === value}
            onClick={() => setTab(value)}
            className={`rounded-lg px-3.5 py-2 text-sm font-medium ${
              tab === value ? 'bg-ink text-white' : 'border border-line hover:border-ink'
            }`}
          >
            {value === 'github' ? 'Public GitHub repository' : 'Upload a ZIP'}
          </button>
        ))}
      </div>

      <div className="mt-5">
        {tab === 'github' ? (
          <>
            <label htmlFor="repo" className="block text-sm font-medium">
              Repository address
            </label>
            <input
              id="repo"
              type="url"
              inputMode="url"
              placeholder="https://github.com/owner/repository"
              value={repositoryUrl}
              onChange={(changeEvent) => setRepositoryUrl(changeEvent.target.value)}
              required
              className="mt-1.5 w-full rounded-lg border border-line px-3 py-2.5"
            />
            <p className="mt-1.5 text-xs text-muted">
              Public repositories only. We scan the latest commit on the default branch.
            </p>
          </>
        ) : (
          <>
            <label htmlFor="zip" className="block text-sm font-medium">
              ZIP file
            </label>
            <input
              id="zip"
              type="file"
              accept=".zip,application/zip"
              onChange={(changeEvent) => setFile(changeEvent.target.files?.[0] ?? null)}
              required
              className="mt-1.5 w-full rounded-lg border border-line px-3 py-2.5 text-sm"
            />
            <p className="mt-1.5 text-xs text-muted">
              Up to {formatBytes(maxArchiveBytes)}. Exclude node_modules and build output —
              we ignore them anyway.
            </p>
          </>
        )}
      </div>

      <div aria-live="polite" className="mt-4">
        {error ? (
          <p className="rounded-lg bg-danger-soft px-3.5 py-2.5 text-sm text-danger">{error}</p>
        ) : null}
        {exhausted ? (
          <p className="rounded-lg bg-warn-soft px-3.5 py-2.5 text-sm text-warn">
            You have used your scans for this month. Upgrade for a higher allowance, or wait
            for the reset.
          </p>
        ) : null}
      </div>

      <button
        type="submit"
        disabled={busy || exhausted}
        className="mt-5 rounded-lg bg-ink px-5 py-2.5 font-medium text-white hover:opacity-90 disabled:opacity-40"
      >
        {busy ? 'Starting…' : 'Run scan'}
      </button>
    </form>
  );
}
