/**
 * The body of `scripts/setup-stripe.ts`.
 *
 * Kept out of the entry point so the parts worth testing — how webhook targets
 * are derived, which values reach an env file, how failures map to exit codes —
 * can be imported without running a provisioning pass as a side effect of the
 * import.
 */
import process from 'node:process';
import Stripe from 'stripe';
import { maskSecret } from '@mcp-upgrade/shared';
import { SETUP_USAGE, UsageError, isLocalOrigin, parseSetupArgs } from './args.ts';
import type { SetupOptions } from './args.ts';
import { ENV_KEYS, REPO_ROOT, REQUIRED_EVENTS, discoverWebhookPath } from './contract.ts';
import { dryRunGateway } from './dry-run.ts';
import type { PlannedWrite } from './dry-run.ts';
import { EnvFileError, gitProbe, writeEnvFile } from './env-file.ts';
import type { WriteResult } from './env-file.ts';
import { gatewayFor } from './gateway.ts';
import { GuardError, confirmLiveMode, resolveCredential } from './guard.ts';
import { ProvisionError, provision } from './provision.ts';
import type { ProvisionResult } from './provision.ts';

/* -------------------------------------------------------------------------- */
/* Targets                                                                     */
/* -------------------------------------------------------------------------- */

interface Targets {
  path: string;
  urls: string[];
  /** The URL whose signing secret belongs in `--write-env`, if any. */
  primaryUrl: string | null;
  /** Set when `--base-url` is somewhere Stripe cannot reach. */
  skippedLocal: string | null;
}

/**
 * Which endpoints to register.
 *
 * A localhost origin is skipped rather than attempted: Stripe's servers cannot
 * reach it, the API rejects it, and the correct local answer is `stripe listen`
 * with its own separate signing secret.
 */
export function webhookTargets(options: SetupOptions, webhookPath: string): Targets {
  const urls: string[] = [];
  let skippedLocal: string | null = null;
  let primaryUrl: string | null = null;

  if (isLocalOrigin(options.baseUrl)) {
    skippedLocal = options.baseUrl;
  } else {
    primaryUrl = `${options.baseUrl}${webhookPath}`;
    urls.push(primaryUrl);
  }

  if (options.productionBaseUrl) {
    if (isLocalOrigin(options.productionBaseUrl)) {
      throw new UsageError('--production-base-url must not be a local origin.');
    }
    const url = `${options.productionBaseUrl}${webhookPath}`;
    if (!urls.includes(url)) urls.push(url);
  }

  return { path: webhookPath, urls, primaryUrl, skippedLocal };
}

/**
 * Confirms every object Stripe returned lives in the mode we asked for.
 *
 * Cheap, and it is the check that would catch the one failure this script must
 * never have: touching live-mode objects while believing it is in test mode.
 */
function assertModeConsistency(result: ProvisionResult, mode: 'test' | 'live'): void {
  const live = mode === 'live';
  const wrong: string[] = [];
  if (result.product.livemode !== live) wrong.push(`product ${result.product.id}`);
  if (result.price.livemode !== live) wrong.push(`price ${result.price.id}`);
  for (const webhook of result.webhooks) {
    if (webhook.endpoint.livemode !== live) wrong.push(`webhook endpoint ${webhook.endpoint.id}`);
  }
  if (result.portal && result.portal.configuration.livemode !== live) {
    wrong.push(`portal configuration ${result.portal.configuration.id}`);
  }
  if (wrong.length > 0) {
    throw new ProvisionError(
      `Stripe returned ${wrong.join(', ')} in the wrong mode for a ${mode}-mode key.`,
      'Stop and check the account before using any of these ids. This should be impossible.',
    );
  }
}

/* -------------------------------------------------------------------------- */
/* Environment files                                                           */
/* -------------------------------------------------------------------------- */

export function writeEnvFiles(
  options: SetupOptions,
  mode: 'test' | 'live',
  secretKey: string,
  result: ProvisionResult,
  primaryUrl: string | null,
): WriteResult[] {
  if (options.writeEnv.length === 0) return [];

  const values: Record<string, string> = { [ENV_KEYS.priceId]: result.price.id };

  // The provisioning credential is only a sensible runtime credential in test
  // mode. In live mode the runtime should hold a restricted key with far fewer
  // permissions, so writing this one into an env file would be a downgrade
  // dressed up as convenience.
  if (mode === 'test') values[ENV_KEYS.secretKey] = secretKey;

  // Only the endpoint serving `--base-url` has a secret that belongs in the env
  // file for `--base-url`. A production endpoint's secret is a production value
  // and is reported on screen instead.
  const primary = result.webhooks.find((webhook) => webhook.url === primaryUrl);
  if (primary?.secret) values[ENV_KEYS.webhookSecret] = primary.secret;

  const git = gitProbe(REPO_ROOT);
  return options.writeEnv.map((file) =>
    writeEnvFile({ file, repoRoot: REPO_ROOT, values, git, dryRun: options.dryRun }),
  );
}

