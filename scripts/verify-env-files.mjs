#!/usr/bin/env node
/**
 * Static audit of every environment file in the repository.
 *
 * Read-only, network-free and fast enough to run in CI on every push. It is
 * the check that would have caught this repository's actual state: a root
 * `.env` nothing loaded, an `apps/web/.env.local` that silently outranked it
 * with credentials for a different Stripe account, and a tracked `.env.example`
 * containing a real Stripe object id copied out of a working setup.
 *
 * Exits non-zero on any failure. Never prints a value — only names, paths,
 * prefixes and masked forms.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import {
  APPROVED_ENV_FILE,
  EXAMPLE_ENV_FILES,
  FORBIDDEN_ENV_FILES,
  REPO_ROOT,
  collapseEntries,
  findForbiddenDefinitions,
  parseEnv,
} from './env/load.mjs';

/** @type {{ level: 'fail' | 'warn', check: string, detail: string }[]} */
const problems = [];
/** @type {string[]} */
const passes = [];

/** @param {string} check @param {string} detail */
const fail = (check, detail) => problems.push({ level: 'fail', check, detail });
/** @param {string} check @param {string} detail */
const warn = (check, detail) => problems.push({ level: 'warn', check, detail });
/** @param {string} check @param {string} [detail] */
const pass = (check, detail = '') => passes.push(detail ? `${check} — ${detail}` : check);

const git = (args) => {
  try {
    return { ok: true, out: execFileSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }) };
  } catch {
    return { ok: false, out: '' };
  }
};

/* -------------------------------------------------------------------------- */
/* 1. The approved file exists, is ignored, and is untracked                   */
/* -------------------------------------------------------------------------- */

const approvedRelative = path.relative(REPO_ROOT, APPROVED_ENV_FILE);

if (!existsSync(APPROVED_ENV_FILE)) {
  warn('approved file', `${approvedRelative} does not exist (fine on a hosted platform, fatal locally)`);
} else {
  pass('approved file', `${approvedRelative} exists`);

  if (git(['ls-files', '--error-unmatch', '--', approvedRelative]).ok) {
    fail('approved file tracked', `${approvedRelative} is committed to git. Untrack it and rotate every secret in it.`);
  } else {
    pass('approved file untracked');
  }

  if (git(['check-ignore', '--quiet', '--no-index', '--', approvedRelative]).ok) {
    pass('approved file ignored');
  } else {
    fail('approved file not ignored', `${approvedRelative} is not covered by .gitignore; a later "git add ." would commit it.`);
  }

  const mode = statSync(APPROVED_ENV_FILE).mode & 0o777;
  if (mode & 0o077) {
    warn('approved file permissions', `${approvedRelative} is mode ${mode.toString(8)}; 600 is preferable for a file holding secrets.`);
  } else {
    pass('approved file permissions', `mode ${mode.toString(8)}`);
  }
}

/* -------------------------------------------------------------------------- */
/* 2. No forbidden file defines anything                                       */
/* -------------------------------------------------------------------------- */

const forbidden = findForbiddenDefinitions(REPO_ROOT);
if (forbidden.length > 0) {
  for (const finding of forbidden) {
    fail(
      'forbidden env file',
      `${finding.file} defines ${finding.keys.join(', ')}. Only ${approvedRelative} may define runtime values.`,
    );
  }
} else {
  pass('forbidden env files', `none of ${FORBIDDEN_ENV_FILES.length} watched paths define a variable`);
}

/* -------------------------------------------------------------------------- */
/* 3. No duplicate conflicting definitions anywhere                            */
/* -------------------------------------------------------------------------- */

/** Every env-ish file in the repo, ignoring dependencies and build output. */
function envFiles(directory = REPO_ROOT, relative = '') {
  /** @type {string[]} */
  const found = [];
  const skip = new Set(['node_modules', '.git', '.next', 'dist', 'build', 'coverage', 'test-results']);
  for (const entry of readdirSync(path.join(directory, relative), { withFileTypes: true })) {
    if (skip.has(entry.name)) continue;
    const child = relative ? path.join(relative, entry.name) : entry.name;
    if (entry.isDirectory()) found.push(...envFiles(directory, child));
    else if (/^\.env(\.|$)/.test(entry.name)) found.push(child);
  }
  return found;
}

const allEnvFiles = envFiles();

for (const relative of allEnvFiles) {
  const entries = parseEnv(readFileSync(path.join(REPO_ROOT, relative), 'utf8'));
  try {
    collapseEntries(entries, relative);
    if (entries.length > 0) pass('no duplicate definitions', relative);
  } catch (error) {
    fail('duplicate definitions', error.message);
  }
}

/* -------------------------------------------------------------------------- */
/* 4. No live-mode Stripe credential anywhere in a local env file              */
/* -------------------------------------------------------------------------- */

const LIVE_PREFIXES = ['sk_live_', 'rk_live_', 'pk_live_'];

for (const relative of allEnvFiles) {
  const entries = parseEnv(readFileSync(path.join(REPO_ROOT, relative), 'utf8'));
  for (const entry of entries) {
    const live = LIVE_PREFIXES.find((prefix) => entry.value.startsWith(prefix));
    if (live) {
      fail('live Stripe credential', `${relative}:${entry.line} — ${entry.key} begins with ${live}. This deployment is test-mode only.`);
    }
  }
}
if (!problems.some((p) => p.check === 'live Stripe credential')) {
  pass('no live Stripe credentials', 'checked every .env* file');
}

