'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { getBrowserClient } from '../lib/supabase/client';

type Mode = 'sign-in' | 'sign-up';

/**
 * One form for both flows.
 *
 * Errors are shown from a small closed set of messages rather than passed
 * through from Supabase, so a failed sign-in cannot be used to learn whether an
 * address is registered.
 */
export function AuthForm({ mode }: { mode: Mode }) {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const isSignUp = mode === 'sign-up';

  async function onSubmit(formEvent: React.FormEvent) {
    formEvent.preventDefault();
    setBusy(true);
    setError(null);
    setNotice(null);

    try {
      const supabase = getBrowserClient();
      if (isSignUp) {
        if (password.length < 10) {
          setError('Choose a password of at least 10 characters.');
          return;
        }
        const { error: signUpError } = await supabase.auth.signUp({
          email,
          password,
          options: {
            emailRedirectTo: `${window.location.origin}/auth/callback?next=/dashboard`,
          },
        });
        if (signUpError) {
          setError('We could not create that account. Check the address and try again.');
          return;
        }
        setNotice(
          'Check your email and click the confirmation link. You need to confirm before you can scan.',
        );
        return;
      }

      const { error: signInError } = await supabase.auth.signInWithPassword({ email, password });
      if (signInError) {
        setError('That email address and password did not match.');
        return;
      }
      router.push('/dashboard');
      router.refresh();
    } catch {
      setError('Something went wrong. Please try again.');
    } finally {
      setBusy(false);
    }
  }

  async function onReset() {
    setError(null);
    setNotice(null);
    if (!email) {
      setError('Enter your email address first, then choose reset.');
      return;
    }
    try {
      await getBrowserClient().auth.resetPasswordForEmail(email, {
        redirectTo: `${window.location.origin}/auth/callback?next=/dashboard`,
      });
    } catch {
      // Deliberately ignored: the notice below is shown either way so this
      // cannot be used to discover which addresses are registered.
    }
    setNotice('If that address has an account, a reset link is on its way.');
  }

  return (
    <form onSubmit={onSubmit} className="space-y-5" noValidate>
      <div>
        <label htmlFor="email" className="block text-sm font-medium">
          Email address
        </label>
        <input
          id="email"
          name="email"
          type="email"
          autoComplete="email"
          required
          value={email}
          onChange={(changeEvent) => setEmail(changeEvent.target.value)}
          className="mt-1.5 w-full rounded-lg border border-line px-3 py-2.5"
        />
      </div>

      <div>
        <label htmlFor="password" className="block text-sm font-medium">
          Password
        </label>
        <input
          id="password"
          name="password"
          type="password"
          autoComplete={isSignUp ? 'new-password' : 'current-password'}
          required
          minLength={isSignUp ? 10 : undefined}
          value={password}
          onChange={(changeEvent) => setPassword(changeEvent.target.value)}
          aria-describedby={isSignUp ? 'password-hint' : undefined}
          className="mt-1.5 w-full rounded-lg border border-line px-3 py-2.5"
        />
        {isSignUp ? (
          <p id="password-hint" className="mt-1.5 text-xs text-muted">
            At least 10 characters.
          </p>
        ) : null}
      </div>

      {/* Announced to assistive technology as soon as it appears. */}
      <div aria-live="polite">
        {error ? (
          <p className="rounded-lg bg-danger-soft px-3.5 py-2.5 text-sm text-danger">{error}</p>
        ) : null}
        {notice ? (
          <p className="rounded-lg bg-accent-soft px-3.5 py-2.5 text-sm text-ink">{notice}</p>
        ) : null}
      </div>

      <button
        type="submit"
        disabled={busy}
        className="w-full rounded-lg bg-ink px-4 py-2.5 font-medium text-white hover:opacity-90 disabled:opacity-50"
      >
        {busy ? 'Working…' : isSignUp ? 'Create account' : 'Sign in'}
      </button>

      <div className="flex flex-wrap justify-between gap-3 text-sm text-muted">
        {isSignUp ? (
          <Link href="/sign-in" className="hover:text-ink">Already have an account?</Link>
        ) : (
          <>
            <Link href="/sign-up" className="hover:text-ink">Create an account</Link>
            <button type="button" onClick={onReset} className="hover:text-ink">
              Forgot your password?
            </button>
          </>
        )}
      </div>
    </form>
  );
}
