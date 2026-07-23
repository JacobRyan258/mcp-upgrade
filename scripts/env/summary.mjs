/**
 * The startup banner.
 *
 * Every line here answers a question an operator actually asks when something
 * is wrong — which file am I running from, which Stripe account am I pointed
 * at, is this test mode, which signing secret is in play — and none of them
 * requires printing a secret to answer.
 *
 * The mode and masking rules are deliberately duplicated from
 * `@mcp-upgrade/shared` rather than imported: this module runs from plain
 * `node` before anything has been built, so importing a workspace package
 * would make `npm run dev` depend on `npm run build`. `scripts/test/env-summary.test.ts`
 * asserts the two implementations agree on a table of inputs, so the
 * duplication cannot drift silently.
 */
import path from 'node:path';

const KEY_PREFIXES = Object.freeze([
  { prefix: 'sk_test_', mode: 'test' },
  { prefix: 'rk_test_', mode: 'test' },
  { prefix: 'sk_live_', mode: 'live' },
  { prefix: 'rk_live_', mode: 'live' },
  { prefix: 'pk_test_', mode: 'test' },
  { prefix: 'pk_live_', mode: 'live' },
]);

/** @param {string | undefined} key @returns {'test' | 'live' | 'unknown'} */
export function keyMode(key) {
  if (typeof key !== 'string') return 'unknown';
  return KEY_PREFIXES.find((entry) => key.startsWith(entry.prefix))?.mode ?? 'unknown';
}

/** @param {string | undefined} value */
export function mask(value) {
  if (typeof value !== 'string' || value === '') return '(unset)';
  const known = [...KEY_PREFIXES.map((e) => e.prefix), 'whsec_'];
  const prefix = known.find((candidate) => value.startsWith(candidate)) ?? '';
  const body = value.slice(prefix.length);
  if (body.length <= 8) return `${prefix}${'•'.repeat(8)}`;
  return `${prefix}${'•'.repeat(8)}${body.slice(-4)}`;
}

/**
 * Describes which signing secret is configured, without revealing it.
 *
 * The distinction matters and is invisible from the value alone: a Stripe CLI
 * secret only verifies deliveries forwarded by `stripe listen`, and a dashboard
 * endpoint secret only verifies deliveries Stripe sends to the hosted URL.
 * Configuring one where the other is needed produces a signature failure that
 * looks exactly like an attack.
 *
 * The CLI's secret is materially longer than an endpoint's, which is the only
 * signal available locally, so this reports a guess and says that it is one.
 *
 * @param {string | undefined} secret
 */
export function describeWebhookSecret(secret) {
  if (typeof secret !== 'string' || secret === '') return 'not configured';
  if (!secret.startsWith('whsec_')) return 'INVALID — not a whsec_ signing secret';
  return secret.length > 50 ? 'Stripe CLI local forwarding (probable)' : 'dashboard endpoint (probable)';
}

/**
 * @param {import('./load.mjs').LoadResult} result
 * @param {string} repoRoot
 * @param {NodeJS.ProcessEnv} [env]
 */
export function summariseEnvironment(result, repoRoot, env = process.env) {
  const lines = [];

  const source =
    result.source === 'platform'
      ? 'platform-injected (no .env file)'
      : path.relative(repoRoot, result.file) || '.env';

  lines.push(`  Environment source : ${source}`);
  if (result.preexisting.length > 0) {
    lines.push(`  Pre-set by shell   : ${result.preexisting.join(', ')}`);
  }

  const secret = env.STRIPE_SECRET_KEY;
  const publishable = env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY;

  if (secret || publishable) {
    const secretMode = keyMode(secret);
    const publishableMode = keyMode(publishable);
    const agree = !secret || !publishable || secretMode === publishableMode;

    lines.push(`  Stripe mode        : ${secretMode}${agree ? '' : ` (MISMATCH — publishable key is ${publishableMode})`}`);
    lines.push(`  Stripe secret key  : ${mask(secret)}`);
    lines.push(`  Stripe publishable : ${mask(publishable)}`);
    lines.push(`  Stripe price       : ${env.STRIPE_PRO_MONTHLY_PRICE_ID ?? '(unset)'}`);
    lines.push(`  Webhook secret     : ${mask(env.STRIPE_WEBHOOK_SECRET)}`);
    lines.push(`  Webhook mode       : ${describeWebhookSecret(env.STRIPE_WEBHOOK_SECRET)}`);
  } else {
    lines.push('  Stripe             : not configured (billing disabled)');
  }

  return `${lines.join('\n')}\n\n`;
}
