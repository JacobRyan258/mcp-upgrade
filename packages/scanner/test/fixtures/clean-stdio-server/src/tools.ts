export interface ToolContext {
  workingDirectory: string;
}

/**
 * Directory context is supplied as an explicit parameter rather than being
 * negotiated through the protocol, which is the shape the target specification
 * recommends.
 */
export function resolveWithin(context: ToolContext, relative: string): string {
  if (relative.includes('..')) throw new Error('path escapes working directory');
  return `${context.workingDirectory}/${relative}`;
}
