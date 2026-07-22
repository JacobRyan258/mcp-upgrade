import { describe, expect, it } from 'vitest';
import { redact } from '../../src/scanner/redaction.js';
import { findingsFor, reportFor, ruleIds, withTempProject } from '../helpers.js';

/**
 * Regressions from the production-readiness audit.
 *
 * Every case here is a defect that was reproduced against the shipped scanner:
 * false positives that failed a build on correct code, false negatives that let
 * a legacy server scan clean, and one specification misstatement. Each test
 * names the behavior it locks in rather than the fixture that produced it.
 */

const SDK_PACKAGE = '{"name":"probe","version":"1.0.0","dependencies":{"@modelcontextprotocol/sdk":"^1.20.0"}}';

describe('audit regressions — false positives', () => {
  it('does not read prose that quotes a method name as an implementation of it', async () => {
    // An exported help-text constant was treated as executable protocol use,
    // so a documentation repository with no MCP dependency reported an ERROR
    // for a removed RPC and failed its build under --ci.
    await withTempProject(
      {
        'package.json': '{"name":"docs-only","version":"1.0.0"}',
        'src/help.ts': [
          'export const SAMPLING_HELP =',
          "  'Legacy servers may still call \"sampling/createMessage\" for a completion.';",
          "export const ROOTS_HELP = 'Use \"roots/list\" only on old servers.';",
          "const NOTE = 'The \"logging/setLevel\" RPC was removed in 2026-07-28.';",
          'export function printHelp() {',
          '  console.log(SAMPLING_HELP, ROOTS_HELP, NOTE);',
          '}',
        ].join('\n'),
      },
      async (dir) => {
        const report = await reportFor(dir);
        expect(report.repository.isLikelyMcpServer).toBe(false);
        expect(report.findings).toEqual([]);
      },
    );
  });

  it('does not treat unrelated sampling/logging/roots config as capability declarations', async () => {
    // The capability-proximity gate accepted the token "mcp", which every file
    // in an MCP server carries in its import lines. An LLM wrapper's inference
    // options and app config were reported as deprecated capabilities.
    await withTempProject(
      {
        'package.json': SDK_PACKAGE,
        'src/server.ts': [
          "import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';",
          "export const server = new McpServer({ name: 'wrap', version: '1.0.0' });",
          'export const inferenceOptions = {',
          '  sampling: { temperature: 0.7, topP: 0.9, topK: 40 },',
          '  contextSize: 4096,',
          '};',
          'export const appConfig = {',
          "  logging: { level: 'info', destination: 'stderr' },",
          "  roots: ['./models', './cache'],",
          '};',
        ].join('\n'),
      },
      async (dir) => {
        const report = await reportFor(dir);
        expect(findingsFor(report, 'MCP2026-SAMPLING-001')).toEqual([]);
        expect(findingsFor(report, 'MCP2026-LOGGING-001')).toEqual([]);
        expect(findingsFor(report, 'MCP2026-ROOTS-001')).toEqual([]);
      },
    );
  });

  it('does not treat a bare "mcp" key lookup as an HTTP GET or DELETE route', async () => {
    // The route patterns constrained neither the receiver nor the path, so
    // Map and URLSearchParams lookups were reported as removed HTTP endpoints.
    await withTempProject(
      {
        'package.json': SDK_PACKAGE,
        'src/server.ts': [
          "import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';",
          'export const transport = new StreamableHTTPServerTransport({});',
        ].join('\n'),
        'src/feature-flags.ts': [
          "const flags = new Map<string, boolean>([['mcp', true]]);",
          'export function isEnabled(url: URL) {',
          "  const direct = flags.get('mcp');",
          "  const query = url.searchParams.get('mcp');",
          "  flags.delete('mcp');",
          '  return direct ?? query;',
          '}',
        ].join('\n'),
      },
      async (dir) => {
        expect(findingsFor(await reportFor(dir), 'MCP2026-LIFECYCLE-003')).toEqual([]);
      },
    );
  });

  it('does not require MCP routing headers on a JSON-RPC notification', async () => {
    // The id check matched any token ending in "id", so a notification
    // carrying an X-Request-Id tracing header was asserted to be a request
    // with invalid headers — contradicting the rule's own explanation.
    await withTempProject(
      {
        'package.json': SDK_PACKAGE,
        'src/client.ts': [
          "import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';",
          'export const t = StreamableHTTPClientTransport;',
          'export async function notify(trace: string, token: string, value: number) {',
          "  await fetch('https://example.com/mcp', {",
          "    method: 'POST',",
          "    headers: { 'Content-Type': 'application/json', 'X-Request-Id': trace },",
          '    body: JSON.stringify({',
          "      jsonrpc: '2.0',",
          "      method: 'notifications/progress',",
          '      params: { progressToken: token, progress: value },',
          '    }),',
          '  });',
          '}',
        ].join('\n'),
      },
      async (dir) => {
        expect(findingsFor(await reportFor(dir), 'MCP2026-HEADER-001')).toEqual([]);
      },
    );
  });

  it('does not treat nested tool output named tasks as capability negotiation', async () => {
    // `tasks.list` / `tasks.cancel` matched any object nesting, so a to-do
    // server returning that shape from a tool got two ERROR findings.
    await withTempProject(
      {
        'package.json': SDK_PACKAGE,
        'src/server.ts': [
          "import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';",
          "const server = new McpServer({ name: 'todo', version: '1.0.0' });",
          "const todoItems = ['write tests'];",
          'const cancelledCount = 2;',
          "server.registerTool('summary', {}, async () => {",
          '  const summary = {',
          '    tasks: {',
          '      list: todoItems,',
          '      cancel: cancelledCount,',
          '    },',
          '  };',
          '  return { structuredContent: summary, content: [] };',
          '});',
        ].join('\n'),
      },
      async (dir) => {
        expect(findingsFor(await reportFor(dir), 'MCP2026-TASKS-002')).toEqual([]);
      },
    );
  });

  it('keeps this scanner’s own rule metadata from reading as protocol behavior', async () => {
    // Guards the narrowing that lets a bound request object count as an
    // emission: a `method:` value is only live alongside a jsonrpc marker.
    await withTempProject(
      {
        'package.json': SDK_PACKAGE,
        'src/rule.ts': [
          "import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';",
          'void (null as unknown as McpServer);',
          "const removed = [{ method: 'tasks/list' }, { method: 'logging/setLevel' }];",
          "const legacy = ['execution.taskSupport', 'taskSupport'];",
          'export const rule = { removed, legacy };',
        ].join('\n'),
      },
      async (dir) => {
        const report = await reportFor(dir);
        expect(findingsFor(report, 'MCP2026-TASKS-001')).toEqual([]);
        expect(findingsFor(report, 'MCP2026-LOGGING-002')).toEqual([]);
      },
    );
  });
});

