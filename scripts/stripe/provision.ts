/**
 * Idempotent provisioning.
 *
 * Written as a pure function of a gateway so that "safe to rerun" is something
 * the test suite can assert rather than something the README claims: the second
 * run over the same fake account must perform no writes and report everything
 * as reused.
 *
 * The governing rule throughout is that ambiguity fails. Where the desired
 * state and the account's actual state cannot both be true — a price on the
 * right lookup key charging the wrong amount, two webhook endpoints on one URL,
 * two products claiming to be this plan — the script stops and says which
 * objects are in conflict. It never picks one, and it never deletes the other.
 */
import {
  PORTAL_CONTRACT,
  PRICE_CONTRACT,
  PRODUCT_METADATA_KEYS,
  REQUIRED_EVENTS,
  productContract,
} from './contract.ts';
import { priceProductId } from './gateway.ts';
import type {
  PortalInput,
  StripeGateway,
  StripePortalConfiguration,
  StripePrice,
  StripeProduct,
  StripeWebhookEndpoint,
} from './gateway.ts';

export type Disposition = 'created' | 'reused' | 'updated' | 'skipped';

export interface Change {
  resource: string;
  disposition: Disposition;
  id: string | null;
  detail: string;
}

/** A failure the operator can act on, as opposed to an unexpected crash. */
export class ProvisionError extends Error {
  readonly guidance: string;
  constructor(message: string, guidance: string) {
    super(message);
    this.name = 'ProvisionError';
    this.guidance = guidance;
  }
}

export interface WebhookOutcome {
  url: string;
  endpoint: StripeWebhookEndpoint;
  disposition: Disposition;
  /** Present only for an endpoint created by this run. Stripe never re-issues it. */
  secret: string | null;
  addedEvents: string[];
  extraEvents: string[];
}

export interface PortalOutcome {
  configuration: StripePortalConfiguration;
  disposition: Disposition;
  /** False means the app's portal sessions will not use this configuration. */
  isDefault: boolean;
  drift: string[];
}

export interface ProvisionResult {
  accountId: string | null;
  mode: 'test' | 'live';
  product: StripeProduct;
  price: StripePrice;
  webhooks: WebhookOutcome[];
  portal: PortalOutcome | null;
  changes: Change[];
}

export interface ProvisionOptions {
  gateway: StripeGateway;
  mode: 'test' | 'live';
  /** Absolute https URLs to register. May be empty for a localhost-only setup. */
  webhookUrls: string[];
  /** Base URL used for the portal's return and policy links. */
  portalBaseUrl: string;
  configurePortal: boolean;
}

export async function provision(options: ProvisionOptions): Promise<ProvisionResult> {
  const { gateway, mode } = options;
  const changes: Change[] = [];
  const record = (
    resource: string,
    disposition: Disposition,
    id: string | null,
    detail: string,
  ): void => {
    changes.push({ resource, disposition, id, detail });
  };

  const accountId = await gateway.accountId();
  const { product, price } = await ensureProductAndPrice(gateway, mode, record);

  const webhooks: WebhookOutcome[] = [];
  for (const url of options.webhookUrls) {
    webhooks.push(await ensureWebhook(gateway, url, record));
  }

  const portal = options.configurePortal
    ? await ensurePortal(gateway, options.portalBaseUrl, record)
    : null;
  if (!options.configurePortal) {
    record('portal configuration', 'skipped', null, 'skipped by --no-portal');
  }

  return { accountId, mode, product, price, webhooks, portal, changes };
}

/* -------------------------------------------------------------------------- */
/* Product and price                                                           */
/* -------------------------------------------------------------------------- */

type Record_ = (
  resource: string,
  disposition: Disposition,
  id: string | null,
  detail: string,
) => void;

/**
 * Describes why a price does not match what this application sells.
 *
 * Returns every mismatch rather than the first, so an operator fixing a
 * hand-made price is told all of it at once.
 */
