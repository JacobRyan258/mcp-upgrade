/**
 * Provisioning behaviour.
 *
 * The properties under test are the ones that would cost real money or real
 * downtime to get wrong: never charging a customer against a price with the
 * wrong terms, never leaving two webhook endpoints on one URL when the
 * application holds one signing secret, and never doing any of it twice.
 */
import { describe, expect, it, vi } from 'vitest';
import { PRICE_CONTRACT, REQUIRED_EVENTS } from '../stripe/contract.ts';
import { dryRunGateway } from '../stripe/dry-run.ts';
import { ProvisionError, provision, sameEndpointUrl } from '../stripe/provision.ts';
import type { ProvisionResult } from '../stripe/provision.ts';
import type { StripeGateway } from '../stripe/gateway.ts';
import { FakeStripe, seedEndpoint, seedPrice, seedProduct } from './fake-stripe.ts';

const PROD_URL = 'https://upgrade.jacobryanlive.com/api/stripe/webhook';

function run(gateway: StripeGateway, urls: string[] = [PROD_URL]): Promise<ProvisionResult> {
  return provision({
    gateway,
    mode: 'test',
    webhookUrls: urls,
    portalBaseUrl: 'https://upgrade.jacobryanlive.com',
    configurePortal: true,
  });
}

function dispositionOf(result: ProvisionResult, resource: string): string | undefined {
  return result.changes.find((change) => change.resource === resource)?.disposition;
}

describe('a first run against an empty account', () => {
  it('creates the product, the price, the endpoint and the portal configuration', async () => {
    const fake = new FakeStripe();
    const result = await run(fake);

    expect(dispositionOf(result, 'product')).toBe('created');
    expect(dispositionOf(result, 'price')).toBe('created');
    expect(dispositionOf(result, 'webhook endpoint')).toBe('created');
    expect(dispositionOf(result, 'portal configuration')).toBe('created');

    expect(result.product.name).toBe('MCP Upgrade Pro');
    expect(result.product.metadata).toMatchObject({
      application: 'mcp-upgrade',
      plan: 'pro',
      billing_period: 'monthly',
      environment: 'test',
    });

    expect(result.price.unit_amount).toBe(1900);
    expect(result.price.currency).toBe('usd');
    expect(result.price.recurring).toEqual({ interval: 'month', interval_count: 1 });
    expect(result.price.lookup_key).toBe(PRICE_CONTRACT.lookupKey);
  });

  it('subscribes the endpoint to exactly the events the handler acts on', async () => {
    const fake = new FakeStripe();
    const result = await run(fake);
    expect(result.webhooks[0]!.endpoint.enabled_events).toEqual([...REQUIRED_EVENTS]);
    // Not "every event", and not a wildcard.
    expect(result.webhooks[0]!.endpoint.enabled_events).not.toContain('*');
  });

  it('returns the signing secret once, because Stripe only issues it once', async () => {
    const fake = new FakeStripe();
    const result = await run(fake);
    expect(result.webhooks[0]!.secret).toMatch(/^whsec_/);
  });

  it('turns off plan switching and customer editing in the portal', async () => {
    const fake = new FakeStripe();
    const result = await run(fake);
    const features = result.portal!.configuration.features;
    expect(features.subscription_update?.enabled).toBe(false);
    expect(features.customer_update?.enabled).toBe(false);
    expect(features.subscription_cancel?.enabled).toBe(true);
    expect(features.subscription_cancel?.mode).toBe('at_period_end');
    expect(features.payment_method_update?.enabled).toBe(true);
    expect(features.invoice_history?.enabled).toBe(true);
  });
});

