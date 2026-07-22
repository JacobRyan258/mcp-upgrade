-- Transactional operations for job submission, allowance and queue mechanics.
--
-- These live in the database rather than in application code because each one
-- must be atomic against concurrent callers. Doing the read-check-write in
-- Node would leave a window in which two simultaneous submissions both observe
-- "under the limit"; here the UPDATE against the counter row is the check, and
-- Postgres serialises concurrent writers on that row for us.
--
-- Every function below is REVOKEd from the API roles at the end of this file.
-- Supabase publishes `public` functions as RPC endpoints, so a function that
-- reserves allowance or dequeues work would otherwise be callable by any
-- signed-in user with the anon key and a session token.

-- ---------------------------------------------------------------------------
-- create_scan_job — throttle, reserve and insert, atomically
-- ---------------------------------------------------------------------------
-- Returns exactly one row. `outcome` is one of:
--   'created'          — job_id is set
--   'limit_reached'    — allowance exhausted for this billing period
--   'throttled'        — too many submissions in the rolling window
-- The caller never has to reason about partial state: either a job exists with
-- a matching reservation, or nothing was written at all.

create or replace function public.create_scan_job(
  p_user_id          uuid,
  p_source_type      text,
  p_source_label     text,
  p_repository_url   text,
  p_target_version   text,
  p_plan_id          text,
  p_priority         integer,
  p_storage_key      text,
  p_billing_period   text,
  p_scan_limit       integer,
  p_throttle_limit   integer,
  p_throttle_window  interval
)
returns table (outcome text, job_id uuid, used integer)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_window_start timestamptz;
  v_submissions  integer;
  v_used         integer;
  v_job_id       uuid;
begin
  -- 1. Rolling-window submission brake.
  --    Failed jobs refund allowance, so allowance alone cannot bound how often
  --    a user may submit hostile input. This can.
  v_window_start := date_trunc('hour', now())
    + floor(extract(epoch from (now() - date_trunc('hour', now()))) / extract(epoch from p_throttle_window))
      * p_throttle_window;

  insert into public.submission_throttle (user_id, window_start, submissions)
  values (p_user_id, v_window_start, 0)
  on conflict (user_id, window_start) do nothing;

  update public.submission_throttle
     set submissions = submission_throttle.submissions + 1
   where submission_throttle.user_id = p_user_id
     and submission_throttle.window_start = v_window_start
     and submission_throttle.submissions < p_throttle_limit
  returning submission_throttle.submissions into v_submissions;

  if v_submissions is null then
    return query select 'throttled'::text, null::uuid, null::integer;
    return;
  end if;

  -- 2. Allowance reservation. The `used < p_scan_limit` predicate is the whole
  --    enforcement mechanism: concurrent callers queue on this row lock and
  --    each one re-evaluates the predicate against the committed value.
  insert into public.usage_counters (user_id, billing_period, used)
  values (p_user_id, p_billing_period, 0)
  on conflict (user_id, billing_period) do nothing;

  update public.usage_counters
     set used = usage_counters.used + 1,
         updated_at = now()
   where usage_counters.user_id = p_user_id
     and usage_counters.billing_period = p_billing_period
     and usage_counters.used < p_scan_limit
  returning usage_counters.used into v_used;

  if v_used is null then
    select usage_counters.used into v_used
      from public.usage_counters
     where usage_counters.user_id = p_user_id
       and usage_counters.billing_period = p_billing_period;
    return query select 'limit_reached'::text, null::uuid, coalesce(v_used, 0);
    return;
  end if;

  -- 3. The job itself.
  insert into public.scan_jobs (
    user_id, source_type, source_label, repository_url,
    target_version, plan_id, priority, storage_key, status
  )
  values (
    p_user_id, p_source_type, p_source_label, p_repository_url,
    p_target_version, p_plan_id, p_priority, p_storage_key, 'queued'
  )
  returning scan_jobs.id into v_job_id;

  -- 4. Audit row. The unique index on (scan_job_id, event_type) is what makes
  --    a later release idempotent.
  insert into public.usage_events (user_id, scan_job_id, event_type, billing_period, quantity)
  values (p_user_id, v_job_id, 'reserved', p_billing_period, 1);

  return query select 'created'::text, v_job_id, v_used;
end;
$$;

-- ---------------------------------------------------------------------------
-- release_scan_allowance — refund a reservation, at most once
-- ---------------------------------------------------------------------------
-- Returns true when this call performed the refund, false when it had already
-- been refunded. A retried worker, a duplicate webhook and a manual replay all
-- converge on the same counter value.

