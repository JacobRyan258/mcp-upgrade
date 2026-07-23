/**
 * Server-side authentication.
 *
 * The rule this module exists to enforce: a user id used in a query always
 * comes from `getUser()`, which asks Supabase to verify the access token, and
 * never from a cookie body, a request parameter or anything else the client
 * controls.
 *
 * `getSession()` is deliberately not used. It returns whatever is in the cookie
 * without contacting the auth server, so it can be forged; `getUser()` is the
 * only call that verifies.
 */
import { cookies } from 'next/headers';
import { createServerClient } from '@supabase/ssr';
import type { SupabaseClient } from '@supabase/supabase-js';
import { ensureProfile } from '@mcp-upgrade/database';
import { readPublicEnv, readServerEnv } from './env';

export interface AuthenticatedUser {
  id: string;
  email: string;
  displayName: string | null;
  /** Supabase only sets this once the address has actually been confirmed. */
  emailVerified: boolean;
}

/**
 * A Supabase client bound to the caller's cookies.
 *
 * Uses the anon key, so every query it makes is subject to row level security —
 * which is the point. Privileged work goes through the database package's
 * direct connection instead.
 */
export async function createSupabaseServerClient(): Promise<SupabaseClient> {
  const cookieStore = await cookies();
  const publicEnv = readPublicEnv();

  return createServerClient(
    publicEnv.NEXT_PUBLIC_SUPABASE_URL,
    publicEnv.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet) {
          try {
            for (const { name, value, options } of cookiesToSet) {
              cookieStore.set(name, value, options);
            }
          } catch {
            // Server components cannot set cookies. The middleware refreshes
            // the session instead, so this is expected rather than an error.
          }
        },
      },
    },
  );
}

/**
 * The verified current user, or null.
 *
 * Returns null for an unverified email address as well as for no session at
 * all. Scanning requires a confirmed address, and treating "signed in but
 * unverified" as "not signed in" at this level means no downstream caller can
 * forget to check.
 */
export async function getCurrentUser(): Promise<AuthenticatedUser | null> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.auth.getUser();
  if (error || !data.user) return null;

  const user = data.user;
  const emailVerified = Boolean(user.email_confirmed_at);
  const email = user.email ?? '';
  if (!email) return null;

  const displayName =
    typeof user.user_metadata?.display_name === 'string'
      ? (user.user_metadata.display_name as string)
      : null;

  return { id: user.id, email, displayName, emailVerified };
}

/**
 * The current user, with their profile row guaranteed to exist.
 *
 * The database trigger creates a profile on sign-up, but a project restored
 * from a backup, or a user created before this schema existed, would have none
 * — and every foreign key in the system points at `profiles`. Reconciling here
 * means a signed-in user is never blocked by missing provisioning.
 */
export async function requireUser(): Promise<AuthenticatedUser | null> {
  const user = await getCurrentUser();
  if (!user || !user.emailVerified) return null;
  await ensureProfile(user.id, user.email, user.displayName);
  return user;
}

/** True when Supabase is configured to require email confirmation. */
export function verificationRequired(): boolean {
  return readServerEnv().NODE_ENV !== 'test';
}
