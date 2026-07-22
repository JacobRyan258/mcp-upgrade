import { describe, expect, it } from 'vitest';
import { buildFinding } from '../src/scanner/rules/helpers.js';
import { sessionHeaderRule } from '../src/scanner/rules/stateless-lifecycle.js';
import type { PreparedFile } from '../src/types.js';
import { findingsFor, reportFor, withTempProject } from './helpers.js';

const V2_PACKAGE = JSON.stringify({
  name: 'fixture',
  dependencies: { '@modelcontextprotocol/server': '^2.0.0-beta.3' },
});

const HTTP_PACKAGE = JSON.stringify({
  name: 'fixture',
  dependencies: {
    '@modelcontextprotocol/server': '^2.0.0-beta.3',
    express: '^5.0.0',
  },
});

describe('target result and request shapes', () => {
  it('accepts either requestState or inputRequests in InputRequiredResult', async () => {
    await withTempProject(
      {
        'package.json': V2_PACKAGE,
        'src/server.ts': `
          import { McpServer } from '@modelcontextprotocol/server';
          import type { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
          export type Transport = StreamableHTTPServerTransport;
          declare const server: McpServer;
          server.setRequestHandler('tools/call', async () => ({
            resultType: 'input_required', requestState: 'opaque'
          }));
          server.setRequestHandler('resources/read', async () => ({
            resultType: 'input_required',
            inputRequests: { roots: { method: 'roots/list', params: {} } }
          }));
        `,
      },
      async (dir) => {
        const report = await reportFor(dir);
        expect(findingsFor(report, 'MCP2026-MRTR-002')).toEqual([]);
      },
    );
  });

  it('rejects an empty shape, invalid input method, and unsupported parent method', async () => {
    await withTempProject(
      {
        'package.json': V2_PACKAGE,
        'src/server.ts': `
          import { McpServer } from '@modelcontextprotocol/server';
          declare const server: McpServer;
          server.setRequestHandler('tools/call', async () => ({ resultType: 'input_required' }));
          server.setRequestHandler('resources/read', async () => ({
            resultType: 'input_required',
            inputRequests: { wrong: { method: 'tools/call', params: {} } }
          }));
          server.setRequestHandler('tools/list', async () => ({
            resultType: 'input_required', requestState: 'opaque'
          }));
        `,
      },
      async (dir) => {
        const findings = findingsFor(await reportFor(dir), 'MCP2026-MRTR-002');
        expect(findings.some((finding) => finding.title.includes('neither'))).toBe(true);
        expect(findings.some((finding) => finding.title.includes('invalid client request'))).toBe(true);
        expect(findings.some((finding) => finding.title.includes('not allowed'))).toBe(true);
        expect(findings.every((finding) => finding.level === 'error')).toBe(true);
      },
    );
  });

  it('downgrades shorthand and spread-provided MRTR fields to review', async () => {
    await withTempProject(
      {
        'package.json': V2_PACKAGE,
        'src/server.ts': `
          import { McpServer } from '@modelcontextprotocol/server';
          declare const server: McpServer;
          declare const requestState: string;
          declare const inherited: object;
          server.setRequestHandler('tools/call', async () => ({
            resultType: 'input_required', requestState
          }));
          server.setRequestHandler('resources/read', async () => ({
            resultType: 'input_required', ...inherited
          }));
        `,
      },
      async (dir) => {
        const findings = findingsFor(await reportFor(dir), 'MCP2026-MRTR-002');
        expect(findings).toHaveLength(2);
        expect(findings.every((finding) => finding.level === 'review')).toBe(true);
      },
    );
  });

  it('distinguishes server MRTR calls, client requests, and wrapper ambiguity', async () => {
    await withTempProject(
      {
        'package.json': V2_PACKAGE,
        'src/mcp-server.ts': `
          import { McpServer } from '@modelcontextprotocol/server';
          declare const server: McpServer;
          declare const client: { request(v: unknown): Promise<unknown> };
          declare const ctx: { createMessage(v: unknown): Promise<unknown> };
          await server.listRoots();
          await client.request({ method: 'roots/list', params: {} });
          await ctx.createMessage({ messages: [] });
          await ctx.request({ method: 'roots/list', params: {} });
        `,
      },
      async (dir) => {
        const findings = findingsFor(await reportFor(dir), 'MCP2026-MRTR-001');
        expect(findings).toHaveLength(3);
        expect(findings.some((finding) => finding.level === 'error')).toBe(true);
        expect(findings.filter((finding) => finding.level === 'review')).toHaveLength(2);
      },
    );
  });

  it('reviews decoded sensitive requestState without visible integrity verification', async () => {
    await withTempProject(
      {
        'package.json': V2_PACKAGE,
        'src/mcp-state.ts': `
          import { McpServer } from '@modelcontextprotocol/server';
          export function resume(requestState: string) {
            const state = JSON.parse(Buffer.from(requestState, 'base64url').toString());
            if (state.tenantId) return state.tenantId;
            return null;
          }
        `,
      },
      async (dir) => {
        const findings = findingsFor(await reportFor(dir), 'MCP2026-MRTR-003');
        expect(findings).toHaveLength(1);
        expect(findings[0]?.level).toBe('review');
      },
    );
  });

  it('accepts flattened CreateTaskResult and rejects nested or incomplete task shapes', async () => {
    await withTempProject(
      {
        'package.json': V2_PACKAGE,
        'src/results.ts': `
          import { McpServer } from '@modelcontextprotocol/server';
          export const task = () => ({ jsonrpc: '2.0', id: 1, result: {
            resultType: 'task', taskId: '1', status: 'working',
            createdAt: '2026-07-22T00:00:00Z', lastUpdatedAt: '2026-07-22T00:00:00Z', ttlMs: null
          }});
          export const vendor = () => ({ jsonrpc: '2.0', id: 2, result: {
            resultType: 'vendor.example/custom', value: 1
          }});
          export const brokenTask = () => ({ jsonrpc: '2.0', id: 3, result: {
            resultType: 'task', task: { taskId: 'legacy-nested' }
          }});
          export const incompleteTask = () => ({ jsonrpc: '2.0', id: 4, result: {
            resultType: 'task', taskId: '4', status: 'working'
          }});
        `,
      },
      async (dir) => {
        const findings = findingsFor(await reportFor(dir), 'MCP2026-RESULT-001');
        expect(findings).toHaveLength(3);
        expect(findings.find((finding) => finding.evidence.includes('vendor'))?.level).toBe('review');
        const taskFindings = findings.filter((finding) => finding.source.sep === 'SEP-2663');
        expect(taskFindings).toHaveLength(2);
        expect(taskFindings.every((finding) => finding.level === 'error')).toBe(true);
        expect(taskFindings.every((finding) => finding.title.includes('flattened Task shape'))).toBe(true);
      },
    );
  });

  it('validates explicit CreateTaskResult field types and reviews dynamic values', async () => {
    await withTempProject(
      {
        'package.json': V2_PACKAGE,
        'src/results.ts': `
          import { McpServer } from '@modelcontextprotocol/server';
          declare const taskId: string;
          declare const status: string;
          declare const createdAt: string;
          declare const lastUpdatedAt: string;
          declare const ttlMs: number | null;
          export const malformed = () => ({ jsonrpc: '2.0', id: 1, result: {
            resultType: 'task', taskId: 42, status: 'queued', createdAt: false,
            lastUpdatedAt: 'not-a-time', ttlMs: 1.5, pollIntervalMs: 'fast'
          }});
          export const dynamic = () => ({ jsonrpc: '2.0', id: 2, result: {
            resultType: 'task', taskId, status, createdAt, lastUpdatedAt, ttlMs
          }});
        `,
      },
      async (dir) => {
        const findings = findingsFor(await reportFor(dir), 'MCP2026-RESULT-001');
        expect(findings).toHaveLength(2);
        expect(findings.find((finding) => finding.level === 'error')?.title).toContain(
          'status has invalid value',
        );
        expect(findings.find((finding) => finding.level === 'error')?.title).toContain(
          'ttlMs must be an integer or null',
        );
        expect(findings.find((finding) => finding.level === 'review')?.title).toContain(
          'shape needs review',
        );
      },
    );
  });

  it('treats resultType shorthand as dynamic review', async () => {
    await withTempProject(
      {
        'src/mcp-result.ts': `
          declare const resultType: string;
          export const response = () => ({ jsonrpc: '2.0', id: 1, result: { resultType } });
        `,
      },
      async (dir) => {
        const findings = findingsFor(await reportFor(dir), 'MCP2026-RESULT-001');
        expect(findings).toHaveLength(1);
        expect(findings[0]?.level).toBe('review');
      },
    );
  });

  it('rejects CreateTaskResult from methods the Tasks extension does not augment', async () => {
    await withTempProject(
      {
        'package.json': V2_PACKAGE,
        'src/server.ts': `
          import { McpServer } from '@modelcontextprotocol/server';
          declare const server: McpServer;
          server.setRequestHandler('resources/read', async () => ({ jsonrpc: '2.0', id: 1, result: {
            resultType: 'task', taskId: '1', status: 'working',
            createdAt: '2026-07-22T00:00:00Z', lastUpdatedAt: '2026-07-22T00:00:00Z', ttlMs: null
          }}));
        `,
      },
      async (dir) => {
        const findings = findingsFor(await reportFor(dir), 'MCP2026-RESULT-001');
        expect(findings).toHaveLength(1);
        expect(findings[0]?.title).toContain('not supported for resources/read');
        expect(findings[0]?.source.sep).toBe('SEP-2663');
      },
    );
  });

  it('requires metadata on requests, ignores notifications, and reviews shorthand params', async () => {
    await withTempProject(
      {
        'src/mcp-client.ts': `
          declare const transport: { send(v: unknown): void };
          declare const params: object;
          transport.send({ jsonrpc: '2.0', method: 'tools/list', params: {} });
          transport.send({ jsonrpc: '2.0', id: 1, method: 'tools/list', params });
          transport.send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
          transport.send({ jsonrpc: '2.0', id: 3, method: 'tools/list', params: {
            _meta: {
              'io.modelcontextprotocol/protocolVersion': '2026-07-28',
              'io.modelcontextprotocol/clientCapabilities': {}
            }
          }});
        `,
      },
      async (dir) => {
        const findings = findingsFor(await reportFor(dir), 'MCP2026-META-001');
        expect(findings).toHaveLength(2);
        expect(findings.some((finding) => finding.level === 'review')).toBe(true);
        expect(findings.some((finding) => finding.level === 'error')).toBe(true);
      },
    );
  });

  it('does not apply ordinary request metadata requirements inside inputRequests', async () => {
    await withTempProject(
      {
        'src/mcp-mrtr.ts': `
          declare const server: { setRequestHandler(m: string, h: () => unknown): void };
          server.setRequestHandler('tools/call', () => ({
            resultType: 'input_required',
            inputRequests: {
              roots: { jsonrpc: '2.0', id: 1, method: 'roots/list', params: {} }
            }
          }));
        `,
      },
      async (dir) => {
        expect(findingsFor(await reportFor(dir), 'MCP2026-META-001')).toEqual([]);
      },
    );
  });

  it('does not mistake foreign JSON-RPC traffic in an MCP bridge for MCP wire objects', async () => {
    await withTempProject(
      {
        'package.json': V2_PACKAGE,
        'src/bridge.ts': `
          import { McpServer } from '@modelcontextprotocol/server';
          declare const server: McpServer;
          declare const transport: { send(value: unknown): void };

          export const ethereumRequest = () => transport.send({
            jsonrpc: '2.0', id: 1, method: 'eth_getBalance', params: { address: '0x0' }
          });
          export const ethereumResponse = () => ({
            jsonrpc: '2.0', id: 1, result: { blockNumber: '0x123' }
          });

          transport.send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
          server.setRequestHandler('tools/list', async () => ({
            jsonrpc: '2.0', id: 2, result: { tools: [] }
          }));
        `,
      },
      async (dir) => {
        const report = await reportFor(dir);
        const resultFindings = findingsFor(report, 'MCP2026-RESULT-001');
        const metadataFindings = findingsFor(report, 'MCP2026-META-001');

        expect(resultFindings).toHaveLength(1);
        expect(resultFindings[0]?.level).toBe('error');
        expect(resultFindings[0]?.evidence).toContain('tools');
        expect(metadataFindings).toHaveLength(1);
        expect(metadataFindings[0]?.level).toBe('error');
        expect(metadataFindings[0]?.evidence).toContain('tools/list');
        expect(JSON.stringify([...resultFindings, ...metadataFindings])).not.toContain(
          'eth_getBalance',
        );
        expect(JSON.stringify([...resultFindings, ...metadataFindings])).not.toContain(
          'blockNumber',
        );
      },
    );
  });
});

