/**
 * Effective plan and allowance for the current user.
 *
 * Every limit decision in the application funnels through here, and it reads
 * only from the database — never from a request, a cookie or a redirect
 * parameter. A user returning from a successful Stripe checkout has exactly the
 * plan the webhook recorded, which may still be Free if the webhook has not
 * landed yet. That is correct: the alternative is granting access on the
 * strength of a URL the user controls.
 */
import { getSubscription, getUsage } from '@mcp-upgrade/database';
import type { UsageSnapshot } from '@mcp-upgrade/database';
import {
  billingPeriodKey,
  billingPeriodResetsAt,
  resolvePlan,
} from '@mcp-upgrade/shared';
import type { PlanId, PlanLimits, ResolvedPlan } from '@mcp-upgrade/shared';
import { readServerEnv } from './env';

export interface PlanState {
  planId: PlanId;
  limits: Readonly<PlanLimits>;
  resolution: ResolvedPlan['reason'];
  usage: UsageSnapshot;
  subscription: {
    status: string | null;
    cancelAtPeriodEnd: boolean;
    currentPeriodEnd: string | null;
    hasCustomer: boolean;
  };
}

export async function getPlanState(userId: string, now = new Date()): Promise<PlanState> {
  const env = readServerEnv();
  const subscription = await getSubscription(userId);

  const resolved = resolvePlan({
    subscription: subscription
      ? {
          status: subscription.status,
          priceId: subscription.priceId,
          currentPeriodEnd: subscription.currentPeriodEnd,
          cancelAtPeriodEnd: subscription.cancelAtPeriodEnd,
        }
      : null,
    proPriceId: env.STRIPE_PRO_MONTHLY_PRICE_ID ?? null,
    now,
  });

  const period = billingPeriodKey(now);
  const usage = await getUsage(
    userId,
    period,
    resolved.limits.scansPerPeriod,
    billingPeriodResetsAt(period),
  );

  return {
    planId: resolved.planId,
    limits: resolved.limits,
    resolution: resolved.reason,
    usage,
    subscription: {
      status: subscription?.status ?? null,
      cancelAtPeriodEnd: subscription?.cancelAtPeriodEnd ?? false,
      currentPeriodEnd: subscription?.currentPeriodEnd
        ? subscription.currentPeriodEnd.toISOString()
        : null,
      hasCustomer: Boolean(subscription?.stripeCustomerId),
    },
  };
}

/**
 * How many past scans a plan may list.
 *
 * `Infinity` is not a value a SQL LIMIT accepts, so it is capped at a large
 * finite number here rather than at every call site.
 */
export function historyLimitFor(limits: Readonly<PlanLimits>): number {
  return Number.isFinite(limits.historyLimit) ? limits.historyLimit : 200;
}
