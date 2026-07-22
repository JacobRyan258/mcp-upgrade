import { promises as fs } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import {
  MAX_FILE_BYTES,
  MAX_PARSE_TOKENS_PER_FILE,
  MAX_SOURCE_LINES_PER_FILE,
  MAX_SOURCE_LINE_LENGTH,
} from '../src/constants.js';
import { isScanReport } from '../src/index.js';
import { resolveScanOptions } from '../src/options.js';
import {
  collectHeaderAccess,
  computeLineStarts,
  lexCommentsJsonc,
  lexCommentsYaml,
  nodeAt,
} from '../src/scanner/ast.js';
import { discover } from '../src/scanner/discovery.js';
import { runScan } from '../src/scanner/engine.js';
import { redact, sanitizeReportText } from '../src/scanner/redaction.js';
import { matches } from '../src/scanner/rules/helpers.js';
import { UsageError, type Finding, type ScannerRule } from '../src/types.js';
import { fixture, reportFor, withTempProject } from './helpers.js';

describe('hostile filesystem boundaries', () => {
  it('includes hidden source files in a complete scan', async () => {
    await withTempProject(
      { '.server.ts': "export const header = 'mcp-session-id';\n" },
      async (dir) => {
        const report = await reportFor(dir);
        expect(report.files.some((file) => file.file === '.server.ts' && file.scanned)).toBe(true);
        expect(report.scanStatus).toBe('complete');
      },
    );
  });

  it('reports invalid UTF-8 and a late NUL instead of scanning lossy text', async () => {
    await withTempProject({ 'src/ok.ts': 'export const ok = true;\n' }, async (dir) => {
      await fs.writeFile(path.join(dir, 'src/invalid.ts'), Buffer.from([0x63, 0xff, 0x3b]));
      await fs.writeFile(
        path.join(dir, 'src/late-nul.ts'),
        Buffer.concat([Buffer.alloc(9_000, 0x61), Buffer.from([0, 0x62])]),
      );

      const report = await reportFor(dir);
      expect(report.files.find((file) => file.file === 'src/invalid.ts')?.skipped).toBe(
        'invalid-utf8',
      );
      expect(report.files.find((file) => file.file === 'src/late-nul.ts')?.skipped).toBe('binary');
      expect(report.scanStatus).toBe('partial');
      expect(report.issues.map((issue) => issue.code)).toEqual(
        expect.arrayContaining(['binary', 'invalid-utf8']),
      );
    });
  });

  it('reports malformed package JSON and JavaScript syntax as parse failures', async () => {
    await withTempProject(
      {
        'package.json': '{"name":"broken",}',
        'broken.ts': 'export const value = {\n',
        'broken.js': 'export const value = ;\n',
        'tsconfig.json': '{ // JSONC is valid for TypeScript configuration\n"compilerOptions": {}\n}',
        'valid.ts': 'export const valid = true;\n',
      },
      async (dir) => {
        const report = await reportFor(dir);
        const parseFailures = report.files
          .filter((file) => file.skipped === 'parse-failure')
          .map((file) => file.file)
          .sort();
        expect(parseFailures).toEqual(['broken.js', 'broken.ts', 'package.json']);
        expect(report.files.find((file) => file.file === 'tsconfig.json')?.scanned).toBe(true);
        expect(report.summary.filesDiscovered).toBe(5);
        expect(report.summary.filesScanned).toBe(2);
        expect(report.summary.filesSkipped).toBe(3);
        expect(report.scanStatus).toBe('partial');
        expect(report.issues.filter((issue) => issue.code === 'parse-failure')).toHaveLength(3);
      },
    );
  });

  it('does not read or classify a package manifest symlinked outside the root', async () => {
    await withTempProject({ 'src/server.ts': 'export const ok = true;\n' }, async (dir) => {
      const outside = path.join(path.dirname(dir), `${path.basename(dir)}-outside-package.json`);
      await fs.writeFile(
        outside,
        JSON.stringify({
          name: 'outside-secret',
          dependencies: { '@modelcontextprotocol/sdk': '^1.99.0' },
        }),
      );
      try {
        await fs.symlink(outside, path.join(dir, 'package.json'));
        const report = await reportFor(dir);
        expect(report.repository.packageName).toBeNull();
        expect(report.repository.sdk).toBeNull();
        expect(report.files.some((file) => file.file === 'package.json')).toBe(false);
        expect(report.issues).toContainEqual(
          expect.objectContaining({ path: 'package.json', code: 'symlink-outside-root' }),
        );
        expect(report.scanStatus).toBe('partial');
      } finally {
        await fs.rm(outside, { force: true });
      }
    });
  });

  it('reports in-root, broken, circular and directory symlinks without following them', async () => {
    await withTempProject({ 'src/target.ts': 'export const target = true;\n' }, async (dir) => {
      const outside = `${dir}-outside`;
      await fs.mkdir(outside);
      await fs.writeFile(
        path.join(outside, 'escape.ts'),
        "export const leaked = 'mcp-session-id';\n",
      );
      try {
        await fs.symlink('target.ts', path.join(dir, 'src/in-root.ts'));
        await fs.symlink('missing.ts', path.join(dir, 'src/broken.ts'));
        await fs.symlink('circle-b.ts', path.join(dir, 'src/circle-a.ts'));
        await fs.symlink('circle-a.ts', path.join(dir, 'src/circle-b.ts'));
        await fs.symlink(outside, path.join(dir, 'linked-directory'));

        const report = await reportFor(dir);
        const issues = new Map(report.issues.map((issue) => [issue.path, issue.code]));
        expect(issues.get('src/in-root.ts')).toBe('symlink');
        expect(issues.get('src/broken.ts')).toBe('symlink');
        expect(issues.get('src/circle-a.ts')).toBe('symlink');
        expect(issues.get('src/circle-b.ts')).toBe('symlink');
        expect(issues.get('linked-directory')).toBe('symlink-outside-root');
        expect(report.files.map((file) => file.file)).toEqual(['src/target.ts']);
        expect(report.summary.filesDiscovered).toBe(1);
        expect(report.summary.filesSkipped).toBe(0);
        expect(report.findings.some((finding) => finding.file.includes('escape.ts'))).toBe(false);
        expect(report.scanStatus).toBe('partial');
      } finally {
        await fs.rm(outside, { recursive: true, force: true });
      }
    });
  });

  it('discards staged names when an ancestor changes while a nested directory is opened', async () => {
    await withTempProject(
      { 'src/nested/inside.ts': 'export const inside = true;\n' },
      async (dir) => {
        const outside = `${dir}-outside-directory`;
        const outsideMarker = 'outside-secret-file.ts';
        const sourceDirectory = path.join(dir, 'src');
        const nestedDirectory = await fs.realpath(path.join(sourceDirectory, 'nested'));
        const heldDirectory = path.join(dir, '.held-src');
        await fs.mkdir(outside);
        await fs.writeFile(
          path.join(outside, outsideMarker),
          'export const outsideContent = true;\n',
        );

        let injected = false;
        try {
          const options = await resolveScanOptions(dir, { verbose: true });
          const result = await runScan(options, {
            rules: [],
            discovery: {
              openDirectory: async (absPath) => {
                if (absPath !== nestedDirectory || injected) return fs.opendir(absPath);
                injected = true;
                await fs.rename(sourceDirectory, heldDirectory);
                try {
                  return await fs.opendir(outside);
                } finally {
                  await fs.rename(heldDirectory, sourceDirectory);
                }
              },
            },
          });

          expect(injected).toBe(true);
          expect(result.report.scanStatus).toBe('partial');
          expect(result.report.issues).toContainEqual(
            expect.objectContaining({ code: 'unreadable-directory', path: 'src/nested' }),
          );
          const serialized = JSON.stringify(result);
          expect(serialized).not.toContain(outsideMarker);
          expect(result.report.files.some((file) => file.file === 'src/nested/inside.ts')).toBe(
            false,
          );
        } finally {
          await fs.rm(outside, { recursive: true, force: true });
        }
      },
    );
  });

  it('discards staged entries when directory identity changes during enumeration', async () => {
    await withTempProject(
      { 'src/nested/inside.ts': 'export const inside = true;\n' },
      async (dir) => {
        const nestedDirectory = await fs.realpath(path.join(dir, 'src/nested'));
        const marker = 'staged-outside-name.ts';
        const fakeDirectory = {
          close: async () => undefined,
          async *[Symbol.asyncIterator]() {
            yield {
              name: marker,
              isSymbolicLink: () => false,
              isDirectory: () => false,
              isFile: () => true,
            };
            await fs.utimes(nestedDirectory, new Date(1_000), new Date(1_000));
          },
        } as unknown as Awaited<ReturnType<typeof fs.opendir>>;
        const options = await resolveScanOptions(dir, { verbose: true });
        const result = await runScan(options, {
          rules: [],
          discovery: {
            openDirectory: async (absPath) =>
              absPath === nestedDirectory ? fakeDirectory : fs.opendir(absPath),
          },
        });

        expect(result.report.scanStatus).toBe('partial');
        expect(result.report.issues).toContainEqual(
          expect.objectContaining({ code: 'unreadable-directory', path: 'src/nested' }),
        );
        expect(JSON.stringify(result)).not.toContain(marker);
      },
    );
  });

  it('charges rejected files against the inspection budget', async () => {
    await withTempProject({ 'c-safe.ts': 'export const safe = true;\n' }, async (dir) => {
      await fs.writeFile(path.join(dir, 'a-binary.ts'), Buffer.from([0, 1, 2]));
      await fs.writeFile(path.join(dir, 'b-invalid.ts'), Buffer.from([0xff, 0xfe]));
      const options = await resolveScanOptions(dir, {});
      const { report } = await runScan({ ...options, maxFiles: 2 });

      expect(report.summary.filesScanned).toBe(0);
      expect(report.files.find((file) => file.file === 'c-safe.ts')?.skipped).toBe('scan-limit');
      expect(report.scanStatus).toBe('partial');
    });
  });

  it('rejects dense syntax before constructing a parent-linked AST', async () => {
    const denseSource = 'a;'.repeat(Math.floor(MAX_FILE_BYTES / 2) - 1);
    await withTempProject({ 'dense.ts': denseSource }, async (dir) => {
      const options = await resolveScanOptions(dir, {});
      const { report } = await runScan(options, { rules: [] });

      expect(Buffer.byteLength(denseSource)).toBeLessThan(MAX_FILE_BYTES);
      expect(report.files).toContainEqual(
        expect.objectContaining({ file: 'dense.ts', skipped: 'complexity-limit' }),
      );
      expect(report.issues).toContainEqual(
        expect.objectContaining({ path: 'dense.ts', code: 'complexity-limit' }),
      );
      expect(report.scanStatus).toBe('partial');
    });
  });

  it('charges dense comment trivia before retaining comment ranges', async () => {
    const denseComments = `${'/**/'.repeat(MAX_PARSE_TOKENS_PER_FILE)}a;`;
    await withTempProject({ 'dense-comments.ts': denseComments }, async (dir) => {
      const options = await resolveScanOptions(dir, {});
      const { report } = await runScan(options, { rules: [] });

      expect(Buffer.byteLength(denseComments)).toBeLessThan(MAX_FILE_BYTES);
      expect(report.files).toContainEqual(
        expect.objectContaining({ file: 'dense-comments.ts', skipped: 'complexity-limit' }),
      );
      expect(report.scanStatus).toBe('partial');
    });
  });

  it('charges structured JSDoc payload that TypeScript expands into tag nodes', async () => {
    const jsDocFlood = `/** ${'@param value description '.repeat(24_000)}*/\nfunction f() {}`;
    await withTempProject({ 'jsdoc-flood.ts': jsDocFlood }, async (dir) => {
      const options = await resolveScanOptions(dir, {});
      const { report } = await runScan(options, { rules: [] });

      expect(Buffer.byteLength(jsDocFlood)).toBeLessThan(MAX_FILE_BYTES);
      expect(report.files).toContainEqual(
        expect.objectContaining({ file: 'jsdoc-flood.ts', skipped: 'complexity-limit' }),
      );
      expect(report.scanStatus).toBe('partial');
    });
  });

  it('retains large ordinary comment payload when it has no JSDoc structure', async () => {
    const proseComment = `/*${'x'.repeat(MAX_FILE_BYTES - 128)}*/\nexport const ok = true;\n`;
    await withTempProject({ 'prose-comment.ts': proseComment }, async (dir) => {
      const options = await resolveScanOptions(dir, {});
      const { report } = await runScan(options, { rules: [] });

      expect(Buffer.byteLength(proseComment)).toBeLessThan(MAX_FILE_BYTES);
      expect(report.files).toContainEqual(
        expect.objectContaining({ file: 'prose-comment.ts', scanned: true }),
      );
      expect(report.scanStatus).toBe('complete');
    });
  });

  it('enforces aggregate AST complexity across otherwise acceptable files', async () => {
    const moderateSource = 'a;'.repeat(60_000);
    await withTempProject(
      Object.fromEntries(
        Array.from({ length: 5 }, (_, index) => [`${index + 1}.ts`, moderateSource]),
      ),
      async (dir) => {
        const options = await resolveScanOptions(dir, {});
        const { report } = await runScan(options, { rules: [] });

        expect(report.files.filter((file) => file.scanned)).toHaveLength(4);
        expect(report.files.find((file) => file.file === '5.ts')?.skipped).toBe(
          'complexity-limit',
        );
        expect(report.scanStatus).toBe('partial');
      },
    );
  });

  it('accepts near-limit literal payload without charging it as dense syntax', async () => {
    const source = `export const prose = ${JSON.stringify('x'.repeat(MAX_FILE_BYTES - 128))};\n`;
    await withTempProject({ 'prose.ts': source }, async (dir) => {
      const options = await resolveScanOptions(dir, {});
      const { report } = await runScan(options, { rules: [] });

      expect(Buffer.byteLength(source)).toBeLessThan(MAX_FILE_BYTES);
      expect(report.files).toContainEqual(
        expect.objectContaining({ file: 'prose.ts', scanned: true }),
      );
      expect(report.scanStatus).toBe('complete');
    });
  });

  it('bounds source line count and structural line length', async () => {
    await withTempProject(
      {
        'many-lines.ts': '\n'.repeat(MAX_SOURCE_LINES_PER_FILE),
        'long-token.ts': `${'a'.repeat(MAX_SOURCE_LINE_LENGTH + 1)};`,
      },
      async (dir) => {
        const options = await resolveScanOptions(dir, {});
        const { report } = await runScan(options, { rules: [] });

        expect(
          report.files
            .filter((file) => file.skipped === 'complexity-limit')
            .map((file) => file.file),
        ).toEqual(['long-token.ts', 'many-lines.ts']);
        expect(report.scanStatus).toBe('partial');
      },
    );
  });

  it('bounds an adversarial ignore glob against a long nested path', async () => {
    const segments = Array.from({ length: 6 }, (_, index) => `${'a'.repeat(100)}${index}`);
    const relPath = path.join(...segments, `${'b'.repeat(180)}.ts`);
    await withTempProject({ [relPath]: 'export const safe = true;\n' }, async (dir) => {
      const options = await resolveScanOptions(dir, {});
      options.ignore = [`${'*'.repeat(512)}z`];
      const started = performance.now();
      const { report } = await runScan(options);
      const elapsedMs = performance.now() - started;

      expect(report.files.some((file) => file.file.endsWith('.ts') && file.scanned)).toBe(true);
      expect(elapsedMs).toBeLessThan(1_000);
    });
  });

  it('bounds retained discovery paths and uses a generic limit sentinel', async () => {
    await withTempProject({}, async (dir) => {
      const marker = 'attacker-controlled-final-name.ts';
      const fakeDirectory = {
        close: async () => undefined,
        async *[Symbol.asyncIterator]() {
          for (let index = 0; index < 24_998; index++) {
            yield {
              name: 'tests',
              isSymbolicLink: () => false,
              isDirectory: () => true,
              isFile: () => false,
            };
          }
          yield {
            name: marker,
            isSymbolicLink: () => false,
            isDirectory: () => true,
            isFile: () => false,
          };
        },
      } as unknown as Awaited<ReturnType<typeof fs.opendir>>;
      const options = await resolveScanOptions(dir, {});
      const result = await discover(options, {
        openDirectory: async () => fakeDirectory,
      });

      expect(result.skipped.length).toBeLessThanOrEqual(25_000);
      expect(result.skipped).toContainEqual(
        expect.objectContaining({ relPath: '.', reason: 'discovery-limit' }),
      );
      expect(JSON.stringify(result)).not.toContain(marker);
    });
  });

  it('preserves recursive globstar ignore semantics', async () => {
    await withTempProject(
      {
        'src/nested/generated.gen.ts': 'export const generated = true;\n',
        'src/nested/keep.ts': 'export const keep = true;\n',
      },
      async (dir) => {
        const options = await resolveScanOptions(dir, { ignore: '**/*.gen.ts' });
        const { report } = await runScan(options);
        expect(report.files.some((file) => file.file === 'src/nested/generated.gen.ts')).toBe(false);
        expect(report.files.some((file) => file.file === 'src/nested/keep.ts' && file.scanned)).toBe(
          true,
        );
      },
    );
  });

  it.runIf(process.platform !== 'win32')(
    'keeps control-character filenames distinct in findings and file counts',
    async () => {
      const firstToken = 'sk-' + 'a'.repeat(16);
      const secondToken = 'sk-' + 'b'.repeat(16);
      const sessionHeaderWrite =
        "declare const response: { setHeader(name: string, value: string): void }; response.setHeader('mcp-session-id', 'legacy');\n";
      await withTempProject(
        {
          'a\nb.ts': sessionHeaderWrite,
          'a b.ts': sessionHeaderWrite,
          'a%0Ab.ts': sessionHeaderWrite,
          'escape\u001b.ts': sessionHeaderWrite,
          'escape\\x1b.ts': sessionHeaderWrite,
          'both\\slash\u001b.ts': sessionHeaderWrite,
          [`${firstToken}.ts`]: sessionHeaderWrite,
          [`${secondToken}.ts`]: sessionHeaderWrite,
          '[REDACTED:token]~1.ts': sessionHeaderWrite,
        },
        async (dir) => {
          const report = await reportFor(dir);
          const sessionFindings = report.findings.filter(
            (finding) => finding.ruleId === 'MCP2026-SESSION-001',
          );
          const expectedPaths = new Set([
            'a b.ts',
            'a%0Ab.ts',
            'a%250Ab.ts',
            'escape%1B.ts',
            'escape%5Cx1b.ts',
            'both%5Cslash%1B.ts',
            '[REDACTED:token]~2.ts',
            '[REDACTED:token]~3.ts',
            '[REDACTED:token]~1.ts',
          ]);
          expect(new Set(sessionFindings.map((finding) => finding.file))).toEqual(expectedPaths);
          const resultByPath = new Map(
            report.files
              .filter((file) => expectedPaths.has(file.file))
              .map((file) => [file.file, file.findingCount]),
          );
          expect(new Set(resultByPath.keys())).toEqual(expectedPaths);
          expect([...resultByPath.values()]).toEqual([1, 1, 1, 1, 1, 1, 1, 1, 1]);
          const serialized = JSON.stringify(report);
          expect(serialized).not.toContain(firstToken);
          expect(serialized).not.toContain(secondToken);
          expect(isScanReport(report)).toBe(true);
        },
      );
    },
  );

  it('reports an unreadable nested directory when permission bits are enforced', async () => {
    await withTempProject(
      { 'locked/server.ts': "export const header = 'mcp-session-id';\n" },
      async (dir) => {
        const locked = path.join(dir, 'locked');
        await fs.chmod(locked, 0o000);
        try {
          let permissionEnforced = false;
          try {
            await fs.readdir(locked);
          } catch {
            permissionEnforced = true;
          }
          const report = await reportFor(dir);
          if (permissionEnforced) {
            expect(report.scanStatus).toBe('partial');
            expect(report.issues).toContainEqual(
              expect.objectContaining({ code: 'unreadable-directory', path: 'locked' }),
            );
          }
        } finally {
          await fs.chmod(locked, 0o755);
        }
      },
    );
  });

  it('maps an unreadable root directory probe to a usage error', async () => {
    await withTempProject({ 'locked/server.ts': 'export const value = true;\n' }, async (dir) => {
      const locked = path.join(dir, 'locked');
      await fs.chmod(locked, 0o000);
      try {
        let permissionEnforced = false;
        try {
          const handle = await fs.opendir(locked);
          await handle.close();
        } catch {
          permissionEnforced = true;
        }
        if (permissionEnforced) {
          await expect(resolveScanOptions(locked, {})).rejects.toMatchObject({
            name: UsageError.name,
            message: expect.stringMatching(/permission denied/i),
          });
        }
      } finally {
        await fs.chmod(locked, 0o755);
      }
    });
  });

  it('marks a scan partial when a rule analysis budget is exhausted', async () => {
    await withTempProject({ 'many.ts': `const values = [${'x,'.repeat(20_010)}];\n` }, async (dir) => {
      const options = await resolveScanOptions(dir, {});
      const rule: ScannerRule = {
        id: 'MCP2026-TEST-BUDGET',
        title: 'budget test',
        category: 'stateless-lifecycle',
        targetVersion: '2026-07-28',
        level: 'review',
        defaultConfidence: 'low',
        source: { title: 'test', url: 'https://modelcontextprotocol.io/' },
        appliesTo: { fileKinds: ['ts'], transports: ['unknown'] },
        autofix: 'none',
        description: 'Exercises the defensive lexical analysis budget.',
        async scan(context) {
          for (const file of context.files) {
            for (const _match of matches(context, rule, file, /x/g)) {
              // Exhaust the generator without allocating findings.
            }
          }
          return [];
        },
      };

      const { report } = await runScan(options, { rules: [rule] });
      expect(report.scanStatus).toBe('partial');
      expect(report.issues).toContainEqual(
        expect.objectContaining({ code: 'analysis-limit', path: 'many.ts' }),
      );
    });
  });

  it('does not consult a sibling package.json for a single-file scan', async () => {
    await withTempProject(
      {
        'package.json': JSON.stringify({
          name: 'sibling-package',
          dependencies: { '@modelcontextprotocol/sdk': '^1.0.0' },
        }),
        'server.ts': 'export const server = true;\n',
      },
      async (dir) => {
        const report = await reportFor(path.join(dir, 'server.ts'));
        expect(report.repository.singleFile).toBe(true);
        expect(report.repository.packageName).toBeNull();
        expect(report.repository.sdk).toBeNull();
      },
    );
  });

  it('scans an explicitly selected test-named source file', async () => {
    await withTempProject(
      { 'server.test.ts': "export const header = 'mcp-session-id';\n" },
      async (dir) => {
        const selected = await reportFor(path.join(dir, 'server.test.ts'));
        expect(selected.summary.filesScanned).toBe(1);
        expect(selected.files).toContainEqual(
          expect.objectContaining({ file: 'server.test.ts', scanned: true }),
        );

        const directory = await reportFor(dir);
        expect(directory.summary.filesScanned).toBe(0);
        expect(directory.files).toContainEqual(
          expect.objectContaining({ file: 'server.test.ts', skipped: 'test-path' }),
        );
      },
    );
  });
});

