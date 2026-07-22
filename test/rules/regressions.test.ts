import { describe, expect, it } from 'vitest';
import { resolveOptions } from '../../src/cli/commands/scan.js';
import { runScan } from '../../src/scanner/engine.js';
import { redact, toEvidence } from '../../src/scanner/redaction.js';
import { computeReadiness } from '../../src/scanner/scoring.js';
import type { Finding } from '../../src/types.js';
import { findingsFor, reportFor, ruleIds, scanFixture, withTempProject } from '../helpers.js';

/**
 * Regression tests for defects found during the production-readiness audit.
 * Every test here reproduces a confirmed bug; none may be weakened to pass.
 */

const MCP_PKG = JSON.stringify({
  name: 'fixture',
  dependencies: { '@modelcontextprotocol/sdk': '^1.12.0' },
});

/** MCP server that also serves HTTP, so HTTP-transport rules apply. */
const MCP_HTTP_PKG = JSON.stringify({
  name: 'fixture',
  dependencies: { '@modelcontextprotocol/sdk': '^1.12.0', express: '^4.18.0' },
});

const PLAIN_PKG = JSON.stringify({
  name: 'plain',
  dependencies: { express: '^4.18.0' },
});

describe('comment suppression', () => {
  it('suppresses same-line trailing comments, not just leading ones', async () => {
    await withTempProject(
      {
        'src/server.ts':
          "const t = 1; // header was 'mcp-session-id' back then\n" +
          "// leading: 'mcp-session-id'\n" +
          'export default t;\n',
      },
      async (dir) => {
        const report = await reportFor(dir);
        expect(report.findings).toEqual([]);
      },
    );
  });

  it('does not classify transport from a commented-out signal', async () => {
    await withTempProject(
      {
        'src/old.ts': 'const x = 1; // migrated off StreamableHTTPServerTransport last year\n',
      },
      async (dir) => {
        const report = await reportFor(dir);
        expect(report.repository.transport).toBe('unknown');
      },
    );
  });
});

describe('lifecycle handler gating', () => {
  it('ignores EventEmitter "initialize" and WebSocket "ping" in non-MCP code', async () => {
    await withTempProject(
      {
        'package.json': PLAIN_PKG,
        'src/emitter.ts':
          "import { EventEmitter } from 'node:events';\n" +
          'const lifecycle = new EventEmitter();\n' +
          "lifecycle.on('initialize', () => {});\n" +
          'declare const ws: { on(e: string, cb: () => void): void; pong(): void };\n' +
          "ws.on('ping', () => ws.pong());\n" +
          "declare const bus: { handle(e: string, cb: () => void): void };\n" +
          "bus.handle('initialize', () => {});\n",
      },
      async (dir) => {
        const report = await reportFor(dir);
        expect(ruleIds(report)).not.toContain('MCP2026-LIFECYCLE-001');
        expect(ruleIds(report)).not.toContain('MCP2026-LIFECYCLE-002');
      },
    );
  });

  it('still flags setRequestHandler("initialize") anywhere', async () => {
    await withTempProject(
      {
        'src/server.ts': "server.setRequestHandler('initialize', () => ({}));\n",
      },
      async (dir) => {
        const report = await reportFor(dir);
        expect(ruleIds(report)).toContain('MCP2026-LIFECYCLE-001');
      },
    );
  });

  it('accepts generic .on("initialize") when the file shows an MCP signal', async () => {
    await withTempProject(
      {
        'src/server.ts':
          "import { Server } from '@modelcontextprotocol/sdk/server/index.js';\n" +
          "server.on('initialize', () => ({}));\n",
      },
      async (dir) => {
        const report = await reportFor(dir);
        expect(ruleIds(report)).toContain('MCP2026-LIFECYCLE-001');
      },
    );
  });

  it('downgrades protocol literals inside multi-line template strings', async () => {
    await withTempProject(
      {
        'src/notes.ts':
          'export const migrationNotes = `\n' +
          "  The 'notifications/initialized' handshake is removed.\n" +
          "  The 'mcp-session-id' header is removed.\n" +
          '`;\n',
      },
      async (dir) => {
        const report = await reportFor(dir);
        for (const finding of report.findings) {
          expect(finding.level).not.toBe('error');
        }
      },
    );
  });
});

