import { ReadResourceRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const documents = new Map<string, string>([['doc://readme', '# Readme']]);

export function registerResources(server: {
  setRequestHandler: (schema: unknown, handler: (request: { params: { uri: string } }) => Promise<unknown>) => void;
}): void {
  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const text = documents.get(request.params.uri);
    if (!text) {
      // Resource not found, reported with the superseded MCP-specific code.
      throw { code: -32002, message: 'Resource not found', data: { uri: request.params.uri } };
    }
    return { contents: [{ uri: request.params.uri, text }] };
  });
}
