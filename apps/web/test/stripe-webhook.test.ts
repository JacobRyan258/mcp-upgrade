/**
 * The webhook route itself.
 *
 * `billing.test.ts` covers what an event *means*; this covers the handler that
 * decides whether an event is even allowed to reach that logic. Each test here
 * corresponds to a defect found while auditing the handler against the Stripe
 * provisioning work:
 *
 *   - a live-mode signing secret paired with a test-mode API key was accepted,
 *     and failed later and confusingly inside the subscription re-read;
 *   - `hydrate` wrote whatever customer the fetched subscription named, without
 *     checking it against the customer the verified event named;
 *   - the live-key guard matched only `sk_live_`, so the restricted live key
 *     this application is meant to be deployed with went straight through.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const database = vi.hoisted(() => ({
  claimStripeEvent: vi.fn(async (): Promise<'claimed' | 'duplicate'> => 'claimed'),
  finishStripeEvent: vi.fn(async () => undefined),
  releaseStripeEvent: vi.fn(async () => undefined),
  findUserByStripeCustomer: vi.fn(async (): Promise<string | null> => 'user-1'),
  getSubscription: vi.fn(async (): Promise<{ stripeCustomerId: string } | null> => null),
  linkStripeCustomer: vi.fn(async () => ({ linked: true, existingCustomerId: null })),
  applySubscription: vi.fn(async (): Promise<'applied' | 'stale'> => 'applied'),
}));

const stripe = vi.hoisted(() => ({
  constructEvent: vi.fn(),
  retrieveSubscription: vi.fn(),
}));

vi.mock('@mcp-upgrade/database', () => database);

vi.mock('../src/lib/stripe/client', () => ({
  getStripe: () => ({
    webhooks: { constructEvent: stripe.constructEvent },
    subscriptions: { retrieve: stripe.retrieveSubscription },
  }),
  isTestMode: () => true,
  resetStripeCache: () => undefined,
}));

const BASE_ENV = {
  NODE_ENV: 'test',
  NEXT_PUBLIC_APP_URL: 'http://localhost:3000',
  NEXT_PUBLIC_SUPABASE_URL: 'https://example.supabase.co',
  NEXT_PUBLIC_SUPABASE_ANON_KEY: 'anon',
  SUPABASE_SERVICE_ROLE_KEY: 'service',
  DATABASE_URL: 'postgresql://localhost/db',
  WORKER_SHARED_SECRET: 'x'.repeat(40),
  STRIPE_SECRET_KEY: 'sk_test_0123456789abcdefghij',
  STRIPE_WEBHOOK_SECRET: 'whsec_fakelocal',
  STRIPE_PRO_MONTHLY_PRICE_ID: 'price_pro',
};

function subscriptionEvent(overrides: Record<string, unknown> = {}) {
  return {
    id: 'evt_1',
    type: 'customer.subscription.updated',
    created: 1_753_000_000,
    livemode: false,
    data: {
      object: {
        id: 'sub_1',
        customer: 'cus_1',
        status: 'active',
        cancel_at_period_end: false,
        items: { data: [{ price: { id: 'price_pro' }, current_period_end: 1_753_600_000 }] },
      },
    },
    ...overrides,
  };
}

async function post(headers: Record<string, string> = { 'stripe-signature': 't=1,v1=abc' }) {
  const { POST } = await import('../src/app/api/stripe/webhook/route');
  return POST(new Request('http://localhost:3000/api/stripe/webhook', {
    method: 'POST',
    headers,
    body: '{"id":"evt_1"}',
  }));
}

beforeEach(async () => {
  vi.resetModules();
  for (const [key, value] of Object.entries(BASE_ENV)) process.env[key] = value;
  const { resetEnvCache } = await import('../src/lib/env');
  resetEnvCache();
  stripe.constructEvent.mockReset().mockReturnValue(subscriptionEvent());
  stripe.retrieveSubscription.mockReset();
  for (const fn of Object.values(database)) fn.mockClear();
  database.claimStripeEvent.mockResolvedValue('claimed');
  database.findUserByStripeCustomer.mockResolvedValue('user-1');
  database.applySubscription.mockResolvedValue('applied');
});

afterEach(() => {
  for (const key of Object.keys(BASE_ENV)) delete process.env[key];
});

describe('signature handling', () => {
  it('reads the raw body and verifies it before parsing anything', async () => {
    await post();
    expect(stripe.constructEvent).toHaveBeenCalledWith(
      '{"id":"evt_1"}',
      't=1,v1=abc',
      BASE_ENV.STRIPE_WEBHOOK_SECRET,
    );
  });

  it('rejects a request with no signature header, without claiming the event', async () => {
    const response = await post({});
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: 'missing_signature' });
    expect(database.claimStripeEvent).not.toHaveBeenCalled();
  });

  it('rejects an invalid signature and says nothing about why', async () => {
    stripe.constructEvent.mockImplementation(() => {
      throw new Error('no signatures found matching the expected signature for payload');
    });
    const response = await post();
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body).toEqual({ error: 'invalid_signature' });
    // The reason would tell a prober how close their forgery was.
    expect(JSON.stringify(body)).not.toMatch(/signature for payload/);
    expect(database.applySubscription).not.toHaveBeenCalled();
  });

  it('refuses to run at all when no signing secret is configured', async () => {
    delete process.env.STRIPE_WEBHOOK_SECRET;
    vi.resetModules();
    const { resetEnvCache } = await import('../src/lib/env');
    resetEnvCache();
    const response = await post();
    expect(response.status).toBe(503);
    expect(stripe.constructEvent).not.toHaveBeenCalled();
  });
});

describe('mode mismatch', () => {
  it('rejects a live-mode event delivered to a test-mode deployment', async () => {
    stripe.constructEvent.mockReturnValue(subscriptionEvent({ livemode: true }));
    const response = await post();
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: 'mode_mismatch' });
  });

  it('does not claim the event id, so fixing the configuration allows a retry', async () => {
    stripe.constructEvent.mockReturnValue(subscriptionEvent({ livemode: true }));
    await post();
    expect(database.claimStripeEvent).not.toHaveBeenCalled();
    expect(database.applySubscription).not.toHaveBeenCalled();
  });

  it('accepts a live-mode event when the key is a live-mode key', async () => {
    process.env.STRIPE_SECRET_KEY = 'sk_live_fake';
    vi.resetModules();
    const { resetEnvCache } = await import('../src/lib/env');
    resetEnvCache();
    stripe.constructEvent.mockReturnValue(subscriptionEvent({ livemode: true }));
    const response = await post();
    expect(response.status).toBe(200);
  });

  it('treats a restricted live key as live mode, not as unknown', async () => {
    process.env.STRIPE_SECRET_KEY = 'rk_live_fake';
    vi.resetModules();
    const { resetEnvCache } = await import('../src/lib/env');
    resetEnvCache();
    // A test-mode event now mismatches, which is the correct reading.
    stripe.constructEvent.mockReturnValue(subscriptionEvent({ livemode: false }));
    const response = await post();
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: 'mode_mismatch' });
  });
});

describe('idempotency', () => {
  it('does nothing on a second delivery of the same event id', async () => {
    database.claimStripeEvent.mockResolvedValue('duplicate');
    const response = await post();
    await expect(response.json()).resolves.toMatchObject({ received: true, duplicate: true });
    expect(database.applySubscription).not.toHaveBeenCalled();
  });

  it('releases the claim when processing throws, so the retry is not swallowed', async () => {
    database.applySubscription.mockRejectedValue(new Error('database is down'));
    const response = await post();
    expect(response.status).toBe(500);
    expect(database.releaseStripeEvent).toHaveBeenCalledWith('evt_1');
  });

  it('marks the event finished with its outcome on success', async () => {
    await post();
    expect(database.finishStripeEvent).toHaveBeenCalledWith('evt_1', 'applied');
  });

  it('reports a stale event as stale rather than applied', async () => {
    database.applySubscription.mockResolvedValue('stale');
    const response = await post();
    await expect(response.json()).resolves.toMatchObject({ outcome: 'stale' });
  });
});

describe('customer to user mapping', () => {
  it('prefers the stored mapping over the metadata hint', async () => {
    database.findUserByStripeCustomer.mockResolvedValue('user-stored');
    stripe.constructEvent.mockReturnValue(
      subscriptionEvent({
        data: {
          object: {
            id: 'sub_1',
            customer: 'cus_1',
            status: 'active',
            cancel_at_period_end: false,
            metadata: { userId: 'user-claimed-by-attacker' },
            items: { data: [{ price: { id: 'price_pro' } }] },
          },
        },
      }),
    );
    await post();
    expect(database.applySubscription).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'user-stored' }),
    );
  });

  it('ignores an event for a customer it has never seen and cannot map', async () => {
    database.findUserByStripeCustomer.mockResolvedValue(null);
    const response = await post();
    await expect(response.json()).resolves.toMatchObject({ outcome: 'ignored' });
    expect(database.applySubscription).not.toHaveBeenCalled();
  });

  it('refuses a hint naming a user who already has a different customer', async () => {
    database.findUserByStripeCustomer.mockResolvedValue(null);
    database.getSubscription.mockResolvedValue({ stripeCustomerId: 'cus_somebody_else' });
    stripe.constructEvent.mockReturnValue(
      subscriptionEvent({
        data: {
          object: {
            id: 'sub_1',
            customer: 'cus_1',
            status: 'active',
            cancel_at_period_end: false,
            metadata: { userId: 'victim' },
            items: { data: [{ price: { id: 'price_pro' } }] },
          },
        },
      }),
    );
    const response = await post();
    await expect(response.json()).resolves.toMatchObject({ outcome: 'ignored' });
    expect(database.applySubscription).not.toHaveBeenCalled();
  });
});

describe('re-reading a subscription', () => {
  const invoiceEvent = {
    id: 'evt_2',
    type: 'invoice.paid',
    created: 1_753_000_000,
    livemode: false,
    data: { object: { customer: 'cus_1', subscription: 'sub_1' } },
  };

  it('fetches the subscription rather than trusting the invoice', async () => {
    stripe.constructEvent.mockReturnValue(invoiceEvent);
    stripe.retrieveSubscription.mockResolvedValue({
      id: 'sub_1',
      customer: 'cus_1',
      status: 'active',
      cancel_at_period_end: false,
      items: { data: [{ price: { id: 'price_pro' }, current_period_end: 1_753_600_000 }] },
    });

    await post();

    expect(stripe.retrieveSubscription).toHaveBeenCalledWith('sub_1');
    expect(database.applySubscription).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'active', priceId: 'price_pro' }),
    );
  });

  it('keeps the original event timestamp so ordering stays Stripe\'s', async () => {
    stripe.constructEvent.mockReturnValue(invoiceEvent);
    stripe.retrieveSubscription.mockResolvedValue({
      id: 'sub_1',
      customer: 'cus_1',
      status: 'active',
      cancel_at_period_end: false,
      items: { data: [{ price: { id: 'price_pro' } }] },
    });
    await post();
    expect(database.applySubscription).toHaveBeenCalledWith(
      expect.objectContaining({ eventAt: new Date(1_753_000_000 * 1000) }),
    );
  });

  it('refuses to write when the fetched subscription names a different customer', async () => {
    // The event was verified for cus_1 and the user was resolved from cus_1.
    // Writing state belonging to cus_2 onto that user is the failure this
    // check exists to make impossible.
    stripe.constructEvent.mockReturnValue(invoiceEvent);
    stripe.retrieveSubscription.mockResolvedValue({
      id: 'sub_1',
      customer: 'cus_2',
      status: 'active',
      cancel_at_period_end: false,
      items: { data: [{ price: { id: 'price_pro' } }] },
    });

    const response = await post();

    await expect(response.json()).resolves.toMatchObject({ outcome: 'ignored' });
    expect(database.applySubscription).not.toHaveBeenCalled();
  });

  it('ignores an invoice whose subscription cannot be resolved', async () => {
    stripe.constructEvent.mockReturnValue({
      ...invoiceEvent,
      data: { object: { customer: 'cus_1' } },
    });
    const response = await post();
    await expect(response.json()).resolves.toMatchObject({ outcome: 'ignored' });
    expect(stripe.retrieveSubscription).not.toHaveBeenCalled();
  });
});
