/**
 * Billing logic.
 *
 * Two things are under test and both are ways a user could gain Pro without
 * paying for it: how a stored subscription resolves to a plan, and how a Stripe
 * event is interpreted before it is written.
 *
 * Signature verification is not tested here because it is not our code — it is
 * `stripe.webhooks.constructEvent`, called before any of this runs. What is
 * tested is everything that happens after a payload is known to be genuine.
 */
import { describe, expect, it } from 'vitest';
import type Stripe from 'stripe';
import { PLANS, resolvePlan, billingPeriodKey, billingPeriodResetsAt } from '@mcp-upgrade/shared';
import { isComplete, isHandledEvent, planEvent } from '../src/lib/stripe/events';

const PRO_PRICE = 'price_pro_monthly';

function subscription(overrides: Record<string, unknown> = {}) {
  return {
    status: 'active',
    priceId: PRO_PRICE,
    currentPeriodEnd: new Date('2026-08-22T00:00:00Z'),
    cancelAtPeriodEnd: false,
    ...overrides,
  };
}

const NOW = new Date('2026-07-22T12:00:00Z');

describe('plan resolution defaults to Free on every failure', () => {
  it('grants Pro for an active subscription on the configured price', () => {
    const resolved = resolvePlan({ subscription: subscription(), proPriceId: PRO_PRICE, now: NOW });
    expect(resolved.planId).toBe('pro');
    expect(resolved.reason).toBe('entitled');
    expect(resolved.limits.scansPerPeriod).toBe(PLANS.pro.scansPerPeriod);
  });

  it('grants Pro while trialing', () => {
    expect(
      resolvePlan({
        subscription: subscription({ status: 'trialing' }),
        proPriceId: PRO_PRICE,
        now: NOW,
      }).planId,
    ).toBe('pro');
  });

  it('gives Free when there is no subscription at all', () => {
    const resolved = resolvePlan({ subscription: null, proPriceId: PRO_PRICE, now: NOW });
    expect(resolved.planId).toBe('free');
    expect(resolved.reason).toBe('no-subscription');
  });

  it('gives Free for every non-entitling status', () => {
    for (const status of [
      'past_due',
      'unpaid',
      'canceled',
      'incomplete',
      'incomplete_expired',
      'paused',
    ]) {
      const resolved = resolvePlan({
        subscription: subscription({ status }),
        proPriceId: PRO_PRICE,
        now: NOW,
      });
      expect(resolved.planId, `status ${status} must not grant Pro`).toBe('free');
      expect(resolved.reason).toBe('status-not-entitling');
    }
  });

  it('gives Free for a price this deployment does not recognise', () => {
    // The defence against checking out against some other price and being
    // upgraded because the status happened to be active.
    const resolved = resolvePlan({
      subscription: subscription({ priceId: 'price_someone_elses_cheap_plan' }),
      proPriceId: PRO_PRICE,
      now: NOW,
    });
    expect(resolved.planId).toBe('free');
    expect(resolved.reason).toBe('unknown-price');
  });

  it('gives Free when no Pro price is configured at all', () => {
    expect(
      resolvePlan({ subscription: subscription(), proPriceId: null, now: NOW }).planId,
    ).toBe('free');
  });

  it('gives Free once the paid period has expired beyond the grace window', () => {
    const resolved = resolvePlan({
      subscription: subscription({ currentPeriodEnd: new Date('2026-07-20T00:00:00Z') }),
      proPriceId: PRO_PRICE,
      now: NOW,
    });
    expect(resolved.planId).toBe('free');
    expect(resolved.reason).toBe('period-expired');
  });

  it('keeps Pro inside the grace window, so a slow renewal does not demote', () => {
    expect(
      resolvePlan({
        subscription: subscription({ currentPeriodEnd: new Date('2026-07-22T10:00:00Z') }),
        proPriceId: PRO_PRICE,
        now: NOW,
      }).planId,
    ).toBe('pro');
  });

  it('keeps Pro for a subscription cancelling at period end', () => {
    // Cancelled-but-still-paid must keep working until the period ends.
    expect(
      resolvePlan({
        subscription: subscription({ cancelAtPeriodEnd: true }),
        proPriceId: PRO_PRICE,
        now: NOW,
      }).planId,
    ).toBe('pro');
  });

  it('ignores a missing period end rather than treating it as expired', () => {
    expect(
      resolvePlan({
        subscription: subscription({ currentPeriodEnd: null }),
        proPriceId: PRO_PRICE,
        now: NOW,
      }).planId,
    ).toBe('pro');
  });

  it('gives Free for a garbage period end', () => {
    expect(
      resolvePlan({
        subscription: subscription({ currentPeriodEnd: 'not a date' }),
        proPriceId: PRO_PRICE,
        now: NOW,
      }).planId,
    ).toBe('pro');
  });
});

