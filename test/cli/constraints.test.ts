import { promises as fs } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { fixture, repoRoot, scanFixture } from '../helpers.js';

/**
 * Guardrails on what the scanner is allowed to be.
 *
 * These are the promises the README makes about privacy and safety. They are
 * tested rather than asserted in prose, because a promise about not phoning
 * home is only as good as the thing that would catch it changing.
 */

async function sourceFiles(): Promise<{ file: string; content: string }[]> {
  const srcDir = path.join(repoRoot, 'src');
  const out: { file: string; content: string }[] = [];

  const walk = async (dir: string): Promise<void> => {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.name.endsWith('.ts')) {
        out.push({
          file: path.relative(repoRoot, full),
          content: await fs.readFile(full, 'utf8'),
        });
      }
    }
  };

  await walk(srcDir);
  return out;
}

/**
 * Reduces a source file to the code that could actually *do* something.
 *
 * Comments, string literals and regular-expression literals are blanked. That
 * last one matters: this scanner detects `fetch` and `axios` call sites, so
 * those words appear inside detection patterns as data. A guard that could not
 * tell a pattern naming `fetch` from a call to `fetch` would be useless.
 */
function executableText(content: string): string {
  return content
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ')
    .replace(/'(?:[^'\\\n]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\\n]|\\.)*"/g, '""')
    .replace(/`(?:[^`\\]|\\.)*`/g, '``')
    .replace(/\/(?![*/])(?:[^/\\\n[]|\\.|\[(?:[^\]\\]|\\.)*\])+\/[gimsuyd]*/g, '/RE/');
}

describe('the scanner makes no network calls', () => {
  it('never references a network API in executable code', async () => {
    const forbidden = [
      /\bfetch\s*\(/,
      /\bXMLHttpRequest\b/,
      /\bWebSocket\b/,
      /\bnode:https?\b/,
      /\bfrom\s+['"]node:(?:http|https|net|dgram|tls)['"]/,
      /\brequire\s*\(\s*['"]node:(?:http|https|net|dgram|tls)['"]/,
      /\baxios\b/,
      /\bundici\b/,
      /\bgot\s*\(/,
    ];

    for (const { file, content } of await sourceFiles()) {
      const code = executableText(content);
      for (const pattern of forbidden) {
        expect(pattern.test(code), `${file} references ${pattern}`).toBe(false);
      }
    }
  });

  it('declares only the four permitted production dependencies', async () => {
    const manifest = JSON.parse(
      await fs.readFile(path.join(repoRoot, 'package.json'), 'utf8'),
    ) as { dependencies?: Record<string, string> };

    expect(Object.keys(manifest.dependencies ?? {}).sort()).toEqual([
      'chalk',
      'commander',
      'fast-glob',
      'typescript',
    ]);
  });
});

describe('the scanner never executes scanned code', () => {
  it('never references an evaluation or process-spawning API', async () => {
    const forbidden = [
      /\beval\s*\(/,
      /\bnew\s+Function\s*\(/,
      /\bchild_process\b/,
      /\bexecSync\b/,
      /\bspawnSync\b/,
      /\bnode:vm\b/,
      /\bvm\.runIn/,
    ];

    for (const { file, content } of await sourceFiles()) {
      const code = executableText(content);
      for (const pattern of forbidden) {
        expect(pattern.test(code), `${file} references ${pattern}`).toBe(false);
      }
    }
  });

  it('does not install or resolve dependencies from the scanned repository', async () => {
    // package.json is read as text and parsed; it is never require()d or
    // resolved, which would execute resolution logic against the target tree.
    for (const { file, content } of await sourceFiles()) {
      const code = executableText(content);
      expect(/\brequire\.resolve\s*\(/.test(code), file).toBe(false);
      expect(/\bcreateRequire\s*\(/.test(code), file).toBe(false);
    }
  });
});

describe('the scanner has no telemetry', () => {
  it('never references an analytics or telemetry destination', async () => {
    const forbidden = [
      /\banalytics\b/i,
      /\btelemetry\b/i,
      /\bsentry\b/i,
      /\bposthog\b/i,
      /\bmixpanel\b/i,
      /\bsegment\.io\b/i,
      /\bdatadog\b/i,
    ];

    for (const { file, content } of await sourceFiles()) {
      const code = executableText(content);
      for (const pattern of forbidden) {
        expect(pattern.test(code), `${file} references ${pattern}`).toBe(false);
      }
    }
  });

  it('writes nothing to disk during a scan', async () => {
    const before = await fs.readdir(fixture('clean-stdio-server'), { recursive: true });
    await scanFixture(fixture('clean-stdio-server'));
    const after = await fs.readdir(fixture('clean-stdio-server'), { recursive: true });

    expect([...after].sort()).toEqual([...before].sort());
  });

  it('leaves the scanned tree unmodified', async () => {
    const target = path.join(fixture('legacy-session-server'), 'src', 'server.ts');
    const before = await fs.readFile(target, 'utf8');
    await scanFixture(fixture('legacy-session-server'));
    expect(await fs.readFile(target, 'utf8')).toBe(before);
  });
});

describe('rule documentation stays in sync', () => {
  it('documents every implemented rule in the rule matrix', async () => {
    const { ALL_RULES } = await import('../../src/scanner/rules/index.js');
    const matrix = await fs.readFile(path.join(repoRoot, 'docs', 'rule-matrix.md'), 'utf8');

    for (const rule of ALL_RULES) {
      expect(matrix, `rule-matrix.md does not document ${rule.id}`).toContain(rule.id);
    }
  });

  it('documents every implemented rule in the README rule table', async () => {
    const { ALL_RULES } = await import('../../src/scanner/rules/index.js');
    const readme = await fs.readFile(path.join(repoRoot, 'README.md'), 'utf8');

    for (const rule of ALL_RULES) {
      expect(readme, `README.md does not document ${rule.id}`).toContain(rule.id);
    }
  });

  it('does not document rules that no longer exist', async () => {
    const { ALL_RULES } = await import('../../src/scanner/rules/index.js');
    const implemented = new Set(ALL_RULES.map((rule) => rule.id));
    const matrix = await fs.readFile(path.join(repoRoot, 'docs', 'rule-matrix.md'), 'utf8');

    for (const match of matrix.matchAll(/MCP2026-[A-Z]+-\d{3}/g)) {
      expect(implemented.has(match[0]), `${match[0]} is documented but not implemented`).toBe(true);
    }
  });

  it('cites the same source URL in the matrix as the rule declares', async () => {
    const { ALL_RULES } = await import('../../src/scanner/rules/index.js');
    const matrix = await fs.readFile(path.join(repoRoot, 'docs', 'rule-matrix.md'), 'utf8');

    for (const rule of ALL_RULES) {
      expect(matrix, `rule-matrix.md is missing the source URL for ${rule.id}`).toContain(
        rule.source.url,
      );
    }
  });
});
