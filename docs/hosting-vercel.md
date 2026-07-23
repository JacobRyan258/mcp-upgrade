# Hosting the web app on Vercel

This is the checklist for taking `apps/web` to Vercel **while staying in Stripe
test mode**. It does not deploy anything; it is the list of what must be true
first, and the exact place each value comes from.

The governing rule: **in a hosted deployment there is no `.env`.** Vercel's
Project → Settings → Environment Variables *is* the configuration. The
repository's `scripts/with-env.mjs` loader detects a hosted platform
(`VERCEL`/`VERCEL_ENV`/`CI`) and stands aside, so the platform variables are
used verbatim and are never overridden by a committed file.

## Environment variable checklist

Every variable the web app reads, with the scope it belongs in. "Secret" means
it must be added as a Vercel *sensitive* variable and must never carry the
`NEXT_PUBLIC_` prefix.

| Name | Dev | Preview | Production | Secret | Expected format | Source |
| --- | :---: | :---: | :---: | :---: | --- | --- |
| `NEXT_PUBLIC_APP_URL` | ✓ | ✓ | ✓ | no | `https://…` (no localhost in prod) | the deployment's canonical origin |
| `NEXT_PUBLIC_SUPABASE_URL` | ✓ | ✓ | ✓ | no | `https://<ref>.supabase.co` | Supabase → Project Settings → API |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | ✓ | ✓ | ✓ | no (public by design) | JWT (`eyJ…`) | Supabase → API |
| `SUPABASE_SERVICE_ROLE_KEY` | ✓ | ✓ | ✓ | **yes** | JWT (`eyJ…`) | Supabase → API → service_role |
| `DATABASE_URL` | ✓ | ✓ | ✓ | **yes** | `postgresql://…` | Supabase → Database → Connection string (see note) |
| `SUPABASE_UPLOAD_BUCKET` | ✓ | ✓ | ✓ | no | bucket name (`scan-uploads`) | Supabase Storage |
| `WORKER_SHARED_SECRET` | ✓ | ✓ | ✓ | **yes** | ≥32 chars | shared with the worker host, identical value |
| `WORKER_STATUS_URL` | optional | optional | optional | no | `https://…/status` | the worker's status endpoint |
| `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` | ✓ | ✓ | ✓ | no (public) | `pk_test_…` | Stripe → Developers → API keys (test) |
| `STRIPE_SECRET_KEY` | ✓ | ✓ | ✓ | **yes** | `sk_test_…` or `rk_test_…` | Stripe → API keys (test) |
| `STRIPE_WEBHOOK_SECRET` | ✓ | ✓ | ✓ | **yes** | `whsec_…` | **hosted endpoint** secret (not the CLI's) |
| `STRIPE_PRO_MONTHLY_PRICE_ID` | ✓ | ✓ | ✓ | no | `price_…` | `npm run stripe:setup` output |
| `GITHUB_TOKEN` | optional | optional | optional | **yes** | `ghp_…` | only raises GitHub's anon rate limit |

Notes:

- **All four Stripe values stay test mode for initial hosting.**
  `assertEnvironment()` refuses to start a production deployment holding a
  live-mode key, and refuses a `STRIPE_WEBHOOK_SECRET` that is a `we_` endpoint
  id rather than a `whsec_` signing secret.
- **`NEXT_PUBLIC_APP_URL` is inlined at build time.** Set it *before* the build
  runs. Setting it after leaves the bundle pointing at whatever it compiled
  with, and a hosted deployment built with `http://` or `localhost` refuses to
  start.
- **`DATABASE_URL`** for the serverless web app should use Supabase's
  **transaction** pooler (Supavisor, port `6543`):
  `postgresql://postgres.<ref>:<password>@aws-0-<region>.pooler.supabase.com:6543/postgres`.
  The pool (`packages/database/src/pool.ts`) deliberately does **not** pass
  `statement_timeout` to `pg` — pg would put it in the startup packet and the
  transaction pooler rejects that with
  `unsupported startup parameter: statement_timeout`, which previously took down
  every database-backed request. The query bound is instead enforced two
  pooler-safe ways: a client-side `query_timeout` on the pool, and a
  transaction-scoped `SET LOCAL statement_timeout` inside `withTransaction`.
  Migrations and the worker use the **session** pooler (port `5432`,
  same host) because migrations hold a session-level advisory lock; both
  endpoints are otherwise interchangeable. See the pre-deploy check below.

## The hosted webhook — a required manual step

`npm run stripe:setup -- --production-base-url https://upgrade.jacobryanlive.com`
registers the endpoint and prints its `whsec_` **once**. That value — not the
Stripe CLI's local forwarding secret — is what goes in Vercel's
`STRIPE_WEBHOOK_SECRET`. They are different secrets and are not interchangeable:
the CLI secret only verifies deliveries forwarded by `stripe listen`, and the
endpoint secret only verifies deliveries Stripe sends to the hosted URL.

If the endpoint already exists, reveal its secret at
Dashboard → Developers → Webhooks → the endpoint → Signing secret. There is no
API that returns it after creation.

## Pre-deploy verification

Run from a machine that has the production values available (or point the
commands at them):

```bash
# 1. Stripe: product, price, hosted webhook endpoint, events, portal.
npm run stripe:verify -- --production-base-url https://upgrade.jacobryanlive.com

# 2. Environment files: nothing forbidden, nothing tracked, no live keys.
npm run verify:env-files

# 3. Database reachability with the production DATABASE_URL. A serverless
#    deployment cannot serve a single billing request if this fails. Run
#    migrations against the SESSION pooler (5432); the web app then uses the
#    TRANSACTION pooler (6543) at runtime.
DATABASE_URL='<session-pooler-url>' npm run db:migrate   # applies, then idempotent
```

## What Vercel injection does and does not change

- Platform variables are read straight from `process.env`; the loader does not
  touch them.
- There is intentionally no committed `.env` in the deployment. Do not add one.
- `apps/web/.env.local` and `apps/worker/.env` remain empty. If a build step
  ever writes a variable into one, the app fails to start by design — that is
  the guard against the local override sneaking into a build.