export function priceMismatches(price: StripePrice, productId?: string): string[] {
  const problems: string[] = [];
  if (!price.active) problems.push('it is archived (active=false)');
  if (price.currency.toLowerCase() !== PRICE_CONTRACT.currency) {
    problems.push(`its currency is ${price.currency.toUpperCase()}, not USD`);
  }
  if (price.unit_amount !== PRICE_CONTRACT.unitAmount) {
    problems.push(
      `its amount is ${price.unit_amount === null ? 'not a fixed unit amount' : price.unit_amount}, not ${PRICE_CONTRACT.unitAmount}`,
    );
  }
  if (price.type !== 'recurring' || price.recurring === null) {
    problems.push('it is a one-off price, not a recurring one');
  } else {
    if (price.recurring.interval !== PRICE_CONTRACT.interval) {
      problems.push(`it renews every ${price.recurring.interval}, not every month`);
    }
    if (price.recurring.interval_count !== PRICE_CONTRACT.intervalCount) {
      problems.push(`its interval count is ${price.recurring.interval_count}, not 1`);
    }
  }
  if (productId !== undefined && priceProductId(price) !== productId) {
    problems.push(`it belongs to product ${priceProductId(price)}, not ${productId}`);
  }
  return problems;
}

function identityOf(product: StripeProduct): string | undefined {
  return product.metadata.application;
}

function isOurProduct(product: StripeProduct): boolean {
  return (
    product.metadata.application === PRODUCT_METADATA_KEYS.application &&
    product.metadata.plan === PRODUCT_METADATA_KEYS.plan
  );
}

async function ensureProductAndPrice(
  gateway: StripeGateway,
  mode: 'test' | 'live',
  record: Record_,
): Promise<{ product: StripeProduct; price: StripePrice }> {
  const wanted = productContract(mode);

  // The lookup key is the strongest identity available and is exactly
  // consistent, so it is consulted first.
  const byLookup = await gateway.listPricesByLookupKey(PRICE_CONTRACT.lookupKey);
  if (byLookup.length > 1) {
    throw new ProvisionError(
      `${byLookup.length} prices claim the lookup key "${PRICE_CONTRACT.lookupKey}" ` +
        `(${byLookup.map((price) => price.id).join(', ')}).`,
      'Stripe allows one active price per lookup key, so this account is in a state ' +
        'this script did not create. Archive the prices you do not want in the ' +
        'dashboard, then run this again.',
    );
  }

  const existingPrice = byLookup[0];
  if (existingPrice) {
    const problems = priceMismatches(existingPrice);
    if (problems.length > 0) {
      throw new ProvisionError(
        `Price ${existingPrice.id} already holds the lookup key "${PRICE_CONTRACT.lookupKey}" ` +
          `but does not match what this application sells: ${problems.join('; ')}.`,
        'A price\'s amount, currency and interval are immutable in Stripe, so this ' +
          'cannot be corrected in place and will not be reused. Archive that price in ' +
          'the dashboard (Products → the price → Archive) and run this again, or point ' +
          'this script at a different lookup key.',
      );
    }

    const product = await adoptProductFor(gateway, existingPrice, wanted, record);
    record('price', 'reused', existingPrice.id, `matched on lookup key ${PRICE_CONTRACT.lookupKey}`);
    return { product, price: existingPrice };
  }

  const product = await ensureProduct(gateway, wanted, record);

  // Before creating anything, check whether the product already carries a price
  // with identical terms that simply never had the lookup key attached — the
  // shape left behind by creating the product by hand in the dashboard.
  const candidates = (await gateway.listPricesForProduct(product.id)).filter(
    (price) => priceMismatches(price, product.id).length === 0,
  );
  if (candidates.length > 1) {
    throw new ProvisionError(
      `Product ${product.id} has ${candidates.length} active $19.00/month USD prices ` +
        `(${candidates.map((price) => price.id).join(', ')}).`,
      'This script will not choose which one your customers should be charged against. ' +
        'Archive the duplicates in the dashboard, then run this again.',
    );
  }

  const adoptable = candidates[0];
  if (adoptable) {
    const updated = await gateway.attachPriceLookupKey(adoptable, PRICE_CONTRACT.lookupKey);
    record(
      'price',
      'updated',
      updated.id,
      `adopted an existing matching price and attached lookup key ${PRICE_CONTRACT.lookupKey}`,
    );
    return { product, price: updated };
  }

  const created = await gateway.createPrice({
    product: product.id,
    currency: PRICE_CONTRACT.currency,
    unitAmount: PRICE_CONTRACT.unitAmount,
    interval: PRICE_CONTRACT.interval,
    intervalCount: PRICE_CONTRACT.intervalCount,
    lookupKey: PRICE_CONTRACT.lookupKey,
    metadata: wanted.metadata,
  });
  const problems = priceMismatches(created, product.id);
  if (problems.length > 0) {
    throw new ProvisionError(
      `Stripe created price ${created.id} but it does not match what was asked for: ${problems.join('; ')}.`,
      'This should not happen. Archive that price and report it before relying on the account.',
    );
  }
  record('price', 'created', created.id, '$19.00 USD every 1 month');
  return { product, price: created };
}

