import { DEFAULT_TARGET_VERSION, META_KEYS, SOURCES } from '../../constants.js';
import type { Finding, ScanContext, ScannerRule } from '../../types.js';
import { collectCalls, collectPropertyPaths, getSourceFile } from '../ast.js';
import { isInComment, offsetToPosition } from '../discovery.js';
import {
  buildFinding,
  dedupeByLocation,
  fileHasMcpSignal,
  filesFor,
  hasContextNear,
  identifierLiteral,
  isExecutableProtocolLiteral,
  isMcpSdkIdentifier,
  legacyEraFindingOverride,
  matches,
  quotedLiteral,
} from './helpers.js';

/**
 * Group 7 — protocol logging deprecation (SEP-2577), plus one removal.
 *
 * As with Roots, the *feature* is deprecated and still works
 * (`MCP2026-LOGGING-001`, WARNING) while one specific method is removed
 * (`MCP2026-LOGGING-002`, ERROR).
 */

const DEPRECATION_STATEMENT =
  'Protocol logging is deprecated as of MCP 2026-07-28 (SEP-2577). It is not removed: deprecated ' +
  'features "remain fully functional during the deprecation window", with a minimum twelve-month ' +
  'window before removal — the deprecated-features registry records the earliest removal as the ' +
  'first revision released on or after 2027-07-28.';

const MIGRATION_GUIDANCE =
  'Do not add protocol logging to new code. To migrate, use stderr on the stdio transport, and ' +
  'OpenTelemetry or your normal application observability stack for structured logging — the ' +
  'changelog names exactly these: "log to stderr (stdio) or use OpenTelemetry instead of Logging". ' +
  'The draft also documents W3C trace context propagation through _meta (traceparent, tracestate, ' +
  'baggage), so a request can still be correlated end to end. Do not do this replacement ' +
  'mechanically: protocol log calls carry request-scoped context that a blind rewrite to a global ' +
  'logger would drop. And review what is being logged before the destination changes — arguments, ' +
  'headers and tool inputs that were acceptable to send to one connected client may not be ' +
  'acceptable in a shared observability backend or a captured stderr stream, so redact secrets and ' +
  'personal data at the call site.';

const LOGGING_NOTIFICATION_LITERALS = ['notifications/message'];

const LOGGING_IDENTIFIERS = [
  'LoggingMessageNotificationSchema',
  'LoggingMessageNotification',
  'LoggingLevelSchema',
  'LoggingLevel',
];

/**
 * Callee shapes that emit protocol log notifications. Matched against actual
 * call expressions (never declarations), and only in files with an MCP signal.
 */
const LOGGING_CALL_NAMES = [/(^|\.)sendLoggingMessage$/];

/**
 * A `capabilities.logging` path is self-evidencing. A bare top-level `logging`
 * key is not — every second app config has one — so it only counts with
 * capability/MCP vocabulary nearby, and only as the exact key.
 */
const LOGGING_CAPABILITY_PATH = /(^|\.)capabilities\.logging(\.|$)/;
const LOGGING_BARE_PATH = /^logging$/;
/**
 * Vocabulary that makes a bare top-level key a capability declaration rather
 * than ordinary configuration. Deliberately excludes 'mcp' and
 * 'modelcontextprotocol': every file in an MCP server contains those in its
 * import lines, which made the proximity gate vacuous and turned an LLM
 * wrapper's token-sampling options, a winston logging config and a directory
 * roots array into asserted capability declarations.
 */
const CAPABILITY_CONTEXT_NEEDLES = [
  'capabilities',
  'clientcapabilities',
  'servercapabilities',
];

