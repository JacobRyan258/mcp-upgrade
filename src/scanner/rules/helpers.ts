import type {
  Confidence,
  Finding,
  FindingLevel,
  PreparedFile,
  RuleSource,
  ScanContext,
  ScannerRule,
} from '../../types.js';
import ts from 'typescript';
import { calleeName, getSourceFile, nodeAt, propertyKeyText, walk } from '../ast.js';
import { isInComment, lineText, offsetToPosition } from '../discovery.js';
import { isPrivateKeyPosition, redact, toEvidence } from '../redaction.js';

/**
 * Shared plumbing for rules. Every rule expresses *what* to look for; this
 * module owns the parts that must behave identically everywhere — comment
 * suppression, evidence redaction, position arithmetic and finding shape.
 */

export interface Hit {
  file: PreparedFile;
  /** Character offset of the match. */
  offset: number;
  /** End offset, used for `endLine`. */
  endOffset?: number;
  /** Raw matched text, before redaction. */
  text: string;
}

/** Files a rule is allowed to look at. */
export function fileApplies(rule: ScannerRule, file: PreparedFile): boolean {
  return rule.appliesTo.fileKinds.includes(file.kind);
}

/** Whether a rule runs at all given the repository's transport. */
export function transportApplies(rule: ScannerRule, context: ScanContext): boolean {
  return rule.appliesTo.transports.includes(context.repository.transport);
}

/** Files this rule should scan, in deterministic order. */
export function filesFor(rule: ScannerRule, context: ScanContext): PreparedFile[] {
  return context.files.filter((file) => fileApplies(rule, file));
}

/**
 * Iterates regular-expression matches in a file, skipping anything inside a
 * comment. Comment-only matches are recorded on the context so `--verbose` can
 * report them as ignored evidence rather than silently dropping them.
 */
