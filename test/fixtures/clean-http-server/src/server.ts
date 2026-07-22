import express from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { validateRoutingHeaders } from './headers.js';

const app = express();
app.use(express.json());

const server = new McpServer({ name: 'clean-http-server', version: '2.0.0' });

server.registerTool(
  'lookup',
  { title: 'Lookup', inputSchema: { id: z.string() } },
  async ({ id }) => ({ content: [{ type: 'text', text: `record ${id}` }] }),
);

// Stateless: no session ID is minted, so any instance can serve any request.
const transport = new StreamableHTTPServerTransport({
  sessionIdGenerator: undefined,
  enableDnsRebindingProtection: true,
  allowedHosts: ['127.0.0.1'],
});

await server.connect(transport);

app.post('/mcp', async (req, res) => {
  const problem = validateRoutingHeaders(req.headers, req.body);
  if (problem) {
    res.status(400).json({
      jsonrpc: '2.0',
      id: null,
      error: { code: -32020, message: problem },
    });
    return;
  }
  await transport.handleRequest(req, res, req.body);
});

app.listen(3000, '127.0.0.1');
