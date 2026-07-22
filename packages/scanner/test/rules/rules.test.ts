import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ALL_RULES, ruleById } from '../../src/scanner/rules/index.js';
import { DEFAULT_TARGET_VERSION } from '../../src/constants.js';
import { fixture, findingsFor, reportFor, withTempProject } from '../helpers.js';

/**
 * Per-rule behaviour, exercised through small purpose-built inputs rather than
 * the shared fixtures, so each rule's edges are pinned independently.
 */

describe('rule registry', () => {
  it('has unique, well-formed rule IDs', () => {
    const ids = ALL_RULES.map((rule) => rule.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^MCP2026-[A-Z]+-\d{3}$/);
  });

  it('gives every rule an official MCP source URL', () => {
    for (const rule of ALL_RULES) {
      expect(rule.source.url, rule.id).toMatch(
        /^https:\/\/(modelcontextprotocol\.io|blog\.modelcontextprotocol\.io|ts\.sdk\.modelcontextprotocol\.io)\//,
      );
      expect(rule.source.title.length, rule.id).toBeGreaterThan(0);
    }
  });

  it('gives every rule a target version, applicability and description', () => {
    for (const rule of ALL_RULES) {
      expect(rule.targetVersion, rule.id).toBe(DEFAULT_TARGET_VERSION);
      expect(rule.appliesTo.fileKinds.length, rule.id).toBeGreaterThan(0);
      expect(rule.appliesTo.transports.length, rule.id).toBeGreaterThan(0);
      expect(rule.description.length, rule.id).toBeGreaterThan(20);
      expect(['safe', 'suggested', 'manual', 'none']).toContain(rule.autofix);
    }
  });

  it('covers all eight rule groups', () => {
    const categories = new Set(ALL_RULES.map((rule) => rule.category));
    expect([...categories].sort()).toEqual([
      'apps-readiness',
      'http-headers',
      'logging',
      'resource-errors',
      'roots',
      'sampling',
      'stateless-lifecycle',
      'tasks',
    ]);
  });

  it('resolves rules by ID', () => {
    expect(ruleById('MCP2026-SESSION-001')?.category).toBe('stateless-lifecycle');
    expect(ruleById('does-not-exist')).toBeUndefined();
  });

  it('restricts HTTP header rules to HTTP transports', () => {
    for (const rule of ALL_RULES.filter((r) => r.category === 'http-headers')) {
      expect(rule.appliesTo.transports, rule.id).not.toContain('stdio');
    }
  });
});

describe('MCP2026-ERROR-001 / -002 — resource error codes', () => {
  it('flags -32002 when a server emits it for a missing resource', async () => {
    await withTempProject(
      {
        'package.json': JSON.stringify({ dependencies: { '@modelcontextprotocol/sdk': '^1.0.0' } }),
        'server.ts': `
          import { ReadResourceRequestSchema } from '@modelcontextprotocol/sdk/types.js';
          server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
            const found = store.get(request.params.uri);
            if (!found) throw new McpError(-32002, 'Resource not found');
            return { contents: [found] };
          });
        `,
      },
      async (dir) => {
        const report = await reportFor(dir);
        const findings = findingsFor(report, 'MCP2026-ERROR-001');
        expect(findings).toHaveLength(1);
        expect(findings[0]?.confidence).toBe('high');
        expect(findings[0]?.remediation).toContain('-32602');
      },
    );
  });

  it('does NOT flag a client accepting -32002 from an older server', async () => {
    // The change is a producer/consumer asymmetry: servers MUST NOT emit
    // -32002, but clients SHOULD keep accepting it. A comparison is correct.
    await withTempProject(
      {
        'package.json': JSON.stringify({ dependencies: { '@modelcontextprotocol/sdk': '^1.0.0' } }),
        'client.ts': `
          import { Client } from '@modelcontextprotocol/sdk/client/index.js';
          export function isResourceMissing(error: { code: number }, uri: string): boolean {
            void Client;
            void uri;
            // resources/read may answer with either code depending on server age.
            if (error.code === -32602) return true;
            return error.code === -32002;
          }
          export function classify(code: number): string {
            switch (code) {
              case -32002:
              case -32602:
                return 'resource-not-found';
              default:
                return 'other';
            }
          }
        `,
      },
      async (dir) => {
        const report = await reportFor(dir);
        expect(findingsFor(report, 'MCP2026-ERROR-001')).toEqual([]);
        expect(findingsFor(report, 'MCP2026-ERROR-002')).toEqual([]);
      },
    );
  });

  it('reports an unexplained -32002 as review rather than error', async () => {
    await withTempProject(
      {
        'package.json': JSON.stringify({ dependencies: { '@modelcontextprotocol/sdk': '^1.0.0' } }),
        'errors.ts': `
          import { McpError } from '@modelcontextprotocol/sdk/types.js';
          export function rateLimited() {
            throw new McpError(-32002, 'Too many requests');
          }
        `,
      },
      async (dir) => {
        const report = await reportFor(dir);
        expect(findingsFor(report, 'MCP2026-ERROR-001')).toEqual([]);
        const ambiguous = findingsFor(report, 'MCP2026-ERROR-002');
        expect(ambiguous).toHaveLength(1);
        expect(ambiguous[0]?.level).toBe('review');
      },
    );
  });

  it('does not flag other valid JSON-RPC error codes', async () => {
    await withTempProject(
      {
        'package.json': JSON.stringify({ dependencies: { '@modelcontextprotocol/sdk': '^1.0.0' } }),
        'errors.ts': `
          export const CODES = {
            parse: -32700,
            invalidRequest: -32600,
            methodNotFound: -32601,
            invalidParams: -32602,
            internal: -32603,
            custom: -32011,
          };
          export function notFound(uri: string) {
            throw { code: -32602, message: 'Resource not found', data: { uri } };
          }
        `,
      },
      async (dir) => {
        const report = await reportFor(dir);
        const errorFindings = report.findings.filter((f) => f.category === 'resource-errors');
        expect(errorFindings).toEqual([]);
      },
    );
  });
});