describe('classification hardening', () => {
  it('does not mistake generic cache access for HTTP header access', () => {
    const source = ts.createSourceFile(
      'cache.ts',
      `
        cache.get('mcp-session-id');
        headers.get('mcp-session-id');
        ctx.req.get('mcp-session-id');
        res.set('mcp-session-id', value);
        new Headers().set('mcp-session-id', value);
      `,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
    const hits = collectHeaderAccess(source, new Set(['mcp-session-id']));
    expect(hits.map((hit) => hit.mode)).toEqual(['read', 'read', 'write', 'write']);
  });

  it('classifies stdio plus a custom MCP HTTP route as mixed', async () => {
    await withTempProject(
      {
        'server.ts': `
          import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
          declare const app: { post(path: string, handler: () => void): void };
          app.post('/mcp', () => undefined);
          export const transport = new StdioServerTransport();
        `,
      },
      async (dir) => {
        const report = await reportFor(dir);
        expect(report.repository.transport).toBe('mixed');
        expect(report.repository.transportEvidence).toEqual(
          expect.arrayContaining(['MCP HTTP route', 'StdioServerTransport']),
        );
      },
    );
  });

  it('does not classify documentation strings as MCP implementation code', async () => {
    await withTempProject(
      {
        'docs.ts': `
          export const example = "import '@modelcontextprotocol/sdk'; new McpServer();";
          export const methods = 'tools/list resources/read setRequestHandler() FastMCP()';
        `,
      },
      async (dir) => {
        const report = await reportFor(dir);
        expect(report.repository.isLikelyMcpServer).toBe(false);
        expect(report.repository.mcpEvidence).toEqual([]);
      },
    );
  });

  it('does not infer a transport from decoy literals', async () => {
    await withTempProject(
      {
        'docs.ts': `
          export const examples = [
            'StdioServerTransport',
            'serveStdio()',
            'StreamableHTTPServerTransport',
            "app.post('/mcp', handler)",
          ];
        `,
      },
      async (dir) => {
        const report = await reportFor(dir);
        expect(report.repository.transport).toBe('unknown');
        expect(report.repository.transportEvidence).toEqual([]);
      },
    );
  });

  it('does not treat generic handler APIs as MCP code without provenance', async () => {
    await withTempProject(
      {
        'router.ts': `
          class Router {
            setRequestHandler(name: string, callback: () => void) { callback(); }
            registerTool(name: string, callback: () => void) { callback(); }
          }
          const router = new Router();
          router.setRequestHandler('account', () => undefined);
          router.registerTool('formatter', () => undefined);
        `,
      },
      async (dir) => {
        const report = await reportFor(dir);
        expect(report.repository.isLikelyMcpServer).toBe(false);
        expect(report.repository.mcpEvidence).toEqual([]);
      },
    );
  });

  it('does not trust locally declared MCP-named constructors without provenance', async () => {
    await withTempProject(
      {
        'decoy.ts': `
          class McpServer { constructor(readonly label: string) {} }
          class FastMCP { constructor(readonly label: string) {} }
          export const first = new McpServer('unrelated test double');
          export const second = new FastMCP('unrelated task runner');
        `,
      },
      async (dir) => {
        const report = await reportFor(dir);
        expect(report.repository.isLikelyMcpServer).toBe(false);
        expect(report.repository.mcpEvidence).toEqual([]);
      },
    );
  });

  it('retains imported MCP handler provenance', async () => {
    await withTempProject(
      {
        'server.ts': `
          import { Server } from '@modelcontextprotocol/sdk/server/index.js';
          declare const server: Server;
          server.registerTool('formatter', () => undefined);
        `,
      },
      async (dir) => {
        const report = await reportFor(dir);
        expect(report.repository.isLikelyMcpServer).toBe(true);
        expect(report.repository.mcpEvidence).toContain('@modelcontextprotocol import');
      },
    );
  });

  it('keeps stdio when an unrelated file creates a health HTTP server', async () => {
    await withTempProject(
      {
        'server.ts': `
          import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
          export const transport = new StdioServerTransport();
        `,
        'health.ts': `
          import http from 'node:http';
          http.createServer((_req, res) => { res.end('ok'); }).listen(8080);
        `,
      },
      async (dir) => {
        const report = await reportFor(dir);
        expect(report.repository.transport).toBe('stdio');
        expect(report.repository.transportEvidence).not.toContain('http.createServer()');
      },
    );
  });

  it('does not infer an MCP transport from an HTTP framework dependency', async () => {
    await withTempProject(
      {
        'package.json': JSON.stringify({ dependencies: { express: '^5.0.0' } }),
        'server.ts': `
          import express from 'express';
          const app = express();
          app.get('/health', (_req, res) => res.send('ok'));
        `,
      },
      async (dir) => {
        const report = await reportFor(dir);
        expect(report.repository.isLikelyMcpServer).toBe(false);
        expect(report.repository.transport).toBe('unknown');
        expect(report.repository.transportEvidence).toEqual([]);
      },
    );
  });
});

describe('report boundary hardening', () => {
  it('keeps truncation sentinels inside the absolute issue-record cap', async () => {
    await withTempProject({ 'server.ts': 'export const server = true;\n' }, async (dir) => {
      let laterRuleRan = false;
      const floodingRule: ScannerRule = {
        id: 'MCP2026-TEST-FLOOD',
        title: 'report boundary flood',
        category: 'stateless-lifecycle',
        targetVersion: '2026-07-28',
        level: 'review',
        defaultConfidence: 'low',
        source: {
          title: 'MCP base protocol',
          url: 'https://modelcontextprotocol.io/specification/draft/basic',
        },
        appliesTo: { fileKinds: ['ts'], transports: ['unknown'] },
        autofix: 'none',
        description: 'Exercises report detail limits.',
        async scan(context) {
          for (let index = 0; index < 5_001; index++) {
            context.noteAnalysisLimit(this.id, `virtual/${index}.ts`, 'test analysis limit');
          }
          return Array.from(
            { length: 20_001 },
            (_, index): Finding => ({
              ruleId: this.id,
              level: 'review',
              confidence: 'low',
              category: this.category,
              title: this.title,
              file: 'server.ts',
              line: 1,
              column: index + 1,
              evidence: 'bounded test evidence',
              explanation: 'Synthetic finding used to verify defensive report limits.',
              remediation: 'No action.',
              source: this.source,
              autofix: this.autofix,
            }),
          );
        },
      };
      const laterRule: ScannerRule = {
        ...floodingRule,
        id: 'MCP2026-TEST-LATER',
        async scan() {
          laterRuleRan = true;
          return [];
        },
      };

      const options = await resolveScanOptions(dir, {});
      const { report } = await runScan(options, { rules: [floodingRule, laterRule] });

      expect(laterRuleRan).toBe(false);
      expect(report.findings).toHaveLength(20_000);
      expect(report.issues).toHaveLength(5_000);
      expect(report.issues.find((issue) => issue.code === 'finding-limit')).toEqual({
        code: 'finding-limit',
        path: '.',
        message: 'Finding output reached the defensive limit; later matches or rules may be absent.',
      });
      expect(report.issues.find((issue) => issue.code === 'report-limit')).toEqual(
        expect.objectContaining({ code: 'report-limit', path: '.', count: 3 }),
      );
      expect(report.scanStatus).toBe('partial');
      expect(isScanReport(report)).toBe(true);
    });
  });

  it('redacts AWS, connection and control-sequence secrets', () => {
    const awsId = 'ASIAABCDEFGHIJKLMNOP';
    const awsSecret = 'aVerySecretAwsAccessKeyValue1234567890';
    const session = 'sessionTokenValue1234567890';
    const raw =
      `aws_secret_access_key=${awsSecret} aws_session_token=${session} ${awsId} ` +
      'redis://:databasePassword123@localhost \u001b]8;;https://evil.invalid\u0007click\u001b]8;;\u0007';
    const sanitized = sanitizeReportText(raw);

    expect(sanitized).not.toContain(awsId);
    expect(sanitized).not.toContain(awsSecret);
    expect(sanitized).not.toContain(session);
    expect(sanitized).not.toContain('databasePassword123');
    expect(sanitized).not.toMatch(/[\u001b\u0007]/);
    expect(sanitized).toContain('[REDACTED:');
  });

  it('consumes complete and truncated multiline private-key material', () => {
    const complete =
      'prefix -----BEGIN ' +
      'OPENSSH PRIVATE KEY-----\nsecretBodyOne\n' +
      '-----END OPENSSH PRIVATE KEY----- suffix';
    const truncated =
      'prefix -----BEGIN ' + 'RSA PRIVATE KEY-----\nsecretBodyTwo\nstillSecretWithoutEnd';

    expect(redact(complete)).toBe('prefix [REDACTED:private-key] suffix');
    expect(redact(truncated)).toBe('prefix [REDACTED:private-key]');
  });

  it('redacts reconstructable vendor and bearer token fragments', () => {
    const vendorSuffix = 'AbCdEfGhIjKlMnOpQrStUvWx';
    const bearerSuffix = 'abcDEF0123456789xyz';
    const input =
      `const vendor = "sk-proj-" + "${vendorSuffix}"; ` +
      `const bearer = "Bearer abc" + "${bearerSuffix}"; ` +
      'const templated = `ghp_${"AbCdEf0123456789GhIjKlMn"}`;';
    const output = redact(input);

    expect(output).not.toContain('sk-proj-');
    expect(output).not.toContain(vendorSuffix);
    expect(output).not.toContain(bearerSuffix);
    expect(output).not.toContain('AbCdEf0123456789GhIjKlMn');
    expect(output.match(/\[REDACTED:token\]/g)).toHaveLength(3);
  });

  it('does not expose split tokens or multiline PEM bodies through findings', async () => {
    const vendorSuffix = 'AbCdEfGhIjKlMnOpQrStUvWx';
    const bearerSuffix = 'abcDEF0123456789xyz';
    const pemBody = 'MIIPrivateKeyBodyMustNeverAppear';
    await withTempProject(
      {
        'server.ts':
          'declare const response: { setHeader(name: string, value: string): void }; ' +
          `const x = "sk-proj-" + "${vendorSuffix}"; ` +
          `const y = "Bearer abc" + "${bearerSuffix}";\n` +
          'export const key = `-----BEGIN ' +
          'PRIVATE KEY-----\n' +
          `${pemBody} \${response.setHeader('mcp-session-id', 'legacy')}\n` +
          '`;\n',
      },
      async (dir) => {
        const report = await reportFor(dir);
        const serialized = JSON.stringify(report);
        expect(serialized).not.toContain(vendorSuffix);
        expect(serialized).not.toContain(bearerSuffix);
        expect(serialized).not.toContain(pemBody);
        expect(report.findings.some((finding) => finding.evidence === '[REDACTED:private-key]')).toBe(
          true,
        );
      },
    );
  });

  it('does not mistake ordinary cross-platform paths for high-entropy secrets', () => {
    for (const ordinaryPath of [
      '/private/var/folders/qq/ylb0xg552196r56p6w0tvz_c0000gn/T/project-file.ts',
      '/home/runner/work/mcp-upgrade/mcp-upgrade/src/server.ts',
      String.raw`C:\Users\build-agent\AppData\Local\Temp\mcp-upgrade-3fa91b\server.ts`,
    ]) {
      expect(sanitizeReportText(ordinaryPath)).toBe(ordinaryPath);
    }
    const opaque = 'AbCdEf0123456789GhIjKlMnOpQrStUvWxYz9876543210';
    expect(sanitizeReportText(opaque)).toBe('[REDACTED:high-entropy]');
  });

  it('sanitizes secrets from package metadata and all report serialization', async () => {
    const token = 'sk-proj-abcdefghijklmnopqrstuvwx';
    await withTempProject(
      {
        'package.json': JSON.stringify({
          name: token,
          dependencies: { '@modelcontextprotocol/sdk': token },
        }),
        'server.ts': "import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';\n",
      },
      async (dir) => {
        const report = await reportFor(dir);
        expect(JSON.stringify(report)).not.toContain(token);
        expect(report.repository.packageName).toContain('[REDACTED:');
        expect(report.repository.sdk?.range).toContain('[REDACTED:');
      },
    );
  });

  it('redacts a complete long line before selecting the evidence window', async () => {
    const secretTail = 'a'.repeat(180);
    await withTempProject(
      {
        'server.ts':
          `const credential = 'sk-proj-${secretTail}'; ` +
          "declare const response: { setHeader(name: string, value: string): void }; response.setHeader('mcp-session-id', 'legacy');\n",
      },
      async (dir) => {
        const report = await reportFor(dir);
        const finding = report.findings.find(
          (entry) => entry.ruleId === 'MCP2026-SESSION-001',
        );
        expect(finding).toBeDefined();
        expect(finding?.evidence).not.toContain(secretTail.slice(-80));
        expect(finding?.evidence).toContain('[REDACTED:');
      },
    );
  });

  it('does not share mutable finding sources or effort exclusions across scans', async () => {
    const target = fixture('legacy-session-server');
    const first = await reportFor(target);
    const originalTitle = first.findings[0]?.source.title;
    const originalExclusion = first.summary.effort.excludes[0];
    expect(originalTitle).toBeTypeOf('string');
    expect(originalExclusion).toBeTypeOf('string');

    if (first.findings[0]) first.findings[0].source.title = 'MUTATED SOURCE';
    first.summary.effort.excludes[0] = 'MUTATED EXCLUSION';

    const second = await reportFor(target);
    expect(second.findings[0]?.source.title).toBe(originalTitle);
    expect(second.summary.effort.excludes[0]).toBe(originalExclusion);
  });

  it('handles every JavaScript line terminator deterministically', () => {
    expect(computeLineStarts('a\rb\r\nc\u2028d\u2029e')).toEqual([0, 2, 5, 7, 9]);
    const jsonc = '// comment\r{"live":true}';
    const yaml = '# comment\u2028live: true';
    expect(jsonc.slice(lexCommentsJsonc(jsonc)[0]?.start, lexCommentsJsonc(jsonc)[0]?.end)).toBe(
      '// comment',
    );
    expect(yaml.slice(lexCommentsYaml(yaml)[0]?.start, lexCommentsYaml(yaml)[0]?.end)).toBe(
      '# comment',
    );
  });

  it('keeps repeated AST lookups bounded on a flat minified file', () => {
    const statement = 'void 0;';
    const statementCount = 50_000;
    const content = statement.repeat(statementCount);
    const source = ts.createSourceFile(
      'minified.ts',
      content,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
    let resolved = 0;
    const started = performance.now();
    for (let index = 0; index < 5_000; index++) {
      const statementIndex = (index * 7_919) % statementCount;
      if (nodeAt(source, statementIndex * statement.length + 5)) resolved++;
    }
    const elapsedMs = performance.now() - started;

    expect(resolved).toBe(5_000);
    expect(elapsedMs).toBeLessThan(2_000);
  });

  it('keeps the widened redaction rules linear on adversarial input', () => {
    // The hex-digest and encoded-literal rules run on hostile source text, so
    // they must not backtrack: each of these is a 100 KB run of exactly the
    // characters their character classes accept.
    const inputs = [
      'deadbeef'.repeat(12_500),
      '"'.repeat(100_000),
      '/'.repeat(100_000),
      'Ab9/'.repeat(25_000),
      'aA1+/_-'.repeat(14_285),
      'password:'.repeat(11_111),
    ];
    for (const input of inputs) {
      const started = performance.now();
      redact(input);
      expect(performance.now() - started).toBeLessThan(1_000);
    }
  });

  it('keeps redact free of shared regular-expression state', async () => {
    const input = 'password="concurrentSecret123"';
    const outputs = await Promise.all(Array.from({ length: 100 }, async () => redact(input)));
    expect(new Set(outputs).size).toBe(1);
    expect(outputs[0]).not.toContain('concurrentSecret123');
  });
});

describe('scan-root identity binding', () => {
  it('reports root-changed instead of scanning when the root is replaced after resolution', async () => {
    await withTempProject({ 'src/server.ts': 'export const ok = true;\n' }, async (dir) => {
      const options = await resolveScanOptions(dir, {});
      const replacement = `${dir}-replacement`;
      await fs.rename(dir, replacement);
      await fs.mkdir(path.join(dir, 'src'), { recursive: true });
      await fs.writeFile(path.join(dir, 'src/server.ts'), 'export const attacker = true;\n');
      try {
        const { report } = await runScan(options, { rules: [] });
        expect(report.summary.filesScanned).toBe(0);
        expect(report.scanStatus).toBe('partial');
        expect(report.issues.some((issue) => issue.code === 'root-changed')).toBe(true);
        expect(isScanReport(report)).toBe(true);
      } finally {
        await fs.rm(dir, { recursive: true, force: true });
        await fs.rename(replacement, dir);
      }
    });
  });

  it('aborts discovery with root-changed when the root is swapped mid-walk', async () => {
    await withTempProject({ 'src/server.ts': 'export const ok = true;\n' }, async (dir) => {
      const options = await resolveScanOptions(dir, {});
      const replacement = `${dir}-replacement`;
      let swapped = false;
      const result = await discover(options, {
        openDirectory: async (absPath) => {
          const handle = await fs.opendir(absPath);
          if (!swapped) {
            swapped = true;
            await fs.rename(dir, replacement);
            await fs.mkdir(dir, { recursive: true });
          }
          return handle;
        },
      });
      try {
        expect(result.files).toHaveLength(0);
        expect(result.skipped.some((skip) => skip.reason === 'root-changed')).toBe(true);
      } finally {
        await fs.rm(dir, { recursive: true, force: true });
        await fs.rename(replacement, dir);
      }
    });
  });
});

describe('credential redaction gaps', () => {
  // Each of these reached a report in full before the redaction rules were
  // widened: the key spellings SDK credential objects actually use, hex and
  // base64 encodings, and passwords containing shell-significant characters.
  const mustRedact: Array<[string, string]> = [
    ['camelCase AWS secret half', 'secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"'],
    ['camelCase secretKey', 'secretKey: "HotAbcdef1234Value"'],
    ['screaming snake SECRET_KEY', 'SECRET_KEY=DjangoStyleCore123456'],
    ['signing key', 'signingKey: "aVeryLongSigningKeyValue123"'],
    ['session secret', 'sessionSecret = "s3cr3tSessionValueHere"'],
    ['lowercase hex digest', 'const h = "f3a9c1d2e4b5a6978081726354453627181920ab"'],
    ['sha256 hex digest', 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'],
    ['base64 literal with slash', 'token "Ab9/B64SlashCoreEf7Gh6Ij5Kl4Mn3Op2Qr1St0Uv9="'],
    ['base64url literal with dash', 'const t = "Ab9-B64DashCorexEf7Gh6Ij5Kl4Mn3Op2Qr1St0Uv9"'],
    ['password containing a dollar sign', 'password=Dollar$ValCore1234'],
    ['password containing parentheses', 'password=P@ss(word)123456'],
  ];

  for (const [name, input] of mustRedact) {
    it(`redacts ${name}`, () => {
      const output = redact(input);
      expect(output).not.toBe(input);
      expect(output).toContain('[REDACTED:');
    });
  }

  // Widening redaction must not start eating the evidence and portable paths a
  // report exists to communicate.
  const mustPreserve: Array<[string, string]> = [
    ['a type annotation', 'apiKey: string'],
    ['an environment lookup', 'password = process.env.PASSWORD'],
    ['a function call', 'token: getToken(config)'],
    ['template interpolation', 'secret: ${vault.lookup}'],
    ['a relative source path', "path: 'src/scanner/rules/modern-protocol.ts'"],
    ['an MCP method literal', "method: 'notifications/roots/list_changed'"],
    ['an MCP meta key', "key: 'io.modelcontextprotocol/clientCapabilities'"],
    ['a long lowercase path literal', "'src/generated/aaaa/bbbb/cccc/dddd/eeee/ffff/gggg/hhh'"],
    ['a protocol version literal', 'const version = "2026-07-28";'],
  ];

  for (const [name, input] of mustPreserve) {
    it(`preserves ${name}`, () => {
      expect(redact(input)).toBe(input);
    });
  }

  it('keeps a paired AWS credential object out of report evidence', async () => {
    await withTempProject(
      {
        'package.json': '{"dependencies":{"@modelcontextprotocol/sdk":"^1.20.0"}}',
        'src/server.ts': [
          "import { Server } from '@modelcontextprotocol/sdk/server/index.js';",
          'const creds = {',
          '  accessKeyId: "AKIAIOSFODNN7EXAMPLE",',
          '  secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",',
          '};',
          "server.setRequestHandler('logging/setLevel', () => creds);",
        ].join('\n'),
      },
      async (dir) => {
        const report = await reportFor(dir);
        const serialized = JSON.stringify(report);
        expect(serialized).not.toContain('wJalrXUtnFEMI');
        expect(serialized).not.toContain('AKIAIOSFODNN7EXAMPLE');
      },
    );
  });
});