/**
 * Resolves the product an existing price belongs to, and reconciles its
 * identity metadata.
 *
 * A product that already declares a *different* application is a conflict, not
 * something to overwrite. A product that declares nothing is adopted, because
 * that is what a product created by hand in the dashboard looks like and
 * refusing it would leave the operator with no way forward but deletion.
 */
async function adoptProductFor(
  gateway: StripeGateway,
  price: StripePrice,
  wanted: ReturnType<typeof productContract>,
  record: Record_,
): Promise<StripeProduct> {
  const productId = priceProductId(price);
  const product = await gateway.retrieveProduct(productId);
  if (!product) {
    throw new ProvisionError(
      `Price ${price.id} points at product ${productId}, which Stripe will not return.`,
      'Check that the API key has products read access, then run this again.',
    );
  }
  if (!product.active) {
    throw new ProvisionError(
      `Price ${price.id} belongs to archived product ${product.id}.`,
      'Unarchive the product in the dashboard, or archive the price so a fresh ' +
        'product and price can be created, then run this again.',
    );
  }

  const claimed = identityOf(product);
  if (claimed !== undefined && !isOurProduct(product)) {
    throw new ProvisionError(
      `Product ${product.id} is tagged application="${claimed}", plan="${product.metadata.plan ?? ''}", ` +
        'so it belongs to a different application.',
      `Either free the lookup key "${PRICE_CONTRACT.lookupKey}" by archiving that price, ` +
        'or run this script against a Stripe account that is not shared with that application.',
    );
  }

  return reconcileProduct(gateway, product, wanted, record, claimed === undefined);
}

async function ensureProduct(
  gateway: StripeGateway,
  wanted: ReturnType<typeof productContract>,
  record: Record_,
): Promise<StripeProduct> {
  const matches = (await gateway.listProducts()).filter(
    (product) => product.active && isOurProduct(product),
  );

  if (matches.length > 1) {
    throw new ProvisionError(
      `${matches.length} active products are tagged as this application's Pro plan ` +
        `(${matches.map((product) => product.id).join(', ')}).`,
      'Archive the ones you do not want in the dashboard, then run this again. ' +
        'This script will not guess which product your customers should be billed for.',
    );
  }

  const found = matches[0];
  if (found) return reconcileProduct(gateway, found, wanted, record, false);

  const created = await gateway.createProduct(wanted);
  record('product', 'created', created.id, wanted.name);
  return created;
}

/** Brings a product's display copy and metadata back in line, or reports it unchanged. */
async function reconcileProduct(
  gateway: StripeGateway,
  product: StripeProduct,
  wanted: ReturnType<typeof productContract>,
  record: Record_,
  adopting: boolean,
): Promise<StripeProduct> {
  const drift: string[] = [];
  if (product.name !== wanted.name) drift.push('name');
  if (product.description !== wanted.description) drift.push('description');
  for (const [key, value] of Object.entries(wanted.metadata)) {
    if (product.metadata[key] !== value) drift.push(`metadata.${key}`);
  }

  if (drift.length === 0) {
    record('product', 'reused', product.id, `already matches (${product.name})`);
    return product;
  }

  const updated = await gateway.updateProduct(product.id, {
    name: wanted.name,
    description: wanted.description,
    // Merged, not replaced: metadata this script does not own stays put.
    metadata: { ...product.metadata, ...wanted.metadata },
  });
  record(
    'product',
    'updated',
    updated.id,
    `${adopting ? 'adopted an untagged product; ' : ''}brought ${drift.join(', ')} into line`,
  );
  return updated;
}

