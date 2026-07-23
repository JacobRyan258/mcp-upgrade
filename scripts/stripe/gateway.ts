/**
 * A narrow, validated door onto the Stripe API.
 *
 * The provisioning logic talks to this interface and never to the SDK. Two
 * things follow from that, and both are the point:
 *
 *   Every object Stripe returns is parsed before it is believed. A price whose
 *   `recurring` block is missing, or whose `unit_amount` came back null because
 *   it is a tiered price, is rejected here rather than being compared field by
 *   field against `undefined` somewhere downstream and quietly matching.
 *
 *   The dry-run mode and the whole test suite are implementations of this
 *   interface rather than mocks of an HTTP client, so "dry run creates nothing"
 *   is a structural property rather than a discipline.
 */
import type Stripe from 'stripe';
import { z } from 'zod';

/* -------------------------------------------------------------------------- */
/* Validated shapes                                                            */
/* -------------------------------------------------------------------------- */

const metadataSchema = z.record(z.string(), z.string()).default({});

export const productSchema = z.object({
  id: z.string().min(1),
  object: z.literal('product').optional(),
  name: z.string(),
  description: z.string().nullable().default(null),
  active: z.boolean(),
  livemode: z.boolean(),
  metadata: metadataSchema,
});

export const priceSchema = z.object({
  id: z.string().min(1),
  object: z.literal('price').optional(),
  active: z.boolean(),
  currency: z.string(),
  livemode: z.boolean(),
  lookup_key: z.string().nullable().default(null),
  type: z.string(),
  unit_amount: z.number().int().nullable().default(null),
  // Expanded or not, we only ever need the id.
  product: z.union([z.string(), z.object({ id: z.string() })]),
  recurring: z
    .object({
      interval: z.string(),
      interval_count: z.number().int(),
    })
    .nullable()
    .default(null),
  metadata: metadataSchema,
});

export const webhookEndpointSchema = z.object({
  id: z.string().min(1),
  object: z.literal('webhook_endpoint').optional(),
  url: z.string(),
  status: z.string(),
  livemode: z.boolean(),
  enabled_events: z.array(z.string()),
  description: z.string().nullable().default(null),
  metadata: metadataSchema,
  // Returned by Stripe on creation only. Never present on a list or retrieve.
  secret: z.string().optional(),
});

export const portalConfigurationSchema = z.object({
  id: z.string().min(1),
  object: z.literal('billing_portal.configuration').optional(),
  active: z.boolean(),
  is_default: z.boolean(),
  livemode: z.boolean(),
  metadata: metadataSchema,
  default_return_url: z.string().nullable().default(null),
  business_profile: z
    .object({
      privacy_policy_url: z.string().nullable().default(null),
      terms_of_service_url: z.string().nullable().default(null),
    })
    .partial()
    .nullable()
    .default(null),
  features: z.object({
    customer_update: z.object({ enabled: z.boolean() }).partial().loose().optional(),
    invoice_history: z.object({ enabled: z.boolean() }).partial().loose().optional(),
    payment_method_update: z.object({ enabled: z.boolean() }).partial().loose().optional(),
    subscription_cancel: z
      .object({ enabled: z.boolean(), mode: z.string() })
      .partial()
      .loose()
      .optional(),
    subscription_update: z.object({ enabled: z.boolean() }).partial().loose().optional(),
  }),
});

export type StripeProduct = z.infer<typeof productSchema>;
export type StripePrice = z.infer<typeof priceSchema>;
export type StripeWebhookEndpoint = z.infer<typeof webhookEndpointSchema>;
export type StripePortalConfiguration = z.infer<typeof portalConfigurationSchema>;

/** The product id a price points at, whether or not Stripe expanded it. */
export function priceProductId(price: StripePrice): string {
  return typeof price.product === 'string' ? price.product : price.product.id;
}

function parse<T>(schema: z.ZodType<T>, value: unknown, what: string): T {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  const detail = result.error.issues
    .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
    .join('; ');
  throw new Error(`Stripe returned a ${what} this script does not understand — ${detail}`);
}

/* -------------------------------------------------------------------------- */
/* Inputs                                                                      */
/* -------------------------------------------------------------------------- */

export interface ProductInput {
  name: string;
  description: string;
  metadata: Record<string, string>;
}

export interface PriceInput {
  product: string;
  currency: string;
  unitAmount: number;
  interval: 'month';
  intervalCount: number;
  lookupKey: string;
  metadata: Record<string, string>;
}

export interface WebhookInput {
  url: string;
  enabledEvents: string[];
  description: string;
  metadata: Record<string, string>;
}

export interface PortalInput {
  businessProfile: {
    privacy_policy_url: string;
    terms_of_service_url: string;
  };
  defaultReturnUrl: string;
  features: {
    invoice_history: { enabled: boolean };
    payment_method_update: { enabled: boolean };
    subscription_cancel: { enabled: boolean };
    subscription_update: { enabled: boolean };
    customer_update: { enabled: boolean };
  };
  metadata: Record<string, string>;
}

