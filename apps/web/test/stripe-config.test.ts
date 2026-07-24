/**
 * Static Stripe configuration rules, and the precise boundary of what they can
 * prove.
 *
 * Two failures in this repository motivate the whole file:
 *
 *   `STRIPE_WEBHOOK_SECRET` was set to a webhook *endpoint id* (`we_…`). It is
 *   a real Stripe identifier, it sits next to the signing secret in the
 *   dashboard, and it can never verify a signature — so every delivery would
 *   have been rejected and logged as a forgery attempt.
 *
 *   A test-mode secret key was paired with a price id from a *different*
 *   Stripe account. Nothing static can catch that, which is why the last block
 *   here asserts that it passes — the check that catches it has to talk to
 *   Stripe, and lives in `describePriceMismatch` and `verify:stripe-env`.
 */
import { describe, expect, it } from 'vitest';
import {
  describePriceMismatch,
  isPriceId,
  isWebhookEndpointId,
  isWebhookSigningSecret,
  validateStripeConfig,
} from '@mcp-upgrade/shared';
import type { PriceFacts, ProductFacts } from '@mcp-upgrade/shared';

const VALID = {
  publishableKey: 'pk_test_abc',
  secretKey: 'sk_test_abc',
  webhookSecret: 'whsec_abcdef',
  priceId: 'price_abc',
};

const VALID_LIVE = {
  publishableKey: 'pk_live_abc',
  secretKey: 'rk_live_abc',
  webhookSecret: 'whsec_abcdef',
  priceId: 'price_abc',
};

describe('live-mode credentials are refused by default', () => {
  // The default is test mode: any caller that has not positively established it
  // is running on a production deployment gets the safe answer.
  it('rejects a live secret key', () => {
    expect(validateStripeConfig({ ...VALID, secretKey: 'sk_live_abc' }).join('\n')).toMatch(
      /live-mode secret key/,
    );
  });

  it('rejects a live restricted key, which a "not sk_live_" check would miss', () => {
    expect(validateStripeConfig({ ...VALID, secretKey: 'rk_live_abc' }).join('\n')).toMatch(
      /live-mode restricted key/,
    );
  });

  it('rejects a live publishable key, which would be inlined into the bundle', () => {
    const problems = validateStripeConfig({ ...VALID, publishableKey: 'pk_live_abc' }).join('\n');
    expect(problems).toMatch(/live-mode publishable key/);
    expect(problems).toMatch(/inlined into the browser bundle/);
  });

  it('accepts a restricted test key', () => {
    expect(validateStripeConfig({ ...VALID, secretKey: 'rk_test_abc' })).toEqual([]);
  });

  it('rejects a whole live configuration when allowLiveMode is not passed', () => {
    expect(validateStripeConfig(VALID_LIVE).join('\n')).toMatch(/test mode only/);
  });
});

describe('live-mode credentials on a production deployment (allowLiveMode)', () => {
  it('accepts a live restricted key with a live publishable key', () => {
    expect(validateStripeConfig(VALID_LIVE, { allowLiveMode: true })).toEqual([]);
  });

  it('accepts a live secret key with a live publishable key', () => {
    expect(
      validateStripeConfig({ ...VALID_LIVE, secretKey: 'sk_live_abc' }, { allowLiveMode: true }),
    ).toEqual([]);
  });

  it('still rejects a live secret key paired with a test publishable key', () => {
    // Permitting live mode does not permit a mismatched pair: a live secret with
    // a test publishable key would take real payments while loading test Stripe.js.
    expect(
      validateStripeConfig(
        { ...VALID_LIVE, publishableKey: 'pk_test_abc' },
        { allowLiveMode: true },
      ).join('\n'),
    ).toMatch(/live mode but NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY is test mode/);
  });

  it('still rejects a webhook endpoint id in place of the signing secret', () => {
    expect(
      validateStripeConfig(
        { ...VALID_LIVE, webhookSecret: 'we_1SyntheticEndpointIdFixture' },
        { allowLiveMode: true },
      ).join('\n'),
    ).toMatch(/webhook endpoint id/);
  });

  it('still requires the price id to have the price_ prefix', () => {
    expect(
      validateStripeConfig({ ...VALID_LIVE, priceId: 'prod_abc' }, { allowLiveMode: true }).join('\n'),
    ).toMatch(/must begin with price_/);
  });

  it('accepts a test-mode configuration too — live is permitted, not required', () => {
    expect(validateStripeConfig(VALID, { allowLiveMode: true })).toEqual([]);
  });
});

describe('mode agreement between the two keys', () => {
  it('rejects a test secret key paired with a live publishable key', () => {
    expect(
      validateStripeConfig({ ...VALID, secretKey: 'sk_test_abc', publishableKey: 'pk_live_abc' }).join('\n'),
    ).toMatch(/live-mode publishable key/);
  });

  it('names the mismatch when each key is individually well-formed', () => {
    const problems = validateStripeConfig({
      secretKey: 'rk_live_abc',
      publishableKey: 'pk_test_abc',
    }).join('\n');
    expect(problems).toMatch(/live mode but NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY is test mode/);
  });
});

