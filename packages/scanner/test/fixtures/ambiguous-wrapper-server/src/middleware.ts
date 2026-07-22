import type { NextFunction, Request, Response } from 'express';

/**
 * Middleware that may or may not populate the MCP routing headers depending on
 * runtime configuration.
 */
export function attachMcpHeaders(req: Request, _res: Response, next: NextFunction): void {
  if (process.env.ATTACH_MCP_HEADERS === '1') {
    const body = req.body as { method?: string; params?: { name?: string } } | undefined;
    if (body?.method) req.headers['mcp-method'] = body.method;
    if (body?.params?.name) req.headers['mcp-name'] = body.params.name;
  }
  next();
}
