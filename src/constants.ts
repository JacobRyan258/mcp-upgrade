import type { Confidence, FailOnLevel, FindingLevel, RuleSource, TargetSpec } from './types.js';

/* -------------------------------------------------------------------------- */
/* Versions                                                                    */
/* -------------------------------------------------------------------------- */

export const SCANNER_VERSION = '0.1.0';

export const BASELINE_PROTOCOL_VERSION = '2025-11-25';
export const DEFAULT_TARGET_VERSION = '2026-07-28';

/**
 * Target specifications this scanner knows how to evaluate. `2026-07-28` is a
 * release candidate: it was locked on 2026-05-21 and is scheduled for final
 * publication on 2026-07-28. Rules will be revalidated against the final text.
 */
export const KNOWN_TARGETS: Record<string, TargetSpec> = {
  '2026-07-28': {
    protocolVersion: '2026-07-28',
    status: 'release-candidate',
    baselineVersion: BASELINE_PROTOCOL_VERSION,
  },
};

export const RC_DISCLAIMER =
  'This tool targets the MCP 2026-07-28 release candidate. The final specification ' +
  'is not yet published; rules will be revalidated after publication.';

export const SCORE_DISCLAIMER =
  'Estimated migration readiness is a heuristic produced by this tool. It is not an ' +
  'official Model Context Protocol certification, score or endorsement.';

export const EFFORT_EXCLUSIONS = [
  'deployment and rollout',
  'integration and end-to-end testing',
  'downstream client changes',
  'coordination with hosting or gateway providers',
];

/* -------------------------------------------------------------------------- */
/* Discovery                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Build output, dependencies and vendored code. Always ignored — there is no
 * flag that re-enables these, because a finding in `node_modules` is never the
 * user's to fix.
 */
export const ALWAYS_IGNORE_PATTERNS = [
  'node_modules',
  '.git',
  'dist',
  'build',
  'coverage',
  '.next',
  'out',
  'vendor',
];

/** Ignored by default, re-enabled by `--include-tests`. */
export const TEST_IGNORE_PATTERNS = ['fixtures', 'test/fixtures'];

/** The complete default ignore list, as documented in `--help` and the README. */
export const DEFAULT_IGNORE_PATTERNS = [...ALWAYS_IGNORE_PATTERNS, ...TEST_IGNORE_PATTERNS];

/**
 * Additional path segments treated as test/fixture territory. Skipped unless
 * `--include-tests` is passed. Kept separate from DEFAULT_IGNORE_PATTERNS so
 * `--include-tests` can re-enable exactly this set.
 */
export const TEST_PATH_SEGMENTS = [
  '__tests__',
  '__mocks__',
  '__fixtures__',
  'fixtures',
  'test',
  'tests',
  'spec',
  'e2e',
];

export const TEST_FILE_SUFFIXES = [
  '.test.ts',
  '.test.tsx',
  '.test.js',
  '.test.jsx',
  '.test.mjs',
  '.test.cjs',
  '.spec.ts',
  '.spec.tsx',
  '.spec.js',
  '.spec.jsx',
  '.spec.mjs',
  '.spec.cjs',
];

export const SUPPORTED_EXTENSIONS = [
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.json',
  '.yaml',
  '.yml',
] as const;

/** Files larger than this are skipped and reported. */
export const MAX_FILE_BYTES = 1_048_576; // 1 MiB

/**
 * Resource budgets for a whole scan. A scanned repository is untrusted input;
 * without these a pathological tree could exhaust memory. Files beyond either
 * budget are reported skipped with reason `scan-limit`, never silently
 * dropped.
 */
export const MAX_FILES = 20_000;
export const MAX_TOTAL_BYTES = 33_554_432; // 32 MiB

/**
 * Parent-linked TypeScript ASTs amplify source size substantially. These
 * lexical preflight limits bound that amplification before an AST is built.
 * Literal/comment payload is not charged as structural line content, so large
 * generated schemas and embedded prose remain scannable when their syntax is
 * otherwise simple.
 */
