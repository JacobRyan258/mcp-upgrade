import { randomUUID } from 'node:crypto';
import express from 'express';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  InitializeRequestSchema,
  InitializedNotificationSchema,
  PingRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { sessionStore } from './sessions.js';

const app = express();
app.use(express.json());

const transports = new Map<string, StreamableHTTPServerTransport>();

const server = new Server(
  { name: 'legacy-session-server', version: '0.9.0' },
  { capabilities: { tools: {}, resources: { subscribe: true } } },
);

server.setRequestHandler(InitializeRequestSchema, async (request) => {
  const clientInfo = request.params.clientInfo;
  sessionStore.rememberClient(clientInfo.name);
  return {
    protocolVersion: '2025-11-25',
    capabilities: { tools: {} },
    serverInfo: { name: 'legacy-session-server', version: '0.9.0' },
  };
});

server.setNotificationHandler(InitializedNotificationSchema, async () => {
  sessionStore.markReady();
});

server.setRequestHandler(PingRequestSchema, async () => ({}));

app.post('/mcp', async (req, res) => {
  const sessionId = req.headers['mcp-session-id'] as string | undefined;
  let transport = sessionId ? transports.get(sessionId) : undefined;

  if (!transport) {
    transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => {
        transports.set(id, transport!);
        sessionStore.create(id);
      },
      onsessionclosed: (id) => {
        transports.delete(id);
        sessionStore.destroy(id);
      },
    });
    await server.connect(transport);
  }

  res.setHeader('Mcp-Session-Id', transport.sessionId ?? '');
  await transport.handleRequest(req, res, req.body);
});

// Legacy standalone SSE stream and session-termination verb.
app.get('/mcp', async (req, res) => {
  const sessionId = req.headers['mcp-session-id'] as string;
  const transport = transports.get(sessionId);
  await transport?.handleRequest(req, res);
});

app.delete('/mcp', async (req, res) => {
  const sessionId = req.headers['mcp-session-id'] as string;
  transports.delete(sessionId);
  sessionStore.destroy(sessionId);
  res.status(204).end();
});

app.listen(8080);
