import { promises as fs } from 'node:fs';
import type { BigIntStats } from 'node:fs';
import path from 'node:path';
import {
  DEFAULT_TARGET_VERSION,
  KNOWN_TARGETS,
  MAX_FILE_BYTES,
  MAX_FILES,
  MAX_TOTAL_BYTES,
  SUPPORTED_EXTENSIONS,
} from './constants.js';
import { filesystemIdentity, sameFilesystemIdentity } from './filesystem-identity.js';
import type {
  Confidence,
  FailOnLevel,
  FilesystemIdentity,
  OutputFormat,
  ResolvedScanOptions,
} from './types.js';
import { UsageError } from './types.js';
import { sanitizeReportText } from './scanner/redaction.js';

const FORMATS: OutputFormat[] = ['text', 'json', 'checklist'];
const CONFIDENCES: Confidence[] = ['low', 'medium', 'high'];
const FAIL_ON: FailOnLevel[] = ['error', 'warning', 'review'];

const MAX_IGNORE_PATTERNS = 32;
const MAX_IGNORE_PATTERN_LENGTH = 512;
const UNSUPPORTED_GLOB_CHARACTERS = new Set(['[', ']', '{', '}', '!', '(', ')']);

/** Shared input accepted by the CLI adapter and the programmatic API. */
export interface ScanOptionInput {
  format?: string;
  target?: string;
  ignore?: string | string[];
  includeTests?: boolean;
  minConfidence?: string;
  ci?: boolean;
  failOn?: string;
  color?: boolean;
  verbose?: boolean;
}

export interface ResolveScanExtras {
  /** Base directory used to resolve a relative target. */
  cwd?: string;
}

/**
 * Validates and resolves scan input without importing the CLI or a reporter.
 * Invalid caller input always becomes a UsageError.
 */
export async function resolveScanOptions(
  targetPath: string,
  raw: ScanOptionInput,
  extras: ResolveScanExtras = {},
): Promise<ResolvedScanOptions> {
  if (typeof targetPath !== 'string' || targetPath.trim() === '') {
    throw new UsageError('A path to scan is required. Usage: mcp-upgrade scan <path>');
  }
  if (extras.cwd !== undefined && typeof extras.cwd !== 'string') {
    throw new UsageError('The scan working directory must be a string.');
  }
  validateOptionalBoolean('includeTests', raw.includeTests);
  validateOptionalBoolean('ci', raw.ci);
  validateOptionalBoolean('color', raw.color);
  validateOptionalBoolean('verbose', raw.verbose);

  const format = pickOne('format', raw.format ?? 'text', FORMATS);
  const minConfidence = pickOne(
    'min-confidence',
    raw.minConfidence ?? 'low',
    CONFIDENCES,
  );

  const targetValue: unknown = raw.target ?? DEFAULT_TARGET_VERSION;
  if (typeof targetValue !== 'string' || !Object.hasOwn(KNOWN_TARGETS, targetValue)) {
    throw new UsageError(
      `Unknown target specification "${diagnosticValue(targetValue)}". Known targets: ${Object.keys(KNOWN_TARGETS)
        .sort()
        .join(', ')}.`,
    );
  }
  const target = targetValue;

  const ci = raw.ci === true;
  const failOn = pickOne('fail-on', raw.failOn ?? 'error', FAIL_ON);

  let absolute: string;
  try {
    absolute = path.resolve(extras.cwd ?? process.cwd(), targetPath);
  } catch {
    throw new UsageError(`Path could not be resolved: ${diagnosticValue(targetPath)}`);
  }

  let stat: BigIntStats;
  try {
    stat = await fs.stat(absolute, { bigint: true });
  } catch (cause) {
    const code = (cause as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      throw new UsageError(`Path does not exist: ${diagnosticValue(targetPath)}`);
    }
    if (code === 'EACCES' || code === 'EPERM') {
      throw new UsageError(
        `Path is not readable (permission denied): ${diagnosticValue(targetPath)}`,
      );
    }
    throw new UsageError(`Path could not be read: ${diagnosticValue(targetPath)}`);
  }

  // Resolve an explicitly selected symlink once, then keep discovery inside the
  // resulting real root. Discovery itself does not follow directory symlinks.
  try {
    absolute = await fs.realpath(absolute);
  } catch {
    throw new UsageError(`Path could not be resolved: ${diagnosticValue(targetPath)}`);
  }

  let rootDir: string;
  let singleFilePath: string | null;

  if (stat.isDirectory()) {
    rootDir = absolute;
    singleFilePath = null;
    let handle: Awaited<ReturnType<typeof fs.opendir>> | undefined;
    try {
      handle = await fs.opendir(absolute);
      await handle.close();
    } catch (cause) {
      await handle?.close().catch(() => undefined);
      const code = (cause as NodeJS.ErrnoException).code;
      if (code === 'EACCES' || code === 'EPERM') {
        throw new UsageError(
          `Directory is not readable (permission denied): ${diagnosticValue(targetPath)}`,
        );
      }
      throw new UsageError(`Directory could not be read: ${diagnosticValue(targetPath)}`);
    }
  } else if (stat.isFile()) {
    const ext = path.extname(absolute).toLowerCase();
    if (!(SUPPORTED_EXTENSIONS as readonly string[]).includes(ext)) {
      throw new UsageError(
        `Unsupported file type "${diagnosticValue(ext || '(none)')}". Supported: ${SUPPORTED_EXTENSIONS.join(', ')}.`,
      );
    }
    try {
      await fs.access(absolute, fs.constants.R_OK);
    } catch {
      throw new UsageError(
        `File is not readable (permission denied): ${diagnosticValue(targetPath)}`,
      );
    }
    rootDir = path.dirname(absolute);
    singleFilePath = absolute;
  } else {
    throw new UsageError(
      `Path is neither a file nor a directory: ${diagnosticValue(targetPath)}`,
    );
  }

  const rootIdentity = await bindResolvedTarget(absolute, rootDir, stat, targetPath);

  const ignore = normalizeIgnorePatterns(raw.ignore);
  const displayRoot = targetPath.split(path.sep).join('/').replace(/\/+$/, '') || '/';

  return {
    rootDir,
    rootIdentity,
    singleFilePath,
    displayRoot,
    format,
    target,
    ignore,
    includeTests: raw.includeTests === true,
    minConfidence,
    ci,
    failOn,
    color: raw.color === true && format === 'text',
    verbose: raw.verbose === true,
    maxFileBytes: MAX_FILE_BYTES,
    maxFiles: MAX_FILES,
    maxTotalBytes: MAX_TOTAL_BYTES,
  };
}

