/**
 * Provisions the Stripe objects the hosted application needs.
 *
 *   npm run stripe:setup -- --dry-run
 *   npm run stripe:setup -- --write-env apps/web/.env.local
 *   npm run stripe:setup -- --production-base-url https://upgrade.jacobryanlive.com
 *
 * Test mode by default and safe to rerun. The Stripe credential comes from
 * STRIPE_SECRET_KEY in the environment, is never printed, and is never written
 * anywhere git can see.
 *
 * What it will not do: delete anything, change a price's billing terms (Stripe
 * forbids it and so does this script), or pretend it can recover a webhook
 * signing secret that Stripe only ever returns once.
 *
 * The work lives in ./stripe/setup.ts so it can be tested without a
 * provisioning run happening as a side effect of an import.
 */
import process from 'node:process';
import { fail, main } from './stripe/setup.ts';

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (error) {
  process.exitCode = fail(error);
}
