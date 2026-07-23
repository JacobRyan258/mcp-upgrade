/**
 * Stripe event interpretation.
 *
 * Deliberately separated from both the HTTP handler and the database so it can
 * be tested exhaustively against hand-built events. Everything adversarial
 * about webhook handling — a customer we have never seen, a price we do not
 * recognise, missing metadata, a user id that does not match the customer,
 * events arriving out of order — is decided here, as a pure function of the
 * event and a small amount of looked-up state.
 *
 * Signature verification is not done here; it happens in the route before an
 * event is ever parsed, because an unverified payload must not reach any of
 * this logic.
 */
import type Stripe from 'stripe';

/**
 * The events this application acts on. Anything else is acknowledged and
 * ignored.
 *
 * Defined in `@mcp-upgrade/shared` and re-exported here so the handler and
 * `scripts/setup-stripe.ts` — which subscribes the Stripe endpoint to exactly
 * this list — cannot disagree about it.
 */
export { HANDLED_EVENTS, isHandledEvent } from '@mcp-upgrade/shared';
export type { HandledEvent } from '@mcp-upgrade/shared';

export interface SubscriptionUpdate {
  kind: 'subscription';
  customerId: string;
  subscriptionId: string | null;
  priceId: string | null;
  status: string | null;
  currentPeriodStart: Date | null;
  currentPeriodEnd: Date | null;
  cancelAtPeriodEnd: boolean;
  /**
   * Only present when the event itself carries it (checkout metadata). The
   * route prefers the stored customer mapping and uses this solely to
   * establish the mapping the first time.
   */
  userIdHint: string | null;
  eventAt: Date;
}

export interface IgnoredEvent {
  kind: 'ignore';
  reason: string;
}

export type EventPlan = SubscriptionUpdate | IgnoredEvent;

function toDate(seconds: unknown): Date | null {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds <= 0) return null;
  return new Date(seconds * 1000);
}

function idOf(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object' && 'id' in value) {
    const id = (value as { id?: unknown }).id;
    return typeof id === 'string' ? id : null;
  }
  return null;
}

/**
 * Extracts the price from a subscription.
 *
 * A subscription can carry several items. This product has exactly one paid
 * price, so the first item's price is taken and validated against the
 * configured one downstream — an unrecognised price resolves to the Free plan
 * rather than granting anything.
 */
function priceOf(subscription: Stripe.Subscription): string | null {
  const item = subscription.items?.data?.[0];
  return item ? idOf(item.price) : null;
}

/**
 * Whether the subscription is set to stop renewing.
 *
 * Older Stripe API versions expressed this only as the boolean
 * `cancel_at_period_end`. Newer ones (observed from `2026-06-24`) leave that
 * `false` and instead set `cancel_at` to the instant the subscription will end
 * while it is still `active` — the customer portal's "cancel at period end" now
 * produces exactly that shape. Reading only the boolean would miss a pending
 * cancellation entirely, which is the same class of API-version drift `periodOf`
 * already guards against, so both shapes are honoured.
 */
function isSetToCancel(subscription: Stripe.Subscription): boolean {
  if (subscription.cancel_at_period_end) return true;
  const cancelAt = (subscription as unknown as Record<string, unknown>).cancel_at;
  return typeof cancelAt === 'number' && cancelAt > 0;
}

/**
 * Reads the current period from a subscription.
 *
 * Recent Stripe API versions moved `current_period_start` / `current_period_end`
 * off the subscription and onto each subscription item. Both shapes are read so
 * the integration does not silently start storing nulls after an API version
 * bump — which would demote every paying customer to Free at the next period
 * check.
 */
function periodOf(subscription: Stripe.Subscription): { start: Date | null; end: Date | null } {
  const record = subscription as unknown as Record<string, unknown>;
  const topStart = toDate(record.current_period_start);
  const topEnd = toDate(record.current_period_end);
  if (topStart || topEnd) return { start: topStart, end: topEnd };

  const item = subscription.items?.data?.[0] as unknown as Record<string, unknown> | undefined;
  return {
    start: toDate(item?.current_period_start),
    end: toDate(item?.current_period_end),
  };
}

