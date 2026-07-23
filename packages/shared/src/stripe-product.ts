/**
 * What the paid plan is, as a single fact.
 *
 * "$19 a month" appeared in four places — the pricing page, the provisioning
 * script, the verification script and a runbook — and nothing tied them
 * together. This module is the one definition; everything else imports it.
 *
 * It lives in `shared` rather than in the scripts because the running
 * application needs it too: startup verification resolves the configured price
 * against the Stripe API and compares it to these numbers, which is the only
 * check that catches a price id belonging to the wrong Stripe account. Prefix
 * validation cannot: `price_…` from another account is a perfectly well-formed
 * price id, and the failure surfaces as "No such price" at a customer's
 * checkout rather than at deploy time.
 */

export const PRO_PRODUCT_NAME = 'MCP Upgrade Pro';
export const PRO_PRODUCT_DESCRIPTION = 'Monthly Pro access to the hosted MCP Upgrade validator';
export const PRO_PRICE_LOOKUP_KEY = 'mcp_upgrade_pro_monthly';

export interface ProPriceContract {
  readonly currency: string;
  readonly unitAmount: number;
  readonly interval: 'month';
  readonly intervalCount: number;
  readonly lookupKey: string;
}

export const PRO_PRICE_CONTRACT: ProPriceContract = Object.freeze({
  currency: 'usd',
  unitAmount: 1900,
  interval: 'month',
  intervalCount: 1,
  lookupKey: PRO_PRICE_LOOKUP_KEY,
});

/** Stable identity for the product, independent of its display name. */
export const PRO_PRODUCT_METADATA = Object.freeze({
  application: 'mcp-upgrade',
  plan: 'pro',
} as const);

/** The shape of a price, reduced to what has to be true. */
export interface PriceFacts {
  id: string;
  active: boolean;
  livemode: boolean;
  currency: string;
  unitAmount: number | null;
  interval: string | null;
  intervalCount: number | null;
  productId: string;
}

export interface ProductFacts {
  id: string;
  active: boolean;
  livemode: boolean;
  name: string;
}

/**
 * Every reason a price is not the one this application sells.
 *
 * `expectTestMode` is passed rather than assumed so the same function serves
 * the test-mode application and any future live-mode deployment without a
 * second implementation drifting away from this one.
 */
export function describePriceMismatch(
  price: PriceFacts,
  options: { expectTestMode: boolean; product?: ProductFacts | null },
): string[] {
  const problems: string[] = [];
  const contract = PRO_PRICE_CONTRACT;

  if (price.livemode === options.expectTestMode) {
    problems.push(
      `price ${price.id} is a ${price.livemode ? 'live' : 'test'}-mode object but this ` +
        `deployment expects ${options.expectTestMode ? 'test' : 'live'} mode.`,
    );
  }
  if (!price.active) problems.push(`price ${price.id} is not active.`);
  if (price.currency !== contract.currency) {
    problems.push(`price ${price.id} is in ${price.currency}, expected ${contract.currency}.`);
  }
  if (price.unitAmount !== contract.unitAmount) {
    problems.push(
      `price ${price.id} is ${price.unitAmount ?? 'an unset amount'}, expected ${contract.unitAmount} ` +
        `(${(contract.unitAmount / 100).toFixed(2)} ${contract.currency.toUpperCase()}).`,
    );
  }
  if (price.interval !== contract.interval || price.intervalCount !== contract.intervalCount) {
    problems.push(
      `price ${price.id} recurs every ${price.intervalCount ?? '?'} ${price.interval ?? 'unknown interval'}, ` +
        `expected every ${contract.intervalCount} ${contract.interval}.`,
    );
  }

  const product = options.product;
  if (product) {
    if (product.id !== price.productId) {
      problems.push(`price ${price.id} belongs to ${price.productId}, not ${product.id}.`);
    }
    if (!product.active) problems.push(`product ${product.id} is not active.`);
    if (product.livemode === options.expectTestMode) {
      problems.push(
        `product ${product.id} is a ${product.livemode ? 'live' : 'test'}-mode object but this ` +
          `deployment expects ${options.expectTestMode ? 'test' : 'live'} mode.`,
      );
    }
  }

  return problems;
}
