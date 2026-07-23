/**
 * An in-memory Stripe account.
 *
 * Implements the gateway rather than mocking HTTP, which keeps the tests about
 * provisioning behaviour instead of about request shapes. Every write is
 * recorded, so "a second run performs no writes" and "a dry run performs no
 * writes" are single assertions rather than inferences.
 *
 * Nothing here talks to the network. A green suite says nothing about whether a
 * real Stripe account exists, which is deliberate: the real account is checked
 * by `npm run stripe:verify`, not by CI.
 */
import type {
  PortalInput,
  PriceInput,
  ProbeResource,
  ProbeResult,
  ProductInput,
  StripeGateway,
  StripePortalConfiguration,
  StripePrice,
  StripeProduct,
  StripeWebhookEndpoint,
  WebhookInput,
} from '../stripe/gateway.ts';

export interface FakeOptions {
  livemode?: boolean;
  account?: string | null;
  /** Resources this credential may not read, as a restricted key could not. */
  forbidden?: ProbeResource[];
  /** Operation names that should throw, to exercise failure handling. */
  failing?: string[];
}

let counter = 0;
function id(prefix: string): string {
  counter += 1;
  return `${prefix}_fake${counter.toString().padStart(4, '0')}`;
}

export class FakeStripe implements StripeGateway {
  readonly dryRun = false;

  products: StripeProduct[] = [];
  prices: StripePrice[] = [];
  endpoints: StripeWebhookEndpoint[] = [];
  portals: StripePortalConfiguration[] = [];

  /** Every mutating call, in order. */
  readonly writes: string[] = [];

  private readonly livemode: boolean;
  private readonly account: string | null;
  private readonly forbidden: Set<ProbeResource>;
  private readonly failing: Set<string>;

  constructor(options: FakeOptions = {}) {
    this.livemode = options.livemode ?? false;
    this.account = options.account ?? 'acct_fake';
    this.forbidden = new Set(options.forbidden ?? []);
    this.failing = new Set(options.failing ?? []);
  }

  private write(operation: string): void {
    if (this.failing.has(operation)) {
      const error = new Error(`fake Stripe failure on ${operation}`) as Error & {
        statusCode: number;
        type: string;
      };
      error.statusCode = 500;
      error.type = 'StripeAPIError';
      throw error;
    }
    this.writes.push(operation);
  }

  /* ---------------------------------------------------------------------- */

  async accountId(): Promise<string | null> {
    return this.account;
  }

  async listProducts(): Promise<StripeProduct[]> {
    return this.products.map((product) => ({ ...product }));
  }

  async retrieveProduct(productId: string): Promise<StripeProduct | null> {
    const found = this.products.find((product) => product.id === productId);
    return found ? { ...found } : null;
  }

  async createProduct(input: ProductInput): Promise<StripeProduct> {
    this.write('products.create');
    const product: StripeProduct = {
      id: id('prod'),
      name: input.name,
      description: input.description,
      active: true,
      livemode: this.livemode,
      metadata: { ...input.metadata },
    };
    this.products.push(product);
    return { ...product };
  }

  async updateProduct(productId: string, input: Partial<ProductInput>): Promise<StripeProduct> {
    this.write('products.update');
    const product = this.products.find((candidate) => candidate.id === productId);
    if (!product) throw new Error(`no such product ${productId}`);
    if (input.name !== undefined) product.name = input.name;
    if (input.description !== undefined) product.description = input.description;
    if (input.metadata !== undefined) product.metadata = { ...input.metadata };
    return { ...product };
  }

  async listPricesByLookupKey(lookupKey: string): Promise<StripePrice[]> {
    return this.prices.filter((price) => price.lookup_key === lookupKey).map((price) => ({ ...price }));
  }

  async listPricesForProduct(productId: string): Promise<StripePrice[]> {
    return this.prices
      .filter((price) => (typeof price.product === 'string' ? price.product : price.product.id) === productId)
      .map((price) => ({ ...price }));
  }

  async createPrice(input: PriceInput): Promise<StripePrice> {
    this.write('prices.create');
    const price: StripePrice = {
      id: id('price'),
      active: true,
      currency: input.currency,
      livemode: this.livemode,
      lookup_key: input.lookupKey,
      type: 'recurring',
      unit_amount: input.unitAmount,
      product: input.product,
      recurring: { interval: input.interval, interval_count: input.intervalCount },
      metadata: { ...input.metadata },
    };
    this.prices.push(price);
    return { ...price };
  }

  async attachPriceLookupKey(price: StripePrice, lookupKey: string): Promise<StripePrice> {
    this.write('prices.update');
    // Stripe's `transfer_lookup_key` takes the key off whoever holds it.
    for (const candidate of this.prices) {
      if (candidate.lookup_key === lookupKey) candidate.lookup_key = null;
    }
    const stored = this.prices.find((candidate) => candidate.id === price.id);
    if (!stored) throw new Error(`no such price ${price.id}`);
    stored.lookup_key = lookupKey;
    return { ...stored };
  }

  async listWebhookEndpoints(): Promise<StripeWebhookEndpoint[]> {
    return this.endpoints.map((endpoint) => ({ ...endpoint }));
  }

