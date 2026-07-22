import ts from 'typescript';
import { DEFAULT_TARGET_VERSION, META_KEYS } from '../../constants.js';
import type { Finding, PreparedFile, ScanContext, ScannerRule } from '../../types.js';
import {
  calleeName,
  collectCalls,
  collectNumericLiterals,
  getSourceFile,
  nodeAt,
  propertyKeyText,
  walk,
} from '../ast.js';
import { isInComment } from '../discovery.js';
import {
  buildFinding,
  dedupeByLocation,
  fileHasMcpSignal,
  filesFor,
  hasContextNear,
  identifierLiteral,
  isLegacyEraGuarded,
  isClientOnlyMcpFile,
  isMcpSdkIdentifier,
  isProvenErrorEmission,
  legacyEraFindingOverride,
  matches,
  quotedLiteral,
} from './helpers.js';

const ALL_TRANSPORTS = ['stdio', 'streamable-http', 'mixed', 'custom-http', 'unknown'] as const;

const SOURCES = {
  sdkMigration: {
    title: 'MCP TypeScript SDK v2 migration - Supporting the 2026-07-28 protocol',
    url: 'https://ts.sdk.modelcontextprotocol.io/v2/migration/support-2026-07-28',
  },
  mrtr: {
    title: 'MCP draft specification - Multi Round-Trip Requests',
    url: 'https://modelcontextprotocol.io/specification/draft/basic/patterns/mrtr',
  },
  base: {
    title: 'MCP draft specification - Base protocol',
    url: 'https://modelcontextprotocol.io/specification/draft/basic/index',
  },
  discovery: {
    title: 'MCP draft specification - Server discovery',
    url: 'https://modelcontextprotocol.io/specification/draft/server/discover',
  },
  caching: {
    title: 'MCP draft specification - Caching',
    url: 'https://modelcontextprotocol.io/specification/draft/server/utilities/caching',
  },
  tasks: {
    title: 'SEP-2663 - Tasks Extension',
    url: 'https://modelcontextprotocol.io/seps/2663-tasks-extension',
    sep: 'SEP-2663',
  },
  elicitation: {
    title: 'MCP draft specification - Elicitation',
    url: 'https://modelcontextprotocol.io/specification/draft/client/elicitation',
  },
} as const;

/* -------------------------------------------------------------------------- */
/* MCP2026-SDK-001 - serving entry points                                      */
/* -------------------------------------------------------------------------- */

