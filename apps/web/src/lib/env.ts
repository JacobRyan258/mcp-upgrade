/**
 * Environment configuration.
 *
 * Split deliberately into two schemas:
 *
 *   `publicEnv` may be read anywhere, including the browser. Everything in it
 *   is prefixed `NEXT_PUBLIC_` and is expected to be visible in the bundle.
 *
 *   `serverEnv` must only ever be read from a route handler, a server
 *   component or a server action. It contains the service-role key, the Stripe
 *   secret, the database URL and the worker secret. `readServerEnv()` throws if
 *   it is somehow evaluated in a browser, so an accidental import from a client
 *   component fails loudly at the boundary instead of quietly shipping a secret.
 *
 * Both are validated on first read. A missing required variable is a startup
 * error with a complete list of problems, never a silent default — the one
 * exception being test-only fallbacks, which are gated on NODE_ENV === 'test'
 * so they cannot apply in production.
 */
import { z } from 'zod';

const publicSchema = z.object({
  NEXT_PUBLIC_APP_URL: z.string().url(),
  NEXT_PUBLIC_SUPABASE_URL: z.string().url(),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: z.string().min(1),
  NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: z.string().min(1).optional(),
});

const serverSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),

  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
  DATABASE_URL: z.string().min(1),

  /** Bucket used to stage uploads. Must be private. */
  SUPABASE_UPLOAD_BUCKET: z.string().min(1).default('scan-uploads'),

  /**
   * Shared with the worker. The web app never calls the worker to enqueue work
   * — it writes a row — so this is used only for the operator status probe.
   */
  WORKER_SHARED_SECRET: z.string().min(32),
  WORKER_STATUS_URL: z.string().url().optional(),

  STRIPE_SECRET_KEY: z.string().min(1).optional(),
  STRIPE_WEBHOOK_SECRET: z.string().min(1).optional(),
  STRIPE_PRO_MONTHLY_PRICE_ID: z.string().min(1).optional(),

  /** Optional; only raises GitHub's anonymous rate limit. */
  GITHUB_TOKEN: z.string().min(1).optional(),
});

export type PublicEnv = Readonly<z.infer<typeof publicSchema>>;
export type ServerEnv = Readonly<z.infer<typeof serverSchema>>;

function describe(error: z.ZodError): string {
  return error.issues
    .map((issue) => `  ${issue.path.join('.') || '(root)'}: ${issue.message}`)
    .join('\n');
}

let publicCache: PublicEnv | null = null;
let serverCache: ServerEnv | null = null;

export function readPublicEnv(): PublicEnv {
  if (publicCache) return publicCache;
  // Next.js inlines `process.env.NEXT_PUBLIC_*` at build time only when each
  // one is referenced literally, so they are listed explicitly rather than
  // spread from `process.env`.
  const parsed = publicSchema.safeParse({
    NEXT_PUBLIC_APP_URL: process.env.NEXT_PUBLIC_APP_URL,
    NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY,
  });
  if (!parsed.success) {
    throw new Error(`Public environment is invalid:\n${describe(parsed.error)}`);
  }
  publicCache = Object.freeze(parsed.data);
  return publicCache;
}

export function readServerEnv(): ServerEnv {
  if (typeof window !== 'undefined') {
    throw new Error('Server environment was read in a browser context.');
  }
  if (serverCache) return serverCache;
  const parsed = serverSchema.safeParse(process.env);
  if (!parsed.success) {
    throw new Error(`Server environment is invalid:\n${describe(parsed.error)}`);
  }
  serverCache = Object.freeze(parsed.data);
  return serverCache;
}

/**
 * Whether billing is configured.
 *
 * Stripe variables are optional so the application runs without them — the
 * scanner half of the product works fine on the Free plan alone. When they are
 * absent the billing UI says so rather than rendering a checkout button that
 * would fail.
 */
export function billingConfigured(env: ServerEnv = readServerEnv()): boolean {
  return Boolean(env.STRIPE_SECRET_KEY && env.STRIPE_WEBHOOK_SECRET && env.STRIPE_PRO_MONTHLY_PRICE_ID);
}

/** Clears caches. Tests only. */
export function resetEnvCache(): void {
  publicCache = null;
  serverCache = null;
}

/**
 * Validates everything at once.
 *
 * Called from `instrumentation.ts` so a misconfigured deployment fails when the
 * server starts rather than on a user's first request.
 */
export function assertEnvironment(): void {
  readPublicEnv();
  const env = readServerEnv();
  if (env.NODE_ENV === 'production') {
    const app = readPublicEnv().NEXT_PUBLIC_APP_URL;
    if (app.startsWith('http://')) {
      throw new Error('NEXT_PUBLIC_APP_URL must use https in production.');
    }
    if (/localhost|127\.0\.0\.1/.test(app)) {
      throw new Error('NEXT_PUBLIC_APP_URL still points at localhost in production.');
    }
    if (env.STRIPE_SECRET_KEY?.startsWith('sk_live_')) {
      // A deliberate guard rail while this product is pre-launch. Removing it
      // is a conscious act, which is the point.
      throw new Error(
        'STRIPE_SECRET_KEY is a live-mode key. This deployment is configured for test mode only.',
      );
    }
  }
}
