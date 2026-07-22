# mcp-upgrade

**Find what breaks before you upgrade your MCP server.**

`mcp-upgrade` scans a JavaScript or TypeScript MCP server and reports what will
break when you move from MCP protocol revision `2025-11-25` to `2026-07-28`.
Every finding cites an official specification page, changelog entry, SEP, or
official SDK migration guide that justifies the exact claim it makes.

> ⚠️ **Release-candidate scanner.** This tool currently targets the MCP
> `2026-07-28` **release candidate**. The final specification has not yet been
> published. Rules will be revalidated against the final specification after
> publication.

## Quick start

Requires Node.js `22.12.0` or newer.

> **Not yet published to npm.** `0.1.0` is prepared and validated but has not
> been released, so the `npx` and `npm install -g` commands below will not
> resolve yet. Until it is published, install from the repository:
> `npm install github:JacobRyan258/mcp-upgrade`.

```bash
npx mcp-upgrade scan ./my-mcp-server
```

Global install:

```bash
npm install -g mcp-upgrade
mcp-upgrade scan ./my-mcp-server
```

The command analyzes files locally. It does not execute the target repository,
install its dependencies, or make network requests.

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

# Fail on warnings too
mcp-upgrade scan . --ci --fail-on warning

# High-confidence findings only, skipping generated code
mcp-upgrade scan . --min-confidence high --ignore "generated,*.pb.ts"

# Show which files were scanned and which rules ran
mcp-upgrade scan . --verbose
```

## CI usage

Pin the scanner version in automation so a future release cannot change the
result without review:

```yaml
- name: Check MCP migration compatibility
  run: npx --yes mcp-upgrade@0.1.0 scan . --ci --format json > mcp-upgrade.json
```

The command exits `1` when a finding reaches the configured threshold while
still writing valid JSON. Upload `mcp-upgrade.json` as an artifact when the
report needs to be retained.

## Example report

```text
MCP Upgrade Scanner
Target: MCP 2026-07-28 RC  (migrating from 2025-11-25)
This tool targets the MCP 2026-07-28 release candidate. The final specification is not yet published; rules will be revalidated after publication.

Repository
  Path:      ./example-server
  Package:   example-server
  MCP server: yes
  Transport: streamable-http (MCP HTTP route, StreamableHTTPServerTransport)
  SDK:       @modelcontextprotocol/sdk, declared ^1.20.0
  Framework: express
  Languages: 3 TS, 0 JS, 2 JSON, 1 YAML

Files
  Scanned:   6   Skipped: 0   Discovered: 6
  Status:    complete

ERROR — 4 findings
  Confirmed incompatibility with the target specification.

  ── stateless-lifecycle ──

  ERROR MCP2026-SESSION-002
  src/server.ts:42:17 · confidence: high
  MCP transport is configured to create or track protocol sessions

  Found:
    new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID() });

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
  49 / 100
  Started at 100. Deductions are applied once per rule per file (5 unique
  rule/file pairs): 3 × error/high = −45, 2 × review/medium = −6. 100 − 51 = 49.
  Estimated migration readiness is a heuristic produced by this tool. It is not
  an official Model Context Protocol certification, score or endorsement.

Estimated migration effort
  2.25–8.5 hours total
    Session and lifecycle redesign: 2–8 h (MCP2026-SESSION-002, …)
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
      --ci                   Enable finding-threshold exit codes for CI
      --fail-on <level>      error | warning | review         (default: error)
      --no-color             Disable ANSI terminal formatting
      --verbose              Show files scanned and rule execution details
  -v, --version              Print CLI version
  -h, --help                 Print help
