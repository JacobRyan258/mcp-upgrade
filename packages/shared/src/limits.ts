/**
 * Ingestion limits.
 *
 * Every one of these is enforced in the worker while streaming, before the
 * bytes concerned are ever written to disk. Plan-derived values come from
 * {@link PLANS}; the rest are absolute service ceilings that no plan raises.
 */
import type { PlanLimits } from './plans.js';

export interface IngestionLimits {
  /** Largest accepted archive, compressed. */
  maxArchiveBytes: number;
  /** Largest accepted total of all extracted files. */
  maxExpandedBytes: number;
  /** Largest number of files extracted. */
  maxFiles: number;
  /** Largest single extracted file. */
  maxFileBytes: number;
  /** Maximum directory nesting inside the archive. */
  maxDepth: number;
  /** Maximum length of any single entry path. */
  maxPathLength: number;
  /**
   * Maximum expanded:compressed ratio tolerated across the whole archive.
   * A zip bomb is characterised by an enormous ratio, not by absolute size.
   */
  maxCompressionRatio: number;
  /** Milliseconds a single scan job may run before it is killed. */
  timeoutMs: number;
}

/** Ceilings that apply to every plan. A plan can lower these, never raise them. */
export const ABSOLUTE_LIMITS = Object.freeze({
  maxArchiveBytes: 250 * 1024 * 1024,
  maxExpandedBytes: 1536 * 1024 * 1024,
  maxFiles: 60_000,
  maxFileBytes: 8 * 1024 * 1024,
  maxDepth: 32,
  maxPathLength: 1024,
  maxCompressionRatio: 200,
  timeoutMs: 10 * 60 * 1000,
});

export function ingestionLimitsFor(
  plan: Pick<PlanLimits, 'maxArchiveBytes' | 'maxExpandedBytes' | 'maxFiles'>,
  overrides: Partial<IngestionLimits> = {},
): IngestionLimits {
  const merged: IngestionLimits = {
    maxArchiveBytes: plan.maxArchiveBytes,
    maxExpandedBytes: plan.maxExpandedBytes,
    maxFiles: plan.maxFiles,
    maxFileBytes: ABSOLUTE_LIMITS.maxFileBytes,
    maxDepth: ABSOLUTE_LIMITS.maxDepth,
    maxPathLength: ABSOLUTE_LIMITS.maxPathLength,
    maxCompressionRatio: ABSOLUTE_LIMITS.maxCompressionRatio,
    timeoutMs: ABSOLUTE_LIMITS.timeoutMs,
    ...overrides,
  };
  // Clamp every field so a misconfigured environment variable or a future plan
  // definition can never widen the service's exposure.
  return {
    maxArchiveBytes: clamp(merged.maxArchiveBytes, ABSOLUTE_LIMITS.maxArchiveBytes),
    maxExpandedBytes: clamp(merged.maxExpandedBytes, ABSOLUTE_LIMITS.maxExpandedBytes),
    maxFiles: clamp(merged.maxFiles, ABSOLUTE_LIMITS.maxFiles),
    maxFileBytes: clamp(merged.maxFileBytes, ABSOLUTE_LIMITS.maxFileBytes),
    maxDepth: clamp(merged.maxDepth, ABSOLUTE_LIMITS.maxDepth),
    maxPathLength: clamp(merged.maxPathLength, ABSOLUTE_LIMITS.maxPathLength),
    maxCompressionRatio: clamp(merged.maxCompressionRatio, ABSOLUTE_LIMITS.maxCompressionRatio),
    timeoutMs: clamp(merged.timeoutMs, ABSOLUTE_LIMITS.timeoutMs),
  };
}

function clamp(value: number, ceiling: number): number {
  if (!Number.isFinite(value) || value <= 0) return ceiling;
  return Math.min(Math.floor(value), ceiling);
}

/** Human-readable byte size, e.g. "20 MB". Used in UI copy and error text. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const rounded = value >= 10 ? Math.round(value) : Math.round(value * 10) / 10;
  return `${rounded} ${units[unit]}`;
}
