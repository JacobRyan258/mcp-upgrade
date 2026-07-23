# Stripe

Billing is optional. With the three Stripe variables unset, the application runs
Free-plan-only and says so on the billing page rather than showing a checkout
button that would fail.

Everything below has been run. Where a step needs something this repository
cannot provide — a live-mode decision, a Vercel dashboard — that is stated
rather than glossed over.

## What the application actually uses

Read out of the code, not out of a runbook:

| Thing | Value | Where it comes from |
| --- | --- | --- |
| Webhook route | `/api/stripe/webhook` | the only route handler calling `stripe.webhooks.constructEvent` |
| Handled events | six, listed below | `HANDLED_EVENTS` in `packages/shared/src/stripe-events.ts` |
| Checkout flow | Stripe Checkout, `mode: 'subscription'`, server-side only | `apps/web/src/app/api/stripe/checkout/route.ts` |
| Billing management | Stripe Customer Portal | `apps/web/src/app/api/stripe/portal/route.ts` |
| Plan storage | `public.subscriptions`, written only by the webhook | `packages/database/src/billing.ts` |
| Entitlement rule | `active`/`trialing` **and** price id equals `STRIPE_PRO_MONTHLY_PRICE_ID` | `packages/shared/src/plans.ts` |

The six events:

```
checkout.session.completed
customer.subscription.created
customer.subscription.updated
customer.subscription.deleted
invoice.paid
invoice.payment_failed
```

The endpoint is subscribed to exactly these. Anything else is a delivery, a row
in `stripe_events` and a retry budget spent on an event the handler will always
report as `ignored`.

## Provisioning

```bash
npm run stripe:setup -- --dry-run                 # read everything, write nothing
npm run stripe:setup                              # test mode, localhost
npm run stripe:setup -- --production-base-url https://upgrade.jacobryanlive.com
npm run stripe:verify                             # read-only checks
```

The credential comes from `STRIPE_SECRET_KEY` in the environment. Provide it for
one command without it entering your shell history:

```bash
read -rs STRIPE_SECRET_KEY && export STRIPE_SECRET_KEY
```

### Flags

| Flag | Effect |
| --- | --- |
| `--base-url <origin>` | The origin being set up. Default `http://localhost:3000`. A local origin registers **no** webhook endpoint — Stripe cannot reach it. |
| `--production-base-url <origin>` | Also register the hosted endpoint. |
| `--write-env <path>` | Write results into an env file. Repeatable. |
| `--no-portal` | Leave the customer portal configuration alone. |
| `--dry-run` | Read everything, write nothing, print the plan. |
| `--live` | Permit a live-mode key. Requires typing `provision live mode` at an interactive prompt; there is deliberately no flag that skips it. |
| `--json` | Machine-readable summary. Never contains a signing secret. |

### What "safe to rerun" means

| Situation | What happens |
| --- | --- |
| Nothing exists | Product, price, endpoint and portal configuration are created |
| Everything exists and matches | Nothing is written; every resource reports `reused` |
| Product name or metadata has drifted | Updated in place; metadata this script does not own is preserved |
| A matching price exists without the lookup key | Adopted — the lookup key is attached, no new price created |
| The lookup key points at a price with different terms | **Fails**, because amount, currency and interval are immutable in Stripe and reusing it would charge customers the wrong thing |
| The endpoint exists but is missing events | Updated to the *union* — events somebody else added are preserved |
| Two endpoints share one URL | **Fails.** The application holds one signing secret, so the other endpoint's deliveries are rejected as forgeries |
| Two products claim to be this plan | **Fails** rather than picking one |

Nothing is ever deleted. Every refusal names the objects in conflict and says
what to archive in the dashboard.

### The webhook signing secret

Stripe returns it once, at creation, and never again — not on a retrieve, not on
a list. The script prints it in full exactly once, only at an interactive
terminal, only for an endpoint it just created. It is never in `--json` and
never in a file this script did not verify is gitignored and untracked.