/* -------------------------------------------------------------------------- */
/* The interface                                                               */
/* -------------------------------------------------------------------------- */

export interface StripeGateway {
  /**
   * True when writes are simulated.
   *
   * The provisioning logic asserts on what Stripe returns — that a freshly
   * created endpoint carries a signing secret, for instance. A simulated write
   * cannot satisfy those assertions and must not pretend to, so the few places
   * that check a *creation result* consult this rather than being handed a
   * fabricated secret.
   */
  readonly dryRun: boolean;

  /** Best effort. Restricted keys may not carry account read access. */
  accountId(): Promise<string | null>;

  listProducts(): Promise<StripeProduct[]>;
  createProduct(input: ProductInput): Promise<StripeProduct>;
  updateProduct(id: string, input: Partial<ProductInput>): Promise<StripeProduct>;
  retrieveProduct(id: string): Promise<StripeProduct | null>;

  listPricesByLookupKey(lookupKey: string): Promise<StripePrice[]>;
  listPricesForProduct(productId: string): Promise<StripePrice[]>;
  createPrice(input: PriceInput): Promise<StripePrice>;
  /**
   * Only ever used to attach a lookup key to an already-matching price. A
   * price's billing terms — amount, currency, interval — are immutable in
   * Stripe and are never sent here.
   *
   * Takes the whole price rather than an id so a dry run can describe the
   * result without having to go and find it again.
   */
  attachPriceLookupKey(price: StripePrice, lookupKey: string): Promise<StripePrice>;

  listWebhookEndpoints(): Promise<StripeWebhookEndpoint[]>;
  createWebhookEndpoint(input: WebhookInput): Promise<StripeWebhookEndpoint>;
  updateWebhookEndpoint(
    id: string,
    input: { enabledEvents: string[]; description: string },
  ): Promise<StripeWebhookEndpoint>;

  listPortalConfigurations(): Promise<StripePortalConfiguration[]>;
  createPortalConfiguration(input: PortalInput): Promise<StripePortalConfiguration>;
  updatePortalConfiguration(id: string, input: PortalInput): Promise<StripePortalConfiguration>;

  /**
   * A harmless read against a resource, used by the verification script to
   * report which permissions a restricted key actually carries. Never writes.
   */
  probeRead(resource: ProbeResource): Promise<ProbeResult>;
}

export type ProbeResource = 'products' | 'prices' | 'customers' | 'subscriptions' | 'webhooks';

export type ProbeResult = 'ok' | 'forbidden' | 'failed';

/* -------------------------------------------------------------------------- */
/* The real implementation                                                     */
/* -------------------------------------------------------------------------- */

/**
 * How many objects a single listing will walk before giving up.
 *
 * Bounded so a pathological account cannot turn `--dry-run` into thousands of
 * API calls. The caller is told when the bound was reached — an unreported
 * truncation would read as "there is no matching product" and cheerfully
 * create a duplicate.
 */
export const LIST_CEILING = 500;

export class ListTruncatedError extends Error {
  constructor(what: string) {
    super(
      `More than ${LIST_CEILING} ${what} exist in this Stripe account. ` +
        'Refusing to continue: this script cannot prove no matching object exists ' +
        'beyond the page it read, and guessing would create a duplicate.',
    );
    this.name = 'ListTruncatedError';
  }
}

async function collect<T>(
  list: { autoPagingToArray(options: { limit: number }): Promise<T[]> },
  what: string,
): Promise<T[]> {
  const items = await list.autoPagingToArray({ limit: LIST_CEILING });
  if (items.length >= LIST_CEILING) throw new ListTruncatedError(what);
  return items;
}

