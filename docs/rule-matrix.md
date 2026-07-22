# Rule Matrix

Every rule implemented by `mcp-upgrade`, mapped to the official Model Context
Protocol source that justifies it.

**Target:** MCP `2026-07-28` (release candidate — final specification not yet
published as of 2026-07-22).
**Baseline:** MCP `2025-11-25`.

Classification vocabulary:

- **ERROR** — confirmed incompatibility with the target specification.
- **WARNING** — a directly detected, material migration risk that is not a
  confirmed MUST-level incompatibility. Deprecated-feature warnings state that
  the feature remains functional during its deprecation window.
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
| `MCP2026-SESSION-001` | WARNING / REVIEW | medium / low | Writes of the `Mcp-Session-Id` HTTP header are `WARNING` / medium; reads and other compatibility literals are `REVIEW` / low because the target says servers SHOULD ignore the header and not mint or echo session IDs | [Streamable HTTP (draft)](https://modelcontextprotocol.io/specification/draft/basic/transports/streamable-http) · [SEP-2567](https://modelcontextprotocol.io/seps/2567-sessionless-mcp) | manual |
| `MCP2026-SESSION-002` | ERROR / REVIEW | high / medium | MCP transport constructor options that create or track protocol sessions: `sessionIdGenerator`, `onsessioninitialized`, `onsessionclosed`. Occurrences guarded as legacy-only downgrade to REVIEW. | [SEP-2567](https://modelcontextprotocol.io/seps/2567-sessionless-mcp) | suggested |
| `MCP2026-SESSION-003` | REVIEW | medium | Session-keyed transport/state maps near MCP code — `Map<string, StreamableHTTPServerTransport>`, `transports[sessionId]`, `sessions[sessionId]` | [SEP-2567](https://modelcontextprotocol.io/seps/2567-sessionless-mcp) | manual |
| `MCP2026-SESSION-004` | REVIEW | low | Sticky-session / session-affinity infrastructure config in JSON or YAML — `sessionAffinity`, `stickySessions`, `ip_hash`, affinity ingress annotations | [SEP-2567](https://modelcontextprotocol.io/seps/2567-sessionless-mcp) · [RC announcement](https://blog.modelcontextprotocol.io/posts/2026-07-28-release-candidate/) | manual |
| `MCP2026-LIFECYCLE-001` | ERROR / REVIEW | high / medium / low | The removed initialization handshake: `initialize` / `notifications/initialized` handled as MCP lifecycle methods, `InitializeRequestSchema`, `InitializedNotificationSchema`. Legacy-only guards downgrade to REVIEW / medium; ambiguous multiline templates use REVIEW / low. | [SEP-2575](https://modelcontextprotocol.io/seps/2575-stateless-mcp) · [changelog](https://modelcontextprotocol.io/specification/draft/changelog) | manual |
| `MCP2026-LIFECYCLE-002` | ERROR / REVIEW | high / medium / low | Core RPCs removed in the target: `ping`, `resources/subscribe`, `resources/unsubscribe`, and their SDK schema constants. Legacy-only guards downgrade to REVIEW / medium; ambiguous multiline templates use REVIEW / low. The `capabilities.resources.subscribe` declaration is **retained** in the target with new meaning and is reported at REVIEW / medium only, never as a removal. | [SEP-2575](https://modelcontextprotocol.io/seps/2575-stateless-mcp) · [changelog](https://modelcontextprotocol.io/specification/draft/changelog) | manual |
| `MCP2026-LIFECYCLE-003` | WARNING / REVIEW | medium / low | Legacy Streamable HTTP mechanics: the standalone GET SSE endpoint and HTTP DELETE session termination are warnings; ambiguous `Last-Event-ID` / `eventStore` use is review-only. Routes that visibly return 405 are excluded. | [Streamable HTTP (draft)](https://modelcontextprotocol.io/specification/draft/basic/transports/streamable-http) · [SEP-2575](https://modelcontextprotocol.io/seps/2575-stateless-mcp) | manual |

**`capabilities.resources.subscribe` is retained, not removed.** Only the
`resources/subscribe` and `resources/unsubscribe` RPCs were removed. The draft
Resources page still shows `subscribe` in a valid target-era capability example
and redefines it as "whether the server supports resource-specific update
notifications for resources requested through subscriptions/listen using the
`resourceSubscriptions` filter". `MCP2026-LIFECYCLE-002` therefore reports the
declaration at REVIEW so a human can confirm which mechanism backs it, and its
remediation never tells a user to drop a capability the target specification
expects subscribing servers to declare.

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
| `MCP2026-HEADER-001` | ERROR / REVIEW | high / low | Explicit MCP request construction (`fetch`/`axios`/`got` POST of a JSON-RPC Request) that omits or visibly mismatches `MCP-Protocol-Version` / `Mcp-Method`, or omits/mismatches `Mcp-Name` when required. Name-bearing methods include `tools/call`, `resources/read`, `prompts/get`, `tasks/get`, `tasks/update`, and `tasks/cancel`; task methods use `params.taskId`. Downgraded to REVIEW / low when a middleware/header wrapper or dynamic value prevents proof. | [SEP-2243](https://modelcontextprotocol.io/seps/2243-http-standardization) · [Streamable HTTP (draft)](https://modelcontextprotocol.io/specification/draft/basic/transports/streamable-http) · [SEP-2663](https://modelcontextprotocol.io/seps/2663-tasks-extension) | suggested |
| `MCP2026-HEADER-002` | REVIEW | medium | An MCP POST route handler that never visibly validates `MCP-Protocol-Version`, `Mcp-Method`, and applicable `Mcp-Name`, so header/body disagreement cannot be rejected | [Streamable HTTP (draft)](https://modelcontextprotocol.io/specification/draft/basic/transports/streamable-http) | manual |
| `MCP2026-HEADER-003` | INFO | high | Places where `MCP-Protocol-Version`, `Mcp-Method`, or `Mcp-Name` are already referenced; this is an implementation signal, not proof that every path is compliant | [Streamable HTTP (draft)](https://modelcontextprotocol.io/specification/draft/basic/transports/streamable-http) | none |

Supporting requirements:

The draft Streamable HTTP transport separately requires clients to include
`MCP-Protocol-Version` on HTTP requests. Its standard request-header table maps
`Mcp-Method` to every JSON-RPC Request and `Mcp-Name` to requests whose method
uses a named target. The draft states that those standard headers are required
for compliance.

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
| `MCP2026-ERROR-001` | ERROR / REVIEW | high / medium | `-32002` **emitted** as a resource-not-found error — a throw/return/reject position with resource context nearby (`resources/read`, `uri`, `resource not found`, `ReadResourceRequestSchema`). Legacy-only guarded emissions downgrade to REVIEW. | [SEP-2164](https://modelcontextprotocol.io/seps/2164-resource-not-found-error) · [Resources (draft)](https://modelcontextprotocol.io/specification/draft/server/resources) | suggested |
| `MCP2026-ERROR-002` | REVIEW | medium | A hardcoded `-32002` whose purpose cannot be determined from context | [SEP-2164](https://modelcontextprotocol.io/seps/2164-resource-not-found-error) | manual |

Client/server asymmetry is deliberate:

- A client scope that visibly accepts both `-32002` and `-32602` is compatible
  with old and target-era servers and is not flagged.
- A client comparison or `case` that accepts only `-32002` is REVIEW because it
  may reject the required target-era `-32602`; it is never asserted to be a
  server emission.
- Occurrences flowing through helpers the scanner cannot classify are REVIEW,
  never ERROR.
- Proven server emission of `-32002` for resource-not-found is ERROR.

Not flagged, deliberately:

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
| `MCP2026-TASKS-001` | ERROR / REVIEW | high / medium | Removed task RPCs: `tasks/list`, `tasks/result`, plus `ListTasksRequestSchema` / `GetTaskPayloadRequestSchema`. Legacy-only guards downgrade to REVIEW. | [SEP-2663](https://modelcontextprotocol.io/seps/2663-tasks-extension) · [changelog](https://modelcontextprotocol.io/specification/draft/changelog) | manual |
| `MCP2026-TASKS-002` | ERROR / REVIEW | high / medium | Legacy Tasks capability negotiation: `capabilities.tasks`, `tasks.requests.*`, `tasks.list`, `tasks.cancel`, `experimental.tasks`, and the tool-level `execution.taskSupport` field. Legacy-only guards downgrade to REVIEW. | [SEP-2663](https://modelcontextprotocol.io/seps/2663-tasks-extension) | manual |
| `MCP2026-TASKS-003` | REVIEW | medium | Legacy task augmentation and lifecycle structures: the 2025-11-25 per-request `task` param, related-task metadata, `notifications/tasks/status`, renamed `pollInterval` / `ttl` fields and legacy SDK helpers. It also identifies `modelcontextprotocol.io/task`, `notifications/tasks/created`, and `tasks/delete` explicitly as pre-2025 draft artifacts, not 2025-11-25 removals. `statusMessage` and `lastUpdatedAt` are deliberately **not** flagged because SEP-2663 carries both forward unchanged. | [SEP-2663](https://modelcontextprotocol.io/seps/2663-tasks-extension) · [SEP-1686](https://modelcontextprotocol.io/seps/1686-tasks) | manual |
| `MCP2026-TASKS-004` | ERROR / REVIEW | high / medium | Task-augmented Sampling and Elicitation: `tasks.requests.sampling.createMessage`, `tasks.requests.elicitation.create`, `createMessageStream`, `elicitInputStream`. Legacy-only guards downgrade to REVIEW. | [SEP-2663](https://modelcontextprotocol.io/seps/2663-tasks-extension) · [SEP-2260](https://modelcontextprotocol.io/seps/2260-Require-Server-requests-to-be-associated-with-Client-requests) | manual |

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
| `MCP2026-SAMPLING-001` | WARNING | high / medium | The `sampling` client capability, `sampling/createMessage`, `CreateMessageRequestSchema`, `server.createMessage(…)`, `requestSampling(…)`, and Sampling schema types (`CreateMessageResult`, `SamplingMessage`, `ModelPreferences`). Direct calls use high confidence; other explicit surfaces use medium. | [SEP-2577](https://modelcontextprotocol.io/seps/2577-deprecate-roots-sampling-and-logging) · [Sampling (draft)](https://modelcontextprotocol.io/specification/draft/client/sampling) | manual |
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
| `MCP2026-ROOTS-001` | WARNING | high / medium | The `roots` client capability, `roots/list`, `ListRootsRequestSchema`, `server.listRoots(…)`, and Roots schema types (`ListRootsResult`, `RootsCapability`). Direct calls use high confidence; other explicit surfaces use medium. | [SEP-2577](https://modelcontextprotocol.io/seps/2577-deprecate-roots-sampling-and-logging) · [Roots (draft)](https://modelcontextprotocol.io/specification/draft/client/roots) | manual |
| `MCP2026-ROOTS-002` | ERROR / REVIEW | high / medium | `notifications/roots/list_changed`, `RootsListChangedNotificationSchema`, `sendRootsListChanged(…)` — **removed**, not merely deprecated. Legacy-only guards downgrade to REVIEW. | [SEP-2575](https://modelcontextprotocol.io/seps/2575-stateless-mcp) · [changelog](https://modelcontextprotocol.io/specification/draft/changelog) | manual |

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
| `MCP2026-LOGGING-001` | WARNING | high / medium | The `logging` server capability, `notifications/message`, `sendLoggingMessage(…)`, `LoggingMessageNotificationSchema`, `LoggingLevel`. Direct calls use high confidence; other explicit surfaces use medium. | [SEP-2577](https://modelcontextprotocol.io/seps/2577-deprecate-roots-sampling-and-logging) · [Logging (draft)](https://modelcontextprotocol.io/specification/draft/server/utilities/logging) | manual |
| `MCP2026-LOGGING-002` | ERROR / REVIEW | high / medium | `logging/setLevel`, `SetLevelRequestSchema`, `setLoggingLevel(…)` — **removed**, replaced by the per-request `io.modelcontextprotocol/logLevel` `_meta` field. Legacy-only guards downgrade to REVIEW. | [SEP-2575](https://modelcontextprotocol.io/seps/2575-stateless-mcp) · [changelog](https://modelcontextprotocol.io/specification/draft/changelog) | manual |

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
| `MCP2026-APPS-001` | INFO | high / low | UI-producing behaviour associated with MCP tool output: `ui://` resource URIs, the `text/html;profile=mcp-app` MIME type, the `io.modelcontextprotocol/ui` extension identifier, `_meta.ui.resourceUri`, `@modelcontextprotocol/ext-apps` imports, HTML content responses, HTML templates, JSX/TSX UI modules, and existing iframe/sandbox implementations. Explicit MCP Apps signals use high confidence; generic UI candidates use low. | [SEP-1865](https://modelcontextprotocol.io/seps/1865-mcp-apps-interactive-user-interfaces-for-mcp) · [MCP Apps overview](https://modelcontextprotocol.io/extensions/apps/overview) | none |

Verdict rules:

| Verdict | Condition |
| --- | --- |
| `LIKELY_READY` | An explicit MCP Apps signal is present: the `io.modelcontextprotocol/ui` identifier, a `ui://` URI, the `text/html;profile=mcp-app` MIME type, `_meta.ui` metadata, or an `@modelcontextprotocol/ext-apps` import. A bare `resourceUri:` property is *not* explicit. |
| `POSSIBLE_CANDIDATE` | Generic UI-producing signals only — HTML in tool results, HTML templates, JSX/TSX modules, iframes, or bare `resourceUri:` properties — or a foreign UI convention such as `text/html+skybridge`, which is reported as needing translation rather than as an MCP App. |
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

## Group 9 - Target-era wire contract and SDK migration

These rules cover material gaps found during the release audit. They are scoped
to executable, explicit protocol objects or official SDK entry points; they do
not infer missing fields from high-level v2 SDK handler results whose wire codec
adds the target envelope.

| Rule ID | Level | Confidence | Detects | Official source | Autofix |
| --- | --- | --- | --- | --- | --- |
| `MCP2026-SDK-001` | ERROR / REVIEW | high / medium | A proven direct `Server` / `McpServer.connect(transport)` serving entry point is ERROR. A legacy monolithic `@modelcontextprotocol/sdk` manifest dependency alone is REVIEW because it may be client-only, tooling, or an intentionally isolated legacy endpoint. | [Official TypeScript SDK v2 migration](https://ts.sdk.modelcontextprotocol.io/v2/migration/support-2026-07-28) | manual |
| `MCP2026-MRTR-001` | ERROR / REVIEW | high / medium | Direct `roots/list`, `sampling/createMessage`, and `elicitation/create` server requests that must instead be request objects inside `InputRequiredResult.inputRequests`. Ambiguous direction and legacy-only guards downgrade to REVIEW. | [MRTR (draft)](https://modelcontextprotocol.io/specification/draft/basic/patterns/mrtr) · [SEP-2322](https://modelcontextprotocol.io/seps/2322-MRTR) | manual |
| `MCP2026-MRTR-002` | ERROR / REVIEW | high / medium | Explicit `input_required` results that provide neither `inputRequests` nor `requestState`, contain invalid request entries, or are returned by a method outside `prompts/get`, `resources/read`, and `tools/call`; dynamic shapes downgrade to REVIEW | [MRTR (draft)](https://modelcontextprotocol.io/specification/draft/basic/patterns/mrtr) | suggested |
| `MCP2026-MRTR-003` | REVIEW | medium | Locally decoded `requestState` used in identity, tenant, or authorization branching without visible same-function integrity verification | [MRTR security requirements (draft)](https://modelcontextprotocol.io/specification/draft/basic/patterns/mrtr) | manual |
| `MCP2026-ELICITATION-001` | ERROR / REVIEW | high / medium | Removed `notifications/elicitation/complete`, `elicitationId`, URL-elicitation SDK surfaces, and server emission of `-32042`. Legacy-only guards and unproven numeric uses downgrade to REVIEW. | [Elicitation (draft)](https://modelcontextprotocol.io/specification/draft/client/elicitation) · [changelog](https://modelcontextprotocol.io/specification/draft/changelog) | manual |
| `MCP2026-RESULT-001` | ERROR / REVIEW | high / medium | Raw JSON-RPC results linked to a recognized MCP handler or dispatch case that omit `resultType` are ERROR; unassociated MCP-shaped results require REVIEW; explicit `CreateTaskResult` objects must flatten the required Task fields and are limited to `tools/call` | [Base protocol (draft)](https://modelcontextprotocol.io/specification/draft/basic/index) · [SEP-2663](https://modelcontextprotocol.io/seps/2663-tasks-extension) | suggested |
| `MCP2026-META-001` | ERROR / REVIEW | high / medium | Executable raw requests for recognized MCP methods missing `io.modelcontextprotocol/protocolVersion` or `io.modelcontextprotocol/clientCapabilities` in `params._meta` are ERROR; dynamic params require REVIEW | [Base protocol (draft)](https://modelcontextprotocol.io/specification/draft/basic/index) | suggested |
| `MCP2026-DISCOVERY-001` | REVIEW | high / medium | Explicit discovery results with obsolete top-level `serverInfo` or missing recommended `_meta['io.modelcontextprotocol/serverInfo']`; an extra top-level field alone is not claimed to invalidate the result | [Server discovery (draft)](https://modelcontextprotocol.io/specification/draft/server/discover) | suggested |
| `MCP2026-CACHE-001` | ERROR / REVIEW | high / medium | Explicit complete discovery/list/read results with missing or invalid `ttlMs` and `cacheScope` are ERROR; dynamic hints require REVIEW | [Caching (draft)](https://modelcontextprotocol.io/specification/draft/server/utilities/caching) · [SEP-2549](https://modelcontextprotocol.io/seps/2549-TTL-for-list-results) | suggested |
| `MCP2026-ERROR-003` | ERROR / REVIEW | high / medium | Proven server emission of obsolete `-32001`, `-32003`, or `-32004` with the corresponding named target error is ERROR; named declarations of uncertain direction are REVIEW and client comparisons are excluded | [Base protocol error codes (draft)](https://modelcontextprotocol.io/specification/draft/basic/index) · [changelog](https://modelcontextprotocol.io/specification/draft/changelog) | suggested |

Official-source constraints encoded by this group:

- `resultType` is required on target results. Treating an absent value as
  `complete` is backward-compatible **client** behavior for older servers, not
  permission for a target server to omit it.
- Core `InputRequiredResult` is limited to `prompts/get`, `resources/read`, and
  `tools/call`; `inputRequests` and `requestState` are each optional, but at
  least one must be present. The client must treat `requestState` as opaque; a server that
  uses client-returned state must validate it and bind user-specific state to
  the authenticated user.
- Complete `server/discover`, list and resource-read results carry cache hints;
  interim `input_required` results do not.
- The old `-32000` through `-32019` range remains implementation-defined. The
  renumbering rule therefore requires the named target error nearby and never
  treats every occurrence of an old number as invalid.

---

## Coverage gaps

Only genuine remaining gaps are listed. A clean scan can miss each one as noted.

| Gap | Classification and reason | Impact / clean-scan risk | Expected future implementation |
| --- | --- | --- | --- |
| [Authorization hardening](https://modelcontextprotocol.io/specification/draft/basic/authorization) (`iss`, `application_type`, credential binding, DCR changes) | **Not statically detectable at acceptable confidence** across client code, authorization-server configuration, deployment metadata and runtime redirect flows. | High security impact. A clean scan can miss it. | A specialized authorization audit with role detection, configuration schemas and bounded data flow. |
| [JSON Schema 2020-12 support](https://modelcontextprotocol.io/specification/draft/basic) for tool schemas | **Valuable but safely deferred.** The specification change primarily permits more schema constructs; existing valid object-root input schemas remain valid. | Medium interoperability impact for custom validators. A clean scan can miss rejection of newly valid schemas. | Detect legacy schema validators, forced object output, and unsafe automatic external `$ref` dereferencing. |
| [`subscriptions/listen` adoption](https://modelcontextprotocol.io/specification/draft/basic/patterns/subscriptions) | **Valuable but safely deferred.** Removed subscribe/unsubscribe surfaces are detected, but static analysis cannot prove that a particular application requires replacement invalidation behavior. | Medium stale-cache risk. A clean scan can miss a missing replacement. | Correlate removed subscriptions, cache policy and list/read consumers across files. |
| [MRTR retry consumption](https://modelcontextprotocol.io/specification/draft/basic/patterns/mrtr) (`inputResponses` and echoed `requestState`) | **Not statically detectable at acceptable confidence** without correlating the initial result, client fulfillment and a later independent retry. | High functional impact. A clean scan can miss a server that emits a valid result but mishandles the retry. | Add bounded cross-file data flow that associates request keys with retry parameters and server-side consumption. |
| [End-to-end Tasks semantics](https://modelcontextprotocol.io/seps/2663-tasks-extension) | **Valuable but safely deferred.** Rules cover removed legacy surfaces, explicit `CreateTaskResult` shapes and routing headers, but do not prove per-request capability negotiation, durable creation, authorization binding or valid status transitions. | High functional and isolation impact. A clean scan can miss these runtime invariants. | Add a Tasks-specific cross-file analyzer and runtime conformance tests for lifecycle and authorization invariants. |
| Dynamic custom HTTP routing | **Not statically detectable at acceptable confidence** when route paths, receiver names or raw request dispatch are assembled across files. Common Fastify, Hono, Koa, router and Node HTTP shapes are covered. | Medium transport-migration impact. A clean scan can miss HTTP-only rules when transport remains `unknown`. | Add bounded inter-file call and constant propagation while retaining conservative MCP provenance checks. |
| Non-JavaScript MCP servers | **Outside the JavaScript/TypeScript scope.** | Potentially complete migration impact. A clean scan can miss Python, Go, C#, Java, Rust or PHP behavior. | Language-specific front ends that emit the same versioned report contract. |
