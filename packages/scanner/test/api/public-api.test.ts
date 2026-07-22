import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import * as publicApi from '../../src/index.js';
import {
  SCANNER_VERSION,
  UsageError,
  assertScanReport,
  isScanReport,
  scan,
  scanPath,
} from '../../src/index.js';
import { fixture } from '../helpers.js';
import { withTempProject } from '../helpers.js';
import { main, sanitizeDiagnosticText } from '../../src/cli/index.js';
import { MAX_FILE_BYTES } from '../../src/constants.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

describe('public package API', () => {
  it('exports only the documented runtime surface', () => {
    expect(Object.keys(publicApi).sort()).toEqual([
      'ALWAYS_IGNORE_PATTERNS',
      'BASELINE_PROTOCOL_VERSION',
      'DEFAULT_TARGET_VERSION',
      'InternalScannerError',
      'RC_DISCLAIMER',
      'SCANNER_VERSION',
      'SUPPORTED_EXTENSIONS',
      'UsageError',
      'assertScanReport',
      'isScanReport',
      'redact',
      'sanitizeReportText',
      'scan',
      'scanPath',
      'toEvidence',
    ]);
  });

  it('exposes the discovery inputs a staging host needs to match', () => {
    expect(publicApi.SUPPORTED_EXTENSIONS).toContain('.ts');
    expect(publicApi.SUPPORTED_EXTENSIONS).toContain('.json');
    expect(publicApi.SUPPORTED_EXTENSIONS.every((ext) => ext.startsWith('.'))).toBe(true);
    expect(publicApi.ALWAYS_IGNORE_PATTERNS).toContain('node_modules');
    expect(publicApi.ALWAYS_IGNORE_PATTERNS).toContain('.git');
  });

  it('exposes redaction that embedders can re-apply at their own boundary', () => {
    const secret = 'sk-live-6f3aB9xQ2mZ7pL0wN4tR8vK1cD5eH2jS';
    expect(publicApi.redact(`const key = "${secret}";`)).not.toContain(secret);
    expect(publicApi.redact(`const key = "${secret}";`)).toContain('[REDACTED:');
    // Report text is flattened so hostile metadata cannot forge extra records.
    expect(publicApi.sanitizeReportText('a\nb\tc')).toBe('a b c');
    expect(publicApi.toEvidence('  let   x = 1  ')).toBe('let x = 1');
    expect(publicApi.toEvidence('x'.repeat(500)).length).toBeLessThanOrEqual(160);
  });

  it('returns reports that satisfy the runtime schema guard', async () => {
    const target = fixture('clean-stdio-server');
    const result = await scan({ path: target, verbose: true });
    const report = await scanPath({ path: target });

    expect(isScanReport(result.report)).toBe(true);
    expect(isScanReport(report)).toBe(true);
    expect(result.trace.length).toBeGreaterThan(0);
    expect(() => assertScanReport(report)).not.toThrow();
  });

  it('resolves caller-relative paths without cross-contaminating concurrent scans', async () => {
    const fixtureRoot = path.dirname(fixture('clean-stdio-server'));
    const [clean, legacy] = await Promise.all([
      scanPath({ path: 'clean-stdio-server', cwd: fixtureRoot }),
      scanPath({ path: 'legacy-session-server', cwd: fixtureRoot }),
    ]);

    expect(clean.repository.root).toBe('clean-stdio-server');
    expect(legacy.repository.root).toBe('legacy-session-server');
    expect(clean.repository.packageName).toBe('clean-stdio-server');
    expect(legacy.repository.packageName).toBe('legacy-session-server');
    expect(clean.findings).not.toBe(legacy.findings);
  });

  it('rejects malformed reports at runtime', async () => {
    const report = await scanPath({ path: fixture('clean-stdio-server') });
    const malformed: unknown = { ...report, schemaVersion: '2.0' };
    const file = report.files[0];

    expect(isScanReport(malformed)).toBe(false);
    expect(() => assertScanReport(malformed)).toThrow(TypeError);
    expect(isScanReport(null)).toBe(false);
    expect(isScanReport({ ...report, scanStatus: 'unknown' })).toBe(false);
    expect(
      isScanReport({
        ...report,
        scanStatus: 'partial',
        issues: [{ code: 'unknown-skip', path: '.', message: 'not allowed' }],
      }),
    ).toBe(false);
    expect(
      isScanReport({
        ...report,
        scanStatus: 'partial',
        issues: [{ code: 'too-large', path: '', message: 'missing path' }],
      }),
    ).toBe(false);
    expect(isScanReport({ ...report, files: [{ ...file, scanned: false }] })).toBe(false);
    expect(
      isScanReport({ ...report, files: [{ ...file, scanned: true, skipped: 'binary' }] }),
    ).toBe(false);
    expect(
      isScanReport({
        ...report,
        files: [{ ...file, scanned: false, skipped: 'parse-failure', findingCount: 1 }],
      }),
    ).toBe(false);
    expect(
      isScanReport({
        ...report,
        scanStatus: 'partial',
        issues: [{ code: 'analysis-limit', path: 'src/server.ts', message: 'limit reached' }],
      }),
    ).toBe(true);
  });

  it('rejects unsafe or excessive ignore patterns as usage errors', async () => {
    const target = fixture('clean-stdio-server');
    await expect(scanPath({ path: target, ignore: ['!src/**'] })).rejects.toThrow(UsageError);
    await expect(
      scanPath({ path: target, ignore: Array.from({ length: 33 }, (_, index) => `p${index}`) }),
    ).rejects.toThrow(/At most 32/);
    await expect(scanPath({ path: target, ignore: ['x'.repeat(513)] })).rejects.toThrow(
      /at most 512/,
    );
    await expect(scanPath({ path: target, ignore: ['src/[ab].ts'] })).rejects.toThrow(
      /Only \*, \*\*, and \?/,
    );
    await expect(scanPath({ path: target, ignore: ['src\0server.ts'] })).rejects.toThrow(
      /NUL bytes/,
    );

    let stderr = '';
    const exitCode = await main(
      ['node', 'mcp-upgrade', 'scan', target, '--ignore', 'src\0server.ts'],
      {
        stdout: () => undefined,
        stderr: (text) => {
          stderr += text;
        },
      },
    );
    expect(exitCode).toBe(2);
    expect(stderr).toContain('NUL bytes');
  });

  it('redacts hostile input in programmatic usage errors', async () => {
    const secret = 'sk-live-6f3aB9xQ2mZ7pL0wN4tR8vK1cD5eH2jS';
    const target = fixture('clean-stdio-server');

    await expect(scanPath({ path: `missing-${secret}` })).rejects.not.toThrow(secret);
    await expect(scanPath({ path: target, ignore: [`!${secret}`] })).rejects.not.toThrow(secret);

    for (const promise of [
      scanPath({ path: `missing-${secret}` }),
      scanPath({ path: target, ignore: [`!${secret}`] }),
    ]) {
      await promise.catch((error: unknown) => {
        expect(error).toBeInstanceOf(UsageError);
        expect((error as Error).message).not.toContain(secret);
        expect((error as Error).message).toContain('[REDACTED:');
      });
    }
  });

  it('rejects malformed JavaScript options as usage errors', async () => {
    const target = fixture('clean-stdio-server');
    const malformed = [
      undefined,
      null,
      { path: target, target: 'toString' },
      { path: target, includeTests: 'yes' },
      { path: target, minimumConfidence: 7 },
    ];

    for (const options of malformed) {
      await expect(scanPath(options as unknown as Parameters<typeof scanPath>[0])).rejects.toBeInstanceOf(
        UsageError,
      );
    }
  });

  it('keeps package and lockfile entrypoint metadata in sync', async () => {
    // This package lives in a workspace, so the lockfile is at the monorepo
    // root and describes this package under its workspace path. The invariant
    // being protected is unchanged: the published version and bin entry must
    // match what the lockfile records.
    const packageJson = JSON.parse(await readFile(path.join(ROOT, 'package.json'), 'utf8'));
    const packageLock = JSON.parse(
      await readFile(path.join(ROOT, '..', '..', 'package-lock.json'), 'utf8'),
    );
    const workspaceEntry = packageLock.packages['packages/scanner'];

    expect(packageJson.version).toBe(SCANNER_VERSION);
    expect(workspaceEntry).toBeDefined();
    expect(workspaceEntry.name).toBe('mcp-upgrade');
    expect(workspaceEntry.version).toBe(SCANNER_VERSION);
    expect(workspaceEntry.bin).toEqual(packageJson.bin);
    // The root manifest is a private workspace root and must never be publishable.
    expect(packageLock.packages[''].name).toBe('mcp-upgrade-monorepo');
    expect(packageJson.type).toBe('module');
    expect(packageJson.exports['.'].import).toBe('./dist/index.js');
    expect(packageJson.exports['.']).not.toHaveProperty('require');
    expect(packageJson.exports['.']).not.toHaveProperty('default');
  });

  it('redacts secrets and controls from CLI diagnostics without touching stdout', async () => {
    const secret = 'sk-live-6f3aB9xQ2mZ7pL0wN4tR8vK1cD5eH2jS';
    let stdout = '';
    let stderr = '';
    const code = await main(['node', 'mcp-upgrade', 'scan', `missing\n\u001b[31m${secret}`], {
      stdout: (text) => {
        stdout += text;
      },
      stderr: (text) => {
        stderr += text;
      },
    });

    expect(code).toBe(2);
    expect(stdout).toBe('');
    expect(stderr).not.toContain(secret);
    expect(stderr).not.toContain('\u001b');
    expect(stderr).toContain('[REDACTED:');
    expect(sanitizeDiagnosticText(`bad\nAuthorization: Bearer ${secret}`)).not.toContain(secret);
  });

  it('makes every partial scan fail closed while preserving JSON', async () => {
    await withTempProject(
      {
        'package.json': '{"dependencies":{"@modelcontextprotocol/sdk":"^1.0.0"}}',
        'src/too-large.ts': 'x'.repeat(MAX_FILE_BYTES + 1),
      },
      async (target) => {
        const run = async (ci: boolean): Promise<{ code: number; stdout: string }> => {
          let stdout = '';
          const argv = [
            'node',
            'mcp-upgrade',
            'scan',
            target,
            '--format',
            'json',
            ...(ci ? ['--ci'] : []),
          ];
          const code = await main(argv, {
            stdout: (text) => {
              stdout += text;
            },
            stderr: () => undefined,
          });
          return { code, stdout };
        };

        const advisory = await run(false);
        const gated = await run(true);
        expect(advisory.code).toBe(2);
        expect(gated.code).toBe(2);
        expect(JSON.parse(advisory.stdout).scanStatus).toBe('partial');
        expect(JSON.parse(gated.stdout).scanStatus).toBe('partial');
      },
    );
  });
});
