/**
 * Subscription and Stripe-event data access.
 *
 * The invariant this module protects: subscription state is only ever written
 * from a signature-verified webhook, and only ever after mapping the Stripe
 * customer back to a user id we already stored. Nothing here accepts a user id
 * that came from a client.
 */
import type pg from 'pg';
import type { SubscriptionSnapshot } from '@mcp-upgrade/shared';
import { query } from './pool.js';

export interface SubscriptionRecord extends SubscriptionSnapshot {
  userId: string;
  stripeCustomerId: string | null;
  stripeSubscriptionId: string | null;
  currentPeriodStart: Date | null;
  currentPeriodEnd: Date | null;
  cancelAtPeriodEnd: boolean;
}

interface SubscriptionRow {
  user_id: string;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  stripe_price_id: string | null;
  status: string | null;
  current_period_start: Date | null;
  current_period_end: Date | null;
  cancel_at_period_end: boolean;
}

function toRecord(row: SubscriptionRow): SubscriptionRecord {
  return {
    userId: row.user_id,
    stripeCustomerId: row.stripe_customer_id,
    stripeSubscriptionId: row.stripe_subscription_id,
    priceId: row.stripe_price_id,
    status: row.status,
    currentPeriodStart: row.current_period_start,
    currentPeriodEnd: row.current_period_end,
    cancelAtPeriodEnd: row.cancel_at_period_end,
  };
}

export async function getSubscription(
  userId: string,
  pool?: pg.Pool,
): Promise<SubscriptionRecord | null> {
  const result = await query<SubscriptionRow>(
    `select user_id, stripe_customer_id, stripe_subscription_id, stripe_price_id,
            status, current_period_start, current_period_end, cancel_at_period_end
       from public.subscriptions where user_id = $1`,
    [userId],
    pool,
  );
  const row = result.rows[0];
  return row ? toRecord(row) : null;
}

/** Resolves a Stripe customer to our user. Returns null for unknown customers. */
export async function findUserByStripeCustomer(
  customerId: string,
  pool?: pg.Pool,
): Promise<string | null> {
  const result = await query<{ user_id: string }>(
    'select user_id from public.subscriptions where stripe_customer_id = $1',
    [customerId],
    pool,
  );
  return result.rows[0]?.user_id ?? null;
}

/**
 * Records the Stripe customer we created for a user.
 *
 * Uses an insert-or-update keyed on the user so a retried checkout does not
 * create a second row, and refuses to move an existing customer id — a user
 * whose customer changed underneath us is a condition to investigate, not to
 * silently overwrite.
 */
export async function linkStripeCustomer(
  userId: string,
  customerId: string,
  pool?: pg.Pool,
): Promise<{ linked: boolean; existingCustomerId: string | null }> {
  const result = await query<{ stripe_customer_id: string | null }>(
    `insert into public.subscriptions (user_id, stripe_customer_id)
     values ($1, $2)
     on conflict (user_id) do update
        set stripe_customer_id = coalesce(public.subscriptions.stripe_customer_id, excluded.stripe_customer_id)
     returning stripe_customer_id`,
    [userId, customerId],
    pool,
  );
  const stored = result.rows[0]?.stripe_customer_id ?? null;
  return { linked: stored === customerId, existingCustomerId: stored };
}

export interface ApplySubscriptionInput {
  userId: string;
  customerId: string | null;
  subscriptionId: string | null;
  priceId: string | null;
  status: string | null;
  currentPeriodStart: Date | null;
  currentPeriodEnd: Date | null;
  cancelAtPeriodEnd: boolean;
  /** Stripe's own event timestamp, used to reject out-of-order delivery. */
  eventAt: Date;
}

export type ApplySubscriptionOutcome = 'applied' | 'stale';

export async function applySubscription(
  input: ApplySubscriptionInput,
  pool?: pg.Pool,
): Promise<ApplySubscriptionOutcome> {
  const result = await query<{ apply_stripe_subscription: string }>(
    `select public.apply_stripe_subscription(
       $1::uuid, $2::text, $3::text, $4::text, $5::text,
       $6::timestamptz, $7::timestamptz, $8::boolean, $9::timestamptz
     )`,
    [
      input.userId,
      input.customerId,
      input.subscriptionId,
      input.priceId,
      input.status,
      input.currentPeriodStart,
      input.currentPeriodEnd,
      input.cancelAtPeriodEnd,
      input.eventAt,
    ],
    pool,
  );
  return (result.rows[0]?.apply_stripe_subscription ?? 'applied') as ApplySubscriptionOutcome;
}

/* -------------------------------------------------------------------------- */
/* Webhook idempotency                                                         */
/* -------------------------------------------------------------------------- */

export type EventClaim = 'claimed' | 'duplicate';

/**
 * Claims a Stripe event id for processing.
 *
 * The primary key on `stripe_events` is the whole mechanism: the second
 * delivery of an event loses the insert race and is told it is a duplicate,
 * so replaying a captured webhook body cannot double-apply anything.
 */
export async function claimStripeEvent(
  eventId: string,
  type: string,
  createdAt: Date,
  pool?: pg.Pool,
): Promise<EventClaim> {
  const result = await query<{ id: string }>(
    `insert into public.stripe_events (id, type, stripe_created_at)
     values ($1, $2, $3)
     on conflict (id) do nothing
     returning id`,
    [eventId, type, createdAt],
    pool,
  );
  return result.rows.length > 0 ? 'claimed' : 'duplicate';
}

export async function finishStripeEvent(
  eventId: string,
  outcome: 'applied' | 'ignored' | 'stale' | 'error',
  pool?: pg.Pool,
): Promise<void> {
  await query(
    'update public.stripe_events set processed_at = now(), outcome = $2 where id = $1',
    [eventId, outcome],
    pool,
  );
}

/**
 * Releases a claim so a failed delivery can be retried by Stripe.
 *
 * Without this, a transient database error mid-processing would leave the event
 * marked as seen and the retry would be discarded as a duplicate — losing the
 * subscription update permanently.
 */
export async function releaseStripeEvent(eventId: string, pool?: pg.Pool): Promise<void> {
  await query('delete from public.stripe_events where id = $1 and processed_at is null', [
    eventId,
  ], pool);
}