export function* matches(
  context: ScanContext,
  rule: ScannerRule,
  file: PreparedFile,
  pattern: RegExp,
): Generator<{ hit: Hit; match: RegExpExecArray }> {
  const flags = pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`;
  const scoped = new RegExp(pattern.source, flags);
  let match: RegExpExecArray | null;
  const budget = matchBudget(context, rule.id);

  while ((match = scoped.exec(file.content)) !== null) {
    if (budget.inspected++ >= MAX_INSPECTED_MATCHES_PER_RULE || budget.emitted >= MAX_RULE_MATCHES) {
      if (!budget.traced) {
        context.trace(`  rule ${rule.id}: lexical match budget reached; remaining matches skipped`);
        context.noteAnalysisLimit(
          rule.id,
          file.relPath,
          'Lexical match budget reached; remaining matches were skipped.',
        );
        budget.traced = true;
      }
      return;
    }
    if (match[0] === '') {
      scoped.lastIndex++;
      continue;
    }
    const offset = match.index;
    if (isInComment(file, offset)) {
      const { line } = offsetToPosition(file, offset);
      context.noteCommentOnlyMatch(rule.id, file.relPath, line, match[0]);
      continue;
    }
    yield {
      hit: { file, offset, endOffset: offset + match[0].length, text: match[0] },
      match,
    };
    budget.emitted++;
  }
}

interface MatchBudget {
  inspected: number;
  emitted: number;
  traced: boolean;
}

const MAX_RULE_MATCHES = 20_000;
const MAX_INSPECTED_MATCHES_PER_RULE = 100_000;
const MATCH_BUDGETS = Symbol('mcp-upgrade.match-budgets');
type BudgetedContext = ScanContext & { [MATCH_BUDGETS]?: Map<string, MatchBudget> };

function matchBudget(context: ScanContext, ruleId: string): MatchBudget {
  const budgeted = context as BudgetedContext;
  let scan = budgeted[MATCH_BUDGETS];
  if (!scan) {
    scan = new Map();
    budgeted[MATCH_BUDGETS] = scan;
  }
  let budget = scan.get(ruleId);
  if (!budget) {
    budget = { inspected: 0, emitted: 0, traced: false };
    scan.set(ruleId, budget);
  }
  return budget;
}

export interface FindingInput {
  explanation: string;
  remediation: string;
  /** Overrides the rule's default level. */
  level?: FindingLevel;
  /** Overrides the rule's default confidence. */
  confidence?: Confidence;
  /** Overrides the rule's title for this specific finding. */
  title?: string;
  /** More specific official source for a method-specific finding. */
  source?: RuleSource;
  transportApplicability?: string;
  /** Evidence text. Defaults to the matched line, which reads better than a bare token. */
  evidence?: string;
}

/**
 * Builds a finding. Evidence defaults to the whole source line rather than the
 * matched token: a bare `-32002` tells a reviewer nothing, whereas the line it
 * sits on is usually self-explanatory. It is redacted and bounded either way.
 */
export function buildFinding(rule: ScannerRule, hit: Hit, input: FindingInput): Finding {
  const { line, column } = offsetToPosition(hit.file, hit.offset);
  const endOffset = hit.endOffset ?? hit.offset + hit.text.length;
  const endLine = offsetToPosition(hit.file, Math.max(hit.offset, endOffset - 1)).line;
  const rawEvidence = input.evidence ?? evidenceLine(hit, line, column);

  const finding: Finding = {
    ruleId: rule.id,
    level: input.level ?? rule.level,
    confidence: input.confidence ?? rule.defaultConfidence,
    category: rule.category,
    title: input.title ?? rule.title,
    file: hit.file.relPath,
    line,
    column,
    evidence: toEvidence(sanitizeEvidence(rawEvidence)),
    explanation: input.explanation,
    remediation: input.remediation,
    // A report is a public data contract. Do not let a consumer mutate the
    // registry-owned source object through one of its findings.
    source: { ...(input.source ?? rule.source) },
    autofix: rule.autofix,
  };

  if (endLine !== line) finding.endLine = endLine;
  if (input.transportApplicability) finding.transportApplicability = input.transportApplicability;
  Object.defineProperty(finding, FINDING_SPAN, {
    value: `${hit.file.relPath}\u0000${hit.offset}\u0000${hit.endOffset ?? hit.offset + hit.text.length}`,
    enumerable: false,
  });
  return finding;
}

const FINDING_SPAN: unique symbol = Symbol('mcp-upgrade.finding-span');
type SpannedFinding = Finding & { [FINDING_SPAN]?: string };

/**
 * The source line as evidence — windowed around the match when the line is
 * longer than an excerpt can show, so the matched token is always visible
 * (minified files are single multi-kilobyte lines; the head of one says
 * nothing).
 */
function evidenceLine(hit: Hit, line: number, column: number): string {
  if (isPrivateKeyPosition(hit.file.content, hit.offset)) return '[REDACTED:private-key]';
  const raw = lineText(hit.file, line) || hit.text;
  // Redact the complete source line before choosing a window. Windowing first
  // can split a credential assignment or token prefix away from its secret and
  // thereby defeat a context-sensitive redaction rule.
  const text = sanitizeEvidence(redact(raw));
  if (text.length <= 200) return text;

  // Redaction can change the length of the prefix. Compute the corresponding
  // position from a separately redacted prefix, but only slice the fully
  // redacted line above.
  const rawIndex = Math.max(0, column - 1);
  const redactedIndex = sanitizeEvidence(redact(raw.slice(0, rawIndex))).length;
  const start = Math.max(0, redactedIndex - 80);
  return `${start > 0 ? '...' : ''}${text.slice(start, start + 240)}`;
}

/** Removes terminal/control bytes that must never reach a rendered report. */
function sanitizeEvidence(input: string): string {
  return input.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, '?');
}

/**
 * Keeps at most one finding per rule per exact source span.
 *
 * A rule commonly matches the same line through several routes — an AST pass
 * and a lexical fallback, or two nested capability paths in one object literal.
 * Reporting that line once keeps the report readable and the score honest,
 * without hiding any distinct location. The most severe, then most confident,
 * candidate for a span wins. Distinct violations on a minified one-line file
 * remain distinct findings.
 */
export function dedupeByLocation(findings: Finding[]): Finding[] {
  const bySpan = new Map<string, Finding>();

  for (const finding of findings) {
    const location =
      (finding as SpannedFinding)[FINDING_SPAN] ??
      `${finding.file}\u0000${finding.line}\u0000${finding.column ?? 0}\u0000${finding.endLine ?? finding.line}`;
    const key = `${finding.ruleId}\u0000${location}`;
    const incumbent = bySpan.get(key);
    if (!incumbent || outranks(finding, incumbent)) bySpan.set(key, finding);
  }

  return [...bySpan.values()];
}

const LEVEL_SEVERITY: Record<Finding['level'], number> = {
  error: 0,
  warning: 1,
  review: 2,
  info: 3,
};

const CONFIDENCE_STRENGTH: Record<Finding['confidence'], number> = {
  high: 0,
  medium: 1,
  low: 2,
};

function outranks(candidate: Finding, incumbent: Finding): boolean {
  const bySeverity = LEVEL_SEVERITY[candidate.level] - LEVEL_SEVERITY[incumbent.level];
  if (bySeverity !== 0) return bySeverity < 0;
  return CONFIDENCE_STRENGTH[candidate.confidence] < CONFIDENCE_STRENGTH[incumbent.confidence];
}

/** Builds an alternation regex from literal strings, longest first. */
export function literalAlternation(literals: readonly string[]): string {
  return [...literals]
    .sort((a, b) => b.length - a.length)
    .map((literal) => literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('|');
}

/**
 * Matches an MCP protocol method name appearing as a quoted string literal.
 * Requiring quotes is what keeps `tasks/list` from matching a URL path or a
 * comment fragment.
 */
export function quotedLiteral(literals: readonly string[]): RegExp {
  return new RegExp(`['"\`](${literalAlternation(literals)})['"\`]`, 'g');
}

/** Matches a bare identifier such as an SDK schema constant. */
export function identifierLiteral(literals: readonly string[]): RegExp {
  return new RegExp(`\\b(${literalAlternation(literals)})\\b`, 'g');
}

/**
 * True when any of the given needles appear within `radius` chars of the match.
 *
 * Two hardenings both exist because their absence produced confirmed false
 * positives: the matched span itself is excluded from the window (otherwise a
 * needle that is a substring of the match makes the gate self-satisfying), and
 * purely alphabetic needles are matched on word boundaries (otherwise `uri`
 * matches "during" and "security").
 */
export function hasContextNear(
  file: PreparedFile,
  offset: number,
  needles: readonly (string | RegExp)[],
  radius = 400,
  matchEnd: number = offset,
): boolean {
  const before = file.content.slice(Math.max(0, offset - radius), offset).toLowerCase();
  const after = file.content
    .slice(matchEnd, Math.min(file.content.length, matchEnd + radius))
    .toLowerCase();
  return needles.some((needle) => {
    if (needle instanceof RegExp) return needle.test(before) || needle.test(after);
    const lower = needle.toLowerCase();
    if (/^[a-z]+$/.test(lower)) {
      const bounded = new RegExp(`\\b${lower}\\b`);
      return bounded.test(before) || bounded.test(after);
    }
    return before.includes(lower) || after.includes(lower);
  });
}

/**
 * Signals that a file is MCP-related at all. Used to gate patterns that are
 * individually too generic to assert on arbitrary code — an EventEmitter
 * handling "initialize", a REST route called "tasks/list", a config object
 * with a top-level `logging` key. Coarse on purpose: it only decides whether
 * MCP rules have any business looking at this file, never whether a specific
 * line is a finding.
 */
export function fileHasMcpSignal(file: PreparedFile): boolean {
  const cached = (file as SignaledFile)[MCP_SIGNAL];
  if (cached !== undefined) return cached;
  if (/(^|\/)mcp(?:[._/-]|$)/i.test(file.relPath)) return cacheMcpSignal(file, true);
  const sourceFile = getSourceFile(file);
  if (!sourceFile) return cacheMcpSignal(file, false);
  const hasEsmMcpImport = sourceFile.statements.some(
    (statement) =>
      ts.isImportDeclaration(statement) &&
      ts.isStringLiteralLike(statement.moduleSpecifier) &&
      (statement.moduleSpecifier.text.startsWith('@modelcontextprotocol/') ||
        /(?:^|\/)fastmcp(?:$|\/)/i.test(statement.moduleSpecifier.text)),
  );
  const relativeServerBindings = new Set<string>();
  for (const statement of sourceFile.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteralLike(statement.moduleSpecifier) ||
      !/^\./.test(statement.moduleSpecifier.text) ||
      !/(?:^|[/._-])(?:mcp|server)(?:[/._-]|$)/i.test(statement.moduleSpecifier.text)
    ) {
      continue;
    }
    const clause = statement.importClause;
    if (clause?.name) relativeServerBindings.add(clause.name.text);
    if (clause?.namedBindings && ts.isNamedImports(clause.namedBindings)) {
      for (const element of clause.namedBindings.elements) {
        const imported = element.propertyName?.text ?? element.name.text;
        if (/^(?:server|mcpServer)$/i.test(imported)) relativeServerBindings.add(element.name.text);
      }
    }
  }
  let hasCjsMcpImport = false;
  walk(sourceFile, (node) => {
    if (!ts.isCallExpression(node) || calleeName(node) !== 'require') return;
    const first = node.arguments[0];
    if (
      first &&
      ts.isStringLiteralLike(first) &&
      (first.text.startsWith('@modelcontextprotocol/') || /(?:^|\/)fastmcp(?:$|\/)/i.test(first.text))
    ) {
      hasCjsMcpImport = true;
    }
  });
  const hasMcpImport = hasEsmMcpImport || hasCjsMcpImport;
  let found = hasMcpImport;
  walk(sourceFile, (node) => {
    if (found) return;
    if (
      ts.isImportDeclaration(node) &&
      ts.isStringLiteralLike(node.moduleSpecifier) &&
      (node.moduleSpecifier.text.startsWith('@modelcontextprotocol/') ||
        /(?:^|\/)fastmcp(?:$|\/)/i.test(node.moduleSpecifier.text))
    ) {
      found = true;
      return;
    }
    if (ts.isNewExpression(node)) {
      const name = calleeName(node);
      if (hasMcpImport && /^(?:McpServer|FastMCP)$/.test(name)) found = true;
      return;
    }
    if (ts.isCallExpression(node)) {
      const name = calleeName(node);
      if (
        hasMcpImport &&
        /(?:^|\.)(?:mcpServer|server|client)\.(?:connect|register(?:Tool|Prompt|Resource)|setRequestHandler)$/.test(
          name,
        )
      ) {
        found = true;
      }
      const receiver = /^([A-Za-z_$][\w$]*)\.(?:listRoots|createMessage|requestSampling|elicitInput|sendLoggingMessage)$/.exec(
        name,
      )?.[1];
      if (receiver && relativeServerBindings.has(receiver)) found = true;
      return;
    }
    if (ts.isCaseClause(node) && ts.isStringLiteralLike(node.expression)) {
      if (isStrongMcpMethod(node.expression.text) || (hasMcpImport && isKnownMcpMethod(node.expression.text))) {
        found = true;
      }
      return;
    }
    if (ts.isClassDeclaration(node) && node.name?.text === 'McpError') {
      if (hasMcpImport) found = true;
      return;
    }
    if (!ts.isPropertyAssignment(node)) return;
    const key = propertyKeyText(node.name);
    if (key !== 'method' || !ts.isStringLiteralLike(node.initializer)) return;
    const object = ts.isObjectLiteralExpression(node.parent) ? node.parent : null;
    const rawJsonRpc = Boolean(
      object?.properties.some(
        (entry) =>
          ts.isPropertyAssignment(entry) &&
          propertyKeyText(entry.name) === 'jsonrpc' &&
          ts.isStringLiteralLike(entry.initializer) &&
          entry.initializer.text === '2.0',
      ),
    );
    if (
      isStrongMcpMethod(node.initializer.text) ||
      ((hasMcpImport || rawJsonRpc) && isKnownMcpMethod(node.initializer.text))
    ) {
      found = true;
    }
  });
  return cacheMcpSignal(file, found);
}