/* -------------------------------------------------------------------------- */
/* 5. Example files are documentation only                                     */
/* -------------------------------------------------------------------------- */

/**
 * A value that looks like it came out of a real Stripe account rather than
 * being a placeholder. Stripe's own identifiers are long and alphanumeric;
 * placeholders in this repository end in `...` or `_here` by convention.
 */
function looksReal(value) {
  if (/\.\.\.$/.test(value) || /_here$/.test(value) || value === '') return false;
  return (
    /^(sk|rk|pk)_(test|live)_[A-Za-z0-9]{16,}/.test(value) ||
    /^whsec_[A-Za-z0-9]{16,}/.test(value) ||
    /^(price|prod|we|sub|cus|acct|bpc)_[A-Za-z0-9]{14,}/.test(value) ||
    /^eyJ[A-Za-z0-9_-]{20,}\./.test(value)
  );
}

for (const relative of EXAMPLE_ENV_FILES) {
  const absolute = path.join(REPO_ROOT, relative);
  if (!existsSync(absolute)) continue;

  const entries = parseEnv(readFileSync(absolute, 'utf8'));
  let clean = true;

  for (const entry of entries) {
    if (looksReal(entry.value)) {
      clean = false;
      fail(
        'real value in example file',
        `${relative}:${entry.line} — ${entry.key} holds what looks like a real Stripe/JWT identifier. ` +
          'This file is tracked; replace it with a placeholder.',
      );
    }
  }

  // A placeholder that would satisfy runtime validation is worse than no
  // placeholder: it boots the app into a half-configured state.
  const values = Object.fromEntries(entries.map((e) => [e.key, e.value]));
  for (const [key, prefix] of [
    ['STRIPE_SECRET_KEY', 'sk_test_'],
    ['NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY', 'pk_test_'],
    ['STRIPE_WEBHOOK_SECRET', 'whsec_'],
    ['STRIPE_PRO_MONTHLY_PRICE_ID', 'price_'],
  ]) {
    const value = values[key];
    if (value === undefined) continue;
    if (value.startsWith(prefix) && value.length > prefix.length + 12) {
      clean = false;
      fail(
        'example value could pass validation',
        `${relative} — ${key} is long enough to look like a real credential. Keep placeholders obviously fake (e.g. ${prefix}...).`,
      );
    }
  }

  if (clean) pass('example file is documentation only', relative);

  if (!git(['ls-files', '--error-unmatch', '--', relative]).ok) {
    warn('example file untracked', `${relative} is not tracked; it is meant to be the committed template.`);
  }
}

/* -------------------------------------------------------------------------- */
/* 6. No tracked file holds secrets, and nothing loads a forbidden file        */
/* -------------------------------------------------------------------------- */

const tracked = git(['ls-files']).out.split('\n').filter(Boolean);
const trackedEnv = tracked.filter((file) => /^\.env(\.|$)/.test(path.basename(file)) && !EXAMPLE_ENV_FILES.includes(file));
if (trackedEnv.length > 0) {
  fail('tracked env file', `${trackedEnv.join(', ')} is committed. Only ${EXAMPLE_ENV_FILES.join(', ')} may be tracked.`);
} else {
  pass('no tracked env files', 'other than the example template');
}

/**
 * Source that reads a forbidden file by name.
 *
 * The loader and this script name those files deliberately, so they are
 * excluded; anything else mentioning them is either a stale runbook or code
 * about to reintroduce the override.
 */
const sourceExtensions = /\.(ts|tsx|js|mjs|cjs|json|ya?ml|sh|bash|zsh|Dockerfile)$/;
const allowedToMention = new Set([
  'scripts/env/load.mjs',
  'scripts/env/summary.mjs',
  'scripts/verify-env-files.mjs',
  'scripts/with-env.mjs',
]);

for (const file of tracked) {
  if (!sourceExtensions.test(file) && path.basename(file) !== 'Dockerfile') continue;
  if (allowedToMention.has(file) || file.startsWith('scripts/test/')) continue;
  const absolute = path.join(REPO_ROOT, file);
  if (!existsSync(absolute)) continue;
  const source = readFileSync(absolute, 'utf8');

  if (/dotenv|loadEnvConfig|--env-file[= ]\S*\.env\.(local|example)|\.env\.example['"]?\s*\)/.test(source)) {
    if (/\.env\.example/.test(source) && /readFile|require|import|dotenv|loadEnv/.test(source)) {
      fail('code loads an example file', `${file} appears to read .env.example at runtime.`);
    }
  }
}
if (!problems.some((p) => p.check === 'code loads an example file')) {
  pass('no code loads .env.example');
}

/* -------------------------------------------------------------------------- */
/* Report                                                                      */
/* -------------------------------------------------------------------------- */

const failures = problems.filter((p) => p.level === 'fail');
const warnings = problems.filter((p) => p.level === 'warn');

const out = process.stdout;
out.write('\nEnvironment file audit\n\n');
for (const line of passes) out.write(`  [ok  ] ${line}\n`);
for (const problem of warnings) out.write(`  [warn] ${problem.check} — ${problem.detail}\n`);
for (const problem of failures) out.write(`  [FAIL] ${problem.check} — ${problem.detail}\n`);

out.write(
  failures.length === 0
    ? `\nEnvironment files verified. ${warnings.length} warning${warnings.length === 1 ? '' : 's'}.\n\n`
    : `\n${failures.length} failure${failures.length === 1 ? '' : 's'}.\n\n`,
);

process.exit(failures.length === 0 ? 0 : 1);
