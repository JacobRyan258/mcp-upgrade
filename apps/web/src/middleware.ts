/**
 * Session refresh and route protection.
 *
 * Supabase access tokens are short-lived, so the middleware refreshes them on
 * every request and writes the rotated cookies back. It also gates
 * `/dashboard`, but that is a redirect for the user's benefit, not the security
 * boundary — every route handler and server component independently verifies
 * the user, because middleware can be bypassed by a misconfigured matcher and a
 * single missed path would otherwise be an unauthenticated hole.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { createServerClient } from '@supabase/ssr';

export async function middleware(request: NextRequest): Promise<NextResponse> {
  let response = NextResponse.next({ request });

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) return response;

  const supabase = createServerClient(url, key, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet) {
        for (const { name, value } of cookiesToSet) {
          request.cookies.set(name, value);
        }
        response = NextResponse.next({ request });
        for (const { name, value, options } of cookiesToSet) {
          response.cookies.set(name, value, options);
        }
      },
    },
  });

  // `getUser` rather than `getSession`: it verifies the token with the auth
  // server instead of trusting the cookie.
  const { data } = await supabase.auth.getUser();

  if (!data.user && request.nextUrl.pathname.startsWith('/dashboard')) {
    const signIn = request.nextUrl.clone();
    signIn.pathname = '/sign-in';
    signIn.search = `?next=${encodeURIComponent(request.nextUrl.pathname)}`;
    return NextResponse.redirect(signIn);
  }

  return response;
}

export const config = {
  matcher: [
    // Everything except static assets and image optimisation output.
    '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)',
  ],
};