describe('discovery, caching, and error renumbering', () => {
  it('keeps serverInfo placement and absence at SHOULD-level review', async () => {
    await withTempProject(
      {
        'package.json': V2_PACKAGE,
        'src/discover.ts': `
          import { McpServer } from '@modelcontextprotocol/server';
          export const old = () => ({ supportedVersions: ['2026-07-28'], capabilities: {}, serverInfo: { name: 'x' } });
          export const missing = () => ({ supportedVersions: ['2026-07-28'], capabilities: {} });
          export const current = () => ({ supportedVersions: ['2026-07-28'], capabilities: {},
            _meta: { 'io.modelcontextprotocol/serverInfo': { name: 'x' } }
          });
        `,
      },
      async (dir) => {
        const findings = findingsFor(await reportFor(dir), 'MCP2026-DISCOVERY-001');
        expect(findings).toHaveLength(2);
        expect(findings.every((finding) => finding.level === 'review')).toBe(true);
      },
    );
  });

  it('does not infer missing server/discover from unrelated JSON-RPC or REST dispatch', async () => {
    await withTempProject(
      {
        'package.json': JSON.stringify({ dependencies: { '@modelcontextprotocol/server': '2.0.0' } }),
        'src/mcp.ts': "import { McpServer } from '@modelcontextprotocol/server'; export const mcp = McpServer;\n",
        'src/orders.ts': `
          declare const router: { onRequest(m: string, h: () => unknown): void };
          router.onRequest('/api/orders', () => ({ jsonrpc: '2.0', id: 1, result: { orders: [] } }));
        `,
      },
      async (dir) => {
        expect(findingsFor(await reportFor(dir), 'MCP2026-DISCOVERY-001')).toEqual([]);
      },
    );
  });

  it('finds raw custom-server result and cache defects in case-clause dispatch', async () => {
    await withTempProject(
      {
        'src/custom.ts': `
          export function dispatch(req: { method: string }) {
            switch (req.method) {
              case 'tools/list':
                return { jsonrpc: '2.0', id: 1, result: { tools: [] } };
              default: return null;
            }
          }
        `,
      },
      async (dir) => {
        const report = await reportFor(dir);
        expect(findingsFor(report, 'MCP2026-RESULT-001').some((f) => f.level === 'error')).toBe(true);
        expect(findingsFor(report, 'MCP2026-CACHE-001').length).toBeGreaterThan(0);
      },
    );
  });

  it('associates cache hints with the directly containing method', async () => {
    await withTempProject(
      {
        'package.json': V2_PACKAGE,
        'src/server.ts': `
          import { McpServer } from '@modelcontextprotocol/server';
          declare const server: McpServer;
          server.setRequestHandler('tools/call', async () => ({ jsonrpc: '2.0', id: 1, result: {
            resultType: 'complete', tools: []
          }}));
          server.setRequestHandler('tools/list', async () => ({ jsonrpc: '2.0', id: 2, result: {
            resultType: 'complete', tools: [], ttlMs: 0.5, cacheScope: 'private'
          }}));
        `,
      },
      async (dir) => {
        const findings = findingsFor(await reportFor(dir), 'MCP2026-CACHE-001');
        expect(findings).toHaveLength(1);
        expect(findings[0]?.level).toBe('error');
        expect(findings[0]?.evidence).toContain('ttlMs');
      },
    );
  });

  it('reviews shorthand cache values instead of asserting they are missing', async () => {
    await withTempProject(
      {
        'package.json': V2_PACKAGE,
        'src/server.ts': `
          import { McpServer } from '@modelcontextprotocol/server';
          declare const server: McpServer;
          declare const ttlMs: number;
          declare const cacheScope: 'private' | 'public';
          server.setRequestHandler('tools/list', async () => ({ jsonrpc: '2.0', id: 1, result: {
            resultType: 'complete', tools: [], ttlMs, cacheScope
          }}));
        `,
      },
      async (dir) => {
        const findings = findingsFor(await reportFor(dir), 'MCP2026-CACHE-001');
        expect(findings).toHaveLength(1);
        expect(findings[0]?.level).toBe('review');
      },
    );
  });

  it('asserts only proven named error emission, not a helper return or client comparison', async () => {
    await withTempProject(
      {
        'package.json': V2_PACKAGE,
        'src/errors.ts': `
          import { McpServer } from '@modelcontextprotocol/server';
          class McpError extends Error { constructor(public code: number, message: string) { super(message); } }
          export function legacyHeaderCode() { return -32001; } // HeaderMismatch compatibility
          export function accepts(error: { code: number }) { return error.code === -32001; }
          export function emit() { throw new McpError(-32001, 'HeaderMismatch'); }
        `,
      },
      async (dir) => {
        const findings = findingsFor(await reportFor(dir), 'MCP2026-ERROR-003');
        expect(findings.some((finding) => finding.level === 'error')).toBe(true);
        expect(findings.some((finding) => finding.level === 'review')).toBe(true);
        expect(findings.filter((finding) => finding.level === 'error')).toHaveLength(1);
      },
    );
  });
});

