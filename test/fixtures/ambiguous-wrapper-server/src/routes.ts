import express from 'express';
import { attachMcpHeaders } from './middleware.js';

const app = express();
app.use(express.json());
app.use(attachMcpHeaders);

// The body is parsed by a downstream handler, so whether this route is the
// place to validate headers is not decidable from here.
app.post('/mcp', async (req, res) => {
  const forwarded = await fetch(process.env.UPSTREAM_MCP_URL!, {
    method: 'POST',
    body: JSON.stringify(req.body),
  });
  res.status(forwarded.status).send(await forwarded.text());
});

export { app };
