import type { IncomingHttpHeaders } from 'node:http';

/** Methods for which the target specification requires an Mcp-Name header. */
const NAME_BEARING = new Set([
  'tools/call',
  'resources/read',
  'prompts/get',
  'tasks/get',
  'tasks/update',
  'tasks/cancel',
]);

interface JsonRpcBody {
  method?: string;
  params?: {
    name?: string;
    uri?: string;
    taskId?: string;
    _meta?: { 'io.modelcontextprotocol/protocolVersion'?: string };
  };
}

/**
 * Validates the standard MCP routing headers against the JSON-RPC body and
 * returns a problem description, or null when the request is well formed.
 * Header names are compared case-insensitively; header values are not.
 */
export function validateRoutingHeaders(
  headers: IncomingHttpHeaders,
  body: JsonRpcBody,
): string | null {
  const protocolVersion = headers['mcp-protocol-version'];
  if (typeof protocolVersion !== 'string') return 'MCP-Protocol-Version header is required';
  if (protocolVersion !== body.params?._meta?.['io.modelcontextprotocol/protocolVersion']) {
    return 'MCP-Protocol-Version does not match request metadata';
  }

  const declaredMethod = headers['mcp-method'];
  if (typeof declaredMethod !== 'string') return 'Mcp-Method header is required';
  if (body.method && declaredMethod !== body.method) {
    return 'Mcp-Method does not match the request body';
  }

  if (body.method && NAME_BEARING.has(body.method)) {
    const declaredName = headers['mcp-name'];
    if (typeof declaredName !== 'string') return 'Mcp-Name header is required';
    const expected =
      body.method === 'resources/read'
        ? body.params?.uri
        : body.method.startsWith('tasks/')
          ? body.params?.taskId
          : body.params?.name;
    if (expected && declaredName !== expected) {
      return 'Mcp-Name does not match the request body';
    }
  }

  return null;
}
