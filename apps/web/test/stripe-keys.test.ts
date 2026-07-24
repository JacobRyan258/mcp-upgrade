/**
 * Credential-mode guard rails.
 *
 * Both guards below existed and both were inert against the credential this
 * application should actually be deployed with. A restricted key is the least
 * privileged option Stripe offers, so it is the one people are told to use —
 * and `startsWith('sk_live_')` waves `rk_live_` straight through, while
 * `startsWith('sk_test_')` tells an `rk_test_` deployment it is not in test
 * mode and hides the "no real payment will be taken" banner.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { describeStripeKey, isLiveModeKey, stripeKeyMode } from '@mcp-upgrade/shared';
import { assertEnvironment, resetEnvCache } from '../src/lib/env';
import { getStripe, isTestMode, resetStripeCache } from '../src/lib/stripe/client';

const BASE = {
  NEXT_PUBLIC_APP_URL: 'https://upgrade.jacobryanlive.com',
  NEXT_PUBLIC_SUPABASE_URL: 'https://example.supabase.co',
  NEXT_PUBLIC_SUPABASE_ANON_KEY: 'anon',
  SUPABASE_SERVICE_ROLE_KEY: 'service',
  DATABASE_URL: 'postgresql://localhost/db',
  WORKER_SHARED_SECRET: 'x'.repeat(40),
};

const MANAGED = [
  ...Object.keys(BASE),
  'NODE_ENV',
  'STRIPE_SECRET_KEY',
  'STRIPE_WEBHOOK_SECRET',
  'STRIPE_PRO_MONTHLY_PRICE_ID',
  'NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY',
  'VERCEL_ENV',
  'DEPLOY_ENV',
];

function configure(overrides: Record<string, string | undefined>): void {
  resetEnvCache();
  resetStripeCache();
  // The deployment-environment signals decide whether a live key is permitted,
  // so they are cleared before every configuration and only set by a test that
  // means to — a leaked VERCEL_ENV would silently change what the guard allows.
  delete process.env.VERCEL_ENV;
  delete process.env.DEPLOY_ENV;
  for (const [key, value] of Object.entries({ ...BASE, ...overrides })) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

beforeEach(() => {
  configure({ NODE_ENV: 'test' });
});

afterEach(() => {
  for (const key of MANAGED) delete process.env[key];
  resetEnvCache();
  resetStripeCache();
});

describe('key classification', () => {
  it('treats restricted keys as first-class credentials', () => {
    expect(stripeKeyMode('rk_test_abc')).toBe('test');
    expect(stripeKeyMode('rk_live_abc')).toBe('live');
    expect(isLiveModeKey('rk_live_abc')).toBe(true);
    expect(describeStripeKey('rk_test_abc')).toBe('test-mode restricted key');
  });

  it('does not fall back to "probably test" for anything unrecognised', () => {
    expect(stripeKeyMode('sk_sandbox_abc')).toBe('unknown');
    expect(isLiveModeKey('sk_sandbox_abc')).toBe(false);
    // Not live, but also not test — so nothing that requires test mode passes.
    expect(stripeKeyMode('sk_sandbox_abc')).not.toBe('test');
  });
});

describe('the billing page test-mode banner', () => {
  it('shows for a restricted test key, not just a secret test key', () => {
    configure({ NODE_ENV: 'test', STRIPE_SECRET_KEY: 'sk_test_abc' });
    expect(isTestMode()).toBe(true);
    configure({ NODE_ENV: 'test', STRIPE_SECRET_KEY: 'rk_test_abc' });
    expect(isTestMode()).toBe(true);
  });

  it('stays hidden for live keys of either kind', () => {
    configure({ NODE_ENV: 'test', STRIPE_SECRET_KEY: 'sk_live_abc' });
    expect(isTestMode()).toBe(false);
    configure({ NODE_ENV: 'test', STRIPE_SECRET_KEY: 'rk_live_abc' });
    expect(isTestMode()).toBe(false);
  });
});

describe('the live-key guard on getStripe', () => {
  // A live key is permitted only on a real production deployment. NODE_ENV
  // alone does not establish that — a Vercel Preview build and a local
  // `next start` both run with NODE_ENV=production — so the guard reads the
  // deployment signal (VERCEL_ENV) rather than trusting NODE_ENV.
  it('refuses a live secret key outside a production deployment', () => {
    configure({ NODE_ENV: 'production', STRIPE_SECRET_KEY: 'sk_live_abc' });
    expect(() => getStripe()).toThrow(/test mode only/);
  });

  it('refuses a live restricted key outside a production deployment', () => {
    configure({ NODE_ENV: 'production', STRIPE_SECRET_KEY: 'rk_live_abc' });
    expect(() => getStripe()).toThrow(/test mode only/);
  });

  it('refuses a credential it cannot classify rather than allowing it', () => {
    configure({ NODE_ENV: 'production', STRIPE_SECRET_KEY: 'totally-made-up' });
    expect(() => getStripe()).toThrow(/not a recognised test-mode or live-mode Stripe key/);
  });

  it('allows a restricted test key', () => {
    configure({ NODE_ENV: 'production', STRIPE_SECRET_KEY: 'rk_test_abc' });
    expect(() => getStripe()).not.toThrow();
  });

  it('refuses a live key on a Preview deployment', () => {
    configure({ NODE_ENV: 'production', VERCEL_ENV: 'preview', STRIPE_SECRET_KEY: 'rk_live_abc' });
    expect(() => getStripe()).toThrow(/test mode only/);
  });

  it('refuses a live key in local development, where it used to be waved through', () => {
    configure({ NODE_ENV: 'development', STRIPE_SECRET_KEY: 'sk_live_abc' });
    expect(() => getStripe()).toThrow(/test mode only/);
  });

  it('permits a live restricted key on a production deployment', () => {
    configure({ NODE_ENV: 'production', VERCEL_ENV: 'production', STRIPE_SECRET_KEY: 'rk_live_abc' });
    expect(() => getStripe()).not.toThrow();
  });

  it('permits a live secret key on a production deployment', () => {
    configure({ NODE_ENV: 'production', VERCEL_ENV: 'production', STRIPE_SECRET_KEY: 'sk_live_abc' });
    expect(() => getStripe()).not.toThrow();
  });

  it('honours DEPLOY_ENV=production as the non-Vercel escape hatch', () => {
    configure({ NODE_ENV: 'production', DEPLOY_ENV: 'production', STRIPE_SECRET_KEY: 'rk_live_abc' });
    expect(() => getStripe()).not.toThrow();
  });
});

describe('the startup environment assertion', () => {
  it('refuses to start a non-production deployment holding a live restricted key', () => {
    configure({ NODE_ENV: 'production', STRIPE_SECRET_KEY: 'rk_live_abc' });
    expect(() => assertEnvironment()).toThrow(/live-mode restricted key/);
  });

  it('refuses a live secret key too', () => {
    configure({ NODE_ENV: 'production', STRIPE_SECRET_KEY: 'sk_live_abc' });
    expect(() => assertEnvironment()).toThrow(/live-mode secret key/);
  });

  it('refuses an unclassifiable value rather than assuming it is harmless', () => {
    configure({ NODE_ENV: 'production', STRIPE_SECRET_KEY: 'oops-pasted-the-wrong-thing' });
    expect(() => assertEnvironment()).toThrow(/not a recognised Stripe secret or restricted key/);
  });

  // The assertion used to return early unless NODE_ENV was production, which
  // meant a developer running against a live account — the person best placed
  // to notice and fix it — was the only one never told.
  it('applies outside production too', () => {
    configure({ NODE_ENV: 'development', STRIPE_SECRET_KEY: 'sk_live_abc' });
    expect(() => assertEnvironment()).toThrow(/live-mode secret key/);
  });

  it('refuses a live key on a Preview deployment', () => {
    configure({ NODE_ENV: 'production', VERCEL_ENV: 'preview', STRIPE_SECRET_KEY: 'rk_live_abc' });
    expect(() => assertEnvironment()).toThrow(/live-mode restricted key/);
  });

  it('passes with a test key, and with no Stripe configuration at all', () => {
    configure({ NODE_ENV: 'production', STRIPE_SECRET_KEY: 'sk_test_abc' });
    expect(() => assertEnvironment()).not.toThrow();
    configure({ NODE_ENV: 'production', STRIPE_SECRET_KEY: undefined });
    expect(() => assertEnvironment()).not.toThrow();
  });

  it('accepts a full live configuration on a production deployment', () => {
    configure({
      NODE_ENV: 'production',
      VERCEL_ENV: 'production',
      STRIPE_SECRET_KEY: 'rk_live_abc',
      STRIPE_WEBHOOK_SECRET: 'whsec_live',
      STRIPE_PRO_MONTHLY_PRICE_ID: 'price_live',
      NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: 'pk_live_abc',
    });
    expect(() => assertEnvironment()).not.toThrow();
  });
});
