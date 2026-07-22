import {
  HTTP_FRAMEWORK_PACKAGES,
  MCP_PACKAGE_PREFIXES,
  MCP_SDK_PACKAGE,
  MCP_SDK_V2_PACKAGES,
} from '../constants.js';
import ts from 'typescript';
import { compareCodeUnits } from '../order.js';
import type {
  DetectedDependency,
  PreparedFile,
  RepositoryClassification,
  ResolvedScanOptions,
  TransportType,
} from '../types.js';
import { isInComment } from './discovery.js';
import { calleeName, getSourceFile, nodeAt, propertyKeyText, walk } from './ast.js';

/**
 * Lightweight repository classification.
 *
 * The transport verdict is the load-bearing output: it decides whether the
 * Streamable HTTP header rules run at all, so a stdio-only server is never
 * asked for HTTP headers it has no way to send.
 */

interface Signal {
  pattern: RegExp;
  label: string;
}

const STDIO_SIGNALS: Signal[] = [
  { pattern: /\bStdioServerTransport\b/, label: 'StdioServerTransport' },
  { pattern: /\bStdioClientTransport\b/, label: 'StdioClientTransport' },
  { pattern: /\bserveStdio\s*\(/, label: 'serveStdio()' },
  { pattern: /['"`]@modelcontextprotocol\/(?:sdk\/server\/)?stdio(?:\.js)?['"`]/, label: 'stdio transport import' },
  { pattern: /['"`]@modelcontextprotocol\/server\/stdio['"`]/, label: '@modelcontextprotocol/server/stdio' },
];

const STREAMABLE_HTTP_SIGNALS: Signal[] = [
  { pattern: /\bStreamableHTTPServerTransport\b/, label: 'StreamableHTTPServerTransport' },
  { pattern: /\bStreamableHTTPClientTransport\b/, label: 'StreamableHTTPClientTransport' },
  { pattern: /\bNodeStreamableHTTPServerTransport\b/, label: 'NodeStreamableHTTPServerTransport' },
  { pattern: /\bWebStandardStreamableHTTPServerTransport\b/, label: 'WebStandardStreamableHTTPServerTransport' },
  { pattern: /\bcreateMcpHandler\s*\(/, label: 'createMcpHandler()' },
  { pattern: /\btoNodeHandler\s*\(/, label: 'toNodeHandler()' },
  { pattern: /['"`][^'"`]*streamableHttp(?:\.js)?['"`]/, label: 'streamableHttp module import' },
];

const SSE_SIGNALS: Signal[] = [
  { pattern: /\bSSEServerTransport\b/, label: 'SSEServerTransport (deprecated HTTP+SSE transport)' },
];

/** Something is serving HTTP, but not through a recognised MCP transport. */
const CUSTOM_HTTP_SIGNALS: Signal[] = [
  {
    pattern:
      /\bfetch\s*\(\s*['"`][^'"`]*(?:^|[/._-])mcp(?:[/._-]|['"`])/i,
    label: 'MCP HTTP request',
  },
  {
    pattern: /\b(?:http\.)?createServer\s*\(\s*(?:handleMcp\w*|mcp\w*)\b/i,
    label: 'MCP-linked HTTP server',
  },
];

const HTTP_ROUTE_METHODS = new Set([
  'all',
  'delete',
  'get',
  'head',
  'options',
  'patch',
  'post',
  'put',
  'use',
]);

const HTTP_OBJECT_ROUTE_METHODS = new Set([
  'delete',
  'get',
  'head',
  'options',
  'patch',
  'post',
  'put',
]);

const MCP_REQUEST_METHOD =
  /^(?:server\/discover|tools\/(?:list|call)|resources\/(?:list|read)|prompts\/(?:list|get)|completion\/complete|subscriptions\/listen|tasks\/(?:get|update|cancel)|roots\/list|sampling\/createMessage|elicitation\/create)$/;

const NODE_HTTP_MODULE = /^(?:node:)?https?$/;

interface HttpBindings {
  factories: Set<string>;
  namespaces: Set<string>;
}

function literalText(node: ts.Expression | undefined): string | null {
  return node && ts.isStringLiteralLike(node) ? node.text : null;
}

function isMcpPath(value: string): boolean {
  return /(?:^|[._-]|\/)mcp(?:[._-]|\/|$)/i.test(value);
}

function terminalCalleePart(name: string): string {
  const part = name.slice(name.lastIndexOf('.') + 1);
  return part.toLowerCase();
}

/**
 * Identifier names that read as an HTTP route registrar. Exported so rules that
 * need to tell a server route from an outbound client call share one
 * vocabulary with the transport classifier instead of maintaining their own.
 */
export const ROUTE_RECEIVER_SOURCE =
  '(?:app|application|api|router|routes|fastify|hono|koa|express|server|web|mcp\\w*|rpc\\w*)';

function isRouteReceiver(name: string): boolean {
  const receiver = name.slice(0, name.lastIndexOf('.'));
  const terminal = receiver.slice(receiver.lastIndexOf('.') + 1);
  return new RegExp(`^${ROUTE_RECEIVER_SOURCE}$`, 'i').test(terminal);
}

function isHandlerReference(node: ts.Expression): boolean {
  if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) return true;
  if (ts.isIdentifier(node)) {
    return /(?:handler|handle|route|endpoint|middleware|callback|mcp|rpc)/i.test(node.text);
  }
  if (ts.isPropertyAccessExpression(node)) {
    return /(?:handler|handle|route|endpoint|middleware|callback|mcp|rpc)/i.test(node.name.text);
  }
  return false;
}

function hasRouteHandler(call: ts.CallExpression): boolean {
  return call.arguments.slice(1).some(isHandlerReference);
}

function objectProperty(
  object: ts.ObjectLiteralExpression,
  key: string,
): ts.ObjectLiteralElementLike | undefined {
  return object.properties.find((property) => {
    if (ts.isSpreadAssignment(property)) return false;
    return propertyKeyText(property.name) === key;
  });
}

function propertyInitializer(
  property: ts.ObjectLiteralElementLike | undefined,
): ts.Expression | undefined {
  if (!property || !ts.isPropertyAssignment(property)) return undefined;
  return property.initializer;
}

function hasHandlerProperty(object: ts.ObjectLiteralExpression): boolean {
  const handler = objectProperty(object, 'handler');
  return Boolean(
    handler &&
      (ts.isPropertyAssignment(handler) ||
        ts.isShorthandPropertyAssignment(handler) ||
        ts.isMethodDeclaration(handler)),
  );
}

function recordRequireBinding(
  declaration: ts.VariableDeclaration,
  bindings: HttpBindings,
): void {
  const initializer = declaration.initializer;
  if (!initializer || !ts.isCallExpression(initializer)) return;
  if (!ts.isIdentifier(initializer.expression) || initializer.expression.text !== 'require') return;
  const moduleName = literalText(initializer.arguments[0]);
  if (!moduleName || !NODE_HTTP_MODULE.test(moduleName)) return;

  if (ts.isIdentifier(declaration.name)) {
    bindings.namespaces.add(declaration.name.text);
    return;
  }
  if (!ts.isObjectBindingPattern(declaration.name)) return;
  for (const element of declaration.name.elements) {
    const imported = element.propertyName
      ? ts.isIdentifier(element.propertyName) || ts.isStringLiteralLike(element.propertyName)
        ? element.propertyName.text
        : null
      : element.name.getText();
    if (imported === 'createServer' && ts.isIdentifier(element.name)) {
      bindings.factories.add(element.name.text);
    }
  }
}

function collectHttpBindings(sourceFile: ts.SourceFile): HttpBindings {
  const bindings: HttpBindings = { factories: new Set(), namespaces: new Set() };
  for (const statement of sourceFile.statements) {
    if (
      ts.isImportDeclaration(statement) &&
      ts.isStringLiteralLike(statement.moduleSpecifier) &&
      NODE_HTTP_MODULE.test(statement.moduleSpecifier.text)
    ) {
      const clause = statement.importClause;
      if (clause?.isTypeOnly) continue;
      if (clause?.name) bindings.namespaces.add(clause.name.text);
      if (clause?.namedBindings && ts.isNamespaceImport(clause.namedBindings)) {
        bindings.namespaces.add(clause.namedBindings.name.text);
      } else if (clause?.namedBindings && ts.isNamedImports(clause.namedBindings)) {
        for (const element of clause.namedBindings.elements) {
          if (
            !element.isTypeOnly &&
            (element.propertyName?.text ?? element.name.text) === 'createServer'
          ) {
            bindings.factories.add(element.name.text);
          }
        }
      }
      continue;
    }
    if (ts.isImportEqualsDeclaration(statement)) {
      const reference = statement.moduleReference;
      const moduleName = ts.isExternalModuleReference(reference)
        ? literalText(reference.expression)
        : null;
      if (
        moduleName !== null &&
        NODE_HTTP_MODULE.test(moduleName)
      ) {
        bindings.namespaces.add(statement.name.text);
      }
      continue;
    }
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      recordRequireBinding(declaration, bindings);
    }
  }
  return bindings;
}

function isImportedHttpCreateServer(call: ts.CallExpression, bindings: HttpBindings): boolean {
  const expression = call.expression;
  if (ts.isIdentifier(expression)) return bindings.factories.has(expression.text);
  if (!ts.isPropertyAccessExpression(expression) || expression.name.text !== 'createServer') {
    return false;
  }
  if (ts.isIdentifier(expression.expression)) {
    return bindings.namespaces.has(expression.expression.text);
  }
  const receiver = expression.expression;
  if (!ts.isCallExpression(receiver)) return false;
  if (!ts.isIdentifier(receiver.expression) || receiver.expression.text !== 'require') return false;
  const moduleName = literalText(receiver.arguments[0]);
  return Boolean(moduleName && NODE_HTTP_MODULE.test(moduleName));
}

function isMethodAccess(node: ts.Expression): boolean {
  if (ts.isPropertyAccessExpression(node)) return node.name.text === 'method';
  return (
    ts.isElementAccessExpression(node) && literalText(node.argumentExpression) === 'method'
  );
}

function hasStrongMcpDispatch(sourceFile: ts.SourceFile): boolean {
  let found = false;
  walk(sourceFile, (node) => {
    if (found) return;
    if (ts.isCaseClause(node)) {
      const method = literalText(node.expression);
      if (method) found = MCP_REQUEST_METHOD.test(method);
      return;
    }
    if (ts.isBinaryExpression(node)) {
      const operator = node.operatorToken.kind;
      const compares =
        operator === ts.SyntaxKind.EqualsEqualsToken ||
        operator === ts.SyntaxKind.EqualsEqualsEqualsToken ||
        operator === ts.SyntaxKind.ExclamationEqualsToken ||
        operator === ts.SyntaxKind.ExclamationEqualsEqualsToken;
      if (!compares) return;
      const left = literalText(node.left);
      const right = literalText(node.right);
      if (left && MCP_REQUEST_METHOD.test(left) && isMethodAccess(node.right)) found = true;
      if (right && MCP_REQUEST_METHOD.test(right) && isMethodAccess(node.left)) found = true;
      return;
    }
    if (ts.isCallExpression(node) && /(?:^|\.)setRequestHandler$/.test(calleeName(node))) {
      const method = literalText(node.arguments[0]);
      if (method && MCP_REQUEST_METHOD.test(method)) found = true;
      return;
    }
  });
  return found;
}

/** AST-backed custom routes omitted by the intentionally narrow regex signals above. */
function customHttpEvidence(file: PreparedFile): Set<string> {
  const evidence = new Set<string>();
  const sourceFile = getSourceFile(file);
  if (!sourceFile) return evidence;
  const httpBindings = collectHttpBindings(sourceFile);
  const strongMcpDispatch = hasStrongMcpDispatch(sourceFile);

  walk(sourceFile, (node) => {
    if (!ts.isCallExpression(node)) return;
    const name = calleeName(node);
    const method = terminalCalleePart(name);
    const firstArgument = node.arguments[0];

    if (
      name.includes('.') &&
      isRouteReceiver(name) &&
      HTTP_ROUTE_METHODS.has(method) &&
      hasRouteHandler(node)
    ) {
      const route = literalText(firstArgument);
      if (route && isMcpPath(route)) evidence.add('MCP HTTP route');
    }

    if (method === 'route' && firstArgument && ts.isObjectLiteralExpression(firstArgument)) {
      const routeMethod = literalText(
        propertyInitializer(objectProperty(firstArgument, 'method')),
      );
      const path = literalText(
        propertyInitializer(
          objectProperty(firstArgument, 'url') ?? objectProperty(firstArgument, 'path'),
        ),
      );
      if (
        routeMethod &&
        HTTP_OBJECT_ROUTE_METHODS.has(routeMethod.toLowerCase()) &&
        path &&
        isMcpPath(path) &&
        hasHandlerProperty(firstArgument)
      ) {
        evidence.add('MCP object HTTP route');
      }
    }

    if (strongMcpDispatch && isImportedHttpCreateServer(node, httpBindings)) {
      evidence.add('MCP JSON-RPC HTTP server');
    }
  });
  return evidence;
}

const MCP_PATH_POST_SIGNALS: Signal[] = [
  {
    pattern: /\bexport\s+(?:async\s+)?function\s+POST\b/,
    label: 'MCP HTTP route handler',
  },
  { pattern: /\bexport\s+const\s+POST\b/, label: 'MCP HTTP route handler' },
];

/** Wrappers and middleware that may add MCP headers out of sight of a call site. */
const ABSTRACTION_SIGNALS: Signal[] = [
  { pattern: /\bapp\.use\s*\(/, label: 'framework middleware (app.use)' },
  { pattern: /\bfetchWithMiddleware\b|\bwithHeaders\b|\bapplyDefaultHeaders\b/, label: 'header-injecting wrapper' },
  { pattern: /\bcustomFetch\b|\bfetchImpl\b|\bfetchOverride\b/, label: 'custom fetch implementation' },
  { pattern: /\baxios\.create\s*\(/, label: 'axios instance with default headers' },
  { pattern: /\binterceptors\.request\.use\s*\(/, label: 'axios request interceptor' },
  { pattern: /\bcreateProxyMiddleware\b|\bhttp-proxy\b/, label: 'HTTP proxy middleware' },
  { pattern: /\bnew\s+Headers\s*\(/, label: 'shared Headers construction' },
];

export interface PackageManifest {
  name?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
}

function stringMap(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const result: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === 'string') result[key] = entry;
  }
  return result;
}

/** Parses only a root package.json that has already passed bounded discovery. */
export function readPackageManifest(files: PreparedFile[]): PackageManifest | null {
  const packageFile = files.find(
    (file) => file.relPath === 'package.json' && file.kind === 'json' && !file.isTestPath,
  );
  if (!packageFile) return null;

  try {
    const parsed: unknown = JSON.parse(packageFile.content.replace(/^\uFEFF/, ''));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const value = parsed as Record<string, unknown>;
    const dependencies = stringMap(value.dependencies);
    const devDependencies = stringMap(value.devDependencies);
    const peerDependencies = stringMap(value.peerDependencies);
    const optionalDependencies = stringMap(value.optionalDependencies);
    return {
      ...(typeof value.name === 'string' ? { name: value.name } : {}),
      ...(dependencies ? { dependencies } : {}),
      ...(devDependencies ? { devDependencies } : {}),
      ...(peerDependencies ? { peerDependencies } : {}),
      ...(optionalDependencies ? { optionalDependencies } : {}),
    };
  } catch {
    return null;
  }
}

function allDependencies(manifest: PackageManifest | null): Record<string, string> {
  if (!manifest) return {};
  const dependencies: Record<string, string> = Object.create(null) as Record<string, string>;
  Object.assign(
    dependencies,
    manifest.dependencies,
    manifest.devDependencies,
    manifest.peerDependencies,
    manifest.optionalDependencies,
  );
  return dependencies;
}

/** Counts a signal only when it appears outside a comment. */
function matchSignals(
  files: PreparedFile[],
  signals: Signal[],
  executableOnly = false,
): Set<string> {
  const found = new Set<string>();
  for (const file of files) {
    if (file.kind !== 'ts' && file.kind !== 'js') continue;
    for (const signal of signals) {
      const pattern = new RegExp(signal.pattern.source, `${signal.pattern.flags.replace('g', '')}g`);
      let match: RegExpExecArray | null;
      while ((match = pattern.exec(file.content)) !== null) {
        if (match[0] === '') {
          pattern.lastIndex++;
          continue;
        }
        const sourceFile = executableOnly ? getSourceFile(file) : null;
        const node = sourceFile ? nodeAt(sourceFile, match.index) : undefined;
        const insideLiteral =
          node !== undefined &&
          (ts.isStringLiteralLike(node) ||
            ts.isTemplateLiteral(node) ||
            ts.isRegularExpressionLiteral(node));
        if (!isInComment(file, match.index) && !insideLiteral) {
          found.add(signal.label);
          break;
        }
      }
    }
  }
  return found;
}

export function classifyTransport(
  files: PreparedFile[],
): { transport: TransportType; evidence: string[] } {
  const stdio = matchSignals(files, STDIO_SIGNALS, true);
  const http = matchSignals(files, STREAMABLE_HTTP_SIGNALS, true);
  const sse = matchSignals(files, SSE_SIGNALS, true);
  const custom = matchSignals(files, CUSTOM_HTTP_SIGNALS, true);
  for (const file of files) {
    for (const evidence of customHttpEvidence(file)) custom.add(evidence);
    if (!/(^|[/._-])mcp(?:[/._-]|$)/i.test(file.relPath)) continue;
    for (const evidence of matchSignals([file], MCP_PATH_POST_SIGNALS, true)) custom.add(evidence);
  }

  const httpish = new Set([...http, ...sse]);
  const evidence = [...stdio, ...httpish, ...custom].sort(compareCodeUnits);

  if (stdio.size > 0 && (httpish.size > 0 || custom.size > 0)) {
    return { transport: 'mixed', evidence };
  }
  if (httpish.size > 0) return { transport: 'streamable-http', evidence };
  if (stdio.size > 0) return { transport: 'stdio', evidence };
  if (custom.size > 0) return { transport: 'custom-http', evidence };
  return { transport: 'unknown', evidence };
}

const MCP_CONSTRUCTOR_SIGNALS: Signal[] = [
  { pattern: /\bnew\s+McpServer\s*\(/, label: 'new McpServer()' },
  { pattern: /\b(?:new\s+)?FastMCP\s*\(/, label: 'FastMCP construction' },
];

const MCP_PROTOCOL_SIGNALS: Signal[] = [
  { pattern: /\bcreateMcpHandler\s*\(/, label: 'createMcpHandler()' },
  {
    pattern:
      /(?:\bcase\s+|\bmethod\s*[:=]\s*|\bsetRequestHandler\s*\([^\n]{0,160})['"`]tools\/(?:list|call)['"`]/,
    label: 'tools/* method handler',
  },
  {
    pattern:
      /(?:\bcase\s+|\bmethod\s*[:=]\s*|\bsetRequestHandler\s*\([^\n]{0,160})['"`]resources\/(?:list|read)['"`]/,
    label: 'resources/* method handler',
  },
  {
    pattern:
      /(?:\bcase\s+|\bmethod\s*[:=]\s*|\bsetRequestHandler\s*\([^\n]{0,160})['"`]prompts\/(?:list|get)['"`]/,
    label: 'prompts/* method handler',
  },
];

function mcpImportEvidence(files: PreparedFile[]): Set<string> {
  const evidence = new Set<string>();
  const recordSpecifier = (node: ts.Expression | undefined): void => {
    if (node && ts.isStringLiteralLike(node) && node.text.startsWith('@modelcontextprotocol/')) {
      evidence.add('@modelcontextprotocol import');
    }
  };

  for (const file of files) {
    if (file.kind !== 'ts' && file.kind !== 'js') continue;
    const sourceFile = getSourceFile(file);
    if (!sourceFile) continue;
    walk(sourceFile, (node) => {
      if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
        recordSpecifier(node.moduleSpecifier);
        return;
      }
      if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
        recordSpecifier(node.moduleReference.expression);
        return;
      }
      if (!ts.isCallExpression(node) || node.arguments.length !== 1) return;
      const isRequire = ts.isIdentifier(node.expression) && node.expression.text === 'require';
      const isDynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
      if (isRequire || isDynamicImport) recordSpecifier(node.arguments[0]);
    });
  }
  return evidence;
}

export async function classify(
  files: PreparedFile[],
  options: ResolvedScanOptions,
): Promise<RepositoryClassification> {
  const manifest = readPackageManifest(files);
  const dependencies = allDependencies(manifest);

  const sdkRange = dependencies[MCP_SDK_PACKAGE];
  let sdk: DetectedDependency | null = sdkRange
    ? { name: MCP_SDK_PACKAGE, range: sdkRange }
    : null;

  const relatedDependencies: DetectedDependency[] = [];
  for (const [name, range] of Object.entries(dependencies)) {
    if (name === MCP_SDK_PACKAGE) continue;
    const isMcpPackage =
      MCP_SDK_V2_PACKAGES.includes(name) ||
      MCP_PACKAGE_PREFIXES.some((prefix) =>
        prefix.endsWith('/') ? name.startsWith(prefix) : name === prefix,
      );
    if (isMcpPackage) relatedDependencies.push({ name, range });
  }
  relatedDependencies.sort((a, b) => compareCodeUnits(a.name, b.name));

  // Fall back to a v2 package as "the SDK" when v1 is absent.
  if (!sdk && relatedDependencies.length > 0) {
    const preferred =
      relatedDependencies.find((dep) => MCP_SDK_V2_PACKAGES.includes(dep.name)) ??
      relatedDependencies[0];
    if (preferred) sdk = { ...preferred };
  }

  const frameworks = HTTP_FRAMEWORK_PACKAGES.filter((pkg) => pkg in dependencies).sort(
    compareCodeUnits,
  );

  const { transport, evidence: transportEvidence } = classifyTransport(files);

  const codeEvidence = matchSignals(files, MCP_PROTOCOL_SIGNALS, true);
  const importEvidence = mcpImportEvidence(files);
  for (const evidence of importEvidence) codeEvidence.add(evidence);
  if (
    importEvidence.size > 0 ||
    sdk !== null ||
    relatedDependencies.length > 0 ||
    codeEvidence.size > 0
  ) {
    for (const evidence of matchSignals(files, MCP_CONSTRUCTOR_SIGNALS, true)) {
      codeEvidence.add(evidence);
    }
  }
  for (const evidence of transportEvidence) {
    if (
      evidence === 'MCP HTTP route' ||
      evidence === 'MCP object HTTP route' ||
      evidence === 'MCP JSON-RPC HTTP server' ||
      evidence === 'MCP HTTP request' ||
      evidence === 'MCP HTTP route handler'
    ) {
      codeEvidence.add(evidence);
    }
  }
  const mcpEvidence = new Set(codeEvidence);
  if (sdk) mcpEvidence.add(`dependency: ${sdk.name}@${sdk.range}`);
  for (const dep of relatedDependencies) mcpEvidence.add(`dependency: ${dep.name}@${dep.range}`);
  const sortedMcpEvidence = [...mcpEvidence].sort(compareCodeUnits);

  const abstraction = matchSignals(files, ABSTRACTION_SIGNALS, true);

  const languages = { typescript: 0, javascript: 0, json: 0, yaml: 0 };
  for (const file of files) {
    if (file.kind === 'ts') languages.typescript++;
    else if (file.kind === 'js') languages.javascript++;
    else if (file.kind === 'json') languages.json++;
    else if (file.kind === 'yaml') languages.yaml++;
  }

  return {
    root: options.displayRoot,
    singleFile: options.singleFilePath !== null,
    isLikelyMcpServer: sortedMcpEvidence.length > 0,
    mcpEvidence: sortedMcpEvidence,
    languages,
    transport,
    transportEvidence,
    sdk,
    relatedDependencies,
    frameworks,
    httpRoutingIsAbstracted: abstraction.size > 0,
    packageName: manifest?.name ?? null,
  };
}
