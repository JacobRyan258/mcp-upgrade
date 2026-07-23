/**
 * Sign out.
 *
 * POST only. A GET sign-out can be triggered by any page that embeds an image
 * pointing at it, which makes logging a user out a cross-site request forgery.
 */
import { NextResponse } from 'next/server';
import { createSupabaseServerClient } from '../../../../lib/auth';
import { readPublicEnv } from '../../../../lib/env';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(): Promise<NextResponse> {
  const supabase = await createSupabaseServerClient();
  await supabase.auth.signOut();
  return NextResponse.redirect(new URL('/', readPublicEnv().NEXT_PUBLIC_APP_URL), {
    status: 303,
  });
}
