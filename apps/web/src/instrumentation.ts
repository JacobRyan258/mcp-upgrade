/**
 * Startup validation.
 *
 * Next calls `register()` once, in the server process, before the first request
 * is served. `assertEnvironment()` was written to be called from here and
 * documented as such, but this file did not exist — so every guard rail it
 * implements (https-only canonical URL, no localhost in production, no
 * live-mode Stripe key) was dead code, and a misconfigured deployment would
 * have started cleanly and failed later on a user's request instead.
 *
 * The check is skipped for the Edge runtime: `readServerEnv` reads variables
 * that are only populated in the Node.js runtime, and the middleware that runs
 * on Edge does not touch any of them.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  const { assertEnvironment } = await import('./lib/env');
  assertEnvironment();

  // Static validation cannot tell a price id belonging to this Stripe account
  // from one belonging to another; only Stripe can. This resolves the price and
  // refuses to start if it is the wrong mode, the wrong amount or missing —
  // while tolerating Stripe simply being unreachable, which is a different
  // problem and must not take the deployment down with it.
  const { assertStripeResources } = await import('./lib/stripe/resources');
  await assertStripeResources();
}
