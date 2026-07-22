# mcp-upgrade

**Find what breaks before you upgrade your MCP server.**

`mcp-upgrade` scans a JavaScript or TypeScript MCP server and reports what will
break when you move from MCP protocol revision `2025-11-25` to `2026-07-28`.
Every finding cites the official specification page, changelog entry or SEP that
justifies it.

> ⚠️ **Release-candidate scanner.** This tool currently targets the MCP
> `2026-07-28` **release candidate**. The final specification has not yet been
> published. Rules will be revalidated against the final specification after
> publication.

## Quick start

```bash
npx mcp-upgrade scan ./my-mcp-server
```

Global install:

```bash
npm install -g mcp-upgrade
mcp-upgrade scan ./my-mcp-server
```

## Examples

```bash
# Default terminal report
mcp-upgrade scan ./my-mcp-server

# A single file
mcp-upgrade scan ./src/server.ts

# Machine-readable report
mcp-upgrade scan . --format json > mcp-migration.json

# A checklist to paste into a GitHub issue
mcp-upgrade scan . --format checklist

# Fail a build on confirmed incompatibilities
mcp-upgrade scan . --ci

# Fail on deprecations too
mcp-upgrade scan . --ci --fail-on warning

# High-confidence findings only, skipping generated code
mcp-upgrade scan . --min-confidence high --ignore "generated,*.pb.ts"

# Show which files were scanned and which rules ran
mcp-upgrade scan . --verbose
```

## Example report

```text
MCP Upgrade Scanner
Target: MCP 2026-07-28 RC  (migrating from 2025-11-25)

Repository
  Path:      ./example-server
  MCP server: yes
  Transport: streamable-http (StreamableHTTPServerTransport, MCP HTTP route)
  SDK:       @modelcontextprotocol/sdk, declared ^1.20.0
  Framework: express

Files
  Scanned:   6   Skipped: 0   Discovered: 6

ERROR — 4 findings
  Confirmed incompatibility with the target specification.

  ── stateless-lifecycle ──

  ERROR MCP2026-SESSION-001
  src/server.ts:42:17 · confidence: high
  Server reads the removed Mcp-Session-Id header

  Found:
    const sessionId = req.headers['mcp-session-id'] as string | undefined;

  Why this matters:
    Protocol-level MCP sessions are removed in MCP 2026-07-28. The Streamable
    HTTP transport no longer defines the Mcp-Session-Id header, and a server
    "SHOULD ignore it, and not mint or echo session IDs". Any routing, storage
    or authorization that depends on a protocol session will have nothing to
    key on once the server targets the new revision.

  Migration:
    Remove protocol-level session routing and serve every request
    independently. Where state must genuinely persist across calls, keep it —
    but move it behind an explicit, server-minted handle returned in a tool
    result and passed back as an ordinary tool argument. Client identity and
    capabilities are now available per request in _meta under
    io.modelcontextprotocol/clientInfo and
    io.modelcontextprotocol/clientCapabilities. Do not delete application
    state as part of this change.

  Source:
    SEP-2567 — Sessionless MCP via Explicit State Handles
    https://modelcontextprotocol.io/seps/2567-sessionless-mcp

Summary
  4 error, 0 warning, 3 review, 0 info
  Unique files requiring changes: 3

Estimated migration readiness
  55 / 100
  Started at 100. Deductions are applied once per rule per file (5 unique
  rule/file pairs): 3 × error/high = −45, 2 × review/medium = −6. 100 − 45 = 55.
  Estimated migration readiness is a heuristic produced by this tool. It is not
  an official Model Context Protocol certification, score or endorsement.

Estimated migration effort
  2.5–9 hours total
    Session and lifecycle redesign: 2–8 h (MCP2026-SESSION-001, …)
    Literal and configuration correction: 0.25–0.5 h (MCP2026-ERROR-001)
  Excludes: deployment and rollout; integration and end-to-end testing;
  downstream client changes; coordination with hosting or gateway providers.

MCP Apps readiness
  NO_SIGNAL
```

## CLI reference

```text
mcp-upgrade scan <path> [options]

Arguments:
  path                       Repository directory or individual source file

Options:
  -f, --format <format>      text | json | checklist          (default: text)
  -t, --target <version>     Target MCP specification         (default: 2026-07-28)
      --ignore <patterns>    Comma-separated glob patterns to ignore
      --include-tests        Include test and fixture directories
      --min-confidence <l>   low | medium | high              (default: low)
      --ci                   Nonzero exit code for confirmed incompatibilities
      --fail-on <level>      error | warning | review         (default: error)
      --no-color             Disable ANSI terminal formatting
      --verbose              Show files scanned and rule execution details
  -v, --version              Print CLI version
  -h, --help                 Print help
```

