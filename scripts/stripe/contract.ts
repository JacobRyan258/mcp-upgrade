/**
 * What Stripe is supposed to look like for this application.
 *
 * Every value here is either derived from the repository or is the product
 * decision itself. Nothing is restated from a prompt or a runbook, because a
 * restated value drifts: the day somebody renames the webhook route or adds a
 * seventh event to `HANDLED_EVENTS`, a setup script holding its own copy would
 * quietly provision the wrong thing and still report success.
 *
 * So:
 *   - the webhook path is *discovered* by finding the route handler that calls
 *     `webhooks.constructEvent`;
 *   - the event list is *imported* from `@mcp-upgrade/shared`, which is the
 *     same module the handler dispatches on;
 *   - the environment variable names are checked against `lib/env.ts` by a test.
 */
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  HANDLED_EVENTS,
  PRO_PRICE_CONTRACT,
  PRO_PRICE_LOOKUP_KEY,
  PRO_PRODUCT_DESCRIPTION,
  PRO_PRODUCT_METADATA,
  PRO_PRODUCT_NAME,
} from '@mcp-upgrade/shared';

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** The Next.js app directory the webhook route is discovered within. */
const APP_DIR = path.join(REPO_ROOT, 'apps', 'web', 'src', 'app');

/* -------------------------------------------------------------------------- */
/* Webhook route discovery                                                     */
/* -------------------------------------------------------------------------- */

function routeFiles(directory: string, relative = ''): string[] {
  const found: string[] = [];
  let entries;
  try {
    entries = readdirSync(path.join(directory, relative), { withFileTypes: true });
  } catch {
    return found;
  }
  for (const entry of entries) {
    const child = relative ? path.join(relative, entry.name) : entry.name;
    if (entry.isDirectory()) found.push(...routeFiles(directory, child));
    else if (entry.isFile() && /^route\.tsx?$/.test(entry.name)) found.push(child);
  }
  return found;
}

/**
 * Turns an App Router file path into the URL path it serves.
 *
 * Route groups — `(marketing)` — are organisational and contribute no segment,
 * so they are dropped. A dynamic segment would be a bug here rather than
 * something to encode: a webhook endpoint with a parameter in it is not
 * something Stripe can be pointed at.
 */
function urlPathFor(routeFile: string): string {
  const segments = path
    .dirname(routeFile)
    .split(path.sep)
    .filter((segment) => segment && segment !== '.' && !/^\(.*\)$/.test(segment));
  return `/${segments.join('/')}`;
}

/**
 * The application's Stripe webhook path, found by locating the route handler
 * that verifies Stripe signatures.
 *
 * Identifying it by behaviour rather than by name means renaming the directory
 * moves the provisioned endpoint with it, and deleting the signature check —
 * which would be a far worse bug — fails this lookup loudly.
 */
export function discoverWebhookPath(appDir: string = APP_DIR): string {
  const matches = routeFiles(appDir).filter((file) => {
    const source = readFileSync(path.join(appDir, file), 'utf8');
    return source.includes('webhooks.constructEvent');
  });

  if (matches.length === 0) {
    throw new Error(
      `No route handler under ${appDir} calls stripe.webhooks.constructEvent. ` +
        'Either the webhook route was removed or it no longer verifies signatures; ' +
        'refusing to guess a URL to register with Stripe.',
    );
  }
  if (matches.length > 1) {
    throw new Error(
      `Several route handlers verify Stripe signatures (${matches.join(', ')}). ` +
        'This script provisions exactly one endpoint and cannot choose between them.',
    );
  }
  return urlPathFor(matches[0]!);
}

/* -------------------------------------------------------------------------- */
/* Product and price                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Metadata written to the product, and the key used to find it again.
 *
 * Idempotency never keys on the product *name*: a name is display copy, it is
 * editable in the dashboard by anyone, and two unrelated products can share
 * one. `application` + `plan` is a stable identity that survives a rename.
 */
export const PRODUCT_METADATA_KEYS = PRO_PRODUCT_METADATA;

export const PRICE_LOOKUP_KEY = PRO_PRICE_LOOKUP_KEY;