export const MAX_PARSE_TOKENS_PER_FILE = 250_000;
export const MAX_PARSE_TOKENS_TOTAL = 500_000;
export const MAX_SOURCE_LINES_PER_FILE = 100_000;
export const MAX_SOURCE_LINES_TOTAL = 400_000;
export const MAX_SOURCE_LINE_LENGTH = 262_144; // 256 Ki structural code units

/** Evidence excerpts are collapsed to one line and truncated to this length. */
export const MAX_EVIDENCE_LENGTH = 160;

/* -------------------------------------------------------------------------- */
/* Ordering                                                                    */
/* -------------------------------------------------------------------------- */

export const LEVEL_RANK: Record<FindingLevel, number> = {
  error: 0,
  warning: 1,
  review: 2,
  info: 3,
};

export const CONFIDENCE_RANK: Record<Confidence, number> = {
  high: 0,
  medium: 1,
  low: 2,
};

/** Levels that meet or exceed a `--fail-on` threshold. */
export const FAIL_ON_LEVELS: Record<FailOnLevel, FindingLevel[]> = {
  error: ['error'],
  warning: ['error', 'warning'],
  review: ['error', 'warning', 'review'],
};

/* -------------------------------------------------------------------------- */
/* Exit codes                                                                  */
/* -------------------------------------------------------------------------- */

export const EXIT_OK = 0;
export const EXIT_FINDINGS = 1;
export const EXIT_USAGE = 2;
export const EXIT_INTERNAL = 3;

/* -------------------------------------------------------------------------- */
/* Official sources                                                            */
/* -------------------------------------------------------------------------- */

const SPEC_DRAFT = 'https://modelcontextprotocol.io/specification/draft';

export const SOURCES = {
  changelog: {
    title: 'MCP draft specification — Key Changes since 2025-11-25',
    url: `${SPEC_DRAFT}/changelog`,
  },
  rcAnnouncement: {
    title: 'The 2026-07-28 MCP Specification Release Candidate',
    url: 'https://blog.modelcontextprotocol.io/posts/2026-07-28-release-candidate/',
  },
  streamableHttp: {
    title: 'MCP draft specification — Streamable HTTP transport',
    url: `${SPEC_DRAFT}/basic/transports/streamable-http`,
  },
  resources: {
    title: 'MCP draft specification — Resources',
    url: `${SPEC_DRAFT}/server/resources`,
  },
  roots: {
    title: 'MCP draft specification — Roots',
    url: `${SPEC_DRAFT}/client/roots`,
  },
  sampling: {
    title: 'MCP draft specification — Sampling',
    url: `${SPEC_DRAFT}/client/sampling`,
  },
  logging: {
    title: 'MCP draft specification — Logging',
    url: `${SPEC_DRAFT}/server/utilities/logging`,
  },
  featureLifecycle: {
    title: 'MCP — Feature Lifecycle and Deprecation Policy',
    url: 'https://modelcontextprotocol.io/community/feature-lifecycle',
  },
  deprecatedRegistry: {
    title: 'MCP draft specification — Deprecated Features',
    url: `${SPEC_DRAFT}/deprecated`,
  },
  tasksExtension: {
    title: 'MCP Tasks extension — overview',
    url: 'https://modelcontextprotocol.io/extensions/tasks/overview',
  },
  appsExtension: {
    title: 'MCP Apps extension — overview',
    url: 'https://modelcontextprotocol.io/extensions/apps/overview',
  },
  sep2567: {
    title: 'SEP-2567 — Sessionless MCP via Explicit State Handles',
    url: 'https://modelcontextprotocol.io/seps/2567-sessionless-mcp',
    sep: 'SEP-2567',
  },
  sep2575: {
    title: 'SEP-2575 — Make MCP Stateless',
    url: 'https://modelcontextprotocol.io/seps/2575-stateless-mcp',
    sep: 'SEP-2575',
  },
  sep2243: {
    title: 'SEP-2243 — HTTP Header Standardization for Streamable HTTP Transport',
    url: 'https://modelcontextprotocol.io/seps/2243-http-standardization',
    sep: 'SEP-2243',
  },
  sep2164: {
    title: 'SEP-2164 — Standardize Resource Not Found Error Code',
    url: 'https://modelcontextprotocol.io/seps/2164-resource-not-found-error',
    sep: 'SEP-2164',
  },
  sep2663: {
    title: 'SEP-2663 — Tasks Extension',
    url: 'https://modelcontextprotocol.io/seps/2663-tasks-extension',
    sep: 'SEP-2663',
  },
  sep1686: {
    title: 'SEP-1686 — Tasks (2025-11-25 baseline)',
    url: 'https://modelcontextprotocol.io/seps/1686-tasks',
    sep: 'SEP-1686',
  },
  sep2577: {
    title: 'SEP-2577 — Deprecate Roots, Sampling, and Logging',
    url: 'https://modelcontextprotocol.io/seps/2577-deprecate-roots-sampling-and-logging',
    sep: 'SEP-2577',
  },
  sep2322: {
    title: 'SEP-2322 — Multi Round-Trip Requests',
    url: 'https://modelcontextprotocol.io/seps/2322-MRTR',
    sep: 'SEP-2322',
  },
  sep2596: {
    title: 'SEP-2596 — Specification Feature Lifecycle and Deprecation Policy',
    url: 'https://modelcontextprotocol.io/seps/2596-spec-feature-lifecycle-and-deprecation',
    sep: 'SEP-2596',
  },
  sep1865: {
    title: 'SEP-1865 — MCP Apps: Interactive User Interfaces for MCP',
    url: 'https://modelcontextprotocol.io/seps/1865-mcp-apps-interactive-user-interfaces-for-mcp',
    sep: 'SEP-1865',
  },
} as const satisfies Record<string, RuleSource>;

