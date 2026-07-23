/**
 * Checks that Stripe matches what the application expects.
 *
 *   npm run stripe:verify
 *   npm run stripe:verify -- --production-base-url https://upgrade.jacobryanlive.com
 *   npm run stripe:verify -- --env-file apps/web/.env.local
 *
 * Read-only: it lists and retrieves, and there is no create or update anywhere
 * beneath it. Exits non-zero if any check fails.
 */
import process from 'node:process';
import { fail, main } from './stripe/verify.ts';

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (error) {
  process.exitCode = fail(error);
}
