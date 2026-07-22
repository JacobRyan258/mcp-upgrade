import { DEFAULT_TARGET_VERSION, SOURCES } from '../../constants.js';
import type { Finding, ScanContext, ScannerRule } from '../../types.js';
import { collectNumericLiterals, getSourceFile } from '../ast.js';
import { isInComment, offsetToPosition } from '../discovery.js';
import { buildFinding, dedupeByLocation, filesFor, hasContextNear, matches } from './helpers.js';

/**
 * Group 3 — resource error-code migration (SEP-2164).
 *
 * `2026-07-28` moves resource-not-found from the MCP-specific `-32002` to the
 * standard JSON-RPC `-32602` Invalid Params.
 *
 * The subtlety that decides correctness here: the change is a producer/consumer
 * asymmetry, not a ban. Servers MUST return `-32602`; clients SHOULD *still*
 * accept `-32002` from older servers. So code that compares against `-32002`
 * is correct forward-compatible behaviour and must never be flagged — only
 * code that emits it is a finding.
 */

const RESOURCE_CONTEXT_NEEDLES = [
  'resources/read',
  'readresource',
  'resource not found',
  'resourcenotfound',
  'resource_not_found',
  'notfoundresource',
  'uri',
  'resourceuri',
  'listresources',
  'resources/list',
];

const EXPLANATION_BASE =
  'MCP 2026-07-28 changes the resource-not-found error code from -32002 to the standard JSON-RPC ' +
  '-32602 (Invalid Params). SEP-2164 makes it normative: "If the requested resource does not ' +
  'exist, servers MUST return a JSON-RPC error with code -32602 (Invalid Params)." The rationale ' +
  'is that -32002 sits in the JSON-RPC implementation-defined server-error range rather than ' +
  'carrying protocol-level meaning, and SDKs disagreed about it.';

const REMEDIATION_EMIT =
  'Return -32602 (Invalid Params) instead of -32002 for a missing resource, and include the URI ' +
  'that was not found in the error data, e.g. { "uri": "file:///missing.txt" }. Do not signal a ' +
  'missing resource with an empty contents array — SEP-2164 rules that out as ambiguous. Note this ' +
  'is a server-side obligation only: if this repository also acts as a client, keep accepting ' +
  '-32002 from older servers.';

/* -------------------------------------------------------------------------- */
/* MCP2026-ERROR-001 — -32002 emitted for resource-not-found                   */
/* -------------------------------------------------------------------------- */

export const resourceNotFoundEmitRule: ScannerRule = {
  id: 'MCP2026-ERROR-001',
  title: 'Resource-not-found is reported with the superseded -32002 error code',
  category: 'resource-errors',
  targetVersion: DEFAULT_TARGET_VERSION,
  level: 'error',
  defaultConfidence: 'high',
  source: SOURCES.sep2164,
  appliesTo: {
    fileKinds: ['ts', 'js'],
    transports: ['stdio', 'streamable-http', 'mixed', 'custom-http', 'unknown'],
  },
  autofix: 'suggested',
  description:
    'Detects -32002 being emitted as a resource-not-found error, using surrounding resource ' +
    'context and the position of the literal to distinguish emitting from accepting.',

  async scan(context: ScanContext): Promise<Finding[]> {
    const findings: Finding[] = [];

    for (const file of filesFor(this, context)) {
      const sourceFile = getSourceFile(file);
      if (!sourceFile) continue;

      for (const hit of collectNumericLiterals(sourceFile, -32002)) {
        if (isInComment(file, hit.start)) {
          const { line } = offsetToPosition(file, hit.start);
          context.noteCommentOnlyMatch(this.id, file.relPath, line, '-32002');
          continue;
        }
        // Client-side acceptance is correct. Never a finding.
        if (hit.usage === 'compare') continue;
        if (hit.usage !== 'emit' && hit.usage !== 'declare') continue;
        if (!hasContextNear(file, hit.start, RESOURCE_CONTEXT_NEEDLES)) continue;

        findings.push(
          buildFinding(
            this,
            { file, offset: hit.start, endOffset: hit.end, text: '-32002' },
            {
              confidence: hit.usage === 'emit' ? 'high' : 'medium',
              explanation:
                `${EXPLANATION_BASE} This literal appears in resource-handling code in a position ` +
                `that ${hit.usage === 'emit' ? 'emits' : 'defines'} the error code, so a server ` +
                'built from it would return the superseded value.',
              remediation: REMEDIATION_EMIT,
            },
          ),
        );
      }
    }

    return dedupeByLocation(findings);
  },
};

/* -------------------------------------------------------------------------- */
/* MCP2026-ERROR-002 — ambiguous -32002                                        */
/* -------------------------------------------------------------------------- */

export const resourceNotFoundAmbiguousRule: ScannerRule = {
  id: 'MCP2026-ERROR-002',
  title: 'Hardcoded -32002 with no clear resource context',
  category: 'resource-errors',
  targetVersion: DEFAULT_TARGET_VERSION,
  level: 'review',
  defaultConfidence: 'medium',
  source: SOURCES.sep2164,
  appliesTo: {
    fileKinds: ['ts', 'js', 'json'],
    transports: ['stdio', 'streamable-http', 'mixed', 'custom-http', 'unknown'],
  },
  autofix: 'manual',
  description:
    'Detects a hardcoded -32002 whose purpose cannot be determined from surrounding context.',

  async scan(context: ScanContext): Promise<Finding[]> {
    const findings: Finding[] = [];

    const explanation =
      `${EXPLANATION_BASE} This occurrence has no nearby resource-handling context, so this ` +
      'scanner cannot tell whether it is the resource-not-found code, an unrelated ' +
      'implementation-defined error, or a client accepting the old value. It is reported for ' +
      'review rather than treated as a break. The -32000 to -32019 range remains ' +
      'implementation-defined and existing SDK usage there is explicitly grandfathered.';

    const remediation =
      'Check what this code means. If it signals a missing resource from a server, change it to ' +
      '-32602 (Invalid Params). If it is a client accepting -32002 from an older server, leave it: ' +
      'the draft says clients SHOULD keep accepting it. If it is an unrelated ' +
      'implementation-defined error, no change is required.';

    for (const file of filesFor(this, context)) {
      const sourceFile = getSourceFile(file);

      if (sourceFile) {
        for (const hit of collectNumericLiterals(sourceFile, -32002)) {
          if (isInComment(file, hit.start)) continue;
          if (hit.usage === 'compare') continue;
          if (hasContextNear(file, hit.start, RESOURCE_CONTEXT_NEEDLES)) continue;
          findings.push(
            buildFinding(
              this,
              { file, offset: hit.start, endOffset: hit.end, text: '-32002' },
              { explanation, remediation },
            ),
          );
        }
        continue;
      }

      // JSON has no AST pass; match the literal directly.
      for (const { hit } of matches(context, this, file, /(?<![\d.])-32002(?![\d.])/g)) {
        findings.push(buildFinding(this, hit, { explanation, remediation }));
      }
    }

    return dedupeByLocation(findings);
  },
};

export const resourceErrorRules: ScannerRule[] = [
  resourceNotFoundEmitRule,
  resourceNotFoundAmbiguousRule,
];
