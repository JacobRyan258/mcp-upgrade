import ts from 'typescript';
import { DEFAULT_TARGET_VERSION, SOURCES } from '../../constants.js';
import type { Finding, ScanContext, ScannerRule } from '../../types.js';
import { collectHeaderAccess, collectPropertyPaths, getSourceFile, walk } from '../ast.js';
import { isInComment, offsetToPosition } from '../discovery.js';
import {
  buildFinding,
  dedupeByLocation,
  filesFor,
  hasContextNear,
  identifierLiteral,
  matches,
  quotedLiteral,
} from './helpers.js';

/**
 * Group 1 — stateless lifecycle migration.
 *
 * `2026-07-28` removes protocol-level sessions (SEP-2567) and the
 * `initialize`/`notifications/initialized` handshake (SEP-2575). Requests
 * become self-contained: protocol version, client info and client capabilities
 * travel in `_meta` on every request, and servers implement `server/discover`.
 */

const STATELESS_EXPLANATION =
  'Protocol-level MCP sessions are removed in MCP 2026-07-28. The Streamable HTTP transport no ' +
  'longer defines the Mcp-Session-Id header, and a server "SHOULD ignore it, and not mint or echo ' +
  'session IDs". Any routing, storage or authorization that depends on a protocol session will ' +
  'have nothing to key on once the server targets the new revision.';

const STATELESS_REMEDIATION =
  'Remove protocol-level session routing and serve every request independently. Where state must ' +
  'genuinely persist across calls, keep it — but move it behind an explicit, server-minted handle ' +
  'returned in a tool result and passed back as an ordinary tool argument (SEP-2567 is explicit ' +
  'that handles are not a protocol construct: there is no handle type on the wire). Client identity ' +
  'and capabilities are now available per request in _meta under ' +
  'io.modelcontextprotocol/clientInfo and io.modelcontextprotocol/clientCapabilities. Do not delete ' +
  'application state as part of this change.';

/* -------------------------------------------------------------------------- */
/* MCP2026-SESSION-001 — Mcp-Session-Id header                                 */
/* -------------------------------------------------------------------------- */

const SESSION_HEADER_NAMES = new Set(['mcp-session-id']);

