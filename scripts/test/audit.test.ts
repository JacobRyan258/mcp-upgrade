/**
 * The read-only verification.
 *
 * Two things are being asserted: that it notices everything that would make the
 * application misbehave, and that it writes nothing while doing so.
 */
import { describe, expect, it } from 'vitest';
import { audit } from '../stripe/audit.ts';
import type { AuditReport, CheckStatus } from '../stripe/audit.ts';
import { provision } from '../stripe/provision.ts';
import { FakeStripe, seedEndpoint, seedPrice, seedProduct } from './fake-stripe.ts';

const BASE = 'https://upgrade.jacobryanlive.com';
const URL = `${BASE}/api/stripe/webhook`;

async function provisioned(): Promise<FakeStripe> {
  const fake = new FakeStripe();
  await provision({
    gateway: fake,
    mode: 'test',
    webhookUrls: [URL],
    portalBaseUrl: BASE,
    configurePortal: true,
  });
  fake.writes.length = 0;
  return fake;
}

function check(report: AuditReport, name: string): CheckStatus | undefined {
  return report.checks.find((entry) => entry.name === name)?.status;
}

async function run(fake: FakeStripe, envPriceId: string | null): Promise<AuditReport> {
  return audit({
    gateway: fake,
    mode: 'test',
    webhookUrls: [URL],
    configuredPortal: true,
    portalBaseUrl: BASE,
    envPriceId,
    envSource: 'the process environment',
  });
}

describe('a correctly provisioned account', () => {
  it('passes every check', async () => {
    const fake = await provisioned();
    const report = await run(fake, fake.prices[0]!.id);

    expect(report.ok).toBe(true);
    expect(report.checks.filter((entry) => entry.status === 'fail')).toEqual([]);
    expect(check(report, 'price exists')).toBe('pass');
    expect(check(report, 'price terms')).toBe('pass');
    expect(check(report, 'product exists')).toBe('pass');
    expect(check(report, `webhook ${URL}`)).toBe('pass');
    expect(check(report, `webhook ${URL} events`)).toBe('pass');
    expect(check(report, 'customer portal')).toBe('pass');
    expect(check(report, 'configured price id')).toBe('pass');
  });

  it('writes nothing', async () => {
    const fake = await provisioned();
    await run(fake, fake.prices[0]!.id);
    expect(fake.writes).toEqual([]);
  });
});

describe('catching a broken account', () => {
  it('fails when no price holds the lookup key', async () => {
    const report = await run(new FakeStripe(), null);
    expect(report.ok).toBe(false);
    expect(check(report, 'price exists')).toBe('fail');
  });

  it('fails when the price charges the wrong amount', async () => {
    const fake = new FakeStripe();
    const product = seedProduct(fake);
    seedPrice(fake, { product: product.id, unit_amount: 900 });
    const report = await run(fake, null);
    expect(check(report, 'price terms')).toBe('fail');
    expect(report.ok).toBe(false);
  });

  it('fails when the price is archived', async () => {
    const fake = new FakeStripe();
    const product = seedProduct(fake);
    seedPrice(fake, { product: product.id, active: false });
    expect(check(await run(fake, null), 'price terms')).toBe('fail');
  });

  it('fails when the price belongs to a product that cannot be read', async () => {
    const fake = new FakeStripe();
    seedPrice(fake, { product: 'prod_gone' });
    expect(check(await run(fake, null), 'product exists')).toBe('fail');
  });

  it('fails when no endpoint is registered for the URL', async () => {
    const fake = new FakeStripe();
    const product = seedProduct(fake);
    seedPrice(fake, { product: product.id });
    expect(check(await run(fake, null), `webhook ${URL}`)).toBe('fail');
  });

  it('fails when the endpoint is missing a required event', async () => {
    const fake = await provisioned();
    fake.endpoints[0]!.enabled_events = ['checkout.session.completed'];
    const report = await run(fake, fake.prices[0]!.id);
    expect(check(report, `webhook ${URL} events`)).toBe('fail');
    expect(report.ok).toBe(false);
  });

  it('fails when the endpoint is disabled', async () => {
    const fake = await provisioned();
    fake.endpoints[0]!.status = 'disabled';
    expect(check(await run(fake, fake.prices[0]!.id), `webhook ${URL} status`)).toBe('fail');
  });

  it('fails when two endpoints share the URL', async () => {
    const fake = await provisioned();
    seedEndpoint(fake, { url: URL });
    expect(check(await run(fake, fake.prices[0]!.id), `webhook ${URL}`)).toBe('fail');
  });

  it('fails when the configured price id is not the one in Stripe', async () => {
    const fake = await provisioned();
    const report = await run(fake, 'price_something_else');
    expect(check(report, 'configured price id')).toBe('fail');
    expect(report.ok).toBe(false);
  });

  it('fails when there is no default portal configuration', async () => {
    const fake = await provisioned();
    fake.portals = [];
    expect(check(await run(fake, fake.prices[0]!.id), 'customer portal')).toBe('fail');
  });

  it('fails when a test-mode key returns a live-mode object', async () => {
    const fake = await provisioned();
    fake.prices[0]!.livemode = true;
    const report = await run(fake, fake.prices[0]!.id);
    expect(check(report, 'price mode')).toBe('fail');
    expect(report.ok).toBe(false);
  });
});

