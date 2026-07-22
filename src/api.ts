import { runScan } from './scanner/engine.js';
import type { EngineOptions, ScanResult } from './scanner/engine.js';
import { resolveOptions } from './cli/commands/scan.js';
import type { Confidence, ScanReport } from './types.js';

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

/**
 * Scans a path and returns the full structured result: the report plus the
 * verbose trace and comment-only match records when `verbose` is set.
 */
export async function scan(
  options: ScanPathOptions,
  engineOptions: EngineOptions = {},
): Promise<ScanResult> {
  const resolved = await resolveOptions(
    options.path,
    {
      target: options.target,
      includeTests: options.includeTests,
      minConfidence: options.minimumConfidence,
      ignore: options.ignore?.join(','),
      verbose: options.verbose,
      // Machine consumers never want ANSI.
      color: false,
    },
    { cwd: options.cwd },
  );
  return runScan(resolved, engineOptions);
}

/**
 * Scans a path and returns just the {@link ScanReport} — the stable,
 * versioned JSON contract (`schemaVersion`).
 */
export async function scanPath(options: ScanPathOptions): Promise<ScanReport> {
  return (await scan(options)).report;
}
