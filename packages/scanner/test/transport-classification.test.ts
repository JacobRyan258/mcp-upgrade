import { describe, expect, it } from 'vitest';
import { findingsFor, reportFor, withTempProject } from './helpers.js';

describe('custom HTTP transport classification', () => {
  it('recognizes Fastify, Hono, and Koa router variables in executable TypeScript and JavaScript', async () => {
    await withTempProject(
      {
        'src/fastify.ts': `
          declare const fastify: { post(path: string, handler: unknown): void };
          const mcpHandler = (request: unknown) => request;
          fastify.post('/mcp', mcpHandler);
        `,
        'src/hono.js': `
          const hono = { post() {} };
          hono.post('/api/mcp-server', (context) => context.body);
        `,
        'src/koa.js': `
          const koa = { post() {} };
          function handleMcp(context) { return context.request; }
          koa.post('/v1/mcp', handleMcp);
        `,
        'src/router.js': `
          const router = { post() {} };
          const mcpEndpoint = (context) => context.request;
          router.post('/mcp', mcpEndpoint);
        `,
      },
      async (dir) => {
        const report = await reportFor(dir);
        expect(report.repository.transport).toBe('custom-http');
        expect(report.repository.transportEvidence).toContain('MCP HTTP route');
        expect(report.repository.isLikelyMcpServer).toBe(true);
        expect(
          findingsFor(report, 'MCP2026-HEADER-002')
            .map((finding) => finding.file)
            .sort(),
        ).toEqual(['src/fastify.ts', 'src/hono.js', 'src/koa.js', 'src/router.js']);
      },
    );
  });

  it('opens lifecycle rules for a custom router that only defines an MCP DELETE endpoint', async () => {
    await withTempProject(
      {
        'src/router.ts': `
          declare const router: { delete(path: string, handler: unknown): void };
          const terminateMcp = () => undefined;
          router.delete('/mcp', terminateMcp);
        `,
      },
      async (dir) => {
        const report = await reportFor(dir);
        expect(report.repository.transport).toBe('custom-http');
        expect(findingsFor(report, 'MCP2026-LIFECYCLE-003')).toHaveLength(1);
      },
    );
  });

  it('recognizes complete Fastify-style object route declarations in TS and JS', async () => {
    await withTempProject(
      {
        'src/object-route.ts': `
          declare const fastify: { route(options: unknown): void };
          function mcpHandler(request: unknown) { return request; }
          fastify.route({ method: 'POST', url: '/mcp', handler: mcpHandler });
        `,
        'src/object-route.js': `
          const router = { route() {} };
          const handler = (request) => request;
          router.route({ method: 'POST', path: '/api/mcp', handler });
        `,
      },
      async (dir) => {
        const report = await reportFor(dir);
        expect(report.repository.transport).toBe('custom-http');
        expect(report.repository.transportEvidence).toContain('MCP object HTTP route');
        expect(
          findingsFor(report, 'MCP2026-HEADER-002')
            .map((finding) => finding.file)
            .sort(),
        ).toEqual(['src/object-route.js', 'src/object-route.ts']);
      },
    );
  });

  it('recognizes imported raw Node HTTP servers with executable MCP request dispatch', async () => {
    await withTempProject(
      {
        'src/raw-server.ts': `
          import { createServer as openServer } from 'node:http';
          openServer((request, response) => {
            if (request.url !== '/rpc') return response.end();
            const body = (request as any).body;
            if (body.jsonrpc !== '2.0') return response.end();
            switch (body.method) {
              case 'tools/call': return response.end(request.headers['mcp-method']);
              default: return response.end();
            }
          });
        `,
        'src/raw-server.cjs': `
          const web = require('node:http');
          web.createServer((request, response) => {
            if (request.url !== '/rpc') return response.end();
            if (request.body.jsonrpc === '2.0' && request.body.method === 'resources/read') {
              response.end(request.headers['mcp-method']);
            }
          });
        `,
      },
      async (dir) => {
        const report = await reportFor(dir);
        expect(report.repository.transport).toBe('custom-http');
        expect(report.repository.transportEvidence).toContain('MCP JSON-RPC HTTP server');
        expect(report.repository.isLikelyMcpServer).toBe(true);
        expect(
          findingsFor(report, 'MCP2026-HEADER-003')
            .map((finding) => finding.file)
            .sort(),
        ).toEqual(['src/raw-server.cjs', 'src/raw-server.ts']);
      },
    );
  });

  it('ignores route examples in comments, strings, templates, and inert configuration', async () => {
    await withTempProject(
      {
        'src/examples.ts': `
          // fastify.post('/mcp', mcpHandler);
          const quoted = "hono.post('/mcp', handler)";
          const guide = \`router.route({ method: 'POST', url: '/mcp', handler })\`;
          const inert = { method: 'POST', url: '/mcp', handler: 'documented only' };
          void [quoted, guide, inert];
        `,
        'src/examples.js': `
          /* router.post('/mcp', handleMcp); */
          const readme = "require('node:http').createServer(handleMcp)";
          void readme;
        `,
      },
      async (dir) => {
        const report = await reportFor(dir);
        expect(report.repository.transport).toBe('unknown');
        expect(report.repository.transportEvidence).toEqual([]);
      },
    );
  });

  it('does not turn generic web, RPC, cache, or HTTP-client code into an MCP server', async () => {
    await withTempProject(
      {
        'src/web.ts': `
          import { createServer } from 'node:http';
          declare const cache: { get(key: string, fallback: unknown): unknown };
          declare const api: { post(path: string, body: unknown): Promise<unknown> };
          const handler = () => 'fallback';
          cache.get('/mcp', handler);
          api.post('/mcp', { jsonrpc: '2.0', id: 1, method: 'math/add' });
          createServer((request, response) => {
            if (request.url !== '/rpc') return response.end();
            if ((request as any).body.method === 'math/add') response.end('ok');
          });
        `,
        'src/routes.js': `
          const fastify = { post() {}, route() {} };
          const handler = () => {};
          fastify.post('/mcpanel', handler);
          fastify.route({ method: 'POST', url: '/mcp' });
        `,
      },
      async (dir) => {
        const report = await reportFor(dir);
        expect(report.repository.transport).toBe('unknown');
        expect(report.repository.transportEvidence).toEqual([]);
        expect(report.repository.isLikelyMcpServer).toBe(false);
      },
    );
  });

  it('requires runtime Node HTTP provenance before coupling an MCP dispatch to createServer', async () => {
    await withTempProject(
      {
        'src/fake-server.ts': `
          import type { createServer as NodeCreateServer } from 'node:http';
          type Factory = typeof NodeCreateServer;
          const http = { createServer(_handler: unknown) {} };
          http.createServer((request: any) => {
            switch (request.body.method) {
              case 'tools/call': return 'not an HTTP server';
              default: return undefined;
            }
          });
          void (null as unknown as Factory);
        `,
      },
      async (dir) => {
        const report = await reportFor(dir);
        expect(report.repository.isLikelyMcpServer).toBe(true);
        expect(report.repository.transport).toBe('unknown');
        expect(report.repository.transportEvidence).toEqual([]);
      },
    );
  });
});
