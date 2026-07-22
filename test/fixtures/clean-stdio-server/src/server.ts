import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

// A stdio MCP server with no session handling, no deprecated features and no
// HTTP surface. Scanning this must produce zero ERROR findings, and must not
// ask for Streamable HTTP routing headers a stdio server cannot send.
const server = new McpServer({ name: 'clean-stdio-server', version: '1.0.0' });

server.registerTool(
  'echo',
  {
    title: 'Echo',
    description: 'Returns its input unchanged.',
    inputSchema: { message: z.string() },
  },
  async ({ message }) => ({
    content: [{ type: 'text', text: message }],
  }),
);

server.registerResource(
  'readme',
  'file:///readme.md',
  { title: 'Readme', mimeType: 'text/markdown' },
  async (uri) => ({
    contents: [{ uri: uri.href, text: '# Example' }],
  }),
);

// Diagnostics go to stderr, which is the transport-appropriate channel for stdio.
process.stderr.write('clean-stdio-server starting\n');

await server.connect(new StdioServerTransport());
