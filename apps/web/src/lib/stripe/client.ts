/**
 * Stripe SDK access.
 *
 * The API version is pinned to whatever the installed SDK declares, rather than
 * being written out here. Hardcoding a version string that drifts from the SDK
 * is how integrations start silently receiving a payload shape they no longer
 * parse.
 */
import Stripe from 'stripe';
import { describeStripeKey, isTestModeKey, stripeKeyMode } from '@mcp-upgrade/shared';
import { liveStripeModePermitted, readServerEnv } from '../env';

let cached: Stripe | null = null;

export function getStripe(): Stripe {
  if (cached) return cached;
  const env = readServerEnv();
  if (!env.STRIPE_SECRET_KEY) {
    throw new Error('STRIPE_SECRET_KEY is not configured.');
  }
  // The mode comes from the key itself — restricted keys (`rk_live_`) are
  // live-mode credentials too, so a check for `sk_live_` alone would wave the
  // recommended key straight through. An unrecognised value is refused rather
  // than tried.
  const mode = stripeKeyMode(env.STRIPE_SECRET_KEY);
  if (mode === 'unknown') {
    throw new Error(
      'STRIPE_SECRET_KEY is not a recognised test-mode or live-mode Stripe key. ' +
        'Refusing to use a credential whose mode cannot be established.',
    );
  }
  // A live key is permitted only on a real production deployment. Everywhere
  // else — a Preview deployment, a local production build, local dev, the test
  // runner — a live credential is refused rather than used, so a key pasted into
  // the wrong environment can never take a real payment. This is the single gate
  // on *where* a live key may run; the mode itself is still the key's.
  if (mode === 'live' && !liveStripeModePermitted()) {
    throw new Error(
      `Refusing to use a ${describeStripeKey(env.STRIPE_SECRET_KEY)} outside a production ` +
        'deployment. This environment is test mode only.',
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
