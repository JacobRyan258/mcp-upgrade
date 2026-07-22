/**
 * The job model shared by the web app, the database layer and the worker.
 *
 * These are wire and storage contracts. They deliberately contain nothing about
 * *how* a scan runs — no paths, no queue internals, no worker identifiers that
 * would be meaningful to an attacker.
 */

/** Where the source code came from. */
export type ScanSourceType = 'zip' | 'github';

export const SCAN_STATUSES = [
  'queued',
  'running',
  'succeeded',
  'failed',
] as const;

export type ScanJobStatus = (typeof SCAN_STATUSES)[number];

export function isScanJobStatus(value: unknown): value is ScanJobStatus {
  return typeof value === 'string' && (SCAN_STATUSES as readonly string[]).includes(value);
}

/** A job in a terminal state will never change again. */
export function isTerminalStatus(status: ScanJobStatus): boolean {
  return status === 'succeeded' || status === 'failed';
}

/**
 * What a user is shown about one of their scans.
 *
 * Every field here is safe to serialise to the browser. There is intentionally
 * no worker identifier, no attempt counter, no storage key and no internal
 * error text.
 */
export interface ScanJobSummary {
  id: string;
  status: ScanJobStatus;
  sourceType: ScanSourceType;
  /** `owner/repo` or the uploaded file name. Already sanitized for display. */
  sourceLabel: string;
  /** Only set for GitHub scans. Normalized `https://github.com/owner/repo`. */
  repositoryUrl: string | null;
  /** Only set for GitHub scans, once resolved. */
  commitSha: string | null;
  targetVersion: string;
  scannerVersion: string | null;
  /** One of the closed `ScanErrorCategory` values, or null. */
  errorCategory: string | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  /** Present once a report exists. */
  readinessScore: number | null;
  /** Present once a report exists. */
  counts: { error: number; warning: number; review: number; info: number } | null;
  /** True when the scanner could not read every in-scope file. */
  partial: boolean | null;
}

/** Maximum characters of a user-supplied file name we keep for display. */
export const MAX_SOURCE_LABEL_LENGTH = 120;

/**
 * Reduces an uploaded file name to something safe to store and render.
 *
 * The result is used only as a label. It never touches the filesystem, but it
 * is still stripped of separators and control characters so that a hostile
 * name cannot be reused as a path or injected into a log line.
 */
export function toSourceLabel(rawName: unknown, fallback = 'upload.zip'): string {
  if (typeof rawName !== 'string') return fallback;
  let out = '';
  for (const character of rawName) {
    const code = character.codePointAt(0) ?? 0;
    // Drop control characters, path separators and bidi/format overrides.
    if (code <= 0x1f || code === 0x7f) continue;
    if (character === '/' || character === '\\') continue;
    if (code >= 0x202a && code <= 0x202e) continue;
    if (code >= 0x2066 && code <= 0x2069) continue;
    out += character;
    if (out.length >= MAX_SOURCE_LABEL_LENGTH) break;
  }
  out = out.trim();
  return out.length > 0 ? out : fallback;
}
