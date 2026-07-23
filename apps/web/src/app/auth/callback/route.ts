/**
 * Email confirmation and magic-link landing.
 *
 * Exchanges the one-time code for a session and redirects. The `next`
 * parameter is attacker-controlled, so it is accepted only when it is a
 * same-origin absolute path — otherwise this is an open redirect that turns a
 * trusted confirmation link into a phishing hop.
 */
import { NextResponse } from 'next/server';
import { createSupabaseServerClient } from '../../../lib/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function safeNext(raw: string | null): string {
  if (!raw) return '/dashboard';
  // Must be a path, not a URL, and must not be protocol-relative.
  if (!raw.startsWith('/') || raw.startsWith('//') || raw.includes('\\')) return '/dashboard';
  return raw;
}

export async function GET(request: Request): Promise<NextResponse> {
  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  const next = safeNext(url.searchParams.get('next'));

  if (!code) {
    return NextResponse.redirect(new URL('/sign-in?error=missing_code', url.origin));
  }

  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.auth.exchangeCodeForSession(code);
  if (error) {
    return NextResponse.redirect(new URL('/sign-in?error=link_expired', url.origin));
  }
  return NextResponse.redirect(new URL(next, url.origin));
}