describe('session-state gating', () => {
  it('ignores ordinary web-session stores with no MCP vocabulary', async () => {
    await withTempProject(
      {
        'package.json': PLAIN_PKG,
        'src/web.ts':
          'const sessions: Record<string, { cart: string[] }> = {};\n' +
          'export function addToCart(sessionId: string, item: string) {\n' +
          '  sessions[sessionId] = sessions[sessionId] ?? { cart: [] };\n' +
          '  sessions[sessionId].cart.push(item);\n' +
          '}\n',
      },
      async (dir) => {
        const report = await reportFor(dir);
        expect(ruleIds(report)).not.toContain('MCP2026-SESSION-003');
      },
    );
  });

  it('still flags the SDK session-to-transport routing map', async () => {
    await withTempProject(
      {
        'package.json': MCP_PKG,
        'src/server.ts':
          "import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';\n" +
          'const transports: Record<string, StreamableHTTPServerTransport> = {};\n' +
          "const sessionId = req.headers['mcp-session-id'];\n" +
          'transports[sessionId] = transport;\n',
      },
      async (dir) => {
        const report = await reportFor(dir);
        expect(ruleIds(report)).toContain('MCP2026-SESSION-003');
      },
    );
  });
});

describe('route patterns require mcp as a segment', () => {
  it('ignores /mcpanel and /mcpherson but flags /mcp', async () => {
    await withTempProject(
      {
        'package.json': MCP_HTTP_PKG,
        'src/routes.ts':
          "import express from 'express';\n" +
          'const app = express();\n' +
          "app.get('/mcpanel', () => {});\n" +
          "app.get('/team/mcpherson', () => {});\n" +
          "app.get('/mcp', () => {});\n" +
          "app.delete('/mcp', () => {});\n",
      },
      async (dir) => {
        const report = await reportFor(dir);
        const lifecycle = findingsFor(report, 'MCP2026-LIFECYCLE-003');
        expect(lifecycle.map((f) => f.line).sort()).toEqual([5, 6]);
      },
    );
  });
});

describe('resource error-code classification', () => {
  it('does not assert ERROR for -32002 whose context is only a common word containing "uri"', async () => {
    await withTempProject(
      {
        'src/rate-limit.ts':
          'export class McpError extends Error { constructor(public code: number, m: string){ super(m); } }\n' +
          'export function checkRateLimit(rpm: number): void {\n' +
          "  if (rpm > 100) throw new McpError(-32002, 'rate limited during peak hours');\n" +
          '}\n',
      },
      async (dir) => {
        const report = await reportFor(dir);
        expect(findingsFor(report, 'MCP2026-ERROR-001')).toEqual([]);
        // Still visible for a human decision, never asserted.
        expect(findingsFor(report, 'MCP2026-ERROR-002')).toHaveLength(1);
      },
    );
  });

  it('flags -32002 emitted through res.json with resource context', async () => {
    await withTempProject(
      {
        'src/handler.ts':
          'export function handleRead(res: { json(v: unknown): void }, uri: string) {\n' +
          "  res.json({ jsonrpc: '2.0', error: { code: -32002, message: `resource not found: ${uri}` } });\n" +
          '}\n',
      },
      async (dir) => {
        const report = await reportFor(dir);
        const emitted = findingsFor(report, 'MCP2026-ERROR-001');
        expect(emitted).toHaveLength(1);
        expect(emitted[0]?.level).toBe('error');
      },
    );
  });

  it('treats an acceptance list as review, never as an emission', async () => {
    await withTempProject(
      {
        'src/client.ts':
          'const NOT_FOUND_CODES = [-32002, -32602];\n' +
          'export const isNotFound = (code: number, uri: string) =>\n' +
          '  NOT_FOUND_CODES.includes(code) && uri.length > 0;\n',
      },
      async (dir) => {
        const report = await reportFor(dir);
        expect(findingsFor(report, 'MCP2026-ERROR-001')).toEqual([]);
        for (const finding of findingsFor(report, 'MCP2026-ERROR-002')) {
          expect(finding.level).toBe('review');
        }
      },
    );
  });
});

