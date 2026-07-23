/**
 * Startup verification of the Stripe objects this deployment points at.
 *
 * Shape validation stops at "looks like a price id". That was not enough here:
 * the repository shipped a test-mode secret key for one Stripe account
 * alongside a price id belonging to a *different* account. Both values are
 * individually well-formed, both pass every prefix rule, and the pairing fails
 * only when Stripe is asked — at which point it fails inside a customer's
 * checkout as "No such price", which is the worst possible place to find out.
 *
 * So this asks. Once, at startup, before the first request.
 *
 * The distinction that keeps this from being an availability risk: a
 * *definitive* answer from Stripe that the configuration is wrong is fatal, and
 * a *failure to get an answer* is not. If Stripe is unreachable or returns a
 * 5xx, the deployment starts and logs a warning; if Stripe says the price does
 * not exist, is live mode, or costs something other than $19, the deployment
 * refuses to serve. "Stripe is down" and "you are misconfigured" are different
 * events and must not share a failure mode.
 */
import { describePriceMismatch, stripeKeyMode } from '@mcp-upgrade/shared';
import type { PriceFacts, ProductFacts } from '@mcp-upgrade/shared';
import { billingConfigured, readServerEnv } from '../env';
import { getStripe } from './client';
import { logEvent } from '../log';

export class StripeResourceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StripeResourceError';
  }
}

/**
 * Stripe errors that mean "your configuration is wrong", as opposed to
 * "the request did not get through".
 *
 * `resource_missing` is the cross-account case: a price id from another account
 * is indistinguishable from one that was deleted.
 */
function isDefinitive(error: unknown): boolean {
  const type = (error as { type?: string } | null)?.type;
  const status = (error as { statusCode?: number } | null)?.statusCode;
  if (type === 'StripeInvalidRequestError' || type === 'StripeAuthenticationError') return true;
  if (type === 'StripePermissionError') return true;
  return typeof status === 'number' && status >= 400 && status < 500;
}

/**
 * Verifies the configured price and its product against the Stripe API.
 *
 * Resolves silently when billing is not configured — running without Stripe is
 * a supported state, not a misconfiguration.
 */
export async function assertStripeResources(): Promise<void> {
  const env = readServerEnv();
  if (!billingConfigured(env)) return;

  const priceId = env.STRIPE_PRO_MONTHLY_PRICE_ID!;
  const expectTestMode = stripeKeyMode(env.STRIPE_SECRET_KEY) === 'test';

  let price;
  try {
    price = await getStripe().prices.retrieve(priceId, { expand: ['product'] });
  } catch (error) {
    if (!isDefinitive(error)) {
      // Could not reach Stripe. Start, but say so.
      logEvent('warn', 'stripe.startup_verification_unavailable', {
        detail: error instanceof Error ? error.name : 'unknown',
      });
      return;
    }
    throw new StripeResourceError(
      `STRIPE_PRO_MONTHLY_PRICE_ID (${priceId}) could not be resolved with the configured ` +
        'STRIPE_SECRET_KEY. The usual cause is a price id and a secret key that belong to ' +
        'different Stripe accounts or different modes — both look valid on their own. ' +
        'Run `npm run verify:stripe-env` to see which.',
    );
  }

  const product = typeof price.product === 'string' ? null : (price.product as { id: string; active: boolean; livemode: boolean; name: string; deleted?: boolean });

  const priceFacts: PriceFacts = {
    id: price.id,
    active: price.active,
    livemode: price.livemode,
    currency: price.currency,
    unitAmount: price.unit_amount,
    interval: price.recurring?.interval ?? null,
    intervalCount: price.recurring?.interval_count ?? null,
    productId: typeof price.product === 'string' ? price.product : (price.product as { id: string }).id,
  };

  const productFacts: ProductFacts | null =
    product && !product.deleted
      ? { id: product.id, active: product.active, livemode: product.livemode, name: product.name }
      : null;

  const problems = describePriceMismatch(priceFacts, { expectTestMode, product: productFacts });

  if (problems.length > 0) {
    throw new StripeResourceError(
      `The configured Stripe price is not the product this application sells:\n` +
        problems.map((problem) => `  ${problem}`).join('\n') +
        '\n  Run `npm run stripe:setup` to provision the correct test-mode objects.',
    );
  }

  logEvent('info', 'stripe.startup_verified', {
    priceId: priceFacts.id,
    livemode: String(priceFacts.livemode),
  });
}
