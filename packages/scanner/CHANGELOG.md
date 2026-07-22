# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

The JSON report is a separate, versioned interface: see `schemaVersion` in the
report. Additive report fields are a minor release; changing or removing an
existing field bumps `schemaVersion`.

## Unreleased — `0.1.0`

`0.1.0` is prepared and validated but **not yet published to npm**; install from
the repository until it is released. It targets the MCP `2026-07-28` **release
candidate**, and rules will be revalidated against the final specification once
that is published. This section becomes `## [0.1.0] - <date>` at publication.

### Added

- `mcp-upgrade scan <path>` with `text`, `json` and `checklist` output formats.
- 33 rules across the migration surface, each traceable to an official MCP
  specification page, changelog entry, SEP, or official SDK migration guide:
  - **Stateless lifecycle** — `MCP2026-SESSION-001`…`004`, `MCP2026-LIFECYCLE-001`…`003`
  - **Streamable HTTP headers** — `MCP2026-HEADER-001`…`003`
  - **Resource error codes** — `MCP2026-ERROR-001`, `MCP2026-ERROR-002`
  - **Tasks extension** — `MCP2026-TASKS-001`…`004`
  - **Sampling deprecation** — `MCP2026-SAMPLING-001`, `MCP2026-SAMPLING-002`
  - **Roots deprecation** — `MCP2026-ROOTS-001`, `MCP2026-ROOTS-002`
  - **Logging deprecation** — `MCP2026-LOGGING-001`, `MCP2026-LOGGING-002`
  - **MCP Apps readiness** — `MCP2026-APPS-001`
  - **Target-era wire and SDK migration** — `MCP2026-SDK-001`,
    `MCP2026-MRTR-001`…`003`, `MCP2026-ELICITATION-001`,
    `MCP2026-RESULT-001`, `MCP2026-META-001`, `MCP2026-DISCOVERY-001`,
    `MCP2026-CACHE-001`, `MCP2026-ERROR-003`
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
- Runtime `isScanReport()` / `assertScanReport()` validation for the versioned
  JSON contract and an intentionally small, ESM-only root export surface.
- Ambiguous patterns are gated on MCP evidence, so generic code (Jest `roots`
  configs, `logging`/`sampling` config objects, EventEmitter `on('initialize')`,
  WebSocket `ping` handlers, task-queue vocabulary, non-MCP Next.js `POST`
  routes) is never reported in repositories or files with no MCP signal.
- Whole-scan resource budgets (20,000 files / 32 MiB) with files beyond the
  budget reported as skipped (`scan-limit`), never silently dropped.
- Explicit partial-scan issues for unreadable, binary, invalid UTF-8,
  over-limit, symlinked, and unparseable source files.
- Bounded report detail (20,000 findings, 25,000 file records, 5,000 total issue
  records including limit sentinels) with exact omitted file/issue counts and an
  explicit partial-scan status. Finding truncation is marked without claiming an
  exact count after later rules are skipped.
- Per-rule lexical-analysis budgets (20,000 yielded / 100,000 inspected
  matches) with exhaustion reported as an `analysis-limit` partial scan.
- Deterministic reports independent of the process working directory:
  `repository.root` preserves the caller-supplied target representation except
  that secret-shaped and control-character content is sanitized.
- Colour is TTY-aware: piped and redirected output is ANSI-free by default;
  `NO_COLOR`, `--no-color` and `FORCE_COLOR` are honoured.
- Stable exit codes: without `--ci`, complete scans exit `0`; with `--ci`, `1`
  means findings reached the configured threshold. Invalid input and all
  partial scans exit `2`; internal failures exit `3`.
- `docs/rule-matrix.md` mapping every rule to its official requirement or
  rationale, with supporting excerpts where concise.

### Fixed before release

An adversarial production-readiness audit reproduced and corrected the
following, each covered by a regression test in
`test/rules/audit-regressions.test.ts` and `test/security-hardening.test.ts`:

- **Specification correction.** `capabilities.resources.subscribe` is
  **retained** in `2026-07-28` with `subscriptions/listen` semantics — only the
  `resources/subscribe` and `resources/unsubscribe` RPCs were removed.
  `MCP2026-LIFECYCLE-002` previously reported the declaration as an ERROR and
  told users to delete it; it is now REVIEW with corrected guidance.
- **Secret redaction.** Compound credential key names (`secretAccessKey`,
  `SECRET_KEY`, `signingKey`, `sessionSecret`), lowercase hex digests, and
  base64/base64url literals containing `/` or `-` reached report evidence in
  full. Unquoted values containing `$`, `(` or `{` were skipped entirely by a
  guard meant only to skip `${…}` interpolation.
- **False positives.** Prose quoting a method name is no longer read as an
  implementation of it; unrelated `sampling`/`logging`/`roots` config keys are
  no longer capability declarations; `Map.get('mcp')` is no longer an HTTP
  route; JSON-RPC notifications no longer require request headers; nested tool
  output named `tasks` is no longer capability negotiation; outbound client
  POSTs and Next.js MCP *client* routes are no longer MCP route handlers.
- **False negatives.** Removed RPCs registered in a dispatch table
  (`{ 'logging/setLevel': fn }`), `case 'initialize':` / `case 'ping':` in
  switch dispatch, `client.sendRootsListChanged()` / `client.setLoggingLevel()`,
  requests carrying `id` as ES6 shorthand, and direct server requests through a
  binding named `mcp` are all now detected.
- **Severity accuracy.** An *emitted* legacy `protocolVersion` no longer counts
  as a legacy-era guard, so a purely legacy server no longer has every ERROR
  downgraded to REVIEW — which had let `--ci` exit `0` on exactly the servers
  the tool exists to flag. A genuine version comparison still downgrades.
- **Scan-root binding.** Discovery now re-verifies the scan root's filesystem
  identity and aborts with an explicit `root-changed` partial-scan issue if the
  root is replaced after validation or mid-walk.

### Notes on classification

Two features are classified against the letter of the official sources rather
than their headline framing:

- The Roots and Logging *features* are deprecated (WARNING), but
  `notifications/roots/list_changed` and `logging/setLevel` are **removed** by
  the draft changelog and are reported as ERROR under their own rule IDs.
- Server emission of `-32002` for resource-not-found is an error. Client code
  that visibly accepts both `-32002` and `-32602` is not flagged; accepting only
  the old code is REVIEW because it may reject a target-era server.
