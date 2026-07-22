import axios from 'axios';

/**
 * A shared client. Whether MCP routing headers are attached here, in the
 * interceptor below, or not at all cannot be settled without following values
 * across modules — so a scanner should ask for review rather than assert a break.
 */
export const mcpClient = axios.create({
  baseURL: process.env.MCP_ENDPOINT,
  headers: {
    'Content-Type': 'application/json',
  },
});

mcpClient.interceptors.request.use((config) => {
  config.headers.set('MCP-Protocol-Version', '2026-07-28');
  return config;
});

/** Sends a tool call without naming the routing headers at this call site. */
export async function callTool(name: string, args: unknown) {
  return mcpClient.post('/mcp', {
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name, arguments: args },
  });
}