/**
 * True when a string literal reads as a sentence rather than a protocol value.
 *
 * A dispatch literal is exactly the method name, so any whitespace means the
 * token is embedded in something larger. That something is usually prose — but
 * it can also be a formatted JSON-RPC envelope shipped as a string, so a
 * literal carrying JSON structure is not treated as prose.
 */
function isProseLiteral(text: string): boolean {
  if (!/\s/.test(text)) return false;
  return !/[{}]/.test(text);
}

/**
 * True for a value that can serve a request: a function, a reference to one, or
 * a handler-bearing object. A string, number, or plain data literal cannot.
 */
function isHandlerValue(value: ts.Expression): boolean {
  if (ts.isArrowFunction(value) || ts.isFunctionExpression(value)) return true;
  if (ts.isIdentifier(value) || ts.isPropertyAccessExpression(value)) return true;
  if (ts.isCallExpression(value)) return true;
  if (ts.isAsExpression(value) || ts.isParenthesizedExpression(value)) {
    return isHandlerValue(value.expression);
  }
  if (ts.isObjectLiteralExpression(value)) {
    return value.properties.some(
      (entry) =>
        ts.isMethodDeclaration(entry) ||
        (ts.isPropertyAssignment(entry) && isHandlerValue(entry.initializer)),
    );
  }
  return false;
}