describe('Streamable HTTP evidence', () => {
  it('ignores notifications and unrelated extension-looking RPC calls', async () => {
    await withTempProject(
      {
        'package.json': HTTP_PACKAGE,
        'src/client.ts': `
          await fetch('/mcp', { method: 'POST', body: JSON.stringify({
            jsonrpc: '2.0', method: 'tools/call', params: { name: 'x' }
          }) });
          await fetch('/internal-rpc', { method: 'POST', body: JSON.stringify({
            jsonrpc: '2.0', id: 1, method: 'orders/list', params: {}
          }) });
        `,
      },
      async (dir) => {
        expect(findingsFor(await reportFor(dir), 'MCP2026-HEADER-001')).toEqual([]);
      },
    );
  });

  it('does not let comments inside a request satisfy required headers', async () => {
    await withTempProject(
      {
        'package.json': HTTP_PACKAGE,
        'src/client.ts': `
          await fetch('/mcp', {
            method: 'POST',
            /* 'MCP-Protocol-Version': '2026-07-28', 'Mcp-Method': 'tools/list' */
            // 'Mcp-Name': 'x'
            body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} })
          });
        `,
      },
      async (dir) => {
        const findings = findingsFor(await reportFor(dir), 'MCP2026-HEADER-001');
        expect(findings).toHaveLength(1);
        expect(findings[0]?.level).toBe('error');
      },
    );
  });

  it('reviews request-option spreads and interpolated header values', async () => {
    await withTempProject(
      {
        'package.json': HTTP_PACKAGE,
        'src/client.ts': `
          declare const mcpDefaults: object;
          declare const method: string;
          await fetch('/mcp', { ...mcpDefaults, method: 'POST', body: JSON.stringify({
            jsonrpc: '2.0', id: 1, method: 'tools/list', params: {}
          }) });
          await fetch('/mcp', { method: 'POST', headers: {
            'MCP-Protocol-Version': '2026-07-28', 'Mcp-Method': \`\${method}\`
          }, body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {
            _meta: {
              'io.modelcontextprotocol/protocolVersion': '2026-07-28',
              'io.modelcontextprotocol/clientCapabilities': {}
            }
          }}) });
        `,
      },
      async (dir) => {
        const findings = findingsFor(await reportFor(dir), 'MCP2026-HEADER-001');
        expect(findings).toHaveLength(2);
        expect(findings.every((finding) => finding.level === 'review')).toBe(true);
      },
    );
  });

  it('checks taskId routing and protocol-version equality', async () => {
    await withTempProject(
      {
        'package.json': HTTP_PACKAGE,
        'src/client.ts': `
          await fetch('/mcp', { method: 'POST', headers: {
            'MCP-Protocol-Version': '2026-01-01',
            'Mcp-Method': 'tasks/get',
            'Mcp-Name': 'wrong-task'
          }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tasks/get', params: {
            taskId: 'task-1',
            _meta: {
              'io.modelcontextprotocol/protocolVersion': '2026-07-28',
              'io.modelcontextprotocol/clientCapabilities': {}
            }
          }}) });
        `,
      },
      async (dir) => {
        const finding = findingsFor(await reportFor(dir), 'MCP2026-HEADER-001')[0];
        expect(finding?.level).toBe('error');
        expect(finding?.title).toContain('MCP-Protocol-Version');
        expect(finding?.title).toContain('Mcp-Name');
        expect(finding?.source.sep).toBe('SEP-2663');
      },
    );
  });

  it('requires complete custom validation and detects Fastify routes', async () => {
    await withTempProject(
      {
        'package.json': HTTP_PACKAGE,
        'src/server.ts': `
          import { McpServer } from '@modelcontextprotocol/server';
          import type { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
          export type Transport = StreamableHTTPServerTransport;
          declare const fastify: { post(path: string, handler: unknown): void };
          fastify.post('/mcp', (req: any, res: any) => {
            if (req.headers['mcp-method'] !== req.body.method) res.status(400).send();
          });
        `,
      },
      async (dir) => {
        const report = await reportFor(dir);
        expect(report.repository.transport).not.toBe('unknown');
        const findings = findingsFor(report, 'MCP2026-HEADER-002');
        expect(findings).toHaveLength(1);
        expect(findings[0]?.level).toBe('review');
      },
    );
  });

  it('recognizes complete comparison, Node handlers, object routes, and aliased official adapters', async () => {
    await withTempProject(
      {
        'package.json': HTTP_PACKAGE,
        'src/full.ts': `
          import { McpServer } from '@modelcontextprotocol/server';
          declare const app: { post(path: string, handler: unknown): void };
          app.post('/mcp', (req: any) => {
            if (req.headers['mcp-protocol-version'] !== req.body.params._meta['io.modelcontextprotocol/protocolVersion'] ||
                req.headers['mcp-method'] !== req.body.method ||
                req.headers['mcp-name'] !== req.body.params.name) throw new Error('HeaderMismatch');
          });
        `,
        'src/node.ts': `
          import { McpServer } from '@modelcontextprotocol/server';
          import http from 'node:http';
          function handleMcp(req: any) { return req.url; }
          http.createServer(handleMcp);
        `,
        'src/object.ts': `
          import { McpServer } from '@modelcontextprotocol/server';
          declare const fastify: { route(v: unknown): void };
          function mcpHandler(req: any) { return req.body; }
          fastify.route({ method: 'POST', url: '/mcp', handler: mcpHandler });
        `,
        'src/official.ts': `
          import { createMcpHandler as makeHandler, McpServer } from '@modelcontextprotocol/server';
          declare const app: { post(path: string, handler: unknown): void };
          const handler = makeHandler(() => new McpServer({ name: 'x', version: '1' }));
          app.post('/mcp', handler);
        `,
      },
      async (dir) => {
        const findings = findingsFor(await reportFor(dir), 'MCP2026-HEADER-002');
        expect(findings.map((finding) => finding.file).sort()).toEqual([
          'src/node.ts',
          'src/object.ts',
        ]);
      },
    );
  });

  it('does not duplicate informational header signals at one source location', async () => {
    await withTempProject(
      {
        'package.json': HTTP_PACKAGE,
        'src/header.ts': `
          import { McpServer } from '@modelcontextprotocol/server';
          import type { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
          export type Transport = StreamableHTTPServerTransport;
          export const headers = { 'Mcp-Method': 'tools/list' };
        `,
      },
      async (dir) => {
        const findings = findingsFor(await reportFor(dir), 'MCP2026-HEADER-003');
        expect(findings).toHaveLength(1);
      },
    );
  });
});

