import { constants as fsConstants, promises as fs } from 'node:fs';
import type { BigIntStats, Dir, Stats } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import path from 'node:path';
import {
  ALWAYS_IGNORE_PATTERNS,
  MAX_FILES,
  MAX_PARSE_TOKENS_PER_FILE,
  MAX_PARSE_TOKENS_TOTAL,
  MAX_SOURCE_LINES_PER_FILE,
  MAX_SOURCE_LINES_TOTAL,
  MAX_SOURCE_LINE_LENGTH,
  SUPPORTED_EXTENSIONS,
  TEST_FILE_SUFFIXES,
  TEST_PATH_SEGMENTS,
} from '../constants.js';
import type {
  FileKind,
  FilesystemIdentity,
  PreparedFile,
  Range,
  ResolvedScanOptions,
  SkipReason,
} from '../types.js';
import { filesystemIdentity, sameFilesystemIdentity } from '../filesystem-identity.js';
import { compareCodeUnits } from '../order.js';
import { computeCommentRangesForFile, preflightSource } from './ast.js';

export interface DiscoveredFile {
  absPath: string;
  relPath: string;
}

export interface SkippedFile {
  relPath: string;
  reason: SkipReason;
  entryType: 'file' | 'directory' | 'other';
  size?: number;
}

export interface DiscoveryResult {
  files: PreparedFile[];
  skipped: SkippedFile[];
}

interface QueuedDirectory {
  absPath: string;
  relPath: string;
  depth: number;
}

interface OpenedFile {
  handle: FileHandle;
  stat: Stats;
}

export interface DiscoveryInternals {
  /** Test seam for deterministic directory-replacement races. */
  openDirectory?: (absPath: string) => Promise<Dir>;
}

interface DirectoryIdentity {
  dev: bigint;
  ino: bigint;
  mode: bigint;
  ctimeNs: bigint;
  mtimeNs: bigint;
}

const SUPPORTED_EXTENSION_SET = new Set<string>(SUPPORTED_EXTENSIONS);

/** Bounds directory enumeration independently of the supported-file budget. */
const MAX_DISCOVERY_ENTRIES = 100_000;
const MAX_DIRECTORY_DEPTH = 64;
/** Includes candidates, queued directories and detailed discovery skips. */
const MAX_DISCOVERY_RECORDS = MAX_FILES + 5_000;
/** Prevents a deep hostile tree from retaining very large path strings. */
const MAX_RETAINED_RELATIVE_PATH_LENGTH = 2_048;

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
  const posix = toPosix(relPath).toLowerCase();
  const segments = posix.split('/');
  const base = segments[segments.length - 1] ?? '';
  if (TEST_FILE_SUFFIXES.some((suffix) => base.endsWith(suffix.toLowerCase()))) return true;
  return segments
    .slice(0, -1)
    .some((segment) => TEST_PATH_SEGMENTS.some((candidate) => candidate.toLowerCase() === segment));
}

function isPathInsideRoot(candidate: string, realRoot: string): boolean {
  const rel = path.relative(realRoot, candidate);
  return (
    rel === '' ||
    (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel))
  );
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

type IgnoreMatcher = (relPath: string) => boolean;

/** Compiles the supported glob subset without a backtracking regular expression. */
function compileGlob(glob: string): IgnoreMatcher {
  const patternSegments = toPosix(glob)
    .replace(/^\.\//, '')
    .toLowerCase()
    .split('/')
    .map((segment) => (/^\*{2,}$/.test(segment) ? '**' : segment.replace(/\*+/g, '*')));

  return (relPath) => matchGlobSegments(patternSegments, toPosix(relPath).toLowerCase().split('/'));
}

function matchGlobSegments(pattern: string[], value: string[]): boolean {
  let patternIndex = 0;
  let valueIndex = 0;
  let globstarIndex = -1;
  let globstarValueIndex = -1;

  while (valueIndex < value.length) {
    const segment = pattern[patternIndex];
    if (segment === '**') {
      globstarIndex = patternIndex++;
      globstarValueIndex = valueIndex;
      continue;
    }
    if (segment !== undefined && matchGlobSegment(segment, value[valueIndex] as string)) {
      patternIndex++;
      valueIndex++;
      continue;
    }
    if (globstarIndex < 0) return false;
    patternIndex = globstarIndex + 1;
    valueIndex = ++globstarValueIndex;
  }

  while (pattern[patternIndex] === '**') patternIndex++;
  return patternIndex === pattern.length;
}

function matchGlobSegment(pattern: string, value: string): boolean {
  let patternIndex = 0;
  let valueIndex = 0;
  let starIndex = -1;
  let starValueIndex = -1;

  while (valueIndex < value.length) {
    const character = pattern[patternIndex];
    if (character === '?' || character === value[valueIndex]) {
      patternIndex++;
      valueIndex++;
      continue;
    }
    if (character === '*') {
      starIndex = patternIndex++;
      starValueIndex = valueIndex;
      continue;
    }
    if (starIndex < 0) return false;
    patternIndex = starIndex + 1;
    valueIndex = ++starValueIndex;
  }

  while (pattern[patternIndex] === '*') patternIndex++;
  return patternIndex === pattern.length;
}

function ignoreMatchers(options: ResolvedScanOptions): IgnoreMatcher[] {
  return [...ALWAYS_IGNORE_PATTERNS, ...options.ignore]
    .flatMap(toIgnoreGlobs)
    .map(compileGlob);
}

function isIgnored(relPath: string, matchers: IgnoreMatcher[]): boolean {
  return matchers.some((matcher) => matcher(relPath));
}

/* -------------------------------------------------------------------------- */
/* Binary and text validation                                                  */
/* -------------------------------------------------------------------------- */

/** A NUL byte anywhere in a bounded file marks the file as binary. */
export function looksBinary(buffer: Buffer): boolean {
  return buffer.includes(0);
}

function decodeUtf8(buffer: Buffer): string | null {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    return null;
  }
}

