/**
 * Server-side structured logging.
 *
 * Mirrors the worker's logger: one JSON object per line, keyed by a safe event
 * name, with a fixed set of fields. Nothing derived from a request body, a
 * Stripe payload or an exception message is ever written — only closed-set
 * values such as an event type or an error category.
 */
export type Level = 'debug' | 'info' | 'warn' | 'error';

const FORBIDDEN_KEYS = new Set([
  'password', 'secret', 'token', 'authorization', 'cookie', 'key',
  'email', 'body', 'payload', 'storagekey', 'content',
]);

function scrub(fields: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (FORBIDDEN_KEYS.has(key.toLowerCase())) {
      out[key] = '<redacted>';
      continue;
    }
    if (typeof value === 'string') {
      out[key] = value.length > 300 ? `${value.slice(0, 300)}…` : value;
      continue;
    }
    if (typeof value === 'number' || typeof value === 'boolean' || value === null) {
      out[key] = value;
      continue;
    }
    if (value === undefined) continue;
    out[key] = '<object>';
  }
  return out;
}

export function logEvent(
  level: Level,
  event: string,
  fields: Record<string, unknown> = {},
): void {
  const line = JSON.stringify({
    level,
    event,
    at: new Date().toISOString(),
    ...scrub(fields),
  });
  if (level === 'error' || level === 'warn') console.error(line);
  else console.log(line);
}
