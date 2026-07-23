/**
 * The one place local runtime configuration comes from.
 *
 * This repository had no environment loader at all. Nothing read the root
 * `.env`: Next.js loaded `apps/web/.env.local` (the only file in its own
 * project directory), the worker read whatever the shell happened to export,
 * and the Stripe scripts required the operator to export a key by hand. The
 * result was a root `.env` that looked authoritative, was internally
 * inconsistent — a key from one Stripe account paired with a price id from
 * another — and could not have worked even if something had loaded it.
 *
 * The rules this module enforces, in order:
 *
 *   1. There is exactly one approved local file: `<repo>/.env`. Not a search
 *      path, not a cascade — one resolved absolute path.
 *   2. The real process environment always wins over the file. That is what
 *      keeps Vercel, Docker `-e` and CI secrets working: in a hosted
 *      deployment there is no `.env` at all and the platform is the source.
 *   3. `.env.local` and `.env.example` are never read. `.env.example` is
 *      documentation; `.env.local` is the framework default this project
 *      deliberately opts out of.
 *   4. A forbidden file that still *defines* a runtime variable is a hard
 *      error, not a warning. Deleting `apps/web/.env.local` once would fix
 *      today; failing loudly when it reappears is what fixes next month.
 *   5. A key defined twice with two different values inside the approved file
 *      is a hard error. dotenv's "last one wins" is a coin flip that looks
 *      like configuration.
 *
 * No value is ever printed. Everything this module reports is a variable
 * *name*, a file path, or a masked form.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** The single approved local runtime file. */
export const APPROVED_ENV_FILE = path.join(REPO_ROOT, '.env');

/**
 * Files that must never contribute a runtime value.
 *
 * `.env.example` is in here as well as being unreadable by construction: it is
 * tracked documentation, so a value in it is either a placeholder or a leak,
 * and neither belongs in `process.env`.
 */
export const FORBIDDEN_ENV_FILES = Object.freeze([
  '.env.local',
  '.env.development',
  '.env.development.local',
  '.env.production',
  '.env.production.local',
  '.env.test.local',
  'apps/web/.env',
  'apps/web/.env.local',
  'apps/web/.env.development',
  'apps/web/.env.development.local',
  'apps/web/.env.production',
  'apps/web/.env.production.local',
  'apps/worker/.env',
  'apps/worker/.env.local',
]);

/** Documentation-only files. Never loaded, and checked for real-looking secrets. */
export const EXAMPLE_ENV_FILES = Object.freeze(['.env.example']);

export class EnvLoadError extends Error {
  /** @param {string} message @param {string} guidance */
  constructor(message, guidance) {
    super(message);
    this.name = 'EnvLoadError';
    this.guidance = guidance;
  }
}

/* -------------------------------------------------------------------------- */
/* Parsing                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Parses env-file text into entries, keeping every occurrence.
 *
 * Occurrences are kept rather than collapsed so a duplicate definition can be
 * reported with both line numbers. A parser that returned a plain object could
 * not tell "defined once" from "defined twice, identically".
 *
 * @param {string} text
 * @returns {{ key: string, value: string, line: number }[]}
 */
export function parseEnv(text) {
  /** @type {{ key: string, value: string, line: number }[]} */
  const entries = [];
  const lines = text.split(/\r?\n/);

  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index];
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;

    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/.exec(line);
    if (!match) continue;

    const key = match[1];
    let value = match[2].trim();

    if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
      // Only double quotes get escape processing, matching dotenv.
      value = value.slice(1, -1).replace(/\\n/g, '\n').replace(/\\r/g, '\r').replace(/\\"/g, '"');
    } else if (value.startsWith("'") && value.endsWith("'") && value.length >= 2) {
      value = value.slice(1, -1);
    } else {
      // An unquoted value ends at an inline comment.
      value = value.replace(/\s+#.*$/, '').trim();
    }

    entries.push({ key, value, line: index + 1 });
  }

  return entries;
}

/**
 * Collapses entries to a map, refusing keys defined twice with different values.
 *
 * @param {{ key: string, value: string, line: number }[]} entries
 * @param {string} label Path shown in the error, for the operator's benefit.
 * @returns {Record<string, string>}
 */
export function collapseEntries(entries, label) {
  /** @type {Record<string, string>} */
  const values = {};
  /** @type {Record<string, number>} */
  const firstLine = {};
  /** @type {string[]} */
  const conflicts = [];

  for (const entry of entries) {
    if (Object.prototype.hasOwnProperty.call(values, entry.key)) {
      if (values[entry.key] !== entry.value) {
        conflicts.push(`${entry.key} (lines ${firstLine[entry.key]} and ${entry.line})`);
      }
      continue;
    }
    values[entry.key] = entry.value;
    firstLine[entry.key] = entry.line;
  }

  if (conflicts.length > 0) {
    throw new EnvLoadError(
      `${label} defines the same variable twice with different values: ${conflicts.join(', ')}.`,
      'Delete the wrong one. Which value a loader picks is an implementation ' +
        'detail, so leaving both means the configuration is decided by luck.',
    );
  }

  return values;
}

