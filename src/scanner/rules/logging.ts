import { DEFAULT_TARGET_VERSION, META_KEYS, SOURCES } from '../../constants.js';
import type { Finding, ScanContext, ScannerRule } from '../../types.js';
import { collectPropertyPaths, getSourceFile } from '../ast.js';
import { isInComment, offsetToPosition } from '../discovery.js';
import {
  buildFinding,
  dedupeByLocation,
  filesFor,
  identifierLiteral,
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
  'SetLevelRequest',
];

const LOGGING_CALLS = [
  /\b(?:server|mcpServer|this)\.sendLoggingMessage\s*\(/g,
  /\bsendLoggingMessage\s*\(/g,
];

/**
 * Only a genuine top-level capability declaration counts. A nested key such as
 * `capabilities.tasks.requests.logging` is a different feature and is handled by
 * its own rule.
 */
const LOGGING_CAPABILITY_PATHS = [/^capabilities\.logging(\.|$)/, /^logging(\.|$)/];

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

      for (const { hit } of matches(
        context,
        this,
        file,
        quotedLiteral(LOGGING_NOTIFICATION_LITERALS),
      )) {
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
        findings.push(
          buildFinding(this, hit, {
            title: `Deprecated protocol logging type (${hit.text})`,
            explanation: DEPRECATION_STATEMENT,
            remediation: MIGRATION_GUIDANCE,
          }),
        );
      }

      for (const pattern of LOGGING_CALLS) {
        for (const { hit } of matches(context, this, file, pattern)) {
          findings.push(
            buildFinding(this, hit, {
              title: 'Log emitted through deprecated protocol logging',
              explanation:
                `${DEPRECATION_STATEMENT} Note also that log level is now per request via ` +
                `${META_KEYS.logLevel} in _meta, and a server must not emit log notifications for a ` +
                'request that did not set it — so an unconditional call like this one may produce ' +
                'nothing on the wire.',
              remediation: MIGRATION_GUIDANCE,
              confidence: 'high',
            }),
          );
        }
      }

      if (!sourceFile) continue;
      for (const property of collectPropertyPaths(sourceFile)) {
        if (!LOGGING_CAPABILITY_PATHS.some((pattern) => pattern.test(property.path))) continue;
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
const SET_LEVEL_IDENTIFIERS = ['SetLevelRequestSchema', 'setLoggingLevel'];

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
      for (const { hit } of matches(context, this, file, quotedLiteral(SET_LEVEL_LITERALS))) {
        findings.push(buildFinding(this, hit, { explanation, remediation }));
      }
      for (const { hit } of matches(context, this, file, identifierLiteral(SET_LEVEL_IDENTIFIERS))) {
        findings.push(
          buildFinding(this, hit, {
            title: `SDK surface for the removed logging/setLevel RPC (${hit.text})`,
            explanation,
            remediation,
          }),
        );
      }
    }

    return dedupeByLocation(findings);
  },
};

export const loggingRules: ScannerRule[] = [loggingDeprecationRule, loggingSetLevelRule];
