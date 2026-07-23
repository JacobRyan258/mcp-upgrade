/**
 * Argument handling, target derivation and exit codes.
 *
 * The argument tests matter more than they look: a mistyped `--dry-run` that
 * parses as "no flags given" would run for real against a Stripe account, so
 * unknown flags are an error rather than something to ignore.
 */
import { describe, expect, it } from 'vitest';
import {
  SETUP_USAGE,
  UsageError,
  VERIFY_USAGE,
  isLocalOrigin,
  parseBaseUrl,
  parseSetupArgs,
  parseVerifyArgs,
} from '../stripe/args.ts';
import { EnvFileError } from '../stripe/env-file.ts';
import { GuardError } from '../stripe/guard.ts';
import { ProvisionError } from '../stripe/provision.ts';
import { fail, webhookTargets } from '../stripe/setup.ts';

describe('parsing setup arguments', () => {
  it('defaults to localhost, test mode, portal on, dry run off', () => {
    const options = parseSetupArgs([]);
    expect(options).toMatchObject({
      baseUrl: 'http://localhost:3000',
      productionBaseUrl: null,
      live: false,
      dryRun: false,
      json: false,
      configurePortal: true,
      writeEnv: [],
    });
  });

  it('accepts both --flag value and --flag=value', () => {
    expect(parseSetupArgs(['--base-url', 'https://a.test']).baseUrl).toBe('https://a.test');
    expect(parseSetupArgs(['--base-url=https://a.test']).baseUrl).toBe('https://a.test');
  });

  it('takes --write-env more than once', () => {
    const options = parseSetupArgs(['--write-env', 'a/.env', '--write-env', 'b/.env']);
    expect(options.writeEnv).toEqual(['a/.env', 'b/.env']);
  });

  it('rejects an unknown flag rather than ignoring it', () => {
    expect(() => parseSetupArgs(['--dryrun'])).toThrow(UsageError);
    expect(() => parseSetupArgs(['--dry–run'])).toThrow(/Unknown option/);
  });

  it('rejects a bare positional argument', () => {
    expect(() => parseSetupArgs(['setup'])).toThrow(/Every option starts with --/);
  });

  it('rejects a value-taking flag with no value', () => {
    expect(() => parseSetupArgs(['--base-url'])).toThrow(/needs a value/);
    expect(() => parseSetupArgs(['--base-url', '--dry-run'])).toThrow(/needs a value/);
  });

  it('rejects a repeated single-valued flag', () => {
    expect(() => parseSetupArgs(['--base-url=https://a.test', '--base-url=https://b.test'])).toThrow(
      /more than once/,
    );
  });

  it('rejects a boolean flag given a value', () => {
    expect(() => parseSetupArgs(['--dry-run=false'])).toThrow(/does not take a value/);
  });

  it('parses --help without validating anything else', () => {
    expect(parseSetupArgs(['--help', '--base-url', 'not a url']).help).toBe(true);
  });
});

describe('base URLs', () => {
  it('keeps only the origin and rejects anything carrying a path', () => {
    expect(parseBaseUrl('https://upgrade.jacobryanlive.com', '--base-url')).toBe(
      'https://upgrade.jacobryanlive.com',
    );
    expect(() => parseBaseUrl('https://a.test/app', '--base-url')).toThrow(/no path/);
    expect(() => parseBaseUrl('https://a.test/?x=1', '--base-url')).toThrow(/no path/);
    expect(() => parseBaseUrl('not-a-url', '--base-url')).toThrow(/not a URL/);
    expect(() => parseBaseUrl('ftp://a.test', '--base-url')).toThrow(/http or https/);
  });

  it('knows which origins Stripe could never reach', () => {
    expect(isLocalOrigin('http://localhost:3000')).toBe(true);
    expect(isLocalOrigin('http://127.0.0.1:3000')).toBe(true);
    expect(isLocalOrigin('http://app.localhost')).toBe(true);
    expect(isLocalOrigin('https://upgrade.jacobryanlive.com')).toBe(false);
  });
});

describe('deriving webhook targets', () => {
  const path = '/api/stripe/webhook';

  it('registers nothing for a localhost base URL', () => {
    const targets = webhookTargets(parseSetupArgs([]), path);
    expect(targets.urls).toEqual([]);
    expect(targets.primaryUrl).toBeNull();
    expect(targets.skippedLocal).toBe('http://localhost:3000');
  });

  it('registers the production endpoint alongside a local base URL', () => {
    const targets = webhookTargets(
      parseSetupArgs(['--production-base-url', 'https://upgrade.jacobryanlive.com']),
      path,
    );
    expect(targets.urls).toEqual(['https://upgrade.jacobryanlive.com/api/stripe/webhook']);
    // The local env file must not receive a production endpoint's secret.
    expect(targets.primaryUrl).toBeNull();
  });

  it('does not register the same URL twice', () => {
    const targets = webhookTargets(
      parseSetupArgs([
        '--base-url',
        'https://upgrade.jacobryanlive.com',
        '--production-base-url',
        'https://upgrade.jacobryanlive.com',
      ]),
      path,
    );
    expect(targets.urls).toHaveLength(1);
    expect(targets.primaryUrl).toBe('https://upgrade.jacobryanlive.com/api/stripe/webhook');
  });

  it('refuses a local production URL', () => {
    expect(() =>
      webhookTargets(parseSetupArgs(['--production-base-url', 'http://localhost:3000']), path),
    ).toThrow(/must not be a local origin/);
  });
});

describe('parsing verify arguments', () => {
  it('has no way to write anything', () => {
    // Not a behavioural assertion so much as a contract one: if a --write or
    // --fix flag is ever added here, this fails and somebody has to think.
    expect(VERIFY_USAGE).not.toMatch(/--write|--fix|--repair/);
    expect(VERIFY_USAGE).toContain('Read-only');
  });

  it('reads the price id from a file when asked', () => {
    expect(parseVerifyArgs(['--env-file', 'apps/web/.env.local']).envFile).toBe(
      'apps/web/.env.local',
    );
  });

  it('rejects setup-only flags', () => {
    expect(() => parseVerifyArgs(['--dry-run'])).toThrow(/Unknown option/);
    expect(() => parseVerifyArgs(['--write-env', 'x'])).toThrow(/Unknown option/);
  });
});

describe('exit codes', () => {
  it('uses 2 for a usage error and prints the usage text', () => {
    expect(fail(new UsageError('bad flag'))).toBe(2);
  });

  it('uses 1 for a refusal the operator can act on', () => {
    expect(fail(new GuardError('nope', 'do this instead'))).toBe(1);
    expect(fail(new ProvisionError('nope', 'do this instead'))).toBe(1);
    expect(fail(new EnvFileError('nope', 'do this instead'))).toBe(1);
  });

  it('uses 1 for an unexpected Stripe failure', () => {
    expect(fail(new Error('connection reset'))).toBe(1);
  });

  it('never exits 0 on a failure of any kind', () => {
    for (const error of [new Error('x'), 'a string', null, undefined]) {
      expect(fail(error)).toBeGreaterThan(0);
    }
  });
});

describe('usage text', () => {
  it('says test mode is the default', () => {
    expect(SETUP_USAGE).toMatch(/test mode by\s+default/i);
  });

  it('tells the reader the key comes from the environment and is never printed', () => {
    expect(SETUP_USAGE).toContain('STRIPE_SECRET_KEY');
    expect(SETUP_USAGE).toMatch(/never printed/);
  });
});