describe('audit regressions — false negatives', () => {
  it('detects removed RPCs registered in a dispatch table', async () => {
    // A quoted method used as an object KEY is how a hand-rolled JSON-RPC
    // server routes it, but object initializers were dismissed as inert data,
    // so the whole server scanned clean.
    await withTempProject(
      {
        'package.json': '{"name":"raw","version":"1.0.0"}',
        'src/server.ts': [
          'type Handler = (params: unknown) => unknown;',
          "let level = 'info';",
          'const handlers: Record<string, Handler> = {',
          "  'tools/list': () => ({ tools: [] }),",
          "  'logging/setLevel': (params) => {",
          '    level = (params as { level: string }).level;',
          '    return { level };',
          '  },',
          '};',
          'export function dispatch(method: string, params: unknown) {',
          '  return handlers[method]?.(params);',
          '}',
        ].join('\n'),
      },
      async (dir) => {
        const findings = findingsFor(await reportFor(dir), 'MCP2026-LOGGING-002');
        expect(findings).toHaveLength(1);
        expect(findings[0]?.level).toBe('error');
      },
    );
  });

  it('detects removed lifecycle methods in switch dispatch', async () => {
    // `case 'initialize':` and `case 'ping':` were skipped while other case
    // labels in the same switch fired, so a switch-dispatch server shipped
    // with a clean result for the primary removed handshake method.
    await withTempProject(
      {
        'package.json': SDK_PACKAGE,
        'src/server.ts': [
          'interface Rpc { method: string }',
          'export function dispatch(rpc: Rpc) {',
          '  switch (rpc.method) {',
          "    case 'initialize':",
          "      return { protocolVersion: '2025-11-25' };",
          "    case 'notifications/initialized':",
          '      return null;',
          "    case 'ping':",
          '      return {};',
          "    case 'resources/subscribe':",
          '      return {};',
          '    default:',
          '      return null;',
          '  }',
          '}',
        ].join('\n'),
      },
      async (dir) => {
        const report = await reportFor(dir);
        const lifecycle = findingsFor(report, 'MCP2026-LIFECYCLE-001');
        const removed = findingsFor(report, 'MCP2026-LIFECYCLE-002');
        expect(lifecycle.map((finding) => finding.title)).toContain(
          'Handling of the removed "initialize" lifecycle method',
        );
        expect(removed.map((finding) => finding.title)).toContain('Removed core RPC "ping"');
        expect([...lifecycle, ...removed].every((finding) => finding.level === 'error')).toBe(true);
      },
    );
  });

  it('detects removed SDK client methods, which never appear in an import', async () => {
    // Both surfaces were gated on an import-position check that an instance
    // method can never satisfy, so they could not fire at any call site.
    await withTempProject(
      {
        'package.json': SDK_PACKAGE,
        'src/client.ts': [
          "import { Client } from '@modelcontextprotocol/sdk/client/index.js';",
          "const client = new Client({ name: 'demo', version: '1.0.0' });",
          'export async function go() {',
          '  await client.sendRootsListChanged();',
          "  await client.setLoggingLevel('debug');",
          '}',
        ].join('\n'),
      },
      async (dir) => {
        const report = await reportFor(dir);
        expect(findingsFor(report, 'MCP2026-ROOTS-002')).toHaveLength(1);
        expect(findingsFor(report, 'MCP2026-LOGGING-002')).toHaveLength(1);
        expect(findingsFor(report, 'MCP2026-ROOTS-002')[0]?.level).toBe('error');
        expect(findingsFor(report, 'MCP2026-LOGGING-002')[0]?.level).toBe('error');
      },
    );
  });

  it('detects direct server requests when the server binding is named mcp', async () => {
    // `mcp` is the binding the SDK's own examples use, and omitting it from
    // the receiver lists meant `mcp.elicitInput(...)` produced no finding from
    // any rule at all.
    await withTempProject(
      {
        'package.json': SDK_PACKAGE,
        'src/renamed.ts': [
          "import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';",
          "const mcp = new McpServer({ name: 'b', version: '1.0.0' });",
          'export async function go() {',
          '  await mcp.listRoots();',
          '  await mcp.createMessage({ messages: [] });',
          "  await mcp.elicitInput({ message: 'Continue?' });",
          '}',
        ].join('\n'),
      },
      async (dir) => {
        const findings = findingsFor(await reportFor(dir), 'MCP2026-MRTR-001');
        expect(findings).toHaveLength(3);
        expect(findings.every((finding) => finding.level === 'error')).toBe(true);
      },
    );
  });
});