### Exit codes

| Code | Meaning |
| --- | --- |
| `0` | Scan completed; no finding reached the configured failure threshold. |
| `1` | Scan completed; findings reached the configured failure threshold. |
| `2` | Invalid CLI arguments or unreadable target. |
| `3` | Internal scanner failure. |

`1` is only ever used for findings. A scanner crash is always `3`, so a broken
tool can never be mistaken for a broken server.

Without `--ci`, a completed scan always exits `0` — reporting is not failing.

## Programmatic API

The scanner can be embedded without going through the CLI. The package is
ESM-native (`require()` works on Node versions that support `require(esm)`,
i.e. 20.19+ and 22.12+); types are included.

```ts
import { scanPath } from 'mcp-upgrade';

const report = await scanPath({
  path: './server',
  target: '2026-07-28',
  includeTests: false,
  minimumConfidence: 'low',
});

console.log(report.summary.counts, report.summary.readiness.score);
```

`scanPath()` returns the same `ScanReport` object the JSON format prints —
a stable, versioned contract (see `schemaVersion`). Library calls never write
to stdout, never call `process.exit`, and hold no global mutable state, so
concurrent scans in one process are safe. Invalid input throws `UsageError`;
unexpected failures throw `InternalScannerError` (both exported).

Also exported: `scan()` (report plus verbose trace), `runScan()`/`resolveOptions()`
(the lower-level pieces), the reporters (`renderTextReport`, `renderJsonReport`,
`renderChecklistReport`), `ALL_RULES`, and all report types. In server
environments, pass `cwd` explicitly so nothing depends on the process working
directory.

### Default ignored paths

```text
node_modules   .git      dist    build
coverage       .next     out     vendor
fixtures       test/fixtures
```

`--include-tests` re-enables `fixtures` and `test/fixtures` plus the test-path
heuristics (`__tests__`, `spec/`, `*.test.ts`, `*.spec.js`, …). The build-output
patterns are never re-enabled.

## Rules

### Finding levels

| Level | Meaning | Exits nonzero under `--ci`? |
| --- | --- | --- |
| **ERROR** | A confirmed incompatibility with the target specification. Your server will not behave correctly against `2026-07-28`. | Yes, at the default threshold |
| **WARNING** | A deprecated feature. **Still fully functional** during the deprecation window — a minimum of twelve months under the feature lifecycle policy. Not a breaking change. | Only with `--fail-on warning` |
| **REVIEW** | A suspicious pattern that may require migration but cannot be conclusively interpreted through static analysis. Needs a human decision. | Only with `--fail-on review` |
| **INFO** | A non-breaking modernisation or product opportunity. Also used to show where required behaviour is *already* implemented, so a clean report is legible. | Never |

The ERROR / WARNING distinction is load-bearing. Sampling, Roots and protocol
Logging are **deprecated**, not removed: this tool reports them as WARNING and
never describes them as breaking changes.

### Rule table

