import type { IncomingHttpHeaders } from 'node:http';

/** Methods for which the target specification requires an Mcp-Name header. */
const NAME_BEARING = new Set(['tools/call', 'resources/read', 'prompts/get']);

interface JsonRpcBody {
  method?: string;
  params?: { name?: string; uri?: string };
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
  const declaredMethod = headers['mcp-method'];
  if (typeof declaredMethod !== 'string') return 'Mcp-Method header is required';
  if (body.method && declaredMethod !== body.method) {
    return 'Mcp-Method does not match the request body';
  }

  if (body.method && NAME_BEARING.has(body.method)) {
    const declaredName = headers['mcp-name'];
    if (typeof declaredName !== 'string') return 'Mcp-Name header is required';
    const expected = body.method === 'resources/read' ? body.params?.uri : body.params?.name;
    if (expected && declaredName !== expected) {
      return 'Mcp-Name does not match the request body';
    }
  }

  return null;
}