/* -------------------------------------------------------------------------- */
/* Discovery                                                                   */
/* -------------------------------------------------------------------------- */

export async function discover(
  options: ResolvedScanOptions,
  internals: DiscoveryInternals = {},
): Promise<DiscoveryResult> {
  if (!(await rootIdentityHolds(options))) {
    return {
      files: [],
      skipped: [{ relPath: '.', reason: 'root-changed', entryType: 'directory' }],
    };
  }
  const realRoot = await fs.realpath(options.rootDir);
  const skipped: SkippedFile[] = [];

  const candidates = options.singleFilePath
    ? [
        {
          absPath: options.singleFilePath,
          relPath: toPosix(path.relative(realRoot, options.singleFilePath)),
        },
      ]
    : await walkCandidates(realRoot, options, skipped, internals);

  candidates.sort((a, b) => compareCodeUnits(a.relPath, b.relPath));

  const prepared: PreparedFile[] = [];
  let totalBytesRead = 0;
  let candidatesInspected = 0;
  let totalTokensInspected = 0;
  let totalLinesInspected = 0;

  for (const candidate of candidates) {
    const ext = extensionOf(candidate.relPath);
    const kind = kindForExtension(ext);
    if (!kind) {
      skipped.push({ relPath: candidate.relPath, reason: 'unsupported-extension', entryType: 'file' });
      continue;
    }

    if (!options.includeTests && options.singleFilePath === null && isTestPath(candidate.relPath)) {
      skipped.push({ relPath: candidate.relPath, reason: 'test-path', entryType: 'file' });
      continue;
    }

    if (candidatesInspected >= options.maxFiles) {
      skipped.push({ relPath: candidate.relPath, reason: 'scan-limit', entryType: 'file' });
      continue;
    }
    candidatesInspected++;

    const opened = await openInsideRoot(candidate.absPath, realRoot);
    if ('reason' in opened) {
      skipped.push({ relPath: candidate.relPath, reason: opened.reason, entryType: 'file' });
      continue;
    }

    const { handle, stat } = opened;
    try {
      if (stat.size > options.maxFileBytes) {
        skipped.push({ relPath: candidate.relPath, reason: 'too-large', entryType: 'file', size: stat.size });
        continue;
      }

      if (totalBytesRead + stat.size > options.maxTotalBytes) {
        skipped.push({ relPath: candidate.relPath, reason: 'scan-limit', entryType: 'file', size: stat.size });
        continue;
      }

      let buffer: Buffer;
      try {
        buffer = await readBounded(handle, options.maxFileBytes + 1);
      } catch {
        skipped.push({ relPath: candidate.relPath, reason: 'unreadable', entryType: 'file', size: stat.size });
        continue;
      }

      const actualSize = buffer.length;
      totalBytesRead += actualSize;
      if (actualSize > options.maxFileBytes) {
        skipped.push({ relPath: candidate.relPath, reason: 'too-large', entryType: 'file', size: actualSize });
        continue;
      }
      if (totalBytesRead > options.maxTotalBytes) {
        skipped.push({ relPath: candidate.relPath, reason: 'scan-limit', entryType: 'file', size: actualSize });
        continue;
      }
      if (looksBinary(buffer)) {
        skipped.push({ relPath: candidate.relPath, reason: 'binary', entryType: 'file', size: actualSize });
        continue;
      }

      const content = decodeUtf8(buffer);
      if (content === null) {
        skipped.push({ relPath: candidate.relPath, reason: 'invalid-utf8', entryType: 'file', size: actualSize });
        continue;
      }

      const tokenize = kind !== 'yaml';
      const preflight = preflightSource(content, ext, tokenize, {
        maxTokens: Math.min(
          MAX_PARSE_TOKENS_PER_FILE,
          Math.max(0, MAX_PARSE_TOKENS_TOTAL - totalTokensInspected),
        ),
        maxLines: Math.min(
          MAX_SOURCE_LINES_PER_FILE,
          Math.max(0, MAX_SOURCE_LINES_TOTAL - totalLinesInspected),
        ),
        maxStructuralLineLength: MAX_SOURCE_LINE_LENGTH,
      });
      totalLinesInspected = Math.min(
        MAX_SOURCE_LINES_TOTAL + 1,
        totalLinesInspected + preflight.linesInspected,
      );
      if (tokenize) {
        totalTokensInspected = Math.min(
          MAX_PARSE_TOKENS_TOTAL + 1,
          totalTokensInspected + preflight.tokensInspected,
        );
      }
      if (preflight.exceeded !== null) {
        skipped.push({
          relPath: candidate.relPath,
          reason: 'complexity-limit',
          entryType: 'file',
          size: actualSize,
        });
        continue;
      }

      const file = prepareFile(
        candidate,
        ext,
        kind,
        content,
        actualSize,
        preflight.lineStarts,
      );
      const commentRanges = computeCommentRangesForFile(file);
      if (commentRanges === null) {
        skipped.push({ relPath: candidate.relPath, reason: 'parse-failure', entryType: 'file', size: actualSize });
        continue;
      }
      file.commentRanges = commentRanges;
      prepared.push(file);
    } finally {
      await handle.close().catch(() => undefined);
    }
  }

  prepared.sort((a, b) => compareCodeUnits(a.relPath, b.relPath));
  skipped.sort(
    (a, b) =>
      compareCodeUnits(a.relPath, b.relPath) || compareCodeUnits(a.reason, b.reason),
  );

  return { files: prepared, skipped };
}

