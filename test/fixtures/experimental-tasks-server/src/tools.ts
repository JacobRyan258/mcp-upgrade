/**
 * A tool declaring the legacy per-tool task support field. The 2025-11-25 shape
 * required clients to read this from tools/list before task-augmenting a call.
 */
export const longRunningTool = {
  name: 'render_report',
  description: 'Renders a large report.',
  inputSchema: { type: 'object', properties: { reportId: { type: 'string' } } },
  execution: {
    taskSupport: 'required',
  },
};

/** Requests were task-augmented by adding a `task` parameter to params. */
export function buildTaskAugmentedCall(reportId: string) {
  return {
    jsonrpc: '2.0',
    id: 7,
    method: 'tools/call',
    params: {
      name: 'render_report',
      arguments: { reportId },
      task: { ttl: 120000 },
    },
  };
}
