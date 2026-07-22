import ts from 'typescript';
import { DEFAULT_TARGET_VERSION, META_KEYS, SOURCES } from '../../constants.js';
import type { Finding, PreparedFile, ScanContext, ScannerRule } from '../../types.js';
import {
  calleeName,
  collectHeaderAccess,
  getSourceFile,
  nodeAt,
  propertyKeyText,
  walk,
} from '../ast.js';
import { ROUTE_RECEIVER_SOURCE } from '../classification.js';
import { isInComment, offsetToPosition } from '../discovery.js';
import {
  buildFinding,
  dedupeByLocation,
  fileHasMcpSignal,
  filesFor,
  isClientOnlyMcpFile,
  matches,
} from './helpers.js';

/**
 * Group 2 — Streamable HTTP request headers (SEP-2243).
 *
 * The target specification requires `MCP-Protocol-Version` and `Mcp-Method` on
 * every Streamable HTTP POST request, plus method-specific `Mcp-Name`. These
 * rules only run for HTTP transports — a stdio server has no HTTP request to
 * put a header on, and flagging one would be a pure false positive.
 */

const HTTP_TRANSPORTS = ['streamable-http', 'mixed', 'custom-http'] as const;

const REQUIRED_HEADER_NAMES = new Set(['mcp-method', 'mcp-name', 'mcp-protocol-version']);

/** Methods for which `Mcp-Name` is required, and where its value comes from. */
const NAME_BEARING_METHODS: Record<string, string> = {
  'tools/call': 'params.name',
  'resources/read': 'params.uri',
  'prompts/get': 'params.name',
  'tasks/get': 'params.taskId',
  'tasks/update': 'params.taskId',
  'tasks/cancel': 'params.taskId',
};

const HEADER_EXPLANATION =
  'MCP 2026-07-28 requires standard routing headers on Streamable HTTP POST requests so that ' +
  'intermediaries can route without parsing the body. MCP-Protocol-Version and Mcp-Method are ' +
  'required on every JSON-RPC request over Streamable HTTP POST. Mcp-Name is additionally required ' +
  'for tools/call, resources/read, prompts/get, tasks/get, tasks/update and tasks/cancel. A target ' +
  'server must reject a request whose routing headers disagree with the body with 400 Bad Request ' +
  'and JSON-RPC error -32020 (HeaderMismatch). The draft does not define these requirements for ' +
  'JSON-RPC notifications, so this rule only analyzes messages carrying an id.';

interface StaticValue {
  kind: 'literal' | 'identifier';
  value: string;
}

/* -------------------------------------------------------------------------- */
/* Request-construction analysis                                               */
/* -------------------------------------------------------------------------- */

interface McpRequestSite {
  /** Offset of the request-constructing call. */
  offset: number;
  endOffset: number;
  /** JSON-RPC method the call sends, when a literal was found. */
  method: string | null;
  /** Whether the call site sets Mcp-Method. */
  hasMcpMethod: boolean;
  /** Whether the call site sets Mcp-Name. */
  hasMcpName: boolean;
  /** Whether a name/uri value is available at the call site. */
  nameValue: StaticValue | null;
  mcpMethodValue: StaticValue | null;
  protocolHeaderValue: StaticValue | null;
  bodyProtocolVersion: StaticValue | null;
  mcpNameValue: StaticValue | null;
  hasProtocolHeader: boolean;
  headersOpaque: boolean;
}

const REQUEST_CALLS =
  /^(?:fetch|axios|axios\.(?:request|post)|(?:http|https|client|mcpClient|customClient|httpClient|apiClient)\.(?:request|post))$/i;

const KNOWN_MCP_METHODS = new Set([
  'server/discover',
  'tools/list',
  'tools/call',
  'resources/list',
  'resources/templates/list',
  'resources/read',
  'prompts/list',
  'prompts/get',
  'completion/complete',
  'subscriptions/listen',
  'tasks/get',
  'tasks/update',
  'tasks/cancel',
  'roots/list',
  'sampling/createMessage',
  'elicitation/create',
]);

/**
 * Finds explicit HTTP request construction that carries an MCP JSON-RPC body,
 * and records which MCP headers the same call site sets.
 *
 * Only literal, self-contained call sites are considered. A request whose body
 * or headers come from a variable is left alone: without cross-file analysis
 * the scanner cannot see what that variable holds, and guessing would produce
 * exactly the false ERROR this rule set exists to avoid.
 */
