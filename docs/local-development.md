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
  npm run test --workspace @mcp-upgrade/database   # 116 tests
```

Everything at once, plus typecheck, lint, secret scan and build:

```bash
npm run verify
```

## Environment

There is exactly one local runtime file: `.env` at the repository root.

```bash
cp .env.example .env && chmod 600 .env   # then fill in real values
```

Every command — dev, build, start, worker, migrations, Stripe scripts — loads
it through `scripts/with-env.mjs`. There is no per-workspace env file:
`apps/web/.env.local` and `apps/worker/.env` are kept deliberately empty, and
**defining any variable in them is a hard startup error**. Next.js loads
`.env.local` automatically and would otherwise outrank root `.env`; preloading
root `.env` first closes that override, because `@next/env` never replaces a
variable already set in `process.env`. `npm run verify:env-files` audits this,
and the startup banner names which file was loaded (never a secret value).

Both applications validate their configuration at startup and refuse to run if
something required is missing, so a typo produces a list of problems rather than
a confusing failure on the first request. All Stripe values must additionally
belong to the same account and mode — the price is resolved against the Stripe
API at startup, so a cross-account price id fails to boot rather than at
checkout.

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

To enable it, provision the Stripe side with the setup script rather than
clicking through the dashboard:

```bash
# Put the test-mode keys in root .env first (sk_test_ / pk_test_). The setup
# script loads root .env for you — no separate export step.
npm run stripe:setup:dry-run                     # see the plan
npm run stripe:setup -- --write-env .env         # do it
```

That creates or reuses the product, the $19/month price and the customer portal
configuration, and writes `STRIPE_PRO_MONTHLY_PRICE_ID` into root `.env`. It
refuses to write to any file that git tracks or does not ignore, and takes a
backup first.

Then forward webhooks. No endpoint is registered for `localhost` — Stripe cannot
reach it — so the CLI is how deliveries arrive locally, and it prints its own
signing secret, which is a *different* value from any registered endpoint's:

```bash
npm run stripe:listen
```

Copy the `whsec_...` it prints into `STRIPE_WEBHOOK_SECRET` in root `.env`, then
start the app and check the result:

```bash
npm run dev:web
npm run verify:stripe-env
```

Pay with card `4242 4242 4242 4242`, any future expiry, any CVC.

A production build refuses to start with a live-mode key, restricted (`rk_live_`)
or full (`sk_live_`). That guard is deliberate; removing it should be a conscious
decision.

`docs/stripe.md` has the full reference: every flag, what "safe to rerun" means
case by case, the restricted-key permission matrices, and the production steps.

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
build tooling, and writes only to `/scans`.

If you mount a volume or tmpfs at `/scans`, it **must** carry
`uid=1000,gid=1000`. A mount replaces the directory the image created and
arrives owned by root, so without those options the unprivileged runtime user
cannot create its per-job directory and every scan fails with `EACCES`.
`docker-compose.yml` already does this:

```
--tmpfs /scans:mode=0700,uid=1000,gid=1000,size=2g
```

To run the image directly against the local database, use the Postgres
container's address rather than `host.docker.internal` — the database port is
bound to host loopback, which the bridge network cannot reach:

```bash
PGIP=$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' mcp-upgrade-test-db)
docker run --rm \
  -e DATABASE_URL="postgresql://postgres:postgres@$PGIP:5432/mcp_upgrade_test" \
  -e WORKER_SHARED_SECRET="at-least-32-characters-long-value-here" \
  -e SUPABASE_URL="https://your-project-ref.supabase.co" \
  -e SUPABASE_SERVICE_ROLE_KEY="your-service-role-key" \
  -p 127.0.0.1:8080:8080 \
  --read-only --tmpfs /scans:mode=0700,uid=1000,gid=1000,size=512m \
  --tmpfs /tmp:mode=1777,size=64m \
  --security-opt no-new-privileges:true --cap-drop ALL \
  mcp-upgrade-worker
```

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

**`DATABASE_URL is not set`** — the database package refuses to guess. Put it in
root `.env` (loaded automatically) or export it for a one-off command.

**`Forbidden environment file(s) define runtime variables`** — something was
written into `apps/web/.env.local` or `apps/worker/.env`. Move it into root
`.env` and comment the line out of the forbidden file. `npm run verify:env-files`
lists exactly what to fix.

**`unsupported startup parameter: statement_timeout`** — the `DATABASE_URL`
points at a PgBouncer transaction-mode pooler, which rejects that startup
parameter (the pool sets it in `packages/database/src/pool.ts`). Use the session
pooler / direct connection string, or a pooler that ignores it. See
`docs/hosting-vercel.md`.

**Migration says a file has changed** — an already-applied migration was edited.
Migrations are checksummed. Add a new one instead; on a disposable database,
reset.

**The worker starts but no jobs run** — check it is pointed at the same database
the web app writes to. The queue is a table, not a network call, so a mismatched
`DATABASE_URL` looks exactly like an idle queue.

**Uploads fail but GitHub scans work** — the `scan-uploads` bucket is missing, or
the service-role key is wrong.
