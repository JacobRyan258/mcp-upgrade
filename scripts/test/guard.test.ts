/**
 * The credential gate.
 *
 * Every test here is about refusing something. The one behaviour that must
 * never regress is the default: a live key, with no flag, does nothing at all.
 */
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { maskSecret, stripeKeyMode } from '@mcp-upgrade/shared';
import {
  GuardError,
  LIVE_CONFIRMATION_PHRASE,
  confirmLiveMode,
  resolveCredential,
} from '../stripe/guard.ts';

const TEST_KEY = 'sk_test_0123456789abcdefghij';
const LIVE_KEY = 'sk_live_fake';
const RESTRICTED_LIVE_KEY = 'rk_live_fake';
const RESTRICTED_TEST_KEY = 'rk_test_0123456789abcdefghij';

describe('key mode detection', () => {
  it('recognises restricted keys as well as secret keys', () => {
    expect(stripeKeyMode(TEST_KEY)).toBe('test');
    expect(stripeKeyMode(RESTRICTED_TEST_KEY)).toBe('test');
    expect(stripeKeyMode(LIVE_KEY)).toBe('live');
    expect(stripeKeyMode(RESTRICTED_LIVE_KEY)).toBe('live');
  });

  it('calls anything else unknown rather than assuming it is safe', () => {
    for (const value of ['', 'sk_', 'pk_test_abc', 'whsec_abc', 'sktest_abc', 'SK_TEST_abc']) {
      expect(stripeKeyMode(value), value).toBe('unknown');
    }
  });
});

describe('resolving a credential', () => {
  it('accepts a test key with no flags', () => {
    const credential = resolveCredential({ rawKey: TEST_KEY, live: false });
    expect(credential.mode).toBe('test');
    expect(credential.description).toBe('test-mode secret key');
  });

  it('accepts a restricted test key', () => {
    expect(resolveCredential({ rawKey: RESTRICTED_TEST_KEY, live: false }).description).toBe(
      'test-mode restricted key',
    );
  });

  it('rejects a live secret key by default', () => {
    expect(() => resolveCredential({ rawKey: LIVE_KEY, live: false })).toThrow(GuardError);
    expect(() => resolveCredential({ rawKey: LIVE_KEY, live: false })).toThrow(
      /defaults to test mode/,
    );
  });

  it('rejects a live restricted key by default too', () => {
    // The prefix that a `startsWith('sk_live_')` check would have waved through.
    expect(() => resolveCredential({ rawKey: RESTRICTED_LIVE_KEY, live: false })).toThrow(
      /live-mode restricted key/,
    );
  });

  it('permits a live key only once --live is passed', () => {
    expect(resolveCredential({ rawKey: LIVE_KEY, live: true }).mode).toBe('live');
  });

  it('refuses a missing key', () => {
    expect(() => resolveCredential({ rawKey: undefined, live: false })).toThrow(/is not set/);
    expect(() => resolveCredential({ rawKey: '   ', live: false })).toThrow(/is not set/);
  });

  it('refuses a value that is not a Stripe server-side credential', () => {
    expect(() => resolveCredential({ rawKey: 'pk_test_abcdef', live: false })).toThrow(
      /does not look like a Stripe secret or restricted key/,
    );
  });

  it('never puts the key itself in the error', () => {
    try {
      resolveCredential({ rawKey: 'nonsense_but_secret_value', live: false });
      throw new Error('should have refused');
    } catch (error) {
      const text = `${(error as Error).message} ${(error as GuardError).guidance}`;
      expect(text).not.toContain('nonsense_but_secret_value');
    }
  });
});

describe('live-mode confirmation', () => {
  const live = { key: LIVE_KEY, mode: 'live' as const, description: 'live-mode secret key' };

  it('does nothing for a test-mode credential', async () => {
    await expect(
      confirmLiveMode({
        credential: { key: TEST_KEY, mode: 'test', description: 'test-mode secret key' },
        intent: 'anything',
      }),
    ).resolves.toBeUndefined();
  });

  it('refuses outright when stdin is not a terminal', async () => {
    const input = new PassThrough() as PassThrough & { isTTY?: boolean };
    input.isTTY = false;
    await expect(
      confirmLiveMode({ credential: live, intent: 'x', input, output: new PassThrough() }),
    ).rejects.toThrow(/not a terminal/);
  });

  it('accepts the exact phrase typed at a terminal', async () => {
    const input = new PassThrough() as PassThrough & { isTTY?: boolean };
    input.isTTY = true;
    const promise = confirmLiveMode({
      credential: live,
      intent: 'x',
      input,
      output: new PassThrough(),
    });
    input.write(`${LIVE_CONFIRMATION_PHRASE}\n`);
    await expect(promise).resolves.toBeUndefined();
  });

  it('rejects anything else, including a bare yes', async () => {
    for (const answer of ['yes', 'y', '', 'PROVISION LIVE MODE', 'provision live']) {
      const input = new PassThrough() as PassThrough & { isTTY?: boolean };
      input.isTTY = true;
      const promise = confirmLiveMode({
        credential: live,
        intent: 'x',
        input,
        output: new PassThrough(),
      });
      input.write(`${answer}\n`);
      await expect(promise, answer).rejects.toThrow(/did not match/);
    }
  });
});

describe('masking', () => {
  it('keeps the prefix and the last four characters and nothing else', () => {
    const masked = maskSecret('sk_test_51abcdefghijklmnopqrstuvwx');
    expect(masked).toBe('sk_test_••••••••uvwx');
    expect(masked).not.toContain('abcdefghij');
  });

  it('masks a signing secret the same way', () => {
    expect(maskSecret('whsec_abcdefgh1234')).toBe('whsec_••••••••1234');
  });

  it('reveals nothing at all from a short value', () => {
    expect(maskSecret('sk_test_abc')).toBe('sk_test_••••••••');
  });

  it('says so when there is no value rather than printing an empty string', () => {
    expect(maskSecret(undefined)).toBe('(unset)');
    expect(maskSecret('')).toBe('(unset)');
  });
});