/* -------------------------------------------------------------------------- */
/* Forbidden files                                                             */
/* -------------------------------------------------------------------------- */

/**
 * @typedef {{ file: string, keys: string[] }} ForbiddenFinding
 */

/**
 * Finds forbidden env files that still define variables.
 *
 * A file that exists but is entirely comments is fine — that is exactly the
 * shape this repository leaves `apps/web/.env.local` in, so the explanation of
 * why it is empty lives next to the emptiness.
 *
 * @param {string} [repoRoot]
 * @returns {ForbiddenFinding[]}
 */
export function findForbiddenDefinitions(repoRoot = REPO_ROOT) {
  /** @type {ForbiddenFinding[]} */
  const findings = [];

  for (const relative of FORBIDDEN_ENV_FILES) {
    const absolute = path.join(repoRoot, relative);
    if (!existsSync(absolute)) continue;

    const entries = parseEnv(readFileSync(absolute, 'utf8'));
    if (entries.length === 0) continue;

    findings.push({
      file: relative,
      keys: [...new Set(entries.map((entry) => entry.key))].sort(),
    });
  }

  return findings;
}

/** @param {ForbiddenFinding[]} findings */
function forbiddenError(findings) {
  const detail = findings
    .map((finding) => `  ${finding.file} defines ${finding.keys.join(', ')}`)
    .join('\n');

  return new EnvLoadError(
    `Forbidden environment file(s) define runtime variables:\n${detail}`,
    'This project loads exactly one local file: .env at the repository root.\n' +
      'Next.js would otherwise load apps/web/.env.local for the web app, which is\n' +
      'how two different Stripe accounts ended up configured at once.\n\n' +
      'Move any value you still need into .env, then comment the lines out (or\n' +
      'delete the file). Run `npm run verify:env-files` to check.',
  );
}

/* -------------------------------------------------------------------------- */
/* Loading                                                                     */
/* -------------------------------------------------------------------------- */

let loaded = false;

/**
 * @typedef {object} LoadResult
 * @property {string | null} file Absolute path loaded, or null on a hosted platform.
 * @property {string[]} applied Variable names taken from the file.
 * @property {string[]} preexisting Variable names the real environment already set.
 * @property {'file' | 'platform'} source
 */

/**
 * Loads the approved `.env` into `process.env`.
 *
 * @param {object} [options]
 * @param {string} [options.repoRoot]
 * @param {boolean} [options.force] Load again even if already loaded. Tests only.
 * @param {NodeJS.ProcessEnv} [options.env] Target. Defaults to `process.env`.
 * @returns {LoadResult}
 */
export function loadRootEnv(options = {}) {
  const repoRoot = options.repoRoot ?? REPO_ROOT;
  const target = options.env ?? process.env;

  if (loaded && !options.force && target === process.env) {
    return { file: APPROVED_ENV_FILE, applied: [], preexisting: [], source: 'file' };
  }

  // A forbidden file is refused before anything is loaded, so the failure is
  // about the misconfiguration rather than about whatever it caused.
  const forbidden = findForbiddenDefinitions(repoRoot);
  if (forbidden.length > 0) throw forbiddenError(forbidden);

  const file = path.join(repoRoot, '.env');

  if (!existsSync(file)) {
    // A hosted deployment legitimately has no .env — the platform injects
    // everything. Refusing here would make Vercel unbootable.
    if (isHostedPlatform(target)) {
      loaded = true;
      return { file: null, applied: [], preexisting: [], source: 'platform' };
    }
    throw new EnvLoadError(
      `${path.relative(repoRoot, file) || '.env'} does not exist.`,
      'Copy .env.example to .env and fill in real values. The example file is\n' +
        'documentation and is never loaded — its placeholders are deliberately\n' +
        'chosen so they cannot satisfy validation if pasted through unchanged.',
    );
  }

  const values = collapseEntries(parseEnv(readFileSync(file, 'utf8')), path.relative(repoRoot, file));

  /** @type {string[]} */
  const applied = [];
  /** @type {string[]} */
  const preexisting = [];

  for (const [key, value] of Object.entries(values)) {
    // The real environment wins. On Vercel and in CI the platform is the source
    // of truth, and a stale file must never quietly replace an injected secret.
    if (typeof target[key] === 'string' && target[key] !== '') {
      preexisting.push(key);
      continue;
    }
    target[key] = value;
    applied.push(key);
  }

  if (target === process.env) loaded = true;
  return { file, applied: applied.sort(), preexisting: preexisting.sort(), source: 'file' };
}

/**
 * Whether this process is running on a platform that injects its own
 * environment. Vercel, and an explicit escape hatch for any other host.
 *
 * @param {NodeJS.ProcessEnv} env
 */
export function isHostedPlatform(env = process.env) {
  return Boolean(env.VERCEL || env.VERCEL_ENV || env.DEPLOY_ENV || env.CI);
}

/** Clears the once-only latch. Tests only. */
export function resetLoadedFlag() {
  loaded = false;
}