export const loggingDeprecationRule: ScannerRule = {
  id: 'MCP2026-LOGGING-001',
  title: 'Protocol logging is deprecated in the target specification',
  category: 'logging',
  targetVersion: DEFAULT_TARGET_VERSION,
  level: 'warning',
  defaultConfidence: 'medium',
  source: SOURCES.sep2577,
  appliesTo: {
    fileKinds: ['ts', 'js', 'json'],
    transports: ['stdio', 'streamable-http', 'mixed', 'custom-http', 'unknown'],
  },
  autofix: 'manual',
  description:
    'Detects the logging server capability, notifications/message, and MCP logging schema types.',

  async scan(context: ScanContext): Promise<Finding[]> {
    const findings: Finding[] = [];

    for (const file of filesFor(this, context)) {
      const sourceFile = getSourceFile(file);

      const localMcp = fileHasMcpSignal(file);

      for (const { hit } of matches(
        context,
        this,
        file,
        quotedLiteral(LOGGING_NOTIFICATION_LITERALS),
      )) {
        if (!localMcp) continue;
        if (!sourceFile || !isExecutableProtocolLiteral(sourceFile, hit.offset)) continue;
        findings.push(
          buildFinding(this, hit, {
            title: 'Deprecated protocol log notification (notifications/message)',
            explanation:
              `${DEPRECATION_STATEMENT} One behavioural change applies even while it is still ` +
              'supported: log level is now set per request through the ' +
              `${META_KEYS.logLevel} field in _meta, and a server "MUST NOT emit ` +
              'notifications/message for requests that did not include this field". A server that ' +
              'logs unconditionally will simply stop being heard.',
            remediation: MIGRATION_GUIDANCE,
          }),
        );
      }

      for (const { hit } of matches(context, this, file, identifierLiteral(LOGGING_IDENTIFIERS))) {
        if (!sourceFile || !isMcpSdkIdentifier(sourceFile, hit.offset)) continue;
        findings.push(
          buildFinding(this, hit, {
            title: `Deprecated protocol logging type (${hit.text})`,
            explanation: DEPRECATION_STATEMENT,
            remediation: MIGRATION_GUIDANCE,
          }),
        );
      }

      if (!sourceFile) continue;

      for (const call of collectCalls(sourceFile)) {
        if (!localMcp) continue;
        if (!LOGGING_CALL_NAMES.some((pattern) => pattern.test(call.name))) continue;
        if (isInComment(file, call.start)) continue;
        findings.push(
          buildFinding(
            this,
            { file, offset: call.start, endOffset: call.end, text: call.name },
            {
              title: 'Log emitted through deprecated protocol logging',
              explanation:
                `${DEPRECATION_STATEMENT} Note also that log level is now per request via ` +
                `${META_KEYS.logLevel} in _meta, and a server must not emit log notifications for a ` +
                'request that did not set it — so an unconditional call like this one may produce ' +
                'nothing on the wire.',
              remediation: MIGRATION_GUIDANCE,
              confidence: 'high',
            },
          ),
        );
      }

      for (const property of collectPropertyPaths(sourceFile)) {
        // Deliberately gated on the per-file signal, not repository evidence:
        // in a monorepo a sibling package's generic `capabilities: { roots: {} }`
        // config must not borrow provenance from an MCP package next to it.
        if (!localMcp) continue;
        const explicit = LOGGING_CAPABILITY_PATH.test(property.path);
        const bare =
          LOGGING_BARE_PATH.test(property.path) &&
          hasContextNear(file, property.start, CAPABILITY_CONTEXT_NEEDLES, 400, property.end);
        if (!explicit && !bare) continue;
        if (isInComment(file, property.start)) {
          const { line } = offsetToPosition(file, property.start);
          context.noteCommentOnlyMatch(this.id, file.relPath, line, property.path);
          continue;
        }
        findings.push(
          buildFinding(
            this,
            { file, offset: property.start, endOffset: property.end, text: property.path },
            {
              title: 'Deprecated protocol logging capability declaration',
              explanation: DEPRECATION_STATEMENT,
              remediation: MIGRATION_GUIDANCE,
            },
          ),
        );
      }
    }

    return dedupeByLocation(findings);
  },
};