/** True when an object literal carries the JSON-RPC `jsonrpc: "2.0"` marker. */
function hasJsonRpcMarker(object: ts.ObjectLiteralExpression): boolean {
  return object.properties.some(
    (entry) =>
      ts.isPropertyAssignment(entry) &&
      propertyKeyText(entry.name) === 'jsonrpc' &&
      ts.isStringLiteralLike(entry.initializer) &&
      entry.initializer.text === '2.0',
  );
}

function isStrongMcpMethod(value: string): boolean {
  return value.includes('/') && isKnownMcpMethod(value);
}

function isKnownMcpMethod(value: string): boolean {
  return /^(?:server\/discover|tools\/(?:list|call)|resources\/(?:list|read)|prompts\/(?:list|get)|tasks\/(?:list|result|get|update|cancel)|roots\/list|sampling\/createMessage|elicitation\/create|initialize|notifications\/initialized|ping|logging\/setLevel|notifications\/roots\/list_changed)$/.test(
    value,
  );
}

/** True when a file visibly consumes MCP as a client and has no server-side surface. */
export function isClientOnlyMcpFile(file: PreparedFile): boolean {
  const sourceFile = getSourceFile(file);
  if (!sourceFile) return false;
  let clientImport = false;
  let serverSignal = false;
  walk(sourceFile, (node) => {
    if (
      ts.isImportDeclaration(node) &&
      ts.isStringLiteralLike(node.moduleSpecifier) &&
      node.moduleSpecifier.text.startsWith('@modelcontextprotocol/')
    ) {
      const module = node.moduleSpecifier.text;
      if (/(?:^|\/)client(?:\/|$)/.test(module)) clientImport = true;
      if (/(?:^|\/)server(?:\/|$)/.test(module)) serverSignal = true;
      return;
    }
    if (ts.isCallExpression(node) && calleeName(node) === 'require') {
      const first = node.arguments[0];
      if (first && ts.isStringLiteralLike(first) && first.text.startsWith('@modelcontextprotocol/')) {
        if (/(?:^|\/)client(?:\/|$)/.test(first.text)) clientImport = true;
        if (/(?:^|\/)server(?:\/|$)/.test(first.text)) serverSignal = true;
      }
      return;
    }
    if (ts.isNewExpression(node) && /^(?:McpServer|Server|FastMCP)$/.test(calleeName(node))) {
      serverSignal = true;
      return;
    }
    if (
      ts.isCallExpression(node) &&
      /(?:^|\.)(?:setRequestHandler|registerTool|registerPrompt|registerResource|createMcpHandler|serveStdio)$/.test(
        calleeName(node),
      )
    ) {
      serverSignal = true;
    }
  });
  return clientImport && !serverSignal;
}

