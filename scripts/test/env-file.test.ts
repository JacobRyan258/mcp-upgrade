/**
 * Environment file writing.
 *
 * Two classes of failure are being guarded against, and they pull in opposite
 * directions: destroying configuration the operator wrote by hand, and leaking
 * a credential into version control. The tests below hold both ends.
 */
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  EnvFileError,
  applyEnvValues,
  readEnvValue,
  writeEnvFile,
} from '../stripe/env-file.ts';
import type { GitProbe } from '../stripe/env-file.ts';

const ignoresEverything: GitProbe = { isTracked: () => false, isIgnored: () => true };
const tracked: GitProbe = { isTracked: () => true, isIgnored: () => true };
const notIgnored: GitProbe = { isTracked: () => false, isIgnored: () => false };

function scratch(): string {
  return mkdtempSync(path.join(tmpdir(), 'mcp-upgrade-env-'));
}

describe('rewriting env text', () => {
  it('updates only the keys it was given', () => {
    const before = [
      'DATABASE_URL=postgresql://localhost/db',
      'STRIPE_PRO_MONTHLY_PRICE_ID=price_old',
      'WORKER_SHARED_SECRET=keepme',
      '',
    ].join('\n');

    const after = applyEnvValues(before, { STRIPE_PRO_MONTHLY_PRICE_ID: 'price_new' });

    expect(after.content).toContain('DATABASE_URL=postgresql://localhost/db');
    expect(after.content).toContain('WORKER_SHARED_SECRET=keepme');
    expect(after.content).toContain('STRIPE_PRO_MONTHLY_PRICE_ID=price_new');
    expect(after.content).not.toContain('price_old');
    expect(after.updated).toEqual(['STRIPE_PRO_MONTHLY_PRICE_ID']);
  });

  it('preserves comments, blank lines and their order', () => {
    const before = [
      '# --- Stripe: TEST MODE ONLY ---',
      '# All three must be present for billing to be offered.',
      '',
      'STRIPE_SECRET_KEY=sk_test_old',
      '',
      '# Optional.',
      '# GITHUB_TOKEN=ghp_x',
      '',
    ].join('\n');

    const after = applyEnvValues(before, { STRIPE_SECRET_KEY: 'sk_test_new' });

    expect(after.content.split('\n')).toEqual([
      '# --- Stripe: TEST MODE ONLY ---',
      '# All three must be present for billing to be offered.',
      '',
      'STRIPE_SECRET_KEY=sk_test_new',
      '',
      '# Optional.',
      '# GITHUB_TOKEN=ghp_x',
      '',
    ]);
  });

  it('uncomments a key in place rather than appending a duplicate', () => {
    // This is the shape `apps/web/.env.local` actually ships in.
    const before = [
      '# Test-mode recurring price for "MCP Upgrade Pro", $19/month.',
      '#STRIPE_PRO_MONTHLY_PRICE_ID=price_...',
      '',
    ].join('\n');

    const after = applyEnvValues(before, { STRIPE_PRO_MONTHLY_PRICE_ID: 'price_real' });

    expect(after.content).toBe(
      [
        '# Test-mode recurring price for "MCP Upgrade Pro", $19/month.',
        'STRIPE_PRO_MONTHLY_PRICE_ID=price_real',
        '',
      ].join('\n'),
    );
    // The explanatory comment stays directly above the value it explains.
    expect(after.content.match(/STRIPE_PRO_MONTHLY_PRICE_ID/g)).toHaveLength(1);
  });

  it('appends a key that is absent entirely, under its own header', () => {
    const after = applyEnvValues('EXISTING=1\n', { STRIPE_WEBHOOK_SECRET: 'whsec_x' });
    expect(after.added).toEqual(['STRIPE_WEBHOOK_SECRET']);
    expect(after.content).toContain('# Added by scripts/setup-stripe.ts.');
    expect(after.content).toContain('STRIPE_WEBHOOK_SECRET=whsec_x');
    expect(after.content).toContain('EXISTING=1');
  });

  it('reports an already-correct value as unchanged rather than rewriting it', () => {
    const after = applyEnvValues('STRIPE_SECRET_KEY=sk_test_same\n', {
      STRIPE_SECRET_KEY: 'sk_test_same',
    });
    expect(after.unchanged).toEqual(['STRIPE_SECRET_KEY']);
    expect(after.updated).toEqual([]);
    expect(after.added).toEqual([]);
  });

  it('sets every uncommented occurrence, not just the last one', () => {
    const after = applyEnvValues('K=a\nOTHER=1\nK=b\n', { K: 'c' });
    expect(after.content).toBe('K=c\nOTHER=1\nK=c\n');
  });

  it('does not match a key that is only a prefix of another', () => {
    const after = applyEnvValues('STRIPE_SECRET_KEY_OLD=x\n', { STRIPE_SECRET_KEY: 'sk_test_y' });
    expect(after.content).toContain('STRIPE_SECRET_KEY_OLD=x');
    expect(after.added).toEqual(['STRIPE_SECRET_KEY']);
  });

  it('quotes a value that would otherwise be ambiguous', () => {
    const after = applyEnvValues('', { K: 'has space # and hash' });
    expect(after.content).toContain('K="has space # and hash"');
  });

  it('reads a value back out again', () => {
    expect(readEnvValue('A=1\nSTRIPE_PRO_MONTHLY_PRICE_ID=price_1\n', 'STRIPE_PRO_MONTHLY_PRICE_ID')).toBe(
      'price_1',
    );
    expect(readEnvValue('#STRIPE_PRO_MONTHLY_PRICE_ID=price_1\n', 'STRIPE_PRO_MONTHLY_PRICE_ID')).toBeNull();
    expect(readEnvValue('K="quoted"\n', 'K')).toBe('quoted');
    expect(readEnvValue('K=value # trailing\n', 'K')).toBe('value');
  });
});