describe('lifecycle and provenance boundaries', () => {
  it('does not treat a non-MCP protocol constant catalog as server behavior', async () => {
    await withTempProject(
      {
        'src/constants.ts': `
          export const SESSION_HEADER = 'Mcp-Session-Id';
          export const EXTENSIONS = { ui: 'io.modelcontextprotocol/ui' };
          export const APP_MIME = 'text/html;profile=mcp-app';
          export const detectorNotes = '_meta.ui.resourceUri ui/resourceUri';
          export const headerNames = new Set(['mcp-session-id']);
        `,
      },
      async (dir) => {
        const report = await reportFor(dir);
        expect(report.repository.isLikelyMcpServer).toBe(false);
        expect(findingsFor(report, 'MCP2026-SESSION-001')).toEqual([]);
        expect(findingsFor(report, 'MCP2026-APPS-001')).toEqual([]);
        expect(report.summary.appsReadiness).toBe('NOT_APPLICABLE');
      },
    );
  });

  it('does not treat scanner metadata or explanatory strings as live protocol behavior', async () => {
    await withTempProject(
      {
        'package.json': V2_PACKAGE,
        'src/rule.ts': `
          import type { McpServer } from '@modelcontextprotocol/server';
          void (null as unknown as McpServer);
          const removed = [{ method: 'tasks/list' }];
          const legacy = ['execution.taskSupport', 'taskSupport'];
          const explanation = 'tasks/list is removed. ' +
            'tasks/list was previously available.';
          const stickyPatterns = [/\\bip_hash\\b/g];
          export const rule = {
            appliesTo: { transports: ['stdio', 'streamable-http'] },
            removed,
            legacy,
            explanation,
            stickyPatterns,
          };
        `,
      },
      async (dir) => {
        const report = await reportFor(dir);
        expect(findingsFor(report, 'MCP2026-TASKS-001')).toEqual([]);
        expect(findingsFor(report, 'MCP2026-TASKS-002')).toEqual([]);
        expect(findingsFor(report, 'MCP2026-SESSION-003')).toEqual([]);
        expect(findingsFor(report, 'MCP2026-SESSION-004')).toEqual([]);
      },
    );
  });

  it('accepts every explicitly disabled v1 session callback', async () => {
    await withTempProject(
      {
        'src/mcp-server.ts': `
          import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
          new StreamableHTTPServerTransport({
            sessionIdGenerator: undefined,
            onsessioninitialized: undefined,
            onsessionclosed: undefined
          });
        `,
      },
      async (dir) => {
        expect(findingsFor(await reportFor(dir), 'MCP2026-SESSION-002')).toEqual([]);
      },
    );
  });

  it('reviews a Last-Event-ID read, warns on replay, and ignores unrelated code', async () => {
    await withTempProject(
      {
        'package.json': HTTP_PACKAGE,
        'src/mcp-read.ts': `
          import { McpServer } from '@modelcontextprotocol/server';
          import type { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
          declare const req: any;
          export type Transport = StreamableHTTPServerTransport;
          export const id = req.headers['last-event-id'];
        `,
        'src/mcp-replay.ts': `
          import { McpServer } from '@modelcontextprotocol/server';
          declare const res: any;
          export function resume(eventId: string) { res.setHeader('Last-Event-ID', eventId); return replay(eventId); }
          declare function replay(id: string): unknown;
        `,
        'src/unrelated.ts': "export const id = response.headers['last-event-id'];\n",
      },
      async (dir) => {
        const findings = findingsFor(await reportFor(dir), 'MCP2026-LIFECYCLE-003');
        expect(findings.some((finding) => finding.level === 'review')).toBe(true);
        expect(findings.some((finding) => finding.level === 'warning')).toBe(true);
        expect(findings.every((finding) => finding.file.startsWith('src/mcp-'))).toBe(true);
      },
    );
  });

  it('finds exact Fastify GET/DELETE endpoints, ignores health subroutes, and accepts 405 handlers', async () => {
    await withTempProject(
      {
        'package.json': HTTP_PACKAGE,
        'src/routes.ts': `
          import { McpServer } from '@modelcontextprotocol/server';
          import type { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
          export type Transport = StreamableHTTPServerTransport;
          declare const fastify: any;
          fastify.get('/mcp', streamSse);
          fastify.delete('/mcp', endSession);
          fastify.get('/mcp/health', health);
          fastify.get('/api/mcp', (_req: any, res: any) => res.sendStatus(405));
          declare const streamSse: unknown, endSession: unknown, health: unknown;
        `,
      },
      async (dir) => {
        const findings = findingsFor(await reportFor(dir), 'MCP2026-LIFECYCLE-003');
        expect(findings).toHaveLength(2);
        expect(findings.every((finding) => finding.level === 'warning')).toBe(true);
      },
    );
  });

  it('ignores decoy classes, receivers, generic JSON-RPC, and lifecycle words', async () => {
    await withTempProject(
      {
        'package.json': JSON.stringify({ name: 'plain' }),
        'src/decoy.ts': `
          class McpServer { connect(): void {} }
          const instance = new McpServer();
          const server = { setRequestHandler(_m: string, _h: unknown) {}, registerTool() {} };
          const client = { connect() {} };
          server.setRequestHandler('orders/list', () => ({}));
          server.registerTool(); client.connect(); instance.connect();
          switch ('command') { case 'ping': break; case 'initialize': break; }
          export const message = { jsonrpc: '2.0', method: 'orders/list' };
        `,
      },
      async (dir) => {
        expect((await reportFor(dir)).findings).toEqual([]);
      },
    );
  });

  it('keeps lifecycle matching bounded on many decoy literals', async () => {
    const lines = Array.from({ length: 2_000 }, (_, index) => `console.log('initialize', ${index});`).join('\n');
    await withTempProject(
      {
        'package.json': V2_PACKAGE,
        'src/mcp-log.ts': "import { McpServer } from '@modelcontextprotocol/server';\n" + lines,
      },
      async (dir) => {
        const started = performance.now();
        const report = await reportFor(dir);
        expect(findingsFor(report, 'MCP2026-LIFECYCLE-001')).toEqual([]);
        expect(performance.now() - started).toBeLessThan(4_000);
      },
    );
  });
});

