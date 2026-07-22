-- MCP Upgrade hosted validator — initial schema.
--
-- Design notes that matter for security and correctness:
--
--   * Every table has row level security enabled with explicit policies. This
--     is not defence in depth for our own code paths — Supabase exposes this
--     database through a public PostgREST endpoint using the anon key, so RLS
--     is the only thing standing between an anonymous request and every row.
--     Our server processes connect as the table owner and bypass RLS, which is
--     why all *writes* are owner-only and the policies below grant reads only.
--
--   * Usage is enforced by an atomic UPDATE against a per-period counter row,
--     not by counting audit rows. Concurrent requests serialise on that row, so
--     N simultaneous submissions can never all observe "under the limit".
--
--   * Every externally-triggered mutation is idempotent by construction:
--     Stripe events are keyed by event id, usage moves are keyed by
--     (scan_job_id, event_type), and job state transitions are guarded by the
--     status they are transitioning *from*.

create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------------------
-- profiles
-- ---------------------------------------------------------------------------

create table if not exists public.profiles (
  id            uuid primary key references auth.users (id) on delete cascade,
  email         text not null,
  display_name  text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  constraint profiles_email_length check (char_length(email) between 3 and 320),
  constraint profiles_display_name_length check (
    display_name is null or char_length(display_name) between 1 and 120
  )
);

create unique index if not exists profiles_email_key on public.profiles (lower(email));

-- ---------------------------------------------------------------------------
-- subscriptions
-- ---------------------------------------------------------------------------
-- One row per user. The Stripe customer is created lazily at first checkout,
-- so the row may exist with a customer id and no subscription id.

create table if not exists public.subscriptions (
  user_id                 uuid primary key references public.profiles (id) on delete cascade,
  stripe_customer_id      text unique,
  stripe_subscription_id  text unique,
  stripe_price_id         text,
  status                  text,
  current_period_start    timestamptz,
  current_period_end      timestamptz,
  cancel_at_period_end    boolean not null default false,
  -- Guards against out-of-order webhook delivery: an event carrying an older
  -- Stripe timestamp than the one already applied is ignored.
  last_event_at           timestamptz,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),
  constraint subscriptions_status_known check (
    status is null or status in (
      'incomplete', 'incomplete_expired', 'trialing', 'active',
      'past_due', 'canceled', 'unpaid', 'paused'
    )
  )
);

create index if not exists subscriptions_customer_idx
  on public.subscriptions (stripe_customer_id);

-- ---------------------------------------------------------------------------
-- scan_jobs
-- ---------------------------------------------------------------------------

create table if not exists public.scan_jobs (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null references public.profiles (id) on delete cascade,
  source_type      text not null,
  source_label     text not null,
  repository_url   text,
  commit_sha       text,
  status           text not null default 'queued',
  target_version   text not null,
  scanner_version  text,
  plan_id          text not null,
  -- Storage object key for an uploaded archive. Cleared as soon as the worker
  -- has consumed it; a non-null value on a finished job is a cleanup bug.
  storage_key      text,
  error_category   text,

  -- Queue mechanics. Deliberately not exposed to users.
  priority         integer not null default 100,
  attempts         integer not null default 0,
  max_attempts     integer not null default 1,
  locked_by        text,
  locked_at        timestamptz,
  visible_at       timestamptz not null default now(),

  created_at       timestamptz not null default now(),
  started_at       timestamptz,
  completed_at     timestamptz,

  constraint scan_jobs_source_type check (source_type in ('zip', 'github')),
  constraint scan_jobs_status check (status in ('queued', 'running', 'succeeded', 'failed')),
  constraint scan_jobs_label_length check (char_length(source_label) between 1 and 120),
  constraint scan_jobs_repo_url_shape check (
    repository_url is null or repository_url ~ '^https://github\.com/[A-Za-z0-9-]{1,39}/[A-Za-z0-9._-]{1,100}$'
  ),
  constraint scan_jobs_commit_sha_shape check (
    commit_sha is null or commit_sha ~ '^[0-9a-f]{40}$'
  ),
  -- A GitHub job must carry a repository URL; a ZIP job must not.
  constraint scan_jobs_source_consistency check (
    (source_type = 'github' and repository_url is not null)
    or (source_type = 'zip' and repository_url is null)
  ),
  -- A finished job must record when it finished, and only a failed job may
  -- carry an error category.
  constraint scan_jobs_completion_consistency check (
    (status in ('succeeded', 'failed')) = (completed_at is not null)
  ),
  constraint scan_jobs_error_consistency check (
    (error_category is null) or (status = 'failed')
  ),
  constraint scan_jobs_priority_range check (priority between 0 and 1000),
  constraint scan_jobs_attempts_range check (attempts >= 0 and attempts <= 100)
);

-- Dashboard listing: a user's jobs, newest first.
create index if not exists scan_jobs_user_created_idx
  on public.scan_jobs (user_id, created_at desc);

