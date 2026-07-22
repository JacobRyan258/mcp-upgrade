import { promises as fs } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { main } from '../../src/cli/index.js';
import type { CliIo } from '../../src/cli/index.js';
import {
  EXIT_FINDINGS,
  EXIT_INTERNAL,
  EXIT_OK,
  EXIT_USAGE,
} from '../../src/constants.js';
import { runScan } from '../../src/scanner/engine.js';
import { resolveOptions } from '../../src/cli/commands/scan.js';
import { InternalScannerError } from '../../src/types.js';
import { ANSI_PATTERN, fixture, withTempProject } from '../helpers.js';
import type { ScanReport } from '../../src/types.js';

interface CliRun {
  code: number;
  stdout: string;
  stderr: string;
}

/** Runs the CLI in-process and captures both streams. */
async function cli(...args: string[]): Promise<CliRun> {
  let stdout = '';
  let stderr = '';
  const io: CliIo = {
    stdout: (text) => {
      stdout += text;
    },
    stderr: (text) => {
      stderr += text;
    },
  };
  const code = await main(['node', 'mcp-upgrade', ...args], io);
  return { code, stdout, stderr };
}

const CLEAN = fixture('clean-stdio-server');
const LEGACY = fixture('legacy-session-server');
const DEPRECATED = fixture('deprecated-features-server');

describe('help and version', () => {
  it('prints help', async () => {
    const { code, stdout } = await cli('--help');
    expect(code).toBe(EXIT_OK);
    expect(stdout).toContain('mcp-upgrade');
    expect(stdout).toContain('scan');
  });

  it('prints help through the explicit help command', async () => {
    const { code, stdout } = await cli('help', 'scan');
    expect(code).toBe(EXIT_OK);
    expect(stdout).toContain('Usage: mcp-upgrade scan');
  });

  it('prints scan help with every documented option and exit code', async () => {
    const { code, stdout } = await cli('scan', '--help');
    expect(code).toBe(EXIT_OK);

    for (const flag of [
      '-f, --format',
      '-t, --target',
      '--ignore',
      '--include-tests',
      '--min-confidence',
      '--ci',
      '--fail-on',
      '--no-color',
      '--verbose',
    ]) {
      expect(stdout, `missing flag: ${flag}`).toContain(flag);
    }

    expect(stdout).toContain('Exit codes:');
    expect(stdout).toContain('0  Scan completed');
    expect(stdout).toContain('1  Scan completed');
    expect(stdout).toContain('2  Invalid CLI arguments');
    expect(stdout).toContain('3  Internal scanner failure');
  });

  it('prints the version', async () => {
    const { code, stdout } = await cli('--version');
    expect(code).toBe(EXIT_OK);
    expect(stdout.trim()).toMatch(/^\d+\.\d+\.\d+$/);
  });
});

describe('exit code 0 — scan completed below the threshold', () => {
  it('returns 0 for a clean repository without --ci', async () => {
    const { code } = await cli('scan', CLEAN, '--no-color');
    expect(code).toBe(EXIT_OK);
  });

  it('returns 0 even for a repository full of findings when --ci is absent', async () => {
    const { code } = await cli('scan', LEGACY, '--no-color');
    expect(code).toBe(EXIT_OK);
  });

  it('returns 0 with --ci for a clean repository', async () => {
    const { code } = await cli('scan', CLEAN, '--ci');
    expect(code).toBe(EXIT_OK);
  });

  it('returns 0 with --ci when only deprecations exist and --fail-on is error', async () => {
    // Deprecations are not breaking changes, so the default CI threshold must
    // not fail a build for them.
    await withTempProject(
      {
        'package.json': JSON.stringify({
          dependencies: { '@modelcontextprotocol/server': '^2.0.0-beta.0' },
        }),
        'server.ts': `
          import { McpServer } from '@modelcontextprotocol/server';
          export const s = McpServer;
          export const capabilities = { sampling: {}, roots: {} };
        `,
      },
      async (dir) => {
        const { code, stdout } = await cli('scan', dir, '--ci', '--format', 'json');
        const report = JSON.parse(stdout) as ScanReport;
        expect(report.summary.counts.warning).toBeGreaterThan(0);
        expect(report.summary.counts.error).toBe(0);
        expect(code).toBe(EXIT_OK);
      },
    );
  });
});