describe('audit regressions — severity and specification accuracy', () => {
  it('does not let an emitted legacy protocol version dilute findings', async () => {
    // A purely legacy server unconditionally emits protocolVersion
    // '2025-11-25' from initialize. Reading that emission as a dual-era guard
    // downgraded every ERROR in the same switch to REVIEW, so --ci exited 0 on
    // exactly the servers this tool exists to flag.
    await withTempProject(
      {
        'package.json': '{"name":"legacy","version":"1.0.0"}',
        'src/server.ts': [
          'export function dispatch(req: { method: string; id: number }) {',
          '  switch (req.method) {',
          "    case 'initialize':",
          '      return {',
          "        jsonrpc: '2.0',",
          '        id: req.id,',
          "        result: { protocolVersion: '2025-11-25', capabilities: { tasks: { list: {} } } },",
          '      };',
          "    case 'tasks/list':",
          '      return { tasks: [] };',
          '    default:',
          '      return null;',
          '  }',
          '}',
        ].join('\n'),
      },
      async (dir) => {
        const report = await reportFor(dir);
        const tasks = findingsFor(report, 'MCP2026-TASKS-001');
        expect(tasks.length).toBeGreaterThan(0);
        expect(tasks.every((finding) => finding.level === 'error')).toBe(true);
      },
    );
  });

  it('still downgrades findings inside a genuine legacy version comparison', async () => {
    await withTempProject(
      {
        'package.json': '{"name":"dual","version":"1.0.0"}',
        'src/server.ts': [
          'export function dispatch(req: { method: string; protocolVersion: string }) {',
          "  if (req.protocolVersion === '2025-11-25') {",
          "    if (req.method === 'logging/setLevel') return {};",
          '  }',
          '  return null;',
          '}',
        ].join('\n'),
      },
      async (dir) => {
        const findings = findingsFor(await reportFor(dir), 'MCP2026-LOGGING-002');
        expect(findings).toHaveLength(1);
        expect(findings[0]?.level).toBe('review');
      },
    );
  });

  it('does not call the retained resources.subscribe capability a removed RPC', async () => {
    // The draft Resources page retains this capability with subscriptions/listen
    // semantics; only the resources/subscribe and resources/unsubscribe RPCs
    // were removed. Reporting it as an ERROR told users to delete a capability
    // the target specification expects subscribing servers to declare.
    await withTempProject(
      {
        'package.json': '{"name":"target","version":"1.0.0","dependencies":{"@modelcontextprotocol/server":"^2.0.0"}}',
        'src/server.ts': [
          'export function discoverResult() {',
          '  return {',
          "    resultType: 'complete',",
          "    supportedVersions: ['2026-07-28'],",
          '    capabilities: { resources: { subscribe: true, listChanged: true } },',
          '  };',
          '}',
        ].join('\n'),
      },
      async (dir) => {
        const report = await reportFor(dir);
        const findings = findingsFor(report, 'MCP2026-LIFECYCLE-002');
        expect(findings).toHaveLength(1);
        expect(findings[0]?.level).toBe('review');
        expect(findings[0]?.title).toBe(
          'resources.subscribe capability needs subscriptions/listen backing',
        );
        // The remediation must not instruct removal of a retained capability.
        expect(findings[0]?.remediation).toContain('subscriptions/listen');
        expect(report.summary.counts.error).toBe(0);
        expect(ruleIds(report)).not.toContain('MCP2026-SESSION-002');
      },
    );
  });
});