const MCP_SIGNAL: unique symbol = Symbol('mcp-upgrade.file-mcp-signal');
type SignaledFile = PreparedFile & { [MCP_SIGNAL]?: boolean };

function cacheMcpSignal(file: PreparedFile, value: boolean): boolean {
  if (Object.isExtensible(file)) {
    Object.defineProperty(file, MCP_SIGNAL, { value, enumerable: false });
  }
  return value;
}

/** True when a quoted protocol token participates in executable dispatch or emission. */
export function isExecutableProtocolLiteral(sourceFile: ts.SourceFile, offset: number): boolean {
  let current = nodeAt(sourceFile, offset);

  // A protocol token embedded in a sentence is documentation, not a dispatch
  // value: a real dispatch literal is exactly the method name, and method names
  // contain no whitespace. Without this, any exported help-text constant that
  // mentions a removed method is asserted as an implementation of it. Template
  // literals are deliberately excluded — rules give multi-line templates their
  // own review-level treatment rather than dropping them.
  if (current && ts.isStringLiteral(current) && isProseLiteral(current.text)) return false;

  // Set while walking out of the literal, so the variable-declaration branch
  // below can tell a dispatch table from an inert data registry.
  let isDispatchKey = false;
  let isWireRequest = false;
  let insideArray = false;
  let depth = 0;
  while (current && depth < 14) {
    const parent = current.parent;
    if (!parent) return false;
    if (ts.isArrayLiteralExpression(parent)) insideArray = true;
    if (ts.isPropertyAssignment(parent)) {
      // A method-shaped KEY is dispatch only when the value is something that
      // can handle a call. Accepting any value made every inert data map keyed
      // by method name — i18n labels, documentation links, metric counters —
      // an asserted implementation of a removed RPC.
      if (parent.name === current && isHandlerValue(parent.initializer)) isDispatchKey = true;
      else if (
        propertyKeyText(parent.name) === 'method' &&
        parent.initializer === current &&
        ts.isObjectLiteralExpression(parent.parent) &&
        hasJsonRpcMarker(parent.parent)
      ) {
        // A `method:` value only proves emission alongside a `jsonrpc: "2.0"`
        // sibling. Without that marker, `{ method: 'tasks/list' }` is just as
        // likely to be a rule table or test fixture as a request.
        isWireRequest = true;
      }
    }
    if (ts.isBinaryExpression(parent)) {
      // Comparisons and dispatch expressions are executable protocol use. A
      // `+` expression is commonly just a long diagnostic or documentation
      // string, so keep walking until its actual consumer is known.
      if (parent.operatorToken.kind !== ts.SyntaxKind.PlusToken) return true;
    } else if (ts.isCaseClause(parent) || ts.isReturnStatement(parent)) {
      return true;
    }
    if (ts.isCallExpression(parent)) {
      const name = calleeName(parent);
      // `notification` is the v1 SDK's generic notification method and
      // `literal` covers the zod schema constructors the SDK itself uses to
      // define request schemas (`z.literal('tasks/list')`); both were dispatch
      // sites the allowlist silently dropped.
      return /(?:^|\.)(?:setRequestHandler|setNotificationHandler|onRequest|onNotification|send|sendRequest|request|notify|notification|sendNotification|publish|dispatch|literal|register\w*|handle\w*|on)$/.test(
        name,
      );
    }
    if (ts.isVariableDeclaration(parent)) {
      // A protocol token nested in a registry array/object is data, not an
      // executable alias — unless it sits in a dispatch position. A quoted
      // method used as an object KEY (`const handlers = { 'logging/setLevel':
      // fn }`) is how a hand-rolled JSON-RPC server routes that method, and a
      // `method:` VALUE in a bound request object is a protocol emission. Both
      // become live through the same later references a scalar alias does.
      if (parent.initializer !== current) return false;
      // A JSON-RPC batch is an array of fully-formed requests; the jsonrpc
      // marker is proof of emission there exactly as it is outside one.
      if (insideArray && !isWireRequest) return false;
      if (!ts.isStringLiteralLike(current) && !isDispatchKey && !isWireRequest) return false;
      if (ts.isIdentifier(parent.name)) {
        const statement = parent.parent.parent;
        if (
          ts.isVariableStatement(statement) &&
          statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)
        ) {
          return true;
        }
        const escaped = parent.name.text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const references = sourceFile.text.match(new RegExp(`\\b${escaped}\\b`, 'g'))?.length ?? 0;
        return references > 1;
      }
      return false;
    }
    if (ts.isSourceFile(parent)) return false;
    current = parent;
    depth++;
  }
  return false;
}