describe('MCP2026-HEADER-001 — required routing headers', () => {
  it('flags an explicit MCP request that omits the routing headers', async () => {
    await withTempProject(
      {
        'package.json': JSON.stringify({
          dependencies: { '@modelcontextprotocol/sdk': '^1.0.0' },
        }),
        'transport.ts': `
          import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
          export const t = StreamableHTTPClientTransport;
          export async function call(name: string) {
            return fetch('https://example.com/mcp', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                jsonrpc: '2.0',
                id: 1,
                method: 'tools/call',
                params: { name, arguments: {} },
              }),
            });
          }
        `,
      },
      async (dir) => {
        const report = await reportFor(dir);
        const findings = findingsFor(report, 'MCP2026-HEADER-001');
        expect(findings).toHaveLength(1);
        expect(findings[0]?.level).toBe('error');
        expect(findings[0]?.title).toContain('Mcp-Method');
      },
    );
  });

  it('does not flag a request that already sets the headers', async () => {
    await withTempProject(
      {
        'package.json': JSON.stringify({
          dependencies: { '@modelcontextprotocol/sdk': '^1.0.0' },
        }),
        'transport.ts': `
          import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
          export const t = StreamableHTTPClientTransport;
          export async function call(name: string) {
            return fetch('https://example.com/mcp', {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'MCP-Protocol-Version': '2026-07-28',
                'Mcp-Method': 'tools/call',
                'Mcp-Name': name,
              },
              body: JSON.stringify({
                jsonrpc: '2.0',
                id: 1,
                method: 'tools/call',
                params: {
                  name,
                  arguments: {},
                  _meta: {
                    'io.modelcontextprotocol/protocolVersion': '2026-07-28',
                    'io.modelcontextprotocol/clientCapabilities': {},
                  },
                },
              }),
            });
          }
        `,
      },
      async (dir) => {
        const report = await reportFor(dir);
        expect(findingsFor(report, 'MCP2026-HEADER-001')).toEqual([]);
      },
    );
  });

  it('never fires for a stdio-only repository', async () => {
    const report = await reportFor(fixture('clean-stdio-server'));
    expect(report.repository.transport).toBe('stdio');
    expect(report.findings.filter((f) => f.category === 'http-headers')).toEqual([]);
  });
});