-- Queue dequeue path. Partial so the index stays small as history grows.
create index if not exists scan_jobs_queue_idx
  on public.scan_jobs (priority, created_at)
  where status = 'queued';

-- Reaper path for jobs whose worker died mid-scan.
create index if not exists scan_jobs_running_idx
  on public.scan_jobs (locked_at)
  where status = 'running';

-- ---------------------------------------------------------------------------
-- scan_reports
-- ---------------------------------------------------------------------------
-- One report per job. The report column holds the *sanitized* published
-- report: no absolute paths, no stack traces, schema-validated before insert.

create table if not exists public.scan_reports (
  scan_job_id      uuid primary key references public.scan_jobs (id) on delete cascade,
  user_id          uuid not null references public.profiles (id) on delete cascade,
  schema_version   text not null,
  readiness_score  integer not null,
  report           jsonb not null,
  count_error      integer not null default 0,
  count_warning    integer not null default 0,
  count_review     integer not null default 0,
  count_info       integer not null default 0,
  files_scanned    integer not null default 0,
  files_skipped    integer not null default 0,
  partial          boolean not null default false,
  created_at       timestamptz not null default now(),
  constraint scan_reports_score_range check (readiness_score between 0 and 100),
  constraint scan_reports_counts_nonneg check (
    count_error >= 0 and count_warning >= 0 and count_review >= 0 and count_info >= 0
  ),
  -- A stored report must never contain an absolute or drive-letter root. The
  -- worker sanitizes and schema-validates before writing; this is the database
  -- refusing to store the mistake if that ever regresses.
  constraint scan_reports_root_is_not_a_path check (
    (report -> 'repository' ->> 'root') !~ '^([/~]|[A-Za-z]:|\\\\)'
  )
);

create index if not exists scan_reports_user_idx on public.scan_reports (user_id, created_at desc);

-- ---------------------------------------------------------------------------
-- usage_counters — the atomic allowance gate
-- ---------------------------------------------------------------------------

create table if not exists public.usage_counters (
  user_id         uuid not null references public.profiles (id) on delete cascade,
  billing_period  text not null,
  used            integer not null default 0,
  updated_at      timestamptz not null default now(),
  primary key (user_id, billing_period),
  constraint usage_counters_used_nonneg check (used >= 0),
  constraint usage_counters_period_shape check (billing_period ~ '^\d{4}-\d{2}$')
);

-- ---------------------------------------------------------------------------
-- usage_events — the audit log and the idempotency key for counter moves
-- ---------------------------------------------------------------------------

create table if not exists public.usage_events (
  id              bigint generated always as identity primary key,
  user_id         uuid not null references public.profiles (id) on delete cascade,
  scan_job_id     uuid references public.scan_jobs (id) on delete set null,
  event_type      text not null,
  billing_period  text not null,
  quantity        integer not null,
  created_at      timestamptz not null default now(),
  constraint usage_events_type check (event_type in ('reserved', 'released')),
  constraint usage_events_period_shape check (billing_period ~ '^\d{4}-\d{2}$')
);

-- A job can be reserved once and released once. This is what makes a retried
-- worker completion or a replayed API request unable to move the counter twice.
--
-- This is a plain (non-partial) unique constraint on purpose. A partial index
-- cannot be used for `ON CONFLICT` inference unless every statement repeats the
-- index predicate, and `release_scan_allowance` relies on that inference. Plain
-- SQL NULL semantics already give the behaviour the partial predicate was
-- reaching for: rows with a null scan_job_id never conflict with each other, so
-- usage events not tied to a job remain unconstrained.
alter table public.usage_events
  drop constraint if exists usage_events_job_type_key;
alter table public.usage_events
  add constraint usage_events_job_type_key unique (scan_job_id, event_type);

create index if not exists usage_events_user_period_idx
  on public.usage_events (user_id, billing_period, created_at desc);

-- ---------------------------------------------------------------------------
-- stripe_events — webhook idempotency
-- ---------------------------------------------------------------------------

create table if not exists public.stripe_events (
  id            text primary key,
  type          text not null,
  -- Stripe's own event creation time, used to detect out-of-order delivery.
  stripe_created_at timestamptz not null,
  received_at   timestamptz not null default now(),
  processed_at  timestamptz,
  outcome       text,
  constraint stripe_events_outcome check (
    outcome is null or outcome in ('applied', 'ignored', 'stale', 'error')
  )
);

create index if not exists stripe_events_received_idx on public.stripe_events (received_at desc);

-- ---------------------------------------------------------------------------
-- submission_throttle — cheap abuse brake on job creation
-- ---------------------------------------------------------------------------
-- Failed jobs release their allowance, which is correct for the user but would
-- otherwise let someone submit invalid input without limit. This counts every
-- *submission* in a rolling window, whether or not it consumed allowance.

create table if not exists public.submission_throttle (
  user_id       uuid not null references public.profiles (id) on delete cascade,
  window_start  timestamptz not null,
  submissions   integer not null default 0,
  primary key (user_id, window_start),
  constraint submission_throttle_nonneg check (submissions >= 0)
);