  async createWebhookEndpoint(input: WebhookInput): Promise<StripeWebhookEndpoint> {
    this.write('webhookEndpoints.create');
    const endpoint: StripeWebhookEndpoint = {
      id: id('we'),
      url: input.url,
      status: 'enabled',
      livemode: this.livemode,
      enabled_events: [...input.enabledEvents],
      description: input.description,
      metadata: { ...input.metadata },
      secret: `whsec_${id('x').replace(/\W/g, '')}abcdefghijklmnop`,
    };
    // Stored without the secret, exactly as Stripe behaves: the value is
    // returned once at creation and never appears in a list or a retrieve.
    this.endpoints.push({ ...endpoint, secret: undefined });
    return endpoint;
  }

  async updateWebhookEndpoint(
    endpointId: string,
    input: { enabledEvents: string[]; description: string },
  ): Promise<StripeWebhookEndpoint> {
    this.write('webhookEndpoints.update');
    const endpoint = this.endpoints.find((candidate) => candidate.id === endpointId);
    if (!endpoint) throw new Error(`no such endpoint ${endpointId}`);
    endpoint.enabled_events = [...input.enabledEvents];
    endpoint.description = input.description;
    return { ...endpoint };
  }

  async listPortalConfigurations(): Promise<StripePortalConfiguration[]> {
    return this.portals.map((portal) => ({ ...portal }));
  }

  async createPortalConfiguration(input: PortalInput): Promise<StripePortalConfiguration> {
    this.write('billingPortal.configurations.create');
    const configuration = this.portalFrom(input, id('bpc'), this.portals.length === 0);
    this.portals.push(configuration);
    return { ...configuration };
  }

  async updatePortalConfiguration(
    configurationId: string,
    input: PortalInput,
  ): Promise<StripePortalConfiguration> {
    this.write('billingPortal.configurations.update');
    const index = this.portals.findIndex((portal) => portal.id === configurationId);
    if (index === -1) throw new Error(`no such portal configuration ${configurationId}`);
    const next = this.portalFrom(input, configurationId, this.portals[index]!.is_default);
    this.portals[index] = next;
    return { ...next };
  }

  async probeRead(resource: ProbeResource): Promise<ProbeResult> {
    return this.forbidden.has(resource) ? 'forbidden' : 'ok';
  }

  /* ---------------------------------------------------------------------- */

  private portalFrom(
    input: PortalInput,
    configurationId: string,
    isDefault: boolean,
  ): StripePortalConfiguration {
    return {
      id: configurationId,
      active: true,
      is_default: isDefault,
      livemode: this.livemode,
      metadata: { ...input.metadata },
      default_return_url: input.defaultReturnUrl,
      business_profile: { ...input.businessProfile },
      features: {
        invoice_history: { ...input.features.invoice_history },
        payment_method_update: { ...input.features.payment_method_update },
        subscription_cancel: {
          enabled: input.features.subscription_cancel.enabled,
          ...(input.features.subscription_cancel.enabled ? { mode: 'at_period_end' } : {}),
        },
        subscription_update: { ...input.features.subscription_update },
        customer_update: { ...input.features.customer_update },
      },
    };
  }
}

/* -------------------------------------------------------------------------- */
/* Builders                                                                    */
/* -------------------------------------------------------------------------- */

export function seedProduct(
  fake: FakeStripe,
  overrides: Partial<StripeProduct> = {},
): StripeProduct {
  const product: StripeProduct = {
    id: id('prod'),
    name: 'MCP Upgrade Pro',
    description: 'Monthly Pro access to the hosted MCP Upgrade validator',
    active: true,
    livemode: false,
    metadata: {
      application: 'mcp-upgrade',
      plan: 'pro',
      billing_period: 'monthly',
      environment: 'test',
    },
    ...overrides,
  };
  fake.products.push(product);
  return product;
}

export function seedPrice(fake: FakeStripe, overrides: Partial<StripePrice> = {}): StripePrice {
  const price: StripePrice = {
    id: id('price'),
    active: true,
    currency: 'usd',
    livemode: false,
    lookup_key: 'mcp_upgrade_pro_monthly',
    type: 'recurring',
    unit_amount: 1900,
    product: fake.products[0]?.id ?? 'prod_missing',
    recurring: { interval: 'month', interval_count: 1 },
    metadata: {},
    ...overrides,
  };
  fake.prices.push(price);
  return price;
}

export function seedEndpoint(
  fake: FakeStripe,
  overrides: Partial<StripeWebhookEndpoint> = {},
): StripeWebhookEndpoint {
  const endpoint: StripeWebhookEndpoint = {
    id: id('we'),
    url: 'https://upgrade.jacobryanlive.com/api/stripe/webhook',
    status: 'enabled',
    livemode: false,
    enabled_events: [
      'checkout.session.completed',
      'customer.subscription.created',
      'customer.subscription.deleted',
      'customer.subscription.updated',
      'invoice.paid',
      'invoice.payment_failed',
    ],
    description: 'existing',
    metadata: {},
    ...overrides,
  };
  fake.endpoints.push(endpoint);
  return endpoint;
}