/** Prevents identifier regexes from treating prose inside strings as SDK usage. */
export function isIdentifierUse(sourceFile: ts.SourceFile, offset: number): boolean {
  const node = nodeAt(sourceFile, offset);
  return Boolean(node && ts.isIdentifier(node));
}

/** True for a named/default/namespace import originating in an official MCP package. */
export function isMcpSdkIdentifier(sourceFile: ts.SourceFile, offset: number): boolean {
  const node = nodeAt(sourceFile, offset);
  if (!node || !ts.isIdentifier(node)) return false;
  let current: ts.Node | undefined = node;
  while (current && !ts.isSourceFile(current)) {
    if (ts.isImportDeclaration(current)) {
      return (
        ts.isStringLiteralLike(current.moduleSpecifier) &&
        current.moduleSpecifier.text.startsWith('@modelcontextprotocol/')
      );
    }
    if (ts.isCallExpression(current)) {
      const first = current.arguments[0];
      if (
        calleeName(current) === 'require' &&
        first &&
        ts.isStringLiteralLike(first) &&
        first.text.startsWith('@modelcontextprotocol/')
      ) {
        return true;
      }
    }
    if (
      ts.isVariableDeclaration(current) &&
      /\brequire\s*\(\s*['"`]@modelcontextprotocol\//.test(current.getText(sourceFile))
    ) {
      return true;
    }
    current = current.parent;
  }

  // Namespace imports keep the protocol symbol at its usage site rather than
  // in a named import (`Mcp.RootsListChangedNotificationSchema`). Resolve the
  // namespace binding so aliased SDK imports receive the same treatment.
  if (
    ts.isPropertyAccessExpression(node.parent) &&
    node.parent.name === node &&
    ts.isIdentifier(node.parent.expression)
  ) {
    const namespace = node.parent.expression.text;
    return sourceFile.statements.some((statement) => {
      if (
        !ts.isImportDeclaration(statement) ||
        !ts.isStringLiteralLike(statement.moduleSpecifier) ||
        !statement.moduleSpecifier.text.startsWith('@modelcontextprotocol/')
      ) {
        return false;
      }
      const bindings = statement.importClause?.namedBindings;
      return Boolean(bindings && ts.isNamespaceImport(bindings) && bindings.name.text === namespace);
    });
  }
  return false;
}

/** True only when an error-code literal is visibly emitted on a protocol error path. */
export function isProvenErrorEmission(sourceFile: ts.SourceFile, node: ts.Node): boolean {
  let current: ts.Node | undefined = node;
  let depth = 0;
  while (current && depth < 16) {
    const parent: ts.Node | undefined = current.parent;
    if (!parent) return false;
    if (ts.isThrowStatement(parent)) return true;
    if (ts.isNewExpression(parent)) {
      return /(?:^|\.)(?:McpError|ProtocolError|JsonRpcError|RpcError)$/.test(calleeName(parent));
    }
    if (ts.isCallExpression(parent)) {
      return /(?:^|\.)(?:sendError|createError|makeError|jsonRpcError|errorResponse|reject|fail|throwError|json|send|reply|respond)$/.test(
        calleeName(parent),
      );
    }
    if (ts.isReturnStatement(parent)) {
      const text = parent.expression?.getText(sourceFile) ?? '';
      return /\bjsonrpc\b[\s\S]{0,500}\berror\b|\berror\b[\s\S]{0,500}\bjsonrpc\b/.test(text);
    }
    current = parent;
    depth++;
  }
  return false;
}

/** The repository shows MCP evidence, or this specific file does. */
export function inMcpContext(context: ScanContext, file: PreparedFile): boolean {
  return context.repository.isLikelyMcpServer || fileHasMcpSignal(file);
}

/**
 * True when a match is syntactically or locally guarded as legacy-era support.
 * Target-incompatible behavior is allowed inside an explicitly selected legacy
 * branch of a dual-era implementation, so such evidence cannot be asserted as
 * an unconditional ERROR.
 */
export function isLegacyEraGuarded(
  file: PreparedFile,
  sourceFile: ts.SourceFile | null,
  offset: number,
): boolean {
  if (/(^|\/)(?:legacy|v1|2025)(?:[._/-]|$)/i.test(file.relPath)) return true;

  if (sourceFile) {
    let current = nodeAt(sourceFile, offset);
    let depth = 0;
    while (current && depth < 24) {
      if (
        current.parent &&
        (ts.isIfStatement(current.parent) ||
          ts.isConditionalExpression(current.parent) ||
          ts.isSwitchStatement(current.parent))
      ) {
        const text = current.parent.getText(sourceFile);
        if (LEGACY_GUARD_PATTERN.test(text)) return true;
      }
      current = current.parent;
      depth++;
    }
  }

  // Covers early-return/router shapes where the guarded statement is not a
  // descendant of the condition (for example `if (!legacy) return modern`).
  const local = file.content.slice(Math.max(0, offset - 600), Math.min(file.content.length, offset + 200));
  return LEGACY_GUARD_PATTERN.test(local);
}

const LEGACY_VERSIONS = '2025-11-25|2025-06-18|2025-03-26';

/**
 * A legacy-era guard is a branch that *selects* legacy behavior. Version
 * proximity alone is not one: a purely legacy server unconditionally emits
 * `protocolVersion: '2025-11-25'` from its initialize handler, and reading that
 * emission as a guard downgraded every ERROR in the same dispatch switch to
 * REVIEW — letting `--ci` pass on exactly the servers this tool exists to flag.
 * The version clauses therefore require a comparison or a switch label.
 */
const LEGACY_GUARD_PATTERN = new RegExp(
  [
    String.raw`\bisLegacyRequest\s*\(`,
    String.raw`\bgetProtocolEra\s*\(\s*\)\s*={2,3}\s*['"\`]legacy['"\`]`,
    String.raw`\b(?:era|classification\.era)\s*={2,3}\s*['"\`]legacy['"\`]`,
    String.raw`\bprotocolVersion\b[^\n]{0,60}(?:!==?|===?)[^\n]{0,40}(?:${LEGACY_VERSIONS})`,
    String.raw`(?:${LEGACY_VERSIONS})[^\n]{0,60}(?:!==?|===?)[^\n]{0,40}\bprotocolVersion\b`,
    String.raw`\bcase\s+['"\`](?:${LEGACY_VERSIONS})['"\`]\s*:`,
    // A legacy version literal directly against a comparison operator, whatever
    // the compared variable is called (`if (negotiated === '2025-11-25')`).
    String.raw`(?:!==?|===?)\s*['"\`](?:${LEGACY_VERSIONS})['"\`]`,
    String.raw`['"\`](?:${LEGACY_VERSIONS})['"\`]\s*(?:!==?|===?)`,
    // A legacy-named collection membership test (`LEGACY_VERSIONS.includes(v)`).
    String.raw`\blegacy\w*\s*\.\s*(?:includes|has|indexOf)\s*\(`,
    String.raw`@modelcontextprotocol/server-legacy`,
  ].join('|'),
  'i',
);

/** Severity override for behavior intentionally confined to a legacy era. */
export function legacyEraFindingOverride(
  file: PreparedFile,
  sourceFile: ts.SourceFile | null,
  offset: number,
): { level: 'review'; confidence: 'medium' } | Record<string, never> {
  return isLegacyEraGuarded(file, sourceFile, offset)
    ? { level: 'review', confidence: 'medium' }
    : {};
}
