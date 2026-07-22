/**
 * The complete, closed set of failure reasons a user is ever shown.
 *
 * Nothing derived from an exception message, a stack trace, a filesystem path
 * or a third-party response ever reaches the browser. The worker maps whatever
 * went wrong onto one of these categories; the web app renders the matching
 * static copy. That mapping is the only channel between internal failures and
 * user-visible text.
 */
export const SCAN_ERROR_CATEGORIES = [
  'archive_too_large',
  'archive_invalid',
  'archive_unsafe_entry',
  'archive_too_many_files',
  'archive_expanded_too_large',
  'archive_file_too_large',
  'archive_empty',
  'archive_nested_archive',
  'source_url_invalid',
  'source_url_forbidden_host',
  'source_repository_not_found',
  'source_repository_private',
  'source_repository_too_large',
  'source_download_failed',
  'source_rate_limited',
  'scan_timeout',
  'scan_failed',
  'report_invalid',
  'storage_unavailable',
  'internal_error',
  'cancelled',
] as const;

export type ScanErrorCategory = (typeof SCAN_ERROR_CATEGORIES)[number];

export function isScanErrorCategory(value: unknown): value is ScanErrorCategory {
  return (
    typeof value === 'string' && (SCAN_ERROR_CATEGORIES as readonly string[]).includes(value)
  );
}

interface ErrorCopy {
  /** Short heading. */
  title: string;
  /** One or two plain sentences. Never mentions internals. */
  message: string;
  /** What the user can actually do. */
  action: string;
  /** Whether re-submitting the identical input could plausibly succeed. */
  retryable: boolean;
  /** Whether the failure was the user's input rather than our system. */
  userFault: boolean;
}

const ERROR_COPY: Readonly<Record<ScanErrorCategory, ErrorCopy>> = Object.freeze({
  archive_too_large: {
    title: 'The upload is too large',
    message: 'The ZIP file exceeds the maximum upload size for your plan.',
    action: 'Remove build output and dependency folders, then upload again.',
    retryable: false,
    userFault: true,
  },
  archive_invalid: {
    title: 'The ZIP file could not be read',
    message: 'The file is not a valid ZIP archive, or it is damaged.',
    action: 'Re-create the ZIP file and upload it again.',
    retryable: false,
    userFault: true,
  },
  archive_unsafe_entry: {
    title: 'The ZIP file contains unsafe entries',
    message:
      'The archive contains entries that would write outside the upload folder, such as absolute paths, parent-directory paths or links. We refuse to extract these.',
    action: 'Re-create the ZIP from a clean copy of your project folder.',
    retryable: false,
    userFault: true,
  },
  archive_too_many_files: {
    title: 'The project contains too many files',
    message: 'The archive holds more files than your plan allows us to extract.',
    action: 'Exclude dependency and build folders, or upgrade for a larger limit.',
    retryable: false,
    userFault: true,
  },
  archive_expanded_too_large: {
    title: 'The project is too large once unpacked',
    message:
      'The archive expands to more data than your plan allows. This also protects the service from compression-bomb archives.',
    action: 'Exclude dependency and build folders, or upgrade for a larger limit.',
    retryable: false,
    userFault: true,
  },
  archive_file_too_large: {
    title: 'A file in the project is too large',
    message: 'One file in the archive exceeds the maximum size we will unpack.',
    action: 'Remove large data or media files and upload again.',
    retryable: false,
    userFault: true,
  },
  archive_empty: {
    title: 'Nothing to scan',
    message: 'The archive contained no files the scanner understands.',
    action: 'Upload a project that contains TypeScript, JavaScript, JSON or YAML source files.',
    retryable: false,
    userFault: true,
  },
  archive_nested_archive: {
    title: 'Nested archives are not supported',
    message: 'The upload contains another archive inside it. We do not unpack archives recursively.',
    action: 'Upload the project folder directly, without nested archives.',
    retryable: false,
    userFault: true,
  },
  source_url_invalid: {
    title: 'That repository address is not valid',
    message: 'We only accept a public GitHub repository address such as https://github.com/owner/repository.',
    action: 'Check the address and try again.',
    retryable: false,
    userFault: true,
  },
  source_url_forbidden_host: {
    title: 'That address is not allowed',
    message: 'Only public repositories hosted on github.com can be scanned.',
    action: 'Use a github.com repository address, or upload a ZIP file instead.',
    retryable: false,
    userFault: true,
  },
  source_repository_not_found: {
    title: 'Repository not found',
    message: 'GitHub did not return that repository. It may have been renamed, moved or deleted.',
    action: 'Check the address, or upload a ZIP file instead.',
    retryable: false,
    userFault: true,
  },
  source_repository_private: {
    title: 'That repository is not public',
    message: 'This release can only scan public repositories.',
    action: 'Upload a ZIP file of the project instead.',
    retryable: false,
    userFault: true,
  },
  source_repository_too_large: {
    title: 'That repository is too large',
    message: 'The repository archive exceeds the maximum size for your plan.',
    action: 'Upload a ZIP of just the server source, or upgrade for a larger limit.',
    retryable: false,
    userFault: true,
  },
  source_download_failed: {
    title: 'We could not download that repository',
    message: 'GitHub did not return the repository archive.',
    action: 'Try again in a few minutes, or upload a ZIP file instead.',
    retryable: true,
    userFault: false,
  },
  source_rate_limited: {
    title: 'GitHub is rate limiting us',
    message: 'We have temporarily hit GitHub’s request limit.',
    action: 'Try again in a few minutes, or upload a ZIP file instead.',
    retryable: true,
    userFault: false,
  },
  scan_timeout: {
    title: 'The scan took too long',
    message: 'We stopped the scan because it exceeded the time limit.',
    action: 'Scan a smaller project, or exclude dependency and build folders.',
    retryable: true,
    userFault: false,
  },
  scan_failed: {
    title: 'The scan could not be completed',
    message: 'The scanner stopped unexpectedly while reading this project.',
    action: 'Try again. If it keeps failing, the project may use a structure we do not yet handle.',
    retryable: true,
    userFault: false,
  },
  report_invalid: {
    title: 'The report could not be prepared',
    message: 'The scan produced a result we could not safely publish.',
    action: 'Try again. If it keeps failing, please report the scan reference.',
    retryable: true,
    userFault: false,
  },
  storage_unavailable: {
    title: 'Temporary storage was unavailable',
    message: 'We could not retrieve the uploaded file.',
    action: 'Upload the file again.',
    retryable: true,
    userFault: false,
  },
  internal_error: {
    title: 'Something went wrong',
    message: 'The scan failed for an internal reason.',
    action: 'Try again. This scan was not counted against your allowance.',
    retryable: true,
    userFault: false,
  },
  cancelled: {
    title: 'Scan cancelled',
    message: 'This scan was stopped before it finished.',
    action: 'Start a new scan when you are ready.',
    retryable: true,
    userFault: false,
  },
});

export function describeScanError(category: string | null | undefined): ErrorCopy {
  if (isScanErrorCategory(category)) return ERROR_COPY[category];
  return ERROR_COPY.internal_error;
}

/**
 * Whether a failure should refund the reserved scan.
 *
 * The documented rule: a user is charged when we successfully scanned their
 * code. Anything that fails before the scanner produced a report — including
 * every rejected input — releases the reservation.
 */
export function shouldRefundUsage(category: string | null | undefined): boolean {
  return category !== null && category !== undefined;
}