describe('header rules require MCP evidence', () => {
  it('ignores a plain Next.js POST route with no MCP anywhere', async () => {
    await withTempProject(
      {
        'package.json': JSON.stringify({ name: 'site', dependencies: { next: '14.2.3' } }),
        'app/api/contact/route.ts':
          'export async function POST(req: Request) {\n' +
          '  const data = await req.json();\n' +
          '  return Response.json({ ok: true, data });\n' +
          '}\n',
      },
      async (dir) => {
        const report = await reportFor(dir);
        expect(ruleIds(report)).not.toContain('MCP2026-HEADER-002');
      },
    );
  });

  it('flags a POST route whose file carries an MCP signal', async () => {
    await withTempProject(
      {
        'package.json': JSON.stringify({ name: 'site', dependencies: { next: '14.2.3' } }),
        'app/api/mcp/route.ts':
          "import { createMcpHandler } from 'mcp-handler';\n" +
          'export async function POST(req: Request) {\n' +
          '  return handler(req);\n' +
          '}\n',
      },
      async (dir) => {
        const report = await reportFor(dir);
        expect(ruleIds(report)).toContain('MCP2026-HEADER-002');
      },
    );
  });

  it('is not suppressed by a routing-header literal that only appears in a comment', async () => {
    await withTempProject(
      {
        'package.json': MCP_PKG,
        'src/route.ts':
          "// TODO: validate 'mcp-method' eventually\n" +
          "import { Server } from '@modelcontextprotocol/sdk/server/index.js';\n" +
          "app.post('/mcp', handler);\n",
      },
      async (dir) => {
        const report = await reportFor(dir);
        expect(ruleIds(report)).toContain('MCP2026-HEADER-002');
      },
    );
  });

  it('detects a literal MCP body written as JSON-string text', async () => {
    await withTempProject(
      {
        'package.json': MCP_HTTP_PKG,
        'src/client.ts':
          "await fetch('https://example.com/mcp', {\n" +
          "  method: 'POST',\n" +
          '  body: \'{"jsonrpc":"2.0","method":"tools/call","params":{"name":"x"}}\',\n' +
          '});\n',
      },
      async (dir) => {
        const report = await reportFor(dir);
        expect(ruleIds(report)).toContain('MCP2026-HEADER-001');
      },
    );
  });

  it('ignores generic method names in a repo with no MCP evidence', async () => {
    await withTempProject(
      {
        'package.json': PLAIN_PKG,
        'src/rpc.ts':
          "await fetch('/internal-rpc', {\n" +
          "  method: 'POST',\n" +
          "  body: JSON.stringify({ method: 'tasks/cancel', params: { name: 'cleanup' } }),\n" +
          '});\n',
      },
      async (dir) => {
        const report = await reportFor(dir);
        expect(ruleIds(report)).not.toContain('MCP2026-HEADER-001');
      },
    );
  });
});

