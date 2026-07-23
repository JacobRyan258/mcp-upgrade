/**
 * A gateway that reads for real and refuses to write.
 *
 * `--dry-run` is implemented by substituting this for the real gateway rather
 * than by scattering `if (dryRun)` through the provisioning logic. The logic
 * therefore cannot forget to check the flag on some newly added write, and the
 * guarantee "a dry run creates nothing" is one the type system helps keep.
 *
 * Writes return a plausibly-shaped object carrying an obviously synthetic id,
 * so the steps that follow can keep going and the whole plan is reported in one
 * pass instead of stopping at the first thing that does not exist yet.
 */
import type {
  PortalInput,
  PriceInput,
  ProductInput,
  StripeGateway,
  StripePortalConfiguration,
  StripePrice,
  StripeProduct,
  StripeWebhookEndpoint,
  WebhookInput,
} from './gateway.ts';

/** Deliberately not valid Stripe ids: nothing downstream may treat them as real. */
export const DRY_RUN_IDS = Object.freeze({
  product: 'prod_WOULD_BE_CREATED',
  price: 'price_WOULD_BE_CREATED',
  webhook: 'we_WOULD_BE_CREATED',
  portal: 'bpc_WOULD_BE_CREATED',
});

export interface PlannedWrite {
  operation: string;
  summary: string;
}

export interface DryRunGateway extends StripeGateway {
  readonly planned: readonly PlannedWrite[];
}

/** True for an id this wrapper invented, which the real API has never heard of. */
function isSynthetic(id: string): boolean {
  return (Object.values(DRY_RUN_IDS) as string[]).includes(id);
}

export function dryRunGateway(inner: StripeGateway, livemode: boolean): DryRunGateway {
  const planned: PlannedWrite[] = [];
  const plan = (operation: string, summary: string): void => {
    planned.push({ operation, summary });
  };

  const product = (input: ProductInput, id: string): StripeProduct => ({
    id,
    name: input.name,
    description: input.description,
    active: true,
    livemode,
    metadata: input.metadata,
  });

  return {
    planned,
    dryRun: true,

    accountId: () => inner.accountId(),
    listProducts: () => inner.listProducts(),
    listPricesByLookupKey: (key) => inner.listPricesByLookupKey(key),
    listWebhookEndpoints: () => inner.listWebhookEndpoints(),

    // A read is normally forwarded untouched. The exception is a read *about an
    // object this wrapper only pretended to create* — Stripe would answer "no
    // such product", which is true and useless. Answering as the freshly
    // created object would answer lets the rest of the plan be computed.
    retrieveProduct: async (id) => (isSynthetic(id) ? null : inner.retrieveProduct(id)),
    listPricesForProduct: async (id) => (isSynthetic(id) ? [] : inner.listPricesForProduct(id)),

    listPortalConfigurations: () => inner.listPortalConfigurations(),
    probeRead: (resource) => inner.probeRead(resource),

    async createProduct(input: ProductInput) {
      plan('products.create', `${input.name} — ${input.description}`);
      return product(input, DRY_RUN_IDS.product);
    },

    async updateProduct(id, input) {
      plan('products.update', `${id} — ${Object.keys(input).join(', ')}`);
      const existing = isSynthetic(id) ? null : await inner.retrieveProduct(id);
      return {
        ...(existing ?? product({ name: '', description: '', metadata: {} }, id)),
        ...(input.name === undefined ? {} : { name: input.name }),
        ...(input.description === undefined ? {} : { description: input.description }),
        ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
      };
    },

    async createPrice(input: PriceInput) {
      plan(
        'prices.create',
        `${(input.unitAmount / 100).toFixed(2)} ${input.currency.toUpperCase()} every ` +
          `${input.intervalCount} ${input.interval} on ${input.product}, lookup key ${input.lookupKey}`,
      );
      return synthesisedPrice(input, livemode);
    },

    async attachPriceLookupKey(price, lookupKey) {
      plan('prices.update', `${price.id} — attach lookup key ${lookupKey}`);
      return { ...price, lookup_key: lookupKey };
    },

    async createWebhookEndpoint(input: WebhookInput) {
      plan('webhookEndpoints.create', `${input.url} — ${input.enabledEvents.length} events`);
      const endpoint: StripeWebhookEndpoint = {
        id: DRY_RUN_IDS.webhook,
        url: input.url,
        status: 'enabled',
        livemode,
        enabled_events: input.enabledEvents,
        description: input.description,
        metadata: input.metadata,
        // No secret: a dry run must never produce something that looks like a
        // credential to paste somewhere.
      };
      return endpoint;
    },

    async updateWebhookEndpoint(id, input) {
      plan('webhookEndpoints.update', `${id} — enabled events → ${input.enabledEvents.length}`);
      const existing = (await inner.listWebhookEndpoints()).find(
        (endpoint) => endpoint.id === id,
      );
      return {
        id,
        url: existing?.url ?? '',
        status: existing?.status ?? 'enabled',
        livemode,
        enabled_events: input.enabledEvents,
        description: input.description,
        metadata: existing?.metadata ?? {},
      };
    },

    async createPortalConfiguration(input: PortalInput) {
      plan('billingPortal.configurations.create', describePortal(input));
      return synthesisedPortal(input, livemode, DRY_RUN_IDS.portal, true);
    },

    async updatePortalConfiguration(id, input) {
      plan('billingPortal.configurations.update', `${id} — ${describePortal(input)}`);
      return synthesisedPortal(input, livemode, id, true);
    },
  };
}

function synthesisedPrice(input: PriceInput, livemode: boolean, id?: string): StripePrice {
  return {
    id: id ?? DRY_RUN_IDS.price,
    active: true,
    currency: input.currency,
    livemode,
    lookup_key: input.lookupKey,
    type: 'recurring',
    unit_amount: input.unitAmount,
    product: input.product,
    recurring: { interval: input.interval, interval_count: input.intervalCount },
    metadata: input.metadata,
  };
}

function synthesisedPortal(
  input: PortalInput,
  livemode: boolean,
  id: string,
  isDefault: boolean,
): StripePortalConfiguration {
  return {
    id,
    active: true,
    is_default: isDefault,
    livemode,
    metadata: input.metadata,
    default_return_url: input.defaultReturnUrl,
    business_profile: input.businessProfile,
    features: {
      invoice_history: input.features.invoice_history,
      payment_method_update: input.features.payment_method_update,
      subscription_cancel: {
        enabled: input.features.subscription_cancel.enabled,
        ...(input.features.subscription_cancel.enabled ? { mode: 'at_period_end' } : {}),
      },
      subscription_update: input.features.subscription_update,
      customer_update: input.features.customer_update,
    },
  };
}

function describePortal(input: PortalInput): string {
  return Object.entries(input.features)
    .map(([name, value]) => `${name}=${value.enabled ? 'on' : 'off'}`)
    .join(' ');
}