function findMcpRequestSites(file: PreparedFile, sourceFile: ts.SourceFile): McpRequestSite[] {
  const sites: McpRequestSite[] = [];

  walk(sourceFile, (node) => {
    if (!ts.isCallExpression(node)) return;
    const name = calleeName(node);
    if (!REQUEST_CALLS.test(name)) return;

    const start = node.getStart(sourceFile, false);
    if (isInComment(file, start)) return;

    const text = codeTextWithoutComments(file, start, node.getEnd());
    if (!hasJsonRpcVersion(text) || !hasRequestId(text)) return;
    const method = extractLiteralMethod(text);
    if (!method) return;
    const extensionContext =
      /['"`][^'"`]*[/._-]mcp(?:[/._-]|['"`])/.test(text) ||
      /^(?:mcpClient|customClient)\.(?:request|post)$/i.test(name) ||
      /io\.modelcontextprotocol/.test(text);
    if (!KNOWN_MCP_METHODS.has(method) && !extensionContext) return;

    const hasMcpMethod = hasHeader(text, 'mcp-method');
    const hasMcpName = hasHeader(text, 'mcp-name');
    const hasProtocolHeader = hasHeader(text, 'mcp-protocol-version');
    sites.push({
      offset: start,
      endOffset: node.getEnd(),
      method,
      hasMcpMethod,
      hasMcpName,
      hasProtocolHeader,
      mcpMethodValue: staticHeaderValue(text, 'mcp-method'),
      mcpNameValue: staticHeaderValue(text, 'mcp-name'),
      protocolHeaderValue: staticHeaderValue(text, 'mcp-protocol-version'),
      bodyProtocolVersion: staticBodyValue(text, META_KEYS.protocolVersion),
      nameValue: staticBodyValue(text, nameFieldFor(method)),
      headersOpaque:
        hasOpaqueHeaders(text) ||
        requestOptionsAreOpaque(node, name) ||
        /^(?:mcpClient|customClient|httpClient|apiClient)\.(?:request|post)$/i.test(name),
    });
  });

  return sites;
}

/**
 * Pulls a literal `method: "tools/call"` out of a request body. The key may
 * itself be quoted — bodies written as JSON strings or template-literal JSON
 * (`"method":"tools/call"`) count the same as object literals.
 */
function extractLiteralMethod(text: string): string | null {
  const pattern = /['"`\\]?\bmethod['"`\\]?\s*:\s*\\?['"`]([a-z][a-z0-9]*(?:\/[a-z][a-zA-Z0-9]*)+)\\?['"`]/;
  const match = pattern.exec(text);
  if (!match) return null;
  const method = match[1];
  if (!method) return null;
  return method;
}

function hasJsonRpcVersion(text: string): boolean {
  return /['"`\\]?jsonrpc['"`\\]?\s*:\s*\\?['"`]2\.0\\?['"`]/i.test(text);
}

/**
 * True when the message carries a JSON-RPC `id` member.
 *
 * The `id` must be a member name in its own right. Without the preceding
 * boundary, any token ending in `id` — `X-Request-Id`, `requestId`, `sessionId`
 * — satisfied this, so a JSON-RPC *notification* that merely carried a tracing
 * header was analyzed as an id-bearing request and reported as a definite
 * header error. The draft imposes these header requirements only on messages
 * carrying an id, which is exactly what this rule's own explanation states.
 */
function hasRequestId(text: string): boolean {
  if (/(?<![\w-])['"`\\]?id['"`\\]?\s*:/i.test(text)) return true;
  // ES6 shorthand: `JSON.stringify({ jsonrpc: '2.0', id, method: ... })`.
  // Requiring a colon dropped the whole call site, so an idiomatic request
  // missing every routing header was reported as compliant.
  return /[,{]\s*id\s*(?=[,}])/.test(text);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function hasHeader(text: string, header: string): boolean {
  return new RegExp(`['"\`]${escapeRegExp(header)}['"\`]`, 'i').test(text);
}

function staticHeaderValue(text: string, header: string): StaticValue | null {
  const objectMatch = new RegExp(
    `['"\`]${escapeRegExp(header)}['"\`]\\s*:\\s*([^,}\\n]+)`,
    'i',
  ).exec(text);
  const setterMatch = new RegExp(
    `\\.set\\s*\\(\\s*['"\`]${escapeRegExp(header)}['"\`]\\s*,\\s*([^,)\\n]+)`,
    'i',
  ).exec(text);
  return parseStaticValue(objectMatch?.[1] ?? setterMatch?.[1] ?? null);
}

function staticBodyValue(text: string, key: string): StaticValue | null {
  const escaped = escapeRegExp(key);
  const match = new RegExp(
    `(?:['"\`]${escaped}['"\`]|\\b${escaped}\\b)\\s*:\\s*([^,}\\n]+)`,
  ).exec(text);
  const explicit = parseStaticValue(match?.[1] ?? null);
  if (explicit) return explicit;
  if (/^[A-Za-z_$][\w$]*$/.test(key)) {
    const shorthand = new RegExp(`(?:[,{]\\s*)${escapeRegExp(key)}\\s*(?=[,}])`).test(text);
    if (shorthand) return { kind: 'identifier', value: key };
  }
  return null;
}

function parseStaticValue(raw: string | null): StaticValue | null {
  if (!raw) return null;
  const value = raw.trim();
  if (value.startsWith('`') && value.endsWith('`') && value.includes('${')) return null;
  const literal = /^['"`]([^'"`]*)['"`]$/.exec(value);
  if (literal?.[1] !== undefined) return { kind: 'literal', value: literal[1] };
  if (/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/.test(value)) {
    return { kind: 'identifier', value };
  }
  return null;
}

function compareStaticValues(left: StaticValue, right: StaticValue): 'equal' | 'mismatch' | 'unknown' {
  if (left.kind !== right.kind) return 'unknown';
  return left.value === right.value ? 'equal' : 'mismatch';
}

function nameFieldFor(method: string): string {
  if (method === 'resources/read') return 'uri';
  if (method === 'tasks/get' || method === 'tasks/update' || method === 'tasks/cancel') {
    return 'taskId';
  }
  return 'name';
}

function hasOpaqueHeaders(text: string): boolean {
  return /\bheaders\s*:\s*(?!\s*\{)/.test(text) || /\bheaders\s*:\s*\{[\s\S]*?\.\.\./.test(text);
}

function requestOptionsAreOpaque(call: ts.CallExpression, name: string): boolean {
  let candidate: ts.Expression | undefined;
  if (/^(?:fetch|http\.request|https\.request)$/i.test(name)) candidate = call.arguments[1];
  else if (/\.post$/i.test(name)) candidate = call.arguments[2];
  else if (/^(?:axios|axios\.request|client\.request|mcpClient\.request|customClient\.request|httpClient\.request|apiClient\.request)$/i.test(name)) {
    candidate = call.arguments[0];
  }
  return Boolean(
    candidate &&
      ts.isObjectLiteralExpression(candidate) &&
      candidate.properties.some((entry) => ts.isSpreadAssignment(entry)),
  );
}

/* -------------------------------------------------------------------------- */
/* MCP2026-HEADER-001 — request construction omits required headers            */
/* -------------------------------------------------------------------------- */

export const missingRequestHeadersRule: ScannerRule = {
  id: 'MCP2026-HEADER-001',
  title: 'MCP request is constructed without the required routing headers',
  category: 'http-headers',
  targetVersion: DEFAULT_TARGET_VERSION,
  level: 'error',
  defaultConfidence: 'medium',
  source: SOURCES.streamableHttp,
  appliesTo: { fileKinds: ['ts', 'js'], transports: [...HTTP_TRANSPORTS] },
  autofix: 'suggested',
  description:
    'Detects explicit HTTP request construction that sends an MCP JSON-RPC body without setting ' +
    'MCP-Protocol-Version, Mcp-Method, and Mcp-Name where the method requires it.',

  async scan(context: ScanContext): Promise<Finding[]> {
    const findings: Finding[] = [];
    for (const file of filesFor(this, context)) {
      const sourceFile = getSourceFile(file);
      if (!sourceFile) continue;

      for (const site of findMcpRequestSites(file, sourceFile)) {
        if (!site.method) continue;

        const missing: string[] = [];
        if (!site.hasProtocolHeader) missing.push('MCP-Protocol-Version');
        if (!site.hasMcpMethod) missing.push('Mcp-Method');

        const nameSource = NAME_BEARING_METHODS[site.method];
        if (nameSource && !site.hasMcpName) missing.push('Mcp-Name');

        const mismatches: string[] = [];
        const bodyMethod: StaticValue = { kind: 'literal', value: site.method };
        if (
          site.mcpMethodValue !== null &&
          compareStaticValues(site.mcpMethodValue, bodyMethod) === 'mismatch'
        ) {
          mismatches.push(`Mcp-Method (${site.mcpMethodValue.value} != ${site.method})`);
        }
        if (
          site.protocolHeaderValue !== null &&
          site.bodyProtocolVersion !== null &&
          compareStaticValues(site.protocolHeaderValue, site.bodyProtocolVersion) === 'mismatch'
        ) {
          mismatches.push(
            `MCP-Protocol-Version (${site.protocolHeaderValue.value} != ${site.bodyProtocolVersion.value})`,
          );
        }
        if (
          nameSource &&
          site.mcpNameValue !== null &&
          site.nameValue !== null &&
          compareStaticValues(site.mcpNameValue, site.nameValue) === 'mismatch'
        ) {
          mismatches.push(`Mcp-Name (${site.mcpNameValue.value} != ${site.nameValue.value})`);
        }

        const unverifiable: string[] = [];
        if (
          site.hasProtocolHeader &&
          (site.protocolHeaderValue === null ||
            site.bodyProtocolVersion === null ||
            compareStaticValues(site.protocolHeaderValue, site.bodyProtocolVersion) === 'unknown')
        ) {
          unverifiable.push('MCP-Protocol-Version equality');
        }
        if (
          site.hasMcpMethod &&
          (site.mcpMethodValue === null ||
            compareStaticValues(site.mcpMethodValue, bodyMethod) === 'unknown')
        ) {
          unverifiable.push('Mcp-Method equality');
        }
        if (
          nameSource &&
          site.hasMcpName &&
          (site.mcpNameValue === null ||
            site.nameValue === null ||
            compareStaticValues(site.mcpNameValue, site.nameValue) === 'unknown')
        ) {
          unverifiable.push('Mcp-Name equality');
        }

        if (missing.length === 0 && mismatches.length === 0 && unverifiable.length === 0) continue;

        const nameClause = nameSource
          ? ` For ${site.method}, Mcp-Name must mirror ${nameSource}.`
          : '';
        const definitive =
          mismatches.length > 0 || (missing.length > 0 && !site.headersOpaque);
        const needsReview = !definitive;
        const problem = [
          ...(missing.length > 0 ? [`missing ${missing.join(' and ')}`] : []),
          ...(mismatches.length > 0 ? [`mismatched ${mismatches.join(' and ')}`] : []),
          ...(unverifiable.length > 0 ? [`unverifiable ${unverifiable.join(' and ')}`] : []),
        ].join('; ');

        findings.push(
          buildFinding(
            this,
            { file, offset: site.offset, endOffset: site.endOffset, text: site.method },
            {
              level: needsReview ? 'review' : 'error',
              confidence: needsReview ? 'low' : 'high',
              title: needsReview
                ? `MCP request routing headers need review (${problem})`
                : `MCP request has invalid routing headers (${problem})`,
              ...(nameSource === 'params.taskId' ? { source: SOURCES.sep2663 } : {}),
              explanation: needsReview
                ? `${HEADER_EXPLANATION} This call sends "${site.method}", but ${problem}. A header builder or dynamic value prevents a definitive conclusion.${nameClause}`
                : `${HEADER_EXPLANATION} This call sends "${site.method}" with ${problem}.${nameClause}`,
              remediation:
                `Set the required routing headers on this request. MCP-Protocol-Version must equal ` +
                `params._meta["${META_KEYS.protocolVersion}"], and Mcp-Method must equal the JSON-RPC ` +
                `method exactly — values are case-sensitive, so "${site.method}" and not an ` +
                `upper-cased variant.${nameClause} Values that are non-ASCII, contain control ` +
                'characters or have leading or trailing whitespace must use the sentinel encoding ' +
                '=?base64?<value>?= with those markers in lower case. If a shared client or ' +
                'middleware already adds these headers, verify it covers this path.',
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
/* MCP2026-HEADER-002 — handler does not validate headers                      */
/* -------------------------------------------------------------------------- */

/**
 * Server route registration. The receiver must look like a route registrar:
 * with any receiver accepted, outbound client calls (`axios.post`,
 * `httpClient.post`) matched as server routes, producing two contradictory
 * findings at one location — a client request AND an MCP route handler.
 */
const MCP_ROUTE_PATTERN = new RegExp(
  String.raw`\b(?:[A-Za-z_$][\w$]*\.)*` +
    ROUTE_RECEIVER_SOURCE +
    String.raw`\.(?:post|all|use)\s*\(\s*['"\`]([^'"\`]*[/._-]mcp(?:[/._-][^'"\`]*)?)['"\`]`,
  'gi',
);

const NEXT_ROUTE_PATTERN = /\bexport\s+(?:const|async\s+function|function)\s+POST\b/g;
const NODE_HTTP_ROUTE_PATTERN =
  /\b(?:http\.)?createServer\s*\(\s*(?:handleMcp[A-Za-z0-9_$]*|mcp[A-Za-z0-9_$]*)\b/gi;
const OBJECT_ROUTE_PATTERN =
  /\b(?:[A-Za-z_$][\w$]*\.)+route\s*\(\s*\{(?=[\s\S]{0,800}\bmethod\s*:\s*['"`]POST['"`])(?=[\s\S]{0,800}\b(?:url|path)\s*:\s*['"`](?:[^'"`]*\/)?mcp\/?['"`])[\s\S]{0,800}?\}/gi;

export const unvalidatedHeadersRule: ScannerRule = {
  id: 'MCP2026-HEADER-002',
  title: 'MCP route handler does not validate the required routing headers',
  category: 'http-headers',
  targetVersion: DEFAULT_TARGET_VERSION,
  level: 'review',
  defaultConfidence: 'medium',
  source: SOURCES.streamableHttp,
  appliesTo: { fileKinds: ['ts', 'js'], transports: [...HTTP_TRANSPORTS] },
  autofix: 'manual',
  description:
    'Detects MCP POST route handlers that do not visibly validate target routing headers, so a disagreement ' +
    'between the headers and the JSON-RPC body cannot be rejected.',

  async scan(context: ScanContext): Promise<Finding[]> {
    const findings: Finding[] = [];

    for (const file of filesFor(this, context)) {
      const sourceFile = getSourceFile(file);
      if (!sourceFile) continue;

      const routeHits = [
        ...matches(context, this, file, MCP_ROUTE_PATTERN),
        ...matches(context, this, file, NODE_HTTP_ROUTE_PATTERN),
        ...matches(context, this, file, OBJECT_ROUTE_PATTERN),
        // A bare `export function POST` is every Next.js API route, MCP or
        // not; without an MCP signal in the file it is not an MCP endpoint.
        // A file that only *consumes* MCP as a client (an API route calling
        // client.callTool) has an MCP signal but serves no MCP endpoint.
        ...(fileHasMcpSignal(file) && !isClientOnlyMcpFile(file)
          ? matches(context, this, file, NEXT_ROUTE_PATTERN)
          : []),
      ];

      for (const { hit } of routeHits) {
        if (routeHandlesHeaders(file, sourceFile, hit.offset)) continue;
        findings.push(
          buildFinding(this, hit, {
            explanation:
              `${HEADER_EXPLANATION} This handler does not visibly validate MCP-Protocol-Version, Mcp-Method and Mcp-Name, so it may not ` +
              'detect a request whose headers disagree with its body — the case SEP-2243 requires a ' +
              'server that processes the body to reject. Whether that matters depends on where the ' +
              'body is parsed, which static analysis cannot settle.',
            remediation:
              'If this handler parses the JSON-RPC body, compare MCP-Protocol-Version against the ' +
              `body _meta field ${META_KEYS.protocolVersion}, Mcp-Method against the body method, ` +
              'and Mcp-Name against params.name, params.uri or params.taskId, and reject a mismatch with 400 Bad ' +
              'Request and JSON-RPC error -32020 (HeaderMismatch). Compare header names ' +
              'case-insensitively and header values case-sensitively. If the handler only forwards ' +
              'the request, validation belongs at whichever layer does parse the body.',
            transportApplicability: 'streamable-http',
          }),
        );
      }
    }

    return dedupeByLocation(findings);
  },
};

/* -------------------------------------------------------------------------- */
/* MCP2026-HEADER-003 — routing-header implementation signals                  */
/* -------------------------------------------------------------------------- */

export const headersImplementedRule: ScannerRule = {
  id: 'MCP2026-HEADER-003',
  title: 'MCP routing header implementation signal',
  category: 'http-headers',
  targetVersion: DEFAULT_TARGET_VERSION,
  level: 'info',
  defaultConfidence: 'high',
  source: SOURCES.streamableHttp,
  appliesTo: { fileKinds: ['ts', 'js'], transports: [...HTTP_TRANSPORTS] },
  autofix: 'none',
  description:
    'Reports target routing-header references as neutral implementation signals without asserting compliance.',

  async scan(context: ScanContext): Promise<Finding[]> {
    const findings: Finding[] = [];

    for (const file of filesFor(this, context)) {
      const sourceFile = getSourceFile(file);
      if (!sourceFile) continue;

      const accesses = collectHeaderAccess(sourceFile, REQUIRED_HEADER_NAMES);
      for (const access of accesses) {
        if (isInComment(file, access.start)) {
          const { line } = offsetToPosition(file, access.start);
          context.noteCommentOnlyMatch(this.id, file.relPath, line, access.header);
          continue;
        }
        const canonical =
          access.header === 'mcp-method'
            ? 'Mcp-Method'
            : access.header === 'mcp-name'
              ? 'Mcp-Name'
              : 'MCP-Protocol-Version';
        findings.push(
          buildFinding(
            this,
            { file, offset: access.start, endOffset: access.end, text: access.header },
            {
              title:
                access.mode === 'write'
                  ? `${canonical} is set here`
                  : `${canonical} is read here`,
              explanation:
                `${canonical} is a target-era Streamable HTTP routing header and is referenced at ` +
                'this location. This is an implementation signal only; it does not prove that every ' +
                'request path sets or validates the header correctly.',
              remediation:
                'No change required. When verifying the migration, confirm this path covers every ' +
                'MCP request the repository makes or serves, including every name-bearing method.',
              transportApplicability: 'streamable-http',
            },
          ),
        );
      }

      // Object-literal header declarations the AST header pass does not treat
      // as header access, e.g. a plain `{ 'Mcp-Method': method }` constant.
      for (const { hit } of matches(
        context,
        this,
        file,
        /['"`](?:Mcp-(?:Method|Name)|MCP-Protocol-Version)['"`]/gi,
      )) {
        if (accesses.some((access) => hit.offset >= access.start && hit.offset < access.end)) continue;
        const canonical = /protocol/i.test(hit.text)
          ? 'MCP-Protocol-Version'
          : /method/i.test(hit.text)
            ? 'Mcp-Method'
            : 'Mcp-Name';
        findings.push(
          buildFinding(this, hit, {
            title: `${canonical} is referenced here`,
            explanation:
              `${canonical} is a target-era Streamable HTTP routing header and appears at this ` +
              'location. A reference alone is not proof that every request path is valid.',
            remediation:
              'No change required. Confirm this covers every MCP request path in the repository.',
            transportApplicability: 'streamable-http',
          }),
        );
      }
    }

    return dedupeByLocation(findings);
  },
};

/* -------------------------------------------------------------------------- */

function routeHandlesHeaders(file: PreparedFile, sourceFile: ts.SourceFile, offset: number): boolean {
  let current = nodeAt(sourceFile, offset);
  let routeNode: ts.Node | null = null;
  while (current && !ts.isSourceFile(current)) {
    if (ts.isCallExpression(current)) {
      routeNode = current;
      break;
    }
    if (!routeNode && ts.isFunctionDeclaration(current)) {
      routeNode = current;
    }
    current = current.parent;
  }
  let routeText = routeNode
    ? codeTextWithoutComments(file, routeNode.getStart(sourceFile, false), routeNode.getEnd())
    : codeTextWithoutComments(file, offset, Math.min(file.content.length, offset + 1_500));
  if (routeNode && ts.isCallExpression(routeNode)) {
    for (const argument of routeNode.arguments) {
      if (ts.isIdentifier(argument)) {
        routeText += `\n${declarationText(file, sourceFile, argument.text)}`;
        continue;
      }
      walk(argument, (node) => {
        if (
          ts.isPropertyAssignment(node) &&
          propertyKeyText(node.name) === 'handler' &&
          ts.isIdentifier(node.initializer)
        ) {
          routeText += `\n${declarationText(file, sourceFile, node.initializer.text)}`;
        }
      });
    }
  }

  if (/\bvalidate(?:Mcp)?RoutingHeaders\s*\(/.test(routeText)) return true;
  if (usesOfficialV2Handler(sourceFile, routeText)) return true;

  const validatesProtocol = hasVisibleHeaderComparison(routeText, 'mcp-protocol-version');
  const validatesMethod = hasVisibleHeaderComparison(routeText, 'mcp-method');
  const validatesName = hasVisibleHeaderComparison(routeText, 'mcp-name');
  const rejectsMismatch =
    /\.status\s*\(\s*400\s*\)|\bstatus\s*:\s*400\b|\bHeaderMismatch\b|-32020|\bthrow\b/.test(
      routeText,
    );
  return validatesProtocol && validatesMethod && validatesName && rejectsMismatch;
}

function hasVisibleHeaderComparison(text: string, header: string): boolean {
  const escaped = escapeRegExp(header);
  return new RegExp(
    `${escaped}[\\s\\S]{0,240}(?:!==|===|!=|==)|(?:!==|===|!=|==)[\\s\\S]{0,240}${escaped}`,
    'i',
  ).test(text);
}

function usesOfficialV2Handler(sourceFile: ts.SourceFile, routeText: string): boolean {
  const helperNames = new Set<string>();
  walk(sourceFile, (node) => {
    if (
      !ts.isImportDeclaration(node) ||
      !ts.isStringLiteralLike(node.moduleSpecifier) ||
      !/^@modelcontextprotocol\/(?:server|node|express|hono|fastify)(?:\/|$)/.test(
        node.moduleSpecifier.text,
      )
    ) {
      return;
    }
    const bindings = node.importClause?.namedBindings;
    if (bindings && ts.isNamedImports(bindings)) {
      for (const element of bindings.elements) {
        const imported = element.propertyName?.text ?? element.name.text;
        if (imported === 'createMcpHandler' || imported === 'toNodeHandler') {
          helperNames.add(element.name.text);
        }
      }
    } else if (bindings && ts.isNamespaceImport(bindings)) {
      helperNames.add(`${bindings.name.text}.createMcpHandler`);
      helperNames.add(`${bindings.name.text}.toNodeHandler`);
    }
  });
  if (helperNames.size === 0) return false;
  if (
    [...helperNames].some((name) =>
      new RegExp(`\\b${escapeRegExp(name)}\\s*\\(`).test(routeText),
    )
  ) {
    return true;
  }

  const bindings = new Set<string>();
  walk(sourceFile, (node) => {
    if (
      !ts.isVariableDeclaration(node) ||
      !ts.isIdentifier(node.name) ||
      !node.initializer ||
      !ts.isCallExpression(node.initializer)
    ) {
      return;
    }
    const called = calleeName(node.initializer);
    if (helperNames.has(called)) bindings.add(node.name.text);
  });
  return [...bindings].some((binding) => new RegExp(`\\b${escapeRegExp(binding)}\\b`).test(routeText));
}

function declarationText(file: PreparedFile, sourceFile: ts.SourceFile, name: string): string {
  let result = '';
  walk(sourceFile, (node) => {
    if (result) return;
    if (ts.isFunctionDeclaration(node) && node.name?.text === name) {
      result = codeTextWithoutComments(file, node.getStart(sourceFile, false), node.getEnd());
      return;
    }
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === name &&
      node.initializer
    ) {
      result = codeTextWithoutComments(
        file,
        node.initializer.getStart(sourceFile, false),
        node.initializer.getEnd(),
      );
    }
  });
  return result;
}

function codeTextWithoutComments(file: PreparedFile, start: number, end: number): string {
  const text = file.content.slice(start, end).split('');
  for (const range of file.commentRanges) {
    const from = Math.max(start, range.start);
    const to = Math.min(end, range.end);
    for (let offset = from; offset < to; offset++) {
      const local = offset - start;
      if (text[local] !== '\n' && text[local] !== '\r') text[local] = ' ';
    }
  }
  return text.join('');
}

/** Exported for tests: reads a property key from an object literal. */
export function readPropertyKey(node: ts.PropertyAssignment): string | null {
  return propertyKeyText(node.name);
}

export const headerRules: ScannerRule[] = [
  missingRequestHeadersRule,
  unvalidatedHeadersRule,
  headersImplementedRule,
];
