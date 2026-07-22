import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  ListTasksRequestSchema,
  GetTaskRequestSchema,
  GetTaskPayloadRequestSchema,
  CancelTaskRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { taskStore } from './tasks.js';

const server = new Server(
  { name: 'experimental-tasks-server', version: '0.4.0' },
  {
    capabilities: {
      tools: {},
      tasks: {
        list: {},
        cancel: {},
        requests: {
          tools: { call: {} },
          sampling: { createMessage: {} },
        },
      },
    },
  },
);

server.setRequestHandler(ListTasksRequestSchema, async (request) => {
  const { tasks, nextCursor } = taskStore.list(request.params?.cursor);
  return { tasks, nextCursor };
});

server.setRequestHandler(GetTaskRequestSchema, async (request) => taskStore.get(request.params.taskId));

server.setRequestHandler(GetTaskPayloadRequestSchema, async (request) =>
  taskStore.result(request.params.taskId),
);

server.setRequestHandler(CancelTaskRequestSchema, async (request) =>
  taskStore.cancel(request.params.taskId),
);

await server.connect(new StdioServerTransport());
