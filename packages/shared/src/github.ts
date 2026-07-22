/**
 * Parsing and validation for the one repository source we accept: a canonical
 * public GitHub repository URL.
 *
 * This module is deliberately pure and allow-list driven. It runs in the
 * browser (for immediate feedback), in the web API route (as the authoritative
 * check) and in the worker (again, because the worker never trusts its caller).
 *
 * Network-level SSRF defence — DNS resolution, address-family checks and
 * per-hop redirect validation — lives in the worker, which is the only place
 * that actually opens a socket. Both layers are required; neither is sufficient.
 */

export interface GitHubRepoRef {
  owner: string;
  repo: string;
  /** `https://github.com/{owner}/{repo}` — what we store and display. */
  normalizedUrl: string;
  /** `{owner}/{repo}` — what we show as the scan label. */
  slug: string;
}

export type GitHubUrlRejection =
  | 'empty'
  | 'not-a-url'
  | 'bad-scheme'
  | 'credentials-in-url'
  | 'forbidden-host'
  | 'non-default-port'
  | 'reserved-owner'
  | 'bad-path'
  | 'subpath-unsupported'
  | 'bad-owner'
  | 'bad-repo';

export type GitHubUrlResult =
  | { ok: true; value: GitHubRepoRef }
  | { ok: false; reason: GitHubUrlRejection };

/** Only these hosts are ever accepted. No subdomains, no alternates. */
const ALLOWED_HOSTS: ReadonlySet<string> = new Set(['github.com', 'www.github.com']);

/**
 * GitHub reserves these first path segments for site features, so they can
 * never be a repository owner even though they parse like one.
 */
const RESERVED_OWNERS: ReadonlySet<string> = new Set([
  'about', 'account', 'admin', 'api', 'apps', 'assets', 'blog', 'business',
  'collections', 'contact', 'customer-stories', 'dashboard', 'enterprise',
  'events', 'explore', 'features', 'gist', 'git', 'help', 'home', 'issues',
  'join', 'login', 'logout', 'marketplace', 'new', 'news', 'notifications',
  'orgs', 'organizations', 'pricing', 'pulls', 'raw', 'readme', 'security',
  'sessions', 'settings', 'signup', 'site', 'sponsors', 'stars', 'status',
  'topics', 'trending', 'user', 'users', 'watching',
]);

// GitHub owners: alphanumeric and hyphen, no leading/trailing hyphen, <= 39.
const OWNER_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;
// GitHub repositories: alphanumeric, hyphen, underscore, period. <= 100.
const REPO_PATTERN = /^[A-Za-z0-9._-]{1,100}$/;

/**
 * Validates and normalizes a user-supplied GitHub repository address.
 *
 * Accepts `https://github.com/owner/repo`, with or without `www.`, a trailing
 * slash or a `.git` suffix. Everything else is rejected — including `git://`,
 * `ssh://`, `git@github.com:owner/repo`, any other host, any URL carrying
 * credentials, and any deeper path such as `/owner/repo/tree/main/src`.
 */
export function parseGitHubRepoUrl(input: unknown): GitHubUrlResult {
  if (typeof input !== 'string') return { ok: false, reason: 'not-a-url' };
  const raw = input.trim();
  if (raw.length === 0) return { ok: false, reason: 'empty' };
  // A hard length cap keeps pathological inputs away from the URL parser.
  if (raw.length > 512) return { ok: false, reason: 'bad-path' };
  // Control characters (including NUL, CR and LF) are never legitimate here and
  // are a classic request-splitting vector.
  if (/[\x00-\x1f\x7f]/.test(raw)) return { ok: false, reason: 'not-a-url' };

  // `git@github.com:owner/repo.git` is not a URL at all; reject it explicitly
  // rather than letting it fall through to a confusing parse error.
  if (/^[^\s/@]+@[^\s/]+:/.test(raw)) return { ok: false, reason: 'bad-scheme' };

  // Accept a bare `github.com/owner/repo` by assuming https, but never invent a
  // scheme for something that already declares one.
  const withScheme = /^[A-Za-z][A-Za-z0-9+.-]*:/.test(raw) ? raw : `https://${raw}`;

  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return { ok: false, reason: 'not-a-url' };
  }

  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return { ok: false, reason: 'bad-scheme' };
  }
  // Credentials in the URL are both an SSRF trick and a credential-leak risk.
  if (url.username !== '' || url.password !== '') {
    return { ok: false, reason: 'credentials-in-url' };
  }
  // `URL` lowercases the host and resolves IDN punycode, so the allow-list
  // comparison below cannot be bypassed with mixed case or unicode homographs.
  if (!ALLOWED_HOSTS.has(url.hostname)) {
    return { ok: false, reason: 'forbidden-host' };
  }
  // `url.port` is empty for the scheme default. Anything explicit is suspect.
  if (url.port !== '') return { ok: false, reason: 'non-default-port' };

  const segments = url.pathname.split('/').filter((segment) => segment.length > 0);
  if (segments.length < 2) return { ok: false, reason: 'bad-path' };
  if (segments.length > 2) return { ok: false, reason: 'subpath-unsupported' };

  const owner = decodeSegment(segments[0]);
  let repo = decodeSegment(segments[1]);
  if (owner === null || repo === null) return { ok: false, reason: 'bad-path' };

  if (repo.toLowerCase().endsWith('.git')) repo = repo.slice(0, -4);

  if (!OWNER_PATTERN.test(owner)) return { ok: false, reason: 'bad-owner' };
  if (RESERVED_OWNERS.has(owner.toLowerCase())) return { ok: false, reason: 'reserved-owner' };
  if (!REPO_PATTERN.test(repo)) return { ok: false, reason: 'bad-repo' };
  // `.` and `..` would escape the path when used to build an API URL.
  if (repo === '.' || repo === '..') return { ok: false, reason: 'bad-repo' };

  return {
    ok: true,
    value: {
      owner,
      repo,
      normalizedUrl: `https://github.com/${owner}/${repo}`,
      slug: `${owner}/${repo}`,
    },
  };
}

/**
 * Percent-decoding is applied once, and only to detect an encoded separator or
 * traversal attempt. A segment that changes meaning when decoded is rejected
 * rather than silently normalized.
 */
function decodeSegment(segment: string | undefined): string | null {
  if (segment === undefined) return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(segment);
  } catch {
    return null;
  }
  if (hasUnsafePathChar(decoded)) return null;
  return decoded;
}

/** A 40-character lowercase hex commit SHA, as returned by the GitHub API. */
export function isCommitSha(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{40}$/.test(value);
}

/** Short display form of a commit SHA. */
export function shortSha(sha: string): string {
  return isCommitSha(sha) ? sha.slice(0, 7) : '';
}

/** Permalink to the exact commit that was scanned. */
export function commitUrl(ref: Pick<GitHubRepoRef, 'owner' | 'repo'>, sha: string): string | null {
  if (!isCommitSha(sha)) return null;
  return `https://github.com/${ref.owner}/${ref.repo}/tree/${sha}`;
}

/**
 * Path separators, whitespace and control characters must never survive a
 * single percent-decode. Checked by code point so the source file itself
 * carries no literal control bytes.
 */
function hasUnsafePathChar(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code <= 0x20 || code === 0x7f) return true;
    if (character === '/' || character === '\\') return true;
  }
  return false;
}