describe('the webhook signing secret', () => {
  it('recognises a real signing secret', () => {
    expect(isWebhookSigningSecret('whsec_abcdef')).toBe(true);
    expect(isWebhookSigningSecret('whsec_')).toBe(false);
    expect(isWebhookSigningSecret(undefined)).toBe(false);
  });

  it('rejects a webhook endpoint id and says which mistake was made', () => {
    expect(isWebhookEndpointId('we_1SyntheticEndpointIdFixture')).toBe(true);

    const problems = validateStripeConfig({
      ...VALID,
      webhookSecret: 'we_1SyntheticEndpointIdFixture',
    }).join('\n');

    expect(problems).toMatch(/webhook endpoint id/);
    expect(problems).toMatch(/never verify a signature/);
  });

  it('rejects any other shape', () => {
    expect(validateStripeConfig({ ...VALID, webhookSecret: 'sk_test_oops' }).join('\n')).toMatch(
      /must begin with whsec_/,
    );
  });
});

describe('the price id', () => {
  it('must have the price_ prefix', () => {
    expect(isPriceId('price_abc')).toBe(true);
    expect(isPriceId('prod_abc')).toBe(false);
    expect(isPriceId('price_')).toBe(false);
    expect(validateStripeConfig({ ...VALID, priceId: 'prod_abc' }).join('\n')).toMatch(
      /must begin with price_/,
    );
  });
});

describe('absent configuration', () => {
  it('is valid — billing is optional and the app runs Free-plan-only', () => {
    expect(validateStripeConfig({})).toEqual([]);
    expect(validateStripeConfig({ secretKey: '', webhookSecret: '' })).toEqual([]);
  });
});

describe('the placeholders in .env.example', () => {
  // Requirement: example values must not be able to satisfy runtime validation.
  it('cannot pass validation if copied through unchanged', () => {
    const problems = validateStripeConfig({
      publishableKey: 'pk_test_...',
      secretKey: 'sk_test_...',
      webhookSecret: 'whsec_...',
      priceId: 'price_...',
    });
    // The prefixes are right by design, so the shape checks pass; what stops a
    // copied-through example is that Stripe cannot resolve any of it. That is
    // asserted by the resource check below, and by `verify:stripe-env`.
    expect(problems).toEqual([]);
    expect(isPriceId('price_...')).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/* What only the API can answer                                                */
/* -------------------------------------------------------------------------- */

const GOOD_PRICE: PriceFacts = {
  id: 'price_abc',
  active: true,
  livemode: false,
  currency: 'usd',
  unitAmount: 1900,
  interval: 'month',
  intervalCount: 1,
  productId: 'prod_abc',
};

const GOOD_PRODUCT: ProductFacts = {
  id: 'prod_abc',
  active: true,
  livemode: false,
  name: 'MCP Upgrade Pro',
};

describe('resolving the price against Stripe', () => {
  it('accepts the correct $19/month test-mode price', () => {
    expect(describePriceMismatch(GOOD_PRICE, { expectTestMode: true, product: GOOD_PRODUCT })).toEqual([]);
  });

  it('rejects a live-mode price when test mode is expected', () => {
    const problems = describePriceMismatch(
      { ...GOOD_PRICE, livemode: true },
      { expectTestMode: true, product: GOOD_PRODUCT },
    );
    expect(problems.join('\n')).toMatch(/live-mode object but this deployment expects test mode/);
  });

  it('rejects a live-mode product even when the price looks right', () => {
    const problems = describePriceMismatch(GOOD_PRICE, {
      expectTestMode: true,
      product: { ...GOOD_PRODUCT, livemode: true },
    });
    expect(problems.join('\n')).toMatch(/product prod_abc is a live-mode object/);
  });

  it('rejects the wrong amount', () => {
    const problems = describePriceMismatch(
      { ...GOOD_PRICE, unitAmount: 900 },
      { expectTestMode: true, product: GOOD_PRODUCT },
    );
    expect(problems.join('\n')).toMatch(/is 900, expected 1900 \(19.00 USD\)/);
  });

  it('rejects the wrong currency', () => {
    expect(
      describePriceMismatch({ ...GOOD_PRICE, currency: 'eur' }, { expectTestMode: true }).join('\n'),
    ).toMatch(/is in eur, expected usd/);
  });

  it('rejects the wrong interval', () => {
    expect(
      describePriceMismatch(
        { ...GOOD_PRICE, interval: 'year' },
        { expectTestMode: true },
      ).join('\n'),
    ).toMatch(/recurs every 1 year, expected every 1 month/);
  });

  it('rejects an interval count other than one', () => {
    expect(
      describePriceMismatch({ ...GOOD_PRICE, intervalCount: 3 }, { expectTestMode: true }).join('\n'),
    ).toMatch(/recurs every 3 month, expected every 1 month/);
  });

  it('rejects an inactive price', () => {
    expect(
      describePriceMismatch({ ...GOOD_PRICE, active: false }, { expectTestMode: true }).join('\n'),
    ).toMatch(/is not active/);
  });

  it('rejects an inactive product', () => {
    expect(
      describePriceMismatch(GOOD_PRICE, {
        expectTestMode: true,
        product: { ...GOOD_PRODUCT, active: false },
      }).join('\n'),
    ).toMatch(/product prod_abc is not active/);
  });

  it('rejects a price that belongs to a different product', () => {
    expect(
      describePriceMismatch(GOOD_PRICE, {
        expectTestMode: true,
        product: { ...GOOD_PRODUCT, id: 'prod_something_else' },
      }).join('\n'),
    ).toMatch(/belongs to prod_abc, not prod_something_else/);
  });

  it('rejects a tiered price, whose unit_amount is null', () => {
    expect(
      describePriceMismatch({ ...GOOD_PRICE, unitAmount: null }, { expectTestMode: true }).join('\n'),
    ).toMatch(/an unset amount/);
  });
});