describe('audit regressions — header rule precision', () => {
  it('detects a request that carries its id as ES6 shorthand', async () => {
    // Requiring a colon after `id` dropped the entire call site, so an
    // idiomatic request missing every routing header reported as compliant.
    await withTempProject(
      {
        'package.json': SDK_PACKAGE,
        'src/client.ts': [
          "import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';",
          'export const t = StreamableHTTPClientTransport;',
          'export async function call(id: number, name: string) {',
          "  await fetch('https://example.com/mcp', {",
          "    method: 'POST',",
          "    headers: { 'Content-Type': 'application/json' },",
          "    body: JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name } }),",
          '  });',
          '}',
        ].join('\n'),
      },
      async (dir) => {
        const findings = findingsFor(await reportFor(dir), 'MCP2026-HEADER-001');
        expect(findings).toHaveLength(1);
        expect(findings[0]?.level).toBe('error');
      },
    );
  });

  it('does not treat an outbound client POST as an MCP route handler', async () => {
    // With an unconstrained receiver, axios.post produced two contradictory
    // findings at one location: a client request AND a server route.
    await withTempProject(
      {
        'package.json':
          '{"name":"probe","version":"1.0.0","dependencies":{"@modelcontextprotocol/sdk":"^1.20.0","axios":"^1.0.0"}}',
        'src/client.ts': [
          "import axios from 'axios';",
          "import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';",
          'export const t = StreamableHTTPClientTransport;',
          'export async function send(id: number) {',
          "  await axios.post('https://api.example.com/mcp', {",
          "    jsonrpc: '2.0', id, method: 'tools/list', params: {},",
          "  }, { headers: { 'MCP-Protocol-Version': '2026-07-28', 'Mcp-Method': 'tools/list' } });",
          '}',
        ].join('\n'),
      },
      async (dir) => {
        expect(findingsFor(await reportFor(dir), 'MCP2026-HEADER-002')).toEqual([]);
      },
    );
  });

  it('does not demand route header validation from a Next.js MCP client route', async () => {
    // A route.ts that only consumes MCP as a client has an MCP signal but
    // serves no MCP endpoint.
    await withTempProject(
      {
        'package.json':
          '{"name":"probe","version":"1.0.0","dependencies":{"@modelcontextprotocol/sdk":"^1.20.0","next":"^14.0.0"}}',
        'src/app/chat/route.ts': [
          "import { Client } from '@modelcontextprotocol/sdk/client/index.js';",
          "const client = new Client({ name: 'chat', version: '1.0.0' });",
          'export async function POST(request: Request) {',
          '  const body = await request.json();',
          "  const result = await client.callTool({ name: 'search', arguments: body });",
          '  return Response.json(result);',
          '}',
        ].join('\n'),
      },
      async (dir) => {
        expect(findingsFor(await reportFor(dir), 'MCP2026-HEADER-002')).toEqual([]);
      },
    );
  });
});

