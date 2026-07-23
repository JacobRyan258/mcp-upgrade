# Local development

Everything below has been run. Where a step needs something this repository
cannot provide — a Supabase project, Stripe test keys — that is stated rather
than glossed over.

## Prerequisites

- Node.js 22.12 or newer
- Docker (for Postgres, and to build the worker image)
- A Supabase project, if you want authentication and uploads to work
- The Stripe CLI, if you want to exercise billing

## First run

```bash
npm install                       # installs every workspace
npm run build:libs                # scanner, shared and database packages
docker compose up -d db           # Postgres on 127.0.0.1:55432
```

Then apply the schema:

```bash
DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:55432/mcp_upgrade_test \
  npm run db:migrate
```

## Running the test suite

Most of the suite needs nothing but Node:

```bash
npm run test --workspace mcp-upgrade            # 368 scanner tests
npm run test --workspace @mcp-upgrade/shared    #  20 tests
npm run test --workspace @mcp-upgrade/worker    # 155 tests
npm run test --workspace @mcp-upgrade/web       #  36 tests
```

The database suite needs the Postgres container running, because the properties
it tests — row locking, unique constraints, row level security — cannot be
reproduced against a mock:

```bash
docker compose up -d db
TEST_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:55432/mcp_upgrade_test \
  npm run test --workspace @mcp-upgrade/database   # 85 tests
```

Everything at once, plus typecheck, lint, secret scan and build:

```bash
npm run verify
```

## Environment

Copy `.env.example`. The web block goes in `apps/web/.env.local`, the worker
block in `apps/worker/.env`. Both applications validate their configuration at
startup and refuse to run if something required is missing, so a typo produces a
list of problems rather than a confusing failure on the first request.

Generate the shared secret with:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

## Supabase setup

1. Create a project, or use an existing one.
2. Apply the migrations against its `DATABASE_URL` with `npm run db:migrate`.
   The migrations are guarded so that running them against a Supabase project
   does not attempt to touch objects owned by the auth system.
3. Create a **private** storage bucket named `scan-uploads`. Do not make it
   public: it holds other people's source code.
4. Copy the project URL, the anon key and the service-role key into your
   environment files.
5. In Authentication → URL Configuration, add `http://localhost:3000/auth/callback`
   (and your production equivalent) to the redirect allow-list.

Verify the security posture at any time:

```sql
-- Should return exactly six rows, each with privilege SELECT and nothing else.
select grantee, table_name, string_agg(privilege_type, ',' order by privilege_type)
  from information_schema.role_table_grants
 where table_schema = 'public' and grantee in ('anon', 'authenticated')
 group by grantee, table_name;
```

## Running the applications

```bash
npm run dev:web       # http://localhost:3000
npm run dev:worker    # polls the queue
```

The worker needs `DATABASE_URL`, `WORKER_SHARED_SECRET`, `SUPABASE_URL` and
`SUPABASE_SERVICE_ROLE_KEY`. Without a Supabase project it will start and poll,
but ZIP scans will fail at the download step — GitHub scans still work, because
they do not touch object storage.

## Stripe in test mode

Billing is optional. With the three Stripe variables unset the application runs
Free-plan-only and says so on the billing page.

To enable it:

1. In the Stripe dashboard, in **test mode**, create a product with a recurring
   monthly price. Copy the price id (`price_...`) into
   `STRIPE_PRO_MONTHLY_PRICE_ID`.
2. Copy the test secret key (`sk_test_...`) into `STRIPE_SECRET_KEY`.
3. Forward webhooks to your local server:

   ```bash
   stripe listen --forward-to localhost:3000/api/stripe/webhook
   ```

   Copy the `whsec_...` it prints into `STRIPE_WEBHOOK_SECRET`.

4. Use card `4242 4242 4242 4242`, any future expiry, any CVC.

A production build refuses to start with an `sk_live_` key. That guard is
deliberate; removing it should be a conscious decision.

Useful events to replay while testing:

```bash
stripe trigger checkout.session.completed
stripe trigger customer.subscription.updated
stripe trigger customer.subscription.deleted
stripe trigger invoice.payment_failed
```

Replaying the same event twice is safe by design — the second delivery is
recognised as a duplicate and does nothing.

## Building the worker image

```bash
docker build -f apps/worker/Dockerfile -t mcp-upgrade-worker .
```

The image runs as a non-root user that does not own its own code, carries no
compiler or package manager, and writes only to `/scans`.

## Resetting local data

```bash
DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:55432/mcp_upgrade_test \
ALLOW_DESTRUCTIVE_RESET=yes npm run db:reset
```

`ALLOW_DESTRUCTIVE_RESET` is required because this drops every table. It is
awkward on purpose — pointing it at a production URL would delete every scan and
subscription in the system.

To start completely fresh:

```bash
docker compose down -v && docker compose up -d db && npm run db:migrate
```

## Common problems

**`DATABASE_URL is not set`** — the database package refuses to guess. Export it
or put it in the relevant `.env` file.

**Migration says a file has changed** — an already-applied migration was edited.
Migrations are checksummed. Add a new one instead; on a disposable database,
reset.

**The worker starts but no jobs run** — check it is pointed at the same database
the web app writes to. The queue is a table, not a network call, so a mismatched
`DATABASE_URL` looks exactly like an idle queue.

**Uploads fail but GitHub scans work** — the `scan-uploads` bucket is missing, or
the service-role key is wrong.