/* -------------------------------------------------------------------------- */
/* Webhook endpoint                                                            */
/* -------------------------------------------------------------------------- */

const WEBHOOK_DESCRIPTION = 'MCP Upgrade — subscription state (managed by scripts/setup-stripe.ts)';

/**
 * Compares endpoint URLs the way Stripe does for practical purposes: the exact
 * string, but tolerant of one trailing slash, because `/api/stripe/webhook` and
 * `/api/stripe/webhook/` reach the same Next.js route and registering both
 * would split deliveries across two signing secrets.
 */
export function sameEndpointUrl(a: string, b: string): boolean {
  const normalise = (url: string): string => url.replace(/\/+$/, '');
  return normalise(a) === normalise(b);
}

async function ensureWebhook(
  gateway: StripeGateway,
  url: string,
  record: Record_,
): Promise<WebhookOutcome> {
  const all = await gateway.listWebhookEndpoints();
  const matching = all.filter((endpoint) => sameEndpointUrl(endpoint.url, url));

  if (matching.length > 1) {
    throw new ProvisionError(
      `${matching.length} webhook endpoints already point at ${url} ` +
        `(${matching.map((endpoint) => endpoint.id).join(', ')}).`,
      'The application holds one signing secret, so deliveries from the other endpoint ' +
        'would fail signature verification and be rejected as forgeries. Delete the ' +
        'duplicates in the dashboard (Developers → Webhooks), then run this again. ' +
        'This script does not delete Stripe resources.',
    );
  }

  const existing = matching[0];

  if (!existing) {
    const created = await gateway.createWebhookEndpoint({
      url,
      enabledEvents: [...REQUIRED_EVENTS],
      description: WEBHOOK_DESCRIPTION,
      metadata: { ...PRODUCT_METADATA_KEYS },
    });
    // A real creation always carries the secret; a simulated one never can, and
    // must not invent something that looks like a credential to paste.
    if (!created.secret && !gateway.dryRun) {
      throw new ProvisionError(
        `Stripe created webhook endpoint ${created.id} but returned no signing secret.`,
        'The secret is only ever returned at creation. Read it from the dashboard: ' +
          'Developers → Webhooks → select the endpoint → reveal Signing secret.',
      );
    }
    record('webhook endpoint', 'created', created.id, `${url} · ${REQUIRED_EVENTS.length} events`);
    return {
      url,
      endpoint: created,
      disposition: 'created',
      secret: created.secret ?? null,
      addedEvents: [...REQUIRED_EVENTS],
      extraEvents: [],
    };
  }

  const enabled = new Set(existing.enabled_events);
  // A wildcard subscription genuinely covers everything, so it is not a gap.
  const wildcard = enabled.has('*');
  const missing = wildcard ? [] : REQUIRED_EVENTS.filter((event) => !enabled.has(event));
  const extra = existing.enabled_events.filter(
    (event) => event !== '*' && !REQUIRED_EVENTS.includes(event),
  );

  if (missing.length === 0) {
    record(
      'webhook endpoint',
      'reused',
      existing.id,
      `${url} · already subscribed to every required event`,
    );
    return {
      url,
      endpoint: existing,
      disposition: 'reused',
      secret: null,
      addedEvents: [],
      extraEvents: extra,
    };
  }

  // The union, not the required set: an event somebody else added deliberately
  // is not this script's to remove, and removing it could break another
  // consumer of the same endpoint.
  const union = [...new Set([...existing.enabled_events, ...REQUIRED_EVENTS])].sort();
  const updated = await gateway.updateWebhookEndpoint(existing.id, {
    enabledEvents: union,
    description: existing.description ?? WEBHOOK_DESCRIPTION,
  });
  record(
    'webhook endpoint',
    'updated',
    updated.id,
    `${url} · added ${missing.join(', ')}`,
  );
  return {
    url,
    endpoint: updated,
    disposition: 'updated',
    secret: null,
    addedEvents: missing,
    extraEvents: extra,
  };
}

