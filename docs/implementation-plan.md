# MCP Upgrade Scanner — Implementation Plan

Status: **implemented** (v0.1.0). This document records the design decisions taken
before coding began, and the research that produced them.

## 1. Purpose

`mcp-upgrade` is a local, offline static analyser that scans a JavaScript or
TypeScript MCP server repository and reports what will break when the server is
migrated from MCP protocol revision `2025-11-25` to `2026-07-28`.

The `2026-07-28` specification is **not final** as of 2026-07-22. The release
candidate was locked on 2026-05-21 and the final specification is scheduled for
publication on 2026-07-28. Every rule in this tool is therefore traced to one of:

- the official RC announcement,
- the official draft changelog,
- a draft specification page, or
- a **Final** SEP.

The CLI identifies itself as an RC compatibility scanner in every output format.

## 2. Research performed (2026-07-22)

Primary sources read in full before any rule was written:

| Source | URL |
| --- | --- |
| RC announcement | https://blog.modelcontextprotocol.io/posts/2026-07-28-release-candidate/ |
| Beta SDK announcement | https://blog.modelcontextprotocol.io/posts/sdk-betas-2026-07-28/ |
| Draft changelog (authoritative) | https://modelcontextprotocol.io/specification/draft/changelog |
| Draft Streamable HTTP transport | https://modelcontextprotocol.io/specification/draft/basic/transports/streamable-http |
| Draft base protocol / error codes | https://modelcontextprotocol.io/specification/draft/basic/index |
| Draft resources | https://modelcontextprotocol.io/specification/draft/server/resources |
| Draft roots | https://modelcontextprotocol.io/specification/draft/client/roots |
| Draft sampling | https://modelcontextprotocol.io/specification/draft/client/sampling |
| Draft logging | https://modelcontextprotocol.io/specification/draft/server/utilities/logging |
| Deprecated features registry | https://modelcontextprotocol.io/specification/draft/deprecated |
| Feature lifecycle policy | https://modelcontextprotocol.io/community/feature-lifecycle |
| 2025-11-25 transports (baseline) | https://modelcontextprotocol.io/specification/2025-11-25/basic/transports |
| Extensions overview | https://modelcontextprotocol.io/extensions/overview |
| Tasks extension overview | https://modelcontextprotocol.io/extensions/tasks/overview |
| MCP Apps extension overview | https://modelcontextprotocol.io/extensions/apps/overview |
| SEP-2567 Sessionless MCP | https://modelcontextprotocol.io/seps/2567-sessionless-mcp |
| SEP-2575 Make MCP Stateless | https://modelcontextprotocol.io/seps/2575-stateless-mcp |
| SEP-2243 HTTP Header Standardization | https://modelcontextprotocol.io/seps/2243-http-standardization |
| SEP-2164 Resource Not Found Error Code | https://modelcontextprotocol.io/seps/2164-resource-not-found-error |
| SEP-2663 Tasks Extension | https://modelcontextprotocol.io/seps/2663-tasks-extension |
| SEP-1686 Tasks (legacy baseline) | https://modelcontextprotocol.io/seps/1686-tasks |
| SEP-2577 Deprecate Roots, Sampling, Logging | https://modelcontextprotocol.io/seps/2577-deprecate-roots-sampling-and-logging |
| SEP-2322 Multi Round-Trip Requests | https://modelcontextprotocol.io/seps/2322-MRTR |
| SEP-2596 Feature Lifecycle | https://modelcontextprotocol.io/seps/2596-spec-feature-lifecycle-and-deprecation |
| SEP-2133 Extensions | https://modelcontextprotocol.io/seps/2133-extensions |
| SEP-1865 MCP Apps | https://modelcontextprotocol.io/seps/1865-mcp-apps-interactive-user-interfaces-for-mcp |

### 2.1 Contradictions found and how they were resolved

SEP pages are historical records; several were written before later renumbering or
removal landed. **Authority order used: draft changelog and draft specification
pages > SEP pages > blog posts and extension overviews.**

| Question | Resolution | Evidence |
| --- | --- | --- |
| Is `logging/setLevel` deprecated or removed? | **Removed.** The *Logging feature* is separately deprecated. Both are true. | Changelog major change 5: "Remove `ping`, `logging/setLevel`, and `notifications/roots/list_changed`." |
| Is `notifications/roots/list_changed` deprecated or removed? | **Removed.** | Same changelog entry. |
| Is `roots/list` removed? | **No — deprecated, and reshaped by MRTR.** The method name survives; it is no longer a server-initiated request. | Changelog major change 7 + Deprecated 1. |
| Is `sampling/createMessage` removed? | **No — deprecated, and reshaped by MRTR.** | Same. |
| Is `tasks/list` removed? | **Removed.** | Changelog major change 6. |
| `HeaderMismatch` error code | **`-32020`**, not the `-32001` printed in the body of SEP-2243. | Changelog minor change 12; SEP-2243 "Changes since SEP became Final". |
| Does `-32002` become illegal? | **Servers MUST NOT emit it; clients SHOULD still accept it.** A producer/consumer asymmetry, not a blanket ban. | Draft resources page. |
| MCP Apps MIME type | **`text/html;profile=mcp-app`**. `text/html+skybridge` is an OpenAI Apps SDK convention with zero occurrences in MCP sources. | SEP-1865. |
| MCP Apps extension identifier | **`io.modelcontextprotocol/ui`** — `/ui`, not `/apps`. | SEP-1865, extensions overview. |
| `server/discover` | **Added**, servers MUST implement it. Not a removal. | Changelog major change 3. |
| "No features have been removed yet" (registry) vs. many removals | Both correct. The registry tracks removals *of previously-Deprecated features under SEP-2596*. The 2026-07-28 removals were pre-policy protocol redesigns. | Registry wording: "under this policy". |

