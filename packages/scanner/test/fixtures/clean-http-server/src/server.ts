import express from 'express';
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { z } from 'zod';

const app = express();
app.use(express.json());

function buildServer(): McpServer {
  const server = new McpServer({ name: 'clean-http-server', version: '2.0.0' });

  server.registerTool(
    'lookup',
    { title: 'Lookup', inputSchema: { id: z.string() } },
    async ({ id }) => ({ content: [{ type: 'text', text: `record ${id}` }] }),
  );

  return server;
}

const handler = createMcpHandler(() => buildServer());
app.all('/mcp', toNodeHandler(handler));

app.listen(3000, '127.0.0.1');
