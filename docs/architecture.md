# Architecture and technology choices

Every choice below is recorded with the reason, including the ones where the
obvious option was rejected.

## Three execution boundaries

**Web (`apps/web`)** — Next.js App Router. Serves marketing pages,
authentication, the dashboard, the report UI and the billing routes. It never
extracts an archive and never scans anything.

**Worker (`apps/worker`)** — a plain Node service. It is the only process that
touches untrusted archives. It runs in its own container as a non-root user with
a read-only filesystem and one writable scratch directory.

**Database (`packages/database`)** — Postgres, on Supabase. It is also the queue.

The split exists because a Next.js route handler provides no resource isolation.
Unpacking a hostile archive inside one would put a zip bomb in the same process
as the request that serves the marketing page.

## Choices

**npm workspaces, not Turborepo or Nx.** Five packages with a fixed build order
do not need a build graph. The root scripts state the order explicitly. Adding an
orchestrator would have been churn with no payoff.

**Postgres as the queue, not Redis.** `SELECT … FOR UPDATE SKIP LOCKED` gives
exactly-once dequeue across as many workers as we run, and the job row and its
allowance reservation live in the same transaction. Redis would add a second
durable store to keep consistent with the first, for no capability we need. The
brief said not to add Redis unless genuinely needed; it is not.

**Supabase for auth and Postgres.** One managed service covers both, and its auth
handles email confirmation and password reset without us storing credentials.
The cost is that it publishes the database through an internet-facing PostgREST
endpoint, which makes row level security mandatory rather than optional — so the
schema enables RLS on every table, grants `authenticated` nothing but `SELECT`,
and revokes the `TRUNCATE`, `TRIGGER` and `REFERENCES` privileges Supabase grants
by default. That posture is asserted by tests.

**Two database access paths.** User-facing reads go through the `pg` connection
with the verified user id in the WHERE clause. RLS policies exist as a second,
independent layer covering the PostgREST surface we do not use but cannot turn
off. Neither is sufficient alone.

**`yauzl` for extraction.** It streams entries and never writes to disk itself,
so every limit, every path check and every write decision is ours. A library that
extracts for you decides those things on your behalf. Its own name validation is
kept on as a second layer.

**GitHub zipballs, not tarballs and not `git clone`.** Using the zip endpoint
means both ingestion paths — upload and GitHub — go through one hardened
extractor rather than two. No git process runs, so submodules, LFS and hooks are
not questions that arise.

**Only scanner-readable extensions are extracted.** The scanner reads TypeScript,
JavaScript, JSON and YAML. Everything else is counted and discarded without being
decompressed, which removes most bomb payloads before they cost anything, and
`node_modules` and friends are skipped entirely.

**Stripe, webhook-driven.** Plan state is read from our database, written only by
a signature-verified webhook. A checkout redirect grants nothing: the success URL
is user-controlled, so acting on it would be the vulnerability.

**Zod for validation.** One runtime dependency in the shared package, used for
environment validation and for the published-report schema at both boundaries.

**Vitest and Playwright.** Vitest matches what the scanner already used, so the
toolchain is uniform. Playwright is configured for end-to-end coverage.

**Tailwind v4.** No config file, theme defined in CSS. The UI is deliberately
plain: this is a report someone forwards to a developer, so severity is
communicated by label as well as colour, and it survives a monochrome print.

## Data flow

1. The browser posts a ZIP or a repository URL to `/api/scans`.
2. The route authenticates, reads the plan from the database, validates the
   input against that plan, stages any upload to a private bucket, then calls one
   SQL function that throttles, reserves allowance and inserts the job together.
3. The worker claims the job with `SKIP LOCKED`, downloads or fetches the
   archive, extracts it under hard limits into a private per-job directory, runs
   `scanPath()`, sanitizes the report, and records the result.
4. The job directory and the staged upload are deleted on every path — success,
   failure and timeout.
5. The dashboard polls status and renders the stored report, re-validating it
   against the schema first.

## Allowance rule

One scan is reserved when a job is accepted. It is charged when the scan
completes, whatever it found. It is released when the job fails for any reason,
including our own faults. Because failures refund, allowance alone cannot bound
abuse, so a separate rolling-window submission throttle does that.

## What is deliberately not here

- No autofix. The scanner reports; it does not rewrite code.
- No private repositories in this release.
- No language model anywhere in the request path. Plain-English explanations are
  static templates keyed by rule id, so the same finding always produces the same
  words and the report is reviewable and diffable.
