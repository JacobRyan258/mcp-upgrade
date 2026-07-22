import { promises as fs } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { renderJsonReport } from '../../src/reporters/json.js';
import { computeReadiness } from '../../src/scanner/scoring.js';
import { estimateEffort } from '../../src/scanner/effort.js';
import { redact, toEvidence } from '../../src/scanner/redaction.js';
import {
  isTestPath,
  looksBinary,
  toIgnoreGlobs,
  toPosix,
} from '../../src/scanner/discovery.js';
import { lexCommentsJsonc, lexCommentsYaml } from '../../src/scanner/ast.js';
import { fixture, reportFor, withTempProject } from '../helpers.js';
import type { Finding } from '../../src/types.js';

const LEGACY = fixture('legacy-session-server');

function finding(overrides: Partial<Finding> = {}): Finding {
  return {
    ruleId: 'MCP2026-SESSION-001',
    level: 'error',
    confidence: 'high',
    category: 'stateless-lifecycle',
    title: 'test',
    file: 'src/a.ts',
    line: 1,
    evidence: 'evidence',
    explanation: 'explanation',
    remediation: 'remediation',
    source: { title: 'source', url: 'https://modelcontextprotocol.io/x' },
    autofix: 'manual',
    ...overrides,
  };
}

describe('determinism', () => {
  it('produces an identical report across repeated runs', async () => {
    const first = renderJsonReport(await reportFor(LEGACY));
    const second = renderJsonReport(await reportFor(LEGACY));
    expect(first).toBe(second);
  });

  it('produces a stable finding order', async () => {
    const a = (await reportFor(LEGACY)).findings.map((f) => `${f.ruleId} ${f.file}:${f.line}`);
    const b = (await reportFor(LEGACY)).findings.map((f) => `${f.ruleId} ${f.file}:${f.line}`);
    expect(a).toEqual(b);
  });

  it('orders findings by level, then category, then rule, file and line', async () => {
    const report = await reportFor(LEGACY);
    const rank = { error: 0, warning: 1, review: 2, info: 3 } as const;

    for (let i = 1; i < report.findings.length; i++) {
      const prev = report.findings[i - 1]!;
      const curr = report.findings[i]!;
      expect(rank[prev.level]).toBeLessThanOrEqual(rank[curr.level]);
      if (prev.level !== curr.level) continue;
      if (prev.category !== curr.category) {
        expect(prev.category.localeCompare(curr.category, 'en')).toBeLessThan(0);
        continue;
      }
      if (prev.ruleId !== curr.ruleId) {
        expect(prev.ruleId.localeCompare(curr.ruleId, 'en')).toBeLessThan(0);
        continue;
      }
      if (prev.file !== curr.file) {
        expect(prev.file.localeCompare(curr.file, 'en')).toBeLessThan(0);
        continue;
      }
      expect(prev.line).toBeLessThanOrEqual(curr.line);
    }
  });

  it('produces a stable score', async () => {
    const a = (await reportFor(LEGACY)).summary.readiness.score;
    const b = (await reportFor(LEGACY)).summary.readiness.score;
    expect(a).toBe(b);
  });
});

describe('scoring', () => {
  it('starts at 100 and deducts nothing for a clean scan', () => {
    const score = computeReadiness([]);
    expect(score.score).toBe(100);
    expect(score.deductions).toEqual([]);
  });

  it('applies the documented deduction per level and confidence', () => {
    expect(computeReadiness([finding({ level: 'error', confidence: 'high' })]).score).toBe(85);
    expect(computeReadiness([finding({ level: 'error', confidence: 'medium' })]).score).toBe(90);
    expect(computeReadiness([finding({ level: 'warning', confidence: 'medium' })]).score).toBe(95);
    expect(computeReadiness([finding({ level: 'review', confidence: 'low' })]).score).toBe(97);
    expect(computeReadiness([finding({ level: 'info', confidence: 'low' })]).score).toBe(100);
  });

  it('deducts once per rule per file regardless of repeat count', () => {
    const repeats = [
      finding({ line: 1 }),
      finding({ line: 2 }),
      finding({ line: 3 }),
      finding({ line: 4 }),
    ];
    const score = computeReadiness(repeats);
    expect(score.score).toBe(85);
    expect(score.deductions).toHaveLength(1);
  });

  it('deducts separately for the same rule in different files', () => {
    const score = computeReadiness([
      finding({ file: 'src/a.ts' }),
      finding({ file: 'src/b.ts' }),
    ]);
    expect(score.score).toBe(70);
    expect(score.deductions).toHaveLength(2);
  });

  it('clamps at zero', () => {
    const many = Array.from({ length: 40 }, (_, i) => finding({ file: `src/f${i}.ts` }));
    expect(computeReadiness(many).score).toBe(0);
  });

  it('explains its derivation', () => {
    const score = computeReadiness([finding()]);
    expect(score.explanation).toContain('Started at 100');
    expect(score.explanation).toContain('= 85');
  });
});

