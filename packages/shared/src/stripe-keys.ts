/**
 * Stripe credential shapes.
 *
 * Two questions get asked about a Stripe credential all over this repository —
 * "is this test mode or live mode?" and "how do I show this without leaking
 * it?" — and both were previously answered by ad-hoc `startsWith('sk_test_')`
 * checks. That is wrong for restricted keys, which are the credential this
 * application should actually be deployed with: an `rk_live_` key sailed
 * straight past a guard that only looked for `sk_live_`, and the billing page
 * stopped saying "test mode" the moment a perfectly correct `rk_test_` key was
 * used.
 *
 * Living in shared rather than in the web app is deliberate: the provisioning
 * scripts must apply exactly the same rule as the running application, and one
 * implementation is the only way to guarantee that.
 *
 * Unrecognised is a distinct answer from test and live. Everything that gates
 * on mode must treat `unknown` as "refuse" rather than "probably fine".
 */

export type StripeKeyMode = 'test' | 'live' | 'unknown';

/** Whether the key is a full secret key or a scoped restricted key. */
export type StripeKeyKind = 'secret' | 'restricted' | 'unknown';

interface Prefix {
  prefix: string;
  mode: StripeKeyMode;
  kind: StripeKeyKind;
}

/**
 * Every server-side credential prefix Stripe issues. Publishable keys (`pk_`)
 * are deliberately absent: they are not secrets and must never be accepted
 * where a secret key is expected.
 */
const PREFIXES: readonly Prefix[] = Object.freeze([
  { prefix: 'sk_test_', mode: 'test', kind: 'secret' },
  { prefix: 'rk_test_', mode: 'test', kind: 'restricted' },
  { prefix: 'sk_live_', mode: 'live', kind: 'secret' },
  { prefix: 'rk_live_', mode: 'live', kind: 'restricted' },
]);

function match(key: string | null | undefined): Prefix | null {
  if (typeof key !== 'string') return null;
  return PREFIXES.find((candidate) => key.startsWith(candidate.prefix)) ?? null;
}

/**
 * Test mode, live mode, or neither.
 *
 * A key that matches no known prefix is `unknown`, never a default. A caller
 * that wants "not live" must check for `=== 'test'`, so a malformed or
 * truncated value cannot be mistaken for a safe one.
 */
export function stripeKeyMode(key: string | null | undefined): StripeKeyMode {
  return match(key)?.mode ?? 'unknown';
}

export function stripeKeyKind(key: string | null | undefined): StripeKeyKind {
  return match(key)?.kind ?? 'unknown';
}

/** True only for a credential positively identified as live mode. */
export function isLiveModeKey(key: string | null | undefined): boolean {
  return stripeKeyMode(key) === 'live';
}

/** True only for a credential positively identified as test mode. */
export function isTestModeKey(key: string | null | undefined): boolean {
  return stripeKeyMode(key) === 'test';
}

/**
 * A form of a secret that is safe to print.
 *
 * Keeps the recognisable prefix — which is the part an operator needs in order
 * to tell one credential from another — and the last four characters, which are
 * what Stripe's own dashboard shows. Everything between them is replaced.
 *
 * A value too short to mask meaningfully is replaced entirely rather than
 * having a revealing fraction of it printed.
 */
export function maskSecret(value: string | null | undefined): string {
  if (typeof value !== 'string' || value.length === 0) return '(unset)';

  const known = PREFIXES.map((entry) => entry.prefix);
  // Not a key prefix, but the same masking rule applies to signing secrets.
  known.push('whsec_', 'pk_test_', 'pk_live_');
  const prefix = known.find((candidate) => value.startsWith(candidate)) ?? '';

  const body = value.slice(prefix.length);
  if (body.length <= 8) return `${prefix}${'•'.repeat(8)}`;
  return `${prefix}${'•'.repeat(8)}${body.slice(-4)}`;
}

/**
 * Human-readable description of a credential, for logs and CLI output.
 *
 * Never includes the value itself, so it is safe to write anywhere the masked
 * form would be.
 */
export function describeStripeKey(key: string | null | undefined): string {
  const mode = stripeKeyMode(key);
  if (mode === 'unknown') return 'unrecognised Stripe credential';
  const kind = stripeKeyKind(key);
  return `${mode}-mode ${kind === 'restricted' ? 'restricted' : 'secret'} key`;
}

/* -------------------------------------------------------------------------- */
/* Non-key identifiers                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Whether a value is a webhook *signing secret*.
 *
 * This exists because of a specific, silent failure. `STRIPE_WEBHOOK_SECRET`
 * was set to `we_…`, which is a webhook *endpoint id* — a perfectly real Stripe
 * identifier that is visible right next to the secret in the dashboard, is not
 * secret at all, and can never verify a signature. Nothing checked, so every
 * delivery would have failed signature verification and been logged as a
 * forgery attempt.
 *
 * An endpoint id is called out by name rather than being lumped in with "not a
 * secret", because knowing *which* wrong thing was pasted is most of the fix.
 */
export function isWebhookSigningSecret(value: string | null | undefined): boolean {
  return typeof value === 'string' && value.startsWith('whsec_') && value.length > 'whsec_'.length;
}

