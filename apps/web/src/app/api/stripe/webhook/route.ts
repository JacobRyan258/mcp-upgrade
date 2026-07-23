/**
 * Stripe webhook.
 *
 * This is the only path that may change a subscription. The order of
 * operations is the security design:
 *
 *   1. Verify the signature against the raw body. Nothing is parsed first.
 *   2. Claim the event id. A second delivery loses the insert and returns
 *      early, so a replayed body cannot re-apply anything.
 *   3. Resolve the Stripe customer to *our* user, preferring the mapping we
 *      already stored over any metadata the event carries.
 *   4. Write through a function that discards events older than the one
 *      already applied, so out-of-order delivery is safe.
 *
 * On an unexpected error the event claim is released so Stripe's retry is not
 * discarded as a duplicate; losing a subscription update permanently is far
 * worse than processing one twice, and step 4 makes twice harmless anyway.
 */
import { NextResponse } from 'next/server';
import type Stripe from 'stripe';
import {
  applySubscription,
  claimStripeEvent,
  findUserByStripeCustomer,
  finishStripeEvent,
  getSubscription,
  linkStripeCustomer,
  releaseStripeEvent,
} from '@mcp-upgrade/database';
import { readServerEnv } from '../../../../lib/env';
import { getStripe } from '../../../../lib/stripe/client';
import { isComplete, planEvent } from '../../../../lib/stripe/events';
import type { SubscriptionUpdate } from '../../../../lib/stripe/events';
import { logEvent } from '../../../../lib/log';

// The signature is computed over the exact bytes Stripe sent, so this route
// must never run through a body parser or an edge transform.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<NextResponse> {
  const env = readServerEnv();
  if (!env.STRIPE_WEBHOOK_SECRET || !env.STRIPE_SECRET_KEY) {
    // Not configured is not the same as broken; say so without detail.
    return NextResponse.json({ error: 'billing_not_configured' }, { status: 503 });
  }

  const signature = request.headers.get('stripe-signature');
  if (!signature) {
    return NextResponse.json({ error: 'missing_signature' }, { status: 400 });
  }

  const rawBody = await request.text();

  let event: Stripe.Event;
  try {
    event = getStripe().webhooks.constructEvent(rawBody, signature, env.STRIPE_WEBHOOK_SECRET);
  } catch {
    // Never echo the reason: it tells a prober how close their forgery was.
    logEvent('warn', 'stripe.signature_rejected');
    return NextResponse.json({ error: 'invalid_signature' }, { status: 400 });
  }

  const claim = await claimStripeEvent(
    event.id,
    event.type,
    new Date((event.created ?? Math.floor(Date.now() / 1000)) * 1000),
  );
  if (claim === 'duplicate') {
    logEvent('info', 'stripe.duplicate_event', { eventType: event.type });
    return NextResponse.json({ received: true, duplicate: true });
  }

  try {
    const outcome = await handleEvent(event);
    await finishStripeEvent(event.id, outcome);
    logEvent('info', 'stripe.event_processed', { eventType: event.type, outcome });
    return NextResponse.json({ received: true, outcome });
  } catch (error) {
    // Release the claim so the retry is not swallowed as a duplicate.
    await releaseStripeEvent(event.id).catch(() => undefined);
    logEvent('error', 'stripe.event_failed', {
      eventType: event.type,
      detail: error instanceof Error ? error.name : 'unknown',
    });
    // A 500 asks Stripe to retry, which is what we want for a transient fault.
    return NextResponse.json({ error: 'processing_failed' }, { status: 500 });
  }
}

type Outcome = 'applied' | 'ignored' | 'stale' | 'error';

async function handleEvent(event: Stripe.Event): Promise<Outcome> {
  const plan = planEvent(event);
  if (plan.kind === 'ignore') {
    logEvent('info', 'stripe.event_ignored', { eventType: event.type, reason: plan.reason });
    return 'ignored';
  }

  // Resolve the customer to a user. The stored mapping wins; the metadata hint
  // is only used to establish it the first time, and only when the customer is
  // not already claimed by somebody else.
  let userId = await findUserByStripeCustomer(plan.customerId);

  if (!userId && plan.userIdHint) {
    const existing = await getSubscription(plan.userIdHint);
    if (existing?.stripeCustomerId && existing.stripeCustomerId !== plan.customerId) {
      // The hinted user already has a different customer. Trusting the hint
      // here would let a crafted checkout move somebody else's billing.
      logEvent('warn', 'stripe.customer_user_mismatch', { eventType: event.type });
      return 'ignored';
    }
    const linked = await linkStripeCustomer(plan.userIdHint, plan.customerId);
    if (linked.linked) userId = plan.userIdHint;
  }

  if (!userId) {
    // An event for a customer this deployment has never seen. Common when one
    // Stripe account serves several environments, so it is not an error.
    logEvent('info', 'stripe.unknown_customer', { eventType: event.type });
    return 'ignored';
  }

  const complete = isComplete(plan) ? plan : await hydrate(plan);
  if (!complete) return 'ignored';

  const result = await applySubscription({
    userId,
    customerId: complete.customerId,
    subscriptionId: complete.subscriptionId,
    priceId: complete.priceId,
    status: complete.status,
    currentPeriodStart: complete.currentPeriodStart,
    currentPeriodEnd: complete.currentPeriodEnd,
    cancelAtPeriodEnd: complete.cancelAtPeriodEnd,
    eventAt: complete.eventAt,
  });

  return result === 'stale' ? 'stale' : 'applied';
}

/**
 * Fills in a plan that describes an event without full subscription state —
 * a completed checkout or an invoice — by reading the subscription from Stripe.
 *
 * Reading it back rather than inferring from the event is what makes a failed
 * payment and a cancellation converge on the same authoritative state.
 */
async function hydrate(plan: SubscriptionUpdate): Promise<SubscriptionUpdate | null> {
  if (!plan.subscriptionId) return null;
  const subscription = await getStripe().subscriptions.retrieve(plan.subscriptionId);
  const synthetic = {
    id: event_id_placeholder,
    type: 'customer.subscription.updated',
    created: Math.floor(plan.eventAt.getTime() / 1000),
    data: { object: subscription },
  } as unknown as Stripe.Event;

  const hydrated = planEvent(synthetic);
  if (hydrated.kind !== 'subscription') return null;
  // Keep the original event's timestamp so ordering is judged by when Stripe
  // emitted the event, not by when we happened to read the subscription.
  return { ...hydrated, eventAt: plan.eventAt, userIdHint: plan.userIdHint };
}

/**
 * `planEvent` never reads the event id, so a constant is fine here and avoids
 * inventing one that could be mistaken for a real Stripe identifier.
 */
const event_id_placeholder = 'evt_hydrated';
