/**
 * Server-only database layer.
 *
 * Importing this module from browser code is a bug: it pulls in `pg` and reads
 * `DATABASE_URL`. The web app imports it exclusively from route handlers,
 * server components and server actions.
 */
export {
  getPool,
  setPool,
  closePool,
  query,
  withTransaction,
} from './pool.js';
export type { PoolOptions } from './pool.js';

export { migrate, reset, status, loadMigrations, migrationsDirectory } from './migrate.js';
export type { Migration, MigrateResult, MigrationStatus } from './migrate.js';

export {
  createScanJob,
  listScanJobs,
  getScanJob,
  getScanReport,
  countScanJobs,
  claimScanJob,
  reapStaleJobs,
  failScanJob,
  completeScanJob,
  queueDepth,
  ensureDatabase,
} from './jobs.js';
export type {
  ClaimedJob,
  CompleteScanJobInput,
  CreateScanJobInput,
  CreateScanJobResult,
} from './jobs.js';

export {
  getSubscription,
  findUserByStripeCustomer,
  linkStripeCustomer,
  applySubscription,
  claimStripeEvent,
  finishStripeEvent,
  releaseStripeEvent,
} from './billing.js';
export type {
  ApplySubscriptionInput,
  ApplySubscriptionOutcome,
  EventClaim,
  SubscriptionRecord,
} from './billing.js';

export {
  getUsage,
  releaseAllowance,
  getProfile,
  ensureProfile,
  updateDisplayName,
} from './usage.js';
export type { ProfileRecord, UsageSnapshot } from './usage.js';