### 2.2 Deliberate deviations from the original brief

The brief asked for `notifications/roots/list_changed` and `logging/setLevel` to be
classified `WARNING`. Official sources say both are **removed**, and the brief
instructs that official sources win where they conflict. They are therefore
classified `ERROR`, in dedicated rules (`MCP2026-ROOTS-002`, `MCP2026-LOGGING-002`)
kept separate from the deprecation rules so that the deprecation guidance for Roots
and Logging is still reported as `WARNING` and never described as breaking.

The brief also referenced `text/html+skybridge` and framed `server/discover` as a
removal. Both are corrected above and in `rule-matrix.md`.

## 3. Architecture

```
CLI (commander)
  └─ resolve + validate options ────────────────► UsageError → exit 2
       └─ discovery      (fast-glob, size/binary guards)
            └─ prepare   (read, line index, comment ranges via ts.Scanner / YAML lexer)
                 └─ classify (package.json, imports, transport, framework)
                      └─ engine: run rules concurrently, filter by transport +
                        │        file kind + confidence
                        └─ score + effort
                             └─ reporter (text | json | checklist)
                                  └─ exit code from --fail-on threshold
```

Any unexpected throw inside discovery/classification/rules is wrapped in
`InternalScannerError` → exit 3, keeping exit 1 exclusively for "findings reached
the failure threshold".

### 3.1 Analysis strategy

Hybrid, in four phases, exactly as specified:

1. **Discovery.** `fast-glob` over the resolved root with default ignores. Paths
   are `realpath`-resolved and re-checked to be inside the root, which rejects
   traversal through symlinks and malformed globs. Files above 1 MiB, and files
   whose first 8 KiB contain a NUL byte, are skipped and reported.
2. **Classification.** `package.json` dependencies, import specifiers and
   transport-construction sites determine SDK, transport, framework and whether
   MCP HTTP routing goes through an abstraction.
3. **Lexical detection.** Scoped regular expressions over the file content, with
   comment ranges masked out.
4. **Targeted AST detection.** The TypeScript compiler API is used only where it
   materially reduces false positives — deciding whether an error code literal is
   being *thrown* or merely *compared against*, resolving object-property paths for
   capability declarations, recognising call expressions and header member access,
   and detecting middleware that may inject headers. No type checker, no program
   construction, no whole-program semantic analysis, no evaluation.

### 3.2 Comments and documentation

Comment ranges are computed with `ts.createScanner` for TS/JS and a
quote-aware `#` lexer for YAML. Matches that fall entirely inside a comment range
are never reported; they are counted and, under `--verbose`, listed as ignored
evidence. Markdown is not a supported input type, so README examples are never
read at all.

### 3.3 Determinism

The same repository must produce the same score, the same finding order and the
same effort estimate on every run.

- Discovery output is sorted by POSIX relative path.
- Findings are sorted by `(level rank, category, ruleId, file, line, column, title)`.
- `byRule`, `deductions` and effort items are emitted from sorted key lists.
- `generatedAt` is the only non-deterministic field, and is documented as such.

### 3.4 Redaction

Every evidence excerpt passes through `redact()` before it reaches a report:
Authorization headers, bearer tokens, API-key-shaped assignments, `password`/
`secret`/`token` assignments, PEM private-key blocks, connection strings with
credentials, and long high-entropy base64/hex runs are replaced with
`[REDACTED:<kind>]`. Excerpts are then collapsed to a single line and truncated to
160 characters.

### 3.5 Scoring

Start at 100. Deduction unit is the pair `(ruleId, file)` — the first occurrence of
a rule in a file deducts, further occurrences in that file do not, though all
useful locations are still reported.

| Finding | Deduction |
| --- | --- |
| `ERROR`, high confidence | −15 |
| `ERROR`, medium or low confidence | −10 |
| `WARNING` | −5 |
| `REVIEW` | −3 |
| `INFO` | 0 |

Clamped to `[0, 100]`. A derivation string is included in both text and JSON
output, alongside an explicit statement that the score is not an official MCP
certification.

### 3.6 Effort estimation

Findings are mapped to effort categories and deduplicated before totalling. Ranges
come straight from the brief. Categories that describe a single redesign
(session/lifecycle, tasks, sampling, roots, logging) contribute their range once;
per-implementation-pattern categories (header migration, literal/config
correction, manual review) contribute once per distinct file, capped at five files
so a large repository cannot produce an absurd total. The report states that the
estimate excludes deployment, integration testing and downstream client changes.

## 4. Scope boundaries

Deliberately **not** implemented in this pass, and designed so they can be added
without breaking the `1.0` JSON schema: hosted validator, GitHub App, repository
URL scanning, live endpoint scanning, SARIF output, automated pull requests,
LLM-assisted remediation, analytics or telemetry, authentication, billing,
cross-file semantic analysis, automatic migration patches.

Known detection gaps, listed in the README under Limitations: elicitation changes
(`notifications/elicitation/complete`, `elicitationId`, `ErrorCode.UrlElicitationRequired`),
the required `ttlMs`/`cacheScope` fields on list results, the `resultType`
discriminator, MRTR migration of server-initiated requests, authorization changes,
and the SDK v1 → v2 package split.

## 5. Verification

`npm run verify` runs typecheck, lint, unit tests and build. The final validation
protocol additionally packs a tarball, installs it into a temporary project and
runs the packaged CLI against every fixture, checking each documented exit code,
JSON parseability, absence of ANSI in JSON and checklist output, and absence of
unredacted fixture secrets.