describe('a correctly provisioned live-mode account', () => {
  it('passes the credential-mode check rather than warning, and warns about nothing', async () => {
    // The live launch requires `stripe:verify -- --live` to report zero
    // warnings; a live credential is the intended input to that command, not a
    // condition to warn about. This is the check that makes that possible.
    const fake = new FakeStripe({ livemode: true, account: 'acct_live_fake' });
    await provision({
      gateway: fake,
      mode: 'live',
      webhookUrls: [URL],
      portalBaseUrl: BASE,
      configurePortal: true,
    });
    fake.writes.length = 0;

    const report = await audit({
      gateway: fake,
      mode: 'live',
      webhookUrls: [URL],
      configuredPortal: true,
      portalBaseUrl: BASE,
      envPriceId: fake.prices[0]!.id,
      envSource: 'the process environment',
    });

    expect(check(report, 'credential mode')).toBe('pass');
    expect(report.ok).toBe(true);
    expect(report.checks.filter((entry) => entry.status === 'warn')).toEqual([]);
    // Read-only: verification must never write, in any mode.
    expect(fake.writes).toEqual([]);
  });
});

describe('warnings that do not fail the run', () => {
  it('warns rather than fails about extra events on the endpoint', async () => {
    const fake = await provisioned();
    fake.endpoints[0]!.enabled_events.push('payout.paid');
    const report = await run(fake, fake.prices[0]!.id);
    expect(check(report, `webhook ${URL} extra events`)).toBe('warn');
    expect(report.ok).toBe(true);
  });

  it('warns when the price id is not configured at all', async () => {
    const fake = await provisioned();
    const report = await run(fake, null);
    expect(check(report, 'configured price id')).toBe('warn');
    expect(report.ok).toBe(true);
  });

  it('warns when the portal has drifted but still works', async () => {
    const fake = await provisioned();
    fake.portals[0]!.default_return_url = 'https://elsewhere.test/';
    const report = await run(fake, fake.prices[0]!.id);
    expect(check(report, 'portal capabilities')).toBe('warn');
    expect(report.ok).toBe(true);
  });
});

describe('reporting what a restricted key can do', () => {
  it('fails only on the read the runtime genuinely needs', async () => {
    const fake = new FakeStripe({ forbidden: ['customers', 'products'] });
    const report = await audit({
      gateway: fake,
      mode: 'test',
      webhookUrls: [],
      configuredPortal: false,
      portalBaseUrl: BASE,
      envPriceId: null,
      envSource: 'x',
    });
    expect(check(report, 'read customers')).toBe('warn');
    expect(check(report, 'read products')).toBe('warn');
    expect(check(report, 'read subscriptions')).toBe('pass');
  });

  it('fails when subscriptions cannot be read, because the webhook re-reads them', async () => {
    const fake = new FakeStripe({ forbidden: ['subscriptions'] });
    const report = await audit({
      gateway: fake,
      mode: 'test',
      webhookUrls: [],
      configuredPortal: false,
      portalBaseUrl: BASE,
      envPriceId: null,
      envSource: 'x',
    });
    expect(check(report, 'read subscriptions')).toBe('fail');
    expect(report.ok).toBe(false);
  });

  it('says plainly that write permissions were not tested', async () => {
    const report = await run(await provisioned(), null);
    const entry = report.checks.find((check_) => check_.name === 'write permissions');
    expect(entry?.status).toBe('skip');
    expect(entry?.detail).toMatch(/cannot be probed without creating objects/);
  });
});

describe('skipping what cannot be checked', () => {
  it('skips webhooks when only a local origin was given', async () => {
    const fake = await provisioned();
    const report = await audit({
      gateway: fake,
      mode: 'test',
      webhookUrls: [],
      configuredPortal: true,
      portalBaseUrl: BASE,
      envPriceId: fake.prices[0]!.id,
      envSource: 'x',
    });
    expect(check(report, 'webhook endpoint')).toBe('skip');
    expect(report.ok).toBe(true);
  });
});