export function isWebhookEndpointId(value: string | null | undefined): boolean {
  return typeof value === 'string' && value.startsWith('we_');
}

/** Whether a value has the shape of a Stripe price id. Says nothing about mode. */
export function isPriceId(value: string | null | undefined): boolean {
  return typeof value === 'string' && value.startsWith('price_') && value.length > 'price_'.length;
}

/* -------------------------------------------------------------------------- */
/* Whole-configuration validation                                              */
/* -------------------------------------------------------------------------- */

export interface StripeConfigInput {
  publishableKey?: string | null;
  secretKey?: string | null;
  webhookSecret?: string | null;
  priceId?: string | null;
}

export interface ValidateStripeConfigOptions {
  /**
   * Whether a live-mode credential is permitted.
   *
   * Defaults to `false`, which is the only safe default: a caller that has not
   * positively established it is running on a production deployment is treated
   * as test mode, so a live key pasted into local development, a Preview build
   * or the test runner is refused rather than used. The hosted application sets
   * this to true only on a real Vercel production deployment.
   *
   * Passing it does not weaken any other check — a live secret key still has to
   * agree with a live publishable key, and the price still has to resolve
   * against Stripe. It only decides whether "this credential is live mode" is by
   * itself a reason to refuse.
   */
  allowLiveMode?: boolean;
}

/**
 * Every static problem with a Stripe configuration, as human-readable strings.
 *
 * "Static" is the important qualifier. These checks cover shape and mode, which
 * is everything that can be known without a network call — but shape is not
 * sufficient, and treating it as sufficient is how this repository shipped a
 * test-mode key from one account alongside a price id from another. Both values
 * pass every rule here; the pairing is only detectable by asking Stripe, which
 * `assertStripeResources` and `npm run verify:stripe-env` do.
 *
 * Returns an empty array when the configuration is entirely absent: billing is
 * optional, and "not configured" is a supported state rather than an error.
 */
export function validateStripeConfig(
  input: StripeConfigInput,
  options: ValidateStripeConfigOptions = {},
): string[] {
  const allowLiveMode = options.allowLiveMode ?? false;
  const problems: string[] = [];
  const present = [input.publishableKey, input.secretKey, input.webhookSecret, input.priceId].filter(
    (value) => typeof value === 'string' && value !== '',
  );
  if (present.length === 0) return problems;

  if (input.secretKey) {
    const mode = stripeKeyMode(input.secretKey);
    if (mode === 'unknown') {
      problems.push(
        'STRIPE_SECRET_KEY is not a recognised Stripe secret or restricted key ' +
          '(expected sk_test_, rk_test_, sk_live_ or rk_live_). A publishable key (pk_) ' +
          'cannot be used here, and a truncated value is refused rather than tried.',
      );
    } else if (mode === 'live' && !allowLiveMode) {
      problems.push(
        `STRIPE_SECRET_KEY is a ${describeStripeKey(input.secretKey)}. Live-mode credentials ` +
          'are permitted only on a production deployment; this environment is test mode only.',
      );
    }
  }

  if (input.publishableKey) {
    const publishableMode = input.publishableKey.startsWith('pk_test_')
      ? 'test'
      : input.publishableKey.startsWith('pk_live_')
        ? 'live'
        : 'unknown';
    if (publishableMode === 'unknown') {
      problems.push('NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY must begin with pk_test_ or pk_live_.');
    } else if (publishableMode === 'live' && !allowLiveMode) {
      problems.push(
        'NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY is a live-mode publishable key. It is inlined into ' +
          'the browser bundle at build time, so a non-production build would ship live-mode ' +
          'Stripe.js to every visitor.',
      );
    }
  }

  // Mode agreement between the two keys. Each can be individually valid while
  // the pair is nonsense.
  if (input.secretKey && input.publishableKey) {
    const secretMode = stripeKeyMode(input.secretKey);
    const publishableMode = input.publishableKey.startsWith('pk_test_')
      ? 'test'
      : input.publishableKey.startsWith('pk_live_')
        ? 'live'
        : 'unknown';
    if (secretMode !== 'unknown' && publishableMode !== 'unknown' && secretMode !== publishableMode) {
      problems.push(
        `STRIPE_SECRET_KEY is ${secretMode} mode but NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY is ` +
          `${publishableMode} mode. They must be the same account and the same mode.`,
      );
    }
  }

  if (input.webhookSecret && !isWebhookSigningSecret(input.webhookSecret)) {
    problems.push(
      isWebhookEndpointId(input.webhookSecret)
        ? 'STRIPE_WEBHOOK_SECRET is a webhook endpoint id (we_…), not a signing secret. ' +
          'The signing secret begins with whsec_ and is revealed separately in the dashboard, ' +
          'or printed by `npm run stripe:listen` for local forwarding. An endpoint id can never ' +
          'verify a signature, so every delivery would be rejected as a forgery.'
        : 'STRIPE_WEBHOOK_SECRET must begin with whsec_.',
    );
  }

  if (input.priceId && !isPriceId(input.priceId)) {
    problems.push('STRIPE_PRO_MONTHLY_PRICE_ID must begin with price_.');
  }

  return problems;
}