/* -------------------------------------------------------------------------- */
/* Customer portal                                                             */
/* -------------------------------------------------------------------------- */

export function portalInputFor(baseUrl: string): PortalInput {
  const at = (suffix: string): string => new URL(suffix, baseUrl).toString();
  return {
    businessProfile: {
      privacy_policy_url: at(PORTAL_CONTRACT.privacyPath),
      terms_of_service_url: at(PORTAL_CONTRACT.termsPath),
    },
    defaultReturnUrl: at(PORTAL_CONTRACT.returnPath),
    features: {
      invoice_history: { enabled: PORTAL_CONTRACT.invoiceHistory },
      payment_method_update: { enabled: PORTAL_CONTRACT.paymentMethodUpdate },
      subscription_cancel: { enabled: PORTAL_CONTRACT.subscriptionCancel },
      subscription_update: { enabled: PORTAL_CONTRACT.subscriptionUpdate },
      customer_update: { enabled: PORTAL_CONTRACT.customerUpdate },
    },
    metadata: { ...PRODUCT_METADATA_KEYS },
  };
}

/** Which parts of a live configuration disagree with the contract. */
export function portalDrift(
  configuration: StripePortalConfiguration,
  wanted: PortalInput,
): string[] {
  const drift: string[] = [];
  const features = configuration.features;

  const flags: [keyof PortalInput['features'], boolean | undefined][] = [
    ['invoice_history', features.invoice_history?.enabled],
    ['payment_method_update', features.payment_method_update?.enabled],
    ['subscription_cancel', features.subscription_cancel?.enabled],
    ['subscription_update', features.subscription_update?.enabled],
    ['customer_update', features.customer_update?.enabled],
  ];
  for (const [name, actual] of flags) {
    const expected = wanted.features[name].enabled;
    if (actual !== expected) drift.push(`${name} should be ${expected ? 'on' : 'off'}`);
  }

  if (
    wanted.features.subscription_cancel.enabled &&
    features.subscription_cancel?.mode !== undefined &&
    features.subscription_cancel.mode !== 'at_period_end'
  ) {
    drift.push('subscription_cancel should take effect at period end');
  }
  if (configuration.default_return_url !== wanted.defaultReturnUrl) drift.push('default return URL');
  if (configuration.business_profile?.privacy_policy_url !== wanted.businessProfile.privacy_policy_url) {
    drift.push('privacy policy URL');
  }
  if (
    configuration.business_profile?.terms_of_service_url !==
    wanted.businessProfile.terms_of_service_url
  ) {
    drift.push('terms of service URL');
  }
  return drift;
}

/**
 * Brings the account's *default* portal configuration in line.
 *
 * The portal route creates sessions without naming a configuration, so Stripe
 * uses the default one. Creating a second, correct configuration and leaving
 * the default untouched would provision something the application never reaches
 * — which is worse than doing nothing, because it looks like success.
 */
async function ensurePortal(
  gateway: StripeGateway,
  baseUrl: string,
  record: Record_,
): Promise<PortalOutcome> {
  const wanted = portalInputFor(baseUrl);
  const configurations = await gateway.listPortalConfigurations();
  const current = configurations.find((configuration) => configuration.is_default) ?? null;

  if (!current) {
    const created = await gateway.createPortalConfiguration(wanted);
    record(
      'portal configuration',
      'created',
      created.id,
      created.is_default
        ? 'created as the account default'
        : 'created, but NOT the account default — the application will not use it',
    );
    return {
      configuration: created,
      disposition: 'created',
      isDefault: created.is_default,
      drift: [],
    };
  }

  const drift = portalDrift(current, wanted);
  if (drift.length === 0) {
    record('portal configuration', 'reused', current.id, 'default configuration already matches');
    return { configuration: current, disposition: 'reused', isDefault: true, drift: [] };
  }

  const updated = await gateway.updatePortalConfiguration(current.id, wanted);
  record('portal configuration', 'updated', updated.id, `changed: ${drift.join(', ')}`);
  return { configuration: updated, disposition: 'updated', isDefault: true, drift };
}
