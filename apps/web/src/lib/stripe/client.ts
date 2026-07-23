/**
 * Stripe SDK access.
 *
 * The API version is pinned to whatever the installed SDK declares, rather than
 * being written out here. Hardcoding a version string that drifts from the SDK
 * is how integrations start silently receiving a payload shape they no longer
 * parse.
 */
import Stripe from 'stripe';
import { isTestModeKey, stripeKeyMode } from '@mcp-upgrade/shared';
import { readServerEnv } from '../env';

let cached: Stripe | null = null;

export function getStripe(): Stripe {
  if (cached) return cached;
  const env = readServerEnv();
  if (!env.STRIPE_SECRET_KEY) {
    throw new Error('STRIPE_SECRET_KEY is not configured.');
  }
  // Restricted keys (`rk_live_`) are live-mode credentials too, and are the
  // credential this application is meant to be deployed with. Checking only for
  // `sk_live_` let the recommended key straight through the guard.
  if (env.NODE_ENV === 'production' && stripeKeyMode(env.STRIPE_SECRET_KEY) !== 'test') {
    throw new Error(
      'Refusing to use a Stripe key that is not positively identified as test mode. ' +
        'This deployment is configured for test mode only.',
    );
  }
  cached = new Stripe(env.STRIPE_SECRET_KEY, {
    // Retries are handled by us, not silently by the SDK, so that a failed
    // write is visible in the webhook outcome rather than absorbed.
    maxNetworkRetries: 1,
    timeout: 15_000,
    telemetry: false,
  });
  return cached;
}

/**
 * True when this key is a test-mode key. Surfaced in the billing UI.
 *
 * Covers restricted keys as well as secret keys: an `rk_test_` deployment is
 * still test mode, and hiding the "no real payment will be taken" banner from
 * it would be actively misleading.
 */
export function isTestMode(): boolean {
  return isTestModeKey(readServerEnv().STRIPE_SECRET_KEY);
}

export function resetStripeCache(): void {
  cached = null;
}