describe('package, module, and monorepo boundaries', () => {
  it('reviews manifest-only v1 dependencies, including nested workspaces', async () => {
    await withTempProject(
      {
        'package.json': JSON.stringify({
          name: 'workspace',
          devDependencies: { '@modelcontextprotocol/sdk': '^1.29.0' },
        }),
        'packages/server/package.json': JSON.stringify({
          name: 'server',
          dependencies: { '@modelcontextprotocol/sdk': '^1.28.0' },
        }),
        'config.json': JSON.stringify({ '@modelcontextprotocol/sdk': 'not-a-dependency' }),
      },
      async (dir) => {
        const findings = findingsFor(await reportFor(dir), 'MCP2026-SDK-001');
        expect(findings).toHaveLength(2);
        expect(findings.every((finding) => finding.level === 'review')).toBe(true);
      },
    );
  });

  it('keeps direct v1 server transport connection at error', async () => {
    await withTempProject(
      {
        'package.json': JSON.stringify({ dependencies: { '@modelcontextprotocol/sdk': '^1.29.0' } }),
        'src/server.ts': `
          import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
          import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
          const server = new McpServer({ name: 'x', version: '1' });
          await server.connect(new StdioServerTransport());
        `,
      },
      async (dir) => {
        const findings = findingsFor(await reportFor(dir), 'MCP2026-SDK-001');
        expect(findings.some((finding) => finding.level === 'error')).toBe(true);
      },
    );
  });

  it('does not borrow MCP provenance for generic sibling-package vocabulary', async () => {
    await withTempProject(
      {
        'package.json': V2_PACKAGE,
        'packages/mcp/server.ts': "import { McpServer } from '@modelcontextprotocol/server'; export const Server = McpServer;\n",
        'packages/web/config.ts': `
          export const config = {
            capabilities: { roots: {} },
            logging: { level: 'info' },
            includeContext: 'thisServer'
          };
        `,
        'packages/web/tasks.ts': "router.get('tasks/list', handler);\n",
        'packages/web/view.ts': "export const page = { resourceUri: '/home', mimeType: 'text/html' };\n",
      },
      async (dir) => {
        const report = await reportFor(dir);
        for (const id of [
          'MCP2026-ROOTS-001',
          'MCP2026-LOGGING-001',
          'MCP2026-SAMPLING-002',
          'MCP2026-TASKS-001',
          'MCP2026-APPS-001',
        ]) {
          expect(findingsFor(report, id), id).toEqual([]);
        }
      },
    );
  });

  it('resolves ESM aliases, namespace imports, and renamed CommonJS imports', async () => {
    await withTempProject(
      {
        'src/aliases.ts': `
          import { RootsListChangedNotificationSchema as LegacyRoots } from '@modelcontextprotocol/sdk/types.js';
          import * as Protocol from '@modelcontextprotocol/sdk/types.js';
          void LegacyRoots; void Protocol.RootsListChangedNotificationSchema;
        `,
        'src/tasks.cjs': `
          const { ListTasksRequestSchema: LegacyList } = require('@modelcontextprotocol/sdk/types.js');
          void LegacyList;
        `,
      },
      async (dir) => {
        const report = await reportFor(dir);
        expect(findingsFor(report, 'MCP2026-ROOTS-002').length).toBeGreaterThan(0);
        expect(findingsFor(report, 'MCP2026-TASKS-001').length).toBeGreaterThan(0);
      },
    );
  });

  it('ignores protocol words logged as labels but detects a registration wrapper', async () => {
    await withTempProject(
      {
        'package.json': V2_PACKAGE,
        'src/server.ts': `
          import { McpServer } from '@modelcontextprotocol/server';
          declare const server: McpServer;
          console.log('tasks/list', 'notifications/roots/list_changed', 'sampling/createMessage');
          const registerLegacy = server.setRequestHandler.bind(server);
          registerLegacy('tasks/list', () => ({}));
        `,
      },
      async (dir) => {
        const report = await reportFor(dir);
        const taskFindings = findingsFor(report, 'MCP2026-TASKS-001');
        expect(taskFindings).toHaveLength(1);
        expect(taskFindings[0]?.evidence).toContain('registerLegacy');
        expect(findingsFor(report, 'MCP2026-ROOTS-002')).toEqual([]);
      },
    );
  });

  it('does not report generic web elicitation IDs without local MCP provenance', async () => {
    await withTempProject(
      {
        'src/web.ts': `
          app.post('/elicitation/complete', (req: any) => ({
            elicitationId: req.body.id, url: req.body.url
          }));
        `,
      },
      async (dir) => {
        expect(findingsFor(await reportFor(dir), 'MCP2026-ELICITATION-001')).toEqual([]);
      },
    );
  });

  it('suppresses server-output rules in ESM and CJS client-only wrappers', async () => {
    await withTempProject(
      {
        'src/client.ts': `
          import { Client } from '@modelcontextprotocol/client';
          export const wrap = () => ({ jsonrpc: '2.0', id: 1, result: {
            tools: [], supportedVersions: ['2026-07-28'], capabilities: {}
          }});
        `,
        'src/client.cjs': `
          const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
          exports.wrap = () => ({ jsonrpc: '2.0', id: 2, result: { resources: [] } });
          void Client;
        `,
      },
      async (dir) => {
        const report = await reportFor(dir);
        expect(findingsFor(report, 'MCP2026-RESULT-001')).toEqual([]);
        expect(findingsFor(report, 'MCP2026-CACHE-001')).toEqual([]);
        expect(findingsFor(report, 'MCP2026-DISCOVERY-001')).toEqual([]);
      },
    );
  });
});