describe('exit code 1 — findings reached the threshold', () => {
  it('returns 1 with --ci for confirmed incompatibilities', async () => {
    const { code } = await cli('scan', LEGACY, '--ci');
    expect(code).toBe(EXIT_FINDINGS);
  });

  it('returns 1 with --ci --fail-on warning when deprecations exist', async () => {
    const { code } = await cli('scan', DEPRECATED, '--ci', '--fail-on', 'warning');
    expect(code).toBe(EXIT_FINDINGS);
  });

  it('returns 1 with --ci --fail-on review for review-only findings', async () => {
    const { code: strict } = await cli(
      'scan',
      fixture('ambiguous-wrapper-server'),
      '--ci',
      '--fail-on',
      'review',
    );
    expect(strict).toBe(EXIT_FINDINGS);

    const { code: lenient } = await cli(
      'scan',
      fixture('ambiguous-wrapper-server'),
      '--ci',
      '--fail-on',
      'error',
    );
    expect(lenient).toBe(EXIT_OK);
  });
});

describe('exit code 2 — invalid arguments or unreadable target', () => {
  it('returns 2 when an option terminator is supplied without a command', async () => {
    const { code, stdout, stderr } = await cli('--');
    expect(code).toBe(EXIT_USAGE);
    expect(stdout).toBe('');
    expect(stderr).toContain('Usage: mcp-upgrade');
  });

  it('returns 2 for a path that does not exist', async () => {
    const { code, stderr } = await cli('scan', '/definitely/not/a/real/path-xyz');
    expect(code).toBe(EXIT_USAGE);
    expect(stderr).toContain('does not exist');
  });

  it('returns 2 for an invalid --format', async () => {
    const { code, stderr } = await cli('scan', CLEAN, '--format', 'yaml');
    expect(code).toBe(EXIT_USAGE);
    expect(stderr).toContain('--format');
  });

  it('returns 2 for an invalid --min-confidence', async () => {
    const { code } = await cli('scan', CLEAN, '--min-confidence', 'certain');
    expect(code).toBe(EXIT_USAGE);
  });

  it('returns 2 for an invalid --fail-on', async () => {
    const { code } = await cli('scan', CLEAN, '--ci', '--fail-on', 'everything');
    expect(code).toBe(EXIT_USAGE);
  });

  it('returns 2 for an unknown --target', async () => {
    const { code, stderr } = await cli('scan', CLEAN, '--target', '2027-01-01');
    expect(code).toBe(EXIT_USAGE);
    expect(stderr).toContain('Unknown target');
  });

  it('returns 2 for an unsupported single-file type', async () => {
    await withTempProject({ 'notes.md': '# hello' }, async (dir) => {
      const { code, stderr } = await cli('scan', path.join(dir, 'notes.md'));
      expect(code).toBe(EXIT_USAGE);
      expect(stderr).toContain('Unsupported file type');
    });
  });

  it('returns 2 when the path argument is missing', async () => {
    const { code } = await cli('scan');
    expect(code).toBe(EXIT_USAGE);
  });

  it('returns 2 for an unreadable directory', async () => {
    await withTempProject({ 'locked/keep.ts': 'export const a = 1;\n' }, async (dir) => {
      const locked = path.join(dir, 'locked');
      await fs.chmod(locked, 0o000);
      try {
        const { code, stderr } = await cli('scan', locked);
        // Running as root defeats the permission bit; only assert when it held.
        if (code === EXIT_USAGE) expect(stderr).toMatch(/permission denied/i);
      } finally {
        await fs.chmod(locked, 0o755);
      }
    });
  });
});

describe('exit code 3 — internal scanner failure', () => {
  it('maps an unexpected rule failure to 3, never to 1', async () => {
    const options = await resolveOptions(CLEAN, {});
    const exploding = {
      id: 'MCP2026-TEST-001',
      title: 'exploding rule',
      category: 'stateless-lifecycle' as const,
      targetVersion: '2026-07-28',
      level: 'error' as const,
      defaultConfidence: 'high' as const,
      source: { title: 't', url: 'https://modelcontextprotocol.io/x' },
      appliesTo: {
        fileKinds: ['ts' as const],
        transports: ['stdio' as const],
      },
      autofix: 'none' as const,
      description: 'A rule that throws, used to verify internal-failure handling.',
      scan: async (): Promise<never> => {
        throw new Error('boom');
      },
    };

    await expect(runScan(options, { rules: [exploding] })).rejects.toBeInstanceOf(
      InternalScannerError,
    );
  });

  it('reports an internal failure as exit 3 from main', async () => {
    let stderr = '';
    const io: CliIo = {
      stdout: () => {
        throw new Error('output failed');
      },
      stderr: (text) => {
        stderr += text;
      },
    };
    const code = await main(['node', 'mcp-upgrade', 'scan', CLEAN, '--target', '2026-07-28'], io);
    expect(code).toBe(EXIT_INTERNAL);
    expect(stderr).toContain('internal error');
  });
});

