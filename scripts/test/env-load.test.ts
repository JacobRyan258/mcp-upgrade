/**
 * Proof that the environment precedence rules hold.
 *
 * Every test here corresponds to a way this repository was actually
 * misconfigured, not to a hypothetical. `.env.local` outranking `.env` is what
 * pointed the web app at a second Stripe account; a missing loader is why the
 * root `.env` was never read at all; and duplicate keys are what made
 * `.env.example` disagree with itself.
 *
 * The loader is exercised against a temporary directory rather than the real
 * repository so the assertions are about behaviour rather than about whatever
 * the developer's own `.env` happens to contain today.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  EnvLoadError,
  FORBIDDEN_ENV_FILES,
  collapseEntries,
  findForbiddenDefinitions,
  loadRootEnv,
  parseEnv,
  resetLoadedFlag,
} from '../env/load.mjs';

let root: string;

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'mcp-env-'));
  resetLoadedFlag();
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** Writes a file, creating parent directories. */
function write(relative: string, contents: string): void {
  const absolute = path.join(root, relative);
  mkdirSync(path.dirname(absolute), { recursive: true });
  writeFileSync(absolute, contents);
}

/** Loads into a throwaway object so the real process environment is untouched. */
function load(env: NodeJS.ProcessEnv = {}) {
  return { result: loadRootEnv({ repoRoot: root, env, force: true }), env };
}

describe('parsing', () => {
  it('reads plain, quoted, exported and commented forms', () => {
    const entries = parseEnv(
      [
        'PLAIN=one',
        'export EXPORTED=two',
        'DOUBLE="three three"',
        "SINGLE='four'",
        'TRAILING=five # a comment',
        '# WHOLE_LINE=ignored',
        '',
        'EMPTY=',
      ].join('\n'),
    );

    expect(Object.fromEntries(entries.map((e) => [e.key, e.value]))).toEqual({
      PLAIN: 'one',
      EXPORTED: 'two',
      DOUBLE: 'three three',
      SINGLE: 'four',
      TRAILING: 'five',
      EMPTY: '',
    });
  });

  it('does not treat a # inside a quoted value as a comment', () => {
    const entries = parseEnv('PASSWORD="a#b"');
    expect(entries[0]!.value).toBe('a#b');
  });
});

describe('duplicate definitions', () => {
  it('fails when one key is defined twice with different values', () => {
    const entries = parseEnv('DATABASE_URL=one\nDATABASE_URL=two\n');
    expect(() => collapseEntries(entries, '.env')).toThrow(/same variable twice/);
    expect(() => collapseEntries(entries, '.env')).toThrow(/lines 1 and 2/);
  });

  it('tolerates a key repeated with the identical value', () => {
    const entries = parseEnv('A=same\nA=same\n');
    expect(collapseEntries(entries, '.env')).toEqual({ A: 'same' });
  });

  it('surfaces through loadRootEnv', () => {
    write('.env', 'STRIPE_SECRET_KEY=sk_test_one\nSTRIPE_SECRET_KEY=sk_test_two\n');
    expect(() => load()).toThrow(EnvLoadError);
  });
});

describe('the approved file', () => {
  it('is loaded', () => {
    write('.env', 'STRIPE_SECRET_KEY=sk_test_abc\nOTHER=value\n');
    const { result, env } = load();

    expect(result.source).toBe('file');
    expect(result.file).toBe(path.join(root, '.env'));
    expect(env.STRIPE_SECRET_KEY).toBe('sk_test_abc');
    expect(result.applied).toContain('STRIPE_SECRET_KEY');
  });

  it('fails clearly when it is missing and this is not a hosted platform', () => {
    expect(() => load()).toThrow(/\.env does not exist/);
  });

  it('stands aside on a hosted platform, where the platform injects everything', () => {
    const { result, env } = load({ VERCEL: '1', STRIPE_SECRET_KEY: 'sk_test_from_vercel' });

    expect(result.source).toBe('platform');
    expect(result.file).toBeNull();
    // Requirement 21: the app boots on Vercel with no local .env at all.
    expect(env.STRIPE_SECRET_KEY).toBe('sk_test_from_vercel');
  });

  it('never overrides a value the real environment already set', () => {
    write('.env', 'STRIPE_SECRET_KEY=sk_test_from_file\n');
    const { result, env } = load({ STRIPE_SECRET_KEY: 'sk_test_from_platform' });

    expect(env.STRIPE_SECRET_KEY).toBe('sk_test_from_platform');
    expect(result.preexisting).toContain('STRIPE_SECRET_KEY');
    expect(result.applied).not.toContain('STRIPE_SECRET_KEY');
  });
});

describe('forbidden files', () => {
  it('lists apps/web/.env.local, which Next.js would otherwise load first', () => {
    expect(FORBIDDEN_ENV_FILES).toContain('apps/web/.env.local');
    expect(FORBIDDEN_ENV_FILES).toContain('apps/worker/.env');
  });

  it('refuses to load anything when a forbidden file defines a variable', () => {
    write('.env', 'STRIPE_SECRET_KEY=sk_test_correct\n');
    write('apps/web/.env.local', 'STRIPE_SECRET_KEY=sk_test_wrong_account\n');

    expect(() => load()).toThrow(/Forbidden environment file/);
    expect(() => load()).toThrow(/apps\/web\/\.env\.local defines STRIPE_SECRET_KEY/);
  });

  it('does not fail on a forbidden file that only contains comments', () => {
    write('.env', 'A=1\n');
    write('apps/web/.env.local', '# intentionally empty\n# see scripts/env/load.mjs\n');

    expect(() => load()).not.toThrow();
    expect(findForbiddenDefinitions(root)).toEqual([]);
  });

  it('refuses before loading, so a forbidden file cannot half-apply', () => {
    write('.env', 'GOOD=yes\n');
    write('apps/web/.env.local', 'BAD=yes\n');

    const env: NodeJS.ProcessEnv = {};
    expect(() => loadRootEnv({ repoRoot: root, env, force: true })).toThrow();
    expect(env.GOOD).toBeUndefined();
    expect(env.BAD).toBeUndefined();
  });
});

describe('.env.example', () => {
  it('is never loaded, even when it is the only env file present', () => {
    write('.env.example', 'STRIPE_SECRET_KEY=sk_test_...\n');

    // Missing .env is the error; the example file is not a fallback.
    expect(() => load()).toThrow(/\.env does not exist/);
  });

  it('does not contribute values when .env is present', () => {
    write('.env', 'STRIPE_SECRET_KEY=sk_test_real\n');
    write('.env.example', 'STRIPE_SECRET_KEY=sk_test_...\nONLY_IN_EXAMPLE=leaked\n');

    const { env } = load();
    expect(env.STRIPE_SECRET_KEY).toBe('sk_test_real');
    expect(env.ONLY_IN_EXAMPLE).toBeUndefined();
  });
});