describe('MCP2026-SESSION-002 — transport session options', () => {
  it('accepts the documented stateless shape', async () => {
    await withTempProject(
      {
        'package.json': JSON.stringify({
          dependencies: { '@modelcontextprotocol/sdk': '^1.0.0' },
        }),
        'server.ts': `
          import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
          export const transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: undefined,
          });
        `,
      },
      async (dir) => {
        const report = await reportFor(dir);
        expect(findingsFor(report, 'MCP2026-SESSION-002')).toEqual([]);
      },
    );
  });

  it('flags a session-minting transport', async () => {
    await withTempProject(
      {
        'package.json': JSON.stringify({
          dependencies: { '@modelcontextprotocol/sdk': '^1.0.0' },
        }),
        'server.ts': `
          import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
          export const transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => crypto.randomUUID(),
          });
        `,
      },
      async (dir) => {
        const report = await reportFor(dir);
        const findings = findingsFor(report, 'MCP2026-SESSION-002');
        expect(findings).toHaveLength(1);
        expect(findings[0]?.level).toBe('error');
      },
    );
  });
});

describe('MCP2026-APPS-001 — MCP Apps readiness', () => {
  it('reports NO_SIGNAL for a plain MCP server', async () => {
    const report = await reportFor(fixture('clean-stdio-server'));
    expect(report.summary.appsReadiness).toBe('NO_SIGNAL');
  });

  it('reports NOT_APPLICABLE when the target is not an MCP server', async () => {
    await withTempProject(
      { 'index.ts': 'export const hello = () => "world";' },
      async (dir) => {
        const report = await reportFor(dir);
        expect(report.repository.isLikelyMcpServer).toBe(false);
        expect(report.summary.appsReadiness).toBe('NOT_APPLICABLE');
      },
    );
  });

  it('reports LIKELY_READY only for an explicit MCP Apps signal', async () => {
    await withTempProject(
      {
        'package.json': JSON.stringify({
          dependencies: { '@modelcontextprotocol/sdk': '^1.0.0' },
        }),
        'ui.ts': `
          import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
          export const s = McpServer;
          export const template = {
            uri: 'ui://weather/dashboard',
            mimeType: 'text/html;profile=mcp-app',
          };
        `,
      },
      async (dir) => {
        const report = await reportFor(dir);
        expect(report.summary.appsReadiness).toBe('LIKELY_READY');
        const findings = findingsFor(report, 'MCP2026-APPS-001');
        expect(findings.every((finding) => finding.level === 'info')).toBe(true);
      },
    );
  });

  it('treats generic HTML as a candidate, never as a valid MCP App', async () => {
    await withTempProject(
      {
        'package.json': JSON.stringify({
          dependencies: { '@modelcontextprotocol/sdk': '^1.0.0' },
        }),
        'render.ts': `
          import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
          export const s = McpServer;
          export function toolResult(html: string) {
            return { content: [{ type: 'resource', mimeType: 'text/html', text: html }] };
          }
        `,
      },
      async (dir) => {
        const report = await reportFor(dir);
        expect(report.summary.appsReadiness).toBe('POSSIBLE_CANDIDATE');
      },
    );
  });

  it('identifies the OpenAI Apps SDK MIME type as a different contract', async () => {
    await withTempProject(
      {
        'package.json': JSON.stringify({
          dependencies: { '@modelcontextprotocol/sdk': '^1.0.0' },
        }),
        'ui.ts': `
          import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
          export const s = McpServer;
          export const MIME = 'text/html+skybridge';
        `,
      },
      async (dir) => {
        const report = await reportFor(dir);
        const findings = findingsFor(report, 'MCP2026-APPS-001');
        const foreign = findings.find((finding) => finding.title.includes('Non-MCP'));
        expect(foreign).toBeDefined();
        expect(foreign?.explanation).toContain('text/html;profile=mcp-app');
      },
    );
  });
});

describe('single-file scanning', () => {
  it('scans an individual TypeScript file', async () => {
    const target = path.join(fixture('legacy-session-server'), 'src', 'resources.ts');
    const report = await reportFor(target);

    expect(report.repository.singleFile).toBe(true);
    expect(report.summary.filesScanned).toBe(1);
    expect(findingsFor(report, 'MCP2026-ERROR-001')).toHaveLength(1);
  });

  it('scans an individual YAML file', async () => {
    const target = path.join(fixture('legacy-session-server'), 'deploy', 'ingress.yaml');
    const report = await reportFor(target);

    expect(report.summary.filesScanned).toBe(1);
    expect(findingsFor(report, 'MCP2026-SESSION-004').length).toBeGreaterThan(0);
  });
});
