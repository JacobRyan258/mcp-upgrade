/**
 * Command line parsing.
 *
 * Hand-rolled rather than pulled from a dependency: the surface is small, and
 * adding a package to the root of a monorepo whose whole point is scanning
 * other people's supply chains deserves a better reason than argument parsing.
 *
 * Unknown flags are an error. A typo in `--dry-run` that silently ran for real
 * against a Stripe account is precisely the failure this script exists to
 * prevent.
 */

export interface CommonOptions {
  baseUrl: string;
  productionBaseUrl: string | null;
  live: boolean;
  json: boolean;
  help: boolean;
}

export interface SetupOptions extends CommonOptions {
  dryRun: boolean;
  configurePortal: boolean;
  writeEnv: string[];
}

export interface VerifyOptions extends CommonOptions {
  envFile: string | null;
}

export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UsageError';
  }
}

const DEFAULT_BASE_URL = 'http://localhost:3000';

interface Spec {
  /** Flags taking a value. */
  valued: Set<string>;
  /** Flags that may repeat. */
  repeatable: Set<string>;
  boolean: Set<string>;
}

function tokenise(argv: readonly string[], spec: Spec): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const push = (flag: string, value: string): void => {
    const existing = out.get(flag);
    if (existing && !spec.repeatable.has(flag)) {
      throw new UsageError(`${flag} was given more than once.`);
    }
    if (existing) existing.push(value);
    else out.set(flag, [value]);
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!;
    if (!token.startsWith('--')) {
      throw new UsageError(`Unexpected argument "${token}". Every option starts with --.`);
    }

    const equals = token.indexOf('=');
    const flag = equals === -1 ? token : token.slice(0, equals);
    const inline = equals === -1 ? null : token.slice(equals + 1);

    if (spec.boolean.has(flag)) {
      if (inline !== null) throw new UsageError(`${flag} does not take a value.`);
      push(flag, 'true');
      continue;
    }
    if (spec.valued.has(flag)) {
      const value = inline ?? argv[++index];
      if (value === undefined || value.startsWith('--')) {
        throw new UsageError(`${flag} needs a value.`);
      }
      push(flag, value);
      continue;
    }
    throw new UsageError(`Unknown option "${flag}". Run with --help to see what is accepted.`);
  }
  return out;
}

/**
 * Validates a base URL.
 *
 * Rejects anything with a path, query or fragment: the webhook path is appended
 * to this, and silently swallowing `https://example.com/app` would register an
 * endpoint at a URL the application does not serve.
 */
export function parseBaseUrl(value: string, flag: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new UsageError(`${flag} is not a URL: "${value}".`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new UsageError(`${flag} must be http or https, not "${url.protocol}".`);
  }
  if (url.search || url.hash || (url.pathname !== '/' && url.pathname !== '')) {
    throw new UsageError(
      `${flag} must be an origin with no path, query or fragment. Got "${value}".`,
    );
  }
  return url.origin;
}

/** True for a URL Stripe's servers could never reach. */
export function isLocalOrigin(origin: string): boolean {
  const host = new URL(origin).hostname;
  return (
    host === 'localhost' ||
    host === '127.0.0.1' ||
    host === '::1' ||
    host === '0.0.0.0' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local')
  );
}

export function parseSetupArgs(argv: readonly string[]): SetupOptions {
  const tokens = tokenise(argv, {
    valued: new Set(['--base-url', '--production-base-url', '--write-env']),
    repeatable: new Set(['--write-env']),
    boolean: new Set(['--dry-run', '--live', '--json', '--help', '--no-portal']),
  });

  const help = tokens.has('--help');
  const baseUrlRaw = tokens.get('--base-url')?.[0] ?? DEFAULT_BASE_URL;
  const productionRaw = tokens.get('--production-base-url')?.[0] ?? null;

  return {
    help,
    baseUrl: help ? baseUrlRaw : parseBaseUrl(baseUrlRaw, '--base-url'),
    productionBaseUrl:
      productionRaw === null || help
        ? productionRaw
        : parseBaseUrl(productionRaw, '--production-base-url'),
    live: tokens.has('--live'),
    json: tokens.has('--json'),
    dryRun: tokens.has('--dry-run'),
    configurePortal: !tokens.has('--no-portal'),
    writeEnv: tokens.get('--write-env') ?? [],
  };
}

export function parseVerifyArgs(argv: readonly string[]): VerifyOptions {
  const tokens = tokenise(argv, {
    valued: new Set(['--base-url', '--production-base-url', '--env-file']),
    repeatable: new Set(),
    boolean: new Set(['--live', '--json', '--help']),
  });

  const help = tokens.has('--help');
  const baseUrlRaw = tokens.get('--base-url')?.[0] ?? DEFAULT_BASE_URL;
  const productionRaw = tokens.get('--production-base-url')?.[0] ?? null;

  return {
    help,
    baseUrl: help ? baseUrlRaw : parseBaseUrl(baseUrlRaw, '--base-url'),
    productionBaseUrl:
      productionRaw === null || help
        ? productionRaw
        : parseBaseUrl(productionRaw, '--production-base-url'),
    live: tokens.has('--live'),
    json: tokens.has('--json'),
    envFile: tokens.get('--env-file')?.[0] ?? null,
  };
}

export const SETUP_USAGE = `
Usage: npm run stripe:setup -- [options]

Provisions the Stripe objects the hosted application needs, in test mode by
default. Safe to rerun: existing objects are reused, never duplicated, and
nothing is ever deleted.

Options
  --base-url <origin>             Origin this setup is for.
                                  Default: ${DEFAULT_BASE_URL}
                                  A local origin registers no webhook endpoint —
                                  Stripe cannot reach it. Use \`stripe listen\`.
  --production-base-url <origin>  Also register the hosted webhook endpoint.
  --write-env <path>              Write the resulting values into an env file.
                                  May be repeated. The file must be gitignored
                                  and untracked, and is backed up first.
  --no-portal                     Leave the customer portal configuration alone.
  --dry-run                       Read everything, write nothing, print the plan.
  --live                          Permit a live-mode key. Requires typing a
                                  confirmation phrase at an interactive prompt.
  --json                          Machine-readable summary on stdout. Secrets are
                                  masked; the webhook signing secret is never
                                  included.
  --help                          This text.

The Stripe credential is read from STRIPE_SECRET_KEY in the environment. It is
never printed, never written to a tracked file, and never included in --json.
`.trimStart();

export const VERIFY_USAGE = `
Usage: npm run stripe:verify -- [options]

Read-only. Checks that Stripe matches what the application expects and exits
non-zero if it does not. Makes no writes of any kind.

Options
  --base-url <origin>             Origin to check the webhook endpoint for.
                                  Default: ${DEFAULT_BASE_URL}
  --production-base-url <origin>  Also check the hosted webhook endpoint.
  --env-file <path>               Read STRIPE_PRO_MONTHLY_PRICE_ID from this file
                                  instead of the process environment.
  --live                          Permit a live-mode key (read-only either way).
  --json                          Machine-readable report on stdout.
  --help                          This text.
`.trimStart();
