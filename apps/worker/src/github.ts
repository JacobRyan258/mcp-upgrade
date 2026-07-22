/**
 * Public GitHub repository ingestion.
 *
 * The flow is deliberately narrow: resolve the repository, resolve its default
 * branch to a specific commit, then download the archive for that exact commit.
 * Pinning to a SHA means the report says precisely what was scanned, and a
 * repeat scan of the same SHA is reproducible.
 *
 * Nothing here runs git. No clone, no submodules, no LFS, no hooks — the only
 * thing that happens is an HTTPS GET of a zip file.
 */
import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import type { GitHubRepoRef, IngestionLimits } from '@mcp-upgrade/shared';
import { isCommitSha } from '@mcp-upgrade/shared';
import { IngestionError } from './errors.js';
import { safeFetch } from './net.js';

export interface ResolvedRepository {
  commitSha: string;
  defaultBranch: string;
  /** Repository size in kilobytes, as reported by the GitHub API. */
  sizeKb: number;
}

interface RepoApiResponse {
  private?: boolean;
  fork?: boolean;
  archived?: boolean;
  disabled?: boolean;
  size?: number;
  default_branch?: string;
}

interface CommitApiResponse {
  sha?: string;
}

export interface GitHubOptions {
  limits: IngestionLimits;
  timeoutMs: number;
  /**
   * Optional token, used only to raise the anonymous rate limit. It is never
   * derived from user input and never grants access to anything private,
   * because a private repository is rejected before the archive is fetched.
   */
  token?: string | undefined;
  signal?: AbortSignal;
}

function authHeaders(token: string | undefined): Record<string, string> {
  const headers: Record<string, string> = {
    'x-github-api-version': '2022-11-28',
  };
  if (token) headers.authorization = `Bearer ${token}`;
  return headers;
}

async function readJson(
  url: string,
  options: GitHubOptions,
  notFoundCategory: 'source_repository_not_found',
): Promise<unknown> {
  const response = await safeFetch(url, {
    timeoutMs: options.timeoutMs,
    headers: authHeaders(options.token),
    ...(options.signal ? { signal: options.signal } : {}),
  });

  if (response.status === 404) {
    // GitHub returns 404 for a private repository as well as a missing one, on
    // purpose. We cannot distinguish them, and neither should we.
    await response.body?.cancel().catch(() => undefined);
    throw new IngestionError(notFoundCategory, 'github returned 404');
  }
  if (response.status === 403 || response.status === 429) {
    const remaining = response.headers.get('x-ratelimit-remaining');
    await response.body?.cancel().catch(() => undefined);
    throw new IngestionError(
      'source_rate_limited',
      `github refused the request (remaining=${remaining ?? 'unknown'})`,
    );
  }
  if (response.status !== 200) {
    await response.body?.cancel().catch(() => undefined);
    throw new IngestionError('source_download_failed', `github returned ${response.status}`);
  }

  // The API response is small; a cap still applies so a hostile or broken
  // upstream cannot stream unbounded JSON into memory.
  const text = await readBoundedText(response.body, 512 * 1024);
  try {
    return JSON.parse(text);
  } catch {
    throw new IngestionError('source_download_failed', 'github returned unparseable JSON');
  }
}

