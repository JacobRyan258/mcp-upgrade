import ts from 'typescript';
import { DEFAULT_TARGET_VERSION, SOURCES } from '../../constants.js';
import type { Finding, PreparedFile, ScanContext, ScannerRule } from '../../types.js';
import { calleeName, collectHeaderAccess, getSourceFile, propertyKeyText, walk } from '../ast.js';
import { isInComment, offsetToPosition } from '../discovery.js';
import {
  buildFinding,
  dedupeByLocation,
  fileHasMcpSignal,
  filesFor,
  inMcpContext,
  matches,
} from './helpers.js';

/**
 * Group 2 — Streamable HTTP request headers (SEP-2243).
 *
 * The target specification requires `Mcp-Method` on every Streamable HTTP POST
 * and `Mcp-Name` on `tools/call`, `resources/read` and `prompts/get`. These
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
};

const ALL_MCP_METHODS = [
  'tools/call',
  'tools/list',
  'resources/read',
  'resources/list',
  'resources/templates/list',
  'prompts/get',
  'prompts/list',
  'completion/complete',
  'server/discover',
  'subscriptions/listen',
  'tasks/get',
  'tasks/update',
  'tasks/cancel',
];

const HEADER_EXPLANATION =
  'MCP 2026-07-28 requires standard routing headers on Streamable HTTP POST requests so that ' +
  'intermediaries can route without parsing the body. The transport spec lists Mcp-Method ' +
  '(mirroring the JSON-RPC method, on all requests) and Mcp-Name (mirroring params.name or ' +
  'params.uri, on tools/call, resources/read and prompts/get) and states "These headers are ' +
  'REQUIRED for compliance". A server implementing the new revision must reject a request that ' +
  'omits them with 400 Bad Request and JSON-RPC error -32020 (HeaderMismatch).';

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
  hasNameValue: boolean;
}

const REQUEST_CALLS = /(^|\.)(fetch|request|post|put|send|axios)$/i;

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

    const text = node.getText(sourceFile);
    const method = extractLiteralMethod(text);
    if (!method) return;

    const lowerText = text.toLowerCase();
    sites.push({
      offset: start,
      endOffset: node.getEnd(),
      method,
      hasMcpMethod: /['"`]mcp-method['"`]/i.test(text),
      hasMcpName: /['"`]mcp-name['"`]/i.test(text),
      hasNameValue:
        /\bname\s*:/.test(text) || /\buri\s*:/.test(text) || lowerText.includes('params'),
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
  return ALL_MCP_METHODS.includes(method) ? method : null;
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
  source: SOURCES.sep2243,
  appliesTo: { fileKinds: ['ts', 'js'], transports: [...HTTP_TRANSPORTS] },
  autofix: 'suggested',
  description:
    'Detects explicit HTTP request construction that sends an MCP JSON-RPC body without setting ' +
    'Mcp-Method (and Mcp-Name where the method requires it).',

  async scan(context: ScanContext): Promise<Finding[]> {
    const findings: Finding[] = [];
    // A wrapper or middleware may add the headers somewhere this scanner cannot
    // see, so the finding is downgraded rather than dropped.
    const abstracted = context.repository.httpRoutingIsAbstracted;

    for (const file of filesFor(this, context)) {
      // Generic method names (`tasks/get`, `tasks/cancel`) also occur in
      // non-MCP internal RPC layers; without any MCP signal in the repository
      // or file, a missing MCP header is not a defect.
      if (!inMcpContext(context, file)) continue;

      const sourceFile = getSourceFile(file);
      if (!sourceFile) continue;

      for (const site of findMcpRequestSites(file, sourceFile)) {
        if (!site.method) continue;

        const missing: string[] = [];
        if (!site.hasMcpMethod) missing.push('Mcp-Method');

        const nameSource = NAME_BEARING_METHODS[site.method];
        if (nameSource && !site.hasMcpName && site.hasNameValue) missing.push('Mcp-Name');

        if (missing.length === 0) continue;

        const nameClause = nameSource
          ? ` For ${site.method}, Mcp-Name must mirror ${nameSource}.`
          : '';

        findings.push(
          buildFinding(
            this,
            { file, offset: site.offset, endOffset: site.endOffset, text: site.method },
            {
              level: abstracted ? 'review' : 'error',
              confidence: abstracted ? 'low' : 'medium',
              title: abstracted
                ? `MCP request may be missing ${missing.join(' and ')} (headers may come from a wrapper)`
                : `MCP request omits ${missing.join(' and ')}`,
              explanation: abstracted
                ? `${HEADER_EXPLANATION} This call site sends "${site.method}" without ` +
                  `${missing.join(' or ')}, but the repository also contains header-injecting ` +
                  'middleware or a wrapped fetch, so the headers may well be added elsewhere. ' +
                  'This scanner does not follow values across files, so it reports the site for ' +
                  'review rather than asserting a break.'
                : `${HEADER_EXPLANATION} This call site sends "${site.method}" without ` +
                  `${missing.join(' or ')}.${nameClause}`,
              remediation:
                `Set ${missing.join(' and ')} on this request. Mcp-Method must equal the JSON-RPC ` +
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

const MCP_ROUTE_PATTERN =
  /\b(?:app|router|server)\.(?:post|all|use)\s*\(\s*['"`]([^'"`]*[/._-]mcp(?:[/._-][^'"`]*)?)['"`]/gi;

const NEXT_ROUTE_PATTERN = /\bexport\s+(?:const|async\s+function|function)\s+POST\b/g;

export const unvalidatedHeadersRule: ScannerRule = {
  id: 'MCP2026-HEADER-002',
  title: 'MCP route handler does not validate the required routing headers',
  category: 'http-headers',
  targetVersion: DEFAULT_TARGET_VERSION,
  level: 'review',
  defaultConfidence: 'medium',
  source: SOURCES.sep2243,
  appliesTo: { fileKinds: ['ts', 'js'], transports: [...HTTP_TRANSPORTS] },
  autofix: 'manual',
  description:
    'Detects MCP POST route handlers that never read Mcp-Method or Mcp-Name, so a disagreement ' +
    'between the headers and the JSON-RPC body cannot be rejected.',

  async scan(context: ScanContext): Promise<Finding[]> {
    const findings: Finding[] = [];

    // Header validation is frequently factored into its own module, and this
    // scanner does not follow values across files. If any scanned file names
    // a routing header *outside a comment*, assume the repository handles them
    // and stay quiet: a review item pointing at a route whose validation lives
    // one import away is noise, and noise is what makes a scanner get ignored.
    if (context.files.some((file) => mentionsRoutingHeaderInCode(file))) {
      context.trace(`  rule ${this.id}: suppressed — routing headers are handled somewhere in this repository`);
      return findings;
    }

    for (const file of filesFor(this, context)) {
      const sourceFile = getSourceFile(file);
      if (!sourceFile) continue;

      const routeHits = [
        ...matches(context, this, file, MCP_ROUTE_PATTERN),
        // A bare `export function POST` is every Next.js API route, MCP or
        // not; without an MCP signal in the file it is not an MCP endpoint.
        ...(fileHasMcpSignal(file) ? matches(context, this, file, NEXT_ROUTE_PATTERN) : []),
      ];

      for (const { hit } of routeHits) {
        findings.push(
          buildFinding(this, hit, {
            explanation:
              `${HEADER_EXPLANATION} This handler never reads Mcp-Method or Mcp-Name, so it cannot ` +
              'detect a request whose headers disagree with its body — the case SEP-2243 requires a ' +
              'server that processes the body to reject. Whether that matters depends on where the ' +
              'body is parsed, which static analysis cannot settle.',
            remediation:
              'If this handler parses the JSON-RPC body, compare Mcp-Method against the body method ' +
              'and Mcp-Name against params.name or params.uri, and reject a mismatch with 400 Bad ' +
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
/* MCP2026-HEADER-003 — headers already implemented                            */
/* -------------------------------------------------------------------------- */