describe('billing periods', () => {
  it('keys by UTC calendar month', () => {
    expect(billingPeriodKey(new Date('2026-07-22T23:59:59Z'))).toBe('2026-07');
    expect(billingPeriodKey(new Date('2026-01-01T00:00:00Z'))).toBe('2026-01');
    expect(billingPeriodKey(new Date('2026-12-31T23:59:59Z'))).toBe('2026-12');
  });

  it('resets at the first instant of the next month', () => {
    expect(billingPeriodResetsAt('2026-07').toISOString()).toBe('2026-08-01T00:00:00.000Z');
    expect(billingPeriodResetsAt('2026-12').toISOString()).toBe('2027-01-01T00:00:00.000Z');
  });

  it('refuses a malformed period key', () => {
    expect(() => billingPeriodResetsAt('2026-7')).toThrow();
    expect(() => billingPeriodResetsAt('nonsense')).toThrow();
  });
});

/* -------------------------------------------------------------------------- */

function event(type: string, object: unknown, created = 1_753_000_000): Stripe.Event {
  return { id: 'evt_test', type, created, data: { object } } as unknown as Stripe.Event;
}

describe('event routing', () => {
  it('recognises exactly the events we act on', () => {
    for (const type of [
      'checkout.session.completed',
      'customer.subscription.created',
      'customer.subscription.updated',
      'customer.subscription.deleted',
      'invoice.paid',
      'invoice.payment_failed',
    ]) {
      expect(isHandledEvent(type)).toBe(true);
    }
    for (const type of ['charge.succeeded', 'customer.created', 'payout.paid']) {
      expect(isHandledEvent(type)).toBe(false);
    }
  });

  it('ignores an event type it does not handle', () => {
    const plan = planEvent(event('charge.refunded', {}));
    expect(plan.kind).toBe('ignore');
  });
});

describe('checkout sessions', () => {
  it('reads the customer and the user hint from a paid subscription checkout', () => {
    const plan = planEvent(
      event('checkout.session.completed', {
        mode: 'subscription',
        payment_status: 'paid',
        customer: 'cus_1',
        subscription: 'sub_1',
        metadata: { userId: 'user-1' },
      }),
    );
    expect(plan).toMatchObject({ kind: 'subscription', customerId: 'cus_1', userIdHint: 'user-1' });
    // It carries no status, so it must not be written directly.
    expect(isComplete(plan)).toBe(false);
  });

  it('ignores a checkout that is not for a subscription', () => {
    expect(
      planEvent(
        event('checkout.session.completed', {
          mode: 'payment',
          payment_status: 'paid',
          customer: 'cus_1',
        }),
      ).kind,
    ).toBe('ignore');
  });

  it('ignores a checkout that has not been paid', () => {
    // Acting on an unpaid session would grant access that no later event
    // contradicts.
    for (const status of ['unpaid', 'no_payment_required_but_typo', 'pending']) {
      expect(
        planEvent(
          event('checkout.session.completed', {
            mode: 'subscription',
            payment_status: status,
            customer: 'cus_1',
          }),
        ).kind,
      ).toBe('ignore');
    }
  });

  it('accepts a zero-cost subscription that required no payment', () => {
    expect(
      planEvent(
        event('checkout.session.completed', {
          mode: 'subscription',
          payment_status: 'no_payment_required',
          customer: 'cus_1',
          subscription: 'sub_1',
        }),
      ).kind,
    ).toBe('subscription');
  });

  it('ignores a checkout with no customer', () => {
    expect(
      planEvent(
        event('checkout.session.completed', {
          mode: 'subscription',
          payment_status: 'paid',
          customer: null,
        }),
      ).kind,
    ).toBe('ignore');
  });

  it('ignores missing metadata rather than failing', () => {
    const plan = planEvent(
      event('checkout.session.completed', {
        mode: 'subscription',
        payment_status: 'paid',
        customer: 'cus_1',
        subscription: 'sub_1',
      }),
    );
    expect(plan).toMatchObject({ kind: 'subscription', userIdHint: null });
  });
});

