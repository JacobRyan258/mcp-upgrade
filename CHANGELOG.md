# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

The JSON report is a separate, versioned interface: see `schemaVersion` in the
report. Additive report fields are a minor release; changing or removing an
existing field bumps `schemaVersion`.

## [Unreleased]

## [0.1.0] — 2026-07-22

Initial release. Targets the MCP `2026-07-28` **release candidate**; rules will
be revalidated against the final specification after publication.

### Added

- `mcp-upgrade scan <path>` with `text`, `json` and `checklist` output formats.
- 23 rules across eight groups, each traceable to an official MCP specification
  page, changelog entry or SEP:
  - **Stateless lifecycle** — `MCP2026-SESSION-001`…`004`, `MCP2026-LIFECYCLE-001`…`003`
  - **Streamable HTTP headers** — `MCP2026-HEADER-001`…`003`
  - **Resource error codes** — `MCP2026-ERROR-001`, `MCP2026-ERROR-002`
  - **Tasks extension** — `MCP2026-TASKS-001`…`004`
  - **Sampling deprecation** — `MCP2026-SAMPLING-001`, `MCP2026-SAMPLING-002`
  - **Roots deprecation** — `MCP2026-ROOTS-001`, `MCP2026-ROOTS-002`
  - **Logging deprecation** — `MCP2026-LOGGING-001`, `MCP2026-LOGGING-002`
  - **MCP Apps readiness** — `MCP2026-APPS-001`
- Transport classification (`stdio`, `streamable-http`, `mixed`, `custom-http`,
  `unknown`) so HTTP-only rules never fire on a stdio-only server.
- Deterministic readiness score and effort estimate, both explained in the report.
- Secret redaction on every evidence excerpt, including comment-only match
  excerpts shown under `--verbose`. Recognised vendor prefixes include OpenAI/
  Anthropic `sk-`, Stripe `sk_live_`/`pk_live_`/`rk_live_`/`whsec_`, GitHub
  `ghp_`/`github_pat_`, GitLab `glpat-`, npm `npm_`, Slack, AWS and Google
  tokens, plus JWTs, PEM blocks, `Authorization` headers, credentialed URLs,
  and quoted or unquoted credential-shaped assignments.
- Programmatic API: `scanPath()` / `scan()` for embedding the scanner without
  the CLI, with an explicit `cwd` option for server environments.
- Ambiguous patterns are gated on MCP evidence, so generic code (Jest `roots`
  configs, `logging`/`sampling` config objects, EventEmitter `on('initialize')`,
  WebSocket `ping` handlers, task-queue vocabulary, non-MCP Next.js `POST`
  routes) is never reported in repositories or files with no MCP signal.
- Whole-scan resource budgets (20,000 files / 128 MiB) with files beyond the
  budget reported as skipped (`scan-limit`), never silently dropped.
- Deterministic reports independent of the process working directory:
  `repository.root` is the target exactly as the caller wrote it.
- Colour is TTY-aware: piped and redirected output is ANSI-free by default;
  `NO_COLOR`, `--no-color` and `FORCE_COLOR` are honoured.
- Stable exit codes: `0` clean, `1` findings, `2` usage (including a bare
  invocation), `3` internal failure.
- `docs/rule-matrix.md` mapping every rule to its official source, including the
  verbatim quotes behind each classification.

### Notes on classification

Two features are classified against the letter of the official sources rather
than their headline framing:

- The Roots and Logging *features* are deprecated (WARNING), but
  `notifications/roots/list_changed` and `logging/setLevel` are **removed** by
  the draft changelog and are reported as ERROR under their own rule IDs.
- `-32002` is only a finding where a server *emits* it. Client code that accepts
  `-32002` from an older server is correct forward-compatible behaviour and is
  never flagged.

[Unreleased]: https://github.com/JacobRyan258/mcp-upgrade/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/JacobRyan258/mcp-upgrade/releases/tag/v0.1.0
