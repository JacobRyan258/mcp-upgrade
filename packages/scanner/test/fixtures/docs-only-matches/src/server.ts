import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';

/**
 * Migration notes, kept in comments so the team remembers what changed.
 *
 * Before 2026-07-28 this server read req.headers['mcp-session-id'] and handled
 * the "initialize" method through InitializeRequestSchema. It also called
 * "tasks/list", declared a "sampling" capability, used "logging/setLevel", and
 * returned -32002 for a missing resource. All of that is gone.
 *
 * Example of the old sticky-session config we deleted:
 *   sessionAffinity: ClientIP
 *   stickySessions: true
 */

// The old error code was -32002; we now use -32602 (Invalid Params).
// We also removed the "notifications/roots/list_changed" notification.

function buildServer(): McpServer {
  return new McpServer({ name: 'docs-only-matches', version: '1.0.0' });
}

// A regex containing a double slash, which must not be mistaken for a comment
// by the comment lexer: the literal below is code, not a comment.
const HTTPS_PREFIX = /^https:\/\/[^/]+/;

export function isHttps(url: string): boolean {
  return HTTPS_PREFIX.test(url);
}

await serveStdio(buildServer);