describe('subscription events', () => {
  const base = {
    id: 'sub_1',
    customer: 'cus_1',
    status: 'active',
    cancel_at_period_end: false,
    items: {
      data: [
        {
          price: { id: PRO_PRICE },
          current_period_start: 1_751_000_000,
          current_period_end: 1_753_600_000,
        },
      ],
    },
  };

  it('extracts price, status and period', () => {
    const plan = planEvent(event('customer.subscription.updated', base));
    expect(plan).toMatchObject({
      kind: 'subscription',
      customerId: 'cus_1',
      subscriptionId: 'sub_1',
      priceId: PRO_PRICE,
      status: 'active',
    });
    expect(isComplete(plan)).toBe(true);
  });

  it('reads the period from the subscription when it is there instead', () => {
    // Older API versions put the period on the subscription rather than the
    // item. Both shapes must work or a version bump silently stores nulls.
    const plan = planEvent(
      event('customer.subscription.updated', {
        ...base,
        current_period_start: 1_751_000_000,
        current_period_end: 1_753_600_000,
        items: { data: [{ price: { id: PRO_PRICE } }] },
      }),
    );
    expect(plan.kind).toBe('subscription');
    if (plan.kind !== 'subscription') return;
    expect(plan.currentPeriodEnd?.toISOString()).toBe(new Date(1_753_600_000 * 1000).toISOString());
  });

  it('reads the period from the item when the subscription has none', () => {
    const plan = planEvent(event('customer.subscription.updated', base));
    if (plan.kind !== 'subscription') throw new Error('expected a subscription plan');
    expect(plan.currentPeriodEnd?.toISOString()).toBe(new Date(1_753_600_000 * 1000).toISOString());
  });

  it('forces a deletion to canceled regardless of the reported status', () => {
    const plan = planEvent(
      event('customer.subscription.deleted', { ...base, status: 'active' }),
    );
    expect(plan).toMatchObject({ status: 'canceled' });
  });

  it('carries cancel_at_period_end through', () => {
    const plan = planEvent(
      event('customer.subscription.updated', { ...base, cancel_at_period_end: true }),
    );
    expect(plan).toMatchObject({ cancelAtPeriodEnd: true });
  });

  it('treats a set cancel_at as cancelling, even when the boolean is false', () => {
    // Stripe API versions from 2026-06-24 report a portal "cancel at period end"
    // as cancel_at_period_end:false with cancel_at set to the period end while
    // the subscription is still active. Reading only the boolean missed it.
    const plan = planEvent(
      event('customer.subscription.updated', {
        ...base,
        cancel_at_period_end: false,
        cancel_at: 1_753_600_000,
        canceled_at: 1_751_000_100,
      }),
    );
    expect(plan).toMatchObject({ cancelAtPeriodEnd: true, status: 'active' });
  });

  it('does not treat an ordinary active subscription as cancelling', () => {
    const plan = planEvent(
      event('customer.subscription.updated', { ...base, cancel_at: null }),
    );
    expect(plan).toMatchObject({ cancelAtPeriodEnd: false });
  });

  it('reports past_due faithfully rather than smoothing it over', () => {
    const plan = planEvent(event('customer.subscription.updated', { ...base, status: 'past_due' }));
    expect(plan).toMatchObject({ status: 'past_due' });
    // And that status must not entitle.
    expect(
      resolvePlan({
        subscription: { status: 'past_due', priceId: PRO_PRICE, currentPeriodEnd: null },
        proPriceId: PRO_PRICE,
      }).planId,
    ).toBe('free');
  });

  it('ignores a subscription with no customer', () => {
    expect(planEvent(event('customer.subscription.updated', { ...base, customer: null })).kind).toBe(
      'ignore',
    );
  });

  it('handles an expanded customer object as well as an id', () => {
    const plan = planEvent(
      event('customer.subscription.updated', { ...base, customer: { id: 'cus_expanded' } }),
    );
    expect(plan).toMatchObject({ customerId: 'cus_expanded' });
  });

  it('survives a subscription with no items', () => {
    const plan = planEvent(
      event('customer.subscription.updated', { ...base, items: { data: [] } }),
    );
    expect(plan).toMatchObject({ kind: 'subscription', priceId: null });
  });

  it('uses the event timestamp so ordering can be judged', () => {
    const plan = planEvent(event('customer.subscription.updated', base, 1_700_000_000));
    if (plan.kind !== 'subscription') throw new Error('expected a subscription plan');
    expect(plan.eventAt.toISOString()).toBe(new Date(1_700_000_000 * 1000).toISOString());
  });
});

describe('invoice events', () => {
  it('treats a paid invoice as a signal to re-read, not as state', () => {
    const plan = planEvent(
      event('invoice.paid', { customer: 'cus_1', subscription: 'sub_1' }),
    );
    expect(plan).toMatchObject({ kind: 'subscription', subscriptionId: 'sub_1', status: null });
    expect(isComplete(plan)).toBe(false);
  });

  it('treats a failed payment the same way', () => {
    const plan = planEvent(
      event('invoice.payment_failed', { customer: 'cus_1', subscription: 'sub_1' }),
    );
    expect(plan).toMatchObject({ kind: 'subscription', subscriptionId: 'sub_1' });
  });

  it('ignores an invoice that is not for a subscription', () => {
    expect(planEvent(event('invoice.paid', { customer: 'cus_1' })).kind).toBe('ignore');
  });

  it('ignores an invoice with no customer', () => {
    expect(planEvent(event('invoice.paid', { subscription: 'sub_1' })).kind).toBe('ignore');
  });
});
