import { runScan } from './scanner/engine.js';
import { resolveScanOptions } from './options.js';
import type { Confidence, ScanReport } from './types.js';
import { InternalScannerError, UsageError } from './types.js';

/**
 * High-level programmatic API.
 *
 * This is the entry point embedding applications should use. It performs the
 * same validation and scan the CLI runs, but never writes to stdout, never
 * exits the process and holds no global state. Invalid input throws
 * `UsageError`; an unexpected internal failure throws `InternalScannerError`
 * (both exported from this package).
 */
export interface ScanPathOptions {
  /** Directory or single source file to scan. Relative paths resolve against `cwd`. */
  path: string;
  /**
   * Base directory for resolving a relative `path`. Defaults to
   * `process.cwd()`. Server environments should pass it explicitly so
   * concurrent scans never depend on the process working directory.
   */
  cwd?: string;
  /** Target MCP specification revision. Defaults to `"2026-07-28"`. */
  target?: string;
  /** Include test and fixture directories. Defaults to `false`. */
  includeTests?: boolean;
  /** Minimum confidence for reported findings. Defaults to `"low"`. */
  minimumConfidence?: Confidence;
  /** Additional ignore patterns (same semantics as the CLI `--ignore`). */
  ignore?: string[];
  /** Collect the rule-execution trace into the result. Defaults to `false`. */
  verbose?: boolean;
}

export interface CommentOnlyMatch {
  ruleId: string;
  file: string;
  line: number;
  text: string;
}

export interface ScanResult {
  report: ScanReport;
  /** Verbose diagnostics. Empty unless `verbose` was requested. */
  trace: string[];
  commentOnlyMatches: CommentOnlyMatch[];
}

/**
 * Scans a path and returns the full structured result: the report plus the
 * verbose trace and comment-only match records when `verbose` is set.
 */
export async function scan(options: ScanPathOptions): Promise<ScanResult> {
  if (typeof options !== 'object' || options === null) {
    throw new UsageError('scan() requires an options object.');
  }
  const resolved = await resolveScanOptions(
    options.path,
    {
      target: options.target,
      includeTests: options.includeTests,
      minConfidence: options.minimumConfidence,
      ignore: options.ignore,
      verbose: options.verbose,
      // Machine consumers never want ANSI.
      color: false,
    },
    { cwd: options.cwd },
  );
  try {
    return await runScan(resolved);
  } catch (cause) {
    if (cause instanceof InternalScannerError) throw cause;
    throw new InternalScannerError('The scanner failed while processing the selected path.', cause);
  }
}

/**
 * Scans a path and returns just the {@link ScanReport} — the stable,
 * versioned JSON contract (`schemaVersion`).
 */
export async function scanPath(options: ScanPathOptions): Promise<ScanReport> {
  return (await scan(options)).report;
}