describe('effort estimation', () => {
  it('returns a range, not a single number', async () => {
    const report = await reportFor(LEGACY);
    expect(report.summary.effort.maxHours).toBeGreaterThan(report.summary.effort.minHours);
  });

  it('counts a redesign category once however many files it touches', () => {
    const estimate = estimateEffort([
      finding({ ruleId: 'MCP2026-SESSION-001', file: 'src/a.ts' }),
      finding({ ruleId: 'MCP2026-SESSION-002', file: 'src/b.ts' }),
      finding({ ruleId: 'MCP2026-LIFECYCLE-001', file: 'src/c.ts' }),
    ]);
    const session = estimate.items.find((item) => item.key === 'session-lifecycle');
    expect(session?.minHours).toBe(2);
    expect(session?.maxHours).toBe(8);
  });

  it('scales per-file categories but caps them', () => {
    const many = Array.from({ length: 20 }, (_, i) =>
      finding({ ruleId: 'MCP2026-HEADER-001', file: `src/f${i}.ts`, category: 'http-headers' }),
    );
    const header = estimateEffort(many).items.find((item) => item.key === 'header-migration');
    expect(header?.minHours).toBe(2.5); // 0.5 × 5-file cap
    expect(header?.maxHours).toBe(10);
  });

  it('assigns no effort to informational findings', () => {
    const estimate = estimateEffort([finding({ level: 'info', ruleId: 'MCP2026-APPS-001' })]);
    expect(estimate.items).toEqual([]);
    expect(estimate.maxHours).toBe(0);
  });

  it('states what the estimate excludes', () => {
    const estimate = estimateEffort([finding()]);
    expect(estimate.excludes.join(' ')).toMatch(/testing/);
    expect(estimate.excludes.join(' ')).toMatch(/deployment/);
  });
});

describe('redaction', () => {
  it.each([
    ['authorization: "Bearer abc123def456ghi789"', 'abc123def456ghi789'],
    ['const apiKey = "sk-proj-AbCdEfGhIjKlMnOpQrSt"', 'sk-proj-AbCdEfGhIjKlMnOpQrSt'],
    ['password: "hunter2hunter2"', 'hunter2hunter2'],
    ['"client_secret": "s3cr3t-value-here"', 's3cr3t-value-here'],
    ['DATABASE_URL=postgres://user:pw123456@host/db', 'pw123456'],
    ['-----BEGIN RSA PRIVATE KEY-----\nMIIabc\n-----END RSA PRIVATE KEY-----', 'MIIabc'],
    ['token: eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdef', 'eyJhbGciOiJIUzI1NiJ9'],
    ['ghp_AbCdEfGhIjKlMnOpQrStUvWxYz012345', 'ghp_AbCdEfGhIjKlMnOpQrStUvWxYz012345'],
  ])('redacts %s', (input, secret) => {
    const output = redact(input);
    expect(output).not.toContain(secret);
    expect(output).toContain('[REDACTED:');
  });

  it('leaves ordinary source code intact', () => {
    const code = "const sessionId = req.headers['mcp-session-id'];";
    expect(redact(code)).toBe(code);
  });

  it('leaves specification URLs intact', () => {
    const url = 'https://modelcontextprotocol.io/specification/draft/basic/transports';
    expect(redact(url)).toBe(url);
  });

  it('collapses and bounds evidence', () => {
    const long = `const x = {\n  a: 1,\n  b: ${'y'.repeat(400)}\n};`;
    const evidence = toEvidence(long);
    expect(evidence.length).toBeLessThanOrEqual(160);
    expect(evidence).not.toContain('\n');
  });
});

describe('comment lexers', () => {
  it('finds YAML comments but not a # inside a quoted string', () => {
    const yaml = '# leading\nkey: "https://example.com/#frag"\nother: value # trailing\n';
    const ranges = lexCommentsYaml(yaml);
    const texts = ranges.map((r) => yaml.slice(r.start, r.end));
    expect(texts).toContain('# leading');
    expect(texts).toContain('# trailing');
    expect(texts.join('')).not.toContain('frag');
  });

  it('finds JSONC comments but not a // inside a string', () => {
    const json = '{\n  // note\n  "url": "https://example.com/x",\n  /* block */ "a": 1\n}';
    const texts = lexCommentsJsonc(json).map((r) => json.slice(r.start, r.end));
    expect(texts).toContain('// note');
    expect(texts).toContain('/* block */');
    expect(texts.join('')).not.toContain('example.com');
  });
});

