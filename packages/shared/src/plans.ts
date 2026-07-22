/**
 * Plan and allowance configuration.
 *
 * Plan *limits* are code (they are product logic and must be identical in the
 * web app, the worker and the database checks). Stripe *price identifiers* are
 * configuration and are always injected from the environment — never hardcoded,
 * so the same build can run against different Stripe accounts and modes.
 */

export type PlanId = 'free' | 'pro';

export interface PlanLimits {
  id: PlanId;
  name: string;
  /** Scans allowed per billing period. */
  scansPerPeriod: number;
  /** Largest accepted upload / downloaded archive, in bytes. */
  maxArchiveBytes: number;
  /** Largest accepted total expanded size, in bytes. */
  maxExpandedBytes: number;
  /** Maximum number of files extracted from an archive. */
  maxFiles: number;
  /** How many past scans are listed and openable. `Infinity` means unlimited. */
  historyLimit: number;
  /** Whether report downloads (JSON / Markdown / HTML) are offered. */
  downloads: boolean;
  /** Lower number is dequeued first. */
  queuePriority: number;
}

export const PLANS: Readonly<Record<PlanId, Readonly<PlanLimits>>> = Object.freeze({
  free: Object.freeze({
    id: 'free',
    name: 'Free',
    scansPerPeriod: 2,
    maxArchiveBytes: 20 * 1024 * 1024,
    maxExpandedBytes: 120 * 1024 * 1024,
    maxFiles: 5_000,
    historyLimit: 5,
    downloads: false,
    queuePriority: 100,
  }),
  pro: Object.freeze({
    id: 'pro',
    name: 'Pro',
    scansPerPeriod: 50,
    maxArchiveBytes: 150 * 1024 * 1024,
    maxExpandedBytes: 900 * 1024 * 1024,
    maxFiles: 40_000,
    historyLimit: Number.POSITIVE_INFINITY,
    downloads: true,
    queuePriority: 10,
  }),
});

export const DEFAULT_PLAN_ID: PlanId = 'free';

export function isPlanId(value: unknown): value is PlanId {
  return value === 'free' || value === 'pro';
}

export function planLimits(planId: PlanId): Readonly<PlanLimits> {
  return PLANS[planId];
}

/**
 * Stripe subscription statuses that entitle a customer to their paid plan.
 *
 * `past_due` is deliberately excluded: once an invoice has failed, the account
 * falls back to Free until payment succeeds. `canceled` subscriptions retain
 * access until `current_period_end` only when Stripe itself keeps reporting
 * them active, which it does via `cancel_at_period_end` on an `active` record.
 */
const ENTITLING_STATUSES: ReadonlySet<string> = new Set(['active', 'trialing']);

export interface SubscriptionSnapshot {
  status: string | null;
  priceId: string | null;
  currentPeriodEnd: Date | string | null;
  cancelAtPeriodEnd?: boolean | null;
}

export interface PlanResolutionInput {
  subscription: SubscriptionSnapshot | null;
  /** The single configured Pro price. Injected from `STRIPE_PRO_MONTHLY_PRICE_ID`. */
  proPriceId: string | null;
  /** Injected for determinism in tests. */
  now?: Date;
}

export interface ResolvedPlan {
  planId: PlanId;
  limits: Readonly<PlanLimits>;
  /** Why the plan resolved the way it did. Safe to show to the account owner. */
  reason:
    | 'no-subscription'
    | 'status-not-entitling'
    | 'unknown-price'
    | 'period-expired'
    | 'entitled';
}

/**
 * Derives the effective plan from a *stored, webhook-verified* subscription
 * record. Never call this with client-supplied data.
 *
 * Every failure mode degrades to Free. An unrecognised price ID does not grant
 * Pro, so a customer who checks out against a price this deployment does not
 * know about cannot silently gain a higher allowance.
 */
export function resolvePlan(input: PlanResolutionInput): ResolvedPlan {
  const free: ResolvedPlan = { planId: 'free', limits: PLANS.free, reason: 'no-subscription' };
  const subscription = input.subscription;
  if (!subscription || !subscription.status) return free;

  if (!ENTITLING_STATUSES.has(subscription.status)) {
    return { ...free, reason: 'status-not-entitling' };
  }
  if (!input.proPriceId || subscription.priceId !== input.proPriceId) {
    return { ...free, reason: 'unknown-price' };
  }

  const periodEnd = toDate(subscription.currentPeriodEnd);
  if (periodEnd) {
    const now = input.now ?? new Date();
    // Stripe can lag by a few minutes between the period rolling over and the
    // renewal invoice landing, so allow a small grace window before demoting.
    const graceMs = 6 * 60 * 60 * 1000;
    if (periodEnd.getTime() + graceMs < now.getTime()) {
      return { ...free, reason: 'period-expired' };
    }
  }

  return { planId: 'pro', limits: PLANS.pro, reason: 'entitled' };
}

function toDate(value: Date | string | null | undefined): Date | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * The UTC calendar month a timestamp belongs to, as `YYYY-MM`.
 *
 * Allowance is counted per calendar month rather than per Stripe billing cycle
 * so that Free accounts — which have no Stripe record at all — and Pro accounts
 * use one identical, auditable rule.
 */
export function billingPeriodKey(when: Date = new Date()): string {
  const year = when.getUTCFullYear().toString().padStart(4, '0');
  const month = (when.getUTCMonth() + 1).toString().padStart(2, '0');
  return `${year}-${month}`;
}

/** First instant of the month *after* the given period key, in UTC. */
export function billingPeriodResetsAt(periodKey: string): Date {
  const match = /^(\d{4})-(\d{2})$/.exec(periodKey);
  if (!match) throw new Error('Invalid billing period key.');
  const year = Number(match[1]);
  const month = Number(match[2]);
  return new Date(Date.UTC(month === 12 ? year + 1 : year, month === 12 ? 0 : month, 1));
}
