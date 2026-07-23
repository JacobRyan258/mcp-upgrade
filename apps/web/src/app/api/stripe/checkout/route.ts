/**
 * Checkout session creation.
 *
 * The price is read from configuration, never from the request. A client that
 * posts a price id is ignored — that is the whole defence against someone
 * checking out against a cheaper price and receiving Pro.
 *
 * The resulting session grants nothing on its own. Access follows from the
 * webhook writing subscription state, so a user who abandons checkout, or who
 * replays the success URL, gains nothing.
 */
import { NextResponse } from 'next/server';
import { getSubscription, linkStripeCustomer } from '@mcp-upgrade/database';
import { requireUser } from '../../../../lib/auth';
import { billingConfigured, readPublicEnv, readServerEnv } from '../../../../lib/env';
import { isSameOrigin } from '../../../../lib/origin';
import { getStripe } from '../../../../lib/stripe/client';
import { logEvent } from '../../../../lib/log';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<NextResponse> {
  // This handler reads no body, so an empty cross-site form POST reached it
  // with the visitor's cookie attached and created a Stripe customer for them.
  if (!isSameOrigin(request)) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }

  const user = await requireUser();
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const env = readServerEnv();
  if (!billingConfigured(env)) {
    return NextResponse.json({ error: 'billing_not_configured' }, { status: 503 });
  }
  const priceId = env.STRIPE_PRO_MONTHLY_PRICE_ID!;
  const appUrl = readPublicEnv().NEXT_PUBLIC_APP_URL;
  const stripe = getStripe();

  try {
    // Reuse the customer if we already have one, so a user who subscribes,
    // cancels and resubscribes keeps one billing history rather than
    // accumulating duplicate customers.
    const existing = await getSubscription(user.id);
    let customerId = existing?.stripeCustomerId ?? null;

    if (!customerId) {
      const customer = await stripe.customers.create({
        email: user.email,
        metadata: { userId: user.id },
      });
      const linked = await linkStripeCustomer(user.id, customer.id);
      // If another request won the race, use the customer it stored rather
      // than the one just created.
      customerId = linked.existingCustomerId ?? customer.id;
    }

    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      customer: customerId,
      line_items: [{ price: priceId, quantity: 1 }],
      // Both the session and the resulting subscription carry the user id, so
      // the webhook can establish the mapping from either.
      metadata: { userId: user.id },
      subscription_data: { metadata: { userId: user.id } },
      success_url: `${appUrl}/dashboard/billing?checkout=complete`,
      cancel_url: `${appUrl}/dashboard/billing?checkout=cancelled`,
      allow_promotion_codes: true,
      client_reference_id: user.id,
    });

    if (!session.url) {
      return NextResponse.json({ error: 'checkout_failed' }, { status: 502 });
    }
    logEvent('info', 'billing.checkout_created', { userId: user.id });
    return NextResponse.json({ url: session.url });
  } catch (error) {
    logEvent('error', 'billing.checkout_failed', {
      userId: user.id,
      detail: error instanceof Error ? error.name : 'unknown',
    });
    return NextResponse.json({ error: 'checkout_failed' }, { status: 502 });
  }
}
