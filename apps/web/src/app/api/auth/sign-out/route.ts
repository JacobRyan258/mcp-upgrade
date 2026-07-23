/**
 * Sign out.
 *
 * POST only. A GET sign-out can be triggered by any page that embeds an image
 * pointing at it, which makes logging a user out a cross-site request forgery.
 */
import { NextResponse } from 'next/server';
import { createSupabaseServerClient } from '../../../../lib/auth';
import { readPublicEnv } from '../../../../lib/env';
import { isSameOrigin } from '../../../../lib/origin';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<NextResponse> {
  // POST alone is not enough: a cross-site form can POST too, and forcing a
  // sign-out is a denial of service against the session. The dashboard submits
  // this as a same-origin form, so the browser marks it `same-origin`.
  if (!isSameOrigin(request)) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }

  const supabase = await createSupabaseServerClient();
  await supabase.auth.signOut();
  return NextResponse.redirect(new URL('/', readPublicEnv().NEXT_PUBLIC_APP_URL), {
    status: 303,
  });
}