describe('deprecation rules require MCP evidence', () => {
  it('ignores jest roots, app logging config and tracing sampling config', async () => {
    await withTempProject(
      {
        'package.json': PLAIN_PKG,
        'jest.config.js': "module.exports = { roots: ['<rootDir>/src'] };\n",
        'src/config.ts':
          'export const config = {\n' +
          "  logging: { level: 'info', format: 'json' },\n" +
          '  sampling: { rate: 0.1, parentBased: true },\n' +
          '};\n',
      },
      async (dir) => {
        const report = await reportFor(dir);
        expect(ruleIds(report)).toEqual([]);
      },
    );
  });

  it('ignores user-defined listRoots/sendLoggingMessage/requestSampling functions', async () => {
    await withTempProject(
      {
        'package.json': PLAIN_PKG,
        'src/utils.ts':
          'export function listRoots(volume: string): string[] { return [volume]; }\n' +
          'export function sendLoggingMessage(msg: string): void { console.log(msg); }\n' +
          'export function requestSampling(rate: number): number { return rate; }\n' +
          "listRoots('/');\nsendLoggingMessage('x');\nrequestSampling(1);\n",
      },
      async (dir) => {
        const report = await reportFor(dir);
        expect(ruleIds(report)).toEqual([]);
      },
    );
  });

  it('still flags capability declarations and calls in MCP code', async () => {
    await withTempProject(
      {
        'package.json': MCP_PKG,
        'src/server.ts':
          "import { Server } from '@modelcontextprotocol/sdk/server/index.js';\n" +
          'const capabilities = { roots: { listChanged: true }, sampling: {}, logging: {} };\n' +
          'await server.listRoots();\n' +
          'await server.createMessage({ messages: [] });\n' +
          "await server.sendLoggingMessage({ level: 'info' });\n",
      },
      async (dir) => {
        const report = await reportFor(dir);
        const ids = ruleIds(report);
        expect(ids).toContain('MCP2026-ROOTS-001');
        expect(ids).toContain('MCP2026-SAMPLING-001');
        expect(ids).toContain('MCP2026-LOGGING-001');
      },
    );
  });

  it('ignores "notifications/message" as a pub/sub topic in non-MCP code', async () => {
    await withTempProject(
      {
        'package.json': PLAIN_PKG,
        'src/bus.ts': "queue.publish('notifications/message', payload);\n",
      },
      async (dir) => {
        const report = await reportFor(dir);
        expect(ruleIds(report)).not.toContain('MCP2026-LOGGING-001');
      },
    );
  });

  it('detects capability declarations inside JSON files', async () => {
    await withTempProject(
      {
        'package.json': MCP_PKG,
        'mcp-config.json':
          '{\n  "capabilities": {\n    "tasks": { "requests": {} },\n    "roots": {}\n  }\n}\n',
      },
      async (dir) => {
        const report = await reportFor(dir);
        const ids = ruleIds(report);
        expect(ids).toContain('MCP2026-TASKS-002');
        expect(ids).toContain('MCP2026-ROOTS-001');
      },
    );
  });

  it('detects quoted includeContext values in JSON', async () => {
    await withTempProject(
      {
        'package.json': MCP_PKG,
        'sampling.json': '{ "includeContext": "thisServer" }\n',
      },
      async (dir) => {
        const report = await reportFor(dir);
        expect(ruleIds(report)).toContain('MCP2026-SAMPLING-002');
      },
    );
  });
});

describe('tasks rules', () => {
  it('does not flag statusMessage or lastUpdatedAt — SEP-2663 keeps both', async () => {
    await withTempProject(
      {
        'package.json': MCP_PKG,
        'src/tasks.ts':
          "import { Server } from '@modelcontextprotocol/sdk/server/index.js';\n" +
          'const task = {\n' +
          "  taskId: 'abc',\n" +
          "  status: 'working',\n" +
          "  statusMessage: 'processing',\n" +
          "  lastUpdatedAt: '2026-07-22T00:00:00Z',\n" +
          '  pollIntervalMs: 500,\n' +
          '  ttlMs: 60000,\n' +
          '};\n',
      },
      async (dir) => {
        const report = await reportFor(dir);
        expect(findingsFor(report, 'MCP2026-TASKS-003')).toEqual([]);
      },
    );
  });

  it('still flags the renamed pollInterval and ttl fields near task context', async () => {
    await withTempProject(
      {
        'package.json': MCP_PKG,
        'src/tasks.ts':
          "import { Server } from '@modelcontextprotocol/sdk/server/index.js';\n" +
          "const task = { taskId: 'abc', pollInterval: 500, ttl: 60000 };\n",
      },
      async (dir) => {
        const report = await reportFor(dir);
        expect(findingsFor(report, 'MCP2026-TASKS-003').length).toBeGreaterThan(0);
      },
    );
  });

  it('ignores tasks/list as a REST path in a non-MCP task app', async () => {
    await withTempProject(
      {
        'package.json': PLAIN_PKG,
        'src/api.ts': "router.get('tasks/list', listTasks);\nrouter.post('tasks/result', post);\n",
      },
      async (dir) => {
        const report = await reportFor(dir);
        expect(ruleIds(report)).not.toContain('MCP2026-TASKS-001');
      },
    );
  });

  it('reports the task-augmented sampling property under exactly one rule', async () => {
    await withTempProject(
      {
        'package.json': MCP_PKG,
        'src/caps.ts':
          "import { Client } from '@modelcontextprotocol/sdk/client/index.js';\n" +
          'const capabilities = {\n' +
          '  tasks: {\n' +
          '    requests: {\n' +
          '      sampling: {\n' +
          '        createMessage: true,\n' +
          '      },\n' +
          '    },\n' +
          '  },\n' +
          '};\n',
      },
      async (dir) => {
        const report = await reportFor(dir);
        // The `sampling:` property (line 5) belongs to TASKS-004 alone; before
        // the fix TASKS-002 also matched the same property through its
        // `tasks.requests` path pattern.
        const samplingLine = report.findings.filter(
          (f: Finding) => f.line === 5 && f.ruleId.startsWith('MCP2026-TASKS'),
        );
        expect(samplingLine.map((f) => f.ruleId)).toEqual(['MCP2026-TASKS-004']);
      },
    );
  });
});

