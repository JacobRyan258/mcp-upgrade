/**
 * Validation of what Stripe hands back.
 *
 * The interesting cases are the ones where a field is present but not the shape
 * the comparison logic assumes. A tiered price has `unit_amount: null`; comparing
 * that against 1900 gives "not equal", which happens to be right — but a price
 * with no `recurring` block at all would read `undefined.interval` and throw
 * somewhere far from the cause. Parsing at the boundary keeps the failure here,
 * where the message can say what was wrong.
 */
import { describe, expect, it } from 'vitest';
import {
  portalConfigurationSchema,
  priceProductId,
  priceSchema,
  productSchema,
  webhookEndpointSchema,
} from '../stripe/gateway.ts';

describe('product', () => {
  it('accepts a product with no description', () => {
    const parsed = productSchema.parse({
      id: 'prod_1',
      name: 'MCP Upgrade Pro',
      description: null,
      active: true,
      livemode: false,
      metadata: {},
    });
    expect(parsed.description).toBeNull();
  });

  it('rejects one with no id', () => {
    expect(() => productSchema.parse({ name: 'x', active: true, livemode: false })).toThrow();
  });
});

describe('price', () => {
  const base = {
    id: 'price_1',
    active: true,
    currency: 'usd',
    livemode: false,
    lookup_key: 'mcp_upgrade_pro_monthly',
    type: 'recurring',
    unit_amount: 1900,
    product: 'prod_1',
    recurring: { interval: 'month', interval_count: 1 },
  };

  it('accepts the shape the setup script creates', () => {
    expect(priceSchema.parse(base).unit_amount).toBe(1900);
  });

  it('accepts a tiered price, whose unit amount is null', () => {
    expect(priceSchema.parse({ ...base, unit_amount: null }).unit_amount).toBeNull();
  });

  it('accepts a one-off price, whose recurring block is null', () => {
    expect(priceSchema.parse({ ...base, type: 'one_time', recurring: null }).recurring).toBeNull();
  });

  it('reads the product id whether or not Stripe expanded it', () => {
    expect(priceProductId(priceSchema.parse(base))).toBe('prod_1');
    expect(priceProductId(priceSchema.parse({ ...base, product: { id: 'prod_2' } }))).toBe('prod_2');
  });

  it('rejects a fractional unit amount, which is not a thing Stripe returns', () => {
    expect(() => priceSchema.parse({ ...base, unit_amount: 19.5 })).toThrow();
  });

  it('defaults a missing lookup key to null rather than undefined', () => {
    const { lookup_key: _omitted, ...withoutKey } = base;
    expect(priceSchema.parse(withoutKey).lookup_key).toBeNull();
  });
});

describe('webhook endpoint', () => {
  const base = {
    id: 'we_1',
    url: 'https://a.test/api/stripe/webhook',
    status: 'enabled',
    livemode: false,
    enabled_events: ['checkout.session.completed'],
  };

  it('carries the secret when Stripe returns one', () => {
    expect(webhookEndpointSchema.parse({ ...base, secret: 'whsec_x' }).secret).toBe('whsec_x');
  });

  it('is valid without one, which is every response except creation', () => {
    expect(webhookEndpointSchema.parse(base).secret).toBeUndefined();
  });

  it('rejects a missing event list rather than treating it as empty', () => {
    const { enabled_events: _omitted, ...withoutEvents } = base;
    expect(() => webhookEndpointSchema.parse(withoutEvents)).toThrow();
  });
});

describe('portal configuration', () => {
  it('tolerates feature blocks carrying fields this script does not model', () => {
    const parsed = portalConfigurationSchema.parse({
      id: 'bpc_1',
      active: true,
      is_default: true,
      livemode: false,
      features: {
        subscription_cancel: {
          enabled: true,
          mode: 'at_period_end',
          cancellation_reason: { enabled: true, options: ['too_expensive'] },
          proration_behavior: 'none',
        },
      },
    });
    expect(parsed.features.subscription_cancel?.enabled).toBe(true);
    expect(parsed.features.subscription_cancel?.mode).toBe('at_period_end');
  });

  it('defaults an absent business profile to null instead of throwing', () => {
    const parsed = portalConfigurationSchema.parse({
      id: 'bpc_1',
      active: true,
      is_default: false,
      livemode: false,
      features: {},
    });
    expect(parsed.business_profile).toBeNull();
    expect(parsed.default_return_url).toBeNull();
  });
});