function fromSubscription(
  subscription: Stripe.Subscription,
  eventAt: Date,
  userIdHint: string | null,
): EventPlan {
  const customerId = idOf(subscription.customer);
  if (!customerId) {
    return { kind: 'ignore', reason: 'subscription has no customer' };
  }
  const period = periodOf(subscription);
  return {
    kind: 'subscription',
    customerId,
    subscriptionId: subscription.id,
    priceId: priceOf(subscription),
    status: subscription.status ?? null,
    currentPeriodStart: period.start,
    currentPeriodEnd: period.end,
    cancelAtPeriodEnd: isSetToCancel(subscription),
    userIdHint,
    eventAt,
  };
}

/**
 * Decides what an event means.
 *
 * Never throws. An event whose shape is not what we expect is ignored rather
 * than failed, because failing would make Stripe retry an event that will never
 * succeed, and the retry budget is better spent on transient database errors.
 */
export function planEvent(event: Stripe.Event): EventPlan {
  const eventAt = toDate(event.created) ?? new Date();

  switch (event.type) {
    case 'checkout.session.completed': {
      const session = event.data.object as Stripe.Checkout.Session;
      if (session.mode !== 'subscription') {
        return { kind: 'ignore', reason: 'checkout was not for a subscription' };
      }
      // A session can complete before payment settles. Acting on an unpaid
      // session would grant access that a failed payment never revokes,
      // because no later event would contradict it.
      if (session.payment_status !== 'paid' && session.payment_status !== 'no_payment_required') {
        return { kind: 'ignore', reason: 'checkout session is not paid' };
      }
      const customerId = idOf(session.customer);
      if (!customerId) return { kind: 'ignore', reason: 'checkout session has no customer' };

      const subscriptionId = idOf(session.subscription);
      const userIdHint =
        typeof session.metadata?.userId === 'string' ? session.metadata.userId : null;

      // The session carries no price or period, so this event establishes the
      // customer mapping only. The subscription events that follow carry the
      // authoritative state.
      return {
        kind: 'subscription',
        customerId,
        subscriptionId,
        priceId: null,
        status: null,
        currentPeriodStart: null,
        currentPeriodEnd: null,
        cancelAtPeriodEnd: false,
        userIdHint,
        eventAt,
      };
    }

    case 'customer.subscription.created':
    case 'customer.subscription.updated': {
      const subscription = event.data.object as Stripe.Subscription;
      const hint =
        typeof subscription.metadata?.userId === 'string' ? subscription.metadata.userId : null;
      return fromSubscription(subscription, eventAt, hint);
    }

    case 'customer.subscription.deleted': {
      const subscription = event.data.object as Stripe.Subscription;
      const plan = fromSubscription(subscription, eventAt, null);
      if (plan.kind !== 'subscription') return plan;
      // Stripe reports a deleted subscription's status as `canceled`, but pin
      // it explicitly so a future API change cannot leave a deletion looking
      // like an entitling status.
      return { ...plan, status: 'canceled' };
    }

    case 'invoice.paid':
    case 'invoice.payment_failed': {
      const invoice = event.data.object as Stripe.Invoice;
      const customerId = idOf(invoice.customer);
      if (!customerId) return { kind: 'ignore', reason: 'invoice has no customer' };
      const subscriptionId = idOf((invoice as unknown as Record<string, unknown>).subscription);
      if (!subscriptionId) {
        return { kind: 'ignore', reason: 'invoice is not for a subscription' };
      }
      // An invoice does not describe the subscription's current state. It is
      // treated as a signal to re-read the subscription from Stripe rather than
      // as state in itself, which is what keeps a failed payment from being
      // interpreted from a partial view.
      return {
        kind: 'subscription',
        customerId,
        subscriptionId,
        priceId: null,
        status: null,
        currentPeriodStart: null,
        currentPeriodEnd: null,
        cancelAtPeriodEnd: false,
        userIdHint: null,
        eventAt,
      };
    }

    default:
      return { kind: 'ignore', reason: `unhandled event type: ${event.type}` };
  }
}

/**
 * Whether a plan carries enough state to be written without re-reading Stripe.
 *
 * `checkout.session.completed` and the invoice events do not, so the route
 * fetches the subscription and re-plans from that.
 */
export function isComplete(plan: EventPlan): plan is SubscriptionUpdate {
  return plan.kind === 'subscription' && plan.status !== null;
}
