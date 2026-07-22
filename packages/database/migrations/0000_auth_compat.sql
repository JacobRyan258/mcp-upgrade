-- Supabase compatibility shim.
--
-- On a Supabase project every object below already exists and this migration
-- does nothing. On a plain Postgres — which is what the test suite and the
-- Docker Compose development stack run — it creates the minimum surface the
-- rest of the schema depends on: the `auth` schema, an `auth.users` table to
-- reference, the `auth.uid()` function the RLS policies call, and the `anon`
-- and `authenticated` roles the grants target.
--
-- The point is that the row level security policies are exercised locally
-- against the same definitions they run against in production, rather than
-- being untestable until deploy.
--
-- Every statement is guarded on *existence*, not on `if not exists`. On
-- Supabase the `auth` schema is owned by `supabase_auth_admin` and the
-- migration role has no CREATE privilege on it — and Postgres checks that
-- privilege before honouring `create table if not exists`, so the shortened
-- form fails even though the table is already there. Nothing here ever
-- replaces a Supabase-provided definition: overwriting the real `auth.uid()`
-- would be a critical authentication bug.

do $$
begin
  if not exists (select 1 from pg_namespace where nspname = 'auth') then
    create schema auth;
  end if;
end;
$$;

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role nologin noinherit bypassrls;
  end if;
end;
$$;

-- Minimal stand-in for Supabase's auth.users, created only when absent. Only
-- the columns this schema actually reads are declared.
do $$
begin
  if to_regclass('auth.users') is null then
    create table auth.users (
      id                  uuid primary key default gen_random_uuid(),
      email               text,
      raw_user_meta_data  jsonb default '{}'::jsonb,
      email_confirmed_at  timestamptz,
      created_at          timestamptz not null default now()
    );
    grant usage on schema auth to anon, authenticated, service_role;
  end if;
end;
$$;

-- `auth.uid()` reads the request JWT claims that Supabase's PostgREST sets per
-- connection. The local definition reproduces that contract exactly so a test
-- can impersonate a user with `set local request.jwt.claims`.
do $$
begin
  if not exists (
    select 1
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'auth' and p.proname = 'uid'
  ) then
    execute $fn$
      create function auth.uid()
      returns uuid
      language sql
      stable
      as $body$
        select nullif(
          coalesce(
            current_setting('request.jwt.claim.sub', true),
            (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
          ),
          ''
        )::uuid
      $body$;
    $fn$;
  end if;
end;
$$;
