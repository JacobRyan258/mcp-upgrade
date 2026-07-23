# MCP Upgrade

Find what breaks before you upgrade your MCP server.

This repository contains two products built on one scanner:

- **`mcp-upgrade`** — a free, open-source command-line scanner and library.
  Published to npm, MIT licensed. See [`packages/scanner`](packages/scanner).
- **The hosted validator** — a web application for people who would rather not
  use a terminal. Upload a ZIP or paste a public GitHub repository, get a
  plain-English migration report.

> A clean report means that no implemented rule fired. It does not guarantee
> complete compatibility with the target MCP specification.

## Layout

```
packages/scanner     the published CLI and scanning library
packages/shared      isomorphic contracts: plans, error catalog, GitHub URL
                     validation, published-report schema, plain-English rule
                     guides, report renderers
packages/database    Postgres schema, migrations, server-only data access
apps/worker          isolated worker: ingests hostile archives, scans, publishes
apps/web             Next.js application: marketing, auth, dashboard, billing
docs/                architecture, local development, deployment
```

npm workspaces, no build orchestrator. Package build order is stated explicitly
in the root scripts, which is deterministic and adds no dependency.

## Getting started

```bash
npm install
npm run build:libs
docker compose up -d db
DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:55432/mcp_upgrade_test npm run db:migrate
npm run dev:web
```

Full instructions, including Supabase and Stripe setup, are in
[`docs/local-development.md`](docs/local-development.md).

## Verification

```bash
npm run verify          # typecheck, lint, all tests, secret scan, build
npm run verify:package  # pack the CLI and exercise it from a clean install
```

The database suite needs Postgres running; everything else needs only Node.

## Security posture

The worker treats every archive as adversarial. The properties that matter are
tested rather than asserted:

- Archive limits are enforced against bytes actually decompressed, while
  streaming — declared sizes are attacker-controlled.
- Path traversal, absolute paths, drive letters, UNC paths, symlinks, control
  characters and case collisions are refused, and the tests assert a file
  outside the destination is untouched in each case.
- Outbound requests are restricted to an allow-list of GitHub hosts, re-checked
  on every redirect hop, with DNS results validated and the connection pinned to
  a verified public address.
- Reports are rebuilt field by field from an allow-list before storage, so no
  filesystem path reaches a browser, and credential redaction runs again at the
  boundary.
- Allowance is enforced by an atomic database update; 60 concurrent submissions
  admit exactly the plan limit.

Report vulnerabilities per [`SECURITY.md`](SECURITY.md).

## Licence

MIT. See [`LICENSE`](LICENSE).