describe('MCP Apps verdict', () => {
  it('never reports LIKELY_READY from a bare resourceUri property', async () => {
    await withTempProject(
      {
        'package.json': MCP_PKG,
        'src/rest.ts': "export const request = { resourceUri: 'https://example.com/x' };\n",
      },
      async (dir) => {
        const report = await reportFor(dir);
        expect(report.summary.appsReadiness).toBe('POSSIBLE_CANDIDATE');
      },
    );
  });
});

describe('YAML and JSON pattern coverage', () => {
  it('detects unquoted mcp-session-id YAML scalars', async () => {
    await withTempProject(
      {
        'gateway.yaml': 'forwardHeaders:\n  header: mcp-session-id\n',
      },
      async (dir) => {
        const report = await reportFor(dir);
        expect(ruleIds(report)).toContain('MCP2026-SESSION-001');
      },
    );
  });

  it('detects quoted affinity keys in JSON', async () => {
    await withTempProject(
      {
        'deploy.json': '{ "affinity": "cookie" }\n',
      },
      async (dir) => {
        const report = await reportFor(dir);
        expect(ruleIds(report)).toContain('MCP2026-SESSION-004');
      },
    );
  });
});

describe('discovery hardening', () => {
  it('scans files with uppercase extensions', async () => {
    await withTempProject(
      {
        'FOO.TS': "const h = 'mcp-session-id';\nexport default h;\n",
      },
      async (dir) => {
        const report = await reportFor(dir);
        expect(report.summary.filesScanned).toBe(1);
        expect(ruleIds(report)).toContain('MCP2026-SESSION-001');
      },
    );
  });

  it('honours the file-count budget and reports the rest as scan-limit', async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 6; i++) files[`src/f${i}.ts`] = `export const x${i} = ${i};\n`;
    await withTempProject(files, async (dir) => {
      const options = await resolveOptions(dir, {});
      const { report } = await runScan({ ...options, maxFiles: 3 });
      expect(report.summary.filesScanned).toBe(3);
      const limited = report.files.filter((f) => f.skipped === 'scan-limit');
      expect(limited).toHaveLength(3);
      expect(report.summary.filesSkipped).toBe(3);
    });
  });

  it('reports the same repository.root regardless of process cwd', async () => {
    await withTempProject(
      {
        'src/a.ts': 'export const a = 1;\n',
      },
      async (dir) => {
        const report = await reportFor(dir);
        expect(report.repository.root).toBe(dir.split('\\').join('/'));
      },
    );
  });
});