```

### Output formats

| Format | Contract |
| --- | --- |
| `text` | Human-readable terminal report. Color is enabled only for an interactive terminal and can be disabled with `--no-color` or `NO_COLOR`. |
| `json` | ANSI-free `ScanReport` JSON with stable `schemaVersion`, ordered findings/files, and explicit `scanStatus` / `issues` when a scan is partial. |
| `checklist` | ANSI-free plain Markdown suitable for an issue or pull request. Findings are grouped by rule. |

Machine-readable formats contain no progress text. Diagnostics go to stderr,
so stdout remains parseable even when findings cause exit code `1` under
`--ci`.

### Exit codes

| Code | Meaning |
| --- | --- |
| `0` | Scan completed; no finding reached the configured failure threshold. |
| `1` | Scan completed; findings reached the configured failure threshold. |
| `2` | Invalid CLI arguments, unreadable target, or a partial scan. |
| `3` | Internal scanner failure. |

`1` is only ever used for findings. A scanner crash is always `3`, so a broken
tool can never be mistaken for a broken server.

Without `--ci`, a complete scan always exits `0` — reporting is not failing.
A partial scan always exits `2`, while still writing the selected report format,
so automation cannot mistake incomplete coverage for compatibility. With
`--ci`, this check occurs before the finding threshold is considered.

## Programmatic API

The scanner can be embedded without going through the CLI. The package is
ESM-only and includes TypeScript declarations. Use `import`; CommonJS
`require('mcp-upgrade')` is intentionally unsupported.

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

Use `scan()` when a consumer also needs the verbose trace and comment-only
match records. `isScanReport(value)` and `assertScanReport(value)` validate JSON
at runtime before a hosted service or another process trusts it.

Every path inside `findings[]` and `files[]` is repository-relative POSIX. The
one field that echoes what the caller passed is `repository.root` — so a service
that scans an uploaded copy in a temporary directory should pass a relative
`path` with an explicit `cwd`, or overwrite `repository.root` before returning
the report, rather than exposing its own server-side directory layout. The root
package deliberately does not export rule implementations, CLI adapters,
reporters, filesystem records, or test hooks. In server environments, pass
`cwd` explicitly so relative paths do not depend on process-wide state.

### Default ignored paths

```text
node_modules   .git      dist    build
coverage       .next     out     vendor
fixtures       test/fixtures
```

`--include-tests` re-enables `fixtures` and `test/fixtures` plus the test-path
heuristics (`__tests__`, `spec/`, `*.test.ts`, `*.spec.js`, …). The build-output
patterns are never re-enabled.

Up to 32 custom ignore patterns are accepted, each at most 512 characters.
They support `*`, `**`, and `?` wildcards. Negation, bracket classes, brace
expansion, and extglobs are rejected as invalid input; this bounded dialect is
the same in the CLI and programmatic API.

## Rules

### Finding levels

| Level | Meaning | Exits nonzero under `--ci`? |
| --- | --- | --- |
| **ERROR** | A confirmed incompatibility with the target specification. Your server will not behave correctly against `2026-07-28`. | Yes, at the default threshold |
| **WARNING** | A directly detected migration risk that is material but is not a confirmed MUST-level incompatibility. This includes deprecated features and SHOULD-level transport changes. | Only with `--fail-on warning` |
| **REVIEW** | A suspicious pattern that may require migration but cannot be conclusively interpreted through static analysis. Needs a human decision. | Only with `--fail-on review` |
| **INFO** | A non-breaking modernisation or product opportunity. Also used for positive implementation signals, without asserting complete compliance. | Never |

The ERROR / WARNING distinction is load-bearing. In particular, Sampling,
Roots and protocol Logging are **deprecated**, not removed: those warnings say
the features remain functional during the minimum twelve-month deprecation
window and never describe them as breaking changes.

### Confidence

| Confidence | Meaning |
| --- | --- |
| **high** | The matched syntax and nearby context identify the protocol behavior directly. |
| **medium** | The pattern is MCP-specific, but wrappers or local abstractions may change its meaning. |
| **low** | The pattern is a useful migration lead with meaningful ambiguity; human confirmation is required. |

Confidence describes detection certainty, not impact. Use `--min-confidence`
to filter a report, but do not treat a high-confidence clean scan as complete
specification validation.

### Rule table

| Rule | Level | Confidence | What it detects | Source |
| --- | --- | --- | --- | --- |
| `MCP2026-SESSION-001` | WARNING / REVIEW | medium / low | Writes of `Mcp-Session-Id` are warnings; reads and other compatibility literals require review | [SEP-2567](https://modelcontextprotocol.io/seps/2567-sessionless-mcp) |
| `MCP2026-SESSION-002` | ERROR / REVIEW | high / medium | `sessionIdGenerator`, `onsessioninitialized`, `onsessionclosed`; legacy-only guards require review | [SEP-2567](https://modelcontextprotocol.io/seps/2567-sessionless-mcp) |
| `MCP2026-SESSION-003` | REVIEW | medium | State keyed by an MCP session ID | [SEP-2567](https://modelcontextprotocol.io/seps/2567-sessionless-mcp) |
| `MCP2026-SESSION-004` | REVIEW | low | Sticky-session / session-affinity config | [SEP-2567](https://modelcontextprotocol.io/seps/2567-sessionless-mcp) |
| `MCP2026-LIFECYCLE-001` | ERROR / REVIEW | high / medium / low | `initialize` / `notifications/initialized` handshake; guarded or ambiguous templates require review | [SEP-2575](https://modelcontextprotocol.io/seps/2575-stateless-mcp) |
| `MCP2026-LIFECYCLE-002` | ERROR / REVIEW | high / medium / low | Removed RPCs: `ping`, `resources/subscribe`, `resources/unsubscribe`; guarded or ambiguous templates require review. The retained `capabilities.resources.subscribe` declaration is REVIEW only | [changelog](https://modelcontextprotocol.io/specification/draft/changelog) |
| `MCP2026-LIFECYCLE-003` | WARNING / REVIEW | medium / low | Legacy GET SSE, DELETE termination and stream-replay mechanics; ambiguous `Last-Event-ID` / `eventStore` use requires review | [Streamable HTTP](https://modelcontextprotocol.io/specification/draft/basic/transports/streamable-http) |
| `MCP2026-SDK-001` | ERROR / REVIEW | high / medium | Proven direct legacy server/transport connections are errors; a manifest dependency alone requires review | [SDK v2 migration](https://ts.sdk.modelcontextprotocol.io/v2/migration/support-2026-07-28) |
| `MCP2026-MRTR-001` | ERROR / REVIEW | high / medium | Direct server-to-client requests that must move into MRTR; ambiguous direction or legacy guards require review | [MRTR](https://modelcontextprotocol.io/specification/draft/basic/patterns/mrtr) |
| `MCP2026-MRTR-002` | ERROR / REVIEW | high / medium | Invalid explicit `InputRequiredResult` shapes and unsupported parent methods; dynamic shapes require review | [MRTR](https://modelcontextprotocol.io/specification/draft/basic/patterns/mrtr) |
| `MCP2026-MRTR-003` | REVIEW | medium | Sensitive use of decoded `requestState` without visible integrity verification | [MRTR](https://modelcontextprotocol.io/specification/draft/basic/patterns/mrtr) |
| `MCP2026-ELICITATION-001` | ERROR / REVIEW | high / medium | Removed Elicitation completion, ID, SDK, and `-32042` surfaces; guarded or unproven uses require review | [Elicitation](https://modelcontextprotocol.io/specification/draft/client/elicitation) |
| `MCP2026-RESULT-001` | ERROR / REVIEW | high / medium | Locally linked MCP raw results missing or misspelling required `resultType`, plus malformed flattened `CreateTaskResult` shapes; dynamic or unassociated MCP-shaped results require review | [base protocol](https://modelcontextprotocol.io/specification/draft/basic/index), [SEP-2663](https://modelcontextprotocol.io/seps/2663-tasks-extension) |
| `MCP2026-META-001` | ERROR / REVIEW | high / medium | Recognized MCP raw requests missing required per-request protocol/capability metadata; dynamic params require review | [base protocol](https://modelcontextprotocol.io/specification/draft/basic/index) |
| `MCP2026-DISCOVERY-001` | REVIEW | high / medium | Stale or missing recommended server identity shape in explicit discovery results | [server discovery](https://modelcontextprotocol.io/specification/draft/server/discover) |
| `MCP2026-CACHE-001` | ERROR / REVIEW | high / medium | Raw cacheable results missing or misusing `ttlMs` / `cacheScope`; dynamic shapes require review | [caching](https://modelcontextprotocol.io/specification/draft/server/utilities/caching) |
| `MCP2026-HEADER-001` | ERROR / REVIEW | high / low | Explicitly incorrect MCP request headers are errors; wrappers and dynamic values require review | [Streamable HTTP](https://modelcontextprotocol.io/specification/draft/basic/transports/streamable-http) |
| `MCP2026-HEADER-002` | REVIEW | medium | MCP route that never validates required protocol/routing headers | [Streamable HTTP](https://modelcontextprotocol.io/specification/draft/basic/transports/streamable-http) |
| `MCP2026-HEADER-003` | INFO | high | Where target protocol/routing headers are already referenced | [Streamable HTTP](https://modelcontextprotocol.io/specification/draft/basic/transports/streamable-http) |
| `MCP2026-ERROR-001` | ERROR / REVIEW | high / medium | `-32002` emitted for a missing resource; legacy-only guards require review | [SEP-2164](https://modelcontextprotocol.io/seps/2164-resource-not-found-error) |
| `MCP2026-ERROR-002` | REVIEW | medium | Ambiguous hardcoded `-32002` | [SEP-2164](https://modelcontextprotocol.io/seps/2164-resource-not-found-error) |
| `MCP2026-ERROR-003` | ERROR / REVIEW | high / medium | Proven emission of named protocol errors using obsolete draft codes is an error; declarations require review | [base protocol](https://modelcontextprotocol.io/specification/draft/basic/index) |
| `MCP2026-TASKS-001` | ERROR / REVIEW | high / medium | Removed `tasks/list` and `tasks/result`; legacy-only guards require review | [SEP-2663](https://modelcontextprotocol.io/seps/2663-tasks-extension) |
| `MCP2026-TASKS-002` | ERROR / REVIEW | high / medium | Legacy Tasks capability negotiation and `execution.taskSupport`; legacy-only guards require review | [SEP-2663](https://modelcontextprotocol.io/seps/2663-tasks-extension) |
| `MCP2026-TASKS-003` | REVIEW | medium | Legacy task augmentation and lifecycle structures | [SEP-2663](https://modelcontextprotocol.io/seps/2663-tasks-extension) |
| `MCP2026-TASKS-004` | ERROR / REVIEW | high / medium | Task-augmented Sampling and Elicitation; legacy-only guards require review | [SEP-2663](https://modelcontextprotocol.io/seps/2663-tasks-extension) |
| `MCP2026-SAMPLING-001` | WARNING | high / medium | Sampling capability, `sampling/createMessage`, Sampling types | [SEP-2577](https://modelcontextprotocol.io/seps/2577-deprecate-roots-sampling-and-logging) |
| `MCP2026-SAMPLING-002` | WARNING | low | Deprecated `includeContext` values | [changelog](https://modelcontextprotocol.io/specification/draft/changelog) |
| `MCP2026-ROOTS-001` | WARNING | high / medium | Roots capability, `roots/list`, Roots types | [SEP-2577](https://modelcontextprotocol.io/seps/2577-deprecate-roots-sampling-and-logging) |
| `MCP2026-ROOTS-002` | ERROR / REVIEW | high / medium | Removed `notifications/roots/list_changed`; legacy-only guards require review | [SEP-2575](https://modelcontextprotocol.io/seps/2575-stateless-mcp) |
| `MCP2026-LOGGING-001` | WARNING | high / medium | Logging capability, `notifications/message` | [SEP-2577](https://modelcontextprotocol.io/seps/2577-deprecate-roots-sampling-and-logging) |
| `MCP2026-LOGGING-002` | ERROR / REVIEW | high / medium | Removed `logging/setLevel`; legacy-only guards require review | [SEP-2575](https://modelcontextprotocol.io/seps/2575-stateless-mcp) |
| `MCP2026-APPS-001` | INFO | high / low | MCP Apps readiness signals | [SEP-1865](https://modelcontextprotocol.io/seps/1865-mcp-apps-interactive-user-interfaces-for-mcp) |

Full traceability, including the official requirement or rationale behind each
rule, is in
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

> A clean report means that no implemented rule fired. It does not guarantee complete compatibility with the target MCP specification.

**Scan budgets.** Individual files over 1 MiB, and anything beyond 20,000 files
or 32 MiB of total content, are skipped and reported (`too-large` /
`scan-limit`) - never silently dropped. Before constructing TypeScript ASTs,
the scanner also enforces 250,000 lexical tokens and 100,000 lines per file,
500,000 tokens and 400,000 lines per scan, and a 256 KiB structural line limit.
Literal, template, regex, JSX-text, and comment payload is excluded from the
structural line limit. Files beyond these syntax budgets are reported as
`complexity-limit` partial-scan issues.

Directory enumeration is bounded to 100,000 entries and 64 levels. At most
25,000 candidate, directory, and detailed skip records are retained, and
relative paths beyond 2,048 characters stop discovery with a generic
`discovery-limit` issue rather than retaining the attacker-controlled name.
Symbolic links inside a scanned directory are never followed. Unreadable
directories, invalid UTF-8, depth and discovery limits, and source parser
failures are reported as explicit partial-scan issues.

Report detail is capped at 20,000 findings, 25,000 file records, and 5,000
issue records, including limit sentinels. A truncated report is `partial`.
`report-limit.count` gives the exact number of omitted file and issue details;
`finding-limit` omits a count because later rules are not run and the exact
number of unseen findings is unknowable. Verbose traces retain at most 2,000
entries and comment-only detail retains at most 1,000 entries. Summary finding
counts describe only the findings retained in the report.

Each lexical rule stops after 20,000 reportable matches or 100,000 inspected
matches across the scan, including comment-only candidates. Exhaustion records
an `analysis-limit` issue at the affected file and makes the scan `partial`;
later lexical matches for that rule may be absent.

**Known detection limits.** Capability keys built with computed property names
(`{ [cap]: {} }`) and values assembled across modules may not be resolved.
YAML is scanned lexically with quote-aware comment handling; this release does
not perform full YAML syntax validation. A scan is not a filesystem snapshot:
an in-root file modified concurrently may contribute either its earlier or
later opened contents. Every source file is read through an opened handle whose
inode is verified inside the root. Directory entries are staged until the full
root-to-directory identity chain has remained stable before, immediately after,
and throughout enumeration; staged names are discarded when it changes. Node
does not expose portable `openat`-style directory traversal, so a filesystem
that reports coarse or nonstandard identity timestamps leaves a residual
directory-replacement race. Secrets that are encoded, split, interpolated, or
constructed only at runtime can evade redaction; review a report before
publishing it. Remaining protocol-level gaps are explicit:

| Gap | Classification and reason | Impact / can a clean scan miss it? | Future approach |
| --- | --- | --- | --- |
| [Authorization hardening](https://modelcontextprotocol.io/specification/draft/basic/authorization) (`iss`, `application_type`, credential binding, DCR changes) | Not statically detectable at acceptable confidence across clients, authorization servers, deployment metadata and runtime redirects. | High security impact. **Yes.** | A dedicated authorization audit combining configuration schemas, role detection and bounded data-flow analysis. |
| [JSON Schema 2020-12 support](https://modelcontextprotocol.io/specification/draft/basic) for tool schemas | Valuable but safely deferred because the target change primarily loosens what schemas may express; existing valid object schemas remain valid. | Medium interoperability impact for custom validators. **Yes.** | Detect legacy schema validators, forced object output and unsafe external `$ref` dereferencing. |
| [`subscriptions/listen` adoption](https://modelcontextprotocol.io/specification/draft/basic/patterns/subscriptions) | Valuable but safely deferred; the scanner already reports removed subscribe/unsubscribe surfaces, but cannot prove that an application needs replacement invalidation behavior. | Medium stale-cache risk. **Yes.** | Correlate removed subscriptions, cache policy and list/read consumers across files. |
| [MRTR retry consumption](https://modelcontextprotocol.io/specification/draft/basic/patterns/mrtr) (`inputResponses` and echoed `requestState`) | Not statically detectable at acceptable confidence without correlating an initial result, client fulfillment and a later independent retry. | High functional impact. **Yes.** A server can emit a valid `input_required` result but mishandle the retry. | Add bounded cross-file data flow that associates request keys with retry parameters and server-side consumption. |
| [End-to-end Tasks semantics](https://modelcontextprotocol.io/seps/2663-tasks-extension) | Valuable but safely deferred. Rules cover removed legacy surfaces, explicit `CreateTaskResult` shapes and routing headers, but do not prove per-request capability negotiation, durable creation, authorization binding or valid status transitions. | High functional and isolation impact. **Yes.** | Add a Tasks-specific cross-file analyzer and runtime conformance tests for lifecycle and authorization invariants. |
| Dynamic custom HTTP routing | Not statically detectable at acceptable confidence when route paths, receiver names or raw request dispatch are assembled across files. Common Fastify, Hono, Koa, router and Node HTTP shapes are covered. | Medium transport-migration impact. **Yes.** HTTP-only rules may not run when the transport remains `unknown`. | Add bounded inter-file call and constant propagation while retaining conservative MCP provenance checks. |
| Python, Go, C#, Java, Rust, PHP and other non-JavaScript servers | Outside the JavaScript/TypeScript product scope. | Potentially complete migration impact. **Yes.** | Language-specific front ends that emit the same versioned `ScanReport` contract. |

**Reviewed and deliberately deferred.** These were reproduced during the
pre-release audit and judged not worth the false-positive cost right now:

| Deferred item | Why | Can a clean scan miss it? |
| --- | --- | --- |
| Explicit `capabilities.*` paths in a file with no per-file MCP signal (a standalone JSON capabilities config) | Gating these on repository-level evidence instead makes a sibling package's generic `capabilities: { roots: {} }` config borrow provenance from an MCP package next to it in a monorepo. The per-file gate is the cheaper error. | Yes, for capability declarations kept in a separate config file. |
| Legacy SDK task methods used as instance methods (`server.registerToolTask`, `client.callToolStream`) | They resolve as plain property accesses, so detecting them needs receiver-to-SDK binding resolution to stay below an acceptable false-positive rate. | Yes. |
| `z.literal('tasks/list')` in a *vendored* copy of the SDK request schemas | Covered when the schema call is recognised, but a locally renamed vendored constant is not traced to its registration. | Yes, for servers that vendored the experimental tasks schemas. |
| `res.writeHead(status, { 'Mcp-Session-Id': id })` | The header object is the second argument, which the header-access analysis does not currently treat as a header position. | Yes, for raw `node:http` servers writing the removed header this way. |
| A vendor token split across a `+` boundary *inside* its prefix (`"sk_li" + "ve_…"`) | Requires an adversarial split at exactly the prefix; normalising concatenations before redaction would change evidence text everywhere. | Not a detection gap — a redaction gap. Review a report before publishing it. |

A clean report means "none of the implemented rules fired", not "your migration
is complete". Read [`docs/rule-matrix.md`](docs/rule-matrix.md) for exact coverage.

Report a false positive, false negative, or incorrect classification with the
[false-positive issue form](https://github.com/JacobRyan258/mcp-upgrade/issues/new?template=false_positive.yml).
Remove private code and credentials from any reproduction before submitting it.

## Privacy

**All analysis is local and static.** The scanner:

- makes **no network calls** of any kind while scanning,
- **never executes** scanned code,
- **never installs** dependencies from the scanned repository,
- contains **no telemetry, analytics, authentication or remote service**,
- writes no files in the scanned repository; reports go to stdout and
  diagnostics go to stderr.

Evidence excerpts are redacted before they reach any report: API keys, access
tokens, `Authorization` headers, JWTs, PEM private keys, passwords, client
secrets and credentialed connection strings are replaced with
`[REDACTED:<kind>]`, and excerpts are collapsed to one line and truncated to
160 characters. Reports are meant to be safe to paste into a public issue — but
review one before you do, as with any tool.

## Official MCP references

- [The 2026-07-28 MCP Specification Release Candidate](https://blog.modelcontextprotocol.io/posts/2026-07-28-release-candidate/)
- [Draft specification changelog](https://modelcontextprotocol.io/specification/draft/changelog)
- [Base protocol (draft)](https://modelcontextprotocol.io/specification/draft/basic/index)
- [Streamable HTTP transport (draft)](https://modelcontextprotocol.io/specification/draft/basic/transports/streamable-http)
- [Multi Round-Trip Requests (draft)](https://modelcontextprotocol.io/specification/draft/basic/patterns/mrtr)
- [Server discovery (draft)](https://modelcontextprotocol.io/specification/draft/server/discover)
- [Caching (draft)](https://modelcontextprotocol.io/specification/draft/server/utilities/caching)
- [Elicitation (draft)](https://modelcontextprotocol.io/specification/draft/client/elicitation)
- [Deprecated features registry](https://modelcontextprotocol.io/specification/draft/deprecated)
- [Feature lifecycle and deprecation policy](https://modelcontextprotocol.io/community/feature-lifecycle)
- [Beta SDKs for the 2026-07-28 release candidate](https://blog.modelcontextprotocol.io/posts/sdk-betas-2026-07-28/)
- [TypeScript SDK v2 migration guide](https://ts.sdk.modelcontextprotocol.io/v2/migration/support-2026-07-28)
- [MCP 2025-11-25 specification](https://modelcontextprotocol.io/specification/2025-11-25) (the baseline)
- [SEP index](https://modelcontextprotocol.io/seps)

## Roadmap

- Revalidate every rule against the **final** `2026-07-28` specification once published
- A hosted validator at `upgrade.jacobryanlive.com` for non-technical users
  (planned; not yet live). The scanning engine in this
  package is the same one the hosted validator will run.
- Focused authorization, schema-validator and subscription-adoption analyzers
- SARIF output for code-scanning integrations
- Autofix for the rules already marked `safe` or `suggested`
- Python MCP server support

Deliberately out of scope for this CLI release: telemetry, analytics, hosted
scanning, live endpoint probing, and anything that executes the code being
scanned.

## Contributing

See [CONTRIBUTING.md](https://github.com/JacobRyan258/mcp-upgrade/blob/main/CONTRIBUTING.md).
In short: every rule must trace to an official MCP specification page,
changelog entry, SEP, or an official SDK guide for SDK-specific behavior;
deprecations are never reported as breaking changes; and new rules need a
fixture plus a test.

```bash
npm ci
npm run verify   # typecheck + lint + test + tracked-file secret check + build
bash scripts/verify-package.sh
```

## License

MIT — see [LICENSE](LICENSE).
