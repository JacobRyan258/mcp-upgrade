import { promises as fs } from 'node:fs';
import path from 'node:path';
import fg from 'fast-glob';
import {
  ALWAYS_IGNORE_PATTERNS,
  BINARY_SNIFF_BYTES,
  SUPPORTED_EXTENSIONS,
  TEST_IGNORE_PATTERNS,
  TEST_FILE_SUFFIXES,
  TEST_PATH_SEGMENTS,
} from '../constants.js';
import type { FileKind, PreparedFile, Range, ResolvedScanOptions, SkipReason } from '../types.js';
import { computeCommentRanges, computeLineStarts } from './ast.js';

export interface DiscoveredFile {
  absPath: string;
  relPath: string;
}

export interface SkippedFile {
  relPath: string;
  reason: SkipReason;
  size?: number;
}

export interface DiscoveryResult {
  files: PreparedFile[];
  skipped: SkippedFile[];
}

/* -------------------------------------------------------------------------- */
/* Path helpers                                                                */
/* -------------------------------------------------------------------------- */

/** Normalises a path to POSIX separators so output is identical across platforms. */
export function toPosix(p: string): string {
  return p.split(path.sep).join('/');
}

export function extensionOf(relPath: string): string {
  return path.extname(relPath).toLowerCase();
}

export function kindForExtension(ext: string): FileKind | null {
  switch (ext) {
    case '.ts':
    case '.tsx':
      return 'ts';
    case '.js':
    case '.jsx':
    case '.mjs':
    case '.cjs':
      return 'js';
    case '.json':
      return 'json';
    case '.yaml':
    case '.yml':
      return 'yaml';
    default:
      return null;
  }
}

/** True when the path looks like test or fixture territory. */
export function isTestPath(relPath: string): boolean {
  const posix = toPosix(relPath);
  const segments = posix.split('/');
  const base = segments[segments.length - 1] ?? '';
  if (TEST_FILE_SUFFIXES.some((suffix) => base.endsWith(suffix))) return true;
  // Only directory segments count, so `src/testing-utils.ts` is not a test path
  // while `src/__tests__/utils.ts` is.
  return segments.slice(0, -1).some((segment) => TEST_PATH_SEGMENTS.includes(segment));
}

/**
 * Guards against escaping the scan root. `fast-glob` will not emit `..` paths,
 * but a symlink inside the tree can still point outside it, and a user-supplied
 * `--ignore` pattern can be malformed. Both are re-checked here against the
 * realpath of the root.
 */
