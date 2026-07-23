'use client';

import { useState } from 'react';

/**
 * Both billing actions are POSTs that return a URL to redirect to. Nothing
 * about the plan is decided here: the server reads the customer from our own
 * records and the price from configuration.
 */
export function BillingButton({
  endpoint,
  label,
  variant = 'primary',
}: {
  endpoint: '/api/stripe/checkout' | '/api/stripe/portal';
  label: string;
  variant?: 'primary' | 'secondary';
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function go() {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(endpoint, { method: 'POST' });
      const payload = (await response.json()) as { url?: string; message?: string };
      if (!response.ok || !payload.url) {
        setError(payload.message ?? 'That did not work. Please try again.');
        return;
      }
      window.location.assign(payload.url);
    } catch {
      setError('That did not work. Please try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <button
        type="button"
        onClick={go}
        disabled={busy}
        className={
          variant === 'primary'
            ? 'rounded-lg bg-ink px-5 py-2.5 font-medium text-white hover:opacity-90 disabled:opacity-50'
            : 'rounded-lg border border-line px-5 py-2.5 font-medium hover:border-ink disabled:opacity-50'
        }
      >
        {busy ? 'Opening…' : label}
      </button>
      <div aria-live="polite">
        {error ? <p className="mt-2 text-sm text-danger">{error}</p> : null}
      </div>
    </div>
  );
}
