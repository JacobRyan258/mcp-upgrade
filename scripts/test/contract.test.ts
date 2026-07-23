/**
 * The link between the scripts and the application.
 *
 * These are the tests that stop the setup script from drifting. Every one of
 * them fails if somebody changes the application without changing what gets
 * provisioned for it — which is precisely the failure mode of a setup script
 * that carries its own copy of the truth.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { HANDLED_EVENTS } from '@mcp-upgrade/shared';
import {
  ENV_KEYS,
  MANAGED_ENV_KEYS,
  PORTAL_CONTRACT,
  PRICE_CONTRACT,
  REPO_ROOT,
  REQUIRED_EVENTS,
  discoverWebhookPath,
  productContract,
} from '../stripe/contract.ts';

const read = (relative: string): string =>
  readFileSync(path.join(REPO_ROOT, relative), 'utf8');

describe('webhook route discovery', () => {
  it('finds the route the application actually serves', () => {
    expect(discoverWebhookPath()).toBe('/api/stripe/webhook');
  });

  it('agrees with where the handler file sits on disk', () => {
    // Belt and braces: if the directory moved, both this and the discovery
    // above change together, and a stale hardcoded path cannot survive.
    expect(() => read('apps/web/src/app/api/stripe/webhook/route.ts')).not.toThrow();
  });

  it('is the path the stripe:listen npm script forwards to', () => {
    // The CLI command is a literal string in package.json and cannot import
    // anything, so this is what stops it going stale when the route moves.
    const scripts = (JSON.parse(read('package.json')) as { scripts: Record<string, string> })
      .scripts;
    expect(scripts['stripe:listen']).toContain(`http://localhost:3000${discoverWebhookPath()}`);
  });

  it('refuses to guess when no handler verifies signatures', () => {
    expect(() => discoverWebhookPath(path.join(REPO_ROOT, 'apps/web/src/lib'))).toThrow(
      /no longer verifies signatures|No route handler/i,
    );
  });
});

describe('webhook events', () => {
  it('is exactly the set the handler dispatches on', () => {
    expect([...REQUIRED_EVENTS].sort()).toEqual([...HANDLED_EVENTS].sort());
  });

  it('covers the six subscription lifecycle events, and no others', () => {
    expect(REQUIRED_EVENTS).toEqual([
      'checkout.session.completed',
      'customer.subscription.created',
      'customer.subscription.deleted',
      'customer.subscription.updated',
      'invoice.paid',
      'invoice.payment_failed',
    ]);
  });

  it('does not subscribe to a wildcard', () => {
    expect(REQUIRED_EVENTS).not.toContain('*');
  });
});

describe('environment variable names', () => {
  it('are the names lib/env.ts actually reads', () => {
    const source = read('apps/web/src/lib/env.ts');
    for (const name of Object.values(ENV_KEYS)) {
      expect(source, `${name} must exist in lib/env.ts`).toContain(name);
    }
  });

  it('only manages the three server-side Stripe variables', () => {
    expect([...MANAGED_ENV_KEYS].sort()).toEqual([
      'STRIPE_PRO_MONTHLY_PRICE_ID',
      'STRIPE_SECRET_KEY',
      'STRIPE_WEBHOOK_SECRET',
    ]);
    // The publishable key is public and unrelated to provisioning, so nothing
    // this script does may write it.
    expect(MANAGED_ENV_KEYS).not.toContain(ENV_KEYS.publishableKey);
  });

  it('are the three `billingConfigured` requires', () => {
    const source = read('apps/web/src/lib/env.ts');
    const clause = source.slice(source.indexOf('export function billingConfigured'));
    for (const name of MANAGED_ENV_KEYS) {
      expect(clause.slice(0, 400)).toContain(name);
    }
  });
});

describe('the product and price being provisioned', () => {
  it('matches what the pricing page tells customers', () => {
    const pricing = read('apps/web/src/app/dashboard/billing/page.tsx');
    expect(pricing).toContain('$19');
    expect(PRICE_CONTRACT.unitAmount).toBe(1900);
    expect(PRICE_CONTRACT.currency).toBe('usd');
    expect(PRICE_CONTRACT.interval).toBe('month');
    expect(PRICE_CONTRACT.intervalCount).toBe(1);
  });

  it('is identified by metadata rather than by its display name', () => {
    const contract = productContract('test');
    expect(contract.metadata.application).toBe('mcp-upgrade');
    expect(contract.metadata.plan).toBe('pro');
    expect(contract.metadata.billing_period).toBe('monthly');
  });

  it('records which mode it was provisioned in', () => {
    expect(productContract('test').metadata.environment).toBe('test');
    expect(productContract('live').metadata.environment).toBe('live');
  });
});

describe('the portal contract', () => {
  it('leaves plan switching off, because exactly one price grants Pro', () => {
    // `resolvePlan` compares against a single configured price id. Letting a
    // customer switch plans in the portal would keep them paying while dropping
    // them to Free.
    const plans = read('packages/shared/src/plans.ts');
    expect(plans).toContain('subscription.priceId !== input.proPriceId');
    expect(PORTAL_CONTRACT.subscriptionUpdate).toBe(false);
  });

  it('enables only what the application supports', () => {
    expect(PORTAL_CONTRACT.subscriptionCancel).toBe(true);
    expect(PORTAL_CONTRACT.paymentMethodUpdate).toBe(true);
    expect(PORTAL_CONTRACT.invoiceHistory).toBe(true);
    expect(PORTAL_CONTRACT.customerUpdate).toBe(false);
  });

  it('returns customers to the page the portal route sends them from', () => {
    const route = read('apps/web/src/app/api/stripe/portal/route.ts');
    expect(route).toContain(PORTAL_CONTRACT.returnPath);
  });

  it('points at policy pages that exist', () => {
    expect(() => read(`apps/web/src/app${PORTAL_CONTRACT.privacyPath}/page.tsx`)).not.toThrow();
    expect(() => read(`apps/web/src/app${PORTAL_CONTRACT.termsPath}/page.tsx`)).not.toThrow();
  });
});