describe('rerunning', () => {
  it('is idempotent: a second run writes nothing at all', async () => {
    const fake = new FakeStripe();
    await run(fake);
    const writesAfterFirst = fake.writes.length;
    expect(writesAfterFirst).toBeGreaterThan(0);

    const second = await run(fake);

    expect(fake.writes.length).toBe(writesAfterFirst);
    expect(dispositionOf(second, 'product')).toBe('reused');
    expect(dispositionOf(second, 'price')).toBe('reused');
    expect(dispositionOf(second, 'webhook endpoint')).toBe('reused');
    expect(dispositionOf(second, 'portal configuration')).toBe('reused');
  });

  it('does not create a second product or price', async () => {
    const fake = new FakeStripe();
    await run(fake);
    await run(fake);
    await run(fake);
    expect(fake.products).toHaveLength(1);
    expect(fake.prices).toHaveLength(1);
    expect(fake.endpoints).toHaveLength(1);
  });

  it('reports a reused endpoint as having no retrievable secret', async () => {
    const fake = new FakeStripe();
    await run(fake);
    const second = await run(fake);
    expect(second.webhooks[0]!.disposition).toBe('reused');
    expect(second.webhooks[0]!.secret).toBeNull();
  });
});

describe('an account somebody already set up by hand', () => {
  it('reuses a product that carries the right identity metadata', async () => {
    const fake = new FakeStripe();
    const existing = seedProduct(fake);
    const result = await run(fake);
    expect(result.product.id).toBe(existing.id);
    expect(dispositionOf(result, 'product')).toBe('reused');
    expect(fake.writes).not.toContain('products.create');
  });

  it('adopts an untagged product the lookup key already points at', async () => {
    const fake = new FakeStripe();
    const product = seedProduct(fake, { metadata: {}, name: 'Pro' });
    seedPrice(fake, { product: product.id });

    const result = await run(fake);

    expect(result.product.id).toBe(product.id);
    expect(dispositionOf(result, 'product')).toBe('updated');
    expect(result.product.metadata.application).toBe('mcp-upgrade');
    expect(fake.writes).not.toContain('products.create');
    expect(fake.writes).not.toContain('prices.create');
  });

  it('adopts a matching price that never had the lookup key attached', async () => {
    const fake = new FakeStripe();
    const product = seedProduct(fake);
    const price = seedPrice(fake, { product: product.id, lookup_key: null });

    const result = await run(fake);

    expect(result.price.id).toBe(price.id);
    expect(result.price.lookup_key).toBe(PRICE_CONTRACT.lookupKey);
    expect(fake.writes).not.toContain('prices.create');
  });

  it('brings a drifted product name and description back into line', async () => {
    const fake = new FakeStripe();
    seedProduct(fake, { name: 'Old name', description: 'stale' });
    const result = await run(fake);
    expect(dispositionOf(result, 'product')).toBe('updated');
    expect(result.product.name).toBe('MCP Upgrade Pro');
  });

  it('leaves metadata it does not own alone when reconciling', async () => {
    const fake = new FakeStripe();
    seedProduct(fake, {
      name: 'Old name',
      metadata: { application: 'mcp-upgrade', plan: 'pro', ledger_code: 'XYZ' },
    });
    const result = await run(fake);
    expect(result.product.metadata.ledger_code).toBe('XYZ');
  });
});

describe('refusing to reuse a price that would charge the wrong thing', () => {
  const cases: { why: string; overrides: Record<string, unknown>; expected: RegExp }[] = [
    { why: 'the wrong amount', overrides: { unit_amount: 900 }, expected: /amount is 900/ },
    { why: 'the wrong currency', overrides: { currency: 'eur' }, expected: /currency is EUR/ },
    {
      why: 'a yearly interval',
      overrides: { recurring: { interval: 'year', interval_count: 1 } },
      expected: /renews every year/,
    },
    {
      why: 'a three-month interval',
      overrides: { recurring: { interval: 'month', interval_count: 3 } },
      expected: /interval count is 3/,
    },
    {
      why: 'being one-off rather than recurring',
      overrides: { type: 'one_time', recurring: null },
      expected: /one-off price/,
    },
    { why: 'being archived', overrides: { active: false }, expected: /archived/ },
  ];

  for (const { why, overrides, expected } of cases) {
    it(`fails clearly when the lookup key points at a price with ${why}`, async () => {
      const fake = new FakeStripe();
      const product = seedProduct(fake);
      seedPrice(fake, { product: product.id, ...overrides });

      await expect(run(fake)).rejects.toThrow(ProvisionError);
      await expect(run(fake)).rejects.toThrow(expected);
      // And it must not have quietly created a replacement instead.
      expect(fake.writes).not.toContain('prices.create');
    });
  }

  it('explains that billing terms are immutable rather than trying to fix them', async () => {
    const fake = new FakeStripe();
    const product = seedProduct(fake);
    seedPrice(fake, { product: product.id, unit_amount: 900 });

    await expect(run(fake)).rejects.toMatchObject({
      guidance: expect.stringContaining('immutable'),
    });
  });
});

