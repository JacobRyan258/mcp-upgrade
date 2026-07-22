/**
 * Hostile archive extraction.
 *
 * Every archive reaching this module is assumed to be adversarial: crafted to
 * escape the destination directory, to exhaust disk or memory, or to make the
 * scanner read something it should not.
 *
 * The design rules are:
 *
 *   1. Nothing in the archive is trusted, including the sizes it declares. The
 *      central directory is metadata written by the attacker, so limits are
 *      enforced against bytes actually decompressed, while streaming, and the
 *      write is aborted mid-stream the moment a budget is exceeded.
 *   2. Entry names are validated against an allow-list of shapes and then the
 *      resolved absolute path is re-checked against the destination root. Two
 *      independent checks, because the first is about strings and the second is
 *      about the filesystem.
 *   3. Only regular files are ever created. Symbolic links, hard links, devices
 *      and every other entry type are refused outright rather than skipped,
 *      because a link is an attempt to make the scanner read something outside
 *      the job directory.
 *   4. Only file types the scanner actually reads are written to disk at all.
 *      Everything else is counted and discarded without being decompressed,
 *      which removes most zip-bomb payloads before they cost anything.
 *
 * This module never executes, imports, parses or interprets archive content.
 */
import { createWriteStream } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import yauzl from 'yauzl';
import { ALWAYS_IGNORE_PATTERNS, SUPPORTED_EXTENSIONS } from 'mcp-upgrade';
import type { IngestionLimits } from '@mcp-upgrade/shared';
import { IngestionError } from './errors.js';

/** Archive formats we never unpack recursively. */
const NESTED_ARCHIVE_EXTENSIONS = new Set([
  '.zip', '.tar', '.gz', '.tgz', '.bz2', '.xz', '.7z', '.rar', '.jar',
  '.war', '.whl', '.egg', '.apk', '.iso', '.dmg', '.cab', '.zst', '.lz4',
]);

const SUPPORTED = new Set<string>(SUPPORTED_EXTENSIONS);
const IGNORED_SEGMENTS = new Set<string>(ALWAYS_IGNORE_PATTERNS);

/** Unix file-type bits, taken from the high 16 bits of externalFileAttributes. */
const S_IFMT = 0o170000;
const S_IFREG = 0o100000;
const S_IFDIR = 0o040000;
const S_IFLNK = 0o120000;

/** MS-DOS attribute bit set on directory entries by Windows producers. */
const DOS_DIRECTORY = 0x10;

export interface ExtractionResult {
  /** Files actually written to disk. */
  filesWritten: number;
  /** Bytes actually written to disk. */
  bytesWritten: number;
  /** Entries the scanner would not read, so never decompressed. */
  skippedUnsupported: number;
  /** Entries inside an always-ignored directory such as `node_modules`. */
  skippedIgnored: number;
  /** Nested archives, which are never unpacked. */
  skippedNestedArchives: number;
  /** Directory entries seen. */
  directories: number;
}

interface EntryPlan {
  kind: 'write' | 'skip-unsupported' | 'skip-ignored' | 'skip-nested' | 'directory';
  /** Repository-relative POSIX path. Only set for `write` and `directory`. */
  relativePath: string;
}

/**
 * Validates one entry name and decides what to do with it.
 *
 * Throws for anything hostile. Returns a plan for anything acceptable.
 */