export const headersImplementedRule: ScannerRule = {
  id: 'MCP2026-HEADER-003',
  title: 'Required MCP routing headers are already handled here',
  category: 'http-headers',
  targetVersion: DEFAULT_TARGET_VERSION,
  level: 'info',
  defaultConfidence: 'high',
  source: SOURCES.sep2243,
  appliesTo: { fileKinds: ['ts', 'js'], transports: [...HTTP_TRANSPORTS] },
  autofix: 'none',
  description:
    'Reports where Mcp-Method and Mcp-Name are already set or validated, so a repository that ' +
    'passes this rule group can be understood rather than just trusted.',

  async scan(context: ScanContext): Promise<Finding[]> {
    const findings: Finding[] = [];

    for (const file of filesFor(this, context)) {
      const sourceFile = getSourceFile(file);
      if (!sourceFile) continue;

      for (const access of collectHeaderAccess(sourceFile, REQUIRED_HEADER_NAMES)) {
        if (access.header === 'mcp-protocol-version') continue;
        if (isInComment(file, access.start)) {
          const { line } = offsetToPosition(file, access.start);
          context.noteCommentOnlyMatch(this.id, file.relPath, line, access.header);
          continue;
        }
        const canonical = access.header === 'mcp-method' ? 'Mcp-Method' : 'Mcp-Name';
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
                `${canonical} is a header MCP 2026-07-28 requires on Streamable HTTP POST requests, ` +
                'and it is already handled at this location. This entry exists so a clean report is ' +
                'legible: it is evidence of compliance, not a problem.',
              remediation:
                'No change required. When verifying the migration, confirm this path covers every ' +
                'MCP request the repository makes or serves, and that Mcp-Name is present for ' +
                'tools/call, resources/read and prompts/get.',
              transportApplicability: 'streamable-http',
            },
          ),
        );
      }

      // Object-literal header declarations the AST header pass does not treat
      // as header access, e.g. a plain `{ 'Mcp-Method': method }` constant.
      for (const { hit } of matches(context, this, file, /['"`]Mcp-(?:Method|Name)['"`]/gi)) {
        const canonical = /method/i.test(hit.text) ? 'Mcp-Method' : 'Mcp-Name';
        findings.push(
          buildFinding(this, hit, {
            title: `${canonical} is referenced here`,
            explanation:
              `${canonical} is a header MCP 2026-07-28 requires on Streamable HTTP POST requests, ` +
              'and it already appears at this location.',
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

/** A routing-header literal that is live code, not a commented-out line. */
function mentionsRoutingHeaderInCode(file: PreparedFile): boolean {
  const pattern = /['"`]mcp-(?:method|name)['"`]/gi;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(file.content)) !== null) {
    if (!isInComment(file, match.index)) return true;
  }
  return false;
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