async function bindResolvedTarget(
  targetPath: string,
  rootDir: string,
  initialTargetStat: BigIntStats,
  displayPath: string,
): Promise<FilesystemIdentity> {
  try {
    const rootBefore = await fs.lstat(rootDir, { bigint: true });
    const targetCurrent = await fs.lstat(targetPath, { bigint: true });
    const rootAfter = await fs.lstat(rootDir, { bigint: true });
    const expectedTarget = filesystemIdentity(initialTargetStat);
    const beforeIdentity = filesystemIdentity(rootBefore);
    const afterIdentity = filesystemIdentity(rootAfter);

    if (
      !rootBefore.isDirectory() ||
      rootBefore.isSymbolicLink() ||
      !rootAfter.isDirectory() ||
      rootAfter.isSymbolicLink() ||
      targetCurrent.isSymbolicLink() ||
      !sameFilesystemIdentity(expectedTarget, filesystemIdentity(targetCurrent)) ||
      !sameFilesystemIdentity(beforeIdentity, afterIdentity)
    ) {
      throw new Error('filesystem identity changed');
    }

    return Object.freeze(afterIdentity);
  } catch {
    throw new UsageError(
      `Path changed or could not be identity-verified while preparing the scan: ${diagnosticValue(displayPath)}`,
    );
  }
}

function normalizeIgnorePatterns(input: string | string[] | undefined): string[] {
  const entries = input === undefined ? [] : typeof input === 'string' ? input.split(',') : input;
  if (!Array.isArray(entries) || entries.some((entry) => typeof entry !== 'string')) {
    throw new UsageError('Ignore patterns must be strings.');
  }

  const normalized = entries.map((entry) => entry.trim()).filter((entry) => entry !== '');
  if (normalized.length > MAX_IGNORE_PATTERNS) {
    throw new UsageError(`At most ${MAX_IGNORE_PATTERNS} ignore patterns may be supplied.`);
  }

  for (const pattern of normalized) {
    if ([...pattern].some((character) => UNSUPPORTED_GLOB_CHARACTERS.has(character))) {
      throw new UsageError(
        `Unsupported ignore pattern syntax in "${diagnosticValue(pattern)}". Only *, **, and ? wildcards are supported.`,
      );
    }
    if (pattern.includes('\0')) {
      throw new UsageError('Ignore patterns must not contain NUL bytes.');
    }
    if (pattern.length > MAX_IGNORE_PATTERN_LENGTH) {
      throw new UsageError(
        `Ignore patterns must be at most ${MAX_IGNORE_PATTERN_LENGTH} characters.`,
      );
    }
  }

  return normalized;
}

function pickOne<T extends string>(flag: string, value: unknown, allowed: T[]): T {
  if (typeof value === 'string' && (allowed as string[]).includes(value)) return value as T;
  throw new UsageError(
    `Invalid value "${diagnosticValue(value)}" for --${flag}. Allowed: ${allowed.join(', ')}.`,
  );
}

function validateOptionalBoolean(name: string, value: unknown): void {
  if (value !== undefined && typeof value !== 'boolean') {
    throw new UsageError(`${name} must be a boolean.`);
  }
}

function diagnosticValue(value: unknown): string {
  return sanitizeReportText(String(value), 2_000);
}
