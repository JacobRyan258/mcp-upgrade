import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  DEFAULT_TARGET_VERSION,
  EXIT_FINDINGS,
  EXIT_OK,
  FAIL_ON_LEVELS,
  KNOWN_TARGETS,
  MAX_FILE_BYTES,
  MAX_FILES,
  MAX_TOTAL_BYTES,
  SUPPORTED_EXTENSIONS,
} from '../../constants.js';
import { renderChecklistReport } from '../../reporters/checklist.js';
import { renderJsonReport } from '../../reporters/json.js';
import { renderTextReport } from '../../reporters/text.js';
import { runScan } from '../../scanner/engine.js';
import type {
  Confidence,
  FailOnLevel,
  OutputFormat,
  ResolvedScanOptions,
  ScanReport,
} from '../../types.js';
import { UsageError } from '../../types.js';

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

const FORMATS: OutputFormat[] = ['text', 'json', 'checklist'];
const CONFIDENCES: Confidence[] = ['low', 'medium', 'high'];
const FAIL_ON: FailOnLevel[] = ['error', 'warning', 'review'];

export interface ResolveExtras {
  /**
   * Base directory for resolving a relative target. Defaults to
   * `process.cwd()`; embedding applications should pass it explicitly.
   */
  cwd?: string;
}

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
  const format = pickOne('format', raw.format ?? 'text', FORMATS);
  const minConfidence = pickOne('min-confidence', raw.minConfidence ?? 'low', CONFIDENCES);

  const target = raw.target ?? DEFAULT_TARGET_VERSION;
  if (!KNOWN_TARGETS[target]) {
    throw new UsageError(
      `Unknown target specification "${target}". Known targets: ${Object.keys(KNOWN_TARGETS)
        .sort()
        .join(', ')}.`,
    );
  }

  const ci = raw.ci === true;
  // `--fail-on` defaults to `error` under `--ci` and is otherwise inert.
  const failOn = pickOne('fail-on', raw.failOn ?? 'error', FAIL_ON);

  if (!targetPath || targetPath.trim() === '') {
    throw new UsageError('A path to scan is required. Usage: mcp-upgrade scan <path>');
  }

  let absolute = path.resolve(extras.cwd ?? process.cwd(), targetPath);

  let stat;
  try {
    stat = await fs.stat(absolute);
  } catch (cause) {
    const code = (cause as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') throw new UsageError(`Path does not exist: ${targetPath}`);
    if (code === 'EACCES' || code === 'EPERM') {
      throw new UsageError(`Path is not readable (permission denied): ${targetPath}`);
    }
    throw new UsageError(`Path could not be read: ${targetPath}`);
  }

  // Resolve symlinks up front (macOS /tmp is a symlink into /private) so every
  // downstream relative path is computed against the real location and never
  // degrades into a `../..`-polluted report path. A user who names a symlink
  // explicitly is asking for its target.
  try {
    absolute = await fs.realpath(absolute);
  } catch {
    throw new UsageError(`Path could not be resolved: ${targetPath}`);
  }

  let rootDir: string;
  let singleFilePath: string | null;

  if (stat.isDirectory()) {
    rootDir = absolute;
    singleFilePath = null;
    try {
      await fs.readdir(absolute);
    } catch {
      throw new UsageError(`Directory is not readable (permission denied): ${targetPath}`);
    }
  } else if (stat.isFile()) {
    const ext = path.extname(absolute).toLowerCase();
    if (!(SUPPORTED_EXTENSIONS as readonly string[]).includes(ext)) {
      throw new UsageError(
        `Unsupported file type "${ext || '(none)'}". Supported: ${SUPPORTED_EXTENSIONS.join(', ')}.`,
      );
    }
    try {
      await fs.access(absolute, fs.constants.R_OK);
    } catch {
      throw new UsageError(`File is not readable (permission denied): ${targetPath}`);
    }
    rootDir = path.dirname(absolute);
    singleFilePath = absolute;
  } else {
    throw new UsageError(`Path is neither a file nor a directory: ${targetPath}`);
  }

  const ignore = (raw.ignore ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '');

  // The report's `repository.root` is the target as the caller wrote it, so
  // the same invocation is deterministic regardless of working directory.
  const displayRoot = targetPath.split(path.sep).join('/').replace(/\/+$/, '') || '/';

  return {
    rootDir,
    singleFilePath,
    displayRoot,
    format,
    target,
    ignore,
    includeTests: raw.includeTests === true,
    minConfidence,
    ci,
    failOn,
    color: colorEnabled(raw, format),
    verbose: raw.verbose === true,
    maxFileBytes: MAX_FILE_BYTES,
    maxFiles: MAX_FILES,
    maxTotalBytes: MAX_TOTAL_BYTES,
  };
}

/**
 * Colour only reaches a terminal. Precedence: `--no-color` and `NO_COLOR`
 * always win; `FORCE_COLOR` (non-zero) re-enables colour for a pipe; otherwise
 * colour requires text format on an interactive stdout, so piped and
 * redirected output stays ANSI-free.
 */
function colorEnabled(raw: RawScanOptions, format: OutputFormat): boolean {
  if (format !== 'text') return false;
  if (raw.color === false || process.env.NO_COLOR) return false;
  const force = process.env.FORCE_COLOR;
  if (force !== undefined && force !== '' && force !== '0' && force !== 'false') return true;
  return process.stdout.isTTY === true;
}

function pickOne<T extends string>(flag: string, value: string, allowed: T[]): T {
  if ((allowed as string[]).includes(value)) return value as T;
  throw new UsageError(
    `Invalid value "${value}" for --${flag}. Allowed: ${allowed.join(', ')}.`,
  );
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
 * Exit code from the configured failure threshold. Without `--ci` the scanner
 * always exits 0 on a completed scan: reporting is not failing.
 */
export function computeExitCode(report: ScanReport, options: ResolvedScanOptions): number {
  if (!options.ci) return EXIT_OK;
  const failing = FAIL_ON_LEVELS[options.failOn];
  const total = failing.reduce((sum, level) => sum + report.summary.counts[level], 0);
  return total > 0 ? EXIT_FINDINGS : EXIT_OK;
}