async function walkCandidates(
  realRoot: string,
  options: ResolvedScanOptions,
  skipped: SkippedFile[],
  internals: DiscoveryInternals,
): Promise<DiscoveredFile[]> {
  const matchers = ignoreMatchers(options);
  const openDirectory = internals.openDirectory ?? fs.opendir;
  const candidates: DiscoveredFile[] = [];
  const directories: QueuedDirectory[] = [{ absPath: realRoot, relPath: '', depth: 0 }];
  let directoryIndex = 0;
  let entriesVisited = 0;
  let discoveryLimitReached = false;

  const retainedRecords = (): number => candidates.length + directories.length + skipped.length;
  const recordDiscoveryLimit = (directory: QueuedDirectory): void => {
    if (discoveryLimitReached) return;
    if (retainedRecords() < MAX_DISCOVERY_RECORDS) {
      skipped.push({
        relPath: directory.relPath || '.',
        reason: 'discovery-limit',
        entryType: 'other',
      });
    }
    discoveryLimitReached = true;
  };
  const recordDirectoryFailure = (directory: QueuedDirectory): void => {
    if (retainedRecords() >= MAX_DISCOVERY_RECORDS - 1) {
      recordDiscoveryLimit(directory);
      return;
    }
    skipped.push({
      relPath: directory.relPath || '.',
      reason: 'unreadable-directory',
      entryType: 'directory',
    });
  };

  let rootChanged = false;
  while (directoryIndex < directories.length && !discoveryLimitReached && !rootChanged) {
    const directory = directories[directoryIndex++] as QueuedDirectory;
    const identityBefore = await snapshotDirectoryChain(
      directory.absPath,
      realRoot,
      options.rootIdentity,
    );
    if (identityBefore === 'root-changed') {
      rootChanged = true;
      continue;
    }
    if (identityBefore === null) {
      recordDirectoryFailure(directory);
      continue;
    }

    const stagedCandidates: DiscoveredFile[] = [];
    const stagedSkipped: SkippedFile[] = [];
    const stagedChildren: QueuedDirectory[] = [];
    let stagedEntriesVisited = entriesVisited;
    let stagedDiscoveryLimit = false;
    let handle: Dir | undefined;
    try {
      handle = await openDirectory(directory.absPath);
      const identityAfterOpen = await snapshotDirectoryChain(
        directory.absPath,
        realRoot,
        options.rootIdentity,
      );
      if (
        identityAfterOpen === null ||
        identityAfterOpen === 'root-changed' ||
        !sameDirectoryChain(identityBefore, identityAfterOpen)
      ) {
        await handle.close().catch(() => undefined);
        handle = undefined;
        if (identityAfterOpen === 'root-changed') rootChanged = true;
        else recordDirectoryFailure(directory);
        continue;
      }

      for await (const entry of handle) {
        stagedEntriesVisited++;
        const relPath = toPosix(path.join(directory.relPath, entry.name));
        if (
          stagedEntriesVisited > MAX_DISCOVERY_ENTRIES ||
          relPath.length > MAX_RETAINED_RELATIVE_PATH_LENGTH
        ) {
          stagedSkipped.push({
            relPath: directory.relPath || '.',
            reason: 'discovery-limit',
            entryType: 'other',
          });
          stagedDiscoveryLimit = true;
          break;
        }
        if (isIgnored(relPath, matchers)) continue;

        const absPath = path.join(directory.absPath, entry.name);
        const hasRecordCapacity = (): boolean =>
          retainedRecords() +
            stagedCandidates.length +
            stagedSkipped.length +
            stagedChildren.length <
          MAX_DISCOVERY_RECORDS - 1;
        const stopAtRecordLimit = (): void => {
          stagedSkipped.push({
            relPath: directory.relPath || '.',
            reason: 'discovery-limit',
            entryType: 'other',
          });
          stagedDiscoveryLimit = true;
        };

        if (entry.isSymbolicLink()) {
          if (!hasRecordCapacity()) {
            stopAtRecordLimit();
            break;
          }
          stagedSkipped.push({
            relPath,
            reason: await symlinkReason(absPath, realRoot),
            entryType: 'other',
          });
          continue;
        }
        if (entry.isDirectory()) {
          if (!hasRecordCapacity()) {
            stopAtRecordLimit();
            break;
          }
          if (!options.includeTests && isTestDirectory(relPath)) {
            stagedSkipped.push({ relPath, reason: 'test-path', entryType: 'directory' });
            continue;
          }
          if (directory.depth >= MAX_DIRECTORY_DEPTH) {
            stagedSkipped.push({ relPath, reason: 'depth-limit', entryType: 'directory' });
            continue;
          }
          stagedChildren.push({ absPath, relPath, depth: directory.depth + 1 });
          continue;
        }
        if (entry.isFile()) {
          if (SUPPORTED_EXTENSION_SET.has(extensionOf(relPath))) {
            if (!hasRecordCapacity()) {
              stopAtRecordLimit();
              break;
            }
            stagedCandidates.push({ absPath, relPath });
          }
          continue;
        }
        if (SUPPORTED_EXTENSION_SET.has(extensionOf(relPath))) {
          if (!hasRecordCapacity()) {
            stopAtRecordLimit();
            break;
          }
          stagedSkipped.push({ relPath, reason: 'unreadable', entryType: 'other' });
        }
      }
      handle = undefined;

      const identityAfterEnumeration = await snapshotDirectoryChain(
        directory.absPath,
        realRoot,
        options.rootIdentity,
      );
      if (
        identityAfterEnumeration === null ||
        identityAfterEnumeration === 'root-changed' ||
        !sameDirectoryChain(identityBefore, identityAfterEnumeration)
      ) {
        if (identityAfterEnumeration === 'root-changed') rootChanged = true;
        else recordDirectoryFailure(directory);
        continue;
      }
    } catch {
      await handle?.close().catch(() => undefined);
      recordDirectoryFailure(directory);
      continue;
    }

    entriesVisited = stagedEntriesVisited;
    stagedChildren.sort((a, b) => compareCodeUnits(a.relPath, b.relPath));
    candidates.push(...stagedCandidates);
    skipped.push(...stagedSkipped);
    directories.push(...stagedChildren);
    if (stagedDiscoveryLimit) discoveryLimitReached = true;
  }

  if (rootChanged) {
    // The scan root is no longer the object bound during option resolution;
    // everything already staged from it is untrustworthy, so stop and report.
    skipped.push({ relPath: '.', reason: 'root-changed', entryType: 'directory' });
    return [];
  }

  return candidates;
}

