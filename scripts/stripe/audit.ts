/**
 * Read-only verification.
 *
 * Every call this module can make through the gateway is a list or a retrieve.
 * There is no code path to a create or an update — not guarded by a flag, not
 * behind a confirmation, simply absent — which is the property that makes it
 * safe to run against any account at any time, including production.
 *
 * A check reports `warn` when something is true but ambiguous (a webhook
 * carrying extra events, a portal configuration that is not the account
 * default), and `fail` only when the application would actually misbehave.
 * Warnings do not change the exit code; failures do.
 */
import { PRICE_CONTRACT, PRODUCT_METADATA_KEYS, REQUIRED_EVENTS } from './contract.ts';
import { priceProductId } from './gateway.ts';
import type { ProbeResource, StripeGateway, StripePrice } from './gateway.ts';
import { portalDrift, portalInputFor, priceMismatches, sameEndpointUrl } from './provision.ts';

export type CheckStatus = 'pass' | 'fail' | 'warn' | 'skip';

export interface Check {
  name: string;
  status: CheckStatus;
  detail: string;
}

export interface AuditOptions {
  gateway: StripeGateway;
  mode: 'test' | 'live';
  /** Endpoints that must exist. Empty when only a local origin was given. */
  webhookUrls: string[];
  configuredPortal: boolean;
  portalBaseUrl: string;
  /** `STRIPE_PRO_MONTHLY_PRICE_ID` as the application would read it. */
  envPriceId: string | null;
  /** Where that value came from, for the message. */
  envSource: string;
}

export interface AuditReport {
  checks: Check[];
  ok: boolean;
  accountId: string | null;
  priceId: string | null;
}

export async function audit(options: AuditOptions): Promise<AuditReport> {
  const checks: Check[] = [];
  const add = (name: string, status: CheckStatus, detail: string): void => {
    checks.push({ name, status, detail });
  };

  const accountId = await options.gateway.accountId();

  add(
    'credential mode',
    options.mode === 'test' ? 'pass' : 'warn',
    options.mode === 'test'
      ? 'test-mode credential'
      : 'LIVE-mode credential — the hosted application refuses to start with one',
  );

  const price = await auditPriceAndProduct(options, add);
  await auditWebhooks(options, add);
  await auditPortal(options, add);
  auditEnvPriceId(options, price, add);
  await auditPermissions(options, add);

  return {
    checks,
    ok: checks.every((check) => check.status !== 'fail'),
    accountId,
    priceId: price?.id ?? null,
  };
}

/* -------------------------------------------------------------------------- */

type Add = (name: string, status: CheckStatus, detail: string) => void;

async function auditPriceAndProduct(
  options: AuditOptions,
  add: Add,
): Promise<StripePrice | null> {
  const matches = await options.gateway.listPricesByLookupKey(PRICE_CONTRACT.lookupKey);

  if (matches.length === 0) {
    add(
      'price exists',
      'fail',
      `no price holds the lookup key "${PRICE_CONTRACT.lookupKey}" — run npm run stripe:setup`,
    );
    add('product exists', 'skip', 'not checked: no price to resolve it from');
    return null;
  }
  if (matches.length > 1) {
    add(
      'price exists',
      'fail',
      `${matches.length} prices claim the lookup key "${PRICE_CONTRACT.lookupKey}"`,
    );
    return null;
  }

  const price = matches[0]!;
  add('price exists', 'pass', price.id);

  const problems = priceMismatches(price);
  add(
    'price terms',
    problems.length === 0 ? 'pass' : 'fail',
    problems.length === 0
      ? `${((price.unit_amount ?? 0) / 100).toFixed(2)} ${price.currency.toUpperCase()} every ` +
          `${price.recurring?.interval_count} ${price.recurring?.interval}, active`
      : problems.join('; '),
  );

  // Deliberately checked against the key's own mode rather than assumed: a
  // test-mode key cannot return a live object, so a mismatch here would mean
  // the mode detection itself is wrong.
  add(
    'price mode',
    price.livemode === (options.mode === 'live') ? 'pass' : 'fail',
    price.livemode ? 'live-mode object' : 'test-mode object',
  );

  const productId = priceProductId(price);
  const product = await options.gateway.retrieveProduct(productId);
  if (!product) {
    add('product exists', 'fail', `price points at ${productId}, which could not be read`);
    return price;
  }

  add('product exists', product.active ? 'pass' : 'fail', `${product.id} (${product.name})`);
  const tagged =
    product.metadata.application === PRODUCT_METADATA_KEYS.application &&
    product.metadata.plan === PRODUCT_METADATA_KEYS.plan;
  add(
    'product identity',
    tagged ? 'pass' : 'warn',
    tagged
      ? `application=${PRODUCT_METADATA_KEYS.application}, plan=${PRODUCT_METADATA_KEYS.plan}`
      : 'the product carries no identifying metadata, so a rerun cannot recognise it by anything but the lookup key',
  );
  return price;
}