describe('discovery', () => {
  it('normalises paths to POSIX', () => {
    expect(toPosix(path.join('a', 'b', 'c.ts'))).toBe('a/b/c.ts');
  });

  it('recognises test paths by directory and by suffix', () => {
    expect(isTestPath('test/foo.ts')).toBe(true);
    expect(isTestPath('src/__tests__/foo.ts')).toBe(true);
    expect(isTestPath('src/foo.test.ts')).toBe(true);
    expect(isTestPath('src/foo.spec.js')).toBe(true);
    // A directory named for testing is not the same as a test directory.
    expect(isTestPath('src/testing-utils.ts')).toBe(false);
    expect(isTestPath('src/server.ts')).toBe(false);
  });

  it('expands a bare ignore name to match at any depth', () => {
    expect(toIgnoreGlobs('dist')).toEqual(['**/dist', '**/dist/**']);
    expect(toIgnoreGlobs('**/*.gen.ts')).toEqual(['**/*.gen.ts']);
    expect(toIgnoreGlobs('  ')).toEqual([]);
  });

  it('detects binary content by NUL byte', () => {
    expect(looksBinary(Buffer.from('plain text'))).toBe(false);
    expect(looksBinary(Buffer.from([0x50, 0x00, 0x4b]))).toBe(true);
  });

  it('skips test directories by default and includes them on request', async () => {
    await withTempProject(
      {
        'package.json': JSON.stringify({
          dependencies: { '@modelcontextprotocol/sdk': '^1.0.0' },
        }),
        'src/server.ts': "import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';\nexport const s = McpServer;\n",
        'test/fixtures/legacy.ts': "export const H = 'mcp-session-id';\n",
      },
      async (dir) => {
        const excluded = await reportFor(dir);
        expect(excluded.findings.filter((f) => f.ruleId === 'MCP2026-SESSION-001')).toEqual([]);

        const included = await reportFor(dir, { includeTests: true });
        expect(
          included.findings.filter((f) => f.ruleId === 'MCP2026-SESSION-001').length,
        ).toBeGreaterThan(0);
      },
    );
  });

  it('honours --ignore patterns', async () => {
    await withTempProject(
      {
        'package.json': JSON.stringify({
          dependencies: { '@modelcontextprotocol/sdk': '^1.0.0' },
        }),
        'src/server.ts': "import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';\nexport const s = McpServer;\n",
        'legacy/old.ts': "export const H = 'mcp-session-id';\n",
      },
      async (dir) => {
        const scanned = await reportFor(dir);
        expect(scanned.findings.some((f) => f.file === 'legacy/old.ts')).toBe(true);

        const ignored = await reportFor(dir, { ignore: 'legacy' });
        expect(ignored.findings.some((f) => f.file === 'legacy/old.ts')).toBe(false);
      },
    );
  });

  it('skips oversized files and reports them', async () => {
    await withTempProject(
      {
        'package.json': JSON.stringify({
          dependencies: { '@modelcontextprotocol/sdk': '^1.0.0' },
        }),
        'huge.ts': `const pad = "${'x'.repeat(1_100_000)}";\nexport const H = 'mcp-session-id';\n`,
      },
      async (dir) => {
        const report = await reportFor(dir);
        const entry = report.files.find((file) => file.file === 'huge.ts');
        expect(entry?.scanned).toBe(false);
        expect(entry?.skipped).toBe('too-large');
        expect(report.summary.filesSkipped).toBeGreaterThan(0);
      },
    );
  });

  it('skips binary files', async () => {
    await withTempProject({ 'package.json': '{}' }, async (dir) => {
      await fs.writeFile(path.join(dir, 'blob.json'), Buffer.from([0x7b, 0x00, 0x7d]));
      const report = await reportFor(dir);
      expect(report.files.find((file) => file.file === 'blob.json')?.skipped).toBe('binary');
    });
  });

  it('does not follow a symlink that escapes the scan root', async () => {
    await withTempProject(
      {
        'package.json': JSON.stringify({
          dependencies: { '@modelcontextprotocol/sdk': '^1.0.0' },
        }),
        'inside/server.ts': "export const H = 'ok';\n",
      },
      async (dir) => {
        const outside = path.join(dir, '..', `outside-${path.basename(dir)}.ts`);
        await fs.writeFile(outside, "export const H = 'mcp-session-id';\n", 'utf8');
        try {
          await fs.symlink(outside, path.join(dir, 'inside', 'linked.ts'));
        } catch {
          return; // Symlink creation is not permitted here; nothing to assert.
        }

        const report = await reportFor(dir);
        expect(report.findings.some((f) => f.file.includes('linked'))).toBe(false);
        await fs.rm(outside, { force: true });
      },
    );
  });
});

describe('confidence filtering', () => {
  it('drops lower-confidence findings above the threshold', async () => {
    const all = await reportFor(LEGACY, { minConfidence: 'low' });
    const highOnly = await reportFor(LEGACY, { minConfidence: 'high' });

    expect(highOnly.findings.length).toBeLessThan(all.findings.length);
    expect(
      highOnly.findings.every((f) => f.confidence === 'high' || f.level === 'info'),
    ).toBe(true);
  });

  it('never filters out informational findings, which explain a clean pass', async () => {
    const report = await reportFor(fixture('clean-http-server'), { minConfidence: 'high' });
    expect(report.findings.some((f) => f.level === 'info')).toBe(true);
  });
});