/**
 * Re-verifies that the scan root is still the exact filesystem object bound
 * during option resolution, so a root swapped after validation is never read.
 */
async function rootIdentityHolds(options: ResolvedScanOptions): Promise<boolean> {
  try {
    const stat = await fs.lstat(options.rootDir, { bigint: true });
    return (
      stat.isDirectory() &&
      !stat.isSymbolicLink() &&
      sameFilesystemIdentity(filesystemIdentity(stat), options.rootIdentity)
    );
  } catch {
    return false;
  }
}

function isTestDirectory(relPath: string): boolean {
  const segment = toPosix(relPath).toLowerCase().split('/').at(-1) ?? '';
  return TEST_PATH_SEGMENTS.some((candidate) => candidate.toLowerCase() === segment);
}

async function snapshotDirectoryChain(
  absPath: string,
  realRoot: string,
  expectedRoot: FilesystemIdentity,
): Promise<DirectoryIdentity[] | 'root-changed' | null> {
  const relative = path.relative(realRoot, absPath);
  if (
    relative === '..' ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    return null;
  }

  const paths = [realRoot];
  let current = realRoot;
  if (relative !== '') {
    for (const segment of relative.split(path.sep)) {
      if (segment === '' || segment === '.' || segment === '..') return null;
      current = path.join(current, segment);
      paths.push(current);
    }
  }

  const identities: DirectoryIdentity[] = [];
  try {
    for (const [index, candidate] of paths.entries()) {
      const stat = await fs.lstat(candidate, { bigint: true });
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        return index === 0 ? 'root-changed' : null;
      }
      // The root must stay the exact filesystem object bound at resolve time.
      if (index === 0 && (stat.dev !== expectedRoot.dev || stat.ino !== expectedRoot.ino)) {
        return 'root-changed';
      }
      identities.push(directoryIdentity(stat));
    }
    return identities;
  } catch {
    return null;
  }
}

