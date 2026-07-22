import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { SetLevelRequestSchema } from '@modelcontextprotocol/sdk/types.js';

// Declares every feature deprecated by SEP-2577. None of these is a breaking
// change on its own; logging/setLevel below is the one genuine removal.
const server = new Server(
  { name: 'deprecated-features-server', version: '1.4.0' },
  {
    capabilities: {
      tools: {},
      logging: {},
      sampling: {},
      roots: { listChanged: true },
    },
  },
);

let currentLevel = 'info';

server.setRequestHandler(SetLevelRequestSchema, async (request) => {
  currentLevel = request.params.level;
  return {};
});

export async function log(message: string): Promise<void> {
  await server.sendLoggingMessage({ level: 'info', data: { message, currentLevel } });
}

await server.connect(new StdioServerTransport());
export { server };