export function planEntry(
  rawName: string,
  limits: IngestionLimits,
  externalFileAttributes: number,
): EntryPlan {
  if (rawName.length === 0) {
    throw new IngestionError('archive_unsafe_entry', 'empty entry name');
  }
  if (rawName.length > limits.maxPathLength) {
    throw new IngestionError('archive_unsafe_entry', 'entry name exceeds the path length limit');
  }

  // Control characters — most importantly NUL, which truncates a path in any
  // C-level filesystem call and is the classic way to smuggle one name past a
  // validator and a different one past the kernel.
  for (const character of rawName) {
    const code = character.codePointAt(0) ?? 0;
    if (code <= 0x1f || code === 0x7f) {
      throw new IngestionError('archive_unsafe_entry', 'entry name contains a control character');
    }
  }

  // Backslashes are not a ZIP path separator. A producer emitting them is
  // either broken or trying to have the name read differently on Windows.
  if (rawName.includes('\\')) {
    throw new IngestionError('archive_unsafe_entry', 'entry name contains a backslash');
  }
  if (rawName.startsWith('/')) {
    throw new IngestionError('archive_unsafe_entry', 'entry name is absolute');
  }
  if (/^[A-Za-z]:/.test(rawName)) {
    throw new IngestionError('archive_unsafe_entry', 'entry name carries a drive letter');
  }
  // A UNC path would already have been caught by the backslash rule; the
  // forward-slash spelling is caught here.
  if (rawName.startsWith('//')) {
    throw new IngestionError('archive_unsafe_entry', 'entry name is a UNC path');
  }

  const isDirectory =
    rawName.endsWith('/') || (externalFileAttributes & DOS_DIRECTORY) === DOS_DIRECTORY;

  // Unicode normalisation happens before any comparison, so two names that
  // render identically cannot resolve to two different files — or, worse, to
  // the same file, letting a later entry overwrite an already-validated one.
  const normalized = rawName.normalize('NFC');
  const segments = normalized.split('/').filter((segment) => segment.length > 0);

  if (segments.length === 0) {
    throw new IngestionError('archive_unsafe_entry', 'entry name has no usable segments');
  }
  if (segments.length > limits.maxDepth) {
    throw new IngestionError('archive_unsafe_entry', 'entry exceeds the directory depth limit');
  }
  for (const segment of segments) {
    if (segment === '..') {
      throw new IngestionError('archive_unsafe_entry', 'entry name traverses to a parent directory');
    }
    if (segment === '.') {
      throw new IngestionError('archive_unsafe_entry', 'entry name contains a current-directory segment');
    }
    // Trailing dots and spaces are stripped by Windows, so `evil.ts.` and
    // `evil.ts` are the same file there but different strings here.
    if (segment !== segment.trimEnd() || segment.endsWith('.')) {
      throw new IngestionError('archive_unsafe_entry', 'entry segment has trailing dots or spaces');
    }
  }

  const relativePath = segments.join('/');

  // File type. `externalFileAttributes >>> 16` is the Unix mode when the
  // archive was produced on a Unix-like system; it is 0 otherwise, which is why
  // a zero mode is treated as "no information" rather than as a rejection.
  const mode = (externalFileAttributes >>> 16) & 0xffff;
  if (mode !== 0) {
    const fileType = mode & S_IFMT;
    if (fileType === S_IFLNK) {
      throw new IngestionError('archive_unsafe_entry', 'entry is a symbolic link');
    }
    if (fileType !== 0 && fileType !== S_IFREG && fileType !== S_IFDIR) {
      throw new IngestionError('archive_unsafe_entry', 'entry is not a regular file or directory');
    }
  }

  if (isDirectory) return { kind: 'directory', relativePath };

  // Always-ignored directories are dropped before decompression. The scanner
  // would ignore them anyway, so unpacking them buys nothing and is exactly
  // where a bomb hides: a vendored tree nobody inspects.
  if (segments.some((segment) => IGNORED_SEGMENTS.has(segment))) {
    return { kind: 'skip-ignored', relativePath };
  }

  const extension = path.posix.extname(relativePath).toLowerCase();
  if (NESTED_ARCHIVE_EXTENSIONS.has(extension)) {
    return { kind: 'skip-nested', relativePath };
  }
  if (!SUPPORTED.has(extension)) {
    return { kind: 'skip-unsupported', relativePath };
  }
  return { kind: 'write', relativePath };
}

/**
 * Resolves an already-validated relative path against the destination root and
 * proves the result is still inside it.
 *
 * The string checks above should make this unreachable. It exists because
 * "should" is not a security property: this is the check that operates on the
 * value actually handed to the filesystem.
 */
function resolveInsideRoot(root: string, relativePath: string): string {
  const resolved = path.resolve(root, relativePath);
  const prefix = root.endsWith(path.sep) ? root : root + path.sep;
  if (!resolved.startsWith(prefix)) {
    throw new IngestionError('archive_unsafe_entry', 'resolved entry path escapes the job root');
  }
  return resolved;
}

/**
 * Counts bytes as they stream and aborts the moment a budget is exceeded.
 *
 * Enforcing on the decompressed stream rather than on the declared size is the
 * whole point: a zip bomb declares whatever it likes.
 */
class BudgetedCounter extends Transform {
  written = 0;

  constructor(
    private readonly perFileLimit: number,
    private readonly remainingTotal: () => number,
  ) {
    super();
  }

  override _transform(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null, data?: Buffer) => void,
  ): void {
    this.written += chunk.length;
    if (this.written > this.perFileLimit) {
      callback(
        new IngestionError('archive_file_too_large', 'a file exceeded the per-file byte limit'),
      );
      return;
    }
    if (this.written > this.remainingTotal()) {
      callback(
        new IngestionError(
          'archive_expanded_too_large',
          'the archive exceeded the total expanded byte limit',
        ),
      );
      return;
    }
    callback(null, chunk);
  }
}