export function gatewayFor(stripe: Stripe): StripeGateway {
  return {
    dryRun: false,

    async accountId() {
      try {
        const account = await stripe.accounts.retrieveCurrent();
        return typeof account.id === 'string' ? account.id : null;
      } catch {
        // A restricted key without account read is expected, not an error.
        return null;
      }
    },

    async listProducts() {
      const raw = await collect(stripe.products.list({ limit: 100 }), 'products');
      return raw.map((item) => parse(productSchema, item, 'product'));
    },

    async createProduct(input) {
      const created = await stripe.products.create({
        name: input.name,
        description: input.description,
        metadata: input.metadata,
      });
      return parse(productSchema, created, 'product');
    },

    async updateProduct(id, input) {
      const updated = await stripe.products.update(id, {
        ...(input.name === undefined ? {} : { name: input.name }),
        ...(input.description === undefined ? {} : { description: input.description }),
        ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
      });
      return parse(productSchema, updated, 'product');
    },

    async retrieveProduct(id) {
      try {
        return parse(productSchema, await stripe.products.retrieve(id), 'product');
      } catch (error) {
        if (isMissing(error)) return null;
        throw error;
      }
    },

    async listPricesByLookupKey(lookupKey) {
      // An exact lookup, immediately consistent — unlike the Search API, which
      // is index-backed and can miss a price created seconds earlier. That
      // difference is the whole idempotency story for a rerun.
      const raw = await collect(
        stripe.prices.list({ lookup_keys: [lookupKey], limit: 100 }),
        'prices',
      );
      return raw.map((item) => parse(priceSchema, item, 'price'));
    },

    async listPricesForProduct(productId) {
      const raw = await collect(stripe.prices.list({ product: productId, limit: 100 }), 'prices');
      return raw.map((item) => parse(priceSchema, item, 'price'));
    },

    async createPrice(input) {
      const created = await stripe.prices.create({
        product: input.product,
        currency: input.currency,
        unit_amount: input.unitAmount,
        recurring: { interval: input.interval, interval_count: input.intervalCount },
        lookup_key: input.lookupKey,
        metadata: input.metadata,
      });
      return parse(priceSchema, created, 'price');
    },

    async attachPriceLookupKey(price, lookupKey) {
      const updated = await stripe.prices.update(price.id, {
        lookup_key: lookupKey,
        // Takes the key off whatever price currently holds it. Without this the
        // call fails whenever a stale price still owns the key, which is the
        // one case where taking it is exactly what is wanted.
        transfer_lookup_key: true,
      });
      return parse(priceSchema, updated, 'price');
    },

    async listWebhookEndpoints() {
      const raw = await collect(stripe.webhookEndpoints.list({ limit: 100 }), 'webhook endpoints');
      return raw.map((item) => parse(webhookEndpointSchema, item, 'webhook endpoint'));
    },

    async createWebhookEndpoint(input) {
      const created = await stripe.webhookEndpoints.create({
        url: input.url,
        enabled_events: input.enabledEvents as Stripe.WebhookEndpointCreateParams.EnabledEvent[],
        description: input.description,
        metadata: input.metadata,
      });
      return parse(webhookEndpointSchema, created, 'webhook endpoint');
    },

    async updateWebhookEndpoint(id, input) {
      const updated = await stripe.webhookEndpoints.update(id, {
        enabled_events: input.enabledEvents as Stripe.WebhookEndpointUpdateParams.EnabledEvent[],
        description: input.description,
      });
      return parse(webhookEndpointSchema, updated, 'webhook endpoint');
    },

    async listPortalConfigurations() {
      const raw = await collect(
        stripe.billingPortal.configurations.list({ limit: 100 }),
        'portal configurations',
      );
      return raw.map((item) => parse(portalConfigurationSchema, item, 'portal configuration'));
    },

    async createPortalConfiguration(input) {
      const created = await stripe.billingPortal.configurations.create({
        business_profile: input.businessProfile,
        default_return_url: input.defaultReturnUrl,
        features: portalFeatures(input),
        metadata: input.metadata,
      });
      return parse(portalConfigurationSchema, created, 'portal configuration');
    },

    async updatePortalConfiguration(id, input) {
      const updated = await stripe.billingPortal.configurations.update(id, {
        business_profile: input.businessProfile,
        default_return_url: input.defaultReturnUrl,
        features: portalFeatures(input),
        metadata: input.metadata,
      });
      return parse(portalConfigurationSchema, updated, 'portal configuration');
    },

    async probeRead(resource) {
      try {
        switch (resource) {
          case 'products':
            await stripe.products.list({ limit: 1 });
            break;
          case 'prices':
            await stripe.prices.list({ limit: 1 });
            break;
          case 'customers':
            await stripe.customers.list({ limit: 1 });
            break;
          case 'subscriptions':
            await stripe.subscriptions.list({ limit: 1 });
            break;
          case 'webhooks':
            await stripe.webhookEndpoints.list({ limit: 1 });
            break;
        }
        return 'ok';
      } catch (error) {
        return isForbidden(error) ? 'forbidden' : 'failed';
      }
    },
  };
}

/**
 * Cancellation is set to take effect at the end of the paid period rather than
 * immediately, which is what the billing page promises the customer and what
 * `resolvePlan` implements by keeping Pro until `current_period_end`.
 */
function portalFeatures(input: PortalInput): Stripe.BillingPortal.ConfigurationCreateParams.Features {
  return {
    invoice_history: { enabled: input.features.invoice_history.enabled },
    payment_method_update: { enabled: input.features.payment_method_update.enabled },
    subscription_cancel: input.features.subscription_cancel.enabled
      ? { enabled: true, mode: 'at_period_end' }
      : { enabled: false },
    subscription_update: { enabled: input.features.subscription_update.enabled },
    customer_update: input.features.customer_update.enabled
      ? { enabled: true, allowed_updates: ['email'] }
      : { enabled: false },
  };
}

function statusOf(error: unknown): number | null {
  if (error && typeof error === 'object' && 'statusCode' in error) {
    const code = (error as { statusCode?: unknown }).statusCode;
    if (typeof code === 'number') return code;
  }
  return null;
}

function isMissing(error: unknown): boolean {
  return statusOf(error) === 404;
}

/** A restricted key without the necessary permission answers 401 or 403. */
function isForbidden(error: unknown): boolean {
  const status = statusOf(error);
  return status === 401 || status === 403;
}
