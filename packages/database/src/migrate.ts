/**
 * Migration runner.
 *
 * Deliberately small and boring: numbered SQL files, applied once, in order,
 * each inside its own transaction, under an advisory lock so two instances
 * starting at the same time cannot both apply the same file.
 *
 * Applied files are checksummed. Editing a migration that has already run is a
 * hard error rather than a silent divergence between environments.
 */
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type pg from 'pg';
import { getPool, withTransaction } from './pool.js';

/** Postgres advisory lock key. Arbitrary but stable. */
const MIGRATION_LOCK_KEY = 8_274_113_907_412_556n % 2147483647n;

export interface Migration {
  name: string;
  sql: string;
  checksum: string;
}

export function migrationsDirectory(): string {
  // Resolved relative to the compiled file so it works from `dist` and `src`.
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, '..', 'migrations');
}

export async function loadMigrations(directory = migrationsDirectory()): Promise<Migration[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.sql'))
    .map((entry) => entry.name)
    .sort();
  const migrations: Migration[] = [];
  for (const name of files) {
    const sql = await readFile(path.join(directory, name), 'utf8');
    migrations.push({
      name,
      sql,
      checksum: createHash('sha256').update(sql).digest('hex'),
    });
  }
  return migrations;
}

async function ensureLedger(pool: pg.Pool): Promise<void> {
  await pool.query(`
    create table if not exists public.schema_migrations (
      name       text primary key,
      checksum   text not null,
      applied_at timestamptz not null default now()
    )
  `);
  // This table lives in `public`, which Supabase publishes through PostgREST.
  // It has no policies and no grants, so it is invisible to every API role.
  await pool.query('alter table public.schema_migrations enable row level security');
  await pool.query(`
    do $$
    begin
      if exists (select 1 from pg_roles where rolname = 'anon') then
        revoke all on public.schema_migrations from anon;
      end if;
      if exists (select 1 from pg_roles where rolname = 'authenticated') then
        revoke all on public.schema_migrations from authenticated;
      end if;
    end;
    $$
  `);
}

export interface MigrateResult {
  applied: string[];
  skipped: string[];
}

export async function migrate(options: { pool?: pg.Pool; directory?: string } = {}): Promise<MigrateResult> {
  const pool = options.pool ?? getPool();
  await ensureLedger(pool);

  const client = await pool.connect();
  const applied: string[] = [];
  const skipped: string[] = [];
  try {
    // Serialise concurrent migrators. Released automatically on disconnect.
    await client.query('select pg_advisory_lock($1)', [MIGRATION_LOCK_KEY.toString()]);

    const existing = await client.query<{ name: string; checksum: string }>(
      'select name, checksum from public.schema_migrations',
    );
    const byName = new Map(existing.rows.map((row) => [row.name, row.checksum]));

    for (const migration of await loadMigrations(options.directory)) {
      const previous = byName.get(migration.name);
      if (previous !== undefined) {
        if (previous !== migration.checksum) {
          throw new Error(
            `Migration ${migration.name} has already been applied but its contents have changed. ` +
              'Add a new migration instead of editing an applied one.',
          );
        }
        skipped.push(migration.name);
        continue;
      }
      await withTransaction(async (tx) => {
        await tx.query(migration.sql);
        await tx.query(
          'insert into public.schema_migrations (name, checksum) values ($1, $2)',
          [migration.name, migration.checksum],
        );
      }, pool);
      applied.push(migration.name);
    }
  } finally {
    try {
      await client.query('select pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY.toString()]);
    } catch {
      // Lock is released by the disconnect below regardless.
    }
    client.release();
  }
  return { applied, skipped };
}

export interface MigrationStatus {
  name: string;
  applied: boolean;
  drifted: boolean;
}

export async function status(options: { pool?: pg.Pool; directory?: string } = {}): Promise<MigrationStatus[]> {
  const pool = options.pool ?? getPool();
  await ensureLedger(pool);
  const existing = await pool.query<{ name: string; checksum: string }>(
    'select name, checksum from public.schema_migrations',
  );
  const byName = new Map(existing.rows.map((row) => [row.name, row.checksum]));
  return (await loadMigrations(options.directory)).map((migration) => ({
    name: migration.name,
    applied: byName.has(migration.name),
    drifted: byName.has(migration.name) && byName.get(migration.name) !== migration.checksum,
  }));
}

/**
 * Drops everything this schema owns and re-applies it.
 *
 * Refuses to run unless `ALLOW_DESTRUCTIVE_RESET` is set, because pointing this
 * at a production `DATABASE_URL` by accident would delete every scan and
 * subscription record in the system.
 */
export async function reset(options: { pool?: pg.Pool; directory?: string } = {}): Promise<MigrateResult> {
  if (process.env.ALLOW_DESTRUCTIVE_RESET !== 'yes') {
    throw new Error(
      'Refusing to reset. Set ALLOW_DESTRUCTIVE_RESET=yes to confirm this is a disposable database.',
    );
  }
  const pool = options.pool ?? getPool();
  await pool.query(`
    drop table if exists
      public.schema_migrations,
      public.submission_throttle,
      public.stripe_events,
      public.usage_events,
      public.usage_counters,
      public.scan_reports,
      public.scan_jobs,
      public.subscriptions,
      public.profiles
    cascade
  `);
  await pool.query(`
    drop function if exists
      public.create_scan_job(uuid, text, text, text, text, text, integer, text, text, integer, integer, interval),
      public.release_scan_allowance(uuid),
      public.claim_scan_job(text),
      public.reap_stale_scan_jobs(interval),
      public.fail_scan_job(uuid, text),
      public.complete_scan_job(uuid, text, text, text, integer, jsonb, integer, integer, integer, integer, integer, integer, boolean),
      public.apply_stripe_subscription(uuid, text, text, text, text, timestamptz, timestamptz, boolean, timestamptz),
      public.handle_new_user(),
      public.touch_updated_at()
    cascade
  `);
  return migrate(options);
}