function openArchive(archivePath: string): Promise<yauzl.ZipFile> {
  return new Promise((resolve, reject) => {
    yauzl.open(
      archivePath,
      {
        lazyEntries: true,
        autoClose: false,
        // yauzl performs its own name validation when decoding strings, which
        // rejects backslashes, absolute paths and `..` components. That is a
        // second, independent implementation of the checks in `planEntry`.
        decodeStrings: true,
        strictFileNames: true,
        // Declared sizes are attacker-controlled, so a mismatch against what we
        // actually read must be an error rather than something we silently
        // accept.
        validateEntrySizes: true,
      },
      (error, zipfile) => {
        if (error || !zipfile) {
          reject(
            new IngestionError('archive_invalid', 'the archive could not be opened', {
              cause: error,
            }),
          );
          return;
        }
        resolve(zipfile);
      },
    );
  });
}

function openEntryStream(
  zipfile: yauzl.ZipFile,
  entry: yauzl.Entry,
): Promise<NodeJS.ReadableStream> {
  return new Promise((resolve, reject) => {
    zipfile.openReadStream(entry, (error, stream) => {
      if (error || !stream) {
        reject(
          new IngestionError('archive_invalid', 'an entry could not be decompressed', {
            cause: error,
          }),
        );
        return;
      }
      resolve(stream);
    });
  });
}

export interface ExtractOptions {
  limits: IngestionLimits;
  /** Absolute deadline. Extraction aborts when it passes. */
  deadline: number;
  /** Optional strip of a single leading path component (GitHub archives). */
  stripLeadingComponent?: boolean;
}

/**
 * Extracts `archivePath` into `destination`, which must already exist and must
 * be a directory this process created.
 *
 * On any failure the caller is responsible for removing `destination`; this
 * function does not clean up, because the caller's cleanup must run for
 * timeouts and crashes too and having one owner for that is safer than two.
 */
export async function extractZip(
  archivePath: string,
  destination: string,
  options: ExtractOptions,
): Promise<ExtractionResult> {
  const { limits, deadline } = options;
  const root = path.resolve(destination);
  const result: ExtractionResult = {
    filesWritten: 0,
    bytesWritten: 0,
    skippedUnsupported: 0,
    skippedIgnored: 0,
    skippedNestedArchives: 0,
    directories: 0,
  };

  const seenPaths = new Set<string>();
  const createdDirectories = new Set<string>();
  let compressedConsumed = 0;
  const zipfile = await openArchive(archivePath);

  try {
    // `entryCount` is from the central directory and therefore untrusted, but
    // refusing early on an absurd declared count avoids doing any work at all
    // for an archive that cannot possibly be acceptable.
    if (zipfile.entryCount > limits.maxFiles * 20) {
      throw new IngestionError(
        'archive_too_many_files',
        'the archive declares far more entries than the limit allows',
      );
    }

    for (;;) {
      if (Date.now() > deadline) {
        throw new IngestionError('scan_timeout', 'extraction exceeded the job deadline');
      }

      const entry = await nextEntry(zipfile);
      if (!entry) break;

      let rawName = entry.fileName;
      if (options.stripLeadingComponent) {
        const slash = rawName.indexOf('/');
        // An entry that is exactly the top-level directory becomes empty and is
        // simply skipped.
        if (slash < 0) continue;
        rawName = rawName.slice(slash + 1);
        if (rawName.length === 0) continue;
      }

      const plan = planEntry(rawName, limits, entry.externalFileAttributes);

      if (plan.kind === 'directory') {
        result.directories += 1;
        continue;
      }
      if (plan.kind === 'skip-ignored') {
        result.skippedIgnored += 1;
        continue;
      }
      if (plan.kind === 'skip-nested') {
        result.skippedNestedArchives += 1;
        continue;
      }
      if (plan.kind === 'skip-unsupported') {
        result.skippedUnsupported += 1;
        continue;
      }

      // Case-insensitive collision detection. On a case-insensitive filesystem
      // two differently-cased names are one file, so a second entry would
      // overwrite the first — a way to get validated content replaced by
      // something else after the fact.
      const collisionKey = plan.relativePath.toLowerCase();
      if (seenPaths.has(collisionKey)) {
        throw new IngestionError(
          'archive_unsafe_entry',
          'the archive contains duplicate or case-colliding entry names',
        );
      }
      seenPaths.add(collisionKey);

      if (result.filesWritten >= limits.maxFiles) {
        throw new IngestionError('archive_too_many_files', 'the archive exceeded the file limit');
      }

      const absolutePath = resolveInsideRoot(root, plan.relativePath);
      const parent = path.dirname(absolutePath);
      if (!createdDirectories.has(parent)) {
        // `recursive` creates only missing components and never follows a
        // symlink into place, because every component here was created by us.
        await mkdir(parent, { recursive: true, mode: 0o700 });
        createdDirectories.add(parent);
      }

      const counter = new BudgetedCounter(
        limits.maxFileBytes,
        () => limits.maxExpandedBytes - result.bytesWritten,
      );
      const source = await openEntryStream(zipfile, entry);
      // `wx` fails rather than truncating if the path somehow already exists,
      // and never follows an existing symlink.
      const sink = createWriteStream(absolutePath, { flags: 'wx', mode: 0o600 });

      try {
        await pipeline(source, counter, sink);
      } catch (error) {
        if (error instanceof IngestionError) throw error;
        throw new IngestionError('archive_invalid', 'an entry failed to extract', { cause: error });
      }

      result.filesWritten += 1;
      result.bytesWritten += counter.written;
      compressedConsumed += Math.max(entry.compressedSize, 0);

      if (result.bytesWritten > limits.maxExpandedBytes) {
        throw new IngestionError(
          'archive_expanded_too_large',
          'the archive exceeded the total expanded byte limit',
        );
      }

      // Compression ratio is the signature of a bomb that absolute limits miss:
      // a small archive that expands enormously. Checked per entry and again in
      // aggregate, and only once enough bytes have been written that the ratio
      // is meaningful — a 4-byte file compressing to 200 bytes is not an attack.
      const RATIO_FLOOR_BYTES = 1024 * 1024;
      if (
        counter.written > RATIO_FLOOR_BYTES &&
        counter.written / Math.max(entry.compressedSize, 1) > limits.maxCompressionRatio
      ) {
        throw new IngestionError(
          'archive_expanded_too_large',
          'an entry exceeded the compression ratio limit',
        );
      }
      if (
        result.bytesWritten > RATIO_FLOOR_BYTES &&
        result.bytesWritten / Math.max(compressedConsumed, 1) > limits.maxCompressionRatio
      ) {
        throw new IngestionError(
          'archive_expanded_too_large',
          'the archive exceeded the aggregate compression ratio limit',
        );
      }
    }
  } finally {
    zipfile.close();
  }

  if (result.filesWritten === 0) {
    if (result.skippedNestedArchives > 0) {
      throw new IngestionError(
        'archive_nested_archive',
        'the archive contained only nested archives',
      );
    }
    throw new IngestionError('archive_empty', 'the archive contained no scannable source files');
  }

  return result;
}