-- ---------------------------------------------------------------------------
-- updated_at maintenance
-- ---------------------------------------------------------------------------

create or replace function public.touch_updated_at()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists profiles_touch_updated_at on public.profiles;
create trigger profiles_touch_updated_at
  before update on public.profiles
  for each row execute function public.touch_updated_at();

drop trigger if exists subscriptions_touch_updated_at on public.subscriptions;
create trigger subscriptions_touch_updated_at
  before update on public.subscriptions
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------------
-- profile provisioning
-- ---------------------------------------------------------------------------
-- A profile row is created for every new auth user. `security definer` with an
-- empty search_path is required: the trigger runs as the auth system, and an
-- unqualified name would otherwise be resolvable by a caller-controlled schema.

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, email, display_name)
  values (
    new.id,
    coalesce(new.email, ''),
    nullif(trim(coalesce(new.raw_user_meta_data ->> 'display_name', '')), '')
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------------------------------------------------------------------------
-- Row level security
-- ---------------------------------------------------------------------------
-- Policy shape: authenticated users may read their own rows and nothing else.
-- No policy grants INSERT, UPDATE or DELETE to anyone. Every write in this
-- system goes through a server process connecting as the table owner, which
-- bypasses RLS. That keeps "who may write" a property of our code rather than
-- of a policy an attacker can probe through PostgREST.

alter table public.profiles            enable row level security;
alter table public.subscriptions       enable row level security;
alter table public.scan_jobs           enable row level security;
alter table public.scan_reports        enable row level security;
alter table public.usage_counters      enable row level security;
alter table public.usage_events        enable row level security;
alter table public.stripe_events       enable row level security;
alter table public.submission_throttle enable row level security;

-- Force RLS so that even a role which happens to own a table is still
-- constrained when it is not the connection our servers use.
alter table public.stripe_events       force row level security;
alter table public.submission_throttle force row level security;

drop policy if exists profiles_select_own on public.profiles;
create policy profiles_select_own on public.profiles
  for select to authenticated
  using ((select auth.uid()) = id);

drop policy if exists subscriptions_select_own on public.subscriptions;
create policy subscriptions_select_own on public.subscriptions
  for select to authenticated
  using ((select auth.uid()) = user_id);

drop policy if exists scan_jobs_select_own on public.scan_jobs;
create policy scan_jobs_select_own on public.scan_jobs
  for select to authenticated
  using ((select auth.uid()) = user_id);

drop policy if exists scan_reports_select_own on public.scan_reports;
create policy scan_reports_select_own on public.scan_reports
  for select to authenticated
  using ((select auth.uid()) = user_id);

drop policy if exists usage_counters_select_own on public.usage_counters;
create policy usage_counters_select_own on public.usage_counters
  for select to authenticated
  using ((select auth.uid()) = user_id);

drop policy if exists usage_events_select_own on public.usage_events;
create policy usage_events_select_own on public.usage_events
  for select to authenticated
  using ((select auth.uid()) = user_id);

-- stripe_events and submission_throttle have no policies at all: no client
-- role can read them under any circumstances.

-- Undo Supabase's default grants to the API roles, then grant back exactly one
-- privilege.
--
-- `revoke all` rather than `revoke insert, update, delete`, because Supabase's
-- defaults also include TRUNCATE, TRIGGER and REFERENCES, and the first two are
-- genuinely dangerous here:
--
--   * TRUNCATE is not filtered by row level security. A signed-in caller
--     holding that privilege could empty a table outright, policies and all.
--   * TRIGGER lets a caller attach their own function to our tables, which runs
--     whenever *anyone's* row changes.
--   * REFERENCES lets a caller build a foreign key against a table and use
--     constraint violations to probe for rows they cannot select.
--
-- None of these are reachable through PostgREST's own API surface today, but
-- they are privileges held by a role whose credentials ship in the browser, and
-- the correct size for that set is "select, and nothing else".
revoke all on public.stripe_events from anon, authenticated;
revoke all on public.submission_throttle from anon, authenticated;
revoke all on
  public.profiles, public.subscriptions, public.scan_jobs, public.scan_reports,
  public.usage_counters, public.usage_events
from anon, authenticated;

-- Grant the reads back explicitly, so RLS — not a missing privilege — is what
-- decides which rows a signed-in caller sees. Stating this rather than relying
-- on Supabase's default grants also means a local Postgres behaves identically,
-- which is what makes the isolation tests meaningful.
grant usage on schema public to anon, authenticated;
grant select on
  public.profiles, public.subscriptions, public.scan_jobs, public.scan_reports,
  public.usage_counters, public.usage_events
to authenticated;

-- Future tables must not silently inherit the defaults this migration just
-- undid. Applied for both role sets that create objects in this schema.
alter default privileges in schema public revoke all on tables from anon, authenticated;
alter default privileges in schema public revoke all on functions from anon, authenticated;
alter default privileges in schema public revoke all on sequences from anon, authenticated;
