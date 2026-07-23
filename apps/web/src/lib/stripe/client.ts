/**
 * Stripe SDK access.
 *
 * The API version is pinned to whatever the installed SDK declares, rather than
 * being written out here. Hardcoding a version string that drifts from the SDK
 * is how integrations start silently receiving a payload shape they no longer
 * parse.
 */
import Stripe from 'stripe';
import { readServerEnv } from '../env';

let cached: Stripe | null = null;

export function getStripe(): Stripe {
  if (cached) return cached;
  const env = readServerEnv();
  if (!env.STRIPE_SECRET_KEY) {
    throw new Error('STRIPE_SECRET_KEY is not configured.');
  }
  if (env.NODE_ENV === 'production' && env.STRIPE_SECRET_KEY.startsWith('sk_live_')) {
    throw new Error('Refusing to use a live-mode Stripe key.');
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

/** True when this key is a test-mode key. Surfaced in the billing UI. */
export function isTestMode(): boolean {
  const key = readServerEnv().STRIPE_SECRET_KEY ?? '';
  return key.startsWith('sk_test_');
}

export function resetStripeCache(): void {
  cached = null;
}
