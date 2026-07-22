/**
 * Structured logging.
 *
 * Two rules, both enforced here rather than left to call sites:
 *
 *   1. Every line is JSON on one line, keyed by job id and a safe event name.
 *   2. Every string value passes through the scanner's redaction before it is
 *      written, and absolute paths are stripped. Logs are the most common place
 *      a secret escapes, and a worker whose whole job is reading other people's
 *      source code cannot rely on call sites remembering.
 */
import { redact } from 'mcp-upgrade';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_RANK: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

let minimumLevel: LogLevel = 'info';

export function setLogLevel(level: LogLevel): void {
  minimumLevel = level;
}

/** Field names whose values are never written, whatever they contain. */
const FORBIDDEN_KEYS = new Set([
  'password', 'secret', 'token', 'authorization', 'cookie', 'key',
  'apikey', 'api_key', 'service_role_key', 'connection_string', 'database_url',
  'storage_key', 'content', 'source', 'body', 'evidence',
]);

/**
 * Replaces anything that looks like an absolute filesystem path.
 *
 * Temporary directory names encode the job layout and, on some hosts, the
 * account name. They are useful in a log we control and unacceptable anywhere
 * else, so they never enter the log line at all.
 */
function stripPaths(value: string): string {
  return value
    .replace(/\/(?:private\/)?(?:tmp|var|home|Users|root|app|workspace)\/[^\s"']*/g, '<path>')
    .replace(/[A-Za-z]:\\[^\s"']*/g, '<path>');
}

function sanitiseValue(value: unknown, depth = 0): unknown {
  if (depth > 4) return '<deep>';
  if (value === null || value === undefined) return value;
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const cleaned = stripPaths(redact(value));
    return cleaned.length > 1000 ? `${cleaned.slice(0, 1000)}…` : cleaned;
  }
  if (Array.isArray(value)) {
    return value.slice(0, 20).map((item) => sanitiseValue(item, depth + 1));
  }
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (FORBIDDEN_KEYS.has(key.toLowerCase())) {
        out[key] = '<redacted>';
        continue;
      }
      out[key] = sanitiseValue(item, depth + 1);
    }
    return out;
  }
  return '<unloggable>';
}

export interface LogFields {
  /** Correlates every line for one job. Safe to show an operator. */
  jobId?: string;
  /** A closed error category, never free text from an exception. */
  category?: string;
  [key: string]: unknown;
}

function emit(level: LogLevel, event: string, fields: LogFields = {}): void {
  if (LEVEL_RANK[level] < LEVEL_RANK[minimumLevel]) return;
  const record = {
    level,
    event,
    at: new Date().toISOString(),
    ...(sanitiseValue(fields) as Record<string, unknown>),
  };
  const line = JSON.stringify(record);
  if (level === 'error' || level === 'warn') process.stderr.write(`${line}\n`);
  else process.stdout.write(`${line}\n`);
}

export const log = {
  debug: (event: string, fields?: LogFields) => emit('debug', event, fields),
  info: (event: string, fields?: LogFields) => emit('info', event, fields),
  warn: (event: string, fields?: LogFields) => emit('warn', event, fields),
  error: (event: string, fields?: LogFields) => emit('error', event, fields),
};

/** Exposed for tests, which assert that redaction actually happens. */
export const __testing = { sanitiseValue, stripPaths };
