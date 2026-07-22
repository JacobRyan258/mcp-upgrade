/**
 * The worker's internal failure type.
 *
 * Every failure path in the worker throws `IngestionError` carrying one of the
 * closed `ScanErrorCategory` values. That category is the *only* thing that
 * reaches the database and therefore the user; `detail` exists for the
 * structured log and never leaves the process.
 */
import type { ScanErrorCategory } from '@mcp-upgrade/shared';

export class IngestionError extends Error {
  override readonly name = 'IngestionError';
  readonly category: ScanErrorCategory;
  /** Operator-facing context. Logged, never returned to a user. */
  readonly detail: string;

  constructor(category: ScanErrorCategory, detail: string, options?: { cause?: unknown }) {
    // The message deliberately carries only the category, so that an accidental
    // `String(error)` anywhere in the pipeline cannot leak internals.
    super(category);
    this.category = category;
    this.detail = detail;
    if (options?.cause !== undefined) this.cause = options.cause;
  }
}

export function isIngestionError(value: unknown): value is IngestionError {
  return value instanceof IngestionError;
}

/**
 * Maps anything thrown into a category.
 *
 * The default is `internal_error`, which is both the safest thing to show a
 * user and the thing that refunds their allowance.
 */
export function categorise(error: unknown): ScanErrorCategory {
  return isIngestionError(error) ? error.category : 'internal_error';
}

/** Operator-facing detail for a log line. Never sent to a browser. */
export function detailOf(error: unknown): string {
  if (isIngestionError(error)) return error.detail;
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return 'non-error thrown';
}