/* -------------------------------------------------------------------------- */
/* Protocol vocabulary                                                         */
/* -------------------------------------------------------------------------- */

/** Packages that identify a repository as MCP-related. */
export const MCP_PACKAGE_PREFIXES = [
  '@modelcontextprotocol/',
  'fastmcp',
  'mcp-framework',
  '@vercel/mcp-adapter',
  'mcp-handler',
  'xmcp',
];

/** The official TypeScript SDK v1 package. */
export const MCP_SDK_PACKAGE = '@modelcontextprotocol/sdk';

/** v2 beta packages, published as a split. */
export const MCP_SDK_V2_PACKAGES = [
  '@modelcontextprotocol/server',
  '@modelcontextprotocol/client',
  '@modelcontextprotocol/core',
  '@modelcontextprotocol/node',
  '@modelcontextprotocol/express',
  '@modelcontextprotocol/hono',
  '@modelcontextprotocol/fastify',
];

export const HTTP_FRAMEWORK_PACKAGES = [
  'express',
  'fastify',
  'hono',
  'koa',
  'next',
  '@hapi/hapi',
  'restify',
  'polka',
  'h3',
  'elysia',
];

/** Required Streamable HTTP routing headers introduced by SEP-2243. */
export const REQUIRED_MCP_HEADERS = ['Mcp-Method', 'Mcp-Name'] as const;

/** Required per-request protocol version header. Note the all-caps `MCP-` prefix. */
export const PROTOCOL_VERSION_HEADER = 'MCP-Protocol-Version';

/** The removed session header. */
export const SESSION_HEADER = 'Mcp-Session-Id';

/** Extension identifiers in the target specification. */
export const EXTENSION_IDS = {
  tasks: 'io.modelcontextprotocol/tasks',
  ui: 'io.modelcontextprotocol/ui',
} as const;

/** `_meta` keys that replace the removed handshake. */
export const META_KEYS = {
  protocolVersion: 'io.modelcontextprotocol/protocolVersion',
  clientInfo: 'io.modelcontextprotocol/clientInfo',
  clientCapabilities: 'io.modelcontextprotocol/clientCapabilities',
  logLevel: 'io.modelcontextprotocol/logLevel',
} as const;

/** MIME type for MCP Apps UI resources. */
export const MCP_APP_MIME_TYPE = 'text/html;profile=mcp-app';