describe('refusing to guess when the account is ambiguous', () => {
  it('fails when two products claim to be this plan', async () => {
    const fake = new FakeStripe();
    seedProduct(fake);
    seedProduct(fake);
    await expect(run(fake)).rejects.toThrow(/2 active products are tagged/);
  });

  it('fails when the product belongs to a different application', async () => {
    const fake = new FakeStripe();
    const product = seedProduct(fake, { metadata: { application: 'something-else', plan: 'pro' } });
    seedPrice(fake, { product: product.id });
    await expect(run(fake)).rejects.toThrow(/belongs to a different application/);
  });

  it('fails when two endpoints already share one URL', async () => {
    const fake = new FakeStripe();
    seedEndpoint(fake, { url: PROD_URL });
    seedEndpoint(fake, { url: PROD_URL });
    await expect(run(fake)).rejects.toThrow(/2 webhook endpoints already point at/);
    expect(fake.writes).not.toContain('webhookEndpoints.create');
  });

  it('never deletes anything, whatever the conflict', async () => {
    const fake = new FakeStripe();
    seedEndpoint(fake, { url: PROD_URL });
    seedEndpoint(fake, { url: PROD_URL });
    await expect(run(fake)).rejects.toThrow();
    expect(fake.endpoints).toHaveLength(2);
    expect(fake.writes.join(' ')).not.toMatch(/del/i);
  });
});

describe('webhook endpoints', () => {
  it('does not create a duplicate for a URL that differs only by a trailing slash', async () => {
    const fake = new FakeStripe();
    seedEndpoint(fake, { url: `${PROD_URL}/` });
    const result = await run(fake);
    expect(result.webhooks[0]!.disposition).toBe('reused');
    expect(fake.endpoints).toHaveLength(1);
  });

  it('compares URLs tolerantly of one trailing slash and nothing else', () => {
    expect(sameEndpointUrl('https://a.test/hook', 'https://a.test/hook/')).toBe(true);
    expect(sameEndpointUrl('https://a.test/hook', 'https://a.test/hooks')).toBe(false);
    expect(sameEndpointUrl('https://a.test/hook', 'http://a.test/hook')).toBe(false);
  });

  it('adds the events an existing endpoint is missing', async () => {
    const fake = new FakeStripe();
    seedEndpoint(fake, { url: PROD_URL, enabled_events: ['checkout.session.completed'] });

    const result = await run(fake);

    expect(result.webhooks[0]!.disposition).toBe('updated');
    expect(result.webhooks[0]!.addedEvents).toContain('invoice.payment_failed');
    for (const event of REQUIRED_EVENTS) {
      expect(result.webhooks[0]!.endpoint.enabled_events).toContain(event);
    }
  });

  it('preserves extra events somebody else added rather than removing them', async () => {
    const fake = new FakeStripe();
    seedEndpoint(fake, {
      url: PROD_URL,
      enabled_events: ['checkout.session.completed', 'payout.paid'],
    });

    const result = await run(fake);

    expect(result.webhooks[0]!.endpoint.enabled_events).toContain('payout.paid');
    expect(result.webhooks[0]!.extraEvents).toEqual(['payout.paid']);
  });

  it('treats a wildcard subscription as already covering everything', async () => {
    const fake = new FakeStripe();
    seedEndpoint(fake, { url: PROD_URL, enabled_events: ['*'] });
    const result = await run(fake);
    expect(result.webhooks[0]!.disposition).toBe('reused');
    expect(fake.writes).not.toContain('webhookEndpoints.update');
  });

  it('registers nothing when there is no public URL to register', async () => {
    const fake = new FakeStripe();
    const result = await run(fake, []);
    expect(result.webhooks).toHaveLength(0);
    expect(fake.writes).not.toContain('webhookEndpoints.create');
  });
});

