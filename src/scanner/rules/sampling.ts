import { DEFAULT_TARGET_VERSION, SOURCES } from '../../constants.js';
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
 * Group 5 — Sampling deprecation (SEP-2577).
 *
 * Sampling is **deprecated, not removed**. It remains fully functional for at
 * least a twelve-month window, so every finding here is a WARNING and the
 * wording never calls it a breaking change.
 */

const DEPRECATION_STATEMENT =
  'Sampling is deprecated as of MCP 2026-07-28 (SEP-2577). It is not removed: the changelog says ' +
  'the deprecated features "remain fully functional during the deprecation window but new ' +
  'implementations should not add support for them", and the feature lifecycle policy guarantees a ' +
  'minimum twelve-month window before removal — the deprecated-features registry records the ' +
  'earliest removal as the first revision released on or after 2027-07-28. Existing Sampling code ' +
  'keeps working against a 2026-07-28 server.';

const MIGRATION_GUIDANCE =
  'Do not add Sampling to new code. For existing servers, plan a migration to direct integration ' +
  'with an LLM provider API, which is the migration the changelog names. Weigh the consequences ' +
  'before you move: MCP Sampling deliberately kept model access, provider credentials, cost and ' +
  'model choice on the client side. Calling a provider directly means this server now holds an API ' +
  'key that needs storage, rotation and least-privilege scoping; it carries the token cost and ' +
  'rate limits; and it becomes the place where untrusted tool input can reach a model, so prompt ' +
  'injection and output handling become your problem. Separately, and independently of the ' +
  'deprecation, server-initiated Sampling is reshaped by Multi Round-Trip Requests: a server ' +
  'returns an InputRequiredResult carrying inputRequests instead of issuing a request on a stream, ' +
  'and the client answers with inputResponses on a retry of the original request.';

const SAMPLING_METHOD_LITERALS = ['sampling/createMessage'];

const SAMPLING_IDENTIFIERS = [
  'CreateMessageRequestSchema',
  'CreateMessageResultSchema',
  'CreateMessageRequest',
  'CreateMessageResult',
  'SamplingMessage',
  'ModelPreferences',
  'ModelHint',
];

/** Call shapes that initiate an MCP Sampling request. */
const SAMPLING_CALLS = [
  /\b(?:server|mcpServer|this)\.createMessage\s*\(/g,
  /\bctx\.mcpReq\.requestSampling\s*\(/g,
  /\brequestSampling\s*\(/g,
];

/**
 * Only a genuine top-level capability declaration counts. A nested key such as
 * `capabilities.tasks.requests.sampling` is a different feature and is handled by
 * its own rule.
 */
const SAMPLING_CAPABILITY_PATHS = [/^capabilities\.sampling(\.|$)/, /^sampling(\.|$)/];

export const samplingDeprecationRule: ScannerRule = {
  id: 'MCP2026-SAMPLING-001',
  title: 'Sampling is deprecated in the target specification',
  category: 'sampling',
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
    'Detects the sampling capability, sampling/createMessage, server-initiated LLM calls through ' +
    'MCP Sampling, and Sampling schema types.',

  async scan(context: ScanContext): Promise<Finding[]> {
    const findings: Finding[] = [];

    for (const file of filesFor(this, context)) {
      const sourceFile = getSourceFile(file);

      for (const { hit } of matches(context, this, file, quotedLiteral(SAMPLING_METHOD_LITERALS))) {
        findings.push(
          buildFinding(this, hit, {
            title: 'Deprecated Sampling method (sampling/createMessage)',
            explanation: DEPRECATION_STATEMENT,
            remediation: MIGRATION_GUIDANCE,
          }),
        );
      }

      for (const { hit } of matches(context, this, file, identifierLiteral(SAMPLING_IDENTIFIERS))) {
        findings.push(
          buildFinding(this, hit, {
            title: `Deprecated Sampling type (${hit.text})`,
            explanation: DEPRECATION_STATEMENT,
            remediation: MIGRATION_GUIDANCE,
          }),
        );
      }

      for (const pattern of SAMPLING_CALLS) {
        for (const { hit } of matches(context, this, file, pattern)) {
          findings.push(
            buildFinding(this, hit, {
              title: 'Server-initiated LLM call through deprecated MCP Sampling',
              explanation: DEPRECATION_STATEMENT,
              remediation: MIGRATION_GUIDANCE,
              confidence: 'high',
            }),
          );
        }
      }

      if (!sourceFile) continue;
      for (const property of collectPropertyPaths(sourceFile)) {
        if (!SAMPLING_CAPABILITY_PATHS.some((pattern) => pattern.test(property.path))) continue;
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
              title: 'Deprecated Sampling capability declaration',
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
/* MCP2026-SAMPLING-002 — deprecated includeContext values                     */
/* -------------------------------------------------------------------------- */

export const includeContextRule: ScannerRule = {
  id: 'MCP2026-SAMPLING-002',
  title: 'Deprecated includeContext value',
  category: 'sampling',
  targetVersion: DEFAULT_TARGET_VERSION,
  level: 'warning',
  defaultConfidence: 'low',
  source: SOURCES.changelog,
  appliesTo: {
    fileKinds: ['ts', 'js', 'json'],
    transports: ['stdio', 'streamable-http', 'mixed', 'custom-http', 'unknown'],
  },
  autofix: 'suggested',
  description:
    'Detects the includeContext values "thisServer" and "allServers", reclassified as Deprecated ' +
    'in 2026-07-28.',

  async scan(context: ScanContext): Promise<Finding[]> {
    const findings: Finding[] = [];
    const pattern = /\bincludeContext\s*:\s*['"`](thisServer|allServers)['"`]/g;

    for (const file of filesFor(this, context)) {
      for (const { hit, match } of matches(context, this, file, pattern)) {
        const value = match[1] ?? '';
        findings.push(
          buildFinding(this, hit, {
            title: `Deprecated includeContext value ("${value}")`,
            explanation:
              `The includeContext values "thisServer" and "allServers" were soft-deprecated in ` +
              '2025-11-25 and are reclassified as Deprecated in 2026-07-28 under the feature ' +
              'lifecycle policy. They still work; the changelog notes they "will be removed no later ' +
              'than the Sampling feature itself".',
            remediation:
              'Omit the includeContext field or set it to "none". If the model genuinely needs ' +
              'context from this server, pass it explicitly in the messages you construct rather ' +
              'than relying on the host to assemble it.',
          }),
        );
      }
    }

    return dedupeByLocation(findings);
  },
};

export const samplingRules: ScannerRule[] = [samplingDeprecationRule, includeContextRule];