export const legacySdkEntrypointRule: ScannerRule = {
  id: 'MCP2026-SDK-001',
  title: 'SDK entry point only serves the 2025 protocol era',
  category: 'stateless-lifecycle',
  targetVersion: DEFAULT_TARGET_VERSION,
  level: 'error',
  defaultConfidence: 'high',
  source: SOURCES.sdkMigration,
  appliesTo: { fileKinds: ['ts', 'js', 'json'], transports: [...ALL_TRANSPORTS] },
  autofix: 'manual',
  description:
    'Detects direct Server/McpServer transport connections that the official TypeScript SDK documents as legacy-era only.',

  async scan(context: ScanContext): Promise<Finding[]> {
    const findings: Finding[] = [];

    for (const manifest of filesFor(this, context).filter(
      (file) => file.kind === 'json' && /(?:^|\/)package\.json$/.test(file.relPath),
    )) {
      if (manifestDeclaresLegacySdk(manifest.content)) {
        const match = /['"]@modelcontextprotocol\/sdk['"]\s*:/.exec(manifest.content);
        if (match) {
          findings.push(
            buildFinding(
              this,
              {
                file: manifest,
                offset: match.index,
                endOffset: match.index + match[0].length,
                text: '@modelcontextprotocol/sdk',
              },
              {
                level: 'review',
                confidence: 'medium',
                title: 'Legacy monolithic TypeScript SDK dependency needs migration review',
                explanation:
                  'The official TypeScript SDK migration guide states that @modelcontextprotocol/sdk v1 only speaks the 2025 protocol era. A manifest entry alone does not prove this package serves a target-era endpoint: it may be client-only, development tooling, or an isolated legacy endpoint, so the dependency requires review rather than removal by assumption.',
                remediation:
                  'Migrate server code to @modelcontextprotocol/server and the appropriate transport adapter. Use createMcpHandler(factory) for HTTP or serveStdio(factory) for stdio. Retain @modelcontextprotocol/sdk only when an explicitly selected legacy endpoint still needs it.',
              },
            ),
          );
        }
      }
    }

    for (const file of filesFor(this, context)) {
      const sourceFile = getSourceFile(file);
      if (!sourceFile || !fileHasMcpSignal(file)) continue;

      const v1File = /['"`]@modelcontextprotocol\/sdk\/server\//.test(file.content);
      for (const call of collectCalls(sourceFile)) {
        if (!/(^|\.)connect$/.test(call.name)) continue;
        const transportText = call.node.arguments[0]?.getText(sourceFile) ?? '';
        if (!/\b(?:Stdio|StreamableHTTP)ServerTransport\b/.test(transportText)) continue;

        const isDirectServerConnection =
          v1File ||
          /\bStdioServerTransport\b/.test(transportText) ||
          /\bStreamableHTTPServerTransport\b/.test(transportText);
        if (!isDirectServerConnection) continue;

        findings.push(
          buildFinding(
            this,
            { file, offset: call.start, endOffset: call.end, text: call.name },
            {
              ...legacyEraFindingOverride(file, sourceFile, call.start),
              explanation:
                'The official TypeScript SDK migration guide states that a hand-constructed Server or McpServer connected directly to a transport keeps speaking the 2025-era protocol. Updating package versions alone does not put 2026-07-28 messages on the wire.',
              remediation:
                'Upgrade to @modelcontextprotocol/server and a v2 transport adapter. Serve HTTP with createMcpHandler(factory), or stdio with serveStdio(() => buildServer()). Keep this direct connection only inside an explicitly selected legacy-era branch when intentionally serving both eras.',
            },
          ),
        );
      }
    }

    return dedupeByLocation(findings);
  },
};

function manifestDeclaresLegacySdk(content: string): boolean {
  try {
    const parsed = JSON.parse(content) as Record<string, unknown>;
    return ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'].some(
      (field) => {
        const entries = parsed[field];
        return Boolean(
          entries &&
            typeof entries === 'object' &&
            !Array.isArray(entries) &&
            Object.prototype.hasOwnProperty.call(entries, '@modelcontextprotocol/sdk'),
        );
      },
    );
  } catch {
    return false;
  }
}

/* -------------------------------------------------------------------------- */
/* MCP2026-MRTR-001 - removed independent server request channel               */
/* -------------------------------------------------------------------------- */

const MRTR_METHODS = ['roots/list', 'sampling/createMessage', 'elicitation/create'];

export const directServerRequestRule: ScannerRule = {
  id: 'MCP2026-MRTR-001',
  title: 'Server-to-client request uses the removed independent request channel',
  category: 'stateless-lifecycle',
  targetVersion: DEFAULT_TARGET_VERSION,
  level: 'error',
  defaultConfidence: 'high',
  source: SOURCES.mrtr,
  appliesTo: { fileKinds: ['ts', 'js'], transports: [...ALL_TRANSPORTS] },
  autofix: 'manual',
  description:
    'Detects direct Roots, Sampling, or Elicitation requests that must instead be embedded in an InputRequiredResult.',

  async scan(context: ScanContext): Promise<Finding[]> {
    const findings: Finding[] = [];

    for (const file of filesFor(this, context)) {
      const sourceFile = getSourceFile(file);
      if (!sourceFile || !fileHasMcpSignal(file)) continue;

      for (const call of collectCalls(sourceFile)) {
        const direct = directMrtrCall(call.name);
        const sent = direct ? null : methodSentByCall(call.node);
        if (sent?.direction === 'client') continue;
        const method = direct?.method ?? sent?.method;
        if (!method) continue;
        const ambiguousDirection = direct?.direction === 'ambiguous' || sent?.direction === 'ambiguous';

        findings.push(
          buildFinding(
            this,
            { file, offset: call.start, endOffset: call.end, text: method },
            {
              ...(ambiguousDirection
                ? { level: 'review' as const, confidence: 'medium' as const }
                : {}),
              ...legacyEraFindingOverride(file, sourceFile, call.start),
              title: `Direct server request must migrate to MRTR (${method})`,
              explanation:
                `MCP 2026-07-28 no longer permits a server to initiate ${method} as an independent JSON-RPC request. The MRTR specification calls this a breaking change. The method remains valid only as a request object inside InputRequiredResult.inputRequests.`,
              remediation:
                'Return an InputRequiredResult with resultType "input_required" and place this request under inputRequests. On the retried original request, consume the matching inputResponses entry. With the v2 TypeScript SDK, use inputRequired(...) rather than a direct request API.',
            },
          ),
        );
      }
    }

    return dedupeByLocation(findings);
  },
};

const MRTR_PARENT_METHODS = new Set(['prompts/get', 'resources/read', 'tools/call']);

export const inputRequiredShapeRule: ScannerRule = {
  id: 'MCP2026-MRTR-002',
  title: 'InputRequiredResult has an invalid target-era shape',
  category: 'stateless-lifecycle',
  targetVersion: DEFAULT_TARGET_VERSION,
  level: 'error',
  defaultConfidence: 'high',
  source: SOURCES.mrtr,
  appliesTo: { fileKinds: ['ts', 'js'], transports: [...ALL_TRANSPORTS] },
  autofix: 'suggested',
  description:
    'Validates explicit executable input_required results and their directly associated parent request method.',

  async scan(context: ScanContext): Promise<Finding[]> {
    const findings: Finding[] = [];
    for (const file of filesFor(this, context)) {
      const sourceFile = getSourceFile(file);
      if (!sourceFile || !fileHasMcpSignal(file)) continue;

      walk(sourceFile, (node) => {
        if (!ts.isObjectLiteralExpression(node)) return;
        if (stringProperty(node, 'resultType') !== 'input_required') return;
        if (!isExecutableProtocolObject(node)) return;

        const inputRequests = property(node, 'inputRequests');
        const requestState = property(node, 'requestState');
        const inputRequestsShorthand = shorthandProperty(node, 'inputRequests');
        const requestStateShorthand = shorthandProperty(node, 'requestState');
        const opaqueShape = hasOpaqueProperties(node);
        const inputRequestsIsEmpty =
          inputRequests &&
          ts.isObjectLiteralExpression(inputRequests.initializer) &&
          inputRequests.initializer.properties.length === 0;
        if (
          (!inputRequests || inputRequestsIsEmpty) &&
          !inputRequestsShorthand &&
          !requestState &&
          !requestStateShorthand
        ) {
          const start = node.getStart(sourceFile, false);
          findings.push(
            buildFinding(
              this,
              { file, offset: start, endOffset: node.getEnd(), text: 'input_required' },
              {
                ...legacyEraFindingOverride(file, sourceFile, start),
                ...(opaqueShape
                  ? { level: 'review' as const, confidence: 'medium' as const }
                  : {}),
                title: opaqueShape
                  ? 'InputRequiredResult fields cannot be verified through an object spread'
                  : 'InputRequiredResult provides neither inputRequests nor requestState',
                explanation: opaqueShape
                  ? 'An InputRequiredResult must carry inputRequests, requestState, or both. This explicit object has neither field, but an object spread may provide one at runtime.'
                  : 'An InputRequiredResult may carry keyed client requests, opaque requestState, or both, but the MRTR server requirements require at least one of those fields. This explicit result provides neither.',
                remediation:
                  'Add a non-empty inputRequests object containing the required roots/list, sampling/createMessage, or elicitation/create entries, or add integrity-protected requestState when only retry correlation is needed.',
              },
            ),
          );
        } else if (
          (inputRequests && !ts.isObjectLiteralExpression(inputRequests.initializer)) ||
          inputRequestsShorthand ||
          requestStateShorthand
        ) {
          const dynamicEntry = inputRequests ?? inputRequestsShorthand ?? requestStateShorthand;
          if (!dynamicEntry) return;
          const start = dynamicEntry.getStart(sourceFile, false);
          findings.push(
            buildFinding(
              this,
              { file, offset: start, endOffset: dynamicEntry.getEnd(), text: 'InputRequiredResult' },
              {
                ...legacyEraFindingOverride(file, sourceFile, start),
                level: 'review',
                confidence: 'medium',
                title: 'InputRequiredResult fields cannot be verified statically',
                explanation:
                  'The target requires inputRequests, requestState, or both, but this explicit result obtains a required field through a dynamic expression or shorthand property.',
                remediation:
                  'Verify that inputRequests is a non-empty keyed object of valid client requests or that requestState is present and integrity-protected.',
              },
            ),
          );
        }

        if (inputRequests && ts.isObjectLiteralExpression(inputRequests.initializer)) {
          for (const entry of inputRequests.initializer.properties) {
            const entryStart = entry.getStart(sourceFile, false);
            if (
              ts.isSpreadAssignment(entry) ||
              !ts.isPropertyAssignment(entry) ||
              !ts.isObjectLiteralExpression(entry.initializer)
            ) {
              findings.push(
                buildFinding(
                  this,
                  { file, offset: entryStart, endOffset: entry.getEnd(), text: 'inputRequests' },
                  {
                    level: 'review',
                    confidence: 'medium',
                    title: 'InputRequiredResult request entry cannot be verified statically',
                    explanation:
                      'Each inputRequests value must be a client request. A spread, shorthand, computed, or dynamic entry prevents this scanner from checking its method.',
                    remediation:
                      'Verify that every runtime entry is a roots/list, sampling/createMessage, or elicitation/create client request.',
                  },
                ),
              );
              continue;
            }
            const method = stringProperty(entry.initializer, 'method');
            if (method && MRTR_METHODS.includes(method)) continue;
            findings.push(
              buildFinding(
                this,
                { file, offset: entryStart, endOffset: entry.getEnd(), text: method ?? 'input request' },
                {
                  title: method
                    ? `InputRequiredResult contains invalid client request ${method}`
                    : 'InputRequiredResult entry omits a literal client request method',
                  explanation:
                    'Core MRTR inputRequests may contain roots/list, sampling/createMessage, or elicitation/create client requests. This explicit entry is not one of those shapes.',
                  remediation:
                    'Use a supported client request method in this entry, or remove it from inputRequests.',
                },
              ),
            );
          }
        }

        const association = directlyAssociatedHandlerMethod(node);
        if (!association || MRTR_PARENT_METHODS.has(association.method)) return;
        findings.push(
          buildFinding(
            this,
            {
              file,
              offset: association.node.getStart(sourceFile, false),
              endOffset: association.node.getEnd(),
              text: association.method,
            },
            {
              ...legacyEraFindingOverride(file, sourceFile, association.node.getStart(sourceFile, false)),
              title: `InputRequiredResult is not allowed from ${association.method}`,
              explanation:
                'Core InputRequiredResult is supported only by prompts/get, resources/read, and tools/call. This result is directly returned from a handler registered for another method.',
              remediation:
                'Complete this request without MRTR, or move the input-required interaction into a supported prompts/get, resources/read, or tools/call flow.',
            },
          ),
        );
      });
    }
    return dedupeByLocation(findings);
  },
};

export const requestStateIntegrityRule: ScannerRule = {
  id: 'MCP2026-MRTR-003',
  title: 'Decoded requestState influences sensitive behavior without visible integrity verification',
  category: 'stateless-lifecycle',
  targetVersion: DEFAULT_TARGET_VERSION,
  level: 'review',
  defaultConfidence: 'medium',
  source: SOURCES.mrtr,
  appliesTo: { fileKinds: ['ts', 'js'], transports: [...ALL_TRANSPORTS] },
  autofix: 'manual',
  description:
    'Conservatively identifies locally decoded MRTR requestState used in sensitive branching without a same-function verification signal.',

  async scan(context: ScanContext): Promise<Finding[]> {
    const findings: Finding[] = [];
    for (const file of filesFor(this, context)) {
      const sourceFile = getSourceFile(file);
      if (!sourceFile || !fileHasMcpSignal(file)) continue;
      const reportedFunctions = new Set<number>();

      walk(sourceFile, (node) => {
        if (!ts.isIdentifier(node) || node.text !== 'requestState') return;
        const fn = containingFunction(node);
        if (!fn || reportedFunctions.has(fn.pos)) return;
        const text = fn.getText(sourceFile);
        const decodes =
          /JSON\.parse\s*\([\s\S]{0,240}\brequestState\b/.test(text) ||
          /(?:atob|Buffer\.from)\s*\([\s\S]{0,160}\brequestState\b[\s\S]{0,80}(?:base64|base64url)?/.test(
            text,
          );
        const sensitiveBranch =
          /\b(?:if|switch)\s*\([\s\S]{0,300}\b(?:userId|tenantId|accountId|role|permission|authorized|authorization|scope|plan|ownerId)\b/i.test(
            text,
          );
        const verifiesLocally =
          /\b(?:verify|verifyRequestState|verifySignature|createHmac|timingSafeEqual|validateMac|checkSignature)\s*\(/i.test(
            text,
          );
        if (!decodes || !sensitiveBranch || verifiesLocally) return;

        reportedFunctions.add(fn.pos);
        const start = node.getStart(sourceFile, false);
        findings.push(
          buildFinding(
            this,
            { file, offset: start, endOffset: node.getEnd(), text: 'requestState' },
            {
              title: 'Decoded requestState influences a sensitive branch',
              explanation:
                'The client must treat requestState as opaque, and the server must protect its integrity. This function visibly decodes requestState and uses identity, authorization, or tenant data in a branch, but no verification primitive is visible in the same function. Static analysis cannot exclude verification performed by a wrapper.',
              remediation:
                'Use authenticated encryption or a keyed MAC and verify before decoding or trusting state, or keep correlation in server-owned storage. Review any wrapper contract before changing code.',
            },
          ),
        );
      });
    }
    return dedupeByLocation(findings);
  },
};

function directMrtrCall(
  name: string,
): { method: string; direction: 'server' | 'ambiguous' } | null {
  if (/\binputRequired\./.test(name)) return null;
  // `mcp` is as common a binding for an McpServer as `server` is — it is the
  // name used throughout the SDK's own examples — and omitting it meant
  // `mcp.elicitInput(...)` produced no finding from any rule at all.
  const strong = '(?:server|mcpServer|mcp|this\\.server|this\\.mcp)';
  const wrapper = '(?:session|peer|requestContext|context|ctx|extra|this\\.session)';
  const classify = (suffix: string, method: string) => {
    if (new RegExp(`(?:^|\\.)${strong}\\.${suffix}$`, 'i').test(name)) {
      return { method, direction: 'server' as const };
    }
    if (new RegExp(`(?:^|\\.)${wrapper}\\.${suffix}$`, 'i').test(name)) {
      return { method, direction: 'ambiguous' as const };
    }
    return null;
  };
  return (
    classify('listRoots', 'roots/list') ??
    classify('(?:requestSampling|createMessage)', 'sampling/createMessage') ??
    classify('elicitInput', 'elicitation/create')
  );
}

function methodSentByCall(
  call: ts.CallExpression,
): { method: string; direction: 'server' | 'client' | 'ambiguous' } | null {
  const name = calleeName(call);
  if (!/(^|\.)(?:send|request|sendRequest)$/.test(name)) return null;
  const first = call.arguments[0];
  if (!first || !ts.isObjectLiteralExpression(first)) return null;
  const method = stringProperty(first, 'method');
  if (!method || !MRTR_METHODS.includes(method)) return null;
  if (/^(?:client|mcpClient|this\.client)\./i.test(name)) {
    return { method, direction: 'client' };
  }
  if (/(?:^|\.)(?:server|mcpServer|this\.server)\.(?:send|request|sendRequest)$/i.test(name)) {
    return { method, direction: 'server' };
  }
  if (
    /(?:^|\.)(?:session|peer|requestContext|context|ctx|extra|this\.session)\.(?:send|request|sendRequest)$/i.test(
      name,
    )
  ) {
    return { method, direction: 'ambiguous' };
  }
  return { method, direction: 'ambiguous' };
}

/* -------------------------------------------------------------------------- */
/* MCP2026-ELICITATION-001 - removed 2025 elicitation surfaces                 */
/* -------------------------------------------------------------------------- */

const REMOVED_ELICITATION_LITERALS = ['notifications/elicitation/complete'];
const REMOVED_ELICITATION_IDENTIFIERS = [
  'ElicitationCompleteNotificationSchema',
  'createElicitationCompletionNotifier',
  'UrlElicitationRequiredError',
];

export const removedElicitationSurfaceRule: ScannerRule = {
  id: 'MCP2026-ELICITATION-001',
  title: 'Elicitation surface is removed in the target specification',
  category: 'stateless-lifecycle',
  targetVersion: DEFAULT_TARGET_VERSION,
  level: 'error',
  defaultConfidence: 'high',
  source: SOURCES.elicitation,
  appliesTo: { fileKinds: ['ts', 'js', 'json'], transports: [...ALL_TRANSPORTS] },
  autofix: 'manual',
  description:
    'Detects the removed elicitation completion notification, URL elicitation ID, and URL-required error surface.',

  async scan(context: ScanContext): Promise<Finding[]> {
    const findings: Finding[] = [];

    for (const file of filesFor(this, context)) {
      const sourceFile = getSourceFile(file);
      const localMcp = fileHasMcpSignal(file);

      for (const { hit } of matches(
        context,
        this,
        file,
        quotedLiteral(REMOVED_ELICITATION_LITERALS),
      )) {
        if (!sourceFile || !isExecutableLiteralAt(sourceFile, hit.offset)) continue;
        findings.push(
          buildFinding(this, hit, {
            ...legacyEraFindingOverride(file, sourceFile, hit.offset),
            explanation:
              'notifications/elicitation/complete is removed. Under MRTR the client retries the original request, so a separate server-initiated completion signal no longer fits the protocol.',
            remediation:
              'Remove this notification. Determine completion when the original request is retried, using verified requestState or server-owned state where correlation is required.',
          }),
        );
      }

      for (const { hit } of matches(
        context,
        this,
        file,
        identifierLiteral(REMOVED_ELICITATION_IDENTIFIERS),
      )) {
        if (!sourceFile || !isMcpSdkIdentifier(sourceFile, hit.offset)) continue;
        findings.push(
          buildFinding(this, hit, {
            ...legacyEraFindingOverride(file, sourceFile, hit.offset),
            title: `Removed Elicitation SDK surface (${hit.text})`,
            explanation:
              'The 2026-07-28 MRTR flow removes the URL-elicitation-required error and completion notifier APIs used by the 2025 protocol flow.',
            remediation:
              'Return inputRequired({ inputRequests: { ... } }) and use an elicitation/create input request. Handle the matching inputResponses value on retry.',
          }),
        );
      }

      if (!sourceFile || !localMcp) continue;
      walk(sourceFile, (node) => {
        if (!ts.isPropertyAssignment(node) || propertyKeyText(node.name) !== 'elicitationId') return;
        const start = node.getStart(sourceFile, false);
        if (isInComment(file, start)) return;
        if (!hasContextNear(file, start, ['elicitation', 'mode', 'url'], 500, node.getEnd())) return;
        findings.push(
          buildFinding(
            this,
            { file, offset: start, endOffset: node.getEnd(), text: 'elicitationId' },
            {
              ...legacyEraFindingOverride(file, sourceFile, start),
              title: 'URL elicitation uses the removed elicitationId field',
              explanation:
                'The target removes elicitationId from URL-mode elicitation. Correlation now occurs when the client retries the original request.',
              remediation:
                'Remove elicitationId. Encode only necessary correlation data in integrity-protected requestState, or keep correlation in server-owned state.',
            },
          ),
        );
      });

      for (const code of collectNumericLiterals(sourceFile, -32042)) {
        if (code.usage === 'compare' || code.usage === 'list') continue;
        if (!hasContextNear(file, code.start, ['elicitation', 'url'], 500, code.end)) continue;
        findings.push(
          buildFinding(
            this,
            { file, offset: code.start, endOffset: code.end, text: '-32042' },
            {
              ...(code.usage === 'emit'
                ? {}
                : { level: 'review' as const, confidence: 'medium' as const }),
              ...legacyEraFindingOverride(file, sourceFile, code.start),
              title: 'Target server emits the removed URL elicitation error code -32042',
              explanation:
                code.usage === 'emit'
                  ? 'Implementations of 2026-07-28 MUST NOT emit -32042. URL elicitation now uses an elicitation/create input request inside MRTR.'
                  : 'Implementations of 2026-07-28 MUST NOT emit -32042, but this occurrence is not proven to be server emission and may be a legacy-client compatibility declaration.',
              remediation:
                'Replace this error with an InputRequiredResult containing a URL-mode elicitation request.',
            },
          ),
        );
      }
    }

    return dedupeByLocation(findings);
  },
};

/* -------------------------------------------------------------------------- */
/* Raw JSON-RPC shape rules                                                    */
/* -------------------------------------------------------------------------- */

interface RawResultSite {
  file: PreparedFile;
  sourceFile: ts.SourceFile;
  response: ts.ObjectLiteralExpression;
  result: ts.ObjectLiteralExpression;
}

function rawResultSites(file: PreparedFile, sourceFile: ts.SourceFile): RawResultSite[] {
  const sites: RawResultSite[] = [];
  walk(sourceFile, (node) => {
    if (!ts.isObjectLiteralExpression(node)) return;
    if (stringProperty(node, 'jsonrpc') !== '2.0') return;
    const result = objectProperty(node, 'result');
    if (!result || !isExecutableProtocolObject(node)) return;
    sites.push({ file, sourceFile, response: node, result });
  });
  return sites;
}

export const requiredResultTypeRule: ScannerRule = {
  id: 'MCP2026-RESULT-001',
  title: 'Raw MCP result omits or misspells resultType',
  category: 'stateless-lifecycle',
  targetVersion: DEFAULT_TARGET_VERSION,
  level: 'error',
  defaultConfidence: 'high',
  source: SOURCES.base,
  appliesTo: { fileKinds: ['ts', 'js'], transports: [...ALL_TRANSPORTS] },
  autofix: 'suggested',
  description:
    'Detects explicit raw JSON-RPC result objects that omit the required resultType discriminator or use the obsolete camel-case spelling.',

  async scan(context: ScanContext): Promise<Finding[]> {
    const findings: Finding[] = [];
    for (const file of filesFor(this, context)) {
      const sourceFile = getSourceFile(file);
      if (!sourceFile || !fileHasMcpSignal(file) || isClientOnlyMcpFile(file)) continue;

      for (const site of rawResultSites(file, sourceFile)) {
        const resultTypeProperty = property(site.result, 'resultType');
        const resultTypeShorthand = shorthandProperty(site.result, 'resultType');
        const associatedMethod = directlyAssociatedMcpMethod(site.result);
        const hasMcpResultShape = MCP_RESULT_MARKERS.some((key) =>
          hasNamedProperty(site.result, key),
        );
        // A server can also bridge an unrelated JSON-RPC protocol. A file-level
        // MCP import is not enough to classify an otherwise generic response as
        // MCP; require a known handler/case or an MCP-specific result shape.
        if (!resultTypeProperty && !resultTypeShorthand && !associatedMethod && !hasMcpResultShape) {
          continue;
        }
        const value = resultTypeProperty ? literalString(resultTypeProperty.initializer) : null;
        if (resultTypeProperty && (value === 'complete' || value === 'input_required')) continue;
        if (value === 'task') {
          const shape = validateCreateTaskResult(site.result);
          const unsupportedMethod =
            associatedMethod !== null && associatedMethod.method !== 'tools/call'
              ? associatedMethod.method
              : null;
          if (shape.invalid.length === 0 && shape.dynamic.length === 0 && !unsupportedMethod) continue;

          const anchor = resultTypeProperty ?? site.result;
          const start = anchor.getStart(sourceFile, false);
          const shapeIsOpaque = hasOpaqueProperties(site.result);
          const definitive = Boolean(unsupportedMethod || (shape.invalid.length > 0 && !shapeIsOpaque));
          const details = [...shape.invalid, ...shape.dynamic];
          findings.push(
            buildFinding(
              this,
              { file, offset: start, endOffset: anchor.getEnd(), text: 'task' },
              {
                ...legacyEraFindingOverride(file, sourceFile, start),
                level: definitive ? 'error' : 'review',
                confidence: definitive ? 'high' : 'medium',
                source: SOURCES.tasks,
                title: unsupportedMethod
                  ? `CreateTaskResult is not supported for ${unsupportedMethod}`
                  : definitive
                    ? `CreateTaskResult has an invalid flattened Task shape (${details.join(', ')})`
                    : `CreateTaskResult shape needs review (${details.join(', ')})`,
                explanation:
                  'SEP-2663 defines CreateTaskResult as Result & Task. Its Task fields are flattened beside resultType, not nested under a task property. taskId, createdAt, and lastUpdatedAt are strings; status is one of working, input_required, completed, cancelled, or failed; ttlMs is an integer or null; and pollIntervalMs, when present, is an integer. The extension currently permits task augmentation only for tools/call.',
                remediation: unsupportedMethod
                  ? 'Return a standard complete result for this method. The current Tasks extension supports task augmentation only for tools/call.'
                  : 'Flatten taskId, status, createdAt, lastUpdatedAt, and ttlMs directly onto CreateTaskResult, correct the listed types or values, and remove any legacy nested task wrapper. Verify any dynamic or spread-provided fields at runtime.',
              },
            ),
          );
          continue;
        }
        const anchor = resultTypeProperty ?? resultTypeShorthand ?? site.result;
        const start = anchor.getStart(sourceFile, false);
        const dynamic = Boolean(resultTypeShorthand || (resultTypeProperty && value === null));
        const obsoleteCoreSpelling = value === 'inputRequired';
        const reviewOnly = Boolean(
          (resultTypeProperty || resultTypeShorthand) && !obsoleteCoreSpelling,
        );
        findings.push(
          buildFinding(
            this,
            {
              file,
              offset: start,
              endOffset: anchor.getEnd(),
              text: value ?? (resultTypeProperty ? 'resultType' : 'result'),
            },
            {
              ...legacyEraFindingOverride(file, sourceFile, start),
              ...(!resultTypeProperty && (resultTypeShorthand || hasOpaqueProperties(site.result))
                ? { level: 'review' as const, confidence: 'medium' as const }
                : {}),
              ...(!resultTypeProperty && !resultTypeShorthand && !associatedMethod
                ? { level: 'review' as const, confidence: 'medium' as const }
                : {}),
              ...(reviewOnly ? { level: 'review' as const, confidence: 'medium' as const } : {}),
              title: !resultTypeProperty && !resultTypeShorthand
                ? 'Raw JSON-RPC result omits required resultType'
                : dynamic
                  ? 'Raw JSON-RPC resultType cannot be verified statically'
                  : obsoleteCoreSpelling
                    ? 'Raw JSON-RPC resultType uses obsolete "inputRequired" spelling'
                    : `Raw JSON-RPC resultType requires extension-negotiation review ("${value ?? 'dynamic'}")`,
              explanation:
                'Every result in MCP 2026-07-28 MUST carry resultType. Core final results use "complete" and MRTR interim results use the exact value "input_required". Treating an absent field as complete is only backward-compatible client behavior for earlier-version servers. Extension values require an explicitly negotiated extension.',
              remediation: !resultTypeProperty && !resultTypeShorthand
                ? 'Add resultType: "complete" to this raw final result, or "input_required" for an MRTR interim result. Do not add this field to high-level v2 SDK handler return types; the SDK wire codec supplies it.'
                : obsoleteCoreSpelling
                  ? 'Change this core result type to the exact value "input_required".'
                  : 'Verify that this value comes from an extension both peers advertised. The official Tasks extension uses "task" with a task payload.',
            },
          ),
        );
      }
    }
    return dedupeByLocation(findings);
  },
};

export const requiredRequestMetadataRule: ScannerRule = {
  id: 'MCP2026-META-001',
  title: 'Raw MCP request omits required per-request metadata',
  category: 'stateless-lifecycle',
  targetVersion: DEFAULT_TARGET_VERSION,
  level: 'error',
  defaultConfidence: 'high',
  source: SOURCES.base,
  appliesTo: { fileKinds: ['ts', 'js'], transports: [...ALL_TRANSPORTS] },
  autofix: 'suggested',
  description:
    'Detects executable raw JSON-RPC request objects missing protocolVersion or clientCapabilities in params._meta.',

  async scan(context: ScanContext): Promise<Finding[]> {
    const findings: Finding[] = [];
    for (const file of filesFor(this, context)) {
      const sourceFile = getSourceFile(file);
      if (!sourceFile || !fileHasMcpSignal(file)) continue;

      walk(sourceFile, (node) => {
        if (!ts.isObjectLiteralExpression(node)) return;
        if (stringProperty(node, 'jsonrpc') !== '2.0') return;
        if (isInsideInputRequests(node)) return;
        const method = stringProperty(node, 'method');
        if (
          !method ||
          !isRecognizedMcpRequestMethod(method) ||
          !hasNamedProperty(node, 'id') ||
          !isExecutableProtocolObject(node)
        ) {
          return;
        }
        const paramsProperty = property(node, 'params');
        const paramsShorthand = shorthandProperty(node, 'params');
        const params = paramsProperty && ts.isObjectLiteralExpression(paramsProperty.initializer)
          ? paramsProperty.initializer
          : null;
        if ((paramsProperty && !params) || paramsShorthand) {
          const dynamicParams = paramsProperty ?? paramsShorthand;
          if (!dynamicParams) return;
          const start = dynamicParams.getStart(sourceFile, false);
          findings.push(
            buildFinding(
              this,
              { file, offset: start, endOffset: dynamicParams.getEnd(), text: method },
              {
                ...legacyEraFindingOverride(file, sourceFile, start),
                level: 'review',
                confidence: 'medium',
                title: `Raw ${method} request metadata cannot be verified statically`,
                explanation:
                  'Target-era requests require protocolVersion and clientCapabilities in params._meta, but this request supplies params through a dynamic expression.',
                remediation:
                  'Verify that the runtime params value always contains both reserved _meta fields, or construct the request through the official v2 Client.',
              },
            ),
          );
          return;
        }
        const paramsHasSpread = Boolean(
          params?.properties.some((entry) => ts.isSpreadAssignment(entry)),
        );
        const metaProperty = params ? property(params, '_meta') : undefined;
        const metaShorthand = params ? shorthandProperty(params, '_meta') : undefined;
        const meta = params ? objectProperty(params, '_meta') : null;
        const metaHasSpread = Boolean(
          meta?.properties.some((entry) => ts.isSpreadAssignment(entry)),
        );
        const metadataIsOpaque =
          Boolean(metaShorthand || (metaProperty && !meta)) ||
          (!metaProperty && !metaShorthand && paramsHasSpread) ||
          metaHasSpread;
        const missing = [META_KEYS.protocolVersion, META_KEYS.clientCapabilities].filter(
          (key) => !params || !meta || !property(meta, key),
        );
        if (missing.length === 0) return;

        const start = node.getStart(sourceFile, false);
        findings.push(
          buildFinding(
            this,
            { file, offset: start, endOffset: node.getEnd(), text: method },
            {
              ...legacyEraFindingOverride(file, sourceFile, start),
              ...(metadataIsOpaque
                ? { level: 'review' as const, confidence: 'medium' as const }
                : {}),
              title: `Raw ${method} request omits required _meta fields`,
              explanation:
                metadataIsOpaque
                  ? `Every target-era request must include ${META_KEYS.protocolVersion} and ${META_KEYS.clientCapabilities} in params._meta. A spread or dynamic metadata expression prevents this scanner from proving whether ${missing.join(' and ')} is present at runtime.`
                  : `Every target-era request must include ${META_KEYS.protocolVersion} and ${META_KEYS.clientCapabilities} in params._meta. This explicit raw request omits ${missing.join(' and ')}.`,
              remediation:
                'Add both required reserved fields to this raw request. clientInfo is recommended but optional. When using the official v2 Client with modern versionNegotiation, let the SDK attach the envelope instead of constructing raw JSON-RPC.',
            },
          ),
        );
      });
    }
    return dedupeByLocation(findings);
  },
};

export const discoveryShapeRule: ScannerRule = {
  id: 'MCP2026-DISCOVERY-001',
  title: 'server/discover result uses a stale identity shape',
  category: 'stateless-lifecycle',
  targetVersion: DEFAULT_TARGET_VERSION,
  level: 'review',
  defaultConfidence: 'high',
  source: SOURCES.discovery,
  appliesTo: { fileKinds: ['ts', 'js'], transports: [...ALL_TRANSPORTS] },
  autofix: 'suggested',
  description:
    'Detects explicit DiscoverResult-shaped objects with top-level or missing server identity metadata.',

  async scan(context: ScanContext): Promise<Finding[]> {
    const findings: Finding[] = [];
    const applicableFiles = filesFor(this, context);
    for (const file of applicableFiles) {
      const sourceFile = getSourceFile(file);
      if (!sourceFile || !fileHasMcpSignal(file) || isClientOnlyMcpFile(file)) continue;

      walk(sourceFile, (node) => {
        if (!ts.isObjectLiteralExpression(node)) return;
        if (!hasNamedProperty(node, 'supportedVersions') || !hasNamedProperty(node, 'capabilities')) return;
        if (!isExecutableProtocolObject(node)) return;
        const topLevel = property(node, 'serverInfo') ?? shorthandProperty(node, 'serverInfo');
        const meta = objectProperty(node, '_meta');
        const nested = meta ? property(meta, 'io.modelcontextprotocol/serverInfo') : null;
        if (!topLevel && nested) return;

        const anchor = topLevel ?? node;
        const start = anchor.getStart(sourceFile, false);
        findings.push(
          buildFinding(
            this,
            { file, offset: start, endOffset: anchor.getEnd(), text: 'serverInfo' },
            {
              ...legacyEraFindingOverride(file, sourceFile, start),
              level: 'review',
              title: topLevel
                ? 'DiscoverResult puts serverInfo at the obsolete top level'
                : 'DiscoverResult does not include recommended serverInfo in _meta',
              explanation:
                'The integrated target draft identifies the server through _meta["io.modelcontextprotocol/serverInfo"]. Servers SHOULD include it; the earlier top-level SEP shape was superseded. This is a recommendation-level identity issue, not a claim that an extra top-level field alone invalidates the response.',
              remediation:
                'Move server identity to _meta["io.modelcontextprotocol/serverInfo"]. With createMcpHandler or serveStdio, allow the v2 SDK to stamp server identity on target-era results.',
            },
          ),
        );
      });
    }
    const hasV2ServingEntry = applicableFiles.some((file) => {
      const sourceFile = getSourceFile(file);
      return Boolean(
        sourceFile &&
          fileHasMcpSignal(file) &&
          collectCalls(sourceFile).some((call) =>
            /(^|\.)(?:createMcpHandler|serveStdio)$/.test(call.name),
          ),
      );
    });
    if (!hasV2ServingEntry) {
      const registrations = applicableFiles.flatMap((file) => {
        const sourceFile = getSourceFile(file);
        return sourceFile && fileHasMcpSignal(file)
          ? explicitServerMethodRegistrations(file, sourceFile)
          : [];
      });
      const hasDiscover = registrations.some((site) => site.method === 'server/discover');
      const anchor = registrations.find((site) => site.method !== 'server/discover');
      if (!hasDiscover && anchor) {
        findings.push(
          buildFinding(
            this,
            {
              file: anchor.file,
              offset: anchor.start,
              endOffset: anchor.end,
              text: anchor.method,
            },
            {
              level: 'review',
              confidence: 'medium',
              title: 'Custom server dispatch does not visibly register mandatory server/discover',
              explanation:
                'MCP 2026-07-28 requires servers to implement server/discover. This repository visibly registers raw server-side MCP methods, but no server/discover registration or v2 serving entry is visible. A wrapper may still provide it, so absence is reported for review rather than asserted as a break.',
              remediation:
                'Register server/discover with supportedVersions and capabilities, or verify that the serving framework supplies it. Prefer createMcpHandler or serveStdio in the v2 TypeScript SDK.',
            },
          ),
        );
      }
    }
    return dedupeByLocation(findings);
  },
};

const CACHEABLE_RESULT_MARKERS = [
  'supportedVersions',
  'tools',
  'prompts',
  'resources',
  'resourceTemplates',
  'contents',
];

const MCP_RESULT_MARKERS = [
  ...CACHEABLE_RESULT_MARKERS,
  'content',
  'structuredContent',
  'isError',
  'messages',
  'completion',
];
const CACHEABLE_METHODS = new Set([
  'server/discover',
  'tools/list',
  'prompts/list',
  'resources/list',
  'resources/templates/list',
  'resources/read',
]);

export const cacheableResultRule: ScannerRule = {
  id: 'MCP2026-CACHE-001',
  title: 'Raw cacheable result has invalid or missing cache hints',
  category: 'stateless-lifecycle',
  targetVersion: DEFAULT_TARGET_VERSION,
  level: 'error',
  defaultConfidence: 'high',
  source: SOURCES.caching,
  appliesTo: { fileKinds: ['ts', 'js'], transports: [...ALL_TRANSPORTS] },
  autofix: 'suggested',
  description:
    'Detects raw complete discovery/list/read results that omit ttlMs/cacheScope or declare invalid literal values.',

  async scan(context: ScanContext): Promise<Finding[]> {
    const findings: Finding[] = [];
    for (const file of filesFor(this, context)) {
      const sourceFile = getSourceFile(file);
      if (!sourceFile || !fileHasMcpSignal(file) || isClientOnlyMcpFile(file)) continue;
      for (const site of rawResultSites(file, sourceFile)) {
        if (!CACHEABLE_RESULT_MARKERS.some((key) => hasNamedProperty(site.result, key))) continue;
        if (stringProperty(site.result, 'resultType') === 'input_required') continue;
        const association = directlyAssociatedHandlerMethod(site.result);
        if (association && !CACHEABLE_METHODS.has(association.method)) continue;
        const inferredDiscovery = hasNamedProperty(site.result, 'supportedVersions');
        const methodUncertain = !association && !inferredDiscovery;

        const ttl = property(site.result, 'ttlMs');
        const scope = property(site.result, 'cacheScope');
        const ttlShorthand = shorthandProperty(site.result, 'ttlMs');
        const scopeShorthand = shorthandProperty(site.result, 'cacheScope');
        const ttlValue = ttl ? numericValue(ttl.initializer) : null;
        const scopeValue = scope ? literalString(scope.initializer) : null;
        const invalidTtl = ttlValue !== null && (!Number.isInteger(ttlValue) || ttlValue < 0);
        const invalidScope = scopeValue !== null && scopeValue !== 'public' && scopeValue !== 'private';
        const dynamicTtl = Boolean(ttlShorthand || (ttl && ttlValue === null));
        const dynamicScope = Boolean(scopeShorthand || (scope && scopeValue === null));
        if (ttl && scope && !invalidTtl && !invalidScope && !dynamicTtl && !dynamicScope) continue;

        const anchor = invalidTtl ? ttl : invalidScope ? scope : site.result;
        if (!anchor) continue;
        const start = anchor.getStart(sourceFile, false);
        findings.push(
          buildFinding(
            this,
            { file, offset: start, endOffset: anchor.getEnd(), text: 'cache hints' },
            {
              ...legacyEraFindingOverride(file, sourceFile, start),
              ...(dynamicTtl || dynamicScope || methodUncertain || hasOpaqueProperties(site.result)
                ? { level: 'review' as const, confidence: 'medium' as const }
                : {}),
              explanation:
                'Complete server/discover, tools/list, prompts/list, resources/list, resources/templates/list, and resources/read results MUST include an integer ttlMs >= 0 and cacheScope "public" or "private". MRTR input_required results carry neither field.',
              remediation:
                'Add conservative raw-wire defaults ttlMs: 0 and cacheScope: "private", or supply an accurate policy. Do not add wire-only fields to high-level v2 SDK handler returns; configure SDK cache hints and let its target codec emit them.',
            },
          ),
        );
      }
    }
    return dedupeByLocation(findings);
  },
};

/* -------------------------------------------------------------------------- */
/* MCP2026-ERROR-003 - draft error-code renumbering                            */
/* -------------------------------------------------------------------------- */

const RENAMED_ERROR_CODES = [
  { old: -32001, current: -32020, names: ['HeaderMismatch', 'header mismatch'] },
  {
    old: -32003,
    current: -32021,
    names: ['MissingRequiredClientCapability', 'missing required client capability'],
  },
  {
    old: -32004,
    current: -32022,
    names: ['UnsupportedProtocolVersion', 'unsupported protocol version'],
  },
] as const;

export const renamedProtocolErrorRule: ScannerRule = {
  id: 'MCP2026-ERROR-003',
  title: 'Named target protocol error uses its obsolete draft code',
  category: 'resource-errors',
  targetVersion: DEFAULT_TARGET_VERSION,
  level: 'error',
  defaultConfidence: 'high',
  source: SOURCES.base,
  appliesTo: { fileKinds: ['ts', 'js', 'json'], transports: [...ALL_TRANSPORTS] },
  autofix: 'suggested',
  description:
    'Detects obsolete numeric codes only when tied to the named protocol errors that were renumbered.',

  async scan(context: ScanContext): Promise<Finding[]> {
    const findings: Finding[] = [];
    for (const file of filesFor(this, context)) {
      const sourceFile = getSourceFile(file);
      if (!sourceFile || !fileHasMcpSignal(file)) continue;
      for (const renamed of RENAMED_ERROR_CODES) {
        for (const hit of collectNumericLiterals(sourceFile, renamed.old)) {
          if (hit.usage === 'compare' || hit.usage === 'list') continue;
          if (!hasContextNear(file, hit.start, renamed.names, 300, hit.end)) continue;
          const provenEmission =
            hit.usage === 'emit' && isProvenErrorEmission(sourceFile, hit.node);
          findings.push(
            buildFinding(
              this,
              { file, offset: hit.start, endOffset: hit.end, text: String(renamed.old) },
              {
                level:
                  provenEmission && !isLegacyEraGuarded(file, sourceFile, hit.start)
                    ? 'error'
                    : 'review',
                confidence:
                  provenEmission && !isLegacyEraGuarded(file, sourceFile, hit.start)
                    ? 'high'
                    : 'medium',
                title: `${renamed.names[0]} uses obsolete code ${renamed.old}`,
                explanation:
                  `${renamed.names[0]} was renumbered from ${renamed.old} to ${renamed.current}. The legacy range -32000 through -32019 otherwise remains implementation-defined. This occurrence has the named meaning, but only proven server emission is asserted as an error; declarations may intentionally accept an older peer.`,
                remediation:
                  provenEmission
                    ? `Use ${renamed.current}, preferably through the current SDK's named protocol error constant.`
                    : `Determine whether this constant emits a server error or accepts a legacy peer. Change emissions to ${renamed.current}; keep compatibility acceptance when intentional.`,
              },
            ),
          );
        }
      }
    }
    return dedupeByLocation(findings);
  },
};

/* -------------------------------------------------------------------------- */
/* AST helpers                                                                 */
/* -------------------------------------------------------------------------- */

function property(
  object: ts.ObjectLiteralExpression,
  name: string,
): ts.PropertyAssignment | undefined {
  return object.properties.find(
    (entry): entry is ts.PropertyAssignment =>
      ts.isPropertyAssignment(entry) && propertyKeyText(entry.name) === name,
  );
}

function shorthandProperty(
  object: ts.ObjectLiteralExpression,
  name: string,
): ts.ShorthandPropertyAssignment | undefined {
  return object.properties.find(
    (entry): entry is ts.ShorthandPropertyAssignment =>
      ts.isShorthandPropertyAssignment(entry) && entry.name.text === name,
  );
}

function hasNamedProperty(object: ts.ObjectLiteralExpression, name: string): boolean {
  return Boolean(property(object, name) || shorthandProperty(object, name));
}

function hasOpaqueProperties(object: ts.ObjectLiteralExpression): boolean {
  return object.properties.some(
    (entry) =>
      ts.isSpreadAssignment(entry) ||
      ('name' in entry && entry.name !== undefined && ts.isComputedPropertyName(entry.name)),
  );
}

function objectProperty(object: ts.ObjectLiteralExpression, name: string): ts.ObjectLiteralExpression | null {
  const entry = property(object, name);
  return entry && ts.isObjectLiteralExpression(entry.initializer) ? entry.initializer : null;
}

function stringProperty(object: ts.ObjectLiteralExpression, name: string): string | null {
  const entry = property(object, name);
  return entry ? literalString(entry.initializer) : null;
}

function literalString(node: ts.Expression): string | null {
  return ts.isStringLiteralLike(node) ? node.text : null;
}

function numericValue(node: ts.Expression): number | null {
  if (ts.isNumericLiteral(node)) return Number(node.text);
  if (
    ts.isPrefixUnaryExpression(node) &&
    node.operator === ts.SyntaxKind.MinusToken &&
    ts.isNumericLiteral(node.operand)
  ) {
    return -Number(node.operand.text);
  }
  return null;
}

interface TaskShapeValidation {
  invalid: string[];
  dynamic: string[];
}

const TASK_STATUSES = new Set(['working', 'input_required', 'completed', 'cancelled', 'failed']);

function validateCreateTaskResult(result: ts.ObjectLiteralExpression): TaskShapeValidation {
  const invalid: string[] = [];
  const dynamic: string[] = [];
  const opaque = hasOpaqueProperties(result);

  const required = ['taskId', 'status', 'createdAt', 'lastUpdatedAt', 'ttlMs'] as const;
  for (const field of required) {
    const assignment = property(result, field);
    const shorthand = shorthandProperty(result, field);
    if (!assignment && !shorthand) {
      (opaque ? dynamic : invalid).push(
        opaque ? `${field} may be supplied by an object spread` : `${field} is missing`,
      );
      continue;
    }
    if (!assignment) {
      dynamic.push(`${field} uses a shorthand value`);
      continue;
    }
    validateTaskField(field, assignment.initializer, invalid, dynamic);
  }

  const polling = property(result, 'pollIntervalMs');
  const pollingShorthand = shorthandProperty(result, 'pollIntervalMs');
  if (polling) validateTaskField('pollIntervalMs', polling.initializer, invalid, dynamic);
  else if (pollingShorthand) dynamic.push('pollIntervalMs uses a shorthand value');

  return { invalid, dynamic };
}

function validateTaskField(
  field: 'taskId' | 'status' | 'createdAt' | 'lastUpdatedAt' | 'ttlMs' | 'pollIntervalMs',
  value: ts.Expression,
  invalid: string[],
  dynamic: string[],
): void {
  if (field === 'status') {
    const status = literalString(value);
    if (status !== null) {
      if (!TASK_STATUSES.has(status)) invalid.push(`status has invalid value "${status}"`);
      return;
    }
    (isClearlyWrongStaticValue(value) ? invalid : dynamic).push(
      isClearlyWrongStaticValue(value)
        ? 'status must be a Task status string'
        : 'status value cannot be verified statically',
    );
    return;
  }

  if (field === 'ttlMs' || field === 'pollIntervalMs') {
    if (field === 'ttlMs' && value.kind === ts.SyntaxKind.NullKeyword) return;
    const number = numericValue(value);
    if (number !== null) {
      if (!Number.isInteger(number)) invalid.push(`${field} must be an integer${field === 'ttlMs' ? ' or null' : ''}`);
      return;
    }
    const requiredType = `${field} must be an integer${field === 'ttlMs' ? ' or null' : ''}`;
    (isClearlyWrongStaticValue(value) ? invalid : dynamic).push(
      isClearlyWrongStaticValue(value)
        ? requiredType
        : `${field} value cannot be verified statically`,
    );
    return;
  }

  const text = literalString(value);
  if (text !== null) {
    if (
      (field === 'createdAt' || field === 'lastUpdatedAt') &&
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(text)
    ) {
      dynamic.push(`${field} is not a recognizable ISO 8601 timestamp`);
    }
    return;
  }
  (isClearlyWrongStaticValue(value) ? invalid : dynamic).push(
    isClearlyWrongStaticValue(value)
      ? `${field} must be a string`
      : `${field} value cannot be verified statically`,
  );
}

function isClearlyWrongStaticValue(value: ts.Expression): boolean {
  return (
    ts.isNumericLiteral(value) ||
    ts.isBigIntLiteral(value) ||
    ts.isObjectLiteralExpression(value) ||
    ts.isArrayLiteralExpression(value) ||
    value.kind === ts.SyntaxKind.TrueKeyword ||
    value.kind === ts.SyntaxKind.FalseKeyword ||
    value.kind === ts.SyntaxKind.NullKeyword
  );
}

interface RegisteredMethodSite {
  file: PreparedFile;
  method: string;
  start: number;
  end: number;
}

function explicitServerMethodRegistrations(
  file: PreparedFile,
  sourceFile: ts.SourceFile,
): RegisteredMethodSite[] {
  const sites: RegisteredMethodSite[] = [];
  for (const call of collectCalls(sourceFile)) {
    if (!/(^|\.)(?:setRequestHandler|onRequest)$/.test(call.name)) continue;
    const first = call.node.arguments[0];
    if (!first || !ts.isStringLiteralLike(first) || !isRecognizedServerMethod(first.text)) continue;
    sites.push({
      file,
      method: first.text,
      start: first.getStart(sourceFile, false),
      end: first.getEnd(),
    });
  }
  walk(sourceFile, (node) => {
    if (!ts.isCaseClause(node) || !ts.isStringLiteralLike(node.expression)) return;
    if (!isRecognizedServerMethod(node.expression.text)) return;
    const text = node.parent.parent.getText(sourceFile);
    if (!/\b(?:method|jsonrpc|McpServer|setRequestHandler)\b/i.test(text)) return;
    sites.push({
      file,
      method: node.expression.text,
      start: node.expression.getStart(sourceFile, false),
      end: node.expression.getEnd(),
    });
  });
  return sites;
}

function isRecognizedServerMethod(method: string): boolean {
  return /^(?:server\/discover|tools\/(?:list|call)|resources\/(?:list|read)|prompts\/(?:list|get)|tasks\/(?:list|result|get|update|cancel)|subscriptions\/listen|logging\/setLevel)$/.test(
    method,
  );
}

function isInsideInputRequests(node: ts.Node): boolean {
  let current: ts.Node | undefined = node.parent;
  let depth = 0;
  while (current && depth < 12) {
    if (
      ts.isPropertyAssignment(current) &&
      propertyKeyText(current.name) === 'inputRequests' &&
      ts.isObjectLiteralExpression(current.parent) &&
      stringProperty(current.parent, 'resultType') === 'input_required'
    ) {
      return true;
    }
    current = current.parent;
    depth++;
  }
  return false;
}

function isExecutableProtocolObject(node: ts.ObjectLiteralExpression): boolean {
  let current: ts.Node | undefined = node;
  let depth = 0;
  while (current && depth < 12) {
    const parent: ts.Node | undefined = current.parent;
    if (!parent) return false;
    if (ts.isReturnStatement(parent) || ts.isArrowFunction(parent)) return true;
    if (ts.isCallExpression(parent)) {
      const name = calleeName(parent);
      return /(^|\.)(?:fetch|post|request|send|write|json|reply|respond|stringify)$/.test(name);
    }
    if (ts.isVariableDeclaration(parent) || ts.isSourceFile(parent)) return false;
    current = parent;
    depth++;
  }
  return false;
}

function directlyAssociatedHandlerMethod(
  node: ts.ObjectLiteralExpression,
): { method: string; node: ts.StringLiteralLike } | null {
  let current: ts.Node | undefined = node;
  let depth = 0;
  while (current && depth < 14) {
    const parent: ts.Node | undefined = current.parent;
    if (!parent) return null;
    if (ts.isCallExpression(parent)) {
      const name = calleeName(parent);
      if (/(^|\.)(?:setRequestHandler|handle|handler|on)$/.test(name)) {
        const first = parent.arguments[0];
        if (!first || !ts.isStringLiteralLike(first)) return null;
        return { method: first.text, node: first };
      }
    }
    if (ts.isVariableDeclaration(parent) || ts.isSourceFile(parent)) return null;
    current = parent;
    depth++;
  }
  return null;
}

function directlyAssociatedMcpMethod(
  node: ts.ObjectLiteralExpression,
): { method: string; node: ts.StringLiteralLike } | null {
  const handler = directlyAssociatedHandlerMethod(node);
  if (handler && isRecognizedMcpRequestMethod(handler.method)) return handler;

  let current: ts.Node | undefined = node.parent;
  while (current) {
    if (
      ts.isCaseClause(current) &&
      ts.isStringLiteralLike(current.expression) &&
      isRecognizedMcpRequestMethod(current.expression.text)
    ) {
      return { method: current.expression.text, node: current.expression };
    }
    if (ts.isFunctionLike(current) || ts.isSourceFile(current)) return null;
    current = current.parent;
  }
  return null;
}

function isRecognizedMcpRequestMethod(method: string): boolean {
  return /^(?:server\/discover|tools\/(?:list|call)|resources\/(?:list|read)|resources\/templates\/list|prompts\/(?:list|get)|completion\/complete|subscriptions\/listen|tasks\/(?:get|update|cancel)|roots\/list|sampling\/createMessage|elicitation\/create)$/.test(
    method,
  );
}

function containingFunction(node: ts.Node): ts.FunctionLikeDeclaration | null {
  let current: ts.Node | undefined = node.parent;
  while (current) {
    if (
      ts.isArrowFunction(current) ||
      ts.isFunctionDeclaration(current) ||
      ts.isFunctionExpression(current) ||
      ts.isMethodDeclaration(current)
    ) {
      return current;
    }
    current = current.parent;
  }
  return null;
}

function isExecutableLiteralAt(sourceFile: ts.SourceFile, offset: number): boolean {
  let current = nodeAt(sourceFile, offset);
  let depth = 0;
  while (current && depth < 12) {
    const parent = current.parent;
    if (!parent) return false;
    if (
      ts.isCallExpression(parent) ||
      ts.isBinaryExpression(parent) ||
      ts.isCaseClause(parent) ||
      ts.isReturnStatement(parent)
    ) {
      return true;
    }
    if (ts.isVariableDeclaration(parent) || ts.isSourceFile(parent)) return false;
    current = parent;
    depth++;
  }
  return false;
}

export const modernProtocolRules: readonly ScannerRule[] = Object.freeze([
  legacySdkEntrypointRule,
  directServerRequestRule,
  inputRequiredShapeRule,
  requestStateIntegrityRule,
  removedElicitationSurfaceRule,
  requiredResultTypeRule,
  requiredRequestMetadataRule,
  discoveryShapeRule,
  cacheableResultRule,
  renamedProtocolErrorRule,
]);
