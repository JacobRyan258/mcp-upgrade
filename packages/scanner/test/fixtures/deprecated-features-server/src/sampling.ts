import type { CreateMessageResult, SamplingMessage } from '@modelcontextprotocol/sdk/types.js';
import { server } from './server.js';

/** Asks the client's model to summarise text through MCP Sampling. */
export async function summarize(text: string): Promise<string> {
  const messages: SamplingMessage[] = [
    { role: 'user', content: { type: 'text', text: `Summarise:\n${text}` } },
  ];

  const result: CreateMessageResult = await server.createMessage({
    messages,
    maxTokens: 512,
    includeContext: 'thisServer',
    modelPreferences: { intelligencePriority: 0.8 },
  });

  return result.content.type === 'text' ? result.content.text : '';
}
