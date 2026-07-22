import { DEFAULT_TARGET_VERSION, SOURCES } from '../../constants.js';
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

/**
 * Callee shapes that fetch roots. Matched against actual call expressions
 * (never declarations), and only in files with an MCP signal — `listRoots` is
 * an ordinary identifier in filesystem utilities.
 */
/**
 * A `capabilities.roots` path is self-evidencing. A bare top-level `roots` key
 * is not — Jest configs declare `roots` — so it only counts with
 * capability/MCP vocabulary nearby, and only as the exact key.
 */
const ROOTS_CAPABILITY_PATH = /(^|\.)capabilities\.roots(\.|$)/;
const ROOTS_BARE_PATH = /^roots$/;
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

      const localMcp = fileHasMcpSignal(file);

      for (const { hit } of matches(context, this, file, quotedLiteral(ROOTS_METHOD_LITERALS))) {
        if (!sourceFile || !isExecutableProtocolLiteral(sourceFile, hit.offset)) continue;
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
        if (!sourceFile || !isMcpSdkIdentifier(sourceFile, hit.offset)) continue;
        findings.push(
          buildFinding(this, hit, {
            title: `Deprecated Roots type (${hit.text})`,
            explanation: DEPRECATION_STATEMENT,
            remediation: MIGRATION_GUIDANCE,
          }),
        );
      }

      if (!sourceFile) continue;

      for (const call of collectCalls(sourceFile)) {
        if (
          !localMcp ||
          !/(?:^|\.)(?:mcpServer|server|mcp|requestContext|context|ctx|extra)\.listRoots$/.test(
            call.name,
          )
        ) {
          continue;
        }
        findings.push(
          buildFinding(
            this,
            { file, offset: call.start, endOffset: call.end, text: call.name },
            {
              title: 'Deprecated Roots request call',
              explanation: DEPRECATION_STATEMENT,
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
        const explicit = ROOTS_CAPABILITY_PATH.test(property.path);
        const bare =
          ROOTS_BARE_PATH.test(property.path) &&
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

/**
 * `sendRootsListChanged` is an instance method on the SDK `Client`, so it never
 * appears in an import statement. Matching it only as an imported identifier
 * meant a client emitting the removed notification scanned completely clean.
 */
const ROOTS_CHANGED_CALL_NAMES = [/(^|\.)sendRootsListChanged$/];

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
      const sourceFile = getSourceFile(file);
      for (const { hit } of matches(context, this, file, quotedLiteral(ROOTS_CHANGED_LITERALS))) {
        if (!sourceFile || !isExecutableProtocolLiteral(sourceFile, hit.offset)) continue;
        findings.push(
          buildFinding(this, hit, {
            ...legacyEraFindingOverride(file, sourceFile, hit.offset),
            explanation,
            remediation,
          }),
        );
      }
      for (const { hit } of matches(
        context,
        this,
        file,
        identifierLiteral(ROOTS_CHANGED_IDENTIFIERS),
      )) {
        if (!sourceFile || !isMcpSdkIdentifier(sourceFile, hit.offset)) continue;
        findings.push(
          buildFinding(this, hit, {
            ...legacyEraFindingOverride(file, sourceFile, hit.offset),
            title: `SDK surface for the removed roots notification (${hit.text})`,
            explanation,
            remediation,
          }),
        );
      }

      if (!sourceFile || !fileHasMcpSignal(file)) continue;
      for (const call of collectCalls(sourceFile)) {
        if (!ROOTS_CHANGED_CALL_NAMES.some((pattern) => pattern.test(call.name))) continue;
        if (isInComment(file, call.start)) continue;
        findings.push(
          buildFinding(
            this,
            { file, offset: call.start, endOffset: call.end, text: call.name },
            {
              ...legacyEraFindingOverride(file, sourceFile, call.start),
              title: `SDK surface for the removed roots notification (${call.name})`,
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

export const rootsRules: ScannerRule[] = [rootsDeprecationRule, rootsListChangedRule];
