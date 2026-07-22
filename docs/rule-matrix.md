# Rule Matrix

Every rule implemented by `mcp-upgrade`, mapped to the official Model Context
Protocol source that justifies it.

**Target:** MCP `2026-07-28` (release candidate — final specification not yet
published as of 2026-07-22).
**Baseline:** MCP `2025-11-25`.

Classification vocabulary:

- **ERROR** — confirmed incompatibility with the target specification.
- **WARNING** — deprecated or strongly discouraged, still fully functional during
  the deprecation window. Never described as breaking.
- **REVIEW** — may require migration, not conclusively decidable by static analysis.
- **INFO** — non-breaking modernisation or product opportunity.

Autofix column records whether a future automated fix could be safe. No autofix is
implemented in this release.

**MCP-context gating.** Patterns that are ordinary vocabulary outside MCP —
`tasks/list` as a REST path, a `logging` config key, an EventEmitter handling
`"initialize"`, `listRoots()` as a filesystem helper, a Next.js `POST` export —
only produce findings when the repository or the specific file shows an MCP
signal (an MCP dependency, SDK import, MCP method literal, or JSON-RPC
vocabulary). Unambiguous MCP-specific literals (`mcp-session-id`,
`notifications/roots/list_changed`, `logging/setLevel`, `sessionIdGenerator`)
are always reported. Protocol literals inside multi-line template strings are
downgraded to REVIEW: such strings are usually documentation or generated
text, not protocol code.

---

## Group 1 — Stateless lifecycle migration

