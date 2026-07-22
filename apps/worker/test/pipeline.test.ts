/**
 * The whole ingestion path, end to end.
 *
 * These tests run the real extractor, the real scanner and the real sanitizer.
 * The only substitution is the upload store, which copies a local file instead
 * of talking to object storage — everything the security properties depend on
 * is the production code.
 *
 * The assertions people actually care about are at the bottom: that no absolute
 * path and no credential from the scanned repository survives into the report.
 */
import { copyFile, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ClaimedJob } from '@mcp-upgrade/database';
import { validatePublishedReport } from '@mcp-upgrade/shared';
import { runJob } from '../src/pipeline.js';
import type { PipelineDeps } from '../src/pipeline.js';
import { sanitizeReport } from '../src/sanitize.js';
import type { UploadStore } from '../src/storage.js';
import { MCP_PROJECT, bombContent, makeTempDir, writeZip } from './archives.js';

let workspace: string;
let scanRoot: string;

beforeEach(async () => {
  workspace = await makeTempDir('pipeline-test-');
  scanRoot = path.join(workspace, 'scans');
  await mkdir(scanRoot, { recursive: true });
});

afterEach(async () => {
  await rm(workspace, { recursive: true, force: true });
});

/** An upload store backed by a local file, so no network is involved. */
function localUploads(archivePath: string | null): UploadStore & { removed: string[] } {
  const removed: string[] = [];
  return {
    removed,
    async download(_key, destination, maxBytes) {
      if (!archivePath) throw new Error('no archive staged');
      const { size } = await import('node:fs/promises').then((fs) => fs.stat(archivePath));
      if (size > maxBytes) throw new Error('too large');
      await copyFile(archivePath, destination);
      return size;
    },
    async remove(key) {
      removed.push(key);
    },
  };
}

function zipJob(overrides: Partial<ClaimedJob> = {}): ClaimedJob {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    userId: '22222222-2222-4222-8222-222222222222',
    sourceType: 'zip',
    sourceLabel: 'my-server.zip',
    repositoryUrl: null,
    targetVersion: '2026-07-28',
    planId: 'free',
    storageKey: '22222222-2222-4222-8222-222222222222/11111111-1111-4111-8111-111111111111.zip',
    attempts: 1,
    maxAttempts: 1,
    ...overrides,
  };
}

function deps(uploads: UploadStore, overrides: Partial<PipelineDeps> = {}): PipelineDeps {
  return {
    uploads,
    scanTempRoot: scanRoot,
    scanTimeoutMs: 120_000,
    githubTimeoutMs: 15_000,
    ...overrides,
  };
}