async function auditWebhooks(options: AuditOptions, add: Add): Promise<void> {
  if (options.webhookUrls.length === 0) {
    add(
      'webhook endpoint',
      'skip',
      'no public base URL given — a local setup uses `stripe listen`, which registers no endpoint',
    );
    return;
  }

  let endpoints;
  try {
    endpoints = await options.gateway.listWebhookEndpoints();
  } catch (error) {
    add(
      'webhook endpoint',
      'fail',
      `could not list webhook endpoints: ${error instanceof Error ? error.message : String(error)}`,
    );
    return;
  }

  for (const url of options.webhookUrls) {
    const matching = endpoints.filter((endpoint) => sameEndpointUrl(endpoint.url, url));

    if (matching.length === 0) {
      add(`webhook ${url}`, 'fail', 'no endpoint registered for this URL');
      continue;
    }
    if (matching.length > 1) {
      add(
        `webhook ${url}`,
        'fail',
        `${matching.length} endpoints share this URL; the application holds one signing secret, ` +
          'so deliveries from the others are rejected as forgeries',
      );
      continue;
    }

    const endpoint = matching[0]!;
    add(`webhook ${url}`, 'pass', `${endpoint.id} · url matches exactly`);

    add(
      `webhook ${url} status`,
      endpoint.status === 'enabled' ? 'pass' : 'fail',
      endpoint.status,
    );

    const enabled = new Set(endpoint.enabled_events);
    const missing = enabled.has('*')
      ? []
      : REQUIRED_EVENTS.filter((event) => !enabled.has(event));
    add(
      `webhook ${url} events`,
      missing.length === 0 ? 'pass' : 'fail',
      missing.length === 0
        ? `all ${REQUIRED_EVENTS.length} required events enabled`
        : `missing ${missing.join(', ')}`,
    );

    const extra = endpoint.enabled_events.filter(
      (event) => event !== '*' && !REQUIRED_EVENTS.includes(event),
    );
    if (extra.length > 0) {
      add(
        `webhook ${url} extra events`,
        'warn',
        `${extra.join(', ')} — delivered, acknowledged and ignored by the handler`,
      );
    }

    add(
      `webhook ${url} mode`,
      endpoint.livemode === (options.mode === 'live') ? 'pass' : 'fail',
      endpoint.livemode ? 'live-mode endpoint' : 'test-mode endpoint',
    );
  }
}

async function auditPortal(options: AuditOptions, add: Add): Promise<void> {
  if (!options.configuredPortal) {
    add('customer portal', 'skip', 'not checked');
    return;
  }

  let configurations;
  try {
    configurations = await options.gateway.listPortalConfigurations();
  } catch (error) {
    add(
      'customer portal',
      'fail',
      `could not list portal configurations: ${error instanceof Error ? error.message : String(error)}`,
    );
    return;
  }

  const current = configurations.find((configuration) => configuration.is_default);
  if (!current) {
    add(
      'customer portal',
      'fail',
      'no default configuration exists, and the portal route creates sessions without naming one',
    );
    return;
  }

  add('customer portal', 'pass', `${current.id} (account default)`);
  const drift = portalDrift(current, portalInputFor(options.portalBaseUrl));
  add(
    'portal capabilities',
    drift.length === 0 ? 'pass' : 'warn',
    drift.length === 0
      ? 'cancel, payment method and invoices on; plan switching and customer editing off'
      : `differs from the contract: ${drift.join(', ')}`,
  );
}

function auditEnvPriceId(options: AuditOptions, price: StripePrice | null, add: Add): void {
  if (!options.envPriceId) {
    add(
      'configured price id',
      'warn',
      `STRIPE_PRO_MONTHLY_PRICE_ID is not set in ${options.envSource}; ` +
        'the application will run Free-plan-only',
    );
    return;
  }
  if (!price) {
    add('configured price id', 'fail', 'set, but no matching price exists in Stripe');
    return;
  }
  add(
    'configured price id',
    options.envPriceId === price.id ? 'pass' : 'fail',
    options.envPriceId === price.id
      ? `${options.envSource} matches Stripe`
      : `${options.envSource} says ${options.envPriceId}, Stripe says ${price.id} — ` +
          'every subscription on the other price resolves to Free',
  );
}

/**
 * What this credential can actually read.
 *
 * Reads only. A write permission cannot be probed without creating an object,
 * and creating a customer or a checkout session to find out is not something a
 * verification command should do; that half is reported as untested rather than
 * guessed at.
 */
async function auditPermissions(options: AuditOptions, add: Add): Promise<void> {
  const resources: ProbeResource[] = ['products', 'prices', 'subscriptions', 'customers'];
  const results = await Promise.all(
    resources.map(async (resource) => [resource, await options.gateway.probeRead(resource)] as const),
  );

  for (const [resource, result] of results) {
    // Only subscriptions read is required at runtime; the other three are
    // needed by this script and by setup, not by the application.
    const required = resource === 'subscriptions';
    add(
      `read ${resource}`,
      result === 'ok' ? 'pass' : required ? 'fail' : 'warn',
      result === 'ok'
        ? 'permitted'
        : result === 'forbidden'
          ? `this key has no ${resource} read permission${required ? ' — the webhook handler needs it to re-read a subscription' : ''}`
          : `probe failed`,
    );
  }

  add(
    'write permissions',
    'skip',
    'customers write, checkout session write and billing portal session write cannot be ' +
      'probed without creating objects; exercise a real checkout instead',
  );
}