| Rule ID | Level | Confidence | Detects | Official source | Autofix |
| --- | --- | --- | --- | --- | --- |
| `MCP2026-SESSION-001` | ERROR | high | Reads/writes of the `Mcp-Session-Id` HTTP header (any casing), including `req.headers['mcp-session-id']`, `res.setHeader('Mcp-Session-Id', …)` and `headers.get('mcp-session-id')` | [Streamable HTTP (draft)](https://modelcontextprotocol.io/specification/draft/basic/transports/streamable-http) · [SEP-2567](https://modelcontextprotocol.io/seps/2567-sessionless-mcp) | manual |
| `MCP2026-SESSION-002` | ERROR | high | MCP transport constructor options that create or track protocol sessions: `sessionIdGenerator`, `onsessioninitialized`, `onsessionclosed` | [SEP-2567](https://modelcontextprotocol.io/seps/2567-sessionless-mcp) | suggested |
| `MCP2026-SESSION-003` | REVIEW | medium | Session-keyed transport/state maps near MCP code — `Map<string, StreamableHTTPServerTransport>`, `transports[sessionId]`, `sessions[sessionId]` | [SEP-2567](https://modelcontextprotocol.io/seps/2567-sessionless-mcp) | manual |
| `MCP2026-SESSION-004` | REVIEW | low | Sticky-session / session-affinity infrastructure config in JSON or YAML — `sessionAffinity`, `stickySessions`, `ip_hash`, affinity ingress annotations | [SEP-2567](https://modelcontextprotocol.io/seps/2567-sessionless-mcp) · [RC announcement](https://blog.modelcontextprotocol.io/posts/2026-07-28-release-candidate/) | manual |
| `MCP2026-LIFECYCLE-001` | ERROR | high | The removed initialization handshake: `initialize` / `notifications/initialized` handled as MCP lifecycle methods, `InitializeRequestSchema`, `InitializedNotificationSchema` | [SEP-2575](https://modelcontextprotocol.io/seps/2575-stateless-mcp) · [changelog](https://modelcontextprotocol.io/specification/draft/changelog) | manual |
| `MCP2026-LIFECYCLE-002` | ERROR | high | Core RPCs removed in the target: `ping`, `resources/subscribe`, `resources/unsubscribe`, their SDK schema constants, and the `capabilities.resources.subscribe` declaration that advertised them | [SEP-2575](https://modelcontextprotocol.io/seps/2575-stateless-mcp) · [changelog](https://modelcontextprotocol.io/specification/draft/changelog) | manual |
| `MCP2026-LIFECYCLE-003` | ERROR | medium | Removed Streamable HTTP mechanics: the standalone GET SSE endpoint, HTTP DELETE session termination, and `Last-Event-ID` / `eventStore` stream resumability | [Streamable HTTP (draft)](https://modelcontextprotocol.io/specification/draft/basic/transports/streamable-http) · [SEP-2575](https://modelcontextprotocol.io/seps/2575-stateless-mcp) | manual |

**Guidance these rules emit.** Protocol-level sessions and the initialization
handshake are removed in `2026-07-28`. Requests become self-contained: the protocol
version, client info and client capabilities travel in `_meta` on every request
(`io.modelcontextprotocol/protocolVersion`, `io.modelcontextprotocol/clientInfo`,
`io.modelcontextprotocol/clientCapabilities`), and servers MUST implement
`server/discover`. Where application-level state must persist across calls, mint an
explicit server-side handle and pass it as an ordinary tool argument — SEP-2567 is
explicit that handles are not a protocol construct. The rules never recommend
deleting business state.

Supporting quotes:

> "Revision 2026-07-28 changed the behavior of Streamable HTTP. … Removal of the
> GET stream endpoint. Removal of protocol-level sessions."
> — draft Streamable HTTP

> "An `Mcp-Session-Id` header on a request: ignore it, and do not mint or echo
> session IDs." — draft Streamable HTTP

> "Make MCP stateless: remove the `initialize`/`notifications/initialized`
> handshake." — draft changelog, major change 2

> "Remove `ping`, `logging/setLevel`, and `notifications/roots/list_changed`."
> — draft changelog, major change 5

> "Replace the HTTP GET endpoint and `resources/subscribe`/`resources/unsubscribe`
> with `subscriptions/listen`." — draft changelog, major change 4

---

## Group 2 — Streamable HTTP request headers

Applies only when the repository's transport classifies as `streamable-http`,
`mixed` or `custom-http`. A stdio-only repository never receives a finding from
this group.

| Rule ID | Level | Confidence | Detects | Official source | Autofix |
| --- | --- | --- | --- | --- | --- |
| `MCP2026-HEADER-001` | ERROR | medium | Explicit MCP request construction (`fetch`/`axios`/`got` POST of a JSON-RPC MCP body) that omits `Mcp-Method`, where the method and the tool/resource/prompt name are both available at the call site. Downgraded to `REVIEW` when a middleware or header-injecting wrapper is detected in the repository. | [SEP-2243](https://modelcontextprotocol.io/seps/2243-http-standardization) · [Streamable HTTP (draft)](https://modelcontextprotocol.io/specification/draft/basic/transports/streamable-http) | suggested |
| `MCP2026-HEADER-002` | REVIEW | medium | An MCP POST route handler that never reads or validates `Mcp-Method` / `Mcp-Name`, so header/body disagreement cannot be rejected | [SEP-2243](https://modelcontextprotocol.io/seps/2243-http-standardization) | manual |
| `MCP2026-HEADER-003` | INFO | high | Places where `Mcp-Method` / `Mcp-Name` are already set or validated — reported so a passing repository can be understood | [SEP-2243](https://modelcontextprotocol.io/seps/2243-http-standardization) | none |

Supporting quotes:

> "| `Mcp-Method` | `method` | All requests | … | `Mcp-Name` | `params.name` or
> `params.uri` | `tools/call`, `resources/read`, `prompts/get` requests |" …
> "These headers are **REQUIRED** for compliance." — draft Streamable HTTP

> "Servers that process the request body MUST reject requests where the values
> specified in the headers do not match the values in the request body."
> — SEP-2243

> "Servers **MUST** reject requests with a `400 Bad Request` HTTP status and
> JSON-RPC error code `-32020` (`HeaderMismatch`) if any validation fails."
> — draft Streamable HTTP

The stdio exemption is definitional rather than quoted: SEP-2243 and the draft
transport page impose the standard-header requirement on *Streamable HTTP POST
requests* ("The Streamable HTTP transport will require POST requests to include
the following headers…"), and a stdio server has no HTTP request to carry a
header. That is why this whole group is gated on the transport classification.

Note: `HeaderMismatch` is `-32020`. The `-32001` printed in the body of SEP-2243 is
stale — the SEP's own "Changes since SEP became Final" section records the
reassignment, and `-32001` additionally collides with `ErrorCode.RequestTimeout` in
the TypeScript SDK.

---

## Group 3 — Resource error-code migration

| Rule ID | Level | Confidence | Detects | Official source | Autofix |
| --- | --- | --- | --- | --- | --- |
| `MCP2026-ERROR-001` | ERROR | high | `-32002` **emitted** as a resource-not-found error — a throw/return/reject position with resource context nearby (`resources/read`, `uri`, `resource not found`, `ReadResourceRequestSchema`) | [SEP-2164](https://modelcontextprotocol.io/seps/2164-resource-not-found-error) · [Resources (draft)](https://modelcontextprotocol.io/specification/draft/server/resources) | suggested |
| `MCP2026-ERROR-002` | REVIEW | medium | A hardcoded `-32002` whose purpose cannot be determined from context | [SEP-2164](https://modelcontextprotocol.io/seps/2164-resource-not-found-error) | manual |

Not flagged, deliberately:

- **Client-side acceptance** of `-32002` (a comparison such as `err.code === -32002`
  or a `case -32002:`) is correct forward-compatible behaviour and produces no
  finding. The change is a producer/consumer asymmetry. Acceptance *lists*
  (`[-32002, -32602].includes(code)`) and occurrences flowing through helpers
  the scanner cannot classify are reported by `MCP2026-ERROR-002` as REVIEW,
  never asserted as an emission.
- Any other valid JSON-RPC error code (`-32700`, `-32600`, `-32601`, `-32602`,
  `-32603`, or implementation-defined `-32000`…`-32019`).

Supporting quotes:

> "If the requested resource does not exist, servers **MUST** return a JSON-RPC
> error with code `-32602` (Invalid Params)" — SEP-2164

> "For backwards compatibility, clients **SHOULD** also accept `-32002` as a
> resource not found error, as earlier protocol versions used this code."
> — draft Resources

> "Change resource not found error code from `-32002` to `-32602` (Invalid Params)
> to align with JSON-RPC specification." — draft changelog, minor change 6

> "`-32000` to `-32019` remains implementation-defined (existing SDK usage is
> grandfathered)" — draft changelog, minor change 12

---

## Group 4 — Tasks extension migration

| Rule ID | Level | Confidence | Detects | Official source | Autofix |
| --- | --- | --- | --- | --- | --- |
| `MCP2026-TASKS-001` | ERROR | high | Removed task RPCs: `tasks/list`, `tasks/result`, plus `ListTasksRequestSchema` / `GetTaskPayloadRequestSchema` | [SEP-2663](https://modelcontextprotocol.io/seps/2663-tasks-extension) · [changelog](https://modelcontextprotocol.io/specification/draft/changelog) | manual |
| `MCP2026-TASKS-002` | ERROR | high | Legacy Tasks capability negotiation: `capabilities.tasks`, `tasks.requests.*`, `tasks.list`, `tasks.cancel`, `experimental.tasks`, and the tool-level `execution.taskSupport` field | [SEP-2663](https://modelcontextprotocol.io/seps/2663-tasks-extension) | manual |
| `MCP2026-TASKS-003` | REVIEW | medium | Legacy task augmentation and lifecycle structures: the per-request `task` param, `io.modelcontextprotocol/related-task`, `modelcontextprotocol.io/task`, `notifications/tasks/status`, the renamed `pollInterval`/`ttl` fields, `TaskStore` / `InMemoryTaskStore` / `registerToolTask` / `TaskRequestHandlerExtra`. `statusMessage` and `lastUpdatedAt` are deliberately **not** flagged — SEP-2663 carries both forward unchanged. | [SEP-2663](https://modelcontextprotocol.io/seps/2663-tasks-extension) · [SEP-1686](https://modelcontextprotocol.io/seps/1686-tasks) | manual |
| `MCP2026-TASKS-004` | ERROR | high | Task-augmented Sampling and Elicitation: `tasks.requests.sampling.createMessage`, `tasks.requests.elicitation.create`, `createMessageStream`, `elicitInputStream` | [SEP-2663](https://modelcontextprotocol.io/seps/2663-tasks-extension) · [SEP-2260](https://modelcontextprotocol.io/seps/2260-Require-Server-requests-to-be-associated-with-Client-requests) | manual |

**Guidance these rules emit.** Tasks move from an experimental core feature to an
official extension identified by `io.modelcontextprotocol/tasks`. The client
advertises the extension per request inside
`_meta['io.modelcontextprotocol/clientCapabilities'].extensions`; the server
advertises it under `capabilities.extensions` in its `server/discover` result, and
the server alone decides whether a `tools/call` becomes a task. `tasks/list` is
removed because its authorization scope could not be defined once sessions were
removed. `tasks/result` is replaced by polling `tasks/get`, with a new
`tasks/update` carrying `inputResponses`. The old and new surfaces are not
wire-compatible, so migration requires semantic review — no rule in this group is
ever marked safe for automatic rewriting.

Supporting quotes:

> "Move experimental tasks out of the core protocol and into an official extension
> (`io.modelcontextprotocol/tasks`). The redesigned extension replaces the blocking
> `tasks/result` method with polling via `tasks/get` and a new `tasks/update` for
> client-to-server input, removes `tasks/list`, and allows servers to return task
> handles unsolicited without per-request opt-in." — draft changelog, major change 6

> "Because there is no `tasks/list`…" — SEP-2663

> "The server is the sole decider; clients do not signal task preference on the
> request itself" — SEP-2663

---

## Group 5 — Sampling deprecation

| Rule ID | Level | Confidence | Detects | Official source | Autofix |
| --- | --- | --- | --- | --- | --- |
| `MCP2026-SAMPLING-001` | WARNING | medium | The `sampling` client capability, `sampling/createMessage`, `CreateMessageRequestSchema`, `server.createMessage(…)`, `requestSampling(…)`, and Sampling schema types (`CreateMessageResult`, `SamplingMessage`, `ModelPreferences`) | [SEP-2577](https://modelcontextprotocol.io/seps/2577-deprecate-roots-sampling-and-logging) · [Sampling (draft)](https://modelcontextprotocol.io/specification/draft/client/sampling) | manual |
| `MCP2026-SAMPLING-002` | WARNING | low | The deprecated `includeContext` values `"thisServer"` and `"allServers"` | [SEP-2596](https://modelcontextprotocol.io/seps/2596-spec-feature-lifecycle-and-deprecation) · [changelog](https://modelcontextprotocol.io/specification/draft/changelog) | suggested |

**Guidance these rules emit.** Sampling is deprecated as of `2026-07-28`, not
removed. It remains fully functional for a minimum twelve-month window; the
deprecated-features registry records the earliest removal as the first revision
released on or after 2027-07-28. New implementations should not add Sampling.
Existing servers should plan migration to direct integration with an LLM provider
API — which means the server now holds provider credentials, so the guidance calls
out the resulting key-management, cost-control and prompt-injection exposure that
MCP Sampling previously kept on the client side. Separately, server-initiated
Sampling requests are reshaped by Multi Round-Trip Requests: a server returns an
`InputRequiredResult` rather than issuing a request on a stream.

Supporting quotes:

> "Deprecate the Roots, Sampling, and Logging features … These features remain
> fully functional during the deprecation window but new implementations should not
> add support for them. Suggested migrations: … integrate directly with LLM
> provider APIs instead of Sampling" — draft changelog, Deprecated 1

> "The Sampling feature is deprecated as of protocol version `2026-07-28`
> (SEP-2577)." — draft Sampling

> "Reclassify the `includeContext` values `"thisServer"` and `"allServers"` … as
> Deprecated" — draft changelog, Deprecated 3

---

## Group 6 — Roots deprecation

| Rule ID | Level | Confidence | Detects | Official source | Autofix |
| --- | --- | --- | --- | --- | --- |
| `MCP2026-ROOTS-001` | WARNING | medium | The `roots` client capability, `roots/list`, `ListRootsRequestSchema`, `server.listRoots(…)`, and Roots schema types (`ListRootsResult`, `RootsCapability`) | [SEP-2577](https://modelcontextprotocol.io/seps/2577-deprecate-roots-sampling-and-logging) · [Roots (draft)](https://modelcontextprotocol.io/specification/draft/client/roots) | manual |
| `MCP2026-ROOTS-002` | ERROR | high | `notifications/roots/list_changed`, `RootsListChangedNotificationSchema`, `sendRootsListChanged(…)` — **removed**, not merely deprecated | [SEP-2575](https://modelcontextprotocol.io/seps/2575-stateless-mcp) · [changelog](https://modelcontextprotocol.io/specification/draft/changelog) | manual |

**Guidance these rules emit.** Roots remains functional during the deprecation
window. Prefer explicit tool parameters, resource URIs, server configuration or
environment configuration for working-directory and filesystem context. The
guidance states plainly that Roots is not an access-control mechanism and never
suggests removing filesystem safeguards; sandboxing and path validation must stay
in place regardless of how the directory list is supplied.

Supporting quotes:

> "pass directories or files via tool parameters, resource URIs, or server
> configuration instead of Roots" — draft changelog, Deprecated 1

> "`notifications/roots/list_changed`: Removed. Roots are fetched on demand via
> MRTR, so there is no need for a change notification." — SEP-2575

---

## Group 7 — Protocol logging deprecation

| Rule ID | Level | Confidence | Detects | Official source | Autofix |
| --- | --- | --- | --- | --- | --- |
| `MCP2026-LOGGING-001` | WARNING | medium | The `logging` server capability, `notifications/message`, `sendLoggingMessage(…)`, `LoggingMessageNotificationSchema`, `LoggingLevel` | [SEP-2577](https://modelcontextprotocol.io/seps/2577-deprecate-roots-sampling-and-logging) · [Logging (draft)](https://modelcontextprotocol.io/specification/draft/server/utilities/logging) | manual |
| `MCP2026-LOGGING-002` | ERROR | high | `logging/setLevel`, `SetLevelRequestSchema`, `setLoggingLevel(…)` — **removed**, replaced by the per-request `io.modelcontextprotocol/logLevel` `_meta` field | [SEP-2575](https://modelcontextprotocol.io/seps/2575-stateless-mcp) · [changelog](https://modelcontextprotocol.io/specification/draft/changelog) | manual |

**Guidance these rules emit.** Log to `stderr` on stdio, or use OpenTelemetry and
normal application observability for structured logging — the draft also documents
W3C trace context propagation through `_meta` (`traceparent`, `tracestate`,
`baggage`, per the OpenTelemetry semantic conventions the draft base protocol
page cites). Protocol logging is never replaced automatically, because log
call sites carry request context that a rewrite would drop. The guidance warns that
moving log output to `stderr` or an observability backend changes who can read it,
so any argument, header or tool input currently interpolated into a log line should
be reviewed for secrets before the destination changes.

Supporting quotes:

> "Remove `ping`, `logging/setLevel`, and `notifications/roots/list_changed`. Log
> level is now set per-request via `io.modelcontextprotocol/logLevel` in `_meta`;
> servers MUST NOT emit `notifications/message` for requests that did not include
> this field" — draft changelog, major change 5

> "log to `stderr` (stdio) or use OpenTelemetry instead of Logging"
> — draft changelog, Deprecated 1

---

## Group 8 — MCP Apps readiness

Informational only. Emits a repository-level verdict of `LIKELY_READY`,
`POSSIBLE_CANDIDATE`, `NO_SIGNAL` or `NOT_APPLICABLE`.

| Rule ID | Level | Confidence | Detects | Official source | Autofix |
| --- | --- | --- | --- | --- | --- |
| `MCP2026-APPS-001` | INFO | varies | UI-producing behaviour associated with MCP tool output: `ui://` resource URIs, the `text/html;profile=mcp-app` MIME type, the `io.modelcontextprotocol/ui` extension identifier, `_meta.ui.resourceUri`, `@modelcontextprotocol/ext-apps` imports, HTML content responses, HTML templates, JSX/TSX UI modules, embedded frontend assets, and existing iframe/sandbox implementations | [SEP-1865](https://modelcontextprotocol.io/seps/1865-mcp-apps-interactive-user-interfaces-for-mcp) · [MCP Apps overview](https://modelcontextprotocol.io/extensions/apps/overview) | none |

Verdict rules:

| Verdict | Condition |
| --- | --- |
| `LIKELY_READY` | An explicit MCP Apps signal is present: the `io.modelcontextprotocol/ui` identifier, a `ui://` URI, the `text/html;profile=mcp-app` MIME type, `_meta.ui` metadata, or an `@modelcontextprotocol/ext-apps` import. A bare `resourceUri:` property is *not* explicit. |
| `POSSIBLE_CANDIDATE` | Generic UI-producing signals only — HTML in tool results, HTML templates, JSX/TSX modules, iframes, embedded assets, bare `resourceUri:` properties — or a foreign UI convention such as `text/html+skybridge`, which is reported as needing translation rather than as an MCP App. |
| `NO_SIGNAL` | The repository looks like an MCP server but shows no UI signal. |
| `NOT_APPLICABLE` | The repository does not look like an MCP server. |

Two corrections encoded in this rule, both verified against source:

- The extension identifier is **`io.modelcontextprotocol/ui`**, not
  `io.modelcontextprotocol/apps`.
- The MIME type is **`text/html;profile=mcp-app`**. `text/html+skybridge` is the
  OpenAI Apps SDK convention and appears nowhere in MCP sources; when found, the
  rule reports it as a proprietary convention needing translation, not as an MCP
  App.

The rule never claims that generic HTML constitutes a valid MCP App. `LIKELY_READY`
requires an explicit MCP Apps literal. MCP Apps is an optional extension — a
repository that does not implement it remains fully specification-compliant.

> "The proposal is an optional extension to the core protocol. Existing
> implementations continue working without changes." — SEP-1865

> "`mimeType` MUST be `text/html;profile=mcp-app`" — SEP-1865

---

## Coverage gaps

Changes in `2026-07-28` that this release does **not** detect. They are recorded
here so the matrix is an honest statement of coverage, and are listed in the README
under Limitations.

| Change | Source |
| --- | --- |
| Multi Round-Trip Requests: server-initiated requests replaced by `InputRequiredResult` / `inputRequests` / `inputResponses` / `requestState` | [SEP-2322](https://modelcontextprotocol.io/seps/2322-MRTR) |
| Required `resultType` discriminator on all results | [SEP-2322](https://modelcontextprotocol.io/seps/2322-MRTR) |
| Required `ttlMs` and `cacheScope` on list and read results (`CacheableResult`) | [SEP-2549](https://modelcontextprotocol.io/seps/2549-TTL-for-list-results) |
| `subscriptions/listen` adoption (detected only as the removal of what it replaces) | [SEP-2575](https://modelcontextprotocol.io/seps/2575-stateless-mcp) |
| Removal of `notifications/elicitation/complete`, `elicitationId`, and `-32042` | draft changelog, minor change 11 |
| Error-code renumbering `-32001`→`-32020`, `-32003`→`-32021`, `-32004`→`-32022` | draft changelog, minor change 12 |
| Authorization hardening (`iss` validation, `application_type`, credential binding, DCR deprecation) | SEP-2468, SEP-837, SEP-2352, PR #2858 |
| JSON Schema 2020-12 loosening for `inputSchema` / `outputSchema` | [SEP-2106](https://modelcontextprotocol.io/seps/2106-json-schema-2020-12) |
| TypeScript SDK v1 → v2 package split (`@modelcontextprotocol/sdk` → `/server`, `/client` and adapter packages, per the announcement; `/core` additionally published on npm) | [Beta SDK announcement](https://blog.modelcontextprotocol.io/posts/sdk-betas-2026-07-28/) |
| Non-JavaScript MCP servers (Python, Go, C#, Java, Rust, PHP) | — |