/* -------------------------------------------------------------------------- */
/* Output                                                                      */
/* -------------------------------------------------------------------------- */

export const SECRET_UNAVAILABLE = [
  'Existing webhook reused, but its signing secret cannot be retrieved through the API.',
  'Open Stripe Dashboard → Developers → Webhooks → select the endpoint → reveal Signing secret.',
].join('\n');

const MARKS: Record<string, string> = {
  created: '+',
  updated: '~',
  reused: '=',
  skipped: '·',
};

interface ReportInput {
  options: SetupOptions;
  mode: 'test' | 'live';
  description: string;
  result: ProvisionResult;
  targets: Targets;
  written: WriteResult[];
  planned: readonly PlannedWrite[];
}

function report(input: ReportInput): void {
  const { options, result, targets } = input;
  const out = (line = ''): void => {
    process.stdout.write(`${line}\n`);
  };

  out();
  out(options.dryRun ? 'DRY RUN — nothing was written to Stripe.' : 'Stripe provisioning complete.');
  out(`  mode        ${input.mode}  (${input.description})`);
  out(`  account     ${result.accountId ?? 'not readable with this key'}`);
  out(`  route       ${targets.path}  (discovered from the signature-verifying handler)`);
  out();

  out('Resources');
  for (const change of result.changes) {
    out(`  ${MARKS[change.disposition] ?? '?'} ${change.resource.padEnd(21)} ${change.id ?? '—'}`);
    out(`    ${change.detail}`);
  }
  out();

  out('Price');
  out(
    `  ${((result.price.unit_amount ?? 0) / 100).toFixed(2)} ${result.price.currency.toUpperCase()} ` +
      `every ${result.price.recurring?.interval_count ?? '?'} ${result.price.recurring?.interval ?? '?'} · ` +
      `lookup key ${result.price.lookup_key ?? 'none'} · ${result.price.active ? 'active' : 'ARCHIVED'}`,
  );
  out(`  ${ENV_KEYS.priceId}=${result.price.id}`);
  out();

  if (targets.skippedLocal) {
    out('Local webhooks');
    out(`  ${targets.skippedLocal} is not reachable from Stripe, so no endpoint was registered.`);
    out('  Forward deliveries with the CLI instead — it prints its own signing secret:');
    out('    npm run stripe:listen');
    out(`  That whsec_ is separate from any endpoint secret and belongs in`);
    out(`  ${ENV_KEYS.webhookSecret} of your local env file only.`);
    out();
  }

  for (const webhook of result.webhooks) {
    out(`Webhook · ${webhook.url}`);
    out(`  endpoint    ${webhook.endpoint.id}`);
    out(`  status      ${webhook.endpoint.status}`);
    out(`  events      ${webhook.endpoint.enabled_events.length} enabled`);
    for (const event of REQUIRED_EVENTS) out(`                ${event}`);
    if (webhook.extraEvents.length > 0) {
      out(`  also        ${webhook.extraEvents.join(', ')} (left alone — not ours to remove)`);
    }
    if (webhook.secret) {
      // Printed in full exactly once, only at a terminal, only for an endpoint
      // this run created. There is no code path that prints it a second time,
      // because Stripe never returns it a second time.
      if (process.stdout.isTTY) {
        out();
        out('  SIGNING SECRET — shown once, Stripe will not return it again:');
        out(`    ${ENV_KEYS.webhookSecret}=${webhook.secret}`);
        out();
      } else {
        out(`  secret      ${maskSecret(webhook.secret)} — rerun at a terminal to see it in full`);
      }
    } else if (webhook.disposition === 'created') {
      // Only reachable during a dry run: a real creation always carries the
      // secret. Saying "cannot be retrieved" here would be actively wrong —
      // this endpoint does not exist yet, and creating it will issue one.
      out('  secret      would be issued at creation, and printed here once');
    } else {
      out('  secret      unavailable');
      for (const line of SECRET_UNAVAILABLE.split('\n')) out(`    ${line}`);
    }
    out();
  }

  if (result.portal) {
    out('Customer portal');
    out(`  configuration ${result.portal.configuration.id}`);
    out('  enabled       cancel subscription, update payment method, view invoices');
    out('  disabled      plan switching (one recognised price), customer detail editing');
    if (!result.portal.isDefault) {
      out('  WARNING: this is not the account default configuration, and the application');
      out('  creates portal sessions without naming one, so it will not be used.');
    }
    out();
  }

  if (input.written.length > 0) {
    out('Environment files');
    for (const file of input.written) {
      const touched = [...file.updated, ...file.added];
      out(`  ${file.file}${options.dryRun ? '  (untouched — dry run)' : ''}`);
      out(`    set        ${touched.length > 0 ? touched.join(', ') : 'nothing to change'}`);
      if (file.unchanged.length > 0) out(`    already ok ${file.unchanged.join(', ')}`);
      if (file.backup) out(`    backup     ${file.backup}`);
    }
    out();
  }

  if (options.dryRun) {
    out('Would have written');
    if (input.planned.length === 0) out('  nothing — Stripe already matches');
    for (const write of input.planned) out(`  ${write.operation} — ${write.summary}`);
    out();
  }
}