describe('error, logging, and evidence precision', () => {
  it('uses inclusive span positioning at a CRLF line boundary and clones source metadata', () => {
    const file: PreparedFile = {
      absPath: '/tmp/mcp.ts',
      relPath: 'mcp.ts',
      ext: '.ts',
      kind: 'ts',
      content: 'hit\r\nnext',
      size: 9,
      lineStarts: [0, 5],
      commentRanges: [],
      isTestPath: false,
    };
    const finding = buildFinding(
      sessionHeaderRule,
      { file, offset: 0, endOffset: 5, text: 'hit\r\n' },
      { explanation: 'x', remediation: 'y' },
    );
    expect(finding.line).toBe(1);
    expect(finding.endLine).toBeUndefined();
    expect(finding.source).not.toBe(sessionHeaderRule.source);
  });

  it('reviews a lone legacy client comparison but accepts both old and current codes', async () => {
    await withTempProject(
      {
        'src/client.ts': `
          import { Client } from '@modelcontextprotocol/sdk/client/index.js';
          export function compatible(error: { code: number }) {
            return error.code === -32002 || error.code === -32602;
          }
          export function stale(error: { code: number }) {
            return error.code === -32002;
          }
          void Client;
        `,
      },
      async (dir) => {
        const findings = findingsFor(await reportFor(dir), 'MCP2026-ERROR-002');
        expect(findings).toHaveLength(1);
        expect(findings[0]?.level).toBe('review');
        expect(findings[0]?.evidence).toContain('-32002');
      },
    );
  });

  it('keeps a resource-list error ambiguous instead of asserting resource-not-found', async () => {
    await withTempProject(
      {
        'src/mcp-list.ts': `
          import { McpError } from '@modelcontextprotocol/sdk/types.js';
          export function listResources() { throw new McpError(-32002, 'backend rate limit'); }
        `,
      },
      async (dir) => {
        const report = await reportFor(dir);
        expect(findingsFor(report, 'MCP2026-ERROR-001')).toEqual([]);
        expect(findingsFor(report, 'MCP2026-ERROR-002')).toHaveLength(1);
      },
    );
  });

  it('classifies SetLevelRequest only as the removed RPC surface', async () => {
    await withTempProject(
      {
        'src/mcp-log.ts': `
          import { SetLevelRequest } from '@modelcontextprotocol/sdk/types.js';
          export type Legacy = SetLevelRequest;
        `,
      },
      async (dir) => {
        const report = await reportFor(dir);
        expect(findingsFor(report, 'MCP2026-LOGGING-001')).toEqual([]);
        const removed = findingsFor(report, 'MCP2026-LOGGING-002');
        expect(removed.length).toBeGreaterThan(0);
        expect(removed.every((finding) => finding.level === 'error')).toBe(true);
      },
    );
  });

  it('keeps two distinct violations on one minified line', async () => {
    await withTempProject(
      {
        'src/mcp-errors.ts': `import { McpError } from '@modelcontextprotocol/sdk/types.js';export function a(){throw new McpError(-32002,'resource not found')}export function b(){throw new McpError(-32002,'resource not found')}`,
      },
      async (dir) => {
        expect(findingsFor(await reportFor(dir), 'MCP2026-ERROR-001')).toHaveLength(2);
      },
    );
  });
});