describe('writing to disk', () => {
  it('writes, and takes a backup of what was there before', () => {
    const root = scratch();
    writeFileSync(path.join(root, '.env.local'), 'STRIPE_PRO_MONTHLY_PRICE_ID=price_old\n');

    const result = writeEnvFile({
      file: '.env.local',
      repoRoot: root,
      values: { STRIPE_PRO_MONTHLY_PRICE_ID: 'price_new' },
      git: ignoresEverything,
      dryRun: false,
    });

    expect(result.backup).toBe('.env.local.bak');
    expect(readFileSync(path.join(root, '.env.local'), 'utf8')).toContain('price_new');
    expect(readFileSync(path.join(root, '.env.local.bak'), 'utf8')).toContain('price_old');
  });

  it('creates the file when it does not exist', () => {
    const root = scratch();
    const result = writeEnvFile({
      file: '.env.local',
      repoRoot: root,
      values: { STRIPE_PRO_MONTHLY_PRICE_ID: 'price_1' },
      git: ignoresEverything,
      dryRun: false,
    });
    expect(result.created).toBe(true);
    expect(result.backup).toBeNull();
    expect(readFileSync(path.join(root, '.env.local'), 'utf8')).toContain('price_1');
  });

  it('refuses a file tracked by git', () => {
    const root = scratch();
    writeFileSync(path.join(root, '.env.local'), '');
    expect(() =>
      writeEnvFile({
        file: '.env.local',
        repoRoot: root,
        values: { STRIPE_SECRET_KEY: 'sk_test_x' },
        git: tracked,
        dryRun: false,
      }),
    ).toThrow(/tracked by git/);
    expect(readFileSync(path.join(root, '.env.local'), 'utf8')).toBe('');
  });

  it('refuses a file git does not ignore, even if it is untracked today', () => {
    const root = scratch();
    expect(() =>
      writeEnvFile({
        file: 'notes.txt',
        repoRoot: root,
        values: { STRIPE_SECRET_KEY: 'sk_test_x' },
        git: notIgnored,
        dryRun: false,
      }),
    ).toThrow(/not ignored by git/);
  });

  it('refuses a path outside the repository', () => {
    expect(() =>
      writeEnvFile({
        file: '../../elsewhere/.env',
        repoRoot: scratch(),
        values: {},
        git: ignoresEverything,
        dryRun: false,
      }),
    ).toThrow(EnvFileError);
  });

  it('writes nothing during a dry run', () => {
    const root = scratch();
    writeFileSync(path.join(root, '.env.local'), 'STRIPE_PRO_MONTHLY_PRICE_ID=price_old\n');

    const result = writeEnvFile({
      file: '.env.local',
      repoRoot: root,
      values: { STRIPE_PRO_MONTHLY_PRICE_ID: 'price_new' },
      git: ignoresEverything,
      dryRun: true,
    });

    expect(result.updated).toEqual(['STRIPE_PRO_MONTHLY_PRICE_ID']);
    expect(readFileSync(path.join(root, '.env.local'), 'utf8')).toContain('price_old');
    expect(result.backup).toBeNull();
  });

  it('takes no backup when nothing would change', () => {
    const root = scratch();
    writeFileSync(path.join(root, '.env.local'), 'STRIPE_PRO_MONTHLY_PRICE_ID=price_same\n');
    const result = writeEnvFile({
      file: '.env.local',
      repoRoot: root,
      values: { STRIPE_PRO_MONTHLY_PRICE_ID: 'price_same' },
      git: ignoresEverything,
      dryRun: false,
    });
    expect(result.backup).toBeNull();
    expect(result.unchanged).toEqual(['STRIPE_PRO_MONTHLY_PRICE_ID']);
  });

  it('refuses when the backup itself would not be ignored', () => {
    const root = scratch();
    writeFileSync(path.join(root, '.env.local'), 'A=1\n');
    const onlyTheFile: GitProbe = {
      isTracked: () => false,
      isIgnored: (file) => file === '.env.local',
    };
    expect(() =>
      writeEnvFile({
        file: '.env.local',
        repoRoot: root,
        values: { STRIPE_SECRET_KEY: 'sk_test_x' },
        git: onlyTheFile,
        dryRun: false,
      }),
    ).toThrow(/backup would contain|would not be ignored/);
  });

  it('creates the file readable only by its owner', () => {
    const root = scratch();
    writeEnvFile({
      file: '.env.local',
      repoRoot: root,
      values: { STRIPE_SECRET_KEY: 'sk_test_x' },
      git: ignoresEverything,
      dryRun: false,
    });
    // A credentials file that lands world-readable is a quiet way to leak one
    // on a shared machine.
    const mode = statSync(path.join(root, '.env.local')).mode & 0o777;
    expect(mode & 0o077).toBe(0);
  });
});