describe('audit regressions — second-round fix review', () => {
  it('does not treat an inert map keyed by method names as dispatch', async () => {
    // Accepting any value for a method-shaped key made i18n label maps,
    // documentation-link maps and metric counters assert an implementation of
    // the removed RPC at ERROR/high.
    await withTempProject(
      {
        'package.json': SDK_PACKAGE,
        'src/i18n.ts': [
          "import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';",
          "export const server = new McpServer({ name: 'x', version: '1' });",
          'export const METHOD_LABELS = {',
          "  'resources/subscribe': 'Subscribe to a resource',",
          "  'tasks/list': 'List tasks',",
          "  'logging/setLevel': 'Change log level',",
          '};',
        ].join('\n'),
      },
      async (dir) => {
        const report = await reportFor(dir);
        expect(findingsFor(report, 'MCP2026-LIFECYCLE-002')).toEqual([]);
        expect(findingsFor(report, 'MCP2026-TASKS-001')).toEqual([]);
        expect(findingsFor(report, 'MCP2026-LOGGING-002')).toEqual([]);
      },
    );
  });

  it('does not read a heartbeat switch as MCP lifecycle dispatch', async () => {
    // A `switch (frame.method)` in a WebSocket handler legitimately has
    // `case 'ping':`; a method-shaped discriminant alone is not enough.
    await withTempProject(
      {
        'package.json': SDK_PACKAGE,
        'src/ws.ts': [
          "import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';",
          "export const server = new McpServer({ name: 'x', version: '1' });",
          'export function onFrame(frame: { method: string }) {',
          '  switch (frame.method) {',
          "    case 'ping':",
          "      return 'pong';",
          "    case 'close':",
          '      return null;',
          '    default:',
          '      return undefined;',
          '  }',
          '}',
        ].join('\n'),
      },
      async (dir) => {
        expect(findingsFor(await reportFor(dir), 'MCP2026-LIFECYCLE-002')).toEqual([]);
      },
    );
  });

  it('detects removed methods dispatched through an if/else chain', async () => {
    await withTempProject(
      {
        'package.json': SDK_PACKAGE,
        'src/dispatch.ts': [
          "import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';",
          "export const server = new McpServer({ name: 'x', version: '1' });",
          'export function dispatch(req: { method: string }) {',
          "  if (req.method === 'ping') return {};",
          "  if (req.method === 'initialize') return { ok: true };",
          "  if (req.method === 'logging/setLevel') return {};",
          '  return null;',
          '}',
        ].join('\n'),
      },
      async (dir) => {
        const report = await reportFor(dir);
        expect(findingsFor(report, 'MCP2026-LIFECYCLE-001')).toHaveLength(1);
        expect(findingsFor(report, 'MCP2026-LIFECYCLE-002')).toHaveLength(1);
        expect(findingsFor(report, 'MCP2026-LOGGING-002')).toHaveLength(1);
      },
    );
  });

  it('detects stream subroutes of the MCP endpoint but not unrelated subroutes', async () => {
    await withTempProject(
      {
        'package.json': SDK_PACKAGE,
        'src/server.ts': [
          "import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';",
          'export const t = new StreamableHTTPServerTransport({});',
          'declare const app: { get(p: string, h: unknown): void; delete(p: string, h: unknown): void };',
          "app.get('/mcp/sse', () => {});",
          "app.get('/api/mcp-sse', () => {});",
          "app.delete('/mcp/stream', () => {});",
          "app.get('/mcp/health', () => {});",
          "app.get('/mcpanel', () => {});",
          "app.get('/team/mcpherson', () => {});",
        ].join('\n'),
      },
      async (dir) => {
        const findings = findingsFor(await reportFor(dir), 'MCP2026-LIFECYCLE-003');
        expect(findings.map((finding) => finding.line).sort((a, b) => a - b)).toEqual([4, 5, 6]);
      },
    );
  });

  it('keeps progressToken and hash-shaped path segments out of redaction', async () => {
    // progressToken is a core MCP field, and eating a hash-shaped directory
    // name would leave a finding pointing at an unlocatable path.
    expect(redact("params: { progressToken: 'abcdefghijkl' }")).toBe(
      "params: { progressToken: 'abcdefghijkl' }",
    );
    expect(redact('src/generated/a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6/server.ts')).toBe(
      'src/generated/a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6/server.ts',
    );
    // Genuine credential compounds must still redact.
    expect(redact("authToken: 'abcdefghijkl'")).toContain('[REDACTED:');
    expect(redact("myApiKey: 'abcdefghijkl'")).toContain('[REDACTED:');
  });
});

