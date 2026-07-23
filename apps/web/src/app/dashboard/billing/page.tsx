import Link from 'next/link';
import { PLANS, formatBytes } from '@mcp-upgrade/shared';
import { requireUser } from '../../../lib/auth';
import { billingConfigured, readServerEnv } from '../../../lib/env';
import { getPlanState } from '../../../lib/plan';
import { isTestMode } from '../../../lib/stripe/client';
import { BillingButton } from '../../../components/billing-actions';

export const metadata = { title: 'Billing' };
export const dynamic = 'force-dynamic';

const STATUS_COPY: Record<string, string> = {
  active: 'Active',
  trialing: 'Trial',
  past_due: 'Payment failed — your plan has dropped to Free until payment succeeds',
  unpaid: 'Unpaid — your plan has dropped to Free',
  canceled: 'Cancelled',
  incomplete: 'Awaiting payment confirmation',
  incomplete_expired: 'Checkout expired',
  paused: 'Paused',
};

export default async function BillingPage() {
  const user = await requireUser();
  if (!user) {
    return (
      <div className="rounded-xl border border-line bg-white p-8">
        <h1 className="text-xl font-semibold">Confirm your email address first</h1>
      </div>
    );
  }

  const plan = await getPlanState(user.id);
  const configured = billingConfigured();
  const testMode = configured && isTestMode();
  const env = readServerEnv();

  return (
    <div className="space-y-8">
      <div>
        <Link href="/dashboard" className="text-sm text-muted hover:text-ink">
          ← Your scans
        </Link>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight">Billing</h1>
      </div>

      {testMode ? (
        <p className="rounded-lg bg-warn-soft px-4 py-3 text-sm text-warn">
          Stripe is running in <strong>test mode</strong>. No real payment will be taken. Use
          card number 4242 4242 4242 4242 with any future expiry and any CVC.
        </p>
      ) : null}

      <section className="rounded-xl border border-line bg-white p-6">
        <h2 className="text-lg font-semibold">Your plan</h2>
        <p className="mt-2 text-3xl font-semibold tracking-tight">{plan.limits.name}</p>
        <p className="mt-2 text-sm text-muted">
          {plan.usage.used} of {plan.usage.limit} scans used this month.
        </p>
        {plan.subscription.status ? (
          <p className="mt-3 text-sm">
            Subscription status:{' '}
            <strong className="font-medium">
              {STATUS_COPY[plan.subscription.status] ?? plan.subscription.status}
            </strong>
            {plan.subscription.cancelAtPeriodEnd && plan.subscription.currentPeriodEnd
              ? ` · Pro until ${new Date(plan.subscription.currentPeriodEnd).toLocaleDateString('en-GB')}, then Free`
              : ''}
          </p>
        ) : null}
        {plan.planId === 'free' && plan.resolution === 'unknown-price' ? (
          <p className="mt-3 rounded-lg bg-warn-soft px-3.5 py-2.5 text-sm text-warn">
            Your subscription is for a price this deployment does not recognise, so it does
            not grant Pro. Please get in touch.
          </p>
        ) : null}
      </section>

      <section className="grid gap-5 sm:grid-cols-2">
        {(['free', 'pro'] as const).map((id) => {
          const definition = PLANS[id];
          const current = plan.planId === id;
          return (
            <div
              key={id}
              className={`rounded-xl border p-6 ${current ? 'border-ink' : 'border-line'} bg-white`}
            >
              <div className="flex items-center justify-between">
                <h3 className="text-lg font-semibold">{definition.name}</h3>
                {current ? (
                  <span className="rounded-full bg-accent-soft px-2.5 py-1 text-xs font-medium text-accent">
                    Current
                  </span>
                ) : null}
              </div>
              <p className="mt-2 text-2xl font-semibold">
                {id === 'free' ? 'Free' : '$19'}
                {id === 'pro' ? <span className="text-base text-muted">/month</span> : null}
              </p>
              <ul className="mt-4 space-y-2 text-sm text-muted">
                <li>{definition.scansPerPeriod} scans per month</li>
                <li>Projects up to {formatBytes(definition.maxArchiveBytes)}</li>
                <li>
                  {Number.isFinite(definition.historyLimit)
                    ? `Last ${definition.historyLimit} scans kept`
                    : 'Unlimited scan history'}
                </li>
                <li>{definition.downloads ? 'Report downloads' : 'No report downloads'}</li>
                <li>{id === 'pro' ? 'Priority queue' : 'Standard queue'}</li>
              </ul>
            </div>
          );
        })}
      </section>

      <section className="rounded-xl border border-line bg-white p-6">
        <h2 className="text-lg font-semibold">Manage</h2>
        {!configured ? (
          <p className="mt-2 text-sm text-muted">
            Billing is not configured on this deployment, so only the Free plan is available.
            {env.NODE_ENV !== 'production'
              ? ' Set STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET and STRIPE_PRO_MONTHLY_PRICE_ID to enable it.'
              : ''}
          </p>
        ) : (
          <div className="mt-4 flex flex-wrap gap-3">
            {plan.planId === 'free' ? (
              <BillingButton endpoint="/api/stripe/checkout" label="Upgrade to Pro" />
            ) : null}
            {plan.subscription.hasCustomer ? (
              <BillingButton
                endpoint="/api/stripe/portal"
                label="Open billing portal"
                variant={plan.planId === 'free' ? 'secondary' : 'primary'}
              />
            ) : null}
          </div>
        )}
        <p className="mt-4 text-sm leading-relaxed text-muted">
          Cancelling keeps Pro until the end of the period you have already paid for. Your plan
          is determined by what Stripe tells us through a verified webhook, so it may take a
          few seconds to update after a change.
        </p>
      </section>
    </div>
  );
}