describe('output formats', () => {
  it('produces valid JSON on stdout', async () => {
    const { code, stdout } = await cli('scan', LEGACY, '--format', 'json');
    expect(code).toBe(EXIT_OK);
    const report = JSON.parse(stdout) as ScanReport;
    expect(report.schemaVersion).toBe('1.0');
  });

  it('produces JSON with no ANSI even without --no-color', async () => {
    const { stdout } = await cli('scan', LEGACY, '--format', 'json');
    expect(ANSI_PATTERN.test(stdout)).toBe(false);
  });

  it('produces a checklist with no ANSI even without --no-color', async () => {
    const { stdout } = await cli('scan', LEGACY, '--format', 'checklist');
    expect(ANSI_PATTERN.test(stdout)).toBe(false);
    expect(stdout).toContain('## MCP 2026-07-28 Migration Checklist');
  });

  it('produces plain text with --no-color', async () => {
    const { stdout } = await cli('scan', LEGACY, '--no-color');
    expect(ANSI_PATTERN.test(stdout)).toBe(false);
  });

  it('treats NO_COLOR presence as higher priority than FORCE_COLOR', async () => {
    const previousNoColor = process.env.NO_COLOR;
    const previousForceColor = process.env.FORCE_COLOR;
    process.env.NO_COLOR = '';
    process.env.FORCE_COLOR = '1';
    try {
      const { stdout } = await cli('scan', CLEAN);
      expect(ANSI_PATTERN.test(stdout)).toBe(false);
    } finally {
      if (previousNoColor === undefined) delete process.env.NO_COLOR;
      else process.env.NO_COLOR = previousNoColor;
      if (previousForceColor === undefined) delete process.env.FORCE_COLOR;
      else process.env.FORCE_COLOR = previousForceColor;
    }
  });

  it('lists scanned files and rule execution under --verbose', async () => {
    const { stdout } = await cli('scan', CLEAN, '--no-color', '--verbose');
    expect(stdout).toContain('Verbose: rule execution');
    expect(stdout).toContain('src/server.ts');
    expect(stdout).toContain('rule MCP2026-');
  });

  it('explains why HTTP rules were skipped for a stdio server under --verbose', async () => {
    const { stdout } = await cli('scan', CLEAN, '--no-color', '--verbose');
    expect(stdout).toMatch(/MCP2026-HEADER-00\d: skipped — does not apply to transport "stdio"/);
  });
});

describe('option plumbing', () => {
  it('honours --ignore from the command line', async () => {
    const { stdout: withAll } = await cli('scan', LEGACY, '--format', 'json');
    const { stdout: withoutDeploy } = await cli(
      'scan',
      LEGACY,
      '--format',
      'json',
      '--ignore',
      'deploy',
    );

    const all = JSON.parse(withAll) as ScanReport;
    const filtered = JSON.parse(withoutDeploy) as ScanReport;

    expect(all.findings.some((f) => f.file.startsWith('deploy/'))).toBe(true);
    expect(filtered.findings.some((f) => f.file.startsWith('deploy/'))).toBe(false);
  });

  it('accepts several comma-separated --ignore patterns', async () => {
    const { stdout } = await cli(
      'scan',
      LEGACY,
      '--format',
      'json',
      '--ignore',
      'deploy,src/sessions.ts',
    );
    const report = JSON.parse(stdout) as ScanReport;
    expect(report.findings.some((f) => f.file === 'src/sessions.ts')).toBe(false);
    expect(report.findings.some((f) => f.file.startsWith('deploy/'))).toBe(false);
  });

  it('honours --min-confidence', async () => {
    const { stdout } = await cli('scan', LEGACY, '--format', 'json', '--min-confidence', 'high');
    const report = JSON.parse(stdout) as ScanReport;
    expect(report.findings.every((f) => f.confidence === 'high' || f.level === 'info')).toBe(true);
  });

  it('defaults to the documented target and format', async () => {
    const { stdout } = await cli('scan', CLEAN, '--no-color');
    expect(stdout).toContain('Target: MCP 2026-07-28 RC');
    expect(stdout).toContain('MCP Upgrade Scanner');
  });
});