Rerunning against an existing endpoint reports:

```
Existing webhook reused, but its signing secret cannot be retrieved through the API.
Open Stripe Dashboard → Developers → Webhooks → select the endpoint → reveal Signing secret.
```

## Environment variables

Locally every variable lives in **one** file: `.env` at the repository root.
There is no per-workspace env file — `apps/web/.env.local` and
`apps/worker/.env` are kept deliberately empty and defining anything in them is
a hard startup error (see [Environment loading](#environment-loading)). In a
Vercel deployment there is no `.env`; the platform's environment variables are
the source of truth.

| Name | Prefix | Purpose | Secret? | Where to get it | Local | Vercel | Worker |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `STRIPE_SECRET_KEY` | `sk_test_` / `rk_test_` | Every server-side Stripe call | **yes** | Dashboard → Developers → API keys (test mode) | root `.env` | Project → Settings → Environment Variables | no |
| `STRIPE_WEBHOOK_SECRET` | `whsec_` | Verifies webhook signatures | **yes** | `stripe listen` locally; endpoint creation output in production | root `.env` | same | no |
| `STRIPE_PRO_MONTHLY_PRICE_ID` | `price_` | The one price that grants Pro | no | `npm run stripe:setup` output | root `.env` | same | no |
| `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` | `pk_test_` | Unused today; only needed if a client-side Stripe flow is added | no (public by design) | Dashboard → API keys | root `.env` | optional | no |

The worker never talks to Stripe. It has no Stripe dependency in its container
image, and CI asserts that.

All three server variables must be present for billing to be offered at all —
see `billingConfigured` in `apps/web/src/lib/env.ts`. They must also all belong
to the **same Stripe account and the same mode**: matching prefixes is not
enough, and is not what is checked. Startup resolves the configured price
against the Stripe API (`apps/web/src/lib/stripe/resources.ts`), so a test-mode
key paired with a price id from a *different* account — both individually
well-formed — refuses to start instead of failing at a customer's checkout with
"No such price". `npm run verify:stripe-env` runs the same check on demand.

## Environment loading

The single approved local runtime file is `.env` at the repository root. Every
command loads it through `scripts/with-env.mjs`, which:

- loads **only** root `.env` — not `.env.local`, not `.env.example`, not any
  per-workspace file;
- lets the real process environment win, so Vercel/CI/Docker injection is never
  overridden by a stale file;
- refuses to start if a forbidden file (`apps/web/.env.local`,
  `apps/worker/.env`, …) defines any variable;
- prints a masked startup banner naming the source file, the Stripe mode and
  the webhook-secret kind — never a secret value.

Because `@next/env` never overwrites a variable already present in
`process.env`, preloading root `.env` before `next` starts means
`apps/web/.env.local` **cannot** override it even though Next.js still reads it.
`npm run verify:env-files` audits all of this statically, and CI runs it plus a
check that a reintroduced `apps/web/.env.local` fails the audit.

## Restricted API keys

Stripe issues restricted keys (`rk_`) with per-resource Read/Write scopes. Two
different jobs are being done here and they should not share a credential.

Both matrices below are derived from an exhaustive search of the repository for
Stripe SDK calls, not from guesswork. The complete list of calls is:

| Call | Where | Needs |
| --- | --- | --- |
| `customers.create` | checkout route | Customers: Write |
| `checkout.sessions.create` | checkout route | Checkout Sessions: Write |
| `billingPortal.sessions.create` | portal route | Customer portal: Write |
| `subscriptions.retrieve` | webhook route, re-reading after an invoice event | Subscriptions: Read |
| `webhooks.constructEvent` | webhook route | **nothing** — local HMAC, no API call |
| `products.*`, `prices.*`, `webhookEndpoints.*`, `billingPortal.configurations.*` | `scripts/` only | see the setup matrix |

### Runtime credential (the deployed web application)

| Resource | Access | Why |
| --- | --- | --- |
| Customers | **Write** | `customers.create` on a user's first checkout |
| Checkout Sessions | **Write** | `checkout.sessions.create` |
| Customer portal | **Write** | `billingPortal.sessions.create` |
| Subscriptions | **Read** | `subscriptions.retrieve` when hydrating an invoice event |
| Everything else | None | |

Notably **not** needed: Webhook Endpoints (the app never registers one), Prices
or Products write, Events read (the handler is push-only and never calls
`events.retrieve`), Invoices (invoice events are treated as a signal to re-read
the subscription, never read back directly).

Two honest caveats:

- **Prices/Products read** is not listed because no runtime call reads them: the
  price id is passed straight into `checkout.sessions.create` and Stripe resolves
  it under the same key. If a checkout ever fails with a permission error naming
  prices, add **Prices: Read** — do not add it pre-emptively.
- `allow_promotion_codes: true` is set on the Checkout Session. If promotion
  codes stop working under a restricted key, add **Coupons: Read** and
  **Promotion Codes: Read**.

To confirm empirically rather than trusting this table: create the key, run a
real checkout in test mode, then Dashboard → Developers → API keys → the key →
**View request logs**, and remove any permission that has no successful request
against it.

### Provisioning credential (running `scripts/setup-stripe.ts`)

| Resource | Access | Why |
| --- | --- | --- |
| Products | **Write** | create, update, retrieve, list |
| Prices | **Write** | create, list, attach a lookup key |
| Webhook Endpoints | **Write** | create, update, list |
| Customer portal (configurations) | **Write** | read and update the account default |
| Everything else | None | |

`npm run stripe:verify` also probes Customers and Subscriptions read, which
means the verification credential wants those two as **Read** as well. That is
the only reason to grant them to a provisioning key.

This credential should live nowhere near a deployment. Export it into one shell,
run the script, and let it fall out of scope.

### What restricted keys cannot do here

- **Stripe has no API for creating restricted keys.** They are created in the
  dashboard only (Developers → API keys → Create restricted key). No script,
  including this one, can provision one for you, and none should claim to.
- **Account read** (`accounts.retrieveCurrent`) is not in either matrix. Both
  scripts call it purely to print which account they touched, and both degrade
  to "not readable with this key" without it. Granting it is optional.

## Local development

The full sequence, from nothing. The secret key comes from root `.env`, which
`npm run stripe:setup` loads for you — there is no separate export step.

```bash
# 1. Put the test-mode keys in root .env (copy .env.example if starting fresh).
#    STRIPE_SECRET_KEY=sk_test_…  and  NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY=pk_test_…

# 2. See what would happen.
npm run stripe:setup:dry-run

# 3. Provision, and write the resulting price id into root .env.
#    The file must be gitignored and untracked or the script refuses.
npm run stripe:setup -- --write-env .env

# 4. Forward webhooks. This prints its own whsec_ — a different secret from any
#    registered endpoint's. Put it in STRIPE_WEBHOOK_SECRET in root .env.
#    Leave this running.
npm run stripe:listen

# 5. In another terminal.
npm run dev:web

# 6. Check (root .env is loaded automatically).
npm run verify:stripe-env
```

Then exercise it: sign in, open `/dashboard/billing`, click **Upgrade to Pro**,
pay with `4242 4242 4242 4242`, any future expiry, any CVC. Watch the
`stripe listen` terminal for `checkout.session.completed` and
`customer.subscription.created`, and the app terminal for
`{"event":"stripe.event_processed","outcome":"applied"}`.

Replaying is safe by design:

```bash
stripe trigger customer.subscription.updated
stripe trigger customer.subscription.deleted
stripe trigger invoice.payment_failed
```

The second delivery of any event id is recognised as a duplicate and does
nothing.

No webhook endpoint is registered for `localhost`. Stripe's servers cannot
reach it and the API rejects it, which is why step 4 exists.

## Production

Base URL: `https://upgrade.jacobryanlive.com`. **Still test mode** — the
application refuses to start in production holding a live-mode key, and that
guard is deliberate.

```bash
read -rs STRIPE_SECRET_KEY && export STRIPE_SECRET_KEY
npm run stripe:setup -- --production-base-url https://upgrade.jacobryanlive.com
```

The endpoint's signing secret is printed once, at the terminal, at that moment.
If you miss it, or if the endpoint already existed, read it from
Dashboard → Developers → Webhooks → the endpoint → **Signing secret** (reveal).
There is no API that returns it.

Then, in **Vercel → Project → Settings → Environment Variables**, for the
Production environment:

| Name | Value |
| --- | --- |
| `STRIPE_SECRET_KEY` | your `rk_test_…` runtime restricted key (or `sk_test_…`) |
| `STRIPE_WEBHOOK_SECRET` | the `whsec_…` for the `upgrade.jacobryanlive.com` endpoint |
| `STRIPE_PRO_MONTHLY_PRICE_ID` | the `price_…` from the setup output |
| `NEXT_PUBLIC_APP_URL` | `https://upgrade.jacobryanlive.com` |

`NEXT_PUBLIC_APP_URL` is inlined at build time, so it must be set **before** the
build runs — setting it afterwards leaves the deployed bundle pointing at
whatever it was compiled with, and `assertEnvironment()` refuses to start a
hosted deployment built with an http or localhost URL.

Redeploy after changing any of these, then:

```bash
npm run stripe:verify -- --production-base-url https://upgrade.jacobryanlive.com
```

## Customer portal

Configured on the account's **default** configuration, because the portal route
creates sessions without naming one — creating a second, correct configuration
and leaving the default alone would provision something the application never
reaches, which is worse than doing nothing because it looks like success.

| Capability | State | Why |
| --- | --- | --- |
| Cancel subscription | on, at period end | Matches what the billing page promises and what `resolvePlan` implements |
| Update payment method | on | |
| View invoices | on | |
| Switch plan | **off** | `resolvePlan` grants Pro only for the one configured price id. A customer who switched would keep paying and silently drop to Free. Enabling this needs a price allowlist in `plans.ts` first |
| Edit customer details | **off** | The account email comes from Supabase auth; editing Stripe's copy would produce two disagreeing emails and no way to reconcile them |

## Security properties of the webhook handler

Verified while writing this, and covered by `apps/web/test/stripe-webhook.test.ts`:

- The raw body is read with `request.text()` and verified before anything is
  parsed. The route pins `runtime = 'nodejs'` so no body parser or edge
  transform can see it first.
- A missing signature is a 400 and does not claim the event id.
- An invalid signature is a 400 whose body says only `invalid_signature` — the
  reason would tell a prober how close their forgery was.
- The event id is claimed by a primary-key insert. A replayed body loses the
  insert and does nothing.
- A failure releases the claim, so Stripe's retry is not discarded as a
  duplicate.
- Writes go through `apply_stripe_subscription`, which discards an event
  carrying an older Stripe timestamp than the one already applied. Out-of-order
  delivery is safe.
- The Stripe customer is resolved to a user through the mapping we already
  stored. Metadata is used only to establish the mapping the first time, and
  only when the customer is not already claimed by someone else.
- After re-reading a subscription from Stripe, the fetched subscription's
  customer is compared against the customer the verified event named; a
  mismatch is ignored rather than written.
- An event whose `livemode` disagrees with the API key's mode is refused, and
  the event id is not claimed, so fixing the configuration allows a retry.
- Access follows from stored subscription state only. The checkout success URL
  grants nothing — `getPlanState` reads the database and never a request,
  cookie or redirect parameter.
- A subscription on a price this deployment does not recognise resolves to
  Free, so checking out against some other price cannot grant Pro.