describe('hostile input survival', () => {
  it('survives a pathologically deep expression chain without overflowing', async () => {
    await withTempProject(
      {
        // ~100k-node binary expression chain — a recursive AST walk overflows.
        'src/minified.js': `var h='mcp-session-id';${'A-a/'.repeat(50000)}1;\n`,
      },
      async (dir) => {
        const report = await reportFor(dir);
        expect(report.summary.filesScanned).toBe(1);
        expect(ruleIds(report)).toContain('MCP2026-SESSION-001');
      },
    );
  });

  it('survives malformed UTF-8 and late NUL bytes', async () => {
    await withTempProject(
      {
        'src/ok.ts': 'export const x = 1;\n',
      },
      async (dir) => {
        const { promises: fs } = await import('node:fs');
        const path = await import('node:path');
        await fs.writeFile(
          path.join(dir, 'src/bad.ts'),
          Buffer.concat([
            Buffer.from("const h = 'mcp-session-id'; // "),
            Buffer.from([0xff, 0xfe, 0x80]),
            Buffer.from('\n'),
          ]),
        );
        const report = await reportFor(dir);
        expect(report.summary.filesScanned).toBe(2);
      },
    );
  });
});

describe('redaction hardening', () => {
  it('redacts Stripe, GitLab, npm and GitHub fine-grained tokens', () => {
    const input =
      'sk_live_abcdefghij0123456789 pk_test_ABCDEFGHIJ0123 rk_live_AbCdEfGhIjKlMnOp ' +
      'whsec_abcDEF0123456789xyzw glpat-ABCDEFGHIJKLMNOPqrst npm_abcDEF0123456789abcDEF0123456789 ' +
      'github_pat_11ABCDEFGHIJKLMNOPQRSTUV';
    const output = redact(input);
    for (const fragment of [
      'sk_live_',
      'pk_test_',
      'rk_live_',
      'whsec_',
      'glpat-',
      'npm_abc',
      'github_pat_',
    ]) {
      expect(output).not.toContain(fragment);
    }
  });

  it('redacts unquoted env-style credential values', () => {
    expect(redact('PGPASSWORD=Sup3rS3cr3tDbPass')).not.toContain('Sup3rS3cr3tDbPass');
    expect(redact('password: hunter2secret')).not.toContain('hunter2secret');
  });

  it('leaves type annotations and env lookups alone', () => {
    expect(redact('apiKey: string')).toContain('string');
    expect(redact('password: process.env.DB_PASSWORD')).toContain('process.env.DB_PASSWORD');
  });

  it('redacts credentials in comment-only match excerpts', async () => {
    await withTempProject(
      {
        'src/comments.ts':
          "// old: app.post('https://admin:supersecret99@corp.example.com/mcp', handler)\n" +
          'export const x = 1;\n',
      },
      async (dir) => {
        const { commentOnlyMatches } = await scanFixture(dir, { verbose: true });
        for (const match of commentOnlyMatches) {
          expect(match.text).not.toContain('supersecret99');
        }
      },
    );
  });

  it('stays fast on adversarial near-miss input', () => {
    const nearMiss = 'A-a/'.repeat(65536); // 256 KiB of high-entropy near-misses
    const started = performance.now();
    redact(nearMiss);
    expect(performance.now() - started).toBeLessThan(1000);
  });

  it('windows evidence around the match on very long lines', () => {
    const excerpt = toEvidence(`${'x'.repeat(500)} secret`, 40);
    expect(excerpt.length).toBeLessThanOrEqual(40);
  });
});

describe('scoring explanation', () => {
  it('never prints a false equation when deductions exceed 100', () => {
    const findings: Finding[] = Array.from({ length: 12 }, (_, i) => ({
      ruleId: `MCP2026-TEST-${String(i).padStart(3, '0')}`,
      level: 'error',
      confidence: 'high',
      category: 'stateless-lifecycle',
      title: 't',
      file: `f${i}.ts`,
      line: 1,
      evidence: 'e',
      explanation: 'x',
      remediation: 'r',
      source: { title: 's', url: 'https://example.com' },
      autofix: 'none',
    }));
    const readiness = computeReadiness(findings);
    expect(readiness.score).toBe(0);
    expect(readiness.explanation).toContain('floored at 0');
    expect(readiness.explanation).not.toMatch(/= 0\.$/);
  });
});