create or replace function public.release_scan_allowance(p_job_id uuid)
returns boolean
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_user_id uuid;
  v_period  text;
  v_inserted integer;
begin
  select usage_events.user_id, usage_events.billing_period
    into v_user_id, v_period
    from public.usage_events
   where usage_events.scan_job_id = p_job_id
     and usage_events.event_type = 'reserved';

  if v_user_id is null then
    return false;  -- nothing was ever reserved for this job
  end if;

  insert into public.usage_events (user_id, scan_job_id, event_type, billing_period, quantity)
  values (v_user_id, p_job_id, 'released', v_period, -1)
  on conflict (scan_job_id, event_type) do nothing;

  get diagnostics v_inserted = row_count;
  if v_inserted = 0 then
    return false;  -- already released
  end if;

  update public.usage_counters
     set used = greatest(usage_counters.used - 1, 0),
         updated_at = now()
   where usage_counters.user_id = v_user_id
     and usage_counters.billing_period = v_period;

  return true;
end;
$$;

-- ---------------------------------------------------------------------------
-- claim_scan_job — dequeue one job for a worker
-- ---------------------------------------------------------------------------
-- FOR UPDATE SKIP LOCKED is what lets several workers poll the same table
-- without contending or double-processing.

create or replace function public.claim_scan_job(p_worker text)
returns table (
  id uuid, user_id uuid, source_type text, source_label text,
  repository_url text, target_version text, plan_id text,
  storage_key text, attempts integer, max_attempts integer
)
language plpgsql
security invoker
set search_path = ''
as $$
begin
  return query
  update public.scan_jobs as j
     set status = 'running',
         started_at = coalesce(j.started_at, now()),
         locked_by = p_worker,
         locked_at = now(),
         attempts = j.attempts + 1
   where j.id = (
     select inner_job.id
       from public.scan_jobs as inner_job
      where inner_job.status = 'queued'
        and inner_job.visible_at <= now()
      order by inner_job.priority asc, inner_job.created_at asc
      for update skip locked
      limit 1
   )
  returning j.id, j.user_id, j.source_type, j.source_label,
            j.repository_url, j.target_version, j.plan_id,
            j.storage_key, j.attempts, j.max_attempts;
end;
$$;

-- ---------------------------------------------------------------------------
-- reap_stale_scan_jobs — recover work whose worker died
-- ---------------------------------------------------------------------------
-- A job stuck in `running` past the lease is either retried or failed. Failing
-- it here also refunds the allowance, because the user did nothing wrong.

create or replace function public.reap_stale_scan_jobs(p_lease interval)
returns integer
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_count integer := 0;
  v_job record;
begin
  for v_job in
    select scan_jobs.id, scan_jobs.attempts, scan_jobs.max_attempts
      from public.scan_jobs
     where scan_jobs.status = 'running'
       and scan_jobs.locked_at < now() - p_lease
     for update skip locked
  loop
    if v_job.attempts < v_job.max_attempts then
      update public.scan_jobs
         set status = 'queued', locked_by = null, locked_at = null,
             visible_at = now()
       where scan_jobs.id = v_job.id;
    else
      update public.scan_jobs
         set status = 'failed', error_category = 'internal_error',
             completed_at = now(), locked_by = null, locked_at = null,
             storage_key = null
       where scan_jobs.id = v_job.id;
      perform public.release_scan_allowance(v_job.id);
    end if;
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;

-- ---------------------------------------------------------------------------
-- fail_scan_job — guarded terminal transition
-- ---------------------------------------------------------------------------
-- Only a `running` job can fail, so a duplicate completion from a retried
-- worker finds nothing to update and returns false. Every failure refunds the
-- allowance: the documented rule is that a user pays for a completed scan of
-- their code, and this job never produced one.

create or replace function public.fail_scan_job(
  p_job_id uuid,
  p_category text
)
returns boolean
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_updated integer;
begin
  update public.scan_jobs
     set status = 'failed',
         error_category = p_category,
         completed_at = now(),
         locked_by = null,
         locked_at = null,
         storage_key = null
   where scan_jobs.id = p_job_id
     and scan_jobs.status = 'running';

  get diagnostics v_updated = row_count;
  if v_updated = 0 then
    return false;
  end if;

  perform public.release_scan_allowance(p_job_id);
  return true;
end;
$$;