/**
 * Distinguishes a hostile entry name from a genuinely corrupt archive.
 *
 * yauzl performs its own name validation and rejects backslashes, absolute
 * paths and `..` segments before an entry is ever emitted — which means, for
 * exactly those inputs, it is yauzl and not `planEntry` that refuses the
 * archive. That is the desired behaviour (two independent implementations, the
 * stricter one winning), but reporting it as "malformed archive" would tell the
 * user their ZIP is damaged when in fact it is dangerous. These three messages
 * are the complete set yauzl produces for a name, so they are mapped back to
 * the accurate category.
 *
 * The message is matched but never propagated: it embeds the attacker-supplied
 * file name.
 */
function classifyArchiveError(error: Error): IngestionError {
  const message = error.message ?? '';
  if (
    message.startsWith('invalid characters in fileName:') ||
    message.startsWith('absolute path:') ||
    message.startsWith('invalid relative path:')
  ) {
    return new IngestionError(
      'archive_unsafe_entry',
      'the archive declares an entry name that escapes the destination',
    );
  }
  return new IngestionError('archive_invalid', 'the archive is malformed', { cause: error });
}

function nextEntry(zipfile: yauzl.ZipFile): Promise<yauzl.Entry | null> {
  return new Promise((resolve, reject) => {
    const onEntry = (entry: yauzl.Entry): void => {
      cleanup();
      resolve(entry);
    };
    const onEnd = (): void => {
      cleanup();
      resolve(null);
    };
    const onError = (error: Error): void => {
      cleanup();
      reject(
        error instanceof IngestionError ? error : classifyArchiveError(error),
      );
    };
    function cleanup(): void {
      zipfile.removeListener('entry', onEntry);
      zipfile.removeListener('end', onEnd);
      zipfile.removeListener('error', onError);
    }
    zipfile.once('entry', onEntry);
    zipfile.once('end', onEnd);
    zipfile.once('error', onError);
    zipfile.readEntry();
  });
}

/**
 * Removes a job directory.
 *
 * Refuses to delete anything that is not underneath the configured scan root,
 * so a bug that produced a wrong path cannot turn cleanup into destruction.
 */
export async function removeJobDirectory(scanRoot: string, jobDirectory: string): Promise<void> {
  const root = path.resolve(scanRoot);
  const target = path.resolve(jobDirectory);
  const prefix = root.endsWith(path.sep) ? root : root + path.sep;
  if (!target.startsWith(prefix) || target === root) {
    throw new Error('Refusing to remove a directory outside the scan root.');
  }
  await rm(target, { recursive: true, force: true, maxRetries: 3 });
}
