import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  HTTP_FRAMEWORK_PACKAGES,
  MCP_PACKAGE_PREFIXES,
  MCP_SDK_PACKAGE,
  MCP_SDK_V2_PACKAGES,
} from '../constants.js';
import type {
  DetectedDependency,
  PreparedFile,
  RepositoryClassification,
  ResolvedScanOptions,
  TransportType,
} from '../types.js';
import { isInComment } from './discovery.js';

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
  { pattern: /\bcreateServer\s*\(/, label: 'http.createServer()' },
  { pattern: /\bapp\.(?:post|use|all)\s*\(\s*['"`][^'"`]*mcp/i, label: 'MCP HTTP route' },
  { pattern: /\bexport\s+(?:async\s+)?function\s+POST\b/, label: 'HTTP POST route handler export' },
  { pattern: /\bexport\s+const\s+POST\b/, label: 'HTTP POST route handler export' },
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

export async function readPackageManifest(rootDir: string): Promise<PackageManifest | null> {
  try {
    const raw = await fs.readFile(path.join(rootDir, 'package.json'), 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') return parsed as PackageManifest;
    return null;
  } catch {
    return null;
  }
}

function allDependencies(manifest: PackageManifest | null): Record<string, string> {
  if (!manifest) return {};
  return {
    ...manifest.dependencies,
    ...manifest.devDependencies,
    ...manifest.peerDependencies,
    ...manifest.optionalDependencies,
  };
}

/** Counts a signal only when it appears outside a comment. */
function matchSignals(files: PreparedFile[], signals: Signal[]): Set<string> {
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
        if (!isInComment(file, match.index)) {
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
  dependencies: Record<string, string>,
): { transport: TransportType; evidence: string[] } {
  const stdio = matchSignals(files, STDIO_SIGNALS);
  const http = matchSignals(files, STREAMABLE_HTTP_SIGNALS);
  const sse = matchSignals(files, SSE_SIGNALS);
  const custom = matchSignals(files, CUSTOM_HTTP_SIGNALS);

  const httpish = new Set([...http, ...sse]);
  const evidence = [...stdio, ...httpish, ...custom].sort((a, b) => a.localeCompare(b, 'en'));

  const hasHttpFramework = HTTP_FRAMEWORK_PACKAGES.some((pkg) => pkg in dependencies);

  if (stdio.size > 0 && httpish.size > 0) return { transport: 'mixed', evidence };
  if (httpish.size > 0) return { transport: 'streamable-http', evidence };
  if (stdio.size > 0) return { transport: 'stdio', evidence };
  if (custom.size > 0 || hasHttpFramework) {
    if (hasHttpFramework && !evidence.includes('HTTP framework dependency')) {
      evidence.push('HTTP framework dependency');
      evidence.sort((a, b) => a.localeCompare(b, 'en'));
    }
    return { transport: 'custom-http', evidence };
  }
  return { transport: 'unknown', evidence };
}

const MCP_CODE_SIGNALS: Signal[] = [
  { pattern: /['"`]@modelcontextprotocol\/[^'"`]+['"`]/, label: '@modelcontextprotocol import' },
  { pattern: /\bnew\s+McpServer\s*\(/, label: 'new McpServer()' },
  { pattern: /\bnew\s+Server\s*\(\s*\{[^}]*name\s*:/, label: 'new Server({ name, version })' },
  { pattern: /\bsetRequestHandler\s*\(/, label: 'setRequestHandler()' },
  { pattern: /\bregisterTool\s*\(/, label: 'registerTool()' },
  { pattern: /['"`]tools\/(?:list|call)['"`]/, label: 'tools/* method literal' },
  { pattern: /['"`]resources\/(?:list|read)['"`]/, label: 'resources/* method literal' },
  { pattern: /['"`]prompts\/(?:list|get)['"`]/, label: 'prompts/* method literal' },
  { pattern: /\bFastMCP\b/, label: 'FastMCP' },
];

/**
 * Renders a scan target for display. A relative path reads well when the target
 * is nearby, but degrades into a wall of `../` when it is not — so the absolute
 * path wins whenever it is shorter.
 */
function displayPath(target: string): string {
  const relative = path.relative(process.cwd(), target);
  if (relative === '') return '.';
  if (relative.startsWith('..') && relative.length >= target.length) return target;
  return relative;
}

export async function classify(
  files: PreparedFile[],
  options: ResolvedScanOptions,
): Promise<RepositoryClassification> {
  const manifest = await readPackageManifest(options.rootDir);
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
  relatedDependencies.sort((a, b) => a.name.localeCompare(b.name, 'en'));

  // Fall back to a v2 package as "the SDK" when v1 is absent.
  if (!sdk && relatedDependencies.length > 0) {
    const preferred =
      relatedDependencies.find((dep) => MCP_SDK_V2_PACKAGES.includes(dep.name)) ??
      relatedDependencies[0];
    if (preferred) sdk = preferred;
  }

  const frameworks = HTTP_FRAMEWORK_PACKAGES.filter((pkg) => pkg in dependencies).sort((a, b) =>
    a.localeCompare(b, 'en'),
  );

  const { transport, evidence: transportEvidence } = classifyTransport(files, dependencies);

  const codeEvidence = matchSignals(files, MCP_CODE_SIGNALS);
  const mcpEvidence = [...codeEvidence];
  if (sdk) mcpEvidence.push(`dependency: ${sdk.name}@${sdk.range}`);
  for (const dep of relatedDependencies) mcpEvidence.push(`dependency: ${dep.name}@${dep.range}`);
  mcpEvidence.sort((a, b) => a.localeCompare(b, 'en'));

  const abstraction = matchSignals(files, ABSTRACTION_SIGNALS);

  const languages = { typescript: 0, javascript: 0, json: 0, yaml: 0 };
  for (const file of files) {
    if (file.kind === 'ts') languages.typescript++;
    else if (file.kind === 'js') languages.javascript++;
    else if (file.kind === 'json') languages.json++;
    else if (file.kind === 'yaml') languages.yaml++;
  }

  return {
    root: displayPath(options.singleFilePath ?? options.rootDir),
    singleFile: options.singleFilePath !== null,
    isLikelyMcpServer: mcpEvidence.length > 0,
    mcpEvidence,
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