async function readBoundedText(
  body: ReadableStream<Uint8Array> | null,
  maxBytes: number,
): Promise<string> {
  if (!body) return '';
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        throw new IngestionError('source_download_failed', 'github response exceeded the size cap');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * Resolves a repository to a specific commit on its default branch.
 *
 * Rejects private, disabled and oversized repositories before any archive is
 * requested, so the expensive path only runs for something we will accept.
 */
export async function resolveRepository(
  ref: GitHubRepoRef,
  options: GitHubOptions,
): Promise<ResolvedRepository> {
  // `ref` has already been validated to contain only characters safe in a path
  // segment, but encoding is applied anyway so this call site is correct on its
  // own terms rather than because of something a caller promised.
  const owner = encodeURIComponent(ref.owner);
  const repo = encodeURIComponent(ref.repo);

  const repository = (await readJson(
    `https://api.github.com/repos/${owner}/${repo}`,
    options,
    'source_repository_not_found',
  )) as RepoApiResponse;

  if (repository.private === true) {
    throw new IngestionError('source_repository_private', 'repository is private');
  }
  if (repository.disabled === true) {
    throw new IngestionError('source_repository_not_found', 'repository is disabled');
  }

  const defaultBranch = repository.default_branch;
  if (typeof defaultBranch !== 'string' || defaultBranch.length === 0) {
    throw new IngestionError('source_repository_not_found', 'repository has no default branch');
  }

  // The API reports size in KB. Refusing here avoids downloading something we
  // would only reject halfway through.
  const sizeKb = typeof repository.size === 'number' ? repository.size : 0;
  if (sizeKb * 1024 > options.limits.maxArchiveBytes * 4) {
    throw new IngestionError(
      'source_repository_too_large',
      `repository is ${sizeKb}KB, beyond the plan limit`,
    );
  }

  const commit = (await readJson(
    // The branch name comes from GitHub, not the user, but it is still encoded:
    // branch names may contain slashes.
    `https://api.github.com/repos/${owner}/${repo}/commits/${encodeURIComponent(defaultBranch)}`,
    options,
    'source_repository_not_found',
  )) as CommitApiResponse;

  const sha = commit.sha;
  if (!isCommitSha(sha)) {
    throw new IngestionError('source_download_failed', 'github returned an unusable commit sha');
  }

  return { commitSha: sha, defaultBranch, sizeKb };
}

/**
 * Downloads the archive for one commit to `destination`.
 *
 * The response is streamed to disk through a byte counter that aborts the
 * moment the plan's archive limit is passed, so a repository that lies about
 * its size in the API cannot fill the disk.
 */
export async function downloadRepositoryArchive(
  ref: GitHubRepoRef,
  commitSha: string,
  destination: string,
  options: GitHubOptions,
): Promise<number> {
  if (!isCommitSha(commitSha)) {
    throw new IngestionError('source_download_failed', 'refusing to download a non-SHA ref');
  }
  const owner = encodeURIComponent(ref.owner);
  const repo = encodeURIComponent(ref.repo);
  const url = `https://codeload.github.com/${owner}/${repo}/zip/${commitSha}`;

  const response = await safeFetch(url, {
    timeoutMs: options.timeoutMs,
    headers: { ...authHeaders(options.token), accept: 'application/zip' },
    ...(options.signal ? { signal: options.signal } : {}),
  });

  if (response.status === 404) {
    await response.body?.cancel().catch(() => undefined);
    throw new IngestionError('source_repository_not_found', 'archive not found');
  }
  if (response.status === 403 || response.status === 429) {
    await response.body?.cancel().catch(() => undefined);
    throw new IngestionError('source_rate_limited', 'github refused the archive request');
  }
  if (response.status !== 200 || !response.body) {
    await response.body?.cancel().catch(() => undefined);
    throw new IngestionError('source_download_failed', `archive request returned ${response.status}`);
  }

  // A declared Content-Length beyond the limit is refused before any bytes are
  // written; a missing or lying one is caught by the counter below.
  const declared = Number(response.headers.get('content-length') ?? '0');
  if (Number.isFinite(declared) && declared > options.limits.maxArchiveBytes) {
    await response.body.cancel().catch(() => undefined);
    throw new IngestionError('source_repository_too_large', 'archive exceeds the plan limit');
  }

  let received = 0;
  const limit = options.limits.maxArchiveBytes;
  // `wx` rather than `w`: the destination is inside a directory this process
  // just created, and refusing to overwrite anything already there means a
  // path-collision bug fails loudly instead of clobbering.
  const file = createWriteStream(destination, { flags: 'wx', mode: 0o600 });
  const source = Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]);

  try {
    await pipeline(
      source,
      async function* (chunks: AsyncIterable<Buffer>) {
        for await (const chunk of chunks) {
          received += chunk.length;
          if (received > limit) {
            throw new IngestionError(
              'source_repository_too_large',
              'archive exceeded the plan limit',
            );
          }
          yield chunk;
        }
      },
      file,
    );
  } catch (error) {
    if (error instanceof IngestionError) throw error;
    throw new IngestionError('source_download_failed', 'archive download failed', { cause: error });
  }

  if (received === 0) {
    throw new IngestionError('source_download_failed', 'archive was empty');
  }
  return received;
}