| Rule | Level | Confidence | What it detects | Source |
| --- | --- | --- | --- | --- |
| `MCP2026-SESSION-001` | ERROR | high | `Mcp-Session-Id` header reads and writes | [SEP-2567](https://modelcontextprotocol.io/seps/2567-sessionless-mcp) |
| `MCP2026-SESSION-002` | ERROR | high | `sessionIdGenerator`, `onsessioninitialized`, `onsessionclosed` | [SEP-2567](https://modelcontextprotocol.io/seps/2567-sessionless-mcp) |
| `MCP2026-SESSION-003` | REVIEW | medium | State keyed by an MCP session ID | [SEP-2567](https://modelcontextprotocol.io/seps/2567-sessionless-mcp) |
| `MCP2026-SESSION-004` | REVIEW | low | Sticky-session / session-affinity config | [SEP-2567](https://modelcontextprotocol.io/seps/2567-sessionless-mcp) |
| `MCP2026-LIFECYCLE-001` | ERROR | high | `initialize` / `notifications/initialized` handshake | [SEP-2575](https://modelcontextprotocol.io/seps/2575-stateless-mcp) |
| `MCP2026-LIFECYCLE-002` | ERROR | high | Removed RPCs: `ping`, `resources/subscribe`, `resources/unsubscribe` | [changelog](https://modelcontextprotocol.io/specification/draft/changelog) |
| `MCP2026-LIFECYCLE-003` | ERROR | medium | Removed GET SSE endpoint, DELETE termination, `Last-Event-ID` resumability | [Streamable HTTP](https://modelcontextprotocol.io/specification/draft/basic/transports/streamable-http) |
| `MCP2026-HEADER-001` | ERROR | medium | MCP request built without `Mcp-Method` / `Mcp-Name` | [SEP-2243](https://modelcontextprotocol.io/seps/2243-http-standardization) |
| `MCP2026-HEADER-002` | REVIEW | medium | MCP route that never validates the routing headers | [SEP-2243](https://modelcontextprotocol.io/seps/2243-http-standardization) |
| `MCP2026-HEADER-003` | INFO | high | Where the routing headers are already handled | [SEP-2243](https://modelcontextprotocol.io/seps/2243-http-standardization) |
| `MCP2026-ERROR-001` | ERROR | high | `-32002` emitted for a missing resource | [SEP-2164](https://modelcontextprotocol.io/seps/2164-resource-not-found-error) |
| `MCP2026-ERROR-002` | REVIEW | medium | Ambiguous hardcoded `-32002` | [SEP-2164](https://modelcontextprotocol.io/seps/2164-resource-not-found-error) |
| `MCP2026-TASKS-001` | ERROR | high | Removed `tasks/list` and `tasks/result` | [SEP-2663](https://modelcontextprotocol.io/seps/2663-tasks-extension) |
| `MCP2026-TASKS-002` | ERROR | high | Legacy Tasks capability negotiation, `execution.taskSupport` | [SEP-2663](https://modelcontextprotocol.io/seps/2663-tasks-extension) |
| `MCP2026-TASKS-003` | REVIEW | medium | Legacy task augmentation and lifecycle structures | [SEP-2663](https://modelcontextprotocol.io/seps/2663-tasks-extension) |
| `MCP2026-TASKS-004` | ERROR | high | Task-augmented Sampling and Elicitation | [SEP-2663](https://modelcontextprotocol.io/seps/2663-tasks-extension) |
| `MCP2026-SAMPLING-001` | WARNING | medium | Sampling capability, `sampling/createMessage`, Sampling types | [SEP-2577](https://modelcontextprotocol.io/seps/2577-deprecate-roots-sampling-and-logging) |
| `MCP2026-SAMPLING-002` | WARNING | low | Deprecated `includeContext` values | [changelog](https://modelcontextprotocol.io/specification/draft/changelog) |
| `MCP2026-ROOTS-001` | WARNING | medium | Roots capability, `roots/list`, Roots types | [SEP-2577](https://modelcontextprotocol.io/seps/2577-deprecate-roots-sampling-and-logging) |
| `MCP2026-ROOTS-002` | ERROR | high | Removed `notifications/roots/list_changed` | [SEP-2575](https://modelcontextprotocol.io/seps/2575-stateless-mcp) |
| `MCP2026-LOGGING-001` | WARNING | medium | Logging capability, `notifications/message` | [SEP-2577](https://modelcontextprotocol.io/seps/2577-deprecate-roots-sampling-and-logging) |
| `MCP2026-LOGGING-002` | ERROR | high | Removed `logging/setLevel` | [SEP-2575](https://modelcontextprotocol.io/seps/2575-stateless-mcp) |
| `MCP2026-APPS-001` | INFO | varies | MCP Apps readiness signals | [SEP-1865](https://modelcontextprotocol.io/seps/1865-mcp-apps-interactive-user-interfaces-for-mcp) |

Full traceability, including the verbatim quotes behind each rule, is in
[`docs/rule-matrix.md`](docs/rule-matrix.md).

**Note on Roots and Logging.** The Roots and Logging *features* are deprecated
and keep working. But `notifications/roots/list_changed` and `logging/setLevel`
are **removed** by the draft changelog, so they get their own ERROR rules
(`MCP2026-ROOTS-002`, `MCP2026-LOGGING-002`) kept separate from the deprecation
warnings.

## Supported inputs

**File types:** `.ts` `.tsx` `.js` `.jsx` `.mjs` `.cjs` `.json` `.yaml` `.yml`

**Transports:** `stdio`, `streamable-http`, `mixed`, `custom-http`, `unknown`.
The transport is detected first, and HTTP-only rules never run against a
stdio-only server.

Markdown is deliberately not a supported input, so README examples are never
read at all.

## Limitations and false-positive policy

This is a static analyser. It does not run your code, install your
dependencies, or follow values across files.

**Policy:** a finding is only ERROR when the evidence at a single location is
conclusive. When a wrapper, middleware or abstraction could legitimately explain
the pattern, the finding is downgraded to REVIEW rather than dropped. Matches
that appear only inside comments are never reported — they are counted and,
under `--verbose`, listed as ignored evidence (redacted like any excerpt).
Patterns that are ordinary vocabulary outside MCP (a Jest `roots` config, a
`logging` config object, an EventEmitter handling `"initialize"`, task-queue
code, a Next.js `POST` route) only fire when the repository or file shows an
MCP signal — an MCP dependency, an SDK import, MCP method literals, or similar.

> A clean report means that no implemented rule fired. It does not guarantee
> complete compatibility with the target MCP specification.

**Scan budgets.** Individual files over 1 MiB, and anything beyond 20,000 files
or 128 MiB of total content, are skipped and reported (`too-large` /
`scan-limit`) — never silently dropped. Symbolic links inside a scanned
directory are never followed. Files inside directories the scanner cannot read
are not discoverable and therefore cannot be reported as skipped. Scanning this
repository itself reports findings in the rule definitions — the scanner's own
source contains the literals it searches for.

**Known detection limits.** Capability keys built with computed property names
(`{ [cap]: {} }`) are not detected. Secrets split across string concatenations
may evade redaction — review a report before pasting it anywhere public, as
with any tool. These `2026-07-28` changes are *not* detected:

- Multi Round-Trip Requests: server-initiated requests replaced by
  `InputRequiredResult` / `inputRequests` / `inputResponses` ([SEP-2322](https://modelcontextprotocol.io/seps/2322-MRTR))
- The required `resultType` discriminator on all results
- Required `ttlMs` / `cacheScope` on list and read results ([SEP-2549](https://modelcontextprotocol.io/seps/2549-TTL-for-list-results))
- `subscriptions/listen` adoption (only the removal of what it replaces is detected)
- Removal of `notifications/elicitation/complete`, `elicitationId` and `-32042`
- Error-code renumbering `-32001`→`-32020`, `-32003`→`-32021`, `-32004`→`-32022`
- Authorization hardening (`iss` validation, `application_type`, credential binding)
- JSON Schema 2020-12 loosening for `inputSchema` / `outputSchema`
- The TypeScript SDK v1 → v2 package split
- MCP servers written in Python, Go, C#, Java, Rust or PHP

A clean report means "none of the implemented rules fired", not "your migration
is complete". Read [`docs/rule-matrix.md`](docs/rule-matrix.md) for exact coverage.

## Privacy

**All analysis is local and static.** The scanner:

- makes **no network calls** of any kind while scanning,
- **never executes** scanned code,
- **never installs** dependencies from the scanned repository,
- contains **no telemetry, analytics, authentication or remote service**,
- writes nothing outside its own stdout.

Evidence excerpts are redacted before they reach any report: API keys, access
tokens, `Authorization` headers, JWTs, PEM private keys, passwords, client
secrets and credentialed connection strings are replaced with
`[REDACTED:<kind>]`, and excerpts are collapsed to one line and truncated to
160 characters. Reports are meant to be safe to paste into a public issue — but
review one before you do, as with any tool.

## Official MCP references

- [The 2026-07-28 MCP Specification Release Candidate](https://blog.modelcontextprotocol.io/posts/2026-07-28-release-candidate/)
- [Draft specification changelog](https://modelcontextprotocol.io/specification/draft/changelog)
- [Streamable HTTP transport (draft)](https://modelcontextprotocol.io/specification/draft/basic/transports/streamable-http)
- [Deprecated features registry](https://modelcontextprotocol.io/specification/draft/deprecated)
- [Feature lifecycle and deprecation policy](https://modelcontextprotocol.io/community/feature-lifecycle)
- [Beta SDKs for the 2026-07-28 release candidate](https://blog.modelcontextprotocol.io/posts/sdk-betas-2026-07-28/)
- [MCP 2025-11-25 specification](https://modelcontextprotocol.io/specification/2025-11-25) (the baseline)
- [SEP index](https://modelcontextprotocol.io/seps)

## Roadmap

- Revalidate every rule against the **final** `2026-07-28` specification once published
- A hosted validator at [upgrade.jacobryanlive.com](https://upgrade.jacobryanlive.com)
  for non-technical users (planned; not yet live). The scanning engine in this
  package is the same one the hosted validator will run.
- Coverage for the gaps listed above, starting with MRTR and `CacheableResult`
- SARIF output for code-scanning integrations
- Autofix for the rules already marked `safe` or `suggested`
- Python MCP server support

Deliberately out of scope: telemetry, analytics, hosted scanning, live endpoint
probing, and anything that executes the code being scanned.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). In short: every rule must trace to an
official MCP specification page, changelog entry or SEP; deprecations are never
reported as breaking changes; and new rules need a fixture plus a test.

```bash
npm install
npm run verify   # typecheck + lint + test + build
```

## License

MIT — see [LICENSE](LICENSE).