async function remainingJobDirectories(): Promise<string[]> {
  return (await readdir(scanRoot, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
}

describe('a real ZIP scans end to end', () => {
  it('produces a valid published report with findings', async () => {
    const archive = path.join(workspace, 'project.zip');
    await writeZip(archive, MCP_PROJECT);
    const uploads = localUploads(archive);

    const result = await runJob(zipJob(), deps(uploads));

    expect(result.outcome).toBe('succeeded');
    if (result.outcome !== 'succeeded') return;

    expect(validatePublishedReport(result.report).ok).toBe(true);
    expect(result.report.repository.isLikelyMcpServer).toBe(true);
    // The fixture uses sessionIdGenerator and the logging capability, both of
    // which the scanner reports against the 2026-07-28 target.
    expect(result.report.findings.length).toBeGreaterThan(0);
    expect(result.report.summary.readiness.score).toBeLessThan(100);
  });

  it('replaces the repository root with the user-facing label', async () => {
    const archive = path.join(workspace, 'project.zip');
    await writeZip(archive, MCP_PROJECT);
    const result = await runJob(zipJob({ sourceLabel: 'my-server.zip' }), deps(localUploads(archive)));

    expect(result.outcome).toBe('succeeded');
    if (result.outcome !== 'succeeded') return;
    expect(result.report.repository.root).toBe('my-server.zip');
  });

  it('deletes the job directory and the staged upload on success', async () => {
    const archive = path.join(workspace, 'project.zip');
    await writeZip(archive, MCP_PROJECT);
    const uploads = localUploads(archive);
    const job = zipJob();

    await runJob(job, deps(uploads));

    expect(await remainingJobDirectories()).toEqual([]);
    expect(uploads.removed).toEqual([job.storageKey]);
  });
});

describe('failures still clean up', () => {
  const cases: Array<[string, () => Promise<string>, string]> = [
    [
      'a malformed archive',
      async () => {
        const archive = path.join(workspace, 'bad.zip');
        await writeFile(archive, 'not a zip');
        return archive;
      },
      'archive_invalid',
    ],
    [
      'an archive with nothing scannable',
      async () => {
        const archive = path.join(workspace, 'empty.zip');
        await writeZip(archive, [{ name: 'README.md', content: '# hi' }]);
        return archive;
      },
      'archive_empty',
    ],
    [
      'an oversized expansion',
      async () => {
        const archive = path.join(workspace, 'big.zip');
        await writeZip(archive, [{ name: 'a.ts', content: bombContent(40), compress: true }]);
        return archive;
      },
      'archive_file_too_large',
    ],
  ];

  for (const [label, build, expectedCategory] of cases) {
    it(`removes the job directory after ${label}`, async () => {
      const archive = await build();
      const uploads = localUploads(archive);
      const job = zipJob();

      const result = await runJob(job, deps(uploads));

      expect(result.outcome).toBe('failed');
      if (result.outcome !== 'failed') return;
      expect(result.category).toBe(expectedCategory);
      expect(await remainingJobDirectories()).toEqual([]);
      // The staged upload is deleted whether or not the scan worked; that is
      // the retention promise, not a success-path nicety.
      expect(uploads.removed).toEqual([job.storageKey]);
    });
  }

  it('fails cleanly when the staged upload cannot be fetched', async () => {
    const uploads = localUploads(null);
    const result = await runJob(zipJob(), deps(uploads));
    expect(result.outcome).toBe('failed');
    expect(await remainingJobDirectories()).toEqual([]);
  });

  it('fails cleanly when a zip job has no staged upload at all', async () => {
    const result = await runJob(zipJob({ storageKey: null }), deps(localUploads(null)));
    expect(result.outcome).toBe('failed');
    if (result.outcome !== 'failed') return;
    expect(result.category).toBe('storage_unavailable');
    expect(await remainingJobDirectories()).toEqual([]);
  });

  it('times out rather than occupying the worker indefinitely', async () => {
    const archive = path.join(workspace, 'project.zip');
    await writeZip(archive, MCP_PROJECT);
    const result = await runJob(
      zipJob(),
      deps(localUploads(archive), { scanTimeoutMs: 1 }),
    );
    expect(result.outcome).toBe('failed');
    if (result.outcome !== 'failed') return;
    expect(result.category).toBe('scan_timeout');
    expect(await remainingJobDirectories()).toEqual([]);
  });

  it('never throws, whatever happens', async () => {
    // A store that rejects with a non-Error value: the pipeline must still
    // return a failure result rather than propagating.
    const hostileStore: UploadStore = {
      async download() {
        // Deliberately not an Error: the pipeline must categorise anything
        // thrown, not just well-behaved exceptions.
        throw 'not an error object';
      },
      async remove() {
        throw new Error('remove failed too');
      },
    };
    const result = await runJob(zipJob(), deps(hostileStore));
    expect(result.outcome).toBe('failed');
    if (result.outcome !== 'failed') return;
    expect(result.category).toBe('internal_error');
  });

  it('rejects a stored repository URL that would not pass validation today', async () => {
    const result = await runJob(
      zipJob({ sourceType: 'github', repositoryUrl: 'https://evil.example/o/r', storageKey: null }),
      deps(localUploads(null)),
    );
    expect(result.outcome).toBe('failed');
    if (result.outcome !== 'failed') return;
    expect(result.category).toBe('source_url_invalid');
  });
});

describe('nothing sensitive survives into the report', () => {
  const SECRETS = [
    'sk-live-6f3aB9xQ2mZ7pL0wN4tR8vK1cD5eH2jS',
    'ghp_A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8',
    'AKIAIOSFODNN7EXAMPLE',
  ];

  it('redacts credentials that appear in scanned source', async () => {
    const archive = path.join(workspace, 'secrets.zip');
    await writeZip(archive, [
      ...MCP_PROJECT,
      {
        name: 'src/config.ts',
        content: [
          "import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';",
          `const apiKey = "${SECRETS[0]}";`,
          `const githubToken = "${SECRETS[1]}";`,
          `const awsAccessKey = "${SECRETS[2]}";`,
          'export const transport = new StreamableHTTPServerTransport({',
          `  sessionIdGenerator: () => "${SECRETS[0]}",`,
          '});',
          '',
        ].join('\n'),
      },
    ]);

    const result = await runJob(zipJob(), deps(localUploads(archive)));
    expect(result.outcome).toBe('succeeded');
    if (result.outcome !== 'succeeded') return;

    const serialised = JSON.stringify(result.report);
    for (const secret of SECRETS) {
      expect(serialised).not.toContain(secret);
    }
    expect(serialised).toContain('[REDACTED:');
  });

  it('leaks no absolute filesystem path anywhere in the report', async () => {
    const archive = path.join(workspace, 'project.zip');
    await writeZip(archive, MCP_PROJECT);
    const result = await runJob(zipJob(), deps(localUploads(archive)));

    expect(result.outcome).toBe('succeeded');
    if (result.outcome !== 'succeeded') return;

    const serialised = JSON.stringify(result.report);
    // The two things that would actually be present if sanitisation failed:
    // the per-job temporary directory, and the workspace it lives in.
    expect(serialised).not.toContain(scanRoot);
    expect(serialised).not.toContain(workspace);
    expect(serialised).not.toContain('/var/folders');
    expect(serialised).not.toContain('/private/');
    expect(serialised).not.toMatch(/"[^"]*\/(?:tmp|Users|home|root)\//);

    // And every path in the report is relative.
    for (const finding of result.report.findings) {
      expect(finding.file.startsWith('/')).toBe(false);
      expect(finding.file).not.toMatch(/^[A-Za-z]:/);
      expect(finding.file.split('/')).not.toContain('..');
    }
    for (const file of result.report.files) {
      expect(file.file.startsWith('/')).toBe(false);
    }
  });

  it('reports a partial scan honestly rather than hiding it', async () => {
    const archive = path.join(workspace, 'partial.zip');
    // Larger than the scanner's own 1 MiB per-file limit, so the scanner skips
    // it and marks the scan partial. Stored uncompressed on purpose: a 2 MB run
    // of one byte would trip the extractor's compression-ratio guard first, and
    // this test is about the scanner's behaviour, not the extractor's.
    const incompressible = Buffer.alloc(2 * 1024 * 1024);
    for (let i = 0; i < incompressible.length; i += 1) {
      incompressible[i] = (i * 2654435761) % 251;
    }
    await writeZip(archive, [
      ...MCP_PROJECT,
      { name: 'src/huge.ts', content: incompressible, compress: false },
    ]);

    const result = await runJob(zipJob(), deps(localUploads(archive)));
    expect(result.outcome).toBe('succeeded');
    if (result.outcome !== 'succeeded') return;

    expect(result.report.scanStatus).toBe('partial');
    expect(result.report.issues.length).toBeGreaterThan(0);
    expect(result.report.summary.filesSkipped).toBeGreaterThan(0);
  });
});

describe('the sanitizer fails closed', () => {
  const baseReport = {
    schemaVersion: '1.0' as const,
    scannerVersion: '0.1.0',
    generatedAt: '2026-07-22T00:00:00.000Z',
    target: {
      protocolVersion: '2026-07-28',
      status: 'release-candidate' as const,
      baselineVersion: '2025-11-25',
    },
    scanStatus: 'complete' as const,
    issues: [],
    repository: {
      root: '/tmp/scan-abc/src',
      singleFile: false,
      isLikelyMcpServer: true,
      mcpEvidence: [],
      languages: { typescript: 1, javascript: 0, json: 0, yaml: 0 },
      transport: 'stdio' as const,
      transportEvidence: [],
      sdk: null,
      relatedDependencies: [],
      frameworks: [],
      httpRoutingIsAbstracted: false,
      packageName: null,
    },
    summary: {
      filesDiscovered: 1,
      filesScanned: 1,
      filesSkipped: 0,
      filesRequiringChanges: 0,
      counts: { error: 0, warning: 0, review: 0, info: 0 },
      byRule: {},
      readiness: { score: 100, deductions: [], explanation: '100', disclaimer: 'd' },
      effort: { items: [], minHours: 0, maxHours: 0, excludes: [] },
      appsReadiness: 'NO_SIGNAL' as const,
      commentOnlyMatches: 0,
    },
    findings: [],
    files: [],
  };

  it('replaces an absolute root with the source label', () => {
    const published = sanitizeReport(baseReport as never, { sourceLabel: 'owner/repo' });
    expect(published.repository.root).toBe('owner/repo');
  });

  it('rewrites an absolute finding path to a relative one', () => {
    const withFinding = {
      ...baseReport,
      findings: [
        {
          ruleId: 'MCP2026-SESSION-002',
          level: 'error' as const,
          confidence: 'high' as const,
          category: 'stateless-lifecycle',
          title: 't',
          file: '/private/tmp/scan-abc/src/index.ts',
          line: 1,
          evidence: 'sessionIdGenerator',
          explanation: 'e',
          remediation: 'r',
          source: { title: 's', url: 'https://modelcontextprotocol.io/x' },
          autofix: 'manual' as const,
        },
      ],
    };
    const published = sanitizeReport(withFinding as never, { sourceLabel: 'owner/repo' });
    expect(published.findings[0]?.file).toBe('private/tmp/scan-abc/src/index.ts');
    expect(published.findings[0]?.file.startsWith('/')).toBe(false);
  });

  it('refuses a rule source link that is not https', () => {
    const withBadLink = {
      ...baseReport,
      findings: [
        {
          ruleId: 'X',
          level: 'info' as const,
          confidence: 'low' as const,
          category: 'c',
          title: 't',
          file: 'a.ts',
          line: 1,
          evidence: 'e',
          explanation: 'e',
          remediation: 'r',
          source: { title: 's', url: 'javascript:alert(1)' },
          autofix: 'none' as const,
        },
      ],
    };
    const published = sanitizeReport(withBadLink as never, { sourceLabel: 'x' });
    expect(published.findings[0]?.source.url.startsWith('https://')).toBe(true);
  });

  it('drops a field the schema does not know rather than passing it through', () => {
    // The sanitizer builds its output field by field from an allow-list, so an
    // unrecognised field — a future scanner addition carrying a path, say —
    // never reaches the output at all. That is stronger than rejecting it.
    const withExtra = { ...baseReport, somethingNew: { path: '/tmp/secret' } };
    const published = sanitizeReport(withExtra as never, { sourceLabel: 'x' });
    expect(JSON.stringify(published)).not.toContain('somethingNew');
    expect(JSON.stringify(published)).not.toContain('/tmp/secret');
  });

  it('rejects an unknown field on the read path, where construction cannot help', () => {
    // The web app validates a report it read back from the database, which it
    // did not construct. There, strictness is the only defence, so the schema
    // must refuse anything it does not recognise.
    const stored = { ...baseReport, repository: { ...baseReport.repository, root: 'owner/repo' } };
    expect(validatePublishedReport(stored).ok).toBe(true);
    expect(validatePublishedReport({ ...stored, injected: '/tmp/secret' }).ok).toBe(false);
    expect(
      validatePublishedReport({
        ...stored,
        repository: { ...stored.repository, workerPath: '/tmp/scan-abc' },
      }).ok,
    ).toBe(false);
  });

  it('rejects a stored report whose root is an absolute path', () => {
    expect(validatePublishedReport(baseReport).ok).toBe(false);
  });
});
