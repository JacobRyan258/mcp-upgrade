import { server } from './server.js';

/**
 * Uses the client's roots to decide which directories may be read. Note the
 * safeguard below is a real security control and must survive the migration.
 */
export async function allowedDirectories(): Promise<string[]> {
  const result = await server.listRoots();
  return result.roots
    .filter((root) => root.uri.startsWith('file://'))
    .map((root) => decodeURIComponent(root.uri.slice('file://'.length)));
}

export function isPathAllowed(candidate: string, allowed: string[]): boolean {
  const normalized = candidate.replace(/\/+$/, '');
  return allowed.some((dir) => normalized === dir || normalized.startsWith(`${dir}/`));
}