describe('the customer portal', () => {
  it('updates the account default rather than creating a second configuration', async () => {
    const fake = new FakeStripe();
    await run(fake);
    // Drift it the way a dashboard edit would.
    fake.portals[0]!.features.subscription_update = { enabled: true };

    const result = await run(fake);

    expect(result.portal!.disposition).toBe('updated');
    expect(fake.portals).toHaveLength(1);
    expect(result.portal!.configuration.features.subscription_update?.enabled).toBe(false);
  });

  it('can be skipped entirely', async () => {
    const fake = new FakeStripe();
    await provision({
      gateway: fake,
      mode: 'test',
      webhookUrls: [],
      portalBaseUrl: 'https://upgrade.jacobryanlive.com',
      configurePortal: false,
    });
    expect(fake.portals).toHaveLength(0);
    expect(fake.writes).not.toContain('billingPortal.configurations.create');
  });
});

describe('dry run', () => {
  it('creates nothing against an empty account while reporting the full plan', async () => {
    const fake = new FakeStripe();
    const dry = dryRunGateway(fake, false);

    const result = await run(dry);

    expect(fake.writes).toEqual([]);
    expect(fake.products).toEqual([]);
    expect(fake.prices).toEqual([]);
    expect(fake.endpoints).toEqual([]);
    expect(fake.portals).toEqual([]);

    expect(dry.planned.map((write) => write.operation)).toEqual([
      'products.create',
      'prices.create',
      'webhookEndpoints.create',
      'billingPortal.configurations.create',
    ]);
    expect(dispositionOf(result, 'price')).toBe('created');
  });

  it('never produces something that looks like a signing secret', async () => {
    const fake = new FakeStripe();
    const dry = dryRunGateway(fake, false);
    const result = await run(dry);
    expect(result.webhooks[0]!.secret).toBeNull();
  });

  it('never asks the API about an object it only pretended to create', async () => {
    // Forwarding `listPricesForProduct('prod_WOULD_BE_CREATED')` to Stripe
    // answers "no such product" and aborts the whole plan at the first step.
    const fake = new FakeStripe();
    const forProduct = vi.spyOn(fake, 'listPricesForProduct');
    const retrieve = vi.spyOn(fake, 'retrieveProduct');

    await expect(run(dryRunGateway(fake, false))).resolves.toBeDefined();

    expect(forProduct).not.toHaveBeenCalled();
    expect(retrieve).not.toHaveBeenCalled();
  });

  it('plans no writes when the account already matches', async () => {
    const fake = new FakeStripe();
    await run(fake);
    const dry = dryRunGateway(fake, false);
    await run(dry);
    expect(dry.planned).toEqual([]);
  });
});

describe('API failures', () => {
  it('propagates rather than reporting success', async () => {
    const fake = new FakeStripe({ failing: ['products.create'] });
    await expect(run(fake)).rejects.toThrow(/fake Stripe failure on products.create/);
  });

  it('leaves the account untouched past the point of failure', async () => {
    const fake = new FakeStripe({ failing: ['prices.create'] });
    await expect(run(fake)).rejects.toThrow();
    expect(fake.endpoints).toEqual([]);
    expect(fake.portals).toEqual([]);
  });
});
