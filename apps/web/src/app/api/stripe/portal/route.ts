/**
 * Billing portal.
 *
 * The customer is looked up from our own records for the authenticated user, so
 * a request cannot name somebody else's customer. A user with no Stripe
 * customer has never checked out and is told so rather than being sent to a
 * portal that would error.
 */
import { NextResponse } from 'next/server';
import { getSubscription } from '@mcp-upgrade/database';
import { requireUser } from '../../../../lib/auth';
import { billingConfigured, readPublicEnv } from '../../../../lib/env';
import { isSameOrigin } from '../../../../lib/origin';
import { getStripe } from '../../../../lib/stripe/client';
import { logEvent } from '../../../../lib/log';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<NextResponse> {
  if (!isSameOrigin(request)) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }

  const user = await requireUser();
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  if (!billingConfigured()) {
    return NextResponse.json({ error: 'billing_not_configured' }, { status: 503 });
  }

  const subscription = await getSubscription(user.id);
  if (!subscription?.stripeCustomerId) {
    return NextResponse.json(
      { error: 'no_customer', message: 'You do not have a billing account yet.' },
      { status: 404 },
    );
  }

  try {
    const session = await getStripe().billingPortal.sessions.create({
      customer: subscription.stripeCustomerId,
      return_url: `${readPublicEnv().NEXT_PUBLIC_APP_URL}/dashboard/billing`,
    });
    logEvent('info', 'billing.portal_created', { userId: user.id });
    return NextResponse.json({ url: session.url });
  } catch (error) {
    logEvent('error', 'billing.portal_failed', {
      userId: user.id,
      detail: error instanceof Error ? error.name : 'unknown',
    });
    return NextResponse.json({ error: 'portal_failed' }, { status: 502 });
  }
}
