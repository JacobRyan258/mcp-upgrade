import {
  EXIT_FINDINGS,
  EXIT_OK,
  EXIT_USAGE,
  FAIL_ON_LEVELS,
} from '../../constants.js';
import { resolveScanOptions } from '../../options.js';
import type { ResolveScanExtras } from '../../options.js';
import { renderChecklistReport } from '../../reporters/checklist.js';
import { renderJsonReport } from '../../reporters/json.js';
import { renderTextReport } from '../../reporters/text.js';
import { runScan } from '../../scanner/engine.js';
import type { OutputFormat, ResolvedScanOptions, ScanReport } from '../../types.js';

/** Raw option values as commander produces them. */
export interface RawScanOptions {
  format?: string;
  target?: string;
  ignore?: string;
  includeTests?: boolean;
  minConfidence?: string;
  ci?: boolean;
  failOn?: string;
  color?: boolean;
  verbose?: boolean;
}

export interface ScanCommandResult {
  exitCode: number;
  stdout: string;
  report: ScanReport;
}

export type ResolveExtras = ResolveScanExtras;

/**
 * Validates CLI input and resolves it against the filesystem.
 *
 * Everything that can be wrong with the invocation is caught here and raised as
 * a {@link UsageError}, which the entrypoint maps to exit code 2. That keeps
 * exit code 1 meaning exactly one thing: findings reached the threshold.
 */
export async function resolveOptions(
  targetPath: string,
  raw: RawScanOptions,
  extras: ResolveExtras = {},
): Promise<ResolvedScanOptions> {
  const options = await resolveScanOptions(targetPath, { ...raw, color: false }, extras);
  return { ...options, color: colorEnabled(raw, options.format) };
}

/**
 * Colour only reaches a terminal. Precedence: `--no-color` and `NO_COLOR`
 * always win; `FORCE_COLOR` (non-zero) re-enables colour for a pipe; otherwise
 * colour requires text format on an interactive stdout, so piped and
 * redirected output stays ANSI-free.
 */
function colorEnabled(raw: RawScanOptions, format: OutputFormat): boolean {
  if (format !== 'text') return false;
  if (raw.color === false || process.env.NO_COLOR !== undefined) return false;
  const force = process.env.FORCE_COLOR;
  if (force !== undefined && force !== '' && force !== '0' && force !== 'false') return true;
  return process.stdout.isTTY === true;
}

export async function runScanCommand(
  targetPath: string,
  raw: RawScanOptions,
): Promise<ScanCommandResult> {
  const options = await resolveOptions(targetPath, raw);
  const { report, trace, commentOnlyMatches } = await runScan(options);

  let stdout: string;
  switch (options.format) {
    case 'json':
      stdout = renderJsonReport(report);
      break;
    case 'checklist':
      stdout = renderChecklistReport(report);
      break;
    case 'text':
    default:
      stdout = renderTextReport(report, {
        color: options.color,
        verbose: options.verbose,
        trace,
        commentOnlyMatches,
      });
      break;
  }

  return { exitCode: computeExitCode(report, options), stdout, report };
}

/**
 * Partial scans fail closed regardless of reporting mode. For complete scans,
 * the finding threshold is enforced only under `--ci`.
 */
export function computeExitCode(report: ScanReport, options: ResolvedScanOptions): number {
  if (report.scanStatus === 'partial') return EXIT_USAGE;
  if (!options.ci) return EXIT_OK;
  const failing = FAIL_ON_LEVELS[options.failOn];
  const total = failing.reduce((sum, level) => sum + report.summary.counts[level], 0);
  return total > 0 ? EXIT_FINDINGS : EXIT_OK;
}
