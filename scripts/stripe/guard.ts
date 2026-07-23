/**
 * The gate between a Stripe credential and anything that uses it.
 *
 * Three separate refusals, in order, because each catches a different mistake:
 *
 *   1. No key at all, or one whose prefix Stripe does not issue. An
 *      unrecognised value is refused rather than tried — "let the API tell us"
 *      is a fine policy for a read and a terrible one for a write.
 *   2. A live-mode key without `--live`. This is the default state and the one
 *      that matters: pasting the wrong key from a password manager must not be
 *      able to touch a real customer-facing account.
 *   3. `--live` without a human typing the confirmation phrase, at a terminal.
 *      Not a `--yes` flag, because a flag can be copied out of a runbook into a
 *      CI job by somebody who has not read this file.
 */
import { createInterface } from 'node:readline/promises';
import { describeStripeKey, stripeKeyMode } from '@mcp-upgrade/shared';
import type { StripeKeyMode } from '@mcp-upgrade/shared';

export const LIVE_CONFIRMATION_PHRASE = 'provision live mode';

export class GuardError extends Error {
  readonly guidance: string;
  constructor(message: string, guidance: string) {
    super(message);
    this.name = 'GuardError';
    this.guidance = guidance;
  }
}

export interface Credential {
  key: string;
  mode: StripeKeyMode & ('test' | 'live');
  description: string;
}

export interface ResolveOptions {
  /** Usually `process.env.STRIPE_SECRET_KEY`. */
  rawKey: string | undefined;
  live: boolean;
  /** Name of the variable, for the error message. */
  variable?: string;
}

/**
 * Turns a raw environment value into a credential, or explains why it will not.
 *
 * Does not prompt. Confirmation is a separate, explicitly-called step so that
 * the read-only verification script can share this validation without ever
 * being able to trigger an interactive live-mode prompt.
 */
export function resolveCredential(options: ResolveOptions): Credential {
  const variable = options.variable ?? 'STRIPE_SECRET_KEY';
  const raw = options.rawKey?.trim();

  if (!raw) {
    throw new GuardError(`${variable} is not set.`, keyGuidance(variable));
  }

  const mode = stripeKeyMode(raw);
  if (mode === 'unknown') {
    throw new GuardError(
      `${variable} does not look like a Stripe secret or restricted key.`,
      'Expected one of the prefixes sk_test_, rk_test_, sk_live_ or rk_live_. ' +
        'A publishable key (pk_) will not work: it cannot create anything. ' +
        `The value itself is not printed. ${keyGuidance(variable)}`,
    );
  }

  if (mode === 'live' && !options.live) {
    throw new GuardError(
      `${variable} is a ${describeStripeKey(raw)}, and this script defaults to test mode.`,
      'Nothing was read or written. If you genuinely meant to touch the live account, ' +
        'pass --live and confirm at the prompt. Otherwise swap in your test-mode key — ' +
        'the hosted application refuses to start with a live key anyway.',
    );
  }

  return { key: raw, mode, description: describeStripeKey(raw) };
}

function keyGuidance(variable: string): string {
  return (
    `Provide it for one command only, without it entering your shell history:\n` +
    `  read -rs ${variable} && export ${variable}\n` +
    'Test-mode keys are at https://dashboard.stripe.com/test/apikeys.'
  );
}

export interface ConfirmOptions {
  credential: Credential;
  /** What the run will do, shown to the person before they confirm. */
  intent: string;
  input?: NodeJS.ReadableStream & { isTTY?: boolean };
  output?: NodeJS.WritableStream;
}

/**
 * Blocks until a person types the confirmation phrase.
 *
 * Refuses outright when stdin is not a terminal. A live-mode provisioning run
 * from a pipe, a cron job or a CI step is not a thing this script supports, and
 * silently accepting an empty stdin would be the worst possible reading of
 * "confirmed".
 */
export async function confirmLiveMode(options: ConfirmOptions): Promise<void> {
  if (options.credential.mode !== 'live') return;

  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stderr;

  if (!input.isTTY) {
    throw new GuardError(
      'Live mode needs an interactive confirmation and stdin is not a terminal.',
      'Nothing was written. Run this from a terminal, by hand. There is deliberately ' +
        'no flag that skips this prompt.',
    );
  }

  const rl = createInterface({ input, output });
  try {
    output.write(
      `\n  LIVE MODE\n` +
        `  ${options.intent}\n` +
        `  This affects real customers and real money.\n\n` +
        `  Type exactly: ${LIVE_CONFIRMATION_PHRASE}\n`,
    );
    const answer = await rl.question('  > ');
    if (answer.trim() !== LIVE_CONFIRMATION_PHRASE) {
      throw new GuardError('Live-mode confirmation did not match.', 'Nothing was written.');
    }
  } finally {
    rl.close();
  }
}
