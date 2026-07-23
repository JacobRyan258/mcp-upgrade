/**
 * The body of `scripts/verify-stripe.ts`.
 *
 * Same split as the setup script: everything except process wiring lives here
 * so it can be imported by a test without a verification run happening on
 * import.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import Stripe from 'stripe';
import { UsageError, VERIFY_USAGE, isLocalOrigin, parseVerifyArgs } from './args.ts';
import { audit } from './audit.ts';
import type { AuditReport } from './audit.ts';
import { ENV_KEYS, REPO_ROOT, discoverWebhookPath } from './contract.ts';
import { readEnvValue } from './env-file.ts';
import { gatewayFor } from './gateway.ts';
import { GuardError, resolveCredential } from './guard.ts';

const SYMBOLS: Record<string, string> = { pass: 'ok  ', fail: 'FAIL', warn: 'warn', skip: '--  ' };

export async function main(argv: readonly string[]): Promise<number> {
  const options = parseVerifyArgs(argv);
  if (options.help) {
    process.stdout.write(VERIFY_USAGE);
    return 0;
  }

  const credential = resolveCredential({
    rawKey: process.env.STRIPE_SECRET_KEY,
    live: options.live,
  });

  const webhookPath = discoverWebhookPath();
  const urls: string[] = [];
  if (!isLocalOrigin(options.baseUrl)) urls.push(`${options.baseUrl}${webhookPath}`);
  if (options.productionBaseUrl) {
    const url = `${options.productionBaseUrl}${webhookPath}`;
    if (!urls.includes(url)) urls.push(url);
  }

  const configured = readConfiguredPriceId(options.envFile);

  const stripe = new Stripe(credential.key, {
    maxNetworkRetries: 2,
    timeout: 20_000,
    telemetry: false,
  });

  const report = await audit({
    gateway: gatewayFor(stripe),
    mode: credential.mode,
    webhookUrls: urls,
    configuredPortal: true,
    portalBaseUrl: options.productionBaseUrl ?? options.baseUrl,
    envPriceId: configured.value,
    envSource: configured.source,
  });

  if (options.json) {
    process.stdout.write(`${JSON.stringify({ ...report, mode: credential.mode }, null, 2)}\n`);
  } else {
    print(report, credential.description, webhookPath);
  }

  return report.ok ? 0 : 1;
}

function readConfiguredPriceId(envFile: string | null): { value: string | null; source: string } {
  if (!envFile) {
    return {
      value: process.env[ENV_KEYS.priceId] ?? null,
      source: `the process environment`,
    };
  }
  const absolute = path.resolve(REPO_ROOT, envFile);
  try {
    return {
      value: readEnvValue(readFileSync(absolute, 'utf8'), ENV_KEYS.priceId),
      source: path.relative(REPO_ROOT, absolute),
    };
  } catch {
    throw new UsageError(`--env-file ${envFile} could not be read.`);
  }
}

function print(report: AuditReport, description: string, webhookPath: string): void {
  const out = (line = ''): void => {
    process.stdout.write(`${line}\n`);
  };

  out();
  out('Stripe verification (read-only)');
  out(`  credential  ${description}`);
  out(`  account     ${report.accountId ?? 'not readable with this key'}`);
  out(`  route       ${webhookPath}`);
  out();

  for (const check of report.checks) {
    out(`  [${SYMBOLS[check.status] ?? '?   '}] ${check.name}`);
    out(`         ${check.detail}`);
  }
  out();

  const failures = report.checks.filter((check) => check.status === 'fail').length;
  const warnings = report.checks.filter((check) => check.status === 'warn').length;
  out(
    report.ok
      ? `Verified. ${warnings} warning${warnings === 1 ? '' : 's'}.`
      : `${failures} check${failures === 1 ? '' : 's'} failed.`,
  );
  out();
}

export function fail(error: unknown): number {
  const write = (line: string): void => {
    process.stderr.write(`${line}\n`);
  };
  if (error instanceof UsageError) {
    write(`\n${error.message}\n`);
    write(VERIFY_USAGE);
    return 2;
  }
  if (error instanceof GuardError) {
    write(`\n${error.message}\n`);
    write(error.guidance);
    write('');
    return 1;
  }
  write(`\nVerification could not complete: ${error instanceof Error ? error.message : String(error)}\n`);
  return 1;
}