export const sessionHeaderRule: ScannerRule = {
  id: 'MCP2026-SESSION-001',
  title: 'Mcp-Session-Id header is removed in the target specification',
  category: 'stateless-lifecycle',
  targetVersion: DEFAULT_TARGET_VERSION,
  level: 'error',
  defaultConfidence: 'high',
  source: SOURCES.sep2567,
  appliesTo: {
    fileKinds: ['ts', 'js', 'json', 'yaml'],
    // The literal is self-evidencing: wherever it appears, the code speaks HTTP.
    transports: ['stdio', 'streamable-http', 'mixed', 'custom-http', 'unknown'],
  },
  autofix: 'manual',
  description:
    'Detects reads and writes of the Mcp-Session-Id HTTP header, which the 2026-07-28 Streamable ' +
    'HTTP transport no longer defines.',

  async scan(context: ScanContext): Promise<Finding[]> {
    const findings: Finding[] = [];

    for (const file of filesFor(this, context)) {
      const sourceFile = getSourceFile(file);

      if (sourceFile) {
        for (const access of collectHeaderAccess(sourceFile, SESSION_HEADER_NAMES)) {
          if (isInComment(file, access.start)) {
            const { line } = offsetToPosition(file, access.start);
            context.noteCommentOnlyMatch(this.id, file.relPath, line, access.header);
            continue;
          }
          findings.push(
            buildFinding(
              this,
              { file, offset: access.start, endOffset: access.end, text: access.header },
              {
                explanation: STATELESS_EXPLANATION,
                remediation: STATELESS_REMEDIATION,
                title:
                  access.mode === 'write'
                    ? 'Server writes the removed Mcp-Session-Id header'
                    : 'Server reads the removed Mcp-Session-Id header',
                transportApplicability: 'streamable-http',
              },
            ),
          );
        }
      }

      // Config files and any access shape the AST pass did not recognise.
      for (const { hit } of matches(context, this, file, /['"`]mcp-session-id['"`]/gi)) {
        findings.push(
          buildFinding(this, hit, {
            explanation: STATELESS_EXPLANATION,
            remediation: STATELESS_REMEDIATION,
            transportApplicability: 'streamable-http',
          }),
        );
      }
    }

    return dedupeByLocation(findings);
  },
};

/* -------------------------------------------------------------------------- */
/* MCP2026-SESSION-002 — SDK session transport options                         */
/* -------------------------------------------------------------------------- */

const SESSION_TRANSPORT_OPTIONS = ['sessionIdGenerator', 'onsessioninitialized', 'onsessionclosed'];

export const sessionTransportOptionsRule: ScannerRule = {
  id: 'MCP2026-SESSION-002',
  title: 'MCP transport is configured to create or track protocol sessions',
  category: 'stateless-lifecycle',
  targetVersion: DEFAULT_TARGET_VERSION,
  level: 'error',
  defaultConfidence: 'high',
  source: SOURCES.sep2567,
  appliesTo: {
    fileKinds: ['ts', 'js'],
    transports: ['streamable-http', 'mixed', 'custom-http', 'unknown'],
  },
  autofix: 'suggested',
  description:
    'Detects MCP transport constructor options that mint or track protocol session IDs: ' +
    'sessionIdGenerator, onsessioninitialized and onsessionclosed.',

  async scan(context: ScanContext): Promise<Finding[]> {
    const findings: Finding[] = [];

    for (const file of filesFor(this, context)) {
      const sourceFile = getSourceFile(file);
      if (!sourceFile) continue;

      for (const property of collectPropertyPaths(sourceFile)) {
        if (!SESSION_TRANSPORT_OPTIONS.includes(property.key)) continue;
        if (isInComment(file, property.start)) {
          const { line } = offsetToPosition(file, property.start);
          context.noteCommentOnlyMatch(this.id, file.relPath, line, property.key);
          continue;
        }

        // `sessionIdGenerator: undefined` is already the stateless shape the
        // TypeScript SDK documents, so it is not a finding.
        if (
          property.key === 'sessionIdGenerator' &&
          ts.isPropertyAssignment(property.node) &&
          property.node.initializer.kind === ts.SyntaxKind.UndefinedKeyword
        ) {
          continue;
        }
        if (
          property.key === 'sessionIdGenerator' &&
          ts.isPropertyAssignment(property.node) &&
          ts.isIdentifier(property.node.initializer) &&
          property.node.initializer.text === 'undefined'
        ) {
          continue;
        }

        findings.push(
          buildFinding(
            this,
            { file, offset: property.start, endOffset: property.end, text: property.key },
            {
              explanation:
                `The transport option "${property.key}" exists to create or observe protocol-level ` +
                'MCP sessions. SEP-2567 removes sessions from the protocol outright — the SEP calls it ' +
                '"a clean break: sessions are removed in the next spec version, with no deprecation ' +
                'window" — so this option has no meaning against a 2026-07-28 target.',
              remediation:
                property.key === 'sessionIdGenerator'
                  ? 'Remove the sessionIdGenerator option (the TypeScript SDK documents ' +
                    '`sessionIdGenerator: undefined` as the stateless shape), or migrate to the ' +
                    'stateless handler entry point your SDK version provides. ' +
                    STATELESS_REMEDIATION
                  : `Remove the ${property.key} callback and any session bookkeeping it drives. ` +
                    STATELESS_REMEDIATION,
              transportApplicability: 'streamable-http',
            },
          ),
        );
      }
    }

    return dedupeByLocation(findings);
  },
};

/* -------------------------------------------------------------------------- */
/* MCP2026-SESSION-003 — session-keyed state                                   */
/* -------------------------------------------------------------------------- */

const SESSION_STORE_PATTERNS: RegExp[] = [
  /\bnew\s+Map\s*<\s*string\s*,\s*\w*(?:Transport|Server|Session)\w*\s*>/g,
  /\b(?:transports|sessions|sessionStore|sessionMap|activeSessions|mcpSessions)\s*(?::|=)/g,
  /\b(?:transports|sessions|sessionStore|sessionMap|activeSessions|mcpSessions)\s*\[\s*\w*[sS]ession\w*\s*\]/g,
  /\bdelete\s+\w+\s*\[\s*\w*[sS]essionId\w*\s*\]/g,
];

const SESSION_CONTEXT_NEEDLES = [
  'sessionid',
  'mcp-session-id',
  'transport',
  'streamablehttp',
  'mcpserver',
];

export const sessionStateRule: ScannerRule = {
  id: 'MCP2026-SESSION-003',
  title: 'State appears to be keyed by an MCP session ID',
  category: 'stateless-lifecycle',
  targetVersion: DEFAULT_TARGET_VERSION,
  level: 'review',
  defaultConfidence: 'medium',
  source: SOURCES.sep2567,
  appliesTo: {
    fileKinds: ['ts', 'js'],
    transports: ['streamable-http', 'mixed', 'custom-http', 'unknown'],
  },
  autofix: 'manual',
  description:
    'Detects maps, stores and caches that appear to be keyed by an MCP session ID, including the ' +
    'session-to-transport routing map the TypeScript SDK examples popularised.',

  async scan(context: ScanContext): Promise<Finding[]> {
    const findings: Finding[] = [];

    for (const file of filesFor(this, context)) {
      for (const pattern of SESSION_STORE_PATTERNS) {
        for (const { hit } of matches(context, this, file, pattern)) {
          if (!hasContextNear(file, hit.offset, SESSION_CONTEXT_NEEDLES)) continue;
          findings.push(
            buildFinding(this, hit, {
              explanation:
                'This looks like state keyed by an MCP session ID. With protocol-level sessions ' +
                'removed in 2026-07-28 there is no session identifier to key on, so the lookup will ' +
                'have no key once the server targets the new revision. Static analysis cannot tell ' +
                'transport routing state (which should simply disappear) from genuine application ' +
                'state (which must be preserved), so this needs a human decision.',
              remediation:
                'If this map only routes requests to a per-session transport, delete it and serve ' +
                'requests statelessly. If it holds real application state, keep the state and change ' +
                'how it is addressed: mint an opaque handle server-side, return it from a tool, and ' +
                'accept it back as a normal tool argument. Do not delete business state.',
              transportApplicability: 'streamable-http',
            }),
          );
        }
      }
    }

    return dedupeByLocation(findings);
  },
};

/* -------------------------------------------------------------------------- */
/* MCP2026-SESSION-004 — sticky-session infrastructure                         */
/* -------------------------------------------------------------------------- */

const STICKY_CONFIG_PATTERNS: RegExp[] = [
  /\bsessionAffinity\b/g,
  /\bstickySessions?\b/gi,
  /\baffinity\s*:\s*['"`]?(?:cookie|client-?ip|ClientIP)/gi,
  /\bip_hash\b/g,
  /\bnginx\.ingress\.kubernetes\.io\/affinity\b/g,
  /\bservice\.spec\.sessionAffinity\b/g,
  /\balb\.ingress\.kubernetes\.io\/target-group-attributes\b/g,
  /\bstickiness\.enabled\b/g,
];

export const stickySessionConfigRule: ScannerRule = {
  id: 'MCP2026-SESSION-004',
  title: 'Sticky-session or session-affinity infrastructure configuration',
  category: 'stateless-lifecycle',
  targetVersion: DEFAULT_TARGET_VERSION,
  level: 'review',
  defaultConfidence: 'low',
  source: SOURCES.sep2567,
  appliesTo: {
    fileKinds: ['json', 'yaml', 'ts', 'js'],
    transports: ['stdio', 'streamable-http', 'mixed', 'custom-http', 'unknown'],
  },
  autofix: 'manual',
  description:
    'Detects load-balancer session affinity and sticky-session configuration that exists to support ' +
    'protocol-level MCP sessions.',

  async scan(context: ScanContext): Promise<Finding[]> {
    const findings: Finding[] = [];

    for (const file of filesFor(this, context)) {
      for (const pattern of STICKY_CONFIG_PATTERNS) {
        for (const { hit } of matches(context, this, file, pattern)) {
          findings.push(
            buildFinding(this, hit, {
              explanation:
                'Session affinity is configured here. A stateless MCP server does not need it: the ' +
                'release-candidate announcement describes a server that "previously needed sticky ' +
                'sessions, a shared session store, and deep packet inspection at the gateway" being ' +
                'able to "run behind a plain round-robin load balancer". This scanner cannot tell ' +
                'whether the affinity exists for MCP or for something else in the same deployment.',
              remediation:
                'Confirm whether this affinity exists to support MCP protocol sessions. If it does, ' +
                'it can be removed once the server is stateless, and routing can move to the ' +
                'Mcp-Method header instead of body inspection. If it supports an unrelated workload ' +
                'on the same ingress, leave it alone.',
            }),
          );
        }
      }
    }

    return dedupeByLocation(findings);
  },
};

/* -------------------------------------------------------------------------- */
/* MCP2026-LIFECYCLE-001 — initialization handshake                            */
/* -------------------------------------------------------------------------- */

const LIFECYCLE_METHOD_LITERALS = ['initialize', 'notifications/initialized'];
const LIFECYCLE_SDK_IDENTIFIERS = ['InitializeRequestSchema', 'InitializedNotificationSchema'];

/** Calls whose first string argument names the method being handled. */
const HANDLER_CALLS = /(^|\.)(setRequestHandler|setNotificationHandler|onRequest|onNotification|handle|on)$/;

export const initializationLifecycleRule: ScannerRule = {
  id: 'MCP2026-LIFECYCLE-001',
  title: 'Initialization handshake is removed in the target specification',
  category: 'stateless-lifecycle',
  targetVersion: DEFAULT_TARGET_VERSION,
  level: 'error',
  defaultConfidence: 'high',
  source: SOURCES.sep2575,
  appliesTo: {
    fileKinds: ['ts', 'js'],
    transports: ['stdio', 'streamable-http', 'mixed', 'custom-http', 'unknown'],
  },
  autofix: 'manual',
  description:
    'Detects handling of the removed initialize / notifications/initialized lifecycle methods, ' +
    'including the SDK schema constants that register those handlers.',

  async scan(context: ScanContext): Promise<Finding[]> {
    const findings: Finding[] = [];

    const explanation =
      'MCP 2026-07-28 removes the initialize / notifications/initialized handshake: the changelog ' +
      'entry reads "Make MCP stateless: remove the initialize/notifications/initialized handshake." ' +
      'Every request now carries its own protocol version and client capabilities in _meta, and ' +
      'servers MUST implement the new server/discover RPC to advertise supported versions, ' +
      'capabilities and identity.';

    const remediation =
      'Stop treating initialize as the point where session state is established. Implement ' +
      'server/discover to advertise supportedVersions, capabilities and serverInfo. Read client ' +
      'identity and capabilities per request from _meta ' +
      '(io.modelcontextprotocol/protocolVersion, io.modelcontextprotocol/clientInfo, ' +
      'io.modelcontextprotocol/clientCapabilities) instead of caching what the handshake reported. ' +
      'An initialize handler may still be kept deliberately, to serve clients negotiating an older ' +
      'protocol version.';

    for (const file of filesFor(this, context)) {
      const sourceFile = getSourceFile(file);
      if (!sourceFile) continue;

      // Method-name string literals, but only where they are clearly MCP
      // lifecycle methods: `notifications/initialized` is unambiguous on its
      // own, while bare `initialize` needs a handler registration around it.
      for (const { hit } of matches(context, this, file, quotedLiteral(LIFECYCLE_METHOD_LITERALS))) {
        const literal = hit.text.slice(1, -1);
        if (literal === 'initialize' && !isMethodHandlerArgument(sourceFile, hit.offset)) continue;
        findings.push(
          buildFinding(this, hit, {
            explanation,
            remediation,
            title: `Handling of the removed "${literal}" lifecycle method`,
          }),
        );
      }

      for (const { hit } of matches(
        context,
        this,
        file,
        identifierLiteral(LIFECYCLE_SDK_IDENTIFIERS),
      )) {
        findings.push(
          buildFinding(this, hit, {
            explanation,
            remediation,
            title: `SDK schema for the removed lifecycle method (${hit.text})`,
          }),
        );
      }
    }

    return dedupeByLocation(findings);
  },
};

/**
 * True when the string literal at `offset` is the first argument of a
 * handler-registration call. This is what separates `setRequestHandler('initialize', …)`
 * from an unrelated `initialize()` helper or a config key called "initialize".
 */
function isMethodHandlerArgument(sourceFile: ts.SourceFile, offset: number): boolean {
  let found = false;
  walk(sourceFile, (node) => {
    if (found || !ts.isCallExpression(node)) return;
    const first = node.arguments[0];
    if (!first || !ts.isStringLiteralLike(first)) return;
    if (first.getStart(sourceFile, false) !== offset) return;
    const name = expressionName(node.expression);
    if (HANDLER_CALLS.test(name)) found = true;
  });
  return found;
}

function expressionName(node: ts.Expression): string {
  if (ts.isIdentifier(node)) return node.text;
  if (ts.isPropertyAccessExpression(node)) return `${expressionName(node.expression)}.${node.name.text}`;
  return '';
}

/* -------------------------------------------------------------------------- */
/* MCP2026-LIFECYCLE-002 — removed core RPCs                                   */
/* -------------------------------------------------------------------------- */

interface RemovedMethod {
  method: string;
  sdkIdentifiers: string[];
  replacement: string;
}

const REMOVED_METHODS: RemovedMethod[] = [
  {
    method: 'ping',
    sdkIdentifiers: ['PingRequestSchema'],
    replacement:
      'There is no replacement. Liveness is now an HTTP concern: use an ordinary health-check ' +
      'endpoint or transport-level keepalive instead of a protocol ping.',
  },
  {
    method: 'resources/subscribe',
    sdkIdentifiers: ['SubscribeRequestSchema'],
    replacement:
      'Use subscriptions/listen, opting in through params.notifications.resourceSubscriptions. ' +
      'The response to that single request is a long-lived stream carrying the notifications.',
  },
  {
    method: 'resources/unsubscribe',
    sdkIdentifiers: ['UnsubscribeRequestSchema'],
    replacement:
      'Use subscriptions/listen. Unsubscribing is closing the listen stream, not a separate RPC.',
  },
];

export const removedCoreMethodsRule: ScannerRule = {
  id: 'MCP2026-LIFECYCLE-002',
  title: 'Core RPC removed in the target specification',
  category: 'stateless-lifecycle',
  targetVersion: DEFAULT_TARGET_VERSION,
  level: 'error',
  defaultConfidence: 'high',
  source: SOURCES.changelog,
  appliesTo: {
    fileKinds: ['ts', 'js'],
    transports: ['stdio', 'streamable-http', 'mixed', 'custom-http', 'unknown'],
  },
  autofix: 'manual',
  description:
    'Detects use of core RPCs removed in 2026-07-28: ping, resources/subscribe and ' +
    'resources/unsubscribe, plus their SDK schema constants.',

  async scan(context: ScanContext): Promise<Finding[]> {
    const findings: Finding[] = [];

    for (const file of filesFor(this, context)) {
      const sourceFile = getSourceFile(file);
      if (!sourceFile) continue;

      for (const removed of REMOVED_METHODS) {
        const explanation =
          `The "${removed.method}" method is removed in MCP 2026-07-28. The changelog records ` +
          '"Remove ping, logging/setLevel, and notifications/roots/list_changed" and "Replace the ' +
          'HTTP GET endpoint and resources/subscribe/resources/unsubscribe with ' +
          'subscriptions/listen". A client targeting the new revision that calls a removed method ' +
          'receives -32601 Method not found (HTTP 404).';

        for (const { hit } of matches(context, this, file, quotedLiteral([removed.method]))) {
          // `ping` is a common word; require a handler or call context.
          if (removed.method === 'ping' && !isMethodHandlerArgument(sourceFile, hit.offset)) continue;
          findings.push(
            buildFinding(this, hit, {
              explanation,
              remediation: removed.replacement,
              title: `Removed core RPC "${removed.method}"`,
            }),
          );
        }

        for (const { hit } of matches(
          context,
          this,
          file,
          identifierLiteral(removed.sdkIdentifiers),
        )) {
          findings.push(
            buildFinding(this, hit, {
              explanation,
              remediation: removed.replacement,
              title: `SDK schema for the removed RPC "${removed.method}" (${hit.text})`,
            }),
          );
        }
      }

      // The `resources.subscribe` sub-capability advertised support for the
      // removed subscribe/unsubscribe RPCs, so it no longer means anything.
      for (const property of collectPropertyPaths(sourceFile)) {
        if (!/^capabilities\.resources\.subscribe$/.test(property.path)) continue;
        if (isInComment(file, property.start)) continue;
        findings.push(
          buildFinding(
            this,
            { file, offset: property.start, endOffset: property.end, text: property.path },
            {
              title: 'Capability advertises the removed resources/subscribe RPC',
              explanation:
                'The resources.subscribe capability advertised support for resources/subscribe, ' +
                'which 2026-07-28 removes: the changelog replaces it and resources/unsubscribe ' +
                'with subscriptions/listen. Advertising it tells a client the server supports a ' +
                'method it can no longer call.',
              remediation:
                'Drop the subscribe sub-capability and implement subscriptions/listen instead. A ' +
                'client opts into resource updates by passing the URIs it cares about in ' +
                'params.notifications.resourceSubscriptions, and the response stream of that one ' +
                'request carries the notifications.',
            },
          ),
        );
      }
    }

    return dedupeByLocation(findings);
  },
};

/* -------------------------------------------------------------------------- */
/* MCP2026-LIFECYCLE-003 — removed Streamable HTTP mechanics                   */
/* -------------------------------------------------------------------------- */

interface RemovedMechanic {
  pattern: RegExp;
  title: string;
  what: string;
  remediation: string;
}

const REMOVED_MECHANICS: RemovedMechanic[] = [
  {
    pattern: /['"`]last-event-id['"`]/gi,
    title: 'SSE stream resumability via Last-Event-ID',
    what:
      'Stream resumability is removed. The draft transport states "Resumable SSE streams via ' +
      'Last-Event-ID are not supported" and instructs servers to ignore the header.',
    remediation:
      'Remove resumability handling. A broken response stream now loses the in-flight request and ' +
      'the client must re-issue it with a new request ID. Where durability genuinely matters, model ' +
      'the work as a task using the io.modelcontextprotocol/tasks extension rather than relying on ' +
      'stream replay.',
  },
  {
    pattern: /\beventStore\s*[:=]/g,
    title: 'Transport event store for stream replay',
    what:
      'An event store exists to replay SSE events for a resumed stream. Resumability is removed ' +
      'in 2026-07-28, so the store has nothing to serve.',
    remediation:
      'Remove the event store wiring. For long-running work that must survive a dropped connection, ' +
      'use the Tasks extension (io.modelcontextprotocol/tasks) instead.',
  },
  {
    pattern: /\b(?:app|router|server)\.delete\s*\(\s*['"`][^'"`]*mcp[^'"`]*['"`]/gi,
    title: 'HTTP DELETE session-termination route',
    what:
      'HTTP DELETE terminated a session in protocol versions 2025-03-26 through 2025-11-25. With ' +
      'sessions removed, the draft says a server "SHOULD respond 405 Method Not Allowed" to GET or ' +
      'DELETE on the MCP endpoint.',
    remediation:
      'Remove the DELETE route, or make it return 405 Method Not Allowed. There is no session to ' +
      'terminate.',
  },
  {
    pattern: /\b(?:app|router|server)\.get\s*\(\s*['"`][^'"`]*mcp[^'"`]*['"`]/gi,
    title: 'HTTP GET stream endpoint',
    what:
      'The standalone GET SSE endpoint is removed: "The MCP endpoint MUST provide a single HTTP ' +
      'endpoint path that supports POST", and servers "SHOULD respond 405 Method Not Allowed" to GET.',
    remediation:
      'Remove the GET SSE route. Server-to-client change notifications now arrive on the response ' +
      'stream of a subscriptions/listen request, and per-request notifications flow on the response ' +
      'stream of the request they relate to.',
  },
];

export const removedTransportMechanicsRule: ScannerRule = {
  id: 'MCP2026-LIFECYCLE-003',
  title: 'Streamable HTTP mechanic removed in the target specification',
  category: 'stateless-lifecycle',
  targetVersion: DEFAULT_TARGET_VERSION,
  level: 'error',
  defaultConfidence: 'medium',
  source: SOURCES.streamableHttp,
  appliesTo: {
    fileKinds: ['ts', 'js'],
    transports: ['streamable-http', 'mixed', 'custom-http'],
  },
  autofix: 'manual',
  description:
    'Detects Streamable HTTP mechanics removed in 2026-07-28: the standalone GET SSE endpoint, ' +
    'HTTP DELETE session termination and Last-Event-ID stream resumability.',

  async scan(context: ScanContext): Promise<Finding[]> {
    const findings: Finding[] = [];

    for (const file of filesFor(this, context)) {
      for (const mechanic of REMOVED_MECHANICS) {
        for (const { hit } of matches(context, this, file, mechanic.pattern)) {
          findings.push(
            buildFinding(this, hit, {
              explanation: mechanic.what,
              remediation: mechanic.remediation,
              title: mechanic.title,
              transportApplicability: 'streamable-http',
            }),
          );
        }
      }
    }

    return dedupeByLocation(findings);
  },
};

export const statelessLifecycleRules: ScannerRule[] = [
  sessionHeaderRule,
  sessionTransportOptionsRule,
  sessionStateRule,
  stickySessionConfigRule,
  initializationLifecycleRule,
  removedCoreMethodsRule,
  removedTransportMechanicsRule,
];
