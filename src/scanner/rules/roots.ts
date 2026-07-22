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
 * Group 6 — Roots deprecation (SEP-2577), plus one removal.
 *
 * The Roots *feature* is deprecated and still works, so `MCP2026-ROOTS-001` is a
 * WARNING. `notifications/roots/list_changed` is a different matter: the
 * changelog removes it outright, so `MCP2026-ROOTS-002` is an ERROR. Keeping
 * them apart is what stops the report describing a deprecation as breaking.
 */

const DEPRECATION_STATEMENT =
  'Roots is deprecated as of MCP 2026-07-28 (SEP-2577). It is not removed: deprecated features ' +
  '"remain fully functional during the deprecation window", and the feature lifecycle policy ' +
  'guarantees a minimum twelve-month window — the deprecated-features registry records the ' +
  'earliest removal as the first revision released on or after 2027-07-28. Existing Roots code ' +
  'keeps working against a 2026-07-28 server.';

const MIGRATION_GUIDANCE =
  'Do not add Roots to new code. To migrate, take the directory or file context from somewhere ' +
  'explicit instead: a tool parameter, a resource URI, server configuration, or environment ' +
  'configuration — the three the changelog names are "tool parameters, resource URIs, or server ' +
  'configuration". Two cautions. Roots is not an access-control mechanism and never was, so do not ' +
  'treat the roots list as a security boundary that is being lost. And do not remove filesystem ' +
  'safeguards as part of this change: path normalisation, symlink resolution, allowlist checks and ' +
  'sandboxing must stay exactly as they are, whatever supplies the directory list.';

const ROOTS_METHOD_LITERALS = ['roots/list'];

const ROOTS_IDENTIFIERS = [
  'ListRootsRequestSchema',
  'ListRootsResultSchema',
  'ListRootsRequest',
  'ListRootsResult',
  'RootsCapability',
];

const ROOTS_CALLS = [/\b(?:server|mcpServer|client|this)\.listRoots\s*\(/g, /\blistRoots\s*\(/g];

/**
 * Only a genuine top-level capability declaration counts. A nested key such as
 * `capabilities.tasks.requests.roots` is a different feature and is handled by
 * its own rule.
 */
const ROOTS_CAPABILITY_PATHS = [/^capabilities\.roots(\.|$)/, /^roots(\.|$)/];

export const rootsDeprecationRule: ScannerRule = {
  id: 'MCP2026-ROOTS-001',
  title: 'Roots is deprecated in the target specification',
  category: 'roots',
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
    'Detects the roots client capability, roots/list, Root schema types, and server behaviour that ' +
    'relies on roots for working-directory or filesystem context.',

  async scan(context: ScanContext): Promise<Finding[]> {
    const findings: Finding[] = [];

    for (const file of filesFor(this, context)) {
      const sourceFile = getSourceFile(file);

      for (const { hit } of matches(context, this, file, quotedLiteral(ROOTS_METHOD_LITERALS))) {
        findings.push(
          buildFinding(this, hit, {
            title: 'Deprecated Roots method (roots/list)',
            explanation: `${DEPRECATION_STATEMENT} Separately, and independently of the ` +
              'deprecation, roots/list is no longer a server-initiated request: under Multi ' +
              'Round-Trip Requests a server returns an InputRequiredResult carrying the request ' +
              'for roots, and the client answers on a retry of the original request.',
            remediation: MIGRATION_GUIDANCE,
          }),
        );
      }

      for (const { hit } of matches(context, this, file, identifierLiteral(ROOTS_IDENTIFIERS))) {
        findings.push(
          buildFinding(this, hit, {
            title: `Deprecated Roots type (${hit.text})`,
            explanation: DEPRECATION_STATEMENT,
            remediation: MIGRATION_GUIDANCE,
          }),
        );
      }

      for (const pattern of ROOTS_CALLS) {
        for (const { hit } of matches(context, this, file, pattern)) {
          findings.push(
            buildFinding(this, hit, {
              title: 'Server relies on deprecated Roots for filesystem context',
              explanation: `${DEPRECATION_STATEMENT} This call asks the client for its roots, which ` +
                'under Multi Round-Trip Requests is no longer a request the server can issue ' +
                'directly on a stream.',
              remediation: MIGRATION_GUIDANCE,
              confidence: 'high',
            }),
          );
        }
      }

      if (!sourceFile) continue;
      for (const property of collectPropertyPaths(sourceFile)) {
        if (!ROOTS_CAPABILITY_PATHS.some((pattern) => pattern.test(property.path))) continue;
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
              title: 'Deprecated Roots capability declaration',
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
/* MCP2026-ROOTS-002 — removed roots list-changed notification                 */
/* -------------------------------------------------------------------------- */

const ROOTS_CHANGED_LITERALS = ['notifications/roots/list_changed'];
const ROOTS_CHANGED_IDENTIFIERS = ['RootsListChangedNotificationSchema', 'sendRootsListChanged'];

export const rootsListChangedRule: ScannerRule = {
  id: 'MCP2026-ROOTS-002',
  title: 'notifications/roots/list_changed is removed in the target specification',
  category: 'roots',
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
    'Detects the removed notifications/roots/list_changed notification and its SDK surface. This ' +
    'is a removal, distinct from the Roots deprecation.',

  async scan(context: ScanContext): Promise<Finding[]> {
    const findings: Finding[] = [];

    const explanation =
      'notifications/roots/list_changed is removed in MCP 2026-07-28 — not deprecated. The ' +
      'changelog reads "Remove ping, logging/setLevel, and notifications/roots/list_changed", and ' +
      'SEP-2575 explains it: "Roots are fetched on demand via MRTR, so there is no need for a ' +
      'change notification." Note that the Roots feature as a whole is separately deprecated but ' +
      'still functional; only this notification is gone.';

    const remediation =
      'Remove the notification and any handler for it. Nothing needs to replace it: roots are ' +
      'requested on demand rather than cached and invalidated, so there is no cache to keep fresh. ' +
      'While making this change, consider the Roots deprecation as a whole and move the directory ' +
      'context to a tool parameter, resource URI or server configuration.';

    for (const file of filesFor(this, context)) {
      for (const { hit } of matches(context, this, file, quotedLiteral(ROOTS_CHANGED_LITERALS))) {
        findings.push(buildFinding(this, hit, { explanation, remediation }));
      }
      for (const { hit } of matches(
        context,
        this,
        file,
        identifierLiteral(ROOTS_CHANGED_IDENTIFIERS),
      )) {
        findings.push(
          buildFinding(this, hit, {
            title: `SDK surface for the removed roots notification (${hit.text})`,
            explanation,
            remediation,
          }),
        );
      }
    }

    return dedupeByLocation(findings);
  },
};

export const rootsRules: ScannerRule[] = [rootsDeprecationRule, rootsListChangedRule];