function directoryIdentity(stat: BigIntStats): DirectoryIdentity {
  return {
    dev: stat.dev,
    ino: stat.ino,
    mode: stat.mode,
    ctimeNs: stat.ctimeNs,
    mtimeNs: stat.mtimeNs,
  };
}

function sameDirectoryChain(
  left: DirectoryIdentity[],
  right: DirectoryIdentity[],
): boolean {
  return (
    left.length === right.length &&
    left.every((identity, index) => {
      const candidate = right[index];
      return (
        candidate !== undefined &&
        identity.dev === candidate.dev &&
        identity.ino === candidate.ino &&
        identity.mode === candidate.mode &&
        identity.ctimeNs === candidate.ctimeNs &&
        identity.mtimeNs === candidate.mtimeNs
      );
    })
  );
}

async function symlinkReason(absPath: string, realRoot: string): Promise<SkipReason> {
  try {
    const resolved = await fs.realpath(absPath);
    return isPathInsideRoot(resolved, realRoot) ? 'symlink' : 'symlink-outside-root';
  } catch {
    return 'symlink';
  }
}

async function openInsideRoot(
  absPath: string,
  realRoot: string,
): Promise<OpenedFile | { reason: SkipReason }> {
  let resolvedBefore: string;
  try {
    resolvedBefore = await fs.realpath(absPath);
  } catch {
    return { reason: 'unreadable' };
  }
  if (!isPathInsideRoot(resolvedBefore, realRoot)) return { reason: 'symlink-outside-root' };

  let handle: FileHandle | undefined;
  try {
    const flags = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0);
    handle = await fs.open(absPath, flags);
    const stat = await handle.stat();
    if (!stat.isFile()) {
      await handle.close();
      return { reason: 'unreadable' };
    }

    const resolvedAfter = await fs.realpath(absPath);
    if (!isPathInsideRoot(resolvedAfter, realRoot)) {
      await handle.close();
      return { reason: 'symlink-outside-root' };
    }
    const pathStat = await fs.stat(resolvedAfter);
    if (stat.dev !== pathStat.dev || stat.ino !== pathStat.ino) {
      await handle.close();
      return { reason: 'unreadable' };
    }
    return { handle, stat };
  } catch (error) {
    await handle?.close().catch(() => undefined);
    return { reason: errorCode(error) === 'ELOOP' ? 'symlink' : 'unreadable' };
  }
}

function errorCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object' || !('code' in error)) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

async function readBounded(handle: FileHandle, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  while (total < limit) {
    const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, limit - total));
    const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
    if (bytesRead === 0) break;
    chunks.push(chunk.subarray(0, bytesRead));
    total += bytesRead;
  }
  return Buffer.concat(chunks, total);
}

function prepareFile(
  candidate: DiscoveredFile,
  ext: string,
  kind: FileKind,
  content: string,
  size: number,
  lineStarts: number[],
): PreparedFile {
  return {
    absPath: candidate.absPath,
    relPath: candidate.relPath,
    ext,
    kind,
    content,
    size,
    lineStarts,
    commentRanges: [],
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
  return file.content.slice(start, end).replace(/(?:\r\n|\r|\n|\u2028|\u2029)$/, '');
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