export interface ProductContract {
  name: string;
  description: string;
  metadata: Record<string, string>;
}

export interface PriceContract {
  lookupKey: string;
  currency: string;
  unitAmount: number;
  interval: 'month';
  intervalCount: number;
}

export function productContract(mode: 'test' | 'live'): ProductContract {
  return {
    name: PRO_PRODUCT_NAME,
    description: PRO_PRODUCT_DESCRIPTION,
    metadata: {
      ...PRODUCT_METADATA_KEYS,
      billing_period: 'monthly',
      environment: mode,
    },
  };
}

/**
 * Re-expressed from `@mcp-upgrade/shared` rather than restated. The running
 * application validates the configured price against the same numbers at
 * startup, so provisioning and verification cannot disagree about what "$19 a
 * month" means.
 */
export const PRICE_CONTRACT: Readonly<PriceContract> = Object.freeze({
  lookupKey: PRO_PRICE_CONTRACT.lookupKey,
  currency: PRO_PRICE_CONTRACT.currency,
  unitAmount: PRO_PRICE_CONTRACT.unitAmount,
  interval: PRO_PRICE_CONTRACT.interval,
  intervalCount: PRO_PRICE_CONTRACT.intervalCount,
});

/* -------------------------------------------------------------------------- */
/* Webhook events                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Exactly the events the handler acts on — no more.
 *
 * Subscribing an endpoint to events the application ignores is not harmless:
 * every one is a delivery attempt, a row in `stripe_events`, and a retry budget
 * spent on something that will always return `ignored`.
 */
export const REQUIRED_EVENTS: readonly string[] = Object.freeze([...HANDLED_EVENTS].sort());

/* -------------------------------------------------------------------------- */
/* Customer portal                                                             */
/* -------------------------------------------------------------------------- */

/**
 * The portal capabilities this application actually supports.
 *
 * `subscription_update` is off on purpose. There is exactly one paid price, and
 * `resolvePlan` grants Pro only for that price id — so a customer who switched
 * plans inside the portal would keep paying and silently drop to Free. Enabling
 * it would need a price allowlist in `plans.ts` first.
 *
 * `customer_update` is off because nothing reads Stripe's copy of the customer
 * record: the account email comes from Supabase auth, and editing it in the
 * portal would produce two disagreeing emails and no way to reconcile them.
 */
export interface PortalContract {
  invoiceHistory: boolean;
  paymentMethodUpdate: boolean;
  subscriptionCancel: boolean;
  subscriptionUpdate: boolean;
  customerUpdate: boolean;
  returnPath: string;
  privacyPath: string;
  termsPath: string;
}

export const PORTAL_CONTRACT: Readonly<PortalContract> = Object.freeze({
  invoiceHistory: true,
  paymentMethodUpdate: true,
  subscriptionCancel: true,
  subscriptionUpdate: false,
  customerUpdate: false,
  // Matches the `return_url` the portal route sends, so a session created
  // without an explicit return URL still lands somewhere sensible.
  returnPath: '/dashboard/billing',
  privacyPath: '/privacy',
  termsPath: '/terms',
});

/* -------------------------------------------------------------------------- */
/* Environment variables                                                       */
/* -------------------------------------------------------------------------- */

/**
 * The variable names the application reads. Asserted against `lib/env.ts` by
 * `scripts/test/contract.test.ts`, so renaming one there fails the suite here
 * rather than producing a `.env.local` the app ignores.
 */
export const ENV_KEYS = Object.freeze({
  secretKey: 'STRIPE_SECRET_KEY',
  webhookSecret: 'STRIPE_WEBHOOK_SECRET',
  priceId: 'STRIPE_PRO_MONTHLY_PRICE_ID',
  publishableKey: 'NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY',
} as const);

/** Every Stripe variable this script may write. Nothing else is ever touched. */
export const MANAGED_ENV_KEYS: readonly string[] = Object.freeze([
  ENV_KEYS.secretKey,
  ENV_KEYS.webhookSecret,
  ENV_KEYS.priceId,
]);