async function isInsideRoot(absPath: string, realRoot: string): Promise<boolean> {
  let resolved: string;
  try {
    resolved = await fs.realpath(absPath);
  } catch {
    return false;
  }
  const rel = path.relative(realRoot, resolved);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * Converts a user-supplied ignore entry into glob patterns. A bare name such as
 * `dist` should match the directory anywhere in the tree, while an explicit
 * glob is passed through untouched.
 */
export function toIgnoreGlobs(pattern: string): string[] {
  const trimmed = pattern.trim();
  if (trimmed === '') return [];
  if (/[*?[\]{}!]/.test(trimmed)) return [trimmed];
  const normalized = trimmed.replace(/^\.\//, '').replace(/\/+$/, '');
  if (normalized === '') return [];
  return [`**/${normalized}`, `**/${normalized}/**`];
}

/* -------------------------------------------------------------------------- */
/* Binary detection                                                            */
/* -------------------------------------------------------------------------- */

/** A NUL byte in the first {@link BINARY_SNIFF_BYTES} marks the file as binary. */
export function looksBinary(buffer: Buffer): boolean {
  const end = Math.min(buffer.length, BINARY_SNIFF_BYTES);
  for (let i = 0; i < end; i++) {
    if (buffer[i] === 0) return true;
  }
  return false;
}

/* -------------------------------------------------------------------------- */
/* Discovery                                                                   */
/* -------------------------------------------------------------------------- */

export async function discover(options: ResolvedScanOptions): Promise<DiscoveryResult> {
  const realRoot = await fs.realpath(options.rootDir);
  const skipped: SkippedFile[] = [];

  const candidates: DiscoveredFile[] = options.singleFilePath
    ? [
        {
          absPath: options.singleFilePath,
          relPath: toPosix(path.relative(realRoot, options.singleFilePath)),
        },
      ]
    : await globCandidates(realRoot, options);

  const prepared: PreparedFile[] = [];

  for (const candidate of candidates) {
    const ext = extensionOf(candidate.relPath);
    const kind = kindForExtension(ext);
    if (!kind) {
      skipped.push({ relPath: candidate.relPath, reason: 'unsupported-extension' });
      continue;
    }

    if (!options.includeTests && isTestPath(candidate.relPath)) {
      skipped.push({ relPath: candidate.relPath, reason: 'test-path' });
      continue;
    }

    if (!(await isInsideRoot(candidate.absPath, realRoot))) {
      skipped.push({ relPath: candidate.relPath, reason: 'symlink-outside-root' });
      continue;
    }

    let size: number;
    try {
      const stat = await fs.stat(candidate.absPath);
      if (!stat.isFile()) {
        skipped.push({ relPath: candidate.relPath, reason: 'unreadable' });
        continue;
      }
      size = stat.size;
    } catch {
      skipped.push({ relPath: candidate.relPath, reason: 'unreadable' });
      continue;
    }

    if (size > options.maxFileBytes) {
      skipped.push({ relPath: candidate.relPath, reason: 'too-large', size });
      continue;
    }

    let buffer: Buffer;
    try {
      buffer = await fs.readFile(candidate.absPath);
    } catch {
      // Permission errors on individual files must not abort the scan.
      skipped.push({ relPath: candidate.relPath, reason: 'unreadable', size });
      continue;
    }

    if (looksBinary(buffer)) {
      skipped.push({ relPath: candidate.relPath, reason: 'binary', size });
      continue;
    }

    const content = buffer.toString('utf8');
    prepared.push(prepareFile(candidate, ext, kind, content, size));
  }

  prepared.sort((a, b) => a.relPath.localeCompare(b.relPath, 'en'));
  skipped.sort((a, b) => a.relPath.localeCompare(b.relPath, 'en'));

  return { files: prepared, skipped };
}

async function globCandidates(
  realRoot: string,
  options: ResolvedScanOptions,
): Promise<DiscoveredFile[]> {
  // `--include-tests` re-enables the fixture patterns, which is the whole
  // point of the flag; the build-output patterns are never re-enabled.
  const ignore = [
    ...ALWAYS_IGNORE_PATTERNS,
    ...(options.includeTests ? [] : TEST_IGNORE_PATTERNS),
    ...options.ignore,
  ].flatMap(toIgnoreGlobs);

  const entries = await fg(
    SUPPORTED_EXTENSIONS.map((ext) => `**/*${ext}`),
    {
      cwd: realRoot,
      ignore,
      dot: false,
      onlyFiles: true,
      followSymbolicLinks: false,
      suppressErrors: true,
      absolute: false,
      unique: true,
    },
  );

  return entries.map((relPath) => ({
    absPath: path.join(realRoot, relPath),
    relPath: toPosix(relPath),
  }));
}

function prepareFile(
  candidate: DiscoveredFile,
  ext: string,
  kind: FileKind,
  content: string,
  size: number,
): PreparedFile {
  return {
    absPath: candidate.absPath,
    relPath: candidate.relPath,
    ext,
    kind,
    content,
    size,
    lineStarts: computeLineStarts(content),
    commentRanges: computeCommentRanges(content, kind, ext),
    isTestPath: isTestPath(candidate.relPath),
  };
}

/* -------------------------------------------------------------------------- */
/* Position helpers                                                            */
/* -------------------------------------------------------------------------- */

export interface Position {
  /** 1-based. */
  line: number;
  /** 1-based. */
  column: number;
}

/** Converts a character offset to a 1-based line/column pair. */
export function offsetToPosition(file: PreparedFile, offset: number): Position {
  const starts = file.lineStarts;
  let low = 0;
  let high = starts.length - 1;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if ((starts[mid] ?? 0) <= offset) low = mid;
    else high = mid - 1;
  }
  return { line: low + 1, column: offset - (starts[low] ?? 0) + 1 };
}

/** Returns the full text of a 1-based line, without its terminator. */
export function lineText(file: PreparedFile, line: number): string {
  const start = file.lineStarts[line - 1];
  if (start === undefined) return '';
  const end = file.lineStarts[line] ?? file.content.length;
  return file.content.slice(start, end).replace(/\r?\n$/, '');
}

/** True when the offset falls inside a comment. */
export function isInComment(file: PreparedFile, offset: number): boolean {
  return inRanges(file.commentRanges, offset);
}

export function inRanges(ranges: Range[], offset: number): boolean {
  let low = 0;
  let high = ranges.length - 1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    const range = ranges[mid];
    if (!range) break;
    if (offset < range.start) high = mid - 1;
    else if (offset >= range.end) low = mid + 1;
    else return true;
  }
  return false;
}