-- ---------------------------------------------------------------------------
-- complete_scan_job — guarded terminal transition plus report insert
-- ---------------------------------------------------------------------------
-- The report insert and the status transition share one transaction, so a
-- succeeded job always has a readable report. Re-running with the same job id
-- is a no-op rather than a duplicate-key error.

create or replace function public.complete_scan_job(
  p_job_id          uuid,
  p_scanner_version text,
  p_commit_sha      text,
  p_schema_version  text,
  p_readiness_score integer,
  p_report          jsonb,
  p_count_error     integer,
  p_count_warning   integer,
  p_count_review    integer,
  p_count_info      integer,
  p_files_scanned   integer,
  p_files_skipped   integer,
  p_partial         boolean
)
returns boolean
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_updated integer;
  v_user_id uuid;
begin
  update public.scan_jobs
     set status = 'succeeded',
         scanner_version = p_scanner_version,
         commit_sha = coalesce(p_commit_sha, scan_jobs.commit_sha),
         completed_at = now(),
         locked_by = null,
         locked_at = null,
         storage_key = null
   where scan_jobs.id = p_job_id
     and scan_jobs.status = 'running'
  returning scan_jobs.user_id into v_user_id;

  get diagnostics v_updated = row_count;
  if v_updated = 0 then
    return false;
  end if;

  insert into public.scan_reports (
    scan_job_id, user_id, schema_version, readiness_score, report,
    count_error, count_warning, count_review, count_info,
    files_scanned, files_skipped, partial
  )
  values (
    p_job_id, v_user_id, p_schema_version, p_readiness_score, p_report,
    p_count_error, p_count_warning, p_count_review, p_count_info,
    p_files_scanned, p_files_skipped, p_partial
  )
  on conflict (scan_job_id) do nothing;

  return true;
end;
$$;

-- ---------------------------------------------------------------------------
-- apply_stripe_subscription — idempotent, order-tolerant subscription sync
-- ---------------------------------------------------------------------------
-- `p_event_at` is Stripe's own event timestamp. An event older than the one
-- already applied is discarded, which is what makes out-of-order webhook
-- delivery safe: a late `customer.subscription.updated` cannot resurrect a
-- subscription that a newer `customer.subscription.deleted` already ended.

create or replace function public.apply_stripe_subscription(
  p_user_id                uuid,
  p_customer_id            text,
  p_subscription_id        text,
  p_price_id               text,
  p_status                 text,
  p_current_period_start   timestamptz,
  p_current_period_end     timestamptz,
  p_cancel_at_period_end   boolean,
  p_event_at               timestamptz
)
returns text
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_existing timestamptz;
begin
  select subscriptions.last_event_at into v_existing
    from public.subscriptions
   where subscriptions.user_id = p_user_id
   for update;

  if found and v_existing is not null and v_existing > p_event_at then
    return 'stale';
  end if;

  insert into public.subscriptions (
    user_id, stripe_customer_id, stripe_subscription_id, stripe_price_id,
    status, current_period_start, current_period_end, cancel_at_period_end,
    last_event_at
  )
  values (
    p_user_id, p_customer_id, p_subscription_id, p_price_id,
    p_status, p_current_period_start, p_current_period_end,
    coalesce(p_cancel_at_period_end, false), p_event_at
  )
  on conflict (user_id) do update
     set stripe_customer_id     = coalesce(excluded.stripe_customer_id, subscriptions.stripe_customer_id),
         stripe_subscription_id = excluded.stripe_subscription_id,
         stripe_price_id        = excluded.stripe_price_id,
         status                 = excluded.status,
         current_period_start   = excluded.current_period_start,
         current_period_end     = excluded.current_period_end,
         cancel_at_period_end   = excluded.cancel_at_period_end,
         last_event_at          = excluded.last_event_at;

  return 'applied';
end;
$$;

-- ---------------------------------------------------------------------------
-- Function privileges
-- ---------------------------------------------------------------------------
-- None of these may ever be reachable through the public PostgREST RPC surface.

do $$
declare
  v_signature text;
begin
  for v_signature in
    select format('%I.%I(%s)', n.nspname, p.proname, pg_get_function_identity_arguments(p.oid))
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.proname in (
         'create_scan_job', 'release_scan_allowance', 'claim_scan_job',
         'reap_stale_scan_jobs', 'fail_scan_job', 'complete_scan_job',
         'apply_stripe_subscription', 'touch_updated_at', 'handle_new_user'
       )
  loop
    execute format('revoke all on function %s from public, anon, authenticated', v_signature);
  end loop;
end;
$$;