describe('audit regressions — third-round fix review', () => {
  it('detects methods inside a JSON-RPC batch array', async () => {
    // The array guard that keeps rule tables inert must not exempt a batch of
    // fully-formed requests, which carry the same jsonrpc proof of emission.
    await withTempProject(
      {
        'package.json': SDK_PACKAGE,
        'src/batch.ts': [
          "import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';",
          "export const server = new McpServer({ name: 'x', version: '1' });",
          'const batch = [',
          "  { jsonrpc: '2.0', id: 1, method: 'resources/subscribe', params: {} },",
          "  { jsonrpc: '2.0', id: 2, method: 'logging/setLevel', params: {} },",
          '];',
          'export function go(send: (b: unknown) => void) { send(batch); }',
        ].join('\n'),
      },
      async (dir) => {
        const report = await reportFor(dir);
        expect(findingsFor(report, 'MCP2026-LIFECYCLE-002')).toHaveLength(1);
        expect(findingsFor(report, 'MCP2026-LOGGING-002')).toHaveLength(1);
      },
    );
  });

  it('detects a formatted JSON-RPC envelope shipped as a string literal', async () => {
    // The prose guard keys on whitespace, so it must not discard a literal
    // that carries JSON structure rather than a sentence.
    await withTempProject(
      {
        'package.json': SDK_PACKAGE,
        'src/ws.ts': [
          "import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';",
          "export const server = new McpServer({ name: 'x', version: '1' });",
          'declare const ws: { send(s: string): void };',
          'export function go() {',
          '  ws.send(\'{ "jsonrpc": "2.0", "id": 1, "method": "resources/subscribe" }\');',
          '}',
        ].join('\n'),
      },
      async (dir) => {
        expect(findingsFor(await reportFor(dir), 'MCP2026-LIFECYCLE-002')).toHaveLength(1);
      },
    );
  });

  it('recognises dual-era guards that do not name protocolVersion at the comparison', async () => {
    // Tightening the version clauses must not lose the idiomatic shapes: a
    // legacy-named collection membership test, and a comparison against a
    // differently named variable.
    await withTempProject(
      {
        'package.json': SDK_PACKAGE,
        'src/dual.ts': [
          "import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';",
          "export const server = new McpServer({ name: 'x', version: '1' });",
          "const LEGACY_VERSIONS = ['2025-11-25', '2025-06-18'];",
          'export function dispatch(req: { method: string }, negotiated: string) {',
          '  if (LEGACY_VERSIONS.includes(negotiated)) {',
          "    if (req.method === 'logging/setLevel') return {};",
          '  }',
          "  if (negotiated === '2025-11-25') {",
          "    if (req.method === 'tasks/list') return { tasks: [] };",
          '  }',
          '  return null;',
          '}',
        ].join('\n'),
      },
      async (dir) => {
        const report = await reportFor(dir);
        const findings = [
          ...findingsFor(report, 'MCP2026-LOGGING-002'),
          ...findingsFor(report, 'MCP2026-TASKS-001'),
        ];
        expect(findings.length).toBeGreaterThanOrEqual(2);
        expect(findings.every((finding) => finding.level === 'review')).toBe(true);
      },
    );
  });
});

describe('audit regressions — cross-platform report paths', () => {
  it('preserves a Windows drive letter in reported paths', async () => {
    // The drive-letter colon was percent-escaped, so every Windows user saw
    // `C%3A/proj` in the one field documented to echo what they passed. Asserted
    // directly against the sanitizer so the case is covered on every platform.
    const { sanitizeReportPathBase: sanitizeReportPath } = await import(
      '../../src/scanner/engine.js'
    );
    expect(sanitizeReportPath('C:/Users/dev/proj')).toBe('C:/Users/dev/proj');
    expect(sanitizeReportPath('D:/a/mcp-upgrade/src/server.ts')).toBe(
      'D:/a/mcp-upgrade/src/server.ts',
    );
    // Control characters and literal backslashes are still escaped.
    expect(sanitizeReportPath('bad\u001bname.ts')).toBe('bad%1Bname.ts');
    expect(sanitizeReportPath('lit\\eral.ts')).toBe('lit%5Ceral.ts');
  });
});