function jsonSummary(input: ReportInput): unknown {
  const { result } = input;
  return {
    dryRun: input.options.dryRun,
    mode: input.mode,
    account: result.accountId,
    webhookRoute: input.targets.path,
    product: { id: result.product.id, name: result.product.name, active: result.product.active },
    price: {
      id: result.price.id,
      unitAmount: result.price.unit_amount,
      currency: result.price.currency,
      interval: result.price.recurring?.interval ?? null,
      intervalCount: result.price.recurring?.interval_count ?? null,
      lookupKey: result.price.lookup_key,
      active: result.price.active,
    },
    webhooks: result.webhooks.map((webhook) => ({
      id: webhook.endpoint.id,
      url: webhook.url,
      disposition: webhook.disposition,
      enabledEvents: webhook.endpoint.enabled_events,
      // Never the value itself. A JSON summary is the thing most likely to be
      // piped straight into a log aggregator.
      signingSecret: webhook.secret
        ? 'issued — printed once on the terminal, never in JSON'
        : 'unavailable through the API',
    })),
    portal: result.portal
      ? {
          id: result.portal.configuration.id,
          disposition: result.portal.disposition,
          isDefault: result.portal.isDefault,
        }
      : null,
    changes: result.changes,
    envFiles: input.written,
    plannedWrites: input.options.dryRun ? input.planned : [],
  };
}

/* -------------------------------------------------------------------------- */
/* Entry point                                                                 */
/* -------------------------------------------------------------------------- */

export async function main(argv: readonly string[]): Promise<number> {
  const options = parseSetupArgs(argv);
  if (options.help) {
    process.stdout.write(SETUP_USAGE);
    return 0;
  }

  const credential = resolveCredential({
    rawKey: process.env.STRIPE_SECRET_KEY,
    live: options.live,
  });

  const webhookPath = discoverWebhookPath();
  const targets = webhookTargets(options, webhookPath);

  await confirmLiveMode({
    credential,
    intent:
      'About to create or update a product, a $19.00/month price' +
      (targets.urls.length > 0 ? `, ${targets.urls.length} webhook endpoint(s)` : '') +
      (options.configurePortal ? ' and the customer portal configuration' : '') +
      ' in Stripe.',
  });

  const stripe = new Stripe(credential.key, {
    maxNetworkRetries: 2,
    timeout: 20_000,
    telemetry: false,
  });
  const real = gatewayFor(stripe);
  const dry = options.dryRun ? dryRunGateway(real, credential.mode === 'live') : null;

  const result = await provision({
    gateway: dry ?? real,
    mode: credential.mode,
    webhookUrls: targets.urls,
    portalBaseUrl: options.productionBaseUrl ?? options.baseUrl,
    configurePortal: options.configurePortal,
  });

  if (!options.dryRun) assertModeConsistency(result, credential.mode);

  const written = writeEnvFiles(options, credential.mode, credential.key, result, targets.primaryUrl);

  const input: ReportInput = {
    options,
    mode: credential.mode,
    description: credential.description,
    result,
    targets,
    written,
    planned: dry?.planned ?? [],
  };

  if (options.json) process.stdout.write(`${JSON.stringify(jsonSummary(input), null, 2)}\n`);
  else report(input);

  return 0;
}

export function fail(error: unknown): number {
  const write = (line: string): void => {
    process.stderr.write(`${line}\n`);
  };
  if (error instanceof UsageError) {
    write(`\n${error.message}\n`);
    write(SETUP_USAGE);
    return 2;
  }
  if (
    error instanceof GuardError ||
    error instanceof ProvisionError ||
    error instanceof EnvFileError
  ) {
    write(`\n${error.message}\n`);
    write(error.guidance);
    write('');
    return 1;
  }
  if (error instanceof Error) {
    // Stripe's own errors carry a `type` worth surfacing. Neither the message
    // nor the type ever contains the key, which is what matters here.
    const type = (error as { type?: unknown }).type;
    write(
      `\nStripe request failed${typeof type === 'string' ? ` (${type})` : ''}: ${error.message}`,
    );
    write('Nothing further was attempted.\n');
    return 1;
  }
  write(`\nUnexpected failure: ${String(error)}\n`);
  return 1;
}