/* -------------------------------------------------------------------------- */
/* MCP2026-LOGGING-002 — removed logging/setLevel                              */
/* -------------------------------------------------------------------------- */

const SET_LEVEL_LITERALS = ['logging/setLevel'];
const SET_LEVEL_IDENTIFIERS = ['SetLevelRequestSchema', 'SetLevelRequest', 'setLoggingLevel'];

/**
 * `setLoggingLevel` is an instance method on the SDK `Client`, so it never
 * appears in an import statement. Matching it only as an imported identifier
 * meant a client sending the removed RPC scanned completely clean; it needs the
 * call-expression treatment `sendLoggingMessage` already gets.
 */
const SET_LEVEL_CALL_NAMES = [/(^|\.)setLoggingLevel$/];

export const loggingSetLevelRule: ScannerRule = {
  id: 'MCP2026-LOGGING-002',
  title: 'logging/setLevel is removed in the target specification',
  category: 'logging',
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
    'Detects the removed logging/setLevel RPC and its SDK surface. This is a removal, distinct ' +
    'from the protocol logging deprecation.',

  async scan(context: ScanContext): Promise<Finding[]> {
    const findings: Finding[] = [];

    const explanation =
      'logging/setLevel is removed in MCP 2026-07-28 — not deprecated. The changelog reads "Remove ' +
      'ping, logging/setLevel, and notifications/roots/list_changed", and SEP-2575 states there is ' +
      `no replacement RPC: "The log level is now specified per-request via the ` +
      `'${META_KEYS.logLevel}' _meta field." The Logging feature as a whole is separately ` +
      'deprecated but still functional; only this method is gone.';

    const remediation =
      `Remove the logging/setLevel handler. Read the requested level from ${META_KEYS.logLevel} in ` +
      'each request\'s _meta instead of holding a level as connection state — there is no ' +
      'connection to hold it on. A request that omits the field is opting out: the server must not ' +
      'emit notifications/message for it. Longer term, follow the Logging deprecation guidance and ' +
      'move to stderr or OpenTelemetry.';

    for (const file of filesFor(this, context)) {
      const sourceFile = getSourceFile(file);
      for (const { hit } of matches(context, this, file, quotedLiteral(SET_LEVEL_LITERALS))) {
        if (!sourceFile || !isExecutableProtocolLiteral(sourceFile, hit.offset)) continue;
        findings.push(
          buildFinding(this, hit, {
            ...legacyEraFindingOverride(file, sourceFile, hit.offset),
            explanation,
            remediation,
          }),
        );
      }
      for (const { hit } of matches(context, this, file, identifierLiteral(SET_LEVEL_IDENTIFIERS))) {
        if (!sourceFile || !isMcpSdkIdentifier(sourceFile, hit.offset)) continue;
        findings.push(
          buildFinding(this, hit, {
            ...legacyEraFindingOverride(file, sourceFile, hit.offset),
            title: `SDK surface for the removed logging/setLevel RPC (${hit.text})`,
            explanation,
            remediation,
          }),
        );
      }

      if (!sourceFile || !fileHasMcpSignal(file)) continue;
      for (const call of collectCalls(sourceFile)) {
        if (!SET_LEVEL_CALL_NAMES.some((pattern) => pattern.test(call.name))) continue;
        if (isInComment(file, call.start)) continue;
        findings.push(
          buildFinding(
            this,
            { file, offset: call.start, endOffset: call.end, text: call.name },
            {
              ...legacyEraFindingOverride(file, sourceFile, call.start),
              title: `SDK surface for the removed logging/setLevel RPC (${call.name})`,
              explanation,
              remediation,
            },
          ),
        );
      }
    }

    return dedupeByLocation(findings);
  },
};

export const loggingRules: ScannerRule[] = [loggingDeprecationRule, loggingSetLevelRule];
